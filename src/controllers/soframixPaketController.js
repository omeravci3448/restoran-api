const crypto = require('crypto');
const { query } = require('../config/db');
const SP = require('../services/soframixPaket');
const M = require('../services/lisansModul');

// --- SofraMix paket uclari (POS tarafi) ---
//
//   GET /api/public/soframix-paketler     herkese acik: paketler + normal ve SofraMix'e ozel fiyatlar
//   GET /api/public/soframix-durum        SofraMix sunucusu icin imzali: isletmenin POS lisans durumu
//   POST /api/root/provizyon/:odemeId/coz root: elde kalan SofraMix odemesini cozer
//
// Durum ucu imzasi deneme devriyle AYNI duzen (controllers/denemeDevirController.js): yuk = base64url JSON,
// imza = HMAC-SHA256 (anahtar SOFRAMIX_DENEME_GIZLI) cozulen METNIN KENDISI uzerinden, hex. Salt okunur
// oldugu icin nonce yok; 300 sn gecmis / 60 sn ileri pencere. Kiraci YALNIZ SofraMix isletme numarasiyla
// bulunur (telefon/e-posta ile ASLA): ayni sahibin baska subesinin bilgisi donmesin. Kisisel veri donmez.

const GIZLI = process.env.SOFRAMIX_DENEME_GIZLI || '';
const GECMIS_SN = 300;
const ILERI_SN = 60;
const YUK_EN_COK = 4096;

function acikMi() { return GIZLI.length >= 16; }

// IP basina sayaclar (bellekte). sayacKur(ip): sayar ve sinir asildi mi doner. Bellek siniri: 20000 IP'yi gecince
// (yeni IP eklenirken de) tablo bosaltilir.
function sayacTablosu(sinir, pencereMs) {
    const h = new Map();
    const canli = (ip) => { const k = h.get(ip); return k && Date.now() <= k.sifir ? k : null; };
    return {
        // Yalniz okur: sinir asilmis mi (saymaz)
        asildiMi: (ip) => { const k = canli(ip); return !!k && k.sayi > sinir; },
        // Sayar; sinir asildi mi doner
        artir: (ip) => {
            const k = canli(ip);
            if (!k) { if (h.size >= 20000) h.clear(); h.set(ip, { sayi: 1, sifir: Date.now() + pencereMs }); return 1 > sinir; }
            k.sayi++;
            return k.sayi > sinir;
        },
    };
}
const sayacKur = (sinir, pencereMs) => sayacTablosu(sinir, pencereMs).artir;
const paketCokMu = sayacKur(300, 5 * 60000);
// Durum ucu: HATALI istekler (imza, bicim, sure) ayri ve gevsek sayilir (yalniz CPU'yu korur); girista yalniz okunur,
// ret aninda artirilir. Gecerli istekler yalniz durumCokMu ile sinirlanir (SofraMix sunucusu tek IP'den gelir).
const durumHatali = sayacTablosu(300, 15 * 60000);
const durumCokMu = sayacKur(600, 15 * 60000);

function sabitZamanliEsit(a, b) {
    const x = Buffer.from(String(a || ''), 'utf8'); const y = Buffer.from(String(b || ''), 'utf8');
    if (x.length !== y.length) return false;
    return crypto.timingSafeEqual(x, y);
}

// Kisa omurlu bellek onbellegi: herkese acik uc her istekte katalogu okumasin. Root fiyat degistirince en gec
// 30 sn sonra yansir (yanit zaten max-age=60 ile onbelleklenebilir).
let onbellek = { zaman: 0, govde: null };

// GET /api/public/soframix-paketler
exports.paketler = async (req, res) => {
    if (paketCokMu(req.ip || 'bilinmiyor')) return res.status(429).json({ message: 'Çok fazla istek. Birkaç dakika sonra tekrar deneyin.' });
    if (!onbellek.govde || Date.now() - onbellek.zaman > 30000) {
        onbellek = { zaman: Date.now(), govde: await SP.paketler() };
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json(onbellek.govde);
};
exports._onbellekSifirla = () => { onbellek = { zaman: 0, govde: null }; };
exports._sayacTablosu = sayacTablosu;   // test icin

// GET /api/public/soframix-durum?yuk=<base64url>&imza=<hex>
exports.durum = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!acikMi()) {
        console.error('[soframix-durum] SOFRAMIX_DENEME_GIZLI tanimli degil - durum ucu KAPALI');
        return res.status(503).json({ message: 'Hizmet şu an kullanılamıyor.' });
    }
    const ip = req.ip || 'bilinmiyor';
    if (durumHatali.asildiMi(ip)) return res.status(429).json({ message: 'Çok fazla istek.' });
    const reddet = (kod, message) => { durumHatali.artir(ip); return res.status(kod).json({ message }); };

    const { yuk, imza } = req.query || {};
    if (typeof yuk !== 'string' || !yuk || yuk.length > YUK_EN_COK || !/^[0-9a-f]{64}$/.test(String(imza || ''))) {
        return reddet(401, 'İmza geçersiz.');
    }
    // 1) IMZA: cozulen metnin kendisi uzerinden, parse ETMEDEN once
    let metin;
    try { metin = Buffer.from(yuk, 'base64url').toString('utf8'); } catch (_) { metin = ''; }
    const beklenen = crypto.createHmac('sha256', GIZLI).update(metin).digest('hex');
    if (!sabitZamanliEsit(imza, beklenen)) return reddet(401, 'İmza geçersiz.');

    // 2) GOVDE
    let g;
    try { g = JSON.parse(metin); } catch (_) { return reddet(400, 'İstek okunamadı.'); }
    const no = g && g.isletme_no;
    if (!g || g.kaynak !== 'soframix' || Number(g.surum) !== 1 || g.amac !== 'durum'
        || !Number.isInteger(Number(no)) || Number(no) <= 0 || String(no).trim() === '') {
        return reddet(400, 'İstek beklenen biçimde değil.');
    }
    // 3) SURE: unix saniye; 300 sn'den eski ya da 60 sn'den ileri RED
    const simdi = Date.now() / 1000; const zaman = Number(g.zaman);
    if (!Number.isFinite(zaman) || zaman > simdi + ILERI_SN || simdi - zaman > GECMIS_SN) {
        return reddet(410, 'İsteğin süresi dolmuş.');
    }
    if (durumCokMu(ip)) return res.status(429).json({ message: 'Çok fazla istek.' });

    // 4) KIRACI: yalniz SofraMix isletme numarasiyla (deneme devriyle ayni arama)
    const smxId = String(Number(no));
    const { tenantId } = await require('../services/posProvizyon').kiraciBul({ smxId });
    if (!tenantId) return res.json({ bulundu: false });
    const t = (await query(
        `SELECT id, is_active, parent_org, license_tier, license_modules, license_table_limit, license_end_date
           FROM tenants WHERE id = ?`, [tenantId])).rows[0];
    if (!t) return res.json({ bulundu: false });
    const d = require('../services/yonetimOzet').durumu(t);
    const p = await SP.kiraciPaketi(t);
    const bekleyen = await query(
        "SELECT 1 FROM pos_provizyon WHERE soframix_business_id = ? AND durum = 'elde' LIMIT 1", [smxId]);
    const bitis = t.license_end_date && !isNaN(new Date(t.license_end_date).getTime())
        ? new Date(t.license_end_date).toISOString() : null;
    // kalanGun: YALNIZ AKTIF lisansta bitise kalan gun (0 = bugun bitiyor). SALT_OKUNUR/KAPALI'da 0; salt-okunur
    // donemde erisimin bitisine kalan gun ayri alanda (erisimKalanGun; diger durumlarda 0).
    const aktif = d.durum === 'AKTIF';
    const kalanGun = d.kalanGun == null ? null : (aktif ? d.kalanGun : 0);
    const erisimKalanGun = d.durum === 'SALT_OKUNUR' && d.kalanGun != null ? d.kalanGun : 0;
    // Okunur adlar (SofraMix ozeti ham kod gostermesin): katalog adi, yoksa POS'taki modul adi
    const adlar = (await query('SELECT tur, kod, ad FROM lisans_katalog')).rows;
    const ad = (tur, kod) => { const x = adlar.find((y) => y.tur === tur && y.kod === kod); return x ? x.ad : null; };
    const modulAdlari = p.moduller.filter((m) => m !== 'ALL').map((m) => ad('MODUL', m) || M.AD[m] || m);
    const tierAd = p.tier ? ad('TIER', p.tier) : null;
    res.json({
        bulundu: true,
        isletme_no: Number(smxId),
        lisansBitis: bitis,
        durum: d.durum,
        kalanGun,
        erisimKalanGun,
        paket: { tur: p.tur, tier: p.tier, moduller: p.moduller, modulAdlari, tierAd },
        kanal: (t.parent_org === 'SofraMix' || t.license_tier === 'TIER_SOFRAMIX') ? 'soframix' : 'yerel',
        bekleyenOdeme: bekleyen.rows.length > 0,
    });
};

// POST /api/root/provizyon/:odemeId/coz  { islem: 'yeni' | 'aday' | 'isletme' | 'tutar' | 'paket', isyeriKodu? }
//   yeni     eslesme aramadan YENI isletme ac (ayni sahibin ikinci subesi gibi)
//   aday     elde birakilirken bulunan aday isletmeye yaz (root kontrol etti)
//   isletme  isyeri koduyla secilen isletmeye yaz
//   tutar    paket tutari uyusmazligini kabul et (fiyat bilerek degisti)
//   paket    gecersiz sayilan paketi (paket_gecersiz) oldugu gibi kabul et: bagimliliklar tamamlanir, tutar bakilmaz
// Kararlar kayda islenir: iki adimli cozumde (once tutar, sonra yeni isletme) ilk karar kaybolmaz.
exports.rootCoz = async (req, res) => {
    const YG = require('../services/yonetimGunlugu');
    const P = require('../services/posProvizyon');
    const k = (await query('SELECT * FROM pos_provizyon WHERE odeme_id = ?', [req.params.odemeId])).rows[0];
    if (!k) return res.status(404).json({ message: 'Ödeme bulunamadı.' });
    if (k.durum === 'islendi') return res.status(409).json({ message: 'Bu ödeme zaten işlenmiş.' });
    const islem = String((req.body && req.body.islem) || '');
    let ek;
    let aciklama;
    if (islem === 'yeni') {
        if (!k.yetkili_eposta) return res.status(400).json({ message: 'Yetkili e-postası boş; yeni işletme açılamaz. Önce SofraMix tarafında e-postayı tamamlatın.' });
        ek = { yeniIsletme: true }; aciklama = 'yeni işletme olarak açıldı';
    } else if (islem === 'aday') {
        if (!k.aday_tenant_id) return res.status(400).json({ message: 'Bu ödeme için önerilen işletme yok.' });
        ek = { tenantId: k.aday_tenant_id }; aciklama = 'önerilen işletmeye yazıldı';
    } else if (islem === 'isletme') {
        const kod = String((req.body && req.body.isyeriKodu) || '').trim();
        const t = kod ? (await query('SELECT id, business_name FROM tenants WHERE business_code = ?', [kod])).rows[0] : null;
        if (!t) return res.status(404).json({ message: 'Bu işyeri koduyla işletme bulunamadı.' });
        ek = { tenantId: t.id }; aciklama = `${t.business_name} (${kod}) işletmesine yazıldı`;
    } else if (islem === 'tutar') {
        ek = { tutarKabul: true }; aciklama = 'tutar farkı kabul edildi';
    } else if (islem === 'paket') {
        ek = { paketKabul: true }; aciklama = 'paket olduğu gibi kabul edildi';
    } else {
        return res.status(400).json({ message: 'Geçersiz işlem.' });
    }
    const s = await P.kayittanTekrarIsle(k, ek);
    if (s.durum === 'islendi') {
        const o = { odeme_id: k.odeme_id, business_id: k.soframix_business_id, isletme_adi: k.isletme_adi, yetkili_email: k.yetkili_eposta };
        try { await require('../services/posOdemeCekici').islenenSonrasi(o, s); } catch (e) { console.error('[provizyon] coz sonrasi:', e.message); }
    }
    await YG.kaydet(req, {
        islem: 'provizyon', tenantId: s.tenantId || null,
        ozet: `SofraMix ödemesi elle çözüldü (${k.odeme_id}): ${aciklama} - sonuç: ${s.durum}`,
    });
    const { aktivasyonJetonu, ...cevap } = s;   // ham jeton yanita yazilmaz; posta gitmediyse "Bağlantıyı yeniden gönder"
    res.json(cevap);
};
