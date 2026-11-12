const { query } = require('../config/db');
const MS = require('./magazaSiparis');
const B = require('./magazaBildirim');
const E = require('./magazaEposta');

// --- Magaza zamanlayicisi (saatte bir) ---
// 1) Odenmeyen siparisin otomatik iptali: odeme bildirimi YAPILMAMIS ve siparise olusurken yazilan otomatik_iptal_at
//    ani gecmis siparis IPTAL olur (kapatan SISTEM); stok geri doner, gecmise yazilir, isletmeye e-posta gider.
//    "Odemeyi yaptim" denmis siparise dokunulmaz. Ayar (Magaza Ayarlari, 0 = kapali) yalniz YENI siparislere
//    tarih yazar; sonradan degisse de mevcut siparisin tarihi gecerli kalir (geriye donuk uygulanmaz).
// 2) Onay bekleyen odeme hatirlatmasi: "odemeyi yaptim" denmis ama 2 gundur onaylanmamis siparis icin Patron'a
//    rootaBildir + root_olaylar (magaza_hatirlatma). 2. gunde bir, 3. gunde bir kez daha; gunde en cok bir.
// yeniKayitIzleyici deseni: server.js acilista baslat() cagirir; ayni anda ikinci tarama ilkini bekler.

const ARALIK_MS = 60 * 60 * 1000;
const ILK_GECIKME_MS = 2 * 60 * 1000;
const GUN_MS = 86400000;
let suren = null, ilkZaman = null, aralik = null;

async function otomatikIptal({ simdi = new Date() } = {}) {
    const an = simdi.toISOString();
    const r = await query(
        `SELECT id FROM magaza_siparisler
          WHERE durum = 'ODEME_BEKLENIYOR' AND odeme_bildirildi_at IS NULL
            AND otomatik_iptal_at IS NOT NULL AND otomatik_iptal_at <= ?
          ORDER BY otomatik_iptal_at LIMIT 200`, [an]);
    const iptal = [];
    for (const x of r.rows) {
        try {
            if (await MS.sistemIptal({ id: x.id, simdiIso: an })) {
                iptal.push(x.id);
                await E.durumBildir(x.id, 'OTOMATIK_IPTAL');    // hata firlatmaz; gonderilemezse gunluge yazar
            }
        } catch (e) { console.error('[magaza] otomatik iptal:', x.id, e.message); }
    }
    if (iptal.length) console.log(`[magaza] ${iptal.length} odenmeyen siparis otomatik iptal edildi`);
    return { iptal };
}

// root_olaylar.created_at CURRENT_TIMESTAMP bicimindedir ('YYYY-MM-DD HH:MM:SS', UTC)
const olayZamani = (t) => Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? t.replace(' ', 'T') + 'Z' : t);

async function hatirlatmalar({ simdi = new Date() } = {}) {
    const sinir = new Date(simdi.getTime() - 2 * GUN_MS).toISOString();
    const r = await query(
        `SELECT * FROM magaza_siparisler
          WHERE durum = 'ODEME_BEKLENIYOR' AND odeme_bildirildi_at IS NOT NULL AND odeme_bildirildi_at <= ?
          ORDER BY odeme_bildirildi_at LIMIT 200`, [sinir]);
    const gonderilen = [];
    for (const s of r.rows) {
        try {
            const gecen = (simdi.getTime() - Date.parse(s.odeme_bildirildi_at)) / GUN_MS;
            const asama = gecen >= 3 ? 3 : 2;
            const onceki = (await query("SELECT ref, created_at FROM root_olaylar WHERE tur = ? AND ref IN (?, ?)",
                [B.TUR.HATIRLATMA, s.id + ':2', s.id + ':3'])).rows;
            if (onceki.some(x => x.ref === s.id + ':' + asama)) continue;              // bu asama gonderildi
            const son = Math.max(0, ...onceki.map(x => olayZamani(x.created_at) || 0));
            if (son && simdi.getTime() - son < GUN_MS) continue;                       // gunde en cok bir hatirlatma
            if (await B.hatirlatma(s, asama)) gonderilen.push({ id: s.id, asama });
        } catch (e) { console.error('[magaza] hatirlatma:', s.id, e.message); }
    }
    return { gonderilen };
}

function tara() {
    if (suren) return suren;
    suren = (async () => {
        await otomatikIptal().catch((e) => console.error('[magaza] otomatik iptal taramasi:', e.message));
        await hatirlatmalar().catch((e) => console.error('[magaza] hatirlatma taramasi:', e.message));
    })().finally(() => { suren = null; });
    return suren;
}

function baslat() {
    if (ilkZaman || aralik) return;
    ilkZaman = setTimeout(tara, ILK_GECIKME_MS);
    aralik = setInterval(tara, ARALIK_MS);
}

function durdur() {
    clearTimeout(ilkZaman); clearInterval(aralik);
    ilkZaman = null; aralik = null;
}

module.exports = { otomatikIptal, hatirlatmalar, tara, baslat, durdur, ARALIK_MS };
