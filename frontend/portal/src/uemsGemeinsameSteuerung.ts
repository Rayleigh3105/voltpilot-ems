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

/**
 * Regel T6 (IP-26): Grund UND Weg, wenn eine Datenquelle ihre Box nur als Änderung der Gemeinsamen
 * Steuerung wechselt (anhalten → ändern → prüfen → scharfschalten) — in einer Anlage mit
 * eingerichteter Gemeinsamer Steuerung für jede Steuerquelle, solange die Anteile in Kraft sind
 * auch für Netzzähler und Messpunkt eines Mitglieds. Kein Satz aus §5.8: derselbe Wortlaut steht
 * als `texte.gemeinsame_steuerung_aendern` in `data-source-vectors.json` (Java-Zwilling
 * `DatenquelleRegeln`) und kommt als `message` der 409 `gemeinsame_steuerung_aendern` zurück.
 * Die Fläche „Gemeinsame Steuerung ändern“ baut IP-23 — bis dahin nennt der Satz den Weg, ohne
 * auf eine Seite zu verweisen. Platzhalter `{kennzeichen}`: das Kennzeichen der Quelle.
 */
export const WECHSEL_NUR_ALS_AENDERUNG =
  '{kennzeichen} gehört zur Gemeinsamen Steuerung — ihre Box wechselt nur über „Gemeinsame Steuerung ändern“';

/**
 * Die Sätze der Kundenfläche (IP-23), die §5.8 nicht nennt: die wörtlichen Sätze aus §5.2 (Nr. 2, 3, 6), die
 * Antwort auf „Passt die Anlage zur Grenze?“, Grund und Weg beim Anhalten und die Verlust-Zeile. Die Verlust-Zeile
 * trägt die Untergrenze aus IP-22: `kwh` ist eine UNTERGRENZE, die gebundene Zeit ist exakt — darum steht kWh nie
 * ohne „mindestens“ (Variante A: kWh, sonst Zeit; Variante B: immer die Zeit, kWh nur als Zusatz).
 */
export const FLAECHE = {
  /** Kopf der Karte unter Anlage → Technik */
  karte_erklaerung: 'Mehrere Boxen dieser Anlage halten die Grenzen am Netzanschluss zusammen ein — jede ihren Teil.',
  /** ohne Gemeinsame Steuerung, mehr als eine Box */
  nicht_eingerichtet: 'Diese Anlage hat {boxen} Boxen. Mit der Gemeinsamen Steuerung hält jede Box ihren Teil der Grenze am Netzanschluss selbst ein. An den Boxen ändert sich erst etwas, wenn VoltPilot die Anlage geprüft und freigeschaltet hat.',
  /** Box-Zeile, mitsteuernd, vor dem Freischalten (die Anteile sind noch nicht in Kraft) */
  box_mitsteuernd_geplant: 'Box {box} steuert mit, sobald VoltPilot freischaltet · vorgesehener Anteil: Einspeisung {einspeisung_kw} kW · Bezug {bezug_kw} kW',
  /** Box-Zeile, mitsteuernd, solange die Auslegung keinen Anteil nennt */
  box_mitsteuernd_kurz: 'Box {box} steuert mit',
  box_mitsteuernd_geplant_kurz: 'Box {box} steuert mit, sobald VoltPilot freischaltet',
  /** Befund `auslegung_passt_nicht` */
  auslegung_passt_nicht: 'Die Anlage passt noch nicht zur Grenze am Netzanschluss.',
  /** §5.2 Nr. 2, wörtlich */
  netzzaehler_fehlt: 'Für die gemeinsame Steuerung muss eine Box den Zähler am Netzanschluss lesen.',
  /** §5.2 Nr. 3, wörtlich */
  netzanschluss_fehlt: 'Bitte zuerst den Netzanschluss dieser Anlage eintragen.',
  /** Netzanschluss ohne Einspeise- oder Bezugsgrenze */
  grenze_fehlt: 'Am Netzanschluss dieser Anlage fehlt noch eine Grenze für Einspeisung oder Bezug.',
  /** Der Zähler (Messpunkt) einer mitsteuernden Box gehört nicht zu dieser Anlage — Kundenwort „Zähler“ (D3) */
  abgangszaehler_fehlt: 'Box {box} liest ihren Zähler nicht in dieser Anlage.',
  /** §5.2 Nr. 6, wörtlich */
  signal_ladepunkte: 'Die Ladepunkte müssen an der Box hängen, die das Signal des Netzbetreibers bekommt.',
  /** §5.2 Nr. 6 („Am Wechselrichter Verwaltung …“), mit dem Gerätenamen aus dem Bestand */
  rueckfall_fehlt: 'Am Gerät {geraet} ist kein sicherer Rückfallwert hinterlegt — es zählt mit seiner vollen Leistung.',
  /** Frage 6 vor „Absenden“ (§5.2 Nr. 6/7): das Ergebnis ist ein Entwurf */
  ergebnis_entwurf: 'Noch ist nichts gespeichert. Mit „Absenden“ richten Sie die Gemeinsame Steuerung so ein.',
  /** §5.2 Nr. 7, wörtlich */
  abgesendet: 'An den Boxen hat sich nichts geändert.',
  /** Frage 6: Passt die Anlage zur Grenze? */
  urteil_passt: 'Ja — die Anlage passt zur Grenze am Netzanschluss.',
  urteil_passt_nicht: 'Nein — ohne ihre Boxen kämen die Geräte auf {summe_kw} kW, die Grenze lässt {verteilbar_kw} kW zu.',
  urteil_vorbehalt_ueber_grenze: 'Nein — schon was keine Box steuert, braucht mehr, als die Grenze zulässt.',
  urteil_offen: 'Noch nicht zu rechnen — dafür fehlen Angaben aus den Fragen davor.',
  /** Grund und Weg: angehalten vom Betreiber (409 `vom_betreiber_angehalten`) */
  vom_betreiber_angehalten: 'VoltPilot hat die Gemeinsame Steuerung angehalten. Fortsetzen kann nur VoltPilot — bitte wenden Sie sich an den Support.',
  /** Grund und Weg: ändern in aktiv (409 `erst_anhalten`) */
  erst_anhalten: 'Um die Gemeinsame Steuerung zu ändern, halten Sie sie zuerst an — alle Boxen halten dabei weiter ihren Anteil. Danach prüft VoltPilot die Änderung und schaltet wieder frei.',
  /** Anhalten: was passiert, was bleibt (§5.5) */
  anhalten_intro: 'Die Boxen bekommen keinen gemeinsamen Plan mehr.',
  anhalten_fortsetzen: 'Fortsetzen können Sie jederzeit hier — ohne neue Prüfung, solange sich an den Boxen nichts geändert hat.',
  /** Verlust-Zeile, Variante A mit kWh > 0 */
  verlust_mindestens: 'Heute mindestens {kwh} kWh nicht erzeugt, weil diese Box den Netzanschluss nicht sieht.',
  /** Verlust-Zeile nach der gebundenen Zeit (Variante A ohne kWh, Variante B immer) */
  verlust_zeit: 'Heute {dauer} begrenzt, weil diese Box den Netzanschluss nicht sieht.',
  /** Verlust-Zeile, Variante B mit kWh > 0 */
  verlust_zeit_mindestens: 'Heute {dauer} begrenzt, weil diese Box den Netzanschluss nicht sieht — mindestens {kwh} kWh nicht erzeugt.',
} as const;

export type FlaechenSchluessel = keyof typeof FLAECHE;

/** Die Platzhalter einer Vorlage, in der Reihenfolge ihres ersten Auftretens. */
export function platzhalter(vorlage: string): string[] {
  return [...new Set([...vorlage.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]))];
}

/** Setzt die Werte in den Satz `schluessel` ein; ein fehlender oder überzähliger Wert ist ein Fehler. */
export function satz(schluessel: SatzSchluessel, werte: Record<string, string> = {}): string {
  return einsetzen(schluessel, SAETZE[schluessel], werte);
}

/** Wie {@link satz}, für die Sätze der Kundenfläche ({@link FLAECHE}). */
export function flaechenSatz(schluessel: FlaechenSchluessel, werte: Record<string, string> = {}): string {
  return einsetzen(schluessel, FLAECHE[schluessel], werte);
}

function einsetzen(schluessel: string, vorlage: string, werte: Record<string, string>): string {
  const noetig = platzhalter(vorlage);
  const fehlt = noetig.filter((k) => !(k in werte));
  const zuviel = Object.keys(werte).filter((k) => !noetig.includes(k));
  if (fehlt.length > 0 || zuviel.length > 0) {
    throw new Error(`Satz ${schluessel}: fehlt [${fehlt.join(', ')}], überzählig [${zuviel.join(', ')}]`);
  }
  return vorlage.replace(/\{([a-z_]+)\}/g, (_, k: string) => werte[k]);
}
