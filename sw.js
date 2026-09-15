/*
 * Service worker de "Gestión de Cartera".
 *
 * IMPORTANTE PARA QUE LAS ACTUALIZACIONES SE REFLEJEN:
 * Cada vez que publiques cambios en index.html, app.js o styles.css,
 * sube en 1 el número de CACHE_VERSION de la línea de abajo y vuelve a
 * publicar este archivo (sw.js) junto con los demás.
 *
 * ¿Por qué? El navegador solo revisa si hay una versión nueva del
 * service worker comparando el contenido de este archivo byte a byte.
 * Si no cambia ni una letra de sw.js, el navegador asume que nada
 * cambió y seguirá usando la versión guardada en caché, aunque tú sí
 * hayas actualizado app.js o styles.css.
 */
const CACHE_VERSION = 'v9';
const CACHE_NAME = `cartera-cache-${CACHE_VERSION}`;

// Archivos propios de la app (mismo origen) que se guardan como respaldo
// offline. Las librerías externas (Supabase, jsPDF, html2canvas, XLSX)
// no se cachean aquí: siempre se piden a su CDN, que ya las versiona en la URL.
const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './img/favicon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      // No esperar a que el usuario cierre todas las pestañas:
      // deja lista la nueva versión para activarse ya mismo.
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      // Tomar control de las pestañas abiertas sin necesidad de recargar dos veces.
      .then(() => self.clients.claim())
  );
});

// Estrategia "network first" para los archivos propios de la app:
// si hay internet, SIEMPRE se pide la última versión al servidor y se
// refresca la caché con esa respuesta. La caché solo se usa como
// respaldo cuando el usuario está sin conexión.
self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return; // deja pasar peticiones a Supabase, CDNs, etc. sin tocarlas
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request))
  );
});

// Permite que la página (index.html) le pida a una versión nueva ya
// instalada que se active de inmediato, sin esperar a que el usuario
// cierre la pestaña. Lo usa el botón "Actualizar ahora" del aviso.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
