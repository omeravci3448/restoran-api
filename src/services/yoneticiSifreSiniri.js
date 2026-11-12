// --- Yonetici sifresi deneme siniri (isletme basina) ---
// Yonetici sifresi (6+ hane) hem /api/auth/manager-verify ucunda hem de requireManagerPin ara katmaninda
// (x-manager-pin basligi: lisans, plaka, magaza, ayar uclari) denenebilir. Ikisi AYNI sayaci kullanir: biri
// kapaninca digerinden denemek de kapanir. 5 dakikada 8 hatali denemeden sonra 429.
// Ayni anda gelen denemeler siniri asamasin diye "suren" sayaci karsilastirmadan (bcrypt) ONCE artar.
// Bellek ici (tek konteyner yeterli); yeniden baslatmada sifirlanir.

const ESIK = 8;
const PENCERE_MS = 5 * 60 * 1000;
const kayitlar = new Map();   // tenantId -> { hata, bitis, suren }

function kayit(tenantId) {
    const simdi = Date.now();
    let k = kayitlar.get(tenantId);
    if (!k) { k = { hata: 0, bitis: 0, suren: 0 }; kayitlar.set(tenantId, k); }
    if (k.hata && simdi >= k.bitis) { k.hata = 0; k.bitis = 0; }
    if (kayitlar.size > 50000) {
        for (const [a, v] of kayitlar) if (!v.suren && (!v.hata || simdi >= v.bitis)) kayitlar.delete(a);
    }
    return k;
}

// Sinir asildiysa (tamamlanan hatalar + suren denemeler) true
function kilitliMi(tenantId) {
    const k = kayit(tenantId);
    return k.hata + k.suren >= ESIK;
}

// Deneme baslat: kilitliyse null; degilse bitir(dogru) islevi. Hatali deneme pencereyi baslatir/sayar,
// dogru deneme sayaci sifirlar.
function denemeBaslat(tenantId) {
    const k = kayit(tenantId);
    if (k.hata + k.suren >= ESIK) return null;
    k.suren++;
    let bitti = false;
    return (dogru) => {
        if (bitti) return;
        bitti = true;
        k.suren = Math.max(0, k.suren - 1);
        if (dogru) { k.hata = 0; k.bitis = 0; return; }
        if (!k.hata) k.bitis = Date.now() + PENCERE_MS;
        k.hata++;
    };
}

const KILIT_MESAJI = 'Çok fazla hatalı yönetici şifresi denemesi. Birkaç dakika sonra tekrar deneyin.';

module.exports = { ESIK, PENCERE_MS, kilitliMi, denemeBaslat, KILIT_MESAJI };
