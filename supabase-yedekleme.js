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
   - Tüm uygulama verisini tek bir bulut kaydına (jsonb) yedekler — hem
     localStorage'daki "sessizlik-" verilerini hem de soru görselleri, havuz
     görselleri ve cevap anahtarı gibi IndexedDB'de saklanan dosyaların
     kendisini (base64 olarak). Böylece bir cihazda eklenen bir soru
     görseli başka bir cihazda da görünür.
   - Değişiklik olduğunda otomatik (debounce'lu) senkron
   - Çevrimdışıyken sessizce bekler, bağlantı gelince tekrar dener
   - Girişten sonra yerel/bulut verisini otomatik uzlaştırır: bulutta bu
     cihazın bilmediği daha yeni bir kayıt varsa sessizce indirir, yoksa
     hiçbir şey sormaz/göstermez (her açılışta tekrar sormaz)
   - Arayüzü Ayarlar sayfasındaki "Bulut Yedekleme" satırıdır
     (index.html içinde #bulutYedekRow): satırdaki "Yedekle" butonu
     şimdi yedekler, çıkış ikonu hesaptan çıkış yapar (kendi tasarımımızla
     uyumlu bir onay pop-up'ı gösterilir, tarayıcının window.confirm()'ü
     değil). Kurulum/giriş formu hâlâ küçük bir alt panelde gösterilir.
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

  // localStorage sadece küçük metin verisini (soru referansları vb.) tutar; asıl
  // fotoğraf/PDF içerikleri (soru görselleri, havuz görselleri, cevap anahtarı)
  // uygulama tarafında ayrı bir IndexedDB katmanında saklanır (index.html,
  // "sessizlik-dosyalar" veritabanı). Bu yüzden yalnızca localStorage'ı yedeklemek
  // yeterli değildir: bir cihazda eklenen görsel, referansı (bir kimlik/ID) bulutta
  // görünse bile, görselin kendisi o cihazın IndexedDB'sinde kaldığı için başka bir
  // cihaza inmiyordu. Aşağıdaki üç fonksiyon (blobBase64Cevir/base64Blob'aCevir ve
  // güncellenmiş tumVeriyiTopla/veriyiYerelUygula) bu IndexedDB içeriğini de
  // yedeğe dahil eder. window.__sessizlikDosyaTumIcerigiAl / __sessizlikDosyaKaydet /
  // __sessizlikDosyaSil, index.html içinde bu amaçla dışa açılmış köprülerdir.
  var YEDEK_SURUMU = 2;

  // Özel arka plan görseli, index.html'de kendi ayrı ve küçük IndexedDB
  // deposunda (sessizlik-arkaplan-db) saklanıyor — "sessizlik-dosyalar"
  // deposundan farklı. Bulut yedeğine dahil edebilmek için, diğer dosyalarla
  // aynı "dosyalar" paketi içine bu sabit anahtar altında ekleniyor; index.html
  // içindeki yerel Yedekleme modülüyle birebir aynı anahtar kullanılıyor.
  var ARKAPLAN_YEDEK_ID = '__ozel_arkaplan_gorseli__';

  function blobBase64eCevir(blob) {
    return new Promise(function (resolve, reject) {
      var okuyucu = new FileReader();
      okuyucu.onload = function () { resolve(okuyucu.result); }; // "data:<mime>;base64,...."
      okuyucu.onerror = function () { reject(okuyucu.error || new Error('Dosya okunamadı')); };
      okuyucu.readAsDataURL(blob);
    });
  }

  function base64tenBlobaCevir(dataUrl) {
    return fetch(dataUrl).then(function (r) { return r.blob(); });
  }

  function tumDosyalariTopla() {
    var dosyaSozu = (typeof window.__sessizlikDosyaTumIcerigiAl === 'function')
      ? window.__sessizlikDosyaTumIcerigiAl().catch(function () { return {}; })
      : Promise.resolve({});
    var arkaplanSozu = (typeof window.__sessizlikArkaplanGorselOku === 'function')
      ? window.__sessizlikArkaplanGorselOku().catch(function () { return null; })
      : Promise.resolve(null);

    return Promise.all([dosyaSozu, arkaplanSozu]).then(function (sonuclar) {
      var bloblar = sonuclar[0] || {};
      var arkaplanBlob = sonuclar[1];
      var idler = Object.keys(bloblar);
      var sozler = idler.map(function (id) {
        return blobBase64eCevir(bloblar[id]).then(function (dataUrl) {
          return [id, dataUrl];
        }).catch(function () {
          return null; // tek bir dosya okunamazsa yedeğin tamamını bozmasın
        });
      });
      if (arkaplanBlob) {
        sozler.push(
          blobBase64eCevir(arkaplanBlob).then(function (dataUrl) {
            return [ARKAPLAN_YEDEK_ID, dataUrl];
          }).catch(function () { return null; })
        );
      }
      return Promise.all(sozler).then(function (ciftler) {
        var sonuc = {};
        ciftler.forEach(function (cift) {
          if (cift) sonuc[cift[0]] = cift[1];
        });
        return sonuc;
      });
    }).catch(function () {
      return {};
    });
  }

  function tumVeriyiTopla() {
    var yerel = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(ONEK) === 0) {
        yerel[k] = localStorage.getItem(k);
      }
    }
    return tumDosyalariTopla().then(function (dosyalar) {
      return { __surum: YEDEK_SURUMU, localStorage: yerel, dosyalar: dosyalar };
    });
  }

  function dosyalariYerelUygula(dosyalar) {
    dosyalar = dosyalar || {};
    var arkaplanBase64 = dosyalar[ARKAPLAN_YEDEK_ID];
    var digerDosyalar = {};
    Object.keys(dosyalar).forEach(function (id) {
      if (id !== ARKAPLAN_YEDEK_ID) digerDosyalar[id] = dosyalar[id];
    });

    var kaydetSoz = (typeof window.__sessizlikDosyaKaydet === 'function')
      ? Promise.all(Object.keys(digerDosyalar).map(function (id) {
          return base64tenBlobaCevir(digerDosyalar[id]).then(function (blob) {
            return window.__sessizlikDosyaKaydet(id, blob);
          }).catch(function (e) {
            console.error('Dosya geri yüklenemedi:', id, e);
          });
        }))
      : Promise.resolve();

    // Özel arka plan görseli, genel "dosyalar" deposu yerine kendi ayrı
    // IndexedDB deposuna yazılır. Buluttaki yedekte artık yoksa (başka bir
    // cihazdan kaldırılmışsa), tam geri yükleme davranışı için bu cihazdan
    // da kaldırılır.
    var arkaplanSoz = arkaplanBase64
      ? (typeof window.__sessizlikArkaplanGorselKaydet === 'function'
          ? base64tenBlobaCevir(arkaplanBase64).then(function (blob) {
              return window.__sessizlikArkaplanGorselKaydet(blob);
            }).catch(function (e) {
              console.error('Arka plan görseli geri yüklenemedi:', e);
            })
          : Promise.resolve())
      : (typeof window.__sessizlikArkaplanGorselSil === 'function'
          ? window.__sessizlikArkaplanGorselSil().catch(function () {})
          : Promise.resolve());

    // Buluttaki yedekte artık bulunmayan (başka bir cihazda silinmiş) dosyaları
    // bu cihazdan da temizle — tam geri yükleme davranışı localStorage ile aynı olsun.
    return Promise.all([kaydetSoz, arkaplanSoz]).then(function () {
      if (typeof window.__sessizlikDosyaTumIcerigiAl !== 'function' || typeof window.__sessizlikDosyaSil !== 'function') return;
      return window.__sessizlikDosyaTumIcerigiAl().then(function (mevcutBloblar) {
        var silinecekler = Object.keys(mevcutBloblar).filter(function (id) { return !(id in digerDosyalar); });
        return Promise.all(silinecekler.map(function (id) { return window.__sessizlikDosyaSil(id); }));
      }).catch(function () {});
    });
  }

  function veriyiYerelUygula(veri) {
    // Eski yedekler (bu güncellemeden önce alınmış) düz bir { "sessizlik-...": "..." }
    // nesnesiydi ve dosya içeriği hiç içermiyordu; geriye dönük uyumluluk için
    // __surum alanı yoksa veriyi doğrudan localStorage nesnesi olarak ele al.
    var surumluMu = veri && veri.__surum === YEDEK_SURUMU;
    var yerelVeri = surumluMu ? (veri.localStorage || {}) : (veri || {});
    var dosyaVeri = surumluMu ? (veri.dosyalar || {}) : {};

    // Önce bulutta olmayan yerel "sessizlik-" anahtarlarını temizle
    // (tam geri yükleme = cihazı buluttaki hâle birebir eşitler)
    var mevcutAnahtarlar = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(ONEK) === 0) mevcutAnahtarlar.push(k);
    }
    mevcutAnahtarlar.forEach(function (k) {
      if (!(k in yerelVeri)) localStorage.removeItem(k);
    });
    Object.keys(yerelVeri).forEach(function (k) {
      localStorage.setItem(k, yerelVeri[k]);
    });

    return dosyalariYerelUygula(dosyaVeri);
  }

  function veriBosMu(veri) {
    if (!veri) return true;
    if (veri.__surum === YEDEK_SURUMU) {
      var yerel = veri.localStorage || {};
      var dosyalar = veri.dosyalar || {};
      return Object.keys(yerel).length === 0 && Object.keys(dosyalar).length === 0;
    }
    return Object.keys(veri).length === 0;
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
    return tumVeriyiTopla().then(function (veri) {
      return istemci.from(TABLO).upsert({
        user_id: oturum.user.id,
        veri: veri,
        guncellenme_zamani: new Date().toISOString(),
        cihaz_etiketi: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'bilinmiyor'
      }, { onConflict: 'user_id' });
    }).then(function (r) {
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
        mesajGoster('Görseller de dahil veriler indiriliyor…');
        return Promise.resolve(veriyiYerelUygula(r.data.veri)).then(function () {
          localStorage.setItem(SON_YEDEK_ANAHTARI, r.data.guncellenme_zamani);
          mesajGoster('Veriler geri yüklendi. Uygulama yeniden başlatılıyor…');
          setTimeout(function () { window.location.reload(); }, 900);
          return true;
        });
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
  // durumuna göre en makul aksiyonu otomatik uygular. Kullanıcıya soru
  // sormaz — iki tarafta da veri varsa, buluttaki kayıt bu cihazın en son
  // bildiği kayıttan daha yeniyse (yani başka bir cihazda güncellenmişse)
  // buluttaki veri sessizce bu cihaza uygulanır; değilse (bu cihaz zaten
  // günceli biliyorsa) hiçbir şey yapılmaz, her açılışta gereksiz bir
  // indirme/yeniden başlatma olmaz.
  function girisSonrasiSenkronKontrol() {
    if (!girisliMi()) return;
    tumVeriyiTopla().then(function (yerel) {
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
          var bilinenSonYedek = localStorage.getItem(SON_YEDEK_ANAHTARI);
          var bulutDahaYeniMi = !bilinenSonYedek || new Date(r.data.guncellenme_zamani).getTime() > new Date(bilinenSonYedek).getTime();
          if (bulutDahaYeniMi) {
            // Bulutta bu cihazın bilmediği daha yeni bir değişiklik var
            // (başka bir cihazdan gelmiş olabilir) — sessizce uygula.
            buluttanGeriYukle(true);
          } else {
            senkronDurum = 'senkron';
            panelGuncelle();
          }
        } else {
          senkronDurum = 'senkron';
          panelGuncelle();
        }
      });
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
    window.addEventListener('offline', function () {
      wifiIkonuGoster();
      toastGoster('İnternet bağlantısı kesildi', 'hata');
    });
    window.addEventListener('online', function () {
      wifiIkonuGizle();
      toastGoster('İnternet bağlantısı geri geldi', 'basarili');
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
      '.bulut-panel a{color:var(--accent);}',

      /* ---- Yedekle/Çıkış/Bağlan butonlarının satırı: index.html'de bu
         konteynere (.bulut-satir-aksiyon) hiç düzen (layout) verilmemiş,
         bu yüzden içine eklediğimiz wifi ikonu satır dışına taşıp butonların
         ÜSTÜNDE beliriyordu. Aynı satırda yan yana dizilsinler diye flex
         düzeni burada tamamlanıyor (index.html'in kendisine dokunmadan). ---- */
      '.bulut-satir-aksiyon{display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;}',

      /* ---- İnternet bağlantısı kesildiğinde beliren kırmızı wifi ikonu ---- */
      '.bulut-wifi-durum{display:none;align-items:center;justify-content:center;',
      'width:2.05rem;height:2.05rem;flex-shrink:0;color:var(--yanlis);}',
      '.bulut-wifi-durum.gorunur{display:inline-flex;animation:bulutWifiNabiz 1.8s ease-in-out 0.9s infinite;}',
      '.bulut-wifi-svg{width:1.3rem;height:1.3rem;overflow:visible;}',
      '.bulut-wifi-durum.gorunur .bulut-wifi-svg{animation:bulutWifiZiplama 0.7s ease-out;}',
      '.bulut-wifi-durum.gorunur .b-wifi-arc-l{stroke-dasharray:1;stroke-dashoffset:1;opacity:0;',
      'animation:bulutWifiCiz 0.4s ease-out 0.36s forwards;}',
      '.bulut-wifi-durum.gorunur .b-wifi-arc-m{stroke-dasharray:1;stroke-dashoffset:1;opacity:0;',
      'animation:bulutWifiCiz 0.35s ease-out 0.24s forwards;}',
      '.bulut-wifi-durum.gorunur .b-wifi-arc-s{stroke-dasharray:1;stroke-dashoffset:1;opacity:0;',
      'animation:bulutWifiCiz 0.3s ease-out 0.12s forwards;}',
      '.bulut-wifi-durum.gorunur .b-wifi-slash{stroke-dasharray:1;stroke-dashoffset:1;opacity:0;',
      'animation:bulutWifiCiz 0.5s ease-in-out 0.02s forwards;}',
      '.bulut-wifi-durum.gorunur .b-wifi-dot{transform-box:fill-box;transform-origin:center;opacity:0;',
      'animation:bulutWifiNokta 0.35s ease-out forwards;}',
      '@keyframes bulutWifiZiplama{0%{transform:scale(1);}50%{transform:scale(1.05);}80%{transform:scale(0.99);}100%{transform:scale(1);}}',
      '@keyframes bulutWifiCiz{to{stroke-dashoffset:0;opacity:1;}}',
      '@keyframes bulutWifiNokta{0%{transform:scale(0.4);opacity:0;}60%{transform:scale(1.25);opacity:1;}100%{transform:scale(1);opacity:1;}}',
      '@keyframes bulutWifiNabiz{0%,100%{opacity:1;}50%{opacity:0.5;}}',
      '@media(prefers-reduced-motion:reduce){',
      '.bulut-wifi-durum.gorunur, .bulut-wifi-durum.gorunur .bulut-wifi-svg,',
      '.bulut-wifi-durum.gorunur .b-wifi-arc-l, .bulut-wifi-durum.gorunur .b-wifi-arc-m,',
      '.bulut-wifi-durum.gorunur .b-wifi-arc-s, .bulut-wifi-durum.gorunur .b-wifi-slash,',
      '.bulut-wifi-durum.gorunur .b-wifi-dot{animation:none;opacity:1;stroke-dashoffset:0;}',
      '}',

      /* ---- Bağlantı değişikliği bildirimi (küçük toast) ----
         Giriş: hafif "sekerek" yukarı kayan bir animasyon (bulutToastGir).
         Çıkış: sade bir opacity/transform geçişi (transition) yeterli,
         çünkü animasyon kaldırılınca eleman zaten taban stile döner. */
      '.bulut-toast{position:fixed;left:50%;bottom:calc(1.3rem + env(safe-area-inset-bottom,0px));',
      'transform:translateX(-50%) translateY(14px) scale(0.92);max-width:88vw;padding:0.65rem 1.05rem;',
      'border-radius:0.8rem;font-size:0.85rem;font-family:inherit;line-height:1.3;text-align:center;',
      'background:var(--ink);color:var(--bg);box-shadow:0 10px 26px rgba(var(--shadow-rgb),0.28);',
      'z-index:10070;opacity:0;pointer-events:none;',
      'transition:opacity 0.3s ease, transform 0.3s ease;}',
      '.bulut-toast.gorunur{opacity:1;transform:translateX(-50%) translateY(0) scale(1);',
      'animation:bulutToastGir 0.55s cubic-bezier(.34,1.56,.64,1);}',
      '@keyframes bulutToastGir{',
      '0%{opacity:0;transform:translateX(-50%) translateY(18px) scale(0.85);}',
      '55%{opacity:1;transform:translateX(-50%) translateY(-5px) scale(1.03);}',
      '100%{opacity:1;transform:translateX(-50%) translateY(0) scale(1);}',
      '}',
      '.bulut-toast.hata{background:var(--yanlis);color:#fff;}',
      '.bulut-toast.basarili{background:var(--dogru);color:#fff;}',
      '@media(prefers-reduced-motion:reduce){.bulut-toast.gorunur{animation:none;}}'
    ].join('');
    document.head.appendChild(s);
  }

  function mesajGoster(m) {
    if (!mesajEl) return;
    mesajEl.textContent = m;
    mesajEl.classList.add('gorunur');
  }

  /* ---------------- Bağlantı durumu: kırmızı wifi ikonu + toast bildirimi ----------------
     Bulut Yedekleme satırında, internet bağlantısı kesildiğinde beliren
     animasyonlu bir uyarı ikonu (bağlantı gelince otomatik kaybolur) ve her
     iki yönde de (kesildi/geri geldi) kısa bir uygulama içi bildirim. */
  var wifiIkonEl = null;

  function wifiIkonuOlustur() {
    if (wifiIkonEl) return wifiIkonEl;
    var hedef = document.getElementById('bulutSatirAksiyon');
    if (!hedef) return null;
    var el = document.createElement('div');
    el.className = 'bulut-wifi-durum';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', 'İnternet bağlantısı yok');
    el.title = 'İnternet bağlantısı yok — yedekleme bağlantı gelince devam edecek';
    el.innerHTML =
      '<svg class="bulut-wifi-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path class="b-wifi-dot" d="M12 20h.01"></path>' +
      '<path class="b-wifi-arc-s" pathLength="1" d="M8.5 16.429a5 5 0 0 1 7 0"></path>' +
      '<path class="b-wifi-arc-m" pathLength="1" d="M5 12.859a10 10 0 0 1 5.17-2.69"></path>' +
      '<path class="b-wifi-arc-m" pathLength="1" d="M19 12.859a10 10 0 0 0-2.007-1.523"></path>' +
      '<path class="b-wifi-arc-l" pathLength="1" d="M2 8.82a15 15 0 0 1 4.177-2.643"></path>' +
      '<path class="b-wifi-arc-l" pathLength="1" d="M22 8.82a15 15 0 0 0-11.288-3.764"></path>' +
      '<path class="b-wifi-slash" pathLength="1" d="m2 2 20 20"></path>' +
      '</svg>';
    hedef.appendChild(el);
    wifiIkonEl = el;
    return el;
  }

  function wifiIkonuGoster() {
    var el = wifiIkonuOlustur();
    if (!el) return;
    // Her belirişte "çizim" animasyonu baştan oynasın diye sınıfı kaldırıp
    // (araya bir reflow sokup) yeniden ekliyoruz.
    el.classList.remove('gorunur');
    void el.offsetWidth;
    el.classList.add('gorunur');
  }

  function wifiIkonuGizle() {
    if (wifiIkonEl) wifiIkonEl.classList.remove('gorunur');
  }

  var toastEl = null;
  var toastZamanlayici = null;

  function toastGoster(mesaj, tur) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = mesaj;
    toastEl.className = 'bulut-toast' + (tur ? ' ' + tur : '');
    void toastEl.offsetWidth;
    toastEl.classList.add('gorunur');
    if (toastZamanlayici) window.clearTimeout(toastZamanlayici);
    toastZamanlayici = window.setTimeout(function () {
      toastEl.classList.remove('gorunur');
    }, 3200);
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
  // - Çıkış ikonuna tıklamak => hesaptan çıkış yap (kendi onay pop-up'ımızla)
  // Buluttan geri yükleme artık girişten hemen sonra otomatik/sessizce
  // yapıldığı için ayrı bir "geri yükle" butonuna gerek kalmadı.
  var satirEl = null;

  function satirElemanlariAl() {
    if (satirEl) return true;
    var baslik = document.getElementById('bulutBaslikLabel');
    var durum = document.getElementById('bulutDurumLabel');
    var baglanBtn = document.getElementById('bulutBaglanBtn');
    var iconGrup = document.getElementById('bulutIconGrup');
    var yedekleBtn = document.getElementById('bulutYedekleBtn');
    var cikisBtn = document.getElementById('bulutCikisBtn');
    if (!baslik || !durum || !baglanBtn || !iconGrup || !yedekleBtn || !cikisBtn) return false;

    satirEl = {
      baslik: baslik,
      durum: durum,
      baglanBtn: baglanBtn,
      iconGrup: iconGrup,
      yedekleBtn: yedekleBtn,
      cikisBtn: cikisBtn
    };

    baglanBtn.addEventListener('click', function () {
      // Supabase projesi hiç yapılandırılmamışsa (istisnai/teknik durum)
      // küçük kurulum panelini aç; aksi halde kullanıcı sadece giriş
      // yapması gerektiği için uygulamanın kendi tam ekran giriş
      // sayfasını (ilk açılışta gördüğü ekranı) tekrar göster.
      if (!ayarlariOku()) { panelAc(); return; }
      if (typeof window.sessizlikGirisEkraniniYenidenGoster === 'function') {
        window.sessizlikGirisEkraniniYenidenGoster();
      } else {
        panelAc();
      }
    });

    yedekleBtn.addEventListener('click', function () {
      satirEl.durum.textContent = 'Yedekleniyor…';
      simdiYedekle().then(function (basarili) {
        if (!basarili) { satirEl.durum.textContent = 'Yedekleme başarısız oldu.'; return; }
        satirGuncelle();
      });
    });

    cikisBtn.addEventListener('click', function () { cikisOnayGoster(); });

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

  // Hesaptan çıkış öncesi onay: tarayıcının kendi window.confirm()
  // penceresi yerine, uygulamanın kendi tasarımıyla uyumlu küçük bir
  // pop-up gösterir.
  function cikisOnayGoster() {
    panelAc();
    panelEl.innerHTML =
      '<button class="bulut-kapat" type="button" aria-label="Kapat">✕</button>' +
      '<h3>Hesabından Çıkış Yap</h3>' +
      '<p class="bulut-not">Bu cihazda hesabından çıkış yapılacak. Verilerin buluttaki hesabında güvende kalmaya devam eder.</p>' +
      '<button class="bulut-btn tehlike" id="bulutCikisOnaylaBtn">Evet, Çıkış Yap</button>' +
      '<button class="bulut-btn" id="bulutCikisVazgecBtn">Vazgeç</button>';
    panelEl.querySelector('.bulut-kapat').addEventListener('click', panelKapat);
    panelEl.querySelector('#bulutCikisVazgecBtn').addEventListener('click', panelKapat);
    panelEl.querySelector('#bulutCikisOnaylaBtn').addEventListener('click', function () {
      panelKapat();
      istemci.auth.signOut().then(function () {
        satirGuncelle();
        // Küçük bir pop-up açmak yerine kullanıcıyı doğrudan ilk açılışta
        // gördüğü tam ekran giriş sayfasına yönlendir; oradan tekrar
        // giriş yapabilir ya da hesapsız devam edebilir.
        if (typeof window.sessizlikGirisEkraniniYenidenGoster === 'function') {
          window.sessizlikGirisEkraniniYenidenGoster();
        }
      });
    });
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

    // Giriş yapılmış durumda artık işlemler (yedekle / çıkış) Ayarlar
    // sayfasındaki satırdan yapılıyor; bu panel normalde bu aşamada açılmaz
    // (yalnızca çıkış onayı gibi özel durumlarda cikisOnayGoster hemen
    // üzerine yazar), bu yüzden burada sade bir bilgi kartı yeterli.
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
    // Uygulama zaten bağlantısızken açıldıysa, "az önce kesildi" bildirimi
    // göstermeden (bu bir geçiş değil, başlangıç durumu) ikonu sessizce göster.
    if (!navigator.onLine) wifiIkonuGoster();
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
