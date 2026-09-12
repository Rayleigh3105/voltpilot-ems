/**
 * Die REINEN Regeln der Bezugsdaten im Portal (UEMS AP-09 §4) — die Hälfte, die
 * die VORSCHAU braucht: aus einer gelieferten Zeile wird ein Betrag, eine
 * Periode, ein Zeitpunkt, ein Urteil — oder ein Befund.
 *
 * Der Vertrag und die Wahrheit stehen in `docs/contracts/v2/bezugsdaten-vectors.json`
 * (Prosa `bezugsdaten.md`, Schema `bezugsdaten.schema.json`); der Java-Zwilling
 * ist `services/api .../uems/BezugsdatenRegeln`. Beide Tests fahren DIESELBE
 * Datei per Pfad. Wer eine Regel ändert, ändert die Datei UND beide Zwillinge.
 *
 * `zwillinge` in der Datei sagt je Regel, wer sie prüft. Vier Regeln haben hier
 * bewusst keinen Zwilling und nennen dort ihren Grund: die Fassungen, der
 * Stichtag eines Stammdatums und die Zustandsdauer eines Kanals sind
 * Serverseite, und die Menge eines Ablesezeitraums rechnet die Verbrauchsregel
 * AP-08 — das Portal zeigt die Zahl, es bildet sie nicht.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr — „jetzt" wird übergeben. Jeder
 * Betrag reist als Dezimaltext und wird als ganzzahlige Mantisse gerechnet
 * (`Dez` aus `dez.ts`), damit keine Rechnung einen Binärbruch-Fehler erbt:
 * `0.1 + 0.2` ist hier nicht `0.30000000000000004`, und `312,4 t` sind genau
 * `312400 kg`.
 *
 * Seit AP-09 IP-3 rechnet diese Datei die Einheiten und die Perioden NICHT
 * mehr selbst: `bezugsEinheit.ts` (Vokabular je Größe, feste Faktoren,
 * Synonyme) und `bezugsPeriode.ts` (Deutung der Datumsspalte, Zeitzone des
 * Standorts, 23-/25-Stunden-Tage) sind eigene Module, weil Import, Eingabe,
 * Kennzahlen und Berichte sie alle brauchen. Diese Datei reicht sie weiter —
 * eine Fassung, ein Einstieg.
 *
 * Wer anruft (Stand AP-09 IP-3): niemand. Die Flächen kommen mit IP-9 … IP-16.
 */

import { dez, dezGleich, dezProzent, dezVergleich, dezVon, type Dez } from './dez';
import { mitternacht, monatsschluessel, ortsteile, zwei } from './bezugsPeriode';

// ------------------------------------------------------------------ Schwellen (Vertrag)

/** E7: die Zeitzone des Standorts; sie wird je Bezugsgröße übergeben. */
export const ANZEIGE_ZEITZONE = 'Europe/Berlin';

/** F2: eine Berichtigung ohne ausreichende Begründung wird nicht wirksam. */
export const BEGRUENDUNG_MIN_ZEICHEN = 10;

export const BEGRUENDUNG_MAX_ZEICHEN = 500;

/** Z6/E5: bis zu so vielen berührten Kalendermonaten gibt es eine Vorgabe. */
export const ZUORDNUNG_HOECHSTENS_MONATE = 2;

export const ANTEIL_NACHKOMMASTELLEN = 1;

/** K: die Abdeckung eines Kanal-Werts ist ZEITBASIERT — nicht die wertbasierte aus AP-08. */
export const ABDECKUNG_NACHKOMMASTELLEN = 1;

export const VERGLEICH_NACHKOMMASTELLEN = 4;

/** F3/E6: das Vier-Augen-Prinzip folgt der Einstellung des Unternehmens und ist per Vorgabe AUS. */
export const VIER_AUGEN_VORGABE = false;

export const ZAHLFORMAT_VORGABE = 'de';

/** C8: die Befunde, die eine Zeile NICHT verhindern. Alle anderen tun es. */
export const HINWEIS_BEFUNDE = ['datei_bekannt', 'einheit_umgerechnet', 'wert_unplausibel'];

const istHinweis = (befund: string): boolean => HINWEIS_BEFUNDE.includes(befund);

// ------------------------------------------- Die drei Module, aus denen diese Datei besteht

// Seit AP-09 IP-3 wohnen die exakte Dezimalrechnung, die Einheiten und die
// Perioden in eigenen, wiederverwendbaren Modulen — Import, Eingabe,
// Kennzahlen und Berichte brauchen sie alle. Diese Datei RUFT sie an und reicht
// sie weiter; es gibt keine zweite Fassung.

export {
  dez,
  dezGleich,
  dezProzent,
  dezRunde,
  dezSkaliere,
  dezTeile,
  dezText,
  dezVergleich,
  dezVon,
  type Dez,
} from './dez';

export {
  EINHEIT_UMGERECHNET,
  EINHEIT_UNBEKANNT,
  GANZZAHL_EINHEITEN,
  einheit,
  groesseVon,
  istGanzzahlig,
  synonym,
  type Einheitswert,
  type Umrechnung,
} from './bezugsEinheit';

export {
  DATUM_UNLESBAR,
  PERIODE_NICHT_ZU_ENDE,
  PERIODE_PASST_NICHT,
  ZEIT_MEHRDEUTIG,
  ZEIT_NICHT_VORHANDEN,
  iso,
  mitternacht,
  offsetMinuten,
  periode,
  schluesselVon,
  spanneVon,
  stundenDesTages,
  tagText,
  zeitpunkt,
  zeitpunkteVon,
  type Periodendeutung,
  type Periodeneingang,
  type Zeitdeutung,
} from './bezugsPeriode';

// ------------------------------------------------------------------- U4/U5 — die Zahl

export type Zahl = { betrag: Dez | null; befund: string | null };

const dezimalzeichen = (s: string, format: string): string => {
  if (format === 'de') return ',';
  if (format === 'en') return '.';
  return s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
};

/**
 * U4/U5 — der Zahlentext einer Wertspalte wird ein Betrag.
 *
 * `format` ist `de` (Punkt = Tausender, Komma = Dezimal), `en` (umgekehrt) oder
 * `auto` (das letzte Trennzeichen ist das Dezimaltrennzeichen). Leerzeichen —
 * auch geschützte und schmale — sind immer Tausendertrenner. Eine
 * Tausendergruppe hat GENAU drei Stellen; alles andere ist `zahl_unlesbar`, nie
 * eine geratene Deutung. `ganzzahlig` gilt für Stück, Personen und Schichten
 * (U5): ein Dezimaltrennzeichen macht die Zahl unlesbar.
 */
export const zahl = (text: string | null, format: string, ganzzahlig: boolean): Zahl => {
  if (!text || !text.trim()) return { betrag: null, befund: 'zahl_unlesbar' };
  let s = text.replace(/[   ]/g, '').trim();
  const negativ = s.startsWith('-');
  if (negativ || s.startsWith('+')) s = s.slice(1);
  if (!/^[0-9.,]+$/.test(s)) return { betrag: null, befund: 'zahl_unlesbar' };

  const dezimal = dezimalzeichen(s, format);
  const tausender = dezimal === ',' ? '.' : ',';
  const trenner = s.lastIndexOf(dezimal);
  const ganz = trenner < 0 ? s : s.slice(0, trenner);
  const bruch = trenner < 0 ? '' : s.slice(trenner + 1);
  if (trenner >= 0 && (bruch === '' || bruch.includes(dezimal) || bruch.includes(tausender))) {
    return { betrag: null, befund: 'zahl_unlesbar' };
  }
  if (trenner >= 0 && ganzzahlig) return { betrag: null, befund: 'zahl_unlesbar' };

  const gruppen = ganz.split(tausender);
  if (gruppen[0] === '' || gruppen[0].length > 3) return { betrag: null, befund: 'zahl_unlesbar' };
  for (let i = 1; i < gruppen.length; i += 1) {
    if (gruppen[i].length !== 3) return { betrag: null, befund: 'zahl_unlesbar' };
  }
  const roh = gruppen.join('') + (bruch === '' ? '' : `.${bruch}`);
  if (!/^[0-9]+([.][0-9]+)?$/.test(roh)) return { betrag: null, befund: 'zahl_unlesbar' };
  return { betrag: dez(`${negativ ? '-' : ''}${roh}`), befund: null };
};

// -------------------------------------------------------------- U6 — Plausibilität

/**
 * U6 — ein Betrag unter null wird abgelehnt; eine Betriebszeit über der
 * Stundenzahl der Periode ist ein HINWEIS, kein Fehler.
 *
 * Die Obergrenze ist die Stundenzahl der Periode × Anzahl der gebundenen
 * Einheiten — am Umstellungstag also 23 oder 25 Stunden, nie 24.
 */
export const plausibilitaet = (
  betrag: Dez | null,
  einheitswort: string,
  stundenDesTagesWert: number | null,
  einheitenGebunden: number,
): string | null => {
  if (betrag === null) return null;
  if (betrag.z < 0n) return 'wert_negativ';
  if (stundenDesTagesWert === null) return null;
  if (einheitswort !== 'h' && einheitswort !== 'min') return null;
  const faktor = einheitswort === 'min' ? 60 : 1;
  const grenze = dezVon(stundenDesTagesWert * einheitenGebunden * faktor);
  return dezVergleich(betrag, grenze) > 0 ? 'wert_unplausibel' : null;
};

// ------------------------------------------------------------- Z6 — die Zuordnung

export type Anteil = { monat: string; minuten: number; prozent: Dez };

export type Zuordnung = {
  dauerMinuten: number;
  dauerText: string;
  monateBeruehrt: number;
  anteile: Anteil[];
  vorgabe: string | null;
};

/** „32 Tage 1 h 25 min" — die Länge eines Ablesezeitraums als Kundensatz. */
export const dauerText = (minutenGesamt: number): string => {
  const tage = Math.floor(minutenGesamt / 1440);
  const rest = minutenGesamt % 1440;
  const teile: string[] = [];
  if (tage > 0) teile.push(`${tage} Tage`);
  if (Math.floor(rest / 60) > 0) teile.push(`${Math.floor(rest / 60)} h`);
  if (rest % 60 > 0) teile.push(`${rest % 60} min`);
  return teile.join(' ');
};

/**
 * Z6/E5 — ein Ablesezeitraum und die Kalendermonate, die er berührt.
 *
 * Vorgabe ist der Monat mit dem größten zeitlichen Anteil, solange der Zeitraum
 * höchstens `ZUORDNUNG_HOECHSTENS_MONATE` Monate berührt; sonst gibt es keine
 * Vorgabe und nur der Kunde entscheidet. Die Vorgabe entscheidet über die
 * MINUTEN, nicht über den gerundeten Prozentsatz. Nichts wird geteilt — die
 * Zuordnung ist ein Kennzeichen, keine Rechnung.
 */
export const zuordnung = (von: number, bis: number, zone: string): Zuordnung => {
  const gesamt = Math.floor((bis - von) / 60000);
  const anteile: Anteil[] = [];
  let lauf = von;
  while (lauf < bis) {
    const teile = ortsteile(lauf, zone);
    const naechsterErster =
      teile.monat === 12
        ? `${teile.jahr + 1}-01-01`
        : `${teile.jahr}-${zwei(teile.monat + 1)}-01`;
    const grenze = mitternacht(naechsterErster, zone);
    const schnitt = Math.min(grenze, bis);
    const minuten = Math.floor((schnitt - lauf) / 60000);
    anteile.push({
      monat: monatsschluessel(teile.jahr, teile.monat),
      minuten,
      prozent: dezProzent(minuten, gesamt, ANTEIL_NACHKOMMASTELLEN),
    });
    lauf = schnitt;
  }
  let vorgabe: string | null = null;
  if (anteile.length <= ZUORDNUNG_HOECHSTENS_MONATE) {
    vorgabe = anteile.reduce((a, b) => (b.minuten > a.minuten ? b : a)).monat;
  }
  return { dauerMinuten: gesamt, dauerText: dauerText(gesamt), monateBeruehrt: anteile.length, anteile, vorgabe };
};

// ---------------------------------------------------------------- C5 — das Urteil

export type Bestand = { betrag: Dez | null; fassung: number; importKennung: string | null };

export type Urteil = { urteil: string; befunde: string[] };

export type Urteilseingang = {
  betrag: Dez | null;
  bestand: Bestand | null;
  dateiFingerabdruckBekannt: boolean;
  fruehererImportStatus: string | null;
  entscheidung: string | null;
  befundeVorher: string[];
};

/**
 * C5 und §4.7 — das Urteil einer Zeile.
 *
 * Zuerst gewinnt ein Befund, der die Zeile verhindert: `abgelehnt`. Dann kommt
 * der Datei-Befund dazu (`datei_bekannt` ist ein HINWEIS und verhindert
 * nichts). Ein unbelegter Schlüssel — auch nach einer Rücknahme, denn dann hat
 * der wirksame Stand keinen Betrag — ist `neu`. Derselbe Betrag ist eine
 * `wiederholung` und schreibt nichts; ein anderer Betrag ist ein `konflikt`,
 * der eine Entscheidung braucht, und wird NIE still ersetzt (E9).
 */
export const urteil = (eingang: Urteilseingang): Urteil => {
  const befunde: string[] = [];
  if (eingang.dateiFingerabdruckBekannt && eingang.fruehererImportStatus !== null) {
    befunde.push('datei_bekannt');
  }
  befunde.push(...eingang.befundeVorher);
  if (befunde.some((b) => !istHinweis(b))) return { urteil: 'abgelehnt', befunde };
  const bestand = eingang.bestand;
  if (!bestand || bestand.betrag === null) return { urteil: 'neu', befunde };
  if (eingang.betrag !== null && dezGleich(bestand.betrag, eingang.betrag, VERGLEICH_NACHKOMMASTELLEN)) {
    return { urteil: 'wiederholung', befunde };
  }
  befunde.push('konflikt_anderer_wert');
  if (eingang.entscheidung === 'ersetzen') return { urteil: 'berichtigung', befunde };
  if (eingang.entscheidung === 'behalten') return { urteil: 'uebersprungen', befunde };
  return { urteil: 'konflikt', befunde };
};

// ------------------------------------------------------------- C4/C6 — der Import

export type Zaehler = {
  zeilen: number;
  neu: number;
  wiederholung: number;
  konflikt: number;
  berichtigung: number;
  uebersprungen: number;
  abgelehnt: number;
  mitHinweis: number;
};

export type Importergebnis = {
  status: string | null;
  zaehler: Zaehler;
  uebernahmeMoeglich: boolean;
  importDatensatz: boolean;
  bestaetigung: string | null;
  aenderungen: number;
  befunde: string[];
};

export type Zeilenurteil = { urteil: string; befunde: string[] };

/**
 * C4/C6 — was die Vorschau sagt und was die Übernahme täte.
 *
 * Eine Datei ohne Datenzeilen hat keine Übernahme und schreibt nichts, auch
 * keinen Import-Datensatz. Geschrieben werden nur Zeilen mit dem Urteil `neu`
 * oder `berichtigung` — deshalb ist eine doppelt importierte Datei
 * 0 Änderungen. Werden nicht alle Zeilen übernommen, verlangt E10 eine
 * ausdrückliche Bestätigung mit der Zahl.
 */
export const importErgebnis = (
  datenzeilen: number,
  fingerabdruckBekannt: boolean,
  fruehererImportStatus: string | null,
  zeilen: Zeilenurteil[],
): Importergebnis => {
  const leer: Zaehler = {
    zeilen: 0,
    neu: 0,
    wiederholung: 0,
    konflikt: 0,
    berichtigung: 0,
    uebersprungen: 0,
    abgelehnt: 0,
    mitHinweis: 0,
  };
  if (datenzeilen === 0) {
    return {
      status: null,
      zaehler: leer,
      uebernahmeMoeglich: false,
      importDatensatz: false,
      bestaetigung: null,
      aenderungen: 0,
      befunde: ['keine_datenzeilen'],
    };
  }
  const zaehler: Zaehler = { ...leer, zeilen: zeilen.length };
  for (const z of zeilen) {
    if (z.urteil === 'neu') zaehler.neu += 1;
    else if (z.urteil === 'wiederholung') zaehler.wiederholung += 1;
    else if (z.urteil === 'konflikt') zaehler.konflikt += 1;
    else if (z.urteil === 'berichtigung') zaehler.berichtigung += 1;
    else if (z.urteil === 'uebersprungen') zaehler.uebersprungen += 1;
    else zaehler.abgelehnt += 1;
    if (z.befunde.includes('konflikt_anderer_wert') && z.urteil !== 'konflikt') zaehler.konflikt += 1;
    if (z.befunde.some(istHinweis)) zaehler.mitHinweis += 1;
  }
  const aenderungen = zaehler.neu + zaehler.berichtigung;
  let status: string;
  if (zaehler.abgelehnt === zeilen.length) status = 'verworfen';
  else if (zaehler.abgelehnt > 0) status = 'teilweise_uebernommen';
  else if (aenderungen === 0) status = 'wiederholt';
  else status = 'uebernommen';
  return {
    status,
    zaehler,
    uebernahmeMoeglich: aenderungen > 0,
    importDatensatz: true,
    bestaetigung:
      aenderungen > 0 && aenderungen < zeilen.length
        ? `${aenderungen} von ${zeilen.length} Zeilen übernehmen`
        : null,
    aenderungen,
    befunde: fingerabdruckBekannt && fruehererImportStatus !== null ? ['datei_bekannt'] : [],
  };
};

/** Der Kundensatz eines Befunds aus dem Vertrag — das Portal erfindet keinen zweiten. */
export const satz = (befund: string, saetze: Record<string, string>): string => {
  const text = saetze[befund];
  if (!text) throw new Error(`kein Kundensatz für ${befund}`);
  return text;
};
