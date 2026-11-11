const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');
const H = require('./magazaHesap');
const MA = require('./magazaAyar');
const MU = require('./magazaUrun');
const B = require('./magazaBildirim');

// --- Magaza siparisleri ---
//
// Akis: ODEME_BEKLENIYOR -> ODEME_ALINDI -> HAZIRLANIYOR -> KARGODA -> TESLIM_EDILDI
//   - Isletme yalniz ODEME_BEKLENIYOR iken IPTAL edebilir.
//   - Root REDDEDILDI yapabilir (kargodan once, sebep zorunlu); sebebi isletme gorur.
//   - Root, stoktaki urunde HAZIRLANIYOR adimini atlayip dogrudan kargoya verebilir.
//   - Geri donus yok: yanlis isaretleme root tarafinda yeni bir islem gerektirir (bkz. rapor).
//
// Tutarlar SUNUCUDA, veritabanindaki fiyatlardan hesaplanir; istemcinin gonderdigi fiyat okunmaz.
// Stok adedi girilmis urunde siparis olusurken adet AYRILIR (ayni transaction), iptal/redde geri doner.
// Odeme yontemi yalniz havale/EFT. Kartla odeme (iyzico) eklenince ODEME_YONTEMLERI'ne yeni satir
// + kendi onay akisi gelir; siparis satirinda odeme_yontemi sutunu zaten var.

const DURUM = {
    ODEME_BEKLENIYOR: 'ODEME_BEKLENIYOR', ODEME_ALINDI: 'ODEME_ALINDI', HAZIRLANIYOR: 'HAZIRLANIYOR',
    KARGODA: 'KARGODA', TESLIM_EDILDI: 'TESLIM_EDILDI', IPTAL: 'IPTAL', REDDEDILDI: 'REDDEDILDI',
};
const DURUM_AD = {
    ODEME_BEKLENIYOR: 'Ödeme bekleniyor', ODEME_ALINDI: 'Ödeme alındı', HAZIRLANIYOR: 'Hazırlanıyor',
    KARGODA: 'Kargoya verildi', TESLIM_EDILDI: 'Teslim edildi', IPTAL: 'İptal edildi', REDDEDILDI: 'Reddedildi',
};
const KAPALI = [DURUM.TESLIM_EDILDI, DURUM.IPTAL, DURUM.REDDEDILDI];
const ROOT_GECIS = {
    ODEME_BEKLENIYOR: [DURUM.ODEME_ALINDI, DURUM.REDDEDILDI],
    ODEME_ALINDI: [DURUM.HAZIRLANIYOR, DURUM.KARGODA, DURUM.REDDEDILDI],
    HAZIRLANIYOR: [DURUM.KARGODA, DURUM.REDDEDILDI],
    KARGODA: [DURUM.TESLIM_EDILDI],
};
const ODEME_YONTEMLERI = { HAVALE: { ad: 'Havale/EFT', acik: true } };
const ACIK_SIPARIS_SINIRI = 5;     // ayni isletmenin ayni anda odemesi beklenen siparis sayisi
const FILTRE = {
    bekleyen: [DURUM.ODEME_BEKLENIYOR],
    hazirlanacak: [DURUM.ODEME_ALINDI, DURUM.HAZIRLANIYOR],
    kargoda: [DURUM.KARGODA],
    teslim: [DURUM.TESLIM_EDILDI],
    iptal: [DURUM.IPTAL, DURUM.REDDEDILDI],
};

function hata(status, message, code, ek) {
    const e = new Error(message); e.status = status; if (code) e.code = code; if (ek) e.ek = ek; return e;
}
const simdi = () => new Date().toISOString();
const noMetin = B.noMetin;

// --- Sepet ---
function girdiNormalle(kalemler) {
    if (!Array.isArray(kalemler) || !kalemler.length) throw hata(400, 'Sepet boş.', 'SEPET_BOS');
    const harita = new Map();
    for (const k of kalemler) {
        const id = String((k && k.urunId) || '').trim().slice(0, 64);
        if (!id) throw hata(400, 'Sepette tanımsız bir ürün var.', 'SEPET_GECERSIZ');
        const adet = Number(k.adet);
        if (!Number.isInteger(adet) || adet < 1 || adet > H.EN_FAZLA_ADET) {
            throw hata(400, `Adet 1 ile ${H.EN_FAZLA_ADET} arasında tam sayı olmalı.`, 'ADET_GECERSIZ');
        }
        harita.set(id, Math.min(H.EN_FAZLA_ADET, (harita.get(id) || 0) + adet));
    }
    if (harita.size > H.EN_FAZLA_KALEM) throw hata(400, `Bir siparişte en fazla ${H.EN_FAZLA_KALEM} farklı ürün olabilir.`, 'SEPET_GECERSIZ');
    return [...harita].map(([urunId, adet]) => ({ urunId, adet }));
}

// siki=false (sepet ekrani): satista olmayan urun atlanir, fazla adet stoga indirilir, sorun listelenir.
// siki=true (siparis): herhangi bir sorun 409 - isletme sepeti gozden gecirmeden siparis olusmaz.
async function sepetCoz(kalemler, { siki = false, kargoAyar }) {
    const istek = girdiNormalle(kalemler);
    const ids = istek.map(x => x.urunId);
    const r = await query(
        `SELECT * FROM magaza_urunler WHERE id IN (${ids.map(() => '?').join(',')})
            AND silindi_at IS NULL AND yayin = 'YAYINDA'`, ids);
    const urun = new Map(r.rows.map(u => [u.id, u]));
    const kapak = await MU.kapakHaritasi(r.rows.map(u => u.id));
    const satirlar = [], sorunlar = [];
    for (const k of istek) {
        const u = urun.get(k.urunId);
        if (!u) { sorunlar.push({ urunId: k.urunId, sebep: 'SATISTA_DEGIL', mesaj: 'Sepetteki bir ürün artık satışta değil.' }); continue; }
        const st = MU.etkinStok(u);
        if (st.durum === 'TUKENDI') { sorunlar.push({ urunId: u.id, ad: u.ad, sebep: 'TUKENDI', mesaj: `"${u.ad}" tükendi.` }); continue; }
        let adet = k.adet;
        if (adet > st.maksAdet) {
            sorunlar.push({ urunId: u.id, ad: u.ad, sebep: 'STOK_YETERSIZ', maksAdet: st.maksAdet,
                mesaj: `"${u.ad}" için en fazla ${st.maksAdet} adet sipariş verilebilir.` });
            if (siki) continue;
            adet = st.maksAdet;
        }
        satirlar.push({
            urunId: u.id, ad: u.ad, kapak: kapak.get(u.id) || null, adet,
            birimKurus: u.fiyat_kurus, birimKdvDahilKurus: H.kdvDahilBirim(u.fiyat_kurus, u.kdv_orani), kdvOrani: u.kdv_orani,
            ...H.satirHesapla(u.fiyat_kurus, adet, u.kdv_orani),
            stok: { durum: st.durum, tedarikGun: st.tedarikGun }, maksAdet: st.maksAdet,
            stokTakip: u.stok_adedi !== null && u.stok_adedi !== undefined,
        });
    }
    if (siki && sorunlar.length) {
        throw hata(409, 'Sepetinizde değişiklik var: ' + sorunlar.map(s => s.mesaj).join(' '), 'SEPET_DEGISTI', { sorunlar });
    }
    return { kalemler: satirlar, sorunlar, ...H.toplamlar(satirlar, kargoAyar) };
}

// --- Siparis olusturma girdileri ---
function teslimatDenetle(t) {
    t = t || {};
    const alici = H.metin(t.alici, 120), telefon = H.metin(t.telefon, 30), adres = H.metin(t.adres, 500);
    if (alici.length < 3) throw hata(400, 'Teslimat için alıcı adını yazın.', 'TESLIMAT');
    if (!H.telefonGecerli(telefon)) throw hata(400, 'Teslimat telefonu geçersiz.', 'TESLIMAT');
    if (adres.length < 10) throw hata(400, 'Teslimat adresini açık olarak yazın (mahalle, cadde, numara, ilçe, il).', 'TESLIMAT');
    return { alici, telefon, adres };
}

function faturaDenetle(f, teslimatAdres) {
    f = f || {};
    const tip = f.tip === 'SAHIS' || f.tip === 'KURUMSAL' ? f.tip : null;
    if (!tip) throw hata(400, 'Fatura türünü seçin.', 'FATURA');
    const unvan = H.metin(f.unvan, 200);
    if (unvan.length < 2) throw hata(400, tip === 'SAHIS' ? 'Fatura için ad soyad ya da işletme adını yazın.' : 'Fatura unvanını yazın.', 'FATURA');
    const vergiDairesi = H.metin(f.vergiDairesi, 80);
    let vergiNo = null, tcNo = null;
    if (tip === 'KURUMSAL') {
        if (vergiDairesi.length < 2) throw hata(400, 'Vergi dairesini yazın.', 'FATURA');
        vergiNo = H.rakamlar(f.vergiNo);
        if (!H.vknGecerli(vergiNo)) throw hata(400, 'Vergi numarası 10 haneli olmalı.', 'FATURA');
    } else {
        tcNo = H.rakamlar(f.tcKimlikNo);
        if (!H.tcknGecerli(tcNo)) throw hata(400, 'TC kimlik numarası geçersiz.', 'FATURA');
    }
    const adres = H.metin(f.adres, 500) || teslimatAdres;
    if (adres.length < 10) throw hata(400, 'Fatura adresini yazın.', 'FATURA');
    return { tip, unvan, vergiDairesi: vergiDairesi || null, vergiNo, tcNo, adres };
}

async function gecmisYaz(siparisId, olay, aciklama, kim, kimAd) {
    await query('INSERT INTO magaza_siparis_gecmisi (siparis_id, olay, aciklama, kim, kim_ad, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [siparisId, olay, aciklama ? String(aciklama).slice(0, 500) : null, kim, kimAd ? String(kimAd).slice(0, 120) : null, simdi()]);
}

async function siparisOlustur({ tenantId, kullanici, govde }) {
    const g = govde || {};
    const ayar = await MA.oku();
    if (!ayar.acik) throw hata(403, 'Mağaza şu anda kapalı.', 'MAGAZA_KAPALI');
    const yontem = String(g.odemeYontemi || 'HAVALE');
    if (!Object.prototype.hasOwnProperty.call(ODEME_YONTEMLERI, yontem) || !ODEME_YONTEMLERI[yontem].acik) {
        throw hata(400, 'Bu ödeme yöntemi kullanılamıyor.', 'ODEME_YONTEMI');
    }
    const odeme = await MA.odemeBilgisi();
    if (!odeme.iban) throw hata(409, 'Ödeme bilgileri henüz tanımlanmadı; sipariş şu an alınamıyor. Lütfen MDA Yazılım ile iletişime geçin.', 'ODEME_BILGISI_YOK');
    if (g.kosullarKabul !== true) throw hata(400, 'Satış koşullarını okuyup onaylayın.', 'KOSULLAR');
    if (String(g.kosullarSurum || '') !== ayar.kosullarSurum) {
        throw hata(409, 'Satış koşulları güncellendi. Lütfen güncel metni okuyup yeniden onaylayın.', 'KOSULLAR_DEGISTI',
            { kosullar: { metin: ayar.kosullarMetni, surum: ayar.kosullarSurum } });
    }
    const teslimat = teslimatDenetle(g.teslimat);
    const fatura = faturaDenetle(g.fatura, teslimat.adres);
    const not = H.metin(g.not, 500) || null;
    const t = (await query('SELECT business_name, business_code FROM tenants WHERE id = ?', [tenantId])).rows[0] || {};

    const sonuc = await tx(async () => {
        const acik = Number((await query("SELECT COUNT(*) AS c FROM magaza_siparisler WHERE tenant_id = ? AND durum = 'ODEME_BEKLENIYOR'",
            [tenantId])).rows[0].c) || 0;
        if (acik >= ACIK_SIPARIS_SINIRI) {
            throw hata(409, `Ödemesi beklenen ${acik} siparişiniz var. Yeni sipariş için önce bunların ödemesini yapın ya da iptal edin.`, 'ACIK_SIPARIS_SINIRI');
        }
        // Fiyat, KDV, stok: transaction icinde taze okunur (ayni anda iki siparis ayni stogu ayiramaz)
        const s = await sepetCoz(g.kalemler, { siki: true, kargoAyar: MA.kargoAyari(ayar) });
        if (g.beklenenToplamKurus !== undefined && g.beklenenToplamKurus !== null && Number(g.beklenenToplamKurus) !== s.genelToplamKurus) {
            throw hata(409, 'Fiyatlar ya da kargo ücreti güncellendi. Lütfen sepetteki güncel tutarı kontrol edip yeniden onaylayın.',
                'TUTAR_DEGISTI', { genelToplamKurus: s.genelToplamKurus });
        }
        for (const k of s.kalemler) {
            if (!k.stokTakip) continue;
            const r = await query(
                'UPDATE magaza_urunler SET stok_adedi = stok_adedi - ?, updated_at = ? WHERE id = ? AND stok_adedi IS NOT NULL AND stok_adedi >= ?',
                [k.adet, simdi(), k.urunId, k.adet]);
            if (r.changes !== 1) throw hata(409, `"${k.ad}" için yeterli stok kalmadı.`, 'SEPET_DEGISTI');
        }
        const no = Number((await query('SELECT COALESCE(MAX(no), 1000) + 1 AS n FROM magaza_siparisler')).rows[0].n);
        const id = uuidv4(), z = simdi();
        await query(
            `INSERT INTO magaza_siparisler (id, no, tenant_id, isletme_adi, isyeri_kodu, olusturan_kullanici_id, olusturan_ad,
                durum, odeme_yontemi, ara_toplam_kurus, kdv_kurus, kargo_kurus, genel_toplam_kurus,
                teslimat_alici, teslimat_telefon, teslimat_adres,
                fatura_tip, fatura_unvan, fatura_vergi_dairesi, fatura_vergi_no, fatura_tc_no, fatura_adres,
                siparis_notu, kosullar_kabul_at, kosullar_surum, kosullar_metin, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'ODEME_BEKLENIYOR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, no, tenantId, t.business_name || null, t.business_code || null, kullanici.id || null, kullanici.ad || null,
                yontem, s.araToplamKurus, s.kdvKurus, s.kargoKurus, s.genelToplamKurus,
                teslimat.alici, teslimat.telefon, teslimat.adres,
                fatura.tip, fatura.unvan, fatura.vergiDairesi, fatura.vergiNo, fatura.tcNo, fatura.adres,
                not, z, ayar.kosullarSurum, ayar.kosullarMetni, z, z]);
        let sira = 0;
        for (const k of s.kalemler) {
            await query(
                `INSERT INTO magaza_siparis_kalemleri (id, siparis_id, urun_id, urun_adi, kapak_yol, adet, birim_fiyat_kurus,
                    kdv_orani, tutar_kurus, kdv_kurus, toplam_kurus, stok_ayrildi, sira)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [uuidv4(), id, k.urunId, k.ad, k.kapak, k.adet, k.birimKurus, k.kdvOrani, k.tutarKurus, k.kdvKurus,
                    k.toplamKurus, k.stokTakip ? k.adet : 0, ++sira]);
        }
        await gecmisYaz(id, DURUM.ODEME_BEKLENIYOR, 'Sipariş oluşturuldu', 'ISLETME', kullanici.ad);
        return id;
    });

    const kayit = (await query('SELECT * FROM magaza_siparisler WHERE id = ?', [sonuc])).rows[0];
    const kalemler = (await query('SELECT * FROM magaza_siparis_kalemleri WHERE siparis_id = ? ORDER BY sira', [sonuc])).rows;
    B.yeniSiparis(kayit, kalemler).catch(() => {});     // bildirim transaction DISINDA (geri alinan siparis icin posta gitmesin)
    return sonuc;
}

// Stok iadesi (transaction icinde cagrilir). Adet takibi sonradan kapatildiysa (stok_adedi NULL) dokunulmaz.
async function stokIade(siparisId) {
    const k = await query('SELECT urun_id, stok_ayrildi FROM magaza_siparis_kalemleri WHERE siparis_id = ? AND stok_ayrildi > 0', [siparisId]);
    for (const x of k.rows) {
        await query('UPDATE magaza_urunler SET stok_adedi = stok_adedi + ?, updated_at = ? WHERE id = ? AND stok_adedi IS NOT NULL',
            [x.stok_ayrildi, simdi(), x.urun_id]);
    }
}

// --- Isletme eylemleri ---
async function odemeBildir({ id, tenantId, kullanici, referans }) {
    const ref = H.metin(referans, 120) || null;
    const s = await tx(async () => {
        const s = (await query('SELECT * FROM magaza_siparisler WHERE id = ? AND tenant_id = ?', [String(id), tenantId])).rows[0];
        if (!s) throw hata(404, 'Sipariş bulunamadı.');
        if (s.durum !== DURUM.ODEME_BEKLENIYOR) throw hata(409, 'Bu sipariş ödeme beklemiyor.', 'GECERSIZ_DURUM');
        if (s.odeme_bildirildi_at) throw hata(409, 'Ödeme zaten bildirildi; onay bekleniyor.', 'ZATEN_BILDIRILDI');
        const z = simdi();
        await query('UPDATE magaza_siparisler SET odeme_bildirildi_at = ?, odeme_referans = ?, updated_at = ? WHERE id = ?', [z, ref, z, s.id]);
        await gecmisYaz(s.id, 'ODEME_BILDIRIMI', ref ? 'Ödeme bildirildi. Referans: ' + ref : 'Ödeme bildirildi', 'ISLETME', kullanici.ad);
        return s;
    });
    B.odemeBildirildi(s, ref).catch(() => {});
}

async function isletmeIptal({ id, tenantId, kullanici, sebep }) {
    const neden = H.metin(sebep, 300) || 'İşletme siparişi iptal etti.';
    await tx(async () => {
        const s = (await query('SELECT * FROM magaza_siparisler WHERE id = ? AND tenant_id = ?', [String(id), tenantId])).rows[0];
        if (!s) throw hata(404, 'Sipariş bulunamadı.');
        if (s.durum !== DURUM.ODEME_BEKLENIYOR) {
            throw hata(409, 'Yalnız ödemesi beklenen sipariş iptal edilebilir. Bu sipariş için MDA Yazılım ile iletişime geçin.', 'GECERSIZ_DURUM');
        }
        const z = simdi();
        const r = await query(
            `UPDATE magaza_siparisler SET durum = 'IPTAL', kapanis_at = ?, kapatan = 'ISLETME', kapanis_sebebi = ?, updated_at = ?
              WHERE id = ? AND durum = 'ODEME_BEKLENIYOR'`, [z, neden, z, s.id]);
        if (r.changes !== 1) throw hata(409, 'Sipariş durumu değişti, sayfayı yenileyin.', 'GECERSIZ_DURUM');
        await stokIade(s.id);
        await gecmisYaz(s.id, DURUM.IPTAL, neden, 'ISLETME', kullanici.ad);
    });
}

// --- Root eylemleri ---
async function durumDegistir({ id, hedef, govde, rootAd }) {
    const g = govde || {};
    if (!Object.values(DURUM).includes(hedef) || hedef === DURUM.ODEME_BEKLENIYOR || hedef === DURUM.IPTAL) {
        throw hata(400, 'Hedef durum geçersiz.', 'GECERSIZ_HEDEF');
    }
    let firma, takip, sebep;
    if (hedef === DURUM.KARGODA) {
        firma = H.metin(g.kargoFirma, 60); takip = H.metin(g.kargoTakipNo, 60);
        if (firma.length < 2 || takip.length < 3) throw hata(400, 'Kargo firması ve takip numarası zorunlu.', 'KARGO_BILGISI');
    }
    if (hedef === DURUM.REDDEDILDI) {
        sebep = H.metin(g.sebep, 500);
        if (sebep.length < 3) throw hata(400, 'İptal/red sebebi zorunlu (işletme bu sebebi görür).', 'SEBEP');
    }
    await tx(async () => {
        const s = (await query('SELECT * FROM magaza_siparisler WHERE id = ?', [String(id)])).rows[0];
        if (!s) throw hata(404, 'Sipariş bulunamadı.');
        if (!(ROOT_GECIS[s.durum] || []).includes(hedef)) {
            throw hata(409, `Sipariş "${DURUM_AD[s.durum]}" durumunda; "${DURUM_AD[hedef]}" yapılamaz.`, 'GECERSIZ_GECIS');
        }
        const z = simdi();
        const set = { durum: hedef, updated_at: z };
        let aciklama = DURUM_AD[hedef];
        if (hedef === DURUM.ODEME_ALINDI) set.odeme_alindi_at = z;
        if (hedef === DURUM.HAZIRLANIYOR) set.hazirlaniyor_at = z;
        if (hedef === DURUM.KARGODA) {
            Object.assign(set, { kargo_firma: firma, kargo_takip_no: takip, kargoya_verildi_at: z });
            aciklama = `Kargoya verildi: ${firma}, takip no ${takip}`;
        }
        if (hedef === DURUM.TESLIM_EDILDI) set.teslim_at = z;
        if (hedef === DURUM.REDDEDILDI) {
            Object.assign(set, { kapanis_at: z, kapatan: 'ROOT', kapanis_sebebi: sebep });
            aciklama = sebep;
        }
        const k = Object.keys(set);
        const r = await query(`UPDATE magaza_siparisler SET ${k.map(x => x + ' = ?').join(', ')} WHERE id = ? AND durum = ?`,
            [...k.map(x => set[x]), s.id, s.durum]);
        if (r.changes !== 1) throw hata(409, 'Sipariş durumu değişti, sayfayı yenileyin.', 'GECERSIZ_GECIS');
        if (hedef === DURUM.REDDEDILDI) await stokIade(s.id);
        await gecmisYaz(s.id, hedef, aciklama, 'ROOT', rootAd);
    });
}

// Ic not, fatura isareti, kargo bilgisi duzeltmesi (yalniz kargodaki/teslim edilmis sipariste).
async function rootGuncelle({ id, govde, rootAd }) {
    const g = govde || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(g, k);
    const s = (await query('SELECT * FROM magaza_siparisler WHERE id = ?', [String(id)])).rows[0];
    if (!s) throw hata(404, 'Sipariş bulunamadı.');
    const set = {};
    const olaylar = [];
    if (has('icNot')) set.ic_not = H.metin(g.icNot, 2000) || null;
    if (has('faturaKesildi')) {
        if (g.faturaKesildi) {
            set.fatura_kesildi_at = s.fatura_kesildi_at || simdi();
            set.fatura_no = H.metin(has('faturaNo') ? g.faturaNo : s.fatura_no, 50) || null;
            if (!s.fatura_kesildi_at || set.fatura_no !== s.fatura_no) {
                olaylar.push(['FATURA', 'Fatura kesildi' + (set.fatura_no ? ': ' + set.fatura_no : '')]);
            }
        } else {
            set.fatura_kesildi_at = null; set.fatura_no = null;
            if (s.fatura_kesildi_at) olaylar.push(['FATURA', 'Fatura işareti kaldırıldı']);
        }
    } else if (has('faturaNo')) {
        set.fatura_no = H.metin(g.faturaNo, 50) || null;
    }
    if (has('kargoFirma') || has('kargoTakipNo')) {
        if (![DURUM.KARGODA, DURUM.TESLIM_EDILDI].includes(s.durum)) {
            throw hata(409, 'Kargo bilgisi yalnız kargoya verilmiş siparişte düzeltilebilir.', 'GECERSIZ_DURUM');
        }
        const firma = H.metin(has('kargoFirma') ? g.kargoFirma : s.kargo_firma, 60);
        const takip = H.metin(has('kargoTakipNo') ? g.kargoTakipNo : s.kargo_takip_no, 60);
        if (firma.length < 2 || takip.length < 3) throw hata(400, 'Kargo firması ve takip numarası zorunlu.', 'KARGO_BILGISI');
        set.kargo_firma = firma; set.kargo_takip_no = takip;
        if (firma !== s.kargo_firma || takip !== s.kargo_takip_no) olaylar.push(['KARGO', `Kargo bilgisi düzeltildi: ${firma}, takip no ${takip}`]);
    }
    const k = Object.keys(set);
    if (!k.length) throw hata(400, 'Güncellenecek alan yok.');
    set.updated_at = simdi();
    const kk = Object.keys(set);
    await query(`UPDATE magaza_siparisler SET ${kk.map(x => x + ' = ?').join(', ')} WHERE id = ?`, [...kk.map(x => set[x]), s.id]);
    for (const [olay, aciklama] of olaylar) await gecmisYaz(s.id, olay, aciklama, 'ROOT', rootAd);
}

// --- Okuma ---
function ozet(s) {
    return {
        id: s.id, no: s.no, noMetin: noMetin(s.no), durum: s.durum, durumAd: DURUM_AD[s.durum] || s.durum,
        odemeYontemi: s.odeme_yontemi, odemeYontemiAd: (ODEME_YONTEMLERI[s.odeme_yontemi] || {}).ad || s.odeme_yontemi,
        araToplamKurus: s.ara_toplam_kurus, kdvKurus: s.kdv_kurus, kargoKurus: s.kargo_kurus, genelToplamKurus: s.genel_toplam_kurus,
        createdAt: s.created_at, odemeBildirildiAt: s.odeme_bildirildi_at, odemeAlindiAt: s.odeme_alindi_at,
        hazirlaniyorAt: s.hazirlaniyor_at, kargoyaVerildiAt: s.kargoya_verildi_at, teslimAt: s.teslim_at,
        kargoFirma: s.kargo_firma, kargoTakipNo: s.kargo_takip_no,
        kapanisAt: s.kapanis_at, kapatan: s.kapatan, kapanisSebebi: s.kapanis_sebebi,
        faturaKesildiAt: s.fatura_kesildi_at, faturaNo: s.fatura_no,
        kalemSayisi: s.kalem_sayisi != null ? Number(s.kalem_sayisi) : undefined,
        adetToplam: s.adet_toplam != null ? Number(s.adet_toplam) : undefined,
    };
}
const kalemOf = (k) => ({
    id: k.id, urunId: k.urun_id, ad: k.urun_adi, kapak: k.kapak_yol, adet: k.adet,
    birimKurus: k.birim_fiyat_kurus, kdvOrani: k.kdv_orani, birimKdvDahilKurus: H.kdvDahilBirim(k.birim_fiyat_kurus, k.kdv_orani),
    tutarKurus: k.tutar_kurus, kdvKurus: k.kdv_kurus, toplamKurus: k.toplam_kurus,
});
const ozetSecimi = `s.*, (SELECT COUNT(*) FROM magaza_siparis_kalemleri k WHERE k.siparis_id = s.id) AS kalem_sayisi,
                    (SELECT COALESCE(SUM(adet), 0) FROM magaza_siparis_kalemleri k WHERE k.siparis_id = s.id) AS adet_toplam`;

async function ayrintiParcalari(id) {
    const kalemler = (await query('SELECT * FROM magaza_siparis_kalemleri WHERE siparis_id = ? ORDER BY sira', [id])).rows;
    const gecmis = (await query('SELECT olay, aciklama, kim, kim_ad, created_at FROM magaza_siparis_gecmisi WHERE siparis_id = ? ORDER BY id', [id])).rows;
    return { kalemler, gecmis };
}

// Isletme: fatura alanlari ve ic not HIC donmez.
async function isletmeListe(tenantId) {
    const r = await query(`SELECT ${ozetSecimi} FROM magaza_siparisler s WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 200`, [tenantId]);
    return r.rows.map(ozet);
}

async function isletmeAyrinti(id, tenantId) {
    const s = (await query(`SELECT ${ozetSecimi} FROM magaza_siparisler s WHERE s.id = ? AND s.tenant_id = ?`, [String(id), tenantId])).rows[0];
    if (!s) return null;
    const { kalemler, gecmis } = await ayrintiParcalari(s.id);
    const out = {
        ...ozet(s),
        kalemler: kalemler.map(kalemOf),
        teslimat: { alici: s.teslimat_alici, telefon: s.teslimat_telefon, adres: s.teslimat_adres },
        siparisNotu: s.siparis_notu,
        olusturanAd: s.olusturan_ad,
        odemeReferans: s.odeme_referans,
        kosullar: { kabulAt: s.kosullar_kabul_at, surum: s.kosullar_surum, metin: s.kosullar_metin },
        // FATURA olaylari root'un defter kaydi; isletmeye gosterilmez (fatura no ozet alaninda doner)
        gecmis: gecmis.filter(x => x.olay !== 'FATURA')
            .map(x => ({ olay: x.olay, aciklama: x.aciklama, kim: x.kim, zaman: x.created_at })),
    };
    if (s.durum === DURUM.ODEME_BEKLENIYOR) {
        out.odeme = { ...(await MA.odemeBilgisi()), odemeAciklamasi: noMetin(s.no) };
    }
    return out;
}

async function aktifSayisi(tenantId) {
    const r = await query(
        `SELECT COUNT(*) AS c FROM magaza_siparisler WHERE tenant_id = ? AND durum NOT IN ('TESLIM_EDILDI', 'IPTAL', 'REDDEDILDI')`, [tenantId]);
    return Number(r.rows[0].c) || 0;
}

// Root: liste + filtre sayilari
async function sayilar() {
    const r = await query('SELECT durum, COUNT(*) AS c, SUM(CASE WHEN odeme_bildirildi_at IS NOT NULL THEN 1 ELSE 0 END) AS b FROM magaza_siparisler GROUP BY durum');
    const d = Object.fromEntries(r.rows.map(x => [x.durum, Number(x.c) || 0]));
    const say = (l) => l.reduce((a, x) => a + (d[x] || 0), 0);
    const bildirilen = Number((r.rows.find(x => x.durum === DURUM.ODEME_BEKLENIYOR) || {}).b) || 0;
    return {
        hepsi: r.rows.reduce((a, x) => a + (Number(x.c) || 0), 0),
        bekleyen: say(FILTRE.bekleyen), odemeBildirilen: bildirilen,
        hazirlanacak: say(FILTRE.hazirlanacak), kargoda: say(FILTRE.kargoda),
        teslim: say(FILTRE.teslim), iptal: say(FILTRE.iptal),
        islemBekleyen: say([DURUM.ODEME_BEKLENIYOR, DURUM.ODEME_ALINDI, DURUM.HAZIRLANIYOR]),
    };
}

async function rootListe({ filtre, limit }) {
    const durumlar = Object.prototype.hasOwnProperty.call(FILTRE, filtre) ? FILTRE[filtre] : null;
    const n = Math.min(Math.max(Number(limit) || 300, 1), 1000);
    const r = await query(
        `SELECT ${ozetSecimi} FROM magaza_siparisler s
          ${durumlar ? `WHERE s.durum IN (${durumlar.map(() => '?').join(',')})` : ''}
          ORDER BY CASE WHEN s.durum = 'ODEME_BEKLENIYOR' AND s.odeme_bildirildi_at IS NOT NULL THEN 0 ELSE 1 END, s.created_at DESC
          LIMIT ?`, [...(durumlar || []), n]);
    return {
        siparisler: r.rows.map(s => ({ ...ozet(s), isletmeAdi: s.isletme_adi, isyeriKodu: s.isyeri_kodu, tenantId: s.tenant_id })),
        sayilar: await sayilar(),
    };
}

async function rootAyrinti(id) {
    const s = (await query(
        `SELECT ${ozetSecimi}, t.business_name AS guncel_ad, t.owner_email AS t_eposta, t.phone AS t_telefon
           FROM magaza_siparisler s LEFT JOIN tenants t ON t.id = s.tenant_id WHERE s.id = ?`, [String(id)])).rows[0];
    if (!s) return null;
    const { kalemler, gecmis } = await ayrintiParcalari(s.id);
    // KDV orana gore dagilim + kargo KDV ayrimi: Patron e-Arsiv faturasini bunlarla keser
    const dagilim = {};
    for (const k of kalemler) {
        const o = String(k.kdv_orani);
        dagilim[o] = dagilim[o] || { oran: k.kdv_orani, matrahKurus: 0, kdvKurus: 0 };
        dagilim[o].matrahKurus += k.tutar_kurus; dagilim[o].kdvKurus += k.kdv_kurus;
    }
    return {
        ...ozet(s),
        tenantId: s.tenant_id,
        isletme: { ad: s.isletme_adi, guncelAd: s.guncel_ad || null, kod: s.isyeri_kodu, eposta: s.t_eposta || null, telefon: s.t_telefon || null },
        olusturanAd: s.olusturan_ad,
        kalemler: kalemler.map(k => ({ ...kalemOf(k), stokAyrildi: k.stok_ayrildi })),
        kdvDagilimi: Object.values(dagilim),
        kargoAyrimi: H.kdvAyir(s.kargo_kurus),
        teslimat: { alici: s.teslimat_alici, telefon: s.teslimat_telefon, adres: s.teslimat_adres },
        fatura: { tip: s.fatura_tip, unvan: s.fatura_unvan, vergiDairesi: s.fatura_vergi_dairesi,
                  vergiNo: s.fatura_vergi_no, tcKimlikNo: s.fatura_tc_no, adres: s.fatura_adres },
        siparisNotu: s.siparis_notu, odemeReferans: s.odeme_referans, icNot: s.ic_not,
        kosullar: { kabulAt: s.kosullar_kabul_at, surum: s.kosullar_surum, metin: s.kosullar_metin },
        gecmis: gecmis.map(x => ({ olay: x.olay, aciklama: x.aciklama, kim: x.kim, kimAd: x.kim_ad, zaman: x.created_at })),
        gecisler: ROOT_GECIS[s.durum] || [],
    };
}

module.exports = {
    DURUM, DURUM_AD, KAPALI, ROOT_GECIS, ODEME_YONTEMLERI, ACIK_SIPARIS_SINIRI, FILTRE,
    sepetCoz, siparisOlustur, odemeBildir, isletmeIptal, durumDegistir, rootGuncelle,
    isletmeListe, isletmeAyrinti, aktifSayisi, rootListe, rootAyrinti, sayilar,
};
