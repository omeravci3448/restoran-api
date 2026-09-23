const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const { getAdapter, listAdapters } = require('../marketplace/registry');
const cred = require('../marketplace/core/credentialStore');

// ——— Pazaryeri kanal kurulumu ve menu aktarimi ———
// Isletme buradan bir pazaryerine baglanir (anahtar girer) ve ilk kurulumda
// menusunu oradan cekebilir.
//
// PATRON KARARI (2026-09-22): menu cekilirken GORSELLER gelir, FIYAT 0 gelir,
// maliyet bos kalir ve urunler PASIF baslar. Boylece 0 TL'lik bir urun kazara
// masaya eklenip bedava satilamaz; isletme fiyatini girince aktiflestirir.

// Adaptorun disariya cikabilmesi icin ctx
function ctxKur(tenantId, credentials, storeLink) {
    return { tenantId, credentials, storeLink, env: 'prod', http: (u, o) => fetch(u, o) };
}

// --- Bağlanabilir kanallar (arayuz listeyi buradan cizer) ---
exports.adapters = async (_req, res) => {
    res.json(listAdapters());
};

// --- Kanalin kurulum durumu ---
exports.channelStatus = async (req, res) => {
    const ch = (await query('SELECT * FROM marketplace_channels WHERE id = ? AND tenant_id = ?',
        [req.params.id, req.user.tenantId])).rows[0];
    if (!ch) return res.status(404).json({ message: 'Kanal yok.' });

    const krd = (await query(
        "SELECT fingerprint, status, last_verified_at FROM marketplace_credentials WHERE tenant_id = ? AND channel_id = ? AND env = 'prod'",
        [req.user.tenantId, ch.id])).rows[0] || null;
    const link = (await query('SELECT * FROM marketplace_store_links WHERE tenant_id = ? AND channel_id = ?',
        [req.user.tenantId, ch.id])).rows[0] || null;
    const esleme = (await query(
        "SELECT COUNT(*) c FROM marketplace_product_map WHERE tenant_id = ? AND channel_id = ? AND kind = 'product'",
        [req.user.tenantId, ch.id])).rows[0].c;

    let tanim = null;
    try { tanim = ch.adapter_code ? getAdapter(ch.adapter_code).describe() : null; } catch (_) {}
    res.json({
        channel: { id: ch.id, name: ch.name, adapterCode: ch.adapter_code, isApiEnabled: !!ch.is_api_enabled },
        adapter: tanim,
        kimlik: krd,               // yalnizca parmak izi - ham anahtar ASLA donmez
        magaza: link,
        eslesenUrun: esleme,
    });
};

// --- Anahtari kaydet + baglantiyi dogrula ---
exports.saveCredentials = async (req, res) => {
    const ch = (await query('SELECT * FROM marketplace_channels WHERE id = ? AND tenant_id = ?',
        [req.params.id, req.user.tenantId])).rows[0];
    if (!ch) return res.status(404).json({ message: 'Kanal yok.' });
    if (!ch.adapter_code) return res.status(400).json({ message: 'Bu kanalda adaptör tanımlı değil.' });

    let adaptor;
    try { adaptor = getAdapter(ch.adapter_code); } catch (e) { return res.status(400).json({ message: e.message }); }
    if (adaptor.describe().available === false) {
        return res.status(400).json({ message: adaptor.blocker || 'Bu kanala şu an bağlanılamıyor.' });
    }

    const alanlar = req.body?.fields || {};
    const eksik = (adaptor.requiredCredentialFields || [])
        .filter((f) => f.required && !String(alanlar[f.key] || '').trim())
        .map((f) => f.label);
    if (eksik.length) return res.status(400).json({ message: 'Eksik alan: ' + eksik.join(', ') });

    const magazaId = String(req.body?.externalStoreId || '').trim();
    if (!magazaId) return res.status(400).json({ message: 'Mağaza/işletme numarası gerekli.' });

    // Once DOGRULA, sonra kaydet - calismayan anahtari kaydetmeyelim.
    try {
        await adaptor.validateCredentials(ctxKur(req.user.tenantId, alanlar, { externalStoreId: magazaId }));
    } catch (e) {
        return res.status(400).json({ message: 'Bağlantı doğrulanamadı: ' + (e.message || 'bilinmeyen hata') });
    }

    const kayit = await cred.saveCredentials({
        tenantId: req.user.tenantId, channelId: ch.id, scope: 'store', scopeRef: magazaId, fields: alanlar,
    });

    // Magaza baglantisi (kiraci izolasyonunun bekcisi)
    const varOlan = (await query('SELECT id FROM marketplace_store_links WHERE channel_id = ? AND external_store_id = ?',
        [ch.id, magazaId])).rows[0];
    if (varOlan) {
        await query('UPDATE marketplace_store_links SET tenant_id = ?, credential_id = ?, is_active = 1 WHERE id = ?',
            [req.user.tenantId, kayit.id, varOlan.id]);
    } else {
        await query(
            `INSERT INTO marketplace_store_links (id, tenant_id, channel_id, external_store_id, credential_id, is_active)
             VALUES (?, ?, ?, ?, ?, 1)`,
            [uuidv4(), req.user.tenantId, ch.id, magazaId, kayit.id]);
    }
    await query('UPDATE marketplace_channels SET is_api_enabled = 1, capabilities_json = ? WHERE id = ?',
        [JSON.stringify(adaptor.capabilities), ch.id]);
    await cred.markVerified(kayit.id);

    res.json({ ok: true, fingerprint: kayit.fingerprint, message: 'Bağlantı kuruldu ve doğrulandı.' });
};

// --- Menuyu pazaryerinden CEK (ilk kurulum) ---
// Onizleme: ne gelecegini once gosterir, yazmaz.  ?uygula=1 ile yazar.
exports.pullMenu = async (req, res) => {
    const uygula = String(req.query.uygula || '') === '1';
    const ch = (await query('SELECT * FROM marketplace_channels WHERE id = ? AND tenant_id = ?',
        [req.params.id, req.user.tenantId])).rows[0];
    if (!ch) return res.status(404).json({ message: 'Kanal yok.' });

    let adaptor;
    try { adaptor = getAdapter(ch.adapter_code); } catch (e) { return res.status(400).json({ message: e.message }); }
    if (!adaptor.capabilities.menuRead) {
        return res.status(400).json({ message: 'Bu kanaldan menü okunamıyor.' });
    }

    const link = (await query('SELECT * FROM marketplace_store_links WHERE tenant_id = ? AND channel_id = ? AND is_active = 1',
        [req.user.tenantId, ch.id])).rows[0];
    if (!link) return res.status(400).json({ message: 'Önce bağlantı kurun.' });

    let menu;
    try {
        menu = await cred.withCredentials(req.user.tenantId, ch.id, (c) =>
            adaptor.pullMenu(ctxKur(req.user.tenantId, c, { externalStoreId: link.external_store_id })));
    } catch (e) {
        return res.status(502).json({ message: 'Menü alınamadı: ' + (e.message || 'bilinmeyen hata') });
    }

    // Zaten eslenmis olanlari bul - ikinci cekiste mukerrer urun olusmasin.
    const mevcutEsleme = (await query(
        'SELECT kind, external_id, pos_ref_id FROM marketplace_product_map WHERE tenant_id = ? AND channel_id = ?',
        [req.user.tenantId, ch.id])).rows;
    const eslenmis = new Map(mevcutEsleme.map((m) => [m.kind + ':' + m.external_id, m.pos_ref_id]));

    const yeniKategori = menu.kategoriler.filter((k) => !eslenmis.has('category:' + k.externalId));
    const yeniUrun = menu.urunler.filter((u) => !eslenmis.has('product:' + u.externalId));

    if (!uygula) {
        return res.json({
            onizleme: true,
            kategori: { toplam: menu.kategoriler.length, yeni: yeniKategori.length },
            urun: { toplam: menu.urunler.length, yeni: yeniUrun.length },
            ornekler: yeniUrun.slice(0, 8).map((u) => ({ ad: u.name, gorsel: !!u.imageUrl })),
        });
    }

    // --- Yazma ---
    let katSayi = 0, urunSayi = 0;
    const katEsle = new Map(mevcutEsleme.filter((m) => m.kind === 'category')
        .map((m) => [m.external_id, m.pos_ref_id]));

    for (const k of yeniKategori) {
        const id = uuidv4();
        await query('INSERT INTO categories (id, tenant_id, name, sort_order) VALUES (?, ?, ?, ?)',
            [id, req.user.tenantId, k.name, k.sort || 0]);
        await query(
            `INSERT INTO marketplace_product_map (id, tenant_id, channel_id, kind, external_id, external_name, pos_ref_id, match_source)
             VALUES (?, ?, ?, 'category', ?, ?, ?, 'pull')`,
            [uuidv4(), req.user.tenantId, ch.id, k.externalId, k.name, id]);
        katEsle.set(k.externalId, id);
        katSayi++;
    }

    for (const u of yeniUrun) {
        const id = uuidv4();
        // FIYAT 0 + PASIF: isletme fiyatini girene kadar satilamaz (Patron karari).
        // Gorsel pazaryerindeki mutlak adresle baglaniyor; qr-menu 'http' ile
        // baslayan adresi oldugu gibi kullaniyor, ek isleme gerekmiyor.
        await query(
            `INSERT INTO products (id, tenant_id, category_id, name, description, price, cost,
                image_url, tracks_stock, is_available, sort_order)
             VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, 0, ?)`,
            [id, req.user.tenantId, katEsle.get(u.externalCategoryId) || null, u.name,
                u.description || null, u.imageUrl || null, u.sort || 0]);
        await query(
            `INSERT INTO marketplace_product_map
                (id, tenant_id, channel_id, store_link_id, kind, external_id, external_name, external_price, pos_ref_id, match_source)
             VALUES (?, ?, ?, ?, 'product', ?, ?, ?, ?, 'pull')`,
            [uuidv4(), req.user.tenantId, ch.id, link.id, u.externalId, u.name,
                u.platformPriceKurus || 0, id]);
        urunSayi++;
    }

    res.json({
        ok: true, kategoriEklendi: katSayi, urunEklendi: urunSayi,
        uyari: 'Menü ' + (ch.name || 'pazaryeri') + " üzerinden alındı. Fiyat ve maliyet bilgileri "
             + 'aktarılmaz; ürünler fiyatlarını girene kadar PASİF durumdadır. '
             + 'Fiyatları girip "Menüde aktif" kutusunu işaretleyin.',
    });
};

// --- Bu urun bir pazaryerine bagli mi? (fiyat degisince hatirlatma icin) ---
exports.productLinks = async (req, res) => {
    const r = await query(
        `SELECT m.channel_id, c.name AS channel_name, c.adapter_code
           FROM marketplace_product_map m
           JOIN marketplace_channels c ON c.id = m.channel_id
          WHERE m.tenant_id = ? AND m.kind = 'product' AND m.pos_ref_id = ? AND m.is_ignored = 0`,
        [req.user.tenantId, req.params.productId]);
    res.json(r.rows);
};
