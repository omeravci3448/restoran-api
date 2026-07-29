const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../../config/db');

// ——— Pazaryeri kimlik bilgileri: şifreli saklama ———
// Anahtarlar kiracıya ait (her restoran kendi Trendyol/Yemeksepeti anahtarını girer),
// bu yüzden .env'de değil DB'de tutulur — ama ASLA düz metin değil.
// AES-256-GCM + kayıt başına rastgele IV. KEK ortam değişkeninden gelir (Coolify secret).
//
// ⚠️ Yedek alınırken KEK yedeğe DAHİL EDİLMEZ; ayrı saklanır. Böylece yedek dosyası
// çalınsa bile pazaryeri anahtarları okunamaz.

const ALGO = 'aes-256-gcm';
const KEY_VERSION = 1;

function getKek() {
    const raw = process.env.MARKETPLACE_KEK;
    if (!raw) {
        throw new Error(
            'MARKETPLACE_KEK tanımlı değil. 32 baytlık bir anahtar üretip ortam değişkeni olarak ekleyin:\n' +
            '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
        );
    }
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) throw new Error('MARKETPLACE_KEK 32 bayt (base64) olmalı.');
    return buf;
}

function encryptJson(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv(ALGO, getKek(), iv);
    const blob = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return { cipher: blob.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

function decryptJson({ cipher, iv, tag }) {
    const d = crypto.createDecipheriv(ALGO, getKek(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    const out = Buffer.concat([d.update(Buffer.from(cipher, 'base64')), d.final()]);
    return JSON.parse(out.toString('utf8'));
}

// Arayüzde/loglarda anahtarın kendisi yerine bu gösterilir
const fingerprint = (secret) => 'AK-••••' + crypto.createHash('sha256').update(String(secret || '')).digest('hex').slice(0, 4);

// Kaydet/güncelle. `fields` adaptörün requiredCredentialFields'ına göre gelir.
async function saveCredentials({ tenantId, channelId, scope = 'supplier', scopeRef = null, env = 'prod', fields }) {
    const enc = encryptJson(fields);
    const fp = fingerprint(fields.apiKey || fields.clientId || fields.appSecretKey || '');
    const existing = await query(
        `SELECT id FROM marketplace_credentials
          WHERE tenant_id = ? AND channel_id = ? AND scope = ? AND COALESCE(scope_ref,'') = COALESCE(?,'') AND env = ?`,
        [tenantId, channelId, scope, scopeRef, env]);

    if (existing.rows.length) {
        await query(
            `UPDATE marketplace_credentials
                SET cipher_blob = ?, iv = ?, auth_tag = ?, key_version = ?, fingerprint = ?,
                    status = 'active', updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
            [enc.cipher, enc.iv, enc.tag, KEY_VERSION, fp, existing.rows[0].id]);
        return { id: existing.rows[0].id, fingerprint: fp, updated: true };
    }
    const id = uuidv4();
    await query(
        `INSERT INTO marketplace_credentials
            (id, tenant_id, channel_id, scope, scope_ref, cipher_blob, iv, auth_tag, key_version, fingerprint, env)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, tenantId, channelId, scope, scopeRef, enc.cipher, enc.iv, enc.tag, KEY_VERSION, fp, env]);
    return { id, fingerprint: fp, updated: false };
}

// Çözülmüş kimlik YALNIZCA callback süresince bellekte kalır; global cache'e konmaz.
async function withCredentials(tenantId, channelId, fn, { env = 'prod' } = {}) {
    const r = await query(
        `SELECT * FROM marketplace_credentials
          WHERE tenant_id = ? AND channel_id = ? AND env = ? AND status = 'active' LIMIT 1`,
        [tenantId, channelId, env]);
    if (!r.rows.length) throw new Error('Bu kanal için kayıtlı kimlik bilgisi yok.');
    const row = r.rows[0];
    const creds = decryptJson({ cipher: row.cipher_blob, iv: row.iv, tag: row.auth_tag });
    try {
        return await fn(creds, row);
    } finally {
        // referansı temizle (GC'ye yardım; sızıntı yüzeyini küçültür)
        for (const k of Object.keys(creds)) delete creds[k];
    }
}

// Arayüze dönerken ASLA ham değer gönderilmez
async function listCredentialsMasked(tenantId) {
    const r = await query(
        `SELECT id, channel_id, scope, scope_ref, fingerprint, env, status, last_verified_at, created_at
           FROM marketplace_credentials WHERE tenant_id = ?`, [tenantId]);
    return r.rows;
}

async function markInvalid(id) {
    await query("UPDATE marketplace_credentials SET status = 'invalid', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
}
async function markVerified(id) {
    await query("UPDATE marketplace_credentials SET last_verified_at = CURRENT_TIMESTAMP, status = 'active' WHERE id = ?", [id]);
}

// Log/hata mesajlarında gizlenecek alanlar.
// Liste KÜÇÜK HARF tutulur; karşılaştırma da küçük harfle yapılır — aksi halde
// 'apiSecret' gibi camelCase anahtarlar maskelenmeden loglara sızar.
const REDACT_KEYS = ['apisecret', 'apikey', 'clientsecret', 'password', 'secret', 'token',
    'authorization', 'appsecretkey', 'restaurantsecretkey', 'cipher_blob'];
function redact(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
        out[k] = REDACT_KEYS.includes(k.toLowerCase()) ? '••••' : (v && typeof v === 'object' ? redact(v) : v);
    }
    return out;
}

module.exports = {
    saveCredentials, withCredentials, listCredentialsMasked,
    markInvalid, markVerified, fingerprint, redact,
    encryptJson, decryptJson, REDACT_KEYS,
};
