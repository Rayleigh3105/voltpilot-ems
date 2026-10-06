import type { MessstelleRegisterZeile, MessstellenRegister } from './api';
import { zuordnung } from './bezugsdaten';
import { UEMS_ABLESEN } from './glossar';
import { abzulesen, standZahl } from './messstellenListe';
import { lokalerTag } from './uemsOrtsbaum';
import { betrag, wertFehler, zaehltSatz } from './werteEingabe';
import { zahlText } from './zahl';

/**
 * DIE ABLESE-RUNDE je Gebäude (Konzept Messen m1, §6.5 Variante 3A, Entscheid 11): „Halle 1 ablesen · 8 Zähler“, ein
 * Zeitpunkt für alle, je Zähler der letzte Stand und ein Feld; „Weiter“ speichert und springt zum nächsten. Gleiche Route
 * (`POST …/ablesungen`), gleiche Rechte (`ablesung.erfassen`), gleiche Prüfung wie „Ablesung eintragen“ - neu ist nur
 * die Fläche.
 *
 * Rein und deterministisch: welche Zähler zur Runde gehören (die Ablesezähler eines Orts, wie die Wiedervorlage sie als
 * „8 Zähler in Halle 1 ablesen“ bündelt), was jede Reihe sagt und was vor dem Senden geprüft wird. Der Monat, zu dem eine
 * Ablesung zählt, kommt aus demselben Zwilling wie im Dialog (`bezugsdaten.zuordnung`): die Vorgabe mit dem größten
 * Anteil; reicht der Zeitraum über drei oder mehr Monate, entscheidet der Kunde an der Messstelle.
 */

/** Der Adress-Parameter der Runde: `#/portfolio/messstellen?ablesen=G-1` (das Kurzzeichen des Orts). */
export const ABLESEN_PARAMETER = 'ablesen';
export const ABLESEN = UEMS_ABLESEN;
export const FERTIG = 'Fertig';

export interface RundeZaehler {
  id: string;
  kennzeichen: string;
  name: string;
  einheit: string;
  /** Die letzte wirksame Ablesung laut Register; `null` = noch keine (dann gibt es keinen Vergleich). */
  zuletzt: { stand: number; zeitpunkt: string } | null;
}

export interface Runde {
  /** Das Kurzzeichen des Orts (`G-1`). */
  ort: string;
  /** „Halle 1“ */
  ortName: string;
  standortName: string | null;
  standortId: string | null;
  zaehler: RundeZaehler[];
  /** Der Tag der jüngsten Ablesung der Runde (`JJJJ-MM-TT`); `null` = noch keine. */
  zuletztAm: string | null;
}

const nachZiffern = (a: string, b: string) => a.localeCompare(b, 'de-DE', { numeric: true });

/**
 * Die Runde eines Orts aus dem Register: die Ablesezähler, die an ihm oder darunter stehen (`ort.pfad` beginnt mit dem
 * Ort selbst), im Ort der Hauptzähler zuerst, dann nach Kennzeichen - wie die Liste. `null`, wenn der Ort keinen hat.
 */
export function rundeAus(register: MessstellenRegister, ort: string, zone: string): Runde | null {
  const zeilen = register.register.filter((z) => z.ort.pfad.includes(ort) && abzulesen(z));
  if (zeilen.length === 0) return null;
  const hauptzaehler = (z: MessstelleRegisterZeile) => z.elektrische_stellung?.stellung === 'Hauptzähler';
  const sortiert = [...zeilen].sort((a, b) =>
    hauptzaehler(a) !== hauptzaehler(b) ? (hauptzaehler(a) ? -1 : 1) : nachZiffern(a.kennzeichen, b.kennzeichen),
  );
  const amOrt = zeilen.find((z) => z.ort.kennzeichen === ort);
  const zaehler = sortiert.map((z): RundeZaehler => {
    const lw = z.letzter_wert;
    return {
      id: z.id,
      kennzeichen: z.kennzeichen,
      name: z.name ?? z.kennzeichen,
      einheit: z.hauptgroesse?.einheit ?? lw?.einheit ?? '',
      zuletzt: lw && lw.wert !== null ? { stand: lw.wert, zeitpunkt: lw.zeitpunkt } : null,
    };
  });
  const tage = zaehler.flatMap((z) => (z.zuletzt ? [lokalerTag(z.zuletzt.zeitpunkt, zone)] : [])).sort();
  return {
    ort,
    ortName: amOrt?.ort.name ?? ort,
    standortName: zeilen[0].ort.standort_name,
    standortId: zeilen[0].ort.standort_id,
    zaehler,
    zuletztAm: tage.length ? tage[tage.length - 1] : null,
  };
}

const tagText = (tag: string) => tag.split('-').reverse().join('.');

/** „Halle 1 ablesen“ */
export const rundenTitel = (r: Runde): string => `${r.ortName} ablesen`;

/** „8 Zähler · Werk Ahrenberg · zuletzt abgelesen am 01.10.2026“ */
export function rundenUnter(r: Runde): string {
  return [
    `${r.zaehler.length} Zähler`,
    r.standortName,
    r.zuletztAm ? `zuletzt abgelesen am ${tagText(r.zuletztAm)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** „3 von 8“ (fett) und „eingetragen“ - der Fortschritt der Runde. */
export const fortschritt = (fertig: number, gesamt: number) => ({ zahl: `${fertig} von ${gesamt}`, wort: 'eingetragen' });

/**
 * „zuletzt 647.760 kWh“ - der letzte Stand zum Vergleich, mit seinem Tag nur, wenn er nicht der der Runde ist (der
 * steht schon im Kopf). Ohne Ablesung: „noch keine Ablesung“.
 */
export function zuletztText(z: RundeZaehler, r: Runde, zone: string): string {
  if (!z.zuletzt) return 'noch keine Ablesung';
  const tag = lokalerTag(z.zuletzt.zeitpunkt, zone);
  const stand = `zuletzt ${standZahl(z.zuletzt.stand, z.einheit)} ${z.einheit}`;
  return tag === r.zuletztAm ? stand : `${stand} am ${tagText(tag)}`;
}

/** „gespeichert · 216.300 kWh seit 01.10.“ - die Antwort des Servers mit der Menge des Zeitraums. */
export function gespeichertText(menge: number | null, einheit: string, seit: string | null, zone: string): string {
  if (menge === null || seit === null) return 'gespeichert';
  const [, m, t] = lokalerTag(seit, zone).split('-');
  return `gespeichert · ${betrag(menge)} ${einheit} seit ${t}.${m}.`;
}

/** Was vor dem Senden einer Reihe feststeht: der Körper der Anfrage - oder der Satz, der am Zähler stehen bleibt. */
export type Vorpruefung =
  | { art: 'senden'; stand: string; zuordnung_monat: string | null }
  | { art: 'satz'; satz: string };

/**
 * Die Prüfung vor dem Senden (dieselben Regeln wie der Dialog, `AblesungDialog.tsx`): eine Zahl in der Einheit; nach
 * der letzten Ablesung; der Monat aus dem Zwilling - reicht der Zeitraum über drei oder mehr Monate, gibt es keine
 * Vorgabe, und der Kunde wählt den Monat an der Messstelle. Was der Server prüft (Rücksprung, gleicher Zeitpunkt),
 * sagt seine Antwort.
 */
export function vorpruefung(z: RundeZaehler, text: string, zeitpunkt: string, zone: string): Vorpruefung {
  const fehler = wertFehler(text, z.einheit);
  if (fehler) return { art: 'satz', satz: fehler };
  const stand = zahlText(text)!;
  if (!z.zuletzt) return { art: 'senden', stand, zuordnung_monat: null };
  const von = Date.parse(z.zuletzt.zeitpunkt);
  const bis = Date.parse(zeitpunkt);
  if (!(bis > von)) {
    return {
      art: 'satz',
      satz: `Liegt nicht nach der letzten Ablesung (${tagText(lokalerTag(z.zuletzt.zeitpunkt, zone))}) - eine frühere Ablesung tragen Sie an der Messstelle ein.`,
    };
  }
  const zu = zuordnung(von, bis, zone);
  if (!zu.vorgabe) {
    return {
      art: 'satz',
      satz: 'Der Zeitraum seit der letzten Ablesung reicht über drei oder mehr Monate - tragen Sie diese Ablesung an der Messstelle ein und wählen Sie dort den Monat.',
    };
  }
  return { art: 'senden', stand, zuordnung_monat: zu.vorgabe };
}

/**
 * Der Satz unter „Abgelesen am“: zu welchem Monat die Ablesungen zählen, wenn alle Zähler denselben letzten Tag haben
 * („Zählt zum Oktober 2026 – dem Zeitraum seit der letzten Ablesung am 01.10.“); sonst keiner (je Zähler verschieden).
 */
export function rundeZaehltSatz(r: Runde, zeitpunkt: string | null, zone: string): string | null {
  if (!zeitpunkt) return null;
  const letzte = r.zaehler.map((z) => z.zuletzt?.zeitpunkt ?? null);
  if (letzte.some((l) => l === null) || new Set(letzte).size !== 1) return null;
  const von = Date.parse(letzte[0]!);
  const bis = Date.parse(zeitpunkt);
  if (!(bis > von)) return null;
  const zu = zuordnung(von, bis, zone);
  return zu.vorgabe ? zaehltSatz(zu.vorgabe, letzte[0], zone) : null;
}
