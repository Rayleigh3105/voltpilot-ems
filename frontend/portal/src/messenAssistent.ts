import type { Funktionen, FunktionStandort, StandortAmStichtag } from './api';
import { fortschritt } from './anlegenFlow';
import { FUNKTIONEN } from './uemsFunktion';

/**
 * Der Assistent „Messen & Auswerten" je Standort — der RAHMEN (UEMS AP-01
 * IP-9a, Konzept §5.2): die Schrittleiste Standort · Datenquelle · Messstellen ·
 * Prüfen · Fertig, „Schritt n von 5", ein Entwurf, der einen Abbruch überlebt,
 * und der Wiedereinstieg auf dem richtigen Schritt. Rein — die Fläche
 * `components/MessenAssistent.tsx` rendert nur.
 *
 * ⚠ Die Schritte 3 bis 5 baut IP-9b. Der Rahmen kennt sie (die Leiste zeigt
 * alle fünf, der Zähler zählt bis 5), betritt aber nur die GEBAUTEN Schritte:
 * {@link vor} führt nie in einen Schritt, den keine Fläche trägt. Wer einen
 * Schritt einhängt, ergänzt ihn in {@link GEBAUTE_SCHRITTE} und rendert ihn in
 * der Fläche — sonst ändert sich nichts.
 *
 * ⚠ Wo der Assistent steht, entscheidet zuerst der SERVER: kennt `GET
 * /funktionen` „Messen & Auswerten" am Standort (Zustand ≠ kein_objekt), ist
 * Schritt 1 erledigt, egal was im Browser liegt. Der Entwurf im Browser merkt
 * sich nur, WELCHER Standort gewählt war und wie weit der Kunde danach war.
 */

export const MESSEN_SCHRITTE = ['Standort', 'Datenquelle', 'Messstellen', 'Prüfen', 'Fertig'] as const;

export type MessenSchritt = 1 | 2 | 3 | 4 | 5;

export const MESSEN_TITEL = `${FUNKTIONEN.messen} einrichten`;

/**
 * Der Titel am Telefon: dort teilt er die Kopfzeile mit Zurück-Pfeil und Kreuz,
 * und „Messen & Auswerten einrichten" wurde bei 375 px zu „Messen & Auswerten
 * ein…" gekürzt. Die Funktion allein passt; dass eingerichtet wird, sagen Zähler
 * und Frage darunter (Variante B; Variante A — Titel umbrechen — hätte die
 * gemeinsame Kopf-CSS des Anlege-Dialogs geändert, nur als Foto gezeigt).
 */
export const MESSEN_TITEL_KURZ = FUNKTIONEN.messen;

/** Die Schritte, die eine Fläche heute trägt — IP-9a: Standort und Datenquelle. */
export const GEBAUTE_SCHRITTE: readonly MessenSchritt[] = [1, 2];

// ─────────────────────────────────────────────────────────────── Schrittfolge

/** „Schritt 2 von 5" — derselbe Zähler wie im Anlege-Dialog (`anlegenFlow.fortschritt`). */
export function schrittZaehler(schritt: MessenSchritt): string {
  return fortschritt([...MESSEN_SCHRITTE], schritt);
}

/** Der nächste Schritt — `null`, wenn es keinen gibt oder ihn noch keine Fläche trägt. */
export function vor(schritt: MessenSchritt, gebaut: readonly MessenSchritt[] = GEBAUTE_SCHRITTE): MessenSchritt | null {
  const n = schritt + 1;
  return n <= MESSEN_SCHRITTE.length && gebaut.includes(n as MessenSchritt) ? (n as MessenSchritt) : null;
}

/** Der vorige Schritt — `null` auf Schritt 1. */
export function zurueck(schritt: MessenSchritt): MessenSchritt | null {
  return schritt > 1 ? ((schritt - 1) as MessenSchritt) : null;
}

/** Der weiteste Schritt, der von Schritt 1 aus ohne Lücke erreichbar ist. */
export function weitesterSchritt(gebaut: readonly MessenSchritt[] = GEBAUTE_SCHRITTE): MessenSchritt {
  let s: MessenSchritt = 1;
  for (let n = vor(s, gebaut); n !== null; n = vor(s, gebaut)) s = n;
  return s;
}

// ────────────────────────────────────────────────────────── Entwurf im Browser

export const ENTWURF_SCHLUESSEL = 'vp.uems.messen-assistent.entwurf.v1';

/** Was ein Abbruch bewahrt: der gewählte Standort und der Schritt, auf dem der Kunde stand. */
export interface MessenEntwurf {
  standortId: string | null;
  schritt: MessenSchritt;
}

export type EntwurfSpeicher = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Der Speicher des Browsers — `null`, wo es keinen gibt oder er gesperrt ist. */
export function browserSpeicher(): EntwurfSpeicher | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Liest den Entwurf; ein fehlender, fremder oder kaputter Eintrag ist `null`, nie ein Fehler. */
export function entwurfLesen(speicher: EntwurfSpeicher | null): MessenEntwurf | null {
  if (!speicher) return null;
  try {
    const roh = speicher.getItem(ENTWURF_SCHLUESSEL);
    if (!roh) return null;
    const e = JSON.parse(roh) as { standortId?: unknown; schritt?: unknown } | null;
    if (!e || typeof e.schritt !== 'number' || !Number.isInteger(e.schritt)) return null;
    if (e.schritt < 1 || e.schritt > MESSEN_SCHRITTE.length) return null;
    if (e.standortId !== null && typeof e.standortId !== 'string') return null;
    return { standortId: e.standortId, schritt: e.schritt as MessenSchritt };
  } catch {
    return null;
  }
}

/** Schreibt den Entwurf. Ohne Speicher bleibt, was der Server weiß — nie ein Fehler. */
export function entwurfSchreiben(speicher: EntwurfSpeicher | null, entwurf: MessenEntwurf): void {
  try {
    speicher?.setItem(ENTWURF_SCHLUESSEL, JSON.stringify(entwurf));
  } catch {
    // Gesperrter Speicher: der Wiedereinstieg fällt auf den Stand des Servers zurück.
  }
}

export function entwurfVerwerfen(speicher: EntwurfSpeicher | null): void {
  try {
    speicher?.removeItem(ENTWURF_SCHLUESSEL);
  } catch {
    // wie oben
  }
}

// ──────────────────────────────────────────────────────── Start und Wiedereinstieg

/** Wo der Assistent beginnt: der vorgewählte Standort und der Schritt. */
export interface MessenStart {
  standortId: string | null;
  schritt: MessenSchritt;
}

/** Der Schritt nach dem Einrichten: gemerkt, wenn der Entwurf zu diesem Standort gehört, sonst 2. */
function schrittNachEinrichten(
  standortId: string,
  entwurf: MessenEntwurf | null,
  gebaut: readonly MessenSchritt[],
): MessenSchritt {
  const gemerkt = entwurf?.standortId === standortId ? entwurf.schritt : 2;
  return Math.min(Math.max(gemerkt, 2), weitesterSchritt(gebaut)) as MessenSchritt;
}

/**
 * Wo der Assistent beginnt. `standortId` ist der Standort, aus dessen Zeile er
 * geöffnet wurde (ohne: der des Entwurfs).
 *
 * - kein Standort, oder einer, den `GET /funktionen` nicht (mehr) nennt → Schritt 1, ohne Vorwahl
 * - die Funktionen sind nicht abrufbar → Schritt 1 mit Vorwahl (Schritt 1 fragt beim Weitergehen den Server)
 * - „Messen & Auswerten" hat am Standort noch kein Objekt → Schritt 1 mit Vorwahl
 * - es gibt die Funktion → der gemerkte Schritt dieses Standorts, mindestens 2, höchstens der weiteste gebaute
 */
export function startSchritt({
  standortId,
  funktionen,
  entwurf,
  gebaut = GEBAUTE_SCHRITTE,
}: {
  standortId?: string | null;
  funktionen: Funktionen | null;
  entwurf: MessenEntwurf | null;
  gebaut?: readonly MessenSchritt[];
}): MessenStart {
  const id = standortId ?? entwurf?.standortId ?? null;
  if (!id) return { standortId: null, schritt: 1 };
  if (!funktionen) return { standortId: id, schritt: 1 };
  const fs = funktionen.standorte.find((s) => s.id === id);
  if (!fs || fs.messen.zustand === 'archiviert') return { standortId: null, schritt: 1 };
  if (fs.messen.zustand === 'kein_objekt') return { standortId: id, schritt: 1 };
  return { standortId: id, schritt: schrittNachEinrichten(id, entwurf, gebaut) };
}

/**
 * Der Einstieg aus der Karte „Funktionen" (Konzept §4.3/§5.5): „Messen &
 * Auswerten für Werk Lindach einrichten" ohne Objekt, „Einrichtung fortsetzen
 * (Schritt 2 von 5)" im Entwurf, sonst keiner. Die Fläche setzt ihn NICHT
 * selbst — das ist die Karte aus IP-8.
 */
export function messenEinstieg(
  fs: FunktionStandort,
  entwurf: MessenEntwurf | null,
  gebaut: readonly MessenSchritt[] = GEBAUTE_SCHRITTE,
): { text: string; start: MessenStart } | null {
  if (fs.messen.zustand === 'kein_objekt') {
    return { text: `${FUNKTIONEN.messen} für ${fs.name} einrichten`, start: { standortId: fs.id, schritt: 1 } };
  }
  if (fs.messen.zustand !== 'entwurf') return null;
  const schritt = schrittNachEinrichten(fs.id, entwurf, gebaut);
  return { text: `Einrichtung fortsetzen (${schrittZaehler(schritt)})`, start: { standortId: fs.id, schritt } };
}

// ────────────────────────────────────────────────────────────── Schritt 1 · Standort

export const SCHRITT1_FRAGE = 'Wo wird gemessen?';
export const SCHRITT1_SATZ =
  'Wählen Sie den Standort oder legen Sie ihn an. Für ihn richten Sie Messen & Auswerten ein.';
export const STANDORT_ANLEGEN = 'Neuen Standort anlegen';
export const STANDORT_KEINER = 'Es gibt noch keinen Standort. Legen Sie ihn zuerst an.';
export const STANDORT_WAEHLEN = 'Bitte wählen Sie einen Standort.';

/**
 * Schritt 1 legt „Messen & Auswerten" nur an, wenn der Server es am Standort
 * nicht kennt. Unbekannt (`null`) heißt: fragen — ein 409 „bereits angelegt"
 * ist dann kein Fehler ({@link istBereitsAngelegt}).
 */
export function mussEinrichten(fs: FunktionStandort | null): boolean {
  return fs == null || fs.messen.zustand === 'kein_objekt';
}

/** Die Ablehnung `bereits_angelegt`: ein anderer Weg war schneller — die Funktion gibt es, es geht weiter. */
export function istBereitsAngelegt(e: unknown): boolean {
  const f = e as { status?: unknown; body?: { code?: unknown } | null } | null;
  return f?.status === 409 && f.body?.code === 'bereits_angelegt';
}

/** Der Satz unter der Wahl: der Zustand von „Messen & Auswerten" an diesem Standort, wie der Server ihn nennt. */
export function standortMessenSatz(fs: FunktionStandort | null): string | null {
  if (!fs) return null;
  const text = fs.messen.text;
  return text.startsWith(FUNKTIONEN.messen) ? text : `${FUNKTIONEN.messen}: ${text}`;
}

/** Ein Standort im Entwurf, dem die Adresse fehlt — der Weg ist „Adresse nachtragen" im Standort-Dialog. */
export function adresseFehlt(st: StandortAmStichtag | null): boolean {
  return st != null && st.zustand === 'entwurf' && st.esFehlt.includes('adresse');
}

// ─────────────────────────────────────────────────────────── Schritt 2 · Datenquelle

export const SCHRITT2_FRAGE = 'Womit wird gemessen?';
export const SCHRITT2_SATZ =
  'Verbinden Sie die VoltPilot-Box der Anlage und binden Sie Zähler oder Controller an. Beides können Sie jederzeit ergänzen.';
export const GERAET_VERBINDEN = 'Gerät verbinden';
export const GERAET_VERBINDEN_SATZ = 'Die VoltPilot-Box mit ihrer Geräte-ID';
export const GERAET_ANBINDEN = 'Gerät anbinden';
export const GERAET_ANBINDEN_SATZ = 'Zähler oder Controller an der Box';
export const SPAETER_FORTSETZEN = 'Später fortsetzen';
export const SPAETER_SATZ = 'Ihre Angaben bleiben erhalten. Sie setzen die Einrichtung dort fort, wo Sie aufgehört haben.';
export const ANDEREN_STANDORT = 'Anderen Standort wählen';

/** Ohne Anlage am Standort gibt es nichts anzubinden. */
export function keineAnlageSatz(standortName: string): string {
  return `An ${standortName} hängt noch keine Anlage.`;
}

/**
 * WO der Kunde die Anlage anlegt — ein benannter Weg ohne Knopf (firstmate 002,
 * Entscheid A): der Anlage-Assistent spricht von Netzladen, Einspeiseleistung und
 * Betriebsmodell und gehört darum nicht in „Messen & Auswerten". Still heißt
 * aber nicht Sackgasse: der Satz nennt den Knopf, den der Kunde heute sieht —
 * mit genau einer Anlage „Anlage hinzufügen" oben in der Kopfzeile
 * (`addAnlage.showAddAnlageButton`), sonst „Anlage anlegen" auf der Übersicht
 * (`PortfolioCockpit`). Der Standort wird dort im Schritt „Anlage" gewählt.
 */
export function keineAnlageWeg(standortName: string, anlagenZahl: number | null): string {
  const wo = anlagenZahl === 1 ? 'oben über „Anlage hinzufügen“' : 'auf der Übersicht über „Anlage anlegen“';
  return `Legen Sie ${wo} eine Anlage an und wählen Sie dort ${standortName} als Standort. Danach setzen Sie die Einrichtung hier fort.`;
}

/** Die Anlagen, die heute am Standort hängen — an ihnen bindet Schritt 2 an. */
export function anlagenAmStandort(st: StandortAmStichtag | null): { id: string; name: string }[] {
  return (st?.anlagen ?? []).map((a) => ({ id: a.id, name: a.name }));
}

/** „3 Komponenten angebunden" — `null`, solange die Zahl nicht bekannt ist (nie „0" statt „unbekannt"). */
export function komponentenSatz(anzahl: number | null): string | null {
  if (anzahl == null) return null;
  if (anzahl === 0) return 'Noch keine Komponente angebunden';
  return anzahl === 1 ? '1 Komponente angebunden' : `${anzahl.toLocaleString('de-DE')} Komponenten angebunden`;
}
