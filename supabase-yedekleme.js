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
   - Arayüzü Ayarlar sayfasındaki "Bulut Yedekleme" satırıdır
     (index.html içinde #bulutYedekRow): satırdaki "Yedekle" butonu
     şimdi yedekler, bulut ikonu buluttan geri yükler, çıkış ikonu
     hesaptan çıkış yapar. Kurulum/giriş formu ile senkron çakışması
     seçimi hâlâ küçük bir alt panelde gösterilir.
================================================================= */
(function () {
  'use strict';

  var ONEK = 'sessizlik-';                 // Yedeklenecek anahtarların öneki
  var AYAR_ANAHTARI = 'bulut-supabase-ayar'; // Elle girilmiş özel ayar varsa (nadiren gerekir) burada saklanır
  var SON_YEDEK_ANAHTARI = 'bulut-son-yedek-zamani';
  var SUPABASE_JS_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
  var TABLO = 'yedekler';

  // Uygulamanın kendi Supabase projesi — tüm kullanıcılar için sabittir.
  // "anon/publishable" anahtar tarayıcıda bulunmak üzere tasarlanmıştır
  // (gizli değildir); gerçek güvenlik supabase-yedekleme.sql'deki RLS
  // politikalarından gelir, bu anahtardan değil.
  var VARSAYILAN_AYAR = {
    url: 'https://jyrvvyiwlavqquxbodab.supabase.co',
    anonKey: 'sb_publishable_3_9QRSOx-HHZ2vq_ZZd0Bw_rpEGMeCm'
  };

  var istemci = null;      // supabase client
  var oturum = null;       // aktif auth session
  var debounceZamanlayici = null;
  var senkronDurum = 'kapali'; // kapali | bekliyor | senkron | hata
  var supabaseJsYukleniyor = null;

  /* ---------------- Yardımcılar ---------------- */

  function ayarlariOku() {
    try {
      var ham = localStorage.getItem(AYAR_ANAHTARI);
      if (ham) return JSON.parse(ham);
    } catch (e) {}
    if (VARSAYILAN_AYAR.url && VARSAYILAN_AYAR.anonKey && VARSAYILAN_AYAR.anonKey.indexOf('BURAYA_') !== 0) {
      return VARSAYILAN_AYAR;
    }
    return null;
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

  function hataMesajiCevir(ham) {
    var m = String(ham || '').toLowerCase();
    if (m.indexOf('invalid login credentials') !== -1) return 'E-posta veya şifre hatalı.';
    if (m.indexOf('email not confirmed') !== -1) return 'Önce e-posta adresini onaylaman gerekiyor.';
    if (m.indexOf('user already registered') !== -1 || m.indexOf('already registered') !== -1) return 'Bu e-posta ile zaten bir hesap var, giriş yapmayı dene.';
    if (m.indexOf('password should be at least') !== -1) return 'Şifre en az 6 karakter olmalı.';
    if (m.indexOf('unable to validate email') !== -1 || m.indexOf('invalid email') !== -1) return 'Geçerli bir e-posta adresi gir.';
    if (m.indexOf('rate limit') !== -1 || m.indexOf('too many requests') !== -1) return 'Çok fazla deneme yapıldı, birkaç dakika sonra tekrar dene.';
    if (m.indexOf('failed to fetch') !== -1 || m.indexOf('network') !== -1) return 'Bağlantı kurulamadı, internetini kontrol et.';
    return ham || 'Bir hata oluştu, tekrar dene.';
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
      '.bulut-sifre-wrap{position:relative;}',
      '.bulut-sifre-wrap input{padding-right:2.5rem;}',
      '.bulut-goz-btn{position:absolute;right:0.35rem;top:50%;transform:translateY(-50%);width:1.9rem;height:1.9rem;',
      'background:none;border:none;cursor:pointer;color:var(--ink-soft);padding:0;}',
      '.bulut-goz-btn:active{color:var(--accent);}',
      '.bulut-goz-btn svg{position:absolute;top:50%;left:50%;width:1.15rem;height:1.15rem;',
      'transform:translate(-50%,-50%) scale(1) rotate(0deg);opacity:1;',
      'transition:opacity .28s cubic-bezier(.4,0,.2,1), transform .28s cubic-bezier(.4,0,.2,1);}',
      '.bulut-goz-btn .goz-kapali{opacity:0;transform:translate(-50%,-50%) scale(0.4) rotate(-25deg);}',
      '.bulut-goz-btn.acik .goz-acik{opacity:0;transform:translate(-50%,-50%) scale(0.4) rotate(25deg);}',
      '.bulut-goz-btn.acik .goz-kapali{opacity:1;transform:translate(-50%,-50%) scale(1) rotate(0deg);}',
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

  function domOlustur() {
    kokEl = document.createElement('div');

    var overlay = document.createElement('div');
    overlay.className = 'bulut-panel-overlay';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) panelKapat(); });

    panelEl = document.createElement('div');
    panelEl.className = 'bulut-panel';
    overlay.appendChild(panelEl);

    kokEl.appendChild(overlay);
    document.body.appendChild(kokEl);

    kokEl._overlay = overlay;
  }

  function panelAc() { kokEl._overlay.classList.add('acik'); panelCiz(); }
  function panelKapat() { kokEl._overlay.classList.remove('acik'); }

  function panelGuncelle() {
    satirGuncelle();
    if (!kokEl) return;
    if (kokEl._overlay.classList.contains('acik')) panelCiz();
  }

  /* ---------------- Ayarlar sayfasındaki bulut yedekleme satırı ---------------- */
  // Eskiden sağ altta/üstte yüzen bir "bulut" butonu vardı; artık bu buton
  // kaldırıldı ve aynı işlevler Ayarlar sayfasındaki satıra taşındı:
  // - Satırın kendisine (Yedekle butonuna) tıklamak => şimdi yedekle
  // - Bulut (geri yükle) ikonuna tıklamak => buluttan geri yükle
  // - Çıkış ikonuna tıklamak => hesaptan çıkış yap
  var satirEl = null;

  function satirElemanlariAl() {
    if (satirEl) return true;
    var baslik = document.getElementById('bulutBaslikLabel');
    var durum = document.getElementById('bulutDurumLabel');
    var baglanBtn = document.getElementById('bulutBaglanBtn');
    var iconGrup = document.getElementById('bulutIconGrup');
    var yedekleBtn = document.getElementById('bulutYedekleBtn');
    var geriYukleBtn = document.getElementById('bulutGeriYukleBtn');
    var cikisBtn = document.getElementById('bulutCikisBtn');
    if (!baslik || !durum || !baglanBtn || !iconGrup || !yedekleBtn || !geriYukleBtn || !cikisBtn) return false;

    satirEl = {
      baslik: baslik,
      durum: durum,
      baglanBtn: baglanBtn,
      iconGrup: iconGrup,
      yedekleBtn: yedekleBtn,
      geriYukleBtn: geriYukleBtn,
      cikisBtn: cikisBtn
    };

    baglanBtn.addEventListener('click', function () { panelAc(); });

    yedekleBtn.addEventListener('click', function () {
      satirEl.durum.textContent = 'Yedekleniyor…';
      simdiYedekle().then(function (basarili) {
        if (!basarili) { satirEl.durum.textContent = 'Yedekleme başarısız oldu.'; return; }
        satirGuncelle();
      });
    });

    geriYukleBtn.addEventListener('click', function () { buluttanGeriYukle(false); });

    cikisBtn.addEventListener('click', function () {
      if (!window.confirm('Hesabından çıkış yapmak istediğine emin misin?')) return;
      istemci.auth.signOut().then(function () { satirGuncelle(); });
    });

    return true;
  }

  function satirGuncelle() {
    if (!satirElemanlariAl()) return;
    var ayar = ayarlariOku();

    if (!ayar) {
      satirEl.baslik.textContent = 'Bulut Yedekleme';
      satirEl.durum.textContent = 'Kurulum yap ve hesabına bağlan';
      satirEl.baglanBtn.style.display = '';
      satirEl.iconGrup.style.display = 'none';
      return;
    }

    if (!girisliMi()) {
      satirEl.baslik.textContent = 'Bulut Yedekleme';
      satirEl.durum.textContent = 'Hesabına giriş yap';
      satirEl.baglanBtn.style.display = '';
      satirEl.iconGrup.style.display = 'none';
      return;
    }

    var sonYedek = localStorage.getItem(SON_YEDEK_ANAHTARI);
    var noktaSinif = (senkronDurum === 'senkron' || senkronDurum === 'bekliyor' || senkronDurum === 'hata') ? senkronDurum : '';
    satirEl.baslik.textContent = oturum.user.email;
    satirEl.durum.innerHTML = '<span class="bulut-durum-noktasi ' + noktaSinif + '"></span>Son yedek: ' + zamanFormatla(sonYedek);
    satirEl.baglanBtn.style.display = 'none';
    satirEl.iconGrup.style.display = '';
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
    panelEl.querySelector('#bulutSecBulut').addEventListener('click', function () { panelKapat(); buluttanGeriYukle(true); });
    panelEl.querySelector('#bulutSecCihaz').addEventListener('click', function () { panelKapat(); simdiYedekle(); });
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
        '<div class="bulut-sifre-wrap">' +
        '<input type="password" id="bulutSifre" autocomplete="current-password">' +
        '<button type="button" class="bulut-goz-btn" id="bulutGozBtn" aria-label="Şifreyi göster">' +
        '<svg class="goz-acik" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>' +
        '<svg class="goz-kapali" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.8 21.8 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a21.8 21.8 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>' +
        '</button>' +
        '</div>' +
        '<div class="bulut-satir">' +
        '<button class="bulut-btn ana" id="bulutGirisBtn">Giriş Yap</button>' +
        '<button class="bulut-btn" id="bulutKayitBtn">Kayıt Ol</button>' +
        '</div>' +
        '<div class="bulut-mesaj" id="bulutMesaj"></div>';
      mesajEl = panelEl.querySelector('#bulutMesaj');
      panelEl.querySelector('.bulut-kapat').addEventListener('click', panelKapat);
      panelEl.querySelector('#bulutGozBtn').addEventListener('click', function () {
        var sifreInput = panelEl.querySelector('#bulutSifre');
        var acikMi = this.classList.toggle('acik');
        sifreInput.type = acikMi ? 'text' : 'password';
        this.setAttribute('aria-label', acikMi ? 'Şifreyi gizle' : 'Şifreyi göster');
      });
      panelEl.querySelector('#bulutGirisBtn').addEventListener('click', function () {
        var e = panelEl.querySelector('#bulutEposta').value.trim();
        var s = panelEl.querySelector('#bulutSifre').value;
        if (!e || !s) { mesajGoster('E-posta ve şifre gerekli.'); return; }
        mesajGoster('Giriş yapılıyor…');
        istemci.auth.signInWithPassword({ email: e, password: s }).then(function (r) {
          if (r.error) { mesajGoster(hataMesajiCevir(r.error.message)); return; }
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
          if (r.error) { mesajGoster(hataMesajiCevir(r.error.message)); return; }
          mesajGoster('Hesap oluşturuldu. E-postanı onayladıktan sonra giriş yapabilirsin (proje ayarına göre onaysız da giriş yapmış olabilirsin).');
        });
      });
      return;
    }

    // Giriş yapılmış durumda artık işlemler (yedekle / geri yükle / çıkış)
    // Ayarlar sayfasındaki satırdan yapılıyor; bu panel normalde bu aşamada
    // açılmaz (yalnızca çakışma seçimi gibi özel durumlarda panelSecimGoster
    // hemen üzerine yazar), bu yüzden burada sade bir bilgi kartı yeterli.
    var sonYedek = localStorage.getItem(SON_YEDEK_ANAHTARI);
    panelEl.innerHTML =
      '<button class="bulut-kapat" type="button" aria-label="Kapat">✕</button>' +
      '<h3>Bulut Yedekleme</h3>' +
      '<p class="bulut-not">' + oturum.user.email + '</p>' +
      '<p class="bulut-durum">Son yedek: ' + zamanFormatla(sonYedek) + '</p>';
    panelEl.querySelector('.bulut-kapat').addEventListener('click', panelKapat);
  }

  /* ---------------- Başlat ---------------- */

  function baslat() {
    stilEkle();
    domOlustur();
    satirGuncelle();
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
