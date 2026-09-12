/**
 * Die EINHEITEN der Bezugsdaten als eigenes, reines Modul (UEMS AP-09 §4.4
 * U1–U5, IP-3) — der TS-Zwilling von `services/api .../uems/BezugsEinheit`.
 *
 * Der Vertrag und die Wahrheit stehen in
 * `docs/contracts/v2/bezugsdaten-vectors.json` (Familie `einheit`). Wer eine
 * Regel ändert, ändert die Datei UND beide Zwillinge.
 *
 * Warum ein eigenes Modul: Import, Eingabe, Kennzahlen und Berichte brauchen
 * dieselbe Umrechnung. Sie steht deshalb EINMAL hier; `bezugsdaten.ts` reicht
 * sie weiter, statt sie ein zweites Mal zu führen.
 *
 * Die Umrechnungsgrenze (E4/U1): das Vokabular ist geschlossen und gilt JE
 * GRÖSSE; gerechnet wird NUR innerhalb derselben Größe und nur mit einem FESTEN
 * Faktor aus dem Vertrag (t ↔ kg, l ↔ m³, min ↔ h). Ein vom Kunden eingegebener
 * Faktor ist ausgeschlossen — „48 Stück je Palette" ist eine Annahme, die im
 * Wert verschwinden würde. Ein Wort außerhalb des Vokabulars ist
 * `einheit_unbekannt`, nie ein geratener Faktor.
 *
 * Exakt, nicht gerundet: jeder Betrag reist als Dezimaltext und wird als `Dez`
 * gerechnet (`dez.ts`) — 312,4 t sind genau 312 400 kg.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr.
 */

import { dezSkaliere, dezTeile, type Dez } from './dez';

/** U2: das gelieferte Wort steht nicht im Vokabular der Ziel-Größe — die Zeile wird abgelehnt. */
export const EINHEIT_UNBEKANNT = 'einheit_unbekannt';

/** U1: der Betrag wurde mit dem festen Faktor des Vertrags in die Einheit der Bezugsgröße gebracht. */
export const EINHEIT_UMGERECHNET = 'einheit_umgerechnet';

/** U5: diese Einheiten nehmen keine Nachkommastellen an — „Stück sind ganze Zahlen". */
export const GANZZAHL_EINHEITEN = ['Stück', 'Personen', 'Schichten'];

/**
 * Die Kundensätze der Befunde dieses Moduls — hier, nicht in der Fläche: EINE
 * Formulierung, nicht zwei. `bezugsEinheit.test.ts` prüft sie Wort für Wort
 * gegen `befund_saetze` der Vektor-Datei.
 */
export const SAETZE: Record<string, string> = {
  [EINHEIT_UNBEKANNT]: 'Unbekannte Einheit — erlaubt sind die Einheiten dieser Größe.',
  [EINHEIT_UMGERECHNET]: 'Der gelieferte Wert wurde in die Einheit der Bezugsgröße umgerechnet.',
};

/** U1: eine erlaubte Umrechnung. Sie gilt in BEIDE Richtungen. */
export type Umrechnung = {
  von: string;
  nach: string;
  zehnerpotenz?: number;
  teiler?: number;
  nachkommastellen?: number;
};

/** U1–U3: der Betrag in der Einheit der Bezugsgröße; `null` heißt „abgelehnt". */
export type Einheitswert = { betrag: Dez | null; einheit: string; befunde: string[] };

/** Die Größe, zu der eine Einheit gehört — oder `null`, wenn keine sie führt. */
export const groesseVon = (einheitswort: string, einheiten: Record<string, string[]>): string | null => {
  for (const [groesse, woerter] of Object.entries(einheiten)) {
    if (woerter.includes(einheitswort)) return groesse;
  }
  return null;
};

const normal = (wort: string): string => wort.trim().toLowerCase().replace(/\.+$/, '');

/**
 * U2 — das Wort der Datei wird durch die Einheit der Vorlage ersetzt, sonst
 * bleibt es, wie es geliefert wurde. Ein Synonym ist eine Text-Ersetzung VOR
 * der Prüfung („Stk" ist Stück, „Std" ist h) und nie eine Umrechnung: es ändert
 * das Wort, nie den Betrag. Groß-/Kleinschreibung und Punkte am Wortende
 * werden angeglichen, weil ein Typenschild nicht zwischen ihnen unterscheidet.
 */
export const synonym = (geliefert: string | null, synonyme?: Record<string, string>): string | null => {
  if (geliefert === null || !synonyme) return geliefert;
  const schluessel = normal(geliefert);
  for (const [wort, einheitswort] of Object.entries(synonyme)) {
    if (normal(wort) === schluessel) return einheitswort;
  }
  return geliefert;
};

/**
 * U1–U3 — der gelieferte Betrag wird auf die Einheit der Bezugsgröße gebracht.
 *
 * Keine gelieferte Einheit heißt: die Einheit der Bezugsgröße gilt (U3). Eine
 * Einheit außerhalb des Vokabulars der ZIEL-Größe ist `einheit_unbekannt` (U2)
 * — es wird nie ein Faktor geraten und nie über Größen hinweg gerechnet. Eine
 * Einheit derselben Größe OHNE Eintrag in `umrechnung` ist keine Umrechnung,
 * sondern eine Annahme, und wird genauso abgelehnt. `synonyme` sind die der
 * Zuordnungs-Vorlage; eine Vorlage kann das Vokabular nicht erweitern.
 */
export const einheit = (
  betrag: Dez | null,
  geliefert: string | null,
  ziel: string,
  einheiten: Record<string, string[]>,
  umrechnungen: Umrechnung[],
  synonyme?: Record<string, string>,
): Einheitswert => {
  const wort = synonym(geliefert, synonyme);
  if (wort === null || wort === ziel) return { betrag, einheit: ziel, befunde: [] };
  const groesse = groesseVon(ziel, einheiten);
  if (!groesse || !einheiten[groesse].includes(wort)) {
    return { betrag: null, einheit: ziel, befunde: [EINHEIT_UNBEKANNT] };
  }
  for (const u of umrechnungen) {
    const hin = u.von === wort && u.nach === ziel;
    const zurueck = u.von === ziel && u.nach === wort;
    if (!hin && !zurueck) continue;
    if (betrag === null) return { betrag: null, einheit: ziel, befunde: [EINHEIT_UMGERECHNET] };
    if (u.zehnerpotenz !== undefined) {
      return {
        betrag: dezSkaliere(betrag, hin ? u.zehnerpotenz : -u.zehnerpotenz),
        einheit: ziel,
        befunde: [EINHEIT_UMGERECHNET],
      };
    }
    const teiler = u.teiler ?? 1;
    return {
      betrag: hin
        ? dezTeile(betrag, teiler, u.nachkommastellen ?? 0)
        : { z: betrag.z * BigInt(teiler), e: betrag.e },
      einheit: ziel,
      befunde: [EINHEIT_UMGERECHNET],
    };
  }
  return { betrag: null, einheit: ziel, befunde: [EINHEIT_UNBEKANNT] };
};

/** U5 — nimmt diese Einheit Nachkommastellen an? Stück, Personen und Schichten tun es nicht. */
export const istGanzzahlig = (einheitswort: string): boolean => GANZZAHL_EINHEITEN.includes(einheitswort);

/** Der Kundensatz eines Befunds dieses Moduls — die Fläche erfindet keinen zweiten. */
export const satz = (befund: string): string => {
  const text = SAETZE[befund];
  if (!text) throw new Error(`kein Kundensatz für ${befund}`);
  return text;
};
