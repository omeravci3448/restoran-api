const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const { getAdapter } = require('../marketplace/registry');
const cred = require('../marketplace/core/credentialStore');
const { menuCek } = require('./menuAktarim');

// ——— SofraMix kanalini isletme adina OTOMATIK bagla + menuyu cek ———
// Deneme devri ve odemeli provizyon sonrasi cagrilir. Isletme sahibi anahtar uretmez,
// kopyalamaz, yapistirmaz: POS platform anahtariyla SofraMix'ten sunucudan sunucuya
// bir makine anahtari ister (POST /api/platform/pos-makine-anahtari), dogrular, sifreli
// saklar (MARKETPLACE_KEK), magaza bagini kurar ve menuyu hemen ceker.
//
// HER ADIM best-effort: platform ucu yoksa / 403 / ag hatasi -> kiraci yine acilir,
// yalnizca log duser ve isletme eski elle yolu (Ayarlar > Pazaryeri Kanallari) kullanir.
// Anahtar hicbir zaman loglanmaz, URL'ye yazilmaz.

const URL_TABAN = (process.env.SOFRAMIX_PLATFORM_URL || '').trim().replace(/[/]+$/, '');
const ANAHTAR = process.env.SOFRAMIX_PLATFORM_ANAHTAR || '';
const ISTEK_ZAMAN_ASIMI_MS = 15000;

function acikMi() { return !!(URL_TABAN && ANAHTAR && process.env.MARKETPLACE_KEK); }

async function anahtarIste(isletmeNo) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ISTEK_ZAMAN_ASIMI_MS);
    try {
        const no = /^[0-9]+$/.test(String(isletmeNo)) ? Number(isletmeNo) : String(isletmeNo);
        const r = await fetch(URL_TABAN + '/api/platform/pos-makine-anahtari', {
            method: 'POST', signal: ac.signal,
            headers: { 'X-Smx-Platform-Anahtar': ANAHTAR, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ isletme_no: no }),
        });
        const metin = await r.text().catch(() => '');
        let d = null;
        try { d = metin ? JSON.parse(metin) : null; } catch (_) { d = null; }
        if (!r.ok) {
            const ayrinti = d && (d.hata || d.error || d.message);
            const e = new Error('SofraMix anahtar ucu ' + r.status + (ayrinti ? ' - ' + ayrinti : ''));
            e.kod = r.status; throw e;
        }
        if (!d || !d.anahtar) throw new Error('SofraMix anahtar dondurmedi');
        return String(d.anahtar);
    } finally { clearTimeout(t); }
}

async function kanalBul(tenantId) {
    const r = await query(
        "SELECT * FROM marketplace_channels WHERE tenant_id = ? AND adapter_code = 'soframix' ORDER BY created_at LIMIT 1", [tenantId]);
    if (r.rows[0]) return r.rows[0];
    const id = uuidv4();
    await query(
        'INSERT INTO marketplace_channels (id, tenant_id, name, adapter_code, commission_rate, fixed_fee, is_active) VALUES (?, ?, ?, ?, 0, 0, 1)',
        [id, tenantId, 'SofraMix', 'soframix']);
    return (await query('SELECT * FROM marketplace_channels WHERE id = ?', [id])).rows[0];
}

// Donus: { durum: 'baglandi' | 'zaten_bagli' | 'atlandi' | 'hata', kanalId?, menu?, neden? }
// Kiraci basina SIRA: iki devir ayni anda gelirse (cift tiklama, iki sekme) ikinci istek
// birincinin bitmesini bekler; yoksa kanalBul iki SofraMix kanali acabilirdi.
const sirada = new Map();
function otoBagla(args) {
    const k = String(args && args.tenantId);
    const onceki = sirada.get(k) || Promise.resolve();
    const p = onceki.then(() => _otoBagla(args));
    const kuyruk = p.catch(() => {}).then(() => { if (sirada.get(k) === kuyruk) sirada.delete(k); });
    sirada.set(k, kuyruk);
    return p;
}

async function _otoBagla({ tenantId, isletmeNo, sebep }) {
    const etiket = '[oto-baglanti] ' + (sebep || '') + ' kiraci=' + tenantId + ' isletme_no=' + isletmeNo;
    if (!tenantId || isletmeNo == null || isletmeNo === '') return { durum: 'atlandi', neden: 'eksik_parametre' };
    if (!URL_TABAN || !ANAHTAR) { console.warn(etiket + ' atlandi: SOFRAMIX_PLATFORM_URL/ANAHTAR tanimli degil'); return { durum: 'atlandi', neden: 'platform_yok' }; }
    if (!process.env.MARKETPLACE_KEK) { console.warn(etiket + ' atlandi: MARKETPLACE_KEK tanimli degil'); return { durum: 'atlandi', neden: 'kek_yok' }; }
    try {
        const kanal = await kanalBul(tenantId);
        const adaptor = getAdapter('soframix');
        const bag = (await query(
            `SELECT l.*, c.status AS kimlik_durum
               FROM marketplace_store_links l
               LEFT JOIN marketplace_credentials c ON c.id = l.credential_id
              WHERE l.tenant_id = ? AND l.channel_id = ? AND l.is_active = 1`, [tenantId, kanal.id])).rows[0];
        let durum = 'zaten_bagli';
        if (!bag || !bag.credential_id || bag.kimlik_durum !== 'active') {
            const apiKey = await anahtarIste(isletmeNo);
            const ctx = { tenantId, credentials: { apiKey }, storeLink: { externalStoreId: String(isletmeNo) }, env: 'prod',
                          http: (u, o) => fetch(u, { ...(o || {}), signal: AbortSignal.timeout(20000) }) };
            await adaptor.validateCredentials(ctx);   // calismayan anahtari kaydetmeyelim
            const kayit = await cred.saveCredentials({ tenantId, channelId: kanal.id, scope: 'store', scopeRef: String(isletmeNo), fields: { apiKey } });
            if (bag) {
                await query('UPDATE marketplace_store_links SET credential_id = ?, external_store_id = ?, is_active = 1 WHERE id = ?',
                    [kayit.id, String(isletmeNo), bag.id]);
            } else {
                await query(
                    `INSERT INTO marketplace_store_links (id, tenant_id, channel_id, external_store_id, credential_id, is_active)
                     VALUES (?, ?, ?, ?, ?, 1)`, [uuidv4(), tenantId, kanal.id, String(isletmeNo), kayit.id]);
            }
            await cred.markVerified(kayit.id);
            durum = 'baglandi';
        }
        // Kosulun DISINDA ve idempotent: onceki kosu tam bu satirdan once kesildiyse (redeploy,
        // DB zaman asimi) "bag var ama API kapali" yarim kaydi burada onarilir; Menu.jsx dugmeyi
        // is_api_enabled'a bakarak cizdigi icin bu satir kalici gorunmezligi onler.
        await query('UPDATE marketplace_channels SET is_api_enabled = 1, capabilities_json = ? WHERE id = ?',
            [JSON.stringify(adaptor.capabilities), kanal.id]);
        // Menu: hic eslenmis urun yoksa cek. Varsa bos yere SofraMix'e gitme.
        const esli = (await query(
            "SELECT COUNT(*) AS n FROM marketplace_product_map WHERE tenant_id = ? AND channel_id = ? AND kind = 'product'",
            [tenantId, kanal.id])).rows[0].n;
        let menu = null;
        if (!esli) {
            const m = await menuCek({ tenantId, kanalId: kanal.id, uygula: true });
            menu = m.kod === 200 ? { kategori: m.govde.kategoriEklendi, urun: m.govde.urunEklendi }
                                 : { hata: (m.govde && m.govde.message) || ('kod ' + m.kod) };
        }
        console.log(etiket + ' ' + durum + ' menu=' + (menu ? JSON.stringify(menu) : 'zaten_var'));
        return { durum, kanalId: kanal.id, menu };
    } catch (e) {
        console.error(etiket + ' HATA: ' + (e && e.message ? e.message : e));
        return { durum: 'hata', neden: (e && e.message) || String(e) };
    }
}

// ——— Saatlik ONARIM turu (odemeli kiraci icin "bir sonraki devir" yok) ———
// Provizyon aninda baglanti kurulamadiysa (429, ag, SofraMix bakimda) yalniz HIC baglanmamis
// ve son 7 gunde odenmis/acilmis kiracilar yeniden denenir. Isletmenin IPTAL ettigi kiraci
// (bagi var, kimligi invalid) denenmez: SofraMix 403 verir, izin ancak devirle yenilenir.
// Sinir: tur basina 20 kiraci; isletme basina SofraMix siniri 6/saat, biz saatte 1 deniyoruz.
async function onarimTuru() {
    if (!acikMi()) return { atlandi: true };
    const r = await query(`
        SELECT t.id AS tenant_id, COALESCE(p.soframix_business_id, d.soframix_business_id) AS isletme_no
          FROM tenants t
          LEFT JOIN pos_provizyon p ON p.tenant_id = t.id AND p.durum = 'islendi'
               AND COALESCE(p.onay_tarihi, p.created_at) >= datetime('now', '-7 day')
          LEFT JOIN deneme_kayitlari d ON d.tenant_id = t.id AND d.created_at >= datetime('now', '-7 day')
         WHERE t.is_active = 1 AND t.parent_org = 'SofraMix'
           AND COALESCE(p.soframix_business_id, d.soframix_business_id) IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM marketplace_store_links l
                             JOIN marketplace_channels c ON c.id = l.channel_id
                            WHERE l.tenant_id = t.id AND c.adapter_code = 'soframix'
                              AND l.is_active = 1 AND l.credential_id IS NOT NULL)
         GROUP BY t.id LIMIT 20`);
    const ozet = { aday: r.rows.length, baglandi: 0, hata: 0 };
    for (const k of r.rows) {
        const s = await otoBagla({ tenantId: k.tenant_id, isletmeNo: k.isletme_no, sebep: 'onarim' });
        if (s.durum === 'baglandi' || s.durum === 'zaten_bagli') ozet.baglandi++; else ozet.hata++;
    }
    if (ozet.aday) console.log('[oto-baglanti] onarim turu: ' + JSON.stringify(ozet));
    return ozet;
}

module.exports = { otoBagla, onarimTuru, acikMi };
