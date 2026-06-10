// Demo veri seed'i — geliştirme için
// Çalıştır: node seed.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query, initDb } = require('./src/config/db');

const newToken = () => crypto.randomBytes(16).toString('hex');

async function main() {
    initDb();
    await new Promise(r => setTimeout(r, 800)); // DB init bekle

    const email = 'demo@mdayazilim.com';
    const exist = await query('SELECT u.id, u.tenant_id FROM users u WHERE u.email = ?', [email]);
    if (exist.rows.length) {
        console.log('Demo zaten var — tenant_id:', exist.rows[0].tenant_id);
        process.exit(0);
    }

    const tenantId = uuidv4();
    const userId = uuidv4();
    const slug = 'demo-restoran-' + crypto.randomBytes(2).toString('hex');
    const bizCode = String(10000 + Math.floor(Math.random() * 90000));
    const refCode = 'MDA' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const demoEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await query(
        `INSERT INTO tenants
            (id, slug, business_code, business_name, owner_email, phone, address,
             billing_name, billing_tax_office, billing_tax_id,
             referral_code, license_tier, license_modules, license_end_date, license_table_limit, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [tenantId, slug, bizCode, 'Demo Restoran', email, '0532 000 0000',
            'Kadıköy / İstanbul', 'Demo Restoran Ltd. Şti.', 'Kadıköy V.D.', '1234567890',
            refCode, 'TIER_6_10',
            JSON.stringify(['BASE', 'MENU_DIGITAL', 'GARSON', 'STOK']),
            demoEnd, 10]); // demo: 10 masa limiti

    const hash = await bcrypt.hash('demo1234', 10);
    await query(
        `INSERT INTO users (id, tenant_id, email, password_hash, name, role)
         VALUES (?, ?, ?, ?, ?, 'OWNER')`,
        [userId, tenantId, email, hash, 'Demo Patron']);

    // Masalar
    for (let i = 1; i <= 8; i++) {
        await query(
            `INSERT INTO tables (id, tenant_id, code, name, section, qr_token)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [uuidv4(), tenantId, `M${i}`, `Masa M${i}`, i <= 4 ? 'Salon' : 'Bahçe', newToken()]);
    }

    // Kategoriler
    const cats = ['Çorbalar', 'Ana Yemek', 'Tatlılar', 'Sıcak İçecek', 'Soğuk İçecek', 'Hizmet'];
    const catIds = {};
    for (let i = 0; i < cats.length; i++) {
        const id = uuidv4();
        catIds[cats[i]] = id;
        await query(
            `INSERT INTO categories (id, tenant_id, name, sort_order) VALUES (?, ?, ?, ?)`,
            [id, tenantId, cats[i], i]);
    }

    // Ürünler — [kategori, ad, satış fiyatı, MALİYET, stoklu mu, mevcut stok, birim, düşük stok limiti]
    const products = [
        ['Çorbalar', 'Mercimek Çorba', 75, 12, true, 50, 'porsiyon', 10],
        ['Çorbalar', 'Ezogelin Çorba', 75, 12, true, 40, 'porsiyon', 10],
        ['Ana Yemek', 'Adana Kebap', 280, 90, true, 30, 'porsiyon', 5],
        ['Ana Yemek', 'Tavuk Şiş', 220, 65, true, 25, 'porsiyon', 5],
        ['Ana Yemek', 'Karışık Izgara', 380, 140, true, 20, 'porsiyon', 5],
        ['Tatlılar', 'Künefe', 150, 35, true, 15, 'porsiyon', 3],
        ['Tatlılar', 'Sütlaç', 90, 12, true, 20, 'porsiyon', 5],
        ['Sıcak İçecek', 'Çay', 25, 1.5, false, 0, 'bardak', 0],
        ['Sıcak İçecek', 'Türk Kahvesi', 70, 8, false, 0, 'fincan', 0],
        ['Soğuk İçecek', 'Ayran', 35, 8, true, 100, 'adet', 20],
        ['Soğuk İçecek', 'Kola', 60, 18, true, 50, 'adet', 10],
        // Stoksuz hizmet ürünü (Patron'un örneği: oyun alanı) — maliyet 0
        ['Hizmet', 'Oyun Alanı (Saatlik)', 100, 0, false, 0, 'saat', 0]
    ];
    for (const [cat, name, price, cost, tracksStock, qty, unit, low] of products) {
        await query(
            `INSERT INTO products (id, tenant_id, category_id, name, price, cost, tracks_stock, stock_qty, stock_unit, low_stock_threshold, is_available)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [uuidv4(), tenantId, catIds[cat], name, price, cost, tracksStock ? 1 : 0, qty, unit, low]);
    }

    console.log('— Demo hazır —');
    console.log('  Login         : ' + email + ' / demo1234');
    console.log('  İşyeri Kodu   : ' + bizCode);
    console.log('  Referans Kodu : ' + refCode);
    console.log('  Slug          : ' + slug);
    console.log('  Tenant        : ' + tenantId);
    const t1 = await query('SELECT code, qr_token FROM tables WHERE tenant_id = ? LIMIT 1', [tenantId]);
    if (t1.rows.length) {
        console.log('  QR test: GET /api/public/m/' + slug + '/' + t1.rows[0].qr_token + '/menu');
    }
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
