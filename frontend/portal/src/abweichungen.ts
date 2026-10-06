/**
 * UEMS AP-18 IP-18 (§5.2, §5.3, §5.7, A2–A6, U1–U3, SP1–SP4): das reine Bild der Auffälligkeiten und Abweichungen —
 * die Vermerk-Zeile am Monat der Vergleichs-Fläche, das Register „Abweichungen“ und die Abweichungs-Seite. **Hier wird
 * nichts gerechnet:** der Anlass ist die Kopie der Route (Prüfsumme), „überfällig seit n Tagen“ kommt aus `frist`
 * (E5 = A), die Vergleichszeilen aus dem Leser. Das Portal ordnet, filtert und prüft nur die Form; entschieden wird an
 * der Route. Eine Ursache ist immer die Aussage einer Person („Aussage von …“) — nie ein Satz des Systems (U3).
 */
import { ApiError, type Abweichung, type AbweichungEintrag, type AbweichungErgebnis, type Auffaelligkeit } from './api';
import { monatWort } from './bezugsbasisVergleich';
import { BEGRUENDUNG_HINWEIS, begruendungOk, tag } from './energieziele';
import type { MassnahmeVorbelegung } from './massnahmen';
import { monateText, monateWert } from './massnahmen';
import {
  UEMS_ABWEICHUNG,
  UEMS_ABWEICHUNG_ERGEBNISSE,
  UEMS_ABWEICHUNG_ZUSTAENDE,
  UEMS_ABWEICHUNGEN,
  UEMS_AUFFAELLIGKEIT,
  UEMS_AUSSAGE_VON,
  UEMS_MASSNAHME,
  UEMS_UEBERFAELLIG_SEIT,
  UEMS_VERANTWORTLICH,
  UEMS_VERLAUF,
  UEMS_ZUR_KENNTNIS_GENOMMEN,
} from './glossar';

// ------------------------------------------------------------------ Wörter

export const KNOPF_EROEFFNEN = `${UEMS_ABWEICHUNG} eröffnen`;
export const KNOPF_ZUR_KENNTNIS = 'zur Kenntnis nehmen';
export const KNOPF_ABSCHLIESSEN = 'Abschließen';
export const KNOPF_FRIST = 'Frist ändern';
export const KNOPF_VERANTWORTLICH = `${UEMS_VERANTWORTLICH} ändern`;
export const KNOPF_KOMMENTAR = 'Kommentar';
export const KNOPF_AUSSAGE = 'Aussage festhalten';
export const KNOPF_KOMMENTAR_SCHREIBEN = 'Kommentar schreiben';
export const KNOPF_MASSNAHME_ANLEGEN = `Neue ${UEMS_MASSNAHME} anlegen`;
export const ZUR_LISTE = `Alle ${UEMS_ABWEICHUNGEN}`;
export const VERLAUF = UEMS_VERLAUF;
export const PRUEFSUMME = 'Prüfsumme';
export const FRIST = 'Frist';
export const ANLASS = 'Anlass';
export const ANLASS_KOPIE = 'Anlass — Kopie, wie er beim Eröffnen gelesen wurde';
export const VORBEHALTE = 'Vorbehalte';
export const VERGLEICH_JETZT = 'Vergleichszeilen, wie der Vergleich sie heute liest';
export const VERGLEICH_FEHLT = 'Die Vergleichszeilen sind gerade nicht abrufbar — der Anlass oben ist die gespeicherte Kopie.';
export const ABSCHLUSS = 'Abschluss';
export const KOMMENTAR_MAX = 2000;

export const SPALTEN = {
  kennzeichen: UEMS_ABWEICHUNG,
  zustand: 'Zustand',
  kennzahl: 'Kennzahl',
  frist: FRIST,
  verantwortlich: UEMS_VERANTWORTLICH,
  ergebnis: 'Ergebnis',
} as const;

export const FILTER = {
  zustand: 'Zustand',
  kennzahl: 'Kennzahl',
  ueberfaellig: 'nur überfällige',
  alle: 'alle',
} as const;

export const ZUSTAND_WORT = UEMS_ABWEICHUNG_ZUSTAENDE;
export const ERGEBNIS_WORT = UEMS_ABWEICHUNG_ERGEBNISSE;
export const LADEFEHLER = `Die ${UEMS_ABWEICHUNGEN} konnten nicht geladen werden.`;
export const LADEFEHLER_SEITE = `Die ${UEMS_ABWEICHUNG} konnte nicht geladen werden.`;
export const NICHT_GEFUNDEN = `Diese ${UEMS_ABWEICHUNG} gibt es nicht oder Sie dürfen sie nicht sehen.`;
export const LEER = `Noch keine ${UEMS_ABWEICHUNGEN}. Sie entstehen aus einer ${UEMS_AUFFAELLIGKEIT} oder von Hand an einer Zeile im Vergleich mit der Bezugsbasis.`;
export const LEER_GEFILTERT = `Keine ${UEMS_ABWEICHUNG} passt zu dieser Auswahl.`;

export const HERKUNFT_WORT: Record<Abweichung['herkunft']['art'], string> = {
  auffaelligkeit: `aus einer ${UEMS_AUFFAELLIGKEIT}`,
  von_hand: 'von Hand eröffnet',
};

export const VERLAUF_WORT: Record<AbweichungEintrag['art'], string> = {
  abweichung_eroeffnet: 'eröffnet',
  kommentar: 'Kommentar',
  ursache_aussage: 'Ursache-Aussage eingetragen',
  abweichung_geaendert: 'Frist geändert',
  verantwortlicher_geaendert: `${UEMS_VERANTWORTLICH} geändert`,
  abweichung_abgeschlossen: 'abgeschlossen',
};

/** Die Vermerk-Zeile am Monat (§5.2): „Auffälligkeit — vermerkt am 07.01.2028“. */
export const vermerktAm = (tag: string) => `${UEMS_AUFFAELLIGKEIT} — vermerkt am ${tag}`;
export const OFFEN_FRAGE = `Offen: ${KNOPF_EROEFFNEN} oder ${KNOPF_ZUR_KENNTNIS}.`;
export const zurKenntnisVon = (person: string, tag: string, begruendung: string | null) =>
  `${UEMS_ZUR_KENNTNIS_GENOMMEN} von ${person} am ${tag}${begruendung ? `: ‚${begruendung}‘` : '.'}`;
export const eroeffnetAls = (kennung: string) => `beantwortet: ${UEMS_ABWEICHUNG} ${kennung} eröffnet`;
/** Die Antwort `abweichung` nimmt ALLE offenen Vermerke derselben Kennzahl × Fassung mit (A2). */
export const mitgenommen = (monate: string[]) =>
  `Die ${UEMS_ABWEICHUNG} übernimmt alle offenen ${UEMS_AUFFAELLIGKEIT}en dieser Kennzahl und Fassung: ${monate.join(', ')}.`;
export const VON_HAND_HINWEIS =
  'Von Hand an dieser Zeile — auch „im Rahmen“ darf eine Person etwas untersuchen. Der Anlass ist die Kopie des Vergleichs dieses Monats.';
export const WORTLAUT_HINWEIS = 'Pflicht, 10 bis 500 Zeichen: warum diese Zeile untersucht wird.';
export const FRIST_HINWEIS = 'Ohne Angabe: 30 Tage nach dem Eröffnen. Nie vor dem Eröffnungstag.';
export const AUSSAGE_HINWEIS = `Eine Ursache ist immer die ${UEMS_AUSSAGE_VON} einer Person — das System nennt keine. Wer einträgt, muss nicht wer aussagt sein.`;
export const BELEG_HINWEIS = 'Wahlfrei: eine Kennung, die die Aussage stützt (Korrektur K-…, Messbedarf MB-…, Ereignis). Ohne Beleg heißt sie „keine Messung“.';
export const ABSCHLUSS_HINWEIS = `Einmalig. Nichts an der Kennzahl ändert sich — Vergleich, Kennzahl und Bezugsbasis bleiben, wie sie sind.`;
export const MASSNAHME_WAHL = `Bestehende ${UEMS_MASSNAHME}`;
export const MASSNAHME_ODER = `oder eine neue ${UEMS_MASSNAHME} anlegen — vorbelegt mit dieser ${UEMS_ABWEICHUNG}, ihrer Kennzahl und den Monaten des Anlasses.`;

// ------------------------------------------------------------------ Register

/** „überfällig seit n Tagen“ — die Zahl kommt aus `frist` der Route (E5 = A), nie aus dem Portal. */
export function ueberfaelligText(a: Pick<Abweichung, 'frist' | 'zustand'>): string | null {
  const f = a.frist;
  return a.zustand === 'offen' && f.faellig === 'ueberfaellig' && f.seit_tagen !== null ? UEMS_UEBERFAELLIG_SEIT(f.seit_tagen) : null;
}

/** Offene zuerst — überfällige oben (die längste Frist zuerst), dann nach Frist; abgeschlossene danach, neueste oben. */
export function ordnen(liste: readonly Abweichung[]): Abweichung[] {
  const rang = (a: Abweichung) => (a.zustand === 'offen' ? (a.frist.faellig === 'ueberfaellig' ? 0 : 1) : 2);
  return [...liste].sort(
    (a, b) =>
      rang(a) - rang(b) ||
      (b.frist.seit_tagen ?? 0) - (a.frist.seit_tagen ?? 0) ||
      (rang(a) === 2 ? (b.abschluss?.am ?? '').localeCompare(a.abschluss?.am ?? '') : a.frist.termin.localeCompare(b.frist.termin)) ||
      a.kennzeichen.localeCompare(b.kennzeichen),
  );
}

export interface RegisterFilter {
  zustand: Abweichung['zustand'] | '';
  kennzahl: string;
  ueberfaellig: boolean;
}
export const FILTER_LEER: RegisterFilter = { zustand: '', kennzahl: '', ueberfaellig: false };

export function filtern(liste: readonly Abweichung[], f: RegisterFilter): Abweichung[] {
  return liste.filter(
    (a) =>
      (!f.zustand || a.zustand === f.zustand) &&
      (!f.kennzahl || a.kennzahl.id === f.kennzahl) &&
      (!f.ueberfaellig || ueberfaelligText(a) !== null),
  );
}

export const kennzahlText = (k: Abweichung['kennzahl']) => `${k.kennzeichen ?? ''} ${k.name ?? ''}`.trim();

export function kennzahlOptionen(liste: readonly Abweichung[]): { value: string; label: string }[] {
  const gesehen = new Map<string, string>();
  for (const a of liste) if (!gesehen.has(a.kennzahl.id)) gesehen.set(a.kennzahl.id, kennzahlText(a.kennzahl));
  return [...gesehen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'de'));
}

/** Die Monate der Abweichung als Wort: „Dezember 2027“ bzw. „November bis Dezember 2027“ (Kalender, keine Rechnung). */
export function monateDerAbweichung(monate: readonly string[]): string {
  if (monate.length === 0) return '';
  const sortiert = [...monate].sort();
  return monate.length <= 2 ? sortiert.map(monatWort).join(', ') : monateText(sortiert[0], sortiert[sortiert.length - 1]);
}

/** Das Ergebnis im Register: „Maßnahme M-2028-0001“, „erklärt“ … — nur abgeschlossen. */
export function ergebnisText(a: Pick<Abweichung, 'abschluss'>): string | null {
  const s = a.abschluss;
  if (!s) return null;
  return s.ergebnis === 'massnahme' && s.massnahme?.kennzeichen ? `${UEMS_MASSNAHME} ${s.massnahme.kennzeichen}` : ERGEBNIS_WORT[s.ergebnis];
}

// ------------------------------------------------------------------ Seite

/** Der Kopf, wenn die Route keinen `kopf_satz` hat (mehrere Monate oder kein Δ): dieselben Teile ohne Zahl. */
export function kopfZeile(a: Abweichung, tag: (iso: string) => string): string {
  return (
    a.kopf_satz ??
    `${UEMS_ABWEICHUNG} ${a.kennzeichen} · ${kennzahlText(a.kennzahl)}, ${monateDerAbweichung(a.monate)} · ${UEMS_VERANTWORTLICH} ${a.verantwortlich.name} · ${FRIST} ${tag(a.frist.termin)} · ${ZUSTAND_WORT[a.zustand]}.`
  );
}

/**
 * Die Sätze des Lesers in der gespeicherten Kopie — so, wie sie beim Vermerk bzw. beim Eröffnen standen: ein Vermerk
 * (`satz`), mehrere Vermerke (`vermerke[].satz`), von Hand (`vergleich[].satz`, dazu der Zeitraum). Nichts wird neu gebildet.
 */
export function anlassSaetze(inhalt: Record<string, unknown> | null | undefined): string[] {
  if (!inhalt || typeof inhalt !== 'object') return [];
  const aus: string[] = [];
  const nimm = (x: unknown) => {
    if (x && typeof x === 'object' && typeof (x as { satz?: unknown }).satz === 'string') aus.push((x as { satz: string }).satz);
  };
  if (Array.isArray(inhalt.vermerke)) inhalt.vermerke.forEach(nimm);
  else if (Array.isArray(inhalt.vergleich)) {
    inhalt.vergleich.forEach(nimm);
    if ((inhalt.vergleich as unknown[]).length > 1) nimm(inhalt.zeitraum);
  } else nimm(inhalt);
  return aus;
}

/** Offen ändern, kommentieren, aussagen, abschließen — nur solange die Abweichung offen ist (A4, A6). */
export const offen = (a: Pick<Abweichung, 'zustand'>) => a.zustand === 'offen';

/** Vorbelegung des Dialogs „Maßnahme anlegen“ aus dem Abschluss (IP-13, §5.3): Herkunft, Kennung, Kennzahl, Monate. */
export function massnahmeVorbelegung(a: Pick<Abweichung, 'kennzeichen' | 'kennzahl' | 'monate'>): MassnahmeVorbelegung {
  const sortiert = [...a.monate].sort();
  return {
    herkunft: 'abweichung',
    herkunftKennung: a.kennzeichen,
    kennzahl: a.kennzahl.id,
    ...(sortiert.length ? { monate: monateWert(sortiert[0], sortiert[sortiert.length - 1]) } : {}),
  };
}

// ------------------------------------------------------------------ Vermerke an der Vergleichs-Fläche

/** Die Vermerke je Monat (`JJJJ-MM`) — ein Monat kann einen je Fassung haben. */
export function vermerkeJeMonat(vermerke: readonly Auffaelligkeit[]): Map<string, Auffaelligkeit[]> {
  const jeMonat = new Map<string, Auffaelligkeit[]>();
  for (const v of vermerke) jeMonat.set(v.periode, [...(jeMonat.get(v.periode) ?? []), v]);
  return jeMonat;
}

/** Die offenen Vermerke derselben Kennzahl × Fassung — sie gehen mit der Antwort `abweichung` hinein (A2). */
export const offeneDerFassung = (vermerke: readonly Auffaelligkeit[], v: Auffaelligkeit) =>
  vermerke.filter((x) => x.zustand === 'offen' && x.fassung === v.fassung && x.bezugsbasis.id === v.bezugsbasis.id).sort((a, b) => a.periode.localeCompare(b.periode));

// ------------------------------------------------------------------ Form-Regeln (die fachlichen entscheidet die Route)

export const wortlautOk = (t: string) => t.trim().length >= 10 && t.trim().length <= 500;
export const fristOk = (t: string) => t === '' || /^\d{4}-\d{2}-\d{2}$/.test(t);
export { BEGRUENDUNG_HINWEIS, begruendungOk };

export interface AussageEntwurf {
  wortlaut: string;
  person: string;
  am: string;
  beleg: string;
}

export function aussagePruefen(e: AussageEntwurf, heute: string): Partial<Record<keyof AussageEntwurf, string>> {
  return {
    ...(!wortlautOk(e.wortlaut) ? { wortlaut: 'Der Wortlaut der Aussage hat 10 bis 500 Zeichen.' } : {}),
    ...(!e.person ? { person: 'Bitte wählen Sie, wer die Aussage gemacht hat.' } : {}),
    ...(!/^\d{4}-\d{2}-\d{2}$/.test(e.am) || e.am > heute ? { am: 'Der Tag der Aussage liegt nie in der Zukunft.' } : {}),
  };
}

/** Der Abschluss (A6): Ergebnis und Begründung immer; bei `massnahme` der Verweis auf eine Maßnahme. */
export function abschlussPruefen(ergebnis: AbweichungErgebnis | '', begruendung: string, massnahme: string) {
  return {
    ...(!ergebnis ? { ergebnis: 'Bitte wählen Sie ein Ergebnis.' } : {}),
    ...(ergebnis === 'massnahme' && !massnahme ? { massnahme: `Bitte wählen Sie eine ${UEMS_MASSNAHME} — oder legen Sie eine neue an.` } : {}),
    ...(!begruendungOk(begruendung) ? { begruendung: BEGRUENDUNG_HINWEIS } : {}),
  } as Partial<Record<'ergebnis' | 'massnahme' | 'begruendung', string>>;
}

// ------------------------------------------------------------------ Ablehnungen der Route

export const ABLEHNUNG: Record<string, string> = {
  auffaelligkeit_beantwortet: `Diese ${UEMS_AUFFAELLIGKEIT} ist schon beantwortet — die Antwort ist einmalig.`,
  abweichung_abgeschlossen: `Diese ${UEMS_ABWEICHUNG} ist abgeschlossen — sie lässt sich nicht mehr ändern.`,
  massnahme_fehlt: `Bitte wählen Sie eine ${UEMS_MASSNAHME} — oder legen Sie eine neue an.`,
  massnahme_unbekannt: `Diese ${UEMS_MASSNAHME} gibt es nicht oder Sie dürfen sie nicht sehen.`,
  benutzer_unbekannt: 'Diese Person hat kein aktives Konto in Ihrem Kundenbereich.',
  verantwortlich_fehlt: 'Bitte wählen Sie, wer verantwortlich ist.',
  frist_vor_eroeffnung: 'Die Frist liegt nie vor dem Tag des Eröffnens.',
  begruendung_fehlt: BEGRUENDUNG_HINWEIS,
  wortlaut_fehlt: 'Bitte schreiben Sie 10 bis 500 Zeichen.',
  text_ungueltig: `Ein Kommentar hat 1 bis ${KOMMENTAR_MAX.toLocaleString('de-DE')} Zeichen.`,
  aussage_ohne_person: 'Bitte wählen Sie, wer die Aussage gemacht hat.',
  aussage_in_der_zukunft: 'Der Tag der Aussage liegt nie in der Zukunft.',
  monate_nicht_abgeschlossen: 'Eröffnen geht nur an abgeschlossenen Monaten, höchstens zwölf.',
  monat_ohne_fassung: 'Für diesen Monat gilt keine freigegebene Fassung der Bezugsbasis.',
  monate_verschiedene_fassungen: `Eine ${UEMS_ABWEICHUNG} zitiert genau eine Fassung der Bezugsbasis.`,
  kennzahl_ohne_bezugsbasis: 'Diese Kennzahl hat keine freigegebene Bezugsbasis.',
  recht_fehlt: 'Dafür fehlt Ihnen das Recht an dieser Kennzahl.',
};

function code(e: unknown): string | null {
  const body = e instanceof ApiError && e.body && typeof e.body === 'object' ? (e.body as { code?: unknown }) : null;
  return typeof body?.code === 'string' ? body.code : null;
}

export function ablehnungSatz(e: unknown): string {
  const c = code(e);
  if (c && ABLEHNUNG[c]) return ABLEHNUNG[c];
  const body = e instanceof ApiError && e.body && typeof e.body === 'object' ? (e.body as { message?: unknown }) : null;
  if (typeof body?.message === 'string' && body.message) return body.message;
  return e instanceof Error && e.message ? e.message : 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.';
}

// ------------------------------------------------------------------ Verbessern-Konzept v1 (PR3): Reiter, Blatt, Seite
//
// Der Reiter „Abweichungen“ beginnt mit dem, was auf eine Antwort wartet (offene Auffälligkeiten über alle sichtbaren
// Kennzahlen, Entscheid 4), dann was in Arbeit ist, zuletzt was daraus wurde. Die Seite einer Abweichung erzählt sie als
// kurze Geschichte: Stufen, Ergebnis oben, was auffiel, was dazu bekannt ist, was daraus wurde. Zahlen stehen so da, wie
// die Kopie sie trägt - gelesen, gerundet für die Anzeige, nie neu gerechnet.

/** Eine Menge aus der Kopie: der Text der Zahl (`88740`, `81984.5`) und ihre Einheit. */
export interface Menge {
  wert: string;
  einheit: string;
}

/** Was auffiel, aus der gespeicherten Kopie EINES Monats gelesen; `null`-Felder trägt die Kopie nicht. */
export interface AnlassZahlen {
  monat: string | null;
  gemessen: Menge | null;
  erwartet: Menge | null;
  /** Die Bedingung des Monats (Produktionsmenge, Fläche …) mit ihrem Namen, wenn die Kopie ihn nennt. */
  bedingung: (Menge & { name: string | null }) | null;
  /** Δ in Prozent als Text der Kopie (`12.9`); positiv heißt mehr als erwartet. */
  delta: string | null;
  band: string | null;
}

const feldText = (x: unknown): string | null =>
  typeof x === 'number' && Number.isFinite(x) ? String(x) : typeof x === 'string' && x.trim() !== '' ? x.trim() : null;
const feldObjekt = (x: unknown): Record<string, unknown> | null =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
const mengeAus = (wert: unknown, einheit: string): Menge | null => {
  const w = feldText(wert);
  return w === null || Number.isNaN(Number(w)) ? null : { wert: w, einheit };
};

function ausBereinigt(monat: string | null, b: Record<string, unknown> | null): AnlassZahlen | null {
  if (!b) return null;
  const g = feldObjekt(b.gemessen);
  const einheit = feldText(g?.einheit) ?? 'kWh';
  const bed = Array.isArray(b.bedingung) ? feldObjekt(b.bedingung[0]) : null;
  const bedMenge = bed ? mengeAus(bed.wert, feldText(bed.einheit) ?? '') : null;
  return {
    monat,
    gemessen: g ? mengeAus(g.wert, einheit) : null,
    erwartet: mengeAus(b.erwartet, einheit),
    bedingung: bedMenge ? { ...bedMenge, name: feldText(bed?.name) } : null,
    delta: feldText(b.delta_prozent),
    band: feldText(b.band_prozent),
  };
}

/** Die flache Kopie der Referenzwelt: `bedingung` als `{"BZ-1_kg": 250000}` oder `flaeche_m2`. */
function flacheBedingung(o: Record<string, unknown>): AnlassZahlen['bedingung'] {
  const b = feldObjekt(o.bedingung);
  if (b) {
    for (const [schluessel, wert] of Object.entries(b)) {
      if (schluessel === 'fassung') continue;
      const m = mengeAus(wert, /_([^_]+)$/.exec(schluessel)?.[1] ?? '');
      if (m) return { ...m, name: null };
    }
  }
  const flaeche = mengeAus(o.flaeche_m2, 'm²');
  return flaeche ? { ...flaeche, name: null } : null;
}

/**
 * Was auffiel, aus jeder Form der Kopie: ein Vermerk der Naht (`bereinigt`), die flache Kopie der Referenzwelt,
 * von Hand über genau einen Monat (`vergleich[0]`) oder ein einzelner übernommener Vermerk (`vermerke[0]`). Über
 * mehrere Monate gibt es keine eine Zahl - dann sprechen die Sätze der Kopie (`anlassSaetze`).
 */
export function anlassZahlen(inhalt: unknown): AnlassZahlen | null {
  const o = feldObjekt(inhalt);
  if (!o) return null;
  if (Array.isArray(o.vermerke)) return o.vermerke.length === 1 ? anlassZahlen(o.vermerke[0]) : null;
  if (Array.isArray(o.vergleich)) {
    const m = o.vergleich.length === 1 ? feldObjekt(o.vergleich[0]) : null;
    return m ? ausBereinigt(feldText(m.periode), feldObjekt(m.bereinigt)) : null;
  }
  if (feldObjekt(o.bereinigt)) return ausBereinigt(feldText(o.monat), feldObjekt(o.bereinigt));
  const delta = feldText(o.delta_prozent);
  const gemessen = mengeAus(o.gemessen_kwh, 'kWh');
  if (delta === null && gemessen === null) return null;
  return { monat: feldText(o.monat), gemessen, erwartet: mengeAus(o.erwartet_kwh, 'kWh'), bedingung: flacheBedingung(o), delta, band: feldText(o.band_prozent) };
}

/** `88740` → „88.740“, `81984.5` → „81.985“ - nur Anzeige. */
export const zahlDe = (wert: string, stellen = 0) =>
  Number(wert).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: stellen });
export const mengeText = (m: Menge) => `${zahlDe(m.wert)} ${m.einheit}`.trimEnd();
/** `12.9` → „12,9 % mehr“, `-2.7` → „2,7 % weniger“. */
export function deltaWort(delta: string): string {
  const d = Number(delta);
  return `${Math.abs(d).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} % ${d < 0 ? 'weniger' : 'mehr'}`;
}
/** `2.0` → „± 2 %“. */
export const bandText = (band: string) => `± ${zahlDe(band, 1)} %`;
const istMehr = (z: AnlassZahlen | null) => z?.delta != null && Number(z.delta) > 0;

/** Der Name einer Kennzahl, wie die Liste ihn zeigt; ohne Namen das Kennzeichen. */
export const kennzahlName = (k: { kennzeichen: string | null; name: string | null }) => k.name ?? k.kennzeichen ?? '';

/** „März 2029: 2,2 % mehr als erwartet“ - der Titel einer Auffälligkeit. */
export function auffaelligkeitTitel(v: Pick<Auffaelligkeit, 'periode' | 'anlass_inhalt'>): string {
  const z = anlassZahlen(v.anlass_inhalt);
  return `${monatWort(v.periode)}: ${z?.delta ? `${deltaWort(z.delta)} als erwartet` : 'über der Erwartung'}`;
}

/** „Dezember 2027: 12,9 % mehr“ - kurz für die Reihen; mehrere Monate ohne Zahl. */
export function kurzTitel(monate: readonly string[], inhalt: unknown): string {
  const z = monate.length === 1 ? anlassZahlen(inhalt) : null;
  return `${monateDerAbweichung(monate)}${z?.delta ? `: ${deltaWort(z.delta)}` : ''}`;
}

/** Der Titel einer Abweichung (V6: was auffiel, nie das Kennzeichen): „Dezember 2027: 12,9 % mehr als erwartet“. */
export function abweichungTitel(a: Pick<Abweichung, 'monate' | 'anlass_inhalt'>): string {
  const z = a.monate.length === 1 ? anlassZahlen(a.anlass_inhalt) : null;
  return `${monateDerAbweichung(a.monate)}: ${z?.delta ? `${deltaWort(z.delta)} als erwartet` : 'anders als erwartet'}`;
}

/** „88.740 kWh statt 86.812 bei 306.000 kg“ - die Zahlen einer Auffälligkeit in einer Zeile. */
export function zahlenZeile(z: AnlassZahlen | null): string | null {
  if (!z?.gemessen) return null;
  const bei = z.bedingung ? ` bei ${mengeText(z.bedingung)}` : '';
  return z.erwartet ? `${mengeText(z.gemessen)} statt ${zahlDe(z.erwartet.wert)}${bei}` : `${mengeText(z.gemessen)} gemessen${bei}`;
}

/** „88.740 kWh gemessen, 86.812 kWh erwartet bei 306.000 kg - 2,2 % mehr; im Rahmen wären ± 2 %.“ */
export function wasAuffielSatz(z: AnlassZahlen | null): string | null {
  if (!z?.gemessen || !z.delta) return null;
  const erwartet = z.erwartet ? `, ${mengeText(z.erwartet)} erwartet` : '';
  const bei = z.bedingung ? ` bei ${mengeText(z.bedingung)}` : '';
  const rahmen = z.band ? `; im Rahmen wären ${bandText(z.band)}` : '';
  return `${mengeText(z.gemessen)} gemessen${erwartet}${bei} - ${deltaWort(z.delta)}${rahmen}.`;
}

/** Die Bezeichnung der Bedingung im Kästchen: ihr Name aus der Kopie, sonst nach der Einheit. */
export const bedingungLabel = (b: NonNullable<AnlassZahlen['bedingung']>) =>
  b.name ?? (b.einheit === 'm²' ? 'Fläche' : 'Menge im Monat');

const MS_TAG = 86_400_000;
const tagesZahl = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / MS_TAG;
/** Kalendertage zwischen zwei Tagen (`JJJJ-MM-TT`, auch mit Uhrzeit) - nur für „nach 3 Tagen“. */
export const tageZwischen = (von: string, bis: string) => Math.round(tagesZahl(bis) - tagesZahl(von));
/** `2029-04-30` + 30 → `2029-05-30` (Kalender, die Vorgabe der Frist wie der Trigger). */
export function plusTage(iso: string, tage: number): string {
  return new Date((tagesZahl(iso) + tage) * MS_TAG).toISOString().slice(0, 10);
}
/** „am selben Tag“, „nach 1 Tag“, „nach 3 Tagen“. */
export function nachTagen(tage: number): string {
  return tage <= 0 ? 'am selben Tag' : `nach ${tage} Tag${tage === 1 ? '' : 'en'}`;
}

// --- Reiter

/** Ein abgeschlossener Eintrag des Reiters: eine abgeschlossene Abweichung oder eine zur Kenntnis genommene Auffälligkeit. */
export type AbgeschlossenEintrag =
  | { art: 'abweichung'; key: string; am: string; a: Abweichung }
  | { art: 'kenntnis'; key: string; am: string; v: Auffaelligkeit };

export interface ReiterBild {
  /** Offene Auffälligkeiten, ältester Monat zuerst - sie warten am längsten. */
  zuBeantworten: Auffaelligkeit[];
  /** Offene Abweichungen, überfällige zuerst (`ordnen`). */
  inArbeit: Abweichung[];
  /** Neueste zuerst. */
  abgeschlossen: AbgeschlossenEintrag[];
  satz: string;
  formal: string;
}

const anzahl = (n: number, eins: string, viele: string) => `${n} ${n === 1 ? eins : viele}`;

/**
 * Der Reiter aus beiden Listen. `vermerke` darf fehlen (`null`: die Liste lädt nicht) - dann sagt der Satz nur, was die
 * Abweichungen wissen. Eine mit „Abweichung eröffnen“ beantwortete Auffälligkeit steht als ihre Abweichung da.
 */
export function reiterBild(abweichungen: readonly Abweichung[], vermerke: readonly Auffaelligkeit[] | null, abruf: string): ReiterBild {
  const zuBeantworten = (vermerke ?? []).filter((v) => v.zustand === 'offen').sort((a, b) => a.periode.localeCompare(b.periode) || kennzahlName(a.kennzahl).localeCompare(kennzahlName(b.kennzahl), 'de'));
  const inArbeit = ordnen(abweichungen.filter((a) => a.zustand === 'offen'));
  const abgeschlossen: AbgeschlossenEintrag[] = [
    ...abweichungen.filter((a) => a.zustand === 'abgeschlossen' && a.abschluss).map((a) => ({ art: 'abweichung' as const, key: a.id, am: a.abschluss!.am, a })),
    ...(vermerke ?? []).filter((v) => v.zustand === 'beantwortet' && v.antwort === 'zur_kenntnis').map((v) => ({ art: 'kenntnis' as const, key: v.id, am: (v.beantwortet_am ?? v.vermerkt_am).slice(0, 10), v })),
  ].sort((a, b) => b.am.localeCompare(a.am) || a.key.localeCompare(b.key));

  const n = zuBeantworten.length;
  const k = inArbeit.length;
  const ueber = inArbeit.filter((a) => ueberfaelligText(a) !== null).length;
  let satz: string;
  if (n === 1) {
    const v = zuBeantworten[0];
    const z = anlassZahlen(v.anlass_inhalt);
    satz = z?.delta && istMehr(z)
      ? `1 Monat wartet auf Ihre Antwort: ${kennzahlName(v.kennzahl)} lag im ${monatWort(v.periode)} ${zahlDe(z.delta, 1)} % über der Erwartung.`
      : `1 Monat wartet auf Ihre Antwort: ${monatWort(v.periode)}, ${kennzahlName(v.kennzahl)}.`;
  } else if (n > 1) {
    satz = `${n} Monate warten auf Ihre Antwort - der älteste ist ${monatWort(zuBeantworten[0].periode)} (${kennzahlName(zuBeantworten[0].kennzahl)}).`;
  } else if (k > 0) {
    satz = `Nichts wartet auf eine Antwort; ${anzahl(k, 'Abweichung ist', 'Abweichungen sind')} in Arbeit${ueber ? `, ${ueber} davon überfällig` : ''}.`;
  } else if (abgeschlossen.length > 0) {
    satz = 'Nichts zu beantworten, keine Abweichung offen.';
  } else {
    satz = 'Noch nichts zu beantworten.';
  }
  const teile = [
    ...(vermerke === null ? [] : [`${n} zu beantworten`]),
    k === 0 ? 'keine offene Abweichung' : anzahl(k, 'offene Abweichung', 'offene Abweichungen'),
    `Stand ${tag(abruf)}`,
  ];
  return { zuBeantworten, inArbeit, abgeschlossen, satz, formal: teile.join(' · ') };
}

/** Das Ergebnis in einer Reihe: „Maßnahme: Werkzeugheizungen …“, „erklärt: Baustellenstrom …“. */
export function ergebnisKurz(e: AbgeschlossenEintrag): string {
  if (e.art === 'kenntnis') return `${UEMS_ZUR_KENNTNIS_GENOMMEN}${e.v.antwort_begruendung ? `: ${e.v.antwort_begruendung}` : ''}`;
  const s = e.a.abschluss!;
  if (s.ergebnis === 'massnahme') return `${UEMS_MASSNAHME}: ${s.massnahme?.name ?? s.massnahme?.kennzeichen ?? ''}`.trim();
  return `${ERGEBNIS_WORT[s.ergebnis]}: ${s.begruendung}`;
}

/** Der Datumsblock einer Frist im Reiter: „bis 31.01. 2028“, überfällig „seit …“ im Warnton. */
export function fristBlock(a: Pick<Abweichung, 'frist' | 'zustand'>): { wort: string; tag: string; jahr: string; satz: string; ton: 'ueber' | 'bald' } {
  const t = tag(a.frist.termin);
  const ueber = ueberfaelligText(a);
  return { wort: ueber ? 'seit' : 'bis', tag: t.slice(0, 6), jahr: t.slice(6), satz: ueber ? `Frist ${t}, ${ueber}` : `Frist bis ${t}`, ton: ueber ? 'ueber' : 'bald' };
}

/** Ein Tag als Datumsblock: „07.04.“ über „2029“. */
export const tagBlock = (iso: string) => {
  const t = tag(iso);
  return { tag: t.slice(0, 6), jahr: t.slice(6) };
};

// --- Seite

export const KNOPF_BEANTWORTEN = 'Beantworten';
export const KNOPF_ANSEHEN = 'Ansehen';
export const KNOPF_KOPIE = 'Kopie ansehen';
export const WAS_AUFFIEL = 'Was auffiel';
export const WAS_BEKANNT = 'Was dazu bekannt ist';
export const DARAUS_WURDE = 'Daraus wurde';
export const UEBER_DIESE = `Über diese ${UEMS_ABWEICHUNG}`;
export const NEUESTE_ZUERST = 'neueste zuerst';

export interface Stufe {
  wort: string;
  tag: string | null;
  zustand: 'erledigt' | 'jetzt' | 'offen';
}

/** Die Stufen einer Abweichung: vermerkt (oder von Hand eröffnet), untersucht, abgeschlossen - mit Datum. */
export function stufenDerAbweichung(a: Pick<Abweichung, 'herkunft' | 'vermerke' | 'eroeffnet_am' | 'zustand' | 'abschluss' | 'frist'>): Stufe[] {
  const vermerkt = [...(a.vermerke ?? [])].map((v) => v.vermerkt_am).sort()[0] ?? null;
  const erste: Stufe = a.herkunft.art === 'von_hand'
    ? { wort: 'Von Hand eröffnet', tag: tag(a.eroeffnet_am), zustand: 'erledigt' }
    : { wort: 'Vermerkt', tag: vermerkt ? tag(vermerkt) : null, zustand: 'erledigt' };
  if (a.zustand === 'abgeschlossen' && a.abschluss) {
    return [erste, { wort: 'Untersucht', tag: `ab ${tag(a.eroeffnet_am)}`, zustand: 'erledigt' }, { wort: 'Abgeschlossen', tag: tag(a.abschluss.am), zustand: 'erledigt' }];
  }
  return [
    erste,
    { wort: 'Untersuchen', tag: `seit ${tag(a.eroeffnet_am)}`, zustand: 'jetzt' },
    { wort: 'Abschließen', tag: `bis ${tag(a.frist.termin)}`, zustand: 'offen' },
  ];
}

/** Der Antwortsatz der Seite (V1): das Ergebnis, sonst wer bis wann klärt - mit seiner Bedingung darunter. */
export function antwortDerAbweichung(a: Abweichung): { satz: string; formal: string; warn: boolean } {
  const s = a.abschluss;
  if (a.zustand === 'abgeschlossen' && s) {
    const satz = s.ergebnis === 'massnahme'
      ? `Abgeschlossen mit einer ${UEMS_MASSNAHME}: ${s.massnahme?.name ?? s.massnahme?.kennzeichen ?? ''}.`
      : s.ergebnis === 'erklaert'
        ? `Abgeschlossen: Die ${UEMS_ABWEICHUNG} ist erklärt.`
        : s.ergebnis === 'keine_abweichung'
          ? `Abgeschlossen: Es war keine ${UEMS_ABWEICHUNG}.`
          : 'Abgeschlossen: Der Monat ist nicht bewertbar.';
    return { satz, formal: `Ergebnis von ${s.person} am ${tag(s.am)} · ${nachTagen(tageZwischen(a.eroeffnet_am, s.am))}`, warn: false };
  }
  const ueber = ueberfaelligText(a);
  const eroeffnet = `eröffnet am ${tag(a.eroeffnet_am)} von ${a.eroeffnet_von}`;
  return ueber
    ? { satz: `Die Frist ist vorbei: ${a.verantwortlich.name} sollte bis ${tag(a.frist.termin)} klären, woran es lag.`, formal: `${ueber} · ${eroeffnet}`, warn: true }
    : { satz: `In Arbeit: ${a.verantwortlich.name} klärt bis ${tag(a.frist.termin)}, woran es lag.`, formal: eroeffnet, warn: false };
}

export interface VerlaufBild {
  key: string;
  am: string;
  titel: string;
  text: string | null;
}

const zitat = (t: string | null | undefined) => (t ? `‚${t}‘` : null);

/** „Was dazu bekannt ist“: jede Zeile des Protokolls als Satz, neueste zuerst; eine Aussage immer mit „Aussage von …“. */
export function verlaufBild(a: Pick<Abweichung, 'verlauf' | 'herkunft' | 'abschluss'>): VerlaufBild[] {
  return [...(a.verlauf ?? [])]
    .sort((x, y) => y.am.localeCompare(x.am) || y.nr - x.nr)
    .map((e) => {
      const key = String(e.nr);
      const mit = (t: string | null) => [e.person, t].filter(Boolean).join(' · ');
      switch (e.art) {
        case 'abweichung_eroeffnet':
          return { key, am: e.am, titel: 'Untersuchung begonnen', text: mit(a.herkunft.art === 'von_hand' ? zitat(a.herkunft.wortlaut) : null) };
        case 'kommentar':
          return { key, am: e.am, titel: `Kommentar von ${e.person}`, text: zitat(e.kommentar) };
        case 'ursache_aussage': {
          const x = e.aussage;
          if (!x) return { key, am: e.am, titel: UEMS_AUSSAGE_VON, text: e.person };
          const beleg = x.beleg_kennung ? `mit Beleg ${x.beleg_kennung}` : 'keine Messung';
          const eingetragen = e.person !== x.name ? ` · eingetragen von ${e.person}` : '';
          return { key, am: x.am, titel: `${UEMS_AUSSAGE_VON} ${x.name}`, text: `${zitat(x.wortlaut)} · ${beleg}${eingetragen}` };
        }
        case 'abweichung_geaendert': {
          const neu = typeof e.neu?.frist === 'string' ? tag(e.neu.frist) : null;
          return { key, am: e.am, titel: neu ? `Frist geändert auf ${neu}` : 'Frist geändert', text: mit(zitat(e.begruendung)) };
        }
        case 'verantwortlicher_geaendert': {
          const neu = typeof e.neu?.verantwortlich_name === 'string' ? e.neu.verantwortlich_name : null;
          return { key, am: e.am, titel: neu ? `Verantwortlich jetzt ${neu}` : `${UEMS_VERANTWORTLICH} geändert`, text: mit(zitat(e.begruendung)) };
        }
        case 'abweichung_abgeschlossen': {
          const ergebnis = typeof e.neu?.ergebnis === 'string' ? (e.neu.ergebnis as AbweichungErgebnis) : (a.abschluss?.ergebnis ?? null);
          const titel = ergebnis === 'massnahme' ? `Abgeschlossen mit einer ${UEMS_MASSNAHME}` : ergebnis ? `Abgeschlossen: ${ERGEBNIS_WORT[ergebnis]}` : 'Abgeschlossen';
          return { key, am: e.am, titel, text: mit(zitat(e.begruendung)) };
        }
        default:
          return { key, am: e.am, titel: VERLAUF_WORT[e.art] ?? e.art, text: e.person };
      }
    });
}

/** „Heute liest der Vergleich 12,0 % - festgehalten bleiben 12,9 %.“ - nur, wenn der Vergleich heute anders liest. */
export function heuteAnders(festgehalten: AnlassZahlen | null, heute: { delta_prozent: string | null } | null): string | null {
  if (!festgehalten?.delta || !heute?.delta_prozent) return null;
  const f = deltaWort(festgehalten.delta);
  const h = deltaWort(heute.delta_prozent);
  return f === h ? null : `Heute liest der Vergleich ${h} - festgehalten bleiben ${f}. Die Kopie bleibt, wie sie beim Eröffnen gelesen wurde.`;
}
