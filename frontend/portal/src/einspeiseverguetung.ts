/**
 * Die Karte „Einspeisevergütung" (Einstellungen › Strom & Geld) - rein, ohne
 * React. Was Sie je eingespeister Kilowattstunde bekommen, woher der Satz kommt
 * und wie Sie ihn selbst angeben.
 *
 * **Hier wird nichts gerechnet.** Satz, Herkunft und Zustand liefert der Server
 * (`GET /api/v1/sites/{id}/einspeiseverguetung`): der hergeleitete Satz kommt
 * aus demselben EEG-Satzplan wie Optimierer und Erlöse, die Herkunft aus
 * derselben Abfrage, mit der die Erlöse ihren Einspeise-Erlös beschriften. Die
 * Karte kann deshalb nie einen Satz nennen, mit dem nicht gerechnet wird. Dieses
 * Modul macht daraus nur Wörter - ein Satz je Zustand, nie eine erfundene Zahl:
 * ohne Grundlage steht „Ohne Angabe" da, keine Null.
 *
 * Die Angabe ist eine Ebene ÜBER der Herleitung: Sie ersetzt den Satz (und das
 * Ende nach 20 Jahren), § 51a EEG gilt weiter nach dem Inbetriebnahmedatum.
 * Regel und Vektoren: `docs/contracts/einspeiseverguetung-vectors.json`.
 */
import type { Einspeiseverguetung, EinspeiseverguetungZustand } from './api';
import { parsePremiumInput } from './fleet';
import { fmtNum } from './format';

/** Die Plausibilitätsgrenze des Servers: kein EEG-Satz lag je darüber. */
export const VERGUETUNG_MAX_CT = 100;

/** Das Wort der Zeile, wenn es keinen Satz gibt - nie eine stille Null (wie „Ohne Angabe" beim Stromtarif). */
export const OHNE_ANGABE = 'Ohne Angabe';

export const VERGUETUNG_EINGABE_FEHLER =
  'Bitte geben Sie Ihren Satz als Zahl in ct/kWh zwischen 0 und 100 an, z. B. 8,2.';

/** Wofür jemand einen eigenen Satz braucht - die drei Fälle des Auftrags. */
export const EIGENER_SATZ_BEISPIELE = 'z. B. bei Volleinspeisung, Altanlage oder Sondervertrag';

/**
 * Die Frage zu einem eigenen Satz, wenn das Inbetriebnahmedatum fehlt: davon
 * hängt § 51a EEG ab (ab dem 25.02.2025 keine Vergütung bei negativem
 * Börsenpreis). Ohne Antwort rechnete der Fahrplan den Satz still auch in
 * diesen Viertelstunden - deshalb ist sie Pflicht.
 */
export const STICHTAG_FRAGE = 'Wann ging Ihre Anlage in Betrieb?';
export const STICHTAG_WAHL = {
  vor: { label: 'vor dem 25.02.2025', hint: 'Die Vergütung gilt auch bei negativem Börsenpreis.' },
  ab: { label: 'am 25.02.2025 oder später', hint: 'Bei negativem Börsenpreis keine Vergütung (§ 51a EEG).' },
} as const;
export const STICHTAG_FEHLER =
  'Bitte wählen Sie, wann Ihre Anlage in Betrieb ging - davon hängt ab, ob es bei negativem Börsenpreis eine Vergütung gibt.';

/** „2025-06-01" → „01.06.2025" (ein Kalendertag, keine Uhrzeit). */
export function tagText(iso: string): string {
  return iso.slice(0, 10).split('-').reverse().join('.');
}

/** „7,94 ct/kWh" - Vergütungssätze tragen zwei Stellen (der BNetzA-Satz auch). */
export function satzText(ctKwh: number): string {
  return fmtNum(ctKwh, 'ct/kWh', 2);
}

/** Kann die Karte hier einen eigenen Satz annehmen? Genau dort, wo er auch wirkt. */
export function angabeMoeglich(zustand: EinspeiseverguetungZustand): boolean {
  return zustand !== 'netzladen' && zustand !== 'direktvermarktung';
}

/** Die Zeile in „Strom & Geld": Wert und eine kurze Herkunft darunter. */
export interface VerguetungZeile {
  wert: string;
  sub: string;
  /** Hervorgehoben, wenn etwas fehlt, das der Kunde nachtragen kann. */
  warn: boolean;
}

/**
 * Wert und Herkunft der Zeile - „7,94 ct/kWh · hergeleitet aus EEG,
 * Inbetriebnahme 01.06.2025" bzw. „12,50 ct/kWh · von Ihnen angegeben". Ohne
 * Grundlage „Ohne Angabe" (hervorgehoben), bei Direktvermarktung und Netzladen
 * der Börsenpreis mit seinem Grund.
 */
export function verguetungZeile(s: Einspeiseverguetung): VerguetungZeile {
  switch (s.zustand) {
    case 'angegeben':
      return { wert: wirksam(s), sub: 'von Ihnen angegeben', warn: false };
    case 'eeg':
      return { wert: wirksam(s), sub: herleitungHerkunft(s), warn: false };
    case 'eeg_abgelaufen':
      return {
        wert: 'Börsenpreis',
        sub: s.eegEndeAm ? `EEG-Vergütung endete am ${tagText(s.eegEndeAm)}` : 'EEG-Vergütung beendet',
        warn: false,
      };
    case 'ohne_angabe':
      return { wert: OHNE_ANGABE, sub: 'Vergütung nicht hinterlegt', warn: true };
    case 'netzladen':
      return { wert: 'Börsenpreis', sub: 'solange Netzladen erlaubt ist', warn: false };
    case 'direktvermarktung':
      return { wert: 'Börsenpreis + Marktprämie', sub: 'Direktvermarktung - kein fester Satz', warn: false };
  }
}

/** „hergeleitet aus EEG, Inbetriebnahme 01.06.2025". */
function herleitungHerkunft(s: Einspeiseverguetung): string {
  return s.inbetriebnahme
    ? `hergeleitet aus EEG, Inbetriebnahme ${tagText(s.inbetriebnahme)}`
    : 'hergeleitet aus EEG';
}

function wirksam(s: Einspeiseverguetung): string {
  return s.wirksamCtKwh == null ? OHNE_ANGABE : satzText(s.wirksamCtKwh);
}

/** Was das Blatt oben groß zeigt: der Satz, der gerade gilt, und woher er kommt. */
export interface GiltJetzt {
  wert: string;
  herkunft: string;
}

export function giltJetzt(s: Einspeiseverguetung): GiltJetzt {
  const z = verguetungZeile(s);
  return { wert: z.wert, herkunft: z.sub };
}

/**
 * Die Option „Aus dem EEG herleiten": was die Herleitung ergäbe - oder warum
 * sie nichts ergibt. Der Satz steht auch dann da, wenn gerade ein eigener Satz
 * gilt: so sieht der Kunde, worauf „zurücksetzen" ihn bringt.
 */
export function herleitungOption(s: Einspeiseverguetung): string {
  if (s.inbetriebnahme == null || s.hergeleitetCtKwh == null) {
    // Der Weg zum Datum („Anlage verknüpfen ›") steht unter der Wahl.
    return 'Ohne Inbetriebnahmedatum keine Herleitung - es gilt der Börsenpreis.';
  }
  const teile = [`Inbetriebnahme ${tagText(s.inbetriebnahme)}`];
  if (s.leistungKwp != null) teile.push(fmtNum(s.leistungKwp, 'kWp', 1));
  if (s.zustand === 'eeg_abgelaufen' && s.eegEndeAm) {
    return `${teile.join(', ')} · die EEG-Vergütung endete am ${tagText(s.eegEndeAm)}, seitdem gilt der Börsenpreis.`;
  }
  const bis = s.eegEndeAm ? ` · bis ${tagText(s.eegEndeAm)}` : '';
  return `${satzText(s.hergeleitetCtKwh)} · ${teile.join(', ')}${bis}`;
}

/**
 * Die Lage nach § 51a EEG als ein Satz, wenn das Inbetriebnahmedatum sie
 * festlegt - in BEIDE Richtungen, damit ein eigener Satz nie still in
 * Negativpreis-Viertelstunden zählt. Ohne Datum stellt das Blatt stattdessen
 * die Frage {@link STICHTAG_FRAGE}; null heißt hier: nichts festzustellen.
 */
export function negativpreisSatz(s: Einspeiseverguetung): string | null {
  if (s.inbetriebnahme == null) return null;
  if (s.ohneVerguetungBeiNegativpreis) {
    return 'Bei negativem Börsenpreis gibt es für Ihre Anlage keine Vergütung (§ 51a EEG) - das gilt auch für einen eigenen Satz.';
  }
  // Vor dem Stichtag gilt die Vergütung durchgehend - aber nur, solange es eine gibt.
  return s.zustand === 'eeg' || s.zustand === 'angegeben'
    ? 'Ihre Anlage ging vor dem 25.02.2025 in Betrieb: die Vergütung gilt auch bei negativem Börsenpreis.'
    : null;
}

/**
 * Kurze Hinweise unter der Wahl - je ein Satz, nur wenn er für DIESE Anlage
 * gilt: die Lage nach § 51a EEG ({@link negativpreisSatz}) und der
 * Näherungswert der Jahresstufen vor dem EEG 2023.
 */
export function verguetungHinweise(s: Einspeiseverguetung): string[] {
  const aus: string[] = [];
  const s51a = negativpreisSatz(s);
  if (s51a) aus.push(s51a);
  if (s.hergeleitetGenaehert && s.hergeleitetCtKwh != null) {
    aus.push(
      'Für Anlagen vor dem 30.07.2022 ist die Herleitung ein Näherungswert. Den genauen Satz finden Sie in der Abrechnung Ihres Netzbetreibers.',
    );
  }
  return aus;
}

/**
 * Die Erklärung, wenn die Karte NICHTS annimmt (Direktvermarktung, Netzladen) -
 * statt einen festen Satz vorzutäuschen. Null, wenn die Angabe möglich ist.
 */
export function ruhtErklaerung(s: Einspeiseverguetung): string | null {
  // „Gilt jetzt" nennt schon den Börsenpreis und warum - hier steht nur noch, woraus er besteht.
  if (s.zustand === 'direktvermarktung') {
    const aw =
      s.anzulegenderWertCtKwh != null
        ? `Ihrem anzulegenden Wert (${satzText(s.anzulegenderWertCtKwh)})`
        : 'Ihrem anzulegenden Wert - den tragen Sie unter „Anzulegender Wert" ein';
    return `Ihr Erlös ist der Börsenpreis, dazu kommt die Marktprämie aus ${aw}.`;
  }
  if (s.zustand === 'netzladen') {
    const ruht =
      s.angegebenCtKwh != null
        ? ` Ihr Satz von ${satzText(s.angegebenCtKwh)} gilt wieder, sobald Netzladen aus ist.`
        : '';
    return `Strom aus dem Netz darf nicht als EEG-Strom vergütet werden (Ausschließlichkeitsprinzip).${ruht}`;
  }
  return null;
}

/**
 * Die getippte Angabe: deutsches Komma oder Punkt, höchstens drei Stellen, 0
 * bis 100 ct/kWh (dieselben Grenzen wie der Server). `null` = leer, `undefined`
 * = ungültig. 0 ist eine Angabe („ich bekomme nichts"), keine fehlende.
 */
export function parseVerguetungInput(text: string): number | null | undefined {
  const v = parsePremiumInput(text);
  if (v === undefined || v === null) return v;
  return v <= VERGUETUNG_MAX_CT ? v : undefined;
}

/** Ein gespeicherter Satz als Feldtext („12,5"), leer ohne Angabe. */
export function verguetungInputText(ctKwh: number | null): string {
  return ctKwh == null ? '' : String(ctKwh).replace('.', ',');
}

/**
 * Die Folge nach dem Speichern - sie sagt, wann was wirkt: die Erlöse sofort
 * (sie werden neu bewertet), der Fahrplan ab seinem nächsten Lauf.
 */
export function verguetungFolge(nachher: Einspeiseverguetung): string {
  switch (nachher.zustand) {
    case 'angegeben':
      return 'Ab dem nächsten Fahrplan gilt Ihr Satz - Ihre Erlöse sind schon damit bewertet.';
    case 'eeg':
      return 'Ab dem nächsten Fahrplan gilt wieder der Satz aus dem EEG.';
    default:
      return 'Ab dem nächsten Fahrplan gilt wieder der Börsenpreis.';
  }
}
