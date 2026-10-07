/**
 * UEMS AP-18 IP-20 (§5.5–§5.7, WK1–WK6, M4, M5): die Wörter und Regeln von Wirkung, Bewertung und Anstößen am Vorgang
 * (das Bild der Seite seit Verbessern-Konzept v1 PR 2: `massnahmenBild.ts`, `components/WirkungsGrafik.tsx`). **Hier wird nichts gerechnet:** Nachher-Monate, „x von 12“, Σ ÷ Σ, Urteil, Band, Ausschlüsse
 * und ihre Sätze kommen vom Leser `GET …/massnahmen/{id}/wirkung` (IP-11), Stand Nr. n, Prüfsumme und der Satz des
 * Stands von der Route (IP-12). Das Portal setzt nur Zahlen ins deutsche Format und wählt Wörter aus `glossar.ts`.
 * Kein Satz sagt, die Maßnahme habe etwas bewirkt (WK5); „belegt“ sagt nur eine Person (WK6, E6 = A).
 */
import { runden } from './bezugsbasis';
import { deZahl } from './bezugsbasisVergleich';
import type { Massnahme, MassnahmeBewertung, MassnahmeErgebnis, VorgangAnstoss, VorgangAnstossAntwortArt } from './api';
import { ablehnungCode, ANSTOSS_WORT, tag } from './energieziele';
import { ablehnungSatz as massnahmeAblehnung } from './massnahmen';
import { UEMS_MASSNAHME, UEMS_MASSNAHME_ERGEBNISSE, UEMS_VERBESSERUNG_SAETZE, UEMS_WIRKUNG } from './glossar';

// ------------------------------------------------------------------ Wörter

export const WIRKUNG = UEMS_WIRKUNG;
export const ROH_SPALTE = 'Kennzahl roh';
export const ROH_HINWEIS = 'Die rohe Kennzahl steht ohne Urteil daneben — sie ist nicht um die Einflussgröße bereinigt.';
export const ERGEBNIS_WORT = UEMS_MASSNAHME_ERGEBNISSE;
export const KNOPF_FREIGEBEN = 'Bewertung bestätigen';
export const KNOPF_ABLEHNEN = 'Bewertung ablehnen';
export const ALLE_STAENDE = 'Alle Stände der Bewertung';
export const STAENDE_LADEFEHLER = 'Die Stände konnten nicht geladen werden.';
export const EIGENER_ANTRAG = 'Ihren eigenen Antrag bestätigt eine zweite Person.';
export const NUR_NICHT_MESSBAR = 'Ohne Messgrundlage ist „nicht messbar“ das einzige Ergebnis.';

/** §5.9 „Bewertung, offen“ — ohne bewerteten Stand sagt die Fläche nur, was beobachtet ist. */
export const bewertungOffenSatz = UEMS_VERBESSERUNG_SAETZE.bewertungOffen;

// ------------------------------------------------------------------ Wirkung

/** Die rohe Kennzahl ohne Wort (WK5): vier Stellen, nur zur Anzeige gerundet. */
export const rohText = (roh: string | null) => (roh === null ? null : deZahl(runden(roh, 4)));

/** Die Ergebnisse, die zur Wahl stehen: ohne Messgrundlage nur „nicht messbar“ (M4) — entschieden wird an der Route. */
export function ergebnisOptionen(m: Pick<Massnahme, 'messgrundlage'>): { value: MassnahmeErgebnis; label: string }[] {
  const alle = Object.keys(ERGEBNIS_WORT) as MassnahmeErgebnis[];
  return (m.messgrundlage ? alle : (['nicht_messbar'] as MassnahmeErgebnis[])).map((e) => ({ value: e, label: ERGEBNIS_WORT[e] }));
}

export const standZeile = (b: Pick<MassnahmeBewertung, 'stand_nr' | 'pruefsumme'>) =>
  `Stand Nr. ${b.stand_nr}${b.pruefsumme ? ` · Prüfsumme ${b.pruefsumme}` : ''}`;

export const beantragtSatz = (b: Pick<MassnahmeBewertung, 'stand_nr' | 'person' | 'am' | 'ergebnis'>) =>
  `Stand Nr. ${b.stand_nr}: „${ERGEBNIS_WORT[b.ergebnis]}“ beantragt von ${b.person.name} am ${tag(b.am)} — eine zweite Person bestätigt oder lehnt ab.`;
export const bestaetigtSatz = (b: Pick<MassnahmeBewertung, 'entscheidung' | 'entschieden_am'>) =>
  b.entscheidung ? `Bestätigt von ${b.entscheidung.name}${b.entschieden_am ? ` am ${tag(b.entschieden_am)}` : ''}.` : null;
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

export function ablehnungSatz(e: unknown): string {
  const c = ablehnungCode(e);
  return c && ABLEHNUNG[c] ? ABLEHNUNG[c] : massnahmeAblehnung(e);
}
