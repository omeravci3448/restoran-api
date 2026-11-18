const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const bus = require('../services/eventBus');
const { hesabaYaz, kalemleriHazirla } = require('../services/qrSiparis');
const push = require('../services/pushBildirim');
const { qrOzellikleri } = require('../services/lisansModul');

// Ozellik etkin degilse (lisansta modul yok ya da isletme Ayarlar > QR Menu'den kapatti): 403 + makine kodu.
// Siparis: QR_SIPARIS (+ BASE) + anahtar; garson cagir: GARSON + MENU_DIGITAL + anahtar; hesap: BASE + anahtar.
// QR menu zaten dugmeyi gostermez; bu kapi eski sekmede kalan ya da elle istek atan icindir.
const KAPALI = {
    siparis: { code: 'QR_SIPARIS_KAPALI', message: 'Bu işletmede QR menüden sipariş alınmıyor. Siparişiniz için lütfen personele başvurun.' },
    hesap: { code: 'QR_HESAP_KAPALI', message: 'Bu işletmede hesap QR menüden görüntülenemiyor. Hesabınız için lütfen personele başvurun.' },
    garson: { code: 'QR_GARSON_KAPALI', message: 'Bu işletmede QR menüden garson çağrılamıyor. Lütfen personele başvurun.' },
};
// Lisans durumu (guvenlik incelemesi O5): lisansi KAPALI isletmede QR'dan siparis, garson cagrisi ve hesap kapali;
// menu gorunur kalir (masadaki plaka bozuk gorunmesin). SALT_OKUNUR'da yalniz siparis kapali (kasa hesabi
// kapatamaz); garson cagrisi ve hesap acik. Misafire ayni kod ve "lutfen personele basvurun" aciklamasi doner;
// QR menu bu kodla dugmeyi hemen gizler, menu yanitindaki ozellikler de dugmeleri bastan gizler.
function lisansIzinVerir(ctx, ad) {
    // Odeme korumasi (onay bekleyen bildirilmis odeme) varsa isletme acik sayilir (services/odemeKorumasi.js)
    const d = require('../services/odemeKorumasi').etkinDurumSenkron(ctx && ctx.tenant_id, ctx && ctx.license_end_date).durum;
    if (d === 'KAPALI') return false;
    if (d === 'SALT_OKUNUR' && ad === 'siparis') return false;
    return true;
}
// Misafirin kullanabilecegi ozellikler: modul + isletme anahtari + lisans durumu
function etkinOzellikler(ctx) {
    const o = qrOzellikleri(ctx);
    return { siparis: o.siparis && lisansIzinVerir(ctx, 'siparis'), garson: o.garson && lisansIzinVerir(ctx, 'garson'),
        hesap: o.hesap && lisansIzinVerir(ctx, 'hesap') };
}
function ozellikKapali(ctx, ad, res) {
    if (etkinOzellikler(ctx)[ad]) return false;
    res.status(403).json(KAPALI[ad]);
    return true;
}
exports.ozellikKapali = ozellikKapali;

// QR siparisi telefona (garson uygulamasi kapaliyken de). Musteri notu bildirime girmez.
function qrTelefonaBildir(ctx, adet, tutar, bekliyor) {
    const masa = ctx.table_name || ctx.table_code || 'Masa';
    const tl = Number(tutar || 0).toLocaleString('tr-TR', { maximumFractionDigits: 2 }) + ' ₺';
    push.arkadaBildir(ctx.tenant_id, 'qr', {
        baslik: `🧾 ${masa}: yeni QR siparişi`,
        govde: [`${adet} kalem · ${tl}`, bekliyor ? 'Kasa onayı bekliyor' : ''].filter(Boolean).join(' · '),
        etiket: 'qr-' + ctx.table_id,
        url: '/garson/masa/' + ctx.table_id,
    });
}

// QR'dan gelen müşteri için bu masanın bağlamını döndür
async function loadTableContext(tenantSlug, qrToken) {
    const r = await query(
        `SELECT te.id AS tenant_id, te.business_name, te.slug, te.license_modules, te.license_end_date, te.logo_url, te.qr_onay_gerekli,
                te.qr_siparis_acik, te.qr_garson_acik, te.qr_hesap_acik,
                tb.id AS table_id, tb.code AS table_code, tb.name AS table_name, tb.section
           FROM tenants te JOIN tables tb ON tb.tenant_id = te.id
          WHERE te.slug = ? AND tb.qr_token = ? AND te.is_active = 1 AND tb.is_active = 1`,
        [tenantSlug, qrToken]);
    return r.rows[0] || null;
}

function tenantHasModule(ctx, mod) {
    try {
        const arr = JSON.parse(ctx.license_modules || '[]');
        return arr.includes(mod) || arr.includes('ALL');
    } catch (_) { return false; }
}

// Masa bağlamı + menü kategorileri + ürünler
exports.menu = async (req, res) => {
    const { tenantSlug, qrToken } = req.params;
    const ctx = await loadTableContext(tenantSlug, qrToken);
    if (!ctx) return res.status(404).json({ message: 'QR geçersiz veya işletme pasif.' });
    if (!tenantHasModule(ctx, 'MENU_DIGITAL')) {
        return res.status(403).json({ code: 'MODULE_NOT_LICENSED', message: 'Dijital menü modülü aktif değil.' });
    }
    const cats = await query(
        'SELECT id, name, sort_order FROM categories WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order, name',
        [ctx.tenant_id]);
    const prods = await query(
        `SELECT id, category_id, name, description, price, image_url, stock_unit,
                allergens, ingredients, calories, portion_grams, contains_alcohol, contains_pork
           FROM products
          WHERE tenant_id = ? AND is_available = 1
          ORDER BY sort_order, name`,
        [ctx.tenant_id]);
    res.json({
        business: { name: ctx.business_name, slug: ctx.slug, logo_url: ctx.logo_url || null },
        table: { code: ctx.table_code, name: ctx.table_name, section: ctx.section },
        // Misafirin kullanabilecegi ozellikler: kapali olan dugme QR menude hic gosterilmez
        ozellikler: etkinOzellikler(ctx),
        categories: cats.rows,
        products: prods.rows
    });
};

// Masanın anlık hesabı — müşteri kasaya gitmeden ne ödeyeceğini görsün
exports.bill = async (req, res) => {
    const { tenantSlug, qrToken } = req.params;
    const ctx = await loadTableContext(tenantSlug, qrToken);
    if (!ctx) return res.status(404).json({ message: 'QR geçersiz.' });
    if (ozellikKapali(ctx, 'hesap', res)) return;
    // Kasa onayi bekleyen kalemler: musteri "siparisim gitti mi?" diye tekrar gondermesin
    const bek = await query(
        "SELECT kalemler_json FROM qr_bekleyen_siparisler WHERE tenant_id = ? AND table_id = ? AND durum = 'BEKLIYOR' ORDER BY created_at",
        [ctx.tenant_id, ctx.table_id]);
    const bekleyen = [];
    for (const b of bek.rows) {
        try { for (const k of JSON.parse(b.kalemler_json)) bekleyen.push({ name: k.name, qty: k.qty, unit_price: k.unitPrice, total: k.total }); } catch (_) {}
    }
    const o = await query(
        "SELECT * FROM orders WHERE tenant_id = ? AND table_id = ? AND status = 'OPEN' LIMIT 1",
        [ctx.tenant_id, ctx.table_id]);
    if (!o.rows.length) return res.json({ items: [], total: 0, bekleyen });
    const items = await query(
        'SELECT product_name AS name, qty, unit_price, total, status FROM order_items WHERE order_id = ? ORDER BY created_at',
        [o.rows[0].id]);
    res.json({
        orderId: o.rows[0].id,
        openedAt: o.rows[0].opened_at,
        items: items.rows,
        subtotal: o.rows[0].subtotal,
        total: o.rows[0].total,
        bekleyen
    });
};

// Müşteri kendi siparişini gönderir — STAFF onayı için NEW statüsünde girilir
exports.placeOrder = async (req, res) => {
    const { tenantSlug, qrToken } = req.params;
    const { items = [], note } = req.body;
    if (!items.length) return res.status(400).json({ message: 'Sepet boş.' });

    const ctx = await loadTableContext(tenantSlug, qrToken);
    if (!ctx) return res.status(404).json({ message: 'QR geçersiz.' });
    if (ozellikKapali(ctx, 'siparis', res)) return;

    const olay = { tableId: ctx.table_id, tableName: ctx.table_name, tableCode: ctx.table_code, section: ctx.section };

    // Isletme "kasa onaylamadan hesaba girmesin" dediyse: hesaba yazilmaz, bekleyen listeye duser.
    // Kasa Masalar sayfasinda onaylar ya da reddeder; onayda ayni hesabaYaz yolu calisir.
    if (ctx.qr_onay_gerekli) {
        const acik = await query("SELECT COUNT(*) AS c FROM qr_bekleyen_siparisler WHERE tenant_id = ? AND table_id = ? AND durum = 'BEKLIYOR'",
            [ctx.tenant_id, ctx.table_id]);
        if (Number(acik.rows[0].c) >= 5) {
            return res.status(429).json({ message: 'Önceki siparişleriniz kasa onayı bekliyor. Lütfen garsona sorun.' });
        }
        const { kalemler, toplam } = await kalemleriHazirla(ctx.tenant_id, items);
        if (!kalemler.length) return res.status(400).json({ message: 'Sepetteki ürünler şu an satışta değil.' });
        const id = uuidv4();
        await query(
            `INSERT INTO qr_bekleyen_siparisler (id, tenant_id, table_id, kalemler_json, not_metni, toplam)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, ctx.tenant_id, ctx.table_id, JSON.stringify(kalemler), note || null, toplam]);
        bus.emit(ctx.tenant_id, 'new_order', { ...olay, pending: true, bekleyenId: id, addedItems: kalemler.length, addedSubtotal: toplam });
        qrTelefonaBildir(ctx, kalemler.length, toplam, true);
        return res.status(201).json({ pending: true, bekleyenId: id, addedItems: kalemler.length, addedSubtotal: toplam });
    }

    const r = await hesabaYaz({ tenantId: ctx.tenant_id, tableId: ctx.table_id, items, note, status: 'NEW' });

    // Kasaya anlık bildirim (yalnızca gerçekten kalem eklendiyse)
    if (r.added > 0) {
        bus.emit(ctx.tenant_id, 'new_order', { ...olay, orderId: r.orderId, addedItems: r.added, addedSubtotal: r.subAdded, orderTotal: r.total });
        qrTelefonaBildir(ctx, r.added, r.subAdded, false);
    }
    res.status(201).json({ orderId: r.orderId, addedItems: r.added, addedSubtotal: r.subAdded, orderTotal: r.total, atlanan: r.atlanan });
};

// Public garson çağrısı — auth gerekmez, sadece QR token doğrulanır
const waiterCtrl = require('./waiterController');
exports.callWaiter = waiterCtrl.publicCall;

// Deneme suresi (gun): tanitim, kayit ve giris sayfalarindaki "N gun ucretsiz" metinleri root Sistem Ayarlari'ndan
// okur (karar 2026-11-12). Ayar yoksa 7 (DENEME_GUN). Tarayici onbellege almaz: ayar degisince sayfalar hemen
// yeni sureyi gosterir (uc hafif; sayfa basina bir istek).
exports.denemeGun = async (_req, res) => {
    let gun = 7;
    try { gun = await require('../services/yonetimAyar').denemeGunOku(); } catch (_) { gun = Number(process.env.DENEME_GUN || 7); }
    res.set('Cache-Control', 'no-cache');
    res.json({ gun });
};

// Kisa karekod cozumu: /q/<KOD> -> { slug, token }. Yalniz aktif masa + aktif isletme; degilse 404.
// IP basina sinir: 8 haneli kod uzayi kaba kuvvetle taranmasin (services/kisaKod.js).
// Oran siniri yalniz BOS denemeleri sayar (services/kisaKod.js); suren istek sayaci beklemeden ONCE artar.
// Kod bulunursa (aktif ya da silinmis masanin plakasi) bos deneme sayilmaz.
exports.kisaKodCoz = async (req, res) => {
    const K = require('../services/kisaKod');
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || '?';
    const bitir = K.denemeBaslat(ip);
    if (!bitir) return res.status(429).json({ code: 'COK_FAZLA_ISTEK', message: 'Çok fazla deneme. Lütfen biraz sonra tekrar deneyin.' });
    let c;
    try { c = await K.coz(req.params.kod); }
    finally { bitir(!!(c && (c.durum === 'aktif' || c.durum === 'pasif'))); }
    res.set('Cache-Control', 'no-store');
    if (c.durum === 'pasif') {
        return res.status(404).json({ code: 'KISA_KOD_PASIF', message: 'Bu masa artık kullanılmıyor. Lütfen personele başvurun.' });
    }
    if (c.durum !== 'aktif') {
        return res.status(404).json({ code: 'KISA_KOD_YOK', message: 'Bu karekod geçerli değil. Lütfen personele başvurun.' });
    }
    res.json({ slug: c.slug, token: c.token });
};
