// Root paneli + Authenticator (TOTP) uctan uca testi.
// Sunucuyu KENDI baslatir, bitince kapatir.  Calistir: node test_root_totp.js
const { spawn } = require('child_process');
const totp = require('./src/services/totp');

const PORT = 45994, TABAN = `http://127.0.0.1:${PORT}`;
const EPOSTA = 'roottest@mdayazilim.com', PAROLA = 'CokGizliParola123';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

async function iste(yol, govde, jeton) {
    const h = { 'Content-Type': 'application/json' };
    if (jeton) h.Authorization = 'Bearer ' + jeton;
    const r = await fetch(TABAN + yol, { method: 'POST', headers: h, body: JSON.stringify(govde) });
    return { kod: r.status, veri: await r.json().catch(() => null) };
}

// Test KENDI durumunu temizler: onceki kosudan kalan root kaydinda TOTP acik
// kaliyordu ve "ilk giris" adimi bozuluyordu. Sunucu acilmadan ONCE siliyoruz;
// ensureRootUser tertemiz kurar.
async function temizle() {
    const { query } = require('./src/config/db');
    await query('DELETE FROM root_users WHERE email = ?', [EPOSTA]);
    await new Promise(r => setTimeout(r, 300));
}

(async () => {
    await temizle();
    const sunucu = spawn(process.execPath, ['server.js'], {
        cwd: __dirname,
        env: { ...process.env, PORT: String(PORT), ROOT_EMAIL: EPOSTA, ROOT_PASSWORD: PAROLA },
        stdio: 'ignore',
    });
    const kapat = () => { try { sunucu.kill(); } catch (_) {} };
    process.on('exit', kapat);

    for (let i = 0; i < 40; i++) {
        try { const r = await fetch(TABAN + '/health'); if (r.ok) break; } catch (_) {}
        await uyu(400);
    }
    await uyu(6500);   // ensureRootUser 5sn sonra calisiyor

    console.log('\n=== 1) Ilk giris: parola dogru ama authenticator yok ===');
    let r = await iste('/api/root/login', { email: EPOSTA, password: PAROLA });
    ok('200 dondu', r.kod === 200, r.kod);
    ok('kurulum gerekli isareti', r.veri?.totpKurulumGerekli === true);
    ok('kurulum jetonu verildi', !!r.veri?.kurulumJetonu);
    ok('sir verildi', !!r.veri?.sir && r.veri.sir.length >= 16);
    ok('otpauth baglantisi dogru bicimde', /^otpauth:\/\/totp\//.test(r.veri?.otpauth || ''));
    ok('TAM OTURUM JETONU VERILMEDI', !r.veri?.token);
    const sir = r.veri.sir, kurulumJetonu = r.veri.kurulumJetonu;

    console.log('\n=== 2) Kurulum jetonu TAM YETKI DEGIL ===');
    const rr = await fetch(TABAN + '/api/root/tenants', { headers: { Authorization: 'Bearer ' + kurulumJetonu } });
    ok('kurulum jetonuyla isletme listesi ACILMIYOR', rr.status === 403 || rr.status === 401, rr.status);

    console.log('\n=== 3) Yanlis kodla kurulum reddedilir ===');
    r = await iste('/api/root/totp/kurulum', { code: '000000' }, kurulumJetonu);
    ok('yanlis kod 401', r.kod === 401, r.kod);

    console.log('\n=== 4) Dogru kodla kurulum tamamlanir ===');
    const kod1 = totp.kodUret(sir, totp.suankiAdim());
    r = await iste('/api/root/totp/kurulum', { code: kod1 }, kurulumJetonu);
    ok('kurulum 200', r.kod === 200, r.veri);
    ok('gercek oturum jetonu geldi', !!r.veri?.token);
    const jeton = r.veri.token;

    console.log('\n=== 5) Jeton gercekten calisiyor ===');
    const r5 = await fetch(TABAN + '/api/root/tenants', { headers: { Authorization: 'Bearer ' + jeton } });
    ok('isletme listesi acildi', r5.status === 200, r5.status);

    console.log('\n=== 6) Artik parola TEK BASINA yetmiyor ===');
    r = await iste('/api/root/login', { email: EPOSTA, password: PAROLA });
    ok('401 dondu', r.kod === 401, r.kod);
    ok('needTotp isareti var', r.veri?.needTotp === true);
    ok('jeton SIZMADI', !r.veri?.token);

    console.log('\n=== 7) Parola + dogru kod ile giris ===');
    // DIKKAT: kurulumda kullanilan kodla AYNI pencereden kod alirsak tekrar korumasi
    // devreye girer (dogru davranis). Bir SONRAKI pencerenin kodunu kullaniyoruz -
    // +/-1 pencere toleransi sayesinde kabul edilir ve adim numarasi daha buyuktur.
    const kod2 = totp.kodUret(sir, totp.suankiAdim() + 1);
    r = await iste('/api/root/login', { email: EPOSTA, password: PAROLA, code: kod2 });
    ok('giris basarili', r.kod === 200 && !!r.veri?.token, r.veri);

    console.log('\n=== 8) TEKRAR SALDIRISI: ayni kod ikinci kez ===');
    r = await iste('/api/root/login', { email: EPOSTA, password: PAROLA, code: kod2 });
    ok('ayni kod REDDEDILDI', r.kod === 401, r.kod);
    ok('sebep aciklandi', /kullanıldı|kullanildi/i.test(r.veri?.message || ''), r.veri?.message);

    console.log('\n=== 9) Yanlis parola + dogru kod ===');
    const kod3 = totp.kodUret(sir, totp.suankiAdim());
    r = await iste('/api/root/login', { email: EPOSTA, password: 'yanlisparola', code: kod3 });
    ok('reddedildi', r.kod === 401, r.kod);

    kapat();
    console.log('\n' + '='.repeat(50));
    console.log('SONUC: ' + pass + ' gecti, ' + fail + ' kaldi');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
