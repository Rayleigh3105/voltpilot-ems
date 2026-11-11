/**
 * Der Direktlink einer Box (Plan D3 aus dem Bericht voltpilot-edge-inbetriebnahme, gebaut mit der
 * Werkstatt-Seite, Entscheid 8 vom 26.10.2026): der QR-Code auf dem Gehäuse trägt
 * `https://portal.voltpilot.de/k/<referenz>`. nginx leitet `/k/<referenz>` auf `/#/k/<referenz>` um
 * (`frontend/portal/nginx.conf`); das Portal merkt sich die Referenz beim Start und führt den Kunden
 * (Konzept vp-qr-einstieg, entschieden 04.11.2026: QE-1 A, QE-2 A, QE-3 B, QE-4 A, QE-5 A):
 *   - ohne Sitzung auf die Empfangsseite „Ihre VoltPilot-Box ist da“ (`KoppelEmpfang`), bei falschem
 *     Prüfzeichen auf „Dieser Code ist nicht vollständig lesbar“; beides ohne Serverabfrage,
 *   - ohne Anlage in den Einrichtungs-Assistenten (Schritt „Box“),
 *   - mit einer Anlage in den Aufbau („VoltPilot-Box hinzufügen“, `?neu=box&ref=`), mit mehreren erst
 *     auf die Wahl der Anlage,
 *   - auf eigene Seiten, wenn die Box schon zum Konto gehört oder das Recht zum Verbinden fehlt,
 *   - ein VoltPilot-Admin landet in der Werkstatt bei genau dieser Box.
 *
 * Die Referenz liegt im `sessionStorage` dieses Tabs und zusätzlich 24 Stunden im `localStorage`
 * dieses Browsers (QE-3 B, nur die Referenz mit ihrer Frist): Sie übersteht die Anmeldung bei
 * Keycloak, das Neuladen nach der Selbstregistrierung (K1), einen geschlossenen Tab und „später
 * verbinden“. Gelöscht wird sie nach dem Verbinden, beim Abbruch und beim Abmelden. Die Anmeldeseite
 * (Keycloak-Theme `js/box-band.js`, gleiche Herkunft) liest dieselben zwei Schlüssel.
 * Verbunden wird nie von selbst: Der Kunde sieht die Referenz im Feld und drückt selbst.
 *
 * Reines Modul bis auf den Speicher; jeder Zugriff darauf ist abgesichert.
 */
import { pruefeKennung } from './edgeRef';

/** Die Adresse des Portals, die auf dem Gehäuse steht. */
export const PORTAL_ADRESSE = 'https://portal.voltpilot.de';

/** Der Tab-Speicher (`sessionStorage`). ⚠ `deploy/keycloak/…/js/box-band.js` liest ihn mit. */
export const KOPPEL_SPEICHER = 'vp.koppel.ref';
/** Der Vormerker im Browser (`localStorage`): `{ "ref": "edge-…", "bis": <ms> }`. Auch `box-band.js`. */
export const KOPPEL_VORMERKER = 'vp.koppel.vormerk';
/** Wie lange der Browser die Referenz vormerkt (QE-3 B: „bis morgen“). */
export const VORMERK_DAUER_MS = 24 * 60 * 60 * 1000;

/** Was der QR-Code auf dem Gehäuse trägt: `https://portal.voltpilot.de/k/edge-…`. */
export function koppelLink(ref: string, adresse: string = PORTAL_ADRESSE): string {
  return `${adresse.replace(/\/+$/, '')}/k/${ref}`;
}

/** Wohin nginx `/k/<ref>` umleitet. */
export function koppelHash(ref: string): string {
  return `#/k/${ref}`;
}

/**
 * Die Referenz, wie sie auf dem Gehäuse steht: Die Strichschrift kennt nur Großbuchstaben
 * (`werkstatt.ts → beschriftung`). Das Portal zeigt sie überall so, wo der Kunde sie mit dem
 * Aufdruck vergleicht; gesendet wird immer die kanonische Form.
 */
export function kennungWieGedruckt(ref: string): string {
  return ref.toUpperCase();
}

/**
 * Die Referenz aus `#/k/<ref>` in ihrer kanonischen Form - nur eine gültige (`edge-` mit passendem
 * Prüfzeichen). Alles andere ist null: Ein verstümmelter Code soll nichts vorausfüllen.
 */
export function parseKoppelHash(hash: string): string | null {
  const m = /^#\/?k\/([^/?#]+)\/?(?:\?.*)?$/i.exec(hash);
  if (!m) return null;
  let roh: string;
  try {
    roh = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return gueltigeRef(roh);
}

function gueltigeRef(roh: string): string | null {
  const p = pruefeKennung(roh);
  return p.zustand === 'gueltig' ? p.kennung : null;
}

function tabSpeicher(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function browserSpeicher(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Merkt die Referenz im Tab und 24 Stunden im Browser. Nur eine gültige Referenz wird gemerkt. */
export function merkeKoppelRef(ref: string, jetzt: number = Date.now()): void {
  try {
    tabSpeicher()?.setItem(KOPPEL_SPEICHER, ref);
  } catch {
    /* privater Modus, voller Speicher: dann gilt der Link nur bis zur Anmeldung */
  }
  try {
    browserSpeicher()?.setItem(KOPPEL_VORMERKER, JSON.stringify({ ref, bis: jetzt + VORMERK_DAUER_MS }));
  } catch {
    /* dito */
  }
}

/** Liest den Vormerker; ein abgelaufener oder kaputter wird dabei entfernt. */
function vorgemerkt(jetzt: number): string | null {
  let roh: string | null = null;
  try {
    roh = browserSpeicher()?.getItem(KOPPEL_VORMERKER) ?? null;
  } catch {
    return null;
  }
  if (!roh) return null;
  let ref: string | null = null;
  try {
    const v = JSON.parse(roh) as { ref?: unknown; bis?: unknown };
    if (typeof v.ref === 'string' && typeof v.bis === 'number' && v.bis > jetzt) ref = gueltigeRef(v.ref);
  } catch {
    ref = null;
  }
  if (!ref) {
    try {
      browserSpeicher()?.removeItem(KOPPEL_VORMERKER);
    } catch {
      /* nichts zu tun */
    }
  }
  return ref;
}

/**
 * Die gemerkte Referenz, noch einmal geprüft (der Speicher ist Eingabe), oder null. Der Tab geht vor,
 * sonst gilt der Vormerker des Browsers bis zu seiner Frist.
 */
export function offeneKoppelRef(jetzt: number = Date.now()): string | null {
  let wert: string | null = null;
  try {
    wert = tabSpeicher()?.getItem(KOPPEL_SPEICHER) ?? null;
  } catch {
    wert = null;
  }
  const imTab = wert ? gueltigeRef(wert) : null;
  return imTab ?? vorgemerkt(jetzt);
}

/** Nach dem Verbinden, beim Abbruch und beim Abmelden: Tab und Browser vergessen die Referenz. */
export function vergissKoppelRef(): void {
  for (const [speicher, schluessel] of [
    [tabSpeicher(), KOPPEL_SPEICHER],
    [browserSpeicher(), KOPPEL_VORMERKER],
  ] as const) {
    try {
      speicher?.removeItem(schluessel);
    } catch {
      /* nichts zu tun */
    }
  }
}

/** Was beim Start in der Adresse stand. */
export type KoppelAnnahme =
  /** Ein Direktlink mit gültiger Referenz - sie ist jetzt gemerkt. */
  | { art: 'gueltig'; ref: string }
  /** Ein Direktlink, dessen Referenz nicht stimmt (Prüfzeichen, Zeichen, Länge) - nichts gemerkt. */
  | { art: 'unlesbar' };

/**
 * Beim Start: Nennt die Adresse einen Direktlink, merkt sich das Portal die Referenz und nimmt den
 * Link aus der Adresse (sonst landete er als Lesezeichen oder nach dem Anmelden noch einmal hier).
 * Gibt zurück, was im Link stand, oder null, wenn die Adresse keinen Direktlink nennt.
 */
export function koppelLinkAnnehmen(
  loc: Pick<Location, 'hash' | 'pathname' | 'search'>,
  ersetzen: (url: string) => void,
  jetzt: number = Date.now(),
): KoppelAnnahme | null {
  if (!/^#\/?k\//i.test(loc.hash)) return null;
  const ref = parseKoppelHash(loc.hash);
  if (ref) merkeKoppelRef(ref, jetzt);
  ersetzen(`${loc.pathname}${loc.search}#/`);
  return ref ? { art: 'gueltig', ref } : { art: 'unlesbar' };
}

/**
 * Was die Empfangsseite ohne Sitzung zeigt: der Link dieses Starts, sonst eine vorgemerkte Referenz
 * (Neuladen, Rückweg von der Anmeldeseite, ein neuer Tab innerhalb der 24 Stunden). null = keine.
 */
export function koppelEmpfang(annahme: KoppelAnnahme | null, jetzt: number = Date.now()): KoppelAnnahme | null {
  if (annahme) return annahme;
  const ref = offeneKoppelRef(jetzt);
  return ref ? { art: 'gueltig', ref } : null;
}
