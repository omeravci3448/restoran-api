const { query } = require('../config/db');
const { kanalAdi, PAKET } = require('../services/paketServis');
const IG = require('../services/isGunu');

// Kanal kirilimi: Salon (DINE_IN) / Paket (telefon paketi, PAKET_SERVIS) / Pazaryeri (SofraMix ve digerleri).
// "Pazaryeri" toplami paketi ICERMEZ.

// GUN SINIRI: isletmenin is gunu (services/isGunu.js). Varsayilan Istanbul 00:00-00:00; Ayarlar'da kapanis saati
// (gun_donumu_saat, 0-6) secilmisse gun o saatte doner. closed_at SQLite UTC metni ('YYYY-MM-DD HH:MM:SS'); is gunu
// [basUtc, bitUtc) araligiyla secilir, aydaki gunler date(closed_at, kaydirma) ile gruplanir.
exports.islemGunlugu = async (req, res) => {
    const gunHam = String(req.query.gun || '').trim();
    const gun = IG.gecerliGun(gunHam) ? gunHam : null;
    const saat = gun ? await IG.isletmeSaati(req.user.tenantId) : 0;
    const rows = await require('../services/islemGunlugu').listele(req.user.tenantId, { gun, saat });
    res.json(rows);
};

exports.daySummary = async (req, res) => {
    const t = req.user.tenantId;
    const saat = await IG.isletmeSaati(t);
    const day = String(req.query.date || '').trim() || IG.isGunu(new Date(), saat);
    if (!IG.gecerliGun(day)) return res.status(400).json({ message: 'Tarih biçimi geçersiz (YYYY-AA-GG).' });
    const a = IG.aralikUtc(day, day, saat);

    const totals = await query(
        `SELECT
            COUNT(*) AS order_count,
            COALESCE(SUM(total), 0) AS revenue,
            COALESCE(SUM(CASE WHEN channel = 'DINE_IN' THEN total ELSE 0 END), 0) AS dine_in_revenue,
            COALESCE(SUM(CASE WHEN channel = '${PAKET}' THEN total ELSE 0 END), 0) AS paket_revenue,
            COALESCE(SUM(CASE WHEN channel NOT IN ('DINE_IN', '${PAKET}') THEN total ELSE 0 END), 0) AS marketplace_revenue
           FROM orders
          WHERE tenant_id = ? AND status = 'CLOSED' AND closed_at >= ? AND closed_at < ?`,
        [t, a.basUtc, a.bitUtc]);

    const byChannel = await query(
        `SELECT channel, COUNT(*) AS cnt, COALESCE(SUM(total), 0) AS revenue
           FROM orders
          WHERE tenant_id = ? AND status = 'CLOSED' AND closed_at >= ? AND closed_at < ?
          GROUP BY channel
          ORDER BY revenue DESC`,
        [t, a.basUtc, a.bitUtc]);

    const byPayment = await query(
        `SELECT p.method, COUNT(*) AS cnt, COALESCE(SUM(p.amount), 0) AS amount
           FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE p.tenant_id = ? AND o.status = 'CLOSED' AND o.closed_at >= ? AND o.closed_at < ?
          GROUP BY p.method
          ORDER BY amount DESC`,
        [t, a.basUtc, a.bitUtc]);

    const topProducts = await query(
        `SELECT oi.product_name AS name,
                SUM(oi.qty) AS qty,
                SUM(oi.total) AS revenue,
                SUM(oi.qty * COALESCE(p.cost, 0)) AS cost
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products p ON p.id = oi.product_id
          WHERE o.tenant_id = ? AND o.status = 'CLOSED' AND o.closed_at >= ? AND o.closed_at < ?
            AND COALESCE(oi.source, '') != 'TESLIMAT_UCRETI'   -- paket teslimat ucreti urun degil
          GROUP BY oi.product_name
          ORDER BY revenue DESC
          LIMIT 20`,
        [t, a.basUtc, a.bitUtc]);

    // Toplam maliyet + net kar (tüm satılan ürünlerin maliyet × adet toplamı)
    const costRow = await query(
        `SELECT COALESCE(SUM(oi.qty * COALESCE(p.cost, 0)), 0) AS total_cost
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products p ON p.id = oi.product_id
          WHERE o.tenant_id = ? AND o.status = 'CLOSED' AND o.closed_at >= ? AND o.closed_at < ?`,
        [t, a.basUtc, a.bitUtc]);

    // Pazaryeri kesintileri (komisyon + sabit işlem ücreti + ekstra maliyet) — net kârdan düşülür
    const mpRow = await query(
        `SELECT COALESCE(SUM(commission_amount), 0) AS commission,
                COALESCE(SUM(platform_fee), 0) AS fee,
                COALESCE(SUM(extra_cost), 0) AS extra
           FROM orders
          WHERE tenant_id = ? AND status = 'CLOSED' AND closed_at >= ? AND closed_at < ?`,
        [t, a.basUtc, a.bitUtc]);
    const mp = mpRow.rows[0];
    const marketplaceCost = Number(mp.commission || 0) + Number(mp.fee || 0) + Number(mp.extra || 0);

    const totalCost = Number(costRow.rows[0].total_cost || 0);
    const revenue = Number(totals.rows[0].revenue || 0);
    const totalsWithProfit = {
        ...totals.rows[0],
        total_cost: totalCost,
        marketplace_commission: Number(mp.commission || 0),
        marketplace_fee: Number(mp.fee || 0),
        marketplace_extra: Number(mp.extra || 0),
        marketplace_cost: marketplaceCost,
        net_profit: revenue - totalCost - marketplaceCost
    };

    // Ayara göre maliyet/kar görünürlüğü
    const showCost = await query('SELECT show_cost_analytics FROM tenants WHERE id = ?', [t]);
    const flag = showCost.rows[0]?.show_cost_analytics;

    res.json({
        day,
        gunDonumuSaat: saat,
        totals: totalsWithProfit,
        // label: ekranda gorunen ad (Salon / Paket / SofraMix / elle girilen kanalin adi)
        byChannel: byChannel.rows.map(c => ({ ...c, label: kanalAdi(c.channel) })),
        byPayment: byPayment.rows,
        topProducts: topProducts.rows.map(p => ({
            ...p,
            profit: Number(p.revenue || 0) - Number(p.cost || 0)
        })),
        showCostAnalytics: flag == null ? true : !!flag
    });
};

// Aylık özet — gün gün ciro + ay toplamı
exports.monthSummary = async (req, res) => {
    const t = req.user.tenantId;
    const saat = await IG.isletmeSaati(t);
    const monthStr = String(req.query.month || '').trim() || IG.isGunu(new Date(), saat).slice(0, 7); // 2026-05
    if (!IG.gecerliAy(monthStr)) return res.status(400).json({ message: 'Ay biçimi geçersiz (YYYY-AA).' });
    const a = IG.ayAraligiUtc(monthStr, saat);
    const KAY = IG.sqlKaydirma(saat);   // date(closed_at, KAY) = siparisin is gunu

    // Gün gün ciro
    const dailySimple = await query(
        `SELECT date(closed_at, ?) AS day,
                COUNT(*) AS cnt,
                COALESCE(SUM(total), 0) AS revenue,
                COALESCE(SUM(CASE WHEN channel = 'DINE_IN' THEN total ELSE 0 END), 0) AS dine_in,
                COALESCE(SUM(CASE WHEN channel = '${PAKET}' THEN total ELSE 0 END), 0) AS paket,
                COALESCE(SUM(CASE WHEN channel NOT IN ('DINE_IN', '${PAKET}') THEN total ELSE 0 END), 0) AS marketplace
           FROM orders
          WHERE tenant_id = ? AND status = 'CLOSED' AND closed_at >= ? AND closed_at < ?
          GROUP BY day
          ORDER BY day`,
        [KAY, t, a.basUtc, a.bitUtc]);

    // Gün başına maliyet
    const dailyCost = await query(
        `SELECT date(o.closed_at, ?) AS day,
                COALESCE(SUM(oi.qty * COALESCE(p.cost, 0)), 0) AS cost
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products p ON p.id = oi.product_id
          WHERE o.tenant_id = ? AND o.status = 'CLOSED' AND o.closed_at >= ? AND o.closed_at < ?
          GROUP BY day`,
        [KAY, t, a.basUtc, a.bitUtc]);
    const costMap = {};
    dailyCost.rows.forEach(r => { costMap[r.day] = Number(r.cost); });

    // Gün başına pazaryeri kesintisi (komisyon + işlem ücreti + ekstra maliyet)
    const dailyMp = await query(
        `SELECT date(closed_at, ?) AS day,
                COALESCE(SUM(commission_amount + platform_fee + extra_cost), 0) AS mp_cost
           FROM orders
          WHERE tenant_id = ? AND status = 'CLOSED' AND closed_at >= ? AND closed_at < ?
          GROUP BY day`,
        [KAY, t, a.basUtc, a.bitUtc]);
    const mpMap = {};
    dailyMp.rows.forEach(r => { mpMap[r.day] = Number(r.mp_cost); });

    const dailyWithProfit = dailySimple.rows.map(d => {
        const cost = costMap[d.day] || 0;
        const mpCost = mpMap[d.day] || 0;
        return { ...d, cost, marketplace_cost: mpCost, profit: Number(d.revenue) - cost - mpCost };
    });

    const totals = dailyWithProfit.reduce((s, r) => ({
        revenue: s.revenue + Number(r.revenue),
        cnt: s.cnt + Number(r.cnt),
        dine_in: s.dine_in + Number(r.dine_in),
        paket: s.paket + Number(r.paket),
        marketplace: s.marketplace + Number(r.marketplace),
        cost: s.cost + Number(r.cost),
        marketplace_cost: s.marketplace_cost + Number(r.marketplace_cost),
        profit: s.profit + Number(r.profit)
    }), { revenue: 0, cnt: 0, dine_in: 0, paket: 0, marketplace: 0, cost: 0, marketplace_cost: 0, profit: 0 });

    const topProducts = await query(
        `SELECT oi.product_name AS name,
                SUM(oi.qty) AS qty,
                SUM(oi.total) AS revenue,
                SUM(oi.qty * COALESCE(p.cost, 0)) AS cost
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products p ON p.id = oi.product_id
          WHERE o.tenant_id = ? AND o.status = 'CLOSED' AND o.closed_at >= ? AND o.closed_at < ?
            AND COALESCE(oi.source, '') != 'TESLIMAT_UCRETI'   -- paket teslimat ucreti urun degil
          GROUP BY oi.product_name
          ORDER BY revenue DESC
          LIMIT 30`,
        [t, a.basUtc, a.bitUtc]);

    const showCost = await query('SELECT show_cost_analytics FROM tenants WHERE id = ?', [t]);
    const flag = showCost.rows[0]?.show_cost_analytics;

    res.json({
        month: monthStr,
        gunDonumuSaat: saat,
        totals,
        daily: dailyWithProfit,
        topProducts: topProducts.rows.map(p => ({
            ...p,
            profit: Number(p.revenue || 0) - Number(p.cost || 0)
        })),
        showCostAnalytics: flag == null ? true : !!flag
    });
};

// Z raporu — kasiyer kapanış için pratik özet (bugünün durumu)
exports.zReport = (req, res) => exports.daySummary(req, res);
