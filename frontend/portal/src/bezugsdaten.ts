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
 * (`Dez`), damit keine Rechnung einen Binärbruch-Fehler erbt: `0.1 + 0.2` ist
 * hier nicht `0.30000000000000004`, und `312,4 t` sind genau `312400 kg`.
 *
 * Wer anruft (Stand AP-09 IP-1): niemand. Die Flächen kommen mit IP-9 … IP-16.
 */

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

// --------------------------------------------------------------- Dezimalzahlen (exakt)

/** Ein Betrag als ganzzahlige Mantisse: der Wert ist `z / 10^e`. */
export type Dez = { z: bigint; e: number };

const zehn = (n: number): bigint => 10n ** BigInt(n);

/** Dezimaltext (mit Punkt) → Betrag. Alles andere ist ein Programmfehler, kein Befund. */
export const dez = (text: string): Dez => {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`kein Dezimaltext: ${text}`);
  const bruch = m[3] ?? '';
  return { z: BigInt(`${m[1]}${m[2]}${bruch}`), e: bruch.length };
};

export const dezVon = (n: number): Dez => dez(String(n));

const halbAuf = (zaehler: bigint, nenner: bigint): bigint => {
  const negativ = zaehler < 0n !== nenner < 0n;
  const a = zaehler < 0n ? -zaehler : zaehler;
  const b = nenner < 0n ? -nenner : nenner;
  const ganz = a / b;
  const rest = a % b;
  const auf = rest * 2n >= b ? ganz + 1n : ganz;
  return negativ ? -auf : auf;
};

/** Auf `stellen` Nachkommastellen, kaufmännisch gerundet. */
export const dezRunde = (d: Dez, stellen: number): Dez =>
  stellen >= d.e ? { z: d.z * zehn(stellen - d.e), e: stellen } : { z: halbAuf(d.z, zehn(d.e - stellen)), e: stellen };

/** Mal `10^potenz` — exakt, ohne Rundung (t → kg ist potenz 3). */
export const dezSkaliere = (d: Dez, potenz: number): Dez =>
  potenz >= d.e ? { z: d.z * zehn(potenz - d.e), e: 0 } : { z: d.z, e: d.e - potenz };

/** Geteilt durch eine ganze Zahl, auf `stellen` gerundet. */
export const dezTeile = (d: Dez, teiler: number, stellen: number): Dez => ({
  z: halbAuf(d.z * zehn(stellen), BigInt(teiler) * zehn(d.e)),
  e: stellen,
});

export const dezVergleich = (a: Dez, b: Dez): number => {
  const e = Math.max(a.e, b.e);
  const x = a.z * zehn(e - a.e);
  const y = b.z * zehn(e - b.e);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Gleich heißt: gleich auf `vergleich_nachkommastellen` Stellen. */
export const dezGleich = (a: Dez, b: Dez, stellen = VERGLEICH_NACHKOMMASTELLEN): boolean =>
  dezVergleich(dezRunde(a, stellen), dezRunde(b, stellen)) === 0;

/** Der Betrag als Dezimaltext mit Punkt — die Form, in der er im Vertrag steht. */
export const dezText = (d: Dez): string => {
  const negativ = d.z < 0n;
  const ziffern = (negativ ? -d.z : d.z).toString().padStart(d.e + 1, '0');
  const ganz = ziffern.slice(0, ziffern.length - d.e);
  const bruch = d.e > 0 ? `.${ziffern.slice(ziffern.length - d.e)}` : '';
  return `${negativ ? '-' : ''}${ganz}${bruch}`;
};

const prozent = (teil: number, ganz: number, stellen: number): Dez =>
  ganz === 0
    ? { z: 0n, e: stellen }
    : { z: halbAuf(BigInt(teil) * 100n * zehn(stellen), BigInt(ganz)), e: stellen };

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

const zwei = (n: number): string => String(n).padStart(2, '0');

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
const ortsteile = (ms: number, zone: string) => {
  const d = new Date(ms + offsetMinuten(ms, zone) * 60000);
  return { jahr: d.getUTCFullYear(), monat: d.getUTCMonth() + 1, tag: d.getUTCDate() };
};

/** Mitternacht eines Kalendertages in der Zeitzone des Standorts. */
export const mitternacht = (tag: string, zone: string): number => {
  const moeglich = zeitpunkteVon(`${tag}T00:00:00`, zone);
  return moeglich.length > 0 ? moeglich[0] : Date.parse(`${tag}T00:00:00Z`);
};

const tagPlus = (tag: string, tage: number): string =>
  new Date(Date.parse(`${tag}T00:00:00Z`) + tage * 86400000).toISOString().slice(0, 10);

/** P3 — die Länge eines Kalendertages in Stunden: am Umstellungstag 23 oder 25. */
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

const monatsschluessel = (jahr: number, monat: number): string => `${jahr}-${zwei(monat)}`;

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

const tagText = (text: string | null | undefined): string | null => {
  if (!text) return null;
  const s = text.trim();
  const deutsch = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  const kandidat = deutsch ? `${deutsch[3]}-${zwei(Number(deutsch[2]))}-${zwei(Number(deutsch[1]))}` : s;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(kandidat)) return null;
  const ms = Date.parse(`${kandidat}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== kandidat ? null : kandidat;
};

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

// -------------------------------------------------------------- U1–U3 — die Einheit

/** U1: eine erlaubte Umrechnung. Sie gilt in BEIDE Richtungen. */
export type Umrechnung = {
  von: string;
  nach: string;
  zehnerpotenz?: number;
  teiler?: number;
  nachkommastellen?: number;
};

export type Einheitswert = { betrag: Dez | null; einheit: string; befunde: string[] };

const groesseVon = (einheitswort: string, einheiten: Record<string, string[]>): string | null => {
  for (const [groesse, woerter] of Object.entries(einheiten)) {
    if (woerter.includes(einheitswort)) return groesse;
  }
  return null;
};

/**
 * U1–U3 — der gelieferte Betrag wird auf die Einheit der Bezugsgröße gebracht.
 *
 * Keine gelieferte Einheit heißt: die Einheit der Bezugsgröße gilt (U3). Eine
 * Einheit außerhalb des Vokabulars der ZIEL-Größe ist `einheit_unbekannt` (U2)
 * — es wird nie ein Faktor geraten und nie über Größen hinweg gerechnet. Eine
 * Einheit derselben Größe OHNE Eintrag in `umrechnung` ist keine Umrechnung,
 * sondern eine Annahme, und wird genauso abgelehnt.
 */
export const einheit = (
  betrag: Dez | null,
  geliefert: string | null,
  ziel: string,
  einheiten: Record<string, string[]>,
  umrechnungen: Umrechnung[],
): Einheitswert => {
  if (geliefert === null || geliefert === ziel) return { betrag, einheit: ziel, befunde: [] };
  const groesse = groesseVon(ziel, einheiten);
  if (!groesse || !einheiten[groesse].includes(geliefert)) {
    return { betrag: null, einheit: ziel, befunde: ['einheit_unbekannt'] };
  }
  for (const u of umrechnungen) {
    const hin = u.von === geliefert && u.nach === ziel;
    const zurueck = u.von === ziel && u.nach === geliefert;
    if (!hin && !zurueck) continue;
    if (betrag === null) return { betrag: null, einheit: ziel, befunde: ['einheit_umgerechnet'] };
    if (u.zehnerpotenz !== undefined) {
      return {
        betrag: dezSkaliere(betrag, hin ? u.zehnerpotenz : -u.zehnerpotenz),
        einheit: ziel,
        befunde: ['einheit_umgerechnet'],
      };
    }
    const teiler = u.teiler ?? 1;
    return {
      betrag: hin
        ? dezTeile(betrag, teiler, u.nachkommastellen ?? 0)
        : { z: betrag.z * BigInt(teiler), e: betrag.e },
      einheit: ziel,
      befunde: ['einheit_umgerechnet'],
    };
  }
  return { betrag: null, einheit: ziel, befunde: ['einheit_unbekannt'] };
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
 * `periode_nicht_zu_ende` (Z4/E16).
 */
export const periode = (eingang: Periodeneingang, zone: string): Periodendeutung => {
  const { deutung, periodeArt } = eingang;
  let spanne: [string, string];
  let schluessel: string;

  if (deutung === 'periode') {
    const gefunden = periodenschluessel(eingang.text, periodeArt);
    if (!gefunden) return befundPeriode('periode_passt_nicht');
    schluessel = gefunden;
    spanne = spanneVon(schluessel, periodeArt);
  } else if (deutung === 'periodenbeginn' || deutung === 'periodenende') {
    const tag = tagText(eingang.text);
    if (!tag) return befundPeriode('datum_unlesbar');
    schluessel = schluesselVon(tag, periodeArt);
    spanne = spanneVon(schluessel, periodeArt);
    if (tag !== (deutung === 'periodenbeginn' ? spanne[0] : spanne[1])) {
      return befundPeriode('periode_passt_nicht');
    }
  } else if (deutung === 'von_bis') {
    const von = tagText(eingang.vonText);
    const bis = tagText(eingang.bisText);
    if (!von || !bis) return befundPeriode('datum_unlesbar');
    schluessel = schluesselVon(von, periodeArt);
    spanne = spanneVon(schluessel, periodeArt);
    if (von !== spanne[0] || bis !== spanne[1]) return befundPeriode('periode_passt_nicht');
  } else {
    return befundPeriode('periode_passt_nicht');
  }

  const von = mitternacht(spanne[0], zone);
  const bis = mitternacht(tagPlus(spanne[1], 1), zone);
  if (eingang.jetzt != null && bis > eingang.jetzt) return befundPeriode('periode_nicht_zu_ende');
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
  if (!ort) return { zeitpunkt: null, befund: 'datum_unlesbar', varianten: [] };
  if (offsetInDatei) {
    const ms = Date.parse(`${ort}${offsetInDatei}`);
    return Number.isNaN(ms)
      ? { zeitpunkt: null, befund: 'datum_unlesbar', varianten: [] }
      : { zeitpunkt: ms, befund: null, varianten: [] };
  }
  const moeglich = zeitpunkteVon(ort, zone);
  if (moeglich.length === 0) return { zeitpunkt: null, befund: 'zeit_nicht_vorhanden', varianten: [] };
  if (moeglich.length > 1) {
    return {
      zeitpunkt: null,
      befund: 'zeit_mehrdeutig',
      varianten: moeglich.map((ms) => iso(ms, zone)),
    };
  }
  return { zeitpunkt: moeglich[0], befund: null, varianten: [] };
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
      prozent: prozent(minuten, gesamt, ANTEIL_NACHKOMMASTELLEN),
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
  if (eingang.betrag !== null && dezGleich(bestand.betrag, eingang.betrag)) {
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
