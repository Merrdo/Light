/* =============================================================================
   UYGULAMA TEMALARI — "Sessizliğin Sesi"
   =============================================================================
   Bu dosya, mevcut "Arka Plan Animasyonu" (Işık Huzmesi / Yıldız Gecesi / Kar
   Yağışı) seçeneklerinden FARKLI bir katmandır: onlar sadece dekoratif bir
   canvas efektiydi, arayüzün geri kalanı hep aynı kalıyordu. Buradaki
   "Uygulama Teması" ise butonların şeklini, yazı fontunu, arka plan rengini
   ve dokusunu aynı anda değiştirerek uygulamaya baştan sona farklı bir his
   kazandırır — sanki başka bir uygulama gibi.

   Mimari:
   - Her tema, TEMALAR nesnesine bir anahtar olarak eklenir (bkz. aşağıda
     "retro"). Yeni bir tema eklemek için sadece yeni bir CSS bloğu yazıp
     TEMALAR nesnesine eklemek yeterli; ayarlar arayüzündeki buton grubu ve
     kayıt/okuma mantığı otomatik olarak genişler.
   - Aktif tema, <html> üzerinde data-app-tema="<anahtar>" olarak tutulur ve
     "sessizlik-app-tema" anahtarıyla localStorage'a yazılır. "Varsayılan"
     seçilirse öznitelik tamamen kaldırılır (mevcut açık/koyu mod ve renk
     sistemine dokunulmaz, onlarla birlikte çalışır).
   - Görsel geçişler CSS değişkenlerinin (--bg, --ink, --accent, vb.) üzerine
     kurulu; uygulama zaten neredeyse her yerde bu değişkenleri kullandığı
     için renk teması bunları değiştirmek kadar basit. Buton "tipini" (kenar,
     gölge, köşe, büyük harf vb.) değiştirmek için ise geniş kapsamlı ama
     hedefli seçiciler (ör. [class*="btn"]) kullanılır; html[data-app-tema=...]
     ön eki, özgün kurallardaki çoğu çakışmayı zaten belirginlik (specificity)
     olarak geçtiği için ekstra risk taşımadan tüm buton ailelerini kapsar.
   ============================================================================= */
(function () {
  'use strict';

  var STORAGE_KEY = 'sessizlik-app-tema';
  var ATTR = 'data-app-tema';
  var STYLE_ID = 'app-tema-stilleri';
  var DOKU_ID = 'appTemaDokuKatmani';

  /* ---------------------------------------------------------------------
     TEMA TANIMLARI
     --------------------------------------------------------------------- */
  var TEMALAR = {
    retro: {
      isim: 'Retro',
      aciklama: 'Kırık beyaz kağıt, daktilo fontu, mürekkep damgası butonlar',
      // Ayarlardaki seçim düğmesinde gösterilecek küçük renk anahtarı (önizleme)
      onizleme: { bg: '#F1E7CE', ink: '#201D16' },
      css: ''
        /* ============ RETRO — renk paleti (açık taban) ============ */
        + 'html[data-app-tema="retro"]{'
        + '  --bg:#F1E7CE;'
        + '  --ink:#201D16;'
        + '  --ink-soft:#5B5340;'
        + '  --line:#C9BC98;'
        + '  --accent:#6B2E2A;'
        + '  --bg-rgb:241,231,206;'
        + '  --ink-rgb:32,29,22;'
        + '  --accent-rgb:107,46,42;'
        + '  --shadow-rgb:32,29,22;'
        + '  --dogru:#55632F;'
        + '  --dogru-rgb:85,99,47;'
        + '  --yanlis:#8B3A2B;'
        + '  --yanlis-rgb:139,58,43;'
        + '  --sari:#A6782B;'
        + '  --sari-rgb:166,120,43;'
        + '  --kisa-mola:#5E6B4A;'
        + '  --kisa-mola-rgb:94,107,74;'
        + '}'
        /* Koyu mod + Retro birlikte açıksa: karanlık oda / daktilo lambası hissi */
        + 'html[data-theme="dark"][data-app-tema="retro"]{'
        + '  --bg:#1B1611;'
        + '  --ink:#EFE6CC;'
        + '  --ink-soft:#B3A688;'
        + '  --line:#3A3226;'
        + '  --accent:#D98F73;'
        + '  --bg-rgb:27,22,17;'
        + '  --ink-rgb:239,230,204;'
        + '  --accent-rgb:217,143,115;'
        + '  --shadow-rgb:0,0,0;'
        + '  --dogru:#9FB076;'
        + '  --dogru-rgb:159,176,118;'
        + '  --yanlis:#E0836B;'
        + '  --yanlis-rgb:224,131,107;'
        + '  --sari:#D9AE63;'
        + '  --sari-rgb:217,174,99;'
        + '  --kisa-mola:#A8BE8E;'
        + '  --kisa-mola-rgb:168,190,142;'
        + '}'

        /* ============ RETRO — tipografi: daktilo fontu her yerde ============ */
        + 'html[data-app-tema="retro"] *{'
        + '  font-family:"Courier New","IBM Plex Mono",Courier,monospace !important;'
        + '}'
        + 'html[data-app-tema="retro"] .settings-row-title,'
        + 'html[data-app-tema="retro"] h1,'
        + 'html[data-app-tema="retro"] h2,'
        + 'html[data-app-tema="retro"] h3{'
        + '  letter-spacing:0.01em;'
        + '}'
        + 'html[data-app-tema="retro"] .settings-row-sub{'
        + '  text-transform:uppercase;'
        + '  letter-spacing:0.06em;'
        + '}'

        /* ============ RETRO — minimal doku katmanı (kağıt taneciği + ince çizgiler) ============ */
        + '#' + DOKU_ID + '{'
        + '  position:fixed;'
        + '  inset:0;'
        + '  z-index:2147483000;'
        + '  pointer-events:none;'
        + '  opacity:0;'
        + '  mix-blend-mode:multiply;'
        + '  transition:opacity .5s ease;'
        + '  background-image:'
        + '    radial-gradient(rgba(0,0,0,0.05) 1px, transparent 1px),'
        + '    radial-gradient(rgba(0,0,0,0.035) 1px, transparent 1px),'
        + '    repeating-linear-gradient(135deg, rgba(0,0,0,0.018) 0px, rgba(0,0,0,0.018) 1px, transparent 1px, transparent 64px);'
        + '  background-size:3px 3px, 7px 7px, 90px 90px;'
        + '  background-position:0 0, 2px 3px, 0 0;'
        + '  background-repeat:repeat;'
        + '}'
        + 'html[data-app-tema="retro"] #' + DOKU_ID + '{ opacity:1; }'
        + '@media (prefers-reduced-motion: no-preference){'
        + '  html[data-app-tema="retro"] #' + DOKU_ID + '{'
        + '    animation:appTemaDokuNefes 46s ease-in-out infinite;'
        + '  }'
        + '  @keyframes appTemaDokuNefes{'
        + '    0%{ background-position:0 0, 2px 3px, 0 0; }'
        + '    50%{ background-position:1.5px 1px, 3.5px 5px, 40px 25px; }'
        + '    100%{ background-position:0 0, 2px 3px, 0 0; }'
        + '  }'
        + '}'

        /* ============ RETRO — buton "tipi": mürekkep damgası / daktilo tuşu ============ */
        + 'html[data-app-tema="retro"] button,'
        + 'html[data-app-tema="retro"] [class*="btn" i],'
        + 'html[data-app-tema="retro"] [class*="Btn"]{'
        + '  border-width:2px !important;'
        + '  border-style:solid !important;'
        + '  border-color:var(--ink) !important;'
        + '  border-radius:3px !important;'
        + '  background:var(--bg) !important;'
        + '  color:var(--ink) !important;'
        + '  box-shadow:3px 3px 0 rgba(var(--ink-rgb),0.92) !important;'
        + '  text-transform:uppercase;'
        + '  letter-spacing:0.04em;'
        + '  transition:transform .15s cubic-bezier(.4,0,.2,1), box-shadow .15s cubic-bezier(.4,0,.2,1), background .2s ease !important;'
        + '}'
        + 'html[data-app-tema="retro"] button:active,'
        + 'html[data-app-tema="retro"] [class*="btn" i]:active,'
        + 'html[data-app-tema="retro"] [class*="Btn"]:active{'
        + '  transform:translate(2px,2px) !important;'
        + '  box-shadow:1px 1px 0 rgba(var(--ink-rgb),0.92) !important;'
        + '}'
        /* Seçili/aktif durumlar: mürekkeple basılmış gibi renk tersine döner */
        + 'html[data-app-tema="retro"] .secili,'
        + 'html[data-app-tema="retro"] .active,'
        + 'html[data-app-tema="retro"] .aktif{'
        + '  background:var(--ink) !important;'
        + '  color:var(--bg) !important;'
        + '  border-color:var(--ink) !important;'
        + '  box-shadow:none !important;'
        + '}'
        /* Anlamsal renkler (başlat/durdur/doğru/yanlış/tehlike) korunur */
        + 'html[data-app-tema="retro"] [class*="baslat" i],'
        + 'html[data-app-tema="retro"] [class*="basari" i],'
        + 'html[data-app-tema="retro"] [class*="dogru" i]{'
        + '  border-color:var(--dogru) !important;'
        + '  color:var(--dogru) !important;'
        + '}'
        + 'html[data-app-tema="retro"] [class*="durdur" i],'
        + 'html[data-app-tema="retro"] [class*="tehlike" i],'
        + 'html[data-app-tema="retro"] [class*="danger" i],'
        + 'html[data-app-tema="retro"] [class*="yanlis" i]{'
        + '  border-color:var(--yanlis) !important;'
        + '  color:var(--yanlis) !important;'
        + '}'
        /* Renk (accent) örnekleri kendi rengini göstermeye devam etsin, sadece çerçevesi retro olsun */
        + 'html[data-app-tema="retro"] .renk-swatch{'
        + '  border-radius:3px !important;'
        + '  border:2px solid var(--ink) !important;'
        + '  box-shadow:2px 2px 0 rgba(var(--ink-rgb),0.92) !important;'
        + '  background:inherit !important;'
        + '  color:inherit !important;'
        + '}'
        /* Anahtar/switch: bağlantı rölesi gibi köşeli */
        + 'html[data-app-tema="retro"] .theme-switch{'
        + '  background:var(--bg) !important;'
        + '  border:2px solid var(--ink) !important;'
        + '  border-radius:2px !important;'
        + '  box-shadow:2px 2px 0 rgba(var(--ink-rgb),0.92) !important;'
        + '}'
        + 'html[data-app-tema="retro"] .theme-switch.on{'
        + '  background:rgba(var(--accent-rgb),0.18) !important;'
        + '}'
        + 'html[data-app-tema="retro"] .theme-switch-knob{'
        + '  background:var(--ink) !important;'
        + '  border-radius:1px !important;'
        + '}'
        /* Form alanları da fonttan nasibini alsın, köşeli dursun */
        + 'html[data-app-tema="retro"] input,'
        + 'html[data-app-tema="retro"] textarea,'
        + 'html[data-app-tema="retro"] select{'
        + '  border-radius:2px !important;'
        + '  border-color:var(--line) !important;'
        + '}'
    }
    /* Gelecekte eklenecek yeni "tam dönüşüm" temaları buraya, aynı desende eklenir. */
  };

  /* ---------------------------------------------------------------------
     ERKEN UYGULAMA — CSS boyanmadan önce çalışır, tema yanıp sönmesini önler
     --------------------------------------------------------------------- */
  function erkenUygula() {
    try {
      var kayitli = localStorage.getItem(STORAGE_KEY);
      if (kayitli && TEMALAR[kayitli]) {
        document.documentElement.setAttribute(ATTR, kayitli);
      }
    } catch (e) {}
  }
  erkenUygula();

  /* ---------------------------------------------------------------------
     STİLLERİ ENJEKTE ET — mümkün olan en erken anda <head>'e eklenir
     --------------------------------------------------------------------- */
  function stilleriYukle() {
    if (document.getElementById(STYLE_ID)) return;
    var stil = document.createElement('style');
    stil.id = STYLE_ID;
    var tumCss = '';
    for (var anahtar in TEMALAR) {
      if (TEMALAR.hasOwnProperty(anahtar)) tumCss += TEMALAR[anahtar].css;
    }
    stil.textContent = tumCss;
    (document.head || document.documentElement).appendChild(stil);
  }
  stilleriYukle();

  /* ---------------------------------------------------------------------
     DOKU KATMANINI OLUŞTUR (retro kağıt dokusu için sabit, tıklanamaz katman)
     --------------------------------------------------------------------- */
  function dokuKatmaniOlustur() {
    if (document.getElementById(DOKU_ID) || !document.body) return;
    var katman = document.createElement('div');
    katman.id = DOKU_ID;
    katman.setAttribute('aria-hidden', 'true');
    document.body.appendChild(katman);
  }

  /* ---------------------------------------------------------------------
     TEMA UYGULAMA / OKUMA
     --------------------------------------------------------------------- */
  function aktifTema() {
    var v = document.documentElement.getAttribute(ATTR);
    return (v && TEMALAR[v]) ? v : null;
  }

  function temaUygula(anahtar) {
    var root = document.documentElement;
    if (anahtar && TEMALAR[anahtar]) {
      root.setAttribute(ATTR, anahtar);
      try { localStorage.setItem(STORAGE_KEY, anahtar); } catch (e) {}
    } else {
      root.removeAttribute(ATTR);
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    }
    guncelleUI();
  }

  var etiketEl = null;
  var grupEl = null;

  function guncelleUI() {
    var a = aktifTema();
    if (etiketEl) {
      etiketEl.textContent = a ? (TEMALAR[a].isim + ' aktif') : 'Varsayılan aktif';
    }
    if (grupEl) {
      var dugmeler = grupEl.querySelectorAll('.apptema-btn');
      for (var i = 0; i < dugmeler.length; i++) {
        var d = dugmeler[i];
        var deger = d.getAttribute('data-app-tema');
        d.classList.toggle('secili', a ? deger === a : deger === 'varsayilan');
      }
    }
  }

  /* ---------------------------------------------------------------------
     AYARLAR SATIRINI KUR — mevcut "Arka Plan Animasyonu" satırının hemen
     altına, aynı görsel dile sahip yeni bir satır ekler.
     --------------------------------------------------------------------- */
  function satiriKur() {
    if (document.getElementById('appTemaRow')) return;
    var ankor = document.getElementById('bganimRow');
    if (!ankor || !ankor.parentNode) return;

    var satir = document.createElement('div');
    satir.className = 'settings-row wrap-row';
    satir.id = 'appTemaRow';

    var metin = document.createElement('div');
    metin.className = 'settings-row-text';

    var baslik = document.createElement('span');
    baslik.className = 'settings-row-title';
    baslik.textContent = 'Uygulama Teması';

    var alt = document.createElement('span');
    alt.className = 'settings-row-sub';
    alt.id = 'appTemaStateLabel';

    metin.appendChild(baslik);
    metin.appendChild(alt);

    var grup = document.createElement('div');
    grup.className = 'apptema-group';
    grup.id = 'appTemaGroup';
    grup.setAttribute('role', 'group');
    grup.setAttribute('aria-label', 'Uygulama teması seçenekleri');

    // Her seçim düğmesine, o temanın nasıl göründüğünü gösteren küçük bir
    // renk anahtarı (iki tonlu daire) ekler; "Varsayılan" için şu an aktif
    // olan gerçek renkleri (var(--bg)/var(--ink)) canlı olarak yansıtır.
    function anahtarEkle(hedefBtn, bgRengi, inkRengi) {
      var anahtar = document.createElement('span');
      anahtar.className = 'apptema-anahtar';
      anahtar.style.background =
        'linear-gradient(135deg, ' + bgRengi + ' 50%, ' + inkRengi + ' 50%)';
      hedefBtn.appendChild(anahtar);
    }

    var varsayilanBtn = document.createElement('button');
    varsayilanBtn.type = 'button';
    varsayilanBtn.className = 'apptema-btn';
    varsayilanBtn.setAttribute('data-app-tema', 'varsayilan');
    anahtarEkle(varsayilanBtn, 'var(--bg)', 'var(--ink)');
    varsayilanBtn.appendChild(document.createTextNode('Varsayılan'));
    grup.appendChild(varsayilanBtn);

    for (var anahtarAdi in TEMALAR) {
      if (!TEMALAR.hasOwnProperty(anahtarAdi)) continue;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'apptema-btn';
      btn.setAttribute('data-app-tema', anahtarAdi);
      var onz = TEMALAR[anahtarAdi].onizleme || { bg: 'var(--bg)', ink: 'var(--ink)' };
      anahtarEkle(btn, onz.bg, onz.ink);
      btn.appendChild(document.createTextNode(TEMALAR[anahtarAdi].isim));
      grup.appendChild(btn);
    }

    satir.appendChild(metin);
    satir.appendChild(grup);
    ankor.parentNode.insertBefore(satir, ankor.nextSibling);

    etiketEl = alt;
    grupEl = grup;

    grup.addEventListener('click', function (e) {
      var btn = e.target.closest('.apptema-btn');
      if (!btn) return;
      var secim = btn.getAttribute('data-app-tema');
      temaUygula(secim === 'varsayilan' ? null : secim);
    });

    // Ayarlar satırı grubu için görünüm (bganim-group ile aynı üslupta,
    // bağımsız bir sınıf adıyla tanımlanır ki mevcut kurallarla çakışmasın)
    var grupCss = document.createElement('style');
    grupCss.id = 'app-tema-satir-stilleri';
    grupCss.textContent =
      '.apptema-group{display:flex;gap:0.5rem;flex-wrap:wrap;flex-shrink:0;}' +
      '.apptema-btn{display:inline-flex;align-items:center;gap:0.4rem;padding:0.4rem 0.9rem 0.4rem 0.5rem;' +
      'border:1px solid var(--line);border-radius:100px;' +
      'background:rgba(var(--bg-rgb),0.5);color:var(--ink-soft);font-size:0.72rem;' +
      'letter-spacing:0.04em;cursor:pointer;transition:border-color .2s ease,color .2s ease,background .2s ease;}' +
      '.apptema-btn:hover{border-color:var(--accent);color:var(--ink);}' +
      '.apptema-btn.secili{border-color:var(--accent);background:rgba(var(--accent-rgb),0.16);color:var(--ink);}' +
      '.apptema-anahtar{width:14px;height:14px;flex-shrink:0;border-radius:50%;' +
      'border:1px solid rgba(var(--ink-rgb),0.35);box-shadow:inset 0 0 0 1px rgba(255,255,255,0.15);}';
    document.head.appendChild(grupCss);

    guncelleUI();
  }

  function basla() {
    dokuKatmaniOlustur();
    satiriKur();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', basla);
  } else {
    basla();
  }

  // Dışarıdan (konsol, başka bir modül veya ileride eklenecek bir tema
  // galerisi arayüzü) tema değiştirebilmek için küçük bir genel API.
  window.SessizlikTemalar = {
    uygula: temaUygula,
    aktif: aktifTema,
    listele: function () {
      var liste = [];
      for (var k in TEMALAR) { if (TEMALAR.hasOwnProperty(k)) liste.push(k); }
      return liste;
    }
  };
})();
