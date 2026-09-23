const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');

// ——— POS paketi provizyonu ———
// SofraMix'te POS paketi satin alinip ONAYLANINCA, POS o odemeyi kendisi SORAR
// (bkz posOdemeCekici.js). Bu servis gelen odemeyi isler:
//   - kiraci yoksa ACAR, varsa lisansini uzatir
//   - odeme_id'yi kaydeder -> ayni odeme ikinci kez lisans ACAMAZ
//   - sahibine sifre belirleme baglantisi uretir
//
// NEDEN PULL (biz soruyoruz) DEGIL PUSH (onlar haber veriyor):
//   SofraMix'e kuyruk/tekrar-deneme/imza altyapisi kurmak gerekmiyor; sormanin
//   kendisi zaten tekrar denemedir. "Para alindi ama POS acilmadi" sessiz hatasi
//   boylece imkansizlasir.

const VARSAYILAN_MODULLER = ['BASE', 'MENU_DIGITAL', 'GARSON', 'STOK', 'MARKETPLACE'];
const LISANS_GUN = 365;

function rastgeleKod(n = 5) {
    return String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
}

async function benzersizKod() {
    for (let i = 0; i < 40; i++) {
        const k = rastgeleKod();
        const v = await query('SELECT 1 FROM tenants WHERE business_code = ?', [k]);
        if (!v.rows.length) return k;
    }
    return rastgeleKod(7);
}

function slugla(ad) {
    return String(ad || 'isletme').toLowerCase()
        .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
        .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'isletme';
}

async function benzersizSlug(ad) {
    const taban = slugla(ad);
    for (let i = 0; i < 40; i++) {
        const aday = i === 0 ? taban : `${taban}-${rastgeleKod(4)}`;
        const v = await query('SELECT 1 FROM tenants WHERE slug = ?', [aday]);
        if (!v.rows.length) return aday;
    }
    return `${taban}-${uuidv4().slice(0, 8)}`;
}

// Sifre belirleme jetonu: ham deger YALNIZCA burada doner, DB'de yalnizca ozeti durur.
async function aktivasyonJetonu(tenantId, userId, saat = 72) {
    const ham = crypto.randomBytes(32).toString('base64url');
    const ozet = crypto.createHash('sha256').update(ham).digest('hex');
    const son = new Date(Date.now() + saat * 3600 * 1000).toISOString();
    await query(
        `INSERT INTO aktivasyon_jetonlari (id, tenant_id, user_id, jeton_ozet, son_gecerlilik)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), tenantId, userId, ozet, son]);
    return { ham, son };
}

// Lisans bitisini hesapla: mevcut lisans ileri tarihliyse UZERINE ekle
// (erken yenileyen musteri gun kaybetmesin), degilse bugunden basla.
function yeniBitis(mevcutBitis) {
    const simdi = Date.now();
    const taban = mevcutBitis && new Date(mevcutBitis).getTime() > simdi
        ? new Date(mevcutBitis).getTime() : simdi;
    return new Date(taban + LISANS_GUN * 86400000).toISOString();
}

function telefonNorm(tel) {
    const r = String(tel || '').replace(/\D/g, '');
    return r.length >= 10 ? r.slice(-10) : null;
}

// Bu odeme hangi kiraciya ait? Sirayla bakariz; ilk bulan kazanir.
// SIRALAMA ONEMLI: deneme surumunu kullanip sonra satin alan isletme AYNI
// kiraciyi surdurmeli, yoksa denemede girdigi menu/masa duzeni cope gider.
async function kiraciBul({ smxId, tel, eposta }) {
    if (smxId) {
        const p = await query(
            'SELECT tenant_id FROM pos_provizyon WHERE soframix_business_id = ? AND tenant_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
            [smxId]);
        if (p.rows.length) return { tenantId: p.rows[0].tenant_id, esles: 'onceki_odeme' };

        const d = await query(
            'SELECT tenant_id FROM deneme_kayitlari WHERE soframix_business_id = ? AND tenant_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
            [smxId]);
        if (d.rows.length) return { tenantId: d.rows[0].tenant_id, esles: 'deneme_smx' };
    }
    const tn = telefonNorm(tel);
    if (tn) {
        const d = await query(
            'SELECT tenant_id FROM deneme_kayitlari WHERE telefon_norm = ? AND tenant_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
            [tn]);
        if (d.rows.length) return { tenantId: d.rows[0].tenant_id, esles: 'deneme_tel' };
    }
    if (eposta) {
        // En son eslesme kapisi: ayni e-postayla acilmis TEK bir kiraci varsa onu al.
        // Birden fazlaysa ELLE karar gerekir; yanlis kiraciya 1 yil yazmaktansa
        // provizyonu "elde" birakiriz.
        const t = await query('SELECT id FROM tenants WHERE owner_email = ?', [eposta]);
        if (t.rows.length === 1) return { tenantId: t.rows[0].id, esles: 'eposta' };
        if (t.rows.length > 1) return { tenantId: null, esles: 'belirsiz_eposta' };
    }
    return { tenantId: null, esles: 'yok' };
}

// Kiraci acma - HEM provizyon HEM deneme akisi buradan geciyor.
// Ayri ayri yazilsaydi biri modul listesini, digeri slug uretimini farkli
// yapar ve "deneme surumunde calisiyordu, satin alinca bozuldu" turunden
// hatalar dogardi.
async function kiraciAc({ ad, eposta, tel, yetkiliAd, parentOrg, tier, bitis, moduller }) {
    const tenantId = uuidv4();
    const userId = uuidv4();
    const kod = await benzersizKod();
    const slug = await benzersizSlug(ad);
    // Duz sifre URETILMEZ: sahibi tek kullanimlik baglantiyla kendi belirler.
    const gecici = crypto.randomBytes(24).toString('base64url');
    await query(
        `INSERT INTO tenants
            (id, slug, business_code, business_name, parent_org, owner_email, phone,
             billing_name, license_tier, license_modules, license_end_date, is_active, show_cost_analytics)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
        [tenantId, slug, kod, ad, parentOrg || null, eposta, tel || null, ad,
            tier || 'TIER_SOFRAMIX', JSON.stringify(moduller || VARSAYILAN_MODULLER), bitis]);
    await query(
        'INSERT INTO users (id, tenant_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, tenantId, eposta, await bcrypt.hash(gecici, 10),
            String(yetkiliAd || ad).slice(0, 80), 'OWNER']);
    const jeton = await aktivasyonJetonu(tenantId, userId);
    return { tenantId, userId, isyeriKodu: kod, slug, aktivasyonJetonu: jeton };
}

// SofraMix tarihleri SQLite bicimiyle geliyor: 'YYYY-MM-DD HH:MM:SS' (UTC).
// POS ise her yerde ISO kullaniyor. Ayni sutunda iki bicim karisirsa METIN
// karsilastirmasi bozulur: bosluk (0x20) < 'T' (0x54) oldugu icin donemin ILK
// GUNUNDEKI odemeler fatura ozetinden SESSIZCE duser ve imlec de kayar.
// Bu yuzden yazmadan ONCE tek bicime ceviriyoruz.
function tarihNormalle(ham) {
    const s = String(ham || '').trim();
    if (!s) return new Date().toISOString();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s)) {
        return new Date(s.replace(' ', 'T') + 'Z').toISOString();
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// Tek bir odemeyi isle. IDEMPOTENT: ayni odeme_id ikinci kez gelirse hicbir sey yapmaz.
// Tamami TEK transaction: yarida kalirsa ne kiraci ne provizyon kaydi kalir,
// bir sonraki cekimde bastan denenir.
async function odemeIsle(o) {
    const odemeId = String(o.odeme_id || '').trim();
    if (!odemeId) return { durum: 'atlandi', sebep: 'odeme_id yok' };

    return tx(async () => {
        // 1) Daha once BASARIYLA islendi mi? (idempotency - en onemli kapi)
        //    Durum ayrimi SART: 'elde' birakilmis bir odeme burada da "islendi"
        //    sayilsaydi, sorun elle cozulse bile o odeme bir daha ASLA
        //    denenmezdi - para alinmis, lisans hic acilmamis olurdu.
        const v = await query('SELECT tenant_id, durum FROM pos_provizyon WHERE odeme_id = ?', [odemeId]);
        if (v.rows.length && v.rows[0].durum === 'islendi') {
            return { durum: 'zaten_islendi', tenantId: v.rows[0].tenant_id, kiraciAcildi: false };
        }
        const tekrarDeneme = v.rows.length > 0;

        const smxId = o.business_id != null && o.business_id !== '' ? String(o.business_id) : null;
        const ad = String(o.isletme_adi || '').trim() || 'İşletme';
        const eposta = String(o.yetkili_email || '').trim().toLowerCase() || null;
        const tel = String(o.yetkili_tel || '').trim() || null;
        const ortak = { odemeId, smxId, ad, eposta, tel, tekrarDeneme };

        const { tenantId: bulunan, esles } = await kiraciBul({ smxId, tel, eposta });

        // Belirsiz eslesme: parayi kaydet, lisansa DOKUNMA, elle cozulsun.
        if (esles === 'belirsiz_eposta') {
            await provizyonYaz(o, { ...ortak, tenantId: null, donemBitis: null, kiraciAcildi: 0,
                durum: 'elde', hata: 'Ayni e-postayla birden fazla isletme var - hangisine yazilacagi belirsiz.' });
            return { durum: 'elde', tenantId: null, sebep: 'belirsiz_eposta' };
        }

        // Yetkili e-postasi YOKSA ve kiraci da bulunamadiysa kiraci ACMIYORUZ.
        // Eskiden uydurma bir adresle (sahip-12345@ornek.local) acilirdi: lisans
        // baslar, aktivasyon postasi gidecek adres olmadigi icin gitmez, kimse
        // giremez ve hicbir uyari cikmazdi. Simdi elle cozulmek uzere bekliyor.
        if (!bulunan && !eposta) {
            await provizyonYaz(o, { ...ortak, tenantId: null, donemBitis: null, kiraciAcildi: 0,
                durum: 'elde', hata: 'Yetkili e-postasi bos - kiraci acilamaz, sahibi giris yapamazdi.' });
            return { durum: 'elde', tenantId: null, sebep: 'eposta_yok' };
        }

        let tenantId = bulunan;
        let kiraciAcildi = 0;
        let jeton = null;

        if (tenantId) {
            // 2a) Var olan kiracinin lisansini uzat
            const m = (await query(
                'SELECT license_end_date, license_modules FROM tenants WHERE id = ?', [tenantId])).rows[0];
            if (!m) return { durum: 'hata', sebep: 'kiraci_kayip', tenantId };
            // Modul listesi de tazelenir. Eskiden yalniz tarih yazilirdi; elle
            // acilmis ya da eski bir kiraci MARKETPLACE modulu olmadan kalir,
            // parasini odedigi halde kanal ekranlarina hic giremezdi.
            let modul = [];
            try { modul = JSON.parse(m.license_modules || '[]'); } catch (_) { modul = []; }
            if (!Array.isArray(modul)) modul = [];
            for (const x of VARSAYILAN_MODULLER) if (!modul.includes(x)) modul.push(x);
            await query(
                `UPDATE tenants
                    SET license_end_date = ?, is_active = 1,
                        license_modules = ?,
                        license_tier = COALESCE(license_tier, 'TIER_SOFRAMIX'),
                        parent_org   = COALESCE(parent_org, ?)
                  WHERE id = ?`,
                [yeniBitis(m.license_end_date), JSON.stringify(modul), smxId ? 'SofraMix' : null, tenantId]);
        } else {
            // 2b) Kiraci YOK -> ac. Sifre burada BELIRLENMEZ; sahibi tek kullanimlik
            //     baglantiyla kendi belirler, boylece duz sifre hicbir yerde durmaz.
            const y = await kiraciAc({
                ad, eposta, tel, yetkiliAd: o.yetkili_ad,
                parentOrg: smxId ? 'SofraMix' : null, tier: 'TIER_SOFRAMIX',
                bitis: yeniBitis(null), moduller: VARSAYILAN_MODULLER,
            });
            tenantId = y.tenantId;
            kiraciAcildi = 1;
            jeton = y.aktivasyonJetonu;
        }

        const bitis = (await query(
            'SELECT license_end_date, business_code, owner_email FROM tenants WHERE id = ?', [tenantId])).rows[0];
        await provizyonYaz(o, { ...ortak, tenantId, donemBitis: bitis && bitis.license_end_date,
            kiraciAcildi, durum: 'islendi', hata: null });

        return {
            durum: 'islendi', tenantId, kiraciAcildi: !!kiraciAcildi, esles,
            isyeriKodu: bitis && bitis.business_code,
            eposta: (bitis && bitis.owner_email) || eposta,
            lisansBitis: bitis && bitis.license_end_date,
            lisansUzatildi: !kiraciAcildi,
            aktivasyonJetonu: jeton,
        };
    });
}

// odeme_id benzersiz oldugu icin tekrar denemede INSERT patlar - o yuzden
// upsert. 'elde' kalan bir odeme cozulunce ayni satir 'islendi'ye doner,
// ikinci bir kayit olusmaz (fatura ozeti cift saymasin).
async function provizyonYaz(o, k) {
    const kdv = (o.kdv_kurus === null || o.kdv_kurus === undefined || o.kdv_kurus === '')
        ? null : Number(o.kdv_kurus);   // NULL = "kaydedilmedi", 0 = "KDV yok"; ikisi ayni sey DEGIL
    const alanlar = [o.kaynak || 'soframix', k.smxId, k.tenantId, k.ad, k.eposta, k.tel,
        Number(o.tutar_kurus) || 0, kdv, o.yontem || null,
        tarihNormalle(o.onay_tarihi), k.donemBitis, k.kiraciAcildi, k.durum, k.hata];

    if (k.tekrarDeneme) {
        await query(
            `UPDATE pos_provizyon
                SET kaynak = ?, soframix_business_id = ?, tenant_id = ?, isletme_adi = ?,
                    yetkili_eposta = ?, yetkili_tel = ?, tutar_kurus = ?, kdv_kurus = ?,
                    yontem = ?, onay_tarihi = ?, donem_bitis = ?, kiraci_acildi = ?,
                    durum = ?, hata = ?
              WHERE odeme_id = ?`, [...alanlar, k.odemeId]);
        return;
    }
    await query(
        `INSERT INTO pos_provizyon
            (id, odeme_id, kaynak, soframix_business_id, tenant_id, isletme_adi, yetkili_eposta,
             yetkili_tel, tutar_kurus, kdv_kurus, yontem, onay_tarihi, donem_bitis, kiraci_acildi, durum, hata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), k.odemeId, ...alanlar]);
}

// Bir donemde islenen odemeler - Patron'un SofraMix'e kesecegi faturanin dayanagi.
// kdv_bilinmeyen AYRI sayiliyor: KDV'si kaydedilmemis odemeleri 0 TL KDV gibi
// toplamak, faturayi yanlis rakama dayandirmak demektir.
async function donemOzeti({ baslangic, bitis }) {
    const r = await query(
        `SELECT COUNT(*) AS adet,
                COALESCE(SUM(tutar_kurus), 0) AS toplam_kurus,
                COALESCE(SUM(kdv_kurus), 0)   AS kdv_toplam_kurus,
                SUM(CASE WHEN kdv_kurus IS NULL THEN 1 ELSE 0 END) AS kdv_bilinmeyen,
                COALESCE(SUM(kiraci_acildi), 0) AS yeni_isletme
           FROM pos_provizyon
          WHERE durum = 'islendi' AND onay_tarihi >= ? AND onay_tarihi <= ?`,
        [baslangic, bitis]);
    return r.rows[0];
}

// Elle cozulmeyi bekleyen odemeler. Para alinmis ama lisans acilmamis
// demektir - root panelinde rozet olarak gosteriliyor, sessiz kalmiyor.
async function bekleyenElde() {
    const r = await query(
        "SELECT COUNT(*) AS adet, COALESCE(SUM(tutar_kurus), 0) AS tutar_kurus FROM pos_provizyon WHERE durum = 'elde'");
    return r.rows[0];
}

module.exports = {
    odemeIsle, donemOzeti, bekleyenElde, kiraciBul, kiraciAc, aktivasyonJetonu, yeniBitis,
    benzersizSlug, slugla, telefonNorm, tarihNormalle, VARSAYILAN_MODULLER, LISANS_GUN,
};
