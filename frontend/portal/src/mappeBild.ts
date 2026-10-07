/**
 * Nachweisen, Konzept n1 Runde 2 (Entscheid 7, PR 6): das reine Bild von „Unterlagen zusammenstellen“ - wofür
 * (Vokabular `mappe_anlass`), welcher Zeitraum, was hineingehört (Gruppen des Verzeichnisses in vier Bündeln), welche
 * Teile offen sind - und der Seite einer Mappe. Was in die Mappe geht und wie lange sie abrufbar ist, entscheidet die
 * Route; hier stehen nur Wörter, Auswahl und Zählung der Einträge aus dem Verzeichnis, das der Überblick schon gelesen hat.
 */
import type { EnergiemanagementMappe, EnergiemanagementVerzeichnis } from './api';
import { VOKABULARE, WOERTER } from './energiemanagement';
import { tagText } from './energiemanagementPortal';

export const PRUEFUNG_VON_AUSSEN = 'Prüfung von außen';
export const UNTERLAGEN_ZUSAMMENSTELLEN = 'Unterlagen zusammenstellen';
export const EINSICHT_GEBEN = 'Einsicht geben';
export const WOFUER = 'Wofür?';
export const ZEITRAUM = 'Zeitraum';
export const WAS_GEHOERT_HINEIN = 'Was gehört hinein?';
export const MAPPE_ERSTELLEN = 'Mappe erstellen';
export const MAPPE_FERTIG = 'Die Mappe ist fertig';
export const PDF_MIT_INHALT = 'PDF mit Inhaltsverzeichnis';
export const MAPPE_ABGELAUFEN = 'Nicht mehr abrufbar';
export const MAPPEN = 'Mappen';

/**
 * Was eine Person mit „Einsicht“ sieht, kurz und ohne Aufklappen (Review P6-3, Captain-Entscheid: keine engere Rolle,
 * aber das Blatt sagt den Umfang): alle Daten aller Standorte, nur lesend, bis zum letzten Tag.
 */
export const einsichtUmfang = (bis: string | null) =>
  `Sieht alle Daten aller Standorte, nur lesend${bis ? `, bis\u00a0${tagText(bis)}` : ''}.`;

/**
 * „Einsicht geben“ an einem vorhandenen Konto (Review r2, N-6.1): das Blatt gibt sie, wenn keine läuft, und verlängert
 * eine laufende nur - es kürzt nie still. Läuft sie ohne Ende oder mindestens bis zum gewählten Tag, bleibt sie; kürzen
 * geht ausdrücklich in der Benutzerverwaltung. Ohne gewählten Tag sagt erst das Absenden, dass er fehlt.
 */
export type EinsichtWahl = 'geben' | 'verlaengern' | 'bleibt';
export function einsichtWahl(laufend: { bis: string | null } | null, gewaehlt: string | null): EinsichtWahl {
  if (!laufend) return 'geben';
  if (laufend.bis === null) return 'bleibt';
  return gewaehlt === null || gewaehlt > laufend.bis ? 'verlaengern' : 'bleibt';
}
/** Der heutige Stand im Kasten „Schon ein Zugang“ - ohne ihn sah niemand, was „Einsicht bis … geben“ ersetzt. */
export function einsichtStand(laufend: { bis: string | null } | null, wahl: EinsichtWahl): string {
  if (!laufend) return 'Noch keine Einsicht';
  const lauf = laufend.bis === null ? 'Einsicht läuft ohne Ende' : `Einsicht läuft bis\u00a0${tagText(laufend.bis)}`;
  return wahl === 'bleibt' ? `${lauf} · bleibt so` : lauf;
}

/** Der Zusatz je Anlass (Recherche Q13, Q14): wann so eine Prüfung meist kommt. */
const ANLASS_ZUSATZ: Readonly<Record<string, string | null>> = {
  audit_von_aussen: 'meist 6 Wochen vorher',
  anfrage_behoerde: 'oft 4 Wochen Frist',
  eigene_ablage: null,
};

/** „Wofür?“ als Antwort-Karten in der Folge des Vokabulars. */
export const anlassOptionen = () =>
  VOKABULARE.mappe_anlass.map((a) => ({ wert: a, titel: WOERTER.mappe_anlass[a] ?? a, zusatz: ANLASS_ZUSATZ[a] ?? null }));

export type ZeitraumWahl = 'zwoelf_monate' | 'drei_jahre' | 'alles' | 'ab_tag';
export const ZEITRAUM_CHIPS: readonly { wert: ZeitraumWahl; label: string }[] = [
  { wert: 'zwoelf_monate', label: '12 Monate' },
  { wert: 'drei_jahre', label: '3 Jahre' },
  { wert: 'alles', label: 'Alles' },
  { wert: 'ab_tag', label: 'Ab Tag' },
];

/**
 * Ein ISO-Tag minus Jahre plus ein Tag: „12 Monate“ bis zum 30.04.2029 beginnen am 01.05.2028. Endet der Tag einen Monat,
 * sind es ganze Monate: bis 28.02.2029 ab 01.03.2028 (nicht ab dem 29.02.), bis 29.02.2028 ab 01.03.2027; sonst wird ein
 * 29. Februar im Jahr ohne Schalttag zum 28., damit der Zeitraum keinen Tag verliert.
 */
function jahreZurueck(heute: string, jahre: number): string {
  const [j, m, t] = heute.split('-').map(Number);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (new Date(Date.UTC(j, m, 0)).getUTCDate() === t) return iso(new Date(Date.UTC(j - jahre, m, 1)));
  const letzter = new Date(Date.UTC(j - jahre, m, 0)).getUTCDate();
  return iso(new Date(Date.UTC(j - jahre, m - 1, Math.min(t, letzter) + 1)));
}

/** Ab welchem Tag die Mappe zählt; `null` = alles. `heute` ist der Tag der Route. */
export function vonFuer(wahl: ZeitraumWahl, heute: string, abTag: string | null): string | null {
  switch (wahl) {
    case 'zwoelf_monate':
      return jahreZurueck(heute, 1);
    case 'drei_jahre':
      return jahreZurueck(heute, 3);
    case 'ab_tag':
      return abTag;
    default:
      return null;
  }
}

/** „seit 01.05.2028“ oder „alles“ - die Kurzzeile des Desktop-Dialogs. */
export const zeitraumKurz = (von: string | null) => (von ? `seit ${tagText(von)}` : 'alles');

export type Buendel = { key: string; titel: string; gruppen: readonly string[] };

/**
 * „Was gehört hinein?“ - die elf Gruppen des Verzeichnisses in vier Bündeln (Desktop-Mock r2d-dlg-mp), jede Gruppe in
 * genau einem. „Energetische Bewertung“ ausgeschrieben: „Bewertung“ allein gehört Auswerten (Sprach-Wächter SP3).
 */
export const BUENDEL: readonly Buendel[] = [
  {
    key: 'grundlagen',
    titel: 'Grundlagen, Aufgaben, Betrieb',
    gruppen: ['grundlagen', 'verantwortung', 'risiken_chancen', 'kompetenz_kommunikation', 'betrieb_auslegung_beschaffung'],
  },
  {
    key: 'bewertung',
    titel: 'Energetische Bewertung, Kennzahlen, Ziele',
    gruppen: ['bewertung_messplanung', 'kennzahlen_bezugsbasen', 'ziele_massnahmen_abweichungen'],
  },
  { key: 'pruefen', titel: 'Audits, Feststellungen, Managementbewertung', gruppen: ['audits_feststellungen', 'managementbewertung'] },
  { key: 'berichte', titel: 'Berichte', gruppen: ['berichte'] },
];

/** Die Gruppen der gewählten Bündel, in der Folge des Vokabulars. */
export const gruppenAus = (buendel: readonly string[]) =>
  VOKABULARE.verzeichnis_gruppe.filter((g) => BUENDEL.some((b) => buendel.includes(b.key) && b.gruppen.includes(g)));

/** Wie viele Einträge des Verzeichnisses ein Bündel im Zeitraum hat (`bis` eingeschlossen). */
export function eintraegeIm(v: Pick<EnergiemanagementVerzeichnis, 'gruppen'>, b: Buendel, von: string | null, bis: string): number {
  return v.gruppen
    .filter((g) => b.gruppen.includes(g.gruppe))
    .flatMap((g) => g.zeilen)
    .filter((z) => z.tag !== null && (von === null || z.tag >= von) && z.tag <= bis).length;
}

export const teileOffenWort = (n: number) => (n === 1 ? '1 Teil offen' : `${n} Teile offen`);

// ------------------------------------------------------------------ Seite einer Mappe (Mock r2-MP3)

/** „30.04.2029, 10:20“ in der Zeitzone des Unternehmens (die Route liefert den Stichtag mit Versatz). */
export function zeitText(iso: string): string {
  const tag = `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  return `${tag}, ${iso.slice(11, 16)}`;
}

/** Die Zeile unter der Datei: „PDF · CSV · noch 30 Tage“ - nach der Frist „nicht mehr abrufbar“. */
export function dateiZeile(m: Pick<EnergiemanagementMappe, 'abrufbar' | 'abrufbar_tage'>): string {
  if (!m.abrufbar) return MAPPE_ABGELAUFEN.toLowerCase();
  return `PDF · CSV · noch ${m.abrufbar_tage === 1 ? '1 Tag' : `${m.abrufbar_tage} Tage`}`;
}

/** „4 Teile als offen aufgeführt“ - oder nichts, wenn keiner offen war. */
export const offenZeile = (m: Pick<EnergiemanagementMappe, 'offen'>) =>
  m.offen.length ? `${m.offen.length === 1 ? '1 Teil' : `${m.offen.length} Teile`} als offen aufgeführt` : null;

/** Der Zeitraum einer Mappe als kurzer Fakt: „01.05.2028 bis 30.04.2029“ oder „alles bis 30.04.2029“. */
export const zeitraumText = (m: Pick<EnergiemanagementMappe, 'von' | 'bis'>) =>
  m.von ? `${tagText(m.von)} bis ${tagText(m.bis)}` : `alles bis ${tagText(m.bis)}`;
