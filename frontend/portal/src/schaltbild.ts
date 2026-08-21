/**
 * Das STRUKTUR-SCHALTBILD der Anlagen-Zentrale (Konzept
 * `data/vp-anlagen-zentrale-konzept-h6` §8, Stufe 2 PR 2a; Revision 2: es
 * wohnt in einem EIGENEN Reiter neben „Ihre Geräte", nicht als erste Karte -
 * der Einstieg bleibt die ruhige Liste).
 *
 * Es beantwortet EINE Frage, die keine Liste beantworten kann: **wie hängt das
 * alles zusammen?** Von links nach rechts - VoltPilot ⇄ Ihre Box → die Wege →
 * die Geräte → die Komponenten → der Netzanschlusspunkt.
 *
 * **Es ist STRUKTUR, nicht Energiefluss** (§8.5): keine kW-Pfeile, keine
 * Animation, keine Leitungs-/Phasen-Darstellung, keine Netzwerk-Topologie. Der
 * Energiefluss bleibt im Cockpit; dieses Bild sagt, WAS mit WEM spricht und
 * WER was misst bzw. steuert.
 *
 * **Vier Regeln tragen es:**
 *
 * 1. **Kein zweites Modell.** Eingabe ist DERSELBE Lesesatz, aus dem die
 *    Geräte-Karten darunter entstehen (`plantModel`, `/entities.localSetup`,
 *    `/sources`, `/chargers`, `/control-status`, `/curtailment-status`). Es
 *    gibt keine Tabelle „Schaltbild", keine gespeicherten Positionen und keine
 *    zweite Wahrheit über eine Zuordnung - ändert der Kunde einen Pin, ändert
 *    sich das Bild im selben Atemzug.
 * 2. **Das Layout ist DETERMINISTISCH** (die `flow-graph`-Lehre): es wird hier
 *    gerechnet, nicht gespeichert und nicht gezogen. Damit ist die Geometrie -
 *    also auch „läuft etwas über den Rand" - ohne Browser prüfbar.
 * 3. **Kommunikationsweg und Messbezug sind UNTERSCHEIDBAR.** Ein Weg ist eine
 *    durchgezogene graue Linie mit dem Namen des Transports; ein Messbezug ist
 *    GESTRICHELT in der Rollenfarbe; ein Steuer-Bezug ist DURCHGEZOGEN in der
 *    Rollenfarbe und trägt ⚡. Jede Art steht zusätzlich als WORT in der
 *    Legende - nie nur Farbe, nie nur Strichart.
 * 4. **Eine Lücke wird BENANNT, nie gefüllt.** Was die Box nicht weiß (ihre
 *    eigene LAN-Adresse, der Einbauort des Zählers, der Weg eines Geräts mit
 *    älterem Box-Stand) steht als eigene Zeile im Bild bzw. darunter - es wird
 *    nichts erfunden und nichts weggelassen.
 *
 * Rein + framework-frei (das `komponenten.ts`/`geraetSeite.ts`-Muster): die
 * Fläche rendert nur, was hier entschieden wird.
 */
import type {
  ControlStatus,
  CurtailmentStatus,
  Device,
  EdgeVersion,
  EntityLocalSetup,
  SiteSource,
} from './api';
import { deviceLiveStatus } from './api';
import { deviceName, technicalDeviceName } from './entityLabel';
import { fmtNum, fmtRelative } from './format';
import {
  ART_WORT,
  chargerGeraetId,
  geraeteArtWort,
  geraetAdressierbar,
  type GeraetTon,
} from './geraetSeite';
import type { ComponentHealth, ComponentRole, PlantComponent, PlantModel } from './komponenten';
import { chargerName, type ChargePoint, type SiteCharging } from './ladepunkte';
import { boxSeiteHash, geraetSeiteHash } from './nav';
import { capTextLength } from './svgText';

// ---------------------------------------------------------------------------
// Geometrie - die Spalten des Bildes. Alles hier ist Anzeige-Geometrie und
// bewusst KEIN gespeicherter Zustand.
// ---------------------------------------------------------------------------

/** Die Breite des Bildes; die Höhe wächst mit dem Inhalt. */
export const BREITE = 1376;

const SPALTE = {
  cloud: { x: 20, w: 150 },
  box: { x: 240, w: 210 },
  /** Die Mitte der Wege-Spalte - dort sitzen die Transport-Beschriftungen. */
  weg: { x: 450, w: 110 },
  geraet: { x: 560, w: 240 },
  komponente: { x: 900, w: 260 },
  netz: { x: 1196, w: 172 },
} as const;

/** Oberkante des Inhalts (unter den Spaltentiteln). */
const TOP = 48;
/** Luft zwischen zwei Kästchen einer Spalte. */
const LUFT = 16;
/** Innenabstand eines Kästchens. */
const PAD = 10;
/** Zeilenhöhe im Kästchen. */
const ZEILE_H = 15;
/** Höhe der Titelzeile im Kästchen. */
const TITEL_H = 22;
/** Höhe einer Untereinheit im Gateway-Container. */
const EINHEIT_H = 44;

/** Der kleinste Abstand vom untersten Kästchen zum Bildrand. */
const BODEN = 20;

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

/** Welche ART von Kästchen. */
export type KnotenArt =
  | 'cloud'
  | 'box'
  | 'gateway'
  | 'geraet'
  | 'einheit'
  | 'ladepunkt'
  | 'neu'
  | 'komponente'
  | 'netz';

/**
 * Welche ART von Linie - und das ist der Kern der Lesbarkeit: ein
 * KOMMUNIKATIONSWEG (`weg`/`ocpp`/`uplink`) und ein MESSBEZUG (`misst`) sind
 * zwei verschiedene Aussagen und dürfen nie gleich aussehen.
 */
export type KantenArt =
  | 'uplink'
  | 'weg'
  | 'ocpp'
  | 'neu'
  | 'unbekannt'
  | 'misst'
  | 'steuert'
  | 'netz';

/** Eine Zeile in einem Kästchen. */
export interface SchaltbildZeile {
  text: string;
  ton?: GeraetTon | null;
  /** Kappbreite für `textLength`; `undefined` = passt bequem. */
  kapp?: number;
}

/** Ein Kästchen des Bildes, fertig positioniert. */
export interface SchaltbildKnoten {
  id: string;
  art: KnotenArt;
  titel: string;
  titelKapp?: number;
  zeilen: SchaltbildZeile[];
  /** Rollenfarbe einer Komponente; null für alles andere. */
  rolle: ComponentRole | null;
  /** „⚡ VoltPilot steuert" / „maßgeblich"; null = keins. */
  abzeichen: string | null;
  ton: GeraetTon;
  /** Gestrichelter Rahmen (ein neues Gerät, eine verwaiste Komponente). */
  gestrichelt: boolean;
  /** Die Adresse der Geräteseite; null = es gibt keine (nie ein Weg ins Leere). */
  href: string | null;
  /** Bei einer Komponente: ihre Zeilen-Kennung in der Geräte-Liste. */
  komponenteId: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Untereinheiten eines Gateways (zwei Wechselrichter hinter EINER Adresse). */
  einheiten: SchaltbildKnoten[];
}

/** Eine Linie des Bildes, fertig positioniert. */
export interface SchaltbildKante {
  id: string;
  art: KantenArt;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Rollenfarbe eines Mess-/Steuerbezugs; null bei einem Weg. */
  rolle: ComponentRole | null;
  /** Die Beschriftung (der Transport-Name bzw. „⚡ Abregelung"); null = keine. */
  label: string | null;
  labelX: number;
  labelY: number;
  labelKapp?: number;
  /** Pfeilspitze am Ziel. */
  pfeil: boolean;
}

/** Ein Eintrag der Legende - jede Linien-Art trägt ihr WORT. */
export interface LegendenEintrag {
  art: KantenArt;
  text: string;
}

/** Das ganze Bild. */
export interface Schaltbild {
  breite: number;
  hoehe: number;
  spalten: { titel: string; x: number }[];
  knoten: SchaltbildKnoten[];
  kanten: SchaltbildKante[];
  legende: LegendenEintrag[];
  /** Die orangen „das weiß die Box (noch) nicht"-Sätze unter dem Bild. */
  luecken: string[];
  /** Gesetzt, wenn es (noch) nichts zu zeichnen gibt - dann ist alles Übrige leer. */
  leer: string | null;
}

/** Die Eingabe - alles, was die Zentrale ohnehin lädt bzw. nachlädt. */
export interface SchaltbildInput {
  siteId: string;
  siteName: string;
  model: PlantModel;
  devices: Device[] | null;
  devicesFetchedAt?: number | null;
  boxRef: string | null;
  localSetup: EntityLocalSetup[] | null;
  sources: SiteSource[] | null;
  charging: SiteCharging | null;
  control: ControlStatus | null;
  curtailment: CurtailmentStatus | null;
  edgeVersions: EdgeVersion[] | null;
  /** Die im Portal hinterlegte Einspeisegrenze der Anlage; null = keine. */
  maxFeedInKw?: number | null;
  now?: number;
}

// ---------------------------------------------------------------------------
// Wörter
// ---------------------------------------------------------------------------

/**
 * Der Transport als KURZWORT für eine Kanten-Beschriftung.
 *
 * Bewusst neben `geraetSeite.COMM_WORT`, nicht statt dessen: dort steht ein
 * SATZ in einer Tabellenzeile („Solarman-Logger (WLAN-Stick)"), hier ein Chip
 * von ~90 px auf einer Linie. Dieselbe Vokabelliste, zwei Längen - eine
 * gemeinsame Zeichenkette wäre an einem der beiden Orte falsch.
 */
const WEG_WORT: Record<string, string> = {
  solarman_v5: 'Solarman V5',
  modbus_tcp: 'Modbus TCP',
  fronius_sunspec: 'SunSpec Modbus',
  kostal_modbus: 'Modbus TCP',
  fronius_solar_api: 'Solar-API',
  goe_http_api: 'go-e HTTP',
  shelly_http: 'Shelly HTTP',
  self_build: 'Modbus TCP',
};

/** Der Satz, der einen Weg benennt, den die Box (noch) nicht meldet. */
export const WEG_UNBEKANNT = 'Weg unbekannt';

/** Die Lücke, solange die Box ihre eigene Adresse nicht meldet. */
export const LUECKE_LAN =
  'Die eigene LAN-Adresse Ihrer Box meldet sie noch nicht — die lokale Oberfläche erreichen Sie über die Adresse aus Ihrer Einrichtungs-Anleitung (Port 8484).';

/** Die Lücke am Netzanschlusspunkt - sie ist nirgends erfasst. */
export const LUECKE_CT =
  'Wo genau der Stromwandler am Netzanschluss sitzt, ist nirgends hinterlegt — VoltPilot kennt nur seine Messwerte.';

/** Die Lücke eines Geräts mit älterem Box-Stand. */
export const LUECKE_WEG =
  'Für manche Geräte meldet Ihre Box noch nicht, über welchen Weg sie sie liest — dafür braucht sie einen neueren Stand.';

/** Der Satz neben dem Reiter - er sagt, was das Bild IST und was nicht. */
export const SCHALTBILD_HINWEIS =
  'Struktur, nicht Energiefluss — ein Klick auf ein Gerät öffnet seine Seite.';

/** Der Satz, wenn (noch) nichts zu zeichnen ist. */
export const SCHALTBILD_LEER =
  'Sobald sich Ihr erstes Gerät meldet, zeichnet VoltPilot hier, wie Ihre Anlage verschaltet ist.';

/** Die Legende - jede Linien-Art mit ihrem WORT (nie nur Farbe). */
export const LEGENDE: LegendenEintrag[] = [
  { art: 'weg', text: 'liest über diesen Weg' },
  { art: 'ocpp', text: 'OCPP — die Säule wählt Ihre Box an' },
  { art: 'misst', text: 'misst (Farbe = Rolle)' },
  { art: 'steuert', text: '⚡ VoltPilot steuert — Freigabe am Gerät' },
  { art: 'neu', text: 'noch keine Komponente — übernehmen' },
  { art: 'unbekannt', text: 'Weg unbekannt — älterer Box-Stand' },
];

const HEALTH_TON: Record<ComponentHealth, GeraetTon> = {
  ok: 'ok',
  stale: 'warn',
  never: 'off',
  unknown: 'off',
};

// ---------------------------------------------------------------------------
// Kleine Helfer
// ---------------------------------------------------------------------------

function alter(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return fmtRelative(iso, new Date(now));
}

function mitZeit(wort: string, rel: string | null): string {
  return rel ? `${wort} · ${rel}` : wort;
}

/** Eine Zeile samt ihrer Kappbreite für das Kästchen `w`. */
function zeile(text: string, w: number, ton: GeraetTon | null = null): SchaltbildZeile {
  return { text, ton, kapp: capTextLength(text, 10.5, w - 2 * PAD) };
}

/** Die Höhe eines Kästchens aus seiner Zeilenzahl. */
function hoehe(zeilen: number): number {
  return TITEL_H + Math.max(1, zeilen) * ZEILE_H + PAD;
}

/** Die vertikale Mitte eines Kästchens. */
function mitte(k: { y: number; h: number }): number {
  return k.y + k.h / 2;
}

// ---------------------------------------------------------------------------
// Die Ableitung
// ---------------------------------------------------------------------------

/** Ein Gerät des Bildes, bevor es positioniert wird. */
interface RohGeraet {
  id: string;
  art: KnotenArt;
  titel: string;
  zeilen: string[];
  ton: GeraetTon;
  gestrichelt: boolean;
  href: string | null;
  /** Der Transport, mit dem die Box es liest; null = nicht gemeldet. */
  weg: string | null;
  komponenten: PlantComponent[];
  /** Untereinheiten eines Gateways. */
  einheiten: { id: string; titel: string; zeilen: string[]; ton: GeraetTon; href: string | null }[];
}

/**
 * Die Adresse eines gemeldeten Geräts, wie die Box sie speichert - „192.168.…
 * : 8899". `null`, solange die Box keine meldet (ein älterer Stand); dann
 * behauptet das Bild keine.
 */
function adresse(l: EntityLocalSetup): string | null {
  const host = (l.host ?? '').trim();
  if (!host) return null;
  return l.port == null ? host : `${host} : ${l.port}`;
}

/** Der Schlüssel, unter dem zwei Einheiten HINTER EINER Adresse zusammenfallen. */
function gatewaySchluessel(l: EntityLocalSetup): string | null {
  const a = adresse(l);
  return a == null ? null : `${l.communication ?? ''}@${a}`;
}

/**
 * Zwei gemeldete Einheiten hinter DERSELBEN Adresse sind EIN Kästchen mit zwei
 * Unter-Einheiten (§8.2 „Gateway-Zusammenfassung").
 *
 * Der belegte Fall ist der Fronius Datamanager: eine IP, ein Port, zwei
 * Wechselrichter unter verschiedenen Modbus-Adressen. Zwei getrennte Kästchen
 * mit derselben Adresse behaupteten zwei Geräte im Netz, wo eines steht.
 * Zusammengefasst wird NUR, wo die Modbus-Adressen sich wirklich
 * unterscheiden - zwei Meldungen mit identischer Adresse UND identischer
 * Einheit wären dasselbe Gerät zweimal, und das ist keine Aussage über eine
 * Verkabelung.
 */
function gruppen(local: EntityLocalSetup[]): Map<string, EntityLocalSetup[]> {
  const nach = new Map<string, EntityLocalSetup[]>();
  for (const l of local) {
    const k = gatewaySchluessel(l);
    if (k == null) continue;
    const bisher = nach.get(k) ?? [];
    bisher.push(l);
    nach.set(k, bisher);
  }
  for (const [k, list] of [...nach]) {
    const einheiten = new Set(list.map((l) => l.unitId ?? null));
    if (list.length < 2 || einheiten.size < list.length) nach.delete(k);
  }
  return nach;
}

/** Der Titel eines Gateway-Containers - aus der Marke, nie ein erfundener Produktname. */
function gatewayTitel(list: EntityLocalSetup[]): string {
  const marke = technicalDeviceName({ brand: list[0]?.brand ?? null, model: null });
  return marke ? `${marke} · eine Adresse` : 'Eine Adresse, mehrere Geräte';
}

/**
 * Das ganze Bild - EIN Aufruf, EIN Ergebnis. Alles Fehlende wird BENANNT, nie
 * weggelassen und nie erfunden.
 */
export function schaltbild(input: SchaltbildInput): Schaltbild {
  const now = input.now ?? Date.now();
  const { model, siteId, boxRef } = input;
  const local = input.localSetup ?? [];
  const sources = input.sources ?? [];
  const chargers = input.charging?.chargers ?? [];
  const knoten: SchaltbildKnoten[] = [];
  const kanten: SchaltbildKante[] = [];
  const luecken: string[] = [];

  const boxen = (input.devices ?? []).filter((d) => d.siteId === siteId);
  const box = boxen.find((d) => d.externalRef === boxRef) ?? boxen[0];

  if (model.devices.length === 0 && chargers.length === 0 && model.newlyReported.length === 0) {
    return {
      breite: BREITE,
      hoehe: 0,
      spalten: [],
      knoten: [],
      kanten: [],
      legende: [],
      luecken: [],
      leer: SCHALTBILD_LEER,
    };
  }

  const setupVon = (id: string) => local.find((l) => l.id === id);
  const quelleVon = (id: string) => sources.find((s) => s.sourceId === id);
  const komponenteVon = (id: string) => model.components.find((c) => c.id === id);

  // --- Die Geräte, roh (Reihenfolge: Hauptgerät führt) -----------------------
  const geordnet = [...model.devices].sort(
    (a, b) =>
      Number(setupVon(b.id)?.kind === 'inverter') - Number(setupVon(a.id)?.kind === 'inverter'),
  );
  const gateways = gruppen(local);
  const inGateway = new Set<string>();
  for (const list of gateways.values()) for (const l of list) inGateway.add(l.id);

  const roh: RohGeraet[] = [];
  const erledigt = new Set<string>();

  for (const d of geordnet) {
    if (erledigt.has(d.id)) continue;
    const setup = setupVon(d.id);
    const kompo = d.componentIds
      .map(komponenteVon)
      .filter((c): c is PlantComponent => c != null);
    const artWort = geraeteArtWort(
      setup?.kind === 'inverter' ? 'hauptgeraet' : 'quelle',
      setup?.role ?? quelleVon(d.id)?.role ?? null,
      kompo,
    );
    const gw = setup ? gatewaySchluessel(setup) : null;
    const gruppe = gw && inGateway.has(d.id) ? gateways.get(gw) : undefined;

    if (gruppe && gruppe.length > 1) {
      // Ein Container: eine Adresse, mehrere Einheiten.
      const mitglieder = geordnet.filter((x) => gruppe.some((l) => l.id === x.id));
      for (const m of mitglieder) erledigt.add(m.id);
      const alle = mitglieder.flatMap((m) =>
        m.componentIds.map(komponenteVon).filter((c): c is PlantComponent => c != null),
      );
      const takt = setup?.intervalS;
      roh.push({
        id: `gw:${gw}`,
        art: 'gateway',
        titel: gatewayTitel(gruppe),
        zeilen: [
          [adresse(setup!), takt == null ? null : `alle ${takt} s`]
            .filter(Boolean)
            .join(' · '),
          `${mitglieder.length} Geräte hinter einer Adresse`,
        ].filter((t) => t.length > 0),
        ton: mitglieder.some((m) => m.health !== 'ok') ? 'warn' : 'ok',
        gestrichelt: false,
        href: null,
        weg: setup?.communication ?? null,
        komponenten: alle,
        einheiten: mitglieder.map((m) => {
          const ms = setupVon(m.id);
          const einheit = ms?.unitId;
          return {
            id: m.id,
            titel: m.label,
            zeilen: [
              einheit == null
                ? mitZeit(m.state, alter(quelleVon(m.id)?.readAt, now))
                : `Einheit ${einheit} · ${mitZeit(m.state, alter(quelleVon(m.id)?.readAt, now))}`,
            ],
            ton: HEALTH_TON[m.health],
            href:
              boxRef && geraetAdressierbar(m.id) ? geraetSeiteHash(siteId, boxRef, m.id) : null,
          };
        }),
      });
      continue;
    }

    erledigt.add(d.id);
    const adr = setup ? adresse(setup) : null;
    const takt = setup?.intervalS;
    const serial = (setup?.serial ?? '').trim();
    const unit = setup?.unitId;
    const detail = [
      adr,
      serial ? `Logger ${serial}` : unit == null ? null : `Einheit ${unit}`,
      takt == null ? null : `alle ${takt} s`,
    ]
      .filter(Boolean)
      .join(' · ');
    roh.push({
      id: d.id,
      art: 'geraet',
      titel: d.label,
      zeilen: [artWort, detail, mitZeit(d.state, alter(quelleVon(d.id)?.readAt, now))].filter(
        (t) => t.length > 0,
      ),
      ton: HEALTH_TON[d.health],
      gestrichelt: false,
      href: boxRef && geraetAdressierbar(d.id) ? geraetSeiteHash(siteId, boxRef, d.id) : null,
      weg: setup?.communication ?? null,
      komponenten: kompo,
      einheiten: [],
    });
    if (setup && setup.communication == null && setup.host == null) {
      if (!luecken.includes(LUECKE_WEG)) luecken.push(LUECKE_WEG);
    }
  }

  // --- Die Ladesäulen: sie wählen die Box an, nicht umgekehrt ---------------
  for (const c of chargers) {
    const kompo = c.entityId ? model.components.filter((k) => k.entityId === c.entityId) : [];
    roh.push({
      id: chargerGeraetId(c.chargePointId),
      art: 'ladepunkt',
      titel: chargerName(c),
      zeilen: [ART_WORT.ladepunkt, steckerZeile(c), mitZeit(
        c.connected ? 'verbunden' : 'getrennt',
        alter(c.lastSeen, now),
      )].filter((t) => t.length > 0),
      ton: c.connected ? 'ok' : 'warn',
      gestrichelt: false,
      href: boxRef
        ? geraetSeiteHash(siteId, boxRef, chargerGeraetId(c.chargePointId))
        : null,
      weg: 'ocpp',
      komponenten: kompo,
      einheiten: [],
    });
  }

  // --- „Neues Gerät gefunden" ----------------------------------------------
  for (const s of model.newlyReported) {
    roh.push({
      id: `neu:${s.id}`,
      art: 'neu',
      titel: 'Neues Gerät gefunden',
      zeilen: [s.summary, 'noch keine Komponente'],
      ton: 'warn',
      gestrichelt: true,
      href: null,
      weg: setupVon(s.id)?.communication ?? null,
      komponenten: [],
      einheiten: [],
    });
  }

  // --- Positionieren: die Geräte-Spalte ------------------------------------
  let y = TOP;
  const geraetKnoten: SchaltbildKnoten[] = [];
  for (const r of roh) {
    const h =
      r.einheiten.length > 0
        ? TITEL_H + r.zeilen.length * ZEILE_H + r.einheiten.length * (EINHEIT_H + 8) + PAD
        : hoehe(r.zeilen.length);
    const k: SchaltbildKnoten = {
      id: r.id,
      art: r.art,
      titel: r.titel,
      titelKapp: capTextLength(r.titel, 12.5, SPALTE.geraet.w - 2 * PAD),
      zeilen: r.zeilen.map((t) => zeile(t, SPALTE.geraet.w)),
      rolle: null,
      abzeichen: null,
      ton: r.ton,
      gestrichelt: r.gestrichelt,
      href: r.href,
      komponenteId: null,
      x: SPALTE.geraet.x,
      y,
      w: SPALTE.geraet.w,
      h,
      einheiten: [],
    };
    let ey = y + TITEL_H + r.zeilen.length * ZEILE_H + 4;
    for (const e of r.einheiten) {
      k.einheiten.push({
        id: e.id,
        art: 'einheit',
        titel: e.titel,
        titelKapp: capTextLength(e.titel, 11, SPALTE.geraet.w - 4 * PAD),
        zeilen: e.zeilen.map((t) => zeile(t, SPALTE.geraet.w - 2 * PAD)),
        rolle: null,
        abzeichen: null,
        ton: e.ton,
        gestrichelt: false,
        href: e.href,
        komponenteId: null,
        x: SPALTE.geraet.x + PAD,
        y: ey,
        w: SPALTE.geraet.w - 2 * PAD,
        h: EINHEIT_H,
        einheiten: [],
      });
      ey += EINHEIT_H + 8;
    }
    geraetKnoten.push(k);
    y += h + LUFT;
  }
  const geraetUnten = y - LUFT;

  // --- Die Komponenten-Spalte, in der Reihenfolge ihrer Geräte --------------
  const kompoKnoten = new Map<string, SchaltbildKnoten>();
  let cy = TOP;
  const alleKomponenten: { komponente: PlantComponent; geraet: string | null }[] = [];
  for (const r of roh) {
    for (const c of r.komponenten) alleKomponenten.push({ komponente: c, geraet: r.id });
  }
  // Verwaiste Komponenten hängen an keinem gemeldeten Gerät - sie stehen am
  // Ende und tragen ihre Lage als WORT, statt aus dem Bild zu verschwinden.
  const verwaist = model.components.filter(
    (c) => c.orphaned && !alleKomponenten.some((x) => x.komponente.id === c.id),
  );
  for (const c of verwaist) alleKomponenten.push({ komponente: c, geraet: null });

  for (const { komponente: c } of alleKomponenten) {
    if (kompoKnoten.has(c.id)) continue;
    const wert = c.reading ? fmtNum(c.reading.value, c.reading.unit) : null;
    const zeilen = [
      [rollenWort(c.role), c.orphaned ? 'nicht mehr verbunden' : wert].filter(Boolean).join(' · '),
    ];
    if (c.provenance) zeilen.push(c.provenance);
    const h = hoehe(zeilen.length);
    const abzeichen = c.control ? '⚡ VoltPilot steuert' : c.primary ? 'maßgeblich' : null;
    // ⚠ Ein Abzeichen sitzt rechtsbündig in DERSELBEN Zeile wie der Titel - ohne
    // diesen Abzug lief ein langer Kundenname darunter hindurch (im Browser
    // gemessen). Geschätzt wird großzügig; die Kappung staucht, sie schneidet
    // nicht ab.
    const titelPlatz =
      SPALTE.komponente.w - 2 * PAD - (abzeichen ? abzeichen.length * 5.6 + 8 : 0);
    kompoKnoten.set(c.id, {
      id: `k:${c.id}`,
      art: 'komponente',
      titel: c.label,
      titelKapp: capTextLength(c.label, 12, titelPlatz),
      zeilen: zeilen.map((t) => zeile(t, SPALTE.komponente.w)),
      rolle: c.role,
      abzeichen,
      ton: c.orphaned ? 'warn' : HEALTH_TON[c.health],
      gestrichelt: c.orphaned,
      href: null,
      komponenteId: c.id,
      x: SPALTE.komponente.x,
      y: cy,
      w: SPALTE.komponente.w,
      h,
      einheiten: [],
    });
    cy += h + 12;
  }
  const kompoUnten = cy - 12;

  // --- Cloud + Box, mittig zur Geräte-Spalte -------------------------------
  const inhaltUnten = Math.max(geraetUnten, kompoUnten, TOP + 120);
  const mitteY = (TOP + inhaltUnten) / 2;

  const cloudZeilen = ['Portal · Fahrplan · Regeln', 'Befehle, Updates'];
  const cloudH = hoehe(cloudZeilen.length);
  const cloud: SchaltbildKnoten = {
    id: 'cloud',
    art: 'cloud',
    titel: 'VoltPilot',
    zeilen: cloudZeilen.map((t) => zeile(t, SPALTE.cloud.w)),
    rolle: null,
    abzeichen: null,
    ton: 'ok',
    gestrichelt: false,
    href: null,
    komponenteId: null,
    x: SPALTE.cloud.x,
    y: mitteY - cloudH / 2,
    w: SPALTE.cloud.w,
    h: cloudH,
    einheiten: [],
  };

  const edge = input.edgeVersions?.find((v) => v.deviceId === box?.id);
  const boxStatus = box ? deviceLiveStatus(box, new Date(Math.min(input.devicesFetchedAt ?? now, now))) : null;
  const boxTon: GeraetTon =
    boxStatus === 'online' ? 'ok' : boxStatus === 'stale' ? 'warn' : 'off';
  const boxZeilen: SchaltbildZeile[] = [];
  if (box) {
    boxZeilen.push(
      zeile(
        [box.externalRef, (edge?.coreVersion ?? '').trim() || null].filter(Boolean).join(' · '),
        SPALTE.box.w,
      ),
    );
    boxZeilen.push(
      zeile(
        mitZeit(
          boxStatus === 'online'
            ? 'verbunden'
            : boxStatus === 'stale'
              ? 'meldet sich gerade nicht'
              : 'wartet auf die ersten Daten',
          alter(box.lastSeenAt, now),
        ),
        SPALTE.box.w,
        boxTon,
      ),
    );
  } else {
    boxZeilen.push(zeile('noch keine Box verbunden', SPALTE.box.w, 'off'));
  }
  // Die eigene Erreichbarkeit der Box (D5). Meldet sie eine, steht sie IM Bild -
  // sonst bleibt es bei der benannten Lücke; erfunden wird nie eine.
  const lanHost = (box?.lanHost ?? '').trim();
  if (lanHost) {
    const erreicht = box?.lanSource === 'erreicht';
    boxZeilen.push(
      zeile(
        `${erreicht ? 'erreichbar über' : 'im Netzwerk als'} ${lanHost}`,
        SPALTE.box.w,
        erreicht ? 'ok' : null,
      ),
    );
  } else {
    boxZeilen.push(zeile('LAN-Adresse: meldet Ihre Box noch nicht', SPALTE.box.w, 'warn'));
    luecken.push(LUECKE_LAN);
  }

  const boxH = hoehe(boxZeilen.length);
  const boxTitel = box
    ? `VoltPilot-Box ${deviceName({ storedLabel: box.name }) || box.externalRef}`
    : 'VoltPilot-Box';
  const boxKnoten: SchaltbildKnoten = {
    id: 'box',
    art: 'box',
    titel: boxTitel,
    titelKapp: capTextLength(boxTitel, 13, SPALTE.box.w - 2 * PAD),
    zeilen: boxZeilen,
    rolle: null,
    abzeichen: null,
    ton: boxTon,
    gestrichelt: false,
    href: boxRef ? boxSeiteHash(siteId, boxRef) : null,
    komponenteId: null,
    x: SPALTE.box.x,
    y: mitteY - boxH / 2,
    w: SPALTE.box.w,
    h: boxH,
    einheiten: [],
  };

  // --- Der Netzanschlusspunkt ----------------------------------------------
  const netzKomponente = model.components.find((c) => c.role === 'grid' && !c.orphaned);
  const netzZeilen: SchaltbildZeile[] = [];
  const grenze = input.maxFeedInKw;
  netzZeilen.push(
    zeile(
      grenze == null
        ? 'keine Einspeisegrenze hinterlegt'
        : `Einspeisegrenze ${fmtNum(grenze, 'kW')} (Portal)`,
      SPALTE.netz.w,
      grenze == null ? 'off' : null,
    ),
  );
  const geraeteGrenze = input.curtailment?.deviceExportLimit ?? null;
  if (geraeteGrenze) {
    const gleich =
      grenze != null && Math.abs(geraeteGrenze.limitKw - grenze) < 0.05;
    netzZeilen.push(
      zeile(
        `Gerät meldet ${fmtNum(geraeteGrenze.limitKw, 'kW')}${grenze == null ? '' : gleich ? ' ✓' : ' ⚠'}`,
        SPALTE.netz.w,
        grenze == null ? null : gleich ? 'ok' : 'warn',
      ),
    );
  } else {
    netzZeilen.push(zeile('Grenze im Gerät: noch nicht gelesen', SPALTE.netz.w, 'off'));
  }
  // Die Abregel-FREIGABE gehört hierher, nicht an eine Erzeuger-Kante: sie ist
  // eine Zahl über EINHEITEN, und ihr Zweck ist genau diese Grenze.
  const cur = input.curtailment;
  if (cur != null && cur.units > 0) {
    const alle = cur.certifiedUnits === cur.units;
    netzZeilen.push(
      zeile(
        `Abregelung: ${cur.certifiedUnits} von ${cur.units} freigegeben`,
        SPALTE.netz.w,
        alle ? 'ok' : 'warn',
      ),
    );
    if (!alle) {
      luecken.push(
        `Von ${cur.units} abregelbaren Einheiten ${
          cur.certifiedUnits === 0 ? 'ist noch keine' : `sind ${cur.certifiedUnits}`
        } freigegeben — VoltPilot kann die Einspeisung dann nur teilweise begrenzen.`,
      );
    }
  }
  const waechter = input.curtailment?.exportGuard ?? null;
  if (waechter) {
    netzZeilen.push(
      zeile(
        waechter.effective
          ? `Einspeise-Wächter aktiv (${fmtNum(waechter.limitKw, 'kW')})`
          : 'Einspeise-Wächter erreicht kein Gerät',
        SPALTE.netz.w,
        waechter.effective ? 'ok' : 'warn',
      ),
    );
  }
  netzZeilen.push(zeile('Einbauort des Zählers: unbekannt', SPALTE.netz.w, 'warn'));
  luecken.push(LUECKE_CT);

  const netzH = hoehe(netzZeilen.length);
  const netzY = netzKomponente
    ? Math.max(TOP, mitte(kompoKnoten.get(netzKomponente.id)!) - netzH / 2)
    : mitteY - netzH / 2;
  const netzKnoten: SchaltbildKnoten = {
    id: 'netz',
    art: 'netz',
    titel: 'Netzanschlusspunkt',
    zeilen: netzZeilen,
    rolle: 'grid',
    abzeichen: null,
    ton: 'ok',
    gestrichelt: false,
    href: boxRef ? boxSeiteHash(siteId, boxRef) : null,
    komponenteId: null,
    x: SPALTE.netz.x,
    y: netzY,
    w: SPALTE.netz.w,
    h: netzH,
    einheiten: [],
  };

  knoten.push(cloud, boxKnoten, ...geraetKnoten, ...kompoKnoten.values(), netzKnoten);

  // --- Kanten: Cloud ⇄ Box --------------------------------------------------
  kanten.push({
    id: 'cloud-box',
    art: 'uplink',
    x1: cloud.x + cloud.w,
    y1: mitte(cloud) - 12,
    x2: boxKnoten.x,
    y2: mitte(cloud) - 12,
    rolle: null,
    label: 'Fahrplan',
    labelX: (cloud.x + cloud.w + boxKnoten.x) / 2,
    labelY: mitte(cloud) - 18,
    labelKapp: capTextLength('Fahrplan', 10, 66),
    pfeil: true,
  });
  kanten.push({
    id: 'box-cloud',
    art: 'uplink',
    x1: boxKnoten.x,
    y1: mitte(cloud) + 12,
    x2: cloud.x + cloud.w,
    y2: mitte(cloud) + 12,
    rolle: null,
    label: 'Messwerte',
    labelX: (cloud.x + cloud.w + boxKnoten.x) / 2,
    labelY: mitte(cloud) + 26,
    labelKapp: capTextLength('Messwerte', 10, 66),
    pfeil: true,
  });

  // --- Kanten: Box → Gerät (und Säule → Box) -------------------------------
  for (let i = 0; i < roh.length; i += 1) {
    const r = roh[i];
    const k = geraetKnoten[i];
    const ocpp = r.weg === 'ocpp';
    const wort = ocpp ? 'OCPP 1.6J' : (WEG_WORT[r.weg ?? ''] ?? null);
    const art: KantenArt = ocpp
      ? 'ocpp'
      : r.art === 'neu'
        ? 'neu'
        : wort == null
          ? 'unbekannt'
          : 'weg';
    const yBox = mitte(boxKnoten);
    const yGeraet = mitte(k);
    kanten.push({
      id: `weg:${r.id}`,
      art,
      x1: ocpp ? k.x : boxKnoten.x + boxKnoten.w,
      y1: ocpp ? yGeraet : yBox,
      x2: ocpp ? boxKnoten.x + boxKnoten.w : k.x,
      y2: ocpp ? yBox : yGeraet,
      rolle: null,
      label: wort ?? WEG_UNBEKANNT,
      labelX: SPALTE.weg.x + SPALTE.weg.w / 2,
      labelY: (yBox + yGeraet) / 2 - 6,
      labelKapp: capTextLength(wort ?? WEG_UNBEKANNT, 10, SPALTE.weg.w - 16),
      pfeil: true,
    });
    if (art === 'unbekannt' && r.art !== 'neu' && !luecken.includes(LUECKE_WEG)) {
      luecken.push(LUECKE_WEG);
    }
  }

  // --- Kanten: Gerät → Komponente ------------------------------------------
  // ⚠ Die ABREGELUNG ist bewusst KEINE ⚡-Kante. Die Rückmeldung der Box ZÄHLT
  // abregelbare Einheiten, sie BENENNT sie nicht - welcher Erzeuger gemeint
  // ist, weiß das Bild also nicht, und ein geratenes ⚡ wäre eine Zusage über
  // eine Kundenanlage. Der Stand steht deshalb dort, wo die Einspeisegrenze
  // wohnt: am Netzanschlusspunkt, als Zahl.
  const steuerFrei = input.control?.certified === true && input.control.controlEnabled;

  for (let i = 0; i < roh.length; i += 1) {
    const r = roh[i];
    const k = geraetKnoten[i];
    for (const c of r.komponenten) {
      const ziel = kompoKnoten.get(c.id);
      if (!ziel) continue;
      const steuert = c.control && (c.role === 'storage' ? steuerFrei : c.schaltbar);
      // Die Kante geht von der Einheit aus, die diese Komponente wirklich
      // misst - sonst zeigte ein Container-Rand auf eine seiner zwei Einheiten.
      const quelle =
        k.einheiten.find((e) => c.deviceIds.includes(e.id)) ?? k;
      kanten.push({
        id: `misst:${r.id}:${c.id}`,
        art: steuert ? 'steuert' : 'misst',
        x1: quelle.x + quelle.w,
        y1: mitte(quelle),
        x2: ziel.x,
        y2: mitte(ziel),
        rolle: c.role,
        label: null,
        labelX: 0,
        labelY: 0,
        pfeil: false,
      });
    }
  }

  // --- Kante: Netz-Komponente → Netzanschlusspunkt --------------------------
  if (netzKomponente) {
    const von = kompoKnoten.get(netzKomponente.id)!;
    kanten.push({
      id: 'netz',
      art: 'netz',
      x1: von.x + von.w,
      y1: mitte(von),
      x2: netzKnoten.x,
      y2: mitte(netzKnoten),
      rolle: 'grid',
      label: null,
      labelX: 0,
      labelY: 0,
      pfeil: false,
    });
  }

  const hoeheGesamt =
    Math.max(
      inhaltUnten,
      cloud.y + cloud.h,
      boxKnoten.y + boxKnoten.h,
      netzKnoten.y + netzKnoten.h,
    ) + BODEN;

  return {
    breite: BREITE,
    hoehe: hoeheGesamt,
    spalten: [
      { titel: 'VOLTPILOT', x: SPALTE.cloud.x + SPALTE.cloud.w / 2 },
      { titel: 'IHRE BOX', x: SPALTE.box.x + SPALTE.box.w / 2 },
      { titel: 'WEGE', x: SPALTE.weg.x + SPALTE.weg.w / 2 },
      { titel: 'GERÄTE', x: SPALTE.geraet.x + SPALTE.geraet.w / 2 },
      { titel: 'KOMPONENTEN', x: SPALTE.komponente.x + SPALTE.komponente.w / 2 },
      { titel: 'NETZ', x: SPALTE.netz.x + SPALTE.netz.w / 2 },
    ],
    knoten,
    kanten,
    legende: LEGENDE.filter((l) => kanten.some((k) => k.art === l.art)),
    luecken,
    leer: null,
  };
}

/** „2 Stecker · 1 lädt" - dieselbe Aussage wie auf der Geräte-Karte. */
function steckerZeile(c: ChargePoint): string {
  const stecker = c.connectors ?? [];
  if (stecker.length === 0) return '';
  const laedt = stecker.filter((k) => k.charging).length;
  return laedt > 0 ? `${stecker.length} Stecker · ${laedt} lädt` : `${stecker.length} Stecker`;
}

/** Das Rollenwort einer Komponente - das Kundenvokabular, nie ein Kanalname. */
function rollenWort(role: ComponentRole): string {
  switch (role) {
    case 'pv':
      return 'Erzeugung';
    case 'storage':
      return 'Speicher';
    case 'grid':
      return 'Netzanschluss';
    case 'house':
      return 'Hausverbrauch';
    default:
      return 'Verbrauch';
  }
}
