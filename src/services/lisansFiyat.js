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
//
// KORUNAN MODULLER (korunacak): isletmenin lisansinda zaten olan ama satista olmayan (gizli katalog satiri ya da
// katalogda hic olmayan eski kod) moduller. Satin alinamazlar, ama alim/yenileme/yukseltmede SILINMEZLER:
// bagimliliklari yeni secimle karsilaniyorsa listeye ucretsiz eklenirler. Ornek: "Masadan Siparis" (QR_SIPARIS)
// Patron fiyat girip satisa acana kadar gizli; mevcut isletmelerde QR'dan siparis yenilemede kapanmamali.

const yuvarla = (n) => Math.round((Number(n) || 0) * 100) / 100;
const hata = (status, message, code, ek) => Object.assign(new Error(message), { status, code, ek });

async function fiyatla({ tier, modules, indirimOrani = 0, korunacak = [] }) {
    const data = await K.musteriKatalogu();
    const tierRow = data.tiers.find((t) => t.name === tier);
    if (!tierRow) throw hata(400, 'Geçersiz paket.');
    const koru = new Set((Array.isArray(korunacak) ? korunacak : []).map(String));
    // Korunan bir modul istekte gelse de "secim" sayilmaz (bagimlilik eklemez, ucret almaz); asagida ayrica eklenir.
    const istenen = Array.from(new Set((Array.isArray(modules) ? modules : []).map(String).filter(Boolean)))
        .filter((m) => !koru.has(m));
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

    // Korunan moduller: bagimliliklari (yeni secim + diger korunanlar) ile karsilananlar, ucretsiz
    const secilen = sirali.map((x) => x.name);
    const korunan = [];
    if (koru.size) {
        let degisti = true;
        while (degisti) {
            degisti = false;
            for (const m of koru) {
                if (korunan.includes(m) || secilen.includes(m)) continue;
                if (M.bagimlilikSaglaniyor(m, [...secilen, ...korunan])) { korunan.push(m); degisti = true; }
            }
        }
        const tam = await K.tamKatalog();
        for (const m of korunan) {
            const satir = tam.find((x) => x.tur === 'MODUL' && x.kod === m);
            // Katalogda olmayan eski kodlar (orn. FINANSAL_RAPORLAMA) listede korunur ama dokumde gosterilmez
            if (satir) breakdown.push({ name: m, displayName: satir.ad || M.AD[m] || m, type: 'MODULE', price: 0, korunan: true });
        }
    }

    subtotal = yuvarla(subtotal);
    const discountRate = Number(indirimOrani) || 0;
    const discountAmount = yuvarla(subtotal * discountRate / 100);
    const total = Math.max(0, yuvarla(subtotal - discountAmount));
    return {
        tier, tierRow, modules: [...secilen, ...korunan], korunanModuller: korunan, eklenenBagimliliklar: eklenen,
        breakdown, subtotal, discountRate, discountAmount, total, tableLimit: tierRow.tableLimit,
    };
}

module.exports = { fiyatla, yuvarla, hata };
