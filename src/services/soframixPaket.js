const { query } = require('../config/db');
const M = require('./lisansModul');

// --- SofraMix paketleri (POS tarafi) ---
//
// SofraMix isletme panelinde POS paketi satiliyor; para SofraMix'ten geciyor (MDA'nin kendi sanal POS'u yok).
// Paketler ve fiyatlar BURADAN (POS katalogundan) okunur:
//   - normal fiyat: lisans_katalog.fiyat (KDV haric, yillik)
//   - SofraMix uyelerine ozel fiyat: lisans_katalog.smx_fiyat (NULL = normal fiyatla ayni)
//   - tam paket (butun moduller, sinirsiz masa): root ayari smx_tam_paket_fiyat (bos = tam paket sunulmaz;
//     SofraMix o zaman kendi eski fiyatina duser)
// SofraMix paketleri GET /api/public/soframix-paketler ile ceker; odeme onaylaninca secim pos_paket alaniyla
// geri gelir (posProvizyon.odemeIsle) ve tutar BURADAKI guncel katalogla yeniden hesaplanip karsilastirilir.

const SURUM = 1;
const TAM_PAKET_AYARI = 'smx_tam_paket_fiyat';
const ZORUNLU_MODULLER = ['MARKETPLACE'];   // SofraMix siparisleri POS'a duser (Adisyon ve Kasa varsa)
const TUTAR_TOLERANS_KURUS = 100;           // 1 TL
const NOTLAR = [
    'Fiyatlar yıllıktır ve KDV hariçtir.',
    'Adisyon ve Kasa seçilmezse masa paketi gerekmez; menü tek karekodla çalışır.',
];

const yuvarla = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Tam paketin modulleri: POS'un tam SofraMix paketinde yazdigi liste (posProvizyon.VARSAYILAN_MODULLER).
// Gec yuklenir: posProvizyon bu dosyayi kullaniyor (dongusel require).
function tamPaketModulleri() {
    return require('./posProvizyon').VARSAYILAN_MODULLER.slice();
}

// Root ayari kdv_orani varsa o (0-100), yoksa 20.
async function kdvOrani() {
    try {
        const r = await query("SELECT deger FROM sistem_ayarlari WHERE anahtar = 'kdv_orani'");
        const ham = r.rows[0] && r.rows[0].deger;
        if (ham != null && String(ham).trim() !== '') {
            const n = Number(String(ham).trim().replace(',', '.'));
            if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
        }
    } catch (_) { /* tablo yoksa varsayilan */ }
    return 20;
}

// Tam paket fiyati (TL, KDV haric) ya da null (sunulmuyor)
async function tamPaketFiyati() {
    const r = await query('SELECT deger FROM sistem_ayarlari WHERE anahtar = ?', [TAM_PAKET_AYARI]);
    const ham = r.rows[0] && r.rows[0].deger;
    if (ham == null || String(ham).trim() === '') return null;
    const n = Number(String(ham).trim());
    return Number.isFinite(n) && n > 0 ? n : null;
}

// Satistaki (gorunur=1) katalog satirlari
async function gorunurKatalog() {
    const r = await query(
        `SELECT tur, kod, ad, aciklama, fiyat, masa_limiti, smx_fiyat
           FROM lisans_katalog WHERE gorunur = 1 ORDER BY tur DESC, sira, ad`);
    const satir = (x) => ({
        kod: x.kod, ad: x.ad, aciklama: x.aciklama || '',
        normalFiyat: yuvarla(x.fiyat),
        smxFiyat: x.smx_fiyat == null ? yuvarla(x.fiyat) : yuvarla(x.smx_fiyat),
        masaSiniri: x.masa_limiti == null ? null : Number(x.masa_limiti),
    });
    return {
        tierler: r.rows.filter((x) => x.tur === 'TIER').map(satir),
        moduller: r.rows.filter((x) => x.tur === 'MODUL').map(satir),
    };
}

// Bir modulun gereksinimleri (services/lisansModul.js BAGIMLILIK kurali). "hepsi" aynen; "biri" (en az biri)
// icin ilk secenek yazilir: SofraMix onu kendiliginden ekler, POS dogrulamasi da bunu gecerli sayar.
function gerekir(kod) {
    const b = M.BAGIMLILIK[kod];
    if (!b) return [];
    const l = [...(b.hepsi || [])];
    if (b.biri && b.biri.length && !b.biri.some((g) => l.includes(g))) l.push(b.biri[0]);
    return Array.from(new Set(l));
}

// Tam paketin normal fiyati: sinirsiz masa paketi + satistaki modullerin fiyati (Adisyon ve Kasa'nin
// fiyati masa paketinden gelir, ayrica eklenmez).
function tamNormalFiyat(kat) {
    const sinirsiz = kat.tierler.find((t) => t.kod === 'TIER_20_PLUS')
        || kat.tierler.find((t) => t.masaSiniri == null)
        || kat.tierler.slice().sort((a, b) => b.normalFiyat - a.normalFiyat)[0];
    const masa = sinirsiz ? sinirsiz.normalFiyat : 0;
    return yuvarla(masa + kat.moduller.filter((m) => m.kod !== 'BASE').reduce((s, m) => s + m.normalFiyat, 0));
}

// GET /api/public/soframix-paketler govdesi
async function paketler() {
    const kat = await gorunurKatalog();
    const adlar = Object.fromEntries(kat.moduller.map((m) => [m.kod, m.ad]));
    const tamFiyat = await tamPaketFiyati();
    const tamModul = tamPaketModulleri();
    return {
        surum: SURUM,
        kdvOrani: await kdvOrani(),
        tamPaket: tamFiyat == null ? null : {
            kod: 'TAM', ad: 'Tam paket', aciklama: 'Tüm modüller açık, sınırsız masa',
            moduller: tamModul,
            modulAdlari: tamModul.map((k) => adlar[k] || M.AD[k] || k),
            masaSiniri: null,
            normalFiyat: tamNormalFiyat(kat),
            smxFiyat: yuvarla(tamFiyat),
        },
        masaPaketleri: kat.tierler.map((t) => ({ kod: t.kod, ad: t.ad, masaSiniri: t.masaSiniri, normalFiyat: t.normalFiyat, smxFiyat: t.smxFiyat })),
        moduller: kat.moduller.map((m) => {
            const base = m.kod === 'BASE';
            return {
                kod: m.kod, ad: m.ad, aciklama: m.aciklama,
                normalFiyat: base ? 0 : m.normalFiyat, smxFiyat: base ? 0 : m.smxFiyat,
                fiyatMasaPaketinden: base,
                gerekir: gerekir(m.kod).filter((g) => kat.moduller.some((x) => x.kod === g)),
            };
        }),
        zorunluModuller: ZORUNLU_MODULLER.slice(),
        notlar: NOTLAR.slice(),
    };
}

// --- pos_paket dogrulama (provizyon) ---
// Girdi: SofraMix'in odemeyle gonderdigi pos_paket (nesne ya da JSON metni) ya da null.
// Doner:
//   { tur: null }                                         eski odeme (paket bilgisi yok)
//   { tur: 'tam'|'ozel', tier, moduller, masaSiniri, beklenenKurus, gelenKurus, tutarUyumlu, ham }
//   { hata: 'paket_gecersiz', mesaj, ham }                bicim/katalog hatasi -> provizyon elde kalir
function hamCoz(pp) {
    if (pp == null || pp === '') return null;
    if (typeof pp === 'string') { try { return JSON.parse(pp); } catch (_) { return { _bozuk: true }; } }
    return pp;
}

async function posPaketCoz(ppHam) {
    const pp = hamCoz(ppHam);
    if (pp == null) return { tur: null };
    const ham = JSON.stringify(pp).slice(0, 2000);
    const red = (mesaj) => ({ hata: 'paket_gecersiz', mesaj, ham });
    if (pp._bozuk || typeof pp !== 'object' || Array.isArray(pp)) return red('Paket bilgisi okunamadı.');
    if (Number(pp.surum) !== SURUM) return red('Paket bilgisinin sürümü desteklenmiyor.');
    const gelenKurus = pp.smxTutarKurus == null || pp.smxTutarKurus === '' ? null : Number(pp.smxTutarKurus);
    if (gelenKurus == null || !Number.isFinite(gelenKurus) || gelenKurus < 0) return red('Paket tutarı eksik ya da geçersiz.');

    if (pp.tur === 'tam') {
        const fiyat = await tamPaketFiyati();
        // Tam paket fiyati tanimli degilse karsilastiracak fiyat yok: eski (paket bilgisiz) odemeler gibi kabul.
        const beklenenKurus = fiyat == null ? null : Math.round(fiyat * 100);
        return {
            tur: 'tam', tier: null, moduller: tamPaketModulleri(), masaSiniri: null,
            beklenenKurus, gelenKurus,
            tutarUyumlu: beklenenKurus == null || Math.abs(beklenenKurus - gelenKurus) <= TUTAR_TOLERANS_KURUS,
            ham,
        };
    }
    if (pp.tur !== 'ozel') return red('Paket türü tanınmadı.');

    const kat = await gorunurKatalog();
    const istenen = Array.from(new Set((Array.isArray(pp.moduller) ? pp.moduller : []).map(String).filter(Boolean)))
        .filter((m) => !ZORUNLU_MODULLER.includes(m));
    if (!istenen.length) return red('Paket bilgisinde modül yok.');
    const bilinmeyen = istenen.filter((m) => !kat.moduller.some((x) => x.kod === m));
    if (bilinmeyen.length) return red('Satışta olmayan modül: ' + bilinmeyen.join(', '));
    const eksik = istenen.filter((m) => !M.bagimlilikSaglaniyor(m, istenen));
    if (eksik.length) return red('Modül gereksinimi karşılanmıyor: ' + eksik.join(', '));

    const adisyon = istenen.includes('BASE');
    const tierKod = pp.tier == null || pp.tier === '' ? null : String(pp.tier);
    let tier = null;
    if (tierKod) {
        tier = kat.tierler.find((t) => t.kod === tierKod) || null;
        if (!tier) return red('Satışta olmayan masa paketi: ' + tierKod);
    } else if (adisyon) {
        return red('Adisyon ve Kasa için masa paketi seçilmemiş.');
    }

    let beklenen = adisyon ? tier.smxFiyat : 0;
    for (const m of istenen) if (m !== 'BASE') beklenen += kat.moduller.find((x) => x.kod === m).smxFiyat;
    const beklenenKurus = Math.round(yuvarla(beklenen) * 100);
    // SofraMix siparisleri adisyona duser: MARKETPLACE yalniz Adisyon ve Kasa varsa eklenir (BAGIMLILIK kurali).
    const moduller = adisyon ? [...istenen, ...ZORUNLU_MODULLER.filter((z) => !istenen.includes(z))] : istenen;
    return {
        tur: 'ozel', tier: tier ? tier.kod : null, moduller,
        masaSiniri: tier ? tier.masaSiniri : null,
        beklenenKurus, gelenKurus,
        tutarUyumlu: Math.abs(beklenenKurus - gelenKurus) <= TUTAR_TOLERANS_KURUS,
        ham,
    };
}

// --- Isletmenin bugunku SofraMix paketi (durum ucu + lisans sayfasi) ---
// tur: 'deneme' (TIER_DENEME) | 'tam' (tam paket modulleri + sinirsiz masa) | 'ozel'
async function kiraciPaketi(t) {
    const moduller = M.modulListesi(t.license_modules);
    if (t.license_tier === 'TIER_DENEME') return { tur: 'deneme', tier: null, moduller };
    const tumu = moduller.includes('ALL') || tamPaketModulleri().every((m) => moduller.includes(m));
    if (tumu && t.license_table_limit == null) return { tur: 'tam', tier: null, moduller };
    const r = await query("SELECT 1 FROM lisans_katalog WHERE tur = 'TIER' AND kod = ?", [String(t.license_tier || '')]);
    return { tur: 'ozel', tier: r.rows.length ? t.license_tier : null, moduller };
}

// Lisans sayfasinin SofraMix karti icin okunur paket bilgisi
async function kiraciPaketBilgisi(tenantId) {
    const t = (await query(
        'SELECT license_tier, license_modules, license_table_limit, license_end_date FROM tenants WHERE id = ?', [tenantId])).rows[0];
    if (!t) return null;
    const p = await kiraciPaketi(t);
    const r = await query('SELECT tur, kod, ad FROM lisans_katalog');
    const ad = (tur, kod) => { const x = r.rows.find((y) => y.tur === tur && y.kod === kod); return x ? x.ad : null; };
    const TUR_AD = { tam: 'Tam paket', ozel: 'Seçili modüller', deneme: 'Deneme' };
    return {
        ...p,
        turAd: TUR_AD[p.tur],
        tierAd: p.tier ? ad('TIER', p.tier) : null,
        masaSiniri: t.license_table_limit == null ? null : Number(t.license_table_limit),
        modulAdlari: p.moduller.filter((m) => m !== 'ALL').map((m) => ad('MODUL', m) || M.AD[m] || m),
        bitis: t.license_end_date || null,
    };
}

module.exports = {
    SURUM, TAM_PAKET_AYARI, ZORUNLU_MODULLER, TUTAR_TOLERANS_KURUS, NOTLAR,
    kdvOrani, tamPaketFiyati, gorunurKatalog, gerekir, tamNormalFiyat, paketler, posPaketCoz, kiraciPaketi, kiraciPaketBilgisi,
};
