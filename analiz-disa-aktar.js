/* ======================================================================
   ANALİZ DIŞA AKTARMA — "Analizlerim" ekranındaki deneme analizini
   PNG (görsel) veya PDF olarak indirme.
   ----------------------------------------------------------------------
   Mevcut uygulama koduna dokunmayan, tamamen bağımsız bir modüldür
   (kar-efekti.js / supabase-yedekleme.js ile aynı desen). "Analizlerim"
   ekranındaki #analizGovde içeriğini klonlayıp temiz bir rapor kartı
   haline getirir, html2canvas ile görsele çevirir; PDF için aynı görseli
   jsPDF ile tek sayfaya gömer. Her iki kütüphane de yalnızca kullanıcı
   gerçekten indirme butonuna bastığında CDN'den yüklenir (sayfa açılış
   hızını etkilemez).

   Kullanım: <script src="analiz-disa-aktar.js" defer></script>
   ====================================================================== */
(function () {
  'use strict';

  if (window.analizDisaAktar) return;

  var HTML2CANVAS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  var JSPDF_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

  var stilEklendi = false;
  var menuAcikMi = false;
  var yukleniyor = false;

  // ================= YARDIMCI: script yükleme (bir kez) =================
  function scriptYukle(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-analiz-disa-aktar-lib="' + src + '"]')) {
        // Zaten yüklenmeye başlamış/yüklenmiş; yine de görünürse tekrar bekleme
        var mevcut = document.querySelector('script[data-analiz-disa-aktar-lib="' + src + '"]');
        if (mevcut.dataset.yuklendi === '1') { resolve(); return; }
        mevcut.addEventListener('load', function () { resolve(); });
        mevcut.addEventListener('error', reject);
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.setAttribute('data-analiz-disa-aktar-lib', src);
      s.onload = function () { s.dataset.yuklendi = '1'; resolve(); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function kutuphaneleriHazirla() {
    var istekler = [];
    if (typeof window.html2canvas === 'undefined') istekler.push(scriptYukle(HTML2CANVAS_SRC));
    if (typeof window.jspdf === 'undefined') istekler.push(scriptYukle(JSPDF_SRC));
    return Promise.all(istekler);
  }

  // ================= STİL =================
  function stilEkle() {
    if (stilEklendi) return;
    stilEklendi = true;
    var css = ''
      + '.analiz-indir-btn{position:absolute;right:0;top:0.15rem;width:2.1rem;height:2.1rem;z-index:2;'
      + 'display:flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:50%;'
      + 'background:transparent;color:var(--ink-soft);cursor:pointer;'
      + 'transition:color 0.2s ease,border-color 0.2s ease,background 0.2s ease;}'
      + '.analiz-indir-btn:hover{color:var(--ink);border-color:var(--ink-soft);background:rgba(var(--accent-rgb),0.1);}'
      + '.analiz-indir-btn:active{transform:scale(0.94);}'
      + '.analiz-indir-btn svg{width:1.05rem;height:1.05rem;}'
      + '.analiz-indir-btn.yukleniyor svg{animation:analizIndirDon 0.8s linear infinite;}'
      + '@keyframes analizIndirDon{to{transform:rotate(360deg);}}'
      + '.analiz-indir-menu{position:absolute;right:0;top:2.55rem;min-width:190px;z-index:50;'
      + 'background:var(--bg);border:1px solid var(--line);border-radius:14px;'
      + 'box-shadow:0 12px 28px -8px rgba(var(--shadow-rgb),0.22);overflow:hidden;'
      + 'opacity:0;transform:translateY(-6px) scale(0.98);pointer-events:none;'
      + 'transition:opacity 0.16s ease,transform 0.16s ease;}'
      + '.analiz-indir-menu.acik{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;}'
      + '.analiz-indir-menu button{width:100%;text-align:left;padding:0.7rem 0.9rem;border:none;background:transparent;'
      + 'color:var(--ink);font-family:inherit;font-size:0.85rem;cursor:pointer;display:flex;align-items:center;gap:0.55rem;}'
      + '.analiz-indir-menu button:hover{background:rgba(var(--accent-rgb),0.1);}'
      + '.analiz-indir-menu button + button{border-top:1px solid var(--line);}'
      + '.analiz-indir-menu svg{width:0.95rem;height:0.95rem;flex-shrink:0;color:var(--ink-soft);}'
      + '.analiz-rapor-disa{position:fixed;left:-9999px;top:0;width:420px;padding:1.6rem 1.5rem;'
      + 'font-family:"Iowan Old Style","Palatino Linotype","Georgia","Times New Roman",serif;'
      + 'background:var(--bg);color:var(--ink);box-sizing:border-box;}'
      + '.analiz-rapor-baslik{font-size:0.68rem;letter-spacing:0.3em;text-transform:uppercase;color:var(--ink-soft);}'
      + '.analiz-rapor-alt{margin-top:0.35rem;font-size:1.5rem;font-weight:400;}'
      + '.analiz-rapor-tarih{margin-top:0.3rem;font-size:0.78rem;color:var(--ink-soft);}'
      + '.analiz-rapor-govde{margin-top:1.3rem;}'
      + '.analiz-rapor-imza{margin-top:1.6rem;text-align:center;font-size:0.68rem;letter-spacing:0.2em;'
      + 'text-transform:uppercase;color:var(--ink-soft);opacity:0.7;}';
    var stil = document.createElement('style');
    stil.id = 'analiz-disa-aktar-stil';
    stil.textContent = css;
    document.head.appendChild(stil);
  }

  // ================= BUTON + MENÜ OLUŞTUR =================
  function ikonIndir() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path></svg>';
  }
  function ikonGorsel() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path></svg>';
  }
  function ikonPdf() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path></svg>';
  }

  function menuKapat(btn, menu) {
    menuAcikMi = false;
    menu.classList.remove('acik');
    btn.setAttribute('aria-expanded', 'false');
  }

  function kurulumYap() {
    var heading = document.querySelector('#viewAnaliz .sayac-listem-heading');
    if (!heading || document.getElementById('analizIndirBtn')) return;

    stilEkle();

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'analizIndirBtn';
    btn.className = 'analiz-indir-btn';
    btn.setAttribute('aria-label', 'Analizi indir');
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = ikonIndir();

    var menu = document.createElement('div');
    menu.className = 'analiz-indir-menu';
    menu.innerHTML =
      '<button type="button" data-format="png">' + ikonGorsel() + 'Görsel olarak indir (PNG)</button>' +
      '<button type="button" data-format="pdf">' + ikonPdf() + 'PDF olarak indir</button>';

    heading.style.position = 'relative';
    heading.appendChild(btn);
    heading.appendChild(menu);

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (yukleniyor) return;
      menuAcikMi = !menuAcikMi;
      menu.classList.toggle('acik', menuAcikMi);
      btn.setAttribute('aria-expanded', String(menuAcikMi));
    });

    document.addEventListener('click', function (e) {
      if (menuAcikMi && !menu.contains(e.target) && e.target !== btn) menuKapat(btn, menu);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menuAcikMi) menuKapat(btn, menu);
    });

    menu.querySelectorAll('button[data-format]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var format = b.dataset.format;
        menuKapat(btn, menu);
        disaAktar(format, btn);
      });
    });
  }

  // ================= RAPOR KARTI OLUŞTUR (klonla + sadeleştir) =================
  function raporKartiOlustur() {
    var govde = document.getElementById('analizGovde');
    if (!govde) return null;

    var seciliSekme = govde.querySelector('.analiz-sekme-btn.secili');
    var sekmeAdi = seciliSekme ? seciliSekme.textContent.trim() : '';

    var klon = govde.cloneNode(true);
    var sekmeEl = klon.querySelector('.analiz-sekme');
    if (sekmeEl) sekmeEl.remove();

    var sarici = document.createElement('div');
    sarici.className = 'analiz-rapor-disa';

    var ust = document.createElement('div');
    ust.innerHTML =
      '<div class="analiz-rapor-baslik">Sessizliğin Sesi — Deneme Analizi</div>' +
      '<div class="analiz-rapor-alt">' + (sekmeAdi || 'Analizlerim') + '</div>' +
      '<div class="analiz-rapor-tarih">' + yeniTarihMetni() + '</div>';
    sarici.appendChild(ust);

    var govdeSarici = document.createElement('div');
    govdeSarici.className = 'analiz-rapor-govde';
    govdeSarici.appendChild(klon);
    sarici.appendChild(govdeSarici);

    var imza = document.createElement('div');
    imza.className = 'analiz-rapor-imza';
    imza.textContent = 'Sessizliğin Sesi ile oluşturuldu';
    sarici.appendChild(imza);

    return sarici;
  }

  function yeniTarihMetni() {
    var ayIsimleri = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
    var d = new Date();
    return d.getDate() + ' ' + ayIsimleri[d.getMonth()] + ' ' + d.getFullYear();
  }

  function bosMu() {
    var icerik = document.getElementById('analizIcerik');
    return !!(icerik && icerik.querySelector('.analiz-bos'));
  }

  function dosyaAdiOlustur(uzanti) {
    var seciliSekme = document.querySelector('#analizSekme .analiz-sekme-btn.secili');
    var sekme = seciliSekme ? seciliSekme.dataset.alan || 'analiz' : 'analiz';
    var d = new Date();
    var tarih = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return 'sessizlik-deneme-analizi-' + sekme + '-' + tarih + '.' + uzanti;
  }

  function indir(blobVeyaUrl, dosyaAdi) {
    var a = document.createElement('a');
    a.href = blobVeyaUrl;
    a.download = dosyaAdi;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ================= DIŞA AKTAR =================
  function disaAktar(format, btn) {
    if (bosMu()) {
      alert('Henüz bir deneme eklemedin. Grafik oluşunca burada indirebileceksin.');
      return;
    }

    var kart = raporKartiOlustur();
    if (!kart) return;

    yukleniyor = true;
    btn.classList.add('yukleniyor');
    document.body.appendChild(kart);

    kutuphaneleriHazirla()
      .then(function () {
        var bgRengi = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#FDFBF7';
        return window.html2canvas(kart, {
          backgroundColor: bgRengi,
          scale: Math.min(window.devicePixelRatio || 1, 2.5) + 0.5,
          useCORS: true,
          logging: false
        });
      })
      .then(function (canvas) {
        if (format === 'png') {
          canvas.toBlob(function (blob) {
            var url = URL.createObjectURL(blob);
            indir(url, dosyaAdiOlustur('png'));
            setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
          }, 'image/png');
        } else {
          var jsPDF = window.jspdf.jsPDF;
          var genislikPx = canvas.width / (canvas.style.width ? 1 : 1);
          var pdf = new jsPDF({
            orientation: canvas.width >= canvas.height ? 'landscape' : 'portrait',
            unit: 'px',
            format: [canvas.width, canvas.height]
          });
          pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, canvas.width, canvas.height);
          pdf.save(dosyaAdiOlustur('pdf'));
        }
      })
      .catch(function (err) {
        console.error('Analiz dışa aktarma hatası:', err);
        alert('İndirme sırasında bir sorun oluştu. İnternet bağlantını kontrol edip tekrar dener misin?');
      })
      .finally(function () {
        kart.remove();
        yukleniyor = false;
        btn.classList.remove('yukleniyor');
      });
  }

  // ================= BAŞLAT =================
  // "Analizlerim" ekranı DOM'da her zaman mevcut (gizli/görünür), bu yüzden
  // sayfa yüklendiğinde bir kez kurulum yapmak yeterli.
  function baslat() {
    kurulumYap();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', baslat);
  } else {
    baslat();
  }

  window.analizDisaAktar = { disaAktar: disaAktar };
})();
