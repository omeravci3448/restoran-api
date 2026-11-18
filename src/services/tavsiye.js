const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');
const { tavsiyeKoduUret } = require('../config/tavsiyeDb');

// --- Tavsiye sistemi: "Tavsiye et, süre kazan" (Patron karari 2026-11-18) ---
// Her isletmenin bir tavsiye KODU ve BAGLANTISI var: {POS_PANEL_URL}/tanitim?ref=KOD (ya da /register?ref=KOD).
// Baglantiyla gelen kisinin formunda kod kendiliginden dolar; kod elle de yazilabilir.
//
// Odul: tavsiye edilen isletmenin ILK odemesi onaylaninca (root havale onayi) ya da ilk SofraMix odemesi islenince
//   - tavsiye edilen: +30 gun (ilk paket 12 yerine 13 ay): o onayin yeni bitisinin uzerine
//   - tavsiye eden : +60 gun: mevcut bitisin uzerine (bittiyse simdiden). Tavsiye eden odeme yapan bir isletme
//     olmali (en az bir onayli havale ya da islenmis SofraMix odemesi); degilse odul BEKLER ve tavsiye edenin kendi
//     ilk odemesi onaylaninca uygulanir.
// Tavsiye edilen basina BIR kez (tavsiyeler.tavsiye_edilen_id UNIQUE + edilen_odul_at / eden_odul_at kilidi);
// tavsiye sayisina tavan yok.
// Kendi kendini tavsiye yok: telefon, e-posta ya da vergi no eslesirse ya da iki isletme ayni sube grubundaysa tavsiye
// IPTAL olur; kullaniciya tarafsiz bir metin gosterilir (hangi bilginin eslestigi soylenmez). Kayitta ve odul aninda
// iki kez denetlenir (vergi no ve sube grubu sonradan eklenebilir).
// Odul hatasi onayi ya da SofraMix islemesini DURDURMAZ (cagiranlar .catch ile cagirir); root "Ödülü uygula" ile
// yeniden dener.

const EDILEN_GUN = 30;
const EDEN_GUN = 60;
const REF_SAKLAMA_GUN = 30;   // web: ?ref= degeri tarayicida 30 gun saklanir (pos-admin lib/tavsiyeRef.js)
const KURAL_METNI = 'Tavsiye ettiğiniz işletme ilk paketini aldığında size 2 ay ek süre, ona 13 ay lisans.';
const KAYIT_METNI = 'Sizi tavsiye eden işletmenin kodunu yazın; ilk paketiniz 12 yerine 13 ay tanımlanır.';
const KOD_BULUNAMADI = 'Bu tavsiye kodu bulunamadı. Kodu kontrol edin ya da alanı boş bırakın.';
const UYGULANAMADI = 'Tavsiye kodu bu kayıt için kullanılamadı; kaydınız normal şekilde açıldı.';
const EDILEN_METNI = 'Tavsiye koduyla geldiğiniz için ilk paketiniz 13 ay tanımlandı.';

const DURUM_AD = {
    kayit: 'Kayıt oldu',
    odeme_bekliyor: 'Ödeme onayı bekleniyor',
    odul_bekliyor: 'Ödül bekliyor',
    odul_verildi: 'Ödül verildi',
    iptal: 'İptal',
};

const hata = (status, message, code) => Object.assign(new Error(message), { status, code });
const tarihTR = (iso) => (iso ? new Date(iso).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric' }) : '-');
const edenMetni = (isletme, bitis) => `Tavsiye ettiğiniz ${isletme || 'işletme'} paket aldı; lisansınıza 2 ay eklendi. Yeni bitiş: ${tarihTR(bitis)}.`;
const panelAdresi = () => (process.env.POS_PANEL_URL || 'https://restoran.mdayazilim.com').replace(/\/+$/, '');
const baglanti = (kod) => `${panelAdresi()}/tanitim?ref=${encodeURIComponent(kod)}`;
const kayitBaglantisi = (kod) => `${panelAdresi()}/register?ref=${encodeURIComponent(kod)}`;

// Kullanicinin yazdigi kod: buyuk harf, bosluk / tire / nokta atilir. Bos ya da cok uzunsa null.
function kodNormalle(ham) {
    const s = String(ham == null ? '' : ham).toLocaleUpperCase('tr-TR').replace(/İ/g, 'I').replace(/[^A-Z0-9]/g, '');
    return s && s.length <= 20 ? s : null;
}

async function yeniKod() {
    for (let i = 0; i < 30; i++) {
        const k = tavsiyeKoduUret();
        const r = await query('SELECT 1 FROM tenants WHERE referral_code = ? LIMIT 1', [k]);
        if (!r.rows.length) return k;
    }
    throw new Error('Tavsiye kodu üretilemedi (çok fazla çakışma).');
}

// Isletmenin kodu; yoksa uretir (sonradan acilan isletmeler: deneme, SofraMix, root).
async function kodVer(tenantId) {
    const t = (await query('SELECT referral_code FROM tenants WHERE id = ?', [tenantId])).rows[0];
    if (!t) throw hata(404, 'İşletme bulunamadı.');
    if (t.referral_code && String(t.referral_code).trim()) return String(t.referral_code).trim();
    for (let i = 0; i < 5; i++) {
        const k = await yeniKod();
        try {
            await query("UPDATE tenants SET referral_code = ? WHERE id = ? AND (referral_code IS NULL OR TRIM(referral_code) = '')", [k, tenantId]);
        } catch (_) { continue; }   // tekil dizin cakismasi: yeniden dene
        const s = (await query('SELECT referral_code FROM tenants WHERE id = ?', [tenantId])).rows[0];
        if (s && s.referral_code) return s.referral_code;
    }
    throw new Error('Tavsiye kodu yazılamadı.');
}

// Kodun sahibi (yoksa null)
async function kodSahibi(kod) {
    const k = kodNormalle(kod);
    if (!k) return null;
    const r = await query('SELECT id, business_name, referral_code FROM tenants WHERE UPPER(referral_code) = ? LIMIT 1', [k]);
    return r.rows[0] || null;
}

// Formdan gelen kod: bos -> null; bilinmiyorsa 400 TAVSIYE_KODU_YOK; gecerliyse normal bicimi.
async function kodDogrula(ham) {
    if (ham == null || String(ham).trim() === '') return null;
    const s = await kodSahibi(ham);
    if (!s) throw hata(400, KOD_BULUNAMADI, 'TAVSIYE_KODU_YOK');
    return s.referral_code;
}

// --- Kendi kendini tavsiye denetimi ---
const telNorm = (t) => { const r = String(t || '').replace(/\D/g, ''); return r.length >= 10 ? r.slice(-10) : null; };
const vergiNorm = (v) => { const r = String(v || '').replace(/\D/g, ''); return r.length >= 10 ? r : null; };

async function kimlik(tenantId) {
    const t = (await query('SELECT id, owner_email, phone, billing_tax_id FROM tenants WHERE id = ?', [tenantId])).rows[0];
    if (!t) return null;
    const eposta = new Set();
    const ekle = (e) => { const s = String(e || '').trim().toLowerCase(); if (s) eposta.add(s); };
    ekle(t.owner_email);
    for (const u of (await query("SELECT email FROM users WHERE tenant_id = ? AND role = 'OWNER'", [tenantId])).rows) ekle(u.email);
    const tel = new Set();
    if (telNorm(t.phone)) tel.add(telNorm(t.phone));
    for (const d of (await query('SELECT telefon_norm FROM deneme_kayitlari WHERE tenant_id = ? AND telefon_norm IS NOT NULL', [tenantId])).rows) tel.add(d.telefon_norm);
    const g = (await query('SELECT grup_id FROM sube_grup_uyeleri WHERE tenant_id = ?', [tenantId]).catch(() => ({ rows: [] }))).rows[0];
    return { eposta, tel, vergi: vergiNorm(t.billing_tax_id), grup: g ? g.grup_id : null };
}
const kesisir = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };

// Ayni isletme mi? Sebep kodu doner (yalniz root gorur) ya da null.
async function ayniIsletmeMi(edenId, edilenId) {
    if (edenId === edilenId) return 'ayni_hesap';
    const a = await kimlik(edenId);
    const b = await kimlik(edilenId);
    if (!a || !b) return null;
    if (kesisir(a.tel, b.tel)) return 'telefon';
    if (kesisir(a.eposta, b.eposta)) return 'eposta';
    if (a.vergi && a.vergi === b.vergi) return 'vergi_no';
    if (a.grup && a.grup === b.grup) return 'sube_grubu';
    return null;
}

// --- Kayit: tavsiye edilen isletme acildiktan sonra ---
// Doner { durum: 'yok' | 'baglandi' | 'uygulanamadi', mesaj? }. Kod bulunamazsa 'yok' (formlar once kodDogrula ile
// 400 doner; buraya gelmez).
async function kayitBagla({ tenantId, kod, kaynak = 'kayit' }) {
    if (!kod) return { durum: 'yok' };
    const eden = await kodSahibi(kod);
    if (!eden) return { durum: 'yok' };
    const var_ = (await query('SELECT id FROM tavsiyeler WHERE tavsiye_edilen_id = ?', [tenantId])).rows[0];
    if (var_) return { durum: 'yok' };
    const sebep = await ayniIsletmeMi(eden.id, tenantId);
    await query(
        `INSERT OR IGNORE INTO tavsiyeler (id, tavsiye_eden_id, tavsiye_edilen_id, kod, kaynak, durum, iptal_sebep)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), eden.id, tenantId, eden.referral_code, String(kaynak || 'kayit').slice(0, 20), sebep ? 'iptal' : 'kayit', sebep]);
    if (sebep) {
        await query('UPDATE tenants SET referred_by = NULL WHERE id = ?', [tenantId]);
        return { durum: 'uygulanamadi', mesaj: UYGULANAMADI };
    }
    await query('UPDATE tenants SET referred_by = ? WHERE id = ?', [eden.referral_code, tenantId]);
    return { durum: 'baglandi' };
}

// Odeme sayisi: onayli havale + islenmis SofraMix odemesi
async function odemeSayisi(tenantId) {
    const r = await query(
        `SELECT (SELECT COUNT(*) FROM lisans_odemeleri WHERE tenant_id = ? AND durum = 'onaylandi')
              + (SELECT COUNT(*) FROM pos_provizyon WHERE tenant_id = ? AND durum = 'islendi') AS n`, [tenantId, tenantId]);
    return Number(r.rows[0].n) || 0;
}

const yeniBitis = (mevcut, gun) => require('./posProvizyon').yeniBitis(mevcut, gun);

// Tavsiye edilen tarafin odulu (+30 gun). ilkOdemeKosulu: otomatik akista yalniz ILK odemede (odeme sayisi 1);
// root elle uygularken en az bir odeme yeter. Doner { yeniBitis, oncekiBitis } ya da null (uygulanmadi).
async function edilenOdulu(satirId, { kaynak = null, ref = null, ilkOdemeKosulu = true } = {}) {
    const s = (await query('SELECT * FROM tavsiyeler WHERE id = ?', [satirId])).rows[0];
    if (!s || s.durum === 'iptal' || s.edilen_odul_at) return null;
    const n = await odemeSayisi(s.tavsiye_edilen_id);
    if (n < 1 || (ilkOdemeKosulu && n !== 1)) return null;
    const sebep = await ayniIsletmeMi(s.tavsiye_eden_id, s.tavsiye_edilen_id);
    if (sebep) {
        await query("UPDATE tavsiyeler SET durum = 'iptal', iptal_sebep = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND edilen_odul_at IS NULL",
            [sebep, s.id]);
        return null;
    }
    const sonuc = await tx(async () => {
        const g = (await query('SELECT edilen_odul_at, durum FROM tavsiyeler WHERE id = ?', [s.id])).rows[0];
        if (!g || g.edilen_odul_at || g.durum === 'iptal') return null;   // ikinci cagri: bir kez
        const t = (await query('SELECT license_end_date FROM tenants WHERE id = ?', [s.tavsiye_edilen_id])).rows[0];
        if (!t) return null;
        const yeni = yeniBitis(t.license_end_date, EDILEN_GUN);
        await query('UPDATE tenants SET license_end_date = ? WHERE id = ?', [yeni, s.tavsiye_edilen_id]);
        await query(
            `UPDATE tavsiyeler SET edilen_gun = ?, edilen_onceki_bitis = ?, edilen_yeni_bitis = ?, edilen_odul_at = CURRENT_TIMESTAMP,
                                   odeme_kaynak = COALESCE(?, odeme_kaynak), odeme_ref = COALESCE(?, odeme_ref),
                                   odeme_at = COALESCE(odeme_at, CURRENT_TIMESTAMP), durum = 'odul_bekliyor',
                                   son_hata = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND edilen_odul_at IS NULL`,
            [EDILEN_GUN, t.license_end_date || null, yeni, kaynak, ref == null ? null : String(ref), s.id]);
        return { oncekiBitis: t.license_end_date || null, yeniBitis: yeni };
    });
    if (!sonuc) return null;
    const YG = require('./yonetimGunlugu');
    await YG.kaydet(null, { islem: 'tavsiye', tenantId: s.tavsiye_edilen_id, hedefTur: 'isletme', hedefId: s.tavsiye_edilen_id,
        ozet: `Tavsiye ödülü (tavsiye edilen): +${EDILEN_GUN} gün; lisans ${YG.trTarih(sonuc.oncekiBitis)} -> ${YG.trTarih(sonuc.yeniBitis)}`,
        ayrinti: { tavsiye: s.id, gun: EDILEN_GUN, kaynak, onceki: sonuc.oncekiBitis, yeni: sonuc.yeniBitis } });
    require('./lisansBildirim').tavsiyeEdilen(s.tavsiye_edilen_id, { bitis: sonuc.yeniBitis }).catch(() => {});
    return sonuc;
}

// Tavsiye eden tarafin odulu (+60 gun). Tavsiye edilen odulunu almis olmali; tavsiye edenin odemesi yoksa
// 'odul_bekliyor' kalir. Doner { yeniBitis, oncekiBitis } | { bekliyor: true } | null.
async function edenOdulu(satirId) {
    const s = (await query('SELECT * FROM tavsiyeler WHERE id = ?', [satirId])).rows[0];
    if (!s || s.durum === 'iptal' || !s.edilen_odul_at || s.eden_odul_at) return null;
    if (await odemeSayisi(s.tavsiye_eden_id) < 1) {
        await query("UPDATE tavsiyeler SET durum = 'odul_bekliyor', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND eden_odul_at IS NULL", [s.id]);
        return { bekliyor: true };
    }
    const sonuc = await tx(async () => {
        const g = (await query('SELECT eden_odul_at, durum FROM tavsiyeler WHERE id = ?', [s.id])).rows[0];
        if (!g || g.eden_odul_at || g.durum === 'iptal') return null;
        const t = (await query('SELECT license_end_date FROM tenants WHERE id = ?', [s.tavsiye_eden_id])).rows[0];
        if (!t) return null;
        const yeni = yeniBitis(t.license_end_date, EDEN_GUN);
        await query('UPDATE tenants SET license_end_date = ? WHERE id = ?', [yeni, s.tavsiye_eden_id]);
        await query(
            `UPDATE tavsiyeler SET eden_gun = ?, eden_onceki_bitis = ?, eden_yeni_bitis = ?, eden_odul_at = CURRENT_TIMESTAMP,
                                   durum = 'odul_verildi', son_hata = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND eden_odul_at IS NULL`,
            [EDEN_GUN, t.license_end_date || null, yeni, s.id]);
        return { oncekiBitis: t.license_end_date || null, yeniBitis: yeni };
    });
    if (!sonuc) return null;
    const edilen = (await query('SELECT business_name FROM tenants WHERE id = ?', [s.tavsiye_edilen_id])).rows[0];
    const YG = require('./yonetimGunlugu');
    await YG.kaydet(null, { islem: 'tavsiye', tenantId: s.tavsiye_eden_id, hedefTur: 'isletme', hedefId: s.tavsiye_eden_id,
        ozet: `Tavsiye ödülü (tavsiye eden, ${edilen ? edilen.business_name : '-'}): +${EDEN_GUN} gün; lisans ${YG.trTarih(sonuc.oncekiBitis)} -> ${YG.trTarih(sonuc.yeniBitis)}`,
        ayrinti: { tavsiye: s.id, gun: EDEN_GUN, onceki: sonuc.oncekiBitis, yeni: sonuc.yeniBitis } });
    require('./lisansBildirim').tavsiyeEden(s.tavsiye_eden_id, { isletme: edilen ? edilen.business_name : '', bitis: sonuc.yeniBitis }).catch(() => {});
    return sonuc;
}

// --- Odeme kancasi: root havale onayi ve SofraMix odemesi islendikten SONRA (islem disinda) cagrilir ---
// 1) Bu isletme tavsiyeyle geldiyse ve bu ILK odemesiyse: +30 gun; tavsiye eden odeme yapmissa ona +60 gun.
// 2) Bu isletme tavsiye eden olarak odul bekliyorsa (artik odemesi var): bekleyen her tavsiye icin +60 gun.
// Doner { edilen: {yeniBitis} | null, eden: [..] }. Hata firlatabilir: cagiran .catch ile yutar.
async function odemeSonrasi(tenantId, { kaynak = null, ref = null } = {}) {
    const sonuc = { edilen: null, eden: [] };
    const s = (await query("SELECT id FROM tavsiyeler WHERE tavsiye_edilen_id = ? AND durum <> 'iptal' AND edilen_odul_at IS NULL", [tenantId])).rows[0];
    if (s) {
        try {
            sonuc.edilen = await edilenOdulu(s.id, { kaynak, ref, ilkOdemeKosulu: true });
            if (sonuc.edilen) await edenOdulu(s.id).catch((e) => hataYaz(s.id, e));
        } catch (e) { await hataYaz(s.id, e); }
    }
    const bekleyen = (await query(
        `SELECT id FROM tavsiyeler WHERE tavsiye_eden_id = ? AND durum = 'odul_bekliyor'
            AND edilen_odul_at IS NOT NULL AND eden_odul_at IS NULL ORDER BY edilen_odul_at, created_at`, [tenantId])).rows;
    for (const b of bekleyen) {
        try { const r = await edenOdulu(b.id); if (r && r.yeniBitis) sonuc.eden.push({ id: b.id, ...r }); } catch (e) { await hataYaz(b.id, e); }
    }
    if (sonuc.edilen || sonuc.eden.length) require('./odemeKorumasi').tazele().catch(() => {});
    return sonuc;
}

async function hataYaz(id, e) {
    console.error('[tavsiye] odul uygulanamadi:', e && e.message);
    await query('UPDATE tavsiyeler SET son_hata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [String((e && e.message) || e).slice(0, 300), id]).catch(() => {});
}

// "Ödeme onayı bekleniyor": tavsiye edilen "Ödemeyi yaptım" dedi ve onay bekliyor. Okumadan once tazelenir.
async function durumTazele() {
    const bekleyen = `EXISTS (SELECT 1 FROM lisans_odemeleri o WHERE o.tenant_id = tavsiyeler.tavsiye_edilen_id
                              AND o.durum = 'beklemede' AND o.odeme_bildirildi_at IS NOT NULL)`;
    await query(`UPDATE tavsiyeler SET durum = 'odeme_bekliyor', updated_at = CURRENT_TIMESTAMP WHERE durum = 'kayit' AND ${bekleyen}`);
    await query(`UPDATE tavsiyeler SET durum = 'kayit', updated_at = CURRENT_TIMESTAMP
                  WHERE durum = 'odeme_bekliyor' AND edilen_odul_at IS NULL AND NOT ${bekleyen}`);
}

// --- Isletme: Tavsiye Et karti ---
async function isletmeOzeti(tenantId) {
    const kod = await kodVer(tenantId);
    await durumTazele().catch(() => {});
    const r = await query(
        `SELECT v.id, v.durum, v.created_at, v.eden_gun, v.eden_odul_at, v.eden_yeni_bitis, t.business_name
           FROM tavsiyeler v LEFT JOIN tenants t ON t.id = v.tavsiye_edilen_id
          WHERE v.tavsiye_eden_id = ? AND v.durum <> 'iptal'
          ORDER BY v.created_at DESC, v.rowid DESC LIMIT 200`, [tenantId]);
    const isletmeDurumu = {
        kayit: 'Deneme sürecinde',
        odeme_bekliyor: 'Ödeme onayı bekleniyor',
        odul_bekliyor: 'Paket aldı; ilk ödemeniz onaylanınca size 2 ay eklenecek',
        odul_verildi: 'Paket aldı; size 2 ay eklendi',
    };
    const liste = r.rows.map((x) => ({
        id: x.id, isletme: x.business_name || 'İşletme', durum: x.durum, durumAdi: isletmeDurumu[x.durum] || DURUM_AD[x.durum] || x.durum,
        tarih: x.created_at, odulTarihi: x.eden_odul_at || null, eklenenGun: x.eden_gun || null,
    }));
    return {
        kod, baglanti: baglanti(kod), kayitBaglantisi: kayitBaglantisi(kod), kural: KURAL_METNI,
        paylasimMetni: `Merhaba, işletmemizde MDA Restoran POS kullanıyoruz ve memnunuz. Aşağıdaki bağlantıdan ücretsiz denemeye başlayabilirsiniz. `
            + `Tavsiye kodum ${kod}; bu kodla ilk paketiniz 12 yerine 13 ay tanımlanır. ${baglanti(kod)}`,
        liste,
        ozet: { toplam: liste.length, odulVerilen: liste.filter((x) => x.durum === 'odul_verildi').length,
            bekleyen: liste.filter((x) => x.durum === 'odul_bekliyor').length },
    };
}

// Lisans sayfasi: gorulmemis odul bildirimleri (iki taraf icin de)
async function bildirimler(tenantId) {
    const r = await query(
        `SELECT v.id, v.tavsiye_eden_id, v.tavsiye_edilen_id, v.eden_odul_at, v.eden_goruldu_at, v.eden_yeni_bitis,
                v.edilen_odul_at, v.edilen_goruldu_at, t.business_name AS edilen_ad
           FROM tavsiyeler v LEFT JOIN tenants t ON t.id = v.tavsiye_edilen_id
          WHERE (v.tavsiye_edilen_id = ? AND v.edilen_odul_at IS NOT NULL AND v.edilen_goruldu_at IS NULL)
             OR (v.tavsiye_eden_id = ? AND v.eden_odul_at IS NOT NULL AND v.eden_goruldu_at IS NULL)
          ORDER BY v.updated_at DESC LIMIT 20`, [tenantId, tenantId]);
    const liste = [];
    for (const x of r.rows) {
        if (x.tavsiye_edilen_id === tenantId && x.edilen_odul_at && !x.edilen_goruldu_at) liste.push({ id: x.id, tur: 'edilen', metin: EDILEN_METNI });
        if (x.tavsiye_eden_id === tenantId && x.eden_odul_at && !x.eden_goruldu_at) liste.push({ id: x.id, tur: 'eden', metin: edenMetni(x.edilen_ad, x.eden_yeni_bitis) });
    }
    return { bildirimler: liste };
}

async function goruldu(tenantId, id) {
    const s = (await query('SELECT tavsiye_eden_id, tavsiye_edilen_id FROM tavsiyeler WHERE id = ?', [String(id || '')])).rows[0];
    if (!s || (s.tavsiye_eden_id !== tenantId && s.tavsiye_edilen_id !== tenantId)) throw hata(404, 'Bildirim bulunamadı.');
    if (s.tavsiye_edilen_id === tenantId) await query('UPDATE tavsiyeler SET edilen_goruldu_at = COALESCE(edilen_goruldu_at, CURRENT_TIMESTAMP) WHERE id = ? AND edilen_odul_at IS NOT NULL', [String(id)]);
    if (s.tavsiye_eden_id === tenantId) await query('UPDATE tavsiyeler SET eden_goruldu_at = COALESCE(eden_goruldu_at, CURRENT_TIMESTAMP) WHERE id = ? AND eden_odul_at IS NOT NULL', [String(id)]);
}

// --- Root ---
const IPTAL_AD = { ayni_hesap: 'kendi kodu', telefon: 'aynı telefon', eposta: 'aynı e-posta', vergi_no: 'aynı vergi no', sube_grubu: 'aynı şube grubu' };

async function rootListe({ durum } = {}) {
    await durumTazele().catch(() => {});
    const kosul = durum && DURUM_AD[durum] ? 'WHERE v.durum = ?' : '';
    const r = await query(
        `SELECT v.*, a.business_name AS eden_ad, a.business_code AS eden_kod, b.business_name AS edilen_ad, b.business_code AS edilen_kod,
                (SELECT COUNT(*) FROM lisans_odemeleri o WHERE o.tenant_id = v.tavsiye_eden_id AND o.durum = 'onaylandi')
              + (SELECT COUNT(*) FROM pos_provizyon p WHERE p.tenant_id = v.tavsiye_eden_id AND p.durum = 'islendi') AS eden_odeme,
                (SELECT COUNT(*) FROM lisans_odemeleri o WHERE o.tenant_id = v.tavsiye_edilen_id AND o.durum = 'onaylandi')
              + (SELECT COUNT(*) FROM pos_provizyon p WHERE p.tenant_id = v.tavsiye_edilen_id AND p.durum = 'islendi') AS edilen_odeme
           FROM tavsiyeler v
           LEFT JOIN tenants a ON a.id = v.tavsiye_eden_id
           LEFT JOIN tenants b ON b.id = v.tavsiye_edilen_id
           ${kosul}
          ORDER BY v.created_at DESC, v.rowid DESC LIMIT 500`, kosul ? [durum] : []);
    const sayac = (await query('SELECT durum, COUNT(*) AS n FROM tavsiyeler GROUP BY durum')).rows
        .reduce((o, x) => ({ ...o, [x.durum]: Number(x.n) }), {});
    return {
        liste: r.rows.map((x) => ({
            id: x.id, durum: x.durum, durumAdi: DURUM_AD[x.durum] || x.durum,
            iptalSebep: x.iptal_sebep ? (IPTAL_AD[x.iptal_sebep] || x.iptal_sebep) : null,
            eden: { id: x.tavsiye_eden_id, ad: x.eden_ad || '(silinmiş işletme)', kod: x.eden_kod, odemeVar: Number(x.eden_odeme) > 0 },
            edilen: { id: x.tavsiye_edilen_id, ad: x.edilen_ad || '(silinmiş işletme)', kod: x.edilen_kod, odemeVar: Number(x.edilen_odeme) > 0 },
            kod: x.kod, kaynak: x.kaynak, tarih: x.created_at, odemeKaynak: x.odeme_kaynak, odemeAt: x.odeme_at,
            edilenOdul: x.edilen_odul_at ? { gun: x.edilen_gun, at: x.edilen_odul_at, yeniBitis: x.edilen_yeni_bitis } : null,
            edenOdul: x.eden_odul_at ? { gun: x.eden_gun, at: x.eden_odul_at, yeniBitis: x.eden_yeni_bitis } : null,
            sonHata: x.son_hata || null,
        })),
        sayac,
    };
}

// Root "Ödülü uygula": eksik kalan odulleri uygular (ilk odeme kosulu aranmaz; en az bir odeme yeter).
async function rootUygula(id) {
    const s = (await query('SELECT * FROM tavsiyeler WHERE id = ?', [String(id || '')])).rows[0];
    if (!s) throw hata(404, 'Tavsiye kaydı bulunamadı.');
    if (s.durum === 'iptal') throw hata(409, 'Bu tavsiye iptal edilmiş (aynı işletme); ödül uygulanmaz.');
    if (s.edilen_odul_at && s.eden_odul_at) return { degisti: false, message: 'Bu tavsiyenin iki ödülü de uygulanmış.' };
    const parcalar = [];
    if (!s.edilen_odul_at) {
        if (await odemeSayisi(s.tavsiye_edilen_id) < 1) throw hata(409, 'Tavsiye edilen işletmenin onaylı ödemesi yok; ödül ilk ödeme onaylanınca uygulanır.');
        const r = await edilenOdulu(s.id, { ilkOdemeKosulu: false });
        const g = (await query('SELECT durum FROM tavsiyeler WHERE id = ?', [s.id])).rows[0];
        if (g && g.durum === 'iptal') throw hata(409, 'Bu tavsiye iptal edildi (aynı işletme); ödül uygulanmadı.');
        if (r) parcalar.push(`tavsiye edilene +${EDILEN_GUN} gün (yeni bitiş ${tarihTR(r.yeniBitis)})`);
    }
    const e = await edenOdulu(s.id);
    if (e && e.yeniBitis) parcalar.push(`tavsiye edene +${EDEN_GUN} gün (yeni bitiş ${tarihTR(e.yeniBitis)})`);
    else if (e && e.bekliyor) parcalar.push('tavsiye edenin onaylı ödemesi olmadığı için onun ödülü bekliyor');
    require('./odemeKorumasi').tazele().catch(() => {});
    return { degisti: parcalar.length > 0, tenantId: s.tavsiye_edilen_id, message: parcalar.length ? 'Uygulandı: ' + parcalar.join('; ') + '.' : 'Uygulanacak ödül bulunamadı.' };
}

// --- Express uclari ---
const sar = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
        if (e.status && e.status < 500) return res.status(e.status).json({ message: e.message, ...(e.code ? { code: e.code } : {}) });
        throw e;
    }
};
const isletmeUcu = sar(async (req, res) => res.json(await isletmeOzeti(req.user.tenantId)));
const bildirimUcu = sar(async (req, res) => res.json(await bildirimler(req.user.tenantId)));
const gorulduUcu = sar(async (req, res) => { await goruldu(req.user.tenantId, req.params.id); res.json({ ok: true }); });
// Herkese acik: kod gecerli mi (isletme adi DONMEZ)
const kodUcu = sar(async (req, res) => res.json({ gecerli: !!(await kodSahibi(req.params.kod)), metin: KAYIT_METNI }));
const rootListeUcu = sar(async (req, res) => res.json(await rootListe({ durum: req.query.durum })));
const rootUygulaUcu = sar(async (req, res) => {
    const r = await rootUygula(req.params.id);
    const YG = require('./yonetimGunlugu');
    if (r.degisti) await YG.kaydet(req, { islem: 'tavsiye', tenantId: r.tenantId, hedefTur: 'isletme', hedefId: r.tenantId, ozet: 'Tavsiye ödülü elle uygulandı: ' + r.message });
    res.json({ ok: true, ...r });
});

module.exports = {
    EDILEN_GUN, EDEN_GUN, REF_SAKLAMA_GUN, KURAL_METNI, KAYIT_METNI, KOD_BULUNAMADI, UYGULANAMADI, EDILEN_METNI, DURUM_AD,
    kodNormalle, yeniKod, kodVer, kodSahibi, kodDogrula, ayniIsletmeMi, kayitBagla, odemeSonrasi, edilenOdulu, edenOdulu,
    durumTazele, isletmeOzeti, bildirimler, goruldu, rootListe, rootUygula, edenMetni, baglanti,
    isletmeUcu, bildirimUcu, gorulduUcu, kodUcu, rootListeUcu, rootUygulaUcu,
};
