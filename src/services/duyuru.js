const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');

// --- Duyurular: root yazar, isletme panelinin ustunde sakin bir serit olarak gorunur ---
// Hedef: tum | adisyon (Adisyon ve Kasa olanlar) | menu (yalniz QR menu kipi) | deneme | odemeli (sinif tek yerde:
// services/yonetimOzet.js sinifla). Kimler: yonetici (sahip + mudur) | herkes. Tarihler Istanbul gunu (YYYY-MM-DD),
// ikisi de dahil; bos = sinirsiz. Kapatma kullanici basina tarayicida (localStorage) tutulur, sunucuda degil.
// Baglanti: ic yol (/plakalar) ya da http(s) adresi; baska sema (javascript: vb.) KABUL EDILMEZ.

const HEDEFLER = {
    tum: 'Tüm işletmeler',
    adisyon: 'Adisyon ve Kasa olanlar',
    menu: 'Yalnız QR menü kipindekiler',
    deneme: 'Denemedekiler',
    odemeli: 'Ödemeli müşteriler',
};
const KIMLER = { yonetici: 'Sahip ve müdür', herkes: 'Panele giren herkes' };

function hata(mesaj, status = 400) { const e = new Error(mesaj); e.status = status; return e; }
const gunGecerli = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
function baglantiGecerli(s) {
    if (s.length > 300 || /\s/.test(s)) return false;
    if (s.startsWith('/')) return !s.startsWith('//') && !s.startsWith('/\\');
    return /^https?:\/\/[^/\s]+/i.test(s);
}

// Govde -> alanlar (kismi guncellemede yalniz gelen alanlar). mevcut verilirse eksikler ondan alinir.
function dogrula(g, mevcut) {
    const f = g || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(f, k);
    const out = {};
    if (has('baslik') || !mevcut) {
        const s = String(f.baslik == null ? '' : f.baslik).trim();
        if (s.length < 3) throw hata('Başlık en az 3 karakter olmalı.');
        if (s.length > 120) throw hata('Başlık en fazla 120 karakter olabilir.');
        out.baslik = s;
    }
    if (has('metin')) {
        const s = String(f.metin == null ? '' : f.metin).trim();
        if (s.length > 500) throw hata('Metin en fazla 500 karakter olabilir.');
        out.metin = s || null;
    }
    if (has('baglanti')) {
        const s = String(f.baglanti == null ? '' : f.baglanti).trim();
        if (s && !baglantiGecerli(s)) throw hata('Bağlantı "/" ile başlayan bir panel yolu (örn. /plakalar) ya da http(s) adresi olmalı.');
        out.baglanti = s || null;
    }
    if (has('baglantiMetni')) {
        const s = String(f.baglantiMetni == null ? '' : f.baglantiMetni).trim();
        if (s.length > 40) throw hata('Bağlantı metni en fazla 40 karakter olabilir.');
        out.baglanti_metni = s || null;
    }
    if (has('hedef') || !mevcut) {
        const h = String(f.hedef || 'tum');
        if (!HEDEFLER[h]) throw hata('Hedef geçersiz.');
        out.hedef = h;
    }
    if (has('kimler') || !mevcut) {
        const k = String(f.kimler || 'yonetici');
        if (!KIMLER[k]) throw hata('Görecek kişiler geçersiz.');
        out.kimler = k;
    }
    for (const [k, alan] of [['baslangic', 'baslangic'], ['bitis', 'bitis']]) {
        if (!has(k)) continue;
        const s = String(f[k] == null ? '' : f[k]).trim();
        if (s && !gunGecerli(s)) throw hata((k === 'baslangic' ? 'Başlangıç' : 'Bitiş') + ' tarihi geçersiz (YYYY-AA-GG).');
        out[alan] = s || null;
    }
    const bas = has('baslangic') ? out.baslangic : (mevcut ? mevcut.baslangic : null);
    const bit = has('bitis') ? out.bitis : (mevcut ? mevcut.bitis : null);
    if (bas && bit && bit < bas) throw hata('Bitiş tarihi başlangıçtan önce olamaz.');
    if (has('aktif')) out.aktif = f.aktif === true || f.aktif === 1 || f.aktif === '1' ? 1 : 0;
    return out;
}

function istanbulBugun() { return require('./yonetimOzet').istanbulParcalari().bugun; }

function bicimle(x, bugun = istanbulBugun()) {
    const tarihte = (!x.baslangic || x.baslangic <= bugun) && (!x.bitis || x.bitis >= bugun);
    return {
        id: x.id, baslik: x.baslik, metin: x.metin || '', baglanti: x.baglanti || '', baglantiMetni: x.baglanti_metni || '',
        hedef: x.hedef, hedefAd: HEDEFLER[x.hedef] || x.hedef, kimler: x.kimler, kimlerAd: KIMLER[x.kimler] || x.kimler,
        baslangic: x.baslangic || '', bitis: x.bitis || '', aktif: !!Number(x.aktif),
        yayinda: !!Number(x.aktif) && tarihte,
        durumAd: !Number(x.aktif) ? 'Pasif' : (tarihte ? 'Yayında' : (x.baslangic && x.baslangic > bugun ? 'Planlandı' : 'Süresi bitti')),
        olusturma: x.created_at, guncelleme: x.updated_at,
    };
}

async function getir(id) {
    return (await query('SELECT * FROM duyurular WHERE id = ?', [String(id)])).rows[0] || null;
}

async function liste() {
    const r = await query('SELECT * FROM duyurular ORDER BY aktif DESC, created_at DESC, rowid DESC');
    const bugun = istanbulBugun();
    return r.rows.map((x) => bicimle(x, bugun));
}

async function olustur(govde) {
    const a = dogrula(govde, null);
    const id = uuidv4();
    await query(
        `INSERT INTO duyurular (id, baslik, metin, baglanti, baglanti_metni, hedef, kimler, baslangic, bitis, aktif)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, a.baslik, a.metin || null, a.baglanti || null, a.baglanti_metni || null, a.hedef, a.kimler,
            a.baslangic || null, a.bitis || null, a.aktif || 0]);
    return bicimle(await getir(id));
}

async function guncelle(id, govde) {
    const mevcut = await getir(id);
    if (!mevcut) throw hata('Duyuru bulunamadı.', 404);
    const a = dogrula(govde, mevcut);
    const alanlar = Object.keys(a);
    if (alanlar.length) {
        await query(`UPDATE duyurular SET ${alanlar.map((k) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [...alanlar.map((k) => a[k]), mevcut.id]);
    }
    return { once: bicimle(mevcut), sonra: bicimle(await getir(mevcut.id)) };
}

async function sil(id) {
    const mevcut = await getir(id);
    if (!mevcut) throw hata('Duyuru bulunamadı.', 404);
    await query('DELETE FROM duyurular WHERE id = ?', [mevcut.id]);
    return bicimle(mevcut);
}

// Isletme paneli: bu kullanicinin bu gun gormesi gereken duyurular
async function isletmeIcin(user) {
    const Oz = require('./yonetimOzet');
    const M = require('./lisansModul');
    const t = (await query(
        `SELECT t.id, t.license_tier, t.license_modules, t.license_end_date, t.created_at, ${Oz.ODEME_ALANLARI}
           FROM tenants t WHERE t.id = ?`, [user.tenantId])).rows[0];
    if (!t) return [];
    const sinif = Oz.sinifla(t, await Oz.katalogTierleri(), Oz.esikGunu());
    const adisyon = M.varMi(t.license_modules, 'BASE');
    const uyar = { tum: true, adisyon, menu: !adisyon, deneme: sinif === 'deneme', odemeli: sinif === 'odemeli' };
    const yonetici = user.role === 'OWNER' || user.role === 'MANAGER';
    const bugun = istanbulBugun();
    const r = await query(
        `SELECT * FROM duyurular WHERE aktif = 1 AND (baslangic IS NULL OR baslangic <= ?) AND (bitis IS NULL OR bitis >= ?)
          ORDER BY created_at DESC, rowid DESC LIMIT 20`, [bugun, bugun]);
    return r.rows
        .filter((x) => uyar[x.hedef] && (x.kimler === 'herkes' || yonetici))
        .slice(0, 5)
        .map((x) => ({ id: x.id, baslik: x.baslik, metin: x.metin || '', baglanti: x.baglanti || '',
            baglantiMetni: x.baglanti_metni || '', guncelleme: x.updated_at }));
}

module.exports = { HEDEFLER, KIMLER, dogrula, liste, getir, olustur, guncelle, sil, isletmeIcin, bicimle };
