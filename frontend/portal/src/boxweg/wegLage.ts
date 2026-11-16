import { deviceLiveStatus, type BoxSoftwareUpdate, type Device } from '../api';
import { verbindungsStand, warZuletztWlan, type VerbindungsStand } from '../boxVerbindung';
import { VERBINDUNG, WEG } from '../koppelTexte';

/**
 * Die Lage-Regeln des Wegs (vp-box-verbinden-konzept, Bericht Abschnitt 4.3/5,
 * E1 = B „Der Weg"): sechs Stationen - Eingesteckt · Box startet · Anmeldung ·
 * Datenverbindung · Software · Ihre Anlage. Reine Ableitung aus dem, was das
 * Portal wirklich weiß (`Device.createdAt`, `Device.anmeldung`,
 * `Device.lastSeenAt`, das Update der Box `BoxSoftwareUpdate`); nichts hier
 * rät, ob Strom da ist oder welche Box physisch steckt.
 *
 * „Software“ (Erstverbindung S2, E4 = B): Holt sich die Box beim ersten
 * Verbinden die neueste Software, wartet der Weg, bis sie fertig ist - mit
 * Fortschritt und Restzeit, ohne „Weiter“. Fertig ist auch „kommt später“
 * (zurückgenommen, nicht zugewiesen) und die Obergrenze von 12 Minuten. Ist
 * kein Update fällig, ist die Station sofort erledigt.
 *
 * „Eingesteckt" kann das Portal nie belegen (Bauhinweis 7.1): die Station
 * bleibt gestrichelt, bis eine spätere Station ein Signal hat - dann war die
 * Box zwangsläufig eingesteckt, auch ohne dass das Portal es je sah.
 */

export type StationKey = 'eingesteckt' | 'startet' | 'anmeldung' | 'datenverbindung' | 'software' | 'anlage';
/** `spaeter`: erledigt, aber ohne Ergebnis - die neue Software kommt später (nur „Software“). */
export type StationState = 'dashed' | 'active' | 'done' | 'problem' | 'spaeter';
export type SoftwareSchritt = 'laden' | 'neustart' | 'pruefen';

/** Die Station „Software“, solange sie etwas zu sagen hat. */
export interface SoftwareLage {
  /** `prueft` = die Automatik entscheidet noch; `laeuft` = das Update läuft; `laenger` = über der Obergrenze. */
  stand: 'prueft' | 'laeuft' | 'laenger' | 'fertig' | 'spaeter';
  /** Der laufende Schritt (Laden · Neu starten · Prüfen); `null` vor und nach dem Update. */
  schritt: SoftwareSchritt | null;
  /** Fortschritt 0..1 aus Schritt und verstrichener Zeit; `null` ohne Balken. */
  anteil: number | null;
  /** „noch etwa 2 Min.“ */
  restText: string | null;
}
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
  /** Die Station „Software“; `null`, solange die Box noch nicht online war oder nichts fällig ist. */
  software: SoftwareLage | null;
  /** Darf „Weiter: Ihre Anlage“ stehen? Erst wenn die Box online ist und kein Update läuft (E4 = B). */
  weiterFrei: boolean;
  /** Konzept vp-edge-light-wlan-s5: wie die Box gerade zum Router kommt. */
  verbindung: VerbindungsStand;
  /**
   * Box ohne Verbindung, zuletzt per WLAN da (Bericht 0.1, „Ihre Box meldet
   * sich nicht"): der Weg zurück über das Einrichtungs-WLAN - `null`, solange
   * die Box online ist oder noch nie eines wusste.
   */
  einrichtungshinweis: string | null;
}

const SEK = 1000;
export const UMSCHALT_LAENGER_MS = 3 * 60 * SEK;
export const UMSCHALT_PRUEFEN_MS = 5 * 60 * SEK;
export const UMSCHALT_SUPPORT_MS = 15 * 60 * SEK;
/** Anmeldung da, aber 75 s später noch kein Herzschlag: Port 8883 vermutlich gesperrt (Abschnitt 4.1). */
export const DATENSPERRE_MS = 75 * SEK;
/**
 * N1 (Nebenfund vp-erstverbindung-update-konzept): die Box lädt ihre
 * Zertifikatsanfrage nur einmal je Programmstart hoch, `zuletztAngefragtAm`
 * kann also Stunden älter sein als das Verbinden. Lief sie schon vorher
 * (`liefSchon`), bekommt die 75-s-Messung diesen Zuschlag für ihren
 * Abruf-Takt (bis 60 s), statt sofort auf Datensperre zu laufen.
 */
export const DATENSPERRE_ZUSCHLAG_LIEF_SCHON_MS = 60 * SEK;
/** Ein Update dauert geschätzt 3 Minuten (Konzept 2.9, 2 bis 4 Minuten; gemessen ist es noch nicht). */
export const SOFTWARE_GESCHAETZT_MS = 3 * 60 * SEK;
/** Obergrenze: Probezeit der Box 10 Minuten plus Rand - danach „läuft im Hintergrund weiter“ und „Weiter“. */
export const SOFTWARE_OBERGRENZE_MS = 12 * 60 * SEK;

/** Die Spanne des Balkens je Schritt: der Schritt setzt die Mindest- und Höchstmarke, die Zeit füllt dazwischen. */
const SCHRITT_SPANNE: Record<SoftwareSchritt, [number, number]> = {
  laden: [0.04, 0.4],
  neustart: [0.4, 0.75],
  pruefen: [0.75, 0.95],
};

/** Das Update der Box ist noch nicht gefragt (der erste Abruf läuft). */
export const UPDATE_UNGEFRAGT = 'ungefragt';
export type WegUpdate = BoxSoftwareUpdate | null | typeof UPDATE_UNGEFRAGT;

/**
 * Die Station „Software“ aus dem Update der Box. {@link UPDATE_UNGEFRAGT} wie „prüft“: der Weg gibt „Weiter“ nicht
 * frei, bevor er weiß, ob ein Update kommt; `null` = nicht lesbar oder älteres Backend, wie „nichts fällig“ - ein
 * fehlender Block hält niemanden fest.
 */
export function softwareLage(update: WegUpdate, jetzt: Date): SoftwareLage | null {
  if (update === UPDATE_UNGEFRAGT) return { stand: 'prueft', schritt: null, anteil: null, restText: null };
  if (update === null || update.phase === 'keins') return null;
  const seit = zeitpunkt(update.seit);
  const verstrichen = seit == null ? 0 : Math.max(0, jetzt.getTime() - seit);
  switch (update.phase) {
    case 'fertig':
      return { stand: 'fertig', schritt: null, anteil: 1, restText: null };
    case 'spaeter':
      return { stand: 'spaeter', schritt: null, anteil: null, restText: null };
    case 'prueft':
      return verstrichen >= SOFTWARE_OBERGRENZE_MS
        ? { stand: 'laenger', schritt: null, anteil: null, restText: null }
        : { stand: 'prueft', schritt: null, anteil: null, restText: null };
    default: {
      const schritt: SoftwareSchritt =
        update.phase === 'startet_neu' ? 'neustart' : update.phase === 'prueft_box' ? 'pruefen' : 'laden';
      if (verstrichen >= SOFTWARE_OBERGRENZE_MS) return { stand: 'laenger', schritt, anteil: null, restText: null };
      const [von, bis] = SCHRITT_SPANNE[schritt];
      const anteil = Math.min(bis, Math.max(von, verstrichen / SOFTWARE_GESCHAETZT_MS));
      const restMin = Math.max(1, Math.ceil((SOFTWARE_GESCHAETZT_MS - verstrichen) / 60_000));
      return { stand: 'laeuft', schritt, anteil, restText: WEG.softwareRest(restMin) };
    }
  }
}

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

export function wegLage(
  device: Device,
  jetzt: Date = new Date(),
  update: WegUpdate = null,
): WegLage {
  const now = jetzt.getTime();
  const createdAt = zeitpunkt(device.createdAt);
  const angefragtAm = zeitpunkt(device.anmeldung?.zuletztAngefragtAm);
  const abgeholtAm = zeitpunkt(device.anmeldung?.schluesselAbgeholtAm);
  const angemeldet = angefragtAm != null;
  const everSeen = device.lastSeenAt != null;
  const liveStatus = deviceLiveStatus(device, jetzt);
  const online = liveStatus === 'online';
  const stale = liveStatus === 'stale';
  const liefSchon = angemeldet && createdAt != null && angefragtAm! < createdAt;
  const eingesteckt: StationState = angemeldet || everSeen ? 'done' : 'dashed';
  const verbindung = verbindungsStand(device, jetzt);
  // Nur eine Box, die schon einmal online war und es jetzt nicht mehr ist,
  // bekommt den Weg zurück genannt - eine Box, die noch nie etwas sendete,
  // hat auch noch kein WLAN gewusst, das wieder öffnen könnte.
  const einrichtungshinweis = everSeen && !online && warZuletztWlan(device)
    ? VERBINDUNG.stillWlanHinweis
    : null;

  if (everSeen) {
    const software = softwareLage(update, jetzt);
    const basis = { online, stale, liefSchon, verbindung, einrichtungshinweis, software };
    const davor = { eingesteckt: 'done', startet: 'done', anmeldung: 'done', datenverbindung: 'done' } as const;
    // Das Update läuft (oder die Automatik entscheidet noch): der Weg wartet - auch, wenn die Box im Neustart
    // gerade still ist; das gehört zum Update und ist kein „meldet sich nicht“.
    if (software && (software.stand === 'prueft' || software.stand === 'laeuft')) {
      const seit = update === UPDATE_UNGEFRAGT ? null : zeitpunkt(update?.seit ?? null);
      return {
        ...basis,
        stationen: { ...davor, software: 'active', anlage: 'dashed' },
        aktiv: 'software',
        titel: software.stand === 'prueft' ? WEG.softwarePruefTitel : WEG.softwareTitel,
        satz: software.stand === 'prueft' ? WEG.softwarePruefSatz : WEG.softwareSatz,
        chipText: seit == null ? null : WEG.softwareChip(mmss(now - seit)),
        hinweis: 'keiner',
        weiterFrei: false,
      };
    }
    if (software?.stand === 'laenger') {
      return {
        ...basis,
        stationen: { ...davor, software: 'active', anlage: 'dashed' },
        aktiv: 'software',
        titel: WEG.softwareLaengerTitel,
        satz: WEG.softwareLaengerSatz,
        chipText: null,
        hinweis: 'keiner',
        weiterFrei: online,
      };
    }
    const spaeter = software?.stand === 'spaeter';
    return {
      ...basis,
      stationen: { ...davor, software: spaeter ? 'spaeter' : 'done', anlage: 'active' },
      aktiv: 'anlage',
      titel: !online ? WEG.stillTitel : software?.stand === 'fertig' ? WEG.softwareFertigTitel : WEG.onlineTitel,
      satz: !online ? WEG.stillSatz : spaeter ? WEG.softwareSpaeterSatz : WEG.onlineSatz,
      chipText: null,
      hinweis: 'keiner',
      weiterFrei: online,
    };
  }

  if (angemeldet) {
    // N1: ab "Zertifikat abgeholt" messen, sobald gesetzt - der frischeste Beleg für
    // Aktivität nach dem Verbinden. Sonst ab dem späteren Zeitpunkt aus Anmeldung und
    // Verbinden, mit Zuschlag für den Abruf-Takt der Box, wenn sie schon vorher lief.
    let seitAnmeldung: number;
    if (abgeholtAm != null) {
      seitAnmeldung = now - abgeholtAm;
    } else {
      const anmeldungBasis = createdAt != null ? Math.max(angefragtAm!, createdAt) : angefragtAm!;
      const zuschlag = liefSchon ? DATENSPERRE_ZUSCHLAG_LIEF_SCHON_MS : 0;
      seitAnmeldung = now - anmeldungBasis - zuschlag;
    }
    if (seitAnmeldung >= DATENSPERRE_MS) {
      return {
        stationen: {
          eingesteckt: 'done',
          startet: 'done',
          anmeldung: 'done',
          datenverbindung: 'problem',
          software: 'dashed',
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
        verbindung,
        einrichtungshinweis,
        software: null,
        weiterFrei: false,
      };
    }
    return {
      stationen: {
        eingesteckt: 'done',
        startet: 'done',
        anmeldung: 'done',
        datenverbindung: 'active',
        software: 'dashed',
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
      verbindung,
      einrichtungshinweis,
      software: null,
      weiterFrei: false,
    };
  }

  const seit = createdAt == null ? 0 : Math.max(0, now - createdAt);
  if (seit >= UMSCHALT_SUPPORT_MS) {
    return {
      stationen: { eingesteckt, startet: 'problem', anmeldung: 'dashed', datenverbindung: 'dashed', software: 'dashed', anlage: 'dashed' },
      aktiv: 'startet',
      titel: WEG.titelHoertNichts,
      satz: WEG.satzSupport,
      chipText: WEG.chipStartet(mmss(seit)),
      hinweis: 'support',
      online: false,
      stale: false,
      liefSchon,
      verbindung,
      einrichtungshinweis,
      software: null,
      weiterFrei: false,
    };
  }
  if (seit >= UMSCHALT_PRUEFEN_MS) {
    return {
      stationen: { eingesteckt, startet: 'problem', anmeldung: 'dashed', datenverbindung: 'dashed', software: 'dashed', anlage: 'dashed' },
      aktiv: 'startet',
      titel: WEG.titelHoertNichts,
      satz: WEG.satzPruefen,
      chipText: WEG.chipStartet(mmss(seit)),
      hinweis: 'pruefen',
      online: false,
      stale: false,
      liefSchon,
      verbindung,
      einrichtungshinweis,
      software: null,
      weiterFrei: false,
    };
  }
  if (seit >= UMSCHALT_LAENGER_MS) {
    return {
      stationen: { eingesteckt, startet: 'active', anmeldung: 'dashed', datenverbindung: 'dashed', software: 'dashed', anlage: 'dashed' },
      aktiv: 'startet',
      titel: WEG.titelLaenger,
      satz: WEG.satzLaenger,
      chipText: WEG.chipStartet(mmss(seit)),
      hinweis: 'laenger',
      online: false,
      stale: false,
      liefSchon,
      verbindung,
      einrichtungshinweis,
      software: null,
      weiterFrei: false,
    };
  }
  return {
    stationen: { eingesteckt, startet: 'active', anmeldung: 'dashed', datenverbindung: 'dashed', software: 'dashed', anlage: 'dashed' },
    aktiv: 'startet',
    titel: WEG.titelStartet,
    satz: WEG.satzStartet,
    chipText: WEG.chipStartet(mmss(seit)),
    hinweis: 'keiner',
    online: false,
    stale: false,
    liefSchon,
    verbindung,
    einrichtungshinweis,
    software: null,
    weiterFrei: false,
  };
}

export const STATION_LABEL: Record<StationKey, string> = WEG.stationLabel;

export const STATION_REIHENFOLGE: readonly StationKey[] = [
  'eingesteckt',
  'startet',
  'anmeldung',
  'datenverbindung',
  'software',
  'anlage',
];
