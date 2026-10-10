/**
 * UEMS AP-17 IP-17 (F4/F5, R13, §5.5): das reine Bild des Übersichts-Bausteins „Bezugsbasen“ am Unternehmen. Die Frist
 * leitet der Server beim Abruf ab (`GET /api/v1/bezugsbasen/uebersicht`, Regel `frist` in `bezugsbasis.ts`); hier
 * werden nur Zahlen und Sätze gebildet — Wortlaut aus AP-17 §5.8 („Frist“, „Beendet“).
 */
import { ZUR_LISTE } from './kennzahlKarte';

/** Zustand einer Bezugsbasis, wie ihn die Übersicht und die Pflege-Routen liefern. */
export type BezugsbasisZustand = {
  bezugsbasis_id: string;
  kennzeichen: string;
  kennzahl_id: string;
  kennzahl_kennzeichen: string | null;
  kennzahl_name: string | null;
  fassung: number | null;
  freigegeben_am: string | null;
  datenlage: 'vollstaendig' | 'vorlaeufig' | null;
  zustand: 'entwurf' | 'freigegeben' | 'ueberpruefung_faellig' | 'beendet';
  faellig_am: string | null;
  faellig_seit_tagen: number | null;
  anstoss_liegt_vor: boolean;
  beendet_zum: string | null;
  beendet_grund: string | null;
};

export type BezugsbasisUebersicht = {
  stichtag: string;
  laufend: number;
  freigegeben: number;
  vorlaeufig: number;
  mit_anstoss: number;
  ueberpruefung_faellig: number;
  faellig: BezugsbasisZustand[];
};

export type BezugsbasisUebersichtBild = {
  /** „1 Bezugsbasis mit fälliger Überprüfung“ bzw. „Keine Überprüfung fällig“. */
  summe: string;
  faellig: boolean;
  /** „2 freigegeben · 1 vorläufig · 1 Anstoß liegt vor · 1 Überprüfung fällig“. */
  zahlen: string;
  zeilen: { key: string; kennzahlId: string; satz: string }[];
};

export const BEZUGSBASIS_BAUSTEIN_TITEL = 'Bezugsbasen';
/** Der Sprung zur Liste — dasselbe Wort wie der Baustein „Kennzahlen“ (die Basis gehört zur Welt der Kennzahl). */
export const BEZUGSBASIS_BAUSTEIN_OEFFNEN = ZUR_LISTE;

/** JJJJ-MM-TT → TT.MM.JJJJ. */
export const tagDeutsch = (tag: string) => `${tag.slice(8, 10)}.${tag.slice(5, 7)}.${tag.slice(0, 4)}`;

/** „seit 1 Tag“ · „seit n Tagen“ · am Fälligkeitstag „seit heute“. */
export function seitText(tage: number): string {
  if (tage <= 0) return 'seit heute';
  return tage === 1 ? 'seit 1 Tag' : `seit ${tage} Tagen`;
}

/** §5.8 „Frist“: „Bezugsbasis BB-0001, Fassung 2 vom 24.11.2027 · Überprüfung fällig seit 1 Tag — bestätigen oder neu fassen.“ */
export function fristSatz(z: Pick<BezugsbasisZustand, 'kennzeichen' | 'fassung' | 'freigegeben_am' | 'faellig_seit_tagen'>): string {
  const fassung = z.fassung !== null && z.freigegeben_am ? `, Fassung ${z.fassung} vom ${tagDeutsch(z.freigegeben_am)}` : '';
  return `Bezugsbasis ${z.kennzeichen}${fassung} · Überprüfung fällig ${seitText(z.faellig_seit_tagen ?? 0)} — bestätigen oder neu fassen.`;
}

/** §5.8 „Beendet“ (Anfang): „Nicht bewertbar: Bezugsbasis beendet am 31.12.2026 (Anbau Halle 2).“ */
export function beendetSatz(beendetZum: string, anlass?: string | null): string {
  return `Nicht bewertbar: Bezugsbasis beendet am ${tagDeutsch(beendetZum)}${anlass ? ` (${anlass})` : ''}.`;
}

const anzahl = (n: number, eins: string, viele: string) => `${n} ${n === 1 ? eins : viele}`;

/** Das Bild der Kachel; ohne laufende Bezugsbasis `null` — Bestandskunden sehen keine neue Kachel (R10). */
export function bezugsbasisUebersichtBild(u: BezugsbasisUebersicht | null): BezugsbasisUebersichtBild | null {
  if (!u || u.laufend === 0) return null;
  const teile = [`${u.freigegeben} freigegeben`];
  if (u.vorlaeufig > 0) teile.push(`${u.vorlaeufig} vorläufig`);
  if (u.mit_anstoss > 0) teile.push(`${u.mit_anstoss} Anstoß liegt vor`);
  teile.push(`${u.ueberpruefung_faellig} Überprüfung fällig`);
  const entwurf = u.laufend - u.freigegeben;
  if (entwurf > 0) teile.push(`${entwurf} im Entwurf`);
  return {
    summe:
      u.ueberpruefung_faellig > 0
        ? `${anzahl(u.ueberpruefung_faellig, 'Bezugsbasis', 'Bezugsbasen')} mit fälliger Überprüfung`
        : 'Keine Überprüfung fällig',
    faellig: u.ueberpruefung_faellig > 0,
    zahlen: teile.join(' · '),
    zeilen: u.faellig.map((z) => ({ key: z.bezugsbasis_id, kennzahlId: z.kennzahl_id, satz: fristSatz(z) })),
  };
}
