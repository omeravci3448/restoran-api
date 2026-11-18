const { query } = require('../config/db');
const K = require('./kisaKod');

// --- Isletme duzeyi menu karekodu (yalniz QR menu kullanan isletme, "menu kipi") ---
// Karar: menu kipindeki isletmeye masa sayisi gerekmez; tek menu ve tek karekod yeter. Adres masa kisa koduyla ayni
// bicimde: <QR_PUBLIC_BASE>/q/<KOD>. Kod tenants.menu_kisa_kod'da, sistem genelinde tekil (UNIQUE indeks; masa
// kodlariyla da cakismasin diye uretimde tables.kisa_kod'a da bakilir). Kod kendiliginden degismez.
// Bu adresten acilan menu YALNIZ GORUNTULEMEDIR: siparis, garson cagirma ve hesap yok (masa yok).
//
// Menu kipi kapanmasi (root ayari menu_kipi_kapanma_gun, varsayilan 15, 0 = hic): yalniz QR menu kullanan
// isletmenin lisansi KAPALI durumuna gectikten N gun sonra misafir menusu 410 MENU_KAPALI doner (masa karekodu da,
// isletme karekodu da). Adisyon ve Kasa (BASE) olan isletmeler etkilenmez: onlarda menu her zaman gorunur kalir.

const GUN_MS = 86400000;
const KAPALI_YANIT = { code: 'MENU_KAPALI', message: 'Bu işletmenin menüsü şu an görüntülenemiyor.' };

// Isletmenin menu kodu; yoksa uretir ve yazar.
async function kodAl(tenantId) {
    const v = await query('SELECT menu_kisa_kod FROM tenants WHERE id = ?', [tenantId]);
    if (!v.rows.length) return null;
    if (v.rows[0].menu_kisa_kod && K.normalle(v.rows[0].menu_kisa_kod)) return v.rows[0].menu_kisa_kod;
    for (let i = 0; i < 12; i++) {
        const kod = K.uret();
        const masada = await query('SELECT 1 FROM tables WHERE kisa_kod = ?', [kod]);
        if (masada.rows.length) continue;
        try {
            const r = await query('UPDATE tenants SET menu_kisa_kod = ? WHERE id = ? AND (menu_kisa_kod IS NULL OR LENGTH(menu_kisa_kod) <> ?)',
                [kod, tenantId, K.UZUNLUK]);
            if (r.changes) return kod;
            const m = await query('SELECT menu_kisa_kod FROM tenants WHERE id = ?', [tenantId]);
            return m.rows.length ? m.rows[0].menu_kisa_kod : null;
        } catch (e) {
            if (!String(e.message).includes('UNIQUE')) throw e;
        }
    }
    throw new Error('Menü karekodu üretilemedi.');
}

// /q/<KOD> icin: masa kodu bulunamadiysa isletme menu koduna bakilir.
// Doner: null (boyle bir menu kodu yok) | { durum: 'aktif' | 'pasif', slug, menu }
async function kisaKodCoz(kod) {
    const k = K.normalle(kod);
    if (!k) return null;
    const r = await query('SELECT slug, is_active FROM tenants WHERE menu_kisa_kod = ?', [k]);
    const x = r.rows[0];
    if (!x) return null;
    return { durum: Number(x.is_active) === 1 ? 'aktif' : 'pasif', slug: x.slug, menu: k };
}

// t: { id | tenant_id, license_modules, license_end_date }. Menu kipinde ve lisans N gundur KAPALI ise true.
function menuKapaliMi(t, simdi = new Date()) {
    if (!t) return false;
    if (!require('./lisansModul').menuKipiMi(t.license_modules)) return false;
    const n = require('./yonetimAyar').menuKipiKapanmaGun();
    if (!n) return false;
    // Odeme korumasi (havale bildirildi, onay bekliyor) varken durum AKTIF doner: menu acik kalir
    const h = require('./odemeKorumasi').etkinDurumSenkron(t.id || t.tenant_id, t.license_end_date, simdi);
    if (h.durum !== 'KAPALI' || !h.toleransBitis) return false;
    return simdi.getTime() - new Date(h.toleransBitis).getTime() > n * GUN_MS;
}

// Misafir menusu (kategoriler + urunler): masa menusuyle ayni alanlar
async function menuVerisi(tenantId) {
    const cats = await query(
        'SELECT id, name, sort_order FROM categories WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order, name',
        [tenantId]);
    const prods = await query(
        `SELECT id, category_id, name, description, price, image_url, stock_unit,
                allergens, ingredients, calories, portion_grams, contains_alcohol, contains_pork
           FROM products
          WHERE tenant_id = ? AND is_available = 1
          ORDER BY sort_order, name`,
        [tenantId]);
    return { categories: cats.rows, products: prods.rows };
}

module.exports = { KAPALI_YANIT, kodAl, kisaKodCoz, menuKapaliMi, menuVerisi };
