const { query, tx } = require('../config/db');
const gunluk = require('./islemGunlugu');
const paket = require('./paketServis');
const { AKSIYONLAR } = require('../marketplace/paketEsleme');

// --- Pazaryeri siparisine KASADAN durum yazma (ortak) ---
//
// Provada ortaya cikti: adaptor SofraMix'e "hazirlaniyor/yolda/teslim" yazabiliyor,
// SofraMix kabul ediyor, ama POS'ta bunu tetikleyen NE bir uc NE bir dugme vardi.
// Bu servisi iki uc kullanir:
//   - POST /api/marketplace/orders/:id/aksiyon  (Pazaryeri ekrani, MARKETPLACE modulu ister)
//   - POST /api/paket/:id/aksiyon + /iptal       (Paket Servis ekrani, temel paket)
//
// Kural: POS kendi kafasina gore durum ilerletmez. Ne yazilacagi adaptorun yetenegine,
// gecis kurali PLATFORMA birakilir (SofraMix yanlis gecise 400 doner, mesaji aynen gosteririz).
// Paket ekrani ayrica `izinliMi` verir: dugmeler esleme satirinin gecis matrisinden cizildigi icin sunucu
// da ayni listeyle denetler (bayat ekrandan ya da cift tiklamayla gelen istek platforma gitmez).
// Islem tablosu (adaptor metodu + yetenek + hedef normalize durum): marketplace/paketEsleme.js AKSIYONLAR.

class AksiyonHatasi extends Error {
    constructor(status, message, ek) {
        super(message);
        this.status = status;
        if (ek) Object.assign(this, ek);
    }
}

// Adaptor/platform hatasini kasiyerin anlayacagi Turkce mesaja cevirir.
// Platformun kendi mesaji (SofraMix: { error: '...' }) varsa AYNEN gosterilir: kasiyerin neden
// olmadigini bilmesi "program bozuk" demesinden iyidir.
function platformHatasi(e) {
    if (e instanceof AksiyonHatasi) return e;
    const raw = e && e.raw;
    const platformMesaji = raw && typeof raw === 'object' ? (raw.error || raw.hata || raw.message) : null;
    const http = e && e.httpStatus;
    if (http === 401 || http === 403 || (e && e.kind === 'AUTH')) {
        return new AksiyonHatasi(409, 'Platform bu işlem için izin vermedi: bağlantı anahtarı geçersiz ya da sipariş yazma izni yok. '
            + 'Ayarlar > Pazaryeri Kanalları\'ndan kanalı yeniden bağlayın.' + (platformMesaji ? ' (' + platformMesaji + ')' : ''), { yetkiSorunu: true });
    }
    if (platformMesaji) return new AksiyonHatasi(409, 'Platform kabul etmedi: ' + platformMesaji, { yetkiSorunu: false });
    const agHatasi = e && e.name === 'TypeError' && /fetch failed|network|ECONNREFUSED|ENOTFOUND/i.test(String(e.message) + String(e.cause && e.cause.code));
    if (http >= 500 || (e && e.kind === 'TRANSIENT') || agHatasi) {
        return new AksiyonHatasi(502, 'Platforma ulaşılamadı. İnternet bağlantısını kontrol edip biraz sonra tekrar deneyin.', { yetkiSorunu: false });
    }
    // Adaptorun kendi on denetimi (ornek: "Bu asamada iptal edilemez") ya da kimlik kaydi yok
    return new AksiyonHatasi(409, String((e && e.message) || 'Platform kabul etmedi.'), { yetkiSorunu: false });
}

// { tenantId, orderId, aksiyon, sebep, user, izinliMi? } -> { ok, durum, otoOdeme }
async function uygula({ tenantId, orderId, aksiyon: kod, sebep: hamSebep, user, izinliMi }) {
    const { getAdapter } = require('../marketplace/registry');
    const { withCredentials } = require('../marketplace/core/credentialStore');
    const aksiyon = AKSIYONLAR[String(kod || '')];
    if (!aksiyon) throw new AksiyonHatasi(400, 'Geçersiz işlem.');
    const sebep = String(hamSebep || '').trim();
    if (aksiyon.sebepGerekli && sebep.length < 10) {
        throw new AksiyonHatasi(400, 'Sebep yazın (en az 10 karakter) - müşteri ve platform bunu görecek.');
    }

    const o = (await query(
        `SELECT id, tenant_id, channel, external_ref, external_order_no, channel_status_raw, delivery_mode, status, total,
                paket_no, teslim_sorunu_at
           FROM orders WHERE id = ? AND tenant_id = ?`,
        [orderId, tenantId])).rows[0];
    if (!o) throw new AksiyonHatasi(404, 'Sipariş bulunamadı.');
    if (!o.external_ref) throw new AksiyonHatasi(400, 'Bu sipariş elle girilmiş; platformda karşılığı yok.');
    if (izinliMi && !izinliMi(o, kod)) {
        const asama = paket.asamaOf(o);
        throw new AksiyonHatasi(409, `Bu sipariş şu an "${paket.ASAMA_ETIKET[asama] || asama}" aşamasında; `
            + `"${paket.AKSIYON_ETIKET[kod] || kod}" yapılamaz. Ekranı yenileyin.`);
    }

    // Kanal: siparisin channel'i = adaptor kodu (ingest boyle yaziyor).
    const ch = (await query(
        `SELECT c.id, c.adapter_code, l.external_store_id
           FROM marketplace_channels c
           JOIN marketplace_store_links l ON l.channel_id = c.id AND l.is_active = 1
          WHERE c.tenant_id = ? AND c.adapter_code = ? AND c.is_active = 1 LIMIT 1`,
        [tenantId, o.channel])).rows[0];
    if (!ch) throw new AksiyonHatasi(400, 'Bu kanal bağlı değil. Ayarlar > Pazaryeri Kanalları > Bağla.');

    let adaptor;
    try { adaptor = getAdapter(ch.adapter_code); } catch (_) { throw new AksiyonHatasi(400, 'Adaptör yok.'); }
    if (!adaptor.capabilities[aksiyon.yetenek] || typeof adaptor[aksiyon.metod] !== 'function') {
        throw new AksiyonHatasi(400, 'Bu kanal bu işlemi desteklemiyor.');
    }

    try {
        await withCredentials(tenantId, ch.id, async (creds) => {
            const ctx = { tenantId, credentials: creds,
                storeLink: { externalStoreId: ch.external_store_id, id: null }, env: 'prod',
                http: (u, opts) => fetch(u, opts) };
            await adaptor[aksiyon.metod](ctx, {
                externalOrderId: o.external_ref, platformStatus: o.channel_status_raw,
                reason: sebep || undefined, note: sebep || undefined,
            });
        });
    } catch (e) {
        throw platformHatasi(e);
    }

    // Yerel gorunumu hemen guncelle; bir sonraki cekme turu zaten platformdan
    // dogrulayacak (updated_at tetikleyicisi sayesinde degisiklik geri okunur).
    // Yeni ham durum platformun kendi sozlugunden (esleme satiri); satiri olmayan kanalda eski davranis.
    const ham = aksiyon.normal ? (paket.hedefHam(o, kod) || aksiyon.ham) : null;
    let otoOdeme = 0;
    await tx(async () => {
        if (!ham) {   // teslim_edilemedi: platformda durum degismez, yerelde damga
            await query('UPDATE orders SET teslim_sorunu_at = COALESCE(teslim_sorunu_at, CURRENT_TIMESTAMP) WHERE id = ?', [o.id]);
            return;
        }
        // Kapanis / iptal / zaman damgalari islem koduna gore (platformdan bagimsiz)
        await query(
            `UPDATE orders SET channel_status_raw = ?,
                    status = CASE WHEN ? = 'teslim' THEN 'CLOSED' WHEN ? = 'iptal' THEN 'CANCELLED' ELSE status END,
                    closed_at = CASE WHEN ? IN ('teslim', 'iptal') THEN COALESCE(closed_at, CURRENT_TIMESTAMP) ELSE closed_at END,
                    cancelled_by = CASE WHEN ? = 'iptal' THEN ? ELSE cancelled_by END,
                    yola_cikti_at = CASE WHEN ? = 'yolda' THEN COALESCE(yola_cikti_at, CURRENT_TIMESTAMP) ELSE yola_cikti_at END,
                    hazir_at = CASE WHEN ? = 'hazir' THEN COALESCE(hazir_at, CURRENT_TIMESTAMP) ELSE hazir_at END,
                    teslim_at = CASE WHEN ? = 'teslim' THEN COALESCE(teslim_at, CURRENT_TIMESTAMP) ELSE teslim_at END
              WHERE id = ?`,
            [ham, kod, kod, kod, kod, (user && user.id) || null, kod, kod, kod, o.id]);
        if (kod === 'yolda' || kod === 'teslim') await paket.mutfakKalemleriniKapat(o.id);
        // Teslim: odeme kaydi yoksa / eksikse platformun odeme yontemiyle tamamla (gun sonu dagilimi tutsun)
        if (kod === 'teslim') otoOdeme = await paket.otoOdemeYazIc(o.id);
    });

    if (kod === 'iptal' || kod === 'teslim_edilemedi') {
        await gunluk.kaydet({
            tenantId, user, islem: kod === 'iptal' ? 'siparis_iptal' : 'teslim_edilemedi', hedefTur: 'order', hedefId: o.id,
            detay: `${paket.paketEtiketi(o)} - ${paket.TL(o.total)} - platforma iletildi: ${sebep}`,
        });
    }
    return { ok: true, durum: ham || 'teslim_edilemedi', otoOdeme };
}

module.exports = { AKSIYONLAR, AksiyonHatasi, platformHatasi, uygula };
