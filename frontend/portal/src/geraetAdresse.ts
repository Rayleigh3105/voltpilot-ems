/**
 * Die ADRESSEN der Geräteseiten, die das Cockpit schon im ersten Bild braucht:
 * welche Box eine Anlage hat und wie eine OCPP-Säule im Pfad heißt.
 *
 * ⚠ EIGENES MODUL (UX-Review V-01, 24.09.2026): Cockpit und Komponenten-Board
 * brauchten aus `geraetSeite.ts` (1 150 Zeilen Geräteseiten-Ableitung) nur diese
 * Einzeiler - und zogen dafür das ganze Modul samt `selbstbau.ts` ins
 * Einstiegs-Bündel. `geraetSeite.ts` reicht sie unverändert weiter; die
 * Regel „welche Box führt diese Anlage" lebt weiterhin genau einmal - hier.
 */
import type { Device } from './api';
import { geraetSeiteHash } from './nav';

/**
 * Die Referenz der führenden VoltPilot-Box dieser Anlage - sonst null.
 *
 * Bei mehreren Boxen entscheidet ausschließlich das additive API-Fakt
 * {@code fuehrtAnlage} (UEMS AP-06 IP-16); nur für eine echte Ein-Box-Anlage
 * bleibt der alte Rückfall erhalten. So wechselt kein bestehender Aufrufer
 * still auf irgendeine Box.
 */
export function boxRefOf(devices: Device[] | null | undefined, siteId: string): string | null {
  return fuehrendeBoxOf(devices, siteId)?.externalRef ?? null;
}

/**
 * Dieselbe Regel, aber das ganze Gerät - für alles, was mehr braucht als die
 * Referenz (etwa die gemeldete LAN-Adresse, D5).
 *
 * ⚠ Sie lebt EINMAL: zwei Stellen, die „welche Box ist es denn?" verschieden
 * beantworten, wären zwei Wahrheiten über dieselbe Anlage.
 */
export function fuehrendeBoxOf(devices: Device[] | null | undefined, siteId: string): Device | null {
  const eigene = (devices ?? []).filter((d) => d.siteId === siteId);
  const markiert = eigene.filter((d) => d.fuehrtAnlage === true);
  if (markiert.length === 1) return markiert[0];
  return eigene.length === 1 ? eigene[0] : null;
}

/** Die Kennung einer OCPP-Säule im Pfad: `cp-<ChargePointId>`. */
export function chargerGeraetId(chargePointId: string): string {
  return `cp-${chargePointId}`;
}

/** Rückrichtung: `cp-…` → die ChargePointId; null wenn es keine Säule ist. */
export function chargePointIdOf(geraetId: string | null): string | null {
  if (!geraetId || !geraetId.startsWith('cp-')) return null;
  const id = geraetId.slice(3);
  return id ? id : null;
}

/**
 * Die Kennung eines Verbrauchers an einem I/O-Ausgang im Pfad: `io-<Entität>`
 * (K4). Er hat keine eigene Quelle an der Box - geschaltet wird er über das
 * Relais eines Moduls -, bekommt aber trotzdem seine eigene Seite.
 */
export function ioVerbraucherGeraetId(entityId: string): string {
  return `io-${entityId}`;
}

/** Rückrichtung: `io-…` → die Entität des Verbrauchers; null sonst. */
export function ioVerbraucherIdOf(geraetId: string | null): string | null {
  if (!geraetId || !geraetId.startsWith('io-')) return null;
  const id = geraetId.slice(3);
  return id ? id : null;
}

/**
 * Die Kennung einer Anlagensteuerung im Pfad: `as-<Entität>` (UEMS EZ-10). Die Box liest sie über eine
 * Datenquelle (Erzeuger-Registerbild), nicht über eine eigene Quelle - sie bekommt trotzdem ihre eigene Seite.
 */
export function anlagensteuerungGeraetId(entityId: string): string {
  return `as-${entityId}`;
}

/** Rückrichtung: `as-…` → die Entität der Anlagensteuerung; null sonst (auch für eine Einheit `as-…~te-n`). */
export function anlagensteuerungIdOf(geraetId: string | null): string | null {
  if (!geraetId || !geraetId.startsWith('as-') || geraetId.includes('~')) return null;
  const id = geraetId.slice(3);
  return id ? id : null;
}

/**
 * Die Kennung einer Erzeugungseinheit hinter einer Anlagensteuerung im Pfad: `as-<Entität>~te-<n>` (GE-3, d1). Die
 * Einheit hat keine eigene Komponente — ihre Messreihen `erzeuger.te[n].*` hängen an der Komponente der Steuerung,
 * nicht am Einbau; darum trägt die Adresse deren Entität (wie `as-…`) und die TE-Nr. Ohne „/“: der Pfad trennt
 * `…/geraet/{ref}/{geraetId}` am Schrägstrich. „~“ kommt in einer Entitäts-Kennung nie vor
 * (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) und bleibt in `encodeURIComponent` stehen.
 */
export function einheitGeraetId(entityId: string, teNr: number): string {
  return `as-${entityId}~te-${teNr}`;
}

/** Rückrichtung: `as-<Entität>~te-<n>` → Entität und TE-Nr. (1 … 10); null sonst. */
export function einheitAdresseOf(geraetId: string | null): { entityId: string; teNr: number } | null {
  const m = geraetId ? /^as-([A-Za-z0-9][A-Za-z0-9._-]{0,63})~te-([1-9]|10)$/.exec(geraetId) : null;
  return m ? { entityId: m[1], teNr: Number(m[2]) } : null;
}

/**
 * Die Kennung eines Gateways oder Loggers im Pfad: `dq-<n>` aus seinem Kennzeichen `DQ-<n>` (Konzept „Ein Gerät,
 * ein Eintrag", GE-5). Ein Weg mit mehreren Geräten ist selbst ein Kasten (GD-3 A) und bekommt eine Seite im
 * Geräteseiten-Rahmen. Das Kennzeichen ist seine stabile Kennung (je Kundenbereich eindeutig, Vertrag
 * data-source-assignment §3) — nie die Adresse, die sich ändern darf.
 */
export function gatewayGeraetId(kennzeichen: string): string {
  return `dq-${kennzeichen.trim().replace(/^DQ-/i, '')}`;
}

/**
 * Rückrichtung: `dq-3` → das Kennzeichen `DQ-3`; null sonst. Nur Ziffern: die Datenbank vergibt `DQ-<n>` — so
 * bleibt eine Entität, die zufällig mit „dq-" beginnt, ein Gerät.
 */
export function gatewayKennzeichenOf(geraetId: string | null): string | null {
  const m = geraetId ? /^dq-(\d+)$/.exec(geraetId) : null;
  return m ? `DQ-${m[1]}` : null;
}

/**
 * Die Adresse der Gateway-Seite (GE-5) — über die Box, die es liest; liest es keine bekannte Box, über die führende
 * Box der Anlage (wie jedes Gerät). Die Box ist nur das Tor der Adresse: die Seite findet ihr Gateway über das
 * Kennzeichen, auch nach einem Box-Wechsel. null = die Anlage hat keine Box — dann gibt es, wie bei einem Gerät
 * ohne Box, keine Adresse.
 */
export function gatewaySeiteHash(
  siteId: string,
  quelle: { kennzeichen: string; zustaendige_box: { id: string } | null },
  devices: readonly Device[] | null | undefined,
): string | null {
  const lesend = quelle.zustaendige_box ? (devices ?? []).find((d) => d.id === quelle.zustaendige_box?.id) : undefined;
  const ref = lesend?.externalRef ?? boxRefOf(devices ? [...devices] : null, siteId);
  return ref ? geraetSeiteHash(siteId, ref, gatewayGeraetId(quelle.kennzeichen)) : null;
}
