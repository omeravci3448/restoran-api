const nodemailer = require('nodemailer');

// SMTP yapılandırması — .env'den okunur. Belirtilmediyse e-posta gönderimi
// kapalı kabul edilir (kayıt akışı devam eder ama OTP konsola yazılır)
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_NAME = process.env.MAIL_FROM_NAME || 'MDA Restoran POS';

let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
}

async function sendOTP(to, otp, businessName) {
    if (!transporter) {
        console.log(`[email/DEV] OTP for ${to}: ${otp}  (SMTP yok — konsola yazıldı)`);
        return { sent: false, dev: true };
    }
    const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
            <h2 style="color: #f97316; margin: 0 0 12px;">MDA Restoran POS</h2>
            <p style="color: #374151;">Merhaba${businessName ? ` ${businessName}` : ''},</p>
            <p style="color: #374151;">İşletme kaydınızı tamamlamak için doğrulama kodunuz:</p>
            <div style="background: #fff7ed; color: #c2410c; padding: 18px; font-size: 28px; font-weight: 800; text-align: center; letter-spacing: 8px; border-radius: 10px; margin: 16px 0;">
                ${otp}
            </div>
            <p style="color: #6b7280; font-size: .9rem;">Bu kod 15 dakika geçerlidir. Kodu sizden istemiyorsak görmezden geliniz.</p>
            <p style="color: #9ca3af; font-size: .8rem; margin-top: 24px;">Bu e-posta otomatik gönderilmiştir, yanıtlamayınız.</p>
        </div>
    `;
    try {
        await transporter.sendMail({
            from: `"${FROM_NAME}" <${SMTP_USER}>`,
            to,
            subject: 'Doğrulama Kodunuz — MDA Restoran POS',
            html
        });
        return { sent: true };
    } catch (e) {
        console.error('[email] OTP gönderilemedi:', e.message);
        return { sent: false, error: e.message };
    }
}

async function sendMail({ to, subject, html, text }) {
    if (!transporter) {
        console.log(`[email/DEV] ${to} — ${subject}`);
        return { sent: false, dev: true };
    }
    try {
        await transporter.sendMail({
            from: `"${FROM_NAME}" <${SMTP_USER}>`, to, subject, html, text
        });
        return { sent: true };
    } catch (e) {
        console.error('[email]', e.message);
        return { sent: false, error: e.message };
    }
}

module.exports = { sendOTP, sendMail };
