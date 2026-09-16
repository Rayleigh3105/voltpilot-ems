import type {
  MessstelleRegisterBindung,
  MessstelleRegisterWert,
  MessstelleRegisterZeile,
  MessstellenRegister,
  MessstellenRegisterAnfrage,
  MessstelleVertragsform,
} from './api';
import {
  UEMS_FUEHREND,
  UEMS_FUNKTION_MESSEN,
  UEMS_GERAET,
  UEMS_LEBENSZYKLUS,
  UEMS_MESSSTELLE,
  UEMS_QUELLE,
  UEMS_UNTERNEHMEN,
  UEMS_UNTERZAEHLER_VON,
  UEMS_VERGLEICH,
} from './glossar';
import { bestandSatz, datumText, lokalerTag, type Tag } from './uemsOrtsbaum';

/**
 * Das Messstellen-Register im Portal (UEMS AP-04 IP-5, Bericht §3/§5.11/§5.16,
 * Abnahme A17): „Unternehmen › Messstellen“ und „Standort › Messstellen“.
 *
 * Rein und deterministisch — kein React, kein Netz. Der Server hat JEDE
 * Ableitung schon gemacht (`GET /api/v1/messstellen`, IP-4/IP-15: Ort mit
 * abgeleitetem Standort, Stellung, führende Quelle mit „davor“, Beobachtung,
 * letzter Wert, Aggregat). Hier steht nur, welche WÖRTER die Fläche aus einer
 * Zeile spricht, welche Filter sie anbietet, wann sie leer ist und wie „Stand
 * am …“ eine Messstelle benennt, die es an dem Tag noch nicht gab.
 *
 * ⚠ Keine zweite Abfrage und keine zweite Filter-Regel: die Filter gehen als
 * Parameter an DIESELBE Route (der Ort-Filter schließt dort seinen Teilbaum ein,
 * das Aggregat zählt dort genau die gezeigten Zeilen).
 */

export const TITEL = 'Messstellen';

/** Die Spalten der Tabelle (1440 px) und die Zeilen der Karte (375 px) — dieselben Wörter. */
export const SPALTEN = {
  kennzeichen: 'Kennzeichen',
  name: 'Name',
  ort: 'Ort',
  stellung: 'Elektrische Stellung',
  quelle: `${UEMS_QUELLE} (${UEMS_FUEHREND})`,
  zustand: 'Zustand',
  wert: 'Letzter Wert',
} as const;

/** Mit Stichtag: der Lebenszyklus ist der von HEUTE (der Server verschiebt ihn nicht) — die Spalte sagt es. */
export const ZUSTAND_HEUTE = 'Zustand (heute)';

export const OHNE_ANGABE = '—';
export const VERGLEICHSQUELLE = `${UEMS_VERGLEICH}squelle`;
export const KEINE_DATENQUELLE = 'Keine Datenquelle';
export const BERECHNET_AUS = `Berechnet aus anderen ${TITEL}`;
export const KEIN_ORT = 'Kein Ort zugeordnet';

export const FILTER = {
  standort: 'Standort',
  ort: 'Ort',
  anlage: 'Anlage',
  zustand: 'Zustand',
  alle: 'Alle',
  ohneQuelle: `Nur ohne ${UEMS_QUELLE}`,
  zuruecksetzen: 'Filter zurücksetzen',
} as const;

export const FILTER_OHNE_TREFFER = `Keine ${UEMS_MESSSTELLE} passt zu diesen Filtern.`;
export const LADEN = `Die ${TITEL} werden geladen …`;
export const LADEFEHLER = `Die ${TITEL} konnten nicht geladen werden.`;
export const ERNEUT = 'Erneut versuchen';
export const ZUR_UEBERSICHT = 'Zur Übersicht';

// ───────────────────────────────────────────────────────────── Ebene

/** Wessen Register die Fläche zeigt. */
export type MessstellenEbene =
  | { art: 'unternehmen'; name: string }
  | { art: 'standort'; id: string; name: string };

// ───────────────────────────────────────────────────── Zeile → Wörter

export type Lebenszyklus = MessstelleRegisterZeile['lebenszyklus'];
const LEBENSZYKLEN: Lebenszyklus[] = ['entwurf', 'eingerichtet', 'aktiv', 'angehalten', 'archiviert'];

/** Das Kundenwort je Lebenszyklus (Glossar AP-01 E8, dieselbe Reihenfolge). */
export function lebenszyklusWort(z: Lebenszyklus): string {
  return UEMS_LEBENSZYKLUS[LEBENSZYKLEN.indexOf(z)] ?? z;
}

/** Die Wörter der Pflichtangaben, die einem Entwurf noch fehlen (`uemsMessstelle.FEHLT`). */
const FEHLT_WORT: Record<string, string> = {
  kennzeichen: 'Kennzeichen',
  name: 'Name',
  hauptgroesse: 'Hauptgröße',
  ort: 'Ort',
  formel: 'Formel',
  eingaenge: 'Eingänge',
};

/** Wie der Punkt vor der Beobachtung aussieht — Schweigen ist nie ein Fehlschlag, also nie rot. */
export type Ton = 'gut' | 'hinweis' | 'still';

export interface ZeileWoerter {
  id: string;
  kennzeichen: string;
  name: string;
  ort: { text: string; /** Der Standort darunter — nur im Unternehmen und nur, wenn der Ort nicht selbst der Standort ist. */ standort: string | null };
  /** `null` = an dem Tag keine Stellung („—“). */
  stellung: string | null;
  quelle:
    | { art: 'gebunden'; geraet: string; messwert: string; seit: string; davor: string | null; vergleich: string | null }
    | { art: 'berechnet'; text: string }
    | { art: 'keine_datenquelle'; text: string };
  zustand: string;
  /** Der Satz des Servers (Beobachtung bzw. bei einer berechneten Messstelle ihre Vollständigkeit); `null` = keiner. */
  beobachtung: { text: string; ton: Ton } | null;
  /** Der letzte Wert der HAUPTGRÖSSE; `null` = kein guter Wert — „—“, nie eine 0. */
  wert: { text: string; zeit: string } | null;
  /**
   * Die letzten Werte der Nebengrößen mit Wert („Wirkleistung 312,4 kW“) — die
   * Hauptgröße einer Strom-Messstelle ist meist ein Zählerstand, die Leistung
   * steht als Nebengröße daneben. Ohne Wert keine Zeile.
   */
  nebenwerte: { groesse: string; text: string; zeit: string }[];
}

export interface WortKontext {
  ebene: MessstellenEbene;
  /** Zeitzone des Standorts (bzw. die Vorgabe), in der „seit“ und die Uhrzeit stehen. */
  zone: string;
  /** Der Augenblick der Antwort — liegt der letzte Wert am selben Tag, steht nur die Uhrzeit. */
  zeitpunkt: string;
}

/** „18.11.2026 10:40“ — um 00:00 Uhr nur der Tag („12.03.2024“). */
export function zeitpunktText(iso: string, zone: string, bezug?: string): string {
  const { tag, uhr } = wanduhr(iso, zone);
  if (bezug !== undefined && wanduhr(bezug, zone).tag === tag) return uhr;
  return uhr === '00:00' && bezug === undefined ? tag : `${tag} ${uhr}`;
}

function wanduhr(iso: string, zone: string): { tag: string; uhr: string } {
  const teile = Object.fromEntries(
    new Intl.DateTimeFormat('de-DE', {
      timeZone: zone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((t) => [t.type, t.value]),
  );
  return { tag: `${teile.day}.${teile.month}.${teile.year}`, uhr: `${teile.hour}:${teile.minute}` };
}

/** Stellen je Einheit wie der Ergebnis-Vertrag E11 (kW 1, % 0, m³ 1, kWh 1); sonst bis zu drei. */
const STELLEN: Record<string, number> = { kW: 1, kWh: 1, 'm³': 1, kvar: 1, kvarh: 1, '%': 0 };

/** „312,4 kW“, „−40,0 kW“, „1.240,0 m³“ — Tausenderpunkt, U+2212, U+00A0 vor der Einheit. */
export function wertText(w: MessstelleRegisterWert): string | null {
  if (w.wert === null) return w.text;
  const stellen = w.einheit !== null ? STELLEN[w.einheit] : undefined;
  const zahl = new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: stellen ?? 0,
    maximumFractionDigits: stellen ?? 3,
  })
    .format(w.wert)
    .replace('-', '−');
  return w.einheit ? `${zahl} ${w.einheit}` : zahl;
}

/**
 * Das Gerät einer Bindung wie §5.16 („GR-7 C-1“, „GR-4 Z-5a“): Komponente · Gerät
 * und Einbau, wenn der Einbau ein eigenes Kennzeichen hat. Mit „·“ statt Klammer —
 * viele Komponenten tragen schon eine („Ladepunkt Parkplatz Halle 2 (22 kW)“).
 */
export function geraetText(b: MessstelleRegisterBindung): string {
  const name = b.komponente_name ?? b.geraet.bezeichnung ?? UEMS_GERAET;
  const einbau = b.geraet.einbau && b.geraet.einbau !== b.geraet.geraet ? ` ${b.geraet.einbau}` : '';
  return `${name} · ${b.geraet.geraet}${einbau}`;
}

function vergleichText(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? `1 ${VERGLEICHSQUELLE}` : `${n} ${VERGLEICHSQUELLE}n`;
}

function ortWoerter(z: MessstelleRegisterZeile, ebene: MessstellenEbene): ZeileWoerter['ort'] {
  const o = z.ort;
  switch (o.grund) {
    case 'verortet':
      return {
        text: o.name ?? o.kennzeichen ?? OHNE_ANGABE,
        standort: ebene.art === 'unternehmen' && o.ort_art !== 'standort' ? o.standort_name ?? o.standort : null,
      };
    case 'am_unternehmen':
      return { text: UEMS_UNTERNEHMEN, standort: null };
    case 'ort_nicht_im_baum':
      return { text: `${o.name ?? o.kennzeichen ?? 'Ort'} — an diesem Tag keinem Standort zugeordnet`, standort: null };
    default:
      return { text: KEIN_ORT, standort: null };
  }
}

function stellungText(z: MessstelleRegisterZeile): string | null {
  const s = z.elektrische_stellung;
  if (!s) return null;
  const was =
    s.stellung === 'Unterzähler' && s.unterzaehler_von
      ? `${UEMS_UNTERZAEHLER_VON} ${s.unterzaehler_von}`
      : s.stellung === 'keine'
        ? 'keine Stellung'
        : s.stellung;
  return s.anlage_name ? `${s.anlage_name} · ${was}` : was;
}

function zustandText(z: MessstelleRegisterZeile, zone: string): string {
  if (z.lebenszyklus === 'archiviert' && z.archiviert_am) return `Archiviert am ${zeitpunktText(z.archiviert_am, zone).slice(0, 10)}`;
  if (z.lebenszyklus === 'angehalten' && z.angehalten_ab) return `angehalten seit ${zeitpunktText(z.angehalten_ab, zone)}`;
  const wort = lebenszyklusWort(z.lebenszyklus);
  const fehlt = z.fehlt.map((f) => FEHLT_WORT[f]).filter(Boolean);
  return z.lebenszyklus === 'entwurf' && fehlt.length > 0 ? `${wort} · es fehlt: ${fehlt.join(', ')}` : wort;
}

function beobachtungWoerter(z: MessstelleRegisterZeile): ZeileWoerter['beobachtung'] {
  if (z.art === 'berechnet') {
    if (!z.berechnung) return null;
    return { text: z.berechnung.text, ton: z.berechnung.zustand === 'vollstaendig' ? 'gut' : 'hinweis' };
  }
  const b = z.beobachtung;
  if (!b) return null;
  const ton: Ton = b.zustand === 'liefert' ? 'gut' : b.zustand === 'liefert_nicht_seit' ? 'hinweis' : 'still';
  return { text: b.text, ton };
}

/**
 * Prüfnachweis 1 · aus einer Registerzeile werden die Kundenwörter: Kennzeichen,
 * Name, Ort (mit Standort im Unternehmen), Stellung, Quelle („führend seit …“,
 * „davor …“, Vergleichsquellen), Zustand, Beobachtung und letzter Wert.
 */
export function zeileWoerter(z: MessstelleRegisterZeile, k: WortKontext): ZeileWoerter {
  const q = z.quelle;
  const quelle: ZeileWoerter['quelle'] =
    q.stand === 'berechnet'
      ? { art: 'berechnet', text: BERECHNET_AUS }
      : q.stand === 'gebunden' && q.fuehrend
        ? {
            art: 'gebunden',
            geraet: geraetText(q.fuehrend),
            messwert: q.fuehrend.kanal_name ?? q.fuehrend.kanal,
            seit: `${UEMS_FUEHREND} seit ${zeitpunktText(q.fuehrend.gueltig_ab, k.zone)}`,
            davor: q.davor ? `davor ${q.davor.geraet.einbau}` : null,
            vergleich: vergleichText(q.vergleichsquellen),
          }
        : { art: 'keine_datenquelle', text: KEINE_DATENQUELLE };
  const w = z.letzter_wert;
  const text = w ? wertText(w) : null;
  return {
    id: z.id,
    kennzeichen: z.kennzeichen,
    name: z.name ?? `${UEMS_MESSSTELLE} ohne Namen`,
    ort: ortWoerter(z, k.ebene),
    stellung: stellungText(z),
    quelle,
    zustand: zustandText(z, k.zone),
    beobachtung: beobachtungWoerter(z),
    wert: w && text !== null ? { text, zeit: `${zeitpunktText(w.zeitpunkt, k.zone, k.zeitpunkt)} Uhr` } : null,
    nebenwerte: (z.nebengroessen ?? []).flatMap((n) => {
      const nt = n.letzter_wert ? wertText(n.letzter_wert) : null;
      return n.letzter_wert && nt !== null
        ? [{ groesse: n.groesse.groesse, text: nt, zeit: `${zeitpunktText(n.letzter_wert.zeitpunkt, k.zone, k.zeitpunkt)} Uhr` }]
        : [];
    }),
  };
}

// ─────────────────────────────────────────────────────── „Stand am …“

/**
 * Der erste Tag, an dem die Messstelle eine zeitgültige Tatsache trägt — Ort,
 * Stellung oder eine Quelle (auch einer Nebengröße). `null` = keine: dann gibt
 * es keinen Beleg für „noch nicht“, und die Zeile steht wie jede andere da.
 */
export function ersterTag(m: MessstelleVertragsform, zone: string): Tag | null {
  const tage: Tag[] = [
    ...(m.orte ?? []).map((i) => i.gueltig_ab),
    ...(m.elektrische_stellung ?? []).map((i) => i.gueltig_ab),
  ];
  const quellen = [
    ...(m.fuehrende_quelle ?? []),
    ...(m.vergleichsquellen ?? []),
    ...(m.nebengroessen ?? []).flatMap((n) => [...(n.fuehrende_quelle ?? []), ...(n.vergleichsquellen ?? [])]),
  ];
  for (const b of quellen) tage.push(b.gueltig_ab.length > 10 ? lokalerTag(b.gueltig_ab, zone) : b.gueltig_ab);
  return tage.length === 0 ? null : tage.reduce((a, b) => (b < a ? b : a));
}

export type RegisterEintrag =
  | { art: 'messstelle'; woerter: ZeileWoerter }
  /** Gab es am Stichtag noch nicht: an ihrem Platz benannt (Satz wie auf der Liste „Standorte“), nie weggelassen. */
  | { art: 'gab_es_noch_nicht'; id: string; kennzeichen: string; name: string; satz: string };

/**
 * Prüfnachweis 3 · die Einträge der Liste in der Reihenfolge des Servers (nach
 * Kennzeichen — eine Zeile springt nicht, wenn der Tag wechselt). Mit Stichtag
 * wird jede Messstelle, deren erster Tag danach liegt, mit dem Satz „Am … gab es
 * … im Portal noch nicht.“ benannt; ihre Zeile dieses Tages (ohne Ort, ohne
 * Quelle) wäre eine falsche Aussage.
 */
export function registerEintraege(antwort: MessstellenRegister, stichtag: Tag | null, k: WortKontext): RegisterEintrag[] {
  const vertrag = new Map((antwort.messstellen ?? []).map((m) => [m.id, m]));
  return antwort.register.map((z) => {
    const m = vertrag.get(z.id);
    const erster = stichtag && m ? ersterTag(m, k.zone) : null;
    if (stichtag && erster && stichtag < erster) {
      const name = z.name ?? `${UEMS_MESSSTELLE} ohne Namen`;
      return {
        art: 'gab_es_noch_nicht',
        id: z.id,
        kennzeichen: z.kennzeichen,
        name,
        satz: bestandSatz('gab_es_noch_nicht', `${z.kennzeichen} „${name}“`, stichtag),
      };
    }
    return { art: 'messstelle', woerter: zeileWoerter(z, k) };
  });
}

/** Die Unterzeile des Kopfs: „14 von 17 Messstellen liefern Daten“ — nur heute (mit Stichtag spricht das Banner). */
export function kopfZeile(antwort: MessstellenRegister | null, stichtag: Tag | null): string | null {
  if (!antwort || stichtag || antwort.register.length === 0) return null;
  return antwort.aggregat?.unternehmen?.text ?? null;
}

// ───────────────────────────────────────────────────────────── Filter

export interface RegisterFilter {
  standort: string | null;
  ort: string | null;
  anlage: string | null;
  zustand: Lebenszyklus | null;
  ohneQuelle: boolean;
}

export const OHNE_FILTER: RegisterFilter = { standort: null, ort: null, anlage: null, zustand: null, ohneQuelle: false };

/**
 * UEMS AP-13 IP-10: der Ort-Filter aus der Adresse (`#/standort/{id}/messstellen?ort=G-2`) — damit springt die
 * Gebäude-Karte in GENAU dieses gefilterte Register. In der Adresse steht das Kurzzeichen (lesbar, als Lesezeichen
 * haltbar); die Auswahlliste der Filterleiste führt Orte über ihre ID — {@link ortSchluessel} bringt beides zusammen.
 */
export const ortAus = (hash: string): string | null =>
  new URLSearchParams(hash.split('?').slice(1).join('?')).get('ort')?.trim() || null;

/**
 * Das Kurzzeichen aus der Adresse auf den Schlüssel der Auswahlliste bringen (die ID des Orts). Kennt die Antwort das
 * Kurzzeichen nicht, bleibt es, wie es kam — die Route nimmt beides an, und ein unbekannter Ort liefert eine leere
 * Liste statt einer stillen Vollansicht.
 */
export const ortSchluessel = (basis: MessstellenRegister, ort: string): string =>
  basis.register.find((z) => z.ort.kennzeichen === ort)?.ort.id ?? ort;

export function filterAktiv(f: RegisterFilter): boolean {
  return f.standort !== null || f.ort !== null || f.anlage !== null || f.zustand !== null || f.ohneQuelle;
}

/** Die Parameter der EINEN Abfrage: „Standort › Messstellen“ fragt immer mit seinem Standort. */
export function registerAnfrage(ebene: MessstellenEbene, f: RegisterFilter, stichtag: Tag | null): MessstellenRegisterAnfrage {
  const standort = ebene.art === 'standort' ? ebene.id : f.standort;
  return {
    ...(standort ? { standort } : {}),
    ...(f.ort ? { ort: f.ort } : {}),
    ...(f.anlage ? { anlage: f.anlage } : {}),
    ...(f.zustand ? { zustand: f.zustand } : {}),
    ...(f.ohneQuelle ? { ohneQuelle: true } : {}),
    ...(stichtag ? { stichtag } : {}),
  };
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterOptionen {
  /** Nur im Unternehmen. */
  standorte: FilterOption[];
  /** Gebäude und Bereiche, an denen Messstellen stehen (Teilbaum filtert der Server). */
  orte: FilterOption[];
  anlagen: FilterOption[];
  zustaende: FilterOption[];
  /** Gemessene Messstellen ohne führende Quelle — die Zahl am Schalter. */
  ohneQuelle: number;
  /** Gemessene Messstellen überhaupt — der Nenner von „Alle … haben eine Quelle.“ */
  gemessen: number;
  berechnet: number;
}

const nachZiffern = (a: string, b: string) => a.localeCompare(b, 'de-DE', { numeric: true });

/**
 * Was die Filter anbieten — aus der UNGEFILTERTEN Antwort desselben Tags (die
 * Basis), damit eine Wahl die anderen Listen nicht leert. Nur, was vorkommt:
 * ein Zustand ohne Messstelle ist keine Wahl.
 */
export function filterOptionen(basis: MessstellenRegister, ebene: MessstellenEbene): FilterOptionen {
  const standorte = new Map<string, FilterOption & { kz: string }>();
  const orte = new Map<string, FilterOption & { schluessel: string }>();
  const anlagen = new Map<string, FilterOption>();
  const zustaende = new Set<Lebenszyklus>();
  let ohneQuelle = 0;
  let gemessen = 0;
  for (const z of basis.register) {
    const o = z.ort;
    if (ebene.art === 'unternehmen' && o.grund === 'verortet' && o.standort_id) {
      standorte.set(o.standort_id, { value: o.standort_id, label: o.standort_name ?? o.standort ?? OHNE_ANGABE, kz: o.standort ?? '' });
    }
    if (o.grund === 'verortet' && o.id && (o.ort_art === 'gebaeude' || o.ort_art === 'bereich')) {
      const unter = ebene.art === 'unternehmen' && o.standort_name ? ` · ${o.standort_name}` : '';
      orte.set(o.id, { value: o.id, label: `${o.name ?? o.kennzeichen}${unter}`, schluessel: [...o.pfad].reverse().join('/') });
    }
    const s = z.elektrische_stellung;
    if (s) anlagen.set(s.anlage, { value: s.anlage, label: s.anlage_name ?? OHNE_ANGABE });
    zustaende.add(z.lebenszyklus);
    if (z.art === 'gemessen') {
      gemessen += 1;
      if (z.quelle.stand === 'keine_datenquelle') ohneQuelle += 1;
    }
  }
  return {
    standorte: [...standorte.values()].sort((a, b) => nachZiffern(a.kz, b.kz)).map(({ value, label }) => ({ value, label })),
    orte: [...orte.values()].sort((a, b) => nachZiffern(a.schluessel, b.schluessel)).map(({ value, label }) => ({ value, label })),
    anlagen: [...anlagen.values()].sort((a, b) => nachZiffern(a.label, b.label)),
    zustaende: LEBENSZYKLEN.filter((z) => zustaende.has(z)).map((z) => ({ value: z, label: lebenszyklusWort(z) })),
    ohneQuelle,
    gemessen,
    berechnet: basis.register.length - gemessen,
  };
}

// ──────────────────────────────────────────────────────── Leerzustände

export type Leerzustand =
  /** §5.11: ohne „Messen & Auswerten“ gibt es den Bereich nicht — Weg über die Übersicht (Karte „Funktionen“). */
  | { art: 'bereich_fehlt'; satz: string }
  /** §5.11: eingerichtet, noch keine Messstelle. */
  | { art: 'keine_messstelle'; satz: string }
  /** Filter ohne Treffer — „Filter zurücksetzen“. */
  | { art: 'filter_ohne_treffer'; satz: string }
  /** §5.11: „ohne Quelle“ ohne Treffer. */
  | { art: 'alle_mit_quelle'; satz: string };

/**
 * Prüfnachweis 3 · der Leerzustand der Fläche, oder `null`, solange es etwas zu
 * zeigen gibt. `bereichDa` = ob die Ebene den Bereich „Messstellen“ hat
 * (`ebenenNav.ebenenBereiche`); `null` = unbekannt, dann nie „gibt es nicht“.
 */
export function leerzustand(i: {
  antwort: MessstellenRegister;
  basis: MessstellenRegister | null;
  filter: RegisterFilter;
  ebene: MessstellenEbene;
  bereichDa: boolean | null;
}): Leerzustand | null {
  if (i.antwort.register.length > 0) return null;
  const f = i.filter;
  if (filterAktiv(f)) {
    const nurOhneQuelle = f.ohneQuelle && !f.standort && !f.ort && !f.anlage && !f.zustand;
    const o = i.basis ? filterOptionen(i.basis, i.ebene) : null;
    if (nurOhneQuelle && o && o.gemessen > 0) {
      const art = o.berechnet > 0 ? 'gemessenen ' : '';
      const satz =
        o.gemessen === 1
          ? `Die ${art ? 'gemessene ' : ''}${UEMS_MESSSTELLE} hat eine ${UEMS_QUELLE}.`
          : `Alle ${o.gemessen} ${art}${TITEL} haben eine ${UEMS_QUELLE}.`;
      return { art: 'alle_mit_quelle', satz };
    }
    return { art: 'filter_ohne_treffer', satz: FILTER_OHNE_TREFFER };
  }
  if (i.bereichDa === false) {
    return {
      art: 'bereich_fehlt',
      satz:
        i.ebene.art === 'unternehmen'
          ? `${TITEL} gibt es, sobald ein Standort „${UEMS_FUNKTION_MESSEN}“ eingerichtet hat.`
          : `${TITEL} gibt es in ${i.ebene.name}, sobald dort „${UEMS_FUNKTION_MESSEN}“ eingerichtet ist.`,
    };
  }
  return { art: 'keine_messstelle', satz: `Noch keine ${UEMS_MESSSTELLE} in ${i.ebene.name}.` };
}

/** Der Banner-Tag als Text — für Prüfungen und die Vorschau. */
export const tagText = datumText;
