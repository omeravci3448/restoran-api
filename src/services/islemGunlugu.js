const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');

// "Kim ne yapti?" kaydi. Best-effort: gunluk yazilamazsa asil islem bozulmaz.
async function kaydet({ tenantId, user, islem, hedefTur, hedefId, detay }) {
    try {
        await query(
            `INSERT INTO islem_gunlugu (id, tenant_id, user_id, user_name, islem, hedef_tur, hedef_id, detay)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [uuidv4(), tenantId, user ? user.id : null, user ? (user.name || user.email || null) : null,
                islem, hedefTur || null, hedefId || null, String(detay || '').slice(0, 300)]);
    } catch (e) { console.error('[islem-gunlugu] yazilamadi:', e.message); }
}

async function listele(tenantId, { gun, sinir = 200 } = {}) {
    const p = [tenantId];
    let w = 'tenant_id = ?';
    if (gun) { w += " AND substr(created_at, 1, 10) = ?"; p.push(gun); }
    p.push(Math.min(Number(sinir) || 200, 500));
    const r = await query(`SELECT id, user_name, islem, hedef_tur, hedef_id, detay, created_at
                            FROM islem_gunlugu WHERE ${w} ORDER BY created_at DESC LIMIT ?`, p);
    return r.rows;
}

module.exports = { kaydet, listele };
