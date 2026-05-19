// ── VERSIÓN DEL CACHE ──────────────────────────────────────────────────────
// ⚠️  IMPORTANTE: Cambiar este valor con cada deploy para forzar actualización
//    en todos los dispositivos. Usar formato YYYY-MM-DD-vN.
const CACHE  = 'kame-inv-2026-05-19-v3';
const ASSETS = ['/', '/index.html', '/app.js', '/style.css', '/articulos.js', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Eliminar caches viejos automáticamente
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListene