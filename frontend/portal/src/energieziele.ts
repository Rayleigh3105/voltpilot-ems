/**
 * UEMS AP-18 IP-8 (§5.1, §6.3, Z1–Z5, SP1–SP4): das reine Bild des Bereichs „Ziele und Maßnahmen“ — Reiter
 * „Energieziele“, der Dialog „Energieziel setzen“ und die Energieziel-Seite. **Hier wird nichts gerechnet:** Σ ÷ Σ,
 * „x von y“, Urteil, Vorschlag, Sätze und die Frist kommen vom Leser `GET /api/v1/energieziele/{id}/stand` bzw. der
 * Route; das Portal setzt nur Zahlen ins deutsche Format (`bezugsbasisVergleich.ts`) und wählt Wörter aus `glossar.ts`.
 * „Energieziel“, nie „Ziel“ allein (W6) — „Ziel: 2,2 kW“ gehört der Steuerung.
 */
import { ApiError, type Energieziel, type EnergiezielEintrag, type EnergiezielErgebnis, type EnergiezielStand, type Selbstauskunft } from './api';
import { band, deltaText, deZahl, menge, monatWort, urteilWort } from './bezugsbasisVergleich';
import {
  UEMS_ABWEICHUNGEN,
  UEMS_ENERGIEZIEL,
  UEMS_ENERGIEZIEL_ERGEBNISSE,
  UEMS_ENERGIEZIEL_ZUSTAENDE,
  UEMS_ENERGIEZIELE,
  UEMS_MASSNAHMEN,
  UEMS_VERANTWORTLICH,
  UEMS_ZIELPERIODE,
  UEMS_ZIELWERT,
} from './glossar';
import type { VerbesserungReiter } from './nav';

// ------------------------------------------------------------------ Rechte (aus `/me`, entschieden wird an der Route)

type Rechte = Pick<Selbstauskunft, 'standorte' | 'unternehmen_rechte'>;

const hat = (s: Rechte | null | undefined, recht: string, standortId?: string | null) =>
  !!s &&
  (s.unternehmen_rechte.includes(recht) ||
    (standortId !== null && s.standorte.some((st) => (standortId === undefined || st.id === standortId) && st.rechte.includes(recht))));

/** `verbesserung.ansehen` am Unternehmen oder an einem Standort — sonst gibt es den Bereich nicht. */
export const darfAnsehen = (s: Rechte | null | undefined) => hat(s, 'verbesserung.ansehen');

// ------------------------------------------------------------------ Wörter

export const REITER: readonly { key: VerbesserungReiter; label: string }[] = [
  { key: 'energieziele', label: UEMS_ENERGIEZIELE },
  { key: 'massnahmen', label: UEMS_MASSNAHMEN },
  { key: 'abweichungen', label: UEMS_ABWEICHUNGEN },
];

export const KNOPF_SETZEN = `${UEMS_ENERGIEZIEL} setzen`;
export const KNOPF_BEWERTEN = 'bewerten';
export const KNOPF_BEENDEN = 'beenden';
export const KNOPF_FREIGEBEN = 'Bewertung bestätigen';
export const KNOPF_ABLEHNEN = 'Bewertung ablehnen';
export const ZUR_LISTE = `Alle ${UEMS_ENERGIEZIELE}`;

export const SPALTEN = {
  kennzeichen: UEMS_ENERGIEZIEL,
  kennzahl: 'Kennzahl',
  zielwert: UEMS_ZIELWERT,
  zielperiode: UEMS_ZIELPERIODE,
  stand: 'Stand',
  verantwortlich: UEMS_VERANTWORTLICH,
  zustand: 'Zustand',
} as const;

export const MONAT_SPALTEN = {
  monat: 'Monat',
  gemessen: 'gemessen',
  erwartet: 'erwartet',
  delta: 'Δ',
  urteil: 'Urteil (Band)',
  grund: 'nicht gezählt, weil',
} as const;

export const SUMME = 'Summe';
export const NOCH_NICHT_ENDGUELTIG = 'noch nicht endgültig';
export const VERLAUF = 'Verlauf';
export const VORSCHLAG = 'Vorschlag';
export const LADEFEHLER = `Die ${UEMS_ENERGIEZIELE} konnten nicht geladen werden.`;
export const LADEFEHLER_SEITE = `Das ${UEMS_ENERGIEZIEL} konnte nicht geladen werden.`;
export const NICHT_GEFUNDEN = `Dieses ${UEMS_ENERGIEZIEL} gibt es nicht oder Sie dürfen es nicht sehen.`;
export const STAND_OHNE_MONAT = 'noch kein bewertbarer Monat';
/** Der Reiter Abweichungen kommt mit AP-18 IP-18 — bis dahin ehrlich leer, ohne Knopf (Maßnahmen: IP-13). */
export const LEER_SPAETER = (was: string) => `Noch keine ${was}. Diese Liste folgt; heute entstehen hier ${UEMS_ENERGIEZIELE} und ${UEMS_MASSNAHMEN}.`;

export const ZUSTAND_WORT = UEMS_ENERGIEZIEL_ZUSTAENDE;
export const ERGEBNIS_WORT = UEMS_ENERGIEZIEL_ERGEBNISSE;

export const VERLAUF_WORT: Record<EnergiezielEintrag['art'], string> = {
  energieziel_angelegt: 'angelegt',
  energieziel_geaendert: 'geändert',
  verantwortlicher_geaendert: `${UEMS_VERANTWORTLICH} geändert`,
  bewertung_beantragt: 'Bewertung beantragt',
  bewertung_abgelehnt: 'Bewertung abgelehnt',
  energieziel_bewertet: 'bewertet',
  energieziel_beendet: 'beendet',
  anstoss_gesetzt: 'Anstoß',
  anstoss_beantwortet: 'Anstoß beantwortet',
};

// ------------------------------------------------------------------ Datum und Zahlen (nur Anzeige)

/** `2028-01-15` (auch mit Uhrzeit) → `15.01.2028`. */
export function tag(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso ?? '');
}

/** `2028-01/2028-12` → „Januar bis Dezember 2028“; über den Jahreswechsel „November 2027 bis Oktober 2028“. */
export function zielperiodeText(zp: string): string {
  const [von, bis] = zp.split('/');
  if (!bis || von === bis) return monatWort(von);
  if (von.slice(0, 4) === bis.slice(0, 4)) return `${monatWort(von).split(' ')[0]} bis ${monatWort(bis)}`;
  return `${monatWort(von)} bis ${monatWort(bis)}`;
}

/** Der Zielwert einer Person, so wie sie ihn gesetzt hat (SP4: ohne „,0“): `-5.0` → „5 % weniger“. */
export function zielwertText(zielwert: string): string {
  const betrag = zielwert.replace(/^-/, '').replace(/\.0+$/, '');
  return `${deZahl(betrag)} % ${zielwert.startsWith('-') ? 'weniger' : 'mehr'}`;
}

/** Vorgabe der Zielperiode (§5.1): das nächste volle Kalenderjahr nach dem Anlegen-Tag. */
export function zielperiodeVorgabe(heute: string): string {
  const jahr = Number(heute.slice(0, 4)) + 1;
  return `${jahr}-01/${jahr}-12`;
}

// ------------------------------------------------------------------ Der Stand

/** Die Stand-Spalte des Registers: „2,9 % weniger nach 5 von 12 Monaten“ — Zahl und „x von y“ vom Leser. */
export function standSpalte(s: Pick<EnergiezielStand, 'summe' | 'monate_text'>): string {
  const delta = deltaText(s.summe.delta_prozent, s.summe.richtung);
  return delta === null ? `${STAND_OHNE_MONAT} (${s.monate_text})` : `${delta} nach ${s.monate_text} Monaten`;
}

export type MonatZeile =
  | { art: 'offen'; periode: string; beschriftung: string }
  | { art: 'gezaehlt'; periode: string; beschriftung: string; gemessen: string; erwartet: string; delta: string | null;
      urteil: string; band: string | null; urteilKlasse: string }
  | { art: 'ausgeschlossen'; periode: string; beschriftung: string; gemessen: string; satz: string };

/**
 * Je Monat der Zielperiode eine Zeile: noch nicht endgültig · gezählt (gemessen, erwartet, Δ, Urteil mit Band) ·
 * nicht gezählt mit dem Satz des Lesers als Grund (Z3). Zählt ein Monat, entscheidet der Leser über `nicht_gezaehlt`.
 */
export function monatZeilen(s: Pick<EnergiezielStand, 'monate' | 'nicht_gezaehlt'>): MonatZeile[] {
  const aus = new Set(s.nicht_gezaehlt.map((n) => n.monat));
  return s.monate.map(({ periode, endgueltig, vergleich: v }) => {
    const beschriftung = v.beschriftung;
    if (!endgueltig) return { art: 'offen', periode, beschriftung };
    const b = v.bereinigt;
    if (aus.has(periode) || b.erwartet === null) {
      return { art: 'ausgeschlossen', periode, beschriftung, gemessen: menge(b.gemessen.wert, b.gemessen.einheit), satz: v.satz };
    }
    return {
      art: 'gezaehlt',
      periode,
      beschriftung,
      gemessen: menge(b.gemessen.wert, b.gemessen.einheit),
      erwartet: menge(b.erwartet, b.gemessen.einheit),
      delta: deltaText(b.delta_prozent, b.richtung),
      urteil: urteilWort(b.urteil),
      band: band(b.band_prozent),
      urteilKlasse: b.urteil,
    };
  });
}

/** Die Summenzeile Σ ÷ Σ über die gezählten Monate, mit „x von y Monaten“ — ohne gezählten Monat `null`. */
export function summenZeile(s: Pick<EnergiezielStand, 'summe' | 'monate' | 'monate_text'>) {
  const z = s.summe;
  if (z.gemessen === null || z.erwartet === null) return null;
  const einheit = s.monate.find((m) => m.vergleich.bereinigt.gemessen.einheit)?.vergleich.bereinigt.gemessen.einheit ?? '';
  return {
    gemessen: menge(z.gemessen, einheit),
    erwartet: menge(z.erwartet, einheit),
    delta: deltaText(z.delta_prozent, z.richtung),
    urteil: urteilWort(z.urteil),
    band: band(z.band_prozent),
    urteilKlasse: z.urteil,
    monate: `${s.monate_text} Monaten`,
  };
}

/** Der Vorschlag steht nur bei vollständiger Periode (Z4) — sonst die Zahl mit Richtung und ohne Wort. */
export const vorschlagSatz = (s: Pick<EnergiezielStand, 'vollstaendig' | 'vorschlag' | 'vorschlag_satz'>) =>
  s.vollstaendig && s.vorschlag !== null ? s.vorschlag_satz : null;

/** Weicht das Ergebnis einer Person vom Vorschlag ab, steht das sichtbar daneben (Z4, AP-16 E8). */
export function weichtAb(vorschlag: EnergiezielStand['vorschlag'], ergebnis: EnergiezielErgebnis | null): boolean {
  if (vorschlag === null || ergebnis === null) return false;
  return (vorschlag === 'erreicht') !== (ergebnis === 'erreicht');
}
export const ABWEICHUNG_VOM_VORSCHLAG = 'weicht vom Vorschlag ab';

/** F1: „Bewertung fällig seit n Tagen“ — die Zahl kommt von der Route (IP-7), nie aus dem Portal. */
export function fristText(ez: Pick<Energieziel, 'frist'>): string | null {
  const f = ez.frist;
  if (!f || f.faellig !== 'bewertung_faellig' || f.seit_tagen === null) return null;
  return `Bewertung fällig seit ${f.seit_tagen} Tag${f.seit_tagen === 1 ? '' : 'en'}`;
}

/**
 * Der Zustand der Bewertung für die Seite (Z5): keiner · ein Antrag, den eine ZWEITE Person bestätigt (Vier-Augen) ·
 * bewertet. `eigener` sagt, ob die angemeldete Person den Antrag gestellt hat — sie darf ihn nicht bestätigen.
 */
export function bewertungLage(ez: Pick<Energieziel, 'bewertung' | 'zustand'>, sub: string | null) {
  const b = ez.bewertung ?? null;
  if (b?.status === 'beantragt') return { art: 'beantragt' as const, bewertung: b, eigener: sub !== null && b.person.sub === sub };
  if (b?.status === 'bewertet' || ez.zustand === 'bewertet') return { art: 'bewertet' as const, bewertung: b };
  return { art: 'keine' as const, abgelehnt: b?.status === 'abgelehnt' ? b : null };
}

export const beantragtSatz = (name: string, am: string, ergebnis: EnergiezielErgebnis) =>
  `Bewertung „${ERGEBNIS_WORT[ergebnis]}“ beantragt von ${name} am ${tag(am)} — eine zweite Person bestätigt oder lehnt ab.`;
export const EIGENER_ANTRAG = 'Ihren eigenen Antrag bestätigt eine zweite Person.';
export const bewertetSatz = (name: string, am: string, ergebnis: EnergiezielErgebnis) =>
  `Bewertet am ${tag(am)} von ${name}: ${ERGEBNIS_WORT[ergebnis]}.`;
/** Vier-Augen: die zweite Person, die den Antrag bestätigt hat. */
export const bestaetigtSatz = (name: string, am: string | null) => `Bestätigt von ${name}${am ? ` am ${tag(am)}` : ''}.`;
export const abgelehntSatz = (name: string | null) => `Bewertung abgelehnt${name ? ` von ${name}` : ''} — ein neuer Antrag ist möglich.`;

/** Die Anstöße am Energieziel (Z5): die Basis endet oder wird neu gefasst — eine Person antwortet. */
export const ANSTOSS_WORT: Record<NonNullable<Energieziel['anstoesse']>[number]['art'], string> = {
  ausgangslage_korrigiert: 'Ausgangslage korrigiert',
  bewertung_korrigiert: 'Bewertung korrigiert',
  messgrundlage_beendet: 'Bezugsbasis beendet',
  messgrundlage_neu_gefasst: 'Bezugsbasis neu gefasst',
};
export const ANSTOSS_ANTWORT: Record<'bleibt' | 'neu_kopiert' | 'neu_bewertet', string> = {
  bleibt: 'bleibt',
  neu_kopiert: 'neu kopiert',
  neu_bewertet: 'neu bewertet',
};
export const ANSTOESSE = 'Anstöße';
export const beendetSatz = (zum: string, grund: string | null) =>
  `Beendet zum ${tag(zum)}${grund ? `: ‚${grund}‘` : '.'}`;

/** Der Kopf des Energieziels (§5.9 „Energieziel, Stand“ bis zum ersten Punkt) — Kennzeichen und Wortlaut der Person. */
export const kopfZeile = (ez: Pick<Energieziel, 'kennzeichen' | 'wortlaut' | 'zielperiode' | 'verantwortlich'>) =>
  `${UEMS_ENERGIEZIEL} ${ez.kennzeichen} · ${ez.wortlaut} · ${zielperiodeText(ez.zielperiode)} · ${UEMS_VERANTWORTLICH} ${ez.verantwortlich.name}`;

// ------------------------------------------------------------------ Dialoge (nur Form — entschieden wird an der Route)

export const BEGRUENDUNG_MIN = 10;
export const BEGRUENDUNG_MAX = 500;
export const begruendungOk = (t: string) => t.trim().length >= BEGRUENDUNG_MIN && t.trim().length <= BEGRUENDUNG_MAX;
export const BEGRUENDUNG_HINWEIS = `Begründung mit ${BEGRUENDUNG_MIN} bis ${BEGRUENDUNG_MAX} Zeichen.`;

/**
 * Der Zielwert im Dialog: „Prozent weniger als erwartet“, eine Stelle; gesendet wird er wie im Vertrag (weniger
 * Energie negativ). Ein negativer Eintrag heißt „mehr“ — erlaubt, der Wortlaut sagt dann warum (§5.1).
 */
export function zielwertAusEingabe(eingabe: string): number | null {
  const t = eingabe.trim().replace(',', '.');
  if (!/^-?\d{1,2}(\.\d)?$/.test(t)) return null;
  const n = Number(t);
  if (n === 0) return null;
  return -n;
}

/** `JJJJ-MM` → Zahl der Monate seit Jahr 0, nur für die Reihenfolge im Dialog. */
const monatIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
export const zielperiodeOk = (von: string, bis: string) =>
  /^\d{4}-(0[1-9]|1[0-2])$/.test(von) && /^\d{4}-(0[1-9]|1[0-2])$/.test(bis) && monatIndex(bis) >= monatIndex(von);

/** Die Monate zur Wahl im Dialog: ab dem Monat nach heute, fünf Jahre (Z2: nie rückwirkend). */
export function monatsWahl(heute: string, anzahl = 60): { value: string; label: string }[] {
  // Monat 1-basiert: `jahr * 12 + monat` ist als 0-basierter Index genau der Monat nach heute.
  const start = Number(heute.slice(0, 4)) * 12 + Number(heute.slice(5, 7));
  return Array.from({ length: anzahl }, (_, i) => {
    const n = start + i;
    const jahr = Math.floor(n / 12);
    const monat = (n % 12) + 1;
    const value = `${jahr}-${String(monat).padStart(2, '0')}`;
    return { value, label: monatWort(value) };
  });
}

/** Die Ablehnungen der Route als Satz (VerbesserungAbgelehnt `{code, message}`); unbekannt → die Meldung der Route. */
export const ABLEHNUNG: Record<string, string> = {
  kennzahl_ohne_bezugsbasis: `Diese Kennzahl hat keine freigegebene Bezugsbasis — ohne sie gibt es kein ${UEMS_ENERGIEZIEL}.`,
  energieziel_laeuft: `Für diese Kennzahl läuft in dieser ${UEMS_ZIELPERIODE} schon ein ${UEMS_ENERGIEZIEL}.`,
  zielperiode_rueckwirkend: `Die ${UEMS_ZIELPERIODE} beginnt frühestens im nächsten Monat.`,
  zielperiode_vor_fassung: `Die ${UEMS_ZIELPERIODE} beginnt vor der Geltung der Bezugsbasis-Fassung.`,
  zielperiode_ungueltig: `Die ${UEMS_ZIELPERIODE} besteht aus ganzen Monaten, höchstens 120.`,
  energieziel_nicht_offen: `Dieses ${UEMS_ENERGIEZIEL} ist nicht mehr offen.`,
  vieraugen_urheber: 'Ihren eigenen Antrag bestätigt eine zweite Person.',
  vieraugen_rolle: 'Einen Antrag bestätigt oder lehnt eine Person mit der Rolle Kundenadministrator oder Energiemanager ab.',
  vieraugen_aus: 'Für Ihr Unternehmen ist keine Bestätigung durch eine zweite Person eingestellt — bitte direkt bewerten.',
  bewertung_nicht_faellig: `Bewertet wird nach dem Ende der ${UEMS_ZIELPERIODE}, wenn ihr letzter Monat endgültig ist.`,
  bewertung_beantragt: 'Für dieses Energieziel liegt schon ein Antrag auf Bewertung vor.',
  bewertung_nicht_beantragt: 'Es liegt kein Antrag auf Bewertung mehr vor.',
  tag_ungueltig: 'Der Tag liegt in der Zukunft oder vor dem Anlegen.',
};

/** Der Code einer Ablehnung (`VerbesserungAbgelehnt.code`), sonst `null`. */
export function ablehnungCode(e: unknown): string | null {
  const body = e instanceof ApiError && e.body && typeof e.body === 'object' ? (e.body as { code?: unknown }) : null;
  return typeof body?.code === 'string' ? body.code : null;
}

export function ablehnungSatz(e: unknown): string {
  const body = e instanceof ApiError && e.body && typeof e.body === 'object' ? (e.body as { code?: unknown; message?: unknown }) : null;
  const c = ablehnungCode(e);
  if (c && ABLEHNUNG[c]) return ABLEHNUNG[c];
  if (typeof body?.message === 'string' && body.message) return body.message;
  return e instanceof Error && e.message ? e.message : 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.';
}
