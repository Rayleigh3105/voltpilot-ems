// Ein Band der Wiedergabe-Messung (`wiedergabe.mjs aufnehmen`): die aufgezeichneten API-Antworten samt Token, und
// wie eine Messung sie zu einer Adresse findet. Gemeinsam für wiedergabe.mjs, wechsel.mjs, start-kette.mjs und
// js-je-route.mjs, damit alle vier dieselbe Antwort geben.
//
// Zeit (`zeit`):
//   ruhig     - die Antworten wie aufgenommen. Alles bleibt beim Aufnahmezeitpunkt stehen: Live-Werte sind veraltet,
//               und ein Takt bekommt immer dieselbe Antwort.
//   frisch    - alle Zeitpunkte in Adressen und Antworten um den Abstand Aufnahme → Messbeginn verschoben, Tage um
//               ganze Kalendertage (Europe/Berlin). Die Seite sieht frische Daten, aber jeder Takt bekommt dieselbe Antwort.
//   lebendig  - wie frisch, nur verschieben die Live-Pfade (`LIVE`) auf den Augenblick JEDER Anfrage: ihr Zeitpunkt
//               wandert wie an einer laufenden Anlage, jede Takt-Antwort ist eine neue (die Werte bleiben gleich).
//               Das ist der Fall der Produktion, in dem Übersicht und Topologie je Takt wirklich anders sind.
import { readFileSync } from 'node:fs';

export const LIVE = /\/api\/v1\/(overview|sites\/[^/]+\/(topology|control-status|curtailment-status|erzeuger\/jetzt|chargers|rollen\/[a-z]+))$/;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g;
const TAG = /\b(\d{4}-\d{2}-\d{2})\b(?!T)/g;
// Rückfall: Zeitpunkte in der Adresse wechseln je Lauf (from=…, at=…) - dann gilt die Antwort mit gleicher Form.
export const form = (k) => decodeURIComponent(k)
  .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d\d:\d\d)?/g, '{t}')
  .replace(TAG, '{d}')
  .replace(/\b1[78]\d{11}\b/g, '{ms}');
const berlinTag = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const tagPlus = (tag, d) => { const t = new Date(`${tag}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

function aufnahmeZeit(band) {
  if (band.aufgenommen) return Date.parse(band.aufgenommen);
  // Ältere Bänder (13.11.2026) tragen keinen Zeitpunkt: der jüngste Live-Stand der Übersicht.
  const ov = Object.entries(band.api).find(([k]) => k === 'GET /api/v1/overview')?.[1];
  const ts = ov ? [...ov.body.matchAll(ISO)].map((m) => Date.parse(m[0])) : [];
  return ts.length ? Math.max(...ts) : Date.now();
}

export function bandLaden(datei, zeit = 'ruhig') {
  const band = JSON.parse(readFileSync(datei, 'utf8'));
  const nachText = new Map(Object.entries(band.api).map(([k, v]) => [decodeURIComponent(k), v]));
  const nachForm = new Map(Object.entries(band.api).map(([k, v]) => [form(k), v]));
  const t0 = aufnahmeZeit(band);
  const beginn = Date.now();
  const tageFuer = (delta) => Math.round((Date.parse(berlinTag(t0 + delta)) - Date.parse(berlinTag(t0))) / 86_400_000);
  /** Die Antwort auf `GET <url>` als `{ status, typ, body }`, oder `null`, wenn das Band sie nicht kennt. */
  function antwort(url, method = 'GET') {
    const u = new URL(url);
    const k = `${method} ${u.pathname}${u.search}`;
    if (zeit === 'ruhig') return band.api[k] ?? nachForm.get(form(k)) ?? null;
    const delta = (zeit === 'lebendig' && LIVE.test(u.pathname) ? Date.now() : beginn) - t0;
    const tage = tageFuer(delta);
    const zurueck = decodeURIComponent(k)
      .replace(ISO, (s) => new Date(Date.parse(s) - delta).toISOString())
      .replace(TAG, (s) => tagPlus(s, -tage));
    const e = nachText.get(zurueck) ?? band.api[k] ?? nachForm.get(form(k));
    if (!e) return null;
    const body = e.body
      .replace(ISO, (s) => new Date(Date.parse(s) + delta).toISOString())
      .replace(TAG, (s) => tagPlus(s, tage));
    return { ...e, body };
  }
  return { band, token: band.token, t0, antwort };
}
