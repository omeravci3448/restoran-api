const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const { getAdapter, listAdapters } = require('../marketplace/registry');
const cred = require('../marketplace/core/credentialStore');
const { menuCek } = require('../services/menuAktarim');

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
// Musteriye YALNIZCA satisa acik kanallar gosterilir.
//
// Once ham liste doniyordu; kasa ekraninda "Trendyol GO" ve "Test Pazaryeri
// (sahte)" gorunuyordu. Ikisi de yanlisti: pazaryeri entegrasyonu henuz
// satista degil (katalogda MARKETPLACE gizli) ve sahte kanal gercek bir
// isletmeye hic gosterilmemeli.
//
// SofraMix HER ZAMAN listede: musteri paketi zaten SofraMix uzerinden aldi ve
// menusunu cekebilmesi icin bu kanala ihtiyaci var. Yani "pazaryeri modulu
// satista mi" sorusu ile "SofraMix baglantisi kurulabilir mi" sorusu ayri.
exports.adapters = async (_req, res) => {
    const K = require('../services/lisansKatalog');
    const pazaryeriSatista = await K.modulGorunurMu('MARKETPLACE');
    const uretim = process.env.NODE_ENV === 'production';
    res.json(listAdapters().filter((a) => {
        if (a.code === 'sandbox') return !uretim;
        if (a.code === 'soframix') return true;
        return pazaryeriSatista;
    }));
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

    // MARKETPLACE_KEK yoksa credentialStore firlatir. Eskiden bu try DISINDAYDI:
    // restoran "Bagla" deyince 500 ve gelistirici hata metni goruyordu.
    let kayit;
    try {
        kayit = await cred.saveCredentials({
        tenantId: req.user.tenantId, channelId: ch.id, scope: 'store', scopeRef: magazaId, fields: alanlar,
    });
    } catch (e) {
        console.error("[kanal] kimlik bilgisi kaydedilemedi:", e.message);
        return res.status(503).json({ message: "Bağlantı şu an kurulamıyor (sunucu yapılandırması eksik). Lütfen bize yazın." });
    }

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
    // Govde src/services/menuAktarim.js'e tasindi: SofraMix oto-baglantisi da ayni kodu kullaniyor.
    const r = await menuCek({
        tenantId: req.user.tenantId, kanalId: req.params.id,
        uygula: String(req.query.uygula || '') === '1',
    });
    res.status(r.kod).json(r.govde);
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
