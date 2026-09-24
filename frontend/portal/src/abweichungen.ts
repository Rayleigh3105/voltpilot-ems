/**
 * UEMS AP-18 IP-18 (§5.2, §5.3, §5.7, A2–A6, U1–U3, SP1–SP4): das reine Bild der Auffälligkeiten und Abweichungen —
 * die Vermerk-Zeile am Monat der Vergleichs-Fläche, das Register „Abweichungen“ und die Abweichungs-Seite. **Hier wird
 * nichts gerechnet:** der Anlass ist die Kopie der Route (Prüfsumme), „überfällig seit n Tagen“ kommt aus `frist`
 * (E5 = A), die Vergleichszeilen aus dem Leser. Das Portal ordnet, filtert und prüft nur die Form; entschieden wird an
 * der Route. Eine Ursache ist immer die Aussage einer Person („Aussage von …“) — nie ein Satz des Systems (U3).
 */
import { ApiError, type Abweichung, type AbweichungEintrag, type AbweichungErgebnis, type Auffaelligkeit } from './api';
import { monatWort } from './bezugsbasisVergleich';
import { BEGRUENDUNG_HINWEIS, begruendungOk } from './energieziele';
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
export const KNOPF_ABSCHLIESSEN = 'abschließen';
export const KNOPF_FRIST = 'Frist ändern';
export const KNOPF_VERANTWORTLICH = `${UEMS_VERANTWORTLICH} ändern`;
export const KNOPF_KOMMENTAR = 'Kommentar';
export const KNOPF_AUSSAGE = 'Ursache-Aussage eintragen';
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
