/**
 * Die REINE Ableitung des ORTSBAUMS des Unternehmens-Energiemanagements
 * (UEMS AP-02 §4.3–§4.5, Entscheide E1, E2, E3, E9, E11, E12): zeitgültige
 * Zuordnungen von Gebäuden, Bereichen, Anlagen und Messstellen, „Stand am",
 * Überlappung, Rückwirkung, der abgeleitete Standort einer Messstelle,
 * Archivieren/Wiederherstellen/Löschen, Fläche und die tagesgenaue Teilung
 * eines Zeitraums.
 *
 * Kein Datum kommt von der Uhr: Stichtag und „heute" sind immer Parameter. Der
 * Zwilling im Server ist `services/api .../uems/OrtsbaumAbleitung`; beide
 * fahren dieselben Vektoren (`docs/contracts/v2/ortsbaum-vectors.json`).
 * **Wer die Regel ändert, ändert beide Seiten und die Vektor-Datei.**
 *
 * ⚠ **Noch ruft niemand an.** Es gibt keine Tabelle, keinen Endpunkt und keine
 * Fläche; „Standort" ist im Portal weiterhin nur das Koordinaten-Feld der
 * Anlage. Dieses Modul ist der Vertrag, gegen den die Flächen später gebaut
 * werden.
 *
 * ## Die Mechanik in einem Satz (§4.3)
 *
 * „gültig ab" ist ein TAG, wirksam 00:00 Uhr in der Zeitzone des Standorts
 * (E9); je Objekt und Zuordnungsart genau ein Intervall je Tag; ein neues
 * „gültig ab" beendet das laufende Intervall am VORTAG; Rückwirkung ist erlaubt
 * und immer sichtbar (E2); Zukunft ist „geplant"; vor dem Beginn des ersten
 * Intervalls wird abgelehnt; eine Korrektur ersetzt ein Intervall ab seinem
 * Beginn und lässt das alte als „aufgehoben" lesbar.
 *
 * ⚠ `bis` ist der LETZTE gültige Tag, einschließlich („Werk Ahrenberg bis
 * 28.02.2027"). Halboffen sind nur die Zeitpunkte: [ab 00:00, bis+1 00:00).
 */

/** Ein Kalendertag `JJJJ-MM-TT` — ohne Uhrzeit, ohne Zeitzone (E9). */
export type Tag = string;

export const VORGABE_ZEITZONE = 'Europe/Berlin';

/** Das Kennzeichen des Unternehmens: ein Ort für eine Messstelle, aber kein Standort. */
export const UNTERNEHMEN = 'U';

export const ORT_ARTEN = ['standort', 'gebaeude', 'bereich'] as const;
export type OrtArt = (typeof ORT_ARTEN)[number];
export type ObjektArt = 'gebaeude' | 'bereich' | 'anlage' | 'messstelle';
export type ElternArt = 'unternehmen' | OrtArt;

/** Woran was hängen darf (Regel 1, AP-00 E4: Bereiche werden nicht verschachtelt). */
export const ERLAUBTE_ELTERN: Record<ObjektArt, ElternArt[]> = {
  gebaeude: ['standort'],
  bereich: ['gebaeude', 'standort'],
  anlage: ['standort'],
  messstelle: ['unternehmen', 'standort', 'gebaeude', 'bereich'],
};

/** AP-00 E8. Nur `aktiv` sperrt das Archivieren (E12). */
export const OBJEKT_ZUSTAENDE = ['entwurf', 'eingerichtet', 'aktiv', 'angehalten', 'archiviert'] as const;
export type ObjektZustand = (typeof OBJEKT_ZUSTAENDE)[number];

/** Eine Zuordnung: [ab, bis] in Tagen, `bis` einschließlich, `null` = offen. */
export interface Intervall {
  ab: Tag;
  bis: Tag | null;
  /** Der Elternknoten (bei einer Anlage: der Standort); beim Standort `null`. */
  eltern: string | null;
  /** Korrektur (§4.2): bleibt lesbar, belegt aber keinen Tag mehr. */
  aufgehoben?: boolean;
}

export interface FlaechenIntervall {
  ab: Tag;
  bis: Tag | null;
  m2: number;
}

export interface Ort {
  kennzeichen: string;
  art: OrtArt;
  name: string;
  /** Nur am Standort; Gebäude und Bereiche erben (Regel 11). */
  zeitzone?: string;
  /** Beim Standort: sein Bestehen; sonst die Zuordnung an den Elternknoten. */
  intervalle: Intervall[];
  flaechen?: FlaechenIntervall[];
}

export interface Anlage {
  kennzeichen: string;
  name: string;
  netzanschluss: string | null;
  zustand: ObjektZustand;
  zuordnungen: Intervall[];
}

export interface Messstelle {
  kennzeichen: string;
  name: string;
  /** Die Anlage der Messstelle (AP-10) — nur für die Folgen-Karte gelesen. */
  anlage: string | null;
  zustand: ObjektZustand;
  zuordnungen: Intervall[];
}

export interface Ortsbaum {
  /** Die Vorgabe-Zeitzone des Unternehmens. */
  zeitzone: string;
  orte: Ort[];
  anlagen: Anlage[];
  messstellen: Messstelle[];
}

// ───────────────────────────────────────────────────────────────── Tage

function tagZahl(t: Tag): number {
  const [y, m, d] = t.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

export function plusTage(t: Tag, n: number): Tag {
  return new Date((tagZahl(t) + n) * 86_400_000).toISOString().slice(0, 10);
}

export function tageZwischen(von: Tag, bis: Tag): number {
  return tagZahl(bis) - tagZahl(von);
}

/** „01.03.2027" */
export function datumText(t: Tag): string {
  const [y, m, d] = t.split('-');
  return `${d}.${m}.${y}`;
}

function minTag(a: Tag, b: Tag): Tag {
  return a < b ? a : b;
}

/** Die Wanduhr eines Zeitpunkts in einer Zeitzone, als wäre sie UTC — für den Versatz. */
function wanduhr(ms: number, zone: string): { tag: Tag; ms: number } {
  const teile = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const y = Number(teile.year);
  const m = Number(teile.month);
  const d = Number(teile.day);
  return {
    tag: `${teile.year}-${teile.month}-${teile.day}`,
    ms: Date.UTC(y, m - 1, d, Number(teile.hour), Number(teile.minute), Number(teile.second)),
  };
}

/** Der Kalendertag eines Zeitpunkts in der Zeitzone des Standorts. */
export function lokalerTag(zeitpunkt: string, zone: string): Tag {
  return wanduhr(Date.parse(zeitpunkt), zone).tag;
}

/**
 * 00:00 Uhr eines Tages in einer Zeitzone als Zeitpunkt. Mitternacht liegt in
 * den DACH-Zeitzonen nie in einer Umstellungslücke (die ist um 02:00 Uhr).
 */
function mitternacht(t: Tag, zone: string): { ms: number; iso: string } {
  const naiv = tagZahl(t) * 86_400_000;
  let ms = naiv - (wanduhr(naiv, zone).ms - naiv);
  const versatz = wanduhr(ms, zone).ms - ms;
  ms = naiv - versatz;
  const min = Math.round(versatz / 60_000);
  const betrag = Math.abs(min);
  const hh = String(Math.floor(betrag / 60)).padStart(2, '0');
  const mm = String(betrag % 60).padStart(2, '0');
  return { ms, iso: `${t}T00:00:00${min < 0 ? '-' : '+'}${hh}:${mm}` };
}

// ─────────────────────────────────────────────────────────── Intervalle

function wirksam(liste: Intervall[]): Intervall[] {
  return liste.filter((i) => !i.aufgehoben).sort((a, b) => (a.ab < b.ab ? -1 : a.ab > b.ab ? 1 : 0));
}

function deckt(i: { ab: Tag; bis: Tag | null }, tag: Tag): boolean {
  return i.ab <= tag && (i.bis === null || tag <= i.bis);
}

function intervallAm(liste: Intervall[], tag: Tag): Intervall | null {
  return wirksam(liste).find((i) => deckt(i, tag)) ?? null;
}

/** Warum ein Ort an einem Tag nicht im Baum ist — in der Reihenfolge seines Lebens. */
export const NICHT_GEZEIGT_GRUENDE = ['gab_es_noch_nicht', 'archiviert'] as const;
export type Bestand = 'vorhanden' | (typeof NICHT_GEZEIGT_GRUENDE)[number];

function bestand(liste: Intervall[], tag: Tag): Bestand {
  const w = wirksam(liste);
  if (w.some((i) => deckt(i, tag))) return 'vorhanden';
  if (w.length === 0 || tag < w[0].ab) return 'gab_es_noch_nicht';
  return 'archiviert';
}

/** Der erste Tag in [von, bis] (bis null = offen), an dem die Liste nichts deckt; null = lückenlos. */
function ersterFehlenderTag(liste: Intervall[], von: Tag, bis: Tag | null): Tag | null {
  let tag = von;
  for (const i of wirksam(liste)) {
    if (i.bis !== null && i.bis < tag) continue;
    if (i.ab > tag) return tag;
    if (i.bis === null) return null;
    tag = plusTage(i.bis, 1);
    if (bis !== null && tag > bis) return null;
  }
  return tag;
}

export const ZUORDNUNG_ZUSTAENDE = ['gueltig', 'geplant', 'beendet', 'aufgehoben'] as const;
export type ZuordnungZustand = (typeof ZUORDNUNG_ZUSTAENDE)[number];

/** §4.2: gültig (heute im Intervall) · geplant (ab in der Zukunft) · beendet · aufgehoben. */
export function zuordnungZustand(i: Intervall, heute: Tag): ZuordnungZustand {
  if (i.aufgehoben) return 'aufgehoben';
  if (i.ab > heute) return 'geplant';
  if (i.bis !== null && i.bis < heute) return 'beendet';
  return 'gueltig';
}

// ─────────────────────────────────────────────────────────────── Baum

function ort(baum: Ortsbaum, kz: string): Ort | undefined {
  return baum.orte.find((o) => o.kennzeichen === kz);
}

function vorhanden(baum: Ortsbaum, kz: string, tag: Tag): boolean {
  if (kz === UNTERNEHMEN) return true;
  const o = ort(baum, kz);
  return o !== undefined && intervallAm(o.intervalle, tag) !== null;
}

function elternName(baum: Ortsbaum, kz: string): string {
  return kz === UNTERNEHMEN ? 'Unternehmen' : (ort(baum, kz)?.name ?? kz);
}

/** Von einem Ort hinauf bis zum Standort; bricht ab, wo ein Knoten an dem Tag nicht im Baum ist. */
function pfadAm(baum: Ortsbaum, kz: string, tag: Tag): { pfad: string[]; standort: string | null } {
  const pfad: string[] = [];
  let k: string | null = kz;
  // Bereich → Gebäude → Standort: mehr als drei Schritte sind ein kaputter Baum.
  for (let schritt = 0; schritt < 3 && k !== null; schritt++) {
    const o = ort(baum, k);
    const iv = o === undefined ? null : intervallAm(o.intervalle, tag);
    if (o === undefined || iv === null) return { pfad, standort: null };
    pfad.push(k);
    if (o.art === 'standort') return { pfad, standort: k };
    k = iv.eltern;
  }
  return { pfad, standort: null };
}

function zeitzoneVon(baum: Ortsbaum, standort: string | null): string {
  return (standort === null ? undefined : ort(baum, standort)?.zeitzone) ?? baum.zeitzone;
}

// ─────────────────────────────────────────────────────────────── Fläche

export const FLAECHE_QUELLEN = ['eigen', 'aus_gebaeuden_summiert'] as const;
export type FlaecheQuelle = (typeof FLAECHE_QUELLEN)[number];

export interface FlaecheAmTag {
  vorhanden: boolean;
  flaecheM2: number | null;
  flaecheQuelle: FlaecheQuelle | null;
  /** Nur am Standort: die Summe seiner Gebäude — null, sobald einem die Fläche fehlt. */
  summeGebaeudeM2?: number | null;
  gebaeudeOhneFlaeche?: string[];
}

function eigeneFlaeche(o: Ort, tag: Tag): number | null {
  return (o.flaechen ?? []).find((f) => deckt(f, tag))?.m2 ?? null;
}

function flaecheVon(baum: Ortsbaum, o: Ort, tag: Tag): FlaecheAmTag {
  const da = intervallAm(o.intervalle, tag) !== null;
  const eigen = da ? eigeneFlaeche(o, tag) : null;
  if (o.art !== 'standort') {
    return { vorhanden: da, flaecheM2: eigen, flaecheQuelle: eigen === null ? null : 'eigen' };
  }
  const gebaeude = da
    ? baum.orte.filter((g) => g.art === 'gebaeude' && intervallAm(g.intervalle, tag)?.eltern === o.kennzeichen)
    : [];
  const ohne = gebaeude.filter((g) => eigeneFlaeche(g, tag) === null).map((g) => g.kennzeichen);
  const summe =
    gebaeude.length > 0 && ohne.length === 0
      ? gebaeude.reduce((s, g) => s + (eigeneFlaeche(g, tag) ?? 0), 0)
      : null;
  const m2 = eigen ?? summe;
  return {
    vorhanden: da,
    flaecheM2: m2,
    flaecheQuelle: eigen !== null ? 'eigen' : summe !== null ? 'aus_gebaeuden_summiert' : null,
    summeGebaeudeM2: summe,
    gebaeudeOhneFlaeche: ohne,
  };
}

/** E3/Regel 12: die Fläche eines Ortes an einem Tag — nie saldiert, nie erfunden. */
export function flaecheAm(baum: Ortsbaum, objekt: string, tag: Tag): FlaecheAmTag {
  const o = ort(baum, objekt);
  if (o === undefined) throw new Error(`unbekannter Ort: ${objekt}`);
  return flaecheVon(baum, o, tag);
}

export interface FlaechenTeil {
  von: Tag;
  bis: Tag;
  vorhanden: boolean;
  flaecheM2: number | null;
  flaecheQuelle: FlaecheQuelle | null;
}

/** Ein Zeitraum in Teile mit je EINER Fläche — nie ein Mittelwert. */
export function flaecheZeitraum(baum: Ortsbaum, objekt: string, von: Tag, bis: Tag): FlaechenTeil[] {
  const out: FlaechenTeil[] = [];
  for (let tag = von; tag <= bis; tag = plusTage(tag, 1)) {
    const f = flaecheAm(baum, objekt, tag);
    const letzter = out[out.length - 1];
    if (
      letzter !== undefined &&
      letzter.vorhanden === f.vorhanden &&
      letzter.flaecheM2 === f.flaecheM2 &&
      letzter.flaecheQuelle === f.flaecheQuelle
    ) {
      letzter.bis = tag;
    } else {
      out.push({ von: tag, bis: tag, vorhanden: f.vorhanden, flaecheM2: f.flaecheM2, flaecheQuelle: f.flaecheQuelle });
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────── Stand am

export interface OrtAmStichtag extends Omit<FlaecheAmTag, 'vorhanden'> {
  kennzeichen: string;
  eltern: string | null;
  standort: string | null;
}

export interface NichtGezeigt {
  kennzeichen: string;
  grund: Exclude<Bestand, 'vorhanden'>;
  text: string;
}

export interface StandAm {
  orte: OrtAmStichtag[];
  nichtGezeigt: NichtGezeigt[];
  anlagen: { kennzeichen: string; standort: string | null }[];
}

function bestandSatz(grund: Exclude<Bestand, 'vorhanden'>, name: string, tag: Tag): string {
  return grund === 'gab_es_noch_nicht'
    ? `Am ${datumText(tag)} gab es ${name} im Portal noch nicht.`
    : `Am ${datumText(tag)} war ${name} archiviert.`;
}

/**
 * §4.4: der Ortsbaum, die Flächen und die Anlagen-Zuordnung so, wie sie an
 * diesem Tag galten. Objekte, die es an dem Tag nicht gab, fehlen (mit Grund);
 * archivierte, die es gab, erscheinen normal.
 */
export function standAm(baum: Ortsbaum, stichtag: Tag): StandAm {
  const orte: OrtAmStichtag[] = [];
  const nichtGezeigt: NichtGezeigt[] = [];
  for (const o of baum.orte) {
    const b = bestand(o.intervalle, stichtag);
    if (b !== 'vorhanden') {
      nichtGezeigt.push({ kennzeichen: o.kennzeichen, grund: b, text: bestandSatz(b, o.name, stichtag) });
      continue;
    }
    const f = flaecheVon(baum, o, stichtag);
    const zeile: OrtAmStichtag = {
      kennzeichen: o.kennzeichen,
      eltern: intervallAm(o.intervalle, stichtag)?.eltern ?? null,
      standort: pfadAm(baum, o.kennzeichen, stichtag).standort,
      flaecheM2: f.flaecheM2,
      flaecheQuelle: f.flaecheQuelle,
    };
    if (o.art === 'standort') {
      zeile.summeGebaeudeM2 = f.summeGebaeudeM2;
      zeile.gebaeudeOhneFlaeche = f.gebaeudeOhneFlaeche;
    }
    orte.push(zeile);
  }
  const anlagen = baum.anlagen.map((a) => {
    const st = intervallAm(a.zuordnungen, stichtag)?.eltern ?? null;
    return { kennzeichen: a.kennzeichen, standort: st !== null && vorhanden(baum, st, stichtag) ? st : null };
  });
  return { orte, nichtGezeigt, anlagen };
}

// ─────────────────────────────────────────────────────── Überlappung

export const LISTEN_GRUENDE = ['bis_vor_ab', 'ueberlappung'] as const;
export type ListenGrund = (typeof LISTEN_GRUENDE)[number];

export interface ListenErgebnis {
  gueltig: boolean;
  grund: ListenGrund | null;
  /** Der erste Tag, an dem die Regel bricht. */
  tag: Tag | null;
}

/** Das Überlappungsverbot (Regel 2) — was IP-2b als Exklusions-Constraint spiegelt. */
export function pruefeIntervalle(intervalle: Intervall[]): ListenErgebnis {
  for (const i of intervalle) {
    if (i.bis !== null && i.bis < i.ab) return { gueltig: false, grund: 'bis_vor_ab', tag: i.ab };
  }
  const w = wirksam(intervalle);
  for (let k = 1; k < w.length; k++) {
    const vorher = w[k - 1];
    if (vorher.bis === null || vorher.bis >= w[k].ab) {
      return { gueltig: false, grund: 'ueberlappung', tag: w[k].ab };
    }
  }
  return { gueltig: true, grund: null, tag: null };
}

/** Die Reihenfolge IST die Regel: sie entscheidet, welcher Grund gilt, wenn mehrere zutreffen. */
export const EINTRAG_GRUENDE = [
  'ziel_art_unzulaessig',
  'vor_dem_ersten_intervall',
  'objekt_archiviert',
  'gleicher_tag',
  'kein_beginn_an_dem_tag',
  'ziel_ist_bisheriger_eltern',
  'ziel_gab_es_noch_nicht',
  'ziel_archiviert',
] as const;
export type EintragGrund = (typeof EINTRAG_GRUENDE)[number];

export interface EintragAntrag {
  objekt: string;
  /** `verschieben` legt ein neues „gültig ab" an; `korrektur` ersetzt ein Intervall ab seinem Beginn. */
  vorgang: 'verschieben' | 'korrektur';
  ab: Tag;
  eltern: string;
  heute: Tag;
}

export interface IntervallMitZustand {
  ab: Tag;
  bis: Tag | null;
  eltern: string | null;
  aufgehoben: boolean;
  zustand: ZuordnungZustand;
}

export interface EintragErgebnis {
  erlaubt: boolean;
  grund: EintragGrund | null;
  text: string | null;
  /** Alle Intervalle des Objekts nach dem Eintrag, nach Beginn sortiert. */
  intervalle: IntervallMitZustand[] | null;
}

interface Objekt {
  kennzeichen: string;
  art: ObjektArt;
  /** Wie der Kunde es liest: Messstellen mit Kennzeichen („MS-18 …"), sonst der Name. */
  anzeige: string;
  intervalle: Intervall[];
}

function objekt(baum: Ortsbaum, kz: string): Objekt {
  const o = ort(baum, kz);
  if (o !== undefined && o.art !== 'standort') {
    return { kennzeichen: kz, art: o.art, anzeige: o.name, intervalle: o.intervalle };
  }
  const a = baum.anlagen.find((x) => x.kennzeichen === kz);
  if (a !== undefined) return { kennzeichen: kz, art: 'anlage', anzeige: a.name, intervalle: a.zuordnungen };
  const m = baum.messstellen.find((x) => x.kennzeichen === kz);
  if (m !== undefined) {
    return { kennzeichen: kz, art: 'messstelle', anzeige: `${m.kennzeichen} ${m.name}`, intervalle: m.zuordnungen };
  }
  throw new Error(`kein verschiebbares Objekt: ${kz}`);
}

const ZIEL_ART_SATZ: Record<ObjektArt, string> = {
  gebaeude: 'Ein Gebäude kann nur an einem Standort hängen.',
  bereich: 'Ein Bereich kann nur an einem Gebäude oder direkt an einem Standort hängen.',
  anlage: 'Eine Anlage kann nur einem Standort zugeordnet werden.',
  messstelle: 'Eine Messstelle kann nur an einem Ort oder am Unternehmen hängen.',
};

function nein(grund: EintragGrund, text: string): EintragErgebnis {
  return { erlaubt: false, grund, text, intervalle: null };
}

/**
 * Ein neues „gültig ab" (verschieben, zuordnen) oder eine Korrektur gegen die
 * vorhandenen Intervalle — GENAU EIN Grund in der festen Reihenfolge von
 * `EintragGrund`, sonst die Intervalle danach.
 */
export function eintrag(baum: Ortsbaum, antrag: EintragAntrag): EintragErgebnis {
  const obj = objekt(baum, antrag.objekt);
  const zielOrt = ort(baum, antrag.eltern);
  if (antrag.eltern !== UNTERNEHMEN && zielOrt === undefined) {
    throw new Error(`unbekanntes Ziel: ${antrag.eltern}`);
  }
  const zielArt: ElternArt = zielOrt === undefined ? 'unternehmen' : zielOrt.art;
  const zielName = elternName(baum, antrag.eltern);
  if (!ERLAUBTE_ELTERN[obj.art].includes(zielArt)) {
    return nein('ziel_art_unzulaessig', ZIEL_ART_SATZ[obj.art]);
  }
  const bisherSatz =
    obj.art === 'anlage'
      ? `${obj.anzeige} ist bereits ${zielName} zugeordnet.`
      : `${obj.anzeige} hängt bereits an ${zielName}.`;
  const zielPruefen = (von: Tag, bis: Tag | null): EintragErgebnis | null => {
    if (zielOrt === undefined) return null;
    const fehlt = ersterFehlenderTag(zielOrt.intervalle, von, bis);
    if (fehlt === null) return null;
    const erster = wirksam(zielOrt.intervalle)[0]?.ab;
    if (erster !== undefined && fehlt < erster) {
      return nein(
        'ziel_gab_es_noch_nicht',
        `${zielName} gibt es im Portal erst seit ${datumText(erster)}. Wählen Sie ein Datum ab dem ${datumText(erster)}.`,
      );
    }
    return nein('ziel_archiviert', `Am ${datumText(fehlt)} war ${zielName} archiviert.`);
  };

  const liste = wirksam(obj.intervalle);
  let danach: Intervall[];
  if (antrag.vorgang === 'korrektur') {
    const ersetzt = liste.find((i) => i.ab === antrag.ab);
    if (ersetzt === undefined) {
      return nein(
        'kein_beginn_an_dem_tag',
        `Am ${datumText(antrag.ab)} beginnt keine Zuordnung von ${obj.anzeige}. ` +
          'Eine Korrektur ersetzt eine Zuordnung ab ihrem Beginn.',
      );
    }
    if (ersetzt.eltern === antrag.eltern) return nein('ziel_ist_bisheriger_eltern', bisherSatz);
    const ziel = zielPruefen(ersetzt.ab, ersetzt.bis);
    if (ziel !== null) return ziel;
    danach = [
      ...obj.intervalle.map((i) => (i === ersetzt ? { ...i, aufgehoben: true } : i)),
      { ab: ersetzt.ab, bis: ersetzt.bis, eltern: antrag.eltern },
    ];
  } else if (liste.length === 0) {
    // Die erste Zuordnung (eine noch nicht zugeordnete Anlage) hat nichts zu beenden.
    const ziel = zielPruefen(antrag.ab, null);
    if (ziel !== null) return ziel;
    danach = [...obj.intervalle, { ab: antrag.ab, bis: null, eltern: antrag.eltern }];
  } else {
    const erster = liste[0].ab;
    if (antrag.ab < erster) {
      return nein(
        'vor_dem_ersten_intervall',
        `${obj.anzeige} gibt es im Portal erst seit ${datumText(erster)}. Wählen Sie ein Datum ab dem ` +
          `${datumText(erster)} — oder ersetzen Sie die Zuordnung ab Beginn (Korrektur).`,
      );
    }
    const laufend = liste.find((i) => deckt(i, antrag.ab));
    if (laufend === undefined) {
      return nein('objekt_archiviert', `Am ${datumText(antrag.ab)} war ${obj.anzeige} archiviert.`);
    }
    if (laufend.ab === antrag.ab) {
      return nein(
        'gleicher_tag',
        `Für den ${datumText(antrag.ab)} gibt es schon eine Zuordnung (${elternName(baum, laufend.eltern ?? '')}). ` +
          'Ändern Sie diese, statt eine zweite anzulegen.',
      );
    }
    if (laufend.eltern === antrag.eltern) return nein('ziel_ist_bisheriger_eltern', bisherSatz);
    const ziel = zielPruefen(antrag.ab, laufend.bis);
    if (ziel !== null) return ziel;
    danach = [
      ...obj.intervalle.map((i) => (i === laufend ? { ...i, bis: plusTage(antrag.ab, -1) } : i)),
      { ab: antrag.ab, bis: laufend.bis, eltern: antrag.eltern },
    ];
  }
  const sortiert = [...danach].sort((a, b) =>
    a.ab !== b.ab ? (a.ab < b.ab ? -1 : 1) : Number(!a.aufgehoben) - Number(!b.aufgehoben),
  );
  return {
    erlaubt: true,
    grund: null,
    text: null,
    intervalle: sortiert.map((i) => ({
      ab: i.ab,
      bis: i.bis,
      eltern: i.eltern,
      aufgehoben: i.aufgehoben === true,
      zustand: zuordnungZustand(i, antrag.heute),
    })),
  };
}

// ────────────────────────────────────────────────────────── Rückwirkung

export const RUECKWIRKUNG_ARTEN = ['rueckwirkend', 'ab_heute', 'geplant'] as const;
export type Rueckwirkung = (typeof RUECKWIRKUNG_ARTEN)[number];

export interface RueckwirkungEingang {
  /** Wann der Eintrag gespeichert wurde (Zeitpunkt mit Versatz). */
  eingetragenUm: string;
  giltAb: Tag;
  /** Das Ende des Intervalls, das der Eintrag anlegt; null = offen. */
  giltBis: Tag | null;
  /** Die Zeitzone des Standorts — sie bestimmt den Eintragstag. */
  zeitzone: string;
  /** Optional ein Berichtszeitraum, gegen den geprüft wird. */
  zeitraum?: { von: Tag; bis: Tag } | null;
}

export interface RueckwirkungErgebnis {
  art: Rueckwirkung;
  eintragstag: Tag;
  /** Wie viele Tage „gilt ab" vor (rückwirkend) bzw. nach (geplant) dem Eintragstag liegt. */
  tage: number;
  abzeichen: string | null;
  /** Die Tage, die NACHTRÄGLICH anders gelten — der Fakt für die Revision (AP-12). */
  rueckwirkendBetroffen: { von: Tag; bis: Tag } | null;
  reichtInZeitraum: boolean | null;
  rueckwirkendImZeitraum: boolean | null;
}

/** E2: Rückwirkung ist erlaubt — aber immer sichtbar. */
export function rueckwirkung(e: RueckwirkungEingang): RueckwirkungErgebnis {
  const eintragstag = lokalerTag(e.eingetragenUm, e.zeitzone);
  const art: Rueckwirkung =
    e.giltAb < eintragstag ? 'rueckwirkend' : e.giltAb === eintragstag ? 'ab_heute' : 'geplant';
  const tage = Math.abs(tageZwischen(e.giltAb, eintragstag));
  const betroffen =
    art === 'rueckwirkend'
      ? {
          von: e.giltAb,
          bis: e.giltBis === null ? plusTage(eintragstag, -1) : minTag(plusTage(eintragstag, -1), e.giltBis),
        }
      : null;
  const z = e.zeitraum ?? null;
  return {
    art,
    eintragstag,
    tage,
    abzeichen: art === 'rueckwirkend' ? `rückwirkend (${tage} ${tage === 1 ? 'Tag' : 'Tage'})` : null,
    rueckwirkendBetroffen: betroffen,
    reichtInZeitraum: z === null ? null : e.giltAb <= z.bis && (e.giltBis === null || e.giltBis >= z.von),
    rueckwirkendImZeitraum:
      z === null ? null : betroffen !== null && betroffen.von <= z.bis && betroffen.bis >= z.von,
  };
}

// ───────────────────────────────────────────── Standort einer Messstelle

export const VERORTUNG_GRUENDE = ['verortet', 'am_unternehmen', 'nicht_verortet', 'ort_nicht_im_baum'] as const;
export type VerortungGrund = (typeof VERORTUNG_GRUENDE)[number];

export interface Verortung {
  ort: string | null;
  /** Vom Ort hinauf bis zum Standort. */
  pfad: string[];
  standort: string | null;
  grund: VerortungGrund;
}

function verortungVon(baum: Ortsbaum, m: Messstelle, tag: Tag): Verortung {
  const iv = intervallAm(m.zuordnungen, tag);
  if (iv === null || iv.eltern === null) return { ort: null, pfad: [], standort: null, grund: 'nicht_verortet' };
  if (iv.eltern === UNTERNEHMEN) return { ort: UNTERNEHMEN, pfad: [], standort: null, grund: 'am_unternehmen' };
  const p = pfadAm(baum, iv.eltern, tag);
  return {
    ort: iv.eltern,
    pfad: p.pfad,
    standort: p.standort,
    grund: p.standort === null ? 'ort_nicht_im_baum' : 'verortet',
  };
}

/** Regel 7: der Standort einer Messstelle ist die Wurzel ihres Ortsknotens AN DIESEM TAG. */
export function verortung(baum: Ortsbaum, messstelle: string, tag: Tag): Verortung {
  const m = baum.messstellen.find((x) => x.kennzeichen === messstelle);
  if (m === undefined) throw new Error(`unbekannte Messstelle: ${messstelle}`);
  return verortungVon(baum, m, tag);
}

// ──────────────────────────────────────────────────────── Folgen-Karte

export interface Folgen {
  ziehenMit: string[];
  messstellenWechselnStandort: string[];
  bleibenAnlagen: string[];
  bleibenNetzanschluesse: string[];
  bleibenMessstellen: string[];
}

export interface FolgenErgebnis {
  erlaubt: boolean;
  grund: EintragGrund | null;
  text: string | null;
  folgen: Folgen | null;
}

function mitIntervallen(baum: Ortsbaum, kz: string, intervalle: Intervall[]): Ortsbaum {
  return {
    ...baum,
    orte: baum.orte.map((o) => (o.kennzeichen === kz ? { ...o, intervalle } : o)),
    anlagen: baum.anlagen.map((a) => (a.kennzeichen === kz ? { ...a, zuordnungen: intervalle } : a)),
    messstellen: baum.messstellen.map((m) => (m.kennzeichen === kz ? { ...m, zuordnungen: intervalle } : m)),
  };
}

/**
 * E11/A13: was die Folgen-Karte vor dem Speichern nennt. Bereiche ziehen mit;
 * eine Messstelle steht dort, wenn ihr Standort am Umzugstag MIT dem Umzug ein
 * anderer ist als OHNE ihn; es bleiben die Anlagen dieser Messstellen, die nicht
 * schon am Ziel-Standort sind, ihre Netzanschlüsse und ihre übrigen Messstellen.
 */
export function verschiebenFolgen(baum: Ortsbaum, antrag: EintragAntrag): FolgenErgebnis {
  const e = eintrag(baum, antrag);
  if (!e.erlaubt || e.intervalle === null) return { erlaubt: false, grund: e.grund, text: e.text, folgen: null };
  const tag = antrag.ab;
  const nachher = mitIntervallen(
    baum,
    antrag.objekt,
    e.intervalle.map((i) => ({ ab: i.ab, bis: i.bis, eltern: i.eltern, aufgehoben: i.aufgehoben })),
  );
  const ziehenMit = baum.orte
    .filter((o) => o.kennzeichen !== antrag.objekt && intervallAm(o.intervalle, tag)?.eltern === antrag.objekt)
    .map((o) => o.kennzeichen);
  const standortVorher = (m: Messstelle) => verortungVon(baum, m, tag).standort;
  const standortNachher = (m: Messstelle) =>
    verortungVon(nachher, nachher.messstellen.find((x) => x.kennzeichen === m.kennzeichen) ?? m, tag).standort;
  const wechseln = baum.messstellen.filter((m) => standortVorher(m) !== standortNachher(m));
  const zielStandort = ort(nachher, antrag.objekt)
    ? pfadAm(nachher, antrag.objekt, tag).standort
    : antrag.eltern;
  const betroffen = new Set(wechseln.map((m) => m.anlage).filter((a): a is string => a !== null));
  const bleibenAnlagen = nachher.anlagen.filter(
    (a) => betroffen.has(a.kennzeichen) && intervallAm(a.zuordnungen, tag)?.eltern !== zielStandort,
  );
  const netz: string[] = [];
  for (const a of bleibenAnlagen) {
    if (a.netzanschluss !== null && !netz.includes(a.netzanschluss)) netz.push(a.netzanschluss);
  }
  const bleibenMessstellen = baum.messstellen.filter(
    (m) =>
      m.anlage !== null &&
      betroffen.has(m.anlage) &&
      !wechseln.includes(m) &&
      standortNachher(m) !== zielStandort,
  );
  return {
    erlaubt: true,
    grund: null,
    text: null,
    folgen: {
      ziehenMit,
      messstellenWechselnStandort: wechseln.map((m) => m.kennzeichen),
      bleibenAnlagen: bleibenAnlagen.map((a) => a.kennzeichen),
      bleibenNetzanschluesse: netz,
      bleibenMessstellen: bleibenMessstellen.map((m) => m.kennzeichen),
    },
  };
}

// ─────────────────────────────────────────────── Archivieren · Löschen

/** Die Reihenfolge der Sperren in der Grundliste und im Satz. */
export const ARCHIV_GRUENDE = [
  'gab_es_noch_nicht',
  'archiviert',
  'anlage_aktiv',
  'messstelle_aktiv',
  'geplante_zuordnung',
] as const;
export type ArchivGrundArt = (typeof ARCHIV_GRUENDE)[number];

export interface ArchivGrund {
  art: ArchivGrundArt;
  kennzeichen: string;
  name: string;
  /** Nur bei `geplante_zuordnung`: ab wann und wohin. */
  ab?: Tag;
  eltern?: string | null;
}

export interface ArchivErgebnis {
  erlaubt: boolean;
  /** ALLE Sperren — die Rückfrage trägt ihre Folgenliste. */
  gruende: ArchivGrund[];
  text: string | null;
  /** Das Objekt und seine mitarchivierten leeren Kinder mit ihrem letzten Tag. */
  archiviert: { kennzeichen: string; letzterTag: Tag }[] | null;
}

/** „a" · „a und b" · „a, b und c" — eine deutsche Aufzählung. */
function aufzaehlung(worte: string[]): string {
  if (worte.length === 1) return worte[0];
  return `${worte.slice(0, -1).join(', ')} und ${worte[worte.length - 1]}`;
}

function archivSatz(name: string, gruende: ArchivGrund[], zielName: (kz: string) => string): string {
  const anlagen = gruende.filter((g) => g.art === 'anlage_aktiv');
  const messstellen = gruende.filter((g) => g.art === 'messstelle_aktiv');
  const geplant = gruende.filter((g) => g.art === 'geplante_zuordnung');
  const teile: string[] = [];
  const wege: string[] = [];
  if (anlagen.length === 1) {
    teile.push(`die Anlage ${anlagen[0].name} ist aktiv`);
    wege.push('Ordnen Sie die Anlage einem anderen Standort zu oder archivieren Sie sie zuerst.');
  } else if (anlagen.length > 1) {
    teile.push(`die Anlagen ${aufzaehlung(anlagen.map((g) => g.name))} sind aktiv`);
    wege.push('Ordnen Sie die Anlagen einem anderen Standort zu oder archivieren Sie sie zuerst.');
  }
  if (messstellen.length > 0) {
    const liste = aufzaehlung(messstellen.map((g) => `${g.kennzeichen} ${g.name}`));
    const eine = messstellen.length === 1;
    teile.push(eine ? `1 Messstelle ist hier aktiv (${liste})` : `${messstellen.length} Messstellen sind hier aktiv (${liste})`);
    wege.push(
      `Ziehen Sie ${eine ? 'die Messstelle' : 'die Messstellen'} zuerst um oder legen Sie sie still (Messstellen).`,
    );
  }
  for (const g of geplant) {
    teile.push(`für ${g.name} ist ab ${datumText(g.ab ?? '')} eine Zuordnung zu ${zielName(g.eltern ?? '')} geplant`);
  }
  if (geplant.length > 0) {
    wege.push(
      geplant.length === 1
        ? 'Heben Sie die geplante Zuordnung zuerst auf.'
        : 'Heben Sie die geplanten Zuordnungen zuerst auf.',
    );
  }
  return `${name} kann nicht archiviert werden: ${aufzaehlung(teile)}. ${wege.join(' ')}`;
}

/**
 * E12: nur ohne aktive Anlage (am Standort), ohne aktive Messstelle im
 * Teilbaum und ohne geplante Zuordnung hinein oder heraus; leere Kinder werden
 * mitarchiviert, jedes Intervall endet am Vortag. Keine Kaskade auf
 * Messstellen oder Anlagen.
 */
export function archivieren(baum: Ortsbaum, objekt: string, tag: Tag): ArchivErgebnis {
  const o = ort(baum, objekt);
  if (o === undefined) throw new Error(`unbekannter Ort: ${objekt}`);
  const b = bestand(o.intervalle, tag);
  if (b !== 'vorhanden') {
    return {
      erlaubt: false,
      gruende: [{ art: b, kennzeichen: objekt, name: o.name }],
      text: bestandSatz(b, o.name, tag),
      archiviert: null,
    };
  }
  const teilbaum = baum.orte
    .filter((x) => pfadAm(baum, x.kennzeichen, tag).pfad.includes(objekt))
    .map((x) => x.kennzeichen);
  const drin = (kz: string | null) => kz !== null && teilbaum.includes(kz);
  const gruende: ArchivGrund[] = [];
  if (o.art === 'standort') {
    for (const a of baum.anlagen) {
      if (a.zustand === 'aktiv' && intervallAm(a.zuordnungen, tag)?.eltern === objekt) {
        gruende.push({ art: 'anlage_aktiv', kennzeichen: a.kennzeichen, name: a.name });
      }
    }
  }
  for (const m of baum.messstellen) {
    if (m.zustand === 'aktiv' && drin(intervallAm(m.zuordnungen, tag)?.eltern ?? null)) {
      gruende.push({ art: 'messstelle_aktiv', kennzeichen: m.kennzeichen, name: m.name });
    }
  }
  const geplant = (kz: string, name: string, liste: Intervall[], eigen: boolean) => {
    for (const i of wirksam(liste)) {
      if (i.ab > tag && (eigen || drin(i.eltern))) {
        gruende.push({ art: 'geplante_zuordnung', kennzeichen: kz, name, ab: i.ab, eltern: i.eltern });
      }
    }
  };
  for (const x of baum.orte) geplant(x.kennzeichen, x.name, x.intervalle, drin(x.kennzeichen));
  for (const a of baum.anlagen) if (a.zustand === 'aktiv') geplant(a.kennzeichen, a.name, a.zuordnungen, false);
  for (const m of baum.messstellen) {
    if (m.zustand === 'aktiv') geplant(m.kennzeichen, `${m.kennzeichen} ${m.name}`, m.zuordnungen, false);
  }
  if (gruende.length > 0) {
    return {
      erlaubt: false,
      gruende,
      text: archivSatz(o.name, gruende, (kz) => elternName(baum, kz)),
      archiviert: null,
    };
  }
  const letzterTag = plusTage(tag, -1);
  return { erlaubt: true, gruende: [], text: null, archiviert: teilbaum.map((kennzeichen) => ({ kennzeichen, letzterTag })) };
}

export const WIEDERHERSTELL_GRUENDE = ['nicht_archiviert', 'eltern_archiviert', 'name_belegt'] as const;
export type WiederherstellGrund = (typeof WIEDERHERSTELL_GRUENDE)[number];

export interface WiederherstellErgebnis {
  erlaubt: boolean;
  grund: WiederherstellGrund | null;
  text: string | null;
  intervall: { ab: Tag; bis: Tag | null; eltern: string | null } | null;
  name: string | null;
  /** Die Zeit dazwischen — sichtbar, nie aufgefüllt. */
  luecke: { von: Tag; bis: Tag } | null;
}

function namensSchluessel(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Ein NEUES Intervall ab dem Tag am alten Elternknoten; die Lücke bleibt; der
 * Name muss unter den Geschwistern derselben Art frei sein (ohne Groß-/
 * Kleinschreibung und Randleerzeichen). Mitarchivierte Kinder kommen nicht
 * still mit zurück.
 */
export function wiederherstellen(
  baum: Ortsbaum,
  objekt: string,
  tag: Tag,
  neuerName?: string | null,
): WiederherstellErgebnis {
  const o = ort(baum, objekt);
  if (o === undefined) throw new Error(`unbekannter Ort: ${objekt}`);
  const nichts = { intervall: null, name: null, luecke: null };
  const liste = wirksam(o.intervalle);
  const letzte = liste[liste.length - 1];
  if (letzte === undefined || liste.some((i) => i.bis === null || i.bis >= tag)) {
    return { erlaubt: false, grund: 'nicht_archiviert', text: `${o.name} ist nicht archiviert.`, ...nichts };
  }
  const eltern = letzte.eltern;
  if (eltern !== null && !vorhanden(baum, eltern, tag)) {
    return {
      erlaubt: false,
      grund: 'eltern_archiviert',
      text: `${o.name} kann erst wiederhergestellt werden, wenn ${elternName(baum, eltern)} wiederhergestellt ist.`,
      ...nichts,
    };
  }
  const name = (neuerName ?? o.name).trim();
  const belegt = baum.orte.find(
    (x) =>
      x.kennzeichen !== objekt &&
      x.art === o.art &&
      intervallAm(x.intervalle, tag) !== null &&
      (intervallAm(x.intervalle, tag)?.eltern ?? null) === eltern &&
      namensSchluessel(x.name) === namensSchluessel(name),
  );
  if (belegt !== undefined) {
    return {
      erlaubt: false,
      grund: 'name_belegt',
      text:
        `Diesen Namen gibt es hier schon: ${belegt.name} (${belegt.kennzeichen}). Wählen Sie einen anderen Namen — ` +
        `oder öffnen Sie ${belegt.name}.`,
      ...nichts,
    };
  }
  const von = plusTage(letzte.bis ?? tag, 1);
  const bis = plusTage(tag, -1);
  return {
    erlaubt: true,
    grund: null,
    text: null,
    intervall: { ab: tag, bis: null, eltern },
    name,
    luecke: von <= bis ? { von, bis } : null,
  };
}

export const LOESCH_GRUENDE = ['hat_messstellen', 'hat_anlagen', 'hat_flaeche', 'hat_kinder'] as const;
export type LoeschGrund = (typeof LOESCH_GRUENDE)[number];

/** E1: Löschen nur ohne JE eine Messstelle, Anlage (am Standort), Fläche oder ein Kind. */
export function loeschen(baum: Ortsbaum, objekt: string): { erlaubt: boolean; gruende: LoeschGrund[] } {
  const o = ort(baum, objekt);
  if (o === undefined) throw new Error(`unbekannter Ort: ${objekt}`);
  const hing = (liste: Intervall[]) => liste.some((i) => i.eltern === objekt);
  const gruende: LoeschGrund[] = [];
  if (baum.messstellen.some((m) => hing(m.zuordnungen))) gruende.push('hat_messstellen');
  if (o.art === 'standort' && baum.anlagen.some((a) => hing(a.zuordnungen))) gruende.push('hat_anlagen');
  if ((o.flaechen ?? []).length > 0) gruende.push('hat_flaeche');
  if (baum.orte.some((x) => hing(x.intervalle))) gruende.push('hat_kinder');
  return { erlaubt: gruende.length === 0, gruende };
}

// ──────────────────────────────────────────────────── Zeitraum-Teilung

export type TeilGrund = Exclude<Bestand, 'vorhanden'> | Exclude<VerortungGrund, 'verortet'>;

export interface Teil {
  von: Tag;
  bis: Tag;
  standort: string | null;
  /** Warum ein Teil keinen Standort hat; null, wenn er einen hat. */
  grund: TeilGrund | null;
  /** 00:00 Uhr am ersten Tag in der Zeitzone des Standorts (ohne Standort: des Unternehmens). */
  beginn: string;
  /** 00:00 Uhr am Tag nach dem letzten — ausschließlich. */
  ende: string;
  stunden: number;
}

function standortAm(baum: Ortsbaum, objekt: string, tag: Tag): { standort: string | null; grund: TeilGrund | null } {
  const o = ort(baum, objekt);
  if (o !== undefined) {
    const b = bestand(o.intervalle, tag);
    if (b !== 'vorhanden') return { standort: null, grund: b };
    const p = pfadAm(baum, objekt, tag);
    return p.standort === null ? { standort: null, grund: 'ort_nicht_im_baum' } : { standort: p.standort, grund: null };
  }
  const v = verortung(baum, objekt, tag);
  return v.grund === 'verortet' ? { standort: v.standort, grund: null } : { standort: null, grund: v.grund };
}

/**
 * Regel 5: ein Zeitraum wird TAGESGENAU an jedem Wechsel des Standorts geteilt
 * (Februar → alter, März → neuer Standort). Ein Ortswechsel innerhalb des
 * Standorts teilt nicht; eine Lücke ist ein eigener Teil ohne Standort.
 */
export function teile(baum: Ortsbaum, objekt: string, von: Tag, bis: Tag): Teil[] {
  const laeufe: { von: Tag; bis: Tag; standort: string | null; grund: TeilGrund | null }[] = [];
  for (let tag = von; tag <= bis; tag = plusTage(tag, 1)) {
    const s = standortAm(baum, objekt, tag);
    const letzter = laeufe[laeufe.length - 1];
    if (letzter !== undefined && letzter.standort === s.standort && letzter.grund === s.grund) {
      letzter.bis = tag;
    } else {
      laeufe.push({ von: tag, bis: tag, ...s });
    }
  }
  return laeufe.map((l) => {
    const zone = zeitzoneVon(baum, l.standort);
    const beginn = mitternacht(l.von, zone);
    const ende = mitternacht(plusTage(l.bis, 1), zone);
    return { ...l, beginn: beginn.iso, ende: ende.iso, stunden: Math.round((ende.ms - beginn.ms) / 3_600_000) };
  });
}
