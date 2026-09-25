/**
 * Die ADRESSEN der Geräteseiten, die das Cockpit schon im ersten Bild braucht:
 * welche Box eine Anlage hat und wie eine OCPP-Säule im Pfad heißt.
 *
 * ⚠ EIGENES MODUL (UX-Review V-01, 24.09.2026): Cockpit und Komponenten-Board
 * brauchten aus `geraetSeite.ts` (1 150 Zeilen Geräteseiten-Ableitung) nur diese
 * Einzeiler - und zogen dafür das ganze Modul samt `selbstbau.ts` ins
 * Einstiegs-Bündel. `geraetSeite.ts` reicht alle vier unverändert weiter; die
 * Regel „eine Anlage hat genau EINE Box" lebt weiterhin genau einmal - hier.
 */
import type { Device } from './api';

/**
 * Die Referenz der EINEN VoltPilot-Box dieser Anlage - sonst null.
 *
 * Eine Anlage hat per Captain-Korrektur genau EINE Box; sind es (noch) mehrere
 * oder keine, wird KEINE geraten: ein Weg auf eine Geräteseite, die vielleicht
 * die falsche Box meint, ist schlechter als kein Weg.
 */
export function boxRefOf(devices: Device[] | null | undefined, siteId: string): string | null {
  return boxOf(devices, siteId)?.externalRef ?? null;
}

/**
 * Dieselbe Regel, aber das ganze Gerät - für alles, was mehr braucht als die
 * Referenz (etwa die gemeldete LAN-Adresse, D5).
 *
 * ⚠ Sie lebt EINMAL: zwei Stellen, die „welche Box ist es denn?" verschieden
 * beantworten, wären zwei Wahrheiten über dieselbe Anlage.
 */
export function boxOf(devices: Device[] | null | undefined, siteId: string): Device | null {
  const eigene = (devices ?? []).filter((d) => d.siteId === siteId);
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
