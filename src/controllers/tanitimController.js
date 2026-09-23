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
