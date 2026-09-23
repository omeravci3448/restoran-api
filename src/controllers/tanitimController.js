const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');

// ——— Tanitim sayfasi: deneme talebi ———
// Herkese acik bir uc. Musteri olmayan isletmeler dolduruyor, o yuzden
// kimlik dogrulamasi yok - buna karsilik oran siniri ve alan dogrulamasi var.

const son = new Map();                 // ip -> [zaman damgalari]
const PENCERE = 60 * 60 * 1000;        // 1 saat
const SINIR = 5;                       // saatte 5 talep

function cokMu(ip) {
    const simdi = Date.now();
    const liste = (son.get(ip) || []).filter((t) => simdi - t < PENCERE);
    son.set(ip, liste);
    return liste.length >= SINIR;
}

exports.talep = async (req, res) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'bilinmiyor';
    if (cokMu(ip)) {
        return res.status(429).json({ message: 'Çok fazla talep gönderildi. Lütfen bizi telefonla arayın.' });
    }

    const al = (k, max) => String(req.body?.[k] || '').trim().slice(0, max);
    const isletme = al('isletme', 120);
    const adSoyad = al('adSoyad', 120);
    const telefon = al('telefon', 30);
    const eposta = al('eposta', 160);
    const notMetni = al('not', 600);

    if (!isletme || !adSoyad || !telefon) {
        return res.status(400).json({ message: 'İşletme adı, ad soyad ve telefon zorunlu.' });
    }
    // Cok gevsek bir telefon kontrolu - bicimi zorlamiyoruz, yalniz rakam var mi bakiyoruz.
    if ((telefon.match(/\d/g) || []).length < 10) {
        return res.status(400).json({ message: 'Telefon numarası eksik görünüyor.' });
    }

    const id = uuidv4();
    await query(
        `INSERT INTO demo_talepleri (id, isletme, ad_soyad, telefon, eposta, not_metni, kaynak, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, isletme, adSoyad, telefon, eposta || null, notMetni || null, al('kaynak', 40) || 'tanitim', ip]);

    (son.get(ip) || []).push(Date.now());
    son.set(ip, [...(son.get(ip) || []), Date.now()]);

    // E-posta bildirimi - SMTP tanimli degilse sessizce gecilir, talep yine kayitli.
    try {
        const mail = require('../services/emailService');
        if (mail && typeof mail.sendMail === 'function' && process.env.SMTP_HOST) {
            await mail.sendMail({
                to: process.env.DEMO_TALEP_MAIL || process.env.SMTP_USER,
                subject: 'MDA Restoran POS - deneme talebi: ' + isletme,
                text: `İşletme: ${isletme}\nAd Soyad: ${adSoyad}\nTelefon: ${telefon}\n`
                    + `E-posta: ${eposta || '-'}\nNot: ${notMetni || '-'}\nKaynak: ${al('kaynak', 40) || 'tanitim'}`,
            });
        }
    } catch (_) { /* bildirim gitmese de talep kayitli - kullaniciya hata gosterme */ }

    res.status(201).json({ ok: true, message: 'Talebiniz alındı. En kısa sürede sizi arayacağız.' });
};

// ——— 7 gunluk denemeyi HEMEN baslat ———
// Talep formundan farki: burada insan beklemiyor, program aninda aciliyor.
// Ayni oran siniri gecerli; ustune "bir isletme yalnizca BIR KEZ" kurali var.
exports.denemeBaslat = async (req, res) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'bilinmiyor';
    if (cokMu(ip)) {
        return res.status(429).json({ message: 'Çok fazla deneme talebi. Lütfen bizi telefonla arayın.' });
    }
    const al = (k, max) => String(req.body?.[k] || '').trim().slice(0, max);
    const isletme = al('isletme', 120);
    const adSoyad = al('adSoyad', 120);
    const telefon = al('telefon', 30);
    const eposta = al('eposta', 160);
    const smxId = al('soframixBusinessId', 40) || null;

    if (!isletme || !adSoyad || !telefon || !eposta) {
        return res.status(400).json({ message: 'İşletme adı, ad soyad, telefon ve e-posta zorunlu.' });
    }

    const D = require('../services/denemeLisansi');
    const s = await D.denemeBaslat({
        isletmeAdi: isletme, yetkiliAd: adSoyad, eposta, telefon,
        soframixBusinessId: smxId, kaynak: al('kaynak', 40) || 'tanitim',
    });

    if (s.durum === 'hata') {
        const mesajlar = {
            eposta_gecersiz: 'E-posta adresi geçersiz görünüyor.',
            telefon_gecersiz: 'Telefon numarası eksik görünüyor.',
            isletme_adi_yok: 'İşletme adı zorunlu.',
        };
        return res.status(400).json({ message: mesajlar[s.sebep] || 'Bilgiler eksik.' });
    }
    if (s.durum === 'zaten_alinmis') {
        // Bilerek KIBAR ve kapali: "bu telefon daha once denedi" demek, baskasinin
        // numarasini deneyerek bilgi toplamaya kapi acardi.
        return res.status(409).json({
            message: 'Bu işletme için daha önce bir deneme başlatılmış. '
                   + 'Giriş yapamıyorsanız bize yazın, yardımcı olalım.',
        });
    }

    (son.get(ip) || []).push(Date.now());
    son.set(ip, [...(son.get(ip) || []), Date.now()]);

    // Talep kaydi da yaziliyor: Patron kimin denedigini tek listede gorsun.
    await query(
        `INSERT INTO demo_talepleri (id, isletme, ad_soyad, telefon, eposta, not_metni, kaynak, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), isletme, adSoyad, telefon, eposta,
            `7 gunluk deneme BASLATILDI - isyeri kodu ${s.isyeriKodu}`,
            (al('kaynak', 40) || 'tanitim') + '-deneme', ip]).catch(() => {});

    // Sifre belirleme baglantisi. Gonderilemezse akis DURMUYOR ama sonuc
    // yanitta bildiriliyor - kullanici "gelmedi" diyebilsin, biz de bilelim.
    const PANEL = (process.env.POS_PANEL_URL || 'https://restoran.mdayazilim.com').replace(/\/+$/, '');
    const baglanti = `${PANEL}/aktivasyon/${s.aktivasyonJetonu.ham}`;
    let gonderildi = false;
    try {
        const cekici = require('../services/posOdemeCekici');
        gonderildi = await cekici.postaDene(eposta, 'MDA Restoran POS - 7 gunluk denemeniz basladi',
            `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
                <h2 style="color:#E2622A;margin:0 0 12px">MDA Restoran POS</h2>
                <p style="color:#374151">Merhaba ${adSoyad},</p>
                <p style="color:#374151"><b>${isletme}</b> için ${s.gun} günlük ücretsiz denemeniz başladı.
                Aşağıdaki bağlantıdan şifrenizi belirleyip hemen kullanmaya başlayabilirsiniz.</p>
                <p style="margin:20px 0"><a href="${baglanti}" style="background:#E2622A;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Şifremi belirle</a></p>
                <p style="color:#374151;font-size:.92rem">İşyeri kodunuz: <b>${s.isyeriKodu}</b>
                &middot; Deneme bitişi: <b>${new Date(s.bitis).toLocaleDateString('tr-TR')}</b></p>
                <p style="color:#6b7280;font-size:.85rem">Deneme bittiğinde girdiğiniz menü ve masa düzeni silinmez;
                paketi satın aldığınızda aynı hesaptan devam edersiniz.</p>
            </div>`, s.tenantId);
    } catch (_) { /* posta gitmese de deneme acildi */ }

    res.status(201).json({
        ok: true, gun: s.gun, isyeriKodu: s.isyeriKodu, eposta, gonderildi,
        bitis: s.bitis,
        // SMTP yoksa baglanti yanitta doner ki kullanici ekranda gorup devam edebilsin.
        baglanti: gonderildi ? undefined : baglanti,
        message: gonderildi
            ? `Denemeniz başladı. Şifre belirleme bağlantısı ${eposta} adresine gönderildi.`
            : 'Denemeniz başladı. Aşağıdaki bağlantıdan şifrenizi belirleyin.',
    });
};
