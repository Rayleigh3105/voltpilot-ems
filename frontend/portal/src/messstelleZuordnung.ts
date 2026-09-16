/**
 * Die Messstellen-Seite (UEMS AP-04 IP-8, Mockups R2 · Z4) — die reine Hälfte. Drei
 * Zuordnungs-Karten (Ort · Elektrisch · Organisation), „Ändern ab <Tag>“ mit den Kennzeichen
 * „rückwirkend“ und „geplant“, die Historie je Karte. Rein: keine Netzzugriffe, keine Uhr, kein
 * React; `pages/MessstelleSeite.tsx` und `components/ZuordnungAendernDialog.tsx` rendern nur, was
 * hier entschieden wird.
 *
 * ⚠ KEINE ZWEITE REGEL-LOGIK. Ob ein Tag rückwirkend, ab heute oder geplant ist, sagt der Zwilling
 * des Ortsbaum-Vertrags (`rueckwirkung`, am Eintragstag heute in der Zeitzone des Standorts —
 * dieselbe Regel wie der Server); der Zustand eines Abschnitts kommt aus `zuordnungZustand`; die
 * 100 % der Verteilung prüft `uemsVerteilung.satz`; die Ablehnungen von Ort und Stellung spricht
 * `messstelleDialog.ablehnung` (FEHLER-Tabelle §5.12). Hauptzähler, Zyklus und Überlappung
 * urteilt der Server an jedem Tag.
 *
 * ⚠ ZWEI LISTEN, ZWEI ORDNUNGEN. Die HISTORIE einer Karte ist der Zeitstrahl des Sachverhalts —
 * lückenlose, nicht überlappende Abschnitte, der jüngste Beginn oben; eine Eintragungszeit tragen
 * die Intervalle nicht. Das ÄNDERUNGSPROTOKOLL listet die Einträge nach dem Zeitpunkt der
 * EINTRAGUNG ({@link MESSSTELLE_PROTOKOLL_ACHSE}, Captain-Entscheid 15.09.2026: sonst rutscht ein
 * nachgetragener Eintrag zwischen alte Zeilen und verschwindet); „gilt ab“ steht an jeder Zeile.
 */
import type {
  Kostenstelle,
  Messstelle,
  MessstelleOrtAendern,
  MessstelleOrtZuordnung,
  MessstelleProzessZuordnung,
  MessstelleRegisterZeile,
  MessstelleStellung,
  MessstelleStellungAendern,
  MessstelleStellungZuordnung,
  MessstelleVerteilungAnteil,
  OrtsbaumAmStichtag,
  OrtsbaumBereich,
  Prozess,
  StandorteAmStichtag,
  VerteilungZeileEingabe,
} from './api';
import { dez, dezText } from './dez';
import { dezKuerze } from './uemsBilanz';
import {
  UEMS_KOSTENSTELLE,
  UEMS_MESSSTELLE,
  UEMS_PROZESS,
  UEMS_UNTERNEHMEN,
  UEMS_UNTERZAEHLER_VON,
} from './glossar';
import { ablehnung, PFLICHT, SATZ_ALLGEMEIN, tagHinweis } from './messstelleDialog';
import { KEIN_ORT } from './messstellen';
import type { VpOption } from './picker/optionen';
import { datumText, mitternacht, plusTage, rueckwirkung, zuordnungZustand, type Tag } from './uemsOrtsbaum';
import { FEHLER_ANTEIL, FEHLER_SUMME, FEHLER_ZIEL, NICHT_VERTEILT, satz as verteilungSatz } from './uemsVerteilung';

// -------------------------------------------------------------------- Wörter

export const ZUR_LISTE = 'Alle Messstellen';
export const BEARBEITEN = 'Bearbeiten';
export const LADEFEHLER = 'Die Messstelle konnte nicht geladen werden.';
export const NICHT_GEFUNDEN = 'Diese Messstelle gibt es nicht — oder sie gehört zu einem Standort, den Sie nicht sehen.';
export const ERNEUT = 'Erneut versuchen';
export const NICHT_ABRUFBAR = 'Gerade nicht abrufbar.';

export const KARTE = { ort: 'Ort', elektrisch: 'Elektrisch', organisation: 'Organisation' } as const;
export const AENDERN_AB = 'Ändern ab …';
export const HISTORIE = 'Historie';
export const WAS_GESCHIEHT = 'Was geschieht';
export const BISHER = 'Bisher';
export const GILT_AB = 'Gilt ab *';

/** Das Kennzeichen eines Abschnitts, der erst in der Zukunft beginnt (Z4). */
export const MARKE_GEPLANT = 'geplant';
/** Das Kennzeichen des Abschnitts, der heute gilt — in der Historie. */
export const MARKE_HEUTE = 'gilt heute';

/** Die Protokoll-Achse der Seite: nach der EINTRAGUNG (Captain-Entscheid 15.09.2026). */
export const MESSSTELLE_PROTOKOLL_ACHSE = 'eintrag' as const;

export type AendernArt = 'ort' | 'stellung' | 'prozesse' | 'verteilung';

export const AENDERN_TITEL: Record<AendernArt, string> = {
  ort: 'Ort ändern',
  stellung: 'Elektrische Stellung ändern',
  prozesse: 'Prozesse ändern',
  verteilung: 'Kostenstellen ändern',
};

const WAS: Record<AendernArt, string> = {
  ort: 'Ort',
  stellung: 'Elektrische Stellung',
  prozesse: 'Prozesse',
  verteilung: 'Verteilung',
};

export const LEER: Record<AendernArt, string> = {
  ort: KEIN_ORT,
  stellung: 'Keine elektrische Stellung',
  prozesse: 'Keinem Prozess zugeordnet',
  verteilung: NICHT_VERTEILT,
};

export const SATZ = {
  ortFehlt: 'Bitte wählen Sie den neuen Ort.',
  kostenstelleFehlt: 'Bitte wählen Sie die Kostenstelle — oder entfernen Sie die Zeile.',
  kostenstelleDoppelt: 'Diese Kostenstelle steht schon in der Liste.',
  anteilFormat: 'Ein Anteil ist eine Zahl über 0 bis 100 mit höchstens einer Nachkommastelle, z. B. 33,5.',
} as const;

/** „Am 01.03.2027 gilt schon Halle 2 Montage.“ — dann gibt es nichts einzutragen. */
export function unveraendertSatz(tag: Tag, was: string): string {
  return `Am ${datumText(tag)} gilt schon: ${was}. Es gibt nichts zu ändern.`;
}

/** FEHLER-Tabelle §5.12: „Die Anteile ergeben 90 %. Sie müssen 100 % ergeben.“ */
export function summeSatz(summe: string): string {
  return `Die Anteile ergeben ${prozentText(summe)}. Sie müssen ${prozentText('100')} ergeben.`;
}

export function zielFehltSatz(kostenstelle: string, tag: Tag): string {
  return `Die Kostenstelle ${kostenstelle} besteht am ${datumText(tag)} nicht. Wählen Sie eine andere.`;
}

/** „Ort ab 01.03.2027 eintragen“ (Z4) — ohne Tag nur „Eintragen“. */
export function eintragenKnopf(art: AendernArt, tag: string): string {
  return TAG.test(tag) ? `${WAS[art]} ab ${datumText(tag)} eintragen` : 'Eintragen';
}

/** Nach dem Speichern, an der Karte: „Ort ab 01.03.2027 eingetragen · geplant.“ */
export function gespeichertSatz(art: AendernArt, tag: Tag, heute: Tag, zone: string): string {
  const z = zeitformAm(tag, heute, zone);
  return `${WAS[art]} ab ${datumText(tag)} eingetragen${z?.marke ? ` · ${z.marke}` : ''}.`;
}

const TAG = /^\d{4}-\d{2}-\d{2}$/;

/** „70 %“, „33,5 %“ — mit geschütztem Leerzeichen, Komma als Dezimalzeichen. */
export function prozentText(anteil: string): string {
  return `${anteil.replace('.', ',')} %`;
}

// -------------------------------------------------------------------- Kopf

export interface Kopf {
  titel: string;
  kennzeichen: string;
  /** „Strom · Wirkenergie · Bezug · Zählerstand“ */
  unter: string;
}

export function kopf(m: Messstelle): Kopf {
  const g = m.hauptgroesse;
  return {
    titel: m.name ?? `${UEMS_MESSSTELLE} ohne Namen`,
    kennzeichen: m.kennzeichen,
    unter: [m.medium, g?.groesse, g?.richtung, g?.wertart].filter((t): t is string => Boolean(t)).join(' · '),
  };
}

/** Eine archivierte Messstelle bekommt keine neue Zuordnung (der Server: 422 `messstelle_archiviert`). */
export function aenderbar(m: Messstelle): boolean {
  return m.lebenszyklus !== 'archiviert';
}

// -------------------------------------------------------------------- Namen

export interface OrtName {
  name: string;
  kurzzeichen: string;
  /** „Halle 1 · Werk Ahrenberg“ — was darüber hängt; `null` am Standort und am Unternehmen. */
  ueber: string | null;
}

/** Die Namen, die die Seite aus den geladenen Standorten, Ortsbäumen und dem Register kennt. */
export interface Namen {
  ort: (kurzzeichen: string) => OrtName | null;
  anlage: (id: string) => string | null;
  messstelle: (kennzeichen: string) => string | null;
}

/**
 * Jeder Ort mit Namen — auch ein archivierter: die Historie nennt Orte, die es heute nicht mehr
 * gibt. Was die Seite nicht kennt, bleibt `null`; die Wörter nennen dann das Kennzeichen.
 */
export function namenAus(
  standorte: StandorteAmStichtag | null,
  baeume: Readonly<Record<string, OrtsbaumAmStichtag | undefined>>,
  register: readonly MessstelleRegisterZeile[],
): Namen {
  const orte = new Map<string, OrtName>();
  const anlagen = new Map<string, string>();
  for (const s of [...(standorte?.standorte ?? []), ...(standorte?.nichtGezeigt ?? [])]) {
    orte.set(s.kurzzeichen, { name: s.name, kurzzeichen: s.kurzzeichen, ueber: null });
    for (const a of s.anlagen) anlagen.set(a.id, a.name);
    const baum = baeume[s.id];
    if (!baum) continue;
    const bereich = (b: OrtsbaumBereich, ueber: string) =>
      orte.set(b.kurzzeichen, { name: b.name, kurzzeichen: b.kurzzeichen, ueber });
    for (const g of baum.gebaeude) {
      orte.set(g.kurzzeichen, { name: g.name, kurzzeichen: g.kurzzeichen, ueber: s.name });
      for (const b of g.bereiche) bereich(b, `${g.name} · ${s.name}`);
    }
    for (const b of baum.direktAmStandort?.bereiche ?? []) bereich(b, s.name);
  }
  for (const a of standorte?.nochNichtZugeordnet?.anlagen ?? []) anlagen.set(a.id, a.name);
  const messstellen = new Map(register.map((r) => [r.kennzeichen, r.name]));
  return {
    ort: (kz) => (kz === 'U' ? { name: UEMS_UNTERNEHMEN, kurzzeichen: 'U', ueber: null } : (orte.get(kz) ?? null)),
    anlage: (id) => anlagen.get(id) ?? null,
    messstelle: (kz) => messstellen.get(kz) ?? null,
  };
}

// -------------------------------------------------------------------- Abschnitte

interface Tagesintervall {
  gueltig_ab: Tag;
  gueltig_bis: Tag | null;
}

/** Ein Stück Zeit, in dem dieselben Zuordnungen gelten; `teile` leer = eine Lücke. */
export interface Abschnitt<T> {
  ab: Tag;
  bis: Tag | null;
  teile: T[];
}

const deckt = (x: Tagesintervall, tag: Tag) => x.gueltig_ab <= tag && (x.gueltig_bis === null || x.gueltig_bis >= tag);

/**
 * Die Intervalle eines Sachverhalts als lückenloser Zeitstrahl: an jedem Beginn und jedem Tag nach
 * einem Ende ein neuer Abschnitt, gleiche Nachbarn verschmolzen. Eine Lücke ZWISCHEN zwei
 * Abschnitten bleibt stehen (nie aufgefüllt); nach dem letzten Ende gibt es keinen Abschnitt.
 */
export function abschnitte<T extends Tagesintervall>(xs: readonly T[], schluessel: (x: T) => string): Abschnitt<T>[] {
  const grenzen = [
    ...new Set(xs.flatMap((x) => (x.gueltig_bis === null ? [x.gueltig_ab] : [x.gueltig_ab, plusTage(x.gueltig_bis, 1)]))),
  ].sort();
  const menge = (teile: T[]) => teile.map(schluessel).sort().join(' ');
  const out: Abschnitt<T>[] = [];
  grenzen.forEach((ab, i) => {
    const naechste = grenzen[i + 1];
    const teile = xs.filter((x) => deckt(x, ab));
    const bis = naechste ? plusTage(naechste, -1) : null;
    const vorige = out[out.length - 1];
    if (vorige && menge(vorige.teile) === menge(teile)) {
      vorige.bis = bis;
      return;
    }
    out.push({ ab, bis, teile });
  });
  while (out.length && out[out.length - 1].teile.length === 0) out.pop();
  return out;
}

// -------------------------------------------------------------------- Karten

export type HistorieZustand = 'gueltig' | 'geplant' | 'beendet';

export interface HistorieZeile {
  schluessel: string;
  wert: string;
  neben: string | null;
  /** „seit 12.03.2024“ · „12.03.2024 bis 28.02.2027“ · „ab 01.03.2027“ */
  zeitraum: string;
  zustand: HistorieZustand;
  /** „gilt heute“ · „geplant“ · `null` */
  marke: string | null;
}

export interface Stand {
  wert: string;
  neben: string | null;
  /** „seit 12.03.2024“ — mit einem eingetragenen Ende „seit 12.03.2024 · endet 28.02.2027“. */
  zeitraum: string;
}

export interface KartenZeile {
  art: AendernArt;
  /** Innerhalb von „Organisation“: „Prozess“ bzw. „Kostenstelle“; sonst `null`. */
  titel: string | null;
  /** Was HEUTE gilt; `null` = heute nichts ({@link leer}). */
  heute: Stand | null;
  leer: string | null;
  /** Die nächste eingetragene Änderung: „ab 01.03.2027: Halle 2 Montage“ mit „geplant“. */
  danach: { text: string; marke: string } | null;
  /** Der Zeitstrahl, der jüngste Beginn oben. */
  historie: HistorieZeile[];
  /** `false`, wenn die Zuordnungen nicht geladen werden konnten — dann kein „Ändern ab …“. */
  geladen: boolean;
}

export interface ZuordnungsKarte {
  art: keyof typeof KARTE;
  titel: string;
  zeilen: KartenZeile[];
}

interface Woerter {
  wert: string;
  neben: string | null;
}

function zeitraumText(ab: Tag, bis: Tag | null, heute: Tag): string {
  if (bis !== null) return `${datumText(ab)} bis ${datumText(bis)}`;
  return ab > heute ? `ab ${datumText(ab)}` : `seit ${datumText(ab)}`;
}

function kartenZeile<T extends Tagesintervall>(e: {
  art: AendernArt;
  titel: string | null;
  xs: readonly T[] | null;
  schluessel: (x: T) => string;
  woerter: (teile: T[]) => Woerter;
  heute: Tag;
}): KartenZeile {
  if (e.xs === null) {
    return { art: e.art, titel: e.titel, heute: null, leer: NICHT_ABRUFBAR, danach: null, historie: [], geladen: false };
  }
  const leer = LEER[e.art];
  const text = (teile: T[]): Woerter => (teile.length ? e.woerter(teile) : { wert: leer, neben: null });
  const liste = abschnitte(e.xs, e.schluessel);
  const historie = liste
    .map((a): HistorieZeile => {
      const zustand = zuordnungZustand({ ab: a.ab, bis: a.bis, eltern: null }, e.heute) as HistorieZustand;
      return {
        schluessel: a.ab,
        ...text(a.teile),
        zeitraum: zeitraumText(a.ab, a.bis, e.heute),
        zustand,
        marke: zustand === 'geplant' ? MARKE_GEPLANT : zustand === 'gueltig' ? MARKE_HEUTE : null,
      };
    })
    .reverse();
  const jetzt = liste.find((a) => a.teile.length > 0 && a.ab <= e.heute && (a.bis === null || a.bis >= e.heute));
  const naechster = liste.find((a) => a.ab > e.heute);
  return {
    art: e.art,
    titel: e.titel,
    heute: jetzt
      ? {
          ...text(jetzt.teile),
          zeitraum: [`seit ${datumText(jetzt.ab)}`, jetzt.bis ? `endet ${datumText(jetzt.bis)}` : null]
            .filter(Boolean)
            .join(' · '),
        }
      : null,
    leer: jetzt ? null : leer,
    danach: naechster ? { text: `ab ${datumText(naechster.ab)}: ${text(naechster.teile).wert}`, marke: MARKE_GEPLANT } : null,
    historie,
    geladen: true,
  };
}

const ortSchluessel = (o: MessstelleOrtZuordnung) => o.kennzeichen;
const stellungSchluessel = (s: MessstelleStellungZuordnung) => `${s.anlage}|${s.stellung}|${s.unterzaehler_von ?? ''}`;
const prozessSchluessel = (p: MessstelleProzessZuordnung) => p.prozess.id;
const anteilSchluessel = (a: MessstelleVerteilungAnteil) => `${a.kostenstelle.id}|${normalAnteil(a.anteil_prozent)}`;

function ortWoerter(namen: Namen) {
  return (teile: MessstelleOrtZuordnung[]): Woerter => {
    const n = namen.ort(teile[0].kennzeichen);
    return { wert: n?.name ?? teile[0].kennzeichen, neben: n?.ueber ?? null };
  };
}

/** „Unterzähler von MS-01“ · „Hauptzähler“ · „keine Stellung“ — wie im Register. */
export function stellungWort(s: Pick<MessstelleStellungZuordnung, 'stellung' | 'unterzaehler_von'>): string {
  if (s.stellung === 'Unterzähler' && s.unterzaehler_von) return `${UEMS_UNTERZAEHLER_VON} ${s.unterzaehler_von}`;
  return s.stellung === 'keine' ? 'keine Stellung' : s.stellung;
}

function stellungWoerter(namen: Namen) {
  return (teile: MessstelleStellungZuordnung[]): Woerter => ({
    wert: stellungWort(teile[0]),
    neben: namen.anlage(teile[0].anlage),
  });
}

const nachKennzeichen = <T>(k: (x: T) => string) => (a: T, b: T) =>
  k(a).localeCompare(k(b), 'de-DE', { numeric: true });

function prozessWoerter(teile: MessstelleProzessZuordnung[]): Woerter {
  return {
    wert: [...teile]
      .sort(nachKennzeichen((p) => p.prozess.kennzeichen))
      .map((p) => p.name)
      .join(', '),
    neben: null,
  };
}

function anteilWoerter(teile: MessstelleVerteilungAnteil[]): Woerter {
  return {
    wert: [...teile]
      .sort(nachKennzeichen((a) => a.kostenstelle.kennzeichen))
      .map((a) => `${a.kostenstelle.kennzeichen} ${a.name} · ${prozentText(normalAnteil(a.anteil_prozent))}`)
      .join(', '),
    neben: null,
  };
}

/** Karte „Ort“ (R2): der Ort heute, wo er hängt, seit wann — und die Historie. */
export function ortKarte(m: Messstelle, heute: Tag, namen: Namen): ZuordnungsKarte {
  return {
    art: 'ort',
    titel: KARTE.ort,
    zeilen: [
      kartenZeile({ art: 'ort', titel: null, xs: m.orte ?? [], schluessel: ortSchluessel, woerter: ortWoerter(namen), heute }),
    ],
  };
}

/** Karte „Elektrisch“ (R2): Stellung und Anlage heute — und die Historie. */
export function elektrischKarte(m: Messstelle, heute: Tag, namen: Namen): ZuordnungsKarte {
  return {
    art: 'elektrisch',
    titel: KARTE.elektrisch,
    zeilen: [
      kartenZeile({
        art: 'stellung',
        titel: null,
        xs: m.elektrische_stellung ?? [],
        schluessel: stellungSchluessel,
        woerter: stellungWoerter(namen),
        heute,
      }),
    ],
  };
}

/**
 * Karte „Organisation“ (R2): Prozess und Kostenstelle, je mit eigenem „Ändern ab …“ und eigener
 * Historie. `null` = nicht geladen.
 */
export function organisationKarte(
  prozesse: readonly MessstelleProzessZuordnung[] | null,
  anteile: readonly MessstelleVerteilungAnteil[] | null,
  heute: Tag,
): ZuordnungsKarte {
  return {
    art: 'organisation',
    titel: KARTE.organisation,
    zeilen: [
      kartenZeile({ art: 'prozesse', titel: UEMS_PROZESS, xs: prozesse, schluessel: prozessSchluessel, woerter: prozessWoerter, heute }),
      kartenZeile({
        art: 'verteilung',
        titel: UEMS_KOSTENSTELLE,
        xs: anteile,
        schluessel: anteilSchluessel,
        woerter: anteilWoerter,
        heute,
      }),
    ],
  };
}

// -------------------------------------------------------------------- Zeitform

export interface Zeitform {
  art: 'rueckwirkend' | 'ab_heute' | 'geplant';
  /** „rückwirkend (19 Tage)“ · „geplant“ · `null` (ab heute braucht kein Kennzeichen) */
  marke: string | null;
  /** Unter dem Datumsfeld: „rückwirkend ab 01.10.2026“ · „geplant ab 01.03.2027“ · „ab heute“ */
  hinweis: string | null;
  /** Die Tage, die NACHTRÄGLICH anders gelten (nur rückwirkend). */
  betroffen: { von: Tag; bis: Tag } | null;
}

/**
 * Was der gewählte Tag bedeutet — am Eintragstag HEUTE in der Zeitzone des Standorts, über den
 * Zwilling des Ortsbaum-Vertrags (A2/A3: „rückwirkend (n Tage)“). `null` ohne gültigen Tag.
 */
export function zeitformAm(tag: string, heute: Tag, zone: string): Zeitform | null {
  if (!TAG.test(tag)) return null;
  const r = rueckwirkung({ eingetragenUm: mitternacht(heute, zone).iso, giltAb: tag, giltBis: null, zeitzone: zone });
  return {
    art: r.art,
    marke: r.art === 'rueckwirkend' ? r.abzeichen : r.art === 'geplant' ? MARKE_GEPLANT : null,
    hinweis: tagHinweis(tag, heute),
    betroffen: r.rueckwirkendBetroffen,
  };
}

// -------------------------------------------------------------------- Formular

export interface AnteilEingabe {
  /** ID der Kostenstelle; leer = noch keine gewählt. */
  kostenstelle: string;
  /** „70“ · „33,5“ */
  anteil: string;
}

export interface AendernFormular {
  tag: string;
  /** Kurzzeichen des neuen Orts. */
  ort: string;
  anlage: string;
  stellung: MessstelleStellung | '';
  unterzaehlerVon: string;
  /** IDs der Prozesse ab dem Tag (leer = zu keinem). */
  prozesse: string[];
  /** Die Verteilung ab dem Tag (leer = nicht verteilt). */
  anteile: AnteilEingabe[];
}

export type AendernFeld = 'tag' | 'ort' | 'anlage' | 'stellung' | 'unterzaehlerVon' | 'prozesse' | 'anteile';

/** Was heute bekannt ist — der Bestand, gegen den das Formular vorbelegt und geprüft wird. */
export interface ZuordnungsBestand {
  orte: readonly MessstelleOrtZuordnung[];
  stellungen: readonly MessstelleStellungZuordnung[];
  prozesse: readonly MessstelleProzessZuordnung[];
  anteile: readonly MessstelleVerteilungAnteil[];
}

export function bestandAus(
  m: Messstelle,
  prozesse: readonly MessstelleProzessZuordnung[] | null,
  anteile: readonly MessstelleVerteilungAnteil[] | null,
): ZuordnungsBestand {
  return { orte: m.orte ?? [], stellungen: m.elektrische_stellung ?? [], prozesse: prozesse ?? [], anteile: anteile ?? [] };
}

const amTag = <T extends Tagesintervall>(xs: readonly T[], tag: Tag): T[] => xs.filter((x) => deckt(x, tag));

/**
 * Vorbelegt mit dem Stand von HEUTE und „Gilt ab“ = heute. Der Ort bleibt leer (Z4 „Neuer Ort“);
 * Stellung, Prozesse und Verteilung stehen da, wie sie gelten — geändert wird meist ein Teil.
 */
export function formularAus(b: ZuordnungsBestand, heute: Tag): AendernFormular {
  const st = amTag(b.stellungen, heute)[0] ?? null;
  return {
    tag: heute,
    ort: '',
    anlage: st?.anlage ?? '',
    stellung: st?.stellung ?? '',
    unterzaehlerVon: st?.unterzaehler_von ?? '',
    prozesse: amTag(b.prozesse, heute).map((p) => p.prozess.id),
    anteile: amTag(b.anteile, heute)
      .sort(nachKennzeichen((a) => a.kostenstelle.kennzeichen))
      .map((a) => ({ kostenstelle: a.kostenstelle.id, anteil: normalAnteil(a.anteil_prozent).replace('.', ',') })),
  };
}

const ANTEIL = /^\d{1,3}([.,]\d)?$/;

/** „33,5“ → „33.5“, „100.0“ → „100“ — die Form der Schnittstelle; `null` = keine Zahl. */
export function anteilWert(eingabe: string): string | null {
  const t = eingabe.trim();
  if (!ANTEIL.test(t)) return null;
  return normalAnteil(t.replace(',', '.'));
}

function normalAnteil(text: string): string {
  return dezText(dezKuerze(dez(text)));
}

/** „100 %“ — die Summe der lesbaren Anteile; `null`, solange einer keine Zahl ist. */
export function anteileSumme(anteile: readonly AnteilEingabe[]): string | null {
  const werte = anteile.map((a) => anteilWert(a.anteil));
  if (werte.some((w) => w === null)) return null;
  const zehntel = werte.reduce((s, w) => s + Math.round(Number(w) * 10), 0);
  return normalAnteil((zehntel / 10).toFixed(1));
}

/** Leer bedeutet bewusst „nicht verteilt“; sobald es Zeilen gibt, darf nur ein ganzer 100-%-Satz gespeichert werden. */
export function verteilungSpeicherbar(anteile: readonly AnteilEingabe[]): boolean {
  return anteile.length === 0 || anteileSumme(anteile) === '100';
}

/** Der Live-Satz unter den Anteilen (§5.3): Erfolg oder die noch fehlende/überzählige Menge. */
export function verteilungSummeSatz(anteile: readonly AnteilEingabe[]): string {
  const summe = anteileSumme(anteile);
  if (summe === null) return 'Summe: —';
  if (summe === '100') return `Summe: ${prozentText(summe)} ✔`;
  const rest = Math.abs(1000 - Math.round(Number(summe) * 10)) / 10;
  const was = Number(summe) < 100 ? 'fehlen' : 'sind zu viel';
  return `Summe: ${prozentText(summe)} · ${prozentText(normalAnteil(rest.toFixed(1)))} ${was} — eine Verteilung ist vollständig oder existiert nicht.`;
}

/** Der Rest bis 100 % als Vorschlag für eine neue Zeile (§5.12 „Restanteil vorgeschlagen“); leer ohne Rest. */
export function restAnteil(anteile: readonly AnteilEingabe[]): string {
  const summe = anteileSumme(anteile);
  if (summe === null) return '';
  const rest = (1000 - Math.round(Number(summe) * 10)) / 10;
  return rest > 0 ? normalAnteil(rest.toFixed(1)).replace('.', ',') : '';
}

/** Die Prozesse, die es an dem Tag gibt. */
export function prozessOptionen(prozesse: readonly Prozess[], tag: string): VpOption[] {
  return prozesse
    .filter((p) => !TAG.test(tag) || deckt(p, tag))
    .sort(nachKennzeichen((p) => p.kennzeichen))
    .map((p) => ({ value: p.id, label: p.name, sub: p.kennzeichen }));
}

/** Die Kostenstellen, die es an dem Tag gibt („4100 Spritzguss“). */
export function kostenstelleOptionen(kostenstellen: readonly Kostenstelle[], tag: string): VpOption[] {
  return kostenstellen
    .filter((k) => !TAG.test(tag) || deckt(k, tag))
    .sort(nachKennzeichen((k) => k.kennzeichen))
    .map((k) => ({ value: k.id, label: `${k.kennzeichen} ${k.name}` }));
}

/** Ein Ziel mit bekanntem Ende nimmt die Verteilung an genau diesem letzten Tag mit (§5.3/F12). */
export function kostenstelleEndeSatz(kostenstellen: readonly Kostenstelle[], id: string, tag: string): string | null {
  const k = kostenstellen.find((x) => x.id === id);
  if (!k?.gueltig_bis || (TAG.test(tag) && k.gueltig_bis < tag)) return null;
  return `endet mit Kostenstelle ${k.kennzeichen} am ${datumText(k.gueltig_bis)}`;
}

/** Die Stammdaten, gegen die das Formular die Wörter und die 100 % prüft. */
export interface Kataloge {
  namen: Namen;
  prozesse: readonly Prozess[];
  kostenstellen: readonly Kostenstelle[];
}

const gleicheMenge = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

export const hatAendernFehler = (e: Partial<Record<AendernFeld, string>>) => Object.values(e).some(Boolean);

/**
 * Vor dem Senden — die Pflichtfelder, bei der Verteilung die Regel des Vertrags
 * (`uemsVerteilung.satz`: Anteil in (0, 100], Ziel besteht am Tag, genau 100 %) und zuletzt
 * „es gibt nichts zu ändern“ ({@link unveraendertFehler}).
 */
export function aendernPruefen(
  art: AendernArt,
  f: AendernFormular,
  b: ZuordnungsBestand,
  k: Kataloge,
): Partial<Record<AendernFeld, string>> {
  const fehler: Partial<Record<AendernFeld, string>> = {};
  if (!TAG.test(f.tag)) fehler.tag = PFLICHT.tag;
  if (art === 'ort' && !f.ort) fehler.ort = SATZ.ortFehlt;
  if (art === 'stellung') {
    if (!f.anlage) fehler.anlage = PFLICHT.anlage;
    if (!f.stellung) fehler.stellung = PFLICHT.stellung;
    if (f.stellung === 'Unterzähler' && !f.unterzaehlerVon) fehler.unterzaehlerVon = PFLICHT.unterzaehler;
  }
  if (art === 'verteilung') {
    const satz = anteilePruefen(f, k);
    if (satz) fehler.anteile = satz;
  }
  return hatAendernFehler(fehler) ? fehler : unveraendertFehler(art, f, b, k);
}

/**
 * „Es gibt nichts zu ändern“: am gewählten Tag gilt schon genau das. Die Seite zeigt es SOFORT am
 * Feld (nicht erst beim Senden), und „Was geschieht“ entfällt — sonst stünde da „wird berichtigt“
 * für einen Eintrag, der nichts ändert. Leer, solange Tag oder Wert fehlen.
 */
export function unveraendertFehler(
  art: AendernArt,
  f: AendernFormular,
  b: ZuordnungsBestand,
  k: Kataloge,
): Partial<Record<AendernFeld, string>> {
  if (!TAG.test(f.tag)) return {};
  const tag = f.tag;
  if (art === 'ort') {
    const o = amTag(b.orte, tag)[0];
    return f.ort && o?.kennzeichen === f.ort ? { ort: unveraendertSatz(tag, k.namen.ort(f.ort)?.name ?? f.ort) } : {};
  }
  if (art === 'stellung') {
    const st = amTag(b.stellungen, tag)[0];
    const bezug = f.stellung === 'Unterzähler' ? f.unterzaehlerVon : '';
    const gleich =
      st && f.anlage && f.stellung && st.anlage === f.anlage && st.stellung === f.stellung && (st.unterzaehler_von ?? '') === bezug;
    return gleich ? { stellung: unveraendertSatz(tag, stellungWort(st)) } : {};
  }
  if (art === 'prozesse') {
    const heute = amTag(b.prozesse, tag);
    return gleicheMenge(
      heute.map((p) => p.prozess.id),
      f.prozesse,
    )
      ? { prozesse: unveraendertSatz(tag, prozessWoerter(heute).wert || LEER.prozesse) }
      : {};
  }
  const werte = f.anteile.map((a) => anteilWert(a.anteil));
  if (werte.some((w) => w === null) || f.anteile.some((a) => !a.kostenstelle)) return {};
  const heute = amTag(b.anteile, tag);
  const gleich = gleicheMenge(
    heute.map((a) => `${a.kostenstelle.id}|${normalAnteil(a.anteil_prozent)}`),
    f.anteile.map((a, i) => `${a.kostenstelle}|${werte[i]}`),
  );
  return gleich ? { anteile: unveraendertSatz(tag, heute.length ? anteilWoerter(heute).wert : LEER.verteilung) } : {};
}

function anteilePruefen(f: AendernFormular, k: Kataloge): string | null {
  if (f.anteile.some((a) => !a.kostenstelle)) return SATZ.kostenstelleFehlt;
  if (new Set(f.anteile.map((a) => a.kostenstelle)).size !== f.anteile.length) return SATZ.kostenstelleDoppelt;
  const werte = f.anteile.map((a) => anteilWert(a.anteil));
  if (werte.some((w) => w === null)) return SATZ.anteilFormat;
  // Leer ist erlaubt: „nicht verteilt“ ist ein Zustand, kein Fehler (AP-10 E12).
  if (!TAG.test(f.tag) || !f.anteile.length) return null;
  const zeilen = f.anteile.map((a, i) => ({ kostenstelle: a.kostenstelle, anteil_prozent: dez(werte[i]!) }));
  const ziele = k.kostenstellen.map((x) => ({ kostenstelle: x.id, gueltig_ab: x.gueltig_ab, gueltig_bis: x.gueltig_bis }));
  const urteil = verteilungSatz(f.tag, '', zeilen, ziele);
  if (urteil.fehler === FEHLER_ANTEIL) return SATZ.anteilFormat;
  if (urteil.fehler === FEHLER_ZIEL) {
    const ks = k.kostenstellen.find((x) => x.id === urteil.fakten.kostenstelle);
    return zielFehltSatz(ks?.kennzeichen ?? urteil.fakten.kostenstelle, f.tag);
  }
  if (urteil.fehler === FEHLER_SUMME) return summeSatz(urteil.fakten.summe);
  return null;
}

// -------------------------------------------------------------------- Anfragen

/** Beginnt an dem Tag schon ein Intervall, ersetzt der Eintrag es (`korrektur`, sonst 409 `gleicher_tag`). */
const korrektur = (xs: readonly Tagesintervall[], tag: Tag) => (xs.some((x) => x.gueltig_ab === tag) ? { korrektur: true } : {});

/** PUT …/ort — ab dem Tag; das laufende endet am Vortag (Server). */
export function ortAbTagAnfrage(f: AendernFormular, b: ZuordnungsBestand): MessstelleOrtAendern {
  return { kennzeichen: f.ort, gueltig_ab: f.tag, ...korrektur(b.orte, f.tag) };
}

/** PUT …/stellung — „Unterzähler von“ nur bei „Unterzähler“. */
export function stellungAbTagAnfrage(f: AendernFormular, b: ZuordnungsBestand): MessstelleStellungAendern {
  return {
    anlage: f.anlage,
    stellung: f.stellung as MessstelleStellung,
    unterzaehler_von: f.stellung === 'Unterzähler' ? f.unterzaehlerVon : null,
    gueltig_ab: f.tag,
    ...korrektur(b.stellungen, f.tag),
  };
}

/** PUT …/prozesse — ab dem Tag GENAU diese Prozesse (leer = zu keinem). */
export function prozesseAbTagAnfrage(f: AendernFormular): { gueltig_ab: string; prozesse: string[] } {
  return { gueltig_ab: f.tag, prozesse: [...f.prozesse] };
}

/** PUT …/verteilung — ab dem Tag GENAU dieser Satz (leer = nicht verteilt). */
export function verteilungAbTagAnfrage(
  f: AendernFormular,
  b: ZuordnungsBestand,
): { gueltig_ab: string; zeilen: VerteilungZeileEingabe[]; korrektur?: boolean } {
  return {
    gueltig_ab: f.tag,
    zeilen: f.anteile.map((a) => ({ kostenstelle_id: a.kostenstelle, anteil_prozent: anteilWert(a.anteil) ?? a.anteil })),
    ...korrektur(b.anteile, f.tag),
  };
}

// -------------------------------------------------------------------- Bisher und Folgen

export interface Bisher {
  /** „Halle 1 Süd (B-2)“ */
  wert: string;
  /** „Halle 1 · Werk Ahrenberg · seit 12.03.2024 — endet 28.02.2027“ */
  neben: string;
}

/** Was am gewählten Tag bisher gilt (Z4 „Bisher“) — mit dem Ende, das der Eintrag ihm gibt. */
export function bisherAm(art: AendernArt, b: ZuordnungsBestand, tag: string, namen: Namen): Bisher | null {
  if (!TAG.test(tag)) return null;
  const woerter = bisherWoerter(art, b, tag, namen);
  if (!woerter) return null;
  const ende =
    woerter.ab < tag ? `endet ${datumText(plusTage(tag, -1))}` : `wird ab ${datumText(tag)} berichtigt`;
  return {
    wert: woerter.wert,
    neben: [woerter.neben, `seit ${datumText(woerter.ab)} — ${ende}`].filter(Boolean).join(' · '),
  };
}

function bisherWoerter(art: AendernArt, b: ZuordnungsBestand, tag: Tag, namen: Namen): (Woerter & { ab: Tag }) | null {
  const beginn = (xs: readonly Tagesintervall[]) => xs.map((x) => x.gueltig_ab).sort().slice(-1)[0];
  if (art === 'ort') {
    const o = amTag(b.orte, tag)[0];
    if (!o) return null;
    const n = namen.ort(o.kennzeichen);
    return { wert: n ? `${n.name} (${n.kurzzeichen})` : o.kennzeichen, neben: n?.ueber ?? null, ab: o.gueltig_ab };
  }
  if (art === 'stellung') {
    const s = amTag(b.stellungen, tag)[0];
    return s ? { ...stellungWoerter(namen)([s]), ab: s.gueltig_ab } : null;
  }
  if (art === 'prozesse') {
    const p = amTag(b.prozesse, tag);
    return p.length ? { ...prozessWoerter(p), ab: beginn(p) } : null;
  }
  const a = amTag(b.anteile, tag);
  return a.length ? { ...anteilWoerter(a), ab: beginn(a) } : null;
}

export interface Folgen {
  titel: string;
  /** Das Kennzeichen des Tags: „rückwirkend (19 Tage)“ · „geplant“ · `null` */
  marke: string | null;
  saetze: string[];
}

const NICHTS_ZIEHT_MIT: Record<AendernArt, string> = {
  ort: 'Die elektrische Stellung und die Quelle ändern Sie in eigenen Schritten — nichts zieht still mit.',
  stellung: 'Den Ort und die Quelle ändern Sie in eigenen Schritten — nichts zieht still mit.',
  prozesse: 'Ort, elektrische Stellung und Quelle bleiben, wie sie sind.',
  verteilung: 'Ort, elektrische Stellung und Quelle bleiben, wie sie sind.',
};

/** Die neuen Wörter des Formulars: „Halle 2 Montage (B-3)“, „Unterzähler von MS-10 in …“ … */
export function neuWort(art: AendernArt, f: AendernFormular, k: Kataloge): string | null {
  if (art === 'ort') {
    if (!f.ort) return null;
    const n = k.namen.ort(f.ort);
    return n ? `${n.name} (${n.kurzzeichen})` : f.ort;
  }
  if (art === 'stellung') {
    if (!f.anlage || !f.stellung) return null;
    const anlage = k.namen.anlage(f.anlage);
    const was = stellungWort({ stellung: f.stellung, unterzaehler_von: f.unterzaehlerVon || null });
    return anlage ? `${was} in ${anlage}` : was;
  }
  if (art === 'prozesse') {
    const namen = k.prozesse
      .filter((p) => f.prozesse.includes(p.id))
      .sort(nachKennzeichen((p) => p.kennzeichen))
      .map((p) => p.name);
    return namen.length ? namen.join(', ') : LEER.prozesse;
  }
  if (!f.anteile.length) return LEER.verteilung;
  if (f.anteile.some((a) => !a.kostenstelle || anteilWert(a.anteil) === null)) return null;
  return f.anteile
    .map((a) => {
      const ks = k.kostenstellen.find((x) => x.id === a.kostenstelle);
      return `${ks ? `${ks.kennzeichen} ${ks.name}` : a.kostenstelle} · ${prozentText(anteilWert(a.anteil)!)}`;
    })
    .join(', ');
}

function ersterSatz(art: AendernArt, kennzeichen: string, tag: Tag, neu: string): string {
  const ab = `Ab ${datumText(tag)}`;
  if (art === 'ort') return `${ab} gehört ${kennzeichen} zu ${neu}`;
  if (art === 'stellung') return `${ab} ist ${kennzeichen} ${neu}`;
  if (art === 'prozesse') return neu === LEER.prozesse ? `${ab} gehört ${kennzeichen} zu keinem Prozess` : `${ab} gehört ${kennzeichen} zu ${neu}`;
  return neu === LEER.verteilung ? `${ab} ist ${kennzeichen} ${LEER.verteilung}` : `${ab} verteilt sich ${kennzeichen} auf ${neu}`;
}

/**
 * „Was geschieht“ (Z4) VOR dem Speichern: ab wann das Neue gilt, bis wann das Bisherige bleibt,
 * welche Tage nachträglich anders gelten — und dass nichts still mitzieht. `null`, solange Tag
 * oder neuer Wert fehlen.
 */
export function folgen(e: {
  art: AendernArt;
  kennzeichen: string;
  f: AendernFormular;
  b: ZuordnungsBestand;
  k: Kataloge;
  heute: Tag;
  zone: string;
}): Folgen | null {
  if (hatAendernFehler(unveraendertFehler(e.art, e.f, e.b, e.k))) return null;
  const z = zeitformAm(e.f.tag, e.heute, e.zone);
  const neu = neuWort(e.art, e.f, e.k);
  if (!z || neu === null) return null;
  const tag = e.f.tag;
  const bisher = bisherWoerter(e.art, e.b, tag, e.k.namen);
  const saetze: string[] = [];
  if (bisher && bisher.ab === tag) {
    saetze.push(`Der Eintrag ab ${datumText(tag)} (${bisher.wert}) wird berichtigt.`);
    saetze.push(`${ersterSatz(e.art, e.kennzeichen, tag, neu)}.`);
  } else {
    const bleibt = bisher ? `; bis ${datumText(plusTage(tag, -1))} bleibt es bei ${bisher.wert}` : '';
    saetze.push(`${ersterSatz(e.art, e.kennzeichen, tag, neu)}${bleibt}.`);
  }
  const t = z.betroffen;
  if (t) {
    saetze.push(
      t.von === t.bis
        ? `Für den ${datumText(t.von)} gilt das nachträglich.`
        : `Für die Tage vom ${datumText(t.von)} bis ${datumText(t.bis)} gilt das nachträglich.`,
    );
  }
  saetze.push(NICHTS_ZIEHT_MIT[e.art]);
  return { titel: WAS_GESCHIEHT, marke: z.marke, saetze };
}

// -------------------------------------------------------------------- Ablehnungen

/**
 * Die Ablehnung der Schnittstelle als Satz am Feld. Ort und Stellung sprechen die FEHLER-Tabelle
 * über `messstelleDialog.ablehnung` (derselbe Wortlaut wie im Dialog); Prozesse und Verteilung
 * tragen den Satz der Schnittstelle.
 */
export function aendernAblehnung(
  art: AendernArt,
  err: { status?: number; message?: string; body?: unknown } | null,
  anlageName: (id: string) => string | null,
): { feld: AendernFeld | null; satz: string } {
  if (art === 'ort' || art === 'stellung') {
    const a = ablehnung(err, { schritt: 2, anlageName });
    const feld: AendernFeld | null =
      a.feld === 'gueltigAb'
        ? 'tag'
        : a.feld === 'ort' || a.feld === 'anlage' || a.feld === 'stellung' || a.feld === 'unterzaehlerVon'
          ? a.feld
          : null;
    return { feld, satz: a.satz };
  }
  const body = (err?.body && typeof err.body === 'object' ? err.body : {}) as Record<string, unknown>;
  const code = typeof body.code === 'string' ? body.code : null;
  const satz = (typeof body.message === 'string' && body.message) || err?.message || SATZ_ALLGEMEIN;
  if (code === 'zuordnung_ueberlappt' || code === 'zeitraum_ungueltig' || (code === 'anfrage_ungueltig' && body.feld === 'gueltig_ab')) {
    return { feld: 'tag', satz };
  }
  if (art === 'prozesse' && (code === 'prozess_unbekannt' || code === 'ziel_besteht_nicht')) return { feld: 'prozesse', satz };
  if (
    art === 'verteilung' &&
    (code === 'verteilung_summe' || code === 'anteil_ungueltig' || code === 'kostenstelle_unbekannt' || code === 'ziel_besteht_nicht')
  ) {
    return { feld: 'anteile', satz };
  }
  return { feld: null, satz };
}
