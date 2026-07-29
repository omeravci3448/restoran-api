const BaseAdapter = require('../BaseAdapter');
const { AdapterError, KIND } = require('../../errors');
const { toKurus } = require('../../money');
const M = require('./mapping');

// ——— Uber Eats Trendyol GO — Yemek entegrasyonu ———
// Doküman: developers.tgoapps.com   Servis: api.tgoapis.com
//
// NEDEN İLK BU: Anahtarı RESTORAN kendi panelinden üretiyor (Satıcı Paneli >
// Hesap Bilgilerim > Entegrasyon Bilgileri) — bizim Trendyol ile kurumsal anlaşma
// yapmamıza gerek yok. Üstelik tek entegrasyonla üç kanal geliyor
// (Trendyol + TrendyolGo + Galaxy=eski GetirYemek trafiği).
//
// Kimlik: Basic Auth (apiKey:apiSecret). Token/OAuth YOK.
// supplierId bir kimlik bilgisi DEĞİL, URL yol parametresidir.

const BASE_URL = {
    prod: 'https://api.tgoapis.com/integrator',
    stage: 'https://stageapi.tgoapis.com/integrator',
};

// Aynı endpoint'e 10 saniyede en fazla 50 istek; 51.'de 429 "too.many.requests"
const RATE_LIMIT = { windowMs: 10_000, max: 50 };

class TrendyolGoAdapter extends BaseAdapter {
    constructor() {
        super({
            code: 'trendyolgo',
            displayName: 'Uber Eats Trendyol GO — Yemek',
            requiredCredentialFields: [
                { key: 'supplierId', label: 'Satıcı ID (supplierId)', type: 'text', required: true },
                { key: 'apiKey', label: 'API Key', type: 'text', required: true },
                { key: 'apiSecret', label: 'API Secret', type: 'password', required: true },
                { key: 'integratorName', label: 'Entegratör adı (User-Agent)', type: 'text', required: false,
                  hint: 'Boş bırakılırsa "SelfIntegration" gönderilir. Alfanümerik, en fazla 30 karakter.' },
                { key: 'executorUser', label: 'İşlem yapan e-posta (x-executor-user)', type: 'text', required: true,
                  hint: 'Sipariş servislerinde zorunlu header.' },
            ],
            requiredStoreLinkFields: [
                { key: 'externalStoreId', label: 'Trendyol Restoran (store) ID', type: 'text', required: true },
            ],
            capabilities: {
                ingress: 'polling',        // Yemek tarafında resmi webhook sayfası YOK — polling tek doğrulanmış yol
                acceptReject: true,
                prepTimeOnAccept: true,    // picked ucu preparationTime alıyor
                markReady: true,           // invoiced
                markDispatched: true,      // manual-shipped — YALNIZ Model 1
                markDelivered: true,       // manual-delivered — YALNIZ Model 1
                partialCancel: true,       // unsupplied itemIdList ile kısmi
                menuRead: true,
                menuWrite: false,          // ürün OLUŞTURMA yok — müşteriye "menüyü POS'tan yönetirsiniz" TAAHHÜDÜ VERME
                priceUpdate: true,
                itemAvailability: true,
                categoryAvailability: true,
                stockQuantity: false,      // adet yok, sadece ACTIVE/PASSIVE
                storeOpenClose: true,
                settlements: true,         // komisyon/hakediş GERÇEKTEN çekilebiliyor
                asyncJobs: true,           // fiyat güncelleme batchRequestId döner
                sandbox: true,             // stage ortamı (IP yetkilendirmesi gerekir)
                credentialScope: 'supplier', // anahtar supplierId altındaki TÜM şubeleri kapsar
            },
        });
    }

    // — İç yardımcılar —

    _base(ctx) {
        return BASE_URL[ctx.env === 'stage' ? 'stage' : 'prod'];
    }

    _headers(ctx, { isOrderService = false } = {}) {
        const c = ctx.credentials;
        const basic = Buffer.from(`${c.apiKey}:${c.apiSecret}`).toString('base64');
        // User-Agent ZORUNLU — yoksa 403. Biçim: "SatıcıId - EntegratörAdı"
        const agent = (c.integratorName || 'SelfIntegration').replace(/[^a-zA-Z0-9]/g, '').slice(0, 30) || 'SelfIntegration';
        const h = {
            Authorization: `Basic ${basic}`,
            'User-Agent': `${c.supplierId} - ${agent}`,
            'Content-Type': 'application/json',
        };
        // Sipariş servislerinde ek zorunlu header'lar
        if (isOrderService) {
            h['x-agentname'] = agent;
            h['x-executor-user'] = c.executorUser || '';
        }
        return h;
    }

    // Kiracı izolasyonu bekçisi: supplierId DAİMA credentials'tan gelir,
    // çağıran taraf elle geçemez. (Anahtar tüm şubeleri kapsadığı için kritik.)
    _supplierId(ctx) {
        const id = ctx.credentials?.supplierId;
        if (!id) throw new AdapterError(KIND.VALIDATION, 'supplierId tanımlı değil.');
        return encodeURIComponent(String(id));
    }

    async _req(ctx, method, path, { query, body, isOrderService } = {}) {
        const url = new URL(this._base(ctx) + path);
        for (const [k, v] of Object.entries(query || {})) {
            if (v != null && v !== '') url.searchParams.set(k, String(v));
        }
        const res = await ctx.http(url.toString(), {
            method,
            headers: this._headers(ctx, { isOrderService }),
            body: body == null ? undefined : JSON.stringify(body),
        });
        return this._handle(res, `${method} ${path}`);
    }

    async _handle(res, label) {
        const text = await res.text().catch(() => '');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
        if (res.ok) return data;

        const s = res.status;
        // 403 ≠ geçersiz anahtar! Trendyol'da 403 "bu paket sizin supplierId'nizle
        // ilişkili değil" ya da eksik User-Agent demek olabilir — anahtarı bozuk işaretleme.
        let kind = KIND.PERMANENT;
        if (s === 401) kind = KIND.AUTH;
        else if (s === 403) kind = KIND.VALIDATION;
        else if (s === 404) kind = KIND.NOT_FOUND;
        else if (s === 409) kind = KIND.CONFLICT;
        else if (s === 429) kind = KIND.RATE_LIMIT;
        else if (s >= 500) kind = KIND.TRANSIENT;
        else if (s === 400 || s === 422) kind = KIND.VALIDATION;

        throw new AdapterError(kind, `Trendyol GO ${label} → HTTP ${s}`, {
            httpStatus: s,
            platformCode: data?.exception || data?.errors?.[0]?.code || null,
            raw: data,
        });
    }

    // — Kimlik doğrulama —
    // Ayrı bir "ping" ucu yok; mağaza listesi en ucuz doğrulama çağrısı.
    async validateCredentials(ctx) {
        const data = await this._req(ctx, 'GET', `/store/meal/suppliers/${this._supplierId(ctx)}/stores`, {
            query: { page: 0, size: 1 },
        });
        return { ok: true, accountInfo: { storeCount: data?.totalElements ?? null } };
    }

    // — Sipariş alımı (polling) —
    async fetchOrders(ctx, { since, until, statuses, cursor, page = 0, pageSize = 50 } = {}) {
        const start = cursor ?? since;
        const data = await this._req(ctx, 'GET', `/order/meal/suppliers/${this._supplierId(ctx)}/packages`, {
            isOrderService: true,
            query: {
                storeId: ctx.storeLink?.externalStoreId,
                packageStatuses: Array.isArray(statuses) ? statuses.join(',') : statuses,
                packageModificationStartDate: start,
                packageModificationEndDate: until,
                page,
                size: Math.min(pageSize, 50),
            },
        });
        const list = data?.content || data?.packages || [];
        return {
            events: list.map((p) => this._toRawEvent(p)),
            nextCursor: list.length ? Math.max(...list.map((p) => Number(p.packageModificationDate) || 0)) || null : null,
            hasMore: data?.totalPages != null ? page + 1 < data.totalPages : list.length >= Math.min(pageSize, 50),
        };
    }

    async fetchOrder(ctx, { externalOrderId }) {
        const p = await this._req(ctx, 'GET',
            `/order/meal/suppliers/${this._supplierId(ctx)}/packages/${encodeURIComponent(externalOrderId)}`,
            { isOrderService: true });
        return { event: this._toRawEvent(p) };
    }

    _toRawEvent(pkg) {
        return {
            externalOrderId: String(pkg.id),
            platformStatus: pkg.packageStatus,
            // Aynı siparişin aynı durumu tekrar gelirse tek olay sayılsın (idempotency)
            eventKey: `${pkg.id}:${pkg.packageStatus}:${pkg.packageModificationDate || ''}`,
            occurredAt: Number(pkg.packageModificationDate) || Number(pkg.packageCreationDate) || null,
            payload: pkg,
        };
    }

    // — Normalize —
    async normalizeOrder(ctx, rawEvent) {
        const p = rawEvent.payload || {};
        const unmapped = [];
        const lines = p.lines || [];

        const items = [];
        for (const line of lines) {
            const units = line.items || [];
            // Trendyol'da her "item" bir adet; aynı ürünün adetleri satır altında çoğul gelir.
            const activeUnits = units.filter((u) => !u.isCancelled);
            const qty = activeUnits.length || Number(line.quantity) || units.length || 1;
            items.push({
                externalItemId: units.map((u) => u.packageItemId).filter(Boolean).join(','),
                externalItemIds: units.map((u) => u.packageItemId).filter(Boolean),
                externalProductId: line.productId != null ? String(line.productId) : null,
                name: line.name || line.productName || '—',
                quantity: qty,
                unitPriceKurus: toKurus(line.price ?? line.unitPrice),
                lineTotalKurus: toKurus(line.totalPrice ?? (Number(line.price || 0) * qty)),
                isCancelled: units.length > 0 && activeUnits.length === 0 ? 1 : 0,
                modifiers: (line.modifierProducts || []).map((m) => ({
                    externalId: m.productId != null ? String(m.productId) : null,
                    name: m.name,
                    priceKurus: toKurus(m.price),
                    quantity: Number(m.quantity) || 1,
                })),
                extras: (line.extraIngredients || []).map((x) => ({
                    externalId: x.id != null ? String(x.id) : null, name: x.name, priceKurus: toKurus(x.price),
                })),
                removed: (line.removedIngredients || []).map((x) => ({
                    externalId: x.id != null ? String(x.id) : null, name: x.name,
                })),
                note: line.note || null,
            });
        }

        const status = M.STATUS_TO_NORMALIZED[p.packageStatus];
        if (!status) unmapped.push(`packageStatus=${p.packageStatus}`);

        // Model 2'de adres/telefon maskeli gelir (tüm alanlar sabit "TGO Yemek").
        const addr = p.address || {};
        const isMasked = /TGO/i.test(String(addr.address1 || addr.address || '')) ? 1 : 0;

        return {
            order: {
                externalOrderId: String(p.id),
                externalOrderNo: p.orderNumber || p.orderCode || null,
                subChannel: p.userInformation?.appName || null,   // Trendyol | TrendyolGo | Galaxy
                status: status || 'NEW',
                platformStatusRaw: p.packageStatus || null,
                deliveryMode: M.toDeliveryMode(p),
                isTest: p.testPackage ? 1 : 0,
                isAddressMasked: isMasked,
                placedAt: Number(p.packageCreationDate) || null,
                platformModifiedAt: Number(p.packageModificationDate) || null,
                prepTimeMinutes: p.preparationTime != null ? Number(p.preparationTime) : null,
                customer: {
                    name: [p.customer?.firstName, p.customer?.lastName].filter(Boolean).join(' ') || null,
                    phone: p.callCenterPhone || p.customer?.phone || null,
                    isMasked,
                },
                address: {
                    city: addr.city || null, district: addr.district || null,
                    line1: addr.address1 || addr.address || null, isMasked,
                },
                payment: {
                    settlement: M.PAYMENT_SETTLEMENT[p.payment?.paymentType] || 'UNKNOWN',
                    methodCode: p.payment?.paymentType || null,
                },
                money: {
                    grandTotalKurus: toKurus(p.totalPrice),
                    deliveryFeeKurus: toKurus(p.totalDeliveryPrice),
                    // commission/sellerRevenue sipariş payload'ında YOK — ayrı settlements servisinden gelir
                    commissionAmountKurus: null,
                    sellerRevenueKurus: null,
                },
                currency: 'TRY',
                customerNote: p.customerNote || null,
                cancellation: p.cancelInfo
                    ? { by: 'PLATFORM', reasonCode: p.cancelInfo.reasonId ?? null, reasonText: p.cancelInfo.reason || null }
                    : null,
                items,
            },
            unmapped,
        };
    }

    // — Aksiyonlar —
    async acceptOrder(ctx, { externalOrderId, prepTimeMinutes }) {
        return this._req(ctx, 'PUT', `/order/meal/suppliers/${this._supplierId(ctx)}/packages/picked`, {
            isOrderService: true,
            body: { packageId: externalOrderId, preparationTime: Number(prepTimeMinutes) || 15 },
        });
    }

    async markReady(ctx, { externalOrderId, actualAt }) {
        return this._req(ctx, 'PUT', `/order/meal/suppliers/${this._supplierId(ctx)}/packages/invoiced`, {
            isOrderService: true,
            body: { packageId: externalOrderId, ...(actualAt ? { actualDate: actualAt } : {}) },
        });
    }

    // manual-shipped / manual-delivered YALNIZ Model 1'de (restoran kendi kuryesi) çağrılmalı.
    async markDispatched(ctx, { externalOrderId, actualAt }) {
        this._assertOwnCourier(ctx, 'markDispatched');
        return this._req(ctx, 'PUT',
            `/order/meal/suppliers/${this._supplierId(ctx)}/packages/${encodeURIComponent(externalOrderId)}/manual-shipped`,
            { isOrderService: true, body: actualAt ? { actualDate: actualAt } : {} });
    }

    async markDelivered(ctx, { externalOrderId, actualAt }) {
        this._assertOwnCourier(ctx, 'markDelivered');
        return this._req(ctx, 'PUT',
            `/order/meal/suppliers/${this._supplierId(ctx)}/packages/${encodeURIComponent(externalOrderId)}/manual-delivered`,
            { isOrderService: true, body: actualAt ? { actualDate: actualAt } : {} });
    }

    _assertOwnCourier(ctx, method) {
        if (ctx.deliveryMode && ctx.deliveryMode !== 'RESTAURANT_COURIER') {
            throw new AdapterError(KIND.VALIDATION,
                `${method} yalnızca restoranın kendi kuryesiyle çalıştığı siparişlerde kullanılır.`, { retryable: false });
        }
    }

    // Tam ya da kısmi reddetme. itemIds verilmezse siparişin tamamı.
    async rejectOrder(ctx, { externalOrderId, reasonCode, itemIds }) {
        const reasonId = Number(reasonCode);
        if (!M.VALID_UNSUPPLIED_REASON_IDS.has(reasonId)) {
            throw new AdapterError(KIND.VALIDATION,
                `Geçersiz iptal sebebi: ${reasonCode}. Geçerli: ${[...M.VALID_UNSUPPLIED_REASON_IDS].join(', ')}`,
                { retryable: false });
        }
        return this._req(ctx, 'PUT', `/order/meal/suppliers/${this._supplierId(ctx)}/packages/unsupplied`, {
            isOrderService: true,
            body: { packageId: externalOrderId, itemIdList: itemIds || [], reasonId },
        });
    }

    cancelOrder(ctx, params) { return this.rejectOrder(ctx, params); }

    // — Menü —
    async pullMenu(ctx, { externalStoreId } = {}) {
        const storeId = externalStoreId || ctx.storeLink?.externalStoreId;
        if (!storeId) throw new AdapterError(KIND.VALIDATION, 'externalStoreId gerekli.');
        const data = await this._req(ctx, 'GET',
            `/product/meal/suppliers/${this._supplierId(ctx)}/stores/${encodeURIComponent(storeId)}/products`);
        const list = data?.content || data?.products || data || [];
        return {
            products: (Array.isArray(list) ? list : []).map((p) => ({
                externalId: String(p.id ?? p.productId),
                name: p.name,
                priceKurus: toKurus(p.price ?? p.sellingPrice),
                externalCategoryId: p.sectionId != null ? String(p.sectionId) : null,
                isActive: String(p.status || '').toUpperCase() !== 'PASSIVE',
            })),
            raw: data,
        };
    }

    // Fiyat güncelleme ASENKRON — batchRequestId döner, getJobStatus ile takip edilir.
    // ⚠️ storeId (restaurantId) DAİMA açıkça gönderilir; gönderilmezse tüm şubelerin
    // fiyatı ezilir. Bu yüzden parametre zorunlu tutuluyor.
    async updatePrices(ctx, { items, externalStoreId } = {}) {
        const storeId = externalStoreId || ctx.storeLink?.externalStoreId;
        if (!storeId) throw new AdapterError(KIND.VALIDATION,
            'externalStoreId zorunlu — gönderilmezse tüm şubelerin fiyatı değişir.', { retryable: false });
        if (!Array.isArray(items) || !items.length) throw new AdapterError(KIND.VALIDATION, 'items boş.');
        if (items.length > 1000) throw new AdapterError(KIND.VALIDATION, 'Tek istekte en fazla 1000 ürün.');

        const data = await this._req(ctx, 'POST', `/product/meal/suppliers/${this._supplierId(ctx)}/products/price`, {
            body: {
                storeId: String(storeId),
                items: items.map((i) => ({
                    productId: String(i.externalProductId),
                    price: Number((Number(i.priceKurus) / 100).toFixed(2)),
                })),
            },
        });
        return { jobRef: data?.batchRequestId || null, raw: data };
    }

    // Batch sonucu yalnızca 4 saat saklanır.
    async getJobStatus(ctx, { jobRef }) {
        const data = await this._req(ctx, 'GET',
            `/product/meal/suppliers/${this._supplierId(ctx)}/batch-requests/${encodeURIComponent(jobRef)}`);
        return { state: data?.status || 'UNKNOWN', itemResults: data?.items || [], raw: data };
    }

    async setItemAvailability(ctx, { externalProductId, available, externalStoreId }) {
        const storeId = externalStoreId || ctx.storeLink?.externalStoreId;
        return this._req(ctx, 'PUT',
            `/product/meal/suppliers/${this._supplierId(ctx)}/stores/${encodeURIComponent(storeId)}/products/${encodeURIComponent(externalProductId)}/status`,
            { body: { status: available ? 'ACTIVE' : 'PASSIVE' } });
    }

    // — Şube —
    async listStores(ctx, { page = 0, pageSize = 50 } = {}) {
        const data = await this._req(ctx, 'GET', `/store/meal/suppliers/${this._supplierId(ctx)}/stores`, {
            query: { page, size: Math.min(pageSize, 50) },
        });
        const list = data?.content || data?.stores || [];
        return {
            stores: list.map((s) => ({
                externalStoreId: String(s.id),
                name: s.name,
                isOpen: String(s.workingStatus || '').toUpperCase() === 'OPEN',
                deliveryType: s.deliveryType || null,
            })),
            hasMore: data?.totalPages != null ? page + 1 < data.totalPages : false,
        };
    }

    async setStoreStatus(ctx, { externalStoreId, open }) {
        const storeId = externalStoreId || ctx.storeLink?.externalStoreId;
        return this._req(ctx, 'PUT',
            `/store/meal/suppliers/${this._supplierId(ctx)}/stores/${encodeURIComponent(storeId)}/status`,
            { body: { status: open ? 'OPEN' : 'CLOSED' } });
    }

    // — Finans —
    // Komisyon/hakediş: orders.commission_amount'ı MANUEL yerine otomatik doldurmanın
    // doğrulanmış tek yolu. DİKKAT: yolda 'suppliers' değil 'sellers'.
    // Tarih aralığı en fazla 15 gün ve transactionType TEK tip (her tip için ayrı istek).
    async fetchSettlements(ctx, { from, to, transactionType = 'Sale', page = 0, pageSize = 500 } = {}) {
        if (!from || !to) throw new AdapterError(KIND.VALIDATION, 'startDate ve endDate zorunlu.');
        const data = await this._req(ctx, 'GET',
            `/settlement/meal/sellers/${this._supplierId(ctx)}/settlements`, {
                query: { transactionType, startDate: from, endDate: to, page, size: pageSize === 1000 ? 1000 : 500 },
            });
        const list = data?.content || [];
        return {
            settlements: list.map((s) => ({
                externalOrderId: s.orderId != null ? String(s.orderId) : null,
                orderNumber: s.orderNumber || null,
                commissionRate: s.commissionRate != null ? Number(s.commissionRate) : null,
                commissionAmountKurus: toKurus(s.commissionAmount),
                sellerRevenueKurus: toKurus(s.sellerRevenue),
                paymentDate: s.paymentDate || null,
                paymentPeriod: s.paymentPeriod ?? null,
            })),
            hasMore: data?.totalPages != null ? page + 1 < data.totalPages : false,
        };
    }
}

module.exports = { TrendyolGoAdapter, BASE_URL, RATE_LIMIT };
