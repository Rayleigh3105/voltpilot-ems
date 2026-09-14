import type { Ort, OrtFehler, OrtFlaeche, OrtFlaechenStand } from './api';
import { flaecheZahl } from './ortsbaum';
import {
  datumText,
  FLAECHE_SATZ,
  m2Text,
  mitternacht,
  plusTage,
  rueckwirkung,
  tageZwischen,
  type Tag,
} from './uemsOrtsbaum';

/**
 * „Fläche ändern“ mit „gültig ab“ und dem Flächen-Verlauf (UEMS AP-02 IP-8,
 * Mockup T7, E2/E3) — die reine Hälfte des `FlaecheDialog`.
 *
 * Geschrieben wird über den Weg aus IP-5 (`PUT /api/v1/orte/{id}/flaeche`); es
 * gibt keinen Lese-Weg für die Flächen-Intervalle eines Orts. Darum:
 * - VOR dem Speichern steht die Fläche, die heute gilt (aus dem Ortsbaum), und
 *   was das gewählte „gültig ab“ bedeutet — `rueckwirkung` AUFGERUFEN, am
 *   Eintragstag heute in der Zeitzone des Standorts. Wie lange die neue Fläche
 *   gilt, weiß erst der Server (eine spätere Fläche beendet sie).
 * - NACH dem Speichern steht der Verlauf aus der Antwort (`Ort.flaechen`, alle
 *   wirksamen Intervalle), die neue Zeile mit dem Abzeichen des Servers, und die
 *   Folgen mit den Tagen, die wirklich nachträglich anders gelten.
 *
 * ⚠ „Kein freigegebener Bericht ist betroffen“ (T7) sagt der Dialog NICHT —
 * freigegebene Berichte gibt es erst mit AP-12; geraten wird es nicht.
 */

export const FLAECHE_AENDERN_TITEL = 'Fläche ändern';
export const FLAECHE_GESPEICHERT_TITEL = 'Fläche gespeichert';
export const KNOPF_FLAECHE_AENDERN = 'Fläche ändern';
export const KNOPF_FLAECHE_SPEICHERN = 'Fläche speichern';
export const KNOPF_FERTIG = 'Fertig';
export const VERLAUF_TITEL = 'Verlauf der Fläche';

/** T7, wörtlich. */
export const FLAECHE_VORSPANN = 'Kennzahlen je Monat rechnen mit der damals gültigen Fläche.';
export const SATZ_GUELTIG_AB_FEHLT = 'Bitte wählen Sie den Tag, ab dem die Fläche gilt.';

/** „Bezugsfläche Halle 2 (G-2)“ */
export function flaecheKopf(name: string, kurzzeichen: string | null): string {
  return `Bezugsfläche ${name}${kurzzeichen ? ` (${kurzzeichen})` : ''}`;
}

/** Die Fläche, die heute gilt — eine fehlende ist keine 0. */
export function heuteSatz(m2: number | null): string {
  return m2 == null ? 'Heute ist keine Fläche eingetragen.' : `Heute gilt: ${m2Text(m2)}`;
}

export interface FlaecheFormular {
  flaeche: string;
  gueltigAb: string;
}

export type FlaecheFeld = keyof FlaecheFormular;
export type FlaecheFehler = Partial<Record<FlaecheFeld, string>>;

/** Vorbelegt: heute in der Zeitzone des Standorts — der Tag, den der Server ohne Angabe nähme. */
export function leeresFlaecheFormular(heute: Tag): FlaecheFormular {
  return { flaeche: '', gueltigAb: heute };
}

/** Vor dem Senden, mit den Sätzen des Servers. In der Reihenfolge der Felder. */
export function flaechePruefen(f: FlaecheFormular): FlaecheFehler {
  const fehler: FlaecheFehler = {};
  if (flaecheZahl(f.flaeche) == null) fehler.flaeche = FLAECHE_SATZ;
  if (!f.gueltigAb) fehler.gueltigAb = SATZ_GUELTIG_AB_FEHLT;
  return fehler;
}

export function flaecheAnfrage(f: FlaecheFormular): OrtFlaeche | null {
  const m2 = flaecheZahl(f.flaeche);
  return m2 == null || !f.gueltigAb ? null : { m2, gueltigAb: f.gueltigAb };
}

/**
 * Das Feld zu einer Ablehnung von `PUT …/flaeche`: die Zahl (`flaeche_ungueltig`,
 * `gleiche_flaeche`) oder der Tag (`gab_es_noch_nicht`, `archiviert` — beide
 * sagen „an diesem Tag nicht“). Sonst steht der Satz über dem Fuß.
 */
export function flaecheFeldAusServer(fehler: OrtFehler): FlaecheFeld | null {
  if (fehler.code === 'flaeche_ungueltig' || fehler.code === 'gleiche_flaeche') return 'flaeche';
  if (fehler.code === 'gab_es_noch_nicht' || fehler.code === 'archiviert') return 'gueltigAb';
  if (fehler.feld === 'm2') return 'flaeche';
  if (fehler.feld === 'gueltigAb') return 'gueltigAb';
  return null;
}

export interface Folgen {
  titel: string;
  saetze: string[];
}

function tage(n: number): string {
  return `${n} ${n === 1 ? 'Tag' : 'Tage'}`;
}

/** Die Rückwirkung am Eintragstag HEUTE in der Zeitzone des Standorts — dieselbe Regel wie der Server. */
function heuteEingetragen(giltAb: Tag, giltBis: Tag | null, heute: Tag, zeitzone: string) {
  return rueckwirkung({ eingetragenUm: mitternacht(heute, zeitzone).iso, giltAb, giltBis, zeitzone });
}

function folgenTitel(art: 'rueckwirkend' | 'ab_heute' | 'geplant', n: number, giltAb: Tag): string {
  if (art === 'rueckwirkend') return `Rückwirkend um ${tage(n)}`;
  if (art === 'ab_heute') return 'Ab heute';
  return `Geplant ab ${datumText(giltAb)}`;
}

/** VOR dem Speichern: was „gültig ab“ bedeutet. `null`, solange Zahl oder Tag fehlen. */
export function folgenVorher(f: FlaecheFormular, heute: Tag, zeitzone: string): Folgen | null {
  const m2 = flaecheZahl(f.flaeche);
  if (m2 == null || !f.gueltigAb) return null;
  const ab = f.gueltigAb;
  const r = heuteEingetragen(ab, null, heute, zeitzone);
  const titel = folgenTitel(r.art, r.tage, ab);
  if (r.art === 'rueckwirkend') {
    return {
      titel,
      saetze: [
        `Heute ist der ${datumText(heute)}.`,
        `Ab dem ${datumText(ab)} rechnen Kennzahlen in kWh/m² mit ${m2Text(m2)} — auch für Tage, die schon vorbei sind.`,
        'Was davor galt, bleibt.',
      ],
    };
  }
  if (r.art === 'ab_heute') {
    return {
      titel,
      saetze: [`Ab heute rechnen Kennzahlen in kWh/m² mit ${m2Text(m2)}.`, 'Was davor galt, bleibt.'],
    };
  }
  return {
    titel,
    saetze: [
      `Bis zum ${datumText(plusTage(ab, -1))} bleibt die Fläche, wie sie ist.`,
      `Ab dem ${datumText(ab)} rechnen Kennzahlen in kWh/m² mit ${m2Text(m2)}.`,
    ],
  };
}

function nachBeginn(flaechen: OrtFlaechenStand[]): OrtFlaechenStand[] {
  return [...flaechen].sort((x, y) => (x.gueltigAb < y.gueltigAb ? -1 : x.gueltigAb > y.gueltigAb ? 1 : 0));
}

export interface VerlaufZeile {
  schluessel: string;
  /** „3 400 m²“ */
  flaeche: string;
  /** „gültig 01.10.2026 bis 31.12.2026“ · „gültig ab 01.01.2027 (neu)“ */
  zeitraum: string;
  neu: boolean;
  /** „rückwirkend (14 Tage)“ (das Abzeichen des Servers) · „geplant“ · `null` */
  kennzeichen: string | null;
  zustand: OrtFlaechenStand['zustand'];
}

/** NACH dem Speichern: jede wirksame Fläche des Orts, die neue gekennzeichnet (T7 „Bisheriger Verlauf“). */
export function verlauf(ort: Ort, giltAb: Tag): VerlaufZeile[] {
  return nachBeginn(ort.flaechen).map((f) => {
    const neu = f.gueltigAb === giltAb;
    const zeitraum =
      f.gueltigBis == null
        ? `gültig ab ${datumText(f.gueltigAb)}`
        : `gültig ${datumText(f.gueltigAb)} bis ${datumText(f.gueltigBis)}`;
    const abzeichen = neu ? (ort.rueckwirkung?.abzeichen ?? null) : null;
    return {
      schluessel: f.gueltigAb,
      flaeche: m2Text(f.m2),
      zeitraum: neu ? `${zeitraum} (neu)` : zeitraum,
      neu,
      kennzeichen: abzeichen ?? (f.zustand === 'geplant' ? 'geplant' : null),
      zustand: f.zustand,
    };
  });
}

/** NACH dem Speichern: die Folgen mit dem Ende, das der Server der neuen Fläche gab. */
export function folgenNachher(ort: Ort, giltAb: Tag, heute: Tag, zeitzone: string): Folgen | null {
  const liste = nachBeginn(ort.flaechen);
  const neu = liste.find((f) => f.gueltigAb === giltAb);
  if (!neu) return null;
  const vortag = plusTage(giltAb, -1);
  const davor = liste.find((f) => f.gueltigBis === vortag) ?? null;
  const r = heuteEingetragen(giltAb, neu.gueltigBis, heute, zeitzone);
  const saetze: string[] = [];
  if (r.art === 'rueckwirkend') saetze.push(`Heute ist der ${datumText(heute)}.`);
  const zeitraum =
    neu.gueltigBis == null
      ? `ab dem ${datumText(giltAb)}`
      : `vom ${datumText(giltAb)} bis zum ${datumText(neu.gueltigBis)}`;
  saetze.push(
    `Kennzahlen in kWh/m² rechnen ${zeitraum} mit ${m2Text(neu.m2)}` +
      (davor ? `; bis zum ${datumText(vortag)} bleibt es bei ${m2Text(davor.m2)}.` : '.'),
  );
  if (liste.every((f) => f.gueltigAb >= giltAb)) {
    saetze.push(`Vor dem ${datumText(giltAb)} ist keine Fläche eingetragen.`);
  }
  const b = r.rueckwirkendBetroffen;
  if (b) {
    const n = tageZwischen(b.von, b.bis) + 1;
    saetze.push(
      n === 1
        ? `Für den ${datumText(b.von)} gilt die neue Fläche nachträglich.`
        : `Für die ${tage(n)} vom ${datumText(b.von)} bis ${datumText(b.bis)} gilt die neue Fläche nachträglich.`,
    );
  }
  return { titel: folgenTitel(r.art, r.tage, giltAb), saetze };
}
