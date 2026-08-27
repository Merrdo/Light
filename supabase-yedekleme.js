/* ================================================================
   SESSİZLİĞİN SESİ — SUPABASE BULUT YEDEKLEME MODÜLÜ
   ----------------------------------------------------------------
   Bu dosya ana uygulamadan tamamen BAĞIMSIZDIR: hiçbir mevcut
   fonksiyona, id'ye veya localStorage anahtarına dokunmaz. Sadece
   "sessizlik-" ile başlayan tüm anahtarları okuyup/yazarak çalışır,
   bu yüzden uygulamaya yeni bir özellik eklendiğinde bile (yeni bir
   localStorage anahtarı eklendiğinde) otomatik olarak yedeklenir.

   Ne yapar:
   - E-posta/şifre ile hesap oluşturma & giriş
   - Tüm uygulama verisini tek bir bulut kaydına (jsonb) yedekler
   - Değişiklik olduğunda otomatik (debounce'lu) senkron
   - Çevrimdışıyken sessizce bekler, bağlantı gelince tekrar dener
   - Yeni cihazda "buluttan geri yükle" ile veriyi geri getirir
   - Mevcut açık/koyu tema ve vurgu rengiyle uyumlu, kayan bir
     buton + panel arayüzü sağlar
================================================================= */
(function () {
  'use strict';

  var ONEK = 'sessizlik-';                 // Yedeklenecek anahtarların öneki
  var AYAR_ANAHTARI = 'bulut-supabase-ayar'; // Supabase URL/anon key burada saklanır (senkron DIŞI)
  var SON_YEDEK_ANAHTARI = 'bulut-son-yedek-zamani';
  var SUPABASE_JS_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
  var TABLO = 'yedekler';

  var istemci = null;      // supabase client
  var oturum = null;       // aktif auth session
  var debounceZamanlayici = null;
  var senkronDurum = 'kapali'; // kapali | bekliyor | senkron | hata
  var supabaseJsYukleniyor = null;

  /* ---------------- Yardımcılar ---------------- */

  function ayarlariOku() {
    try {
      var ham = localStorage.getItem(AYAR_ANAHTARI);
      return ham ? JSON.parse(ham) : null;
    } catch (e) { return null; }
  }

  function ayarlariKaydet(url, anonKey) {
    localStorage.setItem(AYAR_ANAHTARI, JSON.stringify({ url: url, anonKey: anonKey }));
  }

  function tumVeriyiTopla() {
    var veri = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(ONEK) === 0) {
        veri[k] = localStorage.getItem(k);
      }
    }
    return veri;
  }

  function veriyiYerelUygula(veri) {
    // Önce bulutta olmayan yerel "sessizlik-" anahtarlarını temizle
    // (tam geri yükleme = cihazı buluttaki hâle birebir eşitler)
    var mevcutAnahtarlar = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(ONEK) === 0) mevcutAnahtarlar.push(k);
    }
    mevcutAnahtarlar.forEach(function (k) {
      if (!(k in veri)) localStorage.removeItem(k);
    });
    Object.keys(veri).forEach(function (k) {
      localStorage.setItem(k, veri[k]);
    });
  }

  function veriBosMu(veri) {
    return !veri || Object.keys(veri).length === 0;
  }

  function zamanFormatla(iso) {
    if (!iso) return 'Hiç yedeklenmedi';
    try {
      var d = new Date(iso);
      return d.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return iso; }
  }

  function supabaseJsYukle() {
    if (window.supabase) return Promise.resolve();
    if (supabaseJsYukleniyor) return supabaseJsYukleniyor;
    supabaseJsYukleniyor = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SUPABASE_JS_CDN;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Supabase kütüphanesi yüklenemedi. İnternet bağlantını kontrol et.')); };
      document.head.appendChild(s);
    });
    return supabaseJsYukleniyor;
  }

  /* ---------------- Supabase bağlantısı ---------------- */

  function baglantiyiKur() {
    var ayar = ayarlariOku();
    if (!ayar || !ayar.url || !ayar.anonKey) return Promise.resolve(false);
    return supabaseJsYukle().then(function () {
      istemci = window.supabase.createClient(ayar.url, ayar.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true }
      });
      return istemci.auth.getSession().then(function (r) {
        oturum = r.data && r.data.session ? r.data.session : null;
        istemci.auth.onAuthStateChange(function (_olay, yeniOturum) {
          var oncekiVarMi = !!oturum;
          oturum = yeniOturum;
          panelGuncelle();
          if (!oncekiVarMi && oturum) girisSonrasiSenkronKontrol();
        });
        return true;
      });
    }).catch(function (e) {
      senkronDurum = 'hata';
      console.error('Supabase bağlantı hatası:', e);
      panelGuncelle();
      return false;
    });
  }

  function girisliMi() { return !!(oturum && oturum.user); }

  /* ---------------- Yedekleme / geri yükleme mantığı ---------------- */

  function buluttakiYedegiGetir() {
    return istemci.from(TABLO).select('veri,guncellenme_zamani').eq('user_id', oturum.user.id).maybeSingle();
  }

  function simdiYedekle() {
    if (!girisliMi() || !navigator.onLine) return Promise.resolve(false);
    senkronDurum = 'bekliyor';
    panelGuncelle();
    var veri = tumVeriyiTopla();
    return istemci.from(TABLO).upsert({
      user_id: oturum.user.id,
      veri: veri,
      guncellenme_zamani: new Date().toISOString(),
      cihaz_etiketi: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'bilinmiyor'
    }, { onConflict: 'user_id' }).then(function (r) {
      if (r.error) throw r.error;
      senkronDurum = 'senkron';
      localStorage.setItem(SON_YEDEK_ANAHTARI, new Date().toISOString());
      panelGuncelle();
      return true;
    }).catch(function (e) {
      senkronDurum = 'hata';
      console.error('Yedekleme hatası:', e);
      panelGuncelle();
      return false;
    });
  }

  function buluttanGeriYukle(zorlaOnaysiz) {
    if (!girisliMi()) return Promise.resolve(false);
    var calistir = function () {
      return buluttakiYedegiGetir().then(function (r) {
        if (r.error) throw r.error;
        if (!r.data || veriBosMu(r.data.veri)) {
          mesajGoster('Bulutta henüz bir yedek bulunamadı.');
          return false;
        }
        veriyiYerelUygula(r.data.veri);
        localStorage.setItem(SON_YEDEK_ANAHTARI, r.data.guncellenme_zamani);
        mesajGoster('Veriler geri yüklendi. Uygulama yeniden başlatılıyor…');
        setTimeout(function () { window.location.reload(); }, 900);
        return true;
      }).catch(function (e) {
        senkronDurum = 'hata';
        console.error('Geri yükleme hatası:', e);
        mesajGoster('Geri yükleme başarısız oldu. Bağlantını kontrol edip tekrar dene.');
        panelGuncelle();
        return false;
      });
    };
    if (zorlaOnaysiz) return calistir();
    if (window.confirm('Bu cihazdaki mevcut veriler, buluttaki yedekle DEĞİŞTİRİLECEK. Emin misin?')) {
      return calistir();
    }
    return Promise.resolve(false);
  }

  // Girişten hemen sonra: yerelde veri var mı, buluttta veri var mı
  // durumuna göre en makul aksiyonu otomatik öner/uygula.
  function girisSonrasiSenkronKontrol() {
    if (!girisliMi()) return;
    var yerel = tumVeriyiTopla();
    var yerelBos = veriBosMu(yerel);
    buluttakiYedegiGetir().then(function (r) {
      if (r.error) { senkronDurum = 'hata'; panelGuncelle(); return; }
      var bulutBos = !r.data || veriBosMu(r.data.veri);
      if (bulutBos && !yerelBos) {
        // İlk kez bağlanıyor: bu cihazdaki veriyi buluta gönder.
        simdiYedekle();
      } else if (!bulutBos && yerelBos) {
        // Yeni/boş cihaz: buluttaki veriyi sessizce indir.
        buluttanGeriYukle(true);
      } else if (!bulutBos && !yerelBos) {
        // Her iki tarafta da veri var — kullanıcıya sor.
        panelSecimGoster(r.data.guncellenme_zamani);
      } else {
        senkronDurum = 'senkron';
        panelGuncelle();
      }
    });
  }

  /* ---------------- Otomatik senkron (debounce) ---------------- */

  function otomatikSenkronTetikle() {
    if (!girisliMi()) return;
    clearTimeout(debounceZamanlayici);
    senkronDurum = 'bekliyor';
    panelGuncelle();
    debounceZamanlayici = setTimeout(function () { simdiYedekle(); }, 2500);
  }

  function localStorageIzle() {
    var orjSet = localStorage.setItem.bind(localStorage);
    var orjRemove = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      orjSet(k, v);
      if (k && k.indexOf(ONEK) === 0) otomatikSenkronTetikle();
    };
    localStorage.removeItem = function (k) {
      orjRemove(k);
      if (k && k.indexOf(ONEK) === 0) otomatikSenkronTetikle();
    };
    window.addEventListener('storage', function (e) {
      // Aynı cihazda başka bir sekmede değişiklik olduysa da senkron dene.
      if (e.key && e.key.indexOf(ONEK) === 0) otomatikSenkronTetikle();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && girisliMi()) simdiYedekle();
    });
    window.addEventListener('online', function () {
      if (girisliMi()) simdiYedekle();
    });
  }

  /* ---------------- Arayüz ---------------- */

  var kokEl, panelEl, mesajEl;

  function stilEkle() {
    var s = document.createElement('style');
    s.textContent = [
      '.bulut-fab{position:fixed;right:1.1rem;z-index:9998;width:3rem;height:3rem;border-radius:50%;',
      'background:var(--bg);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;',
      'cursor:pointer;box-shadow:0 2px 10px rgba(var(--shadow-rgb),0.14);transition:transform .2s ease;}',
      '.bulut-fab:active{transform:scale(0.93);}',
      'html[data-navbar="bottom"] .bulut-fab{bottom:calc(6.4rem + env(safe-area-inset-bottom,0px));}',
      'html[data-navbar="top"] .bulut-fab{top:calc(1rem + env(safe-area-inset-top,0px));}',
      '.bulut-fab svg{width:1.3rem;height:1.3rem;stroke:var(--ink-soft);}',
      '.bulut-fab .nokta{position:absolute;top:0.35rem;right:0.35rem;width:0.5rem;height:0.5rem;border-radius:50%;background:var(--ink-soft);border:2px solid var(--bg);}',
      '.bulut-fab .nokta.senkron{background:var(--dogru);} .bulut-fab .nokta.bekliyor{background:var(--sari);} .bulut-fab .nokta.hata{background:var(--yanlis);}',
      '.bulut-panel-overlay{position:fixed;inset:0;background:rgba(var(--shadow-rgb),0.35);z-index:9999;display:none;align-items:flex-end;justify-content:center;}',
      '.bulut-panel-overlay.acik{display:flex;}',
      '@media(min-width:640px){.bulut-panel-overlay{align-items:center;}}',
      '.bulut-panel{width:100%;max-width:26rem;background:var(--bg);color:var(--ink);border:1px solid var(--line);',
      'border-radius:1.1rem 1.1rem 0 0;padding:1.4rem 1.3rem calc(1.4rem + env(safe-area-inset-bottom,0px));',
      'font-family:inherit;max-height:85vh;overflow-y:auto;}',
      '@media(min-width:640px){.bulut-panel{border-radius:1.1rem;}}',
      '.bulut-panel h3{font-size:1.05rem;margin-bottom:0.9rem;font-weight:600;}',
      '.bulut-panel label{display:block;font-size:0.78rem;color:var(--ink-soft);margin:0.7rem 0 0.3rem;}',
      '.bulut-panel input{width:100%;padding:0.6rem 0.7rem;border:1px solid var(--line);border-radius:0.6rem;',
      'background:transparent;color:var(--ink);font-size:0.92rem;font-family:inherit;}',
      '.bulut-panel input:focus{outline:none;border-color:var(--accent);}',
      '.bulut-btn{width:100%;padding:0.68rem;border-radius:0.6rem;border:1px solid var(--line);background:transparent;',
      'color:var(--ink);font-size:0.9rem;margin-top:0.7rem;cursor:pointer;font-family:inherit;}',
      '.bulut-btn.ana{background:var(--accent);border-color:var(--accent);color:var(--bg);font-weight:600;}',
      '.bulut-btn.tehlike{color:var(--yanlis);border-color:var(--yanlis);}',
      '.bulut-satir{display:flex;gap:0.6rem;}',
      '.bulut-kapat{position:absolute;top:1rem;right:1.1rem;background:none;border:none;color:var(--ink-soft);font-size:1.1rem;cursor:pointer;}',
      '.bulut-durum{font-size:0.78rem;color:var(--ink-soft);margin-top:0.2rem;}',
      '.bulut-mesaj{font-size:0.82rem;background:rgba(var(--accent-rgb),0.1);color:var(--ink);padding:0.55rem 0.7rem;',
      'border-radius:0.5rem;margin-top:0.8rem;display:none;}',
      '.bulut-mesaj.gorunur{display:block;}',
      '.bulut-not{font-size:0.75rem;color:var(--ink-soft);line-height:1.4;margin-top:0.5rem;}',
      '.bulut-panel a{color:var(--accent);}'
    ].join('');
    document.head.appendChild(s);
  }

  function mesajGoster(m) {
    if (!mesajEl) return;
    mesajEl.textContent = m;
    mesajEl.classList.add('gorunur');
  }

  function ikonSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h.79a4.5 4.5 0 1 1 0 9Z"/></svg>';
  }

  function domOlustur() {
    kokEl = document.createElement('div');
    var fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'bulut-fab';
    fab.setAttribute('aria-label', 'Bulut Yedekleme');
    fab.innerHTML = ikonSvg() + '<span class="nokta kapali"></span>';
    fab.addEventListener('click', function () { panelAc(); });

    var overlay = document.createElement('div');
    overlay.className = 'bulut-panel-overlay';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) panelKapat(); });

    panelEl = document.createElement('div');
    panelEl.className = 'bulut-panel';
    overlay.appendChild(panelEl);

    kokEl.appendChild(fab);
    kokEl.appendChild(overlay);
    document.body.appendChild(kokEl);

    kokEl._fab = fab;
    kokEl._overlay = overlay;
  }

  function panelAc() { kokEl._overlay.classList.add('acik'); panelCiz(); }
  function panelKapat() { kokEl._overlay.classList.remove('acik'); }

  function panelGuncelle() {
    if (!kokEl) return;
    var nokta = kokEl._fab.querySelector('.nokta');
    nokta.className = 'nokta ' + senkronDurum;
    if (kokEl._overlay.classList.contains('acik')) panelCiz();
  }

  function panelSecimGoster(bulutZamani) {
    panelAc();
    panelEl.innerHTML =
      '<button class="bulut-kapat" type="button" aria-label="Kapat">✕</button>' +
      '<h3>Bu cihazda da, buluttada da veri var</h3>' +
      '<p class="bulut-not">Bulut yedeği: ' + zamanFormatla(bulutZamani) + '<br>Hangisini kullanmak istersin?</p>' +
      '<button class="bulut-btn ana" id="bulutSecBulut">Buluttaki Veriyi Kullan (bu cihazınkini değiştirir)</button>' +
      '<button class="bulut-btn" id="bulutSecCihaz">Bu Cihazdakini Kullan (buluta gönder)</button>' +
      '<button class="bulut-btn" id="bulutSecVazgec">Şimdi Karar Vermeyeyim</button>';
    panelEl.querySelector('.bulut-kapat').addEventListener('click', panelKapat);
    panelEl.querySelector('#bulutSecBulut').addEventListener('click', function () { buluttanGeriYukle(true); });
    panelEl.querySelector('#bulutSecCihaz').addEventListener('click', function () { simdiYedekle().then(panelKapat); });
    panelEl.querySelector('#bulutSecVazgec').addEventListener('click', panelKapat);
  }

  function panelCiz() {
    var ayar = ayarlariOku();
    mesajEl = null;

    if (!ayar) {
      panelEl.innerHTML =
        '<button class="bulut-kapat" type="button" aria-label="Kapat">✕</button>' +
        '<h3>Bulut Yedekleme Kurulumu</h3>' +
        '<p class="bulut-not">Verilerini buluta yedeklemek için kendi Supabase projenin bilgilerini gir. ' +
        '(<a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a> üzerinden ücretsiz oluşturabilirsin — Project Settings → API kısmındaki "Project URL" ve "anon public" anahtarı.)</p>' +
        '<label for="bulutUrl">Project URL</label>' +
        '<input type="url" id="bulutUrl" placeholder="https://xxxx.supabase.co">' +
        '<label for="bulutKey">Anon Public Key</label>' +
        '<input type="text" id="bulutKey" placeholder="eyJhbGciOi...">' +
        '<button class="bulut-btn ana" id="bulutKaydetBtn">Kaydet ve Bağlan</button>' +
        '<div class="bulut-mesaj" id="bulutMesaj"></div>';
      mesajEl = panelEl.querySelector('#bulutMesaj');
      panelEl.querySelector('.bulut-kapat').addEventListener('click', panelKapat);
      panelEl.querySelector('#bulutKaydetBtn').addEventListener('click', function () {
        var url = panelEl.querySelector('#bulutUrl').value.trim();
        var key = panelEl.querySelector('#bulutKey').value.trim();
        if (!url || !key) { mesajGoster('Lütfen her iki alanı da doldur.'); return; }
        ayarlariKaydet(url, key);
        mesajGoster('Kaydedildi, bağlanılıyor…');
        baglantiyiKur().then(function (basarili) {
          if (basarili) panelCiz();
        });
      });
      return;
    }

    if (!girisliMi()) {
      panelEl.innerHTML =
        '<button class="bulut-kapat" type="button" aria-label="Kapat">✕</button>' +
        '<h3>Hesabına Bağlan</h3>' +
        '<label for="bulutEposta">E-posta</label>' +
        '<input type="email" id="bulutEposta" autocomplete="email">' +
        '<label for="bulutSifre">Şifre</label>' +
        '<input type="password" id="bulutSifre" autocomplete="current-password">' +
        '<div class="bulut-satir">' +
        '<button class="bulut-btn ana" id="bulutGirisBtn">Giriş Yap</button>' +
        '<button class="bulut-btn" id="bulutKayitBtn">Kayıt Ol</button>' +
        '</div>' +
        '<button class="bulut-btn" id="bulutAyarSifirla">Farklı Proje Kullan</button>' +
        '<div class="bulut-mesaj" id="bulutMesaj"></div>';
      mesajEl = panelEl.querySelector('#bulutMesaj');
      panelEl.querySelector('.bulut-kapat').addEventListener('click', panelKapat);
      panelEl.querySelector('#bulutAyarSifirla').addEventListener('click', function () {
        localStorage.removeItem(AYAR_ANAHTARI);
        istemci = null; oturum = null;
        panelCiz();
      });
      panelEl.querySelector('#bulutGirisBtn').addEventListener('click', function () {
        var e = panelEl.querySelector('#bulutEposta').value.trim();
        var s = panelEl.querySelector('#bulutSifre').value;
        if (!e || !s) { mesajGoster('E-posta ve şifre gerekli.'); return; }
        mesajGoster('Giriş yapılıyor…');
        istemci.auth.signInWithPassword({ email: e, password: s }).then(function (r) {
          if (r.error) { mesajGoster(r.error.message); return; }
          panelCiz();
        });
      });
      panelEl.querySelector('#bulutKayitBtn').addEventListener('click', function () {
        var e = panelEl.querySelector('#bulutEposta').value.trim();
        var s = panelEl.querySelector('#bulutSifre').value;
        if (!e || !s) { mesajGoster('E-posta ve şifre gerekli.'); return; }
        if (s.length < 6) { mesajGoster('Şifre en az 6 karakter olmalı.'); return; }
        mesajGoster('Hesap oluşturuluyor…');
        istemci.auth.signUp({ email: e, password: s }).then(function (r) {
          if (r.error) { mesajGoster(r.error.message); return; }
          mesajGoster('Hesap oluşturuldu. E-postanı onayladıktan sonra giriş yapabilirsin (proje ayarına göre onaysız da giriş yapmış olabilirsin).');
        });
      });
      return;
    }

    var sonYedek = localStorage.getItem(SON_YEDEK_ANAHTARI);
    var durumMetni = { senkron: 'Güncel', bekliyor: 'Senkronize ediliyor…', hata: 'Hata oluştu', kapali: 'Bağlı değil' }[senkronDurum] || '';
    panelEl.innerHTML =
      '<button class="bulut-kapat" type="button" aria-label="Kapat">✕</button>' +
      '<h3>Bulut Yedekleme</h3>' +
      '<p class="bulut-not">' + oturum.user.email + '</p>' +
      '<p class="bulut-durum">Durum: ' + durumMetni + ' · Son yedek: ' + zamanFormatla(sonYedek) + '</p>' +
      '<button class="bulut-btn ana" id="bulutYedekleBtn">Şimdi Yedekle</button>' +
      '<button class="bulut-btn" id="bulutGeriYukleBtn">Buluttan Geri Yükle</button>' +
      '<button class="bulut-btn tehlike" id="bulutCikisBtn">Çıkış Yap</button>' +
      '<div class="bulut-mesaj" id="bulutMesaj"></div>';
    mesajEl = panelEl.querySelector('#bulutMesaj');
    panelEl.querySelector('.bulut-kapat').addEventListener('click', panelKapat);
    panelEl.querySelector('#bulutYedekleBtn').addEventListener('click', function () {
      mesajGoster('Yedekleniyor…');
      simdiYedekle().then(function (ok) { mesajGoster(ok ? 'Yedeklendi.' : 'Yedekleme başarısız oldu.'); });
    });
    panelEl.querySelector('#bulutGeriYukleBtn').addEventListener('click', function () { buluttanGeriYukle(false); });
    panelEl.querySelector('#bulutCikisBtn').addEventListener('click', function () {
      istemci.auth.signOut().then(function () { panelCiz(); });
    });
  }

  /* ---------------- Başlat ---------------- */

  function baslat() {
    stilEkle();
    domOlustur();
    localStorageIzle();
    baglantiyiKur().then(function (basarili) {
      if (basarili && girisliMi()) girisSonrasiSenkronKontrol();
      panelGuncelle();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', baslat);
  } else {
    baslat();
  }
})();
