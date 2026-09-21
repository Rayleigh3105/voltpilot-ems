/**
 * Die Kundensätze der GEMEINSAMEN STEUERUNG (UEMS AP-15 IP-25, Konzept §4.10 S1–S3 und §5.8).
 *
 * Kundenwort ist „Gemeinsame Steuerung“ (S1, Auflösung W5). Das Fach- und Vertragswort
 * „Steuerungsverbund“ steht nie auf einer Kundenfläche — der Sprach-Wächter in `copy.test.ts`
 * (AP-14 IP-19, Regel S3) verbietet es neben „Verbund“, „gemeinsam optimiert“ und
 * „übergreifend optimiert“. Jeder Satz hier besteht diesen Wächter.
 *
 * Eine Quelle für die Kunden-Fläche (IP-23) und das Betreiber-Blatt (IP-24): die Sätze stehen
 * wörtlich wie in §5.8; wo §5.8 einen Wert einsetzt, steht ein Platzhalter `{name}`. Werte kommen
 * fertig formatiert herein (Zahlen in deutscher Schreibweise, Uhrzeit `HH:MM` in der Zone der
 * Anlage); `satz` wirft, wenn ein Platzhalter offen bliebe.
 */

/** Die vier Zustände der Gemeinsamen Steuerung (S1), in ihrer Reihenfolge. */
export const ZUSTAENDE = {
  eingerichtet: 'eingerichtet',
  wird_geprueft: 'wird geprüft',
  aktiv: 'aktiv',
  angehalten: 'angehalten',
} as const;

export const KUNDENWORT = 'Gemeinsame Steuerung';

/**
 * Die Sätze aus §5.8, je Zeile ein Schlüssel. Platzhalter:
 * `{box}`/`{box}`/`{andere_box}` Box-Name ohne das Wort „Box“, `{boxen}` Anzahl,
 * `{einspeisung_kw}`/`{bezug_kw}`/`{kw}` Leistung in kW, `{uhrzeit}` HH:MM, `{kwh}` Energie in kWh,
 * `{ladepark}` Gerätename des Ladeparks.
 */
export const SAETZE = {
  /** Karte, Zustand aktiv */
  karte_aktiv: 'Gemeinsame Steuerung aktiv · {boxen} Boxen · Einspeisung höchstens {einspeisung_kw} kW · Bezug höchstens {bezug_kw} kW',
  /** Box-Zeile, führend */
  box_fuehrend: 'Box {box} führt die Anlage · regelt am Netzanschluss',
  /** Box-Zeile, mitsteuernd */
  box_mitsteuernd: 'Box {box} steuert mit · hält ihren Anteil: Einspeisung {einspeisung_kw} kW · Bezug {bezug_kw} kW',
  /** Erklärung unter den Anteilen */
  erklaerung_anteile: 'Jede Box hält ihren Teil der Grenze selbst ein — auch ohne Internet. Zusammen bleiben sie immer unter der Grenze am Netzanschluss.',
  /** Box stumm (Matrixzeile A1) */
  box_stumm: 'Box {box} antwortet seit {uhrzeit} nicht. Die Grenze am Netzanschluss bleibt eingehalten; ihre Geräte laufen mit ihren sicheren Vorgabewerten.',
  /** führende Box stumm (A2) */
  fuehrende_box_stumm: 'Box {box} antwortet nicht. Niemand regelt gerade am Netzanschluss; jede Box und jedes Gerät hält seinen sicheren Anteil.',
  /** beide nicht verbunden (A4) */
  beide_nicht_verbunden: 'Beide Boxen sind nicht verbunden. Die Grenze am Netzanschluss halten sie selbst ein.',
  /** Zähler fehlt (A7) */
  zaehler_fehlt: 'Box {box} sieht den Netzzähler nicht; sie hält ihren sicheren Anteil.',
  /** Update nötig (A12) */
  update_noetig: 'Box {box} braucht ein Update für die gemeinsame Steuerung.',
  /** fremde Anlage (R20) */
  fremde_anlage: 'Diese Box gehört zu einer anderen Anlage. Gemeinsam gesteuert wird nur hinter demselben Netzanschluss.',
  /** Regel über zwei Boxen */
  regel_ueber_zwei_boxen: 'Diese Regel braucht Werte von Box {box} und steuert ein Gerät an Box {andere_box}. Eine Regel lebt heute auf einer Box.',
  /** Verlust-Zeile (R2) */
  verlust: 'Heute {kwh} kWh nicht erzeugt, weil diese Box den Netzanschluss nicht sieht.',
  /** Vorbehalt erhöht (R23) */
  vorbehalt_erhoeht: 'Ihr Verbrauch ist gewachsen: die Reserve für alles Übrige wurde erhöht. Der {ladepark} bekommt jetzt höchstens {kw} kW.',
  /** Hinweis beim Einrichten (G7) */
  hinweis_einrichten: 'Der Ladepark hängt an einer Box, die den Netzanschluss nicht sieht: er bekommt fest {kw} kW. An Box {box} bekäme er, was am Anschluss frei ist.',
  /** Anhalten */
  angehalten: 'Gemeinsame Steuerung angehalten. Box {box} steuert allein; alle Boxen halten weiter ihren Anteil.',
  /** Prüfung läuft */
  pruefung_laeuft: 'Eingerichtet · wird geprüft. VoltPilot prüft die Anlage mit einer kurzen Messung und schaltet sie frei.',
} as const;

export type SatzSchluessel = keyof typeof SAETZE;

/** Die Platzhalter einer Vorlage, in der Reihenfolge ihres ersten Auftretens. */
export function platzhalter(vorlage: string): string[] {
  return [...new Set([...vorlage.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]))];
}

/** Setzt die Werte in den Satz `schluessel` ein; ein fehlender oder überzähliger Wert ist ein Fehler. */
export function satz(schluessel: SatzSchluessel, werte: Record<string, string> = {}): string {
  const vorlage: string = SAETZE[schluessel];
  const noetig = platzhalter(vorlage);
  const fehlt = noetig.filter((k) => !(k in werte));
  const zuviel = Object.keys(werte).filter((k) => !noetig.includes(k));
  if (fehlt.length > 0 || zuviel.length > 0) {
    throw new Error(`Satz ${schluessel}: fehlt [${fehlt.join(', ')}], überzählig [${zuviel.join(', ')}]`);
  }
  return vorlage.replace(/\{([a-z_]+)\}/g, (_, k: string) => werte[k]);
}
