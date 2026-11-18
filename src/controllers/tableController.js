const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { query } = require('../config/db');
const G = require('../services/islemGunlugu');

const newToken = () => crypto.randomBytes(16).toString('hex');

// Yeni masaya kisa karekod (/q/<KOD>). Uretilemezse masa yine acilir; acilistaki doldurma tamamlar.
async function kisaKodVer(tableId) {
    try { return await require('../services/kisaKod').masayaAta(tableId); }
    catch (e) { console.error('[kisa-kod] masa', tableId, e.message); return null; }
}

// Aktif masa sayısını döndürür (is_active=1)
async function activeTableCount(tenantId) {
    const r = await query('SELECT COUNT(*) AS c FROM tables WHERE tenant_id = ? AND is_active = 1', [tenantId]);
    return Number(r.rows[0].c);
}

// Tier kodunu YEREL olarak okunur etikete çevir — HUB ÇAĞRISI YOK (hız kritik).
// Masalar sayfası her açılışta çağırdığı için ağ çağrısı yapılırsa ekran kilitlenir.
function prettyTierLabel(tierName) {
    if (!tierName) return '';
    if (tierName === 'TIER_MENU') return 'QR Menü';   // yalniz QR menu paketi (masa kademesi yok)
    const m =String(tierName).match(/^TIER_(\d+)_(\d+)$/);
    if (m) return `${m[1]}-${m[2]} Masa`;
    if (/^TIER_(\d+)_PLUS$/.test(tierName)) return `${tierName.match(/\d+/)[0]}+ Masa`;
    return String(tierName).replace(/^TIER_/, '').replace(/_/g, ' ');
}

// Verilen kadar daha eklemek lisans sınırını aşıyor mu kontrol eder
// Limit: tenant.license_table_limit (null = sınırsız). HUB ÇAĞRISI YOK.
async function checkTableLimit(req, res, addCount = 1) {
    const limit = req.user.licenseTableLimit;
    if (limit == null) return false; // null = sınırsız
    const current = await activeTableCount(req.user.tenantId);
    if (current + addCount > limit) {
        const label = prettyTierLabel(req.user.licenseTier);
        res.status(403).json({
            code: 'TABLE_LIMIT_REACHED',
            tier: req.user.licenseTier,
            tierLabel: label,
            limit,
            currentCount: current,
            attempted: addCount,
            message: `Lisans paketin (${label}) en fazla ${limit} masaya izin veriyor. Şu an ${current} masan var. Daha fazlası için Lisans sayfasından paketini yükselt.`
        });
        return true;
    }
    return false;
}

exports.list = async (req, res) => {
    const r = await query(
        `SELECT t.*,
                (SELECT id FROM orders o WHERE o.table_id = t.id AND o.status = 'OPEN' LIMIT 1) AS open_order_id,
                (SELECT total FROM orders o WHERE o.table_id = t.id AND o.status = 'OPEN' LIMIT 1) AS open_order_total
           FROM tables t
          WHERE t.tenant_id = ? AND t.is_active = 1
          ORDER BY t.section, LENGTH(t.code), t.code`,
        [req.user.tenantId]
    );
    // Plaka talebi kapanmamis (iptal ya da red DISINDAKI her durum: alindi, odeme, hazirlik, kargo, teslim) masalar:
    // silme penceresi uyarsin, plakadaki karekod masa silinince calismaz. Talepler masa listesinin KOPYASINI tutar.
    const basilan = new Set();
    try {
        const p = await query(
            "SELECT masalar_json FROM plaka_talepleri WHERE tenant_id = ? AND durum NOT IN ('IPTAL', 'REDDEDILDI')",
            [req.user.tenantId]);
        for (const x of p.rows) { try { for (const m of JSON.parse(x.masalar_json || '[]')) basilan.add(m.id); } catch (_) {} }
    } catch (_) { /* plaka tablosu yoksa (eski veritabani) uyari cikmaz */ }
    res.json(r.rows.map((t) => (basilan.has(t.id) ? { ...t, plaka_basildi: 1 } : t)));
};

// Butun aktif masalarin karekodu, A4 (sayfa basina 9). Kisa adresle (/q/<KOD>): basilan karekod
// qr_token yenilense de calisir. Sadece QR Menu isletmesi de kendi bastirabilsin diye her rol indirebilir.
exports.karekodlarPdf = async (req, res) => {
    const K = require('../services/kisaKod');
    const C = require('../services/plakaCizim');
    const M = require('../services/lisansModul');
    await K.eksikleriDoldur(req.user.tenantId);
    const t = (await query('SELECT business_name, license_modules, qr_siparis_acik, qr_garson_acik, qr_hesap_acik FROM tenants WHERE id = ?',
        [req.user.tenantId])).rows[0];
    const r = await query(
        `SELECT name, kisa_kod FROM tables WHERE tenant_id = ? AND is_active = 1
          ORDER BY section, LENGTH(code), code`, [req.user.tenantId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Henüz masa yok.' });
    const buf = await C.karekodSayfasiPdf({
        isletmeAdi: (t && t.business_name) || 'İşletme',
        altMetin: M.okutunMetni(t || {}),
        masalar: r.rows.map((m) => ({ ad: m.name, kisaKod: m.kisa_kod, adres: K.kisaAdres(m.kisa_kod) })),
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'attachment; filename="masa-karekodlari.pdf"');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
};

// Ayrı endpoint: yalnızca lisans/limit özetini döndürür
exports.limitInfo = async (req, res) => {
    const limit = req.user.licenseTableLimit;
    const used = await activeTableCount(req.user.tenantId);
    const label = prettyTierLabel(req.user.licenseTier);
    res.json({
        tier: req.user.licenseTier,
        tierLabel: label,
        limit, // null = sınırsız
        used,
        remaining: limit == null ? null : Math.max(0, limit - used)
    });
};

exports.create = async (req, res) => {
    const { code, name, section, capacity, positionX, positionY } = req.body;
    if (!code || !name) return res.status(400).json({ message: 'Kod ve ad zorunlu.' });
    if (await checkTableLimit(req, res, 1)) return;
    const id = uuidv4();
    try {
        await query(
            `INSERT INTO tables (id, tenant_id, code, name, section, capacity, qr_token, position_x, position_y)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, req.user.tenantId, code, name, section || null, capacity || 4, newToken(), positionX || 0, positionY || 0]
        );
        const kisaKod = await kisaKodVer(id);
        res.status(201).json({ id, code, name, kisaKod });
    } catch (e) {
        if (String(e.message).includes('UNIQUE')) return res.status(409).json({ message: 'Bu masa kodu zaten kullanılıyor.' });
        throw e;
    }
};

// RegExp icin kacis (kod harfi kullanicidan geliyor)
const kacis = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Silinmis (pasif) bir masa bu kodu tutuyorsa kodu serbest birakir. Kod isletme icinde tekil
// (UNIQUE tenant_id+code); pasif kayit yeni bir masanin ya da yeniden adlandirmanin onunu
// kesmesin. Gecmis raporlar masa ADINI gosterdigi icin pasif kaydin kodu degisse de bir sey bozulmaz.
// Doner: 'bos' (kimse kullanmiyor) | 'dolu' (aktif bir masada) | 'bosaltildi'
async function pasifKoduBosalt(tenantId, code, haricId) {
    const r = await query('SELECT id, is_active, pasif_sebep FROM tables WHERE tenant_id = ? AND code = ? AND id <> ?',
        [tenantId, code, haricId || '']);
    if (!r.rows.length) return 'bos';
    // Lisans siniri yuzunden pasif masa (services/masaSiniri.js) yeniden aktif edilebilir: kodu korunur
    if (r.rows[0].is_active || r.rows[0].pasif_sebep === 'lisans') return 'dolu';
    await query('UPDATE tables SET code = ? WHERE id = ? AND tenant_id = ?',
        [code + '~' + String(r.rows[0].id).slice(0, 8), r.rows[0].id, tenantId]);
    return 'bosaltildi';
}

// Masa silinebilir mi? Acik hesabi ya da kasa onayi bekleyen QR siparisi olan masa silinmez:
// silinseydi o hesap Masalar ekranindan kaybolur, kimse kapatamazdi.
async function silmeEngeli(tenantId, tableId) {
    const acik = await query("SELECT 1 FROM orders WHERE tenant_id = ? AND table_id = ? AND status = 'OPEN' LIMIT 1",
        [tenantId, tableId]);
    if (acik.rows.length) return { kod: 'ACIK_HESAP', mesaj: 'Bu masada açık hesap var. Önce hesabı kapatın ya da başka masaya aktarın, sonra silin.' };
    const bekleyen = await query("SELECT 1 FROM qr_bekleyen_siparisler WHERE tenant_id = ? AND table_id = ? AND durum = 'BEKLIYOR' LIMIT 1",
        [tenantId, tableId]);
    if (bekleyen.rows.length) return { kod: 'ONAY_BEKLIYOR', mesaj: 'Bu masada kasa onayı bekleyen QR siparişi var. Önce onaylayın ya da reddedin, sonra silin.' };
    return null;
}

// Toplu ekleme: numara KALDIGI YERDEN surer. Eskiden hep 1'den basliyordu; M1-M5 varken "M" ile
// 5 masa daha istenince kodlar cakisiyor, hepsi sessizce atlaniyor ve ekranda hicbir sey olmuyordu.
// Simdi bu harfle (silinmisler dahil) en buyuk numaranin ustune eklenir.
exports.bulkCreate = async (req, res) => {
    const b = req.body || {};
    const count = Number(b.count);
    const prefix = String(b.prefix == null ? 'M' : b.prefix).trim().slice(0, 6);
    const section = String(b.section || '').trim().slice(0, 40) || null;
    if (!Number.isInteger(count) || count < 1 || count > 100) return res.status(400).json({ message: 'Masa sayısı 1 ile 100 arasında olmalı.' });
    if (/\s|~/.test(prefix)) return res.status(400).json({ message: 'Kod harfinde boşluk ya da ~ olmasın (örnek: M, B, T).' });
    if (await checkTableLimit(req, res, count)) return;
    const mevcut = await query('SELECT code FROM tables WHERE tenant_id = ?', [req.user.tenantId]);
    const desen = new RegExp('^' + kacis(prefix) + '(\\d+)$');
    let enBuyuk = 0;
    for (const x of mevcut.rows) {
        const m = desen.exec(x.code);
        if (m) enBuyuk = Math.max(enBuyuk, Number(m[1]));
    }
    const created = [];
    for (let i = 1; i <= count; i++) {
        const code = prefix + String(enBuyuk + i);
        const id = uuidv4();
        try {
            await query(
                'INSERT INTO tables (id, tenant_id, code, name, section, qr_token) VALUES (?, ?, ?, ?, ?, ?)',
                [id, req.user.tenantId, code, 'Masa ' + code, section, newToken()]);
            await kisaKodVer(id);
            created.push({ id, code });
        } catch (e) {
            if (!String(e.message).includes('UNIQUE')) throw e;
        }
    }
    res.status(201).json({
        created, eklenen: created.length,
        ilk: created.length ? created[0].code : null,
        son: created.length ? created[created.length - 1].code : null,
    });
};

// Masa duzenleme: kod, ad, bolum, kisi sayisi. Yalniz GONDERILEN alanlar degisir.
exports.update = async (req, res) => {
    const b = req.body || {};
    const tenantId = req.user.tenantId;
    const cur = await query('SELECT id, code, name, is_active FROM tables WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
    if (!cur.rows.length) return res.status(404).json({ message: 'Masa bulunamadı.' });
    const masa = cur.rows[0];
    const set = [], p = [];

    if (b.code !== undefined) {
        const code = String(b.code == null ? '' : b.code).trim().slice(0, 12);
        if (!code) return res.status(400).json({ message: 'Masa kodu boş olamaz.' });
        if (code.includes('~')) return res.status(400).json({ message: 'Masa kodunda ~ işareti kullanılamaz.' });
        if (code !== masa.code) {
            const d = await pasifKoduBosalt(tenantId, code, masa.id);
            if (d === 'dolu') return res.status(409).json({ message: '"' + code + '" kodu başka bir masada kullanılıyor.' });
            set.push('code = ?'); p.push(code);
        }
    }
    if (b.name !== undefined) {
        const name = String(b.name == null ? '' : b.name).trim().slice(0, 40);
        if (!name) return res.status(400).json({ message: 'Masa adı boş olamaz.' });
        set.push('name = ?'); p.push(name);
    }
    if (b.section !== undefined) {
        set.push('section = ?'); p.push(String(b.section == null ? '' : b.section).trim().slice(0, 40) || null);
    }
    if (b.capacity !== undefined && b.capacity !== null && b.capacity !== '') {
        const k = Number(b.capacity);
        if (!Number.isInteger(k) || k < 1 || k > 99) return res.status(400).json({ message: 'Kişi sayısı 1 ile 99 arasında olmalı.' });
        set.push('capacity = ?'); p.push(k);
    }
    if (b.positionX !== undefined) { set.push('position_x = ?'); p.push(Number(b.positionX) || 0); }
    if (b.positionY !== undefined) { set.push('position_y = ?'); p.push(Number(b.positionY) || 0); }
    if (b.isActive !== undefined) {
        const aktif = b.isActive === true || b.isActive === 1 || b.isActive === '1';
        // Silinmis masayi geri acmak lisans sinirina tabidir
        if (aktif && !masa.is_active && await checkTableLimit(req, res, 1)) return;
        if (!aktif && masa.is_active) {
            const engel = await silmeEngeli(tenantId, masa.id);
            if (engel) return res.status(409).json({ code: engel.kod, message: engel.mesaj });
        }
        set.push('is_active = ?'); p.push(aktif ? 1 : 0);
        if (aktif) set.push('pasif_sebep = NULL');   // lisans pasifi de kalkar (services/masaSiniri.js)
    }
    if (!set.length) return res.json({ message: 'Değişiklik yok.' });
    try {
        await query('UPDATE tables SET ' + set.join(', ') + ' WHERE id = ? AND tenant_id = ?', [...p, masa.id, tenantId]);
    } catch (e) {
        if (String(e.message).includes('UNIQUE')) return res.status(409).json({ message: 'Bu masa kodu başka bir masada kullanılıyor.' });
        throw e;
    }
    res.json({ message: 'Güncellendi.' });
};

// Silme = pasiflestirme: gecmis hesaplar ve raporlar masanin adini gostermeye devam eder.
// QR kodu da artik menu acmaz (publicController aktif masaya bakiyor).
exports.remove = async (req, res) => {
    const tenantId = req.user.tenantId;
    const r = await query('SELECT id, code, name, is_active FROM tables WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Masa bulunamadı.' });
    const masa = r.rows[0];
    if (!masa.is_active) return res.json({ message: 'Masa zaten silinmiş.' });
    const engel = await silmeEngeli(tenantId, masa.id);
    if (engel) return res.status(409).json({ code: engel.kod, message: engel.mesaj });
    await query("UPDATE tables SET is_active = 0, status = 'EMPTY' WHERE id = ? AND tenant_id = ?", [masa.id, tenantId]);
    // Bu masadan bekleyen garson cagrisi kalmasin (silinmis masaya kimse gitmeyecek)
    await query("UPDATE waiter_calls SET status = 'HANDLED', handled_at = CURRENT_TIMESTAMP, handled_by = ? WHERE tenant_id = ? AND table_id = ? AND status = 'PENDING'",
        [req.user.id, tenantId, masa.id]).catch(() => {});
    G.kaydet({ tenantId, user: req.user, islem: 'masa_sil', hedefTur: 'table', hedefId: masa.id, detay: masa.name + ' (' + masa.code + ')' });
    res.json({ message: 'Masa silindi.' });
};

// QR kod PNG döndür (her masa için). Kisa adresle (/q/<KOD>): daha seyrek karekod, qr_token yenilense de calisir.
// Eski /m/<slug>/<qr_token> adresleri calismaya devam eder (once basilmis karekodlar).
exports.qrPng = async (req, res) => {
    const K = require('../services/kisaKod');
    const r = await query(
        'SELECT t.id, t.kisa_kod, t.qr_token, te.slug FROM tables t JOIN tenants te ON te.id = t.tenant_id WHERE t.id = ? AND t.tenant_id = ?',
        [req.params.id, req.user.tenantId]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Masa yok.' });
    const m = r.rows[0];
    const base = String(req.query.publicBase || K.kamuAdresi()).replace(/\/+$/, '');
    let kod = m.kisa_kod && K.normalle(m.kisa_kod) ? m.kisa_kod : null;
    if (!kod) { try { await K.eksikleriDoldur(req.user.tenantId); kod = (await query('SELECT kisa_kod FROM tables WHERE id = ?', [m.id])).rows[0].kisa_kod; } catch (_) { kod = null; } }
    const url = kod ? `${base}/q/${kod}` : `${base}/m/${m.slug}/${m.qr_token}`;
    const png = await QRCode.toBuffer(url, { width: 480, margin: 2, errorCorrectionLevel: 'Q' });
    res.type('image/png').send(png);
};

// POST /api/tables/:id/kisa-kod-yenile (sahip/mudur + yonetici sifresi). Eski kod artik cozulmez: basili plakanin
// karekodu calismaz, yeniden bastirmak gerekir (arayuz bunu sorar).
exports.kisaKodYenile = async (req, res) => {
    const K = require('../services/kisaKod');
    const r = await query('SELECT id, name, kisa_kod, is_active FROM tables WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenantId]);
    if (!r.rows.length || !r.rows[0].is_active) return res.status(404).json({ message: 'Masa bulunamadı.' });
    const eski = r.rows[0].kisa_kod || null;
    const kod = await K.yenile(r.rows[0].id);
    G.kaydet({ tenantId: req.user.tenantId, user: req.user, islem: 'kisa_kod_yenile', hedefTur: 'table', hedefId: r.rows[0].id,
        detay: r.rows[0].name + ': ' + (eski || '-') + ' -> ' + kod });
    res.json({ kisaKod: kod, kisaAdres: K.kisaAdres(kod), eskiKod: eski,
        message: 'Kısa kod yenilendi. Basılı plakanın karekodu artık çalışmaz; yeniden bastırmanız gerekir.' });
};

exports.regenerateToken = async (req, res) => {
    const token = newToken();
    await query('UPDATE tables SET qr_token = ? WHERE id = ? AND tenant_id = ?',
        [token, req.params.id, req.user.tenantId]);
    res.json({ qrToken: token });
};

// --- Lisans siniri yuzunden pasif masalar (services/masaSiniri.js) ---
// GET /api/tables/lisans-pasif: Masalar sayfasindaki bilgi kutusu (fe LisansPasifMasalar)
exports.lisansPasifListe = async (req, res) => {
    const MS = require('../services/masaSiniri');
    const limit = req.user.licenseTableLimit == null ? null : Number(req.user.licenseTableLimit);
    res.json({ limit, used: await activeTableCount(req.user.tenantId), masalar: await MS.pasifListe(req.user.tenantId) });
};

// POST /api/tables/:id/lisans-aktif: lisans pasifindeki masayi yeniden aktif eder (sinira tabi). Kod ve kisa kod
// degismedigi icin masanin karekodu yeniden calisir.
exports.lisansAktifEt = async (req, res) => {
    const tenantId = req.user.tenantId;
    const r = await query('SELECT id, code, name, is_active, pasif_sebep FROM tables WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
    const masa = r.rows[0];
    if (!masa) return res.status(404).json({ message: 'Masa bulunamadı.' });
    if (masa.is_active) return res.json({ ok: true, message: 'Masa zaten aktif.' });
    if (masa.pasif_sebep !== 'lisans') return res.status(409).json({ message: 'Bu masa lisans sınırı nedeniyle pasif değil.' });
    const limit = req.user.licenseTableLimit == null ? null : Number(req.user.licenseTableLimit);
    if (limit != null && (await activeTableCount(tenantId)) + 1 > limit) {
        return res.status(403).json({ code: 'TABLE_LIMIT_REACHED', limit,
            message: `Lisansınız ${limit} masa ile sınırlı. Başka bir masayı aktif etmek için önce bir masayı pasife alın ya da paketinizi büyütün.` });
    }
    // Ayni kodla aktif bir masa varsa (eski veri) kod degistirilmeden durulur
    const cakisma = await query('SELECT 1 FROM tables WHERE tenant_id = ? AND code = ? AND id <> ? AND is_active = 1', [tenantId, masa.code, masa.id]);
    if (cakisma.rows.length) return res.status(409).json({ message: '"' + masa.code + '" kodu başka bir masada kullanılıyor.' });
    await query("UPDATE tables SET is_active = 1, pasif_sebep = NULL, status = 'EMPTY' WHERE id = ? AND tenant_id = ? AND is_active = 0", [masa.id, tenantId]);
    G.kaydet({ tenantId, user: req.user, islem: 'masa_lisans_aktif', hedefTur: 'table', hedefId: masa.id, detay: masa.name + ' (' + masa.code + ') yeniden aktif edildi' });
    res.json({ ok: true, message: masa.name + ' aktif edildi.' });
};
