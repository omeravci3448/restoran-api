const { query } = require('../config/db');
const A = require('./sistemAyar');
const { rootaBildir } = require('./rootBildirim');

// ——— Patron olaylari: yeni restoran kaydi + SofraMix'ten paket alimi ———
// Kiraci (restoran) bes ayri yoldan acilir: sitedeki kayit formu (7 gunluk demo), dogrudan deneme
// (TIER_DENEME), SofraMix deneme devri, SofraMix'te satin alinan POS paketi (provizyon) ve root
// panelinden elle. Her yola ayri kanca takmak yerine tablolari TARIYORUZ:
//   - yarin acilacak altinci yol da kendiliginden yakalanir,
//   - bildirim ancak kayit KESINLESTIKTEN (transaction bittikten) sonra gider; geri alinan bir
//     islem icin "yeni kayit" postasi cikmaz.
// Her olay root_olaylar'a tek satir yazilir (UNIQUE tur+ref): ayni anda iki tarama calissa da
// e-posta bir kez gider. Yonetim APK'si (1.4+) bu tablonun son id'sini sorarak telefona bildirim dusurur.

const BASLANGIC = 'olay_izleme_baslangic';
const ARALIK_MS = 60 * 1000;
const TIER_AD = { TIER_1_5: '1-5 masa', TIER_6_10: '6-10 masa', TIER_11_20: '11-20 masa', TIER_20_PLUS: '20+ masa' };

let suren = null;
// Sunucunun acilis ani (modul server.js'te dinlemeye baslayinca yuklenir)
const ACILIS_ISO = new Date().toISOString();

// Izleme baslangici: ilk calismada sunucunun ACILIS ani yazilir; o ana kadarki kiracilar ve odemeler
// "yeni" sayilmaz (yayin gunu eski kayitlar icin posta yagmasin). "Simdi" degil acilis ani: ilk tarama
// 9 sn sonra calisiyor, arada acilan bir kayit kacmasin.
async function baslangic() {
    let b = await A.oku(BASLANGIC, '');
    if (!b) {
        b = (await query('SELECT datetime(?) AS s', [ACILIS_ISO])).rows[0].s;
        await A.yaz(BASLANGIC, b);
    }
    return b;
}

function trTarih(t) {
    if (!t) return '';
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? t.replace(' ', 'T') + 'Z' : t);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' });
}
function trSaat(t) {
    if (!t) return '';
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? t.replace(' ', 'T') + 'Z' : t);
    return isNaN(d.getTime()) ? '' : d.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'short', timeStyle: 'short' });
}

// Nereden geldi + hangi surum (e-postadaki ve telefon bildirimindeki kisa aciklama)
function etiketle(t) {
    const smx = t.parent_org === 'SofraMix';
    const bitis = trTarih(t.license_end_date);
    const tier = t.license_tier || '';
    if (tier === 'TIER_DENEME') {
        return { kaynak: smx ? 'SofraMix' : 'Site (deneme formu)', surum: 'Deneme sürümü' + (bitis ? ', bitiş ' + bitis : '') };
    }
    if (tier === 'TIER_SOFRAMIX' || Number(t.provizyon_sayisi) > 0) {
        return { kaynak: smx ? 'SofraMix' : 'Ödeme ile', surum: 'Tam sürüm (POS paketi satın alındı)' };
    }
    if (tier === 'TIER_KURUM') {
        return { kaynak: 'Root paneli (elle açıldı)' + (t.parent_org ? ', ' + t.parent_org : ''), surum: 'Kurum lisansı' };
    }
    if (TIER_AD[tier]) {
        return { kaynak: 'Site (kayıt formu)', surum: '7 günlük deneme, seçilen paket ' + TIER_AD[tier] + (bitis ? ', bitiş ' + bitis : '') };
    }
    return { kaynak: t.parent_org || 'Diğer', surum: tier || 'Bilinmiyor' };
}

async function olayYaz(tur, ref, tenantId, baslik, detay) {
    const r = await query(
        'INSERT OR IGNORE INTO root_olaylar (tur, ref, tenant_id, baslik, detay) VALUES (?, ?, ?, ?, ?)',
        [tur, ref, tenantId || null, String(baslik || '').slice(0, 120), String(detay || '').slice(0, 300)]);
    return !!r.changes;   // false: bu olayi baska bir tarama zaten yazdi
}

async function yeniKiracilar(b) {
    const r = await query(
        `SELECT t.id, t.business_name, t.business_code, t.owner_email, t.phone, t.parent_org,
                t.license_tier, t.license_end_date, t.created_at,
                (SELECT COUNT(*) FROM pos_provizyon p WHERE p.tenant_id = t.id) AS provizyon_sayisi
           FROM tenants t
          WHERE datetime(t.created_at) >= datetime(?)
            AND NOT EXISTS (SELECT 1 FROM root_olaylar o WHERE o.tur = 'yeni_kayit' AND o.ref = t.id)
          ORDER BY t.created_at ASC LIMIT 50`, [b]);
    for (const t of r.rows) {
        const { kaynak, surum } = etiketle(t);
        const ad = t.business_name || 'İsimsiz işletme';
        if (!await olayYaz('yeni_kayit', t.id, t.id, ad, kaynak + ' · ' + surum)) continue;
        rootaBildir('Yeni restoran kaydı: ' + ad, [
            ['İşletme', ad + (t.business_code ? ' (kod ' + t.business_code + ')' : '')],
            ['Nereden', kaynak],
            ['Sürüm', surum],
            ['Yetkili e-posta', t.owner_email || '-'],
            ['Telefon', t.phone || '-'],
            ['Kayıt zamanı', trSaat(t.created_at)],
        ], { dugme: 'Root paneli > İşletmeler' }).catch(() => {});
    }
}

// SofraMix'te POS paketi alindi ama kiraci ZATEN vardi (deneme kullanan isletme tam surume gecti
// ya da yillik yenileme): yeni kiraci acilmadigi icin yukaridaki tarama gormez, ayrica bakilir.
async function sofraMixPaketleri(b) {
    const r = await query(
        `SELECT p.odeme_id, p.tenant_id, p.isletme_adi, p.tutar_kurus, p.donem_bitis, t.business_name
           FROM pos_provizyon p LEFT JOIN tenants t ON t.id = p.tenant_id
          WHERE p.durum = 'islendi' AND COALESCE(p.kiraci_acildi, 0) = 0
            AND datetime(p.created_at) >= datetime(?)
            AND NOT EXISTS (SELECT 1 FROM root_olaylar o WHERE o.tur = 'paket_alindi' AND o.ref = p.odeme_id)
          ORDER BY p.created_at ASC LIMIT 50`, [b]);
    for (const p of r.rows) {
        const ad = p.business_name || p.isletme_adi || 'İşletme';
        const tutar = p.tutar_kurus != null ? (Number(p.tutar_kurus) / 100).toLocaleString('tr-TR') + ' TL' : '-';
        const bitis = trTarih(p.donem_bitis);
        if (!await olayYaz('paket_alindi', p.odeme_id, p.tenant_id, ad, 'SofraMix · POS paketi alındı' + (bitis ? ', lisans ' + bitis + ' tarihine uzadı' : ''))) continue;
        rootaBildir('SofraMix\'ten POS paketi alındı: ' + ad, [
            ['İşletme', ad],
            ['Tutar', tutar],
            ['Lisans bitişi', bitis || '-'],
            ['Not', 'Var olan hesabın lisansı uzatıldı (deneme tam sürüme geçti ya da yenileme).'],
        ], { dugme: 'Root paneli > İşletmeler' }).catch(() => {});
    }
}

// Tek tarama; ayni anda ikinci cagri ayni isi bekler (telefon sorgusu + zamanlayici cakisinca)
function tara() {
    if (suren) return suren;
    suren = (async () => {
        const b = await baslangic();
        await yeniKiracilar(b);
        await sofraMixPaketleri(b);
    })().finally(() => { suren = null; });
    return suren;
}

// Yonetim APK'sinin sorusu: istemcinin bildigi son olay id'si verilirse ondan sonraki olay sayisi
// ve en yenisinin ozeti doner. Istemci id vermezse (ilk kurulum) yalniz son id doner: telefon bunu
// baslangic noktasi yapar, eski olaylar icin bildirim cikmaz.
async function telefonOzeti(istemciSonId) {
    await tara().catch((e) => console.error('[olay] tarama:', e.message));
    const sonId = Number((await query('SELECT MAX(id) AS m FROM root_olaylar')).rows[0].m) || 0;
    const n = Number(istemciSonId);
    const verildi = istemciSonId !== undefined && istemciSonId !== null && istemciSonId !== '' && Number.isFinite(n) && n >= 0;
    if (!verildi || sonId <= n) return { sonId, yeni: 0, son: null };
    const yeni = Number((await query('SELECT COUNT(*) AS c FROM root_olaylar WHERE id > ?', [n])).rows[0].c) || 0;
    const s = (await query('SELECT id, tur, baslik, detay, created_at FROM root_olaylar ORDER BY id DESC LIMIT 1')).rows[0];
    return { sonId, yeni, son: s ? { id: s.id, tur: s.tur, isletme: s.baslik, aciklama: s.detay, zaman: s.created_at } : null };
}

function baslat() {
    const calis = () => tara().catch((e) => console.error('[olay] tarama:', e.message));
    setTimeout(calis, 9000);
    setInterval(calis, ARALIK_MS);
}

module.exports = { tara, telefonOzeti, baslat, etiketle };
