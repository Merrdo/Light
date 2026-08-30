/* ======================================================================
   YILDIZ EFEKTİ — Sakin "Yıldız Gecesi" Teması
   ----------------------------------------------------------------------
   Atmosferik parıldama (scintillation) benzeri düzensiz bir titreşimle
   yanıp sönen sabit yıldızlar ve gerçekçi ivme/sürtünme fiziğiyle kayan,
   iz bırakan göktaşları çizer. "Arka Plan Animasyonu" ayarındaki
   seçeneklerden biridir.

   Kullanım:
     <script src="yildiz-efekti.js" defer></script>
   Sayfa yüklendiğinde oluşturulur; yalnızca data-bganim="yildiz" iken
   görünür/çalışır durumdadır (bkz. index.html içindeki bganim kontrolü).

   Dışa açılan basit API:
     window.yildizEfekti.baslat()
     window.yildizEfekti.durdur()
     window.yildizEfekti.aktifMi()
   ====================================================================== */
(function () {
  'use strict';
  if (window.yildizEfekti) return;

  // ================= AYARLAR =================
  var YILDIZ_ALAN_BOLEN = 9000;
  var YILDIZ_MIN = 40, YILDIZ_MAX = 130;
  var GOKTASI_MAX_ESZAMANLI = 2;
  var GOKTASI_BEKLEME_MIN = 4.5, GOKTASI_BEKLEME_MAX = 12;
  var GOKTASI_SURTUNME = 0.16;   // hızın saniyede azalma oranı (atmosfer sürtünmesi benzetimi)
  var IZ_UZUNLUGU = 16;          // göktaşı izinde tutulan geçmiş nokta sayısı

  // ================= DURUM =================
  var canvas, ctx;
  var genislik = 0, yukseklik = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  var yildizlar = [];
  var goktaslari = [];
  var accentRgb = '78,122,166';
  var inkRgb = '26,26,26';
  var azaltilmisHareket = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var calisiyor = false;
  var rafId = null;
  var sonZamanDamgasi = null;
  var globalZaman = 0;
  var sonrakiGoktasiZamani = 0;
  var gokKaymaX = 0; // tüm gök katmanının çok yavaş, fark edilmeyen kayması (Dünya'nın dönüşü hissi)

  function rastgele(a, b) { return a + Math.random() * (b - a); }
  function sinirla(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function temaOku() {
    try {
      var stil = getComputedStyle(document.documentElement);
      var a = stil.getPropertyValue('--accent-rgb').trim();
      var i = stil.getPropertyValue('--ink-rgb').trim();
      if (a) accentRgb = a;
      if (i) inkRgb = i;
    } catch (e) {}
  }

  // ================= KURULUM =================
  function olustur() {
    canvas = document.createElement('canvas');
    canvas.id = 'yildiz-efekti-canvas';
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
    yildizlariHazirla();
    sonrakiGoktasiZamaniAyarla();

    window.addEventListener('resize', boyutuGuncelle, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { durdurDongu(); } else if (calisiyor) { dongubaslat(); }
    });
    if (window.MutationObserver) {
      new MutationObserver(temaOku).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    var baslangictaAktif = document.documentElement.getAttribute('data-bganim') === 'yildiz';
    canvas.style.display = baslangictaAktif ? '' : 'none';
    calisiyor = baslangictaAktif;
    if (baslangictaAktif) dongubaslat();
  }

  var boyutZamanlayici = null;
  function boyutuGuncelle() {
    clearTimeout(boyutZamanlayici);
    boyutZamanlayici = setTimeout(function () { boyutlandir(); yildizlariHazirla(); }, 150);
  }

  function boyutlandir() {
    genislik = window.innerWidth;
    yukseklik = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(genislik * dpr);
    canvas.height = Math.floor(yukseklik * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ================= YILDIZLAR (atmosferik parıldama benzetimi) =================
  function hedefYildizSayisi() {
    var taban = (genislik * yukseklik) / YILDIZ_ALAN_BOLEN;
    taban = sinirla(taban, YILDIZ_MIN, YILDIZ_MAX);
    return Math.round(azaltilmisHareket ? taban / 2 : taban);
  }

  function yeniYildiz() {
    var buyuk = Math.random() < 0.16;
    return {
      x: rastgele(0, genislik),
      y: rastgele(0, yukseklik * 0.72),
      yaricap: buyuk ? rastgele(1.4, 1.8) : rastgele(0.6, 1.1),
      renkIkinci: Math.random() < 0.35, // bazı yıldızlar --ink-rgb tonunda (orijinaldeki gibi karışık)
      parlaklik: rastgele(0.2, 0.5),
      parlaklikHedef: rastgele(0.15, 0.95),
      parlaklikYenilemeZamani: rastgele(0.4, 1.5),
      parlaklikSayaci: 0
    };
  }

  function yildizlariHazirla() {
    var hedef = hedefYildizSayisi();
    if (yildizlar.length === 0) {
      for (var i = 0; i < hedef; i++) yildizlar.push(yeniYildiz());
    } else {
      while (yildizlar.length < hedef) yildizlar.push(yeniYildiz());
      if (yildizlar.length > hedef) yildizlar.length = hedef;
    }
  }

  function yildizFizigiGuncelle(y, dt) {
    // Gerçek yıldız titreşimi düzenli bir sinüs değil; atmosferik türbülansı
    // kaba biçimde benzetmek için düzensiz aralıklarla yeni bir hedef parlaklık
    // seçilip ona yumuşakça yaklaşılıyor (rastgele yürüyüş / smoothed noise).
    y.parlaklikSayaci += dt;
    if (y.parlaklikSayaci >= y.parlaklikYenilemeZamani) {
      y.parlaklikSayaci = 0;
      y.parlaklikYenilemeZamani = rastgele(0.4, 1.6);
      y.parlaklikHedef = rastgele(0.12, 0.95);
    }
    y.parlaklik += (y.parlaklikHedef - y.parlaklik) * (1 - Math.exp(-5 * dt));
  }

  function yildizlariCiz() {
    for (var i = 0; i < yildizlar.length; i++) {
      var y = yildizlar[i];
      var renk = y.renkIkinci ? inkRgb : accentRgb;
      var op = y.parlaklik;
      var r = y.yaricap * (0.8 + op * 0.5);
      var x = y.x + gokKaymaX;
      // Ekranın solundan taşan yıldızı sağdan geri sar (kesintisiz gök hissi)
      if (x < -5) x += genislik + 10;
      if (x > genislik + 5) x -= genislik + 10;

      ctx.fillStyle = 'rgba(' + renk + ',' + op + ')';
      ctx.beginPath();
      ctx.arc(x, y.y, r, 0, Math.PI * 2);
      ctx.fill();

      if (op > 0.55) {
        var g = ctx.createRadialGradient(x, y.y, 0, x, y.y, r * 4.5);
        g.addColorStop(0, 'rgba(' + renk + ',' + (op * 0.35) + ')');
        g.addColorStop(1, 'rgba(' + renk + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y.y, r * 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ================= GÖKTAŞLARI (gerçek ivme/sürtünme fiziği) =================
  function sonrakiGoktasiZamaniAyarla() {
    sonrakiGoktasiZamani = globalZaman + rastgele(GOKTASI_BEKLEME_MIN, GOKTASI_BEKLEME_MAX);
  }

  function goktasiOlustur() {
    var saganTaraf = Math.random() < 0.5;
    var baslangicX = saganTaraf ? rastgele(genislik * 0.45, genislik * 1.05) : genislik * rastgele(0.9, 1.08);
    var baslangicY = saganTaraf ? -genislik * 0.04 : rastgele(-genislik * 0.02, yukseklik * 0.3);
    var aci = rastgele(148, 168) * Math.PI / 180; // sağ üstten sol alta doğru, sığ açı
    var hiz = rastgele(340, 520); // px/s — atmosfere giriş hızı
    goktaslari.push({
      x: baslangicX,
      y: baslangicY,
      vx: Math.cos(aci) * hiz,
      vy: Math.sin(aci) * hiz,
      uzunluk: rastgele(90, 170),
      iz: [],
      omur: rastgele(0.9, 1.7),
      yas: 0
    });
  }

  function goktaslariGuncelle(dt) {
    if (goktaslari.length < GOKTASI_MAX_ESZAMANLI && globalZaman >= sonrakiGoktasiZamani) {
      goktasiOlustur();
      sonrakiGoktasiZamaniAyarla();
    }

    for (var i = goktaslari.length - 1; i >= 0; i--) {
      var g = goktaslari[i];
      // Atmosfer sürtünmesi: hız üstel olarak azalır (gerçek meteor fiziğine yakın)
      var surtunmeCarpani = Math.exp(-GOKTASI_SURTUNME * dt);
      g.vx *= surtunmeCarpani;
      g.vy *= surtunmeCarpani;
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      g.yas += dt;

      g.iz.push({ x: g.x, y: g.y });
      if (g.iz.length > IZ_UZUNLUGU) g.iz.shift();

      var ekranDisinda = g.x < -200 || g.y > yukseklik + 200;
      if (ekranDisinda || g.yas > g.omur) goktaslari.splice(i, 1);
    }
  }

  function goktaslariniCiz() {
    for (var i = 0; i < goktaslari.length; i++) {
      var g = goktaslari[i];
      var yasOrani = sinirla(g.yas / g.omur, 0, 1);
      var globalOp = yasOrani < 0.12 ? yasOrani / 0.12 : sinirla(1 - (yasOrani - 0.12) / 0.88, 0, 1);
      if (globalOp <= 0.01 || g.iz.length < 2) continue;

      ctx.save();
      ctx.lineCap = 'round';
      for (var j = 1; j < g.iz.length; j++) {
        var a = g.iz[j - 1], b = g.iz[j];
        var izOrani = j / g.iz.length; // 0 (kuyruk) -> 1 (baş)
        var op = globalOp * izOrani * 0.85;
        ctx.strokeStyle = 'rgba(' + accentRgb + ',' + op + ')';
        ctx.lineWidth = 0.6 + izOrani * 1.6;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      var bas = g.iz[g.iz.length - 1];
      var parlamaG = ctx.createRadialGradient(bas.x, bas.y, 0, bas.x, bas.y, 6);
      parlamaG.addColorStop(0, 'rgba(' + accentRgb + ',' + (globalOp * 0.95) + ')');
      parlamaG.addColorStop(1, 'rgba(' + accentRgb + ',0)');
      ctx.fillStyle = parlamaG;
      ctx.beginPath();
      ctx.arc(bas.x, bas.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ================= DÖNGÜ =================
  function ciz() {
    ctx.clearRect(0, 0, genislik, yukseklik);
    yildizlariCiz();
    goktaslariniCiz();
  }

  function ilerlet(dt) {
    globalZaman += dt;
    gokKaymaX -= dt * 0.6; // saatte birkaç piksel — fark edilmeyecek kadar yavaş gök kayması
    for (var i = 0; i < yildizlar.length; i++) yildizFizigiGuncelle(yildizlar[i], dt);
    goktaslariGuncelle(dt);
  }

  function kare(zamanDamgasi) {
    if (!calisiyor) return;
    if (sonZamanDamgasi === null) sonZamanDamgasi = zamanDamgasi;
    var dt = Math.min((zamanDamgasi - sonZamanDamgasi) / 1000, 0.05);
    sonZamanDamgasi = zamanDamgasi;

    if (!azaltilmisHareket) {
      ilerlet(dt);
    } else {
      globalZaman += dt;
      for (var i = 0; i < yildizlar.length; i++) yildizFizigiGuncelle(yildizlar[i], dt * 0.3);
    }
    ciz();
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
  window.yildizEfekti = {
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
    aktifMi: function () { return calisiyor; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', olustur);
  } else {
    olustur();
  }
})();
