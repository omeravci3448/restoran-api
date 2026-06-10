const { query } = require('../config/db');

// SQLite CURRENT_TIMESTAMP "YYYY-MM-DD HH:MM:SS" formatı kullandığı için
// karşılaştırmayı substr ile günlük bazda yapıyoruz
exports.daySummary = async (req, res) => {
    const day = req.query.date || new Date().toISOString().slice(0, 10);
    const t = req.user.tenantId;

    const totals = await query(
        `SELECT
            COUNT(*) AS order_count,
            COALESCE(SUM(total), 0) AS revenue,
            COALESCE(SUM(CASE WHEN channel = 'DINE_IN' THEN total ELSE 0 END), 0) AS dine_in_revenue,
            COALESCE(SUM(CASE WHEN channel != 'DINE_IN' THEN total ELSE 0 END), 0) AS marketplace_revenue
           FROM orders
          WHERE tenant_id = ? AND status = 'CLOSED' AND substr(closed_at, 1, 10) = ?`,
        [t, day]);

    const byChannel = await query(
        `SELECT channel, COUNT(*) AS cnt, COALESCE(SUM(total), 0) AS revenue
           FROM orders
          WHERE tenant_id = ? AND status = 'CLOSED' AND substr(closed_at, 1, 10) = ?
          GROUP BY channel
          ORDER BY revenue DESC`,
        [t, day]);

    const byPayment = await query(
        `SELECT p.method, COUNT(*) AS cnt, COALESCE(SUM(p.amount), 0) AS amount
           FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE p.tenant_id = ? AND o.status = 'CLOSED' AND substr(o.closed_at, 1, 10) = ?
          GROUP BY p.method
          ORDER BY amount DESC`,
        [t, day]);

    const topProducts = await query(
        `SELECT oi.product_name AS name,
                SUM(oi.qty) AS qty,
                SUM(oi.total) AS revenue,
                SUM(oi.qty * COALESCE(p.cost, 0)) AS cost
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products p ON p.id = oi.product_id
          WHERE o.tenant_id = ? AND o.status = 'CLOSED' AND substr(o.closed_at, 1, 10) = ?
          GROUP BY oi.product_name
          ORDER BY revenue DESC
          LIMIT 20`,
        [t, day]);

    // Toplam maliyet + net kar (tüm satılan ürünlerin maliyet × adet toplamı)
    const costRow = await query(
        `SELECT COALESCE(SUM(oi.qty * COALESCE(p.cost, 0)), 0) AS total_cost
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products p ON p.id = oi.product_id
          WHERE o.tenant_id = ? AND o.status = 'CLOSED' AND substr(o.closed_at, 1, 10) = ?`,
        [t, day]);

    const totalCost = Number(costRow.rows[0].total_cost || 0);
    const revenue = Number(totals.rows[0].revenue || 0);
    const totalsWithProfit = {
        ...totals.rows[0],
        total_cost: totalCost,
        net_profit: revenue - totalCost
    };

    // Ayara göre maliyet/kar görünürlüğü
    const showCost = await query('SELECT show_cost_analytics FROM tenants WHERE id = ?', [t]);
    const flag = showCost.rows[0]?.show_cost_analytics;

    res.json({
        day,
        totals: totalsWithProfit,
        byChannel: byChannel.rows,
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
    const monthStr = req.query.month || new Date().toISOString().slice(0, 7); // 2026-05
    const t = req.user.tenantId;

    // Gün gün ciro
    const dailySimple = await query(
        `SELECT substr(closed_at, 1, 10) AS day,
                COUNT(*) AS cnt,
                COALESCE(SUM(total), 0) AS revenue,
                COALESCE(SUM(CASE WHEN channel = 'DINE_IN' THEN total ELSE 0 END), 0) AS dine_in,
                COALESCE(SUM(CASE WHEN channel != 'DINE_IN' THEN total ELSE 0 END), 0) AS marketplace
           FROM orders
          WHERE tenant_id = ? AND status = 'CLOSED' AND substr(closed_at, 1, 7) = ?
          GROUP BY day
          ORDER BY day`,
        [t, monthStr]);

    // Gün başına maliyet
    const dailyCost = await query(
        `SELECT substr(o.closed_at, 1, 10) AS day,
                COALESCE(SUM(oi.qty * COALESCE(p.cost, 0)), 0) AS cost
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products p ON p.id = oi.product_id
          WHERE o.tenant_id = ? AND o.status = 'CLOSED' AND substr(o.closed_at, 1, 7) = ?
          GROUP BY day`,
        [t, monthStr]);
    const costMap = {};
    dailyCost.rows.forEach(r => { costMap[r.day] = Number(r.cost); });

    const dailyWithProfit = dailySimple.rows.map(d => {
        const cost = costMap[d.day] || 0;
        return { ...d, cost, profit: Number(d.revenue) - cost };
    });

    const totals = dailyWithProfit.reduce((s, r) => ({
        revenue: s.revenue + Number(r.revenue),
        cnt: s.cnt + Number(r.cnt),
        dine_in: s.dine_in + Number(r.dine_in),
        marketplace: s.marketplace + Number(r.marketplace),
        cost: s.cost + Number(r.cost),
        profit: s.profit + Number(r.profit)
    }), { revenue: 0, cnt: 0, dine_in: 0, marketplace: 0, cost: 0, profit: 0 });

    const topProducts = await query(
        `SELECT oi.product_name AS name,
                SUM(oi.qty) AS qty,
                SUM(oi.total) AS revenue,
                SUM(oi.qty * COALESCE(p.cost, 0)) AS cost
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products p ON p.id = oi.product_id
          WHERE o.tenant_id = ? AND o.status = 'CLOSED' AND substr(o.closed_at, 1, 7) = ?
          GROUP BY oi.product_name
          ORDER BY revenue DESC
          LIMIT 30`,
        [t, monthStr]);

    const showCost = await query('SELECT show_cost_analytics FROM tenants WHERE id = ?', [t]);
    const flag = showCost.rows[0]?.show_cost_analytics;

    res.json({
        month: monthStr,
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
