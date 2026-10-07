import type { Bezugsbasis, BezugsbasisFassung, BezugsbasisFassungKurz, Kennzahl } from './api';
import { dezimal, einheitJe, methodeWort, referenzperiodeText, tagIn, zeilenFassung } from './bezugsbasisAnlegen';
import { grundWort, wertText, type FassungZustand } from './bezugsbasisFassungen';
import { UEMS_BEZUGSBASIS } from './glossar';
import { tagText, zahlWort } from './kennzahlSeite';
import { TRENNER } from './uemsErgebnis';

/**
 * Die Bezugsbasis eine Ebene unter der Kennzahl (Konzept Auswerten a1 §6.6) - REIN: Kopf, Statuszeile, Antwortsatz und
 * der Hinweis „vorläufig“ aus der laufenden Bezugsbasis und ihrer Fassung. Frist und Datenlage kommen vom Server; hier
 * wird nur benannt.
 */

export const VERGLEICH_JE_MONAT = 'Vergleich je Monat · Zeitraum und Bezugsbasis wählen';
export const NEUESTE_ZUERST = 'neueste zuerst';
export const UEBERPRUEFUNG = 'Überprüfung';
export const FASSUNG_ANSEHEN = 'Fassung ansehen';
export const PRUEFSUMME_HINWEIS = 'Prüfsumme und Grundlage je Fassung unter „Fassung ansehen“.';
export const ZWECK = 'Zweck:';
/** So viele Anstöße stehen offen; jeder weitere hinter „Alle … Anstöße“ (zehn Korrekturen lesen sich sonst als Wand). */
export const ANSTOESSE_SICHTBAR = 3;
export const alleAnstoesse = (n: number): string => `Alle ${n} Anstöße`;
export const WENIGER_ANSTOESSE = 'Weniger zeigen';
export const OHNE_BEZUGSBASIS_ANTEIL = 'Ein Anteil hat keine Bezugsbasis - VoltPilot vergleicht ihn nur mit dem Vorjahr.';

/** „Bezugsbasis BB-0001“ und „Womit Stromeinsatz Spritzguss je kg verglichen wird - und seit wann“. */
export function ebenenKopf(k: Pick<Kennzahl, 'name'>, basis: Pick<Bezugsbasis, 'kennzeichen'> | null): { titel: string; kennzeichen: string | null; unter: string } {
  return { titel: UEMS_BEZUGSBASIS, kennzeichen: basis?.kennzeichen ?? null, unter: `Womit ${k.name} verglichen wird - und seit wann` };
}

export interface StatusZeile {
  ton: 'ok' | 'warn' | 'aus';
  text: string;
  leise: string | null;
}

/**
 * Die Fassung, um die es am Tag `tag` geht: die freigegebene, die an ihm gilt; vor der ersten die nächste, die gelten
 * wird; sonst (alle abgelaufen, keine freigegeben) die der Basis-Zeile. Seite und Ebene zeigen dieselbe - zur echten Uhr
 * der Demo (Oktober 2026) ist das Fassung 1 „ab 01.11.2026“, nicht schon Fassung 2 „ab 01.11.2027“.
 */
export function fassungAm(basis: Bezugsbasis, tag: string): BezugsbasisFassungKurz | null {
  const frei = basis.fassungen.filter((f) => f.freigabe_status === 'freigegeben').sort((x, y) => x.gilt_ab.localeCompare(y.gilt_ab));
  const gilt = frei.filter((f) => f.gilt_ab <= tag && (!f.gilt_bis || f.gilt_bis >= tag)).pop();
  return gilt ?? frei.find((f) => f.gilt_ab > tag) ?? zeilenFassung(basis);
}

/**
 * „Gilt seit 01.11.2027 · nächste Überprüfung bis 30.04.2030“; fällig, beendet oder noch nicht freigegeben mit eigenem
 * Wort. Ohne Fassung `null`.
 */
export function statusZeile(basis: Bezugsbasis, fassung: BezugsbasisFassung | null, tag: string): StatusZeile | null {
  if (basis.beendet_zum) return { ton: 'aus', text: `Beendet zum ${tagText(basis.beendet_zum)}`, leise: basis.beendet_grund };
  const kurz = fassungAm(basis, tag);
  if (!kurz) return null;
  if (kurz.freigabe_status !== 'freigegeben') return { ton: 'warn', text: 'Noch nicht freigegeben', leise: `Fassung ${kurz.fassung}` };
  const frist = basis.frist ?? null;
  const seit = !fassung ? `Fassung ${kurz.fassung} gilt` : fassung.gilt_ab > tag ? `Gilt ab ${tagText(fassung.gilt_ab)}` : `Gilt seit ${tagText(fassung.gilt_ab)}`;
  if (frist?.ueberpruefung_faellig) {
    return { ton: 'warn', text: seit, leise: frist.faellig_am ? `Überprüfung seit ${tagText(frist.faellig_am)} fällig` : 'Überprüfung fällig' };
  }
  return { ton: 'ok', text: seit, leise: frist?.faellig_am ? `nächste Überprüfung bis ${tagText(frist.faellig_am)}` : null };
}

/**
 * Der Antwortsatz der Ebene: „VoltPilot erwartet 0,2837 kWh je kg - so viel wie im Oktober 2026.“ (Verhältnis) bzw.
 * „VoltPilot erwartet den Verbrauch nach einem Modell mit einer Einflussgröße: …“; darunter Fassung · Methode ·
 * Vergleichszeitraum.
 */
export function ebenenAntwort(f: BezugsbasisFassung, einheit: string | null): { satz: string; formal: string } {
  const zeitraum = referenzperiodeText(f.referenzperiode);
  const einMonat = f.referenzperiode.split('/')[0] === f.referenzperiode.split('/')[1];
  const formal = [`Fassung ${f.fassung}`, methodeWort(f.methode), `Vergleichszeitraum ${zeitraum}`];
  if (f.methode === 'verhaeltnis') {
    return f.basiswert
      ? { satz: `VoltPilot erwartet ${basiswertAllein(f.basiswert, einheit)} - so viel wie ${einMonat ? 'im' : 'von'} ${zeitraum}.`, formal: formal.join(TRENNER) }
      : { satz: 'Diese Fassung hat keinen Basiswert - VoltPilot rechnet mit ihr keinen erwarteten Wert.', formal: formal.join(TRENNER) };
  }
  // Modell und Gradtage: die Methode im Satz, die Koeffizienten im Untertitel.
  return {
    satz: `VoltPilot rechnet die Erwartung nach der Methode „${methodeWort(f.methode)}“, gebildet aus ${zeitraum}.`,
    formal: [`Fassung ${f.fassung}`, wertText(f, einheit), `Vergleichszeitraum ${zeitraum}`].join(TRENNER),
  };
}

/** „Vorläufig: gebildet aus 1 von 12 Monaten. Belastbar wird sie mit zwölf Monaten; dann lohnt eine neue Fassung.“ */
export function vorlaeufigSatz(f: Pick<BezugsbasisFassung, 'datenlage' | 'monate' | 'mindest_monate'>): { fett: string; satz: string } | null {
  if (f.datenlage !== 'vorlaeufig') return null;
  const aus = f.monate > 0 ? `gebildet aus ${f.monate} von ${f.mindest_monate} Monaten.` : 'gebildet aus weniger Monaten als vorgesehen.';
  return { fett: 'Vorläufig:', satz: `${aus} Belastbar wird sie mit ${zahlWort(f.mindest_monate)} Monaten; dann lohnt eine neue Fassung.` };
}

/** „0,2837 kWh je kg“ - der Basiswert eines Verhältnisses ohne das Wort der Methode. */
export const basiswertAllein = (basiswert: string, einheit: string | null): string => `${dezimal(basiswert)}${einheit ? ` ${einheitJe(einheit)}` : ''}`;

/** Der Datumsblock und die zwei Zeilen einer Fassung (§6.6): „seit 01.11. 2027 · Fassung 2 · gilt · Grund: …“. */
export interface FassungZeile {
  datum: { wort: 'seit' | 'bis' | 'ab'; tag: string; jahr: string } | null;
  titel: string;
  warum: string | null;
}

const TITEL_WORT: Record<FassungZustand, string> = { freigegeben: 'gilt', beendet: 'abgelöst', entwurf: 'Entwurf', beantragt: 'beantragt', abgelehnt: 'abgelehnt' };

/**
 * Eine freigegebene Fassung am Stichtag `tag`: künftig (gilt erst ab), laufend (seit, auch mit einem Ende in der Zukunft)
 * oder abgelöst (bis) - nie „abgelöst“ vor ihrem letzten Tag, nie „seit“ einem Tag, der noch nicht war.
 */
export function fassungZeile(
  f: Pick<BezugsbasisFassung, 'fassung' | 'gilt_ab' | 'freigabe_status'> & { gilt_bis: string | null; anpassungsgruende?: string[] },
  zustand: FassungZustand,
  wer: string | null,
  tag: string,
): FassungZeile {
  const block = (wort: 'seit' | 'bis' | 'ab', t: string) => ({ wort, tag: `${t.slice(8, 10)}.${t.slice(5, 7)}.`, jahr: t.slice(0, 4) });
  const freigegeben = zustand === 'freigegeben' || zustand === 'beendet';
  const kuenftig = freigegeben && f.gilt_ab > tag;
  const abgeloest = freigegeben && !kuenftig && f.gilt_bis !== null && f.gilt_bis < tag;
  const datum =
    zustand === 'abgelehnt' ? null
      : !freigegeben || kuenftig ? block('ab', f.gilt_ab)
        : abgeloest ? block('bis', f.gilt_bis as string)
          : block('seit', f.gilt_ab);
  const wort = !freigegeben ? TITEL_WORT[zustand] : kuenftig ? 'gilt künftig' : abgeloest ? 'abgelöst' : 'gilt';
  const gruende = (f.anpassungsgruende ?? []).map(grundWort);
  const warum = [
    gruende.length > 0 ? `Grund: ${gruende.join(', ')}` : null,
    freigegeben && f.gilt_bis ? `${abgeloest ? 'galt' : 'gilt'} vom ${tagText(f.gilt_ab)} bis ${tagText(f.gilt_bis)}` : null,
    wer,
  ].filter(Boolean).join(TRENNER);
  return { datum, titel: `Fassung ${f.fassung}${TRENNER}${wort}`, warum: warum || null };
}

/** „Zuletzt bestätigt am 30.04.2029. Ist sie noch die richtige Messlatte?“ - sonst der Tag der Freigabe. */
export function zuletztSatz(
  basis: Pick<Bezugsbasis, 'frist'>,
  laufend: { freigegeben_am?: string | null } | null,
): string {
  const bestaetigt = basis.frist?.bestaetigt_am ?? null;
  const frage = 'Ist sie noch die richtige Messlatte?';
  if (bestaetigt) return `Zuletzt bestätigt am ${tagText(bestaetigt.slice(0, 10))}. ${frage}`;
  if (laufend?.freigegeben_am) return `Freigegeben am ${tagIn(laufend.freigegeben_am)}. ${frage}`;
  return frage;
}
