import {
  ApiError,
  type BewertungMessabdeckungOrt,
  type Energieeinsatz,
  type Messbedarf,
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
 * ⚠ Ort und Größe sind am Bedarf WORTLAUT (`openapi.yaml` `MessbedarfAnlegen`). Das Portal schreibt den Ort als
 * Kurzzeichen („G-1“, wie R5) und die Größe als „Wirkenergie · Bezug“ — beides liest der Dialog zurück; was er nicht
 * erkennt, belegt er nicht vor. ⚠ Eine eingelöste Messstelle ohne Quelle hat „keine Datenquelle“, nie eine 0.
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
  ort: string;
  groesse: string;
  richtung: string;
  frist: string;
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

export function bedarfAnfrage(e: BedarfEingabe): MessbedarfAnlegen {
  return {
    wortlaut: e.wortlaut.trim(),
    ort: e.ort || null,
    groesse: groesseWort(e.groesse, e.richtung),
    frist: e.frist || null,
  };
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

/** „G-1 Halle 1“ — das Kurzzeichen mit dem Namen, wenn der Ort bekannt ist; sonst der Wortlaut, wie er kam. */
export function ortText(ort: string | null, orte: readonly OrtWahl[]): string | null {
  if (!ort) return null;
  const o = orte.find((x) => x.kurzzeichen === ort);
  return o ? `${o.kurzzeichen} ${o.name}` : ort;
}

/** Die leise Zeile unter dem Wortlaut: Ort · Größe · Frist — nur, was angegeben ist. */
export function bedarfUnter(b: Messbedarf, orte: readonly OrtWahl[]): string {
  return [ortText(b.ort, orte), b.groesse, b.frist ? `Frist ${tag(b.frist)}` : null, `erfasst ${tag(b.angelegt_am)} · ${b.akteur.name}`]
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
 * Die Liste je Standort: der Ort des Bedarfs (Kurzzeichen) über die Ortsbäume zu seinem Standort; ein Bedarf ohne Ort
 * oder mit unbekanntem Ort steht unter „ohne Ort“ — er verschwindet nie.
 */
export function nachStandort(
  bedarfe: readonly Messbedarf[],
  einsaetze: readonly Energieeinsatz[],
  orte: readonly OrtWahl[],
): StandortGruppe[] {
  const gruppen = new Map<string, StandortGruppe>();
  for (const b of bedarfeSortiert(bedarfe)) {
    const o = b.ort ? orte.find((x) => x.kurzzeichen === b.ort) : undefined;
    const schluessel = o?.standortId ?? '';
    const g = gruppen.get(schluessel) ?? { schluessel, name: o?.standortName ?? MESSPLANUNG.ohneOrt, bedarfe: [] };
    g.bedarfe.push({ bedarf: b, einsatz: einsaetze.find((e) => e.id === b.energieeinsatz_id) ?? null });
    gruppen.set(schluessel, g);
  }
  return [...gruppen.values()].sort((a, b) => (a.schluessel === '' ? 1 : b.schluessel === '' ? -1 : a.name.localeCompare(b.name, 'de-DE')));
}

// ------------------------------------------------------------------ Einlösen · Rest-Zeile · Messstelle

/** Die Schnittstelle nimmt nur eine eingerichtete Messstelle (nichts fehlt, nicht archiviert) — vorher nicht einlösen. */
export function kannEinloesen(m: Messstelle): boolean {
  return m.fehlt.length === 0 && m.lebenszyklus !== 'archiviert';
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
  if (c === 'einsatz_beendet') return MESSPLANUNG.beendet;
  if (c === 'recht_fehlt' || (e instanceof ApiError && e.status === 403)) return 'Das dürfen Kundenadministratoren und Energiemanager.';
  if (e instanceof ApiError && e.status === 404) return 'Diesen Messbedarf gibt es hier nicht.';
  if (e instanceof ApiError && e.message) return e.message;
  return 'Das hat gerade nicht geklappt. Bitte versuchen Sie es noch einmal.';
}
