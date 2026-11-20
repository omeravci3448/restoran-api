// Bos veritabaninda ILK acilis: initDb tek seferde EKSIKSIZ sema kurmali.
// Hata (2026-11-19): bazi "ALTER TABLE ... ADD COLUMN" satirlari hedef tablonun CREATE TABLE satirindan ONCE
// calisiyordu. Bos veritabaninda ALTER sessizce dusuyor (geri cagri hatayi yutuyor), tablo o sutun olmadan
// kuruluyordu: ilk acilista POST /api/categories 500 ("table categories has no column named istasyon"), ikinci
// acilista ALTER'lar tuttugu icin duzeliyordu. Canli veritabani eski oldugu icin etkilenmedi.
//
// Yontem: her acilis AYRI surec (sunucu acilisi gibi). Veritabani gecici klasorde; calisma veritabanina
// (database.sqlite) dokunulmaz. Cocuk surec sqlite3.Database'i gecici dosyaya yonlendirir, initDb'yi calistirir,
// kuyruk bitince semayi (tablo -> sutunlar, indeksler) ve "no such table / no such column" hatalarini yazar.
//   1) Ilk acilista mutfak / islem gunlugu sutunlari ve indeks var; kategori istasyonla yazilabiliyor
//   2) Ilk acilista hicbir ifade "no such table / no such column" hatasi vermedi (sira hatalarinin genel bekcisi)
//   3) Ikinci acilis semaya HICBIR sey eklemedi (ilk acilis eksiksiz)
process.env.HUB_URL = 'http://127.0.0.1:9';   // canli hub'a asla gitmesin
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ISARET = 'SEMA_JSON ';
const siraHatasiMi = (m) => /no such (table|column)/i.test(m || '');

// ---------- Cocuk surec: tek acilis ----------
async function acilis(yaz) {
    const hedef = process.env.ILK_ACILIS_DB;
    if (!hedef) throw new Error('ILK_ACILIS_DB tanimli degil');
    const sqlite3 = require('sqlite3');
    const Asil = sqlite3.Database;
    // db.js veritabanini yuklenirken acar: dosya adi ne olursa olsun gecici dosyaya git
    function Yonlendirilmis(_dosya, ...geri) { return new Asil(hedef, ...geri); }
    Yonlendirilmis.prototype = Asil.prototype;
    sqlite3.Database = Yonlendirilmis;

    // initDb hatalari bos geri cagriyla yutar: geri cagriyi sarip sira hatasi belirtilerini kaydet
    const siraHatalari = [];
    const kisalt = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 140);
    for (const ad of ['run', 'all', 'get']) {
        const asil = Asil.prototype[ad];
        Asil.prototype[ad] = function (sql, ...args) {
            const son = args.length - 1;
            if (son >= 0 && typeof args[son] === 'function') {
                const cb = args[son];
                args[son] = function (err) {
                    if (err && siraHatasiMi(err.message)) siraHatalari.push(`${err.message} :: ${kisalt(sql)}`);
                    return cb.apply(this, arguments);
                };
            }
            return asil.call(this, sql, ...args);
        };
    }
    // Geri cagrisiz ifadenin hatasi surec duzeyine cikar: server.js gibi cokmeden kaydet
    const digerHatalar = [];
    const yakala = (e) => {
        const m = (e && e.message) || String(e);
        (siraHatasiMi(m) ? siraHatalari : digerHatalar).push(m);
    };
    process.on('uncaughtException', yakala);
    process.on('unhandledRejection', yakala);

    const { db, initDb, tx } = require('./src/config/db');
    if (db.filename !== hedef) throw new Error(`yonlendirme tutmadi: ${db.filename}`);
    initDb();
    const hepsi = (sql, p = []) => new Promise((ok, red) => db.all(sql, p, (e, r) => (e ? red(e) : ok(r))));
    const calistir = (sql, p = []) => new Promise((ok, red) => db.run(sql, p, (e) => (e ? red(e) : ok())));
    // Ayni baglantida initDb kuyrugundan (db.serialize) SONRA calisir; ardindan gecis islemi (tx kilidi) de bitsin
    await hepsi('SELECT 1');
    await tx(async () => {});

    const sema = { tablolar: {}, indeksler: [] };
    const tablolar = await hepsi("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    for (const { name } of tablolar) sema.tablolar[name] = (await hepsi(`PRAGMA table_info("${name}")`)).map((s) => s.name);
    sema.indeksler = (await hepsi("SELECT tbl_name || '.' || name AS ad FROM sqlite_master WHERE type = 'index' ORDER BY 1"))
        .map((r) => r.ad);

    let kategori = null, kategoriHata = null;
    if (yaz) {
        try {
            await calistir("INSERT INTO tenants (id, slug, business_name) VALUES ('ilk-acilis-t', 'ilk-acilis-t', 'Ilk Acilis Testi')");
            // categoryController.create ile ayni sorgu
            await calistir('INSERT INTO categories (id, tenant_id, name, sort_order, istasyon) VALUES (?, ?, ?, ?, ?)',
                ['ilk-acilis-k', 'ilk-acilis-t', 'Icecekler', 1, 'BAR']);
            kategori = ((await hepsi("SELECT istasyon FROM categories WHERE id = 'ilk-acilis-k'"))[0] || {}).istasyon || null;
        } catch (e) { kategoriHata = e.message; }
    }
    const cikti = JSON.stringify({ sema, siraHatalari, digerHatalar, kategori, kategoriHata });
    process.stdout.write(ISARET + cikti + '\n', () => process.exit(0));
}

// ---------- Ana surec ----------
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 600) : ''))); };

const BEKLENEN = [
    ['categories', 'istasyon'],
    ['order_items', 'added_by'],
    ['order_items', 'prep_started_at'],
    ['order_items', 'ready_at'],
    ['order_items', 'served_at'],
    ['orders', 'cancelled_by'],
];

// Iki acilisin sema farki (ilk acilis eksiksizse bos)
function semaFarki(a, b) {
    const fark = [];
    for (const t of new Set([...Object.keys(a.tablolar), ...Object.keys(b.tablolar)])) {
        const x = a.tablolar[t], y = b.tablolar[t];
        if (!x || !y) { fark.push(`tablo ${t} ${x ? 'ikinci acilista yok' : 'ilk acilista yok'}`); continue; }
        for (const s of y) if (!x.includes(s)) fark.push(`${t}.${s} ilk acilista yok`);
        for (const s of x) if (!y.includes(s)) fark.push(`${t}.${s} ikinci acilista yok`);
    }
    for (const i of b.indeksler) if (!a.indeksler.includes(i)) fark.push(`indeks ${i} ilk acilista yok`);
    for (const i of a.indeksler) if (!b.indeksler.includes(i)) fark.push(`indeks ${i} ikinci acilista yok`);
    return fark;
}

// Ilk acilista iki baglanti ayni anda "PRAGMA journal_mode=WAL" der; biri SQLITE_BUSY alabilir (bilinen, ayri konu,
// server.js uncaughtException ile ayakta kalir). Sema ile ilgisi yok: not olarak yazilir, testi dusurmez.
const bilinenMi = (m) => /SQLITE_BUSY/.test(m);

if (process.argv[2] === '--acilis') {
    acilis(process.argv[3] === 'yaz').catch((e) => { console.error('[acilis]', (e && e.stack) || e); process.exit(1); });
} else {
    const klasor = fs.mkdtempSync(path.join(os.tmpdir(), 'mda-ilk-acilis-'));
    const dbYolu = path.join(klasor, 'bos.sqlite');
    const acilisYap = (no, ...ek) => {
        const r = spawnSync(process.execPath, [__filename, '--acilis', ...ek], {
            cwd: __dirname, encoding: 'utf8', timeout: 60000,
            env: { ...process.env, ILK_ACILIS_DB: dbYolu, HUB_URL: 'http://127.0.0.1:9', NODE_ENV: 'development' },
        });
        const satir = String(r.stdout || '').split(/\r?\n/).find((s) => s.startsWith(ISARET));
        if (r.status !== 0 || !satir) {
            console.log(`  ${no}. acilis tamamlanamadi (kod ${r.status}${r.error ? ', ' + r.error.message : ''})`);
            console.log(String(r.stdout || '').slice(-1500) + String(r.stderr || '').slice(-1500));
            return null;
        }
        const s = JSON.parse(satir.slice(ISARET.length));
        for (const m of s.digerHatalar.filter(bilinenMi)) console.log(`  NOT ${no}. acilis (ayri konu): ${m}`);
        return s;
    };
    const denetle = (no, s) => {
        ok(`${no}. acilista hicbir ifade "no such table/column" hatasi vermedi`, s.siraHatalari.length === 0, s.siraHatalari);
        const diger = s.digerHatalar.filter((m) => !bilinenMi(m));
        ok(`${no}. acilista beklenmeyen hata yok`, diger.length === 0, diger);
    };
    try {
        console.log('=== 1) Bos veritabaninda ILK acilis ===');
        ok('gecici veritabani bos baslar', !fs.existsSync(dbYolu));
        const s1 = acilisYap(1, 'yaz');
        ok('ilk acilis tamamlandi', !!s1);
        if (s1) {
            ok('veritabani gecici klasorde kuruldu (calisma veritabanina dokunulmadi)', fs.existsSync(dbYolu));
            for (const [t, c] of BEKLENEN) ok(`${t}.${c} var`, (s1.sema.tablolar[t] || []).includes(c), s1.sema.tablolar[t]);
            ok('order_items (order_id, status) indeksi var',
                s1.sema.indeksler.includes('order_items.idx_order_items_order_status'));
            ok('kategori istasyonla yazilir (POST /api/categories sorgusu)', s1.kategori === 'BAR', s1.kategoriHata);
            denetle(1, s1);
        }

        console.log('\n=== 2) Ayni veritabaninda IKINCI acilis semaya bir sey eklemez ===');
        const s2 = s1 && acilisYap(2);
        ok('ikinci acilis tamamlandi', !!s2);
        if (s1 && s2) {
            const fark = semaFarki(s1.sema, s2.sema);
            ok('ilk acilis eksiksiz: ikinci acilis yeni sutun / indeks / tablo eklemedi', fark.length === 0, fark);
            denetle(2, s2);
        }
    } finally {
        try { fs.rmSync(klasor, { recursive: true, force: true }); } catch (_) {}
    }
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi ===`);
    process.exit(fail ? 1 : 0);
}
