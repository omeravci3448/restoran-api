const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = process.env.NODE_ENV === 'production'
    ? '/app/data/database.sqlite'
    : path.resolve(__dirname, '../../database.sqlite');

if (process.env.NODE_ENV === 'production' && !fs.existsSync('/app/data')) {
    try { fs.mkdirSync('/app/data', { recursive: true }); } catch (_) {}
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (!err) {
        db.run('PRAGMA journal_mode=WAL');
        db.run('PRAGMA foreign_keys=ON');
        // Eş zamanlı yazımda (kasiyer + garson + QR menü aynı anda) SQLITE_BUSY
        // hemen atılmasın, 5sn beklesin — çok kullanıcılı canlı ortam için kritik.
        db.run('PRAGMA busy_timeout=5000');
    }
});

// Ham sorgu — kilitsiz, doğrudan tek bağlantıya gider.
const rawQuery = (sql, params = []) => new Promise((resolve, reject) => {
    const op = sql.trim().toUpperCase();
    if (op.startsWith('SELECT') || op.startsWith('PRAGMA') || op.startsWith('WITH')) {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve({ rows }));
    } else {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ rows: [], lastID: this.lastID, changes: this.changes });
        });
    }
});

// ——— Serileştirme kilidi ———
// node-sqlite3 TEK bağlantı kullanıyor. Manuel BEGIN/COMMIT transaction'lar
// eşzamanlı isteklerle iç içe geçerse ("transaction within a transaction")
// bağlantı bozulur ve tüm sorgular asılı kalır (üretimdeki donma buydu).
// Çözüm: tüm sorgu/transaction'ları tek bir promise zincirinden geçir →
// transaction sınırları atomik kalır, araya başka istek giremez.
// AsyncLocalStorage ile "transaction içindeyim" bağlamı SADECE o transaction'ın
// async zincirine taşınır → başka istekler kilide takılıp bekler, sızamaz.
const { AsyncLocalStorage } = require('async_hooks');
const _als = new AsyncLocalStorage();

let _lock = Promise.resolve();
function _runLocked(fn) {
    const run = _lock.then(fn, fn);
    _lock = run.then(() => {}, () => {}); // hata olsa da zincir devam etsin
    return run;
}

const query = (sql, params = []) => {
    // SADECE bu transaction'ın kendi async bağlamındaki query'ler kilidi atlar
    if (_als.getStore()?.inTx) return rawQuery(sql, params);
    return _runLocked(() => rawQuery(sql, params));
};

// Transaction: kilidi tüm süre boyunca tutar. fn içindeki query'ler aynı async
// bağlamda olduğu için kilidi tekrar almaz (deadlock önlemi). Başka isteklerin
// query'leri farklı bağlamda → kilitte bekler. BEGIN..COMMIT arasına kimse giremez.
const tx = (fn) => _runLocked(() => _als.run({ inTx: true }, async () => {
    await rawQuery('BEGIN IMMEDIATE');
    try { const r = await fn(); await rawQuery('COMMIT'); return r; }
    catch (e) { await rawQuery('ROLLBACK').catch(() => {}); throw e; }
}));

const initDb = () => {
    db.serialize(() => {
        // — TENANTS (her restoran/cafe ayrı tenant) —
        db.run(`CREATE TABLE IF NOT EXISTS tenants (
            id TEXT PRIMARY KEY,
            slug TEXT UNIQUE NOT NULL,
            business_code TEXT UNIQUE,
            business_name TEXT NOT NULL,
            owner_email TEXT,
            phone TEXT,
            address TEXT,
            billing_name TEXT,
            billing_address TEXT,
            billing_tax_id TEXT,
            billing_tax_office TEXT,
            referral_code TEXT UNIQUE,
            referred_by TEXT,
            discount_rate INTEGER DEFAULT 0,
            currency TEXT DEFAULT 'TRY',
            tax_rate REAL DEFAULT 10,
            license_tier TEXT,
            license_modules TEXT,
            license_end_date TEXT,
            license_table_limit INTEGER,
            manager_pin TEXT,
            kvkk_consent_at TEXT,
            kvkk_consent_version TEXT,
            closure_requested_at TEXT,
            show_cost_analytics INTEGER DEFAULT 1,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        // Mevcut DB'ler için migration — yoksa sessizce eklesin
        db.run("ALTER TABLE tenants ADD COLUMN show_cost_analytics INTEGER DEFAULT 1", [], () => {});
        db.run("ALTER TABLE tenants ADD COLUMN business_code TEXT", [], () => {});
        db.run("ALTER TABLE tenants ADD COLUMN billing_name TEXT", [], () => {});
        db.run("ALTER TABLE tenants ADD COLUMN billing_address TEXT", [], () => {});
        db.run("ALTER TABLE tenants ADD COLUMN billing_tax_id TEXT", [], () => {});
        db.run("ALTER TABLE tenants ADD COLUMN billing_tax_office TEXT", [], () => {});
        db.run("ALTER TABLE tenants ADD COLUMN referral_code TEXT", [], () => {});
        db.run("ALTER TABLE tenants ADD COLUMN referred_by TEXT", [], () => {});
        db.run("ALTER TABLE tenants ADD COLUMN discount_rate INTEGER DEFAULT 0", [], () => {});
        db.run("ALTER TABLE tenants ADD COLUMN license_table_limit INTEGER", [], () => {});
        db.run("ALTER TABLE tenants ADD COLUMN manager_pin TEXT", [], () => {}); // yönetici şifresi (hash) — rapor/ayar/lisans kilidi
        db.run("ALTER TABLE tenants ADD COLUMN kvkk_consent_at TEXT", [], () => {});        // KVKK açık rıza zamanı
        db.run("ALTER TABLE tenants ADD COLUMN kvkk_consent_version TEXT", [], () => {});    // onaylanan metin sürümü
        db.run("ALTER TABLE tenants ADD COLUMN closure_requested_at TEXT", [], () => {});    // hesap kapatma talebi zamanı

        // — USERS (kasiyer, garson, yönetici) —
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            email TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            name TEXT,
            role TEXT DEFAULT 'CASHIER',
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(tenant_id, email),
            FOREIGN KEY(tenant_id) REFERENCES tenants(id)
        )`);

        // — TABLES (masalar) —
        db.run(`CREATE TABLE IF NOT EXISTS tables (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            section TEXT,
            capacity INTEGER DEFAULT 4,
            qr_token TEXT UNIQUE NOT NULL,
            status TEXT DEFAULT 'EMPTY',
            position_x INTEGER DEFAULT 0,
            position_y INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(tenant_id, code),
            FOREIGN KEY(tenant_id) REFERENCES tenants(id)
        )`);

        // — CATEGORIES (menü kategorileri) —
        db.run(`CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            name TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(tenant_id) REFERENCES tenants(id)
        )`);

        // — PRODUCTS (ürünler — stoklu veya stoksuz) —
        db.run(`CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            category_id TEXT,
            name TEXT NOT NULL,
            description TEXT,
            price REAL NOT NULL DEFAULT 0,
            cost REAL DEFAULT 0,
            image_url TEXT,
            tracks_stock INTEGER DEFAULT 1,
            stock_qty REAL DEFAULT 0,
            stock_unit TEXT DEFAULT 'adet',
            low_stock_threshold REAL DEFAULT 0,
            is_available INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            tax_rate REAL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(tenant_id) REFERENCES tenants(id),
            FOREIGN KEY(category_id) REFERENCES categories(id)
        )`);

        // — ORDERS (siparişler, masa veya pazaryeri kaynaklı) —
        db.run(`CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            table_id TEXT,
            channel TEXT DEFAULT 'DINE_IN',
            external_ref TEXT,
            status TEXT DEFAULT 'OPEN',
            subtotal REAL DEFAULT 0,
            tax_total REAL DEFAULT 0,
            discount REAL DEFAULT 0,
            total REAL DEFAULT 0,
            note TEXT,
            opened_by TEXT,
            opened_at TEXT DEFAULT CURRENT_TIMESTAMP,
            closed_at TEXT,
            FOREIGN KEY(tenant_id) REFERENCES tenants(id),
            FOREIGN KEY(table_id) REFERENCES tables(id),
            FOREIGN KEY(opened_by) REFERENCES users(id)
        )`);

        // — ORDER ITEMS —
        db.run(`CREATE TABLE IF NOT EXISTS order_items (
            id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL,
            product_id TEXT,
            product_name TEXT NOT NULL,
            qty REAL NOT NULL DEFAULT 1,
            unit TEXT,
            unit_price REAL NOT NULL,
            total REAL NOT NULL,
            status TEXT DEFAULT 'NEW',
            note TEXT,
            source TEXT DEFAULT 'STAFF',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY(product_id) REFERENCES products(id)
        )`);
        // Migration: var olan DB'lere unit kolonu ekle (idempotent)
        db.run("ALTER TABLE order_items ADD COLUMN unit TEXT", [], () => {});

        // — PAYMENTS (her sipariş için 1+ ödeme, farklı yöntemlerle split) —
        db.run(`CREATE TABLE IF NOT EXISTS payments (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            order_id TEXT NOT NULL,
            method TEXT NOT NULL,
            amount REAL NOT NULL,
            ref TEXT,
            created_by TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(tenant_id) REFERENCES tenants(id),
            FOREIGN KEY(order_id) REFERENCES orders(id),
            FOREIGN KEY(created_by) REFERENCES users(id)
        )`);

        // — STOCK MOVEMENTS (giriş / çıkış / sayım) —
        db.run(`CREATE TABLE IF NOT EXISTS stock_movements (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            qty REAL NOT NULL,
            unit_cost REAL DEFAULT 0,
            ref_type TEXT,
            ref_id TEXT,
            note TEXT,
            created_by TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(tenant_id) REFERENCES tenants(id),
            FOREIGN KEY(product_id) REFERENCES products(id)
        )`);

        // — SUPPLIERS (tedarikçi/firma) —
        db.run(`CREATE TABLE IF NOT EXISTS suppliers (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            name TEXT NOT NULL,
            contact TEXT,
            phone TEXT,
            email TEXT,
            note TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(tenant_id) REFERENCES tenants(id)
        )`);

        // — WAITER CALLS (masadan garson çağrısı) —
        db.run(`CREATE TABLE IF NOT EXISTS waiter_calls (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            table_id TEXT NOT NULL,
            reason TEXT DEFAULT 'GENERIC',
            status TEXT DEFAULT 'PENDING',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            handled_at TEXT,
            handled_by TEXT,
            FOREIGN KEY(tenant_id) REFERENCES tenants(id),
            FOREIGN KEY(table_id) REFERENCES tables(id),
            FOREIGN KEY(handled_by) REFERENCES users(id)
        )`);

        // — LICENSE CACHE (hub cevabı local'de tutulur, offline çalışma için) —
        db.run(`CREATE TABLE IF NOT EXISTS license_cache (
            tenant_id TEXT PRIMARY KEY,
            payload TEXT,
            checked_at TEXT,
            FOREIGN KEY(tenant_id) REFERENCES tenants(id)
        )`);

        // — PENDING REGISTRATIONS (OTP doğrulanmadan tenant açılmasın) —
        db.run(`CREATE TABLE IF NOT EXISTS pending_registrations (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            form_data TEXT NOT NULL,
            otp_code TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            attempts INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_pending_email ON pending_registrations(email)`);

        // Faydalı index'ler
        db.run(`CREATE INDEX IF NOT EXISTS idx_orders_tenant_status ON orders(tenant_id, status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_orders_tenant_opened ON orders(tenant_id, opened_at)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_stock_product ON stock_movements(product_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_tables_qr ON tables(qr_token)`);
    });
};

module.exports = { db, query, tx, initDb };
