/** AP-09 IP-9: reine Anzeige und Eingabeform. Zahlen liefert ausschließlich die API.
 * Die Art wird gespeichert; fehlender Bestand wird niemals aus Namen oder Einheit geraten.
 * Der geprüfte Katalog enthält nur Vokabular, keine Referenzdaten oder Testfälle.
 */
import type { Bezugsgroesse, BezugsgroessenListe, BezugsgroesseAnfrage, Unternehmen, StandortAmStichtag, OrtsbaumAmStichtag, Prozess, Kostenstelle, MessstelleRegisterZeile } from './api';
import { einheitenDer, geltungDer, periodenDer, type Art, type Vokabular } from './bezugsArt';
import katalog from './bezugsArtKatalog.json';
import { ABLEHNUNGEN } from './bezugsgroesse';
import type { VpOption } from './picker/optionen';

export const ARTEN = katalog.arten as Record<string, Art>;
export const VOKABULAR: Vokabular = katalog.vokabular;
export const TITEL = 'Bezugsgrößen';
export const ANLEGEN = 'Bezugsgröße anlegen';
export const LEER = 'Noch keine Bezugsgrößen';
export const LEER_SATZ = 'Damit Kennzahlen je Kilogramm, Stunde oder Quadratmeter möglich werden.';
export const ARCHIV_FOLGEN = ['Bisherige Werte bleiben lesbar.', 'Neue Werte können nicht mehr eingetragen werden.', 'Kennzahlen zeigen die Bezugsgröße als archiviert.'];
export const PERIODE = { tag: 'Tag', woche: 'Woche', monat: 'Monat', jahr: 'Jahr' };
export const GELTUNG: Record<Bezugsgroesse['geltung_art'], string> = { unternehmen: 'Unternehmen', standort: 'Standort', gebaeude: 'Gebäude', bereich: 'Bereich', prozess: 'Prozess', kostenstelle: 'Kostenstelle', messstelle: 'Messstelle' };
export type Liste = BezugsgroessenListe;
export type Ort = { key: string; id: string; art: Bezugsgroesse['geltung_art']; name: string; kennzeichen: string | null; standort: string | null; gruppe: string; waehlbar: boolean; hinweis: string | null };
export type OrtsDaten = { unternehmen: Unternehmen | null; standorte: StandortAmStichtag[]; baeume: OrtsbaumAmStichtag[]; prozesse: Prozess[]; kostenstellen: Kostenstelle[]; messstellen: MessstelleRegisterZeile[] };
export const ortKey = (art: string, id: string) => `${art}:${id}`;

/** Tagesgrenzen einschließlich: auch am letzten Tag ist das Objekt noch wählbar. */
export function geltungsOrte(q: OrtsDaten, heute: string): Ort[] {
  const out: Ort[] = [];
  const add = (art: Ort['art'], id: string, name: string, kennzeichen: string | null, standort: string | null, gruppe: string, waehlbar = true, hinweis: string | null = null) => out.push({ key: ortKey(art, id), art, id, name, kennzeichen, standort, gruppe, waehlbar, hinweis });
  if (q.unternehmen?.id) add('unternehmen', q.unternehmen.id, q.unternehmen.name ?? 'Unternehmen', null, null, 'Unternehmen');
  for (const s of q.standorte) {
    const aktiv = s.zustand !== 'archiviert';
    add('standort', s.id, s.name, s.kurzzeichen, s.id, s.name, aktiv, aktiv ? null : 'Archiviert');
    const b = q.baeume.find(x => x.standort.id === s.id);
    const bereich = (x: OrtsbaumAmStichtag['gebaeude'][number]['bereiche'][number]) => add('bereich', x.id, x.name, x.kurzzeichen, s.id, s.name, aktiv && x.zustand !== 'archiviert', x.zustand === 'archiviert' ? 'Archiviert' : null);
    for (const g of b?.gebaeude ?? []) {
      add('gebaeude', g.id, g.name, g.kurzzeichen, s.id, s.name, aktiv && g.zustand !== 'archiviert', g.zustand === 'archiviert' ? 'Archiviert' : null);
      g.bereiche.forEach(bereich);
    }
    b?.direktAmStandort?.bereiche.forEach(bereich);
  }
  for (const art of ['prozess', 'kostenstelle'] as const) {
    for (const x of art === 'prozess' ? q.prozesse : q.kostenstellen) {
      const aktiv = x.gueltig_ab <= heute && (x.gueltig_bis === null || x.gueltig_bis >= heute);
      add(art, x.id, x.name, x.kennzeichen, null, art === 'prozess' ? 'Prozesse' : 'Kostenstellen', aktiv, aktiv ? null : 'Heute nicht gültig');
    }
  }
  for (const m of q.messstellen) add('messstelle', m.id, m.name ?? m.kennzeichen, m.kennzeichen, m.ort.standort_id, 'Messstellen', m.archiviert_am === null, m.archiviert_am ? 'Archiviert' : null);
  return out;
}

// AP-16 IP-26 liefert die Art über die API; der vorhandene Anlegedialog erfasst keine Schwellenfassung.
export const anlegeArten = (): VpOption[] => Object.entries(ARTEN).filter(([key]) => key !== 'bezugsflaeche' && key !== 'zaehlerstand' && key !== 'betriebszeit_aus_leistung').map(([value, a]) => ({ value, label: a.name }));
export const einheiten = (art: string) => ARTEN[art] ? einheitenDer(ARTEN[art], VOKABULAR.einheiten, null).filter(e => e !== 'm²') : [];
export const perioden = (art: string) => ARTEN[art] ? periodenDer(ARTEN[art], VOKABULAR.periode_art) : [];
export const passtOrt = (art: string, o: Ort) => Boolean(ARTEN[art] && geltungDer(ARTEN[art], VOKABULAR.geltung_art).includes(o.art));
export const ortOptionen = (art: string, orte: Ort[], darf: (standort: string | null) => boolean): VpOption[] => orte.filter(o => passtOrt(art, o)).map(o => ({ value: o.key, label: o.name, sub: `${GELTUNG[o.art]}${o.kennzeichen ? ` · ${o.kennzeichen}` : ''}`, group: o.gruppe, disabled: !o.waehlbar || !darf(o.standort), disabledHint: o.hinweis ?? (!darf(o.standort) ? 'Dafür fehlt Ihnen das Recht zum Verwalten.' : null) }));

export type Entwurf = { art: string; name: string; kennzeichen: string; einheit: string; periode: string | null; ort: string | null };
export const neuerEntwurf = (): Entwurf => ({ art: 'produktionsmenge', name: '', kennzeichen: '', einheit: 'kg', periode: 'monat', ort: null });
export function artWechsel(e: Entwurf, art: string, orte: Ort[]): Entwurf {
  const ort = orte.find(o => o.key === e.ort);
  return { ...e, art, einheit: einheiten(art)[0] ?? '', periode: perioden(art).includes('monat') ? 'monat' : perioden(art)[0] ?? null, ort: ort && passtOrt(art, ort) ? ort.key : null };
}
export type Feld = 'name' | 'kennzeichen' | 'einheit' | 'periode' | 'ort';
export function pruefen(e: Entwurf, orte: Ort[], darf: (standort: string | null) => boolean): Partial<Record<Feld, string>> {
  const fehler: Partial<Record<Feld, string>> = {};
  if (!e.name.trim()) fehler.name = 'Bitte geben Sie einen Namen ein.';
  if (e.kennzeichen.trim() && !/^[A-Z0-9./-]{2,16}$/.test(e.kennzeichen.trim())) fehler.kennzeichen = ABLEHNUNGEN.kennzeichen_format.satz;
  if (!einheiten(e.art).includes(e.einheit)) fehler.einheit = 'Bitte wählen Sie eine passende Einheit.';
  if (perioden(e.art).length && !perioden(e.art).includes(e.periode ?? '')) fehler.periode = 'Bitte wählen Sie eine Periode.';
  const ort = orte.find(o => o.key === e.ort);
  if (!ort || !ort.waehlbar || !passtOrt(e.art, ort)) fehler.ort = 'Bitte wählen Sie einen gültigen Geltungsbereich.';
  else if (!darf(ort.standort)) fehler.ort = 'Dafür fehlt Ihnen das Recht zum Verwalten.';
  return fehler;
}
export function anfrage(e: Entwurf, o: Ort): BezugsgroesseAnfrage {
  return { art: e.art, name: e.name.trim(), ...(e.kennzeichen.trim() ? { kennzeichen: e.kennzeichen.trim() } : {}), wertart: ARTEN[e.art].wertart as Bezugsgroesse['wertart'], einheit: e.einheit, periode_art: e.periode as Bezugsgroesse['periode_art'], geltung_art: o.art, geltung_id: o.id };
}
export function fehlerSatz(e: unknown): string {
  const body = e && typeof e === 'object' && 'body' in e ? e.body : null;
  const code = body && typeof body === 'object' && 'code' in body ? String(body.code) : null;
  return code && Object.prototype.hasOwnProperty.call(ABLEHNUNGEN, code) ? ABLEHNUNGEN[code as keyof typeof ABLEHNUNGEN].satz : 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.';
}
