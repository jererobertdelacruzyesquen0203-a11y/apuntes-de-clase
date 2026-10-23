/* Service worker: la app abre sin internet.
   Los archivos propios se piden primero a la red (para recibir mejoras) y, si no hay
   conexión, se usa la copia guardada. La librería de PDF se guarda una vez y ya.
   Sube VERSION cuando cambies iconos o el manifest. */
const VERSION = "apuntes-v1";
const FILES = ["./", "index.html", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
const PDF_LIB = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(FILES);
    try { await c.add(new Request(PDF_LIB, { mode: "cors" })); } catch {}
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.url === PDF_LIB) {
    e.respondWith(caches.match(PDF_LIB).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copia = res.clone(); caches.open(VERSION).then(c => c.put(PDF_LIB, copia)); }
      return res;
    })));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copia = res.clone(); caches.open(VERSION).then(c => c.put(req.mode === "navigate" ? "index.html" : req, copia)); }
        return res;
      })
      .catch(() => caches.match(req.mode === "navigate" ? "index.html" : req, { ignoreSearch: true }))
  );
});
