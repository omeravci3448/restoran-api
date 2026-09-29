const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100; // 2 ondalık

// ——————————————————————————————————————————————————————————
// PAZARYERİ KANAL CONFIG (Yemeksepeti/Trendyol/Getir vb.)
// Entegrasyon yok; her kanalın komisyon % + sabit işlem ücreti burada tutulur,
// manuel sipariş girişinde otomatik uygulanır.
// ——————————————————————————————————————————————————————————
exports.listChannels = async (req, res) => {
    const r = await query(
        `SELECT id, name, adapter_code, commission_rate, fixed_fee, is_active
           FROM marketplace_channels WHERE tenant_id = ? ORDER BY name`,
        [req.user.tenantId]);
    res.json(r.rows);
};

// Beyaz liste: yalnizca registry'de kayitli VE baglanabilir adaptorler.
// Bos/eksik deger null doner (kanal adaptorsuz kalir, eski davranis korunur),
// taninmayan deger false doner (cagiran 400 dondurur).
function adaptorKoduCoz(ham) {
    const k = String(ham || '').trim().toLowerCase();
    if (!k) return null;
    const { listAvailable } = require('../marketplace/registry');
    return listAvailable().some((a) => a.code === k) ? k : false;
}

exports.createChannel = async (req, res) => {
    const name = String(req.body.name || '').trim();
    const commissionRate = Number(req.body.commissionRate || 0);
    const fixedFee = Number(req.body.fixedFee || 0);
    if (!name) return res.status(400).json({ message: 'Kanal adı zorunlu.' });
    if (name.toUpperCase() === 'DINE_IN') return res.status(400).json({ message: 'Bu ad ayrılmıştır.' });
    if (commissionRate < 0 || commissionRate > 100) return res.status(400).json({ message: 'Komisyon %0–100 arası olmalı.' });
    if (fixedFee < 0) return res.status(400).json({ message: 'İşlem ücreti negatif olamaz.' });
    // Aynı isim mükerrer olmasın
    const dup = await query('SELECT id FROM marketplace_channels WHERE tenant_id = ? AND name = ?', [req.user.tenantId, name]);
    if (dup.rows.length) return res.status(409).json({ message: 'Bu isimde bir kanal zaten var.' });
    // Adaptor kodu. Bu alan YAZILMADIGI surece kanal yalnizca elle siparis
    // girilen bir muhasebe etiketi olarak kalir: anahtar kaydetme ve menu cekme
    // uclari "Bu kanalda adaptor tanimli degil" deyip 400 doner. Yani entegrasyon
    // fiilen kurulamaz. Beyaz liste: yalnizca kayitli ve baglanabilir adaptorler.
    const adapterCode = adaptorKoduCoz(req.body.adapterCode);
    if (adapterCode === false) return res.status(400).json({ message: 'Bilinmeyen veya henüz bağlanamayan pazaryeri kodu.' });

    const id = uuidv4();
    await query(
        `INSERT INTO marketplace_channels (id, tenant_id, name, adapter_code, commission_rate, fixed_fee, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [id, req.user.tenantId, name, adapterCode, r2(commissionRate), r2(fixedFee)]);
    res.status(201).json({ id, name, adapter_code: adapterCode, commission_rate: r2(commissionRate), fixed_fee: r2(fixedFee), is_active: 1 });
};

exports.updateChannel = async (req, res) => {
    const { id } = req.params;
    const exist = await query('SELECT id FROM marketplace_channels WHERE id = ? AND tenant_id = ?', [id, req.user.tenantId]);
    if (!exist.rows.length) return res.status(404).json({ message: 'Kanal bulunamadı.' });
    const b = req.body;
    if (b.commissionRate != null && (Number(b.commissionRate) < 0 || Number(b.commissionRate) > 100))
        return res.status(400).json({ message: 'Komisyon %0–100 arası olmalı.' });
    if (b.fixedFee != null && Number(b.fixedFee) < 0)
        return res.status(400).json({ message: 'İşlem ücreti negatif olamaz.' });
    let adapterCode = null;
    if (b.adapterCode !== undefined) {
        adapterCode = adaptorKoduCoz(b.adapterCode);
        if (adapterCode === false) return res.status(400).json({ message: 'Bilinmeyen veya henüz bağlanamayan pazaryeri kodu.' });
    }
    await query(
        `UPDATE marketplace_channels
            SET name = COALESCE(?, name),
                adapter_code = COALESCE(?, adapter_code),
                commission_rate = COALESCE(?, commission_rate),
                fixed_fee = COALESCE(?, fixed_fee),
                is_active = COALESCE(?, is_active)
          WHERE id = ? AND tenant_id = ?`,
        [b.name != null ? String(b.name).trim() : null,
         adapterCode,
         b.commissionRate != null ? r2(b.commissionRate) : null,
         b.fixedFee != null ? r2(b.fixedFee) : null,
         b.isActive != null ? (b.isActive ? 1 : 0) : null,
         id, req.user.tenantId]);
    res.json({ message: 'Güncellendi.' });
};

exports.deleteChannel = async (req, res) => {
    const { id } = req.params;
    // Config satırını siler. Geçmiş siparişler kendi kanal adını + dondurulmuş
    // komisyonunu sakladığı için rapor geçmişi bozulmaz.
    await query('DELETE FROM marketplace_channels WHERE id = ? AND tenant_id = ?', [id, req.user.tenantId]);
    res.json({ message: 'Silindi.' });
};

// ——————————————————————————————————————————————————————————
// MANUEL PAZARYERİ SİPARİŞ GİRİŞİ
// Entegrasyon yokken siparişi elle gir: kanal seç → ürünleri tek tek ekle
// (menüden seçilirse maliyet otomatik), komisyon kanal config'inden hesaplanır,
// kurye/zarar gibi ekstra maliyetler eklenir → net kâr çıkar.
// ——————————————————————————————————————————————————————————
exports.ingest = async (req, res) => {
    const {
        channelId,
        externalRef,
        items = [],
        extraCost = 0,
        extraCostNote,
        note,
        paidVia
    } = req.body;

    if (!channelId) return res.status(400).json({ message: 'Kanal seçin.' });
    const chRow = await query(
        'SELECT * FROM marketplace_channels WHERE id = ? AND tenant_id = ?',
        [channelId, req.user.tenantId]);
    if (!chRow.rows.length) return res.status(400).json({ message: 'Geçersiz kanal. Önce Ayarlar > Pazaryeri Kanalları\'ndan ekleyin.' });
    const channel = chRow.rows[0];

    const validItems = items.filter(it => Number(it.qty) > 0 && (it.productId || (it.name && String(it.name).trim())));
    if (!validItems.length) return res.status(400).json({ message: 'En az 1 ürün gerekli.' });

    const ref = (externalRef && String(externalRef).trim()) || ('MAN-' + Date.now());

    // Idempotency: aynı kanal + dış referans tekrar girilirse mükerrer kayıt açma
    const dup = await query(
        'SELECT id FROM orders WHERE tenant_id = ? AND channel = ? AND external_ref = ?',
        [req.user.tenantId, channel.name, ref]);
    if (dup.rows.length) return res.status(200).json({ id: dup.rows[0].id, deduped: true });

    // Ürünleri çöz (menüden seçildiyse ad/fiyat fallback için)
    const resolved = [];
    let subtotal = 0;
    for (const it of validItems) {
        const qty = Number(it.qty);
        let name = it.name && String(it.name).trim();
        let price = Number(it.price);
        if (it.productId) {
            const p = await query('SELECT name, price FROM products WHERE id = ? AND tenant_id = ?',
                [it.productId, req.user.tenantId]);
            if (p.rows.length) {
                if (!name) name = p.rows[0].name;
                if (!(price >= 0) || Number.isNaN(price)) price = Number(p.rows[0].price);
            }
        }
        price = Number(price) || 0;
        const total = r2(qty * price);
        subtotal += total;
        resolved.push({ productId: it.productId || null, name: name || 'Ürün', qty, price, total });
    }
    subtotal = r2(subtotal);

    // Kesintiler — komisyon kanal config'inden, server-side (client'a güvenme)
    const commission = r2(subtotal * Number(channel.commission_rate || 0) / 100);
    const platformFee = r2(channel.fixed_fee || 0);
    const extra = r2(extraCost);

    const orderId = uuidv4();
    await tx(async () => {
        await query(
            `INSERT INTO orders
                (id, tenant_id, table_id, channel, external_ref, status, note,
                 commission_amount, platform_fee, extra_cost, extra_cost_note, opened_by)
             VALUES (?, ?, NULL, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?)`,
            [orderId, req.user.tenantId, channel.name, ref, note || null,
             commission, platformFee, extra, extraCostNote || null, req.user.id]);

        for (const it of resolved) {
            await query(
                `INSERT INTO order_items (id, order_id, product_id, product_name, qty, unit_price, total, source)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [uuidv4(), orderId, it.productId, it.name, it.qty, it.price, it.total, channel.name]);
        }

        await query('UPDATE orders SET subtotal = ?, total = ? WHERE id = ?',
            [subtotal, subtotal, orderId]);

        // Pazaryeri siparişleri genelde platform üzerinden önceden ödenir
        if (paidVia === 'PLATFORM' || paidVia === undefined) {
            await query(
                `INSERT INTO payments (id, tenant_id, order_id, method, amount, ref, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [uuidv4(), req.user.tenantId, orderId, channel.name, subtotal, ref, req.user.id]);
            await query("UPDATE orders SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE id = ?", [orderId]);
        }
    });

    res.status(201).json({ id: orderId, channel: channel.name, externalRef: ref, subtotal, commission, platformFee, extraCost: extra });
};

// Pazaryeri siparişlerini net kâr ile listele
exports.list = async (req, res) => {
    const { channel, from, to } = req.query;
    const w = ['o.tenant_id = ?', "o.channel != 'DINE_IN'"];
    const p = [req.user.tenantId];
    if (channel) { w.push('o.channel = ?'); p.push(channel); }
    if (from) { w.push('o.opened_at >= ?'); p.push(from); }
    if (to) { w.push('o.opened_at <= ?'); p.push(to); }
    const r = await query(
        `SELECT o.*,
                (SELECT COALESCE(SUM(oi.qty * COALESCE(pr.cost, 0)), 0)
                   FROM order_items oi LEFT JOIN products pr ON pr.id = oi.product_id
                  WHERE oi.order_id = o.id) AS product_cost
           FROM orders o WHERE ${w.join(' AND ')}
          ORDER BY o.opened_at DESC LIMIT 200`, p);
    const rows = r.rows.map(o => {
        const productCost = Number(o.product_cost || 0);
        const commission = Number(o.commission_amount || 0);
        const fee = Number(o.platform_fee || 0);
        const extra = Number(o.extra_cost || 0);
        const netProfit = r2(Number(o.total || 0) - productCost - commission - fee - extra);
        return { ...o, product_cost: r2(productCost), net_profit: netProfit };
    });
    res.json(rows);
};

// ——— Pazaryeri siparisine KASADAN durum yazma ———
//
// Provada ortaya cikti: adaptor SofraMix'e "hazirlaniyor/yolda/teslim" yazabiliyor,
// SofraMix kabul ediyor, ama POS'ta bunu tetikleyen NE bir uc NE bir dugme vardi.
// Kasiyer siparisi goruyor, mutfak hazirliyor, musteri SofraMix'te hala "yeni"
// goruyordu. Bu uc o boslugu kapatiyor.
//
// Kural: POS kendi kafasina gore durum ilerletmez. Ne yazilacagi adaptorun
// yetenegine, gecis kurali ise PLATFORMA birakilir (SofraMix yanlis gecise
// 400 doner, biz o mesaji aynen kasiyere gosteririz). Iki yerde ayri kural
// tutmak, bir gun birinin sessizce sapmasi demekti.
const AKSIYONLAR = {
    kabul:            { metod: 'acceptOrder',        yetenek: 'acceptReject' },
    hazirlaniyor:     { metod: 'markPreparing',      yetenek: 'markPreparing' },
    hazir:            { metod: 'markReady',          yetenek: 'markReady' },
    yolda:            { metod: 'markDispatched',     yetenek: 'markDispatched' },
    teslim:           { metod: 'markDelivered',      yetenek: 'markDelivered' },
    iptal:            { metod: 'cancelOrder',        yetenek: 'acceptReject', sebepGerekli: true },
    teslim_edilemedi: { metod: 'reportUndeliverable', yetenek: 'markDelivered', sebepGerekli: true },
};

exports.siparisAksiyon = async (req, res) => {
    const { getAdapter } = require('../marketplace/registry');
    const { withCredentials } = require('../marketplace/core/credentialStore');
    const aksiyon = AKSIYONLAR[String(req.body?.aksiyon || '')];
    if (!aksiyon) return res.status(400).json({ message: 'Geçersiz işlem.' });
    const sebep = String(req.body?.sebep || '').trim();
    if (aksiyon.sebepGerekli && sebep.length < 10) {
        return res.status(400).json({ message: 'Sebep yazın (en az 10 karakter) - müşteri ve platform bunu görecek.' });
    }

    const o = (await query(
        'SELECT id, channel, external_ref, channel_status_raw, delivery_mode FROM orders WHERE id = ? AND tenant_id = ?',
        [req.params.id, req.user.tenantId])).rows[0];
    if (!o) return res.status(404).json({ message: 'Sipariş bulunamadı.' });
    if (!o.external_ref) return res.status(400).json({ message: 'Bu sipariş elle girilmiş; platformda karşılığı yok.' });

    // Kanal: siparisin channel'i = adaptor kodu (ingest boyle yaziyor).
    const ch = (await query(
        `SELECT c.id, c.adapter_code, l.external_store_id
           FROM marketplace_channels c
           JOIN marketplace_store_links l ON l.channel_id = c.id AND l.is_active = 1
          WHERE c.tenant_id = ? AND c.adapter_code = ? AND c.is_active = 1 LIMIT 1`,
        [req.user.tenantId, o.channel])).rows[0];
    if (!ch) return res.status(400).json({ message: 'Bu kanal bağlı değil. Ayarlar > Satış kanalları > Bağla.' });

    let adaptor;
    try { adaptor = getAdapter(ch.adapter_code); } catch (_) { return res.status(400).json({ message: 'Adaptör yok.' }); }
    if (!adaptor.capabilities[aksiyon.yetenek] || typeof adaptor[aksiyon.metod] !== 'function') {
        return res.status(400).json({ message: 'Bu kanal bu işlemi desteklemiyor.' });
    }

    try {
        await withCredentials(req.user.tenantId, ch.id, async (creds) => {
            const ctx = { tenantId: req.user.tenantId, credentials: creds,
                storeLink: { externalStoreId: ch.external_store_id, id: null }, env: 'prod',
                http: (u, opts) => fetch(u, opts) };
            await adaptor[aksiyon.metod](ctx, {
                externalOrderId: o.external_ref, platformStatus: o.channel_status_raw,
                reason: sebep || undefined, note: sebep || undefined,
            });
        });
    } catch (e) {
        // Platformun mesajini AYNEN gosteriyoruz ("Bu asamada iptal edilemez" gibi):
        // kasiyerin neden olmadigini bilmesi, "program bozuk" demesinden iyidir.
        const m = (e && e.details && e.details.raw && (e.details.raw.error || e.details.raw.hata)) || e.message;
        return res.status(e && e.details && e.details.httpStatus === 403 ? 403 : 409).json({
            message: String(m || 'Platform kabul etmedi.'),
            yetkiSorunu: !!(e && e.details && (e.details.httpStatus === 401 || e.details.httpStatus === 403)),
        });
    }

    // Yerel gorunumu hemen guncelle; bir sonraki cekme turu zaten platformdan
    // dogrulayacak (updated_at tetikleyicisi sayesinde degisiklik geri okunur).
    const yeniHam = { kabul: 'onaylandi', hazirlaniyor: 'hazirlaniyor', hazir: 'hazir', yolda: 'yolda',
        teslim: 'teslim', iptal: 'iptal', teslim_edilemedi: 'teslim_edilemedi' }[req.body.aksiyon];
    await query(
        `UPDATE orders SET channel_status_raw = ?,
                status = CASE WHEN ? IN ('teslim') THEN 'CLOSED' WHEN ? IN ('iptal') THEN 'CANCELLED' ELSE status END
          WHERE id = ?`, [yeniHam, yeniHam, yeniHam, o.id]);
    res.json({ ok: true, durum: yeniHam });
};
