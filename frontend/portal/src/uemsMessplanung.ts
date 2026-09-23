import {
  ApiError,
  type BewertungMessabdeckungOrt,
  type Energieeinsatz,
  type Messbedarf,
  type MessbedarfAenderung,
  type MessbedarfAnlegen,
  type Messstelle,
  type MessstelleRegisterZeile,
  type StandorteAmStichtag,
} from './api';
import { laeuft, tag, zahlMitEinheit, prozentText } from './bewertung';
import { UEMS_BEWERTUNG_SAETZE, UEMS_ENERGIEEINSATZ, UEMS_MESSBEDARF } from './glossar';
import { eintragVon, groesseWaehlen, leereGroesse, type GroesseEingabe, type OrtWahl } from './messstelleDialog';

/**
 * UEMS AP-16 IP-20 (§5.3 Schritte 1–3, R5): die Messplanung im Portal — Messbedarf erfassen (am Einsatz oder aus der
 * Rest-Zeile einer Anlage), einlösen (Sprung in den Messstellen-Dialog mit Ort und Größe vorbelegt, das Kennzeichen
 * kommt zurück), verwerfen mit Pflicht-Begründung. Reine Ableitungen; die Flächen stehen in `components/Messplanung.tsx`.
 *
 * AP-16 P1 (Befund IP-20): Ort und Größe schreibt das Portal als STRUKTUR (`ort_id`, `messgroesse`, `richtung`) und
 * zusätzlich den gewohnten Wortlaut (Kurzzeichen „G-1“, „Wirkenergie · Bezug“), den Bericht und Messabdeckung lesen. Die
 * Liste je Standort liest die Standort-Route `GET /api/v1/unternehmen/messbedarf` (der Standort kommt aus `ort_ziel`).
 * ⚠ Ein Bedarf aus der Fassung davor hat nur Wortlaut: dann bleibt der Wortlaut führend — das Kurzzeichen wird wie bisher
 * über die Ortsbäume aufgelöst, sonst steht er unter „ohne Ort“; Bearbeiten behält einen unerkannten Wortlaut.
 * ⚠ Eine eingelöste Messstelle ohne Quelle hat „keine Datenquelle“, nie eine 0.
 */

export const MESSPLANUNG = {
  titel: 'Messplanung',
  erfassen: `${UEMS_MESSBEDARF} erfassen`,
  einrichten: 'Messstelle einrichten',
  verwerfen: 'Verwerfen',
  abbrechen: 'Abbrechen',
  leer: `Noch kein ${UEMS_MESSBEDARF}. Fehlt einem ${UEMS_ENERGIEEINSATZ} eine Messung, halten Sie hier fest, was gemessen werden soll.`,
  leerStandorte: `Noch kein ${UEMS_MESSBEDARF} erfasst.`,
  nurLesen: 'Messbedarf erfassen, einlösen und verwerfen dürfen Kundenadministratoren und Energiemanager.',
  beendet: 'Der Energieeinsatz ist beendet — neue Messbedarfe entstehen an einem laufenden Einsatz.',
  verwerfenSatz: 'Der Bedarf bleibt mit Ihrer Begründung lesbar; er erscheint nicht mehr unter „geplant“.',
  erfassenSatz: 'Der Bedarf steht danach in der Messabdeckung unter „geplant“ — ohne Menge, bis eine Messstelle Werte liefert.',
  einloesenHinweis: 'Ort und Größe sind aus dem Messbedarf vorbelegt. Sobald die Messstelle eingerichtet ist, ist der Bedarf eingelöst.',
  ohneOrt: 'ohne Ort',
  bearbeiten: 'Bearbeiten',
  bearbeitenTitel: `${UEMS_MESSBEDARF} bearbeiten`,
  speichern: 'Speichern',
  bearbeitenSatz: 'Bearbeiten geht, solange der Bedarf offen ist. Jede Änderung steht mit Ihrem Namen im Protokoll.',
  protokoll: 'Protokoll',
  protokollTitel: (kennzeichen: string) => `Protokoll ${kennzeichen}`,
  protokollLeer: 'Noch kein Eintrag im Protokoll.',
  bisher: (wort: string) => `bisher „${wort}“ — bleibt, solange Sie nichts anderes wählen`,
} as const;

export const MESSBEDARF_ZUSTAND: Record<Messbedarf['zustand'], string> = {
  offen: 'offen',
  eingeloest: 'eingelöst',
  verworfen: 'verworfen',
};

// ------------------------------------------------------------------ Erfassen

export interface BedarfEingabe {
  einsatzId: string;
  wortlaut: string;
  /** Das Kurzzeichen des gewählten Orts (die Wahl des Pickers); die ID kommt beim Senden aus den Ortsbäumen. */
  ort: string;
  groesse: string;
  richtung: string;
  frist: string;
  /** Bearbeiten eines Bedarfs aus der Fassung vor der Struktur: der Wortlaut, den kein Picker abbildet — er bleibt. */
  ortWortlaut?: string;
  groesseWortlaut?: string;
}

export const leererBedarf = (einsatzId = '', vorbelegung: Partial<BedarfEingabe> = {}): BedarfEingabe => ({
  einsatzId, wortlaut: '', ort: '', groesse: '', richtung: '', frist: '', ...vorbelegung,
});

export type BedarfFeld = 'einsatz' | 'wortlaut' | 'frist';

export function bedarfPruefen(e: BedarfEingabe): Partial<Record<BedarfFeld, string>> {
  const f: Partial<Record<BedarfFeld, string>> = {};
  if (!e.einsatzId) f.einsatz = 'Bitte wählen Sie den Energieeinsatz, zu dem der Bedarf gehört.';
  if (!e.wortlaut.trim()) f.wortlaut = 'Bitte beschreiben Sie, was gemessen werden soll.';
  if (e.frist && !/^\d{4}-\d{2}-\d{2}$/.test(e.frist)) f.frist = 'Bitte geben Sie die Frist als Tag an.';
  return f;
}

/** „Wirkenergie · Bezug“ — die Größe als Wortlaut am Bedarf; ohne Größe `null`. */
export function groesseWort(groesse: string, richtung: string): string | null {
  if (!groesse) return null;
  return richtung ? `${groesse} · ${richtung}` : groesse;
}

/**
 * Die Anfrage mit Struktur und Wortlaut: `ort_id` aus dem gewählten Kurzzeichen, `messgroesse`/`richtung` aus dem
 * Katalog; der Wortlaut wie bisher (Kurzzeichen, „Wirkenergie · Bezug“). Ohne Wahl bleibt ein alter Wortlaut stehen.
 */
export function bedarfAnfrage(e: BedarfEingabe, orte: readonly OrtWahl[] = []): MessbedarfAnlegen {
  const o = e.ort ? orte.find((x) => x.kurzzeichen === e.ort) : undefined;
  return {
    wortlaut: e.wortlaut.trim(),
    ort: e.ort || e.ortWortlaut || null,
    groesse: groesseWort(e.groesse, e.richtung) ?? (e.groesseWortlaut || null),
    frist: e.frist || null,
    ort_id: o?.id ?? null,
    messgroesse: e.groesse || null,
    richtung: e.groesse ? e.richtung || null : null,
  };
}

/**
 * Die Vorbelegung zum Bearbeiten: die Struktur, wenn es sie gibt; sonst der Wortlaut, soweit ihn die Ortsbäume bzw. der
 * Katalog erkennen. Was keiner erkennt, bleibt als Wortlaut (`ortWortlaut`, `groesseWortlaut`) und geht unverändert zurück.
 */
export function bearbeitenVorbelegung(b: Messbedarf, orte: readonly OrtWahl[]): BedarfEingabe {
  const ort = b.ort_ziel?.kurzzeichen ?? (b.ort && orte.some((o) => o.kurzzeichen === b.ort) ? b.ort : '');
  const g = b.messgroesse ? { groesse: b.messgroesse, richtung: b.richtung ?? '' } : groesseVorbelegung(b.groesse);
  return leererBedarf(b.energieeinsatz_id, {
    wortlaut: b.wortlaut,
    ort,
    groesse: g?.groesse ?? '',
    richtung: g?.richtung ?? '',
    frist: b.frist ?? '',
    ...(!ort && b.ort ? { ortWortlaut: b.ort } : {}),
    ...(!g && b.groesse ? { groesseWortlaut: b.groesse } : {}),
  });
}

/**
 * Die Vorbelegung der Hauptgröße im Messstellen-Dialog aus dem Wortlaut der Größe: die längste Katalog-Größe, mit der
 * der Text beginnt, und eine ihrer Richtungen, die danach vorkommt („Wirkenergie · Bezug“, auch „Wirkenergie Bezug
 * (kWh)“ aus R5). Kennt der Katalog die Größe nicht: `null` — dann bleibt das Feld leer, statt zu raten.
 */
export function groesseVorbelegung(text: string | null | undefined): GroesseEingabe | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const woerter = t.split(/[\s·(),]+/).filter(Boolean);
  for (let n = woerter.length; n > 0; n--) {
    const g = woerter.slice(0, n).join(' ');
    const k = eintragVon(g);
    if (!k) continue;
    const rest = woerter.slice(n);
    const richtung = k.richtungen.find((r) => rest.includes(r)) ?? '';
    return groesseWaehlen({ ...leereGroesse(), richtung }, g);
  }
  return null;
}

// ------------------------------------------------------------------ Lesen

/**
 * „G-1 Halle 1“ — mit Struktur aus `ort_ziel`; ohne Struktur das Kurzzeichen mit dem Namen, wenn die Ortsbäume es
 * kennen, sonst der Wortlaut, wie er kam.
 */
export function ortText(b: Pick<Messbedarf, 'ort' | 'ort_ziel'>, orte: readonly OrtWahl[]): string | null {
  if (b.ort_ziel) return b.ort_ziel.name ? `${b.ort_ziel.kurzzeichen} ${b.ort_ziel.name}` : b.ort_ziel.kurzzeichen;
  if (!b.ort) return null;
  const o = orte.find((x) => x.kurzzeichen === b.ort);
  return o ? `${o.kurzzeichen} ${o.name}` : b.ort;
}

/** Die Größe: mit Struktur „Wirkenergie · Bezug“ aus dem Katalog, sonst der Wortlaut. */
export const groesseText = (b: Pick<Messbedarf, 'groesse' | 'messgroesse' | 'richtung'>): string | null =>
  b.messgroesse ? groesseWort(b.messgroesse, b.richtung ?? '') : b.groesse;

/** Die leise Zeile unter dem Wortlaut: Ort · Größe · Frist — nur, was angegeben ist. */
export function bedarfUnter(b: Messbedarf, orte: readonly OrtWahl[]): string {
  return [ortText(b, orte), groesseText(b), b.frist ? `Frist ${tag(b.frist)}` : null, `erfasst ${tag(b.angelegt_am)} · ${b.akteur.name}`]
    .filter(Boolean)
    .join(' · ');
}

/** Die Beobachtung der eingelösten Messstelle: „keine Datenquelle seit 27.11.2026“ — nie eine Zahl, nie 0. */
export function beobachtungWort(z: MessstelleRegisterZeile | null | undefined): string | null {
  const b = z?.beobachtung;
  if (!b) return null;
  if (b.zustand === 'keine_datenquelle') return b.seit ? `keine Datenquelle seit ${tag(b.seit)}` : 'keine Datenquelle';
  if (b.zustand === 'wartet_auf_erste_daten') return 'wartet auf erste Daten';
  if (b.zustand === 'liefert') return 'liefert Daten';
  return b.text || null;
}

/** Der Satz des Bedarfs nach §5.7 („Messbedarf MB-1: … — eingelöst durch MS-23 Halle 1 Allgemein (keine Datenquelle seit …).“). */
export function bedarfSatz(b: Messbedarf, register: readonly MessstelleRegisterZeile[]): string | null {
  if (b.zustand === 'eingeloest' && b.messstelle) {
    const m = `${b.messstelle.kennzeichen}${b.messstelle.name ? ` ${b.messstelle.name}` : ''}`;
    const hinweis = beobachtungWort(register.find((z) => z.id === b.messstelle!.id));
    return hinweis
      ? UEMS_BEWERTUNG_SAETZE.messbedarf(b.kennzeichen, b.wortlaut, m, hinweis)
      : `${UEMS_MESSBEDARF} ${b.kennzeichen}: ${b.wortlaut} — eingelöst durch ${m}.`;
  }
  if (b.zustand === 'verworfen') return `Verworfen am ${tag(b.geaendert_am)}: ‚${b.begruendung ?? ''}‘`;
  return null;
}

/** Offen zuerst, dann eingelöst, dann verworfen; innerhalb nach Kennzeichen. */
export function bedarfeSortiert(bedarfe: readonly Messbedarf[]): Messbedarf[] {
  const rang = { offen: 0, eingeloest: 1, verworfen: 2 } as const;
  const nr = (b: Messbedarf) => Number(b.kennzeichen.replace(/^MB-/, '')) || 0;
  return [...bedarfe].sort((a, b) => rang[a.zustand] - rang[b.zustand] || nr(a) - nr(b));
}

export interface StandortGruppe {
  schluessel: string;
  name: string;
  bedarfe: { bedarf: Messbedarf; einsatz: Energieeinsatz | null }[];
}

/**
 * Die Liste je Standort: der Standort aus `ort_ziel` (die Standort-Route löst ihn auf); ohne Struktur wie bisher das
 * Kurzzeichen des Wortlauts über die Ortsbäume. Ein Bedarf ohne Ort oder mit unbekanntem Ort steht unter „ohne Ort“ —
 * er verschwindet nie.
 */
export function nachStandort(
  bedarfe: readonly Messbedarf[],
  einsaetze: readonly Energieeinsatz[],
  orte: readonly OrtWahl[],
): StandortGruppe[] {
  const gruppen = new Map<string, StandortGruppe>();
  for (const b of bedarfeSortiert(bedarfe)) {
    const o = b.ort_ziel
      ? b.ort_ziel.standort_id
        ? { standortId: b.ort_ziel.standort_id, standortName: b.ort_ziel.standort_name ?? b.ort_ziel.kurzzeichen }
        : undefined
      : b.ort
        ? orte.find((x) => x.kurzzeichen === b.ort)
        : undefined;
    const schluessel = o?.standortId ?? '';
    const g = gruppen.get(schluessel) ?? { schluessel, name: o?.standortName ?? MESSPLANUNG.ohneOrt, bedarfe: [] };
    g.bedarfe.push({ bedarf: b, einsatz: einsaetze.find((e) => e.id === b.energieeinsatz_id) ?? null });
    gruppen.set(schluessel, g);
  }
  return [...gruppen.values()].sort((a, b) => (a.schluessel === '' ? 1 : b.schluessel === '' ? -1 : a.name.localeCompare(b.name, 'de-DE')));
}

// ------------------------------------------------------------------ Einlösen · Rest-Zeile · Messstelle

// ------------------------------------------------------------------ Protokoll

const PROTOKOLL_ART: Record<MessbedarfAenderung['art'], string> = {
  erfasst: 'erfasst',
  bearbeitet: 'bearbeitet',
  eingeloest: 'eingelöst',
  verworfen: 'verworfen',
};

/** Die Felder, deren Änderung eine Protokollzeile nennt — in dieser Reihenfolge. */
const PROTOKOLL_FELDER = [
  ['wortlaut', 'Wortlaut'],
  ['ort', 'Ort'],
  ['groesse', 'Größe'],
  ['frist', 'Frist'],
  ['begruendung', 'Begründung'],
] as const;

export interface ProtokollZeile {
  id: number;
  art: string;
  wann: string;
  wer: string;
  aenderungen: string[];
}

const feldWort = (feld: string, v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  const t = String(v);
  return feld === 'frist' ? tag(t) : `„${t}“`;
};

/**
 * Das Protokoll als Zeilen: Art, Zeitpunkt, Person und — beim Bearbeiten — je geändertem Feld „Ort: „G-1“ → „G-2““.
 * Die Schnappschüsse bleiben, wie sie kamen; das Portal vergleicht nur Wortlaut, Ort, Größe, Frist und Begründung.
 */
export function protokollZeilen(aenderungen: readonly MessbedarfAenderung[]): ProtokollZeile[] {
  return aenderungen.map((a) => ({
    id: a.id,
    art: PROTOKOLL_ART[a.art] ?? a.art,
    wann: `${tag(a.zeit)}, ${new Date(a.zeit).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })}`,
    wer: a.akteur.name,
    aenderungen:
      a.art === 'bearbeitet' && a.alt && a.neu
        ? PROTOKOLL_FELDER.filter(([f]) => (a.alt![f] ?? null) !== (a.neu![f] ?? null)).map(
            ([f, name]) => `${name}: ${feldWort(f, a.alt![f])} → ${feldWort(f, a.neu![f])}`,
          )
        : [],
  }));
}

// ------------------------------------------------------------------ Einlösen · Rest-Zeile · Messstelle (Prüfung)

/** Die Schnittstelle nimmt nur eine eingerichtete Messstelle (nichts fehlt, nicht archiviert) — vorher nicht einlösen. */
export function kannEinloesen(m: Messstelle): boolean {
  return m.fehlt.length === 0 && m.lebenszyklus !== 'archiviert';
}

/** Die Vorbelegung des Messstellen-Dialogs beim Einlösen: Ort und Größe aus der Struktur, sonst aus dem Wortlaut. */
export function einloesenVorbelegung(b: Messbedarf): { ort: string | null; hauptgroesse: GroesseEingabe | null } {
  return { ort: b.ort_ziel?.kurzzeichen ?? b.ort, hauptgroesse: groesseVorbelegung(groesseText(b)) };
}

/** Aus der Rest-Zeile einer Anlage: der Wortlaut nennt den Rest, der Ort ist der Standort der Anlage (wenn bekannt). */
export function restVorbelegung(o: BewertungMessabdeckungOrt, standorte: StandorteAmStichtag | null): Partial<BedarfEingabe> {
  const r = o.ungemessen;
  const menge = r ? zahlMitEinheit(r.menge, o.einheit ?? 'kWh') : null;
  const anteil = r?.anteil_prozent ? ` (${prozentText(r.anteil_prozent)} der Anlage)` : '';
  const standort = standorte?.standorte.find((s) => s.anlagen.some((a) => a.id === (o.id ?? r?.anlage_id)));
  return {
    wortlaut: `Rest ${o.name ?? r?.anlage ?? ''}${menge ? `: ${menge}${anteil}` : ''} — keinem Energieeinsatz zugeordnet`,
    ort: standort?.kurzzeichen ?? '',
  };
}

/** Die laufenden Einsätze, an denen aus der Rest-Zeile ein Bedarf entstehen kann. */
export const einsatzOptionen = (einsaetze: readonly Energieeinsatz[]) =>
  einsaetze.filter(laeuft).map((e) => ({ value: e.id, label: `${e.kennzeichen} ${e.name}`, sub: e.traeger }));

/** „geplant für EE-8 Gebäudetechnik Halle 1“ an der Messstellen-Seite; ohne eingelösten Bedarf `null`. */
export function geplantFuerText(z: MessstelleRegisterZeile | null | undefined): string | null {
  const e = z?.geplant_fuer_einsaetze ?? [];
  if (e.length === 0) return null;
  return `geplant für ${e.map((x) => `${x.kennzeichen} ${x.name}`).join(', ')}`;
}

const code = (e: unknown): string | null =>
  e instanceof ApiError && e.body && typeof e.body === 'object' && typeof (e.body as { code?: unknown }).code === 'string'
    ? (e.body as { code: string }).code
    : null;

/** Die Ablehnungen der Messbedarf-Routen als Satz mit Weg. */
export function messbedarfAblehnung(e: unknown): string {
  const c = code(e);
  if (c === 'wortlaut_fehlt') return 'Bitte beschreiben Sie, was gemessen werden soll.';
  if (c === 'begruendung_fehlt') return 'Bitte begründen Sie, warum der Bedarf verworfen wird.';
  if (c === 'messstelle_nicht_eingerichtet')
    return 'Die Messstelle ist noch nicht eingerichtet — wählen Sie im Dialog den Ort, dann ist der Bedarf eingelöst.';
  if (c === 'messbedarf_abgeschlossen') return 'Dieser Messbedarf ist schon eingelöst oder verworfen.';
  if (c === 'ort_unbekannt') return 'Diesen Ort gibt es nicht mehr — bitte wählen Sie einen anderen oder keinen Ort.';
  if (c === 'groesse_ungueltig') return 'Diese Größe oder Richtung kennt der Katalog nicht — bitte wählen Sie sie aus der Liste.';
  if (c === 'berichts_belege')
    return e instanceof ApiError && e.message
      ? e.message
      : 'Ein freigegebener Berichtsstand zitiert diesen Messbedarf — er bleibt, wie er ist.';
  if (c === 'einsatz_beendet') return MESSPLANUNG.beendet;
  if (c === 'recht_fehlt' || (e instanceof ApiError && e.status === 403)) return 'Das dürfen Kundenadministratoren und Energiemanager.';
  if (e instanceof ApiError && e.status === 404) return 'Diesen Messbedarf gibt es hier nicht.';
  if (e instanceof ApiError && e.message) return e.message;
  return 'Das hat gerade nicht geklappt. Bitte versuchen Sie es noch einmal.';
}
