const BaseAdapter = require('../BaseAdapter');
const { AdapterError, KIND } = require('../../errors');
const M = require('./mapping');

// ——— SofraMix adaptoru ———
// Diger kanallardan FARKI: iki tarafi da biz yaziyoruz. Bu yuzden Trendyol/Yemeksepeti'nde
// hicbir zaman acilamayan yetenekler burada acik.
//
// PATRON KARARLARI (2026-09-22) - kod bunlara gore yazildi:
//  1. Secenekler (porsiyon/ekstra) POS'ta MODELLENMEZ. SofraMix'in malidir; siparis
//     kalemine donmus METIN olarak gelir. Boylece secenek-ID senkron tuzagi hic olusmaz.
//  2. Fiyat POS'tan SofraMix'e OTOMATIK GITMEZ. Isletme paket fiyatini SofraMix
//     panelinden kendi gunceller; POS yalnizca hatirlatma gosterir. -> menuWrite:false
//  3. Salon stogu bitse bile paket satisi OTOMATIK KAPANMAZ; POS yalnizca uyarir.
//  4. Ilk kurulumda menu SofraMix'ten CEKILIR: gorseller gelir, fiyat 0, urunler PASIF.

class SofraMixAdapter extends BaseAdapter {
    constructor() {
        super({
            code: 'soframix',
            displayName: 'SofraMix',
            requiredCredentialFields: [
                { key: 'apiBase', label: 'SofraMix adresi', type: 'text', required: true,
                  hint: 'ornek: https://soframix.com.tr' },
                { key: 'apiKey', label: 'Isletme API anahtari', type: 'password', required: true,
                  hint: 'SofraMix isletme panelinden uretilir (X-Smx-Anahtar).' },
                { key: 'webhookSecret', label: 'Webhook imza siri', type: 'password', required: false },
            ],
            requiredStoreLinkFields: [
                { key: 'externalStoreId', label: 'SofraMix isletme no (business_id)', type: 'text', required: true },
            ],
            capabilities: {
                ingress: 'hybrid',
                acceptReject: true,
                markPreparing: true,
                markReady: true,
                markDispatched: true,
                markDelivered: true,
                partialCancel: false,
                prepTimeOnAccept: false,
                menuRead: true,
                menuWrite: false,
                priceUpdate: false,
                itemAvailability: false,
                storeOpenClose: true,
                settlements: false,
                asyncJobs: false,
                sandbox: true,
                credentialScope: 'store',
            },
        });
    }

    _base(ctx) {
        const b = String((ctx.credentials && ctx.credentials.apiBase) || '').replace(/\/+$/, '');
        if (!b) throw new AdapterError(KIND.VALIDATION, 'SofraMix adresi tanimli degil.');
        return b;
    }

    _headers(ctx) {
        const k = ctx.credentials && ctx.credentials.apiKey;
        if (!k) throw new AdapterError(KIND.AUTH, 'SofraMix API anahtari tanimli degil.');
        return { 'X-Smx-Anahtar': k, 'Content-Type': 'application/json' };
    }

    async _req(ctx, method, path, opts) {
        const o = opts || {};
        const url = new URL(this._base(ctx) + path);
        for (const [k, v] of Object.entries(o.query || {})) {
            if (v != null && v !== '') url.searchParams.set(k, String(v));
        }
        const res = await ctx.http(url.toString(), {
            method, headers: this._headers(ctx),
            body: o.body == null ? undefined : JSON.stringify(o.body),
        });
        const text = await res.text().catch(() => '');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
        if (res.ok) return data;

        const s = res.status;
        let kind = KIND.PERMANENT;
        if (s === 401 || s === 403) kind = KIND.AUTH;
        else if (s === 404) kind = KIND.NOT_FOUND;
        else if (s === 409) kind = KIND.CONFLICT;
        else if (s === 429) kind = KIND.RATE_LIMIT;
        else if (s >= 500) kind = KIND.TRANSIENT;
        else if (s === 400 || s === 422) kind = KIND.VALIDATION;
        throw new AdapterError(kind, 'SofraMix ' + method + ' ' + path + ' -> HTTP ' + s, {
            httpStatus: s, platformCode: data && data.hata, raw: data,
        });
    }

    async validateCredentials(ctx) {
        const d = await this._req(ctx, 'GET', '/api/business/menu');
        return { ok: true, accountInfo: { urunSayisi: (d && d.products && d.products.length) || 0 } };
    }

    // degisen_sonra: SofraMix'e EKLENECEK artimli cekme parametresi (Faz 1).
    // Yoksa uc onu yok sayar, tam listeyi doner; adaptor yine dogru calisir.
    async fetchOrders(ctx, opts) {
        const o = opts || {};
        const d = await this._req(ctx, 'GET', '/api/business/orders', {
            query: { degisen_sonra: o.cursor || o.since || '' },
        });
        const list = (d && d.orders) || [];
        const damgalar = list.map((x) => x.guncellendi_at || x.created_at).filter(Boolean).sort();
        return {
            events: list.map((x) => this._toRawEvent(x)),
            nextCursor: damgalar.length ? damgalar[damgalar.length - 1] : (o.cursor || null),
            hasMore: false,
        };
    }

    async fetchOrder(ctx, { externalOrderId }) {
        const d = await this._req(ctx, 'GET', '/api/business/orders');
        const o = ((d && d.orders) || []).find((x) => String(x.id) === String(externalOrderId));
        return { event: o ? this._toRawEvent(o) : null };
    }

    // Webhook ve tarama AYNI RawEvent'i uretir -> ayni boru hattina girer.
    _toRawEvent(o) {
        return {
            externalOrderId: String(o.id),
            platformStatus: o.status,
            eventKey: String(o.id) + ':' + o.status + ':' + (o.son_olay_id || o.guncellendi_at || ''),
            occurredAt: M.zamanaMs(o.guncellendi_at || o.created_at),
            payload: o,
        };
    }

    async normalizeOrder(_ctx, rawEvent) {
        const o = rawEvent.payload || {};
        const unmapped = [];

        const status = M.STATUS_TO_NORMALIZED[o.status];
        if (!status) unmapped.push('status=' + o.status);
        const pay = M.PAYMENT[o.payment_method];
        if (!pay) unmapped.push('payment_method=' + o.payment_method);
        const mode = M.DELIVERY_TO_MODE[o.delivery_type];
        if (!mode) unmapped.push('delivery_type=' + o.delivery_type);

        // Adres KVKK imhasiyla anonimlestirilmis olabilir - cokmeden gecmeli.
        let adres = null;
        try {
            adres = typeof o.address_json === 'string' ? JSON.parse(o.address_json) : o.address_json;
        } catch (_) { adres = null; }

        const items = (o.items || []).map((it) => {
            const secMetin = M.seceneklerMetne(it.options_json);
            // Secenekler POS'ta modellenmedigi icin kalem NOTUNA donduruluyor:
            // mutfak "buyuk boy, acili" bilgisini boyle gorur.
            const not = [secMetin, it.note].filter(Boolean).join(' | ') || null;
            return {
                externalItemId: it.id != null ? String(it.id) : null,
                externalProductId: it.product_id != null ? String(it.product_id) : null,
                name: it.name,
                quantity: Number(it.qty) || 1,
                unitPriceKurus: Number(it.unit_price_kurus) || 0,
                lineTotalKurus: Number(it.total_kurus) || 0,
                isCancelled: 0,
                modifiers: [], extras: [], removed: [],
                secenekMetni: secMetin || null,
                note: not,
            };
        });

        return {
            order: {
                externalOrderId: String(o.id),
                externalOrderNo: o.code || null,
                subChannel: null,
                status: status || 'NEW',
                platformStatusRaw: o.status || null,
                deliveryMode: mode || 'UNKNOWN',
                isTest: 0,
                isAddressMasked: adres && adres.silindi ? 1 : 0,
                placedAt: M.zamanaMs(o.created_at),
                platformModifiedAt: M.zamanaMs(o.guncellendi_at || o.confirmed_at || o.created_at),
                prepTimeMinutes: null,
                customer: { name: o.customer_name || null, phone: o.customer_phone || null, isMasked: 0 },
                address: adres ? {
                    district: adres.district || null,
                    line1: adres.full_address || null,
                    note: adres.note || null,
                    isMasked: adres.silindi ? 1 : 0,
                } : null,
                payment: {
                    settlement: (pay && pay.settlement) || 'UNKNOWN',
                    methodCode: o.payment_method || null,
                    posMethod: (pay && pay.posMethod) || 'DIGER',
                    // SofraMix 'teslim' yazinca kapida odemeyi kendiliginden 'odendi'
                    // yapiyor. Tahsilatin SAHIBI POS'tur; bu alan yalnizca bilgi.
                    platformStatus: o.payment_status || null,
                },
                money: {
                    itemsTotalKurus: Number(o.items_total_kurus) || 0,
                    deliveryFeeKurus: Number(o.delivery_fee_kurus) || 0,
                    discountKurus: Number(o.kampanya_indirim_kurus) || 0,
                    grandTotalKurus: Number(o.total_kurus) || 0,
                    commissionAmountKurus: null,
                    sellerRevenueKurus: null,
                },
                currency: 'TRY',
                customerNote: o.customer_note || null,
                // POS kampanyayi ASLA yeniden hesaplamaz - SofraMix ne dediyse o.
                campaign: o.kampanya_baslik
                    ? { title: o.kampanya_baslik, discountKurus: Number(o.kampanya_indirim_kurus) || 0 }
                    : null,
                cancellation: o.cancel_reason
                    ? { by: 'PLATFORM', reasonCode: null, reasonText: o.cancel_reason } : null,
                items,
            },
            unmapped,
        };
    }

    // — Durum yazma —
    async _durumYaz(ctx, externalOrderId, durum, reason) {
        const yol = '/api/business/orders/' + encodeURIComponent(externalOrderId) + '/status';
        return this._req(ctx, 'POST', yol, {
            body: reason ? { status: durum, reason: reason } : { status: durum },
        });
    }

    acceptOrder(ctx, p) { return this._durumYaz(ctx, p.externalOrderId, 'onaylandi'); }
    markPreparing(ctx, p) { return this._durumYaz(ctx, p.externalOrderId, 'hazirlaniyor'); }
    markReady(ctx, p) { return this._durumYaz(ctx, p.externalOrderId, 'hazir'); }
    markDispatched(ctx, p) { return this._durumYaz(ctx, p.externalOrderId, 'yolda'); }
    markDelivered(ctx, p) { return this._durumYaz(ctx, p.externalOrderId, 'teslim'); }

    // SofraMix iptal sebebini ZORUNLU tutuyor (3-300 karakter) ve yolda/hazir
    // asamasinda iptali REDDEDER. Sunucuya bosuna gitmeden burada yakaliyoruz.
    async cancelOrder(ctx, p) {
        if (p.platformStatus && !M.iptalEdilebilir(p.platformStatus)) {
            throw new AdapterError(KIND.CONFLICT,
                'Bu asamada SofraMix siparisi iptal edilemez. "Teslim edilemedi" bildirimini kullanin.',
                { retryable: false });
        }
        const sebep = String(p.note || '').trim();
        if (sebep.length < 3) {
            throw new AdapterError(KIND.VALIDATION, 'Iptal sebebi en az 3 karakter olmali.', { retryable: false });
        }
        return this._durumYaz(ctx, p.externalOrderId, 'iptal', sebep.slice(0, 300));
    }

    rejectOrder(ctx, p) { return this.cancelOrder(ctx, p); }

    // yolda/hazir asamasinda iptal yerine bu kullanilir (sebep en az 10 karakter).
    async reportUndeliverable(ctx, p) {
        const sebep = String(p.note || '').trim();
        if (sebep.length < 10) {
            throw new AdapterError(KIND.VALIDATION,
                'Teslim edilemedi sebebi en az 10 karakter olmali.', { retryable: false });
        }
        const yol = '/api/business/orders/' + encodeURIComponent(p.externalOrderId) + '/teslim-edilemedi';
        return this._req(ctx, 'POST', yol, { body: { sebep: sebep } });
    }

    // — Menu okuma ("SofraMix'ten menuyu cek") —
    // Sozlesme SofraMix'in GERCEK yanitindan alindi (tahmin degil):
    //   GET /api/business/menu, baslik X-Smx-Anahtar. YALNIZ GET - yazma yolu YOK.
    // Fiyat BILEREK tasinmaz (Patron karari): isletme salon fiyatini kendi girer.
    // Urunler PASIF gelir ki 0 TL'lik urun kazara satilmasin.
    async pullMenu(ctx) {
        const d = await this._req(ctx, 'GET', '/api/business/menu');
        const kategoriler = ((d && d.categories) || []).map((c) => ({
            externalId: String(c.id), name: c.name, sort: Number(c.sort) || 0,
        }));

        const bilinmeyenKodlar = new Set();
        let beyansiz = 0;

        const urunler = ((d && d.products) || []).map((p) => {
            const a = M.alerjenAlanlari(p.alerjen);
            a.bilinmeyen.forEach((k) => bilinmeyenKodlar.add(k));
            if (!a.beyanEdildi) beyansiz++;

            // "Iz olarak icerebilir" bilgisi icerdigiyle KARISTIRILMAZ (fazla iddia
            // olurdu); icindekiler metnine ayri satir olarak ekleniyor.
            let icindekiler = (p.icindekiler || '').trim() || null;
            if (a.izMetni && a.izMetni.length) {
                const izAd = a.izMetni.join(', ');
                icindekiler = (icindekiler ? icindekiler + ' ' : '') + '(İz olarak içerebilir: ' + izAd + ')';
            }

            return {
                externalId: String(p.id),
                name: p.name,
                description: (p.description || '').trim() || null,
                externalCategoryId: p.category_id != null ? String(p.category_id) : null,
                imageUrl: p.image_url || null,
                sort: Number(p.sort) || 0,
                priceKurus: 0,        // BILEREK 0
                isActive: false,      // BILEREK pasif
                platformPriceKurus: Number(p.price_kurus) || 0,   // yalnizca bilgi
                // — Seffaf Menu alanlari (SofraMix 2026-09'da ekledi) —
                allergens: a.allergens,              // beyan yoksa NULL (bos dizi DEGIL)
                allergenBeyan: a.beyanEdildi,
                containsAlcohol: a.containsAlcohol,
                containsPork: a.containsPork,
                calories: p.enerji_kcal != null ? Number(p.enerji_kcal) : null,
                portionGrams: p.porsiyon_gram != null ? Number(p.porsiyon_gram) : null,
                ingredients: icindekiler,
            };
        });

        return {
            kategoriler, urunler, raw: d,
            // Cagiran taraf kullaniciya anlamli uyari gosterebilsin diye:
            beyansizUrun: beyansiz,
            bilinmeyenAlerjenKodu: [...bilinmeyenKodlar],
        };
    }

    async setStoreStatus(ctx, p) {
        return this._req(ctx, 'POST', '/api/business/pause', { body: { acik: !!p.open } });
    }
}

module.exports = { SofraMixAdapter };
