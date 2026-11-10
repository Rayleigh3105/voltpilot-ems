import { deviceLiveStatus, type Device } from '../api';
import { WEG } from '../koppelTexte';

/**
 * Die Lage-Regeln des Wegs (vp-box-verbinden-konzept, Bericht Abschnitt 4.3/5,
 * E1 = B „Der Weg"): fünf Stationen - Eingesteckt · Box startet · Anmeldung ·
 * Datenverbindung · Ihre Anlage. Reine Ableitung aus dem, was das Portal
 * wirklich weiß (`Device.createdAt`, `Device.anmeldung`, `Device.lastSeenAt`);
 * nichts hier rät, ob Strom da ist oder welche Box physisch steckt.
 *
 * „Eingesteckt" kann das Portal nie belegen (Bauhinweis 7.1): die Station
 * bleibt gestrichelt, bis eine spätere Station ein Signal hat - dann war die
 * Box zwangsläufig eingesteckt, auch ohne dass das Portal es je sah.
 */

export type StationKey = 'eingesteckt' | 'startet' | 'anmeldung' | 'datenverbindung' | 'anlage';
export type StationState = 'dashed' | 'active' | 'done' | 'problem';
export type Hinweis = 'keiner' | 'laenger' | 'pruefen' | 'datensperre' | 'support';

export interface WegLage {
  stationen: Record<StationKey, StationState>;
  /** Die Station, auf die sich Chip, Überschrift und Prüf-Hilfe beziehen. */
  aktiv: StationKey;
  titel: string;
  satz: string;
  /** „Startet · 1:12" - null, sobald die Box online war (Abschnitt 6.1: kein Chip mehr nötig). */
  chipText: string | null;
  hinweis: Hinweis;
  online: boolean;
  /** War online, ist jetzt still (anders als „waiting": nie ein Lebenszeichen). */
  stale: boolean;
  /** Steckte die Box schon vor dem Verbinden (Anmeldung vor dem Claim)? */
  liefSchon: boolean;
}

const SEK = 1000;
export const UMSCHALT_LAENGER_MS = 3 * 60 * SEK;
export const UMSCHALT_PRUEFEN_MS = 5 * 60 * SEK;
export const UMSCHALT_SUPPORT_MS = 15 * 60 * SEK;
/** Anmeldung da, aber 75 s später noch kein Herzschlag: Port 8883 vermutlich gesperrt (Abschnitt 4.1). */
export const DATENSPERRE_MS = 75 * SEK;

/** "1:12" - Minuten:Sekunden, nie negativ. */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function zeitpunkt(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

export function wegLage(device: Device, jetzt: Date = new Date()): WegLage {
  const now = jetzt.getTime();
  const createdAt = zeitpunkt(device.createdAt);
  const angefragtAm = zeitpunkt(device.anmeldung?.zuletztAngefragtAm);
  const angemeldet = angefragtAm != null;
  const everSeen = device.lastSeenAt != null;
  const liveStatus = deviceLiveStatus(device, jetzt);
  const online = liveStatus === 'online';
  const stale = liveStatus === 'stale';
  const liefSchon = angemeldet && createdAt != null && angefragtAm! < createdAt;
  const eingesteckt: StationState = angemeldet || everSeen ? 'done' : 'dashed';

  if (everSeen) {
    return {
      stationen: {
        eingesteckt: 'done',
        startet: 'done',
        anmeldung: 'done',
        datenverbindung: 'done',
        anlage: 'active',
      },
      aktiv: 'anlage',
      titel: online ? WEG.onlineTitel : WEG.stillTitel,
      satz: online ? WEG.onlineSatz : WEG.stillSatz,
      chipText: null,
      hinweis: 'keiner',
      online,
      stale,
      liefSchon,
    };
  }

  if (angemeldet) {
    const seitAnmeldung = now - angefragtAm!;
    if (seitAnmeldung >= DATENSPERRE_MS) {
      return {
        stationen: {
          eingesteckt: 'done',
          startet: 'done',
          anmeldung: 'done',
          datenverbindung: 'problem',
          anlage: 'dashed',
        },
        aktiv: 'datenverbindung',
        titel: WEG.titelDatensperre,
        satz: WEG.satzDatensperre,
        chipText: WEG.chipAngemeldet(mmss(seitAnmeldung)),
        hinweis: 'datensperre',
        online: false,
        stale: false,
        liefSchon,
      };
    }
    return {
      stationen: {
        eingesteckt: 'done',
        startet: 'done',
        anmeldung: 'done',
        datenverbindung: 'active',
        anlage: 'dashed',
      },
      aktiv: 'datenverbindung',
      titel: WEG.titelImInternet,
      satz: liefSchon ? WEG.satzLiefSchon : WEG.satzGleich,
      chipText: WEG.chipAngemeldet(mmss(seitAnmeldung)),
      hinweis: 'keiner',
      online: false,
      stale: false,
      liefSchon,
    };
  }

  const seit = createdAt == null ? 0 : Math.max(0, now - createdAt);
  if (seit >= UMSCHALT_SUPPORT_MS) {
    return {
      stationen: { eingesteckt, startet: 'problem', anmeldung: 'dashed', datenverbindung: 'dashed', anlage: 'dashed' },
      aktiv: 'startet',
      titel: WEG.titelHoertNichts,
      satz: WEG.satzSupport,
      chipText: WEG.chipStartet(mmss(seit)),
      hinweis: 'support',
      online: false,
      stale: false,
      liefSchon,
    };
  }
  if (seit >= UMSCHALT_PRUEFEN_MS) {
    return {
      stationen: { eingesteckt, startet: 'problem', anmeldung: 'dashed', datenverbindung: 'dashed', anlage: 'dashed' },
      aktiv: 'startet',
      titel: WEG.titelHoertNichts,
      satz: WEG.satzPruefen,
      chipText: WEG.chipStartet(mmss(seit)),
      hinweis: 'pruefen',
      online: false,
      stale: false,
      liefSchon,
    };
  }
  if (seit >= UMSCHALT_LAENGER_MS) {
    return {
      stationen: { eingesteckt, startet: 'active', anmeldung: 'dashed', datenverbindung: 'dashed', anlage: 'dashed' },
      aktiv: 'startet',
      titel: WEG.titelLaenger,
      satz: WEG.satzLaenger,
      chipText: WEG.chipStartet(mmss(seit)),
      hinweis: 'laenger',
      online: false,
      stale: false,
      liefSchon,
    };
  }
  return {
    stationen: { eingesteckt, startet: 'active', anmeldung: 'dashed', datenverbindung: 'dashed', anlage: 'dashed' },
    aktiv: 'startet',
    titel: WEG.titelStartet,
    satz: WEG.satzStartet,
    chipText: WEG.chipStartet(mmss(seit)),
    hinweis: 'keiner',
    online: false,
    stale: false,
    liefSchon,
  };
}

export const STATION_LABEL: Record<StationKey, string> = WEG.stationLabel;

export const STATION_REIHENFOLGE: readonly StationKey[] = [
  'eingesteckt',
  'startet',
  'anmeldung',
  'datenverbindung',
  'anlage',
];
