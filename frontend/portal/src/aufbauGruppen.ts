/**
 * Die GERÄTE im Aufbau GRUPPIERT (Konzept `vp-anlage-geraete-gruppiert`, entschieden GR-1 A · GR-2 A · GR-3 A
 * am 07.11.2026).
 *
 * Ohne diese Ordnung standen die Geräte einer Box in der Reihenfolge ihrer Quellkennung (`src-` + 8 Zeichen
 * SHA-256) - für den Kunden Zufall: „Kaco 3, Netzanschluss, Kaco 2, UV Keller, Kaco 1, UV Halle".
 *
 * - **Fünf feste Gruppen** in der Reihenfolge des Anlagenkopfs: Erzeugung · Speicher · Netz · Verbrauch · Laden.
 *   Leere Gruppen entfallen.
 * - **Jedes Gerät einmal** (D6 „Geräte führen"), in der ERSTEN Gruppe, zu der es gehört: ein Hybrid-Wechselrichter
 *   steht unter Erzeugung (seinen Ladestand zeigen Anlagenkopf und Aufklappen), eine Wallbox unter Laden; Heizstab,
 *   Wärmepumpe, Schalter und Unterzähler stehen unter Verbrauch; eine Anlagensteuerung unter Erzeugung.
 * - **Darin nach Namen**, natürlich („Kaco 2" vor „Kaco 10"); im Verbrauch die Unterzähler zuerst. Nie nach
 *   Leistung - die Zeilen sprängen sonst bei jedem Takt.
 * - **Kopf mit Anzahl und ehrlicher Summe**: eine Summe steht nur bei mindestens zwei Zeilen, die ALLE einen
 *   aktuellen Wert ihrer Gruppe haben; sonst „1 Gerät ohne aktuellen Wert", nie eine Teilsumme und nie eine 0
 *   (dieselbe Regel wie `groupHeadline` in `komponenten.ts`).
 * - **Nichts doppelt zählen**: mischt die Verbrauchsgruppe Unterzähler und einzelne Verbraucher, entfällt ihre
 *   Summe - ein Heizstab kann hinter einer Unterverteilung hängen, und welche Zuordnung gilt, weiß das Portal nicht.
 *   Aus demselben Grund summiert das Netz nie (zwei Zähler messen oft denselben Anschluss), und ein Ladestand in %
 *   lässt sich nicht addieren.
 * - **Köpfe erst ab zwei Gruppen** an einem Ort (Box bzw. Anlage ohne Box); sonst nur sortiert.
 *
 * Rein + deterministisch: kein React, kein Netz, keine Uhr.
 */
import { komponenteAktuell, type AufbauGeraet, type AufbauKategorie, type AufbauWert, type AufbauWertArt } from './aufbauBaum';
import type { IconName } from '../designsystem/components/core/Icon';
import type { PlantComponent } from './komponenten';
import { fmtNum } from './format';
import { istAnlagensteuerungGeraet } from './geraetAdresse';
import { AUFBAU_ERZEUGUNG, AUFBAU_LADEN, AUFBAU_NETZ, AUFBAU_SPEICHER, AUFBAU_VERBRAUCH } from './glossar';

export type GeraeteGruppe = 'erzeugung' | 'speicher' | 'netz' | 'verbrauch' | 'laden';

/** Die Reihenfolge des Anlagenkopfs (PV · Speicher · Netz) und von „Rollen & Zuordnung", Laden zuletzt. */
export const GRUPPEN_ORDNUNG: readonly GeraeteGruppe[] = ['erzeugung', 'speicher', 'netz', 'verbrauch', 'laden'];

/** Dieselben Wörter wie im Energiefluss und im Cockpit („Verbrauch im Detail"). */
export const GRUPPE_WORT: Record<GeraeteGruppe, string> = {
  erzeugung: AUFBAU_ERZEUGUNG,
  speicher: AUFBAU_SPEICHER,
  netz: AUFBAU_NETZ,
  verbrauch: AUFBAU_VERBRAUCH,
  laden: AUFBAU_LADEN,
};

/** Symbol und Farbe des Kopfs - die Kategorie-Farben des Aufbaus, damit die Seite in sich stimmt. */
export const GRUPPE_SYMBOL: Record<GeraeteGruppe, { kategorie: AufbauKategorie; icon: IconName }> = {
  erzeugung: { kategorie: 'solar', icon: 'sun' },
  speicher: { kategorie: 'battery', icon: 'battery' },
  netz: { kategorie: 'grid', icon: 'activity' },
  verbrauch: { kategorie: 'home', icon: 'home' },
  laden: { kategorie: 'ev', icon: 'zap' },
};

/** Der Wert, den eine Zeile in ihrer Gruppe ZUERST zeigt - damit sich die Summe im Kopf nachrechnen lässt. */
const GRUPPE_WERTE: Record<GeraeteGruppe, readonly AufbauWertArt[]> = {
  erzeugung: ['pv'],
  speicher: ['speicher'],
  netz: ['netz'],
  verbrauch: ['verbraucher', 'haus'],
  laden: ['laden', 'verbraucher'],
};

/** Ein reiner Zähler in einer Unterverteilung (Typkatalog `sub-meter`, PR 1776). */
export const UNTERZAEHLER_TYP = 'sub-meter';

/** Die Rolle der gemeldeten Quelle (`localSetup.role`) - nur für ein Gerät, das noch keine Komponente trägt. */
const QUELLROLLE_GRUPPE: Record<string, GeraeteGruppe> = {
  'pv-generation': 'erzeugung',
  'grid-meter': 'netz',
  consumer: 'verbrauch',
};

/** Misst dieses Gerät eine Unterverteilung? */
export function istUnterzaehler(komponenten: readonly Pick<PlantComponent, 'entityType'>[]): boolean {
  return komponenten.some((c) => c.entityType === UNTERZAEHLER_TYP);
}

/** Misst dieses Gerät den Netzanschluss - die Wurzel des Zählerbaums? */
export function istNetzanschluss(komponenten: readonly Pick<PlantComponent, 'role'>[]): boolean {
  return komponenten.some((c) => c.role === 'grid');
}

/**
 * Zählerbaum-Konzept (R1): hängt dieses Gerät hinter einer anderen Komponente
 * (einem Zähler), statt direkt an der Wurzel? Sein Wert steckt dann schon im
 * Wert dieser Eltern-Komponente - der Gruppenkopf darf ihn nicht noch einmal
 * mitzählen (`gruppenKopf` unten).
 */
export function haengtHinterEinemZaehler(komponenten: readonly Pick<PlantComponent, 'haengtAn'>[]): boolean {
  return komponenten.some((c) => c.haengtAn != null);
}

/** Ab diesem Betrag heißt ein negativer Rest „Messwerte passen nicht zusammen" (R3) - dieselbe Toleranz wie die Rest-Zeile des Cockpits (`verbrauchKomposition.ts`). */
const REST_KONFLIKT_TOLERANZ_KW = 0.2;

/** Der Eingang von `restEinesKnotens`: eine gemessene Leistung (null = kein aktueller Wert) und ihr Name für die Begründung. */
export interface RestEingabe {
  kw: number | null;
  label: string;
}

/** Der Rest-Wert eines Knotens, oder warum es keinen gibt (R2/R3). */
export interface RestErgebnis {
  kw: number | null;
  note: string | null;
  konflikt: boolean;
}

/**
 * Der Rest EINES Knotens im Zählerbaum (Vertrag §3.1 „Rest je Knoten", §3.2 R1-R3): sein eigener Wert minus
 * die Summe seiner DIREKTEN Kinder - dieselbe Regel wie die Rest-Zeile des Cockpits (`verbrauchKomposition.ts`
 * `restZeile`), hier für jeden Knoten der Geräteliste statt nur für das Haus. R2: fehlt der eigene Wert oder
 * der eines Kindes, ist der Rest „nicht bestimmbar", nie eine Zahl, die die Lücke verschweigt. R3: ein Rest
 * unter der Toleranz heißt „Messwerte passen nicht zusammen", nie auf 0 geklemmt.
 */
export function restEinesKnotens(eigen: RestEingabe, kinder: readonly RestEingabe[]): RestErgebnis {
  if (eigen.kw == null) {
    return { kw: null, note: `nicht bestimmbar (${eigen.label} meldet sich gerade nicht)`, konflikt: false };
  }
  const blocker = kinder.find((k) => k.kw == null);
  if (blocker) {
    return { kw: null, note: `nicht bestimmbar (${blocker.label} meldet sich gerade nicht)`, konflikt: false };
  }
  const summe = kinder.reduce((s, k) => s + (k.kw as number), 0);
  const diff = Math.round((eigen.kw - summe) * 1000) / 1000;
  if (diff < -REST_KONFLIKT_TOLERANZ_KW) {
    return { kw: null, note: `Messwerte passen nicht zusammen (${fmtNum(diff, 'kW')})`, konflikt: true };
  }
  return { kw: Math.max(diff, 0), note: null, konflikt: false };
}

/**
 * In welche Gruppe ein Gerät gehört - die erste, zu der es passt; null = es gehört in keine (ein Fund oder
 * „Nicht mehr verbunden": beide bleiben am Ende des Orts).
 */
export function gruppeFuer(
  karte: { id: string; art: string; komponenten: readonly Pick<PlantComponent, 'role'>[] },
  setup?: { role?: string | null; kind?: string | null } | null,
): GeraeteGruppe | null {
  if (karte.art === 'neu' || karte.art === 'verwaist') return null;
  if (karte.art === 'ladepunkt') return 'laden';
  // Eine Anlagensteuerung regelt Erzeugung; ihre Einheiten stehen unter ihr.
  if (istAnlagensteuerungGeraet(karte.id)) return 'erzeugung';
  const rollen = new Set(karte.komponenten.map((c) => c.role));
  if (rollen.has('pv')) return 'erzeugung';
  if (rollen.has('storage')) return 'speicher';
  if (rollen.has('grid')) return 'netz';
  if (rollen.has('consumer') || rollen.has('house')) return 'verbrauch';
  // Noch ohne Komponente („Misst noch nichts."): die gemeldete Rolle, ein Wechselrichter erzeugt.
  if (setup?.kind === 'inverter') return 'erzeugung';
  return QUELLROLLE_GRUPPE[setup?.role ?? ''] ?? 'verbrauch';
}

/** Die Chips einer Zeile mit dem Wert ihrer Gruppe vorn (sonst unverändert, stabil). */
export function werteFuerGruppe(werte: AufbauWert[], gruppe: GeraeteGruppe | null): AufbauWert[] {
  if (!gruppe) return werte;
  const passend = GRUPPE_WERTE[gruppe];
  const vorn = werte.filter((w) => passend.includes(w.art));
  return vorn.length === 0 ? werte : [...vorn, ...werte.filter((w) => !passend.includes(w.art))];
}

const natuerlich = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** Die Gruppe eines Geräts im Baum; ein Gerät ohne Gruppe steht nach allen Gruppen. */
function rang(g: AufbauGeraet): number {
  return g.gruppe == null ? GRUPPEN_ORDNUNG.length : GRUPPEN_ORDNUNG.indexOf(g.gruppe);
}

/**
 * Die Lese-Reihenfolge an einem Ort: nach Gruppe, darin die Unterzähler zuerst, dann nach Namen (natürlich).
 * Funde und „Nicht mehr verbunden" bleiben in ihrer Folge am Ende.
 */
export function sortiereGeraete<T extends AufbauGeraet>(geraete: readonly T[]): T[] {
  return [...geraete].sort((a, b) => {
    const r = rang(a) - rang(b);
    if (r !== 0) return r;
    if (a.gruppe == null) return 0;
    const u = Number(istUnterzaehler(b.karte.komponenten)) - Number(istUnterzaehler(a.karte.komponenten));
    return u !== 0 ? u : natuerlich.compare(a.titel, b.titel);
  });
}

/** Wie viele Gruppen an einem Ort stehen - Köpfe erst ab zwei. */
export function gruppenZahl(geraete: readonly AufbauGeraet[]): number {
  return new Set(geraete.map((g) => g.gruppe).filter((x) => x != null)).size;
}

/** Der Kopf einer Gruppe. */
export interface GruppenKopf {
  gruppe: GeraeteGruppe;
  wort: string;
  anzahl: number;
  /** Die Summe der Zeilen („7,9 kW", „2 von 4 laden · 18,2 kW"); null = keine (siehe `hinweis`). */
  summe: string | null;
  /** „1 Gerät ohne aktuellen Wert" - statt einer Teilsumme; null = keiner. */
  hinweis: string | null;
  /** Vollständig für Screenreader: „Erzeugung, 3 Geräte, zusammen 7,9 kW". */
  label: string;
}

const geraeteWort = (n: number) => `${n} ${n === 1 ? 'Gerät' : 'Geräte'}`;

/**
 * Die Leistung EINER Zeile in ihrer Gruppe (kW, Betrag); null = kein aktueller Wert in kW. „Aktuell“ nach derselben
 * Regel wie der Anlagenkopf (`komponenteAktuell`, PR 1778): die PV-Summe einer Anlage mit einer Box ist dann genau die
 * PV im Kopf.
 */
function zeilenKw(g: AufbauGeraet, gruppe: 'erzeugung' | 'verbrauch'): number | null {
  const rollen = gruppe === 'erzeugung' ? ['pv'] : ['consumer', 'house'];
  const teile = g.karte.komponenten.filter((c) => rollen.includes(c.role));
  // Eine Komponente der Gruppe ohne aktuellen Wert macht die Zeile unvollständig - nie still weglassen.
  if (teile.length === 0 || !teile.every(komponenteAktuell)) return null;
  const r = teile.map((c) => c.reading!).filter((x) => x.unit === 'kW');
  return r.length === 0 ? null : r.reduce((s, x) => s + x.value, 0);
}

/** „1 von 1 lädt · 11,0 kW" / „2 von 4 laden · 18,2 kW" / „lädt gerade nicht" - der Wortlaut des Cockpits. */
function ladenSumme(ladungen: readonly NonNullable<AufbauGeraet['ladung']>[]): string {
  const ladend = ladungen.filter((l) => l.laedt);
  if (ladend.length === 0) return 'lädt gerade nicht';
  const zahl = `${ladend.length} von ${ladungen.length} ${ladend.length === 1 ? 'lädt' : 'laden'}`;
  const kw = ladend.map((l) => l.kw);
  return kw.every((x): x is number => x != null)
    ? `${zahl} · ${fmtNum(kw.reduce((s, x) => s + x, 0), 'kW')}`
    : `${zahl} · Leistung nicht messbar`;
}

/**
 * Der Kopf einer Gruppe aus ihren Zeilen (nur denen der obersten Ebene - die Einheiten einer Steuerung tragen ihre
 * Leistung schon in der Steuerung). `teilmenge` = Suche oder Filter blenden Zeilen aus: dann keine Summe, denn sie
 * wäre eine Teilsumme.
 */
export function gruppenKopf(
  gruppe: GeraeteGruppe,
  geraete: readonly AufbauGeraet[],
  teilmenge = false,
): GruppenKopf {
  const wort = GRUPPE_WORT[gruppe];
  const anzahl = geraete.length;
  let summe: string | null = null;
  let ohneWert = 0;
  if (!teilmenge) {
    if (gruppe === 'erzeugung' || gruppe === 'verbrauch') {
      // Zählerbaum-Konzept R1: eine Zeile, die hinter einem Zähler dieser
      // Gruppe hängt, steckt schon in dessen Wert - sie bekommt zwar eine
      // eigene Zeile, geht aber nicht noch einmal in die Summe ein (genau der
      // gemeldete Fall: UV Halle 7,7 kW samt Kompressor 3,2 kW darin, nie
      // 7,7 + 3,2 im Kopf).
      const zaehlbar = gruppe === 'verbrauch'
        ? geraete.filter((g) => !haengtHinterEinemZaehler(g.karte.komponenten))
        : geraete;
      const kw = zaehlbar.map((g) => zeilenKw(g, gruppe));
      ohneWert = kw.filter((x) => x == null).length;
      const gemischt =
        gruppe === 'verbrauch' &&
        zaehlbar.some((g) => istUnterzaehler(g.karte.komponenten)) &&
        zaehlbar.some((g) => !istUnterzaehler(g.karte.komponenten));
      if (zaehlbar.length >= 2 && ohneWert === 0 && !gemischt) {
        summe = fmtNum((kw as number[]).reduce((s, x) => s + x, 0), 'kW');
      }
    } else if (gruppe === 'laden') {
      const ladungen = geraete.map((g) => (g.ton === 'ok' ? g.ladung : null));
      ohneWert = ladungen.filter((l) => l == null).length;
      if (anzahl >= 2 && ohneWert === 0) summe = ladenSumme(ladungen as NonNullable<AufbauGeraet['ladung']>[]);
    } else {
      // Netz und Speicher summieren nicht; sie sagen nur, wer keinen aktuellen Wert hat.
      const rolle = gruppe === 'netz' ? 'grid' : 'storage';
      ohneWert = geraete.filter((g) => !g.karte.komponenten.some((c) => c.role === rolle && komponenteAktuell(c))).length;
    }
  }
  const hinweis = ohneWert > 0 ? `${geraeteWort(ohneWert)} ohne aktuellen Wert` : null;
  const label = [wort, geraeteWort(anzahl), summe ? `zusammen ${summe}` : null, hinweis].filter(Boolean).join(', ');
  return { gruppe, wort, anzahl, summe, hinweis, label };
}
