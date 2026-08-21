/**
 * Die VEREINTE „Ihre Geräte"-Liste der Anlagen-Zentrale (Konzept
 * `data/vp-anlagen-zentrale-konzept-h6` **§13 Revision 2**, Captain-Review
 * 20.08.2026, Entscheid **D6**).
 *
 * **Der behobene Befund war DOPPELUNG.** Der Einstieg stellte jedes Ding
 * zweimal dar: als Geräte-Kachel („Fronius Eco 27.0-3-S · WR 1 · misst: Dach
 * Süd") und, eine Karte tiefer, als Komponenten-Zeile („Dach Süd · gemessen
 * über Fronius Eco 27 · WR 1 · 21,2 kW"). Bei 1:1-Geräten - also jedem Fronius,
 * jeder Säule, jedem Zähler - ist das DIESELBE Information in zwei Formen; nur
 * der Hybrid (1 Gerät → 4 Komponenten) und der abgeleitete Hausverbrauch
 * rechtfertigen überhaupt zwei Ebenen.
 *
 * **Die Verschmelzung: Geräte sind der RAHMEN, Komponenten die ZEILEN.** Es ist
 * ausdrücklich eine RENDER-Änderung, kein Datenumbau - `plantModel`
 * (`komponenten.ts`) verknüpft jede Komponente längst mit ihrem Gerät
 * (`PlantDevice.componentIds`); die Seite rendert bloß `model.devices` statt
 * `model.groups`. Neu ist hier nur, was `plantModel` nicht kennt: die Säulen
 * aus `/chargers`, die Ausnahme-Karten und die Reihenfolge.
 *
 * **Warum Geräte führen und nicht Komponenten** (das revidiert w7 Variante A -
 * auf ausdrücklichen Wunsch des Captains, benannt statt still): ein Gerät ist
 * das, worauf man zeigen kann, und das, was eine SEITE hat. Umgekehrt erschiene
 * der Deye viermal, und die Box, „Neues Gerät gefunden" und die Säule hätten
 * gar keinen Wohnort - obwohl genau sie die Geräteseiten tragen.
 *
 * Rein + framework-frei (das `komponenten.ts`/`geraetSeite.ts`-Muster): die
 * Fläche rendert nur, was hier entschieden wird.
 */
import type { Device, EntityLocalSetup, SiteSource } from './api';
import { deviceName } from './entityLabel';
import { fmtRelative } from './format';
import {
  ART_WORT,
  geraeteArtWort,
  geraetAdressierbar,
  chargerGeraetId,
  type GeraetTon,
} from './geraetSeite';
import type { ComponentHealth, PlantComponent, PlantModel } from './komponenten';
import { chargerName, type ChargePoint, type SiteCharging } from './ladepunkte';
import { boxSeiteHash, geraetSeiteHash } from './nav';
import type { AdoptableSource } from './rollen';

/** Welche ART von Karte die Liste zeigt. */
export type KartenArt = 'box' | 'geraet' | 'ladepunkt' | 'neu' | 'verwaist';

/** Eine Karte der Liste - EIN Gerät (bzw. eine der zwei Ausnahmen). */
export interface GeraeteKarte {
  /** Stabiler Schlüssel; bei einem Gerät die Kennung auf der Box. */
  id: string;
  art: KartenArt;
  /**
   * Der TECHNISCHE Gerätename. **Der Kundenname lebt an der ZEILE** - ein Gerät
   * wird nie umbenannt, nur seine Komponenten (w7 R6 / PR 432), sonst entstünde
   * ein viertes Namenssystem.
   */
  titel: string;
  /** „Hybrid-Wechselrichter · Hauptgerät" / „Ladesäule · 2 Stecker". */
  untertitel: string;
  /** Zustand MIT Zeitbezug („liefert Daten · vor 12 Sek."). */
  zustand: string;
  ton: GeraetTon;
  /** Die Adresse der Geräteseite; null = es gibt keine (nie ein Weg ins Leere). */
  href: string | null;
  /** Die Komponenten-Zeilen dieser Karte. */
  komponenten: PlantComponent[];
  /** Eine ruhige Zusatzzeile unter der Kopfzeile; null = keine. */
  zusatz: string | null;
  /** Nur bei `neu`: die gemeldete Quelle, die übernommen werden kann. */
  quelle?: AdoptableSource;
}

/** Der eine Satz über der Liste. */
export interface ZentraleSatz {
  ton: 'ok' | 'warn';
  text: string;
}

/** Der Ton einer Gesundheit - dieselbe Zuordnung wie überall. */
const HEALTH_TON: Record<ComponentHealth, GeraetTon> = {
  ok: 'ok',
  stale: 'warn',
  never: 'off',
  unknown: 'off',
};

/**
 * Das Zustandswort der BOX. Sie spricht bewusst anders als die Geräte an ihr:
 * eine Box ist mit VoltPilot VERBUNDEN, ein Gerät LIEFERT DATEN - zwei
 * verschiedene Tatsachen, die nie unter ein Wort fallen dürfen.
 */
function boxWort(health: ComponentHealth): string {
  switch (health) {
    case 'ok':
      return 'verbunden';
    case 'stale':
      return 'meldet sich gerade nicht';
    default:
      return 'wartet auf die erste Verbindung';
  }
}

function alter(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return fmtRelative(iso, new Date(now));
}

function mitZeit(wort: string, rel: string | null): string {
  return rel ? `${wort} · ${rel}` : wort;
}

/** Der Satz unter der Säulen-Kopfzeile: „2 Stecker · 1 lädt". */
function steckerSatz(c: ChargePoint): string {
  const stecker = c.connectors ?? [];
  if (stecker.length === 0) return ART_WORT.ladepunkt;
  const laedt = stecker.filter((k) => k.charging).length;
  const teile = [ART_WORT.ladepunkt, `${stecker.length} Stecker`];
  if (laedt > 0) teile.push(`${laedt} lädt`);
  return teile.join(' · ');
}

/** Die Eingabe der Liste - alles, was die Zentrale ohnehin lädt. */
export interface ZentraleListeInput {
  siteId: string;
  model: PlantModel;
  /** Die Geräteliste der Schale, auf diese Anlage gefiltert. */
  devices: Device[] | null;
  /** Bezugszeit der Geräteliste (`liveness.ts`); null = nie geladen. */
  devicesFetchedAt?: number | null;
  /** Die Referenz der EINEN Box; null = kein Weg auf eine Geräteseite. */
  boxRef: string | null;
  /**
   * Der gemeldete Bestand der Box (`/entities.localSetup`). Er trägt die
   * ART eines Geräts (`kind`/`role`) - **die Kennung tut das NICHT**: dass das
   * Hauptgerät `inverter` heisst, ist eine Konvention des Edge-Berichts, `kind`
   * ist der Fakt.
   */
  localSetup: EntityLocalSetup[] | null;
  /**
   * Der gemeldete Ist-Stand je Gerät (`/sources`) - er trägt den ZWEITEN
   * Frische-Anker: ein Gerät hinter der Box altert gegen `readAt`, nie gegen
   * die Telemetrie der Box.
   */
  sources: SiteSource[] | null;
  /** `GET /sites/{id}/chargers`, fail-soft geholt; null = nicht gemeldet. */
  charging: SiteCharging | null;
  now?: number;
}

/**
 * Die Liste, in Lese-Reihenfolge: die EINE Box, dann die Geräte an ihr, dann
 * die Säulen, zuletzt die zwei AUSNAHME-Karten (ein Gerät ohne Komponente, eine
 * Komponente ohne Gerät). Die Ausnahmen stehen am Ende, weil sie Aufgaben sind
 * und der Normalfall zuerst gelesen wird.
 */
export function zentraleListe(input: ZentraleListeInput): GeraeteKarte[] {
  const now = input.now ?? Date.now();
  const { model, siteId, boxRef } = input;
  const karten: GeraeteKarte[] = [];

  // --- Die EINE VoltPilot-Box ------------------------------------------------
  const boxen = input.devices ?? [];
  if (boxen.length > 0) {
    const box = boxen.find((d) => d.externalRef === boxRef) ?? boxen[0];
    const health = boxHealth(boxen, input.devicesFetchedAt, now);
    const n = model.devices.length;
    karten.push({
      id: `box:${box.externalRef}`,
      art: 'box',
      titel: `VoltPilot-Box ${deviceName({ storedLabel: box.name }) || box.externalRef}`,
      untertitel: ART_WORT.box,
      zustand: mitZeit(boxWort(health), alter(box.lastSeenAt, now)),
      ton: HEALTH_TON[health],
      href: boxRef ? boxSeiteHash(siteId, boxRef) : null,
      komponenten: [],
      zusatz:
        n === 0
          ? 'Vermittelt zwischen Ihren Geräten und VoltPilot — noch kein Gerät gemeldet.'
          : `Vermittelt zwischen Ihren Geräten und VoltPilot — ${n} ${
              n === 1 ? 'Gerät' : 'Geräte'
            } angebunden.`,
    });
  }

  // --- Die Geräte AN der Box -------------------------------------------------
  const komponenteVon = (id: string): PlantComponent | undefined =>
    model.components.find((c) => c.id === id);
  const quelleVon = (id: string) => (input.sources ?? []).find((s) => s.sourceId === id);
  const setupVon = (id: string) => (input.localSetup ?? []).find((l) => l.id === id);
  const leseZeit = (id: string) => quelleVon(id)?.readAt ?? null;
  const rolleVon = (id: string) => setupVon(id)?.role ?? quelleVon(id)?.role ?? null;
  // ⚠ Das HAUPTGERÄT führt: es trägt die Grundausstattung der Anlage (Speicher,
  // Netz, Haus), und eine Liste, die mit einem Nebengerät beginnt, liest sich,
  // als sei der Wechselrichter nachrangig. Innerhalb der zwei Klassen bleibt die
  // Reihenfolge des Modells - sie ist die des Geräts, nicht unsere.
  const geraete = [...model.devices].sort(
    (a, b) =>
      Number(setupVon(b.id)?.kind === 'inverter') -
      Number(setupVon(a.id)?.kind === 'inverter'),
  );
  for (const d of geraete) {
    const komponenten = d.componentIds
      .map(komponenteVon)
      .filter((c): c is PlantComponent => c != null);
    const art = setupVon(d.id)?.kind === 'inverter' ? 'hauptgeraet' : 'quelle';
    karten.push({
      id: d.id,
      art: 'geraet',
      titel: d.label,
      untertitel: geraeteArtWort(art, rolleVon(d.id), komponenten),
      zustand: mitZeit(d.state, alter(leseZeit(d.id), now)),
      ton: HEALTH_TON[d.health],
      href:
        boxRef && geraetAdressierbar(d.id) ? geraetSeiteHash(siteId, boxRef, d.id) : null,
      komponenten,
      // R4: eine Karte OHNE Zeile sagt das - sonst stünde ein leerer Rahmen da.
      zusatz: komponenten.length === 0 ? 'Misst noch nichts.' : null,
    });
  }

  // --- Die Ladesäulen (R7) ---------------------------------------------------
  for (const c of input.charging?.chargers ?? []) {
    const komponenten = c.entityId
      ? model.components.filter((k) => k.entityId === c.entityId)
      : [];
    karten.push({
      id: chargerGeraetId(c.chargePointId),
      art: 'ladepunkt',
      titel: chargerName(c),
      untertitel: steckerSatz(c),
      zustand: mitZeit(c.connected ? 'verbunden' : 'getrennt', alter(c.lastSeen, now)),
      ton: c.connected ? 'ok' : 'warn',
      href: boxRef ? geraetSeiteHash(siteId, boxRef, chargerGeraetId(c.chargePointId)) : null,
      komponenten,
      zusatz: komponenten.length === 0 ? 'Die Ladeleistung verteilt das Lastmanagement.' : null,
    });
  }

  // --- Ausnahme 1: „Neues Gerät gefunden" (R5) -------------------------------
  for (const s of model.newlyReported) {
    karten.push({
      id: `neu:${s.id}`,
      art: 'neu',
      titel: 'Neues Gerät gefunden',
      untertitel: s.summary,
      zustand: 'noch keine Komponente',
      ton: 'warn',
      href: null,
      komponenten: [],
      zusatz: 'Übernehmen Sie es — dann erscheint hier seine Zeile.',
      quelle: s,
    });
  }

  // --- Ausnahme 2: „Nicht mehr verbunden" (R6) -------------------------------
  // Nur BEWIESEN verwaiste Pins: `plantModel` erfindet für sie bewusst kein
  // synthetisches Gerät, sie hätten sonst gar keinen Wohnort in dieser Liste.
  const verwaist = model.components.filter((c) => c.orphaned);
  if (verwaist.length > 0) {
    karten.push({
      id: 'verwaist',
      art: 'verwaist',
      titel: 'Nicht mehr verbunden',
      untertitel: `${verwaist.length} ${
        verwaist.length === 1 ? 'Komponente wartet' : 'Komponenten warten'
      } auf ihr Gerät`,
      zustand: 'zuletzt gemeldet',
      ton: 'warn',
      href: null,
      komponenten: verwaist,
      zusatz: null,
    });
  }

  return karten;
}

/** Die Lebendigkeit der Box - der Anker ist ihre Telemetrie (`liveness.ts`). */
function boxHealth(
  devices: Device[],
  fetchedAt: number | null | undefined,
  now: number,
): ComponentHealth {
  const at = fetchedAt == null ? now : Math.min(fetchedAt, now);
  let worst: ComponentHealth = 'ok';
  const rank: Record<ComponentHealth, number> = { ok: 0, unknown: 1, never: 2, stale: 3 };
  for (const d of devices) {
    const alterMs = d.lastSeenAt ? at - Date.parse(d.lastSeenAt) : null;
    const h: ComponentHealth =
      alterMs == null ? 'never' : alterMs <= 5 * 60_000 ? 'ok' : 'stale';
    if (rank[h] > rank[worst]) worst = h;
  }
  return worst;
}

/**
 * Der EINE Satz über der Liste (§13.2): Gesundheit statt der früheren
 * Vier-Zahlen-Kopfzeile. Er folgt der Regel von `komponenten.plantHeadline` -
 * grün NUR, wenn alle liefern; sonst bernstein, **und er nennt das schweigende
 * Gerät beim Namen** (dieselbe Mechanik wie der Cockpit-Satz).
 */
export function zentraleSatz(karten: GeraeteKarte[]): ZentraleSatz {
  const box = karten.find((k) => k.art === 'box');
  const geraete = karten.filter((k) => k.art === 'geraet' || k.art === 'ladepunkt');
  const neu = karten.filter((k) => k.art === 'neu').length;
  const verwaist = karten.find((k) => k.art === 'verwaist');

  if (!box && geraete.length === 0) {
    return {
      ton: 'warn',
      text: 'Noch kein Gerät verbunden — sobald sich eines meldet, erscheint hier Ihre Anlage.',
    };
  }

  const teile: string[] = [];
  const boxSatz = box
    ? box.ton === 'ok'
      ? 'Box verbunden'
      : 'Ihre Box meldet sich gerade nicht'
    : null;
  if (boxSatz) teile.push(boxSatz);

  const still = geraete.filter((g) => g.ton !== 'ok');
  if (geraete.length === 0) {
    teile.push('noch kein Gerät gemeldet');
  } else if (still.length === 0) {
    teile.push(
      geraete.length === 1
        ? 'Ihr Gerät liefert Daten'
        : `alle ${geraete.length} Geräte liefern Daten`,
    );
  } else {
    // Die Regel von `plantHeadline`: das schweigende Gerät wird BENANNT.
    teile.push(
      still.length === 1
        ? `„${still[0].titel}" ${still[0].zustand.split(' · ')[0]}`
        : `${still.length} Geräte melden sich gerade nicht`,
    );
  }

  if (neu > 0) {
    teile.push(
      neu === 1 ? '1 neues Gerät wartet auf Übernahme' : `${neu} neue Geräte warten auf Übernahme`,
    );
  }
  if (verwaist) teile.push(verwaist.untertitel);

  const ton: 'ok' | 'warn' =
    (box && box.ton !== 'ok') || still.length > 0 || neu > 0 || verwaist ? 'warn' : 'ok';
  return { ton, text: `${teile.join(' · ')}.` };
}

/** Der Satz der Fußzeile, der den Register-Weg nennt (§6.2). */
export const REGISTER_VERWEIS =
  'Register lesen oder schreiben: auf der Seite des jeweiligen Geräts („Geräteseite").';

/** Das Leitwort der Liste und ihres Knopfs (D6). */
export const LISTE_TITEL = 'Ihre Geräte';
export const HINZUFUEGEN_LABEL = 'Hinzufügen';
