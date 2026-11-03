const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');
const P = require('../services/paketServis');
const aksiyonServisi = require('../services/pazaryeriAksiyon');
const { hesabiKapatIc } = require('../services/hesapKapat');
const gunluk = require('../services/islemGunlugu');
const bus = require('../services/eventBus');

// --- PAKET SERVIS ekrani ---
// Telefon siparisi (channel 'PAKET_SERVIS') + pazaryeri siparisleri (marketplace/paketEsleme.js'te satiri olan
// her kanal; bugun SofraMix) tek listede. Temel paket: modul istemez.
// Okuma ve durum ilerletme kasa rollerine acik (sahip, mudur, kasiyer; mutfak ve garson YOK - route); iptal ve
// yerelde kapatma yalniz sahip/mudur (bos telefon siparisi iptali haric) ve islem gunlugune yazilir.

const YONETICI = ['OWNER', 'MANAGER'];

// --- Form ---
// teslimat: ADRES | GEL_AL, odemeSekli: kapida_nakit | kapida_kart, teslimatUcreti: TL (yalniz adrese teslimde)
// mevcutUcret: duzenlemede siparisteki teslimat ucreti (alan gelmezse korunur; gel-al'a geciste duser)
function formuOku(b, mevcut = {}, mevcutUcret = 0) {
    const al = (k, m) => (b[k] !== undefined ? String(b[k] == null ? '' : b[k]).trim() : (mevcut[m] || ''));
    const ad = al('musteriAd', 'musteri_ad').slice(0, 80);
    const telHam = al('musteriTel', 'musteri_tel');
    const adres = al('musteriAdres', 'musteri_adres').slice(0, 300);
    const not = al('not', 'note').slice(0, 300);
    const teslimat = String(b.teslimat !== undefined ? b.teslimat : (mevcut.delivery_mode === 'PICKUP' ? 'GEL_AL' : 'ADRES')).toUpperCase();
    const odeme = String(b.odemeSekli !== undefined ? b.odemeSekli : (mevcut.odeme_sekli || 'kapida_nakit'));

    if (!['ADRES', 'GEL_AL'].includes(teslimat)) return { hata: 'Teslimat şekli geçersiz (Adrese ya da Gel-al).' };
    if (!P.TELEFON_ODEME.includes(odeme)) return { hata: 'Ödeme şekli geçersiz (Kapıda nakit ya da Kapıda kart).' };
    // Telefon: rakam, bosluk, +, -, parantez; en az 7 rakam
    if (telHam && !/^[0-9+()\-\s]{7,25}$/.test(telHam)) return { hata: 'Telefon numarası geçersiz.' };
    if (telHam && telHam.replace(/\D/g, '').length < 7) return { hata: 'Telefon numarası çok kısa.' };
    if (!ad && !telHam) return { hata: 'Müşteri adı ya da telefonu yazın.' };
    if (teslimat === 'ADRES' && !adres) return { hata: 'Adrese teslim için adres yazın.' };
    let ucret;
    if (b.teslimatUcreti === undefined || b.teslimatUcreti === null || b.teslimatUcreti === '') {
        ucret = teslimat === 'GEL_AL' ? 0 : Number(mevcutUcret) || 0;
    } else {
        ucret = Number(String(b.teslimatUcreti).replace(',', '.'));
        if (!Number.isFinite(ucret) || ucret < 0 || ucret > 10000) return { hata: 'Teslimat ücreti 0 ile 10.000 ₺ arasında olmalı.' };
        ucret = P.r2(ucret);
        if (teslimat === 'GEL_AL' && ucret > 0) return { hata: 'Gel-al siparişinde teslimat ücreti olmaz.' };
    }
    return {
        ad: ad || null, tel: telHam || null, adres: adres || null, not: not || null,
        teslimat, deliveryMode: teslimat === 'GEL_AL' ? 'PICKUP' : 'RESTAURANT_COURIER', odeme, ucret,
    };
}

// Teslimat ucreti kalemini sipariste tek satir olarak tutar: yoksa ekler, degistiyse gunceller, 0 ise siler.
// Odemesi (kalem bazli) alinmis ucret degistirilemez: once o odeme silinmeli. tx ICINDE cagrilir.
async function teslimatUcretiYazIc(orderId, ucret) {
    const k = (await query(`SELECT id, total, COALESCE(paid_qty, 0) AS paid_qty FROM order_items WHERE order_id = ? AND source = ?`,
        [orderId, P.TESLIMAT_KAYNAK])).rows;
    const mevcut = P.r2(k.reduce((s, x) => s + Number(x.total || 0), 0));
    if (Math.abs(mevcut - ucret) < 0.005 && k.length <= 1) return false;
    if (k.some((x) => Number(x.paid_qty) > 0)) {
        const e = new Error('Teslimat ücretinin ödemesi alınmış; değiştirmek için önce o ödemeyi silin.'); e.status = 409; throw e;
    }
    await query('DELETE FROM order_items WHERE order_id = ? AND source = ?', [orderId, P.TESLIMAT_KAYNAK]);
    if (ucret > 0) {
        await query(
            `INSERT INTO order_items (id, order_id, product_id, product_name, qty, unit_price, total, status, source, served_at)
             VALUES (?, ?, NULL, ?, 1, ?, ?, 'SERVED', ?, CURRENT_TIMESTAMP)`,
            [uuidv4(), orderId, P.TESLIMAT_KALEM_ADI, ucret, ucret, P.TESLIMAT_KAYNAK]);
    }
    const s = Number((await query('SELECT COALESCE(SUM(total), 0) AS s FROM order_items WHERE order_id = ?', [orderId])).rows[0].s);
    await query('UPDATE orders SET subtotal = ?, total = ? WHERE id = ?', [s, s, orderId]);
    return true;
}
const urunSayisi = async (orderId) => Number((await query(
    'SELECT COUNT(*) AS c FROM order_items WHERE order_id = ? AND COALESCE(source, \'\') != ?', [orderId, P.TESLIMAT_KAYNAK])).rows[0].c);

// GET /api/paket -> acik siparislerin HEPSI + bugun (Istanbul) kapanan/iptal edilenler (son 300) + bugun platformla
// celiskisi ortaya cikan (eski gunde kapanmis olsa da: kartta rozet gorunsun)
exports.liste = async (req, res) => {
    const acik = await query(
        `SELECT o.* FROM orders o WHERE o.tenant_id = ? AND ${P.paketKosulu()} AND o.status = 'OPEN'
          ORDER BY o.opened_at`, [req.user.tenantId]);
    const biten = await query(
        `SELECT o.* FROM orders o
          WHERE o.tenant_id = ? AND ${P.paketKosulu()}
            AND o.status IN ('CLOSED', 'CANCELLED')
            AND (COALESCE(o.closed_at, o.opened_at) >= ? OR o.platform_celiski_at >= ?)
          ORDER BY COALESCE(o.closed_at, o.opened_at) DESC
          LIMIT 300`,
        [req.user.tenantId, P.istanbulGunBasiUtc(), P.istanbulGunBasiUtc()]);
    const siparisler = await P.gorunumler([...acik.rows, ...biten.rows]);
    // Sira: acik olanlar once (yeni gelen pazaryeri siparisi en ustte, sonra en eski acilan), bitenler en son kapanan ustte
    siparisler.sort((a, b) => {
        const ga = a.durum === 'OPEN' ? 0 : 1, gb = b.durum === 'OPEN' ? 0 : 1;
        if (ga !== gb) return ga - gb;
        if (ga === 0) {
            if (a.dikkat !== b.dikkat) return a.dikkat ? -1 : 1;
            return String(a.acilis).localeCompare(String(b.acilis));
        }
        return String(b.kapanis || '').localeCompare(String(a.kapanis || ''));
    });
    const sayac = { aktif: 0, hazirlaniyor: 0, yolda: 0, odeme: 0, bugun: 0 };
    for (const s of siparisler) {
        sayac[s.grup]++;
        if (s.durum === 'OPEN') sayac.aktif++;
    }
    res.json({ siparisler, sayac, sunucuSaati: new Date().toISOString() });
};

// GET /api/paket/:id
exports.getir = async (req, res) => {
    const o = await P.paketSatiri(req.params.id, req.user.tenantId);
    if (!o) return res.status(404).json({ message: 'Paket siparişi bulunamadı.' });
    res.json((await P.gorunumler([o]))[0]);
};

// POST /api/paket -> telefon siparisi ac (urunler sonra masadaki ekranla eklenir)
exports.olustur = async (req, res) => {
    const f = formuOku(req.body || {});
    if (f.hata) return res.status(400).json({ message: f.hata });
    const tenantId = req.user.tenantId;
    const id = uuidv4();
    const gun = P.istanbulGunu();
    await tx(async () => {
        // Gunluk artan no: yazma kilidi altinda (tx) MAX+1, UNIQUE indeks ikinci savunma
        const n = Number((await query(
            `SELECT COALESCE(MAX(paket_no), 0) + 1 AS n FROM orders
              WHERE tenant_id = ? AND paket_gunu = ? AND paket_no IS NOT NULL`, [tenantId, gun])).rows[0].n);
        await query(
            `INSERT INTO orders (id, tenant_id, table_id, channel, status, note, opened_by,
                                 paket_no, paket_gunu, paket_durum, musteri_ad, musteri_tel, musteri_adres,
                                 odeme_sekli, delivery_mode)
             VALUES (?, ?, NULL, ?, 'OPEN', ?, ?, ?, ?, 'HAZIRLANIYOR', ?, ?, ?, ?, ?)`,
            [id, tenantId, P.PAKET, f.not, req.user.id, n, gun, f.ad, f.tel, f.adres, f.odeme, f.deliveryMode]);
        if (f.ucret > 0) await teslimatUcretiYazIc(id, f.ucret);
        // Musteri defteri: bir sonraki sipariste telefon yazilinca ad/adres kendiliginden gelsin
        if (f.tel) await P.defterYaz({ tenantId, tel: f.tel, ad: f.ad, adres: f.adres, yeniSiparis: true });
    });
    const v = (await P.gorunumler([await P.paketSatiri(id, tenantId)]))[0];
    // Kasaya bilgi (tek ses, zil yok). Acan kisinin kendi ekraninda uyari cikmaz (byUserId).
    // Kisisel veri olaya KONMAZ: mutfak tableti ve garson telefonu da bu akisi dinliyor.
    bus.emit(tenantId, 'paket_siparis', {
        orderId: id, kaynak: 'TELEFON', etiket: v.etiket, teslimat: v.teslimat,
        byUserId: req.user.id, by: req.user.name || req.user.email,
    });
    res.status(201).json(v);
};

// PUT /api/paket/:id -> musteri bilgisi / teslimat / odeme sekli (yalniz telefon siparisi, hazirlanirken)
exports.guncelle = async (req, res) => {
    const o = await P.paketSatiri(req.params.id, req.user.tenantId);
    if (!o) return res.status(404).json({ message: 'Paket siparişi bulunamadı.' });
    if (o.channel !== P.PAKET) return res.status(409).json({ message: `${P.kanalAdi(o.channel)} siparişinin müşteri bilgileri platformdan gelir, burada değiştirilemez.` });
    if (o.status !== 'OPEN') return res.status(409).json({ message: 'Sipariş kapanmış; bilgiler değiştirilemez.' });
    if ((o.paket_durum || 'HAZIRLANIYOR') !== 'HAZIRLANIYOR') {
        return res.status(409).json({ message: 'Sipariş yola çıktıktan (ya da hazır olduktan) sonra bilgiler değiştirilemez.' });
    }
    const mevcutUcret = Number((await query('SELECT COALESCE(SUM(total), 0) AS s FROM order_items WHERE order_id = ? AND source = ?',
        [o.id, P.TESLIMAT_KAYNAK])).rows[0].s);
    const f = formuOku(req.body || {}, o, mevcutUcret);
    if (f.hata) return res.status(400).json({ message: f.hata });
    try {
        await tx(async () => {
            const u = await query(
                `UPDATE orders SET musteri_ad = ?, musteri_tel = ?, musteri_adres = ?, note = ?, odeme_sekli = ?, delivery_mode = ?
                  WHERE id = ? AND tenant_id = ? AND status = 'OPEN' AND COALESCE(paket_durum, 'HAZIRLANIYOR') = 'HAZIRLANIYOR'`,
                [f.ad, f.tel, f.adres, f.not, f.odeme, f.deliveryMode, o.id, req.user.tenantId]);
            if (!u.changes) { const e = new Error('Sipariş bu arada ilerledi; ekranı yenileyin.'); e.status = 409; throw e; }
            await teslimatUcretiYazIc(o.id, f.ucret);
            // Ucret dusurulunce / gel-al'a gecince toplam alinan odemenin altina inerse hesap bir daha kapanamaz
            // (odeme = toplam sarti): degisiklik geri alinir.
            const yeni = Number((await query('SELECT total FROM orders WHERE id = ?', [o.id])).rows[0].total || 0);
            const odenen = Number((await query('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE order_id = ?', [o.id])).rows[0].s);
            if (odenen - yeni > 0.01) {
                const e = new Error(`Bu siparişte ${P.TL(odenen)} ödeme alınmış; değişiklikle toplam ${P.TL(yeni)} olur ve ödenenin altına iner. `
                    + 'Önce fazla ödemeyi silin (yönetici), sonra tekrar deneyin.');
                e.status = 409; throw e;
            }
            // Defter: numara degistiyse eski numaranin bu siparisle acilan kaydi geri alinir, yenisi yazilir.
            // Numara ayniysa yalniz VAR OLAN kayit guncellenir ("Musteriyi unut" sonrasi geri gelmesin).
            const eskiNorm = P.telNorm(o.musteri_tel), yeniNorm = P.telNorm(f.tel);
            if (eskiNorm !== yeniNorm) {
                if (eskiNorm) await P.defterGeriAl(req.user.tenantId, o.musteri_tel);
                if (yeniNorm) await P.defterYaz({ tenantId: req.user.tenantId, tel: f.tel, ad: f.ad, adres: f.adres, yeniSiparis: true });
            } else if (yeniNorm) {
                await P.defterYaz({ tenantId: req.user.tenantId, tel: f.tel, ad: f.ad, adres: f.adres, yalnizVarsa: true });
            }
        });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ message: e.message });
        throw e;
    }
    res.json((await P.gorunumler([await P.paketSatiri(o.id, req.user.tenantId)]))[0]);
};

// --- Musteri defteri ---
// POST /api/paket/musteri/bul { tel } -> { musteri } (yoksa null). Yalniz bu isletmenin telefon siparislerinden.
// Telefon GOVDEDE: adres satirinda (sunucu / vekil kayitlarinda) kisisel veri tasinmasin.
exports.musteriBul = async (req, res) => {
    const v = await P.defterBul(req.user.tenantId, (req.body || {}).tel);
    res.json({ musteri: P.defterGorunum(v) });
};

// POST /api/paket/musteri/:id/unut  (KVKK silme talebi; yalniz sahip/mudur - route)
exports.musteriUnut = async (req, res) => {
    const r = await require('../services/paketKvkk').musteriyiUnut(req.user.tenantId, req.params.id);
    if (!r) return res.status(404).json({ message: 'Müşteri kaydı bulunamadı.' });
    // Gunluge kisisel veri YAZILMAZ (telefon/ad yok): yalniz kim, ne zaman, kac siparis
    await gunluk.kaydet({
        tenantId: req.user.tenantId, user: req.user, islem: 'musteri_unut', hedefTur: 'paket_musteri', hedefId: req.params.id,
        detay: `Müşteri defter kaydı silindi (KVKK talebi) - ${r.silinenSiparis} siparişte kişisel bilgi silindi`
            + (r.acikSiparis ? ` - ${r.acikSiparis} açık sipariş teslim için bilgisini korudu` : ''),
    });
    res.json({ ok: true, ...r });
};

const izinliMi = (o, kod) => P.aksiyonlarOf(o).some((a) => a.kod === kod);
function aksiyonHatasiGonder(res, e) {
    if (e instanceof aksiyonServisi.AksiyonHatasi) {
        return res.status(e.status).json({ message: e.message, yetkiSorunu: !!e.yetkiSorunu });
    }
    throw e;
}

// Telefon siparisinde durum ilerletme: yolda | hazir | teslim
async function telefonAksiyon(req, res, o, kod) {
    if (kod === 'iptal') return res.status(400).json({ message: 'İptal için "İptal et" düğmesini kullanın.' });
    if (!izinliMi(o, kod)) {
        const asama = P.asamaOf(o);
        return res.status(409).json({ message: `Bu sipariş şu an "${P.ASAMA_ETIKET[asama] || asama}" aşamasında; `
            + `"${P.AKSIYON_ETIKET[kod] || kod}" yapılamaz. Ekranı yenileyin.` });
    }
    if ((kod === 'yolda' || kod === 'hazir') && !(await urunSayisi(o.id))) {
        return res.status(409).json({ message: 'Siparişte ürün yok; önce ürün ekleyin.' });
    }
    let kapandi = false;
    try {
        await tx(async () => {
            const hedef = { yolda: 'YOLDA', hazir: 'HAZIR', teslim: 'TESLIM' }[kod];
            const damga = { yolda: 'yola_cikti_at', hazir: 'hazir_at', teslim: 'teslim_at' }[kod];
            const onceki = kod === 'teslim' ? ['YOLDA', 'HAZIR'] : ['HAZIRLANIYOR'];
            // Atomik: iki kasa ayni anda basarsa ikincisi 409 alir
            const u = await query(
                `UPDATE orders SET paket_durum = ?, ${damga} = CURRENT_TIMESTAMP
                  WHERE id = ? AND status = 'OPEN' AND COALESCE(paket_durum, 'HAZIRLANIYOR') IN (${onceki.map(() => '?').join(',')})`,
                [hedef, o.id, ...onceki]);
            if (!u.changes) { const e = new Error('Sipariş bu arada ilerledi; ekranı yenileyin.'); e.status = 409; throw e; }
            if (kod === 'yolda' || kod === 'teslim') await P.mutfakKalemleriniKapat(o.id);
            if (kod === 'teslim') {
                // Odeme onceden tamamlandiysa (online / kapida alinip girildiyse) hesap kendiliginden kapanir.
                const t = (await query('SELECT total FROM orders WHERE id = ?', [o.id])).rows[0];
                const odenen = Number((await query('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE order_id = ?', [o.id])).rows[0].s);
                const toplam = Number(t.total || 0);
                if (toplam > 0 && Math.abs(odenen - toplam) <= 0.01) {
                    await hesabiKapatIc({ orderId: o.id, tenantId: req.user.tenantId, userId: req.user.id, tableId: null });
                    kapandi = true;
                }
            }
        });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ message: e.message });
        throw e;
    }
    const v = (await P.gorunumler([await P.paketSatiri(o.id, req.user.tenantId)]))[0];
    res.json({ ok: true, kapandi, siparis: v });
}

// POST /api/paket/:id/aksiyon { aksiyon, sebep? }
exports.aksiyon = async (req, res) => {
    const o = await P.paketSatiri(req.params.id, req.user.tenantId);
    if (!o) return res.status(404).json({ message: 'Paket siparişi bulunamadı.' });
    const kod = String((req.body || {}).aksiyon || '');
    if (o.channel === P.PAKET) return telefonAksiyon(req, res, o, kod);
    if (kod === 'iptal') return res.status(400).json({ message: 'İptal için "İptal et" düğmesini kullanın.' });
    try {
        const r = await aksiyonServisi.uygula({
            tenantId: req.user.tenantId, orderId: o.id, aksiyon: kod, sebep: (req.body || {}).sebep, user: req.user, izinliMi,
        });
        const v = (await P.gorunumler([await P.paketSatiri(o.id, req.user.tenantId)]))[0];
        res.json({ ok: true, durum: r.durum, otoOdeme: r.otoOdeme, kapandi: v.durum === 'CLOSED', siparis: v });
    } catch (e) { return aksiyonHatasiGonder(res, e); }
};

// POST /api/paket/:id/iptal { sebep }
// Yalniz sahip/mudur. Istisna: hic urunu ve odemesi olmayan telefon siparisini (yanlislikla acilmis) kasiyer de siler.
exports.iptal = async (req, res) => {
    const o = await P.paketSatiri(req.params.id, req.user.tenantId);
    if (!o) return res.status(404).json({ message: 'Paket siparişi bulunamadı.' });
    if (o.status !== 'OPEN') return res.status(409).json({ message: 'Bu sipariş zaten kapanmış ya da iptal edilmiş.' });
    const sebep = String((req.body || {}).sebep || '').trim().slice(0, 300);
    const yonetici = YONETICI.includes(req.user.role);

    if (o.channel === P.PAKET) {
        const kalem = await urunSayisi(o.id);   // teslimat ucreti urun sayilmaz
        const odenen = Number((await query('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE order_id = ?', [o.id])).rows[0].s);
        const bos = kalem === 0 && odenen === 0;
        if (!yonetici && !bos) {
            return res.status(403).json({ message: 'Paket siparişini yalnız işletme sahibi ya da müdür iptal edebilir.' });
        }
        const u = await query(
            `UPDATE orders SET status = 'CANCELLED', closed_at = CURRENT_TIMESTAMP, cancelled_by = ?
              WHERE id = ? AND tenant_id = ? AND status = 'OPEN'`, [req.user.id, o.id, req.user.tenantId]);
        if (!u.changes) return res.status(409).json({ message: 'Bu sipariş zaten kapanmış ya da iptal edilmiş.' });
        await gunluk.kaydet({
            tenantId: req.user.tenantId, user: req.user, islem: 'siparis_iptal', hedefTur: 'order', hedefId: o.id,
            detay: `${P.paketEtiketi(o)} - ${P.TL(o.total)}${bos ? ' - boş sipariş' : ''}${odenen ? ' - alınmış ödeme ' + P.TL(odenen) : ''}${sebep ? ' - ' + sebep : ''}`,
        });
        return res.json({ ok: true });
    }

    const ad = P.kanalAdi(o.channel);
    if (!yonetici) return res.status(403).json({ message: `${ad} siparişini yalnız işletme sahibi ya da müdür iptal edebilir.` });
    if (!izinliMi(o, 'iptal') && ['YOLDA', 'HAZIR'].includes(P.asamaOf(o))) {
        // Platform kurali (gecis matrisinde iptal yok); bildirim yolu varsa onu goster
        const bildirim = P.aksiyonlarOf({ ...o, teslim_sorunu_at: null }).some((a) => a.kod === 'teslim_edilemedi');
        return res.status(409).json({ message: `Yola çıkmış ya da hazır ${ad} siparişi iptal edilemez (${ad} kuralı).`
            + (bildirim ? ` Müşteriye ulaşılamadıysa "Teslim edilemedi" bildirin; kararı ${ad} verir.` : '') });
    }
    try {
        await aksiyonServisi.uygula({ tenantId: req.user.tenantId, orderId: o.id, aksiyon: 'iptal', sebep, user: req.user, izinliMi });
        return res.json({ ok: true });
    } catch (e) { return aksiyonHatasiGonder(res, e); }
};

// POST /api/paket/:id/yerel-kapat { sonuc: 'TESLIM' | 'IPTAL', sebep }   (yalniz sahip/mudur - route)
// YALNIZ TAKILMIS pazaryeri siparisi icin (P.takilmaOf: kanal bagli degil / son platform islemi hata aldi /
// TAKILMA_SAAT saattir platformda degismedi): saglikli kanalda kisayol olursa platform ile POS sessizce ayrisir.
// Platforma GITMEZ. TESLIM: kapanir, eksik odeme platformun bildirdigi yontemle yazilir (ciro ve gun sonu
// tutar). IPTAL: iptal sayilir, ciroya girmez. Sebep zorunlu, islem gunlugune yazilir; musteri bilgisi 30 gun
// sonra silinir (normal kural). Platformdan sonra gelen olay bu kapanisi DEGISTIRMEZ; celisirse siparise
// celiski damgasi + gunluk kaydi duser (ingest), ciro/odeme kendiliginden degismez.
exports.yerelKapat = async (req, res) => {
    const o = await P.paketSatiri(req.params.id, req.user.tenantId);
    if (!o) return res.status(404).json({ message: 'Paket siparişi bulunamadı.' });
    if (o.channel === P.PAKET) return res.status(400).json({ message: 'Telefon siparişinde "Teslim edildi" ya da "İptal et" kullanın.' });
    if (o.status !== 'OPEN') return res.status(409).json({ message: 'Bu sipariş zaten kapanmış ya da iptal edilmiş.' });
    const takilma = P.takilmaOf(o, await P.kanalBaglantilari(req.user.tenantId));
    if (!takilma) {
        const ad = P.kanalAdi(o.channel);
        return res.status(409).json({ code: 'TAKILMA_YOK',
            message: `Bu sipariş ${ad} ile eşleşiyor; işlemi karttaki düğmelerle yapın (platforma da gider). "Yerelde kapat" yalnız `
                + `${ad} bağlantısı koptuğunda, son platform işlemi hata verdiğinde ya da sipariş ${P.TAKILMA_SAAT} saattir ${ad} tarafında değişmediğinde açılır.` });
    }
    const sonuc = String((req.body || {}).sonuc || '').toUpperCase();
    if (!['TESLIM', 'IPTAL'].includes(sonuc)) return res.status(400).json({ message: 'Sonucu seçin: teslim edildi mi, iptal mi?' });
    const sebep = String((req.body || {}).sebep || '').trim().slice(0, 300);
    if (sebep.length < 10) return res.status(400).json({ message: 'Sebep yazın (en az 10 karakter); işlem günlüğüne yazılır.' });
    const durum = sonuc === 'TESLIM' ? 'CLOSED' : 'CANCELLED';
    let otoOdeme = 0;
    try {
        await tx(async () => {
            const u = await query(
                `UPDATE orders SET status = ?, closed_at = CURRENT_TIMESTAMP,
                        teslim_at = CASE WHEN ? = 'CLOSED' THEN COALESCE(teslim_at, CURRENT_TIMESTAMP) ELSE teslim_at END,
                        cancelled_by = CASE WHEN ? = 'CANCELLED' THEN ? ELSE cancelled_by END
                  WHERE id = ? AND tenant_id = ? AND status = 'OPEN'`,
                [durum, durum, durum, req.user.id, o.id, req.user.tenantId]);
            if (!u.changes) { const e = new Error('Bu sipariş zaten kapanmış ya da iptal edilmiş.'); e.status = 409; throw e; }
            await P.mutfakKalemleriniKapat(o.id);
            if (durum === 'CLOSED') otoOdeme = await P.otoOdemeYazIc(o.id);
        });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ message: e.message });
        throw e;
    }
    await gunluk.kaydet({
        tenantId: req.user.tenantId, user: req.user, islem: 'yerel_kapat', hedefTur: 'order', hedefId: o.id,
        detay: `${P.paketEtiketi(o)} - ${P.TL(o.total)} - ${sonuc === 'TESLIM' ? 'teslim edildi sayıldı' : 'iptal sayıldı'} `
            + `(platforma iletilmedi; neden: ${P.TAKILMA_NEDEN[takilma.kod] || takilma.kod}) - ${sebep}`,
    });
    res.json({ ok: true, otoOdeme, siparis: (await P.gorunumler([await P.paketSatiri(o.id, req.user.tenantId)]))[0] });
};

exports._ic = { formuOku };
