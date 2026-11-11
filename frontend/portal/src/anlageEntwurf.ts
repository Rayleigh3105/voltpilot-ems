import type { AdressWahl } from './components/AdressSuche';
import { currentUser } from './auth';
import type { OrtWahl } from './anlageOrt';
import type { PlantKind, TarifArt } from './api';
import type { AnlegeArt } from './anlegeNurMessen';

/**
 * Der Entwurf des Anlege-Flusses im Browser (Anlage-Flow a1, Paket 3, F9): Neuladen, ein Netzaussetzer
 * oder eine neue Anmeldung ändern nichts an den Eingaben. Vorher lebten die Felder nur im React-Zustand -
 * ein halb ausgefüllter Schritt war nach dem Neuladen leer, und nach einer Anmeldung begann der
 * Assistent von vorn.
 *
 * - Wo: `sessionStorage`, je Kundenbereich und Person - derselbe Tab überlebt Neuladen und die Umleitung zur
 *   Anmeldung, ein anderer Tab oder ein anderes Konto sieht nichts davon.
 * - Was: der Schritt, an dem der Kunde steht, die schon angelegte Anlage und die Felder jedes Schritts.
 * - Wie lange: bis der Fluss endet - Fertig, „Später einrichten“ oder das Schließen des Dialogs räumen ihn
 *   ab; nichts davon überlebt als Geisterzustand. Ein Entwurf, dessen Anlage es nicht mehr gibt, gilt nicht.
 *
 * Gespeichert wird nur, was der Kunde getippt oder gewählt hat - nie eine Antwort des Servers, nie ein Token.
 */

export type EntwurfWirt = 'assistent' | 'dialog';

/** Schritt 1: wo die Anlage steht und wie sie heißt (`AnlageSchritt.tsx`). */
export interface AdressEntwurf {
  name: string;
  nameOffen: boolean;
  suche: string;
  adresse: AdressWahl | null;
  lat: number | null;
  lon: number | null;
  wahl: OrtWahl | null;
  plantKind: PlantKind;
  tarifArt: TarifArt;
  tarifParam: string;
  praemie: string;
  maxFeedIn: string;
  netzladen: boolean;
}

/** Schritt 3: Solar und Speicher (`AnlageBestaetigen.tsx`). */
export interface TeileEntwurf {
  solarAn: boolean;
  speicherAn: boolean;
  kwp: string;
  kwh: string;
  kw: string;
}

export interface AnlageEntwurf {
  v: 1;
  wirt: EntwurfWirt;
  schritt: 1 | 2 | 3;
  /** Die schon angelegte Anlage (ab Schritt 2). */
  siteId: string | null;
  standortId: string | null;
  art: AnlegeArt | null;
  mitBox: boolean;
  /** Postleitzahl und Ort aus Schritt 1 (für den Abgleich mit dem Register). */
  ort: { plz: string | null; ort: string | null } | null;
  adresse: AdressEntwurf | null;
  kennung: string;
  teile: TeileEntwurf | null;
}

const PRAEFIX = 'vp.anlage-entwurf';

/** Der Schlüssel je Kundenbereich und Person. */
export function entwurfSchluessel(person: { tenantId?: string | null; email?: string | null; name?: string | null }): string {
  return `${PRAEFIX}.${person.tenantId ?? ''}.${person.email ?? person.name ?? ''}`;
}

/** Der Schlüssel der angemeldeten Person - ohne Anmeldung (Tests, Übergang) ein leerer. */
export function meinEntwurfSchluessel(): string {
  try {
    return entwurfSchluessel(currentUser());
  } catch {
    return entwurfSchluessel({});
  }
}

/** Nur, was die Form eines Entwurfs hat - ein fremder oder alter Eintrag gilt als keiner. */
export function alsEntwurf(roh: unknown): AnlageEntwurf | null {
  if (!roh || typeof roh !== 'object') return null;
  const e = roh as Partial<AnlageEntwurf>;
  if (e.v !== 1 || (e.wirt !== 'assistent' && e.wirt !== 'dialog')) return null;
  if (e.schritt !== 1 && e.schritt !== 2 && e.schritt !== 3) return null;
  if (e.schritt > 1 && typeof e.siteId !== 'string') return null;
  return e as AnlageEntwurf;
}

/** Ist im Entwurf etwas, das ohne ihn verloren ginge? Ein unberührter erster Schritt ist keiner. */
export function entwurfHatInhalt(e: AnlageEntwurf): boolean {
  if (e.schritt > 1) return true;
  const a = e.adresse;
  return !!a && (a.suche.trim() !== '' || a.adresse != null || (a.nameOffen && a.name.trim() !== ''));
}

function speicher(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function leseEntwurf(schluessel: string): AnlageEntwurf | null {
  try {
    const text = speicher()?.getItem(schluessel);
    return text ? alsEntwurf(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

export function schreibeEntwurf(schluessel: string, e: AnlageEntwurf): void {
  try {
    const s = speicher();
    if (!s) return;
    if (entwurfHatInhalt(e)) s.setItem(schluessel, JSON.stringify(e));
    else s.removeItem(schluessel);
  } catch {
    // Speicher voll oder gesperrt (privates Fenster): der Fluss geht weiter, nur ohne Entwurf.
  }
}

export function loescheEntwurf(schluessel: string): void {
  try {
    speicher()?.removeItem(schluessel);
  } catch {
    // nichts zu räumen
  }
}
