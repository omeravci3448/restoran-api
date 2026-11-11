const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');
const H = require('../services/plakaHak');
const C = require('../services/plakaCizim');
const K = require('../services/kisaKod');
const M = require('../services/lisansModul');
const A = require('../services/sistemAyar');
const { rootaBildir } = require('../services/rootBildirim');

// --- Masa Plakalari (isletme tarafi, OWNER/MANAGER) ---
// Hediye ve ucretli plaka talebi, canli onizleme, talep listesi, iptal ve "odemeyi yaptim".
// Kural ve hesaplar services/plakaHak.js'te; cizim services/plakaCizim.js'te.

const hata = (status, code, message, ek) => Object.assign(new Error(message), { status, code, ek });
const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
// Ayni isletmeden bu sure icinde ayni masa listesiyle ikinci talep (cift tiklama / yeniden gonderim) 409
const MUKERRER_SN = 120;

async function isletme(tenantId) {
    const r = await query(
        `SELECT id, business_name, business_code, phone, address, owner_email, logo_url,
                license_modules, qr_siparis_acik, qr_garson_acik, qr_hesap_acik
           FROM tenants WHERE id = ?`, [tenantId]);
    return r.rows[0] || null;
}

// Aktif masalar, plaka sirasiyla (bolum, kod). Kisa kodu olmayanlara once kod verilir.
async function aktifMasalar(tenantId) {
    await K.eksikleriDoldur(tenantId);
    const r = await query(
        `SELECT id, code, name, section, kisa_kod FROM tables
          WHERE tenant_id = ? AND is_active = 1
          ORDER BY section, LENGTH(code), code`, [tenantId]);
    return r.rows;
}

function logoOzeti(logo) {
    if (!logo) return { var: false };
    return { var: true, url: logo.url, uygun: !!logo.uygun, bicim: logo.tur, uzunKenar: logo.uzunKenar || 0, uyari: logo.uyari || null };
}

// Isletmeye gosterilen talep (root notu YOK)
function talepHazirla(x) {
    let masalar = [];
    try { masalar = JSON.parse(x.masalar_json || '[]'); } catch (_) { masalar = []; }
    const { masalar_json: _m, root_not: _r, created_by: _c, ...kalan } = x;
    return { ...kalan, masalar, durum_ad: H.DURUM_AD[x.durum] || x.durum };
}

// Root'a e-posta + yonetim APK'si olayi (root_olaylar, UNIQUE tur+ref: her olay bir kez)
async function rootaHaberVer(tur, talep, t, satirlar, detay) {
    try {
        await query('INSERT OR IGNORE INTO root_olaylar (tur, ref, tenant_id, baslik, detay) VALUES (?, ?, ?, ?, ?)',
            [tur, talep.id, t.id, String(t.business_name || 'İşletme').slice(0, 120), String(detay).slice(0, 300)]);
    } catch (e) { console.error('[plaka] olay yazilamadi:', e.message); }
    const konu = tur === 'plaka_odeme' ? 'Plaka ödemesi bildirildi: ' : 'Yeni masa plakası talebi: ';
    rootaBildir(konu + (t.business_name || 'İşletme'), satirlar, { dugme: 'Root paneli > Plaka Talepleri', sekme: 'plakalar' }).catch(() => {});
}

const tl = (n) => Number(n || 0).toLocaleString('tr-TR', { maximumFractionDigits: 2 }) + ' TL';

// GET /api/plaka/durum
exports.durum = async (req, res) => {
    const t = await isletme(req.user.tenantId);
    if (!t) return res.status(404).json({ message: 'İşletme bulunamadı.' });
    const [hediye, ay, masalar] = await Promise.all([H.hediyeDurumu(t.id), H.ayarlar(), aktifMasalar(t.id)]);
    const logo = C.logoYukle(t.id, t.logo_url);
    res.json({
        moduller: M.modulListesi(t.license_modules),
        menuKipi: M.menuKipiMi(t.license_modules),
        hediye,
        fiyat: { birimFiyat: ay.birimFiyat, kargoUcreti: ay.kargoUcreti, ucretliAcik: ay.birimFiyat != null },
        olcu: ay.olcu,
        logo: logoOzeti(logo),
        altMetin: M.okutunMetni(t),
        isletme: { ad: t.business_name, telefon: t.phone || '', adres: t.address || '' },
        masalar: masalar.map((m) => ({ id: m.id, ad: m.name, kod: m.code, bolum: m.section || '', kisaKod: m.kisa_kod, adres: K.kisaAdres(m.kisa_kod) })),
        banka: {
            iban: await A.oku('iban', ''), hesapSahibi: await A.oku('iban_sahibi', ''),
            banka: await A.oku('banka_adi', ''), aciklama: await A.oku('odeme_aciklama', ''),
        },
    });
};

// GET /api/plaka/onizleme?tableId=  -> yerlesim JSON (baski dosyasiyla ayni cizim)
exports.onizleme = async (req, res) => {
    const t = await isletme(req.user.tenantId);
    if (!t) return res.status(404).json({ message: 'İşletme bulunamadı.' });
    const r = await query('SELECT id, name, kisa_kod FROM tables WHERE id = ? AND tenant_id = ? AND is_active = 1',
        [String(req.query.tableId || ''), t.id]);
    if (!r.rows.length) return res.status(404).json({ message: 'Masa bulunamadı.' });
    const m = r.rows[0];
    const kod = m.kisa_kod || await K.masayaAta(m.id);
    const ay = await H.ayarlar();
    const olcu = has(C.OLCU, req.query.olcu) ? req.query.olcu : ay.olcu;
    const logo = C.logoYukle(t.id, t.logo_url);
    const y = C.plakaYerlesimi({ olcu, logo, isletmeAdi: t.business_name, masaAdi: m.name, altMetin: M.okutunMetni(t), adres: K.kisaAdres(kod) });
    res.json({ ...C.onizlemeJson(y), kisaKod: kod, logo: logoOzeti(logo) });
};

// GET /api/plaka/talepler
exports.liste = async (req, res) => {
    const r = await query('SELECT * FROM plaka_talepleri WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100', [req.user.tenantId]);
    res.json(r.rows.map(talepHazirla));
};

// POST /api/plaka/talepler  { tableIds: [], aliciAd, telefon, adres, not }
exports.olustur = async (req, res) => {
    const b = req.body || {};
    const al = (k, max) => String(b[k] == null ? '' : b[k]).replace(/\s+/g, ' ').trim().slice(0, max);
    const aliciAd = al('aliciAd', 80);
    const telefon = al('telefon', 30);
    const adres = String(b.adres == null ? '' : b.adres).trim().slice(0, 400);
    const notMetni = al('not', 300);
    if (aliciAd.length < 3) return res.status(400).json({ message: 'Alıcı adını yazın.' });
    if ((telefon.match(/\d/g) || []).length < 10) return res.status(400).json({ message: 'Telefon numarası eksik görünüyor.' });
    if (adres.length < 10) return res.status(400).json({ message: 'Teslimat adresini eksiksiz yazın.' });

    const ids = Array.isArray(b.tableIds) ? Array.from(new Set(b.tableIds.map(String))) : [];
    if (!ids.length) return res.status(400).json({ message: 'En az bir masa seçin.' });
    if (ids.length > 200) return res.status(400).json({ message: 'Tek talepte en çok 200 plaka istenebilir.' });

    const t = await isletme(req.user.tenantId);
    if (!t) return res.status(404).json({ message: 'İşletme bulunamadı.' });
    // Plakanin ust kismi isletme logosu: logo yoksa ya da baskiya uygun degilse talep alinmaz
    const logo = C.logoYukle(t.id, t.logo_url);
    if (!logo) return res.status(409).json({ code: 'LOGO_YOK', message: 'Plakada işletme logosu yer alır. Önce Ayarlar > Logo bölümünden logonuzu yükleyin.' });
    if (!logo.uygun) return res.status(409).json({ code: 'LOGO_UYGUN_DEGIL', message: logo.uyari });

    const masalar = (await aktifMasalar(t.id)).filter((m) => ids.includes(m.id));
    if (masalar.length !== ids.length) return res.status(400).json({ message: 'Seçilen masalardan bazıları bulunamadı ya da silinmiş. Sayfayı yenileyip tekrar seçin.' });
    const ay = await H.ayarlar();

    let sonuc;
    try {
        // Tek transaction: ayni anda iki talep hediye hakkini iki kez kullanamaz (1 set kurali)
        sonuc = await tx(async () => {
            // Cift gonderim korumasi: kisa surede ayni masa listesiyle acik bir talep varsa ikincisi acilmaz
            const anahtar = masalar.map((m) => m.id).sort().join(',');
            const son = await query(
                `SELECT id, talep_no, masalar_json FROM plaka_talepleri
                  WHERE tenant_id = ? AND durum NOT IN ('IPTAL', 'REDDEDILDI')
                    AND created_at >= datetime('now', ?)`, [t.id, `-${MUKERRER_SN} seconds`]);
            for (const x of son.rows) {
                let ids = [];
                try { ids = JSON.parse(x.masalar_json || '[]').map((m) => m.id); } catch (_) { ids = []; }
                if (ids.sort().join(',') === anahtar) {
                    throw hata(409, 'MUKERRER_TALEP', `Bu masalar için talebiniz az önce alındı (talep no ${x.talep_no}).`, { id: x.id, talepNo: x.talep_no });
                }
            }
            const hd = await H.hediyeDurumu(t.id);
            const kalan = hd.durum === 'VAR' ? hd.adet : 0;
            const d = H.dagit(masalar.length, kalan, ay);
            if (d.ucretli > 0 && !d.ucretliAcik) {
                throw hata(409, 'UCRETLI_KAPALI', kalan > 0
                    ? `Hediye hakkınız ${kalan} plaka. Fazlası ücretli plaka olur; ücretli plaka için bizimle iletişime geçin.`
                    : 'Ücretli plaka için bizimle iletişime geçin.');
            }
            const no = Number((await query('SELECT COALESCE(MAX(talep_no), 1000) + 1 AS n FROM plaka_talepleri')).rows[0].n);
            const kopya = masalar.map((m, i) => ({ id: m.id, ad: m.name, kod: m.code, bolum: m.section || '', kisaKod: m.kisa_kod, hediye: i < d.hediye }));
            const id = uuidv4();
            const durum = d.ucretli > 0 ? 'ODEME_BEKLENIYOR' : 'ALINDI';
            await query(
                `INSERT INTO plaka_talepleri
                    (id, talep_no, tenant_id, moduller, hediye_kural_id, hediye_kural_ad, durum, hediye_adet, ucretli_adet, birim_fiyat, kargo_ucreti, tutar,
                     olcu, logo_url, masalar_json, alici_ad, telefon, adres, not_metni, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, no, t.id, JSON.stringify(M.modulListesi(t.license_modules)),
                    d.hediye > 0 && hd.kural ? hd.kural.id : null, d.hediye > 0 ? (hd.kural ? hd.kural.ad : (hd.kaynak === 'elle_ver' ? 'Elle verildi' : null)) : null,
                    durum, d.hediye, d.ucretli,
                    d.ucretli > 0 ? d.birimFiyat : null, d.ucretli > 0 ? d.kargoUcreti : null, d.tutar,
                    ay.olcu, t.logo_url, JSON.stringify(kopya), aliciAd, telefon, adres, notMetni || null, req.user.id]);
            return { id, talepNo: no, durum, kural: hd.kural, ...d };
        });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ code: e.code, message: e.message, ...(e.ek || {}) });
        throw e;
    }

    rootaHaberVer('plaka_talebi', { id: sonuc.id }, t, [
        ['İşletme', t.business_name + (t.business_code ? ' (kod ' + t.business_code + ')' : '')],
        ['Talep no', String(sonuc.talepNo)],
        ['Modüller', M.modulListesi(t.license_modules).map((m) => M.AD[m] || m).join(', ') || '-'],
        ['Hediye kuralı', sonuc.hediye > 0 ? (sonuc.kural ? sonuc.kural.ad : 'Elle verildi') : '-'],
        ['Plaka', `${masalar.length} adet (${sonuc.hediye} hediye, ${sonuc.ucretli} ücretli)`],
        ['Tutar', sonuc.ucretli > 0 ? tl(sonuc.tutar) + ' (KDV dahil' + (sonuc.kargoUcreti ? ', kargo dahil' : '') + ')' : 'Ücretsiz (hediye)'],
        ['Ölçü', ay.olcu.replace('x', ' x ') + ' mm'],
        ['Yapılacak', sonuc.ucretli > 0 ? 'Ödeme bekleniyor; ödeme görülünce Plaka Talepleri sekmesinden "Ödeme alındı" deyin.' : 'Plaka Talepleri sekmesinden baskı dosyasını indirip hazırlamaya başlayın.'],
    ], `Masa plakası talebi #${sonuc.talepNo}: ${masalar.length} plaka (${sonuc.hediye} hediye, ${sonuc.ucretli} ücretli)`);

    const r = await query('SELECT * FROM plaka_talepleri WHERE id = ?', [sonuc.id]);
    res.status(201).json(talepHazirla(r.rows[0]));
};

// POST /api/plaka/talepler/:id/iptal  - isletme yalniz Alindi iken ya da odemesini HENUZ BILDIRMEDIGI odeme
// bekleyen talepte. "Odemeyi yaptim" dendiyse yalniz root iptal eder (para yolda olabilir).
exports.iptal = async (req, res) => {
    const r = await query(
        `UPDATE plaka_talepleri SET durum = 'IPTAL', iptal_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND tenant_id = ?
            AND (durum = 'ALINDI' OR (durum = 'ODEME_BEKLENIYOR' AND odeme_bildirildi_at IS NULL))`, [req.params.id, req.user.tenantId]);
    if (!r.changes) {
        const v = await query('SELECT durum, odeme_bildirildi_at FROM plaka_talepleri WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenantId]);
        if (!v.rows.length) return res.status(404).json({ message: 'Talep bulunamadı.' });
        if (v.rows[0].durum === 'ODEME_BEKLENIYOR' && v.rows[0].odeme_bildirildi_at) {
            return res.status(409).json({ code: 'ODEME_BILDIRILDI', message: 'Ödeme bildiriminiz alındığı için talep buradan iptal edilemez. İptal için bizimle iletişime geçin.' });
        }
        return res.status(409).json({ code: 'IPTAL_EDILEMEZ', message: 'Bu talep hazırlık aşamasına geçtiği için iptal edilemez. Değişiklik için bizimle iletişime geçin.' });
    }
    const x = await query('SELECT * FROM plaka_talepleri WHERE id = ?', [req.params.id]);
    res.json(talepHazirla(x.rows[0]));
};

// POST /api/plaka/talepler/:id/odeme  { ref }  - "Odemeyi yaptim" (bir kez)
exports.odemeYaptim = async (req, res) => {
    const ref = String((req.body || {}).ref || '').trim().slice(0, 200);
    const r = await query(
        `UPDATE plaka_talepleri SET odeme_bildirildi_at = CURRENT_TIMESTAMP, odeme_ref = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND tenant_id = ? AND durum = 'ODEME_BEKLENIYOR' AND odeme_bildirildi_at IS NULL`,
        [ref || null, req.params.id, req.user.tenantId]);
    if (!r.changes) {
        const v = await query('SELECT durum, odeme_bildirildi_at FROM plaka_talepleri WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenantId]);
        if (!v.rows.length) return res.status(404).json({ message: 'Talep bulunamadı.' });
        if (v.rows[0].odeme_bildirildi_at) return res.status(409).json({ code: 'ZATEN_BILDIRILDI', message: 'Ödeme bildiriminiz zaten alındı.' });
        return res.status(409).json({ code: 'ODEME_BEKLENMIYOR', message: 'Bu talep için ödeme beklenmiyor.' });
    }
    const x = (await query('SELECT * FROM plaka_talepleri WHERE id = ?', [req.params.id])).rows[0];
    const t = await isletme(req.user.tenantId);
    rootaHaberVer('plaka_odeme', x, t, [
        ['İşletme', t.business_name + (t.business_code ? ' (kod ' + t.business_code + ')' : '')],
        ['Talep no', String(x.talep_no)],
        ['Tutar', tl(x.tutar)],
        ['Referans', ref || '-'],
        ['Yapılacak', 'Hesabı kontrol edip Plaka Talepleri sekmesinden "Ödeme alındı" deyin.'],
    ], `Plaka talebi #${x.talep_no}: ödeme yapıldı bildirimi, ${tl(x.tutar)}`);
    res.json(talepHazirla(x));
};

module.exports.talepHazirla = talepHazirla;
