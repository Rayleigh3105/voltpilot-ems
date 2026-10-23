/**
 * Der AUFBAU als TABELLE mit Gruppen: Anlage → Box → Gerät → Messwert.
 *
 * Konzept „Aufbau und Gerätekatalog" (Runde 2, Entscheide K1–K6 = A vom
 * 25.09.2026). Der Baum der ersten Runde las sich nicht seriös genug, und es
 * fehlten Suche und Filter. Die DATEN sind unverändert die des Baums
 * (`aufbauBaum.ts`); dieses Modul legt sie als flache Zeilenfolge mit Ebenen
 * aus und entscheidet, was Suche und Filter zeigen.
 *
 * - **Gruppen bleiben sichtbar.** Ein Treffer zeigt immer auch seine Anlage und
 *   seine Box - ein Gerät ohne Ort wäre bei zwei Boxen nicht mehr zuzuordnen.
 * - **Suche = die EINE tolerante Suche** (`picker/suche.ts`): „sun12k" findet
 *   „SUN-12K-SG04LP3-EU", auf jeder Fläche gleich.
 * - **K5 · Messwerte als Unterzeilen.** Ein Gerät mit mehreren Komponenten
 *   klappt sie auf; die Gerätezeile trägt den Hauptwert.
 * - **GE-1 · je Kasten ein Eintrag.** Ein Weg ist keine Zeile; nur ein Gateway
 *   (mit seinen Geräten darunter) und ein Anschluss ohne Gerät stehen da. Die
 *   Kennung („DQ-1") und die Adresse findet die Suche am Gerät.
 * - **GE-3 · Einheiten hinter der Steuerung.** Die Wechselrichter einer
 *   Anlagensteuerung stehen immer sichtbar eine Ebene unter ihr (keine
 *   Aufklapp-Zeile: sie sind Geräte, keine Messwerte). Trifft nur eine Einheit,
 *   steht ihre Steuerung als Ort mit da.
 *
 * Rein + deterministisch: kein React, kein Netz, keine Uhr. Die Fläche
 * (`components/AufbauTabelle.tsx`) rendert nur, was hier entschieden wird.
 */
import type { AufbauAnlage, AufbauBaum, AufbauBox, AufbauGeraet, AufbauWeg } from './aufbauBaum';
import type { PlantComponent } from './komponenten';
import { normalisiereSuche, passt, suchBegriffe } from './picker/suche';

export type FilterSchluessel = 'art' | 'zustand' | 'box' | 'marke';

/** Zustand in drei Klassen - dieselben Töne wie überall (ok · warn/off · gemeldet). */
export type ZustandKlasse = 'ok' | 'achtung' | 'gemeldet';

export interface AufbauFilter {
  q: string;
  art: string[];
  zustand: string[];
  box: string[];
  marke: string[];
}

export const LEERER_FILTER: AufbauFilter = { q: '', art: [], zustand: [], box: [], marke: [] };

export const FILTER_LABEL: Record<FilterSchluessel, string> = {
  art: 'Art',
  zustand: 'Zustand',
  box: 'Box',
  marke: 'Hersteller',
};

export const ZUSTAND_LABEL: Record<ZustandKlasse, string> = {
  ok: 'In Ordnung',
  achtung: 'Braucht Aufmerksamkeit',
  gemeldet: 'Von der Box gemeldet',
};

/** Der Hersteller eines Geräts, das keinen meldet (Ladesäule, Eigenbau). */
export const OHNE_MARKE = 'Ohne Herstellerangabe';
/** Die „Box" eines Geräts, dessen Box das Portal nicht sicher kennt (`aufbauBaum`). */
export const OHNE_BOX = 'ohne-box';
const OHNE_BOX_LABEL = 'Ohne sichere Box';

export function zustandVon(g: AufbauGeraet): ZustandKlasse {
  if (g.art === 'neu') return 'gemeldet';
  return g.ton === 'ok' ? 'ok' : 'achtung';
}

/**
 * Die Art für den FILTER: „Hybrid-Wechselrichter · Hauptgerät" gruppiert als
 * „Hybrid-Wechselrichter" - gefiltert wird nach der Art, nicht nach der Rolle.
 */
export function artVon(g: AufbauGeraet): string {
  return g.artWort.split(' · ')[0];
}

export function markeVon(g: AufbauGeraet): string {
  return g.marke ?? OHNE_MARKE;
}

/** Wonach ein Gerät gefunden wird: sein Name, Modell, Art, Hersteller, Kennung, Anbindung und Ort. */
function heuhaufen(g: AufbauGeraet, box: AufbauBox | null, anlage: AufbauAnlage): string {
  return normalisiereSuche(
    [
      g.titel,
      g.unterzeile,
      g.artWort,
      g.marke ?? '',
      g.kennung ?? '',
      ...g.karte.komponenten.map((c) => c.label),
      // GE-1: der Weg steht am Gerät — Adresse und Kennung („DQ-1") finden es, auch die seines Gateways.
      g.anbindungText ?? '',
      ...g.anbindungen.flatMap((a) => [a.kennzeichen, a.weg]),
      g.gateway?.titel ?? '',
      box?.name ?? '',
      box?.ref ?? '',
      anlage.name,
    ].join(' '),
  );
}

/** Wonach ein Weg mit eigener Zeile (Gateway, Anschluss ohne Gerät) gefunden wird: Name, Weg, Kennung und Ort. */
function wegTrifft(w: AufbauWeg, box: AufbauBox | null, f: AufbauFilter, begriffe: string[]): boolean {
  // Art, Zustand und Hersteller beschreiben Geräte — mit einem dieser Filter steht ein Weg nur über seine Geräte da.
  if (f.art.length + f.zustand.length + f.marke.length > 0) return false;
  if (f.box.length > 0 && !f.box.includes(box?.id ?? OHNE_BOX)) return false;
  return (
    begriffe.length === 0 ||
    passt(normalisiereSuche([w.titel, w.weg, w.kennzeichen, box?.name ?? '', box?.ref ?? ''].join(' ')), begriffe)
  );
}

export function filterAktiv(f: AufbauFilter): boolean {
  return f.q.trim() !== '' || f.art.length + f.zustand.length + f.box.length + f.marke.length > 0;
}

function trifft(
  g: AufbauGeraet,
  box: AufbauBox | null,
  anlage: AufbauAnlage,
  f: AufbauFilter,
  begriffe: string[],
): boolean {
  if (begriffe.length > 0 && !passt(heuhaufen(g, box, anlage), begriffe)) return false;
  if (f.art.length > 0 && !f.art.includes(artVon(g))) return false;
  if (f.zustand.length > 0 && !f.zustand.includes(zustandVon(g))) return false;
  if (f.box.length > 0 && !f.box.includes(box?.id ?? OHNE_BOX)) return false;
  if (f.marke.length > 0 && !f.marke.includes(markeVon(g))) return false;
  return true;
}

export type TabellenZeile =
  | { typ: 'anlage'; key: string; ebene: number; anlage: AufbauAnlage; offen: boolean }
  | { typ: 'box'; key: string; ebene: number; anlage: AufbauAnlage; box: AufbauBox; offen: boolean }
  | {
      typ: 'geraet';
      key: string;
      ebene: number;
      anlage: AufbauAnlage;
      box: AufbauBox | null;
      geraet: AufbauGeraet;
      /** Hat es mehr als eine Komponente (dann klappen sie als Unterzeilen auf)? */
      teilbar: boolean;
      offen: boolean;
    }
  | { typ: 'teil'; key: string; ebene: number; anlage: AufbauAnlage; geraet: AufbauGeraet; komponente: PlantComponent }
  /** Ein Gateway (1 : N, GE-1): ein Kasten, kein Gerät — seine Geräte stehen eine Ebene tiefer. */
  | { typ: 'gateway'; key: string; ebene: number; anlage: AufbauAnlage; box: AufbauBox | null; weg: AufbauWeg; offen: boolean }
  /** Ein Anschluss ohne Gerät (1 : 0, GE-1) — kein Gerät, darum fällt er aus Art-, Zustand- und Herstellerfilter. */
  | { typ: 'anschluss'; key: string; ebene: number; anlage: AufbauAnlage; box: AufbauBox | null; weg: AufbauWeg }
  | {
      typ: 'fund';
      key: string;
      ebene: number;
      anlage: AufbauAnlage;
      box: AufbauBox | null;
      geraet: AufbauGeraet;
    }
  | {
      typ: 'leer';
      key: string;
      ebene: number;
      anlage: AufbauAnlage;
      text: string;
      /** Führt die Zeile zum Hinzufügen einer Box (nur an der geöffneten Anlage)? */
      boxHinzufuegen: boolean;
    };

export interface Aufklappzustand {
  /** Ist dieser Knoten (Anlage/Box/Gateway) offen? `vorgabe` gilt, solange niemand klickte. */
  offen: (id: string, vorgabe: boolean) => boolean;
  /** Die aufgeklappten Geräte - ihre Messwerte stehen als Unterzeilen darunter. */
  geraete: ReadonlySet<string>;
}

function geraeteZeilen(
  out: TabellenZeile[],
  anlage: AufbauAnlage,
  box: AufbauBox | null,
  geraete: AufbauGeraet[],
  ebene: number,
  z: Aufklappzustand,
  einheiten: ReadonlyMap<string, AufbauGeraet[]> = new Map(),
): void {
  for (const g of geraete) {
    if (g.art === 'neu') {
      out.push({ typ: 'fund', key: g.id, ebene, anlage, box, geraet: g });
      continue;
    }
    const teilbar = g.karte.komponenten.length > 1;
    const offen = teilbar && z.geraete.has(g.id);
    out.push({ typ: 'geraet', key: g.id, ebene, anlage, box, geraet: g, teilbar, offen });
    if (offen) {
      for (const c of g.karte.komponenten) {
        out.push({ typ: 'teil', key: `${g.id}::${c.id}`, ebene: ebene + 1, anlage, geraet: g, komponente: c });
      }
    }
    // GE-3: die Einheiten hinter einer Steuerung — Geräte, eine Ebene tiefer, immer sichtbar.
    for (const u of einheiten.get(g.id) ?? []) {
      out.push({ typ: 'geraet', key: u.id, ebene: ebene + 1, anlage, box, geraet: u, teilbar: false, offen: false });
    }
  }
}

/**
 * Die Zeilen EINES Orts (Box oder Anlage ohne Box): seine Geräte, die Gateways mit ihren Geräten darunter und die
 * Anschlüsse ohne Gerät. Mit Suche und Filter nur, was trifft — ein Gateway auch, wenn eins seiner Geräte trifft.
 * Gibt die Zahl der Treffer zurück.
 */
function ortZeilen(
  out: TabellenZeile[],
  anlage: AufbauAnlage,
  box: AufbauBox | null,
  geraete: AufbauGeraet[],
  wege: AufbauWeg[],
  ebene: number,
  f: AufbauFilter,
  begriffe: string[],
  z: Aufklappzustand,
): number {
  const aktiv = filterAktiv(f);
  const trifftHier = (g: AufbauGeraet) => trifft(g, box, anlage, f, begriffe);
  // GE-3: die Einheiten stehen unter ihrer Steuerung, nie für sich — und eine treffende Einheit trägt ihre Steuerung mit.
  const einheiten = new Map<string, AufbauGeraet[]>();
  for (const g of geraete) {
    if (g.einheit && trifftHier(g)) einheiten.set(g.einheit.steuerungId, [...(einheiten.get(g.einheit.steuerungId) ?? []), g]);
  }
  const traegt = (g: AufbauGeraet) => !g.einheit && (trifftHier(g) || einheiten.has(g.id));
  const gateways = wege.filter((w) => w.art === 'gateway');
  const amGateway = new Set(gateways.flatMap((w) => w.geraete.map((g) => g.id)));
  const direkt = geraete.filter((g) => !amGateway.has(g.id) && traegt(g));
  const sichtbar = gateways
    .map((w) => ({ w, geraete: w.geraete.filter(traegt) }))
    .filter(({ w, geraete: g }) => !aktiv || g.length > 0 || wegTrifft(w, box, f, begriffe));
  const offene = wege.filter((w) => w.art === 'offen' && (!aktiv || wegTrifft(w, box, f, begriffe)));
  geraeteZeilen(out, anlage, box, direkt, ebene, z, einheiten);
  const ort = box?.id ?? `${anlage.id}::ohne-box`;
  for (const { w, geraete: dahinter } of sichtbar) {
    const offen = aktiv || z.offen(w.id, true);
    out.push({ typ: 'gateway', key: `${ort}::gateway::${w.id}`, ebene, anlage, box, weg: w, offen });
    if (offen) geraeteZeilen(out, anlage, box, dahinter, ebene + 1, z, einheiten);
  }
  for (const w of offene) out.push({ typ: 'anschluss', key: `${ort}::anschluss::${w.id}`, ebene, anlage, box, weg: w });
  const unter = (liste: AufbauGeraet[]) => liste.reduce((n, g) => n + (einheiten.get(g.id)?.length ?? 0), 0);
  return (
    direkt.length + unter(direkt) + sichtbar.reduce((n, x) => n + 1 + x.geraete.length + unter(x.geraete), 0) + offene.length
  );
}

/** Der Ort ohne Zeilen — nur zum Zählen der Treffer, bevor die Gruppe entschieden ist. */
function ortTreffer(
  anlage: AufbauAnlage,
  box: AufbauBox | null,
  geraete: AufbauGeraet[],
  wege: AufbauWeg[],
  f: AufbauFilter,
  begriffe: string[],
): number {
  return ortZeilen([], anlage, box, geraete, wege, 0, f, begriffe, { offen: () => false, geraete: new Set() });
}

/**
 * Die Zeilen der Tabelle in Lese-Reihenfolge.
 *
 * Ohne Suche und Filter gilt der Aufklappzustand; mit ihnen ist jede Gruppe,
 * die einen Treffer trägt, offen, und Gruppen ohne Treffer entfallen.
 */
export function tabellenZeilen(
  baum: AufbauBaum,
  f: AufbauFilter,
  z: Aufklappzustand,
): TabellenZeile[] {
  const aktiv = filterAktiv(f);
  const begriffe = suchBegriffe(f.q);
  const out: TabellenZeile[] = [];
  for (const a of baum.anlagen) {
    const boxen = a.boxen.map((b) => ({ b, treffer: ortTreffer(a, b, b.geraete, b.wege, f, begriffe) }));
    const ohneBox = ortTreffer(a, null, a.ohneBox, a.wegeOhneBox, f, begriffe);
    const summe = boxen.reduce((n, x) => n + x.treffer, 0) + ohneBox;
    if (aktiv && summe === 0) continue;
    const aOffen = aktiv || z.offen(a.id, a.aktuell);
    out.push({ typ: 'anlage', key: a.id, ebene: 0, anlage: a, offen: aOffen });
    if (!aOffen) continue;
    for (const { b, treffer } of boxen) {
      if (aktiv && treffer === 0) continue;
      const bOffen = aktiv || z.offen(b.id, true);
      out.push({ typ: 'box', key: b.id, ebene: 1, anlage: a, box: b, offen: bOffen });
      if (!bOffen) continue;
      ortZeilen(out, a, b, b.geraete, b.wege, 2, f, begriffe, z);
      if (!aktiv && b.geraete.length === 0 && b.wege.length === 0) {
        out.push({
          typ: 'leer',
          key: `${b.id}::leer`,
          ebene: 2,
          anlage: a,
          text: a.aktuell || a.geraeteZahl != null ? 'Noch kein Gerät an dieser Box' : 'Wird geladen …',
          boxHinzufuegen: false,
        });
      }
    }
    ortZeilen(out, a, null, a.ohneBox, a.wegeOhneBox, 1, f, begriffe, z);
    if (!aktiv && a.boxen.length === 0) {
      out.push({
        typ: 'leer',
        key: `${a.id}::ohne-box`,
        ebene: 1,
        anlage: a,
        text: 'Noch keine VoltPilot-Box',
        boxHinzufuegen: a.aktuell,
      });
    }
  }
  return out;
}

export interface FilterOption {
  wert: string;
  label: string;
  anzahl: number;
}

interface Eintrag {
  g: AufbauGeraet;
  box: AufbauBox | null;
  anlage: AufbauAnlage;
}

function eintraege(baum: AufbauBaum): Eintrag[] {
  const out: Eintrag[] = [];
  for (const anlage of baum.anlagen) {
    for (const box of anlage.boxen) for (const g of box.geraete) out.push({ g, box, anlage });
    for (const g of anlage.ohneBox) out.push({ g, box: null, anlage });
  }
  return out;
}

function zaehle(liste: Eintrag[], schluessel: (e: Eintrag) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of liste) {
    const k = schluessel(e);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/**
 * Die Auswahl je Filter, mit der Anzahl je Eintrag - gezählt über alles, was
 * geladen ist (die geöffnete Anlage und aufgeklappte Nachbarn am Standort).
 */
export function filterOptionen(baum: AufbauBaum): Record<FilterSchluessel, FilterOption[]> {
  const alle = eintraege(baum);
  const deutsch = (a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label, 'de');
  const art = [...zaehle(alle, (e) => artVon(e.g))].map(([wert, anzahl]) => ({ wert, label: wert, anzahl }));
  const zustaende = zaehle(alle, (e) => zustandVon(e.g));
  const zustand = (Object.keys(ZUSTAND_LABEL) as ZustandKlasse[])
    .filter((k) => zustaende.has(k))
    .map((k) => ({ wert: k, label: ZUSTAND_LABEL[k], anzahl: zustaende.get(k) ?? 0 }));
  const jeBox = zaehle(alle, (e) => e.box?.id ?? OHNE_BOX);
  const box: FilterOption[] = [];
  for (const a of baum.anlagen) {
    for (const b of a.boxen) {
      box.push({ wert: b.id, label: a.aktuell ? b.name : `${b.name} · Anlage ${a.name}`, anzahl: jeBox.get(b.id) ?? 0 });
    }
  }
  if (jeBox.has(OHNE_BOX)) box.push({ wert: OHNE_BOX, label: OHNE_BOX_LABEL, anzahl: jeBox.get(OHNE_BOX) ?? 0 });
  const marke = [...zaehle(alle, (e) => markeVon(e.g))]
    .map(([wert, anzahl]) => ({ wert, label: wert, anzahl }))
    // „Ohne Herstellerangabe" steht zuletzt - es ist keine Marke.
    .sort((a, b) => Number(a.wert === OHNE_MARKE) - Number(b.wert === OHNE_MARKE) || deutsch(a, b));
  return { art: art.sort(deutsch), zustand, box, marke };
}

/** Ein aktiver Filter als Chip unter der Werkzeugleiste. */
export interface AktiverFilter {
  schluessel: FilterSchluessel;
  wert: string;
  label: string;
}

export function aktiveFilter(
  f: AufbauFilter,
  optionen: Record<FilterSchluessel, FilterOption[]>,
): AktiverFilter[] {
  const out: AktiverFilter[] = [];
  for (const schluessel of Object.keys(FILTER_LABEL) as FilterSchluessel[]) {
    for (const wert of f[schluessel]) {
      const opt = optionen[schluessel].find((o) => o.wert === wert);
      out.push({ schluessel, wert, label: `${FILTER_LABEL[schluessel]}: ${opt?.label ?? wert}` });
    }
  }
  return out;
}

export interface AufbauZahlen {
  /** Angelegte Geräte der geöffneten Anlage (ohne Gemeldetes). */
  geraete: number;
  /** Gateways der geöffneten Anlage — Kästen, aber keine Geräte (GE-1). */
  gateways: number;
  /** Davon sichtbar unter Suche und Filter. */
  treffer: number;
  /** Was Aufmerksamkeit braucht (Zustand nicht in Ordnung), an der geöffneten Anlage. */
  achtung: number;
  /** Von der Box gemeldet, noch nicht übernommen, an der geöffneten Anlage. */
  gemeldet: number;
  aktiv: boolean;
}

/** Die Zahlen über der Tabelle - sie beziehen sich auf die geöffnete Anlage. */
export function aufbauZahlen(baum: AufbauBaum, f: AufbauFilter): AufbauZahlen {
  const begriffe = suchBegriffe(f.q);
  const hier = eintraege(baum).filter((e) => e.anlage.aktuell);
  const geraete = hier.filter((e) => e.g.art === 'geraet' || e.g.art === 'ladepunkt');
  const aktuelle = baum.anlagen.filter((a) => a.aktuell);
  const wege = aktuelle.flatMap((a) => [...a.boxen.flatMap((b) => b.wege), ...a.wegeOhneBox]);
  return {
    geraete: geraete.length,
    gateways: wege.filter((w) => w.art === 'gateway').length,
    treffer: geraete.filter((e) => trifft(e.g, e.box, e.anlage, f, begriffe)).length,
    achtung: hier.filter((e) => zustandVon(e.g) === 'achtung').length,
    gemeldet: hier.filter((e) => zustandVon(e.g) === 'gemeldet').length,
    aktiv: filterAktiv(f),
  };
}

/** Ein Filterwert an- oder abgewählt - Mehrfachauswahl je Filter. */
export function mitFilter(f: AufbauFilter, schluessel: FilterSchluessel, werte: string[]): AufbauFilter {
  return { ...f, [schluessel]: werte };
}

/** Ein Kurzfilter („braucht Aufmerksamkeit"): ersetzt Suche und Filter durch genau ihn. */
export function kurzfilter(zustand: ZustandKlasse): AufbauFilter {
  return { ...LEERER_FILTER, zustand: [zustand] };
}

const mehrzahl = (n: number, eins: string, viele: string) => `${n} ${n === 1 ? eins : viele}`;

/** Gateways an einem Ort: „1 Gateway"; null = keins. */
export function gatewaySatz(wege: readonly AufbauWeg[]): string | null {
  const n = wege.filter((w) => w.art === 'gateway').length;
  return n > 0 ? mehrzahl(n, 'Gateway', 'Gateways') : null;
}

/**
 * Was an einer Box hängt, in Kästen gezählt (GE-1): „1 Gerät", „4 Geräte · 1 Gateway", „6 Geräte · 1 Gateway ·
 * 1 Anschluss offen". Das Gateway ist ein Kasten, aber kein Gerät — es zählt getrennt; Gemeldetes zählt nicht.
 */
export function kastenSatz(geraete: readonly AufbauGeraet[], wege: readonly AufbauWeg[]): string {
  const offen = wege.filter((w) => w.art === 'offen').length;
  return [
    mehrzahl(geraete.filter((g) => g.art !== 'neu').length, 'Gerät', 'Geräte'),
    gatewaySatz(wege),
    offen > 0 ? mehrzahl(offen, 'Anschluss offen', 'Anschlüsse offen') : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
