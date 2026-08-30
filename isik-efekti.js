/* ======================================================================
   IŞIK EFEKTİ — Sakin "Işık Huzmesi" Teması
   ----------------------------------------------------------------------
   Yukarıdan süzülen yumuşak ışık huzmeleri ve içlerinde gerçekçi fizikle
   asılı duran toz zerreleri (Brown hareketi + hafif çökme + değişken hava
   akımı) çizer. "Arka Plan Animasyonu" ayarındaki seçeneklerden biridir.

   Kullanım:
     <script src="isik-efekti.js" defer></script>
   Sayfa yüklendiğinde oluşturulur; yalnızca data-bganim="isik" iken
   görünür/çalışır durumdadır (bkz. index.html içindeki bganim kontrolü).
   data-isik="off" iken yalnızca huzmeler gizlenir, toz zerreleri kalır
   (mevcut "Işık Efektleri" anahtarının önceki davranışıyla aynı).

   Dışa açılan basit API:
     window.isikEfekti.baslat()
     window.isikEfekti.durdur()
     window.isikEfekti.aktifMi()
   ====================================================================== */
(function () {
  'use strict';
  if (window.isikEfekti) return;

  // ================= AYARLAR =================
  var TOZ_ALAN_BOLEN = 11000;   // toz sayısını ekran alanına göre ölçekler
  var TOZ_MIN = 22, TOZ_MAX = 85;
  var COKME_HIZI = 3.2;         // px/s — çok yavaş, gerçekçi Stokes çökelmesi
  var HAVA_YAVASLIK = 2.4;      // parçacığın hedef rüzgara yaklaşma oranı (sürükleme)

  var HUZMELER = [
    { solYuzde: -6,  genislikPx: 230, aci: 16 },
    { solYuzde: 32,  genislikPx: 160, aci: 11 },
    { solYuzde: 68,  genislikPx: 200, aci: 19 }
  ];

  // ================= DURUM =================
  var canvas, ctx;
  var genislik = 0, yukseklik = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  var tozlar = [];
  var huzmeBitmapleri = [];   // önceden çizilmiş, yumuşak-kenarlı huzme bitmapleri (performans için)
  var accentRgb = '78,122,166';
  var azaltilmisHareket = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var calisiyor = false;
  var rafId = null;
  var sonZamanDamgasi = null;
  var globalZaman = 0;
  var huzmelerKirli = true;

  function rastgele(a, b) { return a + Math.random() * (b - a); }
  function sinirla(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function temaOku() {
    try {
      var stil = getComputedStyle(document.documentElement);
      var deger = stil.getPropertyValue('--accent-rgb').trim();
      if (deger) accentRgb = deger;
    } catch (e) {}
    huzmelerKirli = true;
  }

  function isikAcikMi() {
    return document.documentElement.getAttribute('data-isik') !== 'off';
  }

  // ================= KURULUM =================
  function olustur() {
    canvas = document.createElement('canvas');
    canvas.id = 'isik-efekti-canvas';
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
    tozlarHazirla();

    window.addEventListener('resize', boyutuGuncelle, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { durdurDongu(); } else if (calisiyor) { dongubaslat(); }
    });
    if (window.MutationObserver) {
      new MutationObserver(temaOku).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      new MutationObserver(function () { huzmelerKirli = true; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-isik'] });
    }

    var baslangictaAktif = document.documentElement.getAttribute('data-bganim') === 'isik' || !document.documentElement.hasAttribute('data-bganim');
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
    genislik = window.innerWidth;
    yukseklik = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(genislik * dpr);
    canvas.height = Math.floor(yukseklik * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    huzmelerKirli = true;
  }

  // ================= HUZME BİTMAPLERİ (önceden çizilir, her karede yeniden hesaplanmaz) =================
  function huzmeleriHazirla() {
    huzmeBitmapleri = HUZMELER.map(function (h) {
      var boyPay = yukseklik * 1.7;
      var genPay = h.genislikPx * 2.4;
      var off = document.createElement('canvas');
      off.width = Math.max(4, Math.round(genPay));
      off.height = Math.max(4, Math.round(boyPay));
      var octx = off.getContext('2d');

      var g1 = octx.createLinearGradient(0, 0, 0, off.height);
      g1.addColorStop(0.00, 'rgba(' + accentRgb + ',0)');
      g1.addColorStop(0.34, 'rgba(' + accentRgb + ',0.16)');
      g1.addColorStop(0.62, 'rgba(' + accentRgb + ',0.06)');
      g1.addColorStop(1.00, 'rgba(' + accentRgb + ',0)');
      octx.fillStyle = g1;
      octx.fillRect(0, 0, off.width, off.height);

      // parlak ince çekirdek (orijinal ::before ile aynı mantık)
      var coreX = off.width * 0.3;
      var coreW = off.width * 0.4;
      var g2 = octx.createLinearGradient(0, 0, 0, off.height);
      g2.addColorStop(0.00, 'rgba(' + accentRgb + ',0)');
      g2.addColorStop(0.40, 'rgba(' + accentRgb + ',0.36)');
      g2.addColorStop(0.68, 'rgba(' + accentRgb + ',0.11)');
      g2.addColorStop(1.00, 'rgba(' + accentRgb + ',0)');
      octx.fillStyle = g2;
      octx.fillRect(coreX, 0, coreW, off.height);

      return { canvas: off, taban: h, boyPay: boyPay, genPay: genPay };
    });
    huzmelerKirli = false;
  }

  // ================= TOZ ZERRELERİ (Brown hareketi + yavaş çökme) =================
  function hedefTozSayisi() {
    var taban = (genislik * yukseklik) / TOZ_ALAN_BOLEN;
    taban = sinirla(taban, TOZ_MIN, TOZ_MAX);
    return Math.round(azaltilmisHareket ? taban / 3 : taban);
  }

  function yeniToz(ilkYukleme) {
    return {
      x: rastgele(0, genislik),
      y: ilkYukleme ? rastgele(0, yukseklik) : rastgele(yukseklik * 0.4, yukseklik),
      yaricap: rastgele(1, 4),
      vx: rastgele(-4, 4),
      vy: rastgele(-2, 2),
      hedefVx: rastgele(-6, 6),
      hedefVy: rastgele(-3, 3),
      hedefYenilemeZamani: rastgele(1.5, 4),
      hedefSayaci: 0,
      dogumZamani: 0,
      omur: rastgele(9, 19),
      yasZamani: ilkYukleme ? rastgele(0, 6) : 0,
      parlaklikFaz: rastgele(0, Math.PI * 2)
    };
  }

  function tozlarHazirla() {
    tozlar = [];
    var hedef = hedefTozSayisi();
    for (var i = 0; i < hedef; i++) tozlar.push(yeniToz(true));
  }

  // Belirli bir y konumunda huzmenin merkez x'ini ve genişliğini döndürür
  // (huzme açılı olduğu için y'ye göre kayar) — toz zerresi bu huzmenin
  // içindeyse daha parlak/"ışık yakalıyormuş" gibi görünür.
  function huzmeIsikYogunlugu(x, y) {
    if (!isikAcikMi()) return 0;
    var maxYogunluk = 0;
    for (var i = 0; i < HUZMELER.length; i++) {
      var h = HUZMELER[i];
      var tabanX = (h.solYuzde / 100) * genislik + h.genislikPx / 2;
      var aciRad = h.aci * Math.PI / 180;
      var merkezX = tabanX + Math.tan(aciRad) * (y + yukseklik * 0.35);
      var etkiliGenislik = h.genislikPx * 1.6;
      var uzaklik = Math.abs(x - merkezX);
      var yogunluk = sinirla(1 - uzaklik / etkiliGenislik, 0, 1);
      if (yogunluk > maxYogunluk) maxYogunluk = yogunluk;
    }
    return maxYogunluk;
  }

  function tozFizigiGuncelle(t, dt) {
    t.hedefSayaci += dt;
    if (t.hedefSayaci >= t.hedefYenilemeZamani) {
      t.hedefSayaci = 0;
      t.hedefYenilemeZamani = rastgele(1.5, 4);
      t.hedefVx = rastgele(-6, 6);
      t.hedefVy = rastgele(-3, 3) + COKME_HIZI; // yavaş çökme eğilimi rüzgar hedefine eklenir
    }
    // Sürükleme (drag) ile hedef hıza üstel yaklaşım — gerçekçi, ani sıçramasız hareket
    t.vx += (t.hedefVx - t.vx) * (1 - Math.exp(-HAVA_YAVASLIK * dt));
    t.vy += (t.hedefVy - t.vy) * (1 - Math.exp(-HAVA_YAVASLIK * dt));

    // Küçük, sürekli Brown sarsıntısı (havadaki moleküllerin rastgele çarpışması)
    t.vx += rastgele(-14, 14) * dt;
    t.vy += rastgele(-8, 8) * dt;

    t.x += t.vx * dt;
    t.y += t.vy * dt;
    t.parlaklikFaz += dt * 1.6;

    t.yasZamani += dt;
    if (t.x < -20 || t.x > genislik + 20 || t.y > yukseklik + 20 || t.yasZamani > t.omur) {
      Object.assign(t, yeniToz(false));
      t.y = rastgele(-20, yukseklik * 0.5);
    }
  }

  function tozOpakligi(t) {
    // Ömrünün başında/sonunda yumuşak açılıp kapanır (orijinal dustFloat ile aynı his)
    var yasOrani = t.yasZamani / t.omur;
    var yasakFade = Math.min(yasOrani / 0.08, 1, (1 - yasOrani) / 0.15);
    yasakFade = sinirla(yasakFade, 0, 1);
    var yogunluk = huzmeIsikYogunlugu(t.x, t.y);
    var parlama = (Math.sin(t.parlaklikFaz) * 0.5 + 0.5);
    var taban = 0.05 + yogunluk * 0.55; // huzme dışında çok soluk, içinde belirgin
    return sinirla(taban * (0.6 + parlama * 0.4) * yasakFade, 0, 0.85);
  }

  // ================= ÇİZİM =================
  function huzmeleriCiz(zaman) {
    if (!isikAcikMi()) return;
    if (huzmelerKirli || huzmeBitmapleri.length === 0) huzmeleriHazirla();

    for (var i = 0; i < huzmeBitmapleri.length; i++) {
      var b = huzmeBitmapleri[i];
      var h = b.taban;
      // Orijinal keyframe'lerin yerini alan, birden fazla yavaş sinüsün
      // toplamından oluşan organik "nefes alma" — sabit döngü hissi vermez.
      var faz = zaman * 0.09 + i * 2.1;
      var opaklik = 0.24 + Math.sin(faz) * 0.16 + Math.sin(faz * 0.37 + 1.3) * 0.08;
      opaklik = sinirla(opaklik, 0, 0.5);
      var aciKaymasi = Math.sin(faz * 0.6) * 1.1;
      var tabanX = (h.solYuzde / 100) * genislik + h.genislikPx / 2;

      ctx.save();
      ctx.globalAlpha = opaklik;
      ctx.translate(tabanX, -yukseklik * 0.35);
      ctx.rotate((h.aci + aciKaymasi) * Math.PI / 180);
      ctx.drawImage(b.canvas, -b.genPay / 2, 0, b.genPay, b.boyPay);
      ctx.restore();
    }
  }

  function tozlariCiz() {
    for (var i = 0; i < tozlar.length; i++) {
      var t = tozlar[i];
      var op = tozOpakligi(t);
      if (op <= 0.01) continue;
      var g = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, t.yaricap * 2.4);
      g.addColorStop(0, 'rgba(' + accentRgb + ',' + op + ')');
      g.addColorStop(1, 'rgba(' + accentRgb + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.yaricap * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function ciz(zaman) {
    ctx.clearRect(0, 0, genislik, yukseklik);
    huzmeleriCiz(zaman);
    tozlariCiz();
  }

  // ================= FİZİK DÖNGÜSÜ =================
  function ilerlet(dt) {
    globalZaman += dt;
    var hedefSayi = hedefTozSayisi();
    for (var i = 0; i < tozlar.length; i++) tozFizigiGuncelle(tozlar[i], dt);
    while (tozlar.length < hedefSayi) tozlar.push(yeniToz(false));
    if (tozlar.length > hedefSayi) tozlar.length = hedefSayi;
  }

  function kare(zamanDamgasi) {
    if (!calisiyor) return;
    if (sonZamanDamgasi === null) sonZamanDamgasi = zamanDamgasi;
    var dt = Math.min((zamanDamgasi - sonZamanDamgasi) / 1000, 0.05);
    sonZamanDamgasi = zamanDamgasi;

    if (!azaltilmisHareket) ilerlet(dt); else globalZaman += dt * 0.15;
    ciz(globalZaman);
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
  window.isikEfekti = {
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
