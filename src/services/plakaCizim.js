const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { UPLOADS_DIR } = require('./imageService');

// --- Masa plakasi cizimi: TEK yerlesim, iki cikti ---
//
// plakaYerlesimi() plakanin butun ogelerini milimetre cinsinden hesaplar. Ayni yerlesim:
//   - baski PDF'ine (pdfkit, vektor karekod, gomulu Inter yazi tipi) ve
//   - isletmenin canli onizlemesine (JSON -> tarayicida SVG)
// gider. Boylece onizleme baski dosyasiyla birebir aynidir.
//
// TASARIM (reklam videosu da bunu ciziyor; degisirse raporla bildirilir). 80x80 mm kare:
//   zemin beyaz, onizlemede kose yaricapi 4 mm
//   logo kutusu  : x 15-65, y 4-20 (en cok 50 x 16 mm), logo kutuya orantili sigdirilir, ortalanir
//   karekod      : x 19-61, y 20,5-62,5 (42 x 42 mm, 4 modul sessiz alan DAHIL), %100 siyah
//   masa adi     : ortali, taban cizgisi y 67,5, 6 mm kalin (sigmazsa kuculur, en az 3,8 mm)
//   alt cumle    : ortali, taban y 72,2, 3 mm ("Menü için okutun" / TAM + siparis acik: "Menü ve sipariş için okutun")
//   web          : ortali, taban y 75,7, 2 mm gri "mdayazilim.com"
// 70x70 ayni tasarimin 0,875 katidir. 100x70 yatay: karekod solda, logo + yazilar sagda.
// Yazi tipi: Inter (SIL OFL 1.1), src/assets/fonts. Turkce harflerin tamami var.

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONT = { R: path.join(FONT_DIR, 'Inter-Regular.ttf'), B: path.join(FONT_DIR, 'Inter-Bold.ttf') };
const MM = 72 / 25.4;
const mm = (v) => v * MM;

// Renkler: PDF'te CMYK (baski), onizlemede karsiligi olan RGB
const RENK = {
    siyah: { cmyk: [0, 0, 0, 100], hex: '#000000' },
    koyu: { cmyk: [0, 0, 0, 92], hex: '#141414' },
    orta: { cmyk: [0, 0, 0, 78], hex: '#383838' },
    gri: { cmyk: [0, 0, 0, 48], hex: '#858585' },
    zemin: { cmyk: [0, 0, 0, 0], hex: '#FFFFFF' },
};

const OLCU = {
    '80x80': { gen: 80, yuk: 80, yon: 'kare', k: 1 },
    '70x70': { gen: 70, yuk: 70, yon: 'kare', k: 70 / 80 },
    '100x70': { gen: 100, yuk: 70, yon: 'yatay', k: 1 },
};
const TASMA = 3;      // mm taşma payı
const KENAR = 8;      // mm kesim isareti alani (tasmanin disinda)
const KOSE = 4;       // mm onizleme kose yaricapi
const WEB_METNI = 'mdayazilim.com';

// --- Yazi olcumu (fontkit; pdfkit de ayni kutuphaneyi kullanir) ---
let _fk = null;
function fontlar() {
    if (_fk) return _fk;
    const fontkit = require('fontkit');
    _fk = { R: fontkit.openSync(FONT.R), B: fontkit.openSync(FONT.B) };
    return _fk;
}
function metinGenisligi(metin, punto, kalin) {
    const f = fontlar()[kalin ? 'B' : 'R'];
    return f.layout(String(metin)).advanceWidth / f.unitsPerEm * punto;
}
// Sigdir: once kucult (en az minPunto), yine sigmazsa sonuna "…" koyarak kisalt
function sigdir(metin, punto, kalin, maxGen, minPunto) {
    let s = String(metin || '').replace(/\s+/g, ' ').trim();
    let p = punto;
    while (p > minPunto && metinGenisligi(s, p, kalin) > maxGen) p = Math.max(minPunto, Math.round((p - 0.1) * 100) / 100);
    if (metinGenisligi(s, p, kalin) <= maxGen) return { metin: s, punto: p };
    while (s.length > 1 && metinGenisligi(s + '…', p, kalin) > maxGen) s = s.slice(0, -1).trimEnd();
    return { metin: s + '…', punto: p };
}

// --- Karekod: modul matrisi -> yatay kosu listesi (vektor cizim) ---
// Hata duzeltme Q tercih edilir; adres uzun olup surum 4'u asarsa (moduller 42 mm'de 1 mm'nin altina
// inerse) M'ye dusulur.
function karekod(adres) {
    let q = QRCode.create(adres, { errorCorrectionLevel: 'Q' });
    if (q.version > 4) q = QRCode.create(adres, { errorCorrectionLevel: 'M' });
    const n = q.modules.size;
    const kosular = [];
    for (let r = 0; r < n; r++) {
        let bas = -1;
        for (let c = 0; c <= n; c++) {
            const koyu = c < n && q.modules.get(r, c);
            if (koyu && bas < 0) bas = c;
            if (!koyu && bas >= 0) { kosular.push([r, bas, c - bas]); bas = -1; }
        }
    }
    const seviye = q.errorCorrectionLevel && q.errorCorrectionLevel.bit === 3 ? 'Q' : 'M';
    return { n, kosular, surum: q.version, seviye };
}

// --- Logo: yalniz bu isletmenin /uploads klasorunden PNG ya da JPEG ---
function gorselBoyutu(buf) {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        return { tur: 'png', gen: buf.readUInt32BE(16), yuk: buf.readUInt32BE(20) };
    }
    if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
        let i = 2;
        while (i + 9 < buf.length) {
            if (buf[i] !== 0xFF) { i++; continue; }
            const m = buf[i + 1];
            if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
            const uz = buf.readUInt16BE(i + 2);
            if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
                return { tur: 'jpeg', yuk: buf.readUInt16BE(i + 5), gen: buf.readUInt16BE(i + 7) };
            }
            i += 2 + uz;
        }
        return { tur: 'jpeg', gen: 0, yuk: 0 };
    }
    if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { tur: 'webp', gen: 0, yuk: 0 };
    return { tur: 'bilinmiyor', gen: 0, yuk: 0 };
}

// Doner: null (logo yok) | { url, buf, tur, gen, yuk, uygun, uyari }
function logoYukle(tenantId, logoUrl) {
    if (!logoUrl) return null;
    const onek = `/uploads/${tenantId}/`;
    if (!String(logoUrl).startsWith(onek)) {
        return { url: logoUrl, buf: null, tur: 'bilinmiyor', gen: 0, yuk: 0, uygun: false,
            uyari: 'Logo baskı dosyasına alınamadı. Ayarlar > Logo bölümünden PNG ya da JPEG logo yükleyin.' };
    }
    const dosya = path.join(UPLOADS_DIR, tenantId, path.basename(String(logoUrl)));
    let buf;
    try { buf = fs.readFileSync(dosya); } catch (_) {
        return { url: logoUrl, buf: null, tur: 'yok', gen: 0, yuk: 0, uygun: false,
            uyari: 'Logo dosyası bulunamadı. Ayarlar > Logo bölümünden logoyu yeniden yükleyin.' };
    }
    const b = gorselBoyutu(buf);
    if (b.tur !== 'png' && b.tur !== 'jpeg') {
        return { url: logoUrl, buf: null, tur: b.tur, gen: 0, yuk: 0, uygun: false,
            uyari: 'Logo biçimi baskıya uygun değil. Ayarlar > Logo bölümünden PNG ya da JPEG logo yükleyin.' };
    }
    if (!b.gen || !b.yuk) {
        return { url: logoUrl, buf: null, tur: b.tur, gen: 0, yuk: 0, uygun: false,
            uyari: 'Logo okunamadı. Ayarlar > Logo bölümünden logoyu yeniden yükleyin.' };
    }
    const uzun = Math.max(b.gen, b.yuk);
    return { url: logoUrl, buf, tur: b.tur, gen: b.gen, yuk: b.yuk, uzunKenar: uzun, uygun: true,
        uyari: uzun < 600 ? 'Baskı için daha büyük logo yükleyin (uzun kenarı en az 600 piksel).' : null };
}

// Kutunun icine orantili sigdir, ortala
function sigdirKutu(gen, yuk, k) {
    const s = Math.min(k.w / gen, k.h / yuk);
    const w = gen * s, h = yuk * s;
    return { x: k.x + (k.w - w) / 2, y: k.y + (k.h - h) / 2, w, h };
}

// Logo yoksa isletme adi (en cok 2 satir) logo kutusuna yazilir
function adKutusu(isletmeAdi, k, ol) {
    const ad = String(isletmeAdi || '').replace(/\s+/g, ' ').trim() || 'İşletme';
    const tek = sigdir(ad, 5 * ol, true, k.w, 3.6 * ol);
    if (!tek.metin.endsWith('…')) {
        return [{ tur: 'metin', metin: tek.metin, x: k.x + k.w / 2, y: k.y + k.h / 2 + 0.36 * tek.punto, punto: tek.punto, kalin: true, renk: 'koyu' }];
    }
    // iki satira bol: ortaya en yakin bosluktan
    const kel = ad.split(' ');
    let enIyi = 1, fark = Infinity;
    for (let i = 1; i < kel.length; i++) {
        const a = kel.slice(0, i).join(' ').length, b = kel.slice(i).join(' ').length;
        if (Math.abs(a - b) < fark) { fark = Math.abs(a - b); enIyi = i; }
    }
    const s1 = sigdir(kel.slice(0, enIyi).join(' '), 4.2 * ol, true, k.w, 3.2 * ol);
    const s2 = sigdir(kel.slice(enIyi).join(' ') || '', 4.2 * ol, true, k.w, 3.2 * ol);
    const p = Math.min(s1.punto, s2.punto);
    const satir = p * 1.18;
    const orta = k.y + k.h / 2;
    return [
        { tur: 'metin', metin: s1.metin, x: k.x + k.w / 2, y: orta - satir / 2 + 0.36 * p, punto: p, kalin: true, renk: 'koyu' },
        { tur: 'metin', metin: s2.metin, x: k.x + k.w / 2, y: orta + satir / 2 + 0.36 * p, punto: p, kalin: true, renk: 'koyu' },
    ];
}

// --- Yerlesim (mm, kesim cizgisine gore; sol ust kose 0,0) ---
// girdi: { olcu, logo (logoYukle sonucu|null), isletmeAdi, masaAdi, altMetin, adres }
function plakaYerlesimi({ olcu, logo, isletmeAdi, masaAdi, altMetin, adres }) {
    const O = OLCU[olcu] || OLCU['80x80'];
    const qr = karekod(adres);
    const ogeler = [];
    let logoKutu, qrKutu, metinX, metinMax, taban;

    if (O.yon === 'kare') {
        const k = O.k;
        logoKutu = { x: 15 * k, y: 4 * k, w: 50 * k, h: 16 * k };
        qrKutu = { x: 19 * k, y: 20.5 * k, boyut: 42 * k };
        metinX = 40 * k; metinMax = 68 * k;
        taban = { masa: 67.5 * k, alt: 72.2 * k, web: 75.7 * k, masaP: 6 * k, masaMin: 3.8 * k, altP: 3 * k, altMin: 2.2 * k, webP: 2 * k };
    } else {
        // 100 x 70 yatay: karekod solda dikey ortali (y 14-56); sag sutun (x 55-95) karekodun koyu
        // alaniyla hizali: logo ustte (40 x 14 mm), web yazisi karekodun alt kenarinda.
        logoKutu = { x: 55, y: 18, w: 40, h: 14 };
        qrKutu = { x: 6, y: 14, boyut: 42 };
        metinX = 75; metinMax = 40;
        taban = { masa: 40, alt: 45.2, web: 51.9, masaP: 6, masaMin: 3.8, altP: 3, altMin: 2.2, webP: 2 };
    }
    const ol = O.k;

    // Logo ya da isletme adi
    if (logo && logo.uygun) {
        const r = sigdirKutu(logo.gen, logo.yuk, logoKutu);
        ogeler.push({ tur: 'logo', url: logo.url, x: r.x, y: r.y, w: r.w, h: r.h });
    } else {
        ogeler.push(...adKutusu(isletmeAdi, logoKutu, ol));
    }

    // Karekod (4 modul sessiz alan kutunun ICINDE)
    const modul = qrKutu.boyut / (qr.n + 8);
    ogeler.push({ tur: 'qr', x: qrKutu.x, y: qrKutu.y, boyut: qrKutu.boyut, modul, ox: qrKutu.x + 4 * modul, oy: qrKutu.y + 4 * modul,
        n: qr.n, kosular: qr.kosular, seviye: qr.seviye, surum: qr.surum, renk: 'siyah' });

    // Yazilar
    const m = sigdir(masaAdi || '', taban.masaP, true, metinMax, taban.masaMin);
    ogeler.push({ tur: 'metin', metin: m.metin, x: metinX, y: taban.masa, punto: m.punto, kalin: true, renk: 'koyu' });
    const a = sigdir(altMetin || 'Menü için okutun', taban.altP, false, metinMax, taban.altMin);
    ogeler.push({ tur: 'metin', metin: a.metin, x: metinX, y: taban.alt, punto: a.punto, kalin: false, renk: 'orta' });
    ogeler.push({ tur: 'metin', metin: WEB_METNI, x: metinX, y: taban.web, punto: taban.webP, kalin: false, renk: 'gri' });

    return { olcu: olcu in OLCU ? olcu : '80x80', genislik: O.gen, yukseklik: O.yuk, koseYaricap: KOSE, adres, ogeler };
}

// Onizleme icin JSON: karekod SVG yolu (mm) olarak, renkler hex
const yuvarla = (v) => Math.round(v * 1000) / 1000;
function qrYolu(o) {
    let d = '';
    for (const [r, c, uz] of o.kosular) {
        d += `M${yuvarla(o.ox + c * o.modul)} ${yuvarla(o.oy + r * o.modul)}h${yuvarla(uz * o.modul)}v${yuvarla(o.modul)}h${yuvarla(-uz * o.modul)}z`;
    }
    return d;
}
function onizlemeJson(y) {
    return {
        olcu: y.olcu, genislik: y.genislik, yukseklik: y.yukseklik, koseYaricap: y.koseYaricap, zemin: RENK.zemin.hex, adres: y.adres,
        ogeler: y.ogeler.map((o) => {
            if (o.tur === 'qr') return { tur: 'qr', x: yuvarla(o.x), y: yuvarla(o.y), boyut: yuvarla(o.boyut), d: qrYolu(o), renk: RENK[o.renk].hex, seviye: o.seviye, surum: o.surum };
            if (o.tur === 'logo') return { tur: 'logo', url: o.url, x: yuvarla(o.x), y: yuvarla(o.y), w: yuvarla(o.w), h: yuvarla(o.h) };
            return { tur: 'metin', metin: o.metin, x: yuvarla(o.x), y: yuvarla(o.y), punto: yuvarla(o.punto), kalin: !!o.kalin, renk: RENK[o.renk].hex };
        }),
    };
}

// --- PDF yardimcilari ---
function yeniBelge(bilgi) {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ autoFirstPage: false, margin: 0, info: { Creator: 'MDA Restoran POS', Producer: 'MDA Yazılım', ...bilgi } });
    doc.registerFont('PlakaR', FONT.R);
    doc.registerFont('PlakaB', FONT.B);
    return doc;
}
function bitir(doc) {
    return new Promise((resolve, reject) => {
        const parca = [];
        doc.on('data', (d) => parca.push(d));
        doc.on('end', () => resolve(Buffer.concat(parca)));
        doc.on('error', reject);
        doc.end();
    });
}
// Ortali metin, y = taban cizgisi (mm)
function ortaliMetin(doc, metin, cx, taban, punto, kalin, renk) {
    doc.font(kalin ? 'PlakaB' : 'PlakaR').fontSize(mm(punto)).fillColor(RENK[renk] ? RENK[renk].cmyk : renk);
    const w = doc.widthOfString(String(metin));
    doc.text(String(metin), mm(cx) - w / 2, mm(taban), { lineBreak: false, baseline: 'alphabetic' });
}
function solMetin(doc, metin, x, taban, punto, kalin, renk) {
    doc.font(kalin ? 'PlakaB' : 'PlakaR').fontSize(mm(punto)).fillColor(RENK[renk] ? RENK[renk].cmyk : renk);
    doc.text(String(metin), mm(x), mm(taban), { lineBreak: false, baseline: 'alphabetic' });
}
function qrCiz(doc, o, dx, dy) {
    const ust = 0.012; // satirlar arasinda kil payi boşluk kalmasin diye cok kucuk bindirme
    for (const [r, c, uz] of o.kosular) {
        doc.rect(mm(dx + o.ox + c * o.modul), mm(dy + o.oy + r * o.modul), mm(uz * o.modul), mm(o.modul + (r < o.n - 1 ? ust : 0)));
    }
    doc.fill(RENK[o.renk || 'siyah'].cmyk);
}

// Plakayi (dx, dy) kaydirmasiyla ciz; zemin taşma payina kadar
function plakaCiz(doc, y, logo, dx, dy) {
    doc.rect(mm(dx - TASMA), mm(dy - TASMA), mm(y.genislik + 2 * TASMA), mm(y.yukseklik + 2 * TASMA)).fill(RENK.zemin.cmyk);
    for (const o of y.ogeler) {
        if (o.tur === 'logo' && logo && logo.buf) doc.image(logo.buf, mm(dx + o.x), mm(dy + o.y), { width: mm(o.w), height: mm(o.h) });
        else if (o.tur === 'qr') qrCiz(doc, o, dx, dy);
        else if (o.tur === 'metin') ortaliMetin(doc, o.metin, dx + o.x, dy + o.y, o.punto, o.kalin, o.renk);
    }
}

function kesimIsaretleri(doc, ofs, gen, yuk) {
    const g = TASMA + 1, L = 5;
    const xs = [ofs, ofs + gen], ys = [ofs, ofs + yuk];
    doc.save().lineWidth(0.25).strokeColor([0, 0, 0, 100]);
    for (const x of xs) {
        // dikey isaretler: ustte ve altta
        doc.moveTo(mm(x), mm(ofs - g - L)).lineTo(mm(x), mm(ofs - g)).stroke();
        doc.moveTo(mm(x), mm(ofs + yuk + g)).lineTo(mm(x), mm(ofs + yuk + g + L)).stroke();
    }
    for (const yy of ys) {
        doc.moveTo(mm(ofs - g - L), mm(yy)).lineTo(mm(ofs - g), mm(yy)).stroke();
        doc.moveTo(mm(ofs + gen + g), mm(yy)).lineTo(mm(ofs + gen + g + L), mm(yy)).stroke();
    }
    doc.restore();
}

const trTarih = (s) => {
    if (!s) return '';
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' });
};

// --- Baski dosyasi: kapak (A4) + her plaka ayri sayfada, gercek olcude ---
// girdi: { talepNo, tarih, isletmeAdi, olcu, logo, altMetin, masalar: [{ ad, kisaKod, hediye }], hediyeAdet, ucretliAdet }
async function plakaPdf(g) {
    const olcuKodu = Object.prototype.hasOwnProperty.call(OLCU, g.olcu) ? g.olcu : '80x80';
    const O = OLCU[olcuKodu];
    const olcuAdi = olcuKodu.replace('x', ' x ');
    const pasifSayisi = g.masalar.filter((m) => m.pasif).length;
    const ofs = TASMA + KENAR;
    const sayfaG = O.gen + 2 * ofs, sayfaY = O.yuk + 2 * ofs;
    const doc = yeniBelge({ Title: `Masa plakaları - ${g.isletmeAdi} - Talep ${g.talepNo}`, Subject: 'Masa plakası baskı dosyası' });

    // Kapak (A4, tek sayfa)
    doc.addPage({ size: 'A4', margin: 0 });
    let yy = 24;
    solMetin(doc, 'Masa Plakası Baskı Dosyası', 18, yy, 7.2, true, 'koyu'); yy += 10;
    const satirlar = [
        ['İşletme', g.isletmeAdi],
        ['Talep no', String(g.talepNo)],
        ['Talep tarihi', trTarih(g.tarih)],
        ['Adet', `${g.masalar.length} plaka (${g.hediyeAdet || 0} hediye, ${g.ucretliAdet || 0} ücretli)`],
        ['Kesim ölçüsü', `${olcuAdi} mm, köşe yarıçapı ${KOSE} mm`],
        ['Taşma payı', `${TASMA} mm (sayfa ${Math.round(sayfaG)} x ${Math.round(sayfaY)} mm, kesim işaretli; TrimBox kesim çizgisidir)`],
        ['Karekod', 'Vektör, %100 siyah (K), 4 modül sessiz alan dahil 42 mm'],
        ['Yazı tipi', 'Inter (gömülü)'],
        ['Sayfa düzeni', `Kapaktan sonra her sayfa bir plaka (toplam ${g.masalar.length} sayfa)`],
    ];
    for (const [k, v] of satirlar) {
        solMetin(doc, k, 18, yy, 3.4, true, 'orta');
        const s = sigdir(v, 3.4, false, 140, 2.6);
        solMetin(doc, s.metin, 58, yy, s.punto, false, 'koyu');
        yy += 6.2;
    }
    if (g.logoUyari) { yy += 1; const s = sigdir('Not: ' + g.logoUyari, 3.0, false, 174, 2.4); solMetin(doc, s.metin, 18, yy, s.punto, false, 'koyu'); yy += 6; }
    if (pasifSayisi) {
        yy += 1;
        const s = sigdir(`Dikkat: ${pasifSayisi} masa talepten sonra işletme tarafından silinmiş (listede ! ile işaretli); bu plakaların karekodu çalışmaz. Basmadan önce işletmeyle görüşün.`, 3.0, true, 174, 2.2);
        solMetin(doc, s.metin, 18, yy, s.punto, true, 'koyu'); yy += 6;
    }
    yy += 4;
    solMetin(doc, 'Plakalar', 18, yy, 4.2, true, 'koyu'); yy += 3;
    doc.save().lineWidth(0.4).strokeColor([0, 0, 0, 30]).moveTo(mm(18), mm(yy)).lineTo(mm(192), mm(yy)).stroke().restore();
    yy += 6;
    // 3 sutun, sutun basina en cok 30 satir (tek sayfa): fazlasi ozetlenir
    const sutunX = [18, 76, 134], satirH = 5.4, maxSatir = Math.max(1, Math.floor((280 - yy) / satirH));
    const kapasite = sutunX.length * maxSatir;
    const gosterilen = g.masalar.length > kapasite ? g.masalar.slice(0, kapasite - 1) : g.masalar;
    gosterilen.forEach((m, i) => {
        const s = Math.floor(i / maxSatir), r = i % maxSatir;
        const ad = sigdir(`${i + 2}. ${m.ad}`, 3.0, false, 40, 2.2);
        solMetin(doc, ad.metin, sutunX[s], yy + r * satirH, ad.punto, false, 'koyu');
        solMetin(doc, (m.pasif ? '! ' : '') + m.kisaKod + (m.hediye ? '' : ' *'), sutunX[s] + 42, yy + r * satirH, 2.8, true, 'orta');
    });
    if (gosterilen.length < g.masalar.length) {
        const s = Math.floor(gosterilen.length / maxSatir), r = gosterilen.length % maxSatir;
        solMetin(doc, `ve ${g.masalar.length - gosterilen.length} plaka daha`, sutunX[s], yy + r * satirH, 3.0, true, 'orta');
    }
    // Matbaaya not (kapagin altinda)
    const matbaa = 'Matbaa için: her plaka ayrı sayfadadır; TrimBox kesim çizgisidir, 3 mm taşma payı bırakılmıştır. Listedeki sayılar '
        + 'sayfa numarasıdır (* ücretli plaka). Karekodu küçültmeyin, renklendirmeyin ve sessiz alanını kırpmayın; seri baskıdan önce bir '
        + 'plakayı telefonla okutarak deneyin.';
    const kes = matbaa.lastIndexOf(' ', 118);
    const n1 = sigdir(matbaa.slice(0, kes), 2.6, false, 174, 2.0);
    const n2 = sigdir(matbaa.slice(kes + 1), 2.6, false, 174, 2.0);
    solMetin(doc, n1.metin, 18, 285, n1.punto, false, 'gri');
    solMetin(doc, n2.metin, 18, 289, n2.punto, false, 'gri');

    // Plaka sayfalari
    g.masalar.forEach((m, i) => {
        doc.addPage({ size: [mm(sayfaG), mm(sayfaY)], margin: 0 });
        const d = doc.page.dictionary.data;
        d.TrimBox = [mm(ofs), mm(ofs), mm(ofs + O.gen), mm(ofs + O.yuk)];
        d.BleedBox = [mm(ofs - TASMA), mm(ofs - TASMA), mm(ofs + O.gen + TASMA), mm(ofs + O.yuk + TASMA)];
        const y = plakaYerlesimi({ olcu: olcuKodu, logo: g.logo, isletmeAdi: g.isletmeAdi, masaAdi: m.ad, altMetin: g.altMetin, adres: m.adres });
        plakaCiz(doc, y, g.logo, ofs, ofs);
        kesimIsaretleri(doc, ofs, O.gen, O.yuk);
        // Matbaa etiketi alt kenar boslugunda, kesim isaretlerinin arasinda (genislik kesim olcusunden dar)
        const etiket = sigdir(`Talep ${g.talepNo} · sayfa ${i + 2}/${g.masalar.length + 1} · ${m.kisaKod} · ${olcuAdi} mm${m.pasif ? ' · MASA SİLİNDİ' : ''}`, 1.8, false, O.gen - 8, 1.4);
        ortaliMetin(doc, etiket.metin, sayfaG / 2, sayfaY - 2.4, etiket.punto, false, 'gri');
    });
    return bitir(doc);
}

// --- Toplu karekod sayfasi (A4, sayfa basina 9 karekod + masa adi) ---
// girdi: { isletmeAdi, altMetin, masalar: [{ ad, kisaKod, adres }] }
async function karekodSayfasiPdf(g) {
    const doc = yeniBelge({ Title: `Masa karekodları - ${g.isletmeAdi}`, Subject: 'Masa karekodları (A4)' });
    const SUT = 3, SAT = 3, solK = 12, ustK = 16, altK = 12;
    const hucreG = (210 - 2 * solK) / SUT, hucreY = (297 - ustK - altK) / SAT;
    const sayfaBasina = SUT * SAT;
    const toplamSayfa = Math.max(1, Math.ceil(g.masalar.length / sayfaBasina));
    for (let s = 0; s < toplamSayfa; s++) {
        doc.addPage({ size: 'A4', margin: 0 });
        const baslik = sigdir(`${g.isletmeAdi} - masa karekodları`, 3.4, true, 150, 2.6);
        solMetin(doc, baslik.metin, solK, 10, baslik.punto, true, 'koyu');
        const sy = `Sayfa ${s + 1}/${toplamSayfa}`;
        doc.font('PlakaR').fontSize(mm(2.8));
        solMetin(doc, sy, 210 - solK - doc.widthOfString(sy) / MM, 10, 2.8, false, 'gri');
        // kesim cizgileri (kesik, acik gri)
        doc.save().lineWidth(0.4).dash(mm(1.2), { space: mm(1.2) }).strokeColor([0, 0, 0, 25]);
        for (let i = 1; i < SUT; i++) doc.moveTo(mm(solK + i * hucreG), mm(ustK)).lineTo(mm(solK + i * hucreG), mm(297 - altK)).stroke();
        for (let i = 1; i < SAT; i++) doc.moveTo(mm(solK), mm(ustK + i * hucreY)).lineTo(mm(210 - solK), mm(ustK + i * hucreY)).stroke();
        doc.undash().restore();
        g.masalar.slice(s * sayfaBasina, (s + 1) * sayfaBasina).forEach((m, i) => {
            const hx = solK + (i % SUT) * hucreG, hy = ustK + Math.floor(i / SUT) * hucreY;
            const q = karekod(m.adres);
            const boyut = 52, modul = boyut / (q.n + 8);
            const x = hx + (hucreG - boyut) / 2, y0 = hy + 5;
            qrCiz(doc, { kosular: q.kosular, n: q.n, modul, ox: x + 4 * modul, oy: y0 + 4 * modul, renk: 'siyah' }, 0, 0);
            const cx = hx + hucreG / 2;
            const ad = sigdir(m.ad, 5, true, hucreG - 8, 3.2);
            ortaliMetin(doc, ad.metin, cx, y0 + boyut + 6.2, ad.punto, true, 'koyu');
            const alt = sigdir(g.altMetin || 'Menü için okutun', 3, false, hucreG - 8, 2.2);
            ortaliMetin(doc, alt.metin, cx, y0 + boyut + 11, alt.punto, false, 'orta');
            const adr = sigdir(m.adres.replace(/^https?:\/\//, ''), 2.4, false, hucreG - 6, 1.8);
            ortaliMetin(doc, adr.metin, cx, y0 + boyut + 15.2, adr.punto, false, 'gri');
        });
        solMetin(doc, 'Kesik çizgilerden kesin. Karekodun çevresindeki beyaz alanı kesmeyin.', solK, 297 - 5, 2.4, false, 'gri');
    }
    return bitir(doc);
}

module.exports = {
    OLCU, TASMA, KENAR, KOSE, FONT, FONT_DIR, RENK,
    plakaYerlesimi, onizlemeJson, plakaPdf, karekodSayfasiPdf, logoYukle, gorselBoyutu, karekod, sigdir, metinGenisligi,
};
