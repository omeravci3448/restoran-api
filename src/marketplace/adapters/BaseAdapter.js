const { AdapterError } = require('../errors');
const { buildCapabilities } = require('../capabilities');

// Tüm pazaryeri adaptörlerinin atası.
// Varsayılan: HER metod UNSUPPORTED fırlatır. Adaptör neyi destekliyorsa onu ezer
// ve capabilities'te beyan eder. Böylece "beyan ettim ama yazmadım" hatası
// sessiz kalmaz, sözleşme testinde patlar.
//
// ctx = { tenantId, channelId, credentials, storeLink, logger, http }
// Adaptör ASLA doğrudan DB'ye dokunmaz ve process.env okumaz — her şey ctx'ten gelir.
// (Kiracı izolasyonu: external id'ler daima ctx.storeLink'ten okunur, çağıran elle geçemez.)
class BaseAdapter {
    constructor({ code, displayName, capabilities, requiredCredentialFields = [], requiredStoreLinkFields = [] }) {
        this.code = code;
        this.displayName = displayName;
        this.capabilities = buildCapabilities(capabilities);
        this.requiredCredentialFields = requiredCredentialFields;
        this.requiredStoreLinkFields = requiredStoreLinkFields;
    }

    describe() {
        return {
            code: this.code,
            displayName: this.displayName,
            capabilities: this.capabilities,
            requiredCredentialFields: this.requiredCredentialFields,
            requiredStoreLinkFields: this.requiredStoreLinkFields,
        };
    }

    // — Kimlik / sağlık —
    async validateCredentials() { throw AdapterError.unsupported('validateCredentials'); }

    // — Sipariş alımı (ingress) —
    // parseWebhook ve fetchOrders AYNI RawEvent tipini üretir; böylece webhook'lu ve
    // polling'li platformlar aşağıda tamamen aynı boru hattını kullanır.
    async parseWebhook() { throw AdapterError.unsupported('parseWebhook'); }
    async fetchOrders() { throw AdapterError.unsupported('fetchOrders'); }
    async fetchOrder() { throw AdapterError.unsupported('fetchOrder'); }
    async normalizeOrder() { throw AdapterError.unsupported('normalizeOrder'); }

    // — Sipariş aksiyonları (egress) —
    async acceptOrder() { throw AdapterError.unsupported('acceptOrder'); }
    async rejectOrder() { throw AdapterError.unsupported('rejectOrder'); }
    async markPreparing() { throw AdapterError.unsupported('markPreparing'); }
    async markReady() { throw AdapterError.unsupported('markReady'); }
    async markDispatched() { throw AdapterError.unsupported('markDispatched'); }
    async markDelivered() { throw AdapterError.unsupported('markDelivered'); }
    async cancelOrder() { throw AdapterError.unsupported('cancelOrder'); }

    // — Menü / ürün —
    async pullMenu() { throw AdapterError.unsupported('pullMenu'); }
    async setItemAvailability() { throw AdapterError.unsupported('setItemAvailability'); }
    async updatePrices() { throw AdapterError.unsupported('updatePrices'); }
    async getJobStatus() { throw AdapterError.unsupported('getJobStatus'); }

    // — Şube —
    async listStores() { throw AdapterError.unsupported('listStores'); }
    async setStoreStatus() { throw AdapterError.unsupported('setStoreStatus'); }

    // — Finans —
    async fetchSettlements() { throw AdapterError.unsupported('fetchSettlements'); }
}

module.exports = BaseAdapter;
