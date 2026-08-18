// Sessizliğin Sesi - Service Worker
// Basit "app shell" önbellekleme: uygulama çevrimdışıyken de açılabilsin diye
// temel dosyaları önbelleğe alır. Sürüm numarasını her güncellemede artırın
// (CACHE_NAME değişmezse tarayıcı eski dosyaları göstermeye devam edebilir).

const CACHE_NAME = 'sessizlik-cache-v2';

// Service worker'ın bulunduğu klasöre göre göreli yollar (GitHub Pages proje
// sayfalarında da doğru çalışması için mutlak yol kullanılmıyor).
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Kurulum: app shell dosyalarını önbelleğe al
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(APP_SHELL);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// Aktivasyon: eski sürüm önbelleklerini temizle
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys
          .filter(function(key) { return key !== CACHE_NAME; })
          .map(function(key) { return caches.delete(key); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Fetch stratejisi:
// - Sayfa gezinmeleri (navigation): önce ağ, olmazsa önbellekten index.html
// - Diğer istekler (css/js/img vb. bu proje tek dosya olduğundan çoğunlukla
//   aynı index.html içindeki gömülü kaynaklar): önce önbellek, olmazsa ağ
self.addEventListener('fetch', function(event) {
  const req = event.request;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(function() {
        return caches.match('./index.html');
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function(cached) {
      if (cached) return cached;
      return fetch(req).then(function(res) {
        // Başarılı GET isteklerini de önbelleğe ekle (opsiyonel, sessizce başarısız olabilir)
        if (req.method === 'GET' && res && res.status === 200) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(req, resClone);
          });
        }
        return res;
      }).catch(function() {
        // Ağ da önbellek de yoksa: navigation dışı isteklerde sessizce başarısız ol
      });
    })
  );
});
