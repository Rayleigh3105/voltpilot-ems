/**
 * Nachweisen, Konzept n1 Runde 2 (§6.6, Entscheid 17, PR 4): das reine Bild des Reiters „Audits“ (mit den
 * Feststellungen), der Seite eines internen Audits und der Seite einer Feststellung - Status zuerst, „Als Nächstes“,
 * „Was daraus wurde“ als Zeilen, Stufen bis zur Wirksamkeit, Einträge als Datumsblöcke mit Kürzel.
 *
 * **Hier wird nichts entschieden:** Frist, Lage („seit n Tagen fällig“), das nächste Audit, Vier-Augen und ob die
 * Wirksamkeit prüfbar ist, kommen von der Route oder aus `auditFeststellung.ts`. Hier stehen nur Wörter und die Ordnung
 * der Zeilen. Gezählt wird nur Offenes (G4): kein Satz über das Ganze, kein „erfüllt“.
 */
import type {
  Feststellung,
  FeststellungEintrag,
  FeststellungMassnahme,
  FeststellungStand,
  FeststellungVierAugen,
  InternesAudit,
  InternesAuditAenderung,
  InternesAuditprogramm,
  Massnahme,
} from './api';
import type { Erklaerung } from './components/nachweisen/erklaerung';
import type { DatumTon, ZustandArt } from './components/nachweisen/nwBild';
import type { Stufe } from './components/nachweisen/Stufen';
import { wirksamkeitPruefbar } from './auditFeststellung';
import { tagText } from './energiemanagementPortal';
import { UEMS_MASSNAHME_ZUSTAENDE } from './glossar';
import { tagDesAugenblicks } from './routenUhr';
import { aufzaehlung } from './uemsZustand';

/** Ein Datumsblock: kleines Wort, Tag (ISO), Ton. */
export type Datum = { wort: string; tag: string; ton: DatumTon };
/** Eine Status-Zeile: Zeichen, Wort, leise ein Fakt; Warnton nur für Abgelaufenes. */
export type Status = { zeichen: ZustandArt; text: string; sub: string | null; warn: boolean };

// ------------------------------------------------------------------ Wörter

export const AUDITS = 'Audits';
export const FESTSTELLUNGEN = 'Feststellungen';
export const ALLE_AUDITS = 'Alle Audits';
export const WAS_DARAUS_WURDE = 'Was daraus wurde';
export const EINTRAEGE = 'Einträge';
export const KNOPF_PLANEN = 'Planen';
export const KNOPF_OEFFNEN = 'Öffnen';
export const KNOPF_FESTHALTEN = 'Festhalten';
export const NOCH_KEIN_EINTRAG = 'Noch kein Eintrag';
export const NOCH_KEIN_AUDIT = 'Noch kein internes Audit';
export const NOCH_KEINE_FESTSTELLUNG = 'Keine Feststellung';
export const PRUEFEN_NACH_UMSETZUNG = 'Prüfen nach der Umsetzung';
export const VERLAUF = 'Verlauf';

/** „Selbstprüfung, jährlich“: die Kurzzeile des Reiters aus dem Rhythmus der Einstellung. */
export function rhythmusWort(monate: number): string {
  if (monate === 12) return 'jährlich';
  if (monate === 6) return 'halbjährlich';
  if (monate === 3) return 'vierteljährlich';
  if (monate === 1) return 'monatlich';
  if (monate === 24) return 'alle zwei Jahre';
  return `alle ${monate} Monate`;
}
export const auditsKurzzeile = (monate: number) => `Selbstprüfung, ${rhythmusWort(monate)}`;

const mehrzahl = (n: number, eins: string, viele: string) => `${n} ${n === 1 ? eins : viele}`;
/** „22.01.“ - Tag und Monat, für Zeilen, in denen das Jahr schon steht. */
export const tagMonat = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : '');

/**
 * Der Name eines Audits, wie die Person ihn vergeben hat - am Handy bis zum ersten Doppelpunkt („Internes Audit 2029:
 * Bezugsbasen, …“ → „Internes Audit 2029“); der volle Titel steht auf der Seite unter „Geprüft“.
 */
export function auditName(a: Pick<InternesAudit, 'titel'>): string {
  const i = a.titel.indexOf(':');
  const vorn = i > 0 ? a.titel.slice(0, i).trim() : '';
  return vorn && a.titel.slice(i + 1).trim() ? vorn : a.titel.trim();
}

/** Wer prüft, als Kurzzeile der Seite: „Claudia Berger · Controlling“; mehrere Namen ohne Funktion. */
export function auditorenZeile(a: Pick<InternesAudit, 'auditoren'>): string {
  if (a.auditoren.length === 1) return [a.auditoren[0].name, a.auditoren[0].funktion].filter(Boolean).join(' · ');
  return a.auditoren.map((p) => p.name).join(', ');
}

/** Wie viele Themen geprüft wurden („Bezugsbasen, Energieziel, Maßnahmen und Grundlagen“ → 4), aus dem Wortlaut. */
export function themenZahl(was: string): number {
  return was
    .split(/,|;|\s+und\s+|\n/u)
    .map((t) => t.trim())
    .filter(Boolean).length;
}

// ------------------------------------------------------------------ Reiter „Audits“

/** Die Status-Zeile des Reiters: nur Offenes zählt - „keine Feststellung offen“ oder „2 Feststellungen offen · 1 überfällig“. */
export function auditsStatus(feststellungen: Pick<Feststellung, 'zustand' | 'lage'>[]): Status {
  const offen = feststellungen.filter((f) => f.zustand === 'offen');
  if (!offen.length) return { zeichen: 'done', text: 'keine Feststellung offen', sub: null, warn: false };
  const ueber = offen.filter((f) => (f.lage.tage ?? 0) > 0).length;
  const text = `${mehrzahl(offen.length, 'Feststellung', 'Feststellungen')} offen`;
  return ueber
    ? { zeichen: 'ueber', text, sub: `· ${ueber} überfällig`, warn: true }
    : { zeichen: 'laeuft', text, sub: null, warn: false };
}

export type AuditNaechstes = {
  frist: Datum | null;
  titel: string;
  warum: string | null;
  /** `planen` öffnet „Audit planen“, `oeffnen` die Seite des Audits. */
  knopf: 'planen' | 'oeffnen';
  auditId: string | null;
};

/**
 * „Als Nächstes“ im Reiter: ein durchgeführtes, noch nicht abgeschlossenes Audit; sonst das nächste geplante; sonst das
 * nächste fällige (Frist von der Route, IA4) mit der Person der Aufgabe „Interne Audits“; ohne durchgeführtes Audit das
 * erste - ohne Frist, denn ohne Durchführung nennt VoltPilot keine.
 */
export function auditNaechstes(p: InternesAuditprogramm, zustaendig: string | null): AuditNaechstes {
  const heute = p.tag;
  const nachTag = (x: string | null, y: string | null) => (x ?? '').localeCompare(y ?? '');
  const laufend = p.audits.filter((a) => a.zustand === 'durchgefuehrt').sort((a, b) => nachTag(a.durchgefuehrt_am, b.durchgefuehrt_am))[0];
  if (laufend) {
    return {
      frist: laufend.durchgefuehrt_am ? { wort: 'am', tag: laufend.durchgefuehrt_am, ton: 'bald' } : null,
      titel: `${auditName(laufend)} abschließen`,
      warum: laufend.auditoren.map((x) => x.name).join(', ') || null,
      knopf: 'oeffnen',
      auditId: laufend.id,
    };
  }
  const geplant = p.audits.filter((a) => a.zustand === 'geplant').sort((a, b) => nachTag(a.termin, b.termin))[0];
  if (geplant) {
    const vorbei = geplant.termin < heute;
    return {
      frist: { wort: vorbei ? 'seit' : 'am', tag: geplant.termin, ton: vorbei ? 'ueber' : 'bald' },
      titel: auditName(geplant),
      warum: geplant.auditoren.map((x) => x.name).join(', ') || null,
      knopf: 'oeffnen',
      auditId: geplant.id,
    };
  }
  const n = p.naechstes;
  if (n.faellig_am) {
    return {
      frist: { wort: (n.tage ?? 0) > 0 ? 'seit' : 'bis', tag: n.faellig_am, ton: (n.tage ?? 0) > 0 ? 'ueber' : 'bald' },
      titel: `Internes Audit ${n.faellig_am.slice(0, 4)}`,
      warum: zustaendig,
      knopf: 'planen',
      auditId: null,
    };
  }
  return { frist: null, titel: 'Erstes internes Audit', warum: zustaendig, knopf: 'planen', auditId: null };
}

/** Die Zeile eines Audits im Reiter: Datumsblock, Name, ein Fakt. */
export function auditZeile(a: InternesAudit): { datum: Datum; titel: string; unter: string } {
  const titel = auditName(a);
  if (a.zustand === 'abgeschlossen' || a.zustand === 'durchgefuehrt') {
    const ergebnis = `${mehrzahl(a.hinweise, 'Hinweis', 'Hinweise')} · ${mehrzahl(a.feststellungen.length, 'Feststellung', 'Feststellungen')}`;
    return {
      datum: { wort: '', tag: a.durchgefuehrt_am ?? a.termin, ton: a.zustand === 'abgeschlossen' ? 'erledigt' : 'bald' },
      titel,
      unter: a.zustand === 'abgeschlossen' ? ergebnis : 'durchgeführt',
    };
  }
  if (a.zustand === 'abgesagt') return { datum: { wort: '', tag: a.termin, ton: 'plan' }, titel, unter: 'abgesagt' };
  return { datum: { wort: 'am', tag: a.termin, ton: 'plan' }, titel, unter: 'geplant' };
}

export const ERGEBNIS_KURZ: Record<FeststellungStand['ergebnis'], string> = {
  wirksam: 'wirksam',
  nicht_wirksam: 'nicht wirksam',
  ohne_massnahme: 'ohne Maßnahme',
  zurueckgenommen: 'zurückgenommen',
};

/** Wie eine Feststellung abgeschlossen ist, als Zeile („… am 12.03.2029“; wirksam „seit“). */
const ABGESCHLOSSEN_WORT: Record<FeststellungStand['ergebnis'], string> = {
  wirksam: 'wirksam',
  nicht_wirksam: 'abgeschlossen',
  ohne_massnahme: 'ohne Maßnahme abgeschlossen',
  zurueckgenommen: 'zurückgenommen',
};

/**
 * Die Zeile einer Feststellung: der Wortlaut ist der Titel (auf zwei Zeilen gekürzt); offen mit der Frist als
 * Datumsblock (Warnton erst, wenn sie abgelaufen ist) und der verantwortlichen Person, abgeschlossen mit dem Zeichen
 * ihres Ergebnisses (Haken, zurückgenommen „ohne“ wie unter „Was daraus wurde“) und dem Tag des schließenden Stands:
 * „wirksam seit …“, sonst „… am …“ (Review P4-4: „ohne Maßnahme seit …“ las sich wie „seit … ohne Maßnahme“).
 */
export function feststellungZeile(f: Feststellung): { datum: Datum | null; zeichen: 'done' | 'ohne' | null; titel: string; unter: string } {
  const titel = f.wortlaut.trim();
  if (f.zustand === 'offen') {
    const ueber = (f.lage.tage ?? 0) > 0;
    return { datum: { wort: ueber ? 'seit' : 'bis', tag: f.frist, ton: ueber ? 'ueber' : 'bald' }, zeichen: null, titel, unter: f.verantwortlich.name };
  }
  const was = f.ergebnis ? ABGESCHLOSSEN_WORT[f.ergebnis] : 'abgeschlossen';
  const unter = f.abgeschlossen_am ? `${was} ${f.ergebnis === 'wirksam' ? 'seit' : 'am'} ${tagText(f.abgeschlossen_am)}` : was;
  return { datum: null, zeichen: f.ergebnis === 'zurueckgenommen' ? 'ohne' : 'done', titel, unter };
}

// ------------------------------------------------------------------ Seite eines Audits

export function auditStatus(a: InternesAudit): Status {
  switch (a.zustand) {
    case 'abgeschlossen':
      return { zeichen: 'done', text: 'abgeschlossen', sub: null, warn: false };
    case 'durchgefuehrt':
      return { zeichen: 'laeuft', text: 'durchgeführt', sub: '· noch offen', warn: false };
    case 'abgesagt':
      return { zeichen: 'ohne', text: 'abgesagt', sub: null, warn: false };
    default:
      return { zeichen: 'laeuft', text: 'geplant', sub: `· am ${tagText(a.termin)}`, warn: false };
  }
}

/** Geplant (Tag der Planung) · Durchgeführt · Abgeschlossen; abgesagt endet nach „Geplant“. */
export function auditStufen(a: InternesAudit, verlauf: Pick<InternesAuditAenderung, 'art' | 'zeit'>[]): Stufe[] {
  // Ein Zeitpunkt zählt mit dem Tag in Berlin, nicht dem UTC-Tag (Befund 3, `routenUhr.tagDesAugenblicks`).
  const geplantAm = tagText(tagDesAugenblicks(verlauf.find((v) => v.art === 'audit_geplant')?.zeit ?? a.eingetragen.am));
  const geplant: Stufe = { titel: 'Geplant', datum: geplantAm, zustand: 'done' };
  if (a.zustand === 'abgesagt') {
    const am = tagDesAugenblicks(verlauf.find((v) => v.art === 'audit_abgesagt')?.zeit);
    return [geplant, { titel: 'Abgesagt', datum: am ? tagText(am) : null, zustand: 'aus' }];
  }
  const durch: Stufe =
    a.zustand === 'geplant'
      ? { titel: 'Durchgeführt', datum: `am ${tagText(a.termin)}`, zustand: 'an' }
      : { titel: 'Durchgeführt', datum: tagText(a.durchgefuehrt_am), zustand: 'done' };
  const schluss: Stufe =
    a.zustand === 'abgeschlossen'
      ? { titel: 'Abgeschlossen', datum: tagText(a.abschluss?.am), zustand: 'done' }
      : { titel: 'Abgeschlossen', datum: a.zustand === 'durchgefuehrt' ? 'jetzt' : null, zustand: a.zustand === 'durchgefuehrt' ? 'an' : 'offen' };
  return [geplant, durch, schluss];
}

/** Eine Zeile „Was daraus wurde“: Zeichen, Wort, rechts der Zustand der Folge. */
export type DarausZeile = { art: 'hinweis' | 'feststellung'; titel: string; zeichen: ZustandArt; zustand: string; warn: boolean; ziel: string | null };

/** Der Zustand einer Maßnahme als Zeichen und Wort - überfällig nur mit der Lage der Route (E5). */
export function massnahmeZustand(m: Pick<Massnahme, 'zustand' | 'frist'>): { zeichen: ZustandArt; wort: string; warn: boolean } {
  if (m.zustand === 'geplant') {
    return m.frist?.faellig === 'ueberfaellig'
      ? { zeichen: 'ueber', wort: 'Maßnahme überfällig', warn: true }
      : { zeichen: 'laeuft', wort: 'Maßnahme läuft', warn: false };
  }
  if (m.zustand === 'verworfen') return { zeichen: 'ohne', wort: 'Maßnahme verworfen', warn: false };
  return { zeichen: 'done', wort: `Maßnahme ${UEMS_MASSNAHME_ZUSTAENDE[m.zustand]}`, warn: false };
}

/**
 * „Was daraus wurde“ (Konzept §6.6): je Hinweis eine Zeile mit dem Zustand seiner Maßnahme (aus dem Abschluss des
 * Audits: welcher Hinweis zu welcher Maßnahme wurde), je Feststellung eine Zeile mit ihrem Zustand. `massnahmen` sind
 * die Maßnahmen mit Herkunft dieses Audits (`null`: die Liste ließ sich nicht lesen). Ein Hinweis ohne Maßnahme sagt
 * das nur, wenn es aus diesem Audit keine gibt; was sich nicht zuordnen lässt, bleibt ohne Zustand - unbekannt ist
 * nicht „ohne“.
 */
export function wasDarausWurde(
  a: InternesAudit,
  massnahmen: Pick<Massnahme, 'id' | 'kennzeichen' | 'zustand' | 'frist'>[] | null,
  feststellungen: Feststellung[] | null,
): DarausZeile[] {
  if (a.zustand === 'geplant' || a.zustand === 'abgesagt') return [];
  const zuordnung = (a.abschluss?.kopie?.hinweise ?? []) as { nr?: number; massnahme?: string | null }[];
  const hinweise: DarausZeile[] = Array.from({ length: a.hinweise }, (_, i) => {
    const nr = i + 1;
    const titel = a.hinweise > 1 ? `Hinweis ${nr}` : 'Hinweis';
    // Vor dem Abschluss kennt nur der Abschluss die Zuordnung - eindeutig ist sie, wo ein Hinweis und eine Maßnahme stehen.
    const kz = zuordnung.find((h) => h.nr === nr)?.massnahme ?? (a.hinweise === 1 && massnahmen?.length === 1 ? massnahmen[0].kennzeichen : null);
    const m = kz && massnahmen ? massnahmen.find((x) => x.kennzeichen === kz) : null;
    if (m) {
      const z = massnahmeZustand(m);
      return { art: 'hinweis', titel, zeichen: z.zeichen, zustand: z.wort, warn: z.warn, ziel: m.id };
    }
    if (kz || (massnahmen === null && a.zustand === 'abgeschlossen')) return { art: 'hinweis', titel, zeichen: 'laeuft', zustand: kz ? 'Maßnahme' : '', warn: false, ziel: null };
    if (massnahmen?.length) return { art: 'hinweis', titel, zeichen: 'laeuft', zustand: '', warn: false, ziel: null };
    return { art: 'hinweis', titel, zeichen: 'ohne', zustand: 'ohne Maßnahme', warn: false, ziel: null };
  });
  const fs: DarausZeile[] = a.feststellungen.map((kz, i) => {
    const titel = a.feststellungen.length > 1 ? `Feststellung ${i + 1}` : 'Feststellung';
    const f = feststellungen?.find((x) => x.kennzeichen === kz) ?? null;
    if (!f) return { art: 'feststellung', titel, zeichen: 'laeuft', zustand: '', warn: false, ziel: kz };
    if (f.zustand === 'offen') {
      const ueber = (f.lage.tage ?? 0) > 0;
      return { art: 'feststellung', titel, zeichen: ueber ? 'ueber' : 'laeuft', zustand: ueber ? 'überfällig' : 'offen', warn: ueber, ziel: f.id };
    }
    return {
      art: 'feststellung',
      titel,
      zeichen: f.ergebnis === 'zurueckgenommen' ? 'ohne' : 'done',
      zustand: f.ergebnis ? ERGEBNIS_KURZ[f.ergebnis] : 'abgeschlossen',
      warn: false,
      ziel: f.id,
    };
  });
  return [...hinweise, ...fs];
}

/** „QM-Laufwerk, Ordner Energiemanagement/Audits“ → „QM-Laufwerk“: der Ort als ein Fakt; der volle Ort im Blatt. */
export const ortKurz = (ablage: string | null | undefined) => (ablage ? ablage.split(',')[0].trim() : '');

// ------------------------------------------------------------------ Seite einer Feststellung

/** Die Kurzzeile: „Feststellung · Audit 2029“ - woher sie kommt, in einem Wort. */
export function feststellungHerkunft(f: Pick<Feststellung, 'quelle'>, audit: Pick<InternesAudit, 'termin' | 'durchgefuehrt_am'> | null): string {
  switch (f.quelle.art) {
    case 'internes_audit':
      return audit ? `Feststellung · Audit ${(audit.durchgefuehrt_am ?? audit.termin).slice(0, 4)}` : 'Feststellung · Audit';
    case 'extern':
      return 'Feststellung · von außen';
    case 'managementbewertung':
      return 'Feststellung · Managementbewertung';
    default:
      return 'Feststellung · eigene';
  }
}

/** Was ein offener Antrag will, als Status-Zeile (Review P4-2: nicht immer „Wirksamkeit beantragt“). */
const BEANTRAGT: Record<FeststellungStand['ergebnis'], string> = {
  wirksam: 'Wirksamkeit beantragt',
  nicht_wirksam: '„nicht wirksam“ beantragt',
  ohne_massnahme: 'Abschluss ohne Maßnahme beantragt',
  zurueckgenommen: 'Zurücknahme beantragt',
};

export function feststellungStatus(f: Feststellung, staende: Pick<FeststellungStand, 'status' | 'ergebnis' | 'eingetragen'>[]): Status {
  if (f.zustand === 'abgeschlossen') {
    if (f.ergebnis === 'wirksam') return { zeichen: 'done', text: 'behoben und wirksam', sub: null, warn: false };
    if (f.ergebnis === 'zurueckgenommen') return { zeichen: 'ohne', text: 'zurückgenommen', sub: null, warn: false };
    return { zeichen: 'done', text: 'ohne Maßnahme abgeschlossen', sub: null, warn: false };
  }
  const antrag = staende.find((s) => s.status === 'beantragt');
  if (antrag) return { zeichen: 'laeuft', text: BEANTRAGT[antrag.ergebnis], sub: `· ${antrag.eingetragen.akteur.name}`, warn: false };
  if ((f.lage.tage ?? 0) > 0) return { zeichen: 'ueber', text: 'überfällig', sub: `· seit ${tagText(f.frist)}`, warn: true };
  return { zeichen: 'laeuft', text: 'offen', sub: `· bis ${tagText(f.frist)}`, warn: false };
}

/**
 * Festgestellt · Maßnahme · Umgesetzt · Wirksam (Konzept §6.6): jede Stufe mit ihrem Tag. „Maßnahme“ ist der Tag, an dem
 * die erste Maßnahme angelegt wurde, „Umgesetzt“ der letzte Umsetzungstag, sobald keine mehr geplant ist, „Wirksam“ der
 * Tag des schließenden Stands. Ohne Maßnahme abgeschlossen oder zurückgenommen: zwei Stufen.
 */
export function feststellungStufen(
  f: Feststellung,
  massnahmen: Pick<FeststellungMassnahme, 'zustand' | 'umgesetzt_am'>[],
  angelegt: (string | null)[],
  staende: Pick<FeststellungStand, 'status' | 'ergebnis' | 'am'>[],
): Stufe[] {
  const fest: Stufe = { titel: 'Festgestellt', datum: tagText(f.festgestellt_am), zustand: 'done' };
  if (f.zustand === 'abgeschlossen' && f.ergebnis !== 'wirksam') {
    return [fest, { titel: f.ergebnis === 'zurueckgenommen' ? 'Zurückgenommen' : 'Abgeschlossen', datum: tagText(f.abgeschlossen_am), zustand: 'done' }];
  }
  const ersteMassnahme = angelegt.filter((t): t is string => !!t).sort()[0] ?? null;
  const massnahme: Stufe = massnahmen.length
    ? { titel: 'Maßnahme', datum: ersteMassnahme ? tagText(tagDesAugenblicks(ersteMassnahme) ?? ersteMassnahme.slice(0, 10)) : null, zustand: 'done' }
    : { titel: 'Maßnahme', datum: f.zustand === 'offen' ? 'jetzt' : null, zustand: f.zustand === 'offen' ? 'an' : 'offen' };
  const umgesetztTage = massnahmen
    .map((m) => m.umgesetzt_am)
    .filter((t): t is string => !!t)
    .sort();
  const umgesetztAm = umgesetztTage[umgesetztTage.length - 1];
  const pruefbar = wirksamkeitPruefbar(massnahmen);
  const umgesetzt: Stufe =
    pruefbar || f.zustand === 'abgeschlossen'
      ? { titel: 'Umgesetzt', datum: umgesetztAm ? tagText(umgesetztAm) : null, zustand: 'done' }
      : { titel: 'Umgesetzt', datum: massnahmen.length ? 'jetzt' : null, zustand: massnahmen.length ? 'an' : 'offen' };
  const schluss = staende.find((s) => s.status === 'freigegeben' && s.ergebnis === 'wirksam');
  const wirksam: Stufe =
    f.zustand === 'abgeschlossen'
      ? { titel: 'Wirksam', datum: tagText(f.abgeschlossen_am ?? schluss?.am), zustand: 'done' }
      : pruefbar
        ? { titel: 'Wirksam?', datum: 'jetzt', zustand: 'an' }
        : { titel: 'Wirksam', datum: null, zustand: 'offen' };
  return [fest, massnahme, umgesetzt, wirksam];
}

/** Ein Stand der Wirksamkeit als Menüpunkt: „Stand 1 · wirksam“, „Stand 2 · beantragt“. */
/**
 * Vier-Augen an der Feststellung (FS6, Review P4-2): über einen offenen Antrag entscheidet nur, wen die Route als zweite
 * Person nennt (nie wer beantragt hat, nie wer verantwortlich ist). Ohne Vier-Augen-Liste gilt dieselbe Regel selbst.
 */
export function darfAntragEntscheiden(
  sub: string | null,
  f: Pick<Feststellung, 'verantwortlich'>,
  antrag: Pick<FeststellungStand, 'eingetragen'>,
  vieraugen: Pick<FeststellungVierAugen, 'an' | 'zweite_person'>,
): boolean {
  if (!sub) return false;
  if (vieraugen.an) return vieraugen.zweite_person.some((p) => p.sub === sub);
  return sub !== antrag.eingetragen.akteur.sub && sub !== f.verantwortlich.sub;
}

/** „Entscheiden kann Jonas Wendlinger.“ - für alle, die den Antrag sehen, aber nicht entscheiden; ohne Liste nichts. */
export function entscheidenKann(vieraugen: Pick<FeststellungVierAugen, 'zweite_person'>): string | null {
  const namen = vieraugen.zweite_person.map((p) => p.name);
  if (!namen.length) return null;
  return `Entscheiden ${namen.length === 1 ? 'kann' : 'können'} ${aufzaehlung(namen)}.`;
}

export const standMenue = (s: Pick<FeststellungStand, 'nr' | 'status' | 'ergebnis'>) =>
  `Stand ${s.nr} · ${s.status === 'freigegeben' ? ERGEBNIS_KURZ[s.ergebnis] : s.status === 'beantragt' ? 'beantragt' : 'abgelehnt'}`;

/** Ein Eintrag in einem Wort: „Sofort behoben“, „Ursache“, „Ähnliche Fälle“, „Kommentar“ - der Wortlaut im Blatt. */
export const EINTRAG_KURZ: Record<FeststellungEintrag['art'], string> = {
  behebung: 'Sofort behoben',
  ursache_aussage: 'Ursache',
  aehnliche_faelle: 'Ähnliche Fälle',
  kommentar: 'Kommentar',
};

/** Die Vorgabe als ein Fakt: der Titel des Dokuments, sonst „Wortlaut“; der volle Wortlaut im Blatt. */
export function vorgabeKurz(v: Feststellung['vorgabe'], dokumentTitel: string | null): string {
  if (v.dokument_id) return dokumentTitel ?? v.dokument ?? 'Dokument';
  return v.wortlaut ? 'Wortlaut' : '';
}

// ------------------------------------------------------------------ Erklärungen (Entscheid 24)

/** „Was ist ein internes Audit?“ - mit dem letzten durchgeführten Audit als Beispiel, ohne Daten ohne Beispiel. */
export function erklaerungAudit(audits: InternesAudit[]): Erklaerung {
  const letztes = audits
    .filter((a) => a.durchgefuehrt_am)
    .sort((a, b) => (b.durchgefuehrt_am ?? '').localeCompare(a.durchgefuehrt_am ?? ''))[0];
  const p = letztes?.auditoren[0];
  return {
    frage: 'Was ist ein internes Audit?',
    klartext: 'Jemand aus Ihrem Unternehmen prüft, ob Ihr Energiemanagement läuft, wie Sie es festgelegt haben.',
    beiIhnen: letztes && p ? `${p.name}${p.funktion ? ` (${p.funktion})` : ''} am ${tagText(letztes.durchgefuehrt_am)}.` : null,
    nichtVerwechseln: 'Kein Audit von außen.',
    fachwort: 'internes Audit',
  };
}

/**
 * „Was ist eine Feststellung?“ - das Normwort fehlt hier, solange der Sprach-Wächter die Ausnahme für `fachwort`
 * (Entscheid 18) noch nicht kennt: es enthält ein Wort, das der Wächter auf jeder Fläche sperrt.
 */
export function erklaerungFeststellung(f: Pick<Feststellung, 'kennzeichen' | 'festgestellt_am'> | null): Erklaerung {
  return {
    frage: 'Was ist eine Feststellung?',
    klartext: 'Etwas läuft nicht so, wie Sie es sich vorgenommen haben; es wird behoben, und eine Person prüft, ob es wirkt.',
    beiIhnen: f ? `${f.kennzeichen}, festgestellt am ${tagText(f.festgestellt_am)}.` : null,
    nichtVerwechseln: 'Keine Abweichung im Verbrauch - die gehört zu Verbessern.',
    fachwort: null,
  };
}


export const ERKLAERUNG_WIRKSAMKEIT: Erklaerung = {
  frage: 'Wann lässt sich die Wirksamkeit prüfen?',
  klartext: 'Sobald jede Maßnahme umgesetzt, bewertet oder verworfen ist. Dann hält eine Person fest, ob behoben ist, was festgestellt wurde.',
  nichtVerwechseln: 'Nicht die Wirkung einer Maßnahme auf den Verbrauch.',
  // Das Normwort fehlt wie bei der Feststellung, bis der Wächter die Ausnahme für `fachwort` kennt (Entscheid 18, PR 7).
  fachwort: null,
};
