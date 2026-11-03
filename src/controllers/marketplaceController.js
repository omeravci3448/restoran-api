const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');
const { PAKET, kisiselAlanlariCikar } = require('../services/paketServis');

// Elle girilen pazaryeri siparisinde kanalin ADI orders.channel'a yazilir (ingest asagida). Sistemin kendi
// yazdigi kodlarla cakismasin: salon (DINE_IN), telefon paketi (PAKET_SERVIS) her kanal icin ayrilmis;
// siparis getirebilen (baglanabilir) adaptor kodlari yalniz ADAPTORSUZ (elle) kanal icin ayrilmis - adaptorlu
// kanal kendi adaptorunun adini kullanabilir (SofraMix'ten acilan isletmenin 'SofraMix' kanali). Buyuk/kucuk harf
// ve bosluk duyarsiz. 'Paket' artik serbest (telefon paketi PAKET_SERVIS kodunu kullaniyor; eski 'Paket' adli elle
// kanallar raporda 'Paket (elle kanal)' gorunur). Bekleyen adaptorler (yemeksepeti, getir, migros) BILEREK
// serbest: elle "Yemeksepeti" kanali acmak bilinen kullanim, o kodlarla adaptor siparisi gelmez.
const adaptorKodlari = () => { try { return require('../marketplace/registry').listAvailable().map((x) => String(x.code).toLowerCase()); } catch (_) { return []; } };
function ayrilmisAd(ad, adaptorKodu) {
    const a = String(ad || '').trim().toLowerCase();
    if (!a) return false;
    if (a === 'dine_in' || a === PAKET.toLowerCase()) return true;
    const kendi = String(adaptorKodu || '').toLowerCase();
    return adaptorKodlari().some((k) => k === a && k !== kendi);
}
// Elle siparis girisinde: kanal adi sistem koduyla BIREBIR ayniysa (ornek adaptorlu kanalin adi 'soframix')
// elle girilen siparis platformdan gelenlerle ayni kanal koduna yazilirdi.
const sistemKoduMu = (ad) => ad === 'DINE_IN' || ad === PAKET || adaptorKodlari().includes(ad);

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100; // 2 ondalık

// ——————————————————————————————————————————————————————————
// PAZARYERİ KANAL CONFIG (Yemeksepeti/Trendyol/Getir vb.)
// Entegrasyon yok; her kanalın komisyon % + sabit işlem ücreti burada tutulur,
// manuel sipariş girişinde otomatik uygulanır.
// ——————————————————————————————————————————————————————————
exports.listChannels = async (req, res) => {
    const r = await query(
        // is_api_enabled SART: Menu.jsx "SofraMix'ten cek" dugmesini bu alana bakip ciziyor;
        // alan donmeyince dugme HIC gorunmuyordu (denetim bulgusu).
        `SELECT c.id, c.name, c.adapter_code, c.commission_rate, c.fixed_fee, c.is_active, c.is_api_enabled, c.capabilities_json,
                (SELECT k.status FROM marketplace_credentials k
                  WHERE k.tenant_id = c.tenant_id AND k.channel_id = c.id AND k.env = 'prod'
                  ORDER BY k.updated_at DESC, k.created_at DESC LIMIT 1) AS kimlik_durum
           FROM marketplace_channels c WHERE c.tenant_id = ? ORDER BY c.name`,
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
    // Adaptor kodu (once: adaptorlu kanal kendi adaptorunun adini alabilir, bkz ayrilmisAd). Bu alan YAZILMADIGI
    // surece kanal yalnizca elle siparis girilen bir muhasebe etiketi olarak kalir: anahtar kaydetme ve menu cekme
    // uclari "Bu kanalda adaptor tanimli degil" deyip 400 doner. Beyaz liste: yalnizca kayitli ve baglanabilir adaptorler.
    const adapterCode = adaptorKoduCoz(req.body.adapterCode);
    if (adapterCode === false) return res.status(400).json({ message: 'Bilinmeyen veya henüz bağlanamayan pazaryeri kodu.' });
    // Elle girilen siparis orders.channel'a bu ADLA yazilir: salon / paket servis / adaptor kodlariyla karismasin
    if (ayrilmisAd(name, adapterCode)) return res.status(400).json({ message: 'Bu ad ayrılmıştır, başka bir kanal adı yazın.' });
    if (commissionRate < 0 || commissionRate > 100) return res.status(400).json({ message: 'Komisyon %0-100 arası olmalı.' });
    if (fixedFee < 0) return res.status(400).json({ message: 'İşlem ücreti negatif olamaz.' });
    // Aynı isim mükerrer olmasın
    const dup = await query('SELECT id FROM marketplace_channels WHERE tenant_id = ? AND name = ?', [req.user.tenantId, name]);
    if (dup.rows.length) return res.status(409).json({ message: 'Bu isimde bir kanal zaten var.' });

    const id = uuidv4();
    await query(
        `INSERT INTO marketplace_channels (id, tenant_id, name, adapter_code, commission_rate, fixed_fee, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [id, req.user.tenantId, name, adapterCode, r2(commissionRate), r2(fixedFee)]);
    res.status(201).json({ id, name, adapter_code: adapterCode, commission_rate: r2(commissionRate), fixed_fee: r2(fixedFee), is_active: 1 });
};

exports.updateChannel = async (req, res) => {
    const { id } = req.params;
    const exist = await query('SELECT id, name, adapter_code FROM marketplace_channels WHERE id = ? AND tenant_id = ?', [id, req.user.tenantId]);
    if (!exist.rows.length) return res.status(404).json({ message: 'Kanal bulunamadı.' });
    const b = req.body;
    let adapterCode = null;
    if (b.adapterCode !== undefined) {
        adapterCode = adaptorKoduCoz(b.adapterCode);
        if (adapterCode === false) return res.status(400).json({ message: 'Bilinmeyen veya henüz bağlanamayan pazaryeri kodu.' });
    }
    // Ad denetimi YALNIZ ad gercekten degisiyorsa (Ayarlar her kayitta adi da gonderiyor: mevcut 'SofraMix' ya da
    // eski 'Paket' adli kanal adi degismeden kaydedilebilmeli)
    const yeniAd = b.name != null ? String(b.name).trim() : null;
    if (yeniAd != null && !yeniAd) return res.status(400).json({ message: 'Kanal adı zorunlu.' });
    if (yeniAd != null && yeniAd !== exist.rows[0].name && ayrilmisAd(yeniAd, adapterCode || exist.rows[0].adapter_code))
        return res.status(400).json({ message: 'Bu ad ayrılmıştır, başka bir kanal adı yazın.' });
    if (b.commissionRate != null && (Number(b.commissionRate) < 0 || Number(b.commissionRate) > 100))
        return res.status(400).json({ message: 'Komisyon %0-100 arası olmalı.' });
    if (b.fixedFee != null && Number(b.fixedFee) < 0)
        return res.status(400).json({ message: 'İşlem ücreti negatif olamaz.' });
    await query(
        `UPDATE marketplace_channels
            SET name = COALESCE(?, name),
                adapter_code = COALESCE(?, adapter_code),
                commission_rate = COALESCE(?, commission_rate),
                fixed_fee = COALESCE(?, fixed_fee),
                is_active = COALESCE(?, is_active)
          WHERE id = ? AND tenant_id = ?`,
        [yeniAd,
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
    if (sistemKoduMu(channel.name)) {
        return res.status(400).json({ message: `Bu kanalın adı (${channel.name}) sistem koduyla aynı; elle sipariş girmeden önce Ayarlar > Pazaryeri Kanalları'ndan kanal adını değiştirin.` });
    }

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
    // Telefon paket siparisi pazaryeri degil: kendi ekraninda (Paket Servis) listelenir.
    const w = ['o.tenant_id = ?', "o.channel NOT IN ('DINE_IN', ?)"];
    const p = [req.user.tenantId, PAKET];
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
        // Musteri adi/telefon/adres bu listeden DONMEZ (yalniz Paket Servis ucu, mutfak rolu goremez)
        return { ...kisiselAlanlariCikar(o), product_cost: r2(productCost), net_profit: netProfit };
    });
    res.json(rows);
};

// ——— Pazaryeri siparisine KASADAN durum yazma ———
// Mantik services/pazaryeriAksiyon.js'de: Paket Servis ekrani da ayni yolu kullanir
// (orada MARKETPLACE modulu sart degil). Gecis kurali platforma birakilir; platformun
// mesaji kasiyere aynen gosterilir. Teslimde odeme kaydi eksikse tamamlanir.
exports.siparisAksiyon = async (req, res) => {
    const servis = require('../services/pazaryeriAksiyon');
    try {
        const r = await servis.uygula({
            tenantId: req.user.tenantId, orderId: req.params.id,
            aksiyon: req.body && req.body.aksiyon, sebep: req.body && req.body.sebep, user: req.user,
        });
        res.json({ ok: true, durum: r.durum });
    } catch (e) {
        if (e instanceof servis.AksiyonHatasi) {
            return res.status(e.status).json({ message: e.message, yetkiSorunu: !!e.yetkiSorunu });
        }
        throw e;
    }
};
