const BaseAdapter = require('../BaseAdapter');
const { toKurus } = require('../../money');

// ——— Sahte pazaryeri (test/geliştirme) ———
// Hiçbir API anahtarı GEREKTİRMEZ. Gerçek platform anahtarları gelene kadar
// sipariş boru hattını (idempotency, kısmi iptal, durum geçişi, geç gelen olay)
// uçtan uca çalıştırmak için var. Aynı zamanda demo/tanıtımda kullanılabilir.
//
// Trendyol GO'nun payload şeklini taklit eder ki gerçek adaptöre geçince
// normalize katmanı değişmesin.

const SCENARIOS = {
    // Standart sipariş — 2 kalem
    basic: () => ({
        id: 'SBX-1001', packageStatus: 'Created', orderNumber: 'SB1001',
        userInformation: { appName: 'TrendyolGo' },
        deliveryType: 'GO', totalPrice: 285.5, totalDeliveryPrice: 0,
        packageCreationDate: 1782900000000, packageModificationDate: 1782900000000,
        customer: { firstName: 'Deneme', lastName: 'Müşteri' },
        address: { city: 'Afyonkarahisar', district: 'Merkez', address1: 'TGO Yemek' },
        payment: { paymentType: 'PAY_WITH_CARD' },
        customerNote: 'Acısız olsun',
        lines: [
            { productId: 'P-100', name: 'Adana Kebap', price: 185.5, totalPrice: 185.5, quantity: 1,
              items: [{ packageItemId: 'I-1', isCancelled: false }],
              extraIngredients: [{ id: 'E-1', name: 'Ekstra lavaş', price: 15 }],
              removedIngredients: [{ id: 'R-1', name: 'Soğan' }] },
            { productId: 'P-200', name: 'Ayran', price: 50, totalPrice: 100, quantity: 2,
              items: [{ packageItemId: 'I-2', isCancelled: false }, { packageItemId: 'I-3', isCancelled: false }] },
        ],
    }),
    // Kısmi iptal — bir kalem iptal edilmiş
    partialCancel: () => {
        const o = SCENARIOS.basic();
        o.id = 'SBX-1002'; o.orderNumber = 'SB1002';
        o.lines[1].items = o.lines[1].items.map((i) => ({ ...i, isCancelled: true }));
        return o;
    },
    // Restoran kendi kuryesiyle (Model 1) — manual-shipped/delivered çağrılabilir
    ownCourier: () => {
        const o = SCENARIOS.basic();
        o.id = 'SBX-1003'; o.orderNumber = 'SB1003'; o.deliveryType = 'STORE';
        o.address.address1 = 'Gerçek Mah. 12/3';
        return o;
    },
    // Gel-al
    pickup: () => {
        const o = SCENARIOS.basic();
        o.id = 'SBX-1004'; o.orderNumber = 'SB1004'; o.storePickupSelected = true;
        return o;
    },
    // Bilinmeyen durum kodu — normalize katmanı "unmapped" döndürmeli, çökmemeli
    unknownStatus: () => {
        const o = SCENARIOS.basic();
        o.id = 'SBX-1005'; o.orderNumber = 'SB1005'; o.packageStatus = 'SomeNewStatusFromPlatform';
        return o;
    },
};

class SandboxAdapter extends BaseAdapter {
    constructor() {
        super({
            code: 'sandbox',
            displayName: 'Test Pazaryeri (sahte)',
            requiredCredentialFields: [],
            requiredStoreLinkFields: [],
            capabilities: {
                ingress: 'polling',
                acceptReject: true, prepTimeOnAccept: true, markReady: true,
                markDispatched: true, markDelivered: true, partialCancel: true,
                menuRead: true, priceUpdate: true, itemAvailability: true,
                storeOpenClose: true, settlements: true, sandbox: true,
                credentialScope: 'supplier',
            },
        });
        this._sent = [];   // gönderilen aksiyonlar — testte doğrulamak için
    }

    async validateCredentials() { return { ok: true, accountInfo: { mode: 'sandbox' } }; }

    // scenario adı verilmezse hepsini döndürür
    async fetchOrders(_ctx, { scenario, duplicate = false } = {}) {
        const names = scenario ? [scenario] : Object.keys(SCENARIOS);
        const events = names.filter((n) => SCENARIOS[n]).map((n) => this._toRawEvent(SCENARIOS[n]()));
        // Aynı olayı iki kez döndür — idempotency testinde kullanılır
        return { events: duplicate ? [...events, ...events] : events, nextCursor: null, hasMore: false };
    }

    async fetchOrder(_ctx, { externalOrderId }) {
        const found = Object.values(SCENARIOS).map((f) => f()).find((o) => o.id === externalOrderId);
        if (!found) return { event: null };
        return { event: this._toRawEvent(found) };
    }

    _toRawEvent(pkg) {
        return {
            externalOrderId: String(pkg.id),
            platformStatus: pkg.packageStatus,
            eventKey: `${pkg.id}:${pkg.packageStatus}:${pkg.packageModificationDate || ''}`,
            occurredAt: pkg.packageModificationDate || null,
            payload: pkg,
        };
    }

    // Normalize'ı Trendyol adaptörüyle AYNI tutuyoruz — payload şekli aynı olduğu için
    // gerçek entegrasyona geçişte normalize katmanı değişmez.
    async normalizeOrder(ctx, rawEvent) {
        const { TrendyolGoAdapter } = require('../trendyolgo');
        return new TrendyolGoAdapter().normalizeOrder(ctx, rawEvent);
    }

    // Aksiyonlar sadece kaydedilir (dışarı istek yok)
    async acceptOrder(_c, p) { this._sent.push({ action: 'accept', ...p }); return { ok: true }; }
    async markReady(_c, p) { this._sent.push({ action: 'ready', ...p }); return { ok: true }; }
    async markDispatched(_c, p) { this._sent.push({ action: 'dispatched', ...p }); return { ok: true }; }
    async markDelivered(_c, p) { this._sent.push({ action: 'delivered', ...p }); return { ok: true }; }
    async rejectOrder(_c, p) { this._sent.push({ action: 'reject', ...p }); return { ok: true }; }
    async cancelOrder(_c, p) { this._sent.push({ action: 'cancel', ...p }); return { ok: true }; }

    async pullMenu() {
        return { products: [
            { externalId: 'P-100', name: 'Adana Kebap', priceKurus: toKurus(185.5), isActive: true },
            { externalId: 'P-200', name: 'Ayran', priceKurus: toKurus(50), isActive: true },
        ] };
    }

    async updatePrices(_c, { items }) { this._sent.push({ action: 'price', count: items?.length }); return { jobRef: 'SBX-JOB-1' }; }
    async getJobStatus() { return { state: 'COMPLETED', itemResults: [] }; }
    async setItemAvailability(_c, p) { this._sent.push({ action: 'availability', ...p }); return { ok: true }; }
    async listStores() { return { stores: [{ externalStoreId: 'SBX-STORE-1', name: 'Test Şube', isOpen: true }], hasMore: false }; }
    async setStoreStatus(_c, p) { this._sent.push({ action: 'storeStatus', ...p }); return { ok: true }; }

    async fetchSettlements() {
        return { settlements: [{
            externalOrderId: 'SBX-1001', orderNumber: 'SB1001',
            commissionRate: 15, commissionAmountKurus: toKurus(42.83),
            sellerRevenueKurus: toKurus(242.67), paymentPeriod: 30,
        }], hasMore: false };
    }
}

module.exports = { SandboxAdapter, SCENARIOS };
