const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');
const { getAdapter } = require('../marketplace/registry');
const cred = require('../marketplace/core/credentialStore');

// ——— Pazaryerinden menu aktarimi (onizleme + yazma) ———
// channelSetupController.pullMenu'den cikarildi ki hem "Menuyu cek" dugmesi hem de
// SofraMix OTOMATIK baglantisi (soframixOtoBaglanti) ayni kodu kullansin.
//
// PATRON KARARI (2026-09-22): gorseller gelir, FIYAT 0 gelir, maliyet bos kalir ve
// urunler PASIF baslar. 0 TL'lik urun kazara masaya eklenip bedava satilamaz.
//
// Donus: { kod, govde } - cagiran taraf HTTP yaniti ya da log olarak kullanir.

function ctxKur(tenantId, credentials, storeLink) {
    return { tenantId, credentials, storeLink, env: 'prod',
             http: (u, o) => fetch(u, { ...(o || {}), signal: AbortSignal.timeout(20000) }) };
}

async function menuCek({ tenantId, kanalId, uygula }) {
    const ch = (await query('SELECT * FROM marketplace_channels WHERE id = ? AND tenant_id = ?', [kanalId, tenantId])).rows[0];
    if (!ch) return { kod: 404, govde: { message: 'Kanal yok.' } };

    let adaptor;
    try { adaptor = getAdapter(ch.adapter_code); } catch (e) { return { kod: 400, govde: { message: e.message } }; }
    if (!adaptor.capabilities.menuRead) return { kod: 400, govde: { message: 'Bu kanaldan menü okunamıyor.' } };

    const link = (await query('SELECT * FROM marketplace_store_links WHERE tenant_id = ? AND channel_id = ? AND is_active = 1',
        [tenantId, ch.id])).rows[0];
    if (!link) return { kod: 400, govde: { message: 'Önce bağlantı kurun.' } };

    let menu;
    try {
        menu = await cred.withCredentials(tenantId, ch.id, (c) =>
            adaptor.pullMenu(ctxKur(tenantId, c, { externalStoreId: link.external_store_id })));
    } catch (e) {
        // 401 = anahtar SofraMix'te iptal edilmis/gecersiz -> kimligi 'invalid' isaretle.
        // (403 = izin eksik; anahtar gecerli, isaretleme.)
        if (e && e.kind === 'AUTH' && String(e.httpStatus) === '401') {
            await cred.markInvalidForChannel(tenantId, ch.id).catch(() => {});
            return { kod: 502, govde: { message: 'SofraMix bağlantısı koptu: anahtar geçersiz ya da iptal edilmiş. SofraMix panelinden "Programı aç" deyince yeniden bağlanır; ya da Ayarlar > Pazaryeri Kanalları > Bağla ile yeni anahtar girin.', kimlikGecersiz: true } };
        }
        return { kod: 502, govde: { message: 'Menü alınamadı: ' + (e.message || 'bilinmeyen hata') } };
    }

    // Zaten eslenmis olanlari bul - ikinci cekiste mukerrer urun olusmasin.
    const mevcutEsleme = (await query(
        'SELECT kind, external_id, pos_ref_id FROM marketplace_product_map WHERE tenant_id = ? AND channel_id = ?',
        [tenantId, ch.id])).rows;
    const eslenmis = new Map(mevcutEsleme.map((m) => [m.kind + ':' + m.external_id, m.pos_ref_id]));

    const yeniKategori = menu.kategoriler.filter((k) => !eslenmis.has('category:' + k.externalId));
    const yeniUrun = menu.urunler.filter((u) => !eslenmis.has('product:' + u.externalId));

    if (!uygula) {
        return { kod: 200, govde: {
            onizleme: true,
            kategori: { toplam: menu.kategoriler.length, yeni: yeniKategori.length },
            urun: { toplam: menu.urunler.length, yeni: yeniUrun.length },
            ornekler: yeniUrun.slice(0, 8).map((u) => ({ ad: u.name, gorsel: !!u.imageUrl })),
            beyansizUrun: menu.beyansizUrun || 0,
            bilinmeyenAlerjenKodu: menu.bilinmeyenAlerjenKodu || [],
        } };
    }

    // --- Yazma: TEK transaction, eslesme tx ICINDE yeniden okunur ---
    // Oto-baglanti arka planda cekerken isletme "Aktar"a basarsa (ya da cift tiklarsa) iki cekis
    // yarisir; yazma kilidi + taze okuma sayesinde ikinci cekis birincinin yazdiklarini gorur,
    // mukerrer kategori/urun olusmaz. Urun + esleme ya birlikte yazilir ya hic (yetim urun yok).
    const yazim = await tx(async () => {
    const mevcutEsleme = (await query(
        'SELECT kind, external_id, pos_ref_id FROM marketplace_product_map WHERE tenant_id = ? AND channel_id = ?',
        [tenantId, ch.id])).rows;
    const eslenmis = new Map(mevcutEsleme.map((m) => [m.kind + ':' + m.external_id, m.pos_ref_id]));
    const yeniKategori = menu.kategoriler.filter((k) => !eslenmis.has('category:' + k.externalId));
    const yeniUrun = menu.urunler.filter((u) => !eslenmis.has('product:' + u.externalId));
    let katSayi = 0, urunSayi = 0;
    const katEsle = new Map(mevcutEsleme.filter((m) => m.kind === 'category').map((m) => [m.external_id, m.pos_ref_id]));

    for (const k of yeniKategori) {
        const id = uuidv4();
        await query('INSERT INTO categories (id, tenant_id, name, sort_order) VALUES (?, ?, ?, ?)',
            [id, tenantId, k.name, k.sort || 0]);
        await query(
            `INSERT INTO marketplace_product_map (id, tenant_id, channel_id, store_link_id, kind, external_id, external_name, pos_ref_id, match_source)
             VALUES (?, ?, ?, ?, 'category', ?, ?, ?, 'pull')`,
            [uuidv4(), tenantId, ch.id, link.id, k.externalId, k.name, id]);
        katEsle.set(k.externalId, id);
        katSayi++;
    }

    for (const u of yeniUrun) {
        const id = uuidv4();
        // FIYAT 0 + PASIF: isletme fiyatini girene kadar satilamaz (Patron karari).
        // allergens NULL geldiyse "isletme doldurmadi" demektir - bos dizi YAZMIYORUZ.
        await query(
            `INSERT INTO products (id, tenant_id, category_id, name, description, price, cost,
                image_url, tracks_stock, is_available, sort_order,
                allergens, ingredients, calories, portion_grams, contains_alcohol, contains_pork)
             VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
            [id, tenantId, katEsle.get(u.externalCategoryId) || null, u.name,
                u.description || null, u.imageUrl || null, u.sort || 0,
                u.allergens ?? null, u.ingredients ?? null,
                u.calories ?? null, u.portionGrams ?? null,
                u.containsAlcohol ? 1 : 0, u.containsPork ? 1 : 0]);
        await query(
            `INSERT INTO marketplace_product_map
                (id, tenant_id, channel_id, store_link_id, kind, external_id, external_name, external_price, pos_ref_id, match_source)
             VALUES (?, ?, ?, ?, 'product', ?, ?, ?, ?, 'pull')`,
            [uuidv4(), tenantId, ch.id, link.id, u.externalId, u.name, u.platformPriceKurus || 0, id]);
        urunSayi++;
    }
    return { katSayi, urunSayi };
    });
    const { katSayi, urunSayi } = yazim;

    // Alerjen beyani olmayan urunleri AYRICA uyariyoruz: "alerjen yok" ile
    // "isletme doldurmadi" karistirilirsa gercek bir saglik riski dogar.
    const beyansiz = menu.urunler.filter((u) => !u.allergenBeyan).length;
    return { kod: 200, govde: {
        ok: true, kategoriEklendi: katSayi, urunEklendi: urunSayi,
        beyansizUrun: beyansiz,
        bilinmeyenAlerjenKodu: menu.bilinmeyenAlerjenKodu || [],
        uyari: 'Menü ' + (ch.name || 'pazaryeri') + ' üzerinden alındı. Fiyat ve maliyet bilgileri '
             + 'aktarılmaz; ürünler fiyatlarını girene kadar PASİF durumdadır. '
             + 'Fiyatları girip "Menüde aktif" kutusunu işaretleyin.',
        alerjenUyari: beyansiz > 0
            ? beyansiz + ' üründe alerjen bilgisi işletme tarafından doldurulmamış. '
              + 'Bu "alerjen içermiyor" anlamına GELMEZ - ilgili ürünlerin alerjen '
              + 'bilgisini kendiniz girmelisiniz.'
            : null,
    } };
}

// Daha once GORELI ('/uploads/..') saklanmis SofraMix gorsellerini mutlaklastir. Yalniz SofraMix
// kanalindan eslenmis urunlere dokunur: POS'un KENDI yuklemeleri de '/uploads/..' kullanir ve
// onlar POS API'sinden servis edilir, degismemeli. Idempotent; acilista bir kez calisir.
async function gorselAdresleriniOnar(taban) {
    let b = String(taban || process.env.SOFRAMIX_PLATFORM_URL || 'https://soframix.com.tr').trim().replace(/[/]+$/, '');
    if (!/^https?:[/][/]/i.test(b)) b = 'https://' + b;
    const r = await query(
        `UPDATE products SET image_url = ? || image_url
          WHERE image_url LIKE '/%' AND image_url NOT LIKE '//%'
            AND id IN (SELECT m.pos_ref_id FROM marketplace_product_map m
                         JOIN marketplace_channels c ON c.id = m.channel_id
                        WHERE m.kind = 'product' AND c.adapter_code = 'soframix')`, [b]);
    if (r.changes) console.log('[menu] ' + r.changes + ' SofraMix gorsel adresi mutlaklastirildi (' + b + ')');
    return r.changes || 0;
}

module.exports = { menuCek, gorselAdresleriniOnar };
