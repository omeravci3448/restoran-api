// Basit in-memory SSE olay yayıncısı.
// Tenant başına açık bağlantıları (res) tutar; bir olay olunca o tenant'ın
// tüm açık kasalarına anında yazar. Tek container varsayımı (Coolify'da 1 replika);
// ileride 2+ replika olursa Redis pub/sub'a taşınır.
const clients = new Map(); // tenantId -> Set<res>

function addClient(tenantId, res) {
    let set = clients.get(tenantId);
    if (!set) { set = new Set(); clients.set(tenantId, set); }
    set.add(res);
}

function removeClient(tenantId, res) {
    const set = clients.get(tenantId);
    if (!set) return;
    set.delete(res);
    if (!set.size) clients.delete(tenantId);
}

// event: olay adı ('waiter_call' | 'new_order'), data: serileştirilebilir nesne
function emit(tenantId, event, data) {
    const set = clients.get(tenantId);
    if (!set || !set.size) return 0;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
    let sent = 0;
    for (const res of set) {
        try { res.write(frame); sent++; } catch (_) { /* kopmuş bağlantı — close handler temizler */ }
    }
    return sent;
}

function countClients(tenantId) {
    return clients.get(tenantId)?.size || 0;
}

module.exports = { addClient, removeClient, emit, countClients };
