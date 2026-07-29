const BaseAdapter = require('../adapters/BaseAdapter');

// ——— Henüz açılmamış kanallar ———
// Bu adaptörler bilinçli olarak BOŞ. Hiçbir yeteneği beyan etmiyorlar; arayüzde
// "bağlanamaz" görünürler ve neden bağlanamadıklarını (blocker) söylerler.
// Amaç: doküman/erişim gelmeden UYDURMA endpoint yazmamak.

class PendingAdapter extends BaseAdapter {
    constructor({ code, displayName, blocker, nextStep, docsUrl }) {
        super({ code, displayName, capabilities: {}, requiredCredentialFields: [] });
        this.blocker = blocker;
        this.nextStep = nextStep;
        this.docsUrl = docsUrl || null;
    }
    describe() {
        return { ...super.describe(), available: false, blocker: this.blocker, nextStep: this.nextStep, docsUrl: this.docsUrl };
    }
}

// Yemeksepeti / Delivery Hero — İKİ AYRI HAT var, hangisinin geçerli olduğu
// Account Manager'dan öğrenilmeden kod yazılmamalı (yanlış hatta haftalar yanar).
//  Hat A = Partner API v2 (developer.yemeksepeti.com) — bulgular bunun Q-COMMERCE
//          (market) hattı olduğunu gösteriyor; alan dili sku/barcode/picking.
//  Hat B = Restaurant Integration API (developers.deliveryhero.com/documentation/pos.html)
//          — klasik restoran POS hattı. Self-servis YOK: PGP anahtar çifti +
//          credential talep formu + DH onayı + IP allowlist + geçerli SSL.
const yemeksepeti = new PendingAdapter({
    code: 'yemeksepeti',
    displayName: 'Yemeksepeti (Delivery Hero)',
    blocker: 'Restoran POS entegrasyonu için self-servis anahtar yok. Delivery Hero onayı, PGP ile şifreli credential teslimi ve sunucu IP allowlist gerekiyor. Ayrıca hangi hattın (Partner API v2 mi, Restaurant Integration Middleware mı) geçerli olduğu teyit edilmeli.',
    nextStep: 'Account Manager\'a sorulacak: (1) Restoran vendor\'ları için hangi hat geçerli? (2) Hat A ise Partner mı Pelican picking mi? (3) Hat B ise "Direct" model (tabletsiz) onaylanır mı? (4) Türkiye üretim middleware base URL\'i ve resmi spec.',
    docsUrl: 'https://developers.deliveryhero.com/documentation/pos.html',
});

// Migros Yemek (Alacarte) — teknik değil TİCARİ kilit:
// Restoran kendi panelinden anahtar üretebiliyor AMA "Pos Firması" alanı önceden
// tanımlı bir AÇILIR LİSTE. MDA Yazılım o listede görünmeden hiçbir restoran
// bize anahtar üretemez. Resmi doküman da halka açık değil.
const migros = new PendingAdapter({
    code: 'migros',
    displayName: 'Migros Yemek (Alacarte)',
    blocker: 'Migros panelindeki "Pos Firması" açılır listesinde MDA Yazılım görünmüyor. Liste önceden onaylı entegratörlerden oluşuyor; restoran listede olmayan firmaya anahtar üretemez. Resmi API dokümanı da kamuya açık değil.',
    nextStep: 'Migros Yemek iş geliştirme/entegratör başvurusu yapılmalı (Trendyol fazıyla PARALEL başlat — bekleme süresi öngörülemez). Başvuru kanalı kamuya açık değil, kurumsal iletişim gerekiyor.',
    docsUrl: null,
});

// Getir Yemek — platform Uber Eats/Trendyol GO'ya taşındı; API başvuruları
// resmen kapandı ("GetirYemek API başvuruları sonlandırılmıştır").
// Trafik zaten Trendyol GO'ya appName=Galaxy olarak akıyor → trendyolgo adaptörü kapsıyor.
const getir = new PendingAdapter({
    code: 'getir',
    displayName: 'Getir Yemek (kapandı)',
    blocker: 'GetirYemek API başvuruları resmen sonlandırıldı; yeni anahtar alınamıyor. Platform Uber Eats / Trendyol GO\'ya taşındı.',
    nextStep: 'Yeni geliştirme YAPILMAYACAK. Getir hacmi Trendyol GO üzerinden "Galaxy" alt kanalı olarak zaten geliyor — trendyolgo adaptörü bunu kapsıyor.',
    docsUrl: 'https://developers.tgoapps.com',
});

module.exports = { PendingAdapter, yemeksepeti, migros, getir };
