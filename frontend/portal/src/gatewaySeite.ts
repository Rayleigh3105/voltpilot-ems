/**
 * Die GATEWAY-SEITE (Konzept „Ein Gerät, ein Eintrag", GE-5, Captain 23.10.2026, GD-3 A).
 *
 * Ein Weg, hinter dem mehrere Geräte antworten (1 : N), ist selbst ein Kasten: ein Zählergateway, ein Logger.
 * Er bekommt eine Seite im Geräteseiten-Rahmen unter `…/geraet/{ref}/dq-<n>` (`geraetAdresse.gatewayGeraetId`):
 * seine Anbindung (dieselben Zeilen wie am Gerät, `geraetAnbindung.gatewayAnbindung` — hier mit Last und
 * Box-Wechsel, weil beide für alle Geräte daran gelten), die Geräte dahinter mit ihren Seiten, der Verlauf der
 * Anbindung und „Gerät an diesem Gateway hinzufügen".
 *
 * WELCHE Geräte hinter dem Weg stehen, entscheidet hier nichts: die Seite liest den Aufbau (`aufbauBaum`, GE-1) —
 * nur gespeicherte Verweise (`geraet.data_source_id`), nie eine gleiche Adresse. Trägt der Weg genau ein Gerät
 * (1 : 1) oder keins (1 : 0), ist er kein Kasten und hat keine Seite: die Adresse nennt dann den Ort, an dem er
 * steht.
 *
 * Rein + framework-frei; `pages/GatewaySeiteSection.tsx` rendert nur.
 */
import type { Device, UemsDatenquelle, UemsDatenquelleBestaetigt, UemsDatenquelleVorschlagsliste } from './api';
import type { AufbauAnlage, AufbauWeg } from './aufbauBaum';
import { dqHinzufuegenAnfrage } from './datenquelleVorschlag';
import { gatewayAnbindung, type Anbindung } from './geraetAnbindung';
import { geraetAdressierbar, type GeraetTon } from './geraetSeite';
import { aufbauHash, geraetSeiteHash } from './nav';

/** Ein Gerät hinter dem Gateway, mit dem Weg auf seine Seite. */
export interface GatewayGeraet {
  id: string;
  titel: string;
  /** Modell bzw. Art („Eastron SDM630"). */
  typ: string;
  /** „Geräte-ID 2" — die eigene Adresse am gemeinsamen Weg; null = nicht erhoben. */
  geraeteId: string | null;
  zustand: string;
  ton: GeraetTon;
  /** Die Geräteseite; null = das Gerät hat keine (Ersatzgerät). */
  href: string | null;
}

export interface GatewaySeiteGefunden {
  art: 'gefunden';
  quelle: UemsDatenquelle;
  weg: AufbauWeg;
  titel: string;
  zustand: { wort: string; ton: GeraetTon; detail: string | null };
  anbindung: Anbindung;
  geraete: GatewayGeraet[];
  /** „4 Geräte · 3 liefern Daten". */
  geraeteSatz: string;
  /** „Gerät an diesem Gateway hinzufügen": der Aufbau mit vorbelegtem Weg (`?neu=geraet&an=DQ-3`). */
  hinzufuegenHref: string;
}

/** Kein Gateway unter dieser Adresse — mit dem Ort, an dem der Weg steht, wenn es einen gibt. */
export interface GatewaySeiteFehlt {
  art: 'fehlt';
  titel: string;
  satz: string;
  weiter: { text: string; href: string } | null;
}

export type GatewaySeiteView = GatewaySeiteGefunden | GatewaySeiteFehlt;

export interface GatewaySeiteEingabe {
  siteId: string;
  /** Die Box-Referenz der Adresse — das Tor, über das die Geräte dahinter ihre Seiten haben. */
  ref: string;
  kennzeichen: string;
  /** Der Aufbau der Anlage (`boxGeraete.aufbauDerAnlage`); null = Geräte nicht geladen. */
  anlage: AufbauAnlage | null;
  /** Die Wege der Anlage (`GET …/data-sources`). */
  datenquellen: readonly UemsDatenquelle[];
  /** Ist die Zuordnung Weg → Gerät bekannt (`GET …/geraete` geladen)? Ohne sie gibt es kein Gateway, nie ein geratenes. */
  zuordnung: boolean;
  devices: readonly Device[];
  /** Der Zustand der Gemeinsamen Steuerung (nur für eine Steuerquelle gefragt); null = keine oder nicht geladen. */
  gemeinsamZustand: string | null;
}

const mehrzahl = (n: number, eins: string, viele: string) => `${n} ${n === 1 ? eins : viele}`;

/** Die Seite des Gateways mit diesem Kennzeichen — oder warum es hier keine gibt. */
export function gatewaySeite(e: GatewaySeiteEingabe): GatewaySeiteView {
  const quelle = e.datenquellen.find((q) => q.kennzeichen === e.kennzeichen && q.anlage === e.siteId && q.archiviert_am == null);
  const zumAufbau = { text: 'Zum Aufbau', href: aufbauHash(e.siteId) };
  if (!quelle) {
    return {
      art: 'fehlt',
      titel: 'Dieses Gateway ist hier nicht (mehr) zu finden',
      satz: `Unter der Kennung ${e.kennzeichen} kennt diese Anlage keinen Anschluss.`,
      weiter: zumAufbau,
    };
  }
  if (!e.zuordnung || !e.anlage) {
    return {
      art: 'fehlt',
      titel: 'Die Geräte dieses Anschlusses sind gerade nicht bekannt',
      satz: `Welche Geräte hinter ${quelle.kennzeichen} antworten, ließ sich gerade nicht laden.`,
      weiter: zumAufbau,
    };
  }
  const anlage = e.anlage;
  const weg = [...anlage.boxen.flatMap((b) => b.wege), ...anlage.wegeOhneBox].find((w) => w.id === quelle.id);
  if (!weg || weg.art !== 'gateway') {
    // 1 : 1 — der Weg ist die Anbindung seines Geräts (Regel §2.2): er hat keine eigene Seite.
    const geraete = [...anlage.boxen.flatMap((b) => b.geraete), ...anlage.ohneBox];
    const traeger = geraete.find((g) => g.anbindungen.some((a) => a.quelleId === quelle.id));
    if (traeger) {
      const href = traeger.karte.href ?? (geraetAdressierbar(traeger.id) ? geraetSeiteHash(e.siteId, e.ref, traeger.id) : null);
      return {
        art: 'fehlt',
        titel: `${quelle.kennzeichen} ist die Anbindung von ${traeger.titel}`,
        satz: 'Über diesen Anschluss antwortet genau ein Gerät — Weg, Box und Last stehen auf seiner Seite unter „Anbindung“.',
        weiter: href ? { text: `Zu ${traeger.titel}`, href } : zumAufbau,
      };
    }
    return {
      art: 'fehlt',
      titel: `An ${quelle.kennzeichen} ist noch kein Gerät angebunden`,
      satz: 'Ein Anschluss ohne Gerät steht im Aufbau — dort fügen Sie das Gerät hinzu.',
      weiter: { text: 'Im Aufbau ein Gerät hinzufügen', href: aufbauHash(e.siteId, 'geraet') },
    };
  }

  const geraete = weg.geraete.map((g): GatewayGeraet => ({
    id: g.id,
    titel: g.titel,
    typ: g.unterzeile,
    geraeteId: g.anbindungText,
    zustand: g.zustand,
    ton: g.ton,
    // Über die Box der Adresse — wie die Box-Seite ihre Geräte adressiert (GE-4).
    href: (g.art === 'geraet' && geraetAdressierbar(g.id)) || g.art === 'ladepunkt'
      ? geraetSeiteHash(e.siteId, e.ref, g.id)
      : null,
  }));
  const liefern = weg.geraete.filter((g) => g.ton === 'ok').length;
  return {
    art: 'gefunden',
    quelle,
    weg,
    titel: weg.titel,
    zustand: { wort: weg.zustandWort, ton: weg.ton, detail: weg.zustandZeit },
    anbindung: gatewayAnbindung({
      quelle,
      geraete: weg.geraete.length,
      devices: e.devices,
      siteId: e.siteId,
      gemeinsamZustand: e.gemeinsamZustand,
    }),
    geraete,
    geraeteSatz: [mehrzahl(geraete.length, 'Gerät', 'Geräte'), `${liefern} ${liefern === 1 ? 'liefert' : 'liefern'} Daten`].join(' · '),
    hinzufuegenHref: aufbauHash(e.siteId, 'geraet', { an: quelle.kennzeichen }),
  };
}

// ---- „Gerät an diesem Gateway hinzufügen" -------------------------------------------------------------------

/** Die Protokolle, deren Vorlagen den Weg als `ip` · `port` · `unit_id` tragen (`BestandAnschluss`, Modbus). */
const MODBUS_PROTOKOLLE = new Set(['modbus_tcp', 'sunspec_modbus']);

/**
 * Die kleinste Geräte-ID, die an diesem Weg noch frei ist — belegt sind die Geräte-IDs des Wegs und die der
 * Geräte daran. Nur ein Vorschlag: der Kunde ändert sie, der Verbindungstest prüft sie.
 */
export function freieGeraeteId(q: UemsDatenquelle): number {
  const belegt = new Set<number>([
    ...(q.geraete_ids ?? []),
    ...(q.geraete ?? []).map((g) => g.geraete_id).filter((n): n is number => n != null),
  ]);
  let n = 1;
  while (belegt.has(n)) n += 1;
  return n;
}

/**
 * Was der Anlege-Fluss für ein Gerät an diesem Weg vorbelegt: Adresse, Port und die nächste freie Geräte-ID —
 * dieselbe Adresse ist an derselben Box ein Gerät DIESER Quelle, nie eine neue (Vertrag data-source-assignment
 * §3.2). Nur für Modbus; null = der Weg lässt sich nicht als Vorlagenfeld schreiben (dann bleibt nur die Box).
 */
export function gatewayVorbelegung(q: UemsDatenquelle): Record<string, unknown> | null {
  if (!MODBUS_PROTOKOLLE.has(q.protokoll)) return null;
  const m = /^(.+):(\d+)$/.exec(q.adresse.trim());
  if (!m) return null;
  return { ip: m[1], port: Number(m[2]), unit_id: freieGeraeteId(q) };
}

/**
 * Nach dem Anlegen: die Bestätigung „Zu DQ-3 hinzufügen" für das neue Gerät — der Vorschlag des Servers, der es an
 * diesem Weg zeigt (`adresse_an_box_vergeben` mit `ziel`), genau so, wie die Liste ihn zeigt. Leer = der Server
 * zeigt es dort nicht (etwa, weil eine andere Box es liest) — dann hängt nichts, nie eine geratene Zuordnung.
 */
export function gatewayAnhaengen(
  liste: UemsDatenquelleVorschlagsliste,
  quelleId: string,
  komponenteId: string,
): UemsDatenquelleBestaetigt[] {
  const v = liste.vorschlaege.find((x) => x.ziel?.id === quelleId && x.komponenten.some((k) => k.id === komponenteId));
  return v ? dqHinzufuegenAnfrage(v) : [];
}

/** Der Satz nach dem Anhängen — angehängt oder ehrlich nicht. */
export function gatewayAnhaengenSatz(kennzeichen: string, angehaengt: boolean): string {
  return angehaengt
    ? `Es antwortet jetzt über Gateway ${kennzeichen}.`
    : `Mit Gateway ${kennzeichen} ist es noch nicht verknüpft — VoltPilot sieht es dort nicht unter derselben Adresse und Box.`;
}
