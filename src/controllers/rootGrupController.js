const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const YG = require('../services/yonetimGunlugu');
const L = require('../services/lisansDurumu');

// --- Root: sube gruplari (cok subeli isletme) ---
// Grup = birden fazla isletmenin (sube) toplu ozetini goren yonetici(ler). Root kurar: grup adi, uye isletmeler,
// grup yoneticileri (uye isletmelerin OWNER kullanicilari, e-postayla secilir).
// Karar (2026-11-18, inceleme R2-G3): grup yoneticisi YALNIZ isletme sahibi olabilir. Mudur olamaz: subenin sahibi
// mudurun sifresini sifirlayip onun adina girerek diger subelerin rakamlarini gorebilirdi. Grup yoneticisinin sifresi,
// rolu ve aktifligi personel ekranindan da degistirilemez (authController.updateStaff; yalniz hesabin kendisi).
// Kurallar:
//  - Bir isletme en fazla BIR grupta olur (tablo UNIQUE + burada anlasilir mesaj).
//  - Isletme gruptan cikarilinca o isletmenin kullanicilarinin bu gruptaki yoneticiligi de silinir.
//  - Her degisiklik yonetim gunlugune yazilir (islem: sube_grubu).

const ISLEM = 'sube_grubu';
const ROLLER = ['OWNER'];
const ROL_AD = { OWNER: 'İşletme sahibi', MANAGER: 'Müdür' };

function hata(status, message) { const e = new Error(message); e.status = status; return e; }

function adTemizle(v) {
    const ad = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    if (!ad) throw hata(400, 'Grup adı boş olamaz.');
    if (ad.length > 80) throw hata(400, 'Grup adı en fazla 80 karakter olabilir.');
    return ad;
}

async function grupGetir(id) {
    const r = await query('SELECT id, ad, created_at FROM sube_gruplari WHERE id = ?', [String(id || '')]);
    if (!r.rows.length) throw hata(404, 'Şube grubu bulunamadı.');
    return r.rows[0];
}

// Tum gruplar: uyeler (lisans durumu dahil) ve yoneticiler
async function liste() {
    const g = await query('SELECT id, ad, created_at FROM sube_gruplari ORDER BY ad COLLATE NOCASE, created_at');
    const u = await query(
        `SELECT gu.grup_id, gu.created_at AS eklenme, t.id, t.business_name, t.business_code, t.is_active, t.license_end_date
           FROM sube_grup_uyeleri gu JOIN tenants t ON t.id = gu.tenant_id
          ORDER BY t.business_name COLLATE NOCASE`);
    const y = await query(
        `SELECT gy.grup_id, gy.created_at AS eklenme, us.id, us.name, us.email, us.role, us.is_active, us.tenant_id, t.business_name
           FROM sube_grup_yoneticileri gy
           JOIN users us ON us.id = gy.user_id
           LEFT JOIN tenants t ON t.id = us.tenant_id
          ORDER BY us.email`);
    return g.rows.map((x) => ({
        id: x.id,
        ad: x.ad,
        olusturma: x.created_at,
        uyeler: u.rows.filter((m) => m.grup_id === x.id).map((m) => {
            const d = L.hesapla(m.license_end_date);
            return { tenantId: m.id, ad: m.business_name, isyeriKodu: m.business_code, aktif: !!Number(m.is_active),
                lisansDurum: d.durum, lisansKalanGun: d.kalanGun, eklenme: m.eklenme };
        }),
        yoneticiler: y.rows.filter((m) => m.grup_id === x.id).map((m) => ({
            userId: m.id, ad: m.name || '', eposta: m.email, rol: m.role, rolAd: ROL_AD[m.role] || m.role,
            aktif: !!Number(m.is_active), tenantId: m.tenant_id, isletmeAdi: m.business_name || '', eklenme: m.eklenme,
            // Rolu sonradan kasiyere dusurulen ya da pasif hesap grubu goremez (ekranda isaretlenir)
            gecerli: !!Number(m.is_active) && ROLLER.includes(m.role),
        })),
    }));
}

exports.liste = async (_req, res) => { res.json(await liste()); };

exports.olustur = async (req, res) => {
    const ad = adTemizle(req.body && req.body.ad);
    const id = uuidv4();
    await query('INSERT INTO sube_gruplari (id, ad) VALUES (?, ?)', [id, ad]);
    await YG.kaydet(req, { islem: ISLEM, hedefTur: 'sube_grubu', hedefId: id, ozet: `Şube grubu oluşturuldu: ${ad}`, ayrinti: { ad } });
    res.status(201).json({ id, ad });
};

exports.adDegistir = async (req, res) => {
    const g = await grupGetir(req.params.id);
    const ad = adTemizle(req.body && req.body.ad);
    if (ad === g.ad) return res.json({ id: g.id, ad });
    await query('UPDATE sube_gruplari SET ad = ? WHERE id = ?', [ad, g.id]);
    await YG.kaydet(req, { islem: ISLEM, hedefTur: 'sube_grubu', hedefId: g.id, ozet: `Şube grubunun adı değişti: ${g.ad} -> ${ad}`,
        ayrinti: { once: g.ad, sonra: ad } });
    res.json({ id: g.id, ad });
};

exports.sil = async (req, res) => {
    const g = await grupGetir(req.params.id);
    const uy = await query('SELECT tenant_id FROM sube_grup_uyeleri WHERE grup_id = ?', [g.id]);
    const yo = await query('SELECT user_id FROM sube_grup_yoneticileri WHERE grup_id = ?', [g.id]);
    await query('DELETE FROM sube_grup_yoneticileri WHERE grup_id = ?', [g.id]);
    await query('DELETE FROM sube_grup_uyeleri WHERE grup_id = ?', [g.id]);
    await query('DELETE FROM sube_gruplari WHERE id = ?', [g.id]);
    await YG.kaydet(req, { islem: ISLEM, hedefTur: 'sube_grubu', hedefId: g.id, ozet: `Şube grubu silindi: ${g.ad}`,
        ayrinti: { ad: g.ad, uyeler: uy.rows.map((x) => x.tenant_id), yoneticiler: yo.rows.map((x) => x.user_id) } });
    res.json({ ok: true });
};

exports.uyeEkle = async (req, res) => {
    const g = await grupGetir(req.params.id);
    const tenantId = String((req.body && req.body.tenantId) || '').trim();
    if (!tenantId) throw hata(400, 'İşletme seçilmedi.');
    const t = (await query('SELECT id, business_name FROM tenants WHERE id = ?', [tenantId])).rows[0];
    if (!t) throw hata(404, 'İşletme bulunamadı.');
    const mevcut = (await query(
        `SELECT gu.grup_id, g.ad FROM sube_grup_uyeleri gu LEFT JOIN sube_gruplari g ON g.id = gu.grup_id WHERE gu.tenant_id = ?`, [t.id])).rows[0];
    if (mevcut && mevcut.grup_id === g.id) return res.json({ ok: true, zatenUye: true });
    if (mevcut) throw hata(409, `Bu işletme zaten "${mevcut.ad || 'başka bir grup'}" grubunda. Bir işletme yalnızca bir grupta olabilir.`);
    try {
        await query('INSERT INTO sube_grup_uyeleri (grup_id, tenant_id) VALUES (?, ?)', [g.id, t.id]);
    } catch (e) {
        if (/UNIQUE/i.test(String(e && e.message))) throw hata(409, 'Bu işletme zaten bir grupta. Bir işletme yalnızca bir grupta olabilir.');
        throw e;
    }
    await YG.kaydet(req, { islem: ISLEM, tenantId: t.id, hedefTur: 'sube_grubu', hedefId: g.id,
        ozet: `Şube grubuna eklendi: ${g.ad}`, ayrinti: { grup: g.ad } });
    res.status(201).json({ ok: true });
};

exports.uyeCikar = async (req, res) => {
    const g = await grupGetir(req.params.id);
    const tenantId = String(req.params.tenantId || '');
    const r = await query('DELETE FROM sube_grup_uyeleri WHERE grup_id = ? AND tenant_id = ?', [g.id, tenantId]);
    if (!r.changes) throw hata(404, 'İşletme bu grupta değil.');
    // O isletmenin kullanicilari artik bu grubun yoneticisi olamaz
    const y = await query(
        `SELECT gy.user_id, us.email FROM sube_grup_yoneticileri gy JOIN users us ON us.id = gy.user_id
          WHERE gy.grup_id = ? AND us.tenant_id = ?`, [g.id, tenantId]);
    for (const x of y.rows) await query('DELETE FROM sube_grup_yoneticileri WHERE grup_id = ? AND user_id = ?', [g.id, x.user_id]);
    await YG.kaydet(req, { islem: ISLEM, tenantId, hedefTur: 'sube_grubu', hedefId: g.id,
        ozet: `Şube grubundan çıkarıldı: ${g.ad}` + (y.rows.length ? ` (${y.rows.length} grup yöneticisi de kaldırıldı)` : ''),
        ayrinti: { grup: g.ad, kaldirilanYoneticiler: y.rows.map((x) => x.email) } });
    res.json({ ok: true, kaldirilanYonetici: y.rows.length });
};

// Yonetici adaylari: uye isletmelerin aktif OWNER kullanicilari (root ekraninda secim listesi)
exports.adaylar = async (req, res) => {
    const g = await grupGetir(req.params.id);
    const r = await query(
        `SELECT us.id, us.name, us.email, us.role, us.tenant_id, t.business_name,
                (SELECT 1 FROM sube_grup_yoneticileri gy WHERE gy.grup_id = ? AND gy.user_id = us.id) AS yonetici
           FROM users us
           JOIN sube_grup_uyeleri gu ON gu.tenant_id = us.tenant_id AND gu.grup_id = ?
           JOIN tenants t ON t.id = us.tenant_id
          WHERE us.is_active = 1 AND us.role = 'OWNER'
          ORDER BY t.business_name COLLATE NOCASE, us.role DESC, us.email`, [g.id, g.id]);
    res.json(r.rows.map((x) => ({ userId: x.id, ad: x.name || '', eposta: x.email, rol: x.role, rolAd: ROL_AD[x.role] || x.role,
        tenantId: x.tenant_id, isletmeAdi: x.business_name, yonetici: !!x.yonetici })));
};

// Yonetici ekle: { eposta, tenantId? } ya da { userId }. Kullanici uye isletmelerden birinde aktif OWNER olmali.
exports.yoneticiEkle = async (req, res) => {
    const g = await grupGetir(req.params.id);
    const b = req.body || {};
    const userId = String(b.userId || '').trim();
    const eposta = String(b.eposta || b.email || '').trim().toLowerCase();
    const tenantId = String(b.tenantId || '').trim();
    if (!userId && !eposta) throw hata(400, 'Yöneticinin e-posta adresini yazın.');
    const kosul = userId ? 'us.id = ?' : 'LOWER(us.email) = ?';
    const p = [g.id, userId || eposta];
    let ek = '';
    if (tenantId) { ek = ' AND us.tenant_id = ?'; p.push(tenantId); }
    const r = await query(
        `SELECT us.id, us.email, us.role, us.is_active, us.tenant_id, t.business_name
           FROM users us
           JOIN sube_grup_uyeleri gu ON gu.tenant_id = us.tenant_id AND gu.grup_id = ?
           JOIN tenants t ON t.id = us.tenant_id
          WHERE ${kosul}${ek}`, p);
    if (!r.rows.length) throw hata(404, 'Bu e-posta adresiyle gruptaki işletmelerde bir kullanıcı bulunamadı. Önce kullanıcının işletmesini gruba ekleyin.');
    if (r.rows.length > 1) throw hata(409, 'Bu e-posta adresi gruptaki birden fazla işletmede kayıtlı. Listeden işletmeyi seçerek ekleyin.');
    const us = r.rows[0];
    if (!Number(us.is_active)) throw hata(400, 'Bu kullanıcı hesabı pasif.');
    if (!ROLLER.includes(us.role)) throw hata(400, 'Grup yöneticisi yalnızca işletme sahibi olabilir.');
    const e = await query('INSERT OR IGNORE INTO sube_grup_yoneticileri (grup_id, user_id) VALUES (?, ?)', [g.id, us.id]);
    if (!e.changes) return res.json({ ok: true, zatenYonetici: true });
    await YG.kaydet(req, { islem: ISLEM, tenantId: us.tenant_id, hedefTur: 'sube_grubu', hedefId: g.id,
        ozet: `Grup yöneticisi eklendi: ${us.email} (${g.ad})`, ayrinti: { grup: g.ad, eposta: us.email, rol: us.role } });
    res.status(201).json({ ok: true, userId: us.id });
};

exports.yoneticiCikar = async (req, res) => {
    const g = await grupGetir(req.params.id);
    const userId = String(req.params.userId || '');
    const us = (await query('SELECT email, tenant_id FROM users WHERE id = ?', [userId])).rows[0] || {};
    const r = await query('DELETE FROM sube_grup_yoneticileri WHERE grup_id = ? AND user_id = ?', [g.id, userId]);
    if (!r.changes) throw hata(404, 'Bu kullanıcı grubun yöneticisi değil.');
    await YG.kaydet(req, { islem: ISLEM, tenantId: us.tenant_id || null, hedefTur: 'sube_grubu', hedefId: g.id,
        ozet: `Grup yöneticisi kaldırıldı: ${us.email || userId} (${g.ad})`, ayrinti: { grup: g.ad, eposta: us.email || null } });
    res.json({ ok: true });
};
