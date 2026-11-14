/**
 * Wie die Box gerade zum Router kommt (Konzept vp-edge-light-wlan, E1=B,
 * Scheibe S5) - reine Ableitung aus `Device.linkKind`/`signalDbm`/
 * `linkWeakSince`, genutzt vom Weg (`boxweg/BoxWeg.tsx`) und der Box-Seite
 * (`pages/BoxSeiteSection.tsx`). `null`/fehlend ist immer „die Box meldet es
 * (noch) nicht" - nie „keine Verbindung" oder „schlecht". Die Sätze dazu
 * stehen, wie überall in diesem Weg, in `koppelTexte.ts` (`VERBINDUNG`) -
 * dieses Modul liefert nur die Fakten, nie den Wortlaut.
 */
import type { Device } from './api';

/** Bericht vp-edge-light-wlan-konzept, Abschnitt 0.1/4.2: ab -70 dBm "reicht". */
export const SIGNAL_SCHWACH_DBM = -70;

/**
 * Ab wann ein schwaches Signal zur Warnung wird - nicht schon beim ersten
 * schwachen Herzschlag (ein einzelner Ausreißer), sondern erst, wenn es
 * LÄNGER so ist (Bericht: „warnt, wenn das Signal länger unter -70 dBm
 * liegt"). Dieselbe Größenordnung wie die anderen Umschaltpunkte des Wegs
 * (`boxweg/wegLage.ts`, `UMSCHALT_PRUEFEN_MS`).
 */
export const SIGNAL_SCHWACH_WARNUNG_MS = 5 * 60 * 1000;

type VerbindungsFelder = Pick<Device, 'linkKind' | 'signalDbm' | 'linkWeakSince'>;

export interface VerbindungsStand {
  /** `null` = die Box meldet (noch) nichts darüber - nie „keine Verbindung". */
  art: 'kabel' | 'wlan' | null;
  /** Nur bedeutsam, wenn `art === 'wlan'`: das Signal ist LÄNGER schwach, kein einzelner Ausreißer. */
  schwach: boolean;
}

/** Was der Weg und die Box-Seite aus `linkKind`/`signalDbm`/`linkWeakSince` ablesen. */
export function verbindungsStand(device: VerbindungsFelder, jetzt: Date = new Date()): VerbindungsStand {
  if (device.linkKind !== 'wlan') {
    return { art: device.linkKind === 'kabel' ? 'kabel' : null, schwach: false };
  }
  return { art: 'wlan', schwach: istSignalSchwach(device, jetzt) };
}

/** Ist das Signal gerade LÄNGER schwach, nicht nur ein einzelner Ausreißer? */
function istSignalSchwach(device: Pick<Device, 'linkWeakSince'>, jetzt: Date): boolean {
  if (!device.linkWeakSince) return false;
  const seit = jetzt.getTime() - new Date(device.linkWeakSince).getTime();
  return Number.isFinite(seit) && seit >= SIGNAL_SCHWACH_WARNUNG_MS;
}

/**
 * War die Box zuletzt per WLAN da? Bestimmt, ob eine Box ohne Verbindung den
 * Weg über das Einrichtungs-WLAN genannt bekommt (Bericht 0.1, Bildschirm
 * „Ihre Box meldet sich nicht"). Der Aufrufer entscheidet, WANN das gilt -
 * eine Box, die noch nie online war, bekommt diesen Satz nicht.
 */
export function warZuletztWlan(device: Pick<Device, 'linkKind'>): boolean {
  return device.linkKind === 'wlan';
}
