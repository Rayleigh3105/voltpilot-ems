/**
 * UEMS AP-18 IP-13 (§5.4, §5.7, M1–M4, M6, M7, SP1–SP4): die festen Wörter und Formregeln der Maßnahme, die Seite,
 * Blätter und Nachbarbereiche teilen. **Hier wird nichts gerechnet:** entschieden wird an der Route. Das Bild des
 * Reiters und der Seite steht seit dem Verbessern-Konzept v1 (PR 2) in `massnahmenBild.ts`, „Maßnahme planen“ in
 * `massnahmePlanen.ts`; Wirkung, Bewertung und Anstöße in `massnahmeWirkung.ts` (IP-20).
 */
import { ApiError, type Massnahme, type MassnahmeEintrag, type MassnahmeHerkunft } from './api';
import { monatWort } from './bezugsbasisVergleich';
import {
  UEMS_ABWEICHUNG,
  UEMS_AUSGANGSLAGE,
  UEMS_ENERGIEZIEL,
  UEMS_ERWARTETE_WIRKUNG,
  UEMS_FESTSTELLUNG,
  UEMS_MANAGEMENTBEWERTUNG,
  UEMS_MASSNAHME,
  UEMS_MASSNAHME_ZUSTAENDE,
  UEMS_MASSNAHMEN,
  UEMS_MESSGRUNDLAGE,
  UEMS_VERANTWORTLICH,
} from './glossar';

// ------------------------------------------------------------------ Wörter

export const ZUR_LISTE = `Alle ${UEMS_MASSNAHMEN}`;
export const ZUSTAND_WORT = UEMS_MASSNAHME_ZUSTAENDE;
export const NICHT_GEFUNDEN = `Diese ${UEMS_MASSNAHME} gibt es nicht oder Sie dürfen sie nicht sehen.`;
export const VERLAUF = 'Verlauf';
export const PRUEFSUMME = 'Prüfsumme';
export const KOMMENTAR_MAX = 2000;
export const UNTERNEHMEN = 'Unternehmen (kein Standort)';

export const HERKUNFT_WORT: Record<MassnahmeHerkunft, string> = {
  abweichung: `aus der ${UEMS_ABWEICHUNG}`,
  energieziel: `aus dem ${UEMS_ENERGIEZIEL}`,
  einsatz: 'am Energieeinsatz',
  von_hand: 'von Hand angelegt',
  // AP-19 IP-17: das Kundenwort des Objekts, nie das Vertragswort (`nichtkonformitaet` ist „Feststellung“, SP5).
  nichtkonformitaet: `aus der ${UEMS_FESTSTELLUNG}`,
  audit: 'aus dem internen Audit',
  managementbewertung: `aus der ${UEMS_MANAGEMENTBEWERTUNG}`,
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

/** „Ändern“ gibt es nur, solange die Maßnahme geplant ist (M6); ein Kommentar an geplant und umgesetzt (M7). */
export const aenderbar = (m: Pick<Massnahme, 'zustand'>) => m.zustand === 'geplant';
export const kommentierbar = (m: Pick<Massnahme, 'zustand'>) => m.zustand === 'geplant' || m.zustand === 'umgesetzt';

// ------------------------------------------------------------------ Vorbelegung und Formregeln

/**
 * Womit „Maßnahme planen“ vorbelegt öffnet (§5.4, Verbessern v1 §6.9): aus einer Abweichung (Herkunft `abweichung`,
 * Kennung, Kennzahl und Monate aus dem Anlass - IP-18), aus einem Energieziel, am Energieeinsatz, aus dem
 * Energiemanagement (Feststellung, Audit, Managementbewertung), sonst von Hand.
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

export const wortlautOk = (t: string) => t.trim().length > 0;

/** Ein Tag (ISO) nie in der Zukunft - „umgesetzt am“ (M6); `heute` ist der Tag der Route. */
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
/** Höchstens so viele Monate nimmt die Route für die Ausgangslage (`MassnahmeService.AUSGANGSLAGE_HOECHSTENS_MONATE`). */
export const AUSGANGSLAGE_HOECHSTENS_MONATE = 12;

export const monateWert = (von: string, bis: string) => (von === bis ? von : `${von}/${bis}`);
export const monateText = (von: string, bis: string) => (von === bis ? monatWort(von) : `${monatWort(von)} bis ${monatWort(bis)}`);

// ------------------------------------------------------------------ Ablehnungen der Route

export const ABLEHNUNG: Record<string, string> = {
  ohne_messgrundlage: `Eine Zahl in Prozent gibt es nur mit ${UEMS_MESSGRUNDLAGE} - ohne sie beschreibt der Wortlaut die ${UEMS_ERWARTETE_WIRKUNG}.`,
  kennzahl_ohne_bezugsbasis: 'Diese Kennzahl hat keine freigegebene, heute geltende Bezugsbasis - wählen Sie eine andere oder „Spart Energie, wird aber nicht gemessen“.',
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
  // Verbessern v1, Entscheide 6 und 13.
  art_ohne_kennzahl: 'Gemessen wird an einer Kennzahl mit Bezugsbasis - bitte eine Kennzahl wählen.',
  art_mit_kennzahl: `Eine ${UEMS_MASSNAHME} mit Kennzahl wird an dieser Kennzahl gemessen.`,
  einsparung_mit_kennzahl: 'Mit Kennzahl rechnet VoltPilot die Prozent in kWh im Jahr um.',
  einsparung_organisatorisch: `Eine organisatorische ${UEMS_MASSNAHME} trägt keine Zahl der Einsparung.`,
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
