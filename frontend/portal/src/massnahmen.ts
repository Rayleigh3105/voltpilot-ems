/**
 * UEMS AP-18 IP-13 (§5.4, §5.7, M1–M4, M6, M7, SP1–SP4): das reine Bild des Reiters „Maßnahmen“ — Register, Dialog
 * „Maßnahme anlegen“ und die Maßnahmen-Seite. **Hier wird nichts gerechnet:** die Ausgangslage ist die Kopie der Route
 * (Prüfsumme), „überfällig seit n Tagen“ kommt aus `frist` (E5 = A), die Vorschau aus dem Vergleich-Leser. Das Portal
 * ordnet, filtert und prüft nur die Form; entschieden wird an der Route. Keine Wirkung und keine Bewertung (IP-20).
 */
import { ApiError, type Massnahme, type MassnahmeEintrag, type MassnahmeHerkunft, type MassnahmeNeu } from './api';
import { monatWort } from './bezugsbasisVergleich';
import { zielwertAusEingabe, zielwertText } from './energieziele';
import {
  UEMS_ABWEICHUNG,
  UEMS_AUSGANGSLAGE,
  UEMS_BEWERTUNGSMETHODE,
  UEMS_ENERGIEZIEL,
  UEMS_ERWARTETE_WIRKUNG,
  UEMS_MASSNAHME,
  UEMS_MASSNAHME_ZUSTAENDE,
  UEMS_MASSNAHMEN,
  UEMS_MESSGRUNDLAGE,
  UEMS_OHNE_MESSGRUNDLAGE,
  UEMS_OHNE_MESSGRUNDLAGE_SATZ,
  UEMS_TERMIN,
  UEMS_UEBERFAELLIG_SEIT,
  UEMS_UMGESETZT_AM,
  UEMS_VERANTWORTLICH,
} from './glossar';

// ------------------------------------------------------------------ Wörter

export const KNOPF_ANLEGEN = `${UEMS_MASSNAHME} anlegen`;
export const KNOPF_UMGESETZT = 'umgesetzt melden';
export const KNOPF_VERWERFEN = 'verwerfen';
export const KNOPF_AENDERN = 'ändern';
export const KNOPF_VERANTWORTLICH = `${UEMS_VERANTWORTLICH} ändern`;
export const KNOPF_KOMMENTAR = 'Kommentar';
export const ZUR_LISTE = `Alle ${UEMS_MASSNAHMEN}`;

export const SPALTEN = {
  kennzeichen: UEMS_MASSNAHME,
  zustand: 'Zustand',
  termin: UEMS_TERMIN,
  verantwortlich: UEMS_VERANTWORTLICH,
  messgrundlage: UEMS_MESSGRUNDLAGE,
} as const;

export const FILTER = {
  zustand: 'Zustand',
  kennzahl: 'Kennzahl',
  ueberfaellig: 'nur überfällige',
  alle: 'alle',
} as const;

export const ZUSTAND_WORT = UEMS_MASSNAHME_ZUSTAENDE;
export const LADEFEHLER = `Die ${UEMS_MASSNAHMEN} konnten nicht geladen werden.`;
export const LADEFEHLER_SEITE = `Die ${UEMS_MASSNAHME} konnte nicht geladen werden.`;
export const NICHT_GEFUNDEN = `Diese ${UEMS_MASSNAHME} gibt es nicht oder Sie dürfen sie nicht sehen.`;
export const LEER_GEFILTERT = `Keine ${UEMS_MASSNAHME} passt zu dieser Auswahl.`;
export const VERLAUF = 'Verlauf';
export const PRUEFSUMME = 'Prüfsumme';
export const AUSGANGSLAGE_KOPIE = `${UEMS_AUSGANGSLAGE} — Kopie, wie sie beim Anlegen gelesen wurde`;
export const KOMMENTAR_MAX = 2000;

export const HERKUNFT_WORT: Record<MassnahmeHerkunft, string> = {
  abweichung: `aus der ${UEMS_ABWEICHUNG}`,
  energieziel: `aus dem ${UEMS_ENERGIEZIEL}`,
  einsatz: 'am Energieeinsatz',
  von_hand: 'von Hand angelegt',
};

export const VERLAUF_WORT: Record<MassnahmeEintrag['art'], string> = {
  massnahme_angelegt: 'angelegt',
  massnahme_geaendert: 'geändert',
  verantwortlicher_geaendert: `${UEMS_VERANTWORTLICH} geändert`,
  kommentar: 'Kommentar',
  massnahme_umgesetzt: 'umgesetzt gemeldet',
  massnahme_verworfen: 'verworfen',
  bewertung_beantragt: 'Bewertung beantragt',
  bewertung_abgelehnt: 'Bewertung abgelehnt',
  massnahme_bewertet: 'bewertet',
  anstoss_gesetzt: 'Anstoß',
  anstoss_beantwortet: 'Anstoß beantwortet',
};

/** „ohne Messgrundlage“ als sichtbare Wahl im Dialog (M4, E2 = A) — der Satz aus §5.9 steht daneben. */
export const WAHL_MIT = 'mit Kennzahl';
export const WAHL_OHNE = UEMS_OHNE_MESSGRUNDLAGE;
export const OHNE_HINWEIS = `${UEMS_OHNE_MESSGRUNDLAGE_SATZ}. Die ${UEMS_MASSNAHME} lässt sich anlegen und umsetzen; bewertet werden kann sie nur als „nicht messbar“. Um die Wirkung zu messen, braucht der Energieeinsatz eine Energieleistungskennzahl mit einer Bezugsbasis.`;
export const ZAHL_GESPERRT = `Eine Zahl gibt es nur mit ${UEMS_MESSGRUNDLAGE} — ohne sie beschreibt der Wortlaut die ${UEMS_ERWARTETE_WIRKUNG}.`;
export const METHODE_HINWEIS = `${UEMS_BEWERTUNGSMETHODE}: die der Bezugsbasis-Fassung — keine Wahl.`;
export const KEINE_KENNZAHL = 'Keine Ihrer Kennzahlen hat eine freigegebene Bezugsbasis — anlegen geht nur ohne Messgrundlage.';
export const VORSCHAU_FEHLT = `Die ${UEMS_AUSGANGSLAGE} ist gerade nicht abrufbar; beim Anlegen liest die Route sie selbst.`;
export const UNTERNEHMEN = 'Unternehmen (kein Standort)';

// ------------------------------------------------------------------ Register

/** „überfällig seit n Tagen“ — die Zahl kommt aus `frist` der Route (E5 = A), nie aus dem Portal. */
export function ueberfaelligText(m: Pick<Massnahme, 'frist'>): string | null {
  const f = m.frist;
  return f.faellig === 'ueberfaellig' && f.seit_tagen !== null ? UEMS_UEBERFAELLIG_SEIT(f.seit_tagen) : null;
}

/** Überfällige zuerst (die längste Frist oben), dann nach Termin, dann nach Kennzeichen. */
export function ordnen(liste: readonly Massnahme[]): Massnahme[] {
  const rang = (m: Massnahme) => (m.frist.faellig === 'ueberfaellig' ? 0 : 1);
  return [...liste].sort(
    (a, b) =>
      rang(a) - rang(b) ||
      (b.frist.seit_tagen ?? 0) - (a.frist.seit_tagen ?? 0) ||
      a.termin.localeCompare(b.termin) ||
      a.kennzeichen.localeCompare(b.kennzeichen),
  );
}

export interface RegisterFilter {
  zustand: Massnahme['zustand'] | '';
  kennzahl: string;
  ueberfaellig: boolean;
}
export const FILTER_LEER: RegisterFilter = { zustand: '', kennzahl: '', ueberfaellig: false };

export function filtern(liste: readonly Massnahme[], f: RegisterFilter): Massnahme[] {
  return liste.filter(
    (m) =>
      (!f.zustand || m.zustand === f.zustand) &&
      (!f.kennzahl || m.messgrundlage?.kennzahl.id === f.kennzahl) &&
      (!f.ueberfaellig || m.frist.faellig === 'ueberfaellig'),
  );
}

/** Die Kennzahlen, an denen Maßnahmen dieser Liste messen — für den Filter. */
export function kennzahlOptionen(liste: readonly Massnahme[]): { value: string; label: string }[] {
  const gesehen = new Map<string, string>();
  for (const m of liste) {
    const k = m.messgrundlage?.kennzahl;
    if (k && !gesehen.has(k.id)) gesehen.set(k.id, `${k.kennzeichen}${k.name ? ` ${k.name}` : ''}`);
  }
  return [...gesehen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'de'));
}

// ------------------------------------------------------------------ Seite

/** Die erwartete Wirkung so, wie die Person sie gesetzt hat: „3 % weniger — ‚…‘“; ohne Zahl nur der Wortlaut. */
export function erwarteteWirkungText(m: Pick<Massnahme, 'erwartete_wirkung_prozent' | 'erwartete_wirkung_wortlaut'>): string {
  const zahl = m.erwartete_wirkung_prozent === null ? null : zielwertText(m.erwartete_wirkung_prozent);
  return `${UEMS_ERWARTETE_WIRKUNG}: ${zahl ? `${zahl} — ` : ''}‚${m.erwartete_wirkung_wortlaut}‘`;
}

/** Der Kopf, solange die Route keinen `kopf_satz` hat (vor der Umsetzung): Kennzeichen · Titel · Verantwortlich · Termin. */
export function kopfZeile(m: Pick<Massnahme, 'kennzeichen' | 'titel' | 'verantwortlich' | 'termin' | 'kopf_satz'>, tag: (iso: string) => string): string {
  return m.kopf_satz ?? `${m.kennzeichen} · ${m.titel} · ${UEMS_VERANTWORTLICH} ${m.verantwortlich.name} · ${UEMS_TERMIN} ${tag(m.termin)}.`;
}
export const umgesetztZeile = (am: string, tag: (iso: string) => string) => `${UEMS_UMGESETZT_AM} ${tag(am)}`;

/** „ändern“ gibt es nur, solange die Maßnahme geplant ist (M6); ein Kommentar an geplant und umgesetzt (M7). */
export const aenderbar = (m: Pick<Massnahme, 'zustand'>) => m.zustand === 'geplant';
export const kommentierbar = (m: Pick<Massnahme, 'zustand'>) => m.zustand === 'geplant' || m.zustand === 'umgesetzt';

// ------------------------------------------------------------------ Dialog „Maßnahme anlegen“ (nur Form)

/**
 * Womit der Dialog vorbelegt öffnet (§5.4): aus einer Abweichung (Herkunft `abweichung`, Kennung, Kennzahl und Monate
 * aus dem Anlass — IP-18), aus einem Energieziel, am Energieeinsatz, sonst von Hand.
 */
export interface MassnahmeVorbelegung {
  herkunft: MassnahmeHerkunft;
  herkunftKennung?: string;
  kennzahl?: string;
  /** `JJJJ-MM` oder `JJJJ-MM/JJJJ-MM`. */
  monate?: string;
  einsatz?: string;
  einstufungFassung?: number;
  energieziel?: string;
  titel?: string;
}

export type MessgrundlageWahl = 'mit' | 'ohne';

export interface MassnahmeEntwurf {
  titel: string;
  verantwortlich: string;
  termin: string;
  standort: string;
  wahl: MessgrundlageWahl;
  kennzahl: string;
  von: string;
  bis: string;
  einsatz: string;
  energieziel: string;
  wirkungZahl: string;
  wirkungWortlaut: string;
}

/** Die Zahl der erwarteten Wirkung ist NUR mit Messgrundlage erlaubt (M4) — ohne ist das Feld gesperrt. */
export const zahlErlaubt = (e: Pick<MassnahmeEntwurf, 'wahl' | 'kennzahl'>) => e.wahl === 'mit' && e.kennzahl !== '';

/** „3“ oder „2,5“ (Prozent weniger als erwartet) → wie im Vertrag, weniger Energie negativ; ungültig → `null`. */
export const wirkungAusEingabe = zielwertAusEingabe;

export const wortlautOk = (t: string) => t.trim().length > 0;

/** Ein Tag (ISO) nie in der Zukunft — „umgesetzt am“ (M6); `heute` in der Zone des Unternehmens. */
export const tagNichtInZukunft = (tag: string, heute: string) => /^\d{4}-\d{2}-\d{2}$/.test(tag) && tag <= heute;

/** Der letzte abgeschlossene Monat vor `heute` (Vorgabe der Ausgangslage, wie an der Route) — nur Kalender. */
export function letzterAbgeschlossenerMonat(heute: string): string {
  const jahr = Number(heute.slice(0, 4));
  const monat = Number(heute.slice(5, 7));
  return monat === 1 ? `${jahr - 1}-12` : `${jahr}-${String(monat - 1).padStart(2, '0')}`;
}

/** `JJJJ-MM` bzw. `JJJJ-MM/JJJJ-MM` → die beiden Monate; ohne Angabe der Vorgabe-Monat. */
export function monateAus(monate: string | undefined, heute: string): [string, string] {
  if (monate && /^\d{4}-\d{2}(\/\d{4}-\d{2})?$/.test(monate)) {
    const [von, bis] = monate.split('/');
    return [von, bis ?? von];
  }
  const m = letzterAbgeschlossenerMonat(heute);
  return [m, m];
}
export const monateWert = (von: string, bis: string) => (von === bis ? von : `${von}/${bis}`);
export const monateText = (von: string, bis: string) => (von === bis ? monatWort(von) : `${monatWort(von)} bis ${monatWort(bis)}`);

export function entwurfAus(v: MassnahmeVorbelegung, heute: string): MassnahmeEntwurf {
  const [von, bis] = monateAus(v.monate, heute);
  return {
    titel: v.titel ?? '',
    verantwortlich: '',
    termin: '',
    standort: '',
    wahl: v.kennzahl ? 'mit' : v.herkunft === 'einsatz' ? 'ohne' : 'mit',
    kennzahl: v.kennzahl ?? '',
    von,
    bis,
    einsatz: v.einsatz ?? '',
    energieziel: v.energieziel ?? '',
    wirkungZahl: '',
    wirkungWortlaut: '',
  };
}

export type EntwurfFehler = Partial<Record<'titel' | 'verantwortlich' | 'termin' | 'kennzahl' | 'monate' | 'wirkungZahl' | 'wirkungWortlaut', string>>;

/** Die Form-Regeln des Dialogs; die fachlichen entscheidet die Route. */
export function pruefen(e: MassnahmeEntwurf): EntwurfFehler {
  return {
    ...(!e.titel.trim() ? { titel: `Bitte geben Sie der ${UEMS_MASSNAHME} einen Titel.` } : {}),
    ...(!e.verantwortlich ? { verantwortlich: 'Bitte wählen Sie, wer verantwortlich ist.' } : {}),
    ...(!/^\d{4}-\d{2}-\d{2}$/.test(e.termin) ? { termin: 'Bitte wählen Sie einen Termin.' } : {}),
    ...(e.wahl === 'mit' && !e.kennzahl ? { kennzahl: `Bitte wählen Sie eine Kennzahl — oder „${WAHL_OHNE}“.` } : {}),
    ...(e.wahl === 'mit' && e.von > e.bis ? { monate: 'Der erste Monat muss vor dem letzten liegen.' } : {}),
    ...(zahlErlaubt(e) && e.wirkungZahl.trim() && wirkungAusEingabe(e.wirkungZahl) === null
      ? { wirkungZahl: 'Eine Zahl zwischen 0 und 100 mit höchstens einer Nachkommastelle, zum Beispiel 3 oder 2,5.' }
      : {}),
    ...(!wortlautOk(e.wirkungWortlaut) ? { wirkungWortlaut: `Bitte beschreiben Sie die ${UEMS_ERWARTETE_WIRKUNG} in einem Satz.` } : {}),
  };
}

/** Die Anfrage an `POST /api/v1/massnahmen` — ohne Messgrundlage NIE eine Zahl, keine Monate, kein Kennzahl-Feld. */
export function anfrage(e: MassnahmeEntwurf, v: MassnahmeVorbelegung, einstufungFassung?: number): MassnahmeNeu {
  const mit = e.wahl === 'mit' && e.kennzahl !== '';
  const zahl = zahlErlaubt(e) && e.wirkungZahl.trim() ? wirkungAusEingabe(e.wirkungZahl) : null;
  return {
    titel: e.titel.trim(),
    verantwortlich: e.verantwortlich,
    termin: e.termin,
    herkunft: v.herkunft,
    ...(v.herkunft === 'abweichung' && v.herkunftKennung ? { herkunft_kennung: v.herkunftKennung } : {}),
    ...(mit ? { kennzahl: e.kennzahl, monate: monateWert(e.von, e.bis) } : {}),
    ...(!mit && e.standort ? { standort: e.standort } : {}),
    ...(e.einsatz ? { einsatz: e.einsatz } : {}),
    ...(e.einsatz && einstufungFassung !== undefined ? { einstufung_fassung: einstufungFassung } : {}),
    ...(e.energieziel ? { energieziel: e.energieziel } : {}),
    ...(zahl !== null ? { erwartete_wirkung_prozent: zahl } : {}),
    erwartete_wirkung_wortlaut: e.wirkungWortlaut.trim(),
  };
}

// ------------------------------------------------------------------ Ablehnungen der Route

export const ABLEHNUNG: Record<string, string> = {
  ohne_messgrundlage: `${ZAHL_GESPERRT}`,
  kennzahl_ohne_bezugsbasis: `Diese Kennzahl hat keine freigegebene, heute geltende Bezugsbasis — wählen Sie eine andere oder „${WAHL_OHNE}“.`,
  benutzer_unbekannt: 'Diese Person hat kein aktives Konto in Ihrem Kundenbereich.',
  verantwortlich_fehlt: 'Bitte wählen Sie, wer verantwortlich ist.',
  umgesetzt_in_der_zukunft: 'Der Tag der Umsetzung liegt in der Zukunft.',
  massnahme_nicht_geplant: `Diese ${UEMS_MASSNAHME} ist nicht mehr geplant — sie lässt sich nicht mehr ändern.`,
  wortlaut_fehlt: `Bitte beschreiben Sie die ${UEMS_ERWARTETE_WIRKUNG} in einem Satz.`,
  titel_fehlt: `Bitte geben Sie der ${UEMS_MASSNAHME} einen Titel.`,
  monate_nicht_abgeschlossen: `Die ${UEMS_AUSGANGSLAGE} braucht abgeschlossene Monate, höchstens zwölf.`,
  standort_der_kennzahl: `Der Standort einer ${UEMS_MASSNAHME} mit ${UEMS_MESSGRUNDLAGE} ist der Standort ihrer Kennzahl.`,
  standort_unbekannt: 'Diesen Standort gibt es nicht oder Sie dürfen dort nichts anlegen.',
  herkunft_ohne_verweis: `Eine ${UEMS_MASSNAHME} aus einem Energieeinsatz oder ${UEMS_ENERGIEZIEL} nennt ihn.`,
  einsatz_unbekannt: 'Diesen Energieeinsatz gibt es in Ihrem Kundenbereich nicht.',
  energieziel_unbekannt: `Dieses ${UEMS_ENERGIEZIEL} gibt es in Ihrem Kundenbereich nicht.`,
  einstufung_nicht_freigegeben: 'Die Einstufung des Energieeinsatzes ist noch nicht freigegeben.',
  begruendung_fehlt: 'Begründung mit 10 bis 500 Zeichen.',
  text_ungueltig: `Ein Kommentar hat 1 bis ${KOMMENTAR_MAX.toLocaleString('de-DE')} Zeichen.`,
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
