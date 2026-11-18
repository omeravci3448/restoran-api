const G = require('../services/grupOzet');

// --- Isletme tarafi: sube grubu (grup yoneticisi ekrani) ---
// Rota katmani (routes/grupRoutes.js): protect + destek oturumu yasak + OWNER/MANAGER.
// /ben   : kenar cubugundaki "Şube Grubu" baglantisi icin (yonetici sifresi SORULMAZ; yalniz grup ve sube adlari).
// /ozet  : rakamlar; kullanicinin KENDI isletmesinin yonetici sifresi ister (requireManagerPin).
// Grup yoneticisi olmayan: /ben 404 (baglanti cizilmez), /ozet 403.

exports.ben = async (req, res) => {
    const g = await G.kullanicininGrubu(req.user.id, req.user.tenantId);
    if (!g) return res.status(404).json({ code: 'GRUP_YOK', message: 'Bir şube grubuna bağlı değilsiniz.' });
    const sb = await G.subeler(g.id);
    res.json({
        id: g.id, ad: g.ad,
        subeler: sb.map((t) => ({ tenantId: t.id, ad: t.business_name, isyeriKodu: t.business_code, aktif: !!Number(t.is_active),
            buSube: t.id === req.user.tenantId })),
    });
};

exports.ozet = async (req, res) => {
    const g = await G.kullanicininGrubu(req.user.id, req.user.tenantId);
    if (!g) return res.status(403).json({ code: 'GRUP_YETKI_YOK', message: 'Bu ekran yalnızca şube grubu yöneticilerine açıktır.' });
    res.json(await G.ozet(g, { bas: req.query.bas, bit: req.query.bit }));
};
