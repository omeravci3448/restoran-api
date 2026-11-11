const K = require('./lisansKatalog');
const M = require('./lisansModul');

// --- Moduler lisans fiyati ---
// Patron karari (2026-11-11):
//  - Masa kademesi (TIER) her zaman secilir: masa siniri ondan gelir.
//  - "Adisyon ve Kasa" (BASE) modulunun fiyati secilen kademenin fiyatidir. BASE secilmezse kademe fiyati
//    alinmaz (masa siniri yine kademeden). Katalogdaki BASE satirinin kendi fiyati KULLANILMAZ.
//  - Diger moduller katalog fiyatiyla. Ucretsiz moduller artik sepete KENDILIGINDEN EKLENMEZ: moduller acikca
//    secilir, secilen modulun bagimliliklari kendiliginden eklenir (services/lisansModul.js).
//  - Gizli (gorunur=0) kademe ya da modul fiyatlanamaz, satin alinamaz.
//  - Kiraci indirimi (discount_rate) toplamdan dusulur.

const yuvarla = (n) => Math.round((Number(n) || 0) * 100) / 100;
const hata = (status, message, code) => Object.assign(new Error(message), { status, code });

async function fiyatla({ tier, modules, indirimOrani = 0 }) {
    const data = await K.musteriKatalogu();
    const tierRow = data.tiers.find((t) => t.name === tier);
    if (!tierRow) throw hata(400, 'Geçersiz paket.');
    const istenen = Array.from(new Set((Array.isArray(modules) ? modules : []).map(String).filter(Boolean)));
    if (!istenen.length) throw hata(400, 'En az bir modül seçin.', 'MODUL_SECILMEDI');
    const { moduller, eklenen } = M.bagimliliklariTamamla(istenen);
    const bilinmeyen = moduller.filter((m) => !data.modules.some((x) => x.name === m));
    // Sessizce dusurmuyoruz: musteri sectigini sandigi bir seyin hesaba girmedigini bilmeli.
    if (bilinmeyen.length) throw hata(400, 'Şu an satışta olmayan bir seçenek var: ' + bilinmeyen.join(', '));

    // Katalog sirasi (musteriye gosterilen sira)
    const sirali = data.modules.filter((x) => moduller.includes(x.name));
    const breakdown = [{ name: tier, displayName: tierRow.displayName, type: 'TIER', price: 0, tableLimit: tierRow.tableLimit }];
    let subtotal = 0;
    for (const row of sirali) {
        const price = row.name === 'BASE' ? (Number(tierRow.price) || 0) : (Number(row.price) || 0);
        breakdown.push({ name: row.name, displayName: row.displayName, type: 'MODULE', price,
            ...(row.name === 'BASE' ? { kademe: tierRow.displayName } : {}) });
        subtotal += price;
    }
    subtotal = yuvarla(subtotal);
    const discountRate = Number(indirimOrani) || 0;
    const discountAmount = yuvarla(subtotal * discountRate / 100);
    const total = Math.max(0, yuvarla(subtotal - discountAmount));
    return {
        tier, tierRow, modules: sirali.map((x) => x.name), eklenenBagimliliklar: eklenen,
        breakdown, subtotal, discountRate, discountAmount, total, tableLimit: tierRow.tableLimit,
    };
}

module.exports = { fiyatla, yuvarla, hata };
