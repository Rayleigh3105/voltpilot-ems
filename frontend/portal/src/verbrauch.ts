/**
 * „Auswerten › Verbrauch“ (Konzept Auswerten a1, Richtungsfrage 1 = A, §6.3, Entscheid 10.1): Wo geht die Energie hin?
 * Die Seite liest nur, was es schon gibt — die Rangliste (Menge je Energieeinsatz, Nenner je Anlage, Monatsmengen je
 * Messstelle) und die Messabdeckung (Ort je Messstelle, Rest je Anlage) des gewählten Zeitraums; das Vorjahr ist ein
 * zweiter Abruf desselben Zeitraums ein Jahr früher. Dieses Modul bildet daraus Antwortsatz, Kachel, Balkenreihen und
 * den Monatsverlauf; es rechnet keine Menge selbst, es ordnet, vergleicht und formuliert.
 *
 * ⚠ Fehlend ist keine Null: ein Bereich ohne Werte bleibt ohne Balken und sagt warum; ein Monat ohne Hauptzähler-Wert
 * bleibt eine leere, gestrichelte Säule. Ein Vorjahresvergleich ist roh (Produktion und Wetter sind nicht
 * herausgerechnet) und bekommt darum nie eine Urteilsfarbe; Pfeile erst ab 0,5 % wie die Kacheln der Übersicht.
 */
import type {
  BewertungMessabdeckung,
  BewertungMessabdeckungOrt,
  BewertungRangliste,
  BewertungRanglisteEinsatz,
  EnergieTraeger,
  Messbedarf,
} from './api';
import { UEMS_EINEM_BEREICH_ZUGEORDNET, UEMS_KEINEM_BEREICH_ZUGEORDNET, UEMS_OHNE_EIGENEN_ZAEHLER } from './glossar';
import { MEDIEN_WAEHLBAR } from './uemsMessstelle';

// ------------------------------------------------------------------ Wörter

export const VERBRAUCH_TITEL = 'Verbrauch';
export const VERBRAUCH_UNTERZEILE = 'Wofür Ihr Unternehmen Energie einsetzt – nach Bereichen sortiert.';
export const VERBRAUCH_LISTE_TITEL = 'Wofür der Strom gebraucht wurde';
export const VERBRAUCH_VERLAUF_TITEL = 'Strom je Monat';
export const VERBRAUCH_LEER =
  'Noch keine Bereiche festgelegt. Legen Sie fest, wofür Ihr Betrieb Energie einsetzt – dann zeigt VoltPilot hier die Verteilung.';
export const VERBRAUCH_FEHLER = 'Der Verbrauch ließ sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
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
/** Ein Anteil in der Reihe: eine Nachkommastelle wie die Bewertung; im Satz ganze Prozent. */
export const anteilText = (n: number) => `${n.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${NBSP}%`;
const prozentGanz = (n: number) => `${Math.round(n).toLocaleString('de-DE')}${NBSP}%`;
/** Große Mengen im Satz: „2,5 Millionen kWh“ statt „2.503.200 kWh“ — die genaue Zahl steht in Kachel und Liste. */
export function mengeImSatz(n: number): string {
  if (Math.abs(n) >= 1_000_000) {
    return `${(n / 1_000_000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Millionen kWh`;
  }
  return kwhText(n);
}

const zahl = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

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
  richtung: 'rauf' | 'runter' | 'gleich' | null;
}

export function vorjahrVergleich(jetzt: number | null, vorjahr: number | null): VorjahrVergleich | null {
  if (jetzt === null) return null;
  if (vorjahr === null || vorjahr === 0) return { text: 'Vorjahr noch nicht verfügbar', richtung: null };
  const delta = ((jetzt - vorjahr) / vorjahr) * 100;
  if (Math.abs(delta) < 0.5) return { text: 'unverändert ggü. Vorjahr', richtung: 'gleich' };
  return {
    text: `${delta > 0 ? '▲' : '▼'} ${prozentGanz(Math.abs(delta))} ggü. Vorjahr`,
    richtung: delta > 0 ? 'rauf' : 'runter',
  };
}

/** Im Satz: „so viel wie im Jahr davor“, „3 % mehr als im Jahr davor“; ohne Vorjahr kein Teilsatz. */
function vorjahrImSatz(jetzt: number, vorjahr: number | null, bezug: string): string | null {
  if (vorjahr === null || vorjahr === 0) return null;
  const delta = ((jetzt - vorjahr) / vorjahr) * 100;
  if (Math.abs(delta) < 0.5) return `so viel wie ${bezug}`;
  return `${prozentGanz(Math.abs(delta))} ${delta > 0 ? 'mehr' : 'weniger'} als ${bezug}`;
}

// ------------------------------------------------------------------ Hauptzähler je Monat

export interface NennerMonat {
  monat: string;
  wert: number | null;
  vollstaendig: boolean;
}

/**
 * Der Hauptzähler-Wert (Nenner) je Monat — so, wie die Rangliste ihn als Herkunft jedes Einsatzes mitliefert
 * (`herkunft.nenner.bilanzwerte`, je Anlage und Monat). Mehrere Anlagen ergeben je Monat ihre Summe; fehlt einer
 * Anlage der Wert, ist der Monat ohne Zahl (nie eine Teilsumme als Gesamtwert).
 */
export function nennerJeMonat(r: BewertungRangliste): Map<string, NennerMonat> {
  const quelle = [...r.einsaetze, ...r.weitere_traeger].find((e) => (e.herkunft?.nenner?.bilanzwerte?.length ?? 0) > 0);
  const out = new Map<string, NennerMonat>();
  if (!quelle?.herkunft.nenner) return out;
  const gruppen = new Map<string, { wert: number | null; vollstaendig: boolean; zahl: number }>();
  for (const b of quelle.herkunft.nenner.bilanzwerte) {
    const monat = b.von.slice(0, 7);
    const alt = gruppen.get(monat) ?? { wert: 0, vollstaendig: true, zahl: 0 };
    const w = zahl(b.wert);
    gruppen.set(monat, {
      wert: alt.wert === null || w === null ? null : alt.wert + w,
      vollstaendig: alt.vollstaendig && w !== null && b.zustand === 'vollständig',
      zahl: alt.zahl + 1,
    });
  }
  for (const [monat, g] of gruppen) {
    out.set(monat, { monat, wert: g.wert, vollstaendig: g.vollstaendig && g.zahl >= r.nenner.gesamt });
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
  menge: number | null;
  /** „88.200“ — die Einheit steht daneben. */
  mengeText: string | null;
  einheit: string;
  anteil: string | null;
  /** Breite des Balkens in % des größten Bereichs; `null` ohne Menge. */
  balken: number | null;
  unterzeile: Teil[];
  /** Ein Hinweis an der Reihe („unvollständig“, „keine Werte“) — nie stumm. */
  marke: string | null;
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
  /** Für die CSV: dieselben Zeilen ungerundet. */
  zugeordnetProzent: number | null;
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

/** „G-1 Halle 1“ → „Halle 1“: der Ort mit Namen, das Kennzeichen steht schon am Zähler. */
const ortName = (ort: string) => ort.replace(/^[A-ZÄÖÜ]{1,4}-\d+\s+/, '').trim();

const einsatzMenge = (e: BewertungRanglisteEinsatz | undefined) => (e ? zahl(e.menge) : null);

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

function reiheMarke(e: BewertungRanglisteEinsatz): string | null {
  if (e.menge === null) return 'keine Werte';
  if (e.zustand !== 'vollständig') return 'unvollständig';
  return null;
}

/** Der Rest: die Anlagen ohne eigenen Zähler für ihren ganzen Bezug, dazu, was dafür schon geplant ist. */
function restSatz(d: VerbrauchDaten): { satz: string; ort: BewertungMessabdeckungOrt | null } {
  const orte = (d.abdeckung?.je_ort ?? [])
    .filter((o) => o.art === 'anlage' && o.ungemessen !== null && (zahl(o.ungemessen.menge) ?? 0) > 0)
    .sort((a, b) => (zahl(b.ungemessen?.menge) ?? 0) - (zahl(a.ungemessen?.menge) ?? 0));
  const namen = orte.map((o) => o.ungemessen?.anlage ?? o.name ?? '').filter((n) => n.length > 0);
  const geplant = (d.messbedarfe ?? []).filter((m) => m.zustand === 'offen').map((m) => m.wortlaut);
  const wo = namen.length > 0 ? `${namen.join(' und ')} ${UEMS_OHNE_EIGENEN_ZAEHLER}` : `Strom ${UEMS_OHNE_EIGENEN_ZAEHLER}`;
  return { satz: geplant.length > 0 ? `${wo} · geplant: ${geplant.join('; ')}` : wo, ort: orte[0] ?? null };
}

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
      wert: menge === null ? null : `${kwhZahl(menge)}${NBSP}${e.einheit ?? ''}`.trim(),
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

function hinweise(d: VerbrauchDaten, rest: number | null): Hinweis[] {
  const r = d.rangliste;
  const out: Hinweis[] = [];
  const wann = zeitraumLang(d.zeitraum);
  const fehlend = r.nenner.gesamt - r.nenner.vorhanden;
  if (r.nenner.wert !== null && fehlend > 0) {
    out.push({
      ton: 'warn',
      satz: `Für ${wann} fehlt der Hauptzähler-Wert von ${fehlend === 1 ? 'einer Anlage' : `${fehlend} Anlagen`} – Gesamt und Anteile sind darum zu klein.`,
      weg: null,
    });
  }
  for (const e of r.einsaetze) {
    if (e.menge === null || e.zustand === 'vollständig') continue;
    const luecke = e.messstellen.find((m) => m.zustand && m.zustand !== 'vollständig') ?? e.messstellen[0];
    out.push({
      ton: 'warn',
      satz: `Für ${wann} fehlen Werte von ${e.name}${luecke ? ` (Zähler ${luecke.kennzeichen})` : ''} – sein Anteil ist darum zu klein.`,
      weg: luecke ? { text: ABLESUNG_EINTRAGEN, messstelle: luecke.id } : null,
    });
  }
  if (rest !== null && rest < 0) {
    out.push({
      ton: 'warn',
      satz: `Die Bereiche ergeben ${kwhText(-rest)} mehr als der Hauptzähler – vermutlich ist ein Zähler doppelt zugeordnet.`,
      weg: { text: ZUORDNUNG_PRUEFEN, messstelle: null },
    });
  }
  return out;
}

const zugeordnetTon = (k8: string): 'ok' | 'warn' | 'neutral' =>
  k8 === 'ueber_schwelle' ? 'ok' : k8 === 'unter_schwelle' ? 'warn' : 'neutral';

function hauptzaehlerZeile(r: BewertungRangliste): string {
  const quelle = [...r.einsaetze, ...r.weitere_traeger].find((e) => e.herkunft?.nenner);
  const kennzeichen = [
    ...new Set((quelle?.herkunft.nenner?.bilanzwerte ?? []).flatMap((b) => b.eingaenge.map((x) => x.objekt))),
  ];
  const wer =
    r.nenner.gesamt > 1
      ? `Hauptzähler von ${r.nenner.anlagen} Anlagen`
      : kennzeichen.length === 1
        ? `Hauptzähler ${kennzeichen[0]}`
        : 'Hauptzähler';
  return r.nenner.wert === null ? `${wer} · keine Werte` : `${wer} · ${r.nenner.zustand}`;
}

/** Über zwölf Monate: Menge, Vorjahr, dann der stärkste gegen den schwächsten Monat. */
function zwoelfAntwort(d: VerbrauchDaten, gesamt: number): string {
  const vj = d.vorjahr ? zahl(d.vorjahr.nenner.wert) : null;
  const vergleich = vorjahrImSatz(gesamt, vj, 'im Jahr davor');
  // Ein Gedankenstrich steht nie am Zeilenanfang: davor ein geschütztes Leerzeichen.
  const erster = `In zwölf Monaten ${mengeImSatz(gesamt)} Strom${vergleich ? `${NBSP}– ${vergleich}` : ''}.`;
  const monate = (d.verlauf?.saeulen ?? []).filter((s) => s.wert !== null && s.vollstaendig) as (VerlaufSaeule & { wert: number })[];
  if (monate.length < 2) return erster;
  const hoch = monate.reduce((a, b) => (b.wert > a.wert ? b : a));
  const tief = monate.reduce((a, b) => (b.wert < a.wert ? b : a));
  if (hoch.monat === tief.monat || tief.wert <= 0) return erster;
  const mehr = ((hoch.wert - tief.wert) / tief.wert) * 100;
  if (mehr < 0.5) return `${erster} Jeder Monat brauchte etwa gleich viel.`;
  return `${erster} Der ${monatsName(hoch.monat)} brauchte am meisten, ${prozentGanz(mehr)} mehr als der ${monatsName(tief.monat)}.`;
}

export function verbrauchBild(d: VerbrauchDaten): VerbrauchBild {
  const r = d.rangliste;
  const wann = zeitraumLang(d.zeitraum);
  const gesamt = zahl(r.nenner.wert);
  const rest = zahl(r.rest);
  const abdeckung = zahl(r.abdeckung_prozent);
  const vorjahrGesamt = d.vorjahr ? zahl(d.vorjahr.nenner.wert) : null;
  const sortiert = [...r.einsaetze].sort((a, b) => (einsatzMenge(b) ?? -1) - (einsatzMenge(a) ?? -1));
  const groesste = Math.max(0, ...sortiert.map((e) => einsatzMenge(e) ?? 0), rest !== null && rest > 0 ? rest : 0);
  const balken = (menge: number) => (groesste > 0 ? Math.max(0, Math.min(100, (menge / groesste) * 100)) : 0);

  const bereiche: BereichZeile[] = sortiert.map((e) => {
    const menge = einsatzMenge(e);
    const vj = d.vorjahr ? einsatzMenge([...d.vorjahr.einsaetze, ...d.vorjahr.weitere_traeger].find((x) => x.id === e.id)) : null;
    const vergleich = d.vorjahr && e.zustand === 'vollständig' ? vorjahrVergleich(menge, vj) : null;
    const anteil = zahl(e.anteil_prozent);
    return {
      id: e.id,
      kennzeichen: e.kennzeichen,
      name: e.name,
      wesentlich: d.einstufungen?.get(e.id) ?? null,
      menge,
      mengeText: menge === null ? null : kwhZahl(menge),
      einheit: e.einheit ?? 'kWh',
      anteil: anteil === null ? null : anteilText(anteil),
      balken: menge === null ? null : balken(menge),
      unterzeile: unterzeile(e, d, vergleich),
      marke: reiheMarke(e),
    };
  });

  const restOrt = restSatz(d);
  const restAnteil = zahl(d.abdeckung?.summe.ungemessen_prozent) ?? (abdeckung === null ? null : 100 - abdeckung);
  const restZeile: RestZeile | null =
    rest !== null && rest > 0
      ? {
          menge: rest,
          mengeText: kwhZahl(rest),
          anteil: restAnteil === null ? null : anteilText(restAnteil),
          balken: balken(rest),
          satz: restOrt.satz,
          ort: restOrt.ort,
        }
      : null;

  const top = sortiert.find((e) => einsatzMenge(e) !== null);
  const zugeordnetSatz = abdeckung === null ? null : `${prozentGanz(abdeckung)} des Stroms sind ${UEMS_EINEM_BEREICH_ZUGEORDNET}`;
  let antwort: string | null = null;
  let antwortBreit: string | null = null;
  if (d.zeitraum.art === 'zwoelf' && gesamt !== null) {
    antwort = zwoelfAntwort(d, gesamt);
  } else if (top) {
    const topAnteil = zahl(top.anteil_prozent);
    const kern =
      topAnteil !== null
        ? `${top.name} braucht mit ${prozentGanz(topAnteil)} den größten Teil des Stroms`
        : `${top.name} braucht mit ${kwhText(einsatzMenge(top) ?? 0)} den meisten Strom`;
    antwort = `${kern}.`;
    antwortBreit = zugeordnetSatz ? `${kern}; ${zugeordnetSatz}.` : null;
  }

  const vollstaendigeMonate = d.verlauf ? d.verlauf.saeulen.filter((s) => s.vollstaendig).length : null;
  const datenlage =
    d.zeitraum.art === 'zwoelf'
      ? vollstaendigeMonate !== null
        ? `${vollstaendigeMonate} von 12 Monaten vollständig`
        : null
      : r.einsaetze.length === 0
        ? null
        : r.einsaetze.every((e) => e.zustand === 'vollständig') && r.nenner.zustand === 'vollständig'
          ? 'alle Zähler vollständig'
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
      vorjahr: d.vorjahr && r.nenner.zustand === 'vollständig' ? vorjahrVergleich(gesamt, vorjahrGesamt) : null,
      zugeordnet:
        abdeckung === null ? null : { text: `${prozentGanz(abdeckung)} ${UEMS_EINEM_BEREICH_ZUGEORDNET}`, ton: zugeordnetTon(r.urteil.K8) },
      unterzeile: hauptzaehlerZeile(r),
    },
    hinweise: hinweise(d, rest),
    bereiche,
    rest: restZeile,
    weitere: weitereKarten(d),
    zugeordnetProzent: abdeckung,
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
  wert: number | null;
  vollstaendig: boolean;
  vorjahr: number | null;
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
    jetzt: jetzt.get(monat) ?? { monat, wert: null, vollstaendig: false },
    vj: frueher.get(monatPlus(monat, -12))?.wert ?? null,
  }));
  const max = Math.max(0, ...roh.flatMap((x) => [x.jetzt.wert ?? 0, x.vj ?? 0]));
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
      wert: x.jetzt.wert,
      vollstaendig: x.jetzt.vollstaendig,
      vorjahr: x.vj,
      hoehe: x.jetzt.wert === null ? 0 : hoehe(x.jetzt.wert),
      vorjahrHoehe: x.vj === null ? null : hoehe(x.vj),
    })),
    achse,
  };
}

/** Die Infozeile eines Monats: Wert, Vorjahr und der rohe Vergleich — ohne Urteilsfarbe. */
export function infozeile(s: VerlaufSaeule): { monat: string; wert: string; vorjahr: string | null; vergleich: string | null } {
  const vergleich = s.wert !== null && s.vollstaendig ? vorjahrVergleich(s.wert, s.vorjahr) : null;
  return {
    monat: monatWort(s.monat),
    wert: s.wert === null ? 'keine Werte' : s.vollstaendig ? kwhText(s.wert) : `${kwhText(s.wert)} (unvollständig)`,
    vorjahr: s.vorjahr === null ? null : `Vorjahr ${kwhText(s.vorjahr)}`,
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
  v.saeulen.map((s) => `${monatWort(s.monat)}: ${s.wert === null ? 'keine Werte' : kwhText(s.wert)}${s.vorjahr === null ? '' : `, Vorjahr ${kwhText(s.vorjahr)}`}`);

// ------------------------------------------------------------------ CSV

/** Die Liste als CSV: ungerundet, Dezimalpunkt, ISO-Zeitraum (AP-08 E11) — dieselben Zeilen wie die Fläche. */
export function verbrauchCsv(r: BewertungRangliste): string {
  const zeilen = [['Bereich', 'Kennzeichen', 'Traeger', 'Menge', 'Einheit', 'Anteil_Prozent', 'Zustand', 'Von', 'Bis']];
  for (const e of [...r.einsaetze, ...r.weitere_traeger]) {
    zeilen.push([e.name, e.kennzeichen, e.traeger, e.menge ?? '', e.einheit ?? '', e.anteil_prozent ?? '', e.zustand, r.von, r.bis]);
  }
  if (r.rest !== null) zeilen.push([REST_NAME, '', 'Strom', r.rest, 'kWh', '', r.zustand, r.von, r.bis]);
  if (r.nenner.wert !== null) zeilen.push(['Hauptzähler gesamt', '', 'Strom', r.nenner.wert, 'kWh', '100', r.nenner.zustand, r.von, r.bis]);
  const feld = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return zeilen.map((z) => z.map(feld).join(';')).join('\n');
}
