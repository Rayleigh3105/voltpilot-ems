/**
 * Die GERÄTE AN EINER BOX (GE-4, Konzept „Ein Gerät, ein Eintrag", Captain 23.10.2026, GD-4 A).
 *
 * Box-Seite und Standort › Boxen lesen sie aus DERSELBEN Zuordnung Weg → Gerät wie der Aufbau (GE-1:
 * `plantModel` → `zentraleListe` → `aufbauBaum`, Wege nur über gespeicherte Verweise). Vorher zählte die
 * Box-Seite den gemeldeten Bestand (`localSetup`) und der Aufbau das Anlagenmodell — zwei Zählweisen für dieselben
 * Kästen; Standort › Boxen zählte nur Datenquellen („Liest 1 Datenquelle").
 *
 * Die LAST ist die der Wege, die diese Box liest (Box-Herzschlag `data_sources[]`): max(Anfragen/30,
 * Messwerte/600) — je Weg am Gerät oder Gateway, als Summe an der Box (`boxUebersicht.boxLast`, dieselbe Rechnung
 * wie die Box-Zeile im Aufbau). Nicht gemeldet ist keine Null: ohne Meldung steht keine Zahl da, nie „0 %".
 *
 * Rein + framework-frei; die Seiten rendern nur.
 */
import type { Device, SiteEntities, SiteSource, SiteTopology, UemsDatenquelle, UemsGeraet } from './api';
import { aufbauBaum, type AufbauAnlage, type AufbauBox, type AufbauEingabe, type AufbauGeraet, type AufbauWeg } from './aufbauBaum';
import { kastenSatz } from './aufbauTabelle';
import { ANFRAGEN_GRENZE, boxLast, lastText, MESSWERTE_GRENZE, wegLast, type WegLast } from './boxUebersicht';
import { boxRefOf } from './geraetAdresse';
import { geraetAdressierbar, type GeraetTon } from './geraetSeite';
import { ioBindungenAus, plantModel } from './komponenten';
import type { SiteCharging } from './ladepunkte';
import { geraetSeiteHash } from './nav';
import { zentraleListe } from './zentraleListe';

/** Was die Seite für den Aufbau einer Anlage geladen hat — dieselben Abrufe wie `AufbauSection`. */
export interface AnlageDaten {
  siteId: string;
  siteName: string;
  /** `GET …/entities`; null = nicht geladen, dann ist auch kein Gerät bekannt. */
  entities: SiteEntities | null;
  topology?: SiteTopology | null;
  sources?: SiteSource[] | null;
  charging?: SiteCharging | null;
  /** Die Verbraucher (K4: wer an einem Relais hängt); ohne sie die frühere Zuordnung. */
  consumers?: readonly { id: string; ioEntityId?: string | null; ioChannel?: number | null }[] | null;
  devices: readonly Device[];
  devicesFetchedAt?: number | null;
  datenquellen: readonly UemsDatenquelle[] | null;
  /** `GET …/geraete`; null/undefined = unbekannt — dann stehen weder Anbindungen noch Anschlüsse da (GE-1). */
  uemsGeraete: readonly UemsGeraet[] | null | undefined;
  /** Die Anlagensteuerungen mit ihren Werten (GE-3): ihre Einheiten zählen als Geräte an der Box wie im Aufbau. */
  anlagensteuerungen?: NonNullable<AufbauEingabe['anlagensteuerungen']>[string];
  now: number;
}

/**
 * Der Aufbau EINER Anlage — dieselbe Kette wie `AufbauSection` (die geöffnete Anlage), damit Box-Seite und
 * Standort › Boxen genau die Kästen zählen, die der Aufbau unter der Box zeigt. null = Geräte nicht geladen.
 */
export function aufbauDerAnlage(d: AnlageDaten): AufbauAnlage | null {
  if (!d.entities) return null;
  const devices = [...d.devices];
  const model = plantModel(
    d.entities.entities,
    d.topology ?? null,
    d.entities.localSetup,
    d.sources ?? null,
    ioBindungenAus(d.consumers ?? []),
  );
  const karten = zentraleListe({
    siteId: d.siteId,
    model,
    devices: devices.filter((x) => x.siteId === d.siteId),
    devicesFetchedAt: d.devicesFetchedAt,
    boxRef: boxRefOf(devices, d.siteId),
    localSetup: d.entities.localSetup,
    sources: d.sources ?? null,
    charging: d.charging ?? null,
    now: d.now,
  });
  return aufbauBaum({
    siteId: d.siteId,
    siteName: d.siteName,
    standorte: null,
    devices,
    devicesFetchedAt: d.devicesFetchedAt,
    karten,
    localSetup: d.entities.localSetup,
    charging: d.charging ?? null,
    registryBoxId: d.entities.registry?.deviceId ?? null,
    overview: null,
    datenquellen: d.datenquellen,
    uemsGeraete: { [d.siteId]: d.uemsGeraete },
    anlagensteuerungen: d.anlagensteuerungen ? { [d.siteId]: d.anlagensteuerungen } : undefined,
    now: d.now,
  }).anlagen[0];
}

const zahl = (wert: number) => wert.toLocaleString('de-DE', { maximumFractionDigits: 1 });

/** „Zusammen 12 von 30 Anfragen/min · 305 von 600 Messwerten/min · Last 51 %"; null = keine Zahl gemeldet. */
function summeText(l: WegLast): string | null {
  if (l.prozent == null) return null;
  const teile = [
    l.anfragen == null ? null : `${zahl(l.anfragen)} von ${ANFRAGEN_GRENZE} Anfragen/min`,
    l.messwerte == null ? null : `${zahl(l.messwerte)} von ${MESSWERTE_GRENZE} Messwerten/min`,
  ].filter((s): s is string => s != null);
  return [
    `Zusammen ${teile.join(' · ')}`,
    lastText(l.prozent),
    l.ohneMeldung.length > 0 ? `ohne Meldung: ${l.ohneMeldung.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Ein Kasten an der Box: ein Gerät (auch hinter einem Gateway). */
export interface BoxEintrag {
  id: string;
  titel: string;
  /** Modell bzw. Art („WAGO PFC200"). */
  typ: string;
  /** Die Anbindung mit Last: „Modbus TCP · 192.168.4.165:503 · Last 51 %"; hinter dem Gateway „Geräte-ID 2"; null = kein Weg bekannt. */
  anbindung: string | null;
  zustand: string;
  ton: GeraetTon;
  /** Die Geräteseite über diese Box; null = das Gerät hat keine (Ersatzgerät). */
  href: string | null;
  /** Der Weg (1 : 1), dessen zuständige Box sich hier wechseln lässt; null = keiner. */
  quelleId: string | null;
}

/** Ein Gateway (1 : N) mit den Geräten dahinter — Box-Wechsel und Last gelten für alle. */
export interface BoxGateway {
  id: string;
  kennzeichen: string;
  titel: string;
  /** „Modbus TCP · 192.168.10.31:502 · Geräte-IDs 1–4 · Kennung DQ-3". */
  weg: string;
  /** „4 Geräte · Last 23 %". */
  zeile: string;
  zustand: string;
  ton: GeraetTon;
  geraete: BoxEintrag[];
  /** Die Seite des Gateways (GE-5); null = keine (Anlage ohne Box). */
  href: string | null;
}

/** Ein Anschluss ohne Gerät (1 : 0, angefangen). */
export interface BoxAnschluss {
  id: string;
  kennzeichen: string;
  titel: string;
  /** „Modbus TCP · 192.168.10.40:502 · Kennung DQ-5 · Last 4 %". */
  weg: string;
  zustand: string;
  ton: GeraetTon;
}

/** Der Baustein „Geräte an dieser Box" — und der Satz für Standort › Boxen. */
export interface BoxGeraeteBlock {
  /** Die Geräte direkt an der Box (nicht hinter einem Gateway), in der Reihenfolge des Aufbaus. */
  eintraege: BoxEintrag[];
  gateways: BoxGateway[];
  offen: BoxAnschluss[];
  /** Alle Geräte an der Box, auch hinter einem Gateway — dieselben, die der Aufbau zählt; null = nicht geladen. */
  anzahl: number | null;
  /** Davon „liefert Daten". */
  liefern: number;
  /** Von der Box gemeldet, noch nicht übernommen (zählt nicht als Gerät). */
  gemeldet: number;
  /** „Zusammen 12 von 30 Anfragen/min · 305 von 600 Messwerten/min · Last 51 %"; null = siehe `summeLeer`. */
  summe: string | null;
  /** Warum keine Summe dasteht; null = es steht eine (oder die Box liest keinen Weg). */
  summeLeer: string | null;
  /** Wie die Box-Zeile im Aufbau: „4 Geräte · Last 51 %", „0 Geräte · 3 Anschlüsse offen · Last 47 %". */
  kurz: string;
  /** Wege, die diese Box für eine andere Anlage liest — sie stehen dort, zählen aber in die Last. */
  fremd: string | null;
  /** Die Box liest Wege, aber welches Gerät dahinter steht, ist gerade nicht bekannt (`…/geraete` fehlt). */
  zuordnungUnbekannt: boolean;
}

export interface BoxGeraeteEingabe {
  boxId: string;
  boxRef: string;
  siteId: string;
  /** Der Ast dieser Box im Aufbau der Anlage; null = Geräte nicht geladen. */
  box: AufbauBox | null;
  /** Alle bekannten Wege (auch anderer Anlagen am Standort) — für die Last zählt, was diese Box liest. */
  datenquellen: readonly UemsDatenquelle[] | null;
  /** Ist die Zuordnung Weg → Gerät bekannt (`…/geraete` geladen)? */
  zuordnung: boolean;
  anlagenNamen?: ReadonlyMap<string, string>;
}

const mehrzahl = (n: number, eins: string, viele: string) => `${n} ${n === 1 ? eins : viele}`;

/** Die Geräte an einer Box mit Anbindung und Last (GE-4). */
export function boxGeraeteBlock(e: BoxGeraeteEingabe): BoxGeraeteBlock {
  const { quellen, last, kurz: lastKurz } = boxLast(e.boxId, e.datenquellen);
  const quelle = new Map(quellen.map((q) => [q.id, q]));
  const lastVon = (ids: readonly string[]): string | null => {
    const qs = ids.map((id) => quelle.get(id)).filter((q): q is UemsDatenquelle => q != null);
    const p = qs.length > 0 ? wegLast(qs).prozent : null;
    return p == null ? null : lastText(p);
  };

  const eintrag = (g: AufbauGeraet): BoxEintrag => {
    // Die Wege dieses Geräts, die DIESE Box liest — ihre Last trägt die Box (GD-4 A: je Gerät klein).
    const eigene = g.gateway ? [] : g.anbindungen.map((a) => a.quelleId).filter((id) => quelle.has(id));
    return {
      id: g.id,
      titel: g.titel,
      typ: g.unterzeile,
      anbindung: [g.anbindungText, lastVon(eigene)].filter(Boolean).join(' · ') || null,
      zustand: g.zustand,
      ton: g.ton,
      // Über DIESE Box adressiert (wie die Box-Seite es immer tat) — auch, wo der Aufbau mangels führender Box keine
      // Adresse kennt. Ein Ersatzgerät (`dev:…`) und Gemeldetes haben keine Seite.
      href: (g.art === 'geraet' && geraetAdressierbar(g.id)) || g.art === 'ladepunkt'
        ? geraetSeiteHash(e.siteId, e.boxRef, g.id)
        : null,
      quelleId: eigene[0] ?? null,
    };
  };

  const box = e.box;
  const geraete = (box?.geraete ?? []).filter((g) => g.art !== 'neu');
  const wege = box?.wege ?? [];
  // GE-3: die Einheiten einer Anlagensteuerung stehen direkt hinter ihr — auch hinter einem Gateway, wo die Steuerung steht.
  const mitEinheiten = (liste: readonly AufbauGeraet[]) =>
    liste.flatMap((g) => [g, ...geraete.filter((u) => u.einheit?.steuerungId === g.id)]);
  const gateways = wege.filter((w): w is AufbauWeg => w.art === 'gateway').map((w): BoxGateway => ({
    id: w.id,
    kennzeichen: w.kennzeichen,
    titel: w.titel,
    weg: w.weg,
    zeile: [mehrzahl(w.geraete.length, 'Gerät', 'Geräte'), lastVon([w.id])].filter(Boolean).join(' · '),
    zustand: [w.zustandWort, w.zustandZeit].filter(Boolean).join(' · '),
    ton: w.ton,
    geraete: mitEinheiten(w.geraete).map(eintrag),
    href: w.href,
  }));
  const offen = wege.filter((w) => w.art === 'offen').map((w): BoxAnschluss => ({
    id: w.id,
    kennzeichen: w.kennzeichen,
    titel: w.titel,
    weg: [w.weg, lastVon([w.id])].filter(Boolean).join(' · '),
    zustand: [w.zustandWort, w.zustandZeit].filter(Boolean).join(' · '),
    ton: w.ton,
  }));

  const summe = summeText(last);
  const summeLeer = quellen.length > 0 && summe == null ? 'Ihre Last meldet die Box noch nicht je Anschluss.' : null;

  const fremde = quellen.filter((q) => q.anlage !== e.siteId);
  const fremdeAnlagen = [...new Set(fremde.map((q) => q.anlage))];
  const fremd = fremde.length === 0
    ? null
    : `Außerdem liest diese Box für ${fremdeAnlagen.map((a) => e.anlagenNamen?.get(a) ?? 'eine andere Anlage').join(', ')}: `
      + `${fremde.map((q) => q.kennzeichen).join(', ')} — dort im Aufbau.`;

  return {
    eintraege: mitEinheiten(geraete.filter((g) => !g.gateway && !g.einheit)).map(eintrag),
    gateways,
    offen,
    anzahl: box ? geraete.length : null,
    liefern: geraete.filter((g) => g.ton === 'ok').length,
    gemeldet: (box?.geraete ?? []).length - geraete.length,
    summe,
    summeLeer,
    kurz: [box ? kastenSatz(box.geraete, box.wege) : 'Geräte nicht geladen', lastKurz].filter(Boolean).join(' · '),
    fremd,
    zuordnungUnbekannt: !e.zuordnung && quellen.some((q) => q.anlage === e.siteId),
  };
}
