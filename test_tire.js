// Uzun tire taramasi (Patron kurali: urunde – — − YASAK, duz "-"; guvenlik incelemesi, dusuk 13).
// Kod yorumlari serbest; metin, sablon ve diger kod icinde uzun tire / eksi isareti olmamali (e-posta konusu,
// hata mesaji, arayuze donen her metin). Sunucu baslatmaz.  Calistir: node test_tire.js
const fs = require('fs');
const path = require('path');

const TIRE = new RegExp('[' + String.fromCharCode(0x2013, 0x2014, 0x2212) + ']');   // en tire, uzun tire, eksi
const ATLA = new Set(['node_modules', 'dist', 'build', '.git', 'uploads', 'data']);
function dosyalar(kok, liste = []) {
    for (const ad of fs.readdirSync(kok)) {
        const tam = path.join(kok, ad);
        if (fs.statSync(tam).isDirectory()) { if (!ATLA.has(ad)) dosyalar(tam, liste); continue; }
        if (!/\.(c|m)?js$/.test(ad) || /^test_.*\.js$/.test(ad)) continue;
        liste.push(tam);
    }
    return liste;
}
// Her satirda yorum icindeki karakterleri isaretler (blok yorum ve sablon dizesi satir asabilir)
function yorumIsaretleri(metin) {
    let blok = false, sablon = false;
    return metin.split('\n').map((satir) => {
        const y = new Array(satir.length).fill(false);
        let tek = false, cift = false;
        for (let i = 0; i < satir.length; i++) {
            const c = satir[i], d = satir[i + 1];
            if (blok) { y[i] = true; if (c === '*' && d === '/') { y[i + 1] = true; i++; blok = false; } continue; }
            if (sablon) { if (c === '\\') { i++; continue; } if (c === '`') sablon = false; continue; }
            if (tek) { if (c === '\\') { i++; continue; } if (c === "'") tek = false; continue; }
            if (cift) { if (c === '\\') { i++; continue; } if (c === '"') cift = false; continue; }
            if (c === '/' && d === '/') { for (let j = i; j < satir.length; j++) y[j] = true; break; }
            if (c === '/' && d === '*') { blok = true; y[i] = y[i + 1] = true; i++; continue; }
            if (c === '`') sablon = true; else if (c === "'") tek = true; else if (c === '"') cift = true;
        }
        return y;
    });
}

const bulgu = [];
const kokler = [path.join(__dirname, 'src'), path.join(__dirname, 'server.js')];
for (const kok of kokler) {
    for (const f of fs.statSync(kok).isFile() ? [kok] : dosyalar(kok)) {
        const metin = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
        if (!TIRE.test(metin)) continue;
        const isaret = yorumIsaretleri(metin);
        metin.split('\n').forEach((satir, n) => {
            for (let i = 0; i < satir.length; i++) {
                if (TIRE.test(satir[i]) && !isaret[n][i]) bulgu.push(`${path.relative(__dirname, f)}:${n + 1}: ${satir.trim().slice(0, 120)}`);
            }
        });
    }
}
for (const b of bulgu) console.log('  FAIL uzun tire: ' + b);
const pass = bulgu.length ? 0 : 1;
if (!bulgu.length) console.log('  OK  api kaynaklarinda yorum disi uzun tire yok');
console.log(`\n=== SONUC: ${pass} gecti, ${bulgu.length} kaldi ===`);
process.exit(bulgu.length ? 1 : 0);
