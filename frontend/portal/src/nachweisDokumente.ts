/**
 * Nachweisen, PR 2 Dokumente (Konzept Nachweisen n1, Runde 2, §6.5, Entscheide 10 bis 12, 24, 25): das reine Bild der
 * Liste und der Seite eines Dokuments. **Hier wird nichts entschieden:** Zustand, Fassungen, Überprüfung und Einträge
 * kommen von den Routen (`…/energiemanagement/dokumente`); hier steht nur, wie sie als Zeichen, Zeile und Stufe dastehen.
 *
 * Regeln der Runde 2: Antwort als Zeichen und Zahl (Status-Zeile), ein Fakt je Zeile, ein Datum als Datumsblock, die
 * Fassung nur ab Fassung 2, das Kennzeichen am Handy nur im Menü (Entscheid 25), Erklären auf Antippen (Entscheid 24).
 * „Heute“ ist der Tag der Route (`ueberpruefung.abruf`), nie die Uhr des Browsers (Befund 3).
 */
import type {
  EnergiemanagementBeleg,
  EnergiemanagementDokument,
  EnergiemanagementDokumentEintrag,
  EnergiemanagementDokumentKurz,
  EnergiemanagementFassung,
  EnergiemanagementVerweis,
} from './api';
import type { Erklaerung } from './components/nachweisen/erklaerung';
import type { Stufe } from './components/nachweisen/Stufen';
import type { ZeichenArt } from './components/nachweisen/NwZeichen';
import type { DatumTon } from './components/nachweisen/nwBild';
import { tagIso, tagText } from './energiemanagementPortal';

// ------------------------------------------------------------------ Wörter

export const DOKUMENTE_TITEL = 'Dokumente';
export const VORGABEN = 'Vorgaben';
export const NACHWEISE = 'Nachweise';
export const AUFGEHOBEN = 'Aufgehoben';
export const ALLE_DOKUMENTE = 'Alle Dokumente';
export const DOKUMENTE_LADEFEHLER = 'Die Dokumente ließen sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
export const DOKUMENT_LADEFEHLER = 'Das Dokument ließ sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
export const DOKUMENT_FEHLT = 'Dieses Dokument gibt es nicht - oder Sie dürfen es nicht sehen.';
export const KEIN_DOKUMENT = 'Noch kein Dokument festgehalten.';
export const FESTSTELLUNGEN_FEHLEN = 'Feststellungen nicht geladen';
export const VERLAUF = 'Verlauf';
export const VERLAUF_LEER = 'Noch nichts festgehalten.';

/** Der Tag als „30.04.2029“ - ein Zeitpunkt mit seinem Kalendertag in Berlin (`tagText`, Review r1 P2-7). */
const TAG = tagText;
const MEHRZAHL = (n: number, eins: string, viele: string) => (n === 1 ? `1 ${eins}` : `${n} ${viele}`);

/** Die gültige Fassung: die freigegebene, die keine jüngere ablöst; ohne Freigabe `null`. */
export const gueltigeFassung = (d: Pick<EnergiemanagementDokument, 'fassungen' | 'gueltige_fassung'>): EnergiemanagementFassung | null =>
  d.fassungen.find((f) => f.nr === d.gueltige_fassung) ?? null;

/** Die offene Fassung (Entwurf oder beantragt) - höchstens eine (DK2). */
export const offeneFassung = (d: Pick<EnergiemanagementDokument, 'fassungen'>): EnergiemanagementFassung | null =>
  d.fassungen.find((f) => f.status === 'entwurf' || f.status === 'beantragt') ?? null;

/** „Heute“ der Route: der Abruf-Tag der Überprüfung; ohne Überprüfung (aufgehoben) der übergebene Rückfall. */
export const heuteDerRoute = (d: { ueberpruefung: { abruf: string } | null }, rueckfall: string): string => d.ueberpruefung?.abruf ?? rueckfall;

// ------------------------------------------------------------------ Liste

/** Eine Zeile der Liste: Datumsblock (nächste Prüfung) oder Zeichen, Titel des Kunden, höchstens ein Fakt. */
export interface DokumentZeile {
  id: string;
  kennzeichen: string;
  titel: string;
  /** „Fassung 2“ erst ab Fassung 2; „Entwurf“; bei einem Nachweis die Person oder der Einsatz. */
  unter: string | null;
  /** Der Datumsblock der nächsten Prüfung: „bis 10.11.2029“, überfällig „seit …“ im Warnton. */
  datum: { wort: string; tag: string; ton: DatumTon } | null;
  /** Ohne Datumsblock: das Zeichen im selben Feld (Entwurf wartet, Nachweis festgehalten). */
  zeichen: ZeichenArt | 'nachweis' | null;
  /** Ein Verb, wo etwas zu tun ist: „Prüfen“ (überfällig), „Freigeben“ (Entwurf wartet). */
  verb: string | null;
}

export interface DokumenteBild {
  vorgaben: DokumentZeile[];
  nachweise: DokumentZeile[];
  aufgehoben: DokumentZeile[];
  gelten: number;
  ueberfaellig: number;
  entwuerfe: number;
}

/** Der Fakt unter einem Nachweis: an wem oder woran er hängt (Person, Einsatz), sonst nichts. */
function nachweisUnter(d: EnergiemanagementDokumentKurz): string | null {
  const b = d.bezug;
  if (b.person) return b.person.name;
  if (b.energieeinsatz) return b.energieeinsatz.name ?? b.energieeinsatz.kennzeichen ?? null;
  if (b.aufgabe?.person) return b.aufgabe.person.name;
  return null;
}

function zeile(d: EnergiemanagementDokumentKurz): DokumentZeile {
  const u = d.ueberpruefung;
  const ueber = !!u?.faellig_am && u.tage !== null && u.tage > 0;
  const entwurf = d.zustand === 'entwurf';
  const fassung = d.gueltige_fassung !== null && d.gueltige_fassung >= 2 ? `Fassung ${d.gueltige_fassung}` : null;
  const basis = { id: d.id, kennzeichen: d.kennzeichen, titel: d.titel };
  if (d.zustand === 'aufgehoben') return { ...basis, unter: null, datum: null, zeichen: 'offen', verb: null };
  if (entwurf) return { ...basis, unter: 'Entwurf', datum: null, zeichen: 'entwurf', verb: null };
  if (d.klasse === 'nachweis') return { ...basis, unter: nachweisUnter(d) ?? fassung, datum: null, zeichen: 'nachweis', verb: null };
  return {
    ...basis,
    unter: fassung,
    datum: u?.faellig_am ? { wort: ueber ? 'seit' : 'bis', tag: u.faellig_am, ton: ueber ? 'ueber' : 'bald' } : null,
    zeichen: u?.faellig_am ? null : 'festgehalten',
    verb: ueber ? 'Prüfen' : null,
  };
}

/**
 * Die Liste nach der nächsten Prüfung (§6.5): Vorgaben (jährlich überprüft) und Nachweise (aufbewahrt) getrennt, die
 * nächste Prüfung zuerst, Entwürfe oben; Aufgehobene leise am Ende. Gezählt wird, was gilt, was überfällig ist und was
 * als Entwurf wartet - nie ein Anteil (G4).
 */
export function dokumenteBild(liste: readonly EnergiemanagementDokumentKurz[]): DokumenteBild {
  const offen = liste.filter((d) => d.zustand !== 'aufgehoben');
  const frist = (d: EnergiemanagementDokumentKurz) => (d.zustand === 'entwurf' ? '0000' : (d.ueberpruefung?.faellig_am ?? '9999'));
  const nachFrist = (a: EnergiemanagementDokumentKurz, b: EnergiemanagementDokumentKurz) =>
    frist(a).localeCompare(frist(b)) || a.titel.localeCompare(b.titel, 'de');
  const vorgaben = offen.filter((d) => d.klasse === 'vorgabe').sort(nachFrist).map(zeile);
  const nachweise = offen
    .filter((d) => d.klasse === 'nachweis')
    .sort((a, b) => Number(b.zustand === 'entwurf') - Number(a.zustand === 'entwurf') || a.titel.localeCompare(b.titel, 'de'))
    .map(zeile);
  return {
    vorgaben,
    nachweise,
    aufgehoben: liste.filter((d) => d.zustand === 'aufgehoben').map(zeile),
    gelten: liste.filter((d) => d.zustand === 'gueltig').length,
    ueberfaellig: [...vorgaben].filter((z) => z.verb === 'Prüfen').length,
    entwuerfe: liste.filter((d) => d.zustand === 'entwurf').length,
  };
}

/** Die Status-Zeile der Liste: „● 5 gelten“; Überfälliges und wartende Entwürfe zuerst, die Gültigen leise dahinter. */
export function listenStatus(b: Pick<DokumenteBild, 'gelten' | 'ueberfaellig' | 'entwuerfe'>): { zeichen: ZeichenArt; text: string; sub: string | null; warn: boolean } {
  const gelten = b.gelten === 1 ? '1 gilt' : `${b.gelten} gelten`;
  if (b.ueberfaellig > 0) return { zeichen: 'ueber', text: `${MEHRZAHL(b.ueberfaellig, 'Prüfung', 'Prüfungen')} überfällig`, sub: `· ${gelten}`, warn: true };
  if (b.entwuerfe > 0) return { zeichen: 'entwurf', text: `${MEHRZAHL(b.entwuerfe, 'Entwurf wartet', 'Entwürfe warten')}`, sub: `· ${gelten}`, warn: false };
  return { zeichen: b.gelten > 0 ? 'festgehalten' : 'offen', text: b.gelten > 0 ? gelten : KEIN_DOKUMENT, sub: null, warn: false };
}

// ------------------------------------------------------------------ Seite eines Dokuments

/** Die Bekanntmachungen einer Fassung, je Tag und Kreis eine Mitteilung mit ihren Wegen (DK6). */
export interface Bekanntmachung {
  fassung: number;
  am: string;
  kreis: string;
  wege: string[];
  person: string | null;
}

export const WEG_WORT: Record<string, string> = {
  aushang: 'Aushang',
  intranet: 'Intranet',
  unterweisung: 'Unterweisung',
  besprechung: 'Besprechung',
  e_mail: 'E-Mail',
  weiterer: 'weiterer Weg',
};

export function bekanntmachungen(eintraege: readonly EnergiemanagementDokumentEintrag[]): Bekanntmachung[] {
  const aus: Bekanntmachung[] = [];
  for (const e of eintraege) {
    if (e.art !== 'bekannt_gemacht' || !e.am || e.fassung === null) continue;
    const weg = e.weg === 'weiterer' ? (e.weg_wortlaut ?? WEG_WORT.weiterer) : (WEG_WORT[e.weg ?? ''] ?? e.weg ?? '');
    const da = aus.find((b) => b.fassung === e.fassung && b.am === e.am && b.kreis === (e.kreis ?? ''));
    if (da) {
      if (weg && !da.wege.includes(weg)) da.wege.push(weg);
    } else {
      aus.push({ fassung: e.fassung, am: e.am, kreis: e.kreis ?? '', wege: weg ? [weg] : [], person: e.person?.name ?? null });
    }
  }
  return aus.sort((a, b) => b.am.localeCompare(a.am));
}

/** Die Wege als Aufzählung: „Aushang und Intranet“. */
export const wegeText = (wege: readonly string[]) =>
  wege.length <= 1 ? (wege[0] ?? '') : `${wege.slice(0, -1).join(', ')} und ${wege[wege.length - 1]}`;

/** Die Bekanntmachung zeigen wir als Stufe, wo sie zur Art gehört (Energiepolitik) oder wo es schon eine gibt. */
const mitBekannt = (d: EnergiemanagementDokument) => d.art === 'energiepolitik' || d.eintraege.some((e) => e.art === 'bekannt_gemacht');

/**
 * Die Stufen eines Dokuments (§6.5): „Entwurf · Freigegeben · Bekannt · Prüfen“ mit Tag. Ein Verweis hat keinen Entwurf
 * im Portal (er IST das Original), ein Nachweis keine Prüfung (DK5); „Bekannt“ nur bei der Energiepolitik oder wo schon
 * einmal bekannt gemacht wurde. Nichts wird geraten: eine Stufe ohne Tag bleibt ohne Tag.
 */
export function stufen(d: EnergiemanagementDokument): Stufe[] {
  if (d.zustand === 'aufgehoben') return [];
  const g = gueltigeFassung(d);
  const o = offeneFassung(d);
  if (!g) {
    if (!o) return [];
    if (o.status === 'beantragt') {
      return [
        { titel: 'Entwurf', datum: TAG(o.eingetragen.am), zustand: 'done' },
        { titel: 'Beantragt', datum: TAG(o.freigabe?.am ?? null) || null, zustand: 'an' },
        { titel: 'Bestätigt', datum: 'zweite Person', zustand: 'offen' },
      ];
    }
    return [
      { titel: 'Entwurf', datum: TAG(o.eingetragen.am), zustand: 'an' },
      { titel: 'Freigegeben', datum: null, zustand: 'offen' },
    ];
  }
  const s: Stufe[] = [];
  if (g.form === 'wortlaut') s.push({ titel: 'Entwurf', datum: TAG(g.eingetragen.am), zustand: 'done' });
  s.push({ titel: 'Freigegeben', datum: TAG(g.entschieden_am), zustand: 'done' });
  if (mitBekannt(d)) {
    const b = bekanntmachungen(d.eintraege).find((x) => x.fassung === g.nr);
    s.push(b ? { titel: 'Bekannt', datum: TAG(b.am), zustand: 'done' } : { titel: 'Bekannt', datum: null, zustand: d.klasse === 'vorgabe' ? 'offen' : 'an' });
  }
  const u = d.ueberpruefung;
  if (d.klasse === 'vorgabe' && u?.faellig_am) {
    const ueber = u.tage !== null && u.tage > 0;
    s.push({ titel: 'Prüfen', datum: `${ueber ? 'seit' : 'bis'} ${TAG(u.faellig_am)}`, zustand: ueber || !s.some((x) => x.zustand !== 'done') ? 'an' : 'offen' });
  }
  return s;
}

/** Der Hauptknopf einer Seite - nur mit Anlass (§3.3): Freigeben, Bestätigen, Prüfen, Bekannt machen; sonst nichts. */
export type Anlass =
  | { art: 'freigeben'; fassung: number }
  | { art: 'bestaetigen'; fassung: number }
  | { art: 'antrag_wartet'; fassung: number }
  | { art: 'pruefen' }
  | null;

export interface SeitenStatus {
  zeichen: ZeichenArt;
  text: string;
  sub: string | null;
  warn: boolean;
  /** Grau, ohne Knöpfe: aufgehoben. */
  still: boolean;
}

/**
 * Die Status-Zeile der Seite (§6.5, §6.13): „● gilt · Robert Falk“; „◎ Fassung 3 wartet auf Freigabe“; bei Vier-Augen
 * „◎ Fassung 3 wartet auf Bestätigung“; „○ aufgehoben seit …“ grau. Eine überfällige Prüfung steht im Warnton.
 */
export function seitenStatus(d: EnergiemanagementDokument): SeitenStatus {
  const g = gueltigeFassung(d);
  const o = offeneFassung(d);
  if (d.zustand === 'aufgehoben') {
    const auf = d.eintraege.find((e) => e.art === 'aufgehoben');
    return { zeichen: 'offen', text: `aufgehoben${auf?.am ? ` seit ${TAG(auf.am)}` : ''}`, sub: null, warn: false, still: true };
  }
  // Welche Fassung gilt, sagt schon die Kurzzeile unter dem Titel („Fassung 2“) - die Antwort bleibt ein Fakt (§6.5).
  if (o?.status === 'beantragt') return { zeichen: 'entwurf', text: `Fassung ${o.nr} wartet auf Bestätigung`, sub: null, warn: false, still: false };
  if (o) return { zeichen: 'entwurf', text: `Fassung ${o.nr} wartet auf Freigabe`, sub: null, warn: false, still: false };
  if (!g) return { zeichen: 'offen', text: 'noch keine Fassung', sub: null, warn: false, still: false };
  const u = d.ueberpruefung;
  const von = g.entschieden_von?.name ?? null;
  if (d.klasse === 'vorgabe' && u?.tage !== null && u?.tage !== undefined && u.tage > 0) {
    return { zeichen: 'ueber', text: `Prüfung seit ${TAG(u.faellig_am)}`, sub: '· gilt', warn: true, still: false };
  }
  return { zeichen: 'festgehalten', text: d.klasse === 'nachweis' ? 'festgehalten' : 'gilt', sub: von ? `· ${von}` : null, warn: false, still: false };
}

/**
 * Der Anlass der Seite: ein Entwurf wartet auf Freigabe; ein Antrag auf eine zweite Person (wer beantragt hat, sieht
 * keinen Knopf - `antrag_wartet`); eine Prüfung ist überfällig. Sonst kein Hauptknopf, alles andere steht im Menü.
 */
export function anlass(d: EnergiemanagementDokument, selbstSub: string | null): Anlass {
  if (d.zustand === 'aufgehoben') return null;
  const o = offeneFassung(d);
  if (o?.status === 'beantragt') {
    const urheber = !!selbstSub && (o.freigabe?.akteur.sub === selbstSub || o.eingetragen.akteur.sub === selbstSub);
    return urheber ? { art: 'antrag_wartet', fassung: o.nr } : { art: 'bestaetigen', fassung: o.nr };
  }
  if (o) return { art: 'freigeben', fassung: o.nr };
  const u = d.ueberpruefung;
  if (d.klasse === 'vorgabe' && d.gueltige_fassung !== null && u?.tage !== null && u?.tage !== undefined && u.tage > 0) return { art: 'pruefen' };
  return null;
}

/** Die Kurzzeile unter dem Titel: „Fassung 2“, beim Verweis „Fassung 1 · Verweis“; ohne Fassung „Entwurf“. */
export function kurzzeile(d: EnergiemanagementDokument): string {
  const g = gueltigeFassung(d) ?? offeneFassung(d) ?? d.fassungen[d.fassungen.length - 1] ?? null;
  if (!g) return 'Entwurf';
  return g.form === 'verweis' ? `Fassung ${g.nr} · Verweis` : `Fassung ${g.nr}`;
}

// ------------------------------------------------------------------ Neu in Fassung n

/** Abkürzungen und Ordnungszahlen, nach denen kein Satz endet („z. B.“, „Nr.“, „Rev.“, „am 1. Januar“). */
const KEIN_SATZENDE = /(?:^|[\s(])(?:z|B|bzw|ca|Nr|vgl|ggf|inkl|u|a|d|h|o|s|Abs|Art|Rev|Dr|St|S|Tel|ff)\.$|\d\.$/u;

/** Die Sätze eines Wortlauts: an Satzende mit Leerraum getrennt, Absätze bleiben Absätze. */
export function saetze(text: string): string[][] {
  return text
    .split(/\n\s*\n|\r?\n/)
    .map((absatz) => absatz.trim())
    .filter(Boolean)
    .map((absatz) => {
      const stuecke = absatz.split(/(?<=[.!?…])\s+(?=[„"(\p{Lu}0-9])/u).map((s) => s.trim()).filter(Boolean);
      const aus: string[] = [];
      for (const s of stuecke) {
        if (aus.length && KEIN_SATZENDE.test(aus[aus.length - 1])) aus[aus.length - 1] = `${aus[aus.length - 1]} ${s}`;
        else aus.push(s);
      }
      return aus;
    });
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * „Neu in Fassung n“ (§6.5, Q9): die Sätze der Fassung, die es in der vorigen nicht gab, hinterlegt - der Rest steht
 * unverändert. Gestrichene Sätze zeigt die Fassungs-Zeitleiste, nicht diese Karte.
 */
export function wortlautMitNeuem(alt: string | null, neu: string): { absaetze: { text: string; neu: boolean }[][]; neueSaetze: string[] } {
  const vorher = new Set((alt ? saetze(alt).flat() : []).map(norm));
  const neueSaetze: string[] = [];
  const absaetze = saetze(neu).map((absatz) =>
    absatz.map((s, i) => {
      const istNeu = alt !== null && !vorher.has(norm(s));
      if (istNeu) neueSaetze.push(s);
      return { text: i < absatz.length - 1 ? `${s} ` : s, neu: istNeu };
    }),
  );
  return { absaetze, neueSaetze };
}

/** Die vorige freigegebene Fassung (die, die `f` abgelöst hat) - die Grundlage von „Neu in Fassung n“. */
export function vorigeFassung(d: Pick<EnergiemanagementDokument, 'fassungen'>, f: EnergiemanagementFassung): EnergiemanagementFassung | null {
  return (
    [...d.fassungen]
      .filter((x) => x.nr < f.nr && (x.status === 'abgeloest' || x.status === 'freigegeben'))
      .sort((a, b) => b.nr - a.nr)[0] ?? null
  );
}

/** Der Grund einer Fassung in höchstens vier Wörtern: „Beschluss 3“; sonst der Anfang der Begründung. Ganz im Blatt. */
export function grundKurz(f: Pick<EnergiemanagementFassung, 'beschluss_kennung' | 'begruendung'>): string | null {
  const b = f.beschluss_kennung?.match(/\/B(\d{1,3})$/);
  if (b) return `Beschluss ${Number(b[1])}`;
  const t = f.begruendung?.trim();
  if (!t) return null;
  const woerter = t.replace(/[.!?]$/, '').split(/\s+/);
  return woerter.length <= 4 ? woerter.join(' ') : `${woerter.slice(0, 4).join(' ')} …`;
}

// ------------------------------------------------------------------ Original, Fassungen, Anwendungsbereich

/** Wo das Original liegt - mit der Fassung, zu der es gehört (Entscheid 10). */
export interface OriginalBild {
  /** Die Fassung, an der das Original festgehalten ist. */
  fassung: number;
  /** Bei einem Verweis ist der Verweis das Original. */
  verweis: boolean;
  ablage: string;
  bezeichnung: string | null;
  kennung: string | null;
  /** „Rev. 4“, „Stand 01.12.2028“ - nur am Verweis. */
  stand: string | null;
  adresse: string | null;
  /** Nur eine `https:`-Adresse wird als Verweis geöffnet; VoltPilot lädt und prüft dort nichts. */
  oeffnen: string | null;
  sha256: string | null;
}

const httpsAdresse = (a: string | null | undefined) => (a && /^https:\/\//i.test(a.trim()) ? a.trim() : null);

function ausVerweis(nr: number, v: EnergiemanagementVerweis): OriginalBild | null {
  if (!v.ablage) return null;
  const stand = v.fassungsangabe ?? (v.datum ? `Stand ${TAG(v.datum)}` : null);
  return { fassung: nr, verweis: true, ablage: v.ablage, bezeichnung: v.bezeichnung ?? null, kennung: v.kennung ?? null, stand, adresse: v.adresse ?? null, oeffnen: httpsAdresse(v.adresse), sha256: v.sha256 ?? null };
}

function ausBeleg(nr: number, b: EnergiemanagementBeleg): OriginalBild | null {
  if (!b.ablage) return null;
  return { fassung: nr, verweis: false, ablage: b.ablage, bezeichnung: b.bezeichnung ?? null, kennung: b.kennung ?? null, stand: null, adresse: b.adresse ?? null, oeffnen: httpsAdresse(b.adresse), sha256: b.sha256 ?? null };
}

/**
 * Das Original zur gezeigten Fassung (Entscheid 10): am Verweis der Verweis selbst; am Wortlaut das Original dieser
 * Fassung, sonst das der jüngsten früheren Fassung mit Original - das Original am Dokument gehört zu Fassung 1, an der
 * es beim Anlegen festgehalten wurde. Ohne Angabe `null` (es liegt nur hier).
 */
export function originalBild(d: Pick<EnergiemanagementDokument, 'fassungen' | 'beleg'>, f: EnergiemanagementFassung | null): OriginalBild | null {
  if (!f) return null;
  if (f.form === 'verweis') return f.verweis ? ausVerweis(f.nr, f.verweis) : null;
  const frueher = [...d.fassungen].filter((x) => x.nr <= f.nr && x.form === 'wortlaut').sort((a, b) => b.nr - a.nr);
  for (const x of frueher) {
    const o = x.original ?? null;
    if (o?.ablage) return ausBeleg(x.nr, o);
    if (x.nr === 1 && d.beleg?.ablage) return ausBeleg(1, d.beleg);
  }
  return null;
}

/** Eine Zeile der Fassungs-Zeitleiste: neueste zuerst, „gilt“ in Navy, „überholt“ bleibt lesbar (Q12). */
export interface FassungsZeile {
  nr: number;
  wort: string;
  ton: 'gilt' | 'still' | 'offen' | 'warn';
  datum: string | null;
  person: string | null;
  grund: string | null;
}

const FASSUNG_WORT: Record<EnergiemanagementFassung['status'], string> = {
  freigegeben: 'gilt',
  abgeloest: 'überholt',
  entwurf: 'Entwurf',
  beantragt: 'beantragt',
  abgelehnt: 'abgelehnt',
};

export function fassungsZeitleiste(d: Pick<EnergiemanagementDokument, 'fassungen' | 'zustand'>): FassungsZeile[] {
  return [...d.fassungen]
    .sort((a, b) => b.nr - a.nr)
    .map((f) => ({
      nr: f.nr,
      wort: d.zustand === 'aufgehoben' && f.status === 'freigegeben' ? 'aufgehoben' : FASSUNG_WORT[f.status],
      ton: f.status === 'freigegeben' && d.zustand !== 'aufgehoben' ? 'gilt' : f.status === 'abgelehnt' ? 'warn' : f.status === 'entwurf' || f.status === 'beantragt' ? 'offen' : 'still',
      datum: TAG(f.entschieden_am ?? f.eingetragen.am) || null,
      person: f.entschieden_von?.name ?? f.eingetragen.akteur.name ?? null,
      grund: f.status === 'abgelehnt' ? (f.ablehnung_begruendung ?? null) : (f.begruendung ?? null),
    }));
}

/** Eine Zeile im „Verlauf“ eines Dokuments: Tag, was geschah, wer - und warum, wo es einen Grund gibt. */
export interface VerlaufZeile {
  /** ISO-Tag zum Sortieren (ein Zeitpunkt mit seinem Tag in Berlin). */
  tag: string;
  text: string;
}

/**
 * Der Verlauf eines Dokuments (Review r1, P2-6): was die alte Seite als „Einträge“ führte - Bekanntmachungen mit Kreis,
 * Wegen und Person, „geprüft, bleibt“ und das Aufheben mit Grund, Kommentare - und dazu, was mit den Fassungen geschah
 * (freigegeben, beantragt, abgelehnt mit Grund). Neueste zuerst; nichts geraten: ohne Tag keine Zeile.
 */
export function verlauf(d: Pick<EnergiemanagementDokument, 'fassungen' | 'eintraege'>): VerlaufZeile[] {
  const z: VerlaufZeile[] = [];
  const zeile = (tag: string | null | undefined, ...teile: (string | null | undefined)[]) => {
    const t = tagIso(tag);
    if (t) z.push({ tag: t, text: teile.filter((x): x is string => !!x && !!x.trim()).join(' · ') });
  };
  for (const f of d.fassungen) {
    if (f.status === 'freigegeben' || f.status === 'abgeloest') zeile(f.entschieden_am, `Fassung ${f.nr} freigegeben`, f.entschieden_von?.name);
    if (f.status === 'beantragt') zeile(f.freigabe?.am ?? f.entschieden_am, `Fassung ${f.nr} beantragt`, f.entschieden_von?.name);
    if (f.status === 'abgelehnt') zeile(f.zweite_person?.am, `Fassung ${f.nr} abgelehnt`, f.zweite_person?.akteur.name, f.ablehnung_begruendung);
  }
  for (const b of bekanntmachungen(d.eintraege)) zeile(b.am, `Fassung ${b.fassung} bekannt gemacht`, b.kreis, wegeText(b.wege), b.person);
  for (const e of d.eintraege) {
    if (e.art === 'geprueft_bleibt') zeile(e.am, 'Geprüft, bleibt', e.entschieden_von?.name, e.begruendung);
    if (e.art === 'aufgehoben') zeile(e.am, 'Aufgehoben', e.entschieden_von?.name, e.begruendung);
    if (e.art === 'kommentar') zeile(e.am ?? e.eingetragen.am, 'Kommentar', e.eingetragen.akteur.name, e.kommentar);
  }
  return z.sort((a, b) => b.tag.localeCompare(a.tag));
}

/** Der Anwendungsbereich in einer Zeile: „2 Standorte · Strom, Gas“. */
export function geltungKurz(f: EnergiemanagementFassung | null): string | null {
  const a = f?.anwendungsbereich;
  if (!a) return null;
  return geltungText(a.standorte.length, a.traeger);
}

/** „2 Standorte · Strom, Gas“ aus Zahl und Trägern - auch für eine Geltung, die erst gewählt wird. */
export const geltungText = (standorte: number, traeger: readonly string[]): string =>
  [MEHRZAHL(standorte, 'Standort', 'Standorte'), traeger.join(', ')].filter(Boolean).join(' · ');

// ------------------------------------------------------------------ Erklär-Blätter (Entscheid 24; Normwort nur im Feld `fachwort`, Entscheid 18)

/** „Was ist eine Fassung?“ mit dem Beispiel aus dem eigenen Dokument. */
export function fassungErklaerung(d: Pick<EnergiemanagementDokument, 'fassungen' | 'gueltige_fassung' | 'titel'>): Erklaerung {
  const g = gueltigeFassung(d);
  return {
    frage: 'Was ist eine Fassung?',
    klartext: 'Ein Stand eines Dokuments; es gilt immer genau eine.',
    beiIhnen: g ? `${d.titel}: Fassung ${g.nr} gilt seit ${TAG(g.entschieden_am)}${g.nr > 1 ? `, Fassung ${g.nr - 1} ist überholt` : ''}.` : null,
    nichtVerwechseln: 'Nicht der Stand eines Berichts.',
    fachwort: 'Revisionsstand',
  };
}

/** „Was ist eine Vorgabe, was ein Nachweis?“ mit je einem Beispiel aus der eigenen Liste. */
export function dokumenteErklaerung(liste: readonly Pick<EnergiemanagementDokumentKurz, 'klasse' | 'titel' | 'zustand'>[]): Erklaerung {
  const vorgabe = liste.find((d) => d.klasse === 'vorgabe' && d.zustand === 'gueltig');
  const nachweis = liste.find((d) => d.klasse === 'nachweis' && d.zustand === 'gueltig');
  const bsp = [vorgabe ? `Vorgabe: ${vorgabe.titel}.` : null, nachweis ? `Nachweis: ${nachweis.titel}.` : null].filter(Boolean).join(' ');
  return {
    frage: 'Vorgabe oder Nachweis?',
    klartext: 'Eine Vorgabe sagt, wie Sie es machen, und wird jährlich überprüft; ein Nachweis belegt, dass etwas geschehen ist.',
    beiIhnen: bsp || null,
    nichtVerwechseln: 'Ein Bericht ist keines von beiden.',
    fachwort: 'Dokument / Aufzeichnung',
  };
}

/** „Wo liegt das Original?“ - das Erklär-Blatt am Original (Entscheid 9: keine Dateien). */

// ------------------------------------------------------------------ Blätter

/** Der Tag davor (ISO), für „Gestern“ - Kalendertage, ohne Zeitzone. */
export function tagDavor(iso: string): string {
  const [j, m, t] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(j, m - 1, t));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** „Heute, 30.04.“ - der Tag der Route als Chip. */
export const heuteLabel = (heute: string) => `Heute, ${heute.slice(8, 10)}.${heute.slice(5, 7)}.`;

/** Die Jahreszahl der nächsten Prüfung nach „geprüft, bleibt“ heute: heute plus der Rhythmus des Dokuments. */
export function naechstePruefungJahr(heute: string, monate: number | null): string | null {
  if (!monate) return null;
  const j = Number(heute.slice(0, 4));
  const m = Number(heute.slice(5, 7)) - 1 + monate;
  return String(j + Math.floor(m / 12));
}

/**
 * Wem bisher bekannt gemacht wurde - die Kreise dieses Dokuments, jüngster zuerst, höchstens zwei; dazu „Alle
 * Mitarbeitenden“, wenn er noch nicht dabei ist. So stehen die eigenen Wörter des Kunden als Chips da.
 */
export function kreisVorschlaege(eintraege: readonly EnergiemanagementDokumentEintrag[]): string[] {
  const kreise = bekanntmachungen(eintraege).map((b) => b.kreis).filter(Boolean);
  const eigene = [...new Set(kreise)].slice(0, 2);
  return eigene.some((k) => /^alle\s+mitarbeitenden/i.test(k)) ? eigene : [...eigene, 'Alle Mitarbeitenden'];
}

/** Die Frage der Überprüfung mit der Fassungsangabe des Kunden: „Gilt Rev. 4 noch?“, sonst „Gilt Fassung 2 noch?“. */
export function ueberpruefungFrage(f: EnergiemanagementFassung | null): string {
  if (!f) return 'Gilt das Dokument noch?';
  const angabe = f.verweis?.fassungsangabe?.match(/^(Rev\.?\s*\S+|Version\s+\S+|Stand\s+\S+)/i)?.[1];
  return `Gilt ${angabe ?? `Fassung ${f.nr}`} noch?`;
}

/** Der Ort in einem Wort für die Zeile: „QM-Laufwerk, Ordner Energiemanagement/Politik“ → „QM-Laufwerk“. */
export const ortKurz = (ablage: string) => {
  const erst = ablage.split(/,\s*/)[0].trim();
  return erst.length > 28 ? `${erst.slice(0, 26)} …` : erst;
};
