/**
 * Der Service Worker der App-Huelle - DURCHREICHE mit Offline-Rueckfall, nichts
 * weiter.
 *
 * DIE REGEL, an der alles haengt: er cacht NIEMALS `index.html`, `/assets/*`
 * oder eine API-Antwort. Die Auslieferungs-Politik der nginx (`no-cache` fuer
 * das Dokument, `immutable` fuer die gehashten Buendel) und die Deploy-
 * Erkennung im Portal (`src/deployWatch.ts`, die ihren Anker mit
 * `cache: 'no-store'` am Browser-Cache VORBEI holt) bleiben die EINE Wahrheit
 * darueber, welche Fassung ein Tab faehrt. Ein Service Worker, der Navigationen
 * aus einem Cache beantwortet, waere eine ZWEITE, hartnaeckigere Schicht genau
 * der Sorte, die das Portal schon zweimal eine "alte Ansicht"-Eskalation
 * gekostet hat - und `deployWatch` koennte sie nicht einmal bemerken.
 *
 * Deshalb ist der `fetch`-Handler bewusst so schmal wie moeglich:
 *  - Er beantwortet AUSSCHLIESSLICH Navigationen (`request.mode === 'navigate'`),
 *    also den Seitenaufruf selbst. Alles andere - Buendel, Bilder, Schriften,
 *    jede API-Anfrage - laeuft an ihm vorbei (kein `respondWith`), geht also
 *    genau den Weg, den es ohne Service Worker auch ginge.
 *  - Eine Navigation wird IMMER ans Netz gereicht. Erst wenn das Netz gar nicht
 *    antwortet, kommt `offline.html` aus dem Vorrat.
 *
 * Der VORRAT umfasst mehr als der Ausliefer-Pfad braucht (Manifest + Icons): das
 * ist das Inventar der Huelle, einmal beim Installieren geholt. Der Handler
 * bleibt trotzdem navigations-only - keine andere Antwort darf je aus einem
 * Cache kommen, den die Deploy-Erkennung nicht regiert.
 *
 * SW_VERSION ist der Schluessel des Vorrats. Der Browser installiert neu, sobald
 * sich die BYTES DIESER DATEI aendern - wer `offline.html` oder ein Icon
 * aendert, muss sie deshalb hochzaehlen, sonst behaelt ein Geraet die alte
 * Fassung.
 */
const SW_VERSION = 'v1';
const CACHE = `vp-shell-${SW_VERSION}`;
const OFFLINE_URL = '/offline.html';

/** Das Inventar der Huelle. Serviert wird davon nur OFFLINE_URL (siehe oben). */
const PRECACHE = [
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `cache: 'reload'` holt am HTTP-Cache vorbei: der Vorrat soll den Stand
      // haben, den der Server JETZT ausliefert, nicht den einer alten Schicht.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
      // Kein Warten auf das Schliessen aller Tabs - die Huelle ist eine Datei,
      // es gibt nichts, was zwischen zwei Fassungen inkonsistent werden koennte.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // NUR Seitenaufrufe. Ohne diese Grenze waere der Service Worker eine zweite
  // Cache-Schicht ueber Buendeln und API-Antworten - siehe den Kopf der Datei.
  if (request.mode !== 'navigate') return;
  event.respondWith(
    (async () => {
      try {
        return await fetch(request);
      } catch (err) {
        const cached = await caches.match(OFFLINE_URL);
        // Ohne Vorrat (Cache geleert) bleibt die Netzwerk-Fehlerseite des
        // Browsers - ehrlicher als eine leere Antwort.
        return cached || Response.error();
      }
    })(),
  );
});
