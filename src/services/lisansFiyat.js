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
// Isletmenin zaten sahip oldugu ama satista olmayan moduller (yoksay) istekte gelse de hata vermez, secim
// sayilmaz: onlar onayda korunur (lisansModul.korunacakModuller), ucrete girmez.
// YALNIZ QR MENU (2026-11-18): secimde (bagimliliklarla) Adisyon ve Kasa YOKSA masa kademesi istenmez ve yok sayilir:
// tier null, masa siniri null (tek menu, tek karekod; masa kademesi anlamsiz). Fiyat yalniz modullerden.
// GARSON yeni satista Adisyon ve Kasa ister (lisansModul.SATIS_GEREKIR): BASE'siz secilirse 400
// GARSON_ADISYON_GEREKLI. Istisna garsonBasesizIzinli: isletme GARSON'a zaten sahip (yenileme, eski kural).

const yuvarla = (n) => Math.round((Number(n) || 0) * 100) / 100;
const hata = (status, message, code, ek) => Object.assign(new Error(message), { status, code, ek });

async function fiyatla({ tier, modules, indirimOrani = 0, yoksay = [], garsonBasesizIzinli = false }) {
    const data = await K.musteriKatalogu();
    const atla = new Set((Array.isArray(yoksay) ? yoksay : []).map(String));
    const istenen = Array.from(new Set((Array.isArray(modules) ? modules : []).map(String).filter(Boolean)))
        .filter((m) => !atla.has(m));
    if (!istenen.length) throw hata(400, 'En az bir modül seçin.', 'MODUL_SECILMEDI');
    // GARSON yeni satista BASE ister: once GARSON disindaki secimin bagimliliklari tamamlanir, sonra bakilir
    const garsonVar = istenen.includes('GARSON');
    let { moduller, eklenen } = M.bagimliliklariTamamla(istenen.filter((m) => m !== 'GARSON'));
    if (garsonVar) {
        if (!M.varMi(moduller, 'BASE') && !garsonBasesizIzinli) {
            throw hata(400, M.GARSON_BASE_MESAJI, 'GARSON_ADISYON_GEREKLI');
        }
        // Eski kural (BASE yoksa QR Menu) ile tamamlanir; BASE varsa ek bir sey gerekmez
        const tam = M.bagimliliklariTamamla([...moduller, 'GARSON']);
        moduller = tam.moduller;
        eklenen = [...eklenen, ...tam.eklenen];
    }
    // Masa kademesi yalniz Adisyon ve Kasa ile: yoksa kademe istenmez, gelse de yok sayilir
    const adisyon = M.varMi(moduller, 'BASE');
    const tierRow = adisyon ? data.tiers.find((t) => t.name === tier) : null;
    if (adisyon && !tierRow) throw hata(400, 'Geçersiz paket.');
    const bilinmeyen = moduller.filter((m) => !data.modules.some((x) => x.name === m));
    // Sessizce dusurmuyoruz: musteri sectigini sandigi bir seyin hesaba girmedigini bilmeli.
    if (bilinmeyen.length) throw hata(400, 'Şu an satışta olmayan bir seçenek var: ' + bilinmeyen.join(', '));

    // Katalog sirasi (musteriye gosterilen sira)
    const sirali = data.modules.filter((x) => moduller.includes(x.name));
    const breakdown = tierRow ? [{ name: tierRow.name, displayName: tierRow.displayName, type: 'TIER', price: 0, tableLimit: tierRow.tableLimit }] : [];
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
        tier: tierRow ? tierRow.name : null, tierRow, modules: sirali.map((x) => x.name), korunanModuller: [], eklenenBagimliliklar: eklenen,
        breakdown, subtotal, discountRate, discountAmount, total, tableLimit: tierRow ? tierRow.tableLimit : null, menuPaketi: !adisyon,
    };
}

module.exports = { fiyatla, yuvarla, hata };
