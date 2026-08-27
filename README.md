# football2d — FM 2006 Tarzı 2D Maç Simülatörü

Football Manager 2006'nın klasik 2D maç ekranını örnek alan, tarayıcıda çalışan
bir maç motoru + izleme arayüzü. Maç önce deterministik motorda simüle edilir,
sonra FM tarzı oynatılır: çizgili yeşil saha, numaralı daireler, isim etiketleri,
yorum bandı, skorboard ve **Önemli Anlar** modu.

## Çalıştırma

```bash
npm install
npm run dev      # http://localhost:5173
npm run test     # vitest (motor + denge testleri)
npm run build    # tip kontrolü + üretim derlemesi
```

## Headless denge aracı

Motor DOM'suz çalışır; yüzlerce maçı komut satırından simüle edip denge
raporu alabilirsiniz:

```bash
npm run sim -- --matches 200 --seed 1
```

Rapor: galibiyet dağılımı, gol ortalaması, şut/korner/faul/kart/pas
istatistikleri ve toplam gol dağılım histogramı.

## Mimari

Üç bağımsız katman:

1. **Simülasyon çekirdeği** (`src/engine/`) — sabit tick (10 tick/sn), seeded
   RNG (mulberry32; motor içinde `Math.random` yasak). Aynı seed → birebir aynı
   maç. Çıktı: kare dizisi (`Float32Array`) + olay listesi + istatistikler.
2. **Karar katmanı** — Utility AI: topu taşıyan oyuncu her seçeneğe puan verir
   (pas hattı açıklığı, alıcının alanı, pozisyon değeri, şut kalitesi, öndeki
   boşluk) ve en yüksek puanı seçer (`src/engine/decisions.ts`).
3. **Sunum** (`src/render/`, `src/ui/`) — Canvas 2D çizim, kayıttan oynatma
   (hız 1x-8x, duraklat), Türkçe yorum şablonları, istatistik paneli.

Kritik mekanikler:

- **Top sahipliği state machine**: top ya boşta (`loose`), ya bir oyuncuda
  (`possessed`), ya havada (`inFlight`). Boştaki topa takım başına yalnız en
  yakın 1-2 oyuncu gider; pas hedefi topun varış noktasına koşar, savunmadan da
  en yakın 2 oyuncu varış noktasına kapanır.
- **Pozisyon sistemi**: formasyondan gelen ev pozisyonu + topa göre blok
  kayması. Topsuz takım için çift yönlü kompaktlık: hatlar topun gerisine
  sınırsız çökmez, topun önünde de asılı kalmaz (`src/engine/positioning.ts`).
- **Restartlar**: santra, taç, korner (ceza sahasına ortayla), kale vuruşu,
  serbest vuruş, penaltı; faul → kart zarları (sarı/çift sarı/kırmızı).
- **Önemli anlar**: olay listesinden şut/gol/kart/korner çevresi pencereler
  çıkarılır (`src/engine/highlights.ts`); oynatıcı yalnız bu pencereleri
  izletir, saat aralarda atlar.

## Oyun sistemleri

- **Ofsayt**: çizgi sondan ikinci savunmacıdan hesaplanır; hücumcular çizgiye
  saygılı pozisyon alır, sınırdaki paslar bayrağa takılır (taç/santra/kale
  vuruşu muaf).
- **Görev (rol) sistemi**: her formasyon slotu FM tarzı bir iş taşır —
  bindiren bek, top oynayan stoper, ön libero, oyun kurucu, klasik/içe katan
  kanat, hedef adam, kutu golcüsü (`SlotJob`, `formations.ts`). Görevler
  pozisyon ofsetlerini (toplu oyunda kimlik) ve karar yanlılıklarını eğer;
  ortalar kutudaki hava topu ustasını arar, duran topları en iyi pasör
  kullanır. Bindiren bek topsuzken bek disipliniyle savunur (son adam kuralı
  dahil). Sonuç: kadro-sistem uyumu maç sonucunu ham nitelik ortalaması
  kadar etkiler ve formasyonlar arasında doğal bir taş-kağıt-makas doğar
  (3-5-2 kanat disipliniyle 4-3-3'ü frenler, 4-3-3 orta saha üçgeniyle düz
  4-4-2'ye üstündür, 4-4-2 ile 4-2-3-1 dengelidir).
- **Görev tabanlı savunma**: topa takım başına tek görevli (first defender),
  bir cover, alıcının markajcısı adamıyla iniş noktasına gider; kalanlar
  adam adama markaj/şekil tutar. Son adam kuralı: hat en derin koşucuyu izler.
  Baskı hattı tavanı: full saha pres yok; forvetler prese isteksizdir.
- **Balistik havadan top**: uzun paslar, ortalar ve degajlar gerçek
  yerçekimiyle entegre uçar; inişte seker (uçuş tipine göre çim emilimi:
  ağırlıklı pas alıcının önünde oturur, degaj zıplayarak yol alır) ve hız
  sürekliliğiyle yuvarlanmaya devreder. Falso gerçek yanal ivmedir (iç/dış
  bombeli koşu görünür); AI topun iniş noktasını değil sekme dahil DURUŞ
  noktasını okur. Havadaki topa ayak uzanmaz, bloğun üstünden aşırtma işler.
- **Geometrik şut modeli**: şutör kale ağzında gerçek bir noktaya nişan alır,
  yürütme hatası örneklenir; kaleci GERÇEK konumundan açı kapatma
  geometrisiyle (kendi düzleminde) kesişmeye uzanmaya çalışır. Gol, kurtarış,
  aut ve direk bu geometriden kendiliğinden doğar; kafa vuruşu daha yavaş ve
  dağınıktır; xG aynı geometrinin Gauss-Hermite integralidir
  (`src/engine/shooting.ts`, `src/engine/xg.ts`).
- **Doku**: baskı altında pas hatası büyür, pas hızları değişkendir, top
  sürme kararlı ve görünürdür, baskı altındaki taşıyıcıya takım arkadaşları
  pas açısı yaratır, oyuncular enerjilerini idareli kullanır.

## Bilinçli sadeleştirmeler

- Yorumlar şablon tabanlı Türkçe metinlerdir.
- Şut uçuşu parametriktir (kale düzleminde geometrik çözüldüğü için);
  pas/orta/degaj tam balistiktir.
- Geri pas kuralı yok (kaleci her topu elle alabilir); avantajdan düdüğe
  geri dönüş yok.

## Denge notları

Nitelikler (1-20; hız, pas, şut, top sürme, müdahale, pozisyon alma,
kalecilik, dayanıklılık) motor katsayılarına `src/engine/attributes.ts`
üzerinden bağlanır; denge ayarı bu dosya + `decisions.ts` puan ağırlıkları +
`duels.ts`/`shooting.ts` olasılıklarından yapılır. Mevcut ayar gerçek maç
istatistiklerine kalibredir (~16-40 maçlık taramalarda): maç başına ~2.5-3
gol, takım başına ~11-15 şut, ~400-750 pas (%74-82 isabet), ~10-14 faul,
~1.5 sarı kart, ~2-4 korner, maç başına ~2-4 ofsayt; penaltı dönüşümü ~%76-80; ölü top süreleri
gerçekçidir (taç ~12 sn, kale vuruşu/korner ~13 sn) ve topun oyunda kalma
süresi gerçek maç seviyesine iner. Kadro gücü kazandırır ama tek başına
yetmez: oyuncuların slot görevlerine uyumu (hızlı kanat → içe katan kanat,
uzun forvet → hedef adam) sonucu ham ortalama kadar etkiler.
`tests/balance.test.ts` bu bantları regresyon olarak kilitler.
