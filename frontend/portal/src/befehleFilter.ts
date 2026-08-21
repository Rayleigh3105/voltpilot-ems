// Die REINE Ableitung der BEFEHLS-SUCHE (Geräteseiten Revision B, Konzept
// `vp-geraeteseite-rev-b8` §6, Captain-Punkt 4): aus dem Filter-Zustand werden
// die Server-Parameter, die deutschen Etiketten, der Treffer-Satz und der
// Freitext-Durchlauf über die ANGEZEIGTEN Sätze.
//
// **⚠ STRUKTUR serverseitig, TEXT clientseitig** (§6 Regel 1). Zeitraum, Strom,
// Herkunft und Ergebnis entscheidet der Server (`CommandFilter`); der FREITEXT
// läuft HIER, über genau die Sätze, Urteile und Roh-Blick-Zeilen, die der Kunde
// vor sich sieht. Eine Server-Suche fände nur Rohfelder und widerspräche damit
// dem, was gelesen wird - genau die zweite Wahrheit, gegen die das Haus baut.
//
// **⚠ Die Wörter sind der Server-Vertrag, die Sätze gehören uns.** Jedes
// Filter-Wort hier steht wörtlich so in `CommandFilter` (api); ein Wort, das
// dort nicht existiert, führt zu einer benannten 400 statt zu einem stillen
// „alles". Deshalb wird hier NIE ein Wort erfunden - und ein Wort aus der URL,
// das diese Datei nicht kennt, wird VERWORFEN statt weitergereicht.
//
// **Drei Ehrlichkeitsregeln tragen die Sätze:**
//  1. Der Zähler nennt BEIDE Zahlen („14 von 212 Zeilen"). Ein Zähler, der nur
//     die gezeigten nennt, verwechselte einen scharfen Filter mit einem leeren
//     Zeitraum.
//  2. Eine leere Liste NENNT ihren Grund - „noch nicht hingesehen" und
//     „hingesehen und nichts gefunden" sind zwei verschiedene Auskünfte.
//  3. Die Suche SAGT, worin sie sucht („in den 212 Zeilen dieses Zeitraums") -
//     sie durchsucht nie mehr, als geladen ist.
import type { CommandHistory } from './api';
import type { BefehlZeile } from './befehle';

// ---------------------------------------------------------------------------
// Der Zustand
// ---------------------------------------------------------------------------

/** Die Zeiträume der Leiste. `eigen` trägt zusätzlich `von`/`bis`. */
export type BefehlZeitraum = 'heute' | 'gestern' | 'woche' | 'monat' | 'eigen';

/** Der ganze Filter-Zustand einer Befehle-Ansicht. */
export interface BefehlFilter {
  zeitraum: BefehlZeitraum;
  /** Nur bei `zeitraum === 'eigen'`: Kalendertage `YYYY-MM-DD`. */
  von: string | null;
  bis: string | null;
  /** Die gewählten Ströme (leer = alle). */
  stroeme: string[];
  /** Die gewählten Herkünfte (leer = alle). */
  herkunft: string[];
  /** Die gewählten Ergebnisse (leer = alle). */
  ergebnis: string[];
  /** Der Freitext - er läuft ausschliesslich clientseitig. */
  q: string;
}

/** Der Ausgangszustand: heute, ohne jede Einschränkung. */
export const LEER: BefehlFilter = {
  zeitraum: 'heute',
  von: null,
  bis: null,
  stroeme: [],
  herkunft: [],
  ergebnis: [],
  q: '',
};

// ---------------------------------------------------------------------------
// Das Vokabular - wörtlich das des Servers (`CommandFilter`)
// ---------------------------------------------------------------------------

/** Die Befehlsarten. Der Schlüssel ist das Server-Wort, der Wert die Anzeige. */
export const STROEME: { wert: string; label: string }[] = [
  { wert: 'batterie', label: 'Speicher' },
  { wert: 'abregelung', label: 'Einspeise-Begrenzung' },
  { wert: 'ladepunkt', label: 'Ladelimit' },
  { wert: 'verbraucher', label: 'Gerät' },
  { wert: 'register', label: 'Register' },
];

/** Die Herkünfte - dieselben drei Wörter wie an jeder Zeile. */
export const HERKUENFTE: { wert: string; label: string }[] = [
  { wert: 'cloud_abgeleitet', label: 'Aus dem Gerätestatus abgeleitet' },
  { wert: 'geraet', label: 'Vom Gerät gemeldet' },
  { wert: 'portal', label: 'Über das Portal ausgelöst' },
];

/**
 * Die Ergebnisse. ⚠ Die ersten sieben beschreiben eine HALTEPERIODE, die letzten
 * drei einen REGISTER-Vorgang - zwei Vokabulare, weil sie zwei Fragen
 * beantworten („hält das Gerät den Befehl" gegen „ist der Schreibvorgang
 * angekommen"). Der Server weiss das und fragt den jeweils anderen Speicher gar
 * nicht erst.
 */
export const ERGEBNISSE: { wert: string; label: string }[] = [
  { wert: 'bestaetigt', label: 'Vom Gerät bestätigt' },
  { wert: 'abweichend', label: 'Das Gerät meldet etwas anderes' },
  { wert: 'keine_antwort', label: 'Keine Antwort vom Gerät' },
  { wert: 'unbestaetigt', label: 'Noch nicht bestätigt' },
  { wert: 'fremdeinfluss', label: 'Fremdeinfluss möglich' },
  { wert: 'notaus', label: 'Not-Aus war aktiv' },
  { wert: 'uebernommen', label: 'Register übernommen' },
  { wert: 'nicht_uebernommen', label: 'Register nicht übernommen' },
  { wert: 'keine_quittung', label: 'Register ohne Quittung' },
];

const STROM_WERTE = new Set(STROEME.map((s) => s.wert));
const HERKUNFT_WERTE = new Set(HERKUENFTE.map((s) => s.wert));
const ERGEBNIS_WERTE = new Set(ERGEBNISSE.map((s) => s.wert));
const ZEITRAEUME = new Set<BefehlZeitraum>(['heute', 'gestern', 'woche', 'monat', 'eigen']);

/** Die Beschriftung eines Zeitraums - sie steht auf dem Bedienelement. */
export const ZEITRAUM_LABEL: Record<BefehlZeitraum, string> = {
  heute: 'Heute',
  gestern: 'Gestern',
  woche: 'Diese Woche',
  monat: 'Dieser Monat',
  eigen: 'Zeitraum wählen',
};

/**
 * Die drei SCHNELL-CHIPS über der Leiste - die drei Fragen der Support-Fälle
 * (§6). Jeder setzt genau EINEN Filter und lässt alles andere stehen.
 */
export const CHIPS: { id: string; label: string; patch: Partial<BefehlFilter> }[] = [
  { id: 'abweichungen', label: 'Nur Abweichungen', patch: { ergebnis: ['abweichend'] } },
  { id: 'register', label: 'Nur Register-Schreibvorgänge', patch: { stroeme: ['register'] } },
  { id: 'portal', label: 'Nur über das Portal', patch: { herkunft: ['portal'] } },
];

// ---------------------------------------------------------------------------
// Zustand <-> URL
// ---------------------------------------------------------------------------

/**
 * Liest den Filter aus den Hash-Parametern (`?strom=…&ergebnis=…&zeitraum=30d…`).
 *
 * Ein unbekanntes Wort wird STILL VERWORFEN statt weitergereicht: die URL kommt
 * aus einem Lesezeichen oder einem Support-Link und darf einen älteren Stand
 * nicht in eine Server-Ablehnung laufen lassen. Verworfen wird nur das eine
 * Wort - der Rest des Links bleibt gültig.
 */
export function ausUrl(hash: string): BefehlFilter {
  const rest = hash.replace(/^#\/?/, '').split('?').slice(1).join('?');
  const p = new URLSearchParams(rest);
  const zeitraum = p.get('zeitraum');
  return {
    zeitraum: zeitraum && ZEITRAEUME.has(zeitraum as BefehlZeitraum)
      ? (zeitraum as BefehlZeitraum)
      : 'heute',
    von: tag(p.get('von')),
    bis: tag(p.get('bis')),
    stroeme: liste(p.get('strom'), STROM_WERTE),
    herkunft: liste(p.get('herkunft'), HERKUNFT_WERTE),
    ergebnis: liste(p.get('ergebnis'), ERGEBNIS_WERTE),
    q: (p.get('q') ?? '').trim(),
  };
}

/**
 * Schreibt den Filter in einen Hash zurück - der EINE Ort, an dem die Adresse
 * entsteht. Ein Support-Link trägt damit den Filter, und ein Lesezeichen öffnet
 * genau dieselbe Ansicht wieder.
 *
 * Vorgabe-Werte werden WEGGELASSEN: eine Adresse ohne Filter soll auch ohne
 * Filter-Parameter aussehen (das `zentraleAnsichtHash`-Muster).
 */
export function inUrl(basis: string, f: BefehlFilter): string {
  const [pfad, ...rest] = basis.split('?');
  const p = new URLSearchParams(rest.join('?'));
  ['zeitraum', 'von', 'bis', 'strom', 'herkunft', 'ergebnis', 'q'].forEach((k) => p.delete(k));
  if (f.zeitraum !== 'heute') p.set('zeitraum', f.zeitraum);
  if (f.zeitraum === 'eigen') {
    if (f.von) p.set('von', f.von);
    if (f.bis) p.set('bis', f.bis);
  }
  if (f.stroeme.length) p.set('strom', f.stroeme.join(','));
  if (f.herkunft.length) p.set('herkunft', f.herkunft.join(','));
  if (f.ergebnis.length) p.set('ergebnis', f.ergebnis.join(','));
  if (f.q.trim()) p.set('q', f.q.trim());
  const query = p.toString();
  return query ? `${pfad}?${query}` : pfad;
}

// ---------------------------------------------------------------------------
// Zustand -> Server-Parameter
// ---------------------------------------------------------------------------

/** Die Parameter, die `api.commandHistory` bekommt. */
export interface BefehlAbfrage {
  range: 'day' | 'week' | 'month';
  at: string | null;
  from: string | null;
  to: string | null;
  streams: string | null;
  sources: string | null;
  verdicts: string | null;
}

/**
 * Übersetzt den Zustand in die Server-Parameter.
 *
 * `heute`/`gestern` sind BEIDE ein Tages-Fenster, nur mit anderem Anker - der
 * Server kennt keinen „gestern"-Zeitraum, und einen zu erfinden hiesse, dieselbe
 * Rechnung zweimal zu führen.
 *
 * @param heute der laufende Berliner Kalendertag (`YYYY-MM-DD`) - nie aus dem
 *              Nichts, damit die Ableitung prüfbar bleibt
 */
export function abfrage(f: BefehlFilter, heute: string): BefehlAbfrage {
  const basis: BefehlAbfrage = {
    range: 'day',
    at: null,
    from: null,
    to: null,
    streams: f.stroeme.length ? f.stroeme.join(',') : null,
    sources: f.herkunft.length ? f.herkunft.join(',') : null,
    verdicts: f.ergebnis.length ? f.ergebnis.join(',') : null,
  };
  switch (f.zeitraum) {
    case 'gestern':
      return { ...basis, at: vortag(heute) };
    case 'woche':
      return { ...basis, range: 'week' };
    case 'monat':
      return { ...basis, range: 'month' };
    case 'eigen':
      // Ohne beide Tage bleibt es beim heutigen Fenster: ein halber eigener
      // Zeitraum wäre eine Server-Ablehnung, und die gehört nicht in einen
      // Zustand, den der Kunde gerade erst halb ausgefüllt hat.
      return f.von && f.bis ? { ...basis, from: f.von, to: f.bis } : basis;
    default:
      return basis;
  }
}

/** Der Vortag eines `YYYY-MM-DD` - reine Kalender-Arithmetik, keine Zone. */
export function vortag(tagIso: string): string {
  const d = new Date(`${tagIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Der FREITEXT - clientseitig, über die ANGEZEIGTEN Sätze
// ---------------------------------------------------------------------------

/**
 * Filtert die fertigen Zeilen über den Freitext. Gesucht wird in genau dem, was
 * der Kunde LIEST: Satz, Urteil, Herkunft, Strom-Etikett und jede
 * Roh-Blick-Zeile (Bezeichnung UND Wert - „0x00E7" steht dort).
 *
 * Verglichen wird klein und ohne Rand-Leerzeichen; mehrere Wörter müssen ALLE
 * vorkommen (die übliche Erwartung an eine Suche), Reihenfolge egal.
 */
export function suche(zeilen: BefehlZeile[], q: string): BefehlZeile[] {
  const teile = q.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (teile.length === 0) return zeilen;
  return zeilen.filter((z) => {
    const heu = [
      z.satz,
      z.urteil ?? '',
      z.herkunft,
      z.strom ?? '',
      z.zeit,
      ...z.roh.map((r) => `${r.label} ${r.wert}`),
    ]
      .join(' ')
      .toLowerCase();
    return teile.every((t) => heu.includes(t));
  });
}

// ---------------------------------------------------------------------------
// Die Sätze
// ---------------------------------------------------------------------------

/** Wie viele Filter gerade greifen - die Zahl auf dem Telefon-Knopf. */
export function aktiv(f: BefehlFilter): number {
  return (
    (f.zeitraum === 'heute' ? 0 : 1)
    + (f.stroeme.length ? 1 : 0)
    + (f.herkunft.length ? 1 : 0)
    + (f.ergebnis.length ? 1 : 0)
    + (f.q.trim() ? 1 : 0)
  );
}

/**
 * Der TREFFER-SATZ: „14 von 212 Zeilen · Filter: Speicher · abweichend".
 *
 * ⚠ Beide Zahlen kommen vom SERVER (`matched`/`total`); die Fläche zählt sie
 * nicht selbst nach - sonst zählte sie eine gekappte Seite statt des Fensters
 * und behauptete „12 von 12", während 3.400 Zeilen dahinter liegen. Nur wo der
 * FREITEXT zusätzlich greift, tritt die gezeigte Zahl davor - und der Satz sagt
 * dann ausdrücklich, WORIN gesucht wurde.
 *
 * Ein älteres Backend meldet keine Zahlen (`total` absent) - dann steht hier
 * nichts, statt eine erfundene Bilanz.
 */
export function trefferSatz(
  history: CommandHistory | null,
  f: BefehlFilter,
  gezeigt: number,
): string | null {
  if (!history || typeof history.total !== 'number' || typeof history.matched !== 'number') {
    return null;
  }
  const teile: string[] = [];
  const suchtext = f.q.trim();
  if (suchtext) {
    teile.push(
      `${zahl(gezeigt)} von ${zahl(history.matched)} durchsuchten ${zeilenWort(history.matched)}`,
    );
  } else if (history.matched === history.total) {
    teile.push(`${zahl(history.total)} ${zeilenWort(history.total)}`);
  } else {
    teile.push(`${zahl(history.matched)} von ${zahl(history.total)} ${zeilenWort(history.total)}`);
  }
  const namen = filterNamen(f);
  if (namen.length > 0) {
    teile.push(`Filter: ${namen.join(' · ')}`);
  }
  return teile.join(' · ');
}

/** Die gesetzten Filter, ausgeschrieben - für den Treffer-Satz und die Chips. */
export function filterNamen(f: BefehlFilter): string[] {
  const out: string[] = [];
  if (f.zeitraum !== 'heute') out.push(ZEITRAUM_LABEL[f.zeitraum]);
  f.stroeme.forEach((v) => out.push(label(STROEME, v)));
  f.herkunft.forEach((v) => out.push(label(HERKUENFTE, v)));
  f.ergebnis.forEach((v) => out.push(label(ERGEBNISSE, v)));
  if (f.q.trim()) out.push(`„${f.q.trim()}"`);
  return out.filter((v) => v !== '');
}

/**
 * Der Satz einer LEEREN Liste - er unterscheidet die zwei Fälle, die man nie
 * verwechseln darf, und nennt bei einem Filter ausdrücklich, dass der Zeitraum
 * selbst nicht leer war („212 Befehle, keine davon abweichend").
 *
 * Der Fall „noch gar nicht aufgezeichnet" gehört weiterhin `befehle.leerSatz`
 * und wird hier nicht wiederholt - er ist eine Aussage über die ANLAGE, nicht
 * über den Filter.
 */
export function leerMitFilter(history: CommandHistory | null, f: BefehlFilter): string | null {
  if (!history || aktiv(f) === 0) return null;
  const total = typeof history.total === 'number' ? history.total : null;
  const namen = filterNamen(f);
  if (total == null || total === 0) {
    return 'In diesem Zeitraum liegt nichts vor.';
  }
  return `${zahl(total)} ${zeilenWort(total)} in diesem Zeitraum - keine davon passt zu `
    + `${namen.join(' · ')}.`;
}

/**
 * Der Satz unter dem Suchfeld: WORIN gesucht wird. Er ist die dritte
 * Ehrlichkeitsregel - die Suche läuft über die geladenen Zeilen, nicht über den
 * ganzen Zeitraum, und das muss sie sagen.
 */
export function sucheHinweis(history: CommandHistory | null, gezeigtGesamt: number): string {
  const gekappt = history?.truncated === true;
  return gekappt
    ? `Die Suche läuft über die ${zahl(gezeigtGesamt)} geladenen ${zeilenWort(gezeigtGesamt)} - `
      + 'ältere sind noch nicht geladen.'
    : `Die Suche läuft über die ${zahl(gezeigtGesamt)} ${zeilenWort(gezeigtGesamt)} dieses `
      + 'Zeitraums.';
}

/** Ob „mehr laden" überhaupt etwas bewirken kann - nie ein Knopf ins Leere. */
export function mehrMoeglich(history: CommandHistory | null): boolean {
  return !!history?.nextBefore;
}

// ---------------------------------------------------------------------------
// Kleinkram
// ---------------------------------------------------------------------------

function liste(raw: string | null, erlaubt: Set<string>): string[] {
  if (!raw) return [];
  const out: string[] = [];
  raw.split(',').forEach((part) => {
    const v = part.trim().toLowerCase();
    if (v && erlaubt.has(v) && !out.includes(v)) out.push(v);
  });
  return out;
}

function tag(raw: string | null): string | null {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? raw.trim() : null;
}

function label(liste: { wert: string; label: string }[], wert: string): string {
  return liste.find((e) => e.wert === wert)?.label ?? '';
}

function zahl(n: number): string {
  return n.toLocaleString('de-DE');
}

function zeilenWort(n: number): string {
  return n === 1 ? 'Zeile' : 'Zeilen';
}

/** Ein Wert an/aus in einer Mehrfach-Auswahl - die eine Umschalt-Regel. */
export function umschalten(werte: string[], wert: string): string[] {
  return werte.includes(wert) ? werte.filter((v) => v !== wert) : [...werte, wert];
}
