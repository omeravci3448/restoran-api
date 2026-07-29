const { TrendyolGoAdapter } = require('./adapters/trendyolgo');
const { SandboxAdapter } = require('./adapters/sandbox');
const pending = require('./adapters/pending');

// Adaptör kaydı — kanal kodu → adaptör örneği.
// Adaptörler durumsuzdur (state ctx'te taşınır), tek örnek yeterli.
const ADAPTERS = {
    trendyolgo: new TrendyolGoAdapter(),
    sandbox: new SandboxAdapter(),
    // Erişim/doküman bekleyenler — bilinçli olarak boş (bkz. adapters/pending.js)
    yemeksepeti: pending.yemeksepeti,
    migros: pending.migros,
    getir: pending.getir,
};

function getAdapter(code) {
    const a = ADAPTERS[String(code || '').toLowerCase()];
    if (!a) throw new Error(`Bilinmeyen pazaryeri kanalı: ${code}`);
    return a;
}

// Arayüzün kanal listesini çizmesi için — hangisi bağlanabilir, hangisi neden değil
const listAdapters = () => Object.values(ADAPTERS).map((a) => a.describe());

// Yalnızca gerçekten bağlanabilir olanlar
const listAvailable = () => listAdapters().filter((d) => d.available !== false);

module.exports = { ADAPTERS, getAdapter, listAdapters, listAvailable };
