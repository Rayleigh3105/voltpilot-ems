import type { Dez } from './dez';
import { gradtage } from './gradtage';
import { UEMS_BEZOGEN, UEMS_KOORDINATEN_FEHLEN_SATZ } from './glossar';

/**
 * Vertragszwilling AP-17 E9 = C (IP-12a) zu `WetterArchivRegeln`: die Herkunft `bezogen` —
 * Tagesmittel aus dem Wetter-Archiv über `gradtage` zu Gradtagen. Rein: kein Abruf, keine Uhr.
 */
export const HERKUNFT_BEZOGEN = UEMS_BEZOGEN;
export const VARIABLE_FEHLT = 'variable_fehlt';
export const TEMPERATUR_BEZOGEN = 'Temperatur von VoltPilot bezogen';
export const WORT_TAGE = 'Tagen';
export const ZONE = 'Europe/Berlin';

export interface Archivtag { datum: string; mittel: string | null; quelle: string; abgerufen_am: string }
export interface Tageswert { datum: string; betrag: Dez; zustand: string; kennzeichen: string[] }
export interface Monatswert { betrag: Dez | null; zustand: string; grund: string | null; kennzeichen: string[] }

const ORT = new Intl.DateTimeFormat('de-DE', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const ortszeit = (zeitpunkt: string) => {
  const t: Record<string, string> = {};
  for (const p of ORT.formatToParts(new Date(zeitpunkt))) t[p.type] = p.value;
  return { tag: `${t.year}-${t.month}-${t.day}`, text: `${t.day}.${t.month}.${t.year} ${t.hour}:${t.minute}` };
};

/** Das Kennzeichen an jeder bezogenen Zahl: Quelle und Abrufzeit in der Ortszone. */
export const kennzeichenBezogen = (quelle: string, abgerufenAm: string) =>
  `${TEMPERATUR_BEZOGEN} (${quelle}, abgerufen am ${ortszeit(abgerufenAm).text})`;

/** Nur ein Archiv-Tag: vor dem Kalendertag des Abrufs in der Ortszone (bis gestern). Vorhersage nie. */
export const archivtag = (datum: string, abgerufenAm: string) => datum < ortszeit(abgerufenAm).tag;

export function wetterArchivMonat(
  standort: string, koordinaten: { breite: string; laenge: string } | null, monat: string,
  archiv: Archivtag[], raum: string, grenze: string,
) {
  if (koordinaten === null) {
    if (archiv.length > 0) throw new Error('ohne Koordinaten gibt es keinen Abruf');
    const leer: Monatswert = { betrag: null, zustand: 'keine Werte', grund: VARIABLE_FEHLT, kennzeichen: [] };
    return { abruf: false, grund: VARIABLE_FEHLT as string | null, satz: UEMS_KOORDINATEN_FEHLEN_SATZ(standort) as string | null,
      tage: [] as Tageswert[], nie_geschrieben: [] as string[], monat: leer };
  }
  const [jahr, mon] = monat.split('-').map(Number);
  const laenge = new Date(Date.UTC(jahr, mon, 0)).getUTCDate();
  const geschrieben = new Map<string, Archivtag>();
  const nie: string[] = [];
  const gesehen = new Set<string>();
  for (const a of archiv) {
    if (a.datum.slice(0, 7) !== monat) throw new Error(`Tag außerhalb des Monats: ${a.datum}`);
    if (gesehen.has(a.datum)) throw new Error(`Tag doppelt: ${a.datum}`);
    gesehen.add(a.datum);
    if (!archivtag(a.datum, a.abgerufen_am)) nie.push(a.datum);
    else if (a.mittel !== null) geschrieben.set(a.datum, a);
  }
  const tage: Tageswert[] = [];
  const monatsTage: { mittel: string | null; zustand: string }[] = [];
  const spaetesterAbruf = new Map<string, string>();
  for (let d = 1; d <= laenge; d++) {
    const a = geschrieben.get(`${monat}-${String(d).padStart(2, '0')}`);
    if (!a) { monatsTage.push({ mittel: null, zustand: 'keine Werte' }); continue; }
    const tag = { mittel: a.mittel, zustand: 'vollständig' };
    monatsTage.push(tag);
    const e = gradtage([tag], raum, grenze);
    tage.push({ datum: a.datum, betrag: e.betrag as Dez, zustand: e.zustand, kennzeichen: [...e.kennzeichen, kennzeichenBezogen(a.quelle, a.abgerufen_am)] });
    const bisher = spaetesterAbruf.get(a.quelle);
    if (bisher === undefined || Date.parse(a.abgerufen_am) > Date.parse(bisher)) spaetesterAbruf.set(a.quelle, a.abgerufen_am);
  }
  const m = gradtage(monatsTage, raum, grenze);
  const kennzeichen = [...m.kennzeichen];
  for (const [quelle, zeit] of spaetesterAbruf) kennzeichen.push(kennzeichenBezogen(quelle, zeit));
  if (tage.length < laenge) kennzeichen.push(`${tage.length} von ${laenge} ${WORT_TAGE}`);
  const wert: Monatswert = { betrag: m.betrag, zustand: m.zustand, grund: m.betrag === null ? VARIABLE_FEHLT : null, kennzeichen };
  return { abruf: true, grund: null as string | null, satz: null as string | null, tage, nie_geschrieben: nie, monat: wert };
}
