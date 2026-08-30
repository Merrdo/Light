/* ======================================================================
   KAR EFEKTİ — Sakin Kış Teması
   ----------------------------------------------------------------------
   Üstten karışık (farklı boyut/hız/derinlikte) kar taneleri yağar ve
   alt tarafta gerçekçi bir fizik modeliyle (sürtünme/terminal hız,
   rüzgar sapması, zemine göre birikme + çığ/yayılma düzeltmesi) birikir.

   Kullanım:
     <script src="kar-efekti.js" defer></script>
   eklendiği an otomatik başlar. Sayfanın data-theme="dark" özniteliğini
   izleyip renklerini buna göre otomatik ayarlar.

   Dışa açılan basit kontrol arayüzü:
     window.karEfekti.baslat()
     window.karEfekti.durdur()
     window.karEfekti.temizle()   // birikmiş karı sıfırlar
     window.karEfekti.aktifMi()   // true/false
   ====================================================================== */
(function () {
  'use strict';

  // ---- Zaten yüklenmişse tekrar başlatma ----
  if (window.karEfekti) return;

  // ================= AYARLAR =================
  var AYAR = {
    sutunGenisligi: 4,        // birikme yüksek haritasında sütun genişliği (px)
    maxBirikimOrani: 0.15,    // ekran yüksekliğinin en fazla yüzde kaçı kar ile kaplanabilir
    esikEgim: 3.2,            // çığ/yayılma tetikleyen komşu sütun yükseklik farkı (px)
    ruzgarYavaslik: 0.985,    // rüzgarın hedefe yaklaşma yumuşaklığı (1'e ne kadar yakınsa o kadar ağır/atıl)
    surtunmeKatsayisi: 2.0,   // taneciğin terminal hıza yaklaşma oranı (sürükleme kuvveti benzetimi)
    zeminAralikSaniye: 0.6    // birikmiş kar çizimini yeniden oluşturma için "kirli" bekleme eşiği yoktur, her karede kontrol edilir
  };

  // Derinlik katmanları: uzak/orta/yakın karışımı ile "karışık yağış" hissi
  var KATMANLAR = [
    { rMin: 0.6, rMax: 1.3, vMin: 16, vMax: 28, opMin: 0.22, opMax: 0.40, ruzgarDuyarlilik: 1.55, agirlik: 0.45 },
    { rMin: 1.3, rMax: 2.3, vMin: 28, vMax: 46, opMin: 0.42, opMax: 0.68, ruzgarDuyarlilik: 1.05, agirlik: 0.35 },
    { rMin: 2.3, rMax: 4.0, vMin: 46, vMax: 72, opMin: 0.68, opMax: 0.95, ruzgarDuyarlilik: 0.60, agirlik: 0.20 }
  ];

  // ================= DURUM =================
  var canvas, ctx;
  var genislik = 0, yukseklik = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  var taneler = [];
  var yukHaritasi = [];       // her sütunun birikmiş kar yüksekliği (px, zeminden itibaren)
  var sutunSayisi = 0;
  var maxYukseklikPx = 0;
  var koyuTema = false;
  var azaltilmisHareket = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var calisiyor = false;
  var rafId = null;
  var sonZamanDamgasi = null;
  var globalZaman = 0;
  var ruzgarMevcut = 0;
  var birikimKirli = true;    // birikim yolu yeniden çizilmeli mi
  var parlamaNoktalari = [];  // birikmiş kar üzerinde ince ışıltı noktaları

  // ================= YARDIMCI FONKSİYONLAR =================
  function rastgele(a, b) { return a + Math.random() * (b - a); }
  function sinirla(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function temaOku() {
    try {
      koyuTema = document.documentElement.getAttribute('data-theme') === 'dark';
    } catch (e) { koyuTema = false; }
  }

  function karRengi(opaklik) {
    // Koyu temada saf beyaz parıltı, açık temada hafif mavimsi-kirli beyaz (arka planla uyumlu)
    return koyuTema
      ? 'rgba(255,255,255,' + opaklik + ')'
      : 'rgba(232,238,245,' + opaklik + ')';
  }

  function birikimRengi(opaklik) {
    return koyuTema
      ? 'rgba(226,232,240,' + opaklik + ')'
      : 'rgba(255,255,255,' + opaklik + ')';
  }

  // ================= KURULUM / BOYUTLANDIRMA =================
  function olustur() {
    canvas = document.createElement('canvas');
    canvas.id = 'kar-efekti-canvas';
    canvas.style.position = 'fixed';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '0';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');

    temaOku();
    boyutlandir();
    tanelerHazirla();

    window.addEventListener('resize', boyutuGuncelle, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { durdurDongu(); } else if (calisiyor) { dongubaslat(); }
    });

    if (window.MutationObserver) {
      new MutationObserver(function () {
        var eski = koyuTema;
        temaOku();
        if (eski !== koyuTema) birikimKirli = true;
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    // "Arka Plan Animasyonu" ayarında birden fazla seçenek (Işık Huzmesi /
    // Yıldız Gecesi / Kar Yağışı) birbirini dışlar. Bu yüzden kar efekti,
    // yalnızca data-bganim="kar" seçiliyken görünür ve çalışır durumda
    // başlatılır; diğer durumlarda canvas gizli ve döngü duraklatılmış kalır
    // (gereksiz CPU/GPU kullanımını önlemek için).
    var baslangictaAktif = document.documentElement.getAttribute('data-bganim') === 'kar';
    canvas.style.display = baslangictaAktif ? '' : 'none';
    calisiyor = baslangictaAktif;
    if (baslangictaAktif) dongubaslat();
  }

  var boyutZamanlayici = null;
  function boyutuGuncelle() {
    clearTimeout(boyutZamanlayici);
    boyutZamanlayici = setTimeout(boyutlandir, 150);
  }

  function boyutlandir() {
    var eskiSutunSayisi = sutunSayisi;
    var eskiHarita = yukHaritasi;
    var eskiYukseklik = yukseklik;

    genislik = window.innerWidth;
    yukseklik = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.floor(genislik * dpr);
    canvas.height = Math.floor(yukseklik * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    sutunSayisi = Math.max(1, Math.ceil(genislik / AYAR.sutunGenisligi));
    maxYukseklikPx = yukseklik * AYAR.maxBirikimOrani;

    var yeniHarita = new Array(sutunSayisi).fill(0);
    if (eskiSutunSayisi > 0 && eskiHarita && eskiYukseklik > 0) {
      // Önceki birikimi yeni genişliğe oransal olarak aktar
      var olcekY = eskiYukseklik > 0 ? 1 : 1;
      for (var i = 0; i < sutunSayisi; i++) {
        var kaynakIndeks = Math.min(eskiSutunSayisi - 1, Math.floor(i * eskiSutunSayisi / sutunSayisi));
        yeniHarita[i] = Math.min(eskiHarita[kaynakIndeks] || 0, maxYukseklikPx);
      }
    }
    yukHaritasi = yeniHarita;
    birikimKirli = true;
  }

  // ================= KAR TANELERİ =================
  function hedefTaneSayisi() {
    var taban = (genislik * yukseklik) / 9000;
    taban = sinirla(taban, 30, 200);
    return Math.round(azaltilmisHareket ? taban / 4 : taban);
  }

  function yeniTane() {
    // Katmanlar ağırlıklarına göre karışık seçilir (uzak/orta/yakın karışımı)
    var r = Math.random(), toplam = 0, katman = KATMANLAR[0];
    for (var i = 0; i < KATMANLAR.length; i++) {
      toplam += KATMANLAR[i].agirlik;
      if (r <= toplam) { katman = KATMANLAR[i]; break; }
    }
    var yaricap = rastgele(katman.rMin, katman.rMax);
    return {
      x: rastgele(0, genislik),
      y: rastgele(-yukseklik * 0.3, -4),
      yaricap: yaricap,
      vy: 0,
      terminalVy: rastgele(katman.vMin, katman.vMax),
      opaklik: rastgele(katman.opMin, katman.opMax),
      ruzgarDuyarlilik: katman.ruzgarDuyarlilik,
      sallanmaFaz: rastgele(0, Math.PI * 2),
      sallanmaHizi: rastgele(0.5, 1.1),
      sallanmaGenislik: rastgele(6, 18) * (yaricap / 2.5 + 0.4),
      parlaklikFaz: rastgele(0, Math.PI * 2)
    };
  }

  function tanelerHazirla() {
    taneler = [];
    var hedef = hedefTaneSayisi();
    for (var i = 0; i < hedef; i++) {
      var t = yeniTane();
      t.y = rastgele(-yukseklik, yukseklik); // ilk yüklemede ekrana yayılmış başlasın
      taneler.push(t);
    }
  }

  // ================= FİZİK =================
  function ruzgarGuncelle(dt) {
    // Yavaş, birden fazla sinüs dalgasının toplamıyla oluşan doğal/pürüzsüz rüzgar salınımı
    globalZaman += dt;
    var hedef = Math.sin(globalZaman * 0.06) * 10 + Math.sin(globalZaman * 0.017 + 1.4) * 5;
    ruzgarMevcut += (hedef - ruzgarMevcut) * (1 - AYAR.ruzgarYavaslik) * dt * 6;
  }

  function taneFizigiGuncelle(t, dt) {
    // Sürükleme (drag) benzetimi: hız, terminal hıza üstel biçimde yaklaşır (gerçek kar tanesi düşüşüne yakın)
    t.vy += (t.terminalVy - t.vy) * (1 - Math.exp(-AYAR.surtunmeKatsayisi * dt));
    t.y += t.vy * dt;

    t.sallanmaFaz += t.sallanmaHizi * dt;
    var sallanma = Math.sin(t.sallanmaFaz) * t.sallanmaGenislik * dt * 0.6;
    var ruzgarEtkisi = ruzgarMevcut * t.ruzgarDuyarlilik * dt;
    t.x += sallanma + ruzgarEtkisi;

    if (t.x < -10) t.x = genislik + 10;
    if (t.x > genislik + 10) t.x = -10;
  }

  function zeminYuksekligi(x) {
    var s = sinirla(Math.floor(x / AYAR.sutunGenisligi), 0, sutunSayisi - 1);
    return yukHaritasi[s] || 0;
  }

  function birikimEkle(x, yaricap) {
    var merkezSutun = sinirla(Math.floor(x / AYAR.sutunGenisligi), 0, sutunSayisi - 1);
    var etkiYaricapi = Math.max(1, Math.round((yaricap * 1.8) / AYAR.sutunGenisligi));
    var mevcutYuk = yukHaritasi[merkezSutun];
    if (mevcutYuk >= maxYukseklikPx - 0.5) return; // kapasite dolu: tane sessizce zemine karışır

    var eklenecek = yaricap * rastgele(0.55, 0.9);
    for (var d = -etkiYaricapi; d <= etkiYaricapi; d++) {
      var s = merkezSutun + d;
      if (s < 0 || s >= sutunSayisi) continue;
      var azalma = 1 - Math.abs(d) / (etkiYaricapi + 1);
      yukHaritasi[s] = sinirla(yukHaritasi[s] + eklenecek * azalma * azalma, 0, maxYukseklikPx);
    }

    cigDagilimiUygula(merkezSutun, etkiYaricapi + 4);
    birikimKirli = true;

    if (Math.random() < 0.12 && parlamaNoktalari.length < 46) {
      parlamaNoktalari.push({
        x: x,
        sutun: merkezSutun,
        faz: rastgele(0, Math.PI * 2),
        hiz: rastgele(0.6, 1.4)
      });
    }
  }

  function cigDagilimiUygula(merkez, genislikSutun) {
    // Basit "kum yığını" (sandpile) benzetimi: dik eğimleri komşulara yayarak
    // doğal, yuvarlak bir kar birikintisi görünümü oluşturur.
    var bas = sinirla(merkez - genislikSutun, 0, sutunSayisi - 1);
    var son = sinirla(merkez + genislikSutun, 0, sutunSayisi - 1);
    for (var tur = 0; tur < 3; tur++) {
      for (var i = bas; i < son; i++) {
        var fark = yukHaritasi[i] - yukHaritasi[i + 1];
        if (Math.abs(fark) > AYAR.esikEgim) {
          var aktar = (Math.abs(fark) - AYAR.esikEgim) * 0.5 * (fark > 0 ? 1 : -1);
          yukHaritasi[i] -= aktar * 0.5;
          yukHaritasi[i + 1] += aktar * 0.5;
        }
      }
    }
  }

  function fizigiIlerlet(dt) {
    ruzgarGuncelle(dt);
    var hedefSayi = hedefTaneSayisi();

    for (var i = taneler.length - 1; i >= 0; i--) {
      var t = taneler[i];
      taneFizigiGuncelle(t, dt);

      var yuzeyY = yukseklik - zeminYuksekligi(t.x);
      if (t.y + t.yaricap >= yuzeyY) {
        birikimEkle(t.x, t.yaricap);
        taneler.splice(i, 1);
      }
    }

    while (taneler.length < hedefSayi) {
      var yeni = yeniTane();
      taneler.push(yeni);
    }
    if (taneler.length > hedefSayi) taneler.length = hedefSayi;
  }

  // ================= ÇİZİM =================
  function birikimCiz() {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, yukseklik);
    ctx.lineTo(0, yukseklik - yukHaritasi[0]);
    for (var i = 0; i < sutunSayisi; i++) {
      ctx.lineTo(i * AYAR.sutunGenisligi, yukseklik - yukHaritasi[i]);
    }
    ctx.lineTo(genislik, yukseklik);
    ctx.closePath();

    var grad = ctx.createLinearGradient(0, yukseklik - maxYukseklikPx, 0, yukseklik);
    grad.addColorStop(0, birikimRengi(koyuTema ? 0.9 : 0.96));
    grad.addColorStop(1, birikimRengi(koyuTema ? 0.75 : 0.88));
    ctx.fillStyle = grad;
    ctx.fill();

    // üst kenara ince, aydınlık bir çizgi — kar yüzeyinin ışığı yansıtması hissi
    ctx.beginPath();
    ctx.moveTo(0, yukseklik - yukHaritasi[0]);
    for (var j = 0; j < sutunSayisi; j++) {
      ctx.lineTo(j * AYAR.sutunGenisligi, yukseklik - yukHaritasi[j]);
    }
    ctx.strokeStyle = karRengi(koyuTema ? 0.5 : 0.65);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    birikimKirli = false;
  }

  function taneCiz(t) {
    var renk = karRengi(t.opaklik);
    if (t.yaricap > 2.1) {
      var g = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, t.yaricap);
      g.addColorStop(0, karRengi(t.opaklik));
      g.addColorStop(1, karRengi(0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.yaricap, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = renk;
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.yaricap, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function parlamalariCiz(dt) {
    for (var i = 0; i < parlamaNoktalari.length; i++) {
      var p = parlamaNoktalari[i];
      p.faz += p.hiz * dt;
      var y = yukseklik - zeminYuksekligi(p.x) - 1;
      var alfa = (Math.sin(p.faz) * 0.5 + 0.5) * 0.35;
      ctx.fillStyle = karRengi(alfa);
      ctx.beginPath();
      ctx.arc(p.x, y, 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function ciz(dt) {
    ctx.clearRect(0, 0, genislik, yukseklik);
    birikimCiz();
    parlamalariCiz(dt);
    for (var i = 0; i < taneler.length; i++) taneCiz(taneler[i]);
  }

  // ================= DÖNGÜ =================
  function kare(zamanDamgasi) {
    if (!calisiyor) return;
    if (sonZamanDamgasi === null) sonZamanDamgasi = zamanDamgasi;
    var dt = Math.min((zamanDamgasi - sonZamanDamgasi) / 1000, 0.05);
    sonZamanDamgasi = zamanDamgasi;

    if (!azaltilmisHareket) {
      fizigiIlerlet(dt);
    } else {
      // Azaltılmış hareket: yalnızca çok hafif, sakin bir titreşim — birikim sabit kalır
      ruzgarGuncelle(dt * 0.2);
    }
    ciz(dt);
    rafId = requestAnimationFrame(kare);
  }

  function dongubaslat() {
    if (rafId) return;
    sonZamanDamgasi = null;
    rafId = requestAnimationFrame(kare);
  }

  function durdurDongu() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  // ================= DIŞA AÇILAN API =================
  window.karEfekti = {
    baslat: function () {
      if (canvas) canvas.style.display = '';
      if (calisiyor) return;
      calisiyor = true;
      dongubaslat();
    },
    durdur: function () {
      calisiyor = false;
      durdurDongu();
      if (canvas) canvas.style.display = 'none';
    },
    temizle: function () {
      yukHaritasi = new Array(sutunSayisi).fill(0);
      parlamaNoktalari = [];
      birikimKirli = true;
    },
    aktifMi: function () { return calisiyor; }
  };

  // ================= BAŞLAT =================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', olustur);
  } else {
    olustur();
  }
})();
