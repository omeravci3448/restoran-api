const { query } = require('../config/db');
const H = require('../services/plakaHak');
const C = require('../services/plakaCizim');
const K = require('../services/kisaKod');
const M = require('../services/lisansModul');
const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

// --- Plaka Talepleri (root paneli) ---
// Liste, ayrinti, durum gecisleri, not, baski dosyasi (PDF) ve plaka ayarlari.
//
// Durum gecisleri (root):
//   odeme_alindi : ODEME_BEKLENIYOR -> ODEME_ALINDI
//   hazirlaniyor : ALINDI | ODEME_ALINDI -> HAZIRLANIYOR
//   kargoda      : ALINDI | ODEME_ALINDI | HAZIRLANIYOR -> KARGODA (kargo firmasi + takip no zorunlu)
//   teslim       : KARGODA -> TESLIM_EDILDI
//   reddet       : ALINDI | ODEME_BEKLENIYOR | ODEME_ALINDI | HAZIRLANIYOR -> REDDEDILDI (sebep zorunlu; isletme gorur)
// Odeme beklenen talep, odeme alinmadan hazirlanamaz ve kargoya verilemez.

const GECIS = {
    odeme_alindi: { kaynak: ['ODEME_BEKLENIYOR'], hedef: 'ODEME_ALINDI', alan: 'odeme_alindi_at' },
    hazirlaniyor: { kaynak: ['ALINDI', 'ODEME_ALINDI'], hedef: 'HAZIRLANIYOR', alan: 'hazirlaniyor_at' },
    kargoda: { kaynak: ['ALINDI', 'ODEME_ALINDI', 'HAZIRLANIYOR'], hedef: 'KARGODA', alan: 'kargoya_verildi_at' },
    teslim: { kaynak: ['KARGODA'], hedef: 'TESLIM_EDILDI', alan: 'teslim_at' },
    reddet: { kaynak: ['ALINDI', 'ODEME_BEKLENIYOR', 'ODEME_ALINDI', 'HAZIRLANIYOR'], hedef: 'REDDEDILDI', alan: 'red_at' },
};

// Talepteki masalarin BUGUNKU durumu: aktif mi, kisa kodu ne (kisa kod yenilendiyse baskida yenisi kullanilir)
async function masaDurumlari(talepler) {
    const ids = new Set();
    for (const x of talepler) { try { for (const m of JSON.parse(x.masalar_json || '[]')) if (m && m.id) ids.add(String(m.id)); } catch (_) {} }
    const dizi = Array.from(ids);
    const harita = new Map();
    for (let i = 0; i < dizi.length; i += 500) {
        const parca = dizi.slice(i, i + 500);
        const r = await query(`SELECT id, is_active, kisa_kod FROM tables WHERE id IN (${parca.map(() => '?').join(', ')})`, parca);
        for (const t of r.rows) harita.set(t.id, { aktif: Number(t.is_active) === 1, kisaKod: t.kisa_kod });
    }
    return harita;
}

function hazirla(x, harita) {
    let masalar = [];
    try { masalar = JSON.parse(x.masalar_json || '[]'); } catch (_) { masalar = []; }
    if (harita) {
        masalar = masalar.map((m) => {
            const g = harita.get(String(m.id));
            // Masa silinmis (ya da kaydi yok): plakadaki karekod calismaz, ayrintida ve baski kapaginda isaretlenir
            return { ...m, aktif: !!(g && g.aktif), guncelKisaKod: g && g.kisaKod ? g.kisaKod : m.kisaKod };
        });
    }
    const { masalar_json: _m, ...kalan } = x;
    const moduller = M.modulListesi(x.moduller);
    const { mevcut_moduller: mm, ...dig } = kalan;
    return { ...dig, masalar, moduller, modul_adlari: moduller.map((m) => M.AD[m] || m), menu_kipi: M.menuKipiMi(moduller),
        mevcut_moduller: M.modulListesi(mm), durum_ad: H.DURUM_AD[x.durum] || x.durum };
}

const SEC = `SELECT p.*, t.business_name, t.business_code, t.phone AS isletme_telefon, t.license_modules AS mevcut_moduller
               FROM plaka_talepleri p LEFT JOIN tenants t ON t.id = p.tenant_id`;

// GET /api/root/plaka/talepler?durum=acik|hepsi|<DURUM>
exports.liste = async (req, res) => {
    const d = String(req.query.durum || 'acik');
    let kos = '', p = [];
    if (d === 'acik') kos = "WHERE p.durum NOT IN ('TESLIM_EDILDI', 'IPTAL', 'REDDEDILDI')";
    else if (H.DURUMLAR.includes(d)) { kos = 'WHERE p.durum = ?'; p = [d]; }
    const r = await query(`${SEC} ${kos}
        ORDER BY CASE p.durum WHEN 'ALINDI' THEN 0 WHEN 'ODEME_ALINDI' THEN 1 WHEN 'ODEME_BEKLENIYOR' THEN 2
                              WHEN 'HAZIRLANIYOR' THEN 3 WHEN 'KARGODA' THEN 4 ELSE 5 END, p.created_at DESC
        LIMIT 300`, p);
    const harita = await masaDurumlari(r.rows);
    res.json(r.rows.map((x) => hazirla(x, harita)));
};

// Islem bekleyen talep sayisi (sekme rozeti): yeni, odemesi alinmis, "odemeyi yaptim" denmis
exports.sayac = async (_req, res) => {
    const r = await query(
        `SELECT COUNT(*) AS c FROM plaka_talepleri
          WHERE durum IN ('ALINDI', 'ODEME_ALINDI') OR (durum = 'ODEME_BEKLENIYOR' AND odeme_bildirildi_at IS NOT NULL)`);
    res.json({ bekleyen: Number(r.rows[0].c) || 0 });
};

// GET /api/root/plaka/talepler/:id
exports.getir = async (req, res) => {
    const r = await query(`${SEC} WHERE p.id = ?`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ message: 'Talep bulunamadı.' });
    res.json(hazirla(r.rows[0], await masaDurumlari(r.rows)));
};

// POST /api/root/plaka/talepler/:id/durum  { islem, kargoFirma, takipNo, sebep }
exports.durum = async (req, res) => {
    const b = req.body || {};
    if (!has(GECIS, b.islem)) return res.status(400).json({ message: 'Geçersiz işlem.' });
    const g = GECIS[b.islem];
    const set = ['durum = ?', `${g.alan} = CURRENT_TIMESTAMP`, 'updated_at = CURRENT_TIMESTAMP'];
    const p = [g.hedef];
    if (b.islem === 'kargoda') {
        const firma = String(b.kargoFirma || '').trim().slice(0, 60);
        const takip = String(b.takipNo || '').trim().slice(0, 60);
        if (firma.length < 2 || takip.length < 3) return res.status(400).json({ message: 'Kargo firması ve takip numarası zorunlu.' });
        set.push('kargo_firma = ?', 'takip_no = ?'); p.push(firma, takip);
    }
    if (b.islem === 'reddet') {
        const sebep = String(b.sebep || '').trim().slice(0, 300);
        if (sebep.length < 3) return res.status(400).json({ message: 'Red sebebi yazın (işletme bunu görecek).' });
        set.push('red_sebebi = ?'); p.push(sebep);
    }
    const yer = g.kaynak.map(() => '?').join(', ');
    const r = await query(`UPDATE plaka_talepleri SET ${set.join(', ')} WHERE id = ? AND durum IN (${yer})`,
        [...p, req.params.id, ...g.kaynak]);
    if (!r.changes) {
        const v = await query('SELECT durum FROM plaka_talepleri WHERE id = ?', [req.params.id]);
        if (!v.rows.length) return res.status(404).json({ message: 'Talep bulunamadı.' });
        return res.status(409).json({ code: 'GECERSIZ_GECIS',
            message: `Bu talep "${H.DURUM_AD[v.rows[0].durum] || v.rows[0].durum}" durumunda; bu işlem yapılamaz.` });
    }
    const x = await query(`${SEC} WHERE p.id = ?`, [req.params.id]);
    res.json(hazirla(x.rows[0], await masaDurumlari(x.rows)));
};

// POST /api/root/plaka/talepler/:id/not  { not }  - yalniz root gorur
exports.not = async (req, res) => {
    const not = String((req.body || {}).not || '').trim().slice(0, 1000);
    const r = await query('UPDATE plaka_talepleri SET root_not = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [not || null, req.params.id]);
    if (!r.changes) return res.status(404).json({ message: 'Talep bulunamadı.' });
    res.json({ ok: true, root_not: not || null });
};

// GET /api/root/plaka/talepler/:id/baski.pdf  - kapak + her plaka gercek olcude bir sayfa
exports.baski = async (req, res) => {
    const r = await query(`${SEC} WHERE p.id = ?`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ message: 'Talep bulunamadı.' });
    const x = hazirla(r.rows[0], await masaDurumlari(r.rows));
    const t = (await query(
        'SELECT id, business_name, logo_url, license_modules, qr_siparis_acik, qr_garson_acik, qr_hesap_acik FROM tenants WHERE id = ?',
        [x.tenant_id])).rows[0] || { id: x.tenant_id, business_name: x.business_name || 'İşletme' };
    // Talep anindaki logo; dosyasi silinmisse (logo sonradan degistirildiyse) guncel logo
    let logo = C.logoYukle(t.id, x.logo_url);
    if ((!logo || !logo.uygun) && t.logo_url && t.logo_url !== x.logo_url) logo = C.logoYukle(t.id, t.logo_url);
    const olcu = has(C.OLCU, req.query.olcu) ? req.query.olcu : (has(C.OLCU, x.olcu) ? x.olcu : '80x80');
    const buf = await C.plakaPdf({
        talepNo: x.talep_no, tarih: x.created_at, isletmeAdi: t.business_name, olcu,
        logo: logo && logo.uygun ? logo : null,
        logoUyari: logo && !logo.uygun ? logo.uyari : (!logo ? 'İşletmenin logosu yok; logo yerine işletme adı basıldı.' : null),
        altMetin: M.okutunMetni(t),
        // Guncel kisa kod (talepten sonra "Kisa kodu yenile" dendiyse yenisi); silinmis masa kapakta isaretli
        masalar: x.masalar.map((m) => ({ ad: m.ad, kisaKod: m.guncelKisaKod, hediye: !!m.hediye, pasif: !m.aktif, adres: K.kisaAdres(m.guncelKisaKod) })),
        hediyeAdet: x.hediye_adet, ucretliAdet: x.ucretli_adet,
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="plaka-talep-${x.talep_no}.pdf"`);
    res.set('Cache-Control', 'no-store');
    res.send(buf);
};

// POST /api/root/masalar/:id/kisa-kod-yenile - root: kayip/calinan plaka gibi durumlarda masanin kisa kodunu yeniler.
// Eski kod artik cozulmez (basili plakanin karekodu calismaz); talep baskisi guncel kodu kullanir.
exports.masaKisaKodYenile = async (req, res) => {
    const r = await query('SELECT id, tenant_id, name, kisa_kod, is_active FROM tables WHERE id = ?', [req.params.id]);
    if (!r.rows.length || !r.rows[0].is_active) return res.status(404).json({ message: 'Masa bulunamadı ya da silinmiş.' });
    const eski = r.rows[0].kisa_kod || null;
    const kod = await K.yenile(r.rows[0].id);
    console.log('[root] kisa kod yenilendi:', r.rows[0].tenant_id, r.rows[0].name, eski, '->', kod);
    res.json({ kisaKod: kod, kisaAdres: K.kisaAdres(kod), eskiKod: eski,
        message: `${r.rows[0].name}: kısa kod yenilendi (${kod}). Basılı plakanın karekodu artık çalışmaz.` });
};

// GET/PUT /api/root/plaka/ayarlar  { birimFiyat, kargoUcreti, olcu, maliyetBirim, maliyetKargo }
exports.ayarlar = async (_req, res) => {
    res.json({ ...(await H.ayarlar()), olculer: H.OLCULER });
};
exports.ayarYaz = async (req, res) => {
    try {
        res.json({ ...(await H.ayarYaz(req.body || {})), olculer: H.OLCULER });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ message: e.message });
        throw e;
    }
};

// --- Hediye plaka kurallari ---
// GET /api/root/plaka/kurallar  (+ kural duzenleyicinin modul secenekleri)
exports.kurallar = async (_req, res) => {
    const K = require('../services/lisansKatalog');
    const kat = await K.tamKatalog();
    res.json({
        kurallar: await H.kurallar(),
        moduller: kat.filter((x) => x.tur === 'MODUL').map((x) => ({ kod: x.kod, ad: M.AD[x.kod] || x.ad })),
        varsayilanEnCok: H.VARSAYILAN_EN_COK,
    });
};
// POST /api/root/plaka/kurallar  { ad, moduller[], enAzTutar, enCokPlaka, aktif }
exports.kuralEkle = async (req, res) => {
    try { res.status(201).json(await H.kuralEkle(req.body || {})); }
    catch (e) { if (e.status) return res.status(e.status).json({ message: e.message }); throw e; }
};
// PATCH /api/root/plaka/kurallar/:id
exports.kuralGuncelle = async (req, res) => {
    try {
        const k = await H.kuralGuncelle(req.params.id, req.body || {});
        if (!k) return res.status(404).json({ message: 'Kural bulunamadı.' });
        res.json(k);
    } catch (e) { if (e.status) return res.status(e.status).json({ message: e.message }); throw e; }
};
// DELETE /api/root/plaka/kurallar/:id  (verilmis hediyeler etkilenmez; talep kural adini kopya tutar)
exports.kuralSil = async (req, res) => {
    if (!(await H.kuralSil(req.params.id))) return res.status(404).json({ message: 'Kural bulunamadı.' });
    res.json({ ok: true });
};
// GET /api/root/plaka/kurallar/onizleme?birimMaliyet=&kargoMaliyet=  (bos ise kayitli ayar)
exports.kuralOnizleme = async (req, res) => {
    const ay = await H.ayarlar();
    const q = req.query || {};
    const birimMaliyet = q.birimMaliyet !== undefined && q.birimMaliyet !== '' ? Number(q.birimMaliyet) : (ay.maliyetBirim || 0);
    const kargoMaliyet = q.kargoMaliyet !== undefined && q.kargoMaliyet !== '' ? Number(q.kargoMaliyet) : (ay.maliyetKargo || 0);
    if (!Number.isFinite(birimMaliyet) || !Number.isFinite(kargoMaliyet) || birimMaliyet < 0 || kargoMaliyet < 0) {
        return res.status(400).json({ message: 'Maliyet tutarları geçersiz.' });
    }
    res.json(await H.kuralOnizleme({ birimMaliyet, kargoMaliyet }));
};

// GET /api/root/plaka/hak/:tenantId - root Duzenle penceresinde "otomatik kural su an ne diyor"
exports.hak = async (req, res) => {
    const d = await H.hediyeDurumu(req.params.tenantId);
    if (!d) return res.status(404).json({ message: 'İşletme bulunamadı.' });
    res.json(d);
};
