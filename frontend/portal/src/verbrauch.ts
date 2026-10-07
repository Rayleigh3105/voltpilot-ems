/**
 * „Auswerten › Verbrauch“ (Konzept Auswerten a1, Richtungsfrage 1 = A, §6.3, Entscheid 10.1): Wo geht die Energie hin?
 * Die Seite liest nur, was es schon gibt — die Rangliste (Menge je Energieeinsatz, Nenner je Anlage, Monatsmengen je
 * Messstelle) und die Messabdeckung (Ort je Messstelle, Rest je Anlage) des gewählten Zeitraums; das Vorjahr ist ein
 * zweiter Abruf desselben Zeitraums ein Jahr früher. Dieses Modul bildet daraus Antwortsatz, Kachel, Balkenreihen und
 * den Monatsverlauf; es rechnet keine Menge selbst, es ordnet, vergleicht und formuliert. Summen, Anteile und das Δ
 * gegen das Vorjahr bilden die Vertrags-Zwillinge (`uemsBewertung.nenner`/`prozent`, `uemsBericht.vergleich`) - der
 * Wächter Q5 (`test/oberflaechenArithmetik.json`) hält das fest; Zahlen dienen hier nur der Anzeige und der Geometrie.
 *
 * ⚠ Fehlend ist keine Null: ein Bereich ohne Werte bleibt ohne Balken und sagt warum; ein Monat ohne Hauptzähler-Wert
 * bleibt eine leere, gestrichelte Säule. Ein Vorjahresvergleich ist roh (Produktion und Wetter sind nicht
 * herausgerechnet) und bekommt darum nie eine Urteilsfarbe; Pfeile erst ab 0,5 % wie die Kacheln der Übersicht.
 * Verglichen wird nur, wenn BEIDE Seiten vollständig sind (Ersatz ist Teil der Menge) - ein Vorjahr, in dem ein Zähler
 * erst später dazukam, ist eine Teilsumme und sagt „Vorjahr unvollständig“ statt „▲ 200 %“.
 */
import type {
  BewertungBilanzwert,
  BewertungMessabdeckung,
  BewertungMessabdeckungOrt,
  BewertungRangliste,
  BewertungRanglisteEinsatz,
  EnergieTraeger,
  Messbedarf,
} from './api';
import { dez, dezVergleich, type Dez } from './dez';
import { UEMS_EINEM_BEREICH_ZUGEORDNET, UEMS_KEINEM_BEREICH_ZUGEORDNET, UEMS_OHNE_EIGENEN_ZAEHLER } from './glossar';
import { vergleich as berichtVergleich } from './uemsBericht';
import { nenner, prozent } from './uemsBewertung';
import { KEINE_WERTE, KWH, MIT_ERSATZWERT, PROZENT, UNVOLLSTAENDIG, VOLLSTAENDIG, zahlMitStellen } from './uemsErgebnis';
import { MEDIEN_WAEHLBAR } from './uemsMessstelle';

// ------------------------------------------------------------------ Wörter

export const VERBRAUCH_TITEL = 'Verbrauch';
export const VERBRAUCH_UNTERZEILE = 'Wofür Ihr Unternehmen Energie einsetzt – nach Bereichen sortiert.';
export const VERBRAUCH_LISTE_TITEL = 'Wofür der Strom gebraucht wurde';
export const VERBRAUCH_VERLAUF_TITEL = 'Strom je Monat';
export const VERBRAUCH_LEER =
  'Noch keine Bereiche festgelegt. Legen Sie fest, wofür Ihr Betrieb Energie einsetzt – dann zeigt VoltPilot hier die Verteilung.';
export const VERBRAUCH_FEHLER = 'Der Verbrauch ließ sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
export const VERLAUF_FEHLER = 'Der Verlauf der zwölf Monate ließ sich gerade nicht laden.';
export const VERBRAUCH_GESPERRT = 'Der Verbrauch je Bereich ist für Ihr Konto nicht freigegeben.';
export const ZAEHLER_PLANEN = 'Zähler planen';
export const ABLESUNG_EINTRAGEN = 'Ablesung eintragen';
export const ZUORDNUNG_PRUEFEN = 'Zuordnung prüfen';
export const TIPP_HINWEIS = 'Monat antippen oder mit dem Finger über die Säulen fahren';
export const WESENTLICH = 'wesentlich';

/** Die Wahl der Zeitleiste: ein Monat oder die zwölf Monate bis zu ihm. */
export type VerbrauchArt = 'monat' | 'zwoelf';
export const VERBRAUCH_ARTEN: readonly { id: VerbrauchArt; label: string }[] = [
  { id: 'monat', label: 'Monat' },
  { id: 'zwoelf', label: '12 Monate' },
];

// ------------------------------------------------------------------ Zahlen und Monate

const NBSP = '\u00a0';
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONATE_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** kWh eines Monats oder Jahres: ohne Nachkommastelle (AP-08 E11), deutscher Tausenderpunkt. */
export const kwhZahl = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 0 });
export const kwhText = (n: number) => `${kwhZahl(n)}${NBSP}kWh`;
/** Ein Anteil (Dezimaltext der Route oder des Zwillings) in der Reihe: eine Nachkommastelle wie die Bewertung. */
export const anteilText = (prozentText: string) => zahlMitStellen(prozentText, 1, PROZENT);
/** Ein Anteil oder Δ im Satz: ganze Prozent (AP-08 E11). */
export const prozentGanz = (prozentText: string) => zahlMitStellen(prozentText, 0, PROZENT);
/** Große Mengen im Satz: „2,5 Millionen kWh“ statt „2.503.200 kWh“ — die genaue Zahl steht in Kachel und Liste. */
export function mengeImSatz(n: number): string {
  if (Math.abs(n) >= 1_000_000) {
    const mio = (n / 1_000_000).toLocaleString('de-DE', { maximumFractionDigits: 1 });
    return `${mio} ${mio === '1' ? 'Million' : 'Millionen'} kWh`;
  }
  return kwhText(n);
}

/** Ein Dezimaltext der Route als Zahl - NUR zur Anzeige (`toLocaleString`) und für Balken- und Säulengeometrie. */
const zahl = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Ein Dezimaltext als Betrag für Vergleich und Reihenfolge; was kein Dezimaltext ist, bleibt `null` (nie geraten). */
function betrag(s: string | null | undefined): Dez | null {
  if (s === null || s === undefined || s === '') return null;
  try {
    return dez(s);
  } catch {
    return null;
  }
}
const NULL = dez('0');
const positiv = (s: string | null | undefined) => {
  const b = betrag(s);
  return b !== null && dezVergleich(b, NULL) > 0;
};
const negativ = (s: string | null | undefined) => {
  const b = betrag(s);
  return b !== null && dezVergleich(b, NULL) < 0;
};
/** Absteigend nach Menge (Vergleich der gelieferten Beträge, keine Rechnung); ohne Menge am Ende. */
function absteigend(a: string | null | undefined, b: string | null | undefined): number {
  const x = betrag(a);
  const y = betrag(b);
  if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
  return dezVergleich(y, x);
}

const monatIndex = (monat: string) => {
  const [j, m] = monat.split('-').map(Number);
  return j * 12 + (m - 1);
};
const ausIndex = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
/** `2026-09` → „September 2026“. */
export const monatWort = (monat: string) => `${MONATE[Number(monat.slice(5, 7)) - 1]} ${monat.slice(0, 4)}`;
const monatKurz = (monat: string) => `${MONATE_KURZ[Number(monat.slice(5, 7)) - 1]} ${monat.slice(0, 4)}`;
const monatsName = (monat: string) => MONATE[Number(monat.slice(5, 7)) - 1];
export const monatPlus = (monat: string, schritt: number) => ausIndex(monatIndex(monat) + schritt);
const monatsende = (monat: string) => {
  const [j, m] = monat.split('-').map(Number);
  return `${monat}-${String(new Date(Date.UTC(j, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/**
 * Der letzte volle Monat in der Zeitzone des Unternehmens. Der laufende Monat hat noch keine Monatsmengen (sie entstehen
 * erst nach seinem Ende) — darum endet die Zeitleiste hier und blättert nicht weiter.
 */
export function letzterVollerMonat(jetzt: Date = new Date(), zone = 'Europe/Berlin'): string {
  const teile = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit' })
    .formatToParts(jetzt)
    .reduce<Record<string, string>>((a, x) => ({ ...a, [x.type]: x.value }), {});
  return monatPlus(`${teile.year}-${teile.month}`, -1);
}

// ------------------------------------------------------------------ Zeitraum

export interface VerbrauchZeitraum {
  art: VerbrauchArt;
  /** Der letzte Monat des Zeitraums (`YYYY-MM`). */
  bis: string;
}

/** Die Grenzen für Rangliste und Messabdeckung: erster und letzter Tag. */
export function grenzen(z: VerbrauchZeitraum): { von: string; bis: string } {
  const erster = z.art === 'monat' ? z.bis : monatPlus(z.bis, -11);
  return { von: `${erster}-01`, bis: monatsende(z.bis) };
}

/** Derselbe Zeitraum ein Jahr früher — der zweite Abruf für das Vorjahr. */
export const vorjahrVon = (z: VerbrauchZeitraum): VerbrauchZeitraum => ({ art: z.art, bis: monatPlus(z.bis, -12) });

/** Die Leiste: „September 2026“ bzw. „Okt 2025 – Sep 2026“. */
export function zeitraumKurz(z: VerbrauchZeitraum): string {
  return z.art === 'monat' ? monatWort(z.bis) : `${monatKurz(monatPlus(z.bis, -11))} – ${monatKurz(z.bis)}`;
}

/** Im Satz: „September 2026“ bzw. „Oktober 2025 bis September 2026“. */
export function zeitraumLang(z: VerbrauchZeitraum): string {
  return z.art === 'monat' ? monatWort(z.bis) : `${monatWort(monatPlus(z.bis, -11))} bis ${monatWort(z.bis)}`;
}

/** Blättern: ein Monat bzw. die zwölf Monate davor/danach — nie über den letzten vollen Monat hinaus. */
export function blaettern(z: VerbrauchZeitraum, schritt: 1 | -1, letzter: string): VerbrauchZeitraum {
  const weite = z.art === 'monat' ? 1 : 12;
  const bis = monatPlus(z.bis, schritt * weite);
  return { art: z.art, bis: monatIndex(bis) > monatIndex(letzter) ? letzter : bis };
}

export const kannVor = (z: VerbrauchZeitraum, letzter: string) => monatIndex(z.bis) < monatIndex(letzter);

/**
 * Die Wahl aus der Adresse (`#/portfolio/verbrauch?zeitraum=12monate&bis=2026-09`). Ohne Angabe: der letzte volle Monat.
 * Ein Monat nach dem letzten vollen gilt nicht — er hätte noch keine Werte.
 */
export function zeitraumAusAdresse(hash: string, letzter: string): VerbrauchZeitraum {
  const q = new URLSearchParams(hash.split('?').slice(1).join('?'));
  const art: VerbrauchArt = q.get('zeitraum') === '12monate' ? 'zwoelf' : 'monat';
  const bis = q.get('bis');
  const gueltig = bis !== null && /^\d{4}-(0[1-9]|1[0-2])$/.test(bis) && monatIndex(bis) <= monatIndex(letzter);
  return { art, bis: gueltig ? bis : letzter };
}

/** Die Adresse zur Wahl; die Vorgabe (letzter voller Monat) bleibt ohne Parameter. */
export function zeitraumAdresse(basis: string, z: VerbrauchZeitraum, letzter: string): string {
  const q = new URLSearchParams();
  if (z.art === 'zwoelf') q.set('zeitraum', '12monate');
  if (z.bis !== letzter) q.set('bis', z.bis);
  const s = q.toString();
  return s ? `${basis}?${s}` : basis;
}

// ------------------------------------------------------------------ Vorjahr

/** Der rohe Vergleich mit dem Vorjahr — ohne Farbe, Pfeil erst ab 0,5 % (wie `portfolioKacheln.ts`). */
export interface VorjahrVergleich {
  text: string;
  /** `null`: nicht vergleichbar (kein oder ein unvollständiges Vorjahr) - dann sagt `text`, warum. */
  richtung: 'rauf' | 'runter' | 'gleich' | null;
}

/** Eine Seite des Vergleichs: die Menge als Dezimaltext der Route und ihr Zustand (AP-08). */
export interface VergleichSeite {
  menge: string | null;
  zustand: string | null;
}

export const VORJAHR_FEHLT = 'Vorjahr noch nicht verfügbar';
export const VORJAHR_UNVOLLSTAENDIG = 'Vorjahr unvollständig';

/** Vollständig im Sinn des Vergleichs: eine Menge, deren Zustand „vollständig“ oder „mit Ersatzwert“ ist (Ersatz ist Teil der Menge). */
export const vollstaendigeMenge = (s: VergleichSeite | null | undefined): s is VergleichSeite & { menge: string } =>
  !!s && s.menge !== null && (s.zustand === VOLLSTAENDIG || s.zustand === MIT_ERSATZWERT);

/**
 * Das Δ einer Menge gegen eine andere in ganzen Prozent und seine Richtung - gebildet vom Zwilling
 * (`uemsBericht.vergleich`, DA1: Differenz und Prozent exakt); „gleich“ unter 0,5 %. `null`, wenn die Vergleichsmenge
 * nicht über 0 liegt. Die Einheit braucht der Zwilling nur für seine eigene Anzeige der Differenz, die hier nicht
 * gelesen wird.
 */
function delta(jetzt: string, frueher: string): { betrag: string; richtung: 'rauf' | 'runter' | 'gleich' } | null {
  if (!positiv(frueher)) return null;
  const p = berichtVergleich({ aktuell: jetzt, vergleich: frueher, einheit: KWH, ebene: 'monat', grund: null }).prozent;
  if (p === null) return null;
  const runter = p.startsWith('-');
  const ohneVorzeichen = runter ? p.slice(1) : p;
  const gleich = dezVergleich(dez(ohneVorzeichen), dez('0.5')) < 0;
  return { betrag: prozentGanz(ohneVorzeichen), richtung: gleich ? 'gleich' : runter ? 'runter' : 'rauf' };
}

/**
 * Jetzt gegen das Vorjahr. `null`, solange die eigene Menge fehlt oder unvollständig ist (dann sagt die Reihe das
 * schon); ein fehlendes Vorjahr heißt „noch nicht verfügbar“, ein unvollständiges „Vorjahr unvollständig“ - nie ein Pfeil.
 */
export function vorjahrVergleich(jetzt: VergleichSeite | null, vorjahr: VergleichSeite | null): VorjahrVergleich | null {
  if (!vollstaendigeMenge(jetzt)) return null;
  if (!vorjahr || vorjahr.menge === null) return { text: VORJAHR_FEHLT, richtung: null };
  if (!vollstaendigeMenge(vorjahr)) return { text: VORJAHR_UNVOLLSTAENDIG, richtung: null };
  const d = delta(jetzt.menge, vorjahr.menge);
  if (d === null) return { text: VORJAHR_FEHLT, richtung: null };
  if (d.richtung === 'gleich') return { text: 'unverändert ggü. Vorjahr', richtung: 'gleich' };
  return { text: `${d.richtung === 'rauf' ? '▲' : '▼'} ${d.betrag} ggü. Vorjahr`, richtung: d.richtung };
}

/** Im Satz: „so viel wie im Jahr davor“, „3 % mehr als im Jahr davor“; ohne vergleichbares Vorjahr kein Teilsatz. */
function vorjahrImSatz(jetzt: VergleichSeite, vorjahr: VergleichSeite | null, bezug: string): string | null {
  if (!vollstaendigeMenge(jetzt) || !vollstaendigeMenge(vorjahr)) return null;
  const d = delta(jetzt.menge, vorjahr.menge);
  if (d === null) return null;
  return d.richtung === 'gleich' ? `so viel wie ${bezug}` : `${d.betrag} ${d.richtung === 'rauf' ? 'mehr' : 'weniger'} als ${bezug}`;
}

/** Die Seite „Hauptzähler gesamt“ einer Rangliste. */
const nennerSeite = (r: BewertungRangliste): VergleichSeite => ({ menge: r.nenner.wert, zustand: r.nenner.zustand });

// ------------------------------------------------------------------ Hauptzähler je Monat

export interface NennerMonat {
  monat: string;
  /** Der Hauptzähler-Wert des Monats als Dezimaltext, vom Zwilling summiert; `null`, sobald einer Anlage ein Wert fehlt. */
  menge: string | null;
  /** Dieselbe Menge als Zahl - nur für Säulenhöhe und Anzeige. */
  wert: number | null;
  zustand: string;
  /** Vollständig oder mit Ersatzwert (Ersatz ist Teil der Menge). */
  vollstaendig: boolean;
}

/**
 * Der Hauptzähler-Wert (Nenner) je Monat — so, wie die Rangliste ihn als Herkunft jedes Einsatzes mitliefert
 * (`herkunft.nenner.bilanzwerte`: je Anlage, Hauptzähler und Abschnitt eine Zeile). Je Monat zählt JEDE Anlage der
 * Rangliste mit allen ihren Zeilen (eine Stellungsänderung liefert mehrere Abschnitte); fehlt einer Anlage die Zeile
 * oder einer Zeile der Wert, ist der Monat ohne Zahl - nie eine Teilsumme als Gesamtwert. Die Summe bildet der Zwilling
 * der Bewertung (`uemsBewertung.nenner`, dieselbe Regel wie der Nenner der Rangliste).
 */
export function nennerJeMonat(r: BewertungRangliste): Map<string, NennerMonat> {
  const quelle = [...r.einsaetze, ...r.weitere_traeger].find((e) => (e.herkunft?.nenner?.bilanzwerte?.length ?? 0) > 0);
  const out = new Map<string, NennerMonat>();
  if (!quelle?.herkunft.nenner) return out;
  const zeilen = quelle.herkunft.nenner.bilanzwerte;
  const anlagen = [...new Set([...r.anlagen.map((a) => a.name), ...zeilen.map((b) => b.anlage)])];
  const jeMonat = new Map<string, BewertungBilanzwert[]>();
  for (const b of zeilen) jeMonat.set(b.von.slice(0, 7), [...(jeMonat.get(b.von.slice(0, 7)) ?? []), b]);
  for (const [monat, imMonat] of jeMonat) {
    const eingang = anlagen.flatMap((anlage) => {
      const eigene = imMonat.filter((b) => b.anlage === anlage);
      if (eigene.length === 0) return [{ kennung: anlage, hauptzaehler: true, zufluss: null, abgabe: '0', laden: '0' }];
      return eigene.map((b, i) => ({ kennung: `${anlage} · ${i}`, hauptzaehler: true, zufluss: b.wert, abgabe: '0', laden: '0' }));
    });
    const n = nenner(eingang);
    const zustand =
      n.wert === null
        ? n.vorhanden === 0
          ? KEINE_WERTE
          : UNVOLLSTAENDIG
        : imMonat.some((b) => b.zustand !== VOLLSTAENDIG && b.zustand !== MIT_ERSATZWERT)
          ? UNVOLLSTAENDIG
          : imMonat.some((b) => b.zustand === MIT_ERSATZWERT)
            ? MIT_ERSATZWERT
            : VOLLSTAENDIG;
    out.set(monat, { monat, menge: n.wert, wert: zahl(n.wert), zustand, vollstaendig: zustand === VOLLSTAENDIG || zustand === MIT_ERSATZWERT });
  }
  return out;
}

// ------------------------------------------------------------------ Das Bild der Seite

export interface Teil {
  text: string;
  /** Ein Kennzeichen oder eine kurze Angabe, die nicht umbrechen soll. */
  fest?: boolean;
}

export interface BereichZeile {
  id: string;
  kennzeichen: string;
  name: string;
  /** `true`/`false` nach der freigegebenen Einstufung; `null` = unbekannt oder nicht eingestuft. */
  wesentlich: boolean | null;
  /** Nur zur Anzeige und Sortierprobe; die Menge selbst ist der Dezimaltext der Route. */
  menge: number | null;
  /** „88.200“ — die Einheit steht daneben. */
  mengeText: string | null;
  einheit: string;
  anteil: string | null;
  /** Breite des Balkens in % des größten Bereichs; `null` ohne Menge. */
  balken: number | null;
  unterzeile: Teil[];
  /** Ein Hinweis an der Reihe („unvollständig“, „keine Werte“, „mit Ersatzwert“) - nie stumm. */
  marke: { text: string; ton: 'warn' | 'neutral' } | null;
}

export interface RestZeile {
  menge: number;
  mengeText: string;
  anteil: string | null;
  balken: number;
  /** „Werk Ahrenberg – Halle 1 ohne eigenen Zähler · geplant: Lüftung, …“ */
  satz: string;
  /** Die Anlage mit dem größten Rest — für „Zähler planen“. */
  ort: BewertungMessabdeckungOrt | null;
}

export interface WeitereZeile {
  id: string;
  name: string;
  wert: string | null;
  satz: string | null;
}

export interface WeitereKarte {
  traeger: EnergieTraeger;
  zeilen: WeitereZeile[];
}

export interface Hinweis {
  ton: 'warn' | 'info';
  satz: string;
  /** Der Weg dazu: eine Messstelle (ihre Kennung, „Ablesung eintragen“) oder die Messstellen („Zuordnung prüfen“). */
  weg: { text: string; messstelle: string | null } | null;
}

export interface VerbrauchKachel {
  titel: string;
  wert: string | null;
  vorjahr: VorjahrVergleich | null;
  zugeordnet: { text: string; ton: 'ok' | 'warn' | 'neutral' } | null;
  unterzeile: string;
}

export interface VerbrauchBild {
  zeitraum: VerbrauchZeitraum;
  /** Keine Bereiche festgelegt — der Leerzustand mit Satz und Knopf. */
  leer: boolean;
  /** Der Antwortsatz; `null`, wenn es im Zeitraum nichts zu sagen gibt (dann steht `hinweise[0]` vorn). */
  antwort: string | null;
  /** Am Rechner derselbe Satz mit der Zuordnung: „…; 91 % des Stroms sind einem Bereich zugeordnet.“ */
  antwortBreit: string | null;
  untertitel: string;
  kachel: VerbrauchKachel;
  hinweise: Hinweis[];
  bereiche: BereichZeile[];
  rest: RestZeile | null;
  weitere: WeitereKarte[];
}

export interface VerbrauchDaten {
  zeitraum: VerbrauchZeitraum;
  rangliste: BewertungRangliste;
  /** Derselbe Zeitraum ein Jahr früher; `null` = nicht geladen oder nicht abrufbar. */
  vorjahr: BewertungRangliste | null;
  abdeckung: BewertungMessabdeckung | null;
  /** Je Einsatz: wesentlich nach der freigegebenen Einstufung (`null` = keine). */
  einstufungen: ReadonlyMap<string, boolean | null> | null;
  /** Offene Messbedarfe — sie sagen, was am Rest schon geplant ist. */
  messbedarfe: readonly Messbedarf[] | null;
  /** Der Monatsverlauf des Zeitraums (nur „12 Monate“): für den Satz über den größten und kleinsten Monat. */
  verlauf?: VerlaufBild | null;
}

/** „Keinem Bereich zugeordnet“ mitten im Satz: nur der erste Buchstabe klein. */
const kleinAnfang = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;

/** „G-1 Halle 1“ → „Halle 1“: der Ort mit Namen, das Kennzeichen steht schon am Zähler. */
const ortName = (ort: string) => ort.replace(/^[A-ZÄÖÜ]{1,4}-\d+\s+/, '').trim();

function unterzeile(e: BewertungRanglisteEinsatz, d: VerbrauchDaten, vorjahr: VorjahrVergleich | null): Teil[] {
  const teile: Teil[] = [];
  const je = d.abdeckung?.je_einsatz.find((x) => x.id === e.id);
  const orte = [...new Set((je?.gemessen ?? []).map((m) => (m.ort ? ortName(m.ort) : '')).filter((o) => o.length > 0))];
  if (orte.length > 0) teile.push({ text: orte.join(' und ') });
  const zaehler = e.messstellen.map((m) => m.kennzeichen);
  if (zaehler.length === 1) teile.push({ text: `Zähler ${zaehler[0]}`, fest: true });
  else if (zaehler.length > 1) teile.push({ text: `Zähler ${zaehler.join(', ')}` });
  if (vorjahr) teile.push({ text: vorjahr.text, fest: true });
  return teile;
}

/** Ersatz ist Teil der Menge: „mit Ersatzwert“ ist ein leiser Hinweis, keine Lücke (kein „unvollständig“). */
function reiheMarke(e: BewertungRanglisteEinsatz): BereichZeile['marke'] {
  if (e.menge === null) return { text: KEINE_WERTE, ton: 'warn' };
  if (e.zustand === MIT_ERSATZWERT) return { text: MIT_ERSATZWERT, ton: 'neutral' };
  if (e.zustand !== VOLLSTAENDIG) return { text: UNVOLLSTAENDIG, ton: 'warn' };
  return null;
}

/** Der Rest: die Anlagen ohne eigenen Zähler für ihren ganzen Bezug, dazu, was dafür schon geplant ist. */
function restSatz(d: VerbrauchDaten): { satz: string; ort: BewertungMessabdeckungOrt | null } {
  const orte = (d.abdeckung?.je_ort ?? [])
    .filter((o) => o.art === 'anlage' && o.ungemessen !== null && positiv(o.ungemessen.menge))
    .sort((a, b) => absteigend(a.ungemessen?.menge, b.ungemessen?.menge));
  const namen = orte.map((o) => o.ungemessen?.anlage ?? o.name ?? '').filter((n) => n.length > 0);
  const geplant = (d.messbedarfe ?? []).filter((m) => m.zustand === 'offen').map((m) => m.wortlaut);
  const wo = namen.length > 0 ? `${namen.join(' und ')} ${UEMS_OHNE_EIGENEN_ZAEHLER}` : `Strom ${UEMS_OHNE_EIGENEN_ZAEHLER}`;
  return { satz: geplant.length > 0 ? `${wo} · geplant: ${geplant.join('; ')}` : wo, ort: orte[0] ?? null };
}

/** Eine Menge mit ihrer Einheit („1.240 m³“); ohne Einheit der Route kWh. */
const mengeMitEinheit = (n: number, einheit: string | null) => `${kwhZahl(n)}${NBSP}${einheit ?? KWH}`;

function weitereKarten(d: VerbrauchDaten): WeitereKarte[] {
  const nachTraeger = new Map<EnergieTraeger, WeitereZeile[]>();
  for (const e of d.rangliste.weitere_traeger) {
    const menge = zahl(e.menge);
    const waehlbar = (MEDIEN_WAEHLBAR as readonly string[]).includes(e.traeger);
    // Der Name trägt den Träger oft schon („Heizung Verwaltung (Gas)“) — die Karte heißt nach ihm.
    const name = e.name.replace(new RegExp(`\\s*\\(${e.traeger}\\)$`), '');
    const zeile: WeitereZeile = {
      id: e.id,
      name,
      wert: menge === null ? null : mengeMitEinheit(menge, e.einheit),
      satz:
        menge !== null
          ? null
          : waehlbar
            ? `Für ${zeitraumLang(d.zeitraum)} liegen keine Werte vor.`
            : `Noch nicht gemessen: ${e.traeger}zähler lassen sich noch nicht als Messstelle anlegen. Bis dahin lässt sich der ${e.traeger}bezug als Bezugsgröße führen.`,
    };
    nachTraeger.set(e.traeger, [...(nachTraeger.get(e.traeger) ?? []), zeile]);
  }
  return [...nachTraeger].map(([traeger, zeilen]) => ({ traeger, zeilen }));
}

function hinweise(d: VerbrauchDaten): Hinweis[] {
  const r = d.rangliste;
  const out: Hinweis[] = [];
  const wann = zeitraumLang(d.zeitraum);
  // Ohne den Wert EINER Anlage gibt es kein Gesamt (der Nenner ist dann `null`, nie eine Teilsumme) - und keine Anteile.
  if (r.nenner.wert === null && r.nenner.vorhanden > 0 && r.nenner.vorhanden < r.nenner.gesamt) {
    out.push({
      ton: 'warn',
      satz: `Für ${wann} liegt der Hauptzähler-Wert nur für ${r.nenner.anlagen} Anlagen vollständig vor – darum gibt es kein Gesamt und keine Anteile.`,
      weg: null,
    });
  }
  for (const e of r.einsaetze) {
    if (e.menge === null || vollstaendigeMenge(e)) continue;
    const luecke = e.messstellen.find((m) => m.zustand && m.zustand !== VOLLSTAENDIG && m.zustand !== MIT_ERSATZWERT) ?? e.messstellen[0];
    out.push({
      ton: 'warn',
      satz: `Für ${wann} fehlen Werte von ${e.name}${luecke ? ` (Zähler ${luecke.kennzeichen})` : ''} – sein Anteil ist darum zu klein.`,
      weg: luecke ? { text: ABLESUNG_EINTRAGEN, messstelle: luecke.id } : null,
    });
  }
  if (r.rest !== null && negativ(r.rest)) {
    const mehr = zahl(r.rest.slice(1));
    out.push({
      ton: 'warn',
      satz: `Die Bereiche ergeben ${mehr === null ? 'mehr' : `${kwhText(mehr)} mehr`} als der Hauptzähler – vermutlich ist ein Zähler doppelt zugeordnet.`,
      weg: { text: ZUORDNUNG_PRUEFEN, messstelle: null },
    });
  }
  return out;
}

/** Der Ton der Zuordnung folgt K8; ergeben die Bereiche mehr als der Hauptzähler, ist das nie „ok“. */
const zugeordnetTon = (k8: string, restNegativ: boolean): 'ok' | 'warn' | 'neutral' =>
  restNegativ ? 'warn' : k8 === 'ueber_schwelle' ? 'ok' : k8 === 'unter_schwelle' ? 'warn' : 'neutral';

/**
 * Woher die Gesamtmenge kommt: der Hauptzähler der Anlage. Die Herkunft nennt neben ihm auch die Unterzähler, darum
 * steht hier die Anlage, nicht ein Kennzeichen.
 */
function hauptzaehlerZeile(r: BewertungRangliste): string {
  const mitBilanz = r.anlagen.filter((a) => a.zustand !== 'ohne Bilanz');
  const wer =
    r.nenner.gesamt > 1
      ? `Hauptzähler aus ${r.nenner.vorhanden} von ${r.nenner.gesamt} Anlagen`
      : mitBilanz.length === 1
        ? `Hauptzähler ${mitBilanz[0].name}`
        : 'Hauptzähler';
  return r.nenner.wert === null ? `${wer} · keine Werte` : `${wer} · ${r.nenner.zustand}`;
}

/** Über zwölf Monate: Menge, Vorjahr, dann der stärkste gegen den schwächsten Monat. */
function zwoelfAntwort(d: VerbrauchDaten, gesamt: number): string {
  const vergleich = vorjahrImSatz(nennerSeite(d.rangliste), d.vorjahr ? nennerSeite(d.vorjahr) : null, 'im Jahr davor');
  // Ein Gedankenstrich steht nie am Zeilenanfang: davor ein geschütztes Leerzeichen.
  const erster = `In zwölf Monaten ${mengeImSatz(gesamt)} Strom${vergleich ? `${NBSP}– ${vergleich}` : ''}.`;
  const monate = (d.verlauf?.saeulen ?? []).filter((s) => s.wert !== null && s.menge !== null && s.vollstaendig) as (VerlaufSaeule & {
    wert: number;
    menge: string;
  })[];
  if (monate.length < 2) return erster;
  const hoch = monate.reduce((a, b) => (absteigend(a.menge, b.menge) > 0 ? b : a));
  const tief = monate.reduce((a, b) => (absteigend(a.menge, b.menge) < 0 ? b : a));
  if (hoch.monat === tief.monat) return erster;
  const mehr = delta(hoch.menge, tief.menge);
  if (mehr === null) return erster;
  if (mehr.richtung === 'gleich') return `${erster} Jeder Monat brauchte etwa gleich viel.`;
  return `${erster} Der ${monatsName(hoch.monat)} brauchte am meisten, ${mehr.betrag} mehr als der ${monatsName(tief.monat)}.`;
}

export function verbrauchBild(d: VerbrauchDaten): VerbrauchBild {
  const r = d.rangliste;
  const wann = zeitraumLang(d.zeitraum);
  const gesamt = zahl(r.nenner.wert);
  const restNegativ = negativ(r.rest);
  const restPositiv = positiv(r.rest);
  const sortiert = [...r.einsaetze].sort((a, b) => absteigend(a.menge, b.menge));
  // Der größte Bereich (oder der größere Rest) setzt den Maßstab der Balken - reine Zeichnungsgeometrie.
  const groesste = Math.max(0, ...sortiert.map((e) => zahl(e.menge) ?? 0), restPositiv ? (zahl(r.rest) ?? 0) : 0);
  const balken = (menge: number) => (groesste > 0 ? Math.max(0, Math.min(100, (menge / groesste) * 100)) : 0);

  const bereiche: BereichZeile[] = sortiert.map((e) => {
    const menge = zahl(e.menge);
    const vj = d.vorjahr ? [...d.vorjahr.einsaetze, ...d.vorjahr.weitere_traeger].find((x) => x.id === e.id) ?? null : null;
    const vergleich = d.vorjahr ? vorjahrVergleich(e, vj) : null;
    return {
      id: e.id,
      kennzeichen: e.kennzeichen,
      name: e.name,
      wesentlich: d.einstufungen?.get(e.id) ?? null,
      menge,
      mengeText: menge === null ? null : kwhZahl(menge),
      einheit: e.einheit ?? KWH,
      anteil: e.anteil_prozent === null ? null : anteilText(e.anteil_prozent),
      balken: menge === null ? null : balken(menge),
      unterzeile: unterzeile(e, d, vergleich),
      marke: reiheMarke(e),
    };
  });

  const restOrt = restSatz(d);
  // Der Anteil des Rests kommt von der Messabdeckung, sonst vom Zwilling (Rest ÷ Hauptzähler, AP-16 KR4).
  const restAnteil = d.abdeckung?.summe.ungemessen_prozent ?? prozent(betrag(r.rest), betrag(r.nenner.wert));
  const restMenge = restPositiv ? zahl(r.rest) : null;
  const restZeile: RestZeile | null =
    restMenge !== null
      ? {
          menge: restMenge,
          mengeText: kwhZahl(restMenge),
          anteil: restAnteil === null ? null : anteilText(restAnteil),
          balken: balken(restMenge),
          satz: restOrt.satz,
          ort: restOrt.ort,
        }
      : null;

  const top = sortiert.find((e) => e.menge !== null);
  const abdeckung = r.abdeckung_prozent;
  // Ergeben die Bereiche mehr als der Hauptzähler, ist „102 % zugeordnet“ keine Auskunft - der Hinweis sagt, was los ist.
  const zugeordnetSatz =
    abdeckung === null ? null : restNegativ ? 'die Bereiche ergeben mehr Strom, als der Hauptzähler gemessen hat' : `${prozentGanz(abdeckung)} des Stroms sind ${UEMS_EINEM_BEREICH_ZUGEORDNET}`;
  let antwort: string | null = null;
  let antwortBreit: string | null = null;
  if (d.zeitraum.art === 'zwoelf' && gesamt !== null) {
    antwort = zwoelfAntwort(d, gesamt);
  } else if (top) {
    const topAnteil = top.anteil_prozent;
    const topMenge = zahl(top.menge);
    const bereich =
      topAnteil !== null
        ? `${top.name} braucht mit ${prozentGanz(topAnteil)} den größten Teil des Stroms`
        : `${top.name} braucht mit ${topMenge === null ? '–' : mengeMitEinheit(topMenge, top.einheit)} den meisten Strom`;
    // Ist der Rest größer als jeder Bereich, steht ER vorn - sonst wäre „den größten Teil“ falsch.
    if (restPositiv && absteigend(r.rest, top.menge) < 0 && restAnteil !== null) {
      const kern = `${prozentGanz(restAnteil)} des Stroms sind ${kleinAnfang(UEMS_KEINEM_BEREICH_ZUGEORDNET)}${NBSP}– von den Bereichen braucht ${top.name}${topAnteil !== null ? ` mit ${prozentGanz(topAnteil)}` : ''} am meisten`;
      antwort = `${kern}.`;
      antwortBreit = antwort;
    } else {
      antwort = `${bereich}.`;
      antwortBreit = zugeordnetSatz ? `${bereich}; ${zugeordnetSatz}.` : null;
    }
  }

  const vollstaendigeMonate = d.verlauf ? d.verlauf.saeulen.filter((s) => s.vollstaendig).length : null;
  const mitErsatz = r.einsaetze.some((e) => e.zustand === MIT_ERSATZWERT);
  const datenlage =
    d.zeitraum.art === 'zwoelf'
      ? vollstaendigeMonate !== null
        ? `${vollstaendigeMonate} von 12 Monaten vollständig`
        : null
      : r.einsaetze.length === 0
        ? null
        : r.einsaetze.every((e) => vollstaendigeMenge(e)) && r.nenner.zustand === VOLLSTAENDIG
          ? mitErsatz
            ? 'alle Zähler vollständig, teils mit Ersatzwert'
            : 'alle Zähler vollständig'
          : 'nicht alle Zähler vollständig';
  const untertitel = ['Strom', wann, datenlage].filter((x): x is string => !!x).join(' · ');

  return {
    zeitraum: d.zeitraum,
    leer: r.einsaetze.length === 0 && r.weitere_traeger.length === 0,
    antwort,
    antwortBreit,
    untertitel,
    kachel: {
      titel: d.zeitraum.art === 'monat' ? `Strom im ${wann}` : 'Strom in zwölf Monaten',
      wert: gesamt === null ? null : kwhZahl(gesamt),
      vorjahr: d.vorjahr ? vorjahrVergleich(nennerSeite(r), nennerSeite(d.vorjahr)) : null,
      zugeordnet:
        abdeckung === null ? null : { text: `${prozentGanz(abdeckung)} ${UEMS_EINEM_BEREICH_ZUGEORDNET}`, ton: zugeordnetTon(r.urteil.K8, restNegativ) },
      unterzeile: hauptzaehlerZeile(r),
    },
    hinweise: hinweise(d),
    bereiche,
    rest: restZeile,
    weitere: weitereKarten(d),
  };
}

/** Die Rest-Reihe heißt überall gleich (Bewertung, Energiebilanz, Verbrauch). */
export const REST_NAME = UEMS_KEINEM_BEREICH_ZUGEORDNET;

/** „7 Bereiche“ / „1 Bereich“. */
export const bereicheZahl = (n: number) => (n === 1 ? '1 Bereich' : `${n} Bereiche`);

// ------------------------------------------------------------------ Monatsverlauf (Verlauf mit Vorjahr)

export interface VerlaufSaeule {
  monat: string;
  /** „Okt“ und, wo der Platz nicht reicht, „O“. */
  kurz: string;
  buchstabe: string;
  /** Die Jahreszahl unter dem ersten Monat eines Jahres (und unter dem ersten der Reihe). */
  jahr: string | null;
  /** Die Menge des Monats als Dezimaltext (vom Zwilling summiert); `wert` ist dieselbe Zahl nur zum Zeichnen. */
  menge: string | null;
  wert: number | null;
  zustand: string;
  vollstaendig: boolean;
  vorjahrMenge: string | null;
  vorjahr: number | null;
  vorjahrZustand: string | null;
  /** Das Vorjahr ist vollständig (sonst steht der Punkt hohl und es gibt keinen Vergleich). */
  vorjahrVollstaendig: boolean;
  /** Höhen in % der Zeichenfläche. */
  hoehe: number;
  vorjahrHoehe: number | null;
}

export interface VerlaufBild {
  saeulen: VerlaufSaeule[];
  achse: { wert: number; text: string; hoehe: number }[];
}

/** Zwei bis drei runde Achsenwerte (1, 2, 2,5 oder 5 mal einer Zehnerpotenz). */
function achsenSchritt(max: number): number {
  if (max <= 0) return 1;
  const roh = max / 2.5;
  const p = 10 ** Math.floor(Math.log10(roh));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * p >= roh) return f * p;
  return 10 * p;
}

/**
 * Die zwölf Monate bis `bis`: Hauptzähler-Wert je Monat als Säule, das Vorjahr als Punkt. Ein Monat ohne Wert bleibt
 * eine leere Säule (Höhe 0, die Fläche zeichnet sie gestrichelt).
 */
export function verlaufBild(r: BewertungRangliste, vorjahr: BewertungRangliste | null, bis: string): VerlaufBild {
  const jetzt = nennerJeMonat(r);
  const frueher = vorjahr ? nennerJeMonat(vorjahr) : new Map<string, NennerMonat>();
  const monate = Array.from({ length: 12 }, (_, i) => monatPlus(bis, i - 11));
  const roh = monate.map((monat) => ({
    monat,
    jetzt: jetzt.get(monat) ?? { monat, menge: null, wert: null, zustand: KEINE_WERTE, vollstaendig: false },
    vj: frueher.get(monatPlus(monat, -12)) ?? null,
  }));
  const max = Math.max(0, ...roh.flatMap((x) => [x.jetzt.wert ?? 0, x.vj?.wert ?? 0]));
  const schritt = achsenSchritt(max);
  // Oben bleibt Luft für den Vorjahrespunkt über der höchsten Säule.
  const skala = max > 0 ? Math.max(max * 1.12, schritt) : 1;
  const hoehe = (w: number) => Math.max(0, Math.min(100, (w / skala) * 100));
  const achse: VerlaufBild['achse'] = [];
  for (let w = schritt; w <= skala; w += schritt) achse.push({ wert: w, text: kwhZahl(w), hoehe: hoehe(w) });
  return {
    saeulen: roh.map((x, i) => ({
      monat: x.monat,
      kurz: MONATE_KURZ[Number(x.monat.slice(5, 7)) - 1],
      buchstabe: MONATE_KURZ[Number(x.monat.slice(5, 7)) - 1][0],
      jahr: i === 0 || x.monat.endsWith('-01') ? x.monat.slice(0, 4) : null,
      menge: x.jetzt.menge,
      wert: x.jetzt.wert,
      zustand: x.jetzt.zustand,
      vollstaendig: x.jetzt.vollstaendig,
      vorjahrMenge: x.vj?.menge ?? null,
      vorjahr: x.vj?.wert ?? null,
      vorjahrZustand: x.vj?.zustand ?? null,
      vorjahrVollstaendig: x.vj?.vollstaendig ?? false,
      hoehe: x.jetzt.wert === null ? 0 : hoehe(x.jetzt.wert),
      vorjahrHoehe: x.vj?.wert == null ? null : hoehe(x.vj.wert),
    })),
    achse,
  };
}

/** „Vorjahr 199.500 kWh“, bei einem unvollständigen Vorjahr mit diesem Wort - nie als ganzer Vorjahreswert. */
const vorjahrZeile = (s: VerlaufSaeule) =>
  s.vorjahr === null ? null : `Vorjahr ${kwhText(s.vorjahr)}${s.vorjahrVollstaendig ? '' : ` (${UNVOLLSTAENDIG})`}`;

/** Die Infozeile eines Monats: Wert, Vorjahr und der rohe Vergleich - ohne Urteilsfarbe, nur zwischen vollständigen Monaten. */
export function infozeile(s: VerlaufSaeule): { monat: string; wert: string; vorjahr: string | null; vergleich: string | null } {
  const vergleich = vorjahrVergleich(
    { menge: s.menge, zustand: s.zustand },
    s.vorjahrMenge === null ? null : { menge: s.vorjahrMenge, zustand: s.vorjahrZustand },
  );
  return {
    monat: monatWort(s.monat),
    wert: s.wert === null ? KEINE_WERTE : s.vollstaendig ? kwhText(s.wert) : `${kwhText(s.wert)} (${UNVOLLSTAENDIG})`,
    vorjahr: vorjahrZeile(s),
    vergleich:
      vergleich === null || vergleich.richtung === null
        ? null
        : vergleich.richtung === 'gleich'
          ? 'unverändert'
          : vergleich.text.replace(' ggü. Vorjahr', ''),
  };
}

/** Für Vorleser: der Verlauf als Satzliste („September 2026: 199.500 kWh, Vorjahr 199.500 kWh“). */
export const verlaufListe = (v: VerlaufBild) =>
  v.saeulen.map((s) => {
    const vj = vorjahrZeile(s);
    return `${monatWort(s.monat)}: ${s.wert === null ? KEINE_WERTE : kwhText(s.wert)}${vj === null ? '' : `, ${vj}`}`;
  });

// ------------------------------------------------------------------ CSV

/**
 * Eine Textzelle der CSV: ein Name, der mit `=`, `+`, `-`, `@`, Tab oder Wagenrücklauf beginnt, bekäme in einer
 * Tabellenkalkulation sonst eine Formel (CSV-Formel-Injektion) - davor ein Apostroph. Zahlen bleiben, wie sie sind
 * (sie dürfen mit „-“ beginnen); Trenner, Anführungszeichen und Zeilenumbrüche stehen in Anführungszeichen.
 */
const textZelle = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
const csvFeld = (s: string) => (/[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Die Liste als CSV: ungerundet, Dezimalpunkt, ISO-Zeitraum (AP-08 E11) — dieselben Zeilen wie die Fläche. */
export function verbrauchCsv(r: BewertungRangliste): string {
  const kopf = ['Bereich', 'Kennzeichen', 'Traeger', 'Menge', 'Einheit', 'Anteil_Prozent', 'Zustand', 'Von', 'Bis'];
  const zeile = (text: [string, string, string], menge: string | null, einheit: string | null, anteil: string | null, zustand: string) =>
    [...text.map(textZelle), menge ?? '', textZelle(einheit ?? ''), anteil ?? '', textZelle(zustand), r.von, r.bis];
  const zeilen = [
    kopf,
    ...[...r.einsaetze, ...r.weitere_traeger].map((e) => zeile([e.name, e.kennzeichen, e.traeger], e.menge, e.einheit, e.anteil_prozent, e.zustand)),
  ];
  if (r.rest !== null) zeilen.push(zeile([REST_NAME, '', 'Strom'], r.rest, KWH, null, r.zustand));
  if (r.nenner.wert !== null) zeilen.push(zeile(['Hauptzähler gesamt', '', 'Strom'], r.nenner.wert, KWH, '100', r.nenner.zustand));
  return zeilen.map((z) => z.map(csvFeld).join(';')).join('\n');
}
