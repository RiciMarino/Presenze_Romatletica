const CACHE='romatletica-presenze-v7';
const LOCAL=['./','./index.html','./style.css?v=7','./config.js?v=2','./app.js?v=17','./logo.png'];
const EXTERNAL=[
  'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'
];

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await cache.addAll(LOCAL);
    await Promise.allSettled(EXTERNAL.map(url=>cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.hostname==='script.google.com'||url.hostname==='script.googleusercontent.com'){
    event.respondWith(fetch(request));
    return;
  }
  if(request.mode==='navigate'){
    event.respondWith(fetch(request,{cache:'no-store'}).catch(()=>caches.match('./index.html')));
    return;
  }
  if(url.origin===self.location.origin&&(url.pathname.endsWith('.js')||url.pathname.endsWith('.css'))){
    event.respondWith((async()=>{
      try{
        const response=await fetch(request,{cache:'no-store'});
        const cache=await caches.open(CACHE);
        cache.put(request,response.clone());
        return response;
      }catch{
        return caches.match(request);
      }
    })());
    return;
  }
  event.respondWith((async()=>{
    const cached=await caches.match(request);
    if(cached)return cached;
    const response=await fetch(request);
    const cache=await caches.open(CACHE);
    cache.put(request,response.clone());
    return response;
  })());
});
