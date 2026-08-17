// Sessizliğin Sesi - Service Worker
// Sürüm numarasını her yayında (her index.html güncellemesinde) artırın,
// aksi halde kullanıcılar eski önbellekten hizmet almaya devam eder.
const CACHE_ADI = 'sessizlik-cache-v2';

const ONBELLEK_DOSYALARI = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Kurulum: temel dosyaları önbelleğe al
self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_ADI).then(function(cache){
      return cache.addAll(ONBELLEK_DOSYALARI);
    })
  );
  self.skipWaiting();
});

// Etkinleştirme: eski sürüm önbelleklerini temizle
self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(anahtarlar){
      return Promise.all(
        anahtarlar
          .filter(function(ad){ return ad !== CACHE_ADI; })
          .map(function(ad){ return caches.delete(ad); })
      );
    })
  );
  self.clients.claim();
});

// İstekleri karşıla: önce ağ, başarısız olursa önbellek (index.html için),
// diğer dosyalarda önce önbellek, yoksa ağdan al ve önbelleğe ekle.
self.addEventListener('fetch', function(event){
  const istek = event.request;

  if(istek.method !== 'GET'){ return; }

  if(istek.mode === 'navigate'){
    event.respondWith(
      fetch(istek).catch(function(){
        return caches.match('./index.html');
      })
    );
    return;
  }

  event.respondWith(
    caches.match(istek).then(function(onbellekYaniti){
      if(onbellekYaniti){ return onbellekYaniti; }
      return fetch(istek).then(function(agYaniti){
        if(agYaniti && agYaniti.status === 200 && agYaniti.type === 'basic'){
          const kopya = agYaniti.clone();
          caches.open(CACHE_ADI).then(function(cache){
            cache.put(istek, kopya);
          });
        }
        return agYaniti;
      }).catch(function(){
        // Çevrimdışı ve önbellekte yoksa sessizce başarısız ol
      });
    })
  );
});
