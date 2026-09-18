/**
 * DIE STEUERN-REGEL IM ANLEGE-FLUSS — der Modus „nur messen" (Captain 15.09.2026,
 * wörtlich: „Von Steuern soll beim Messen eigentlich noch nicht die Rede sein.
 * Ebenso eine Frage, darf ich ohne Anlage auch einfach Messstellen anlegen?").
 * Übernommen ist Empfehlung A: ein Modus im BESTEHENDEN Weg (`AnlageFlow`), kein
 * zweiter, schlanker Anlege-Weg daneben.
 *
 * Der Modus ist kein Schalter, sondern DERSELBE Fakt wie auf der Übersicht
 * (`uebersicht.steuernSpricht`, Steuern-Regel aus PR 779): die neue Anlage entsteht
 * an einem Standort. Spricht dieser Standort von Steuern — nimmt mindestens eine
 * seiner Anlagen teil —, läuft der Fluss Zeichen für Zeichen wie heute. Sonst spricht
 * er kein Wort von Steuern, Geld oder Erlösen: kein Schritt „Betrieb", keine
 * Veräußerungsform, keine Feineinstellungen, und am Ende geht es ohne Umweg zu den
 * Messstellen. Nicht ausgegraut — nicht vorhanden.
 *
 * ⚠ Solange kein Standort gewählt ist, spricht das Unternehmen: sobald irgendein
 * Standort von Steuern spricht, wie heute. Ohne Funktionen (älteres Backend, Fehler)
 * und ohne Standort-Objekt bleibt alles wie heute — dieselbe Grenze wie die Geld-Regel
 * je Anlage (`anlageGeld.ts`, PR 776). Still heißt nicht Sackgasse: die Anlage behält
 * ihren Bereich „Steuerung", Tarif und Netzgrenzen stehen unter „Einstellungen".
 * Ohne geladene Funktionen fällt keine Entscheidung; so blitzt weder die heutige
 * noch die stille Fassung auf.
 *
 * Reines Modul: keine React-Importe, kein Netzwerk.
 */
import type { FunktionStandort, Funktionen } from './api';
import { FLOW_STEPS } from './anlageFlow';
import { pageRoute, standortMessstellenRoute, type Route } from './nav';
import { steuernSpricht } from './uebersicht';

/** Wie der Anlege-Fluss spricht: wie heute, oder ohne ein Wort über Steuern und Geld. */
export type AnlegeArt = 'wie_heute' | 'nur_messen' | 'standort_zuerst';

export const STANDORT_ZUERST_TITEL = 'Zuerst den Standort';
export const STANDORT_ZUERST_SATZ =
  'Jede Anlage gehört zu einem Standort. Legen Sie ihn zuerst an; danach geht es hier mit der Anlage weiter.';

/**
 * Woran der Fluss steht: am gewählten Standort (Schritt 1), an der schon bestehenden
 * Anlage (Wiedereinstieg des Assistenten) — oder noch an nichts.
 */
export interface AnlegeOrt {
  standortId?: string | null;
  anlageId?: string | null;
  /** Bestandsschutz: es gibt bereits mindestens eine Anlage, auch wenn sie keinem Standort zugeordnet ist. */
  hatAnlage?: boolean;
}

/**
 * Der Standort, an dem die Anlage entsteht, so wie `GET /funktionen` ihn nennt:
 * der gewählte; beim Wiedereinstieg der, unter dem die Anlage steht; ohne beides der
 * einzige. `null`, wenn es keinen gibt oder die Wahl unter mehreren noch offen ist.
 */
export function anlegeStandort(funktionen: Funktionen | null, ort: AnlegeOrt): FunktionStandort | null {
  const standorte = funktionen?.standorte ?? [];
  if (ort.standortId) return standorte.find((s) => s.id === ort.standortId) ?? null;
  if (ort.anlageId) return standorte.find((s) => s.steuern.anlagen.some((a) => a.id === ort.anlageId)) ?? null;
  return standorte.length === 1 ? standorte[0] : null;
}

/**
 * Die Entscheidung. Ohne Standort UND Anlage kommt zuerst der Standort; eine
 * Bestandsanlage ohne Standort bleibt wie heute. Ein Standort, den `GET /funktionen`
 * nicht nennt, hat keine Ebene — er bleibt wie heute, nie still „nur messen".
 */
export function anlegeArt(funktionen: Funktionen | null, ort: AnlegeOrt = {}): AnlegeArt | null {
  if (funktionen === null) return null;
  const standorte = funktionen.standorte;
  if (standorte.length === 0) {
    return ort.hatAnlage || ort.anlageId || ort.standortId ? 'wie_heute' : 'standort_zuerst';
  }
  if (ort.standortId || ort.anlageId) {
    const standort = anlegeStandort(funktionen, ort);
    return standort && !steuernSpricht(standort) ? 'nur_messen' : 'wie_heute';
  }
  return standorte.some(steuernSpricht) ? 'wie_heute' : 'nur_messen';
}

/**
 * Die Schritte der Leiste. „Betrieb" fragt nach Betriebsmodell und Speicherschonung —
 * er gehört zum Steuern. Er steht nur, wenn der Fluss wie heute spricht; solange das
 * noch nicht feststeht (`null`), fehlt er (sonst stünde er einen Augenblick da und
 * verschwände, dieselbe Falle wie beim Geld, `uems-leerzustaende.md` Falle 4).
 */
export function anlegeSchritte(art: AnlegeArt | null): readonly string[] {
  if (art === 'standort_zuerst') return ['Standort', ...FLOW_STEPS.filter((s) => s !== 'Betrieb')];
  return art === 'wie_heute' ? FLOW_STEPS : FLOW_STEPS.filter((s) => s !== 'Betrieb');
}

/**
 * Text eines Leerzustands „Noch keine Anlage“. Erst wenn die Entscheidung feststeht,
 * erscheint eine der beiden Fassungen; Laden oder Fehler behauptet weder Geld noch
 * reine Messung. Ohne Standort-Bezug (`standort_zuerst`) bleibt der heutige Text.
 */
export function anlageLeertext(
  art: AnlegeArt | null,
  wieHeute: string,
  nurMessen: string,
): string | null {
  if (art === null) return null;
  return art === 'nur_messen' ? nurMessen : wieHeute;
}

/** Der Knopf am Ende des Modus „nur messen". */
export const ZU_DEN_MESSSTELLEN = 'Zu den Messstellen';

/** Wohin der Knopf führt: „Standort › Messstellen", ohne bekannten Standort „Unternehmen › Messstellen". */
export function messstellenZiel(standort: FunktionStandort | null): Route {
  return standort ? standortMessstellenRoute(standort.id) : pageRoute('portfolio-messstellen');
}

/**
 * Der Übergabe-Satz am Ende — statt `SETUP_NEXT_HINT`, der „… wählen danach Ihre
 * Steuerung" sagt.
 */
export function nurMessenWeiterSatz(standort: FunktionStandort | null): string {
  const wo = standort ? `„Messstellen“ von ${standort.name}` : '„Messstellen“';
  return `So geht es weiter: Unter ${wo} legen Sie fest, was gemessen wird.`;
}

/** Die Bestätigung nach den ersten Daten (Einrichtungs-Assistent) — ohne „optimierten Speicher-Fahrplan". */
export const ERSTE_DATEN_NUR_MESSEN = 'Ihr Gerät sendet Daten. Im Portal sehen Sie ab jetzt die Messwerte Ihrer Anlage.';

/**
 * DIE WORTLISTE des Modus „nur messen": Wortstämme über Steuern, Geld und Erlöse,
 * die dort nirgends stehen dürfen — in keinem Schritt, Hinweis, Knopf, Leerzustand,
 * keiner Beschriftung und keinem Platzhalter. Die Prüfungen laufen gegen DIESE Liste,
 * nicht gegen einzelne Sätze (`AnlageFlow.nurMessen.test.tsx`, `e2e/anlage-anlegen.spec.ts`).
 *
 * Klein geschrieben, verglichen als Teilwort ohne Groß-/Kleinschreibung („steuer"
 * trifft „Steuerung" und „gesteuert"). ⚠ Bewusst NICHT darauf: „Marktstammdaten"
 * (der Name des Registers), „Betrieb" allein („In Betrieb seit" im Register),
 * „Einspeisung" allein (eine Messgröße) und „Regel" allein („in der Regel").
 */
export const STEUER_GELD_WOERTER: readonly string[] = [
  // Steuern
  'steuer',
  'optimier',
  'betriebsmodell',
  'fahrplan',
  'speicherschonung',
  'netzladen',
  'einspeisegrenze',
  'einspeiseleistung',
  'lastspitze',
  'lastmanagement',
  // Geld und Erlöse
  'geld',
  'erlös',
  '€',
  'euro',
  'ct/kwh',
  'tarif',
  'preis',
  'kosten',
  'vergüt',
  'verdien',
  'gespart',
  'ersparnis',
  'sparen',
  'marktprämie',
  'direktvermarkt',
  'veräußerung',
  'eeg',
];

/** Die Wörter der Liste, die in `text` stehen — leer heißt: der Text schweigt über Steuern und Geld. */
export function steuerGeldWoerter(text: string): string[] {
  const klein = text.toLocaleLowerCase('de-DE');
  return STEUER_GELD_WOERTER.filter((w) => klein.includes(w));
}
