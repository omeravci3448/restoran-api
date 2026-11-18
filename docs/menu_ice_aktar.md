# Menü içe aktarma dosyası - biçim rehberi

"Kurulumu biz yapıyoruz" hizmetinde işletmenin menü fotoğraflarından bir dosya hazırlanır ve
yönetim panelinde **İşletme ayrıntısı > Menü içe aktar** penceresinden aktarılır.
Bu rehber, dosyayı hazırlayan asistan içindir. İki biçim kabul edilir: **JSON** (önerilen) ve **CSV**.

## Genel kurallar

- Yazımı fotoğraftaki gibi koruyun: Türkçe harfler (ç, ğ, ı, İ, ö, ş, ü) doğru yazılmalı.
- Ürün adı ve kategori adı en fazla 150 karakter; açıklama en fazla 1000 karakter.
- Fiyat TL cinsindendir. JSON'da sayı olarak yazın: `125` ya da `125.5`. Para birimi yazmayın.
- Fiyatı okunamayan ya da menüde olmayan üründe `fiyat` alanını boş bırakın (uydurmayın).
  Böyle ürünler **0 TL ve pasif** eklenir; işletme fiyatı girince satışa açılır.
- Aynı kategoride aynı ad iki kez yazılmamalı (büyük/küçük harf fark etmez); tekrar edenin ilki alınır.
- Alerjen bilgisi yalnız menüde açıkça yazıyorsa girilir. Yazmıyorsa alanı hiç koymayın:
  boş bırakmak "alerjen yok" anlamına gelmez, "beyan edilmedi" anlamına gelir.
- Görsel adresi yalnız `https://` ile başlayan tam adres olabilir; yoksa alanı koymayın.
- Fotoğrafta okunamayan bir şey için tahmin yürütmeyin; dosyayı teslim ederken ayrıca not düşün.

## JSON biçimi (önerilen)

```json
{
  "kategoriler": [
    { "ad": "Çorbalar", "sira": 1 },
    { "ad": "Izgaralar", "sira": 2 },
    { "ad": "Tatlılar", "sira": 3 }
  ],
  "urunler": [
    { "kategori": "Çorbalar", "ad": "Mercimek Çorbası", "fiyat": 90, "aciklama": "Limon ve kıtır ekmek ile" },
    { "kategori": "Izgaralar", "ad": "Adana Kebap", "fiyat": 320, "aciklama": "Közlenmiş biber, domates" },
    { "kategori": "Tatlılar", "ad": "Künefe", "fiyat": 150,
      "alerjenler": ["sut", "gluten"], "icindekiler": "Kadayıf, peynir, şerbet",
      "kalori": 520, "porsiyon": 200 },
    { "kategori": "Tatlılar", "ad": "Sütlaç", "aktif": false }
  ]
}
```

### Kategori alanları

| Alan | Zorunlu | Açıklama |
|---|---|---|
| `ad` | evet | Kategori adı. İşletmede aynı adlı kategori varsa o kullanılır, yenisi açılmaz. |
| `sira` | hayır | Menüdeki sıra (tam sayı, küçük olan önce). Verilmezse mevcutların arkasına eklenir. |

`kategoriler` listesi isteğe bağlıdır; ürünlerde geçen ama listede olmayan kategori yine açılır (uyarıyla).

### Ürün alanları

| Alan | Zorunlu | Açıklama |
|---|---|---|
| `kategori` | evet | Kategori adı (listedeki adla aynı yazılmalı). |
| `ad` | evet | Ürün adı. |
| `fiyat` | önerilir | TL, sayı. Yoksa ürün 0 TL ve pasif eklenir. |
| `aciklama` | hayır | Menüde ürün adının altında görünen kısa metin. |
| `aktif` | hayır | `true` (varsayılan) ya da `false`. `false` olan ürün menüde görünmez. |
| `alerjenler` | hayır | Alerjen kodları listesi (aşağıdaki tablo). |
| `icindekiler` | hayır | Bileşenler / içindekiler metni. |
| `kalori` | hayır | Porsiyon başı enerji (kcal), tam sayı. |
| `porsiyon` | hayır | Net gramaj (g), tam sayı. |
| `gorsel` | hayır | `https://` ile başlayan görsel adresi. |

### Alerjen kodları (14 zorunlu grup)

| Kod | Anlamı |
|---|---|
| `gluten` | Gluten içeren tahıllar |
| `kabuklu_deniz` | Kabuklu deniz ürünleri |
| `yumurta` | Yumurta |
| `balik` | Balık |
| `yer_fistigi` | Yer fıstığı |
| `soya` | Soya |
| `sut` | Süt (laktoz) |
| `sert_kabuklu` | Sert kabuklu yemişler (fındık, ceviz, badem...) |
| `kereviz` | Kereviz |
| `hardal` | Hardal |
| `susam` | Susam |
| `sulfit` | Kükürt dioksit / sülfitler |
| `lupin` | Acı bakla (lupin) |
| `yumusakca` | Yumuşakçalar |

Türkçe yazımlar da tanınır ("Süt", "yer fıstığı", "sert kabuklu"), ama kodları kullanmak en güvenlisidir.
Tanınmayan kod yok sayılır ve önizlemede uyarı olarak gösterilir.

## CSV biçimi

Basit menüler için. İlk satır başlıktır; ayırıcı noktalı virgül (`;`, önerilen) ya da virgül olabilir.
Excel'den "CSV UTF-8" olarak kaydedilebilir.

```
kategori;urun;fiyat;aciklama;aktif
Çorbalar;Mercimek Çorbası;90;Limon ve kıtır ekmek ile;evet
Izgaralar;Adana Kebap;320;Közlenmiş biber, domates;evet
Tatlılar;Künefe;150;;evet
Tatlılar;Sütlaç;;;hayır
```

- Zorunlu sütunlar: `kategori`, `urun`, `fiyat` (başlıkta bulunmalı; `fiyat` hücresi boş olabilir).
- İsteğe bağlı sütunlar: `aciklama`, `aktif`, `alerjenler`, `icindekiler`, `kalori`, `porsiyon`, `gorsel`.
- `aktif`: `evet`/`hayır` (ya da `1`/`0`); boşsa aktif sayılır.
- `fiyat`: `90`, `85,50` ya da `1.250` (binlik nokta) yazılabilir.
- `alerjenler`: kodlar `|` ile ayrılır, örnek `sut|gluten`.
- İçinde ayırıcı (`;` ya da `,`) geçen hücre çift tırnağa alınır: `"Yoğurtlu, tereyağlı"`.
  Hücrede çift tırnak varsa iki kez yazılır: `"Kuzu ""Şiş"""`.

## Aktarma şekli

- **Ekle** (varsayılan): Mevcut ürünlere dokunulmaz, yalnız yeni ürünler eklenir.
  Aynı kategoride aynı adlı ürün varsa atlanır.
- **Güncelle**: Ekle'ye ek olarak, aynı adlı mevcut ürünün fiyatı, açıklaması ve dosyada verilen
  alerjen / içindekiler / kalori / porsiyon bilgisi güncellenir. Fiyatı boş ya da 0 olan satır mevcut
  fiyatı değiştirmez. Ürünün satışta olup olmadığı ve görseli değişmez.
- Hiçbir şekilde ürün ya da kategori **silinmez**.

## Önizleme ve aktarma

1. Önce **Önizle**: hiçbir şey yazılmaz; eklenecek, güncellenecek ve atlanacak ürünler, uyarılar ve
   hatalar listelenir.
2. Hata varsa (ad boş, kategori boş, fiyat okunamadı, eksi fiyat, bozuk JSON...) aktarma yapılamaz;
   dosya düzeltilip yeniden önizlenir.
3. **Aktar**: hepsi tek seferde yazılır. Yazma sırasında bir sorun çıkarsa hiçbir değişiklik yapılmaz.
4. Her aktarma Yönetim Günlüğü'ne "Menü içe aktarma" olarak yazılır (önizleme yazılmaz).

Sınırlar: tek dosyada en fazla 2000 ürün, en fazla yaklaşık 2 MB.
