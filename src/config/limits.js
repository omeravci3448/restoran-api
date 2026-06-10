// Tier → masa sayısı sınırı eşlemesi
// Hub'da yeni TIER eklenirse buraya da satır eklemek gerekir (örn TIER_50_PLUS)
const TIER_TABLE_LIMITS = {
    TIER_1_5: 5,
    TIER_6_10: 10,
    TIER_11_20: 20,
    TIER_20_PLUS: Infinity
};

function getTableLimit(tier) {
    if (!tier) return 0;
    return TIER_TABLE_LIMITS[tier] ?? 5; // bilinmeyen tier varsa en küçük paket varsay
}

function tierLabel(tier) {
    return ({
        TIER_1_5: '1-5 masa',
        TIER_6_10: '6-10 masa',
        TIER_11_20: '11-20 masa',
        TIER_20_PLUS: '20+ masa'
    })[tier] || tier;
}

module.exports = { TIER_TABLE_LIMITS, getTableLimit, tierLabel };
