const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const { getAdapter } = require('../marketplace/registry');
const { withCredentials } = require('../marketplace/core/credentialStore');
const { ingestBatch } = require('../marketplace/core/ingest');

// ——— Pazaryeri siparislerini CEKME dongusu ———
//
// Adaptorlerin fetchOrders/normalizeOrder'i yazilmisti ama URETIMDE HIC
// CAGRILMIYORDU: ne tarama dongusu ne webhook vardi. Yani SofraMix siparisleri
// POS'a otomatik hic dusmuyor, kasiyer elle giriyordu.
//
// NEDEN CEKME: webhook icin POS'un disariya kimlik dogrulamali bir uc acmasi
// ve platformun tekrar-deneme davranisina uyulmasi gerekir. Cekmede POS
// kapaliyken olay KAYBOLMAZ - acilinca imlecin kaldigi yerden devam eder.

const ARALIK_SN = Number(process.env.SIPARIS_CEKME_ARALIK_SN || 60);
// Ust uste bu kadar hatadan sonra o kanal icin bekleme suresi uzuyor: calismayan
// bir anahtar yuzunden dakikada bir bos istek atip karsi tarafi yormayalim.
const GERI_CEKILME_ESIK = 3;
const GERI_CEKILME_KAT = 10;

function imlecAnahtari(tenantId, channelId, storeLinkId) {
    return { tenantId, channelId, storeLinkId: storeLinkId || null, resource: 'orders' };
}

async function imlecOku(k) {
    const r = await query(
        `SELECT * FROM marketplace_sync_state
          WHERE tenant_id = ? AND channel_id = ? AND resource = 'orders'
            AND (store_link_id IS ? OR store_link_id = ?) LIMIT 1`,
        [k.tenantId, k.channelId, k.storeLinkId, k.storeLinkId]);
    return r.rows[0] || null;
}

async function imlecYaz(k, { cursor, hata }) {
    const mevcut = await imlecOku(k);
    const simdi = new Date().toISOString();
    if (mevcut) {
        await query(
            `UPDATE marketplace_sync_state
                SET cursor = COALESCE(?, cursor), last_run_at = ?,
                    last_ok_at = CASE WHEN ? IS NULL THEN ? ELSE last_ok_at END,
                    consecutive_errors = CASE WHEN ? IS NULL THEN 0 ELSE consecutive_errors + 1 END
              WHERE id = ?`,
            [cursor || null, simdi, hata, simdi, hata, mevcut.id]);
        return;
    }
    await query(
        `INSERT INTO marketplace_sync_state
            (id, tenant_id, channel_id, store_link_id, resource, cursor, last_run_at, last_ok_at, consecutive_errors)
         VALUES (?, ?, ?, ?, 'orders', ?, ?, ?, ?)`,
        [uuidv4(), k.tenantId, k.channelId, k.storeLinkId, cursor || null, simdi,
            hata ? null : simdi, hata ? 1 : 0]);
}

// Hangi kanallar taranacak? Adaptore BAGLI, kimlik bilgisi KAYITLI ve magaza
// baglantisi AKTIF olanlar. Bu uc sartin biri eksikse kanal zaten calismaz.
async function taranacaklar() {
    const r = await query(
        `SELECT c.id AS channel_id, c.tenant_id, c.adapter_code, c.name,
                l.id AS store_link_id, l.external_store_id
           FROM marketplace_channels c
           JOIN marketplace_store_links l ON l.channel_id = c.id AND l.is_active = 1
          WHERE c.is_active = 1 AND c.adapter_code IS NOT NULL AND c.adapter_code <> ''
            AND EXISTS (SELECT 1 FROM marketplace_credentials k
                         WHERE k.channel_id = c.id AND k.status = 'active')`);
    return r.rows;
}

// Tek kanal icin bir tur.
async function kanalTuru(k) {
    const anahtar = imlecAnahtari(k.tenant_id, k.channel_id, k.store_link_id);
    const durum = await imlecOku(anahtar);

    // Geri cekilme: ust uste hata alan kanali her turda yeniden denemiyoruz.
    const hataSayisi = (durum && durum.consecutive_errors) || 0;
    if (hataSayisi >= GERI_CEKILME_ESIK && durum && durum.last_run_at) {
        const beklenen = Math.min(hataSayisi, 30) * GERI_CEKILME_KAT * ARALIK_SN * 1000;
        if (Date.now() - new Date(durum.last_run_at).getTime() < beklenen) {
            return { atlandi: 'geri_cekilme', hataSayisi };
        }
    }

    let adaptor;
    try { adaptor = getAdapter(k.adapter_code); }
    catch (_) { return { atlandi: 'adaptor_yok' }; }
    if (typeof adaptor.fetchOrders !== 'function') return { atlandi: 'cekme_yok' };
    // Adaptor siparis okumayi BEYAN ETMIYORSA cagirmiyoruz: beyan edilmeyeni
    // cagirmak, calismayan bir yolu her dakika denemek demek.
    if (adaptor.capabilities && adaptor.capabilities.ingress === 'webhook') return { atlandi: 'webhook' };

    return withCredentials(k.tenant_id, k.channel_id, async (creds) => {
        const ctx = {
            tenantId: k.tenant_id,
            credentials: creds,
            storeLink: { externalStoreId: k.external_store_id, id: k.store_link_id },
            env: 'prod',
            http: (u, o) => fetch(u, o),
        };
        try {
            const r = await adaptor.fetchOrders(ctx, { cursor: durum && durum.cursor });
            const olaylar = (r && r.events) || [];
            const sonuc = olaylar.length
                ? await ingestBatch({ adapter: adaptor, ctx, channelId: k.channel_id,
                    channelCode: k.adapter_code, events: olaylar, source: 'poll' })
                : { created: 0, updated: 0, duplicates: 0, failed: 0 };
            await imlecYaz(anahtar, { cursor: (r && r.nextCursor) || null, hata: null });
            return { ...sonuc, gelen: olaylar.length };
        } catch (e) {
            // ANAHTAR YETKISI: isletme "sadece menumu okusun" secmisse siparis
            // ucu 403 doner. Bu kendiliginden duzelmez; kanalin durumuna
            // yaziyoruz ki arayuzde "yeni anahtar uretin" diyebilelim.
            const yetkiSorunu = e && (e.kind === 'AUTH' || /40[13]/.test(String(e.httpStatus || '')));
            await imlecYaz(anahtar, { cursor: null, hata: String(e.message).slice(0, 300) });
            return { hata: e.message, yetkiSorunu: Boolean(yetkiSorunu) };
        }
    }).catch((e) => ({ hata: e.message }));
}

async function birTur() {
    const liste = await taranacaklar();
    const ozet = { kanal: liste.length, gelen: 0, yeni: 0, guncel: 0, mukerrer: 0, hata: 0, yetkiSorunu: 0 };
    for (const k of liste) {
        const r = await kanalTuru(k);
        if (!r || r.atlandi) continue;
        if (r.hata) { ozet.hata++; if (r.yetkiSorunu) ozet.yetkiSorunu++; continue; }
        ozet.gelen += r.gelen || 0;
        ozet.yeni += r.created || 0;
        ozet.guncel += r.updated || 0;
        ozet.mukerrer += r.duplicates || 0;
    }
    return ozet;
}

let calisiyor = false;
let zamanlayici = null;

async function tikla() {
    if (calisiyor) return;
    calisiyor = true;
    try {
        const o = await birTur();
        if (o.gelen || o.hata) console.log('[siparis-cekme]', JSON.stringify(o));
    } catch (e) {
        console.error('[siparis-cekme] tur hatasi:', e.message);
    } finally { calisiyor = false; }
}

function baslat() {
    if (zamanlayici) return zamanlayici;
    zamanlayici = setInterval(tikla, ARALIK_SN * 1000);
    if (zamanlayici.unref) zamanlayici.unref();
    setTimeout(tikla, 20000).unref?.();
    console.log(`[siparis-cekme] acik - her ${ARALIK_SN} sn'de bir bagli kanallar taranacak`);
    return zamanlayici;
}

function durdur() { if (zamanlayici) { clearInterval(zamanlayici); zamanlayici = null; } }

module.exports = { baslat, durdur, birTur, tikla, kanalTuru, taranacaklar, imlecOku };
