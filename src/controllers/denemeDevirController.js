const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');
const { signToken } = require('../middleware/authMiddleware');

// ——— SofraMix -> MDA POS: 7 gunluk deneme DEVRI ———
//
// Isletme SofraMix panelinde "denemeyi baslat" der; SofraMix imzali bir baglanti
// uretip isletmeyi YENI SEKMEDE buraya yollar:
//   GET /api/public/soframix-deneme?v=1&yuk=<base64url>&imza=<hex>
// Biz imzayi dogrular, kiraciyi acar (ya da var olani bulur) ve yetkiliyi
// oturum acmis halde panele indiririz.
//
// GUVENLIK - BU UC HESAP ACIYOR:
//   - Imza, cozulen METNIN KENDISI uzerinden hesaplanir. Parse edip yeniden
//     stringify ETMIYORUZ: alan sirasi/sayi bicimi farki imzayi bozar ve saatlerce
//     "neden tutmuyor" diye aranir. Cozulen metin zaten kanonik (SofraMix
//     posDeneme.js: JSON.stringify(govde, Object.keys(govde).sort())).
//   - Sure penceresi: damga + gecerli_sn gectiyse RED; ileri tarihli damga da RED.
//   - nonce TEK KULLANIMLIK ve VERITABANINDA (bellekte degil: yeniden baslatma /
//     ikinci kopya nonce'u unutur). Nonce, kiraci acilmadan ONCE ayni transaction
//     icinde yaziliyor: iki es zamanli istek ayni baglantiyla iki kiraci acamaz.
//   - deneme_gun'a ust sinir: imza dogru olsa bile 3650 gun yazdirilamaz.
//   - Gizli anahtar YALNIZ ortam degiskeninde (SOFRAMIX_DENEME_GIZLI); SofraMix
//     panelinde girilenle AYNI olmali.

const GIZLI = process.env.SOFRAMIX_DENEME_GIZLI || '';
const PANEL = (process.env.POS_PANEL_URL || 'https://restoran.mdayazilim.com').replace(/[/]+$/, '');
const EN_COK_DENEME_GUN = Number(process.env.SOFRAMIX_DENEME_EN_COK_GUN || 30);
const ILERI_TARIH_TOLERANS_MS = 60 * 1000;
const GIRIS_JETON_DK = 10;
const YUK_EN_COK_BAYT = 8 * 1024;

function acikMi() { return GIZLI.length >= 16; }

// IP basina sinir: uc herkese acik, kaba kuvvete degil DB'yi bos yere yormaya karsi.
const denemeler = new Map();
function cokMu(ip) {
    const k = denemeler.get(ip); const simdi = Date.now();
    if (!k || simdi > k.sifir) { denemeler.set(ip, { sayi: 1, sifir: simdi + 15 * 60000 }); return false; }
    k.sayi++; if (denemeler.size > 20000) denemeler.clear();
    return k.sayi > 30;
}

// Tarayici sekmesine duz, kucuk bir HTML. Ne oldugu anlasilsin, panik yaratmasin.
function sayfa(res, kod, baslik, metin) {
    res.status(kod).set('Content-Type', 'text/html; charset=utf-8').send(
        '<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>MDA Restoran POS</title><style>body{font-family:Georgia,serif;background:#FAF6EF;color:#1C1A17;margin:0;padding:40px 16px}'
        + '.k{max-width:520px;margin:auto;background:#fff;border:1px solid #E7E0D3;border-radius:14px;padding:28px}h1{font-size:1.3rem;margin:0 0 10px}p{line-height:1.6;color:#4B4741}'
        + 'a{color:#E2622A}</style></head><body><div class="k"><h1>' + baslik + '</h1><p>' + metin + '</p>'
        + '<p><a href="' + PANEL + '/login">Giriş ekranına dön</a></p></div></body></html>');
}

function sabitZamanliEsit(a, b) {
    const x = Buffer.from(String(a || ''), 'utf8'); const y = Buffer.from(String(b || ''), 'utf8');
    if (x.length !== y.length) return false;   // uzunluk farkliysa timingSafeEqual atar
    return crypto.timingSafeEqual(x, y);
}

async function girisJetonu(tenantId, userId) {
    const ham = crypto.randomBytes(32).toString('base64url');
    const ozet = crypto.createHash('sha256').update(ham).digest('hex');
    await query(
        `INSERT INTO deneme_giris_jetonlari (id, jeton_ozet, tenant_id, user_id, son_gecerlilik)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), ozet, tenantId, userId, new Date(Date.now() + GIRIS_JETON_DK * 60000).toISOString()]);
    return ham;
}

// GET /api/public/soframix-deneme?v=1&yuk=...&imza=...
exports.devir = async (req, res) => {
    if (!acikMi()) {
        console.error('[deneme-devir] SOFRAMIX_DENEME_GIZLI tanimli degil - devir ucu KAPALI');
        return sayfa(res, 503, 'Deneme şu an başlatılamıyor', 'Sunucu yapılandırması eksik. Lütfen bize yazın, hemen düzeltelim.');
    }
    const ip = req.ip || 'bilinmiyor';
    if (cokMu(ip)) return sayfa(res, 429, 'Çok fazla deneme', 'Birkaç dakika sonra tekrar deneyin.');

    const { v, yuk, imza } = req.query || {};
    if (String(v) !== '1' || typeof yuk !== 'string' || !/^[0-9a-f]{64}$/.test(String(imza || ''))) {
        return sayfa(res, 400, 'Bağlantı geçersiz', 'Bu bağlantı eksik ya da bozuk. SofraMix panelinden "denemeyi başlat" adımını yeniden deneyin.');
    }
    if (yuk.length > YUK_EN_COK_BAYT * 2) return sayfa(res, 400, 'Bağlantı geçersiz', 'Bağlantı beklenenden büyük.');

    // 1) IMZA - cozulen metnin KENDISI uzerinden, parse ETMEDEN once.
    let yukMetin;
    try { yukMetin = Buffer.from(yuk, 'base64url').toString('utf8'); } catch (_) { yukMetin = ''; }
    const beklenen = crypto.createHmac('sha256', GIZLI).update(yukMetin).digest('hex');
    if (!sabitZamanliEsit(imza, beklenen)) {
        console.warn('[deneme-devir] imza tutmadi', ip);
        return sayfa(res, 400, 'Bağlantı doğrulanamadı', 'Bu bağlantının imzası tutmuyor; kopyalanırken bozulmuş ya da anahtarlar uyuşmuyor olabilir. SofraMix panelinden yeniden başlatın.');
    }

    // 2) GOVDE - imza dogru, artik parse edebiliriz.
    let g;
    try { g = JSON.parse(yukMetin); } catch (_) { return sayfa(res, 400, 'Bağlantı geçersiz', 'Bağlantı içeriği okunamadı.'); }
    if (!g || g.kaynak !== 'soframix' || Number(g.surum) !== 1 || g.isletme_no == null || g.isletme_no === '') {
        return sayfa(res, 400, 'Bağlantı geçersiz', 'Bağlantı beklenen biçimde değil.');
    }

    // 3) SURE - gecmis de ileri tarihli de RED.
    const simdi = Date.now(); const damga = Number(g.damga_ms); const omur = Number(g.gecerli_sn || 600);
    if (!Number.isFinite(damga) || !Number.isFinite(omur) || damga > simdi + ILERI_TARIH_TOLERANS_MS || simdi > damga + omur * 1000) {
        return sayfa(res, 410, 'Bağlantının süresi dolmuş', 'Deneme bağlantısı 10 dakika geçerlidir. SofraMix panelinden "denemeyi başlat" deyip yeni bağlantıyla gelin.');
    }
    const nonce = String(g.nonce || '');
    if (!/^[0-9a-f]{24}$/.test(nonce)) return sayfa(res, 400, 'Bağlantı geçersiz', 'Bağlantı beklenen biçimde değil.');

    const smxId = String(g.isletme_no);
    const ad = String(g.isletme_adi || '').trim() || 'İşletme';
    const eposta = String(g.yetkili_email || '').trim().toLowerCase();
    const tel = String(g.yetkili_tel || '').trim();
    const gun = Math.max(1, Math.min(EN_COK_DENEME_GUN, Math.floor(Number(g.deneme_gun) || 7)));

    let sonuc;
    try {
        sonuc = await tx(async () => {
            // 4) NONCE - kiraci acilmadan ONCE, ayni transaction icinde. UNIQUE ihlali =
            //    bu baglanti daha once kullanilmis. Islem yarida kalirsa geri alinir.
            await query("DELETE FROM deneme_devir_nonce WHERE created_at < datetime('now', '-1 day')");
            try {
                await query('INSERT INTO deneme_devir_nonce (nonce, isletme_no) VALUES (?, ?)', [nonce, smxId]);
            } catch (e) {
                if (/UNIQUE|constraint/i.test(e.message)) return { hata: 'nonce' };
                throw e;
            }
            // 5) KIRACI - isletme_no ile esle; varsa yeni acma, giris yaptir.
            const P = require('../services/posProvizyon');
            const D = require('../services/denemeLisansi');
            // YALNIZCA isletme_no ile eslestir: telefon/e-posta eslesmesi ayni sahibin IKINCI
            // restoranini ilk restoranin hesabina baglardi (her restoran = ayri kiraci).
            const { tenantId: bulunan } = await P.kiraciBul({ smxId });
            if (bulunan) {
                const u = (await query(
                    "SELECT id FROM users WHERE tenant_id = ? AND is_active = 1 ORDER BY CASE role WHEN 'OWNER' THEN 0 ELSE 1 END, created_at LIMIT 1",
                    [bulunan])).rows[0];
                if (!u) return { hata: 'kullanici_yok', tenantId: bulunan };
                return { tenantId: bulunan, userId: u.id, yeni: false };
            }
            if (!eposta) return { hata: 'eposta_yok' };
            const bitis = new Date(simdi + gun * 86400000).toISOString();
            const y = await P.kiraciAc({ ad, eposta, tel, yetkiliAd: g.yetkili_ad, parentOrg: 'SofraMix',
                tier: 'TIER_DENEME', bitis, moduller: P.VARSAYILAN_MODULLER });
            // Fatura bilgileri bos olabilir - isletme SofraMix'te girmemis olabilir.
            await query(
                `UPDATE tenants SET billing_name = COALESCE(NULLIF(?, ''), billing_name),
                                    billing_tax_office = NULLIF(?, ''), billing_tax_id = NULLIF(?, ''), address = NULLIF(?, '')
                  WHERE id = ?`,
                [String(g.unvan || '').slice(0, 160), String(g.vergi_dairesi || '').slice(0, 80),
                    String(g.vergi_no || '').slice(0, 20), [g.ilce, g.il].filter(Boolean).join(' / ').slice(0, 120), y.tenantId]);
            await D.denemeKaydet({ tenantId: y.tenantId, telefon: tel, soframixBusinessId: smxId, isletmeAdi: ad, kaynak: 'soframix-devir' });
            return { tenantId: y.tenantId, userId: y.userId, yeni: true, jeton: y.aktivasyonJetonu, isyeriKodu: y.isyeriKodu, bitis };
        });
    } catch (e) {
        console.error('[deneme-devir] hata:', e.message);
        return sayfa(res, 500, 'Bir şeyler ters gitti', 'Deneme açılamadı. Lütfen bize yazın.');
    }
    if (sonuc.hata === 'nonce') return sayfa(res, 400, 'Bağlantı daha önce kullanılmış', 'Bu bağlantı tek kullanımlıktır. Hesabınız açıldıysa giriş ekranından girebilirsiniz; açılmadıysa SofraMix panelinden yeniden başlatın.');
    if (sonuc.hata === 'eposta_yok') return sayfa(res, 400, 'E-posta gerekli', 'SofraMix hesabınızda yetkili e-postası yok. Önce SofraMix panelinde e-postanızı girin, sonra yeniden deneyin.');
    if (sonuc.hata === 'kullanici_yok') return sayfa(res, 400, 'Hesap bulunamadı', 'İşletmeniz kayıtlı ama aktif kullanıcısı yok. Lütfen bize yazın.');

    // 6) Yeni isletmeye sifre belirleme postasi (sonraki girisler icin) - best-effort.
    if (sonuc.yeni && sonuc.jeton) {
        try {
            const temiz = (s) => String(s || '').replace(/[<>]/g, '');
            require('../services/posOdemeCekici').postaDene(eposta, 'MDA Restoran POS - denemeniz basladi',
                '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">'
                + '<h2 style="color:#E2622A;margin:0 0 12px">MDA Restoran POS</h2>'
                + '<p style="color:#374151">Merhaba ' + temiz(g.yetkili_ad || ad) + ',</p>'
                + '<p style="color:#374151"><b>' + temiz(ad) + '</b> için ' + gun + ' günlük denemeniz başladı. Sonraki girişler için şifrenizi belirleyin:</p>'
                + '<p style="margin:20px 0"><a href="' + PANEL + '/aktivasyon/' + sonuc.jeton.ham + '" style="background:#E2622A;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Şifremi belirle</a></p>'
                + '<p style="color:#374151;font-size:.92rem">İşyeri kodunuz: <b>' + sonuc.isyeriKodu + '</b> &middot; Deneme bitişi: <b>' + new Date(sonuc.bitis).toLocaleDateString('tr-TR') + '</b></p></div>',
                sonuc.tenantId).catch(() => {});
        } catch (_) { /* posta gitmese de devir tamam */ }
    }
    // 7) Tek kullanimlik giris jetonu -> panele yonlendir (JWT adres cubuguna YAZILMAZ).
    const ham = await girisJetonu(sonuc.tenantId, sonuc.userId);
    res.redirect(302, PANEL + '/deneme-giris/' + ham);
};

// POST /api/public/deneme-giris/:jeton -> login ile ayni sekilde { token, ... }
exports.girisJetonuKullan = async (req, res) => {
    const ham = String(req.params.jeton || '');
    if (ham.length < 20) return res.status(404).json({ message: 'Bağlantı geçersiz.' });
    const ozet = crypto.createHash('sha256').update(ham).digest('hex');
    const j = (await query('SELECT * FROM deneme_giris_jetonlari WHERE jeton_ozet = ?', [ozet])).rows[0];
    if (!j) return res.status(404).json({ message: 'Bağlantı geçersiz.' });
    if (j.kullanildi_at) return res.status(410).json({ message: 'Bu bağlantı kullanılmış. Giriş ekranından girebilirsiniz.' });
    if (new Date(j.son_gecerlilik).getTime() < Date.now()) return res.status(410).json({ message: 'Bağlantının süresi dolmuş. SofraMix panelinden yeniden başlatın.' });
    const u = (await query(
        `SELECT u.id, u.role, u.name, u.tenant_id, t.business_code, t.is_active AS tenant_active
           FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = ? AND u.is_active = 1`, [j.user_id])).rows[0];
    if (!u || !u.tenant_active) return res.status(403).json({ message: 'Hesap aktif değil.' });
    await query('UPDATE deneme_giris_jetonlari SET kullanildi_at = ? WHERE id = ?', [new Date().toISOString(), j.id]);
    res.json({ token: signToken(u.id), userId: u.id, role: u.role, name: u.name, tenantId: u.tenant_id, businessCode: u.business_code });
};

exports.acikMi = acikMi;
