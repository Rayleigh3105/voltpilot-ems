/**
 * Der Direktlink einer Box (Plan D3 aus dem Bericht voltpilot-edge-inbetriebnahme, gebaut mit der
 * Werkstatt-Seite, Entscheid 8 vom 26.10.2026): der QR-Code auf dem Gehäuse trägt
 * `https://portal.voltpilot.de/k/<referenz>`. nginx leitet `/k/<referenz>` auf `/#/k/<referenz>` um
 * (`frontend/portal/nginx.conf`); das Portal merkt sich die Referenz beim Start und bietet sie dort an,
 * wo der Kunde eine Box verbindet:
 *   - ohne Anlage im Einrichtungs-Assistenten (Schritt „Box“),
 *   - mit Anlage im Aufbau der ersten Anlage („VoltPilot-Box hinzufügen“, `?neu=box&ref=`),
 *   - ein VoltPilot-Admin landet in der Werkstatt bei genau dieser Box.
 *
 * Die Referenz liegt bis dahin im `sessionStorage` dieses Tabs: Sie übersteht so die Anmeldung bei
 * Keycloak und das Neuladen nach der Selbstregistrierung (K1), und sie verlässt den Tab nicht.
 * Verbunden wird nie von selbst: Der Kunde sieht die Referenz im Feld und drückt selbst.
 *
 * Reines Modul bis auf den Speicher; jeder Zugriff darauf ist abgesichert.
 */
import { pruefeKennung } from './edgeRef';

/** Die Adresse des Portals, die auf dem Gehäuse steht. */
export const PORTAL_ADRESSE = 'https://portal.voltpilot.de';

const SPEICHER = 'vp.koppel.ref';

/** Was der QR-Code auf dem Gehäuse trägt: `https://portal.voltpilot.de/k/edge-…`. */
export function koppelLink(ref: string, adresse: string = PORTAL_ADRESSE): string {
  return `${adresse.replace(/\/+$/, '')}/k/${ref}`;
}

/** Wohin nginx `/k/<ref>` umleitet. */
export function koppelHash(ref: string): string {
  return `#/k/${ref}`;
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
  const p = pruefeKennung(roh);
  return p.zustand === 'gueltig' ? p.kennung : null;
}

function speicher(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function merkeKoppelRef(ref: string): void {
  try {
    speicher()?.setItem(SPEICHER, ref);
  } catch {
    /* privater Modus, voller Speicher: dann gilt der Link nur bis zur Anmeldung */
  }
}

/** Die gemerkte Referenz, noch einmal geprüft (der Speicher ist Eingabe), oder null. */
export function offeneKoppelRef(): string | null {
  let wert: string | null = null;
  try {
    wert = speicher()?.getItem(SPEICHER) ?? null;
  } catch {
    return null;
  }
  return wert ? parseKoppelHash(koppelHash(wert)) : null;
}

export function vergissKoppelRef(): void {
  try {
    speicher()?.removeItem(SPEICHER);
  } catch {
    /* nichts zu tun */
  }
}

/**
 * Beim Start: Nennt die Adresse einen Direktlink, merkt sich das Portal die Referenz und nimmt den
 * Link aus der Adresse (sonst landete er als Lesezeichen oder nach dem Anmelden noch einmal hier).
 * Gibt die Referenz zurück, oder null.
 */
export function koppelLinkAnnehmen(loc: Pick<Location, 'hash' | 'pathname' | 'search'>, ersetzen: (url: string) => void): string | null {
  if (!/^#\/?k\//i.test(loc.hash)) return null;
  const ref = parseKoppelHash(loc.hash);
  if (ref) merkeKoppelRef(ref);
  ersetzen(`${loc.pathname}${loc.search}#/`);
  return ref;
}

export type KoppelZiel =
  /** Der Einrichtungs-Assistent bietet die Referenz im Schritt „Box“ an; die Adresse bleibt. */
  | { art: 'assistent' }
  /** Diese Adresse öffnen (Aufbau mit „Box hinzufügen“ oder die Werkstatt). */
  | { art: 'adresse'; hash: string }
  /** Hier gibt es nichts anzubieten: keine Anlage und kein Recht, eine anzulegen. */
  | { art: 'keins' };

/**
 * Wo die gemerkte Referenz hingehört, sobald feststeht, wer angemeldet ist und welche Anlagen es gibt.
 * `aufbau` baut die Adresse des Aufbaus (`nav.aufbauHash`), `werkstatt` die der Werkstatt. Ob das
 * Konto an dieser Anlage eine Box verbinden darf, entscheidet dort die API; der Aufbau sagt es dann.
 */
export function koppelZiel(
  ref: string,
  lage: {
    admin: boolean;
    siteIds: readonly string[];
    darfAnlegen: boolean;
    aufbau: (siteId: string, ref: string) => string;
    werkstatt: (ref: string) => string;
  },
): KoppelZiel {
  if (lage.admin) return { art: 'adresse', hash: lage.werkstatt(ref) };
  if (lage.siteIds.length > 0) return { art: 'adresse', hash: lage.aufbau(lage.siteIds[0], ref) };
  return lage.darfAnlegen ? { art: 'assistent' } : { art: 'keins' };
}
