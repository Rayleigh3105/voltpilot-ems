/**
 * Nachweisen, Konzept n1 Runde 2 (§6.7, PR 5): das reine Bild des Reiters „Managementbewertung“ und der Seite eines
 * Jahres - „Kann noch nicht beginnen“ für das laufende Jahr, der Folgen-Balken, die Beschlüsse als Zeilen mit ihrer Folge
 * (erledigt, läuft, ohne Folge) und die Eingaben als Zeilen.
 *
 * **Hier wird nichts entschieden:** Folgen und ihr Zustand von heute kommen von der Route (MG6), die nächste fällige
 * Managementbewertung aus der Wiedervorlage (MG7). Hier steht nur, wie ein Zustand heißt und welches Zeichen er trägt.
 * Der Folgen-Balken zählt Beschlüsse nach dem Zustand ihrer Folgen - er urteilt nicht über das Ganze (G4).
 */
import type { Bericht, Managementbewertung, ManagementbewertungBeschluss, ManagementbewertungFolge } from './api';
import type { Erklaerung } from './components/nachweisen/erklaerung';
import type { DatumTon, ZustandArt } from './components/nachweisen/nwBild';
import type { Stufe } from './components/nachweisen/Stufen';
import { WOERTER } from './energiemanagement';
import { tagText } from './energiemanagementPortal';
import { ABSCHNITTE, type MbAbzug } from './managementbewertung';
import type { NaechsteManagementbewertung } from './wiedervorlage';

export const KURZZEILE = 'Jahresrückblick der Leitung';
export const KANN_NOCH_NICHT = 'Kann noch nicht beginnen';
export const FREIGEGEBEN = 'Freigegeben';
export const IN_ARBEIT = 'In Arbeit';
export const WAS_DIE_LEITUNG_SAH = 'Was die Leitung sah';
export const NOCH_KEINE = 'Noch keine Managementbewertung festgehalten.';

/** Ein Tag als „20.03.“ - das Jahr steht in der Seite schon. */
const tagMonat = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : '');

// ------------------------------------------------------------------ Folgen eines Beschlusses

/**
 * Der Zustand einer Folge als Zeichen (MG6): erledigt, was geschehen ist (Fassung freigegeben, „geprüft, bleibt“,
 * Aufgabe zugeordnet, Maßnahme umgesetzt oder bewertet, Energieziel bewertet, Audit abgeschlossen); läuft, was noch
 * offen ist; ohne Wirkung, was verworfen, abgelehnt oder abgesagt wurde. Das Zustandswort kommt von der Route.
 */
export function folgeZustand(f: Pick<ManagementbewertungFolge, 'art' | 'wie' | 'zustand'>): ZustandArt {
  if (f.wie === 'geprueft_bleibt') return 'done';
  switch (f.art) {
    case 'dokument':
      return f.zustand === 'freigegeben' || f.zustand === 'abgeloest' ? 'done' : f.zustand === 'abgelehnt' ? 'ohne' : 'laeuft';
    case 'aufgabe':
      return 'done';
    case 'massnahme':
      return f.zustand === 'umgesetzt' || f.zustand === 'bewertet' ? 'done' : f.zustand === 'verworfen' ? 'ohne' : 'laeuft';
    case 'energieziel':
      return f.zustand === 'bewertet' || f.zustand === 'beendet' ? 'done' : 'laeuft';
    case 'audit':
      return f.zustand === 'abgeschlossen' ? 'done' : f.zustand === 'abgesagt' ? 'ohne' : 'laeuft';
    default:
      return 'laeuft';
  }
}

/** Der Tag einer Folge, an dem sie geschah (Fassung freigegeben, Aufgabe gilt ab, geprüft am) - sonst verknüpft am. */
const folgeTag = (f: Pick<ManagementbewertungFolge, 'tag' | 'verknuepft_am'>) => f.tag ?? f.verknuepft_am ?? null;

/**
 * Der Zustand eines Beschlusses aus seinen Folgen: ohne Folge „ohne Folge“; läuft eine, „läuft“; sonst erledigt mit dem
 * Tag der letzten Folge („✓ 20.03.“). Folgen, die ohne Wirkung endeten, zählen wie keine.
 */
export function beschlussZustand(b: Pick<ManagementbewertungBeschluss, 'folgen'>): { art: ZustandArt; wort: string } {
  const wirksam = b.folgen.filter((f) => folgeZustand(f) !== 'ohne');
  if (!wirksam.length) return { art: 'ohne', wort: 'ohne Folge' };
  if (wirksam.some((f) => folgeZustand(f) === 'laeuft')) return { art: 'laeuft', wort: 'läuft' };
  const tage = wirksam.map(folgeTag).filter((t): t is string => !!t).sort();
  return { art: 'done', wort: tage.length ? tagMonat(tage[tage.length - 1]) : 'erledigt' };
}

/** Der Folgen-Balken: ein Segment je Beschluss in seiner Reihenfolge. */
export const folgenZustaende = (mb: Pick<Managementbewertung, 'beschluesse'>): ZustandArt[] =>
  [...mb.beschluesse].sort((a, b) => a.nr - b.nr).map((b) => beschlussZustand(b).art);

/**
 * Kürzt einen Satz am ersten Komma oder Semikolon außerhalb einer Klammer („Druckluft: Leckagen jährlich orten, 2029 …“,
 * „Energiepolitik um Einkauf und Planung ergänzen; neue Fassung …“); „Der Anwendungsbereich (D-0002, Fassung 1) bleibt
 * unverändert.“ bleibt ganz. Ein Punkt am Ende fällt weg.
 */
export function bisKomma(t: string): string {
  let tiefe = 0;
  for (let i = 0; i < t.length; i++) {
    const z = t[i];
    if (z === '(') tiefe++;
    else if (z === ')') tiefe = Math.max(0, tiefe - 1);
    else if ((z === ',' || z === ';') && tiefe === 0) return t.slice(0, i).trim();
  }
  return t.trim().replace(/\.$/u, '');
}

/** Die Jahre einer Zielperiode („2029-03/2029-12“ → „2029“, „2029-07/2030-06“ → „2029–2030“); sonst die Angabe selbst. */
export function jahre(angabe: string): string {
  const j = [...angabe.matchAll(/(?<!\d)(\d{4})-\d{2}/gu)].map((m) => m[1]);
  if (!j.length) return angabe;
  return j[0] === j[j.length - 1] ? j[0] : `${j[0]}–${j[j.length - 1]}`;
}

/** Ein Betrag im Wortlaut („25 000 €“, „25.000 Euro“) - so wie er dort steht. */
const betrag = (t: string) => /\d[\d .\u00a0\u202f]*\d\s?(?:€|Euro)|\d\s?(?:€|Euro)/u.exec(t)?.[0].replace(/\s?Euro$/u, ' €') ?? null;

/**
 * Der Kurztitel eines Beschlusses (Konzept §6.7: „Energieziel 2029“, „Aufgabe Bezugsbasen“, „Anwendungsbereich
 * bleibt“) aus seiner ersten Folge; ohne Folge bei Ressourcen der Betrag mit dem Wort des Chips („Geld: 25 000 €“),
 * sonst der Wortlaut bis zum ersten Komma - die Zeile kürzt ihn auf zwei Zeilen, der volle Wortlaut steht im Blatt. Ein
 * Kennzeichen ist nie ein Titel (Entscheid 25): `dokumente`/`massnahmen` liefern Titel je Kennzeichen, soweit bekannt;
 * sonst zählt der Wortlaut.
 */
export function beschlussKurz(
  b: Pick<ManagementbewertungBeschluss, 'art' | 'folgen' | 'wortlaut'>,
  titel: { dokumente: Record<string, string>; massnahmen: Record<string, string> },
): string {
  const f = b.folgen[0];
  const wortlaut = bisKomma(b.wortlaut) || b.wortlaut;
  switch (f?.art) {
    case 'energieziel':
      return f.angabe ? `Energieziel ${jahre(f.angabe)}` : 'Energieziel';
    case 'massnahme':
      return titel.massnahmen[f.objekt] ? bisKomma(titel.massnahmen[f.objekt]) : wortlaut;
    case 'aufgabe':
      return `Aufgabe ${WOERTER.aufgabe_kurz[f.objekt] ?? WOERTER.aufgabe[f.objekt] ?? ''}`.trim();
    case 'audit':
      return 'Internes Audit';
    case 'dokument': {
      const [kz, fassung] = f.objekt.split('/');
      const name = titel.dokumente[kz];
      if (!name) return wortlaut;
      if (f.wie === 'geprueft_bleibt') return `${name} bleibt`;
      return fassung ? `${name}, Fassung ${fassung}` : name;
    }
  }
  if (b.art === 'ressourcen') {
    const euro = betrag(b.wortlaut);
    return euro ? `${BESCHLUSS_CHIP.ressourcen}: ${euro}` : wortlaut;
  }
  return wortlaut;
}

/**
 * Eine Folge als Zeile im Blatt des Beschlusses: was entstanden ist, beim Namen („Energiepolitik, Fassung 2“,
 * „Bezugsbasen: Ines Kaltenbach“, „Energieziel 2029“) - das Kennzeichen nur, wo kein Name bekannt ist.
 */
export function folgeKurz(
  f: Pick<ManagementbewertungFolge, 'art' | 'objekt' | 'wie' | 'angabe'>,
  titel: { dokumente: Record<string, string>; massnahmen: Record<string, string> },
): string {
  switch (f.art) {
    case 'energieziel':
      return f.angabe ? `Energieziel ${jahre(f.angabe)}` : `Energieziel ${f.objekt}`;
    case 'massnahme':
      return titel.massnahmen[f.objekt] ? bisKomma(titel.massnahmen[f.objekt]) : `Maßnahme ${f.objekt}`;
    case 'aufgabe':
      return [WOERTER.aufgabe_kurz[f.objekt] ?? WOERTER.aufgabe[f.objekt] ?? f.objekt, f.angabe].filter(Boolean).join(': ');
    case 'audit':
      return `Internes Audit ${f.objekt}`;
    case 'dokument': {
      const [kz, fassung] = f.objekt.split('/');
      const name = titel.dokumente[kz] ?? kz;
      if (f.wie === 'geprueft_bleibt') return `${name} bleibt`;
      return fassung ? `${name}, Fassung ${fassung}` : name;
    }
    default:
      return f.objekt;
  }
}

// ------------------------------------------------------------------ Reiter

export type MbNaechstes = {
  art: 'kann_nicht' | 'als_naechstes';
  frist: { wort: string; tag: string; ton: DatumTon } | null;
  titel: string;
  warum: string | null;
  knopf: 'anlegen' | 'oeffnen' | null;
  kennung: string | null;
};

/**
 * Der eine nächste Schritt im Reiter: ein Entwurf wird vorbereitet („Öffnen“); fehlt die Managementbewertung des Vorjahrs
 * und gibt es keine spätere, ist sie anzulegen; sonst kann die nächste noch nicht beginnen - gestrichelt, mit der Frist aus
 * der Wiedervorlage und „ab Januar …“, ohne Knopf. Die nächste ist die des laufenden Jahres, oder die nach der jüngsten,
 * wenn es die schon gibt. `heute` ist der Tag der Route.
 */
export function mbNaechstes(liste: readonly Pick<Bericht, 'kennung' | 'zeitraum' | 'neueste_nr'>[], naechste: NaechsteManagementbewertung | null, heute: string): MbNaechstes {
  const jahre = liste.map((b) => Number(b.zeitraum)).filter((j) => Number.isFinite(j));
  const juengste = jahre.length ? Math.max(...jahre) : null;
  const jahr = Math.max(Number(heute.slice(0, 4)), juengste !== null ? juengste + 1 : 0);
  const frist = naechste?.faellig_am ?? null;
  const entwurf = liste.find((b) => !b.neueste_nr);
  if (entwurf) {
    return {
      art: 'als_naechstes',
      frist: frist ? { wort: frist < heute ? 'seit' : 'bis', tag: frist, ton: frist < heute ? 'ueber' : 'bald' } : null,
      titel: `Managementbewertung ${entwurf.zeitraum}`,
      warum: 'Entwurf',
      knopf: 'oeffnen',
      kennung: entwurf.kennung,
    };
  }
  if (juengste === null || juengste < jahr - 1) {
    return {
      art: 'als_naechstes',
      frist: frist ? { wort: frist < heute ? 'seit' : 'bis', tag: frist, ton: frist < heute ? 'ueber' : 'bald' } : null,
      titel: `Managementbewertung ${jahr - 1}`,
      warum: null,
      knopf: 'anlegen',
      kennung: null,
    };
  }
  return {
    art: 'kann_nicht',
    frist: frist ? { wort: 'bis', tag: frist, ton: 'plan' } : null,
    titel: `Managementbewertung ${jahr}`,
    warum: `ab Januar ${jahr + 1}`,
    knopf: null,
    kennung: null,
  };
}

// ------------------------------------------------------------------ Seite eines Jahres

/** Freigegeben „Sitzung 12.02.2029 · Robert Falk“, im Entwurf „Entwurf · Sitzung 12.02.2029“ (Mocks r2-M2, MBV). */
export function mbKurzzeile(mb: Pick<Managementbewertung, 'sitzung' | 'freigegeben'>): string {
  const sitzung = mb.sitzung ? `Sitzung ${tagText(mb.sitzung.tag)}` : null;
  if (!mb.freigegeben) return ['Entwurf', sitzung].filter(Boolean).join(' · ');
  return sitzung ? [sitzung, mb.sitzung!.leitung.name].filter(Boolean).join(' · ') : FREIGEGEBEN;
}

/** Die Status-Zeile: „● Stand 1 gilt“ oder „◎ Entwurf · noch nicht freigegeben“. */
export function mbStatus(mb: Pick<Managementbewertung, 'freigegeben' | 'stand_nr'>): { zeichen: 'festgehalten' | 'entwurf'; text: string; sub: string | null } {
  return mb.freigegeben
    ? { zeichen: 'festgehalten', text: `Stand ${mb.stand_nr ?? 1} gilt`, sub: null }
    : { zeichen: 'entwurf', text: 'Entwurf', sub: '· noch nicht freigegeben' };
}

/** Die Stufen eines Entwurfs: Eingaben · Sitzung · Beschlüsse · Freigeben (Mock MBV). */
export function mbStufen(mb: Pick<Managementbewertung, 'sitzung' | 'beschluesse' | 'freigegeben'>, entwurfAm: string | null): Stufe[] {
  const sitzung = !!mb.sitzung;
  const beschluesse = mb.beschluesse.length > 0;
  return [
    { titel: 'Eingaben', datum: entwurfAm ? tagMonat(entwurfAm) : null, zustand: 'done' },
    sitzung ? { titel: 'Sitzung', datum: tagMonat(mb.sitzung!.tag), zustand: 'done' } : { titel: 'Sitzung', datum: 'jetzt', zustand: 'an' },
    beschluesse
      ? { titel: 'Beschlüsse', datum: String(mb.beschluesse.length), zustand: 'done' }
      : { titel: 'Beschlüsse', datum: sitzung ? 'jetzt' : null, zustand: sitzung ? 'an' : 'offen' },
    mb.freigegeben
      ? { titel: 'Freigeben', datum: null, zustand: 'done' }
      : { titel: 'Freigeben', datum: sitzung && beschluesse ? 'jetzt' : null, zustand: sitzung && beschluesse ? 'an' : 'offen' },
  ];
}

/** Wer in der Sitzung war: Leitung und Teilnehmende, ohne doppelte. */
export function sitzungPersonen(s: NonNullable<Managementbewertung['sitzung']>): { name: string }[] {
  const alle = [s.leitung, ...s.teilnehmende].filter((p) => p.name);
  return alle.filter((p, i) => alle.findIndex((q) => q.id === p.id) === i).map((p) => ({ name: p.name! }));
}

const zahl = (n: number | undefined) => n ?? 0;

/** Die Abschnitte der Eingaben als kurze Zeilentitel (der lange Titel der Vorlage steht im PDF). */
export const EINGABE_KURZ: Record<string, string> = {
  vorige_beschluesse: 'Vorige Beschlüsse',
  grundlagen: 'Grundlagen',
  energieziele: 'Energieziele',
  energieleistung: 'Energieleistung',
  massnahmen: 'Maßnahmen',
  abweichungen: 'Abweichungen',
  audits_feststellungen: 'Audits und Feststellungen',
  bewertung_messplanung: 'Energetische Bewertung',
  wiedervorlage: 'Wiedervorlage',
  quellenverzeichnis: 'Quellen',
};

/**
 * „Was die Leitung sah“: die Abschnitte der Eingaben als Zeilen mit der Zahl ihrer Einträge (Sitzung und Beschlüsse
 * stehen schon auf der Seite). Was der Abzug nicht trägt, zählt nicht - unbekannt ist nicht „keine“ (`null`).
 */
export function eingabenZeilen(a: MbAbzug): { key: string; titel: string; zahl: number | null }[] {
  const n: Record<string, number | null> = {
    vorige_beschluesse: a.vorige_beschluesse ? a.vorige_beschluesse.beschluesse.length : null,
    grundlagen: a.grundlagen ? Object.keys(a.grundlagen).length : null,
    energieziele: a.energieziele ? a.energieziele.length : null,
    energieleistung: a.energieleistung ? a.energieleistung.leistungsvergleiche.length + a.energieleistung.bezugsbasen.length : null,
    massnahmen: a.massnahmen ? a.massnahmen.length : null,
    abweichungen: a.abweichungen ? a.abweichungen.im_jahr.length + a.abweichungen.auffaelligkeiten.length : null,
    audits_feststellungen: a.audits_feststellungen ? a.audits_feststellungen.audits.length + a.audits_feststellungen.feststellungen.length : null,
    bewertung_messplanung: a.bewertung_messplanung ? a.bewertung_messplanung.bewertungen.length + a.bewertung_messplanung.messbedarfe.length : null,
    wiedervorlage: a.wiedervorlage ? zahl(a.wiedervorlage.anzahl_faellig) + zahl(a.wiedervorlage.anzahl_vorschau) : null,
    quellenverzeichnis: a.quellenverzeichnis ? a.quellenverzeichnis.length : null,
  };
  return ABSCHNITTE.filter((x) => x.key !== 'beschluesse' && x.key !== 'sitzung').map((x) => ({
    key: x.key,
    titel: EINGABE_KURZ[x.key] ?? x.titel,
    zahl: n[x.key] ?? null,
  }));
}

/** „5 Personen“ - wie viele in der Sitzung waren. */
export const personenZahl = (n: number) => (n === 1 ? '1 Person' : `${n} Personen`);
/** „10 Teile“ - wie viele Abschnitte die Leitung sah. */
export const teileZahl = (n: number) => (n === 1 ? '1 Teil' : `${n} Teile`);

// ------------------------------------------------------------------ Blatt „Vorbereiten“ (Runde 1, §6.7, Mock MBV)

export type VorbereitenSchritt = 'eingaben' | 'sitzung' | 'beschluss' | 'pruefen' | 'freigeben';
export const VORBEREITEN_SCHRITTE: readonly VorbereitenSchritt[] = ['eingaben', 'sitzung', 'beschluss', 'pruefen', 'freigeben'];
export const KNOPF_VORBEREITEN = 'Vorbereiten';
export const KNOPF_WEITER_VORBEREITEN = 'Weiter vorbereiten';
export const KNOPF_MB_FREIGEBEN = 'Managementbewertung freigeben';

/** Wo das Blatt beginnt: ohne Sitzung bei den Eingaben, ohne Beschluss beim Beschluss, sonst beim Prüfen. */
export function vorbereitenStart(mb: Pick<Managementbewertung, 'sitzung' | 'beschluesse'>): VorbereitenSchritt {
  if (!mb.sitzung) return 'eingaben';
  return mb.beschluesse.length ? 'pruefen' : 'beschluss';
}

/** „Worum geht es?“ - die Arten eines Beschlusses als kurze Chips (Mock MBV), in der Reihenfolge des Vokabulars. */
export const BESCHLUSS_CHIP: Record<string, string> = {
  energieziel: 'Energieziel',
  massnahme: 'Maßnahme',
  dokument: 'Dokument',
  aufgabe: 'Aufgabe',
  ressourcen: 'Geld',
  audit: 'Audit',
  keine_aenderung: 'Bleibt',
  weitere: 'Anderes',
};

// ------------------------------------------------------------------ Erklärung (Entscheid 24)

export function erklaerungManagementbewertung(mb: Pick<Managementbewertung, 'sitzung' | 'beschluesse'> | null): Erklaerung {
  const n = mb?.beschluesse.length ?? 0;
  return {
    frage: 'Was ist eine Managementbewertung?',
    klartext: 'Der jährliche Rückblick der Leitung mit ihren Beschlüssen.',
    beiIhnen: mb?.sitzung ? `Am ${tagText(mb.sitzung.tag)}: ${n === 1 ? 'ein Beschluss' : `${n} Beschlüsse`}.` : null,
    nichtVerwechseln: 'Kein Verbrauchsbericht.',
    fachwort: 'Managementbewertung',
  };
}
