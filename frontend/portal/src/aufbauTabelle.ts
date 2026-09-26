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
 *
 * Rein + deterministisch: kein React, kein Netz, keine Uhr. Die Fläche
 * (`components/AufbauTabelle.tsx`) rendert nur, was hier entschieden wird.
 */
import type { AufbauAnlage, AufbauBaum, AufbauBox, AufbauGeraet } from './aufbauBaum';
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

/** Wonach ein Gerät gefunden wird: sein Name, Modell, Art, Hersteller, Kennung und Ort. */
function heuhaufen(g: AufbauGeraet, box: AufbauBox | null, anlage: AufbauAnlage): string {
  return normalisiereSuche(
    [
      g.titel,
      g.unterzeile,
      g.artWort,
      g.marke ?? '',
      g.kennung ?? '',
      ...g.karte.komponenten.map((c) => c.label),
      box?.name ?? '',
      box?.ref ?? '',
      anlage.name,
    ].join(' '),
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
  | { typ: 'teil'; key: string; ebene: number; geraet: AufbauGeraet; komponente: PlantComponent }
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
  /** Ist dieser Knoten (Anlage/Box) offen? `vorgabe` gilt, solange niemand klickte. */
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
): void {
  for (const g of geraete) {
    if (g.art === 'neu') {
      out.push({ typ: 'fund', key: g.id, ebene, anlage, box, geraet: g });
      continue;
    }
    const teilbar = g.karte.komponenten.length > 1;
    const offen = teilbar && z.geraete.has(g.id);
    out.push({ typ: 'geraet', key: g.id, ebene, anlage, box, geraet: g, teilbar, offen });
    if (!offen) continue;
    for (const c of g.karte.komponenten) {
      out.push({ typ: 'teil', key: `${g.id}::${c.id}`, ebene: ebene + 1, geraet: g, komponente: c });
    }
  }
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
    const boxen = a.boxen.map((b) => ({
      b,
      treffer: b.geraete.filter((g) => trifft(g, b, a, f, begriffe)),
    }));
    const ohneBox = a.ohneBox.filter((g) => trifft(g, null, a, f, begriffe));
    const summe = boxen.reduce((n, x) => n + x.treffer.length, 0) + ohneBox.length;
    if (aktiv && summe === 0) continue;
    const aOffen = aktiv || z.offen(a.id, a.aktuell);
    out.push({ typ: 'anlage', key: a.id, ebene: 0, anlage: a, offen: aOffen });
    if (!aOffen) continue;
    for (const { b, treffer } of boxen) {
      if (aktiv && treffer.length === 0) continue;
      const bOffen = aktiv || z.offen(b.id, true);
      out.push({ typ: 'box', key: b.id, ebene: 1, anlage: a, box: b, offen: bOffen });
      if (!bOffen) continue;
      geraeteZeilen(out, a, b, treffer, 2, z);
      if (!aktiv && b.geraete.length === 0) {
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
    geraeteZeilen(out, a, null, ohneBox, 1, z);
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
  return {
    geraete: geraete.length,
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
