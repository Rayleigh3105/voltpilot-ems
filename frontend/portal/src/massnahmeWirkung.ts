/**
 * UEMS AP-18 IP-20 (§5.5–§5.7, WK1–WK6, M4, M5): das reine Bild des Abschnitts „Wirkung“, der Spalte „Bewertung“ und
 * der Anstöße am Vorgang. **Hier wird nichts gerechnet:** Nachher-Monate, „x von 12“, Σ ÷ Σ, Urteil, Band, Ausschlüsse
 * und ihre Sätze kommen vom Leser `GET …/massnahmen/{id}/wirkung` (IP-11), Stand Nr. n, Prüfsumme und der Satz des
 * Stands von der Route (IP-12). Das Portal setzt nur Zahlen ins deutsche Format und wählt Wörter aus `glossar.ts`.
 * Kein Satz sagt, die Maßnahme habe etwas bewirkt (WK5); „belegt“ sagt nur eine Person (WK6, E6 = A).
 */
import { runden } from './bezugsbasis';
import { band, deltaText, deZahl, menge, urteilWort } from './bezugsbasisVergleich';
import type { Massnahme, MassnahmeBewertung, MassnahmeErgebnis, MassnahmeWirkung, VorgangAnstoss, VorgangAnstossAntwortArt } from './api';
import { ablehnungCode, ANSTOSS_WORT, summenZeile, tag } from './energieziele';
import { ablehnungSatz as massnahmeAblehnung } from './massnahmen';
import { UEMS_BEOBACHTET, UEMS_MASSNAHME, UEMS_MASSNAHME_ERGEBNISSE, UEMS_VERBESSERUNG_SAETZE, UEMS_WIRKUNG } from './glossar';

// ------------------------------------------------------------------ Wörter

export const WIRKUNG = UEMS_WIRKUNG;
export const BEWERTUNG = 'Bewertung';
export const VORLAEUFIG = 'vorläufig';
export const ZUM_VERGLEICH = 'Daneben: Ausgangslage und erwartete Wirkung';
export const WIRKUNG_LADEFEHLER = `Die ${UEMS_WIRKUNG} konnte nicht geladen werden.`;
export const ROH_SPALTE = 'Kennzahl roh';
export const ROH_HINWEIS = 'Die rohe Kennzahl steht ohne Urteil daneben — sie ist nicht um die Einflussgröße bereinigt.';
export const ERGEBNIS_WORT = UEMS_MASSNAHME_ERGEBNISSE;
export const KNOPF_BEWERTEN = 'bewerten';
export const KNOPF_FREIGEBEN = 'Bewertung bestätigen';
export const KNOPF_ABLEHNEN = 'Bewertung ablehnen';
export const ALLE_STAENDE = 'Alle Stände der Bewertung';
export const STAENDE_LADEFEHLER = 'Die Stände konnten nicht geladen werden.';
export const EIGENER_ANTRAG = 'Ihren eigenen Antrag bestätigt eine zweite Person.';
export const BELEGT_HINWEIS = 'Bei „belegt“: was Sie wissen und die Zahl nicht zeigt.';
export const NUR_NICHT_MESSBAR = 'Ohne Messgrundlage ist „nicht messbar“ das einzige Ergebnis.';
export const ENDGUELTIG_HINWEIS = 'Die Bewertung ist endgültig: ein Stand mit Kopie der Wirkung und Prüfsumme, nie zurückgenommen.';

/** §5.9 „Bewertung, offen“ — ohne bewerteten Stand sagt die Fläche nur, was beobachtet ist. */
export const bewertungOffenSatz = UEMS_VERBESSERUNG_SAETZE.bewertungOffen;

// ------------------------------------------------------------------ Wirkung

export type WirkungZeile =
  | { art: 'offen'; periode: string; beschriftung: string }
  | { art: 'gezaehlt'; periode: string; beschriftung: string; gemessen: string; erwartet: string; delta: string | null;
      urteil: string; band: string | null; urteilKlasse: string; roh: string | null; version: number | null }
  | { art: 'nicht_gezaehlt'; periode: string; beschriftung: string; gemessen: string; satz: string; roh: string | null };

/** Die rohe Kennzahl ohne Wort (WK5): vier Stellen, nur zur Anzeige gerundet. */
export const rohText = (roh: string | null) => (roh === null ? null : deZahl(runden(roh, 4)));

/**
 * Je Monat vom Umsetzungsmonat an eine Zeile: noch nicht endgültig · gezählt (gemessen mit Version, erwartet, Δ,
 * Urteil mit Band, roh) · nicht gezählt mit dem Satz des Lesers (Umsetzungsmonat, nicht bewertbar, Basis nach der
 * Umsetzung). Ob ein Monat zählt, sagt allein `gezaehlt` der Route (WK3).
 */
export function wirkungZeilen(w: Pick<MassnahmeWirkung, 'monate'>): WirkungZeile[] {
  return w.monate.map(({ periode, endgueltig, gezaehlt, satz, kennzahl_roh, vergleich: v }) => {
    const beschriftung = v.beschriftung;
    const b = v.bereinigt;
    const roh = rohText(kennzahl_roh);
    if (!gezaehlt && satz) return { art: 'nicht_gezaehlt', periode, beschriftung, gemessen: menge(b.gemessen.wert, b.gemessen.einheit), satz, roh };
    if (!endgueltig || !gezaehlt) return { art: 'offen', periode, beschriftung };
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
      roh,
      version: b.gemessen.version,
    };
  });
}

/** Die Summenzeile Σ ÷ Σ mit „x von 12 Monaten“ — dieselbe Form wie am Energieziel; ohne gezählten Monat `null`. */
export function wirkungSumme(w: Pick<MassnahmeWirkung, 'summe' | 'monate' | 'monate_text'>) {
  if (!w.summe || !w.monate_text) return null;
  return summenZeile({ summe: w.summe, monate: w.monate, monate_text: w.monate_text });
}

/** Der Abschnitt „Wirkung“ erscheint ab `umgesetzt` (§5.5); geplant und verworfen haben keine. */
export const hatWirkung = (m: Pick<Massnahme, 'zustand'>) => m.zustand === 'umgesetzt' || m.zustand === 'bewertet';

/** „vorläufig (8 von 12 Monaten)“ — der Zustand steht im Feld `vorlaeufig`, nicht im Satz (IP-11). */
export const vorlaeufigText = (w: Pick<MassnahmeWirkung, 'vorlaeufig' | 'monate_text'>) =>
  w.vorlaeufig && w.monate_text ? `${VORLAEUFIG} (${w.monate_text} Monaten)` : null;

// ------------------------------------------------------------------ Bewertung (WK6)

/** Die Ergebnisse, die zur Wahl stehen: ohne Messgrundlage nur „nicht messbar“ (M4) — entschieden wird an der Route. */
export function ergebnisOptionen(m: Pick<Massnahme, 'messgrundlage'>): { value: MassnahmeErgebnis; label: string }[] {
  const alle = Object.keys(ERGEBNIS_WORT) as MassnahmeErgebnis[];
  return (m.messgrundlage ? alle : (['nicht_messbar'] as MassnahmeErgebnis[])).map((e) => ({ value: e, label: ERGEBNIS_WORT[e] }));
}

/** Prüfsumme in der Kurzform der Route (§5.9): die ersten vier Hex-Zeichen und „…“. */
export const pruefsummeKurz = (p: string | null) => (p ? `${p.replace(/^sha256:/, '').slice(0, 4)}…` : null);

/**
 * Der Satz eines Stands: der Satz der Route (`bewertung_belegt`, `bewertung_nicht_messbar`); für `nicht_belegt` hat
 * §5.9 keinen — dann die Felder in der Form des Nicht-messbar-Satzes (Datum, Person, Ergebnis, Begründung).
 */
export function standSatz(b: MassnahmeBewertung): string {
  return b.satz ?? `Bewertet am ${tag(b.am)} von ${b.person.name}: ${ERGEBNIS_WORT[b.ergebnis]} — ‚${b.begruendung}‘`;
}

export const standZeile = (b: Pick<MassnahmeBewertung, 'stand_nr' | 'pruefsumme'>) =>
  `Stand Nr. ${b.stand_nr}${b.pruefsumme ? ` · Prüfsumme ${b.pruefsumme}` : ''}`;

export const beantragtSatz = (b: Pick<MassnahmeBewertung, 'stand_nr' | 'person' | 'am' | 'ergebnis'>) =>
  `Stand Nr. ${b.stand_nr}: „${ERGEBNIS_WORT[b.ergebnis]}“ beantragt von ${b.person.name} am ${tag(b.am)} — eine zweite Person bestätigt oder lehnt ab.`;
export const bestaetigtSatz = (b: Pick<MassnahmeBewertung, 'entscheidung' | 'entschieden_am'>) =>
  b.entscheidung ? `Bestätigt von ${b.entscheidung.name}${b.entschieden_am ? ` am ${tag(b.entschieden_am)}` : ''}.` : null;
export const abgelehntSatz = (b: Pick<MassnahmeBewertung, 'stand_nr' | 'entscheidung' | 'entscheidungs_begruendung'>) =>
  `Stand Nr. ${b.stand_nr} abgelehnt${b.entscheidung ? ` von ${b.entscheidung.name}` : ''}${b.entscheidungs_begruendung ? `: ‚${b.entscheidungs_begruendung}‘` : '.'}`;

/** „bewerten“ gibt es an umgesetzten und bewerteten Maßnahmen ohne offenen Antrag (§5.7) — die Route entscheidet. */
export const bewertbar = (m: Pick<Massnahme, 'zustand' | 'bewertung_antrag'>) =>
  (m.zustand === 'umgesetzt' || m.zustand === 'bewertet') && !m.bewertung_antrag;

/** Wer den Antrag gestellt hat, bestätigt ihn nicht (Vier-Augen); die Route prüft auch den Verantwortlichen. */
export const eigenerAntrag = (m: Pick<Massnahme, 'bewertung_antrag'>, sub: string | null) =>
  !!m.bewertung_antrag && sub !== null && m.bewertung_antrag.person.sub === sub;

// ------------------------------------------------------------------ Anstöße am Vorgang (M5, Z5, IP-17)

/** Wort und Überschrift wie am Energieziel (IP-8) — eine Fassung. */
export { ANSTOESSE, ANSTOSS_WORT } from './energieziele';
/** Die Knöpfe (§5.6): „beibehalten“ mit Begründung, „neu kopieren“, „neu bewerten“. */
export const ANTWORT_KNOPF: Record<VorgangAnstossAntwortArt, string> = {
  bleibt: 'beibehalten',
  neu_kopiert: 'neu kopieren',
  neu_bewertet: 'neu bewerten',
};
/** Die gegebene Antwort im Vermerk. */
export const ANTWORT_WORT: Record<VorgangAnstossAntwortArt, string> = {
  bleibt: 'beibehalten',
  neu_kopiert: 'neu kopiert',
  neu_bewertet: 'neu bewertet',
};
export const KOPIE_BLEIBT = 'Die Kopie bleibt, wie sie ist, bis eine Person antwortet.';

/**
 * Welche Antworten zur Art passen (IP-17, §5.7): `bleibt` immer; `neu_kopiert` nur an der Ausgangslage einer Maßnahme;
 * `neu_bewertet` an der Maßnahme bei Bewertung/Basis, am Energieziel nur bei Basis-Ende/-Neufassung. Die Route prüft
 * dasselbe (422 `antwort_passt_nicht`) — das Portal zeigt nur keine Knöpfe, die sicher abgelehnt würden.
 */
export function antworten(vorgang: 'massnahme' | 'energieziel', art: VorgangAnstoss['art']): VorgangAnstossAntwortArt[] {
  const basis = art === 'messgrundlage_beendet' || art === 'messgrundlage_neu_gefasst';
  if (vorgang === 'energieziel') return basis ? ['bleibt', 'neu_bewertet'] : ['bleibt'];
  if (art === 'ausgangslage_korrigiert') return ['bleibt', 'neu_kopiert'];
  return ['bleibt', 'neu_bewertet'];
}

/** Die Zeile des Vermerks: Art · Anlass · Tag · offen bzw. die Antwort mit Person und Tag. */
export function anstossZeile(a: VorgangAnstoss): string {
  const kopf = `${ANSTOSS_WORT[a.art]} · ${a.anlass_kennung} · ${tag(a.angestossen_am)}`;
  if (a.zustand === 'offen') return `${kopf} · offen`;
  const wer = [a.beantwortet_von, a.beantwortet_am ? tag(a.beantwortet_am) : null].filter(Boolean).join(', ');
  return `${kopf} · ${a.antwort ? ANTWORT_WORT[a.antwort] : 'beantwortet'}${wer ? ` (${wer})` : ''}`;
}

// ------------------------------------------------------------------ Ablehnungen der Route

export const ABLEHNUNG: Record<string, string> = {
  massnahme_nicht_umgesetzt: `Bewertet wird eine ${UEMS_MASSNAHME} erst, wenn sie umgesetzt ist.`,
  ohne_messgrundlage: NUR_NICHT_MESSBAR,
  begruendung_fehlt: 'Begründung mit 10 bis 500 Zeichen.',
  vieraugen_urheber: EIGENER_ANTRAG,
  vieraugen_verantwortlich: `Wer für die ${UEMS_MASSNAHME} verantwortlich ist, bestätigt ihre Bewertung nicht — das tut eine zweite Person.`,
  vieraugen_rolle: 'Einen Antrag bestätigt oder lehnt eine Person mit der Rolle Kundenadministrator oder Energiemanager ab.',
  vieraugen_aus: 'Für Ihr Unternehmen ist keine Bestätigung durch eine zweite Person eingestellt — bitte direkt bewerten.',
  bewertung_beantragt: `Für diese ${UEMS_MASSNAHME} liegt schon ein Antrag auf Bewertung vor.`,
  bewertung_nicht_beantragt: 'Es liegt kein Antrag auf Bewertung mehr vor.',
  antwort_passt_nicht: 'Diese Antwort passt nicht zu diesem Anstoß.',
  anstoss_beantwortet: 'Auf diesen Anstoß hat schon jemand geantwortet.',
  massnahme_endgueltig: `Diese ${UEMS_MASSNAHME} ist verworfen — die Kopie lässt sich nicht mehr neu bilden; beibehalten geht weiter.`,
};

/** `beobachtet` als Wort der Fläche (E6): das System zeigt, was es sieht — nie „belegt“. */
export const BEOBACHTET = UEMS_BEOBACHTET;

export function ablehnungSatz(e: unknown): string {
  const c = ablehnungCode(e);
  return c && ABLEHNUNG[c] ? ABLEHNUNG[c] : massnahmeAblehnung(e);
}
