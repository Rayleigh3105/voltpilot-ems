/**
 * Die PERIODEN und ZEITPUNKTE der Bezugsdaten als eigenes, reines Modul (UEMS
 * AP-09 §4.4 Z1–Z5, IP-3) — der TS-Zwilling von
 * `services/api .../uems/BezugsPeriode`.
 *
 * Der Vertrag und die Wahrheit stehen in
 * `docs/contracts/v2/bezugsdaten-vectors.json` (Familien `periode`, `zeit`,
 * `stunden`). Wer eine Regel ändert, ändert die Datei UND beide Zwillinge.
 *
 * Warum ein eigenes Modul: Import, Eingabe, Kennzahlen und Berichte deuten
 * dieselbe Datumsspalte. Sie wird deshalb EINMAL hier gedeutet.
 *
 * Die Zeitzone ist die des Standorts (E7, Z1/Z5). Ein Zeitstempel ohne Zone
 * wird in der Zeitzone des Standorts gelesen — eine Vorlage darf davon
 * abweichen, ein Offset in der Datei gewinnt immer. Deshalb wird die Zone hier
 * IMMER übergeben und nie aus dem Browser gelesen.
 *
 * Die drei Fallen, an denen dieses Modul richtig oder falsch wird:
 *  1. Ein Tag hat nicht 24 Stunden — an den Umstellungstagen 23 oder 25
 *     (25.10.2026: 25 h, 28.03.2027: 23 h). Gezählt wird deshalb der ABSTAND
 *     zweier Mitternachten, nie 24 × 3600 s.
 *  2. Ein mehrdeutiger oder nicht existierender Zeitpunkt ist ein BEFUND mit
 *     Kundensatz — nie eine stille Wahl und nie eine Verschiebung auf 03:30.
 *  3. „Passt nicht" ist etwas anderes als „noch nicht zu Ende": eine
 *     Kalenderwoche über eine Monatsgrenze passt NIE (und wird nie geteilt),
 *     der laufende Monat ist nur noch nicht fertig. Zwei Befunde, zwei Sätze.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr — „jetzt" wird übergeben.
 */

/** Z2: der gelieferte Zeitraum ist keine Periode dieser Bezugsgröße — er wird nie geteilt. */
export const PERIODE_PASST_NICHT = 'periode_passt_nicht';

/** Z4/E16: die Periode läuft noch; Werte nehmen nur ABGESCHLOSSENE Perioden an. */
export const PERIODE_NICHT_ZU_ENDE = 'periode_nicht_zu_ende';

/** Z5: die zonenlose Ortszeit liegt in der doppelten Stunde am Sommerzeit-Ende. */
export const ZEIT_MEHRDEUTIG = 'zeit_mehrdeutig';

/** Z5: die zonenlose Ortszeit liegt in der fehlenden Stunde am Sommerzeit-Beginn. */
export const ZEIT_NICHT_VORHANDEN = 'zeit_nicht_vorhanden';

/** Z3: der Text ist kein Datum — nie wird eines geraten. */
export const DATUM_UNLESBAR = 'datum_unlesbar';

/**
 * Die Kundensätze der Befunde dieses Moduls — hier, nicht in der Fläche: EINE
 * Formulierung, nicht zwei. `bezugsPeriode.test.ts` prüft sie Wort für Wort
 * gegen `befund_saetze` der Vektor-Datei.
 */
export const SAETZE: Record<string, string> = {
  [PERIODE_PASST_NICHT]: 'Der gelieferte Zeitraum ist keine Periode dieser Bezugsgröße.',
  [PERIODE_NICHT_ZU_ENDE]: 'Diese Periode ist noch nicht zu Ende.',
  [ZEIT_MEHRDEUTIG]: 'Diesen Zeitpunkt gibt es an diesem Tag zweimal (Zeitumstellung). Geben Sie die Zone an.',
  [ZEIT_NICHT_VORHANDEN]: 'Diesen Zeitpunkt gibt es an diesem Tag nicht (Zeitumstellung).',
  [DATUM_UNLESBAR]: 'Dieses Datum ist nicht lesbar.',
};

// ----------------------------------------------------- Zeitzone, Tage und Kalenderperioden

const OFFSET_FORM = new Map<string, Intl.DateTimeFormat>();

const offsetFormat = (zone: string): Intl.DateTimeFormat => {
  let f = OFFSET_FORM.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
    OFFSET_FORM.set(zone, f);
  }
  return f;
};

/** Der Offset der Zeitzone AN diesem Zeitpunkt, in Minuten. */
export const offsetMinuten = (ms: number, zone: string): number => {
  const teil = offsetFormat(zone)
    .formatToParts(new Date(ms))
    .find((p) => p.type === 'timeZoneName');
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(teil?.value ?? '');
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
};

/**
 * Z5 — alle Zeitpunkte, die zu einer Ortszeit OHNE Zone gehören: keiner in der
 * fehlenden Stunde am Sommerzeit-Beginn, zwei in der doppelten Stunde am
 * Sommerzeit-Ende, sonst genau einer.
 */
export const zeitpunkteVon = (ortszeitIso: string, zone: string): number[] => {
  const wand = Date.parse(`${ortszeitIso}Z`);
  if (Number.isNaN(wand)) return [];
  const gefunden: number[] = [];
  for (const probe of [wand - 26 * 3600000, wand, wand + 26 * 3600000]) {
    const offset = offsetMinuten(probe, zone);
    const ms = wand - offset * 60000;
    if (offsetMinuten(ms, zone) === offset && !gefunden.includes(ms)) gefunden.push(ms);
  }
  return gefunden.sort((a, b) => a - b);
};

/** Zwei Stellen mit führender Null — die Schreibweise jedes Datums- und Zeitteils. */
export const zwei = (n: number): string => String(n).padStart(2, '0');

/** Ein Zeitpunkt als ISO-8601 mit dem Offset, den die Zeitzone dort trägt. */
export const iso = (ms: number, zone: string): string => {
  const offset = offsetMinuten(ms, zone);
  const d = new Date(ms + offset * 60000);
  const vorzeichen = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${d.getUTCFullYear()}-${zwei(d.getUTCMonth() + 1)}-${zwei(d.getUTCDate())}` +
    `T${zwei(d.getUTCHours())}:${zwei(d.getUTCMinutes())}:${zwei(d.getUTCSeconds())}` +
    `${vorzeichen}${zwei(Math.floor(abs / 60))}:${zwei(abs % 60)}`
  );
};

/** Der Kalendertag (und die Uhrzeit) eines Zeitpunkts in der Zeitzone des Standorts. */
export const ortsteile = (ms: number, zone: string) => {
  const d = new Date(ms + offsetMinuten(ms, zone) * 60000);
  return { jahr: d.getUTCFullYear(), monat: d.getUTCMonth() + 1, tag: d.getUTCDate() };
};

/** Mitternacht eines Kalendertages in der Zeitzone des Standorts. */
export const mitternacht = (tag: string, zone: string): number => {
  const moeglich = zeitpunkteVon(`${tag}T00:00:00`, zone);
  return moeglich.length > 0 ? moeglich[0] : Date.parse(`${tag}T00:00:00Z`);
};

/** Ein Kalendertag plus/minus ganze Tage — Kalenderarithmetik, keine Zeitzone. */
export const tagPlus = (tag: string, tage: number): string =>
  new Date(Date.parse(`${tag}T00:00:00Z`) + tage * 86400000).toISOString().slice(0, 10);

/**
 * P3 — die Länge eines Kalendertages in Stunden: am Umstellungstag 23 oder 25.
 *
 * Gezählt wird der Abstand zweier Mitternachten am Standort. Der Java-Zwilling
 * BESTELLT dieselbe Zahl bei der Verbrauchsregel AP-08 (`VerbrauchRegeln.stunden`);
 * im Portal gibt es diese Regel nicht, deshalb steht sie hier — aber nur hier.
 */
export const stundenDesTages = (tag: string, zone: string): number =>
  (mitternacht(tagPlus(tag, 1), zone) - mitternacht(tag, zone)) / 3600000;

const isoWoche = (tag: string): { jahr: number; woche: number } => {
  const d = Date.parse(`${tag}T00:00:00Z`);
  const wochentag = (new Date(d).getUTCDay() + 6) % 7;
  const donnerstag = d + (3 - wochentag) * 86400000;
  const jahr = new Date(donnerstag).getUTCFullYear();
  return { jahr, woche: Math.round((donnerstag - wochenMontag(jahr, 1)) / (7 * 86400000)) + 1 };
};

const wochenMontag = (jahr: number, woche: number): number => {
  const jan4 = Date.UTC(jahr, 0, 4);
  const wochentag = (new Date(jan4).getUTCDay() + 6) % 7;
  return jan4 - wochentag * 86400000 + (woche - 1) * 7 * 86400000;
};

/** Der Schlüssel eines Kalendermonats — `2026-10`. */
export const monatsschluessel = (jahr: number, monat: number): string => `${jahr}-${zwei(monat)}`;

/** Der Schlüssel der Periode, in der ein Kalendertag liegt. */
export const schluesselVon = (tag: string, periodeArt: string): string => {
  const [jahr, monat] = tag.split('-').map(Number);
  if (periodeArt === 'monat') return monatsschluessel(jahr, monat);
  if (periodeArt === 'jahr') return String(jahr);
  if (periodeArt === 'woche') {
    const w = isoWoche(tag);
    return `${w.jahr}-W${zwei(w.woche)}`;
  }
  return tag;
};

/** Erster und LETZTER Tag einer Periode aus ihrem Schlüssel. */
export const spanneVon = (schluessel: string, periodeArt: string): [string, string] => {
  if (periodeArt === 'monat') {
    const [jahr, monat] = schluessel.split('-').map(Number);
    return [`${schluessel}-01`, new Date(Date.UTC(jahr, monat, 0)).toISOString().slice(0, 10)];
  }
  if (periodeArt === 'jahr') return [`${schluessel}-01-01`, `${schluessel}-12-31`];
  if (periodeArt === 'woche') {
    const montag = wochenMontag(Number(schluessel.slice(0, 4)), Number(schluessel.slice(6)));
    const ab = new Date(montag).toISOString().slice(0, 10);
    return [ab, tagPlus(ab, 6)];
  }
  return [schluessel, schluessel];
};

/** Ein Tagesdatum, deutsch (`31.10.2026`) oder ISO (`2026-10-31`) — sonst `null`. */
export const tagText = (text: string | null | undefined): string | null => {
  if (!text) return null;
  const s = text.trim();
  const deutsch = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  const kandidat = deutsch ? `${deutsch[3]}-${zwei(Number(deutsch[2]))}-${zwei(Number(deutsch[1]))}` : s;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(kandidat)) return null;
  const ms = Date.parse(`${kandidat}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== kandidat ? null : kandidat;
};

// -------------------------------------------------------------- Z1–Z4 — die Periode

export type Periodeneingang = {
  text?: string | null;
  vonText?: string | null;
  bisText?: string | null;
  deutung: string;
  periodeArt: string;
  jetzt?: number | null;
};

export type Periodendeutung = {
  schluessel: string | null;
  von: number | null;
  bis: number | null;
  stunden: number | null;
  befund: string | null;
};

const MONATSNAMEN = [
  'januar',
  'februar',
  'märz',
  'april',
  'mai',
  'juni',
  'juli',
  'august',
  'september',
  'oktober',
  'november',
  'dezember',
];

const befundPeriode = (befund: string): Periodendeutung => ({
  schluessel: null,
  von: null,
  bis: null,
  stunden: null,
  befund,
});

/** Z3: nennt der Text GENAU eine Periode der gefragten Art? Sonst `null`. */
const periodenschluessel = (text: string | null | undefined, periodeArt: string): string | null => {
  const s = (text ?? '').trim();
  if (periodeArt === 'monat') {
    if (/^\d{4}-\d{2}$/.test(s)) {
      const monat = Number(s.slice(5));
      return monat >= 1 && monat <= 12 ? s : null;
    }
    const zahlform = /^(\d{1,2})[/.](\d{4})$/.exec(s);
    if (zahlform) {
      const monat = Number(zahlform[1]);
      return monat >= 1 && monat <= 12 ? monatsschluessel(Number(zahlform[2]), monat) : null;
    }
    const wort = s.split(/\s+/);
    if (wort.length === 2 && /^\d{4}$/.test(wort[1])) {
      const monat = MONATSNAMEN.indexOf(wort[0].toLowerCase()) + 1;
      return monat === 0 ? null : monatsschluessel(Number(wort[1]), monat);
    }
    return null;
  }
  if (periodeArt === 'woche') return /^\d{4}-W\d{2}$/.test(s) ? s : null;
  if (periodeArt === 'jahr') return /^\d{4}$/.test(s) ? s : null;
  return tagText(s);
};

/**
 * Z1–Z4 — eine Datumsspalte wird die Periode, für die der Wert gilt.
 *
 * Die Deutung steht in der Zuordnungs-Vorlage (Z3) und wird nie geraten. Ein
 * gelieferter Zeitraum, der keine Periode dieser Bezugsgröße ist, ist
 * `periode_passt_nicht` — er wird nie geteilt, verteilt oder nach Mehrheit
 * zugeordnet (Z2). Eine Periode, deren Ende hinter `jetzt` liegt, ist
 * `periode_nicht_zu_ende` (Z4/E16). Das sind zwei verschiedene Befunde mit zwei
 * verschiedenen nächsten Schritten, nie einer.
 */
export const periode = (eingang: Periodeneingang, zone: string): Periodendeutung => {
  const { deutung, periodeArt } = eingang;
  let spanne: [string, string];
  let schluessel: string;

  if (deutung === 'periode') {
    const gefunden = periodenschluessel(eingang.text, periodeArt);
    if (!gefunden) return befundPeriode(PERIODE_PASST_NICHT);
    schluessel = gefunden;
    spanne = spanneVon(schluessel, periodeArt);
  } else if (deutung === 'periodenbeginn' || deutung === 'periodenende') {
    const tag = tagText(eingang.text);
    if (!tag) return befundPeriode(DATUM_UNLESBAR);
    schluessel = schluesselVon(tag, periodeArt);
    spanne = spanneVon(schluessel, periodeArt);
    if (tag !== (deutung === 'periodenbeginn' ? spanne[0] : spanne[1])) {
      return befundPeriode(PERIODE_PASST_NICHT);
    }
  } else if (deutung === 'von_bis') {
    const von = tagText(eingang.vonText);
    const bis = tagText(eingang.bisText);
    if (!von || !bis) return befundPeriode(DATUM_UNLESBAR);
    schluessel = schluesselVon(von, periodeArt);
    spanne = spanneVon(schluessel, periodeArt);
    if (von !== spanne[0] || bis !== spanne[1]) return befundPeriode(PERIODE_PASST_NICHT);
  } else {
    return befundPeriode(PERIODE_PASST_NICHT);
  }

  const von = mitternacht(spanne[0], zone);
  const bis = mitternacht(tagPlus(spanne[1], 1), zone);
  if (eingang.jetzt != null && bis > eingang.jetzt) return befundPeriode(PERIODE_NICHT_ZU_ENDE);
  return { schluessel, von, bis, stunden: (bis - von) / 3600000, befund: null };
};

// ------------------------------------------------------------ Z5 — der Zeitstempel

export type Zeitdeutung = { zeitpunkt: number | null; befund: string | null; varianten: string[] };

const ortszeit = (text: string): string | null => {
  const s = text.trim();
  const deutsch = /^(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{2})$/.exec(s);
  if (deutsch) {
    const tag = tagText(`${deutsch[1]}.${deutsch[2]}.${deutsch[3]}`);
    return tag ? `${tag}T${zwei(Number(deutsch[4]))}:${deutsch[5]}:00` : null;
  }
  const isoform = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/.exec(s);
  return isoform ? `${isoform[1]}T${isoform[2]}${isoform[3] ?? ':00'}` : null;
};

/**
 * Z5/E7 — ein Zeitstempel ohne Zone bekommt die Zeitzone des Standorts.
 *
 * Ein Offset in der Datei gewinnt immer. Ohne Zone gilt: in der doppelten
 * Stunde am Sommerzeit-Ende ist die Ortszeit `zeit_mehrdeutig` (beide
 * Möglichkeiten stehen in `varianten` — die Regel wählt keine), in der
 * fehlenden Stunde am Sommerzeit-Beginn `zeit_nicht_vorhanden`. Beides wird
 * abgelehnt, nie geraten.
 */
export const zeitpunkt = (text: string, zone: string, offsetInDatei: string | null): Zeitdeutung => {
  const ort = ortszeit(text);
  if (!ort) return { zeitpunkt: null, befund: DATUM_UNLESBAR, varianten: [] };
  if (offsetInDatei) {
    const ms = Date.parse(`${ort}${offsetInDatei}`);
    return Number.isNaN(ms)
      ? { zeitpunkt: null, befund: DATUM_UNLESBAR, varianten: [] }
      : { zeitpunkt: ms, befund: null, varianten: [] };
  }
  const moeglich = zeitpunkteVon(ort, zone);
  if (moeglich.length === 0) return { zeitpunkt: null, befund: ZEIT_NICHT_VORHANDEN, varianten: [] };
  if (moeglich.length > 1) {
    return {
      zeitpunkt: null,
      befund: ZEIT_MEHRDEUTIG,
      varianten: moeglich.map((ms) => iso(ms, zone)),
    };
  }
  return { zeitpunkt: moeglich[0], befund: null, varianten: [] };
};

/** Der Kundensatz eines Befunds dieses Moduls — die Fläche erfindet keinen zweiten. */
export const satz = (befund: string): string => {
  const text = SAETZE[befund];
  if (!text) throw new Error(`kein Kundensatz für ${befund}`);
  return text;
};
