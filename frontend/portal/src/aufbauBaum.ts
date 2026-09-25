/**
 * Der AUFBAU als Baum: Standort → Anlagen → VoltPilot-Boxen → Geräte.
 *
 * Konzept „Anlage – neu gedacht" (Entscheide E1–E6 = A vom 25.09.2026). Der
 * Reiter „Aufbau" ersetzt Anlagenbild UND Liste: EINE Sicht, in der jede Ebene
 * etwas trägt - der Standort seinen Ort, die Anlage ihre Live-Werte, die Box
 * ihre Verbindung, das Gerät seine Messwerte als kurze Chips. Komponenten sind
 * keine eigene Ebene mehr: sie stehen als Werte am Gerät, das sie speist
 * (vorher stand „Speicher Scheune" in der Liste siebenmal da).
 *
 * Rein + deterministisch (das `zentraleListe.ts`-Muster): die Geräte-Karten
 * kommen unverändert aus `zentraleListe`, dieses Modul ordnet sie nur in den
 * Baum und leitet die Chips ab. Kein React, kein Netz, keine Uhr.
 *
 * ⚠ **Welche Box welches Gerät liest, weiß das Portal heute nur mit EINER Box
 * sicher.** Die Geräteliste einer Anlage geht als Ganzes an die führende Box
 * (`registry.deviceId`), und der gemeldete Bestand kommt ohne Box-Kennung an.
 * Bei zwei und mehr Boxen hängen deshalb die angelegten Geräte unter der Box,
 * an die die Liste ging; Ladesäulen tragen ihre Box selbst; ein neu gemeldetes
 * Gerät, dessen Box niemand kennt, steht ehrlich unter der Anlage statt unter
 * einer geratenen Box (UEMS AP-06, Datenquellen je Box, ist im Server gebaut,
 * aber noch nicht angeschlossen).
 */
import type { IconName } from '../designsystem/components/core/Icon';
import type {
  Device,
  EntityLocalSetup,
  OverviewSite,
  StandortAdresse,
  StandorteAmStichtag,
} from './api';
import { technicalDeviceName } from './entityLabel';
import { siteLiveFresh } from './fleet';
import { fmtNum } from './format';
import type { GeraetTon } from './geraetSeite';
import type { ComponentRole, PlantComponent } from './komponenten';
import { chargerGeraetId } from './geraetAdresse';
import type { ChargePoint, SiteCharging } from './ladepunkte';
import { gridState } from './live';
import { boxSeiteHash } from './nav';
import { sanitizeSoc } from './plausible';
import { boxLage, type GeraeteKarte, type KartenArt } from './zentraleListe';

/** Welche Größe ein Chip zeigt - bestimmt Symbol und Farbe, nie den Wert. */
export type AufbauWertArt = 'pv' | 'speicher' | 'netz' | 'haus' | 'verbraucher' | 'laden';

/** Ein Wert-Chip: Zahl + kurzes Richtungswort, nie ein erfundener Wert. */
export interface AufbauWert {
  art: AufbauWertArt;
  /** Sichtbar, ohne Rollenwort: „6,2 kW", „64,0 % geladen", „3,4 kW Einspeisung". */
  text: string;
  /** Vollständig für Screenreader: „PV 6,2 kW". */
  label: string;
}

/** Die Farbe der Kachel eines Knotens - die Kategorie-Verläufe des Designsystems. */
export type AufbauKategorie =
  | 'solar'
  | 'battery'
  | 'ev'
  | 'home'
  | 'grid'
  | 'navy'
  | 'fund'
  | 'warn';

/** Ein Gerät im Baum. Die Karte reist mit, weil an ihr die Handlungen hängen. */
export interface AufbauGeraet {
  id: string;
  art: Exclude<KartenArt, 'box'>;
  titel: string;
  /** Modell bzw. Art in einer Zeile: „Deye SUN-12K-SG04LP3-EU". */
  unterzeile: string;
  ton: GeraetTon;
  /** Zustand MIT Zeitbezug („liefert Daten · vor 12 Sek."). */
  zustand: string;
  werte: AufbauWert[];
  kategorie: AufbauKategorie;
  icon: IconName;
  karte: GeraeteKarte;
}

export interface AufbauBox {
  id: string;
  ref: string;
  /** Der Name der Box, sonst „VoltPilot-Box". */
  name: string;
  ton: GeraetTon;
  zustand: string;
  /** Nur ab zwei Boxen: die Box, an die die Geräteliste der Anlage geht. */
  fuehrend: boolean;
  href: string;
  geraete: AufbauGeraet[];
}

/** Wie aktuell die Live-Werte einer Anlage sind. */
export type WertStand = 'aktuell' | 'veraltet' | 'unbekannt';

export interface AufbauAnlage {
  id: string;
  name: string;
  /** Die geöffnete Anlage („Sie sind hier"). */
  aktuell: boolean;
  werte: AufbauWert[];
  wertStand: WertStand;
  boxen: AufbauBox[];
  /** Geräte, deren Box das Portal nicht sicher kennt (siehe Modulkopf). */
  ohneBox: AufbauGeraet[];
  /** Angelegte Geräte (ohne Funde); null = für diese Anlage noch nicht geladen. */
  geraeteZahl: number | null;
}

export interface AufbauWurzel {
  art: 'standort' | 'ohne-standort';
  id: string | null;
  name: string;
  kurzzeichen: string | null;
  /** „Sonnenweg 1 · 80331 München"; null = keine Adresse hinterlegt. */
  adresse: string | null;
  /** Ein automatisch angelegter Standort bleibt Entwurf, bis die Adresse steht. */
  entwurf: boolean;
}

export interface AufbauBaum {
  /** null = der Server kennt noch keine Standorte (älteres Backend, Fehler). */
  wurzel: AufbauWurzel | null;
  anlagen: AufbauAnlage[];
  boxZahl: number;
}

export interface AufbauEingabe {
  siteId: string;
  siteName: string;
  /** `GET /api/v1/standorte`; null = nicht geladen oder nicht verfügbar. */
  standorte: StandorteAmStichtag | null;
  /** Alle Boxen des Kundenbereichs (die Liste der Schale), mit ihrer Anlage. */
  devices: Device[] | null;
  devicesFetchedAt?: number | null;
  /** Die Karten der geöffneten Anlage (`zentraleListe`); null = noch nicht geladen. */
  karten: GeraeteKarte[] | null;
  /** Der gemeldete Bestand der geöffneten Anlage (Hersteller/Modell je Gerät). */
  localSetup: EntityLocalSetup[] | null;
  charging: SiteCharging | null;
  /** Die Box, an die die Geräteliste zuletzt ging (`/entities.registry.deviceId`). */
  registryBoxId: string | null;
  /** Die Übersicht der Schale (Live-Werte je Anlage); null = nicht geladen. */
  overview: OverviewSite[] | null;
  /** Karten weiterer Anlagen am Standort, sobald sie aufgeklappt geladen sind. */
  nachbarKarten?: Record<string, GeraeteKarte[] | undefined>;
  now: number;
}

/** Der Titel eines Standorts, dem die Anlage (noch) nicht zugeordnet ist. */
export const OHNE_STANDORT = 'Noch keinem Standort zugeordnet';

const ROLLE_WERT: Record<ComponentRole, AufbauWertArt> = {
  pv: 'pv',
  storage: 'speicher',
  grid: 'netz',
  house: 'haus',
  consumer: 'verbraucher',
};

/** Das Rollenwort vor der Zahl - nur für Screenreader, sichtbar trägt es das Symbol. */
export const WERT_WORT: Record<AufbauWertArt, string> = {
  pv: 'PV',
  speicher: 'Speicher',
  netz: 'Netz',
  haus: 'Haus',
  verbraucher: 'Verbraucher',
  laden: 'Laden',
};

/** Welche Rolle die Kachel eines Geräts färbt: der Speicher vor der PV (Hybrid). */
const KACHEL_REIHENFOLGE: ComponentRole[] = ['storage', 'pv', 'grid', 'consumer', 'house'];
const KACHEL: Record<ComponentRole, { kategorie: AufbauKategorie; icon: IconName }> = {
  storage: { kategorie: 'battery', icon: 'battery' },
  pv: { kategorie: 'solar', icon: 'sun' },
  grid: { kategorie: 'grid', icon: 'activity' },
  consumer: { kategorie: 'home', icon: 'sliders' },
  house: { kategorie: 'home', icon: 'home' },
};

function wert(art: AufbauWertArt, text: string): AufbauWert {
  return { art, text, label: `${WERT_WORT[art]} ${text}` };
}

/** Die Chips eines Geräts aus seinen Komponenten - ohne Messwert kein Chip. */
export function komponentenWerte(komponenten: PlantComponent[]): AufbauWert[] {
  const out: AufbauWert[] = [];
  for (const c of komponenten) {
    if (!c.reading) continue;
    // Ein Ladestand steht als ganze Zahl da - wie am Anlagen-Kopf (`anlagenWerte`).
    const zahl = fmtNum(c.reading.value, c.reading.unit, c.reading.unit === '%' ? 0 : 1);
    out.push(wert(ROLLE_WERT[c.role], c.reading.caption ? `${zahl} ${c.reading.caption}` : zahl));
  }
  return out;
}

/**
 * Der Chip einer Ladesäule aus ihrem Stecker-Bericht: „lädt 1,4 kW", sonst
 * „frei", wenn jeder Stecker frei meldet. Alles andere erklärt die Geräteseite.
 */
export function ladeWert(c: ChargePoint): AufbauWert | null {
  const stecker = c.connectors ?? [];
  const laedt = stecker.filter((k) => k.charging);
  if (laedt.length > 0) {
    const kw = laedt
      .map((k) => k.powerKw)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return wert('laden', kw.length > 0 ? `lädt ${fmtNum(kw.reduce((a, b) => a + b, 0), 'kW')}` : 'lädt');
  }
  if (stecker.length > 0 && stecker.every((k) => k.status === 'Available')) {
    return wert('laden', 'frei');
  }
  return null;
}

/** Die Live-Chips einer Anlage aus der Übersicht - nur, wenn sie aktuell sind. */
export function anlagenWerte(
  site: OverviewSite | null | undefined,
  now: number,
): { werte: AufbauWert[]; stand: WertStand } {
  if (!site || !site.live) return { werte: [], stand: 'unbekannt' };
  if (!siteLiveFresh(site, new Date(now))) return { werte: [], stand: 'veraltet' };
  const { pvKw, socPct, gridKw } = site.live;
  const werte: AufbauWert[] = [];
  if (typeof pvKw === 'number' && Number.isFinite(pvKw)) {
    werte.push(wert('pv', fmtNum(Math.max(0, pvKw), 'kW')));
  }
  const soc = sanitizeSoc(socPct);
  if (soc != null) werte.push(wert('speicher', fmtNum(soc, '%', 0)));
  const netz = gridState(gridKw);
  if (netz === 'ausgeglichen') werte.push(wert('netz', 'ausgeglichen'));
  if ((netz === 'bezug' || netz === 'einspeisung') && gridKw != null) {
    werte.push(
      wert('netz', `${netz === 'bezug' ? 'Bezug' : 'Einspeisung'} ${fmtNum(Math.abs(gridKw), 'kW')}`),
    );
  }
  return { werte, stand: 'aktuell' };
}

function adresseText(a: StandortAdresse | null): string | null {
  if (!a) return null;
  const ort = [a.plz, a.ort].filter((t) => t && t.trim()).join(' ');
  const teile = [a.strasse, ort].filter((t): t is string => Boolean(t && t.trim()));
  return teile.length > 0 ? teile.join(' · ') : null;
}

/** Der Standort der Anlage und seine weiteren Anlagen. */
export function aufbauWurzel(
  standorte: StandorteAmStichtag | null,
  siteId: string,
): { wurzel: AufbauWurzel | null; nachbarn: { id: string; name: string }[] } {
  if (!standorte) return { wurzel: null, nachbarn: [] };
  const st = standorte.standorte.find((s) => s.anlagen.some((a) => a.id === siteId));
  if (st) {
    return {
      wurzel: {
        art: 'standort',
        id: st.id,
        name: st.name,
        kurzzeichen: st.kurzzeichen || null,
        adresse: adresseText(st.adresse),
        entwurf: st.zustand === 'entwurf',
      },
      nachbarn: st.anlagen.filter((a) => a.id !== siteId).map((a) => ({ id: a.id, name: a.name })),
    };
  }
  // Nicht zugeordnet: die ANDEREN nicht zugeordneten Anlagen sind kein Ort -
  // sie stehen deshalb nicht als Geschwister daneben.
  return {
    wurzel: {
      art: 'ohne-standort',
      id: null,
      name: OHNE_STANDORT,
      kurzzeichen: null,
      adresse: null,
      entwurf: false,
    },
    nachbarn: [],
  };
}

function kachelFuer(karte: GeraeteKarte): { kategorie: AufbauKategorie; icon: IconName } {
  if (karte.art === 'neu') return { kategorie: 'fund', icon: 'search' };
  if (karte.art === 'verwaist') return { kategorie: 'warn', icon: 'alert-triangle' };
  if (karte.art === 'ladepunkt') return { kategorie: 'ev', icon: 'zap' };
  for (const rolle of KACHEL_REIHENFOLGE) {
    if (karte.komponenten.some((c) => c.role === rolle)) return KACHEL[rolle];
  }
  return { kategorie: 'navy', icon: 'cpu' };
}

function unterzeileFuer(karte: GeraeteKarte, setup: EntityLocalSetup | undefined): string {
  if (karte.art === 'neu') return karte.untertitel;
  const modell = setup ? technicalDeviceName({ brand: setup.brand, model: setup.model ?? null }) : null;
  if (modell && modell !== karte.titel) return modell;
  if (karte.technischerName && karte.technischerName !== karte.titel) return karte.technischerName;
  return karte.untertitel;
}

/** Eine Karte der Liste als Baum-Gerät. */
export function aufbauGeraet(
  karte: GeraeteKarte,
  kontext: { localSetup?: EntityLocalSetup[] | null; charging?: SiteCharging | null } = {},
): AufbauGeraet {
  const setup = (kontext.localSetup ?? []).find((l) => l.id === karte.id);
  let werte = komponentenWerte(karte.komponenten);
  if (karte.art === 'ladepunkt' && werte.length === 0) {
    const saeule = (kontext.charging?.chargers ?? []).find(
      (c) => chargerGeraetId(c.chargePointId) === karte.id,
    );
    const w = saeule ? ladeWert(saeule) : null;
    werte = w ? [w] : [];
  }
  const kachel = kachelFuer(karte);
  return {
    id: karte.id,
    art: karte.art as Exclude<KartenArt, 'box'>,
    titel: karte.art === 'neu' ? neuTitel(karte) : karte.titel,
    unterzeile: unterzeileFuer(karte, setup),
    ton: karte.ton,
    zustand: karte.zustand,
    werte,
    kategorie: kachel.kategorie,
    icon: kachel.icon,
    karte,
  };
}

/** „Fronius gefunden" - der Hersteller, wenn die Box ihn nennt. */
function neuTitel(karte: GeraeteKarte): string {
  const q = karte.quelle;
  const name = q ? technicalDeviceName({ brand: q.brand, model: null }) : null;
  return name ? `${name} gefunden` : 'Neues Gerät gefunden';
}

function boxName(box: Device): string {
  const name = (box.name ?? '').trim();
  return name || 'VoltPilot-Box';
}

/**
 * Die Geräte einer Anlage auf ihre Boxen verteilen (Regeln im Modulkopf).
 * Gibt die Geräte je Box-Id und die ohne sichere Box zurück.
 */
function verteilen(
  geraete: AufbauGeraet[],
  boxen: Device[],
  registryBoxId: string | null,
  charging: SiteCharging | null,
): { jeBox: Map<string, AufbauGeraet[]>; ohneBox: AufbauGeraet[] } {
  const jeBox = new Map<string, AufbauGeraet[]>(boxen.map((b) => [b.id, []]));
  const ohneBox: AufbauGeraet[] = [];
  const einzige = boxen.length === 1 ? boxen[0].id : null;
  const fuehrende = boxen.some((b) => b.id === registryBoxId) ? registryBoxId : null;
  for (const g of geraete) {
    let ziel: string | null = einzige;
    if (!ziel && boxen.length > 1) {
      if (g.art === 'ladepunkt') {
        const saeule = (charging?.chargers ?? []).find(
          (c) => chargerGeraetId(c.chargePointId) === g.id,
        );
        ziel = saeule && jeBox.has(saeule.deviceId) ? saeule.deviceId : fuehrende;
      } else if (g.art !== 'neu') {
        ziel = fuehrende;
      }
    }
    if (ziel && jeBox.has(ziel)) jeBox.get(ziel)!.push(g);
    else ohneBox.push(g);
  }
  return { jeBox, ohneBox };
}

function anlageKnoten(
  input: AufbauEingabe,
  id: string,
  name: string,
  aktuell: boolean,
): AufbauAnlage {
  const boxenRoh = (input.devices ?? []).filter((d) => d.siteId === id);
  const mehrere = boxenRoh.length > 1;
  const registryBoxId = aktuell ? input.registryBoxId : null;
  // Die führende Box steht oben; sonst bleibt die Reihenfolge der Liste.
  const boxenSortiert = [...boxenRoh].sort(
    (a, b) => Number(b.id === registryBoxId) - Number(a.id === registryBoxId),
  );
  const karten = aktuell ? input.karten : input.nachbarKarten?.[id] ?? null;
  const kontext = aktuell ? { localSetup: input.localSetup, charging: input.charging } : {};
  const geraete = (karten ?? [])
    .filter((k) => k.art !== 'box')
    .map((k) => aufbauGeraet(k, kontext));
  const { jeBox, ohneBox } = verteilen(
    geraete,
    boxenSortiert,
    registryBoxId,
    aktuell ? input.charging : null,
  );
  const site = (input.overview ?? []).find((s) => s.id === id);
  const live = anlagenWerte(site, input.now);
  return {
    id,
    name,
    aktuell,
    werte: live.werte,
    wertStand: live.stand,
    boxen: boxenSortiert.map((b) => {
      const lage = boxLage(b, input.devicesFetchedAt, input.now);
      return {
        id: b.id,
        ref: b.externalRef,
        name: boxName(b),
        ton: lage.ton,
        zustand: lage.zustand,
        fuehrend: mehrere && b.id === registryBoxId,
        href: boxSeiteHash(id, b.externalRef),
        geraete: jeBox.get(b.id) ?? [],
      };
    }),
    ohneBox,
    geraeteZahl:
      karten == null
        ? null
        : geraete.filter((g) => g.art === 'geraet' || g.art === 'ladepunkt').length,
  };
}

/** Der ganze Baum: die geöffnete Anlage zuerst, dann ihre Nachbarn am Standort. */
export function aufbauBaum(input: AufbauEingabe): AufbauBaum {
  const { wurzel, nachbarn } = aufbauWurzel(input.standorte, input.siteId);
  const anlagen = [
    anlageKnoten(input, input.siteId, input.siteName, true),
    ...nachbarn.map((n) => anlageKnoten(input, n.id, n.name, false)),
  ];
  return {
    wurzel,
    anlagen,
    boxZahl: anlagen.reduce((n, a) => n + a.boxen.length, 0),
  };
}
