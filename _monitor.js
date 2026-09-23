// 8 dk boyunca 3 sn'de bir: statik sayfa + API health + DB health ölç.
// Yavaş (>1500ms) veya hatalı örnekleri logla — takılma anını yakala.
const https = require('https');
function probe(url, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.get(url, { timeout: timeoutMs }, (r) => {
      r.resume();
      r.on('end', () => resolve({ status: r.statusCode, ms: Date.now() - t0 }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ status: 'ERR:' + e.code, ms: Date.now() - t0 }));
  });
}
const URLS = {
  statik: 'https://restoran.mdayazilim.com/',
  api: 'https://restoran-api.mdayazilim.com/health',
  db: 'https://restoran-api.mdayazilim.com/health/db',
};
(async () => {
  const stats = {}; Object.keys(URLS).forEach(k => stats[k] = { n: 0, slow: 0, err: 0, max: 0, sum: 0 });
  const end = Date.now() + 8 * 60 * 1000;
  console.log('izleme başladı:', new Date().toLocaleTimeString('tr-TR'));
  while (Date.now() < end) {
    const results = await Promise.all(Object.entries(URLS).map(async ([k, u]) => [k, await probe(u)]));
    for (const [k, r] of results) {
      const s = stats[k]; s.n++; s.sum += r.ms; if (r.ms > s.max) s.max = r.ms;
      if (typeof r.status !== 'number') { s.err++; console.log(`${new Date().toLocaleTimeString('tr-TR')} | ${k}: HATA ${r.status} (${r.ms}ms)`); }
      else if (r.ms > 1500) { s.slow++; console.log(`${new Date().toLocaleTimeString('tr-TR')} | ${k}: YAVAŞ ${r.ms}ms (HTTP ${r.status})`); }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('--- ÖZET (8 dk) ---');
  for (const [k, s] of Object.entries(stats))
    console.log(`${k}: ${s.n} örnek | ort ${(s.sum / s.n).toFixed(0)}ms | max ${s.max}ms | yavaş(>1.5s) ${s.slow} | hata ${s.err}`);
})();
