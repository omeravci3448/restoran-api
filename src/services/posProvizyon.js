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

// Tek bir odemeyi isle. IDEMPOTENT: ayni odeme_id ikinci kez gelirse hicbir sey yapmaz.
// Tamami TEK transaction: yarida kalirsa ne kiraci ne provizyon kaydi kalir,
// bir sonraki cekimde bastan denenir.
async function odemeIsle(o) {
    const odemeId = String(o.odeme_id || '').trim();
    if (!odemeId) return { durum: 'atlandi', sebep: 'odeme_id yok' };

    return tx(async () => {
        // 1) Daha once islendi mi? (idempotency - en onemli kapi)
        const v = await query('SELECT tenant_id, kiraci_acildi FROM pos_provizyon WHERE odeme_id = ?', [odemeId]);
        if (v.rows.length) {
            return { durum: 'zaten_islendi', tenantId: v.rows[0].tenant_id, kiraciAcildi: false };
        }

        const smxId = o.business_id != null && o.business_id !== '' ? String(o.business_id) : null;
        const ad = String(o.isletme_adi || '').trim() || 'İşletme';
        const eposta = String(o.yetkili_email || '').trim().toLowerCase() || null;
        const tel = String(o.yetkili_tel || '').trim() || null;

        const { tenantId: bulunan, esles } = await kiraciBul({ smxId, tel, eposta });

        // Belirsiz eslesme: parayi kaydet, lisansa DOKUNMA, elle cozulsun.
        if (esles === 'belirsiz_eposta') {
            await provizyonYaz(o, { odemeId, smxId, ad, eposta, tel, tenantId: null,
                donemBitis: null, kiraciAcildi: 0, durum: 'elde', hata: 'Ayni e-postayla birden fazla isletme var.' });
            return { durum: 'elde', tenantId: null, sebep: 'belirsiz_eposta' };
        }

        let tenantId = bulunan;
        let kiraciAcildi = 0;
        let jeton = null;

        if (tenantId) {
            // 2a) Var olan kiracinin lisansini uzat
            const m = (await query('SELECT license_end_date FROM tenants WHERE id = ?', [tenantId])).rows[0];
            if (!m) return { durum: 'hata', sebep: 'kiraci_kayip', tenantId };
            await query(
                `UPDATE tenants
                    SET license_end_date = ?, is_active = 1,
                        license_tier = COALESCE(license_tier, 'TIER_SOFRAMIX'),
                        parent_org   = COALESCE(parent_org, ?)
                  WHERE id = ?`,
                [yeniBitis(m.license_end_date), smxId ? 'SofraMix' : null, tenantId]);
        } else {
            // 2b) Kiraci YOK -> ac. Sifre burada BELIRLENMEZ; sahibi tek kullanimlik
            //     baglantiyla kendi belirler, boylece duz sifre hicbir yerde durmaz.
            tenantId = uuidv4();
            const userId = uuidv4();
            const kod = await benzersizKod();
            const slug = await benzersizSlug(ad);
            const gecici = crypto.randomBytes(24).toString('base64url');
            await query(
                `INSERT INTO tenants
                    (id, slug, business_code, business_name, parent_org, owner_email, phone,
                     billing_name, license_tier, license_modules, license_end_date, is_active, show_cost_analytics)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'TIER_SOFRAMIX', ?, ?, 1, 1)`,
                [tenantId, slug, kod, ad, smxId ? 'SofraMix' : null, eposta, tel, ad,
                    JSON.stringify(VARSAYILAN_MODULLER), yeniBitis(null)]);
            await query(
                'INSERT INTO users (id, tenant_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)',
                [userId, tenantId, eposta || `sahip-${kod}@ornek.local`,
                    await bcrypt.hash(gecici, 10), String(o.yetkili_ad || ad).slice(0, 80), 'OWNER']);
            kiraciAcildi = 1;
            jeton = await aktivasyonJetonu(tenantId, userId);
        }

        const bitis = (await query('SELECT license_end_date, business_code FROM tenants WHERE id = ?', [tenantId])).rows[0];
        await provizyonYaz(o, { odemeId, smxId, ad, eposta, tel, tenantId,
            donemBitis: bitis && bitis.license_end_date, kiraciAcildi, durum: 'islendi', hata: null });

        return {
            durum: 'islendi', tenantId, kiraciAcildi: !!kiraciAcildi, esles,
            isyeriKodu: bitis && bitis.business_code,
            lisansBitis: bitis && bitis.license_end_date,
            aktivasyonJetonu: jeton,
        };
    });
}

async function provizyonYaz(o, k) {
    await query(
        `INSERT INTO pos_provizyon
            (id, odeme_id, kaynak, soframix_business_id, tenant_id, isletme_adi, yetkili_eposta,
             yetkili_tel, tutar_kurus, kdv_kurus, yontem, onay_tarihi, donem_bitis, kiraci_acildi, durum, hata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), k.odemeId, o.kaynak || 'soframix', k.smxId, k.tenantId, k.ad, k.eposta, k.tel,
            Number(o.tutar_kurus) || 0, Number(o.kdv_kurus) || 0, o.yontem || null,
            o.onay_tarihi || new Date().toISOString(), k.donemBitis, k.kiraciAcildi, k.durum, k.hata]);
}

// Bir donemde islenen odemeler - Patron'un SofraMix'e kesecegi faturanin dayanagi.
async function donemOzeti({ baslangic, bitis }) {
    const r = await query(
        `SELECT COUNT(*) AS adet,
                COALESCE(SUM(tutar_kurus), 0) AS toplam_kurus,
                COALESCE(SUM(kiraci_acildi), 0) AS yeni_isletme
           FROM pos_provizyon
          WHERE durum = 'islendi' AND onay_tarihi >= ? AND onay_tarihi <= ?`,
        [baslangic, bitis]);
    return r.rows[0];
}

module.exports = {
    odemeIsle, donemOzeti, kiraciBul, aktivasyonJetonu, yeniBitis,
    benzersizSlug, slugla, telefonNorm, VARSAYILAN_MODULLER, LISANS_GUN,
};
