const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');

// "Kim ne yapti?" kaydi. Best-effort: gunluk yazilamazsa asil islem bozulmaz.
// Destek oturumu (user.destek): kullanici "MDA Destek" (user_id bos). Bu istek icin ozel kayit yazildigi isaretlenir;
// destek oturumunun genel "degisiklik" kaydi (services/destekOturumu.js istekKaydi) ayni istek icin ikinci satir yazmaz.
async function kaydet({ tenantId, user, islem, hedefTur, hedefId, detay }) {
    if (user && user.destek) {
        if (islem !== 'destek_degisiklik') user.destek.gunlukYazildi = true;
        user = { id: null, name: require('./destekOturumu').DESTEK_ADI };
    }
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

// Kayit ayrintisinda kim: destek oturumunda rol (OWNER) yerine "MDA Destek" (guvenlik incelemesi, dusuk 6)
function rolEtiketi(user) {
    return user && user.destek ? require('./destekOturumu').DESTEK_ADI : String((user && user.role) || '');
}

module.exports = { kaydet, listele, rolEtiketi };
