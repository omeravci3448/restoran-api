const { query } = require('../config/db');
const MA = require('./magazaAyar');
const MS = require('./magazaSiparis');
const E = require('./magazaEposta');

// --- Magaza: odenmeyen siparisin kendiliginden iptali ---
// Odeme bildirimi YAPILMAMIS ve N gundur "Odeme bekleniyor"da duran siparis IPTAL olur (kapatan SISTEM):
// stok geri doner, gecmise yazilir, isletmeye e-posta gider. "Odemeyi yaptim" denmis siparise DOKUNULMAZ;
// onu Patron hesabi kontrol edip onaylar ya da reddeder. N: Magaza Ayarlari (varsayilan 7, 0 = kapali).
// yeniKayitIzleyici deseni: server.js acilista baslat() cagirir, saatte bir tarar; ayni anda ikinci tarama
// ilkini bekler. Kosul UPDATE icinde yeniden denetlenir (ayni anda "odemeyi yaptim" ya da root islemi gelirse
// siparis iptal edilmez).

const ARALIK_MS = 60 * 60 * 1000;
const ILK_GECIKME_MS = 2 * 60 * 1000;
let suren = null, ilkZaman = null, aralik = null;

async function otomatikIptal({ simdi = new Date() } = {}) {
    const gun = (await MA.oku()).otomatikIptalGun;
    if (!gun) return { kapali: true, gun: 0, iptal: [] };
    const sinir = new Date(simdi.getTime() - gun * 86400000).toISOString();
    const r = await query(
        `SELECT id FROM magaza_siparisler
          WHERE durum = 'ODEME_BEKLENIYOR' AND odeme_bildirildi_at IS NULL AND created_at <= ?
          ORDER BY created_at LIMIT 200`, [sinir]);
    const sebep = `Ödeme ${gun} gün içinde ulaşmadığı için sipariş iptal edildi.`;
    const iptal = [];
    for (const x of r.rows) {
        try {
            if (await MS.sistemIptal({ id: x.id, sebep, sinir })) {
                iptal.push(x.id);
                await E.durumBildir(x.id, 'OTOMATIK_IPTAL');    // hata firlatmaz; gonderilemezse gunluge yazar
            }
        } catch (e) { console.error('[magaza] otomatik iptal:', x.id, e.message); }
    }
    if (iptal.length) console.log(`[magaza] ${iptal.length} odenmeyen siparis otomatik iptal edildi (${gun} gun)`);
    return { kapali: false, gun, iptal };
}

function tara() {
    if (suren) return suren;
    suren = otomatikIptal()
        .catch((e) => { console.error('[magaza] otomatik iptal taramasi:', e.message); return null; })
        .finally(() => { suren = null; });
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

module.exports = { otomatikIptal, tara, baslat, durdur, ARALIK_MS };
