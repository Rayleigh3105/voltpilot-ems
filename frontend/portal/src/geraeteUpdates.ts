import { boxVerbindung, releaseIsRunning } from './adminFleet';
import {
  BOX_ART_LABELS, BOX_ART_UNBEKANNT, LOADER_FLASH, actorLabel, blockerLever, deviceBoxArt, geraetZeile,
  releaseBoxArt, releaseSperre, stateLabel, type BoxArt, type EdgeEignung, type EdgeReleaseSeite, type EdgeUpdates,
  type EdgeUpdatesRelease, type FleetRow, type UpdateFakten, type VerlaufEintrag,
} from './adminEdgeUpdates';
import { versionDisplay } from './edgeVersionLabel';
import { NBSP, fmtRelative, seitDauer } from './format';

/**
 * Die reine Schicht der Seite „Geräte & Updates" (Geräte & Updates G5, Konzept
 * vom 05.11.2026): Lage-Satz, je Software-Linie eine Karte, „Braucht dich" und
 * die Boxen nach Linie. Sie rechnet nichts neu, was der Server schon weiß: der
 * Linien-Stand je Box (`stand`), die drei Fakten einer Anfrage (`fakten`) und
 * die eine Uhr (`lastSeenAt`) kommen aus der API. Fehlt ein Feld (älterer
 * Server), steht dort „unbekannt" - nie eine geratene Null.
 *
 * Drei Wörter, nie vermischt: angefragt (Portal) · angenommen (Box) ·
 * bestätigt (Box). Stufe 1 ist kein Fehler, sondern „nur von Hand".
 */

/** Ein Satz mit Versionen in Festbreitenschrift. */
export type Satz = (string | { mono: string })[];

export const LINIEN: BoxArt[] = ['docker', 'light'];

const LINIE_INFO: Record<BoxArt, { name: string; icon: 'layers' | 'cpu'; muster: Satz }> = {
  docker: {
    name: 'Docker-Box', icon: 'layers',
    muster: ['Releases ', { mono: 'edge-JJJJ.MM.N' }, ' · ein Bild für PC und Raspberry Pi'],
  },
  light: {
    name: 'Edge Light', icon: 'cpu',
    muster: ['Releases ', { mono: 'edge-light-JJJJ.MM.N' }, ' · ein Programm je Gerät'],
  },
};

/**
 * Für welche Geräte die Docker-Box gebaut wird: EIN Bild für beide
 * Plattformen (`edge-images.yaml`, `platforms: linux/amd64,linux/arm64`). Das
 * signierte Manifest nennt die Plattformen eines Bildes nicht; der Bau tut es.
 */
const DOCKER_PLATTFORMEN = ['linux/amd64', 'linux/arm64'];

/** Ab wann ein bestätigtes Update nur noch als Satz steht (seine drei Schritte sind dann Geschichte). */
export const TRACKER_NACH_BESTAETIGT_MS = 24 * 3600_000;

// ── Wörter je Linien-Stand (`ota.LinienStand`) ─────────────────────────────

export type SegmentArt = 'ok' | 'lauf' | 'alt' | 'halt' | 'fehler' | 'hand' | 'off' | 'leer';

const SEGMENT_REIHE: SegmentArt[] = ['ok', 'lauf', 'alt', 'halt', 'fehler', 'hand', 'off', 'leer'];

const SEGMENT_WORT: Record<SegmentArt, string> = {
  ok: 'neuestes',
  lauf: 'Update läuft',
  alt: 'älter',
  halt: 'hält zurück',
  fehler: 'braucht dich',
  hand: 'nur von Hand (Stufe 1)',
  off: 'offline',
  leer: 'ohne Stand',
};

/** Der Linien-Stand einer Box als Segment; ein unbekanntes Wort ist „ohne Stand". */
export function segmentArt(stand: string | null | undefined): SegmentArt {
  switch (stand) {
    case 'aktuell': return 'ok';
    case 'laeuft': return 'lauf';
    case 'aelter': return 'alt';
    case 'gehalten': return 'halt';
    case 'fehler': return 'fehler';
    case 'hand': return 'hand';
    case 'offline': return 'off';
    default: return 'leer';
  }
}

/** Die Linie einer Box: aus der API (`linie`), sonst aus der gemeldeten Box-Art. */
export function linieDerBox(row: FleetRow): BoxArt | null {
  if (row.linie !== undefined) return row.linie === 'docker' || row.linie === 'light' ? row.linie : null;
  return deviceBoxArt(row.boxArt);
}

/** Der Name einer Box auf dieser Seite: die Anlage, sonst die Referenz. */
export function boxName(row: FleetRow): string {
  return row.siteName?.trim() || row.label || row.externalRef;
}

// ── Zeiten ──────────────────────────────────────────────────────────────────

const tag = (d: Date) => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const gleicherTag = (a: Date, b: Date) => tag(a) === tag(b);

/** „16:02" (heute), „gestern 16:02", „28.10. 16:02" (dieses Jahr), sonst „28.10.2025". */
export function uhr(iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hhmm = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (gleicherTag(d, now)) return hhmm;
  const gestern = new Date(now.getTime() - 24 * 3600_000);
  if (gleicherTag(d, gestern)) return `gestern ${hhmm}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${hhmm}`;
  }
  return tag(d);
}

/** „heute, 15:43", „gestern, 09:12" oder „28.10.2026" - wann ein Release entstand. */
export function wann(iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hhmm = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (gleicherTag(d, now)) return `heute, ${hhmm}`;
  if (gleicherTag(d, new Date(now.getTime() - 24 * 3600_000))) return `gestern, ${hhmm}`;
  return tag(d);
}

/** „heute", „gestern" oder „28.10." / „28.10.2025" - ein Tag ohne Uhrzeit. */
function datum(iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (gleicherTag(d, now)) return 'heute';
  if (gleicherTag(d, new Date(now.getTime() - 24 * 3600_000))) return 'gestern';
  return d.getFullYear() === now.getFullYear()
    ? d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
    : tag(d);
}

/** Was die Box fährt: das Register-Release aus der API, sonst ihr Stempel (ohne Build-Teil, wo erkennbar). */
export function istText(row: FleetRow): string | null {
  return row.istRelease ?? versionDisplay(row.ist)?.tag ?? row.ist ?? null;
}

// ── Anfrage: die drei Fakten ────────────────────────────────────────────────

const ENDE_FEHLER = ['fehlgeschlagen', 'zurueckgenommen', 'verstummt'];

/** Eine Anfrage ist offen, solange die Box weder bestätigt noch abgelehnt oder zurückgenommen hat. */
export function anfrageOffen(f: UpdateFakten | null | undefined): boolean {
  if (!f) return false;
  if (f.angenommen.stand === 'abgelehnt') return false;
  return f.bestaetigt.stand !== 'ja' && !ENDE_FEHLER.includes(f.bestaetigt.stand);
}

/** Das Release einer Anfrage, kurz („11.4" statt „edge-light-2026.11.4") - nur wo der Satz es braucht. */
export function kurzeVersion(version: string): string {
  const m = /^edge(?:-light)?-\d{4}\.(\d+\.\d+)$/.exec(version);
  return m ? m[1] : version;
}

export type TrackerZustand = 'fertig' | 'aktiv' | 'warten' | 'fehler' | 'leer';
export interface TrackerSchritt {
  /** Wer die Tatsache meldet: das Portal fragt an, die Box nimmt an und bestätigt. */
  schritt: 'angefragt' | 'angenommen' | 'bestaetigt';
  zustand: TrackerZustand;
  wort: string;
}

const SCHRITT_WORT: Record<string, string> = { laedt: 'lädt', wendet_an: 'wendet an', selbsttest: 'Selbsttest' };

/** Die drei Schritte einer Anfrage, so wie die Box sie gemeldet hat. */
export function tracker(f: UpdateFakten): TrackerSchritt[] {
  const angenommen: TrackerSchritt = (() => {
    switch (f.angenommen.stand) {
      case 'ja': return { schritt: 'angenommen', zustand: 'fertig', wort: 'angenommen' };
      case 'offen': return { schritt: 'angenommen', zustand: 'aktiv', wort: 'angenommen' };
      case 'wartet': return { schritt: 'angenommen', zustand: 'warten', wort: 'wartet' };
      case 'zurueckgestellt': return { schritt: 'angenommen', zustand: 'warten', wort: 'zurückgestellt' };
      case 'abgelehnt': return { schritt: 'angenommen', zustand: 'fehler', wort: 'abgelehnt' };
      default: return { schritt: 'angenommen', zustand: 'leer', wort: 'angenommen' };
    }
  })();
  const bestaetigt: TrackerSchritt = (() => {
    switch (f.bestaetigt.stand) {
      case 'ja': return { schritt: 'bestaetigt', zustand: 'fertig', wort: 'bestätigt' };
      case 'laeuft': return { schritt: 'bestaetigt', zustand: 'aktiv', wort: 'bestätigt' };
      case 'fehlgeschlagen': return { schritt: 'bestaetigt', zustand: 'fehler', wort: 'fehlgeschlagen' };
      case 'zurueckgenommen': return { schritt: 'bestaetigt', zustand: 'fehler', wort: 'zurückgenommen' };
      case 'verstummt': return { schritt: 'bestaetigt', zustand: 'fehler', wort: 'verstummt' };
      default:
        return {
          schritt: 'bestaetigt',
          zustand: f.angenommen.stand === 'ja' ? 'aktiv' : 'leer',
          wort: 'bestätigt',
        };
    }
  })();
  return [{ schritt: 'angefragt', zustand: 'fertig', wort: 'angefragt' }, angenommen, bestaetigt];
}

/** Der Satz unter den drei Schritten: was zuletzt geschah, mit Uhrzeit. */
export function anfrageSatz(row: FleetRow, f: UpdateFakten, now: Date): Satz {
  const rel = f.angefragt.release;
  const um = (iso: string | null) => (uhr(iso, now) ? ` ${uhr(iso, now)}` : '');
  const grund = (g: string | null) => (g ? `: ${g}` : '');
  const ist = istText(row);
  switch (f.bestaetigt.stand) {
    case 'ja': return [`bestätigt${um(f.bestaetigt.am)}`];
    case 'zurueckgenommen':
      return [
        `zurückgenommen${um(f.bestaetigt.am)}`,
        ...(f.bestaetigt.grund ? [` · ${f.bestaetigt.grund}`] : []),
        ...(ist ? [' · läuft wieder ', { mono: kurzeVersion(ist) }] : []),
      ];
    case 'fehlgeschlagen': return [`fehlgeschlagen${um(f.bestaetigt.am)}${grund(f.bestaetigt.grund)}`];
    case 'verstummt': return [`im Update verstummt${um(f.bestaetigt.am)}${grund(f.bestaetigt.grund)}`];
    case 'laeuft': {
      const schritt = f.bestaetigt.schritt ? SCHRITT_WORT[f.bestaetigt.schritt] ?? null : null;
      return [`angenommen${um(f.angenommen.am)}${schritt ? ` · ${schritt}` : ''}`];
    }
    default: break;
  }
  switch (f.angenommen.stand) {
    case 'abgelehnt': return ['Anfrage ', { mono: kurzeVersion(rel) }, ` abgelehnt${grund(f.angenommen.grund)}`];
    case 'wartet': return [`angefragt${um(f.angefragt.am)} · wartet, bis die Box online ist`];
    case 'zurueckgestellt':
      return [`angefragt${um(f.angefragt.am)} · zurückgestellt${grund(f.angenommen.grund)}`];
    case 'ja': return [`angenommen${um(f.angenommen.am)}`];
    default: return [`angefragt${um(f.angefragt.am)} · Box hat noch nicht angenommen`];
  }
}

/** Zeigt die Zeile die drei Schritte? Eine bestätigte Anfrage tut es noch einen Tag lang. */
export function zeigtTracker(f: UpdateFakten | null | undefined, now: Date): boolean {
  if (!f) return false;
  if (f.bestaetigt.stand !== 'ja') return true;
  const am = f.bestaetigt.am ? Date.parse(f.bestaetigt.am) : Number.NaN;
  return Number.isFinite(am) && now.getTime() - am < TRACKER_NACH_BESTAETIGT_MS;
}

// ── Box-Zeilen ──────────────────────────────────────────────────────────────

export type BadgeTon = 'ok' | 'lauf' | 'off' | 'warn' | 'fehler' | 'hand';
export interface ZeilenBadge { ton: BadgeTon; text: string }

export interface BoxVerbindungSicht {
  /** `unbekannt`: der Server liefert keine Uhr (älterer Stand) - nie still „nie gemeldet". */
  zustand: 'online' | 'verzoegert' | 'offline' | 'nie' | 'unbekannt';
  text: string;
  gesehen: string | null;
}

export interface BoxZeile {
  row: FleetRow;
  deviceId: string;
  name: string;
  ort: string;
  ref: string;
  linie: BoxArt | null;
  linieText: string;
  geraet: string;
  verbindung: BoxVerbindungSicht;
  /** Der laufende Stand, wie die Box ihn meldet; `null` = nichts gemeldet. */
  laeuft: string | null;
  urteil: ZeilenBadge | null;
  /**
   * Das angefragte Release, solange es nicht bestätigt läuft (die Zielversion,
   * getrennt von laufender und neuester); `null` = keine solche Anfrage.
   */
  ziel: string | null;
  updateBadge: ZeilenBadge | null;
  tracker: TrackerSchritt[] | null;
  satz: Satz | null;
  segment: SegmentArt;
  /** Steht in „Braucht dich" (Fehler, Zurückhalten, wartende Anfrage offline, Stufe 1). */
  brauchtDich: boolean;
  /** Läuft auf einem registrierten, älteren Release ihrer Linie. */
  aelter: boolean;
  offline: boolean;
  laeuftUpdate: boolean;
  suchtext: string;
}

export function verbindungSicht(row: FleetRow, now: Date): BoxVerbindungSicht {
  if (row.lastSeenAt === undefined) return { zustand: 'unbekannt', text: 'Verbindung unbekannt', gesehen: null };
  const v = boxVerbindung(row.lastSeenAt, now);
  // E6: „verzögert" ist reine Anzeige - sie trägt dieselbe Alters-Uhr wie
  // „online", nicht den „seit HH:MM"-Satz von „meldet sich nicht".
  if (v.zustand === 'online' || v.zustand === 'verzoegert') {
    return { zustand: v.zustand, text: v.text, gesehen: fmtRelative(row.lastSeenAt, now) };
  }
  if (v.zustand === 'offline') {
    const seit = seitDauer(row.lastSeenAt, now);
    const zuletzt = uhr(row.lastSeenAt, now);
    return {
      zustand: 'offline', text: v.text,
      gesehen: [seit, zuletzt ? `zuletzt ${zuletzt}` : null].filter(Boolean).join(' · ') || null,
    };
  }
  return { zustand: 'nie', text: v.text, gesehen: null };
}

/**
 * Ab wann gilt der Messwert als „aus" (§5.3-Sonderfall L2) - deutlich über dem
 * normalen Messtakt (die Box sendet spätestens alle 5 s), damit eine einzelne
 * ausgefallene Runde nicht sofort als Lücke behauptet wird.
 */
export const MESSWERT_LUECKE_MS = 60_000;

/**
 * Der L2-Sonderfall: der Herzschlag kommt an, aber die Messwerte stehen -
 * Herzschlag und Messwert laufen über getrennte Wege (API-Listener bzw.
 * Datenannahme → Redpanda → Writer), einer kann ausfallen, während der
 * andere läuft. Der Kopf bleibt dabei „Verbunden" (das ist er ja); diese
 * Funktion trägt nur, OB „Jetzt" trotzdem die Lücke nennen muss, statt sie
 * stumm zu überspringen. Aufrufer prüfen den Herzschlag-Zustand selbst -
 * diese Funktion kennt ihn nicht und behauptet ihn nie mit.
 */
export function messwerteLuecke(
  messwertAm: string | null | undefined,
  now: Date,
): { seit: string } | null {
  if (!messwertAm) return null;
  const alter = now.getTime() - Date.parse(messwertAm);
  if (!Number.isFinite(alter) || alter <= MESSWERT_LUECKE_MS) return null;
  return { seit: seitDauer(messwertAm, now) ?? 'seit wenigen Sekunden' };
}

function urteil(row: FleetRow, verbindung: BoxVerbindungSicht, now: Date): ZeilenBadge | null {
  if (!row.ist) return null;
  if (verbindung.zustand === 'offline') {
    const um = uhr(row.lastSeenAt ?? null, now);
    return { ton: 'off', text: um ? `Stand von ${um}` : 'Stand veraltet' };
  }
  if (row.stand === 'fehler' && row.fakten?.bestaetigt.stand === 'zurueckgenommen') {
    return { ton: 'fehler', text: 'zurückgenommen' };
  }
  if (row.stand === 'laeuft') return { ton: 'lauf', text: 'Update läuft' };
  if (row.istRelease && row.releasesDahinter === 0) return { ton: 'ok', text: 'neuestes' };
  if (row.istRelease && row.releasesDahinter != null && row.releasesDahinter > 0) {
    const n = row.releasesDahinter;
    return { ton: 'off', text: `${n} ${n === 1 ? 'Release' : 'Releases'} älter` };
  }
  if (row.istRelease === null) return { ton: 'off', text: 'nicht im Register' };
  return null;
}

/** Eine Box als Zeile der Liste. */
export function boxZeile(row: FleetRow, now: Date): BoxZeile {
  const linie = linieDerBox(row);
  const verbindung = verbindungSicht(row, now);
  const segment = segmentArt(row.stand);
  const f = row.fakten ?? null;
  let updateBadge: ZeilenBadge | null = null;
  let satz: Satz | null = null;
  const lever = blockerLever(row.blocker);
  if (segment === 'hand') updateBadge = { ton: 'hand', text: 'nur von Hand · Stufe 1' };
  else if (segment === 'halt') updateBadge = { ton: 'warn', text: stateLabel(row.state).label };
  if (f) {
    satz = zeigtTracker(f, now) ? anfrageSatz(row, f, now) : [`zuletzt bestätigt ${datum(f.bestaetigt.am, now) ?? ''}`.trim()];
    if (segment === 'halt' && row.reason) satz = [row.reason, ...(lever ? [` ${lever}`] : [])];
  } else if (segment === 'halt' && row.reason) {
    satz = [row.reason, ...(lever ? [` ${lever}`] : [])];
  } else {
    const seit = datum(row.istSeit ?? null, now);
    satz = [seit ? `läuft seit ${seit}` : 'keine Anfrage'];
  }
  const offline = verbindung.zustand === 'offline';
  const brauchtDich = segment === 'fehler' || segment === 'halt' || segment === 'hand'
    || (offline && anfrageOffen(f));
  const ref = row.label && row.label !== row.externalRef ? `${row.label} · ${row.externalRef}` : row.externalRef;
  const geraet = geraetZeile(row);
  const laeuft = istText(row);
  const linieText = linie ? BOX_ART_LABELS[linie] : BOX_ART_UNBEKANNT;
  return {
    row,
    deviceId: row.deviceId,
    name: boxName(row),
    ort: row.tenantName,
    ref,
    linie,
    linieText,
    geraet,
    verbindung,
    laeuft,
    urteil: urteil(row, verbindung, now),
    ziel: f && f.bestaetigt.stand !== 'ja' ? f.angefragt.release : null,
    updateBadge,
    tracker: f && zeigtTracker(f, now) ? tracker(f) : null,
    satz,
    segment,
    brauchtDich,
    aelter: !!row.istRelease && row.releasesDahinter != null && row.releasesDahinter > 0,
    offline,
    laeuftUpdate: segment === 'lauf',
    suchtext: [boxName(row), row.tenantName, row.label, row.externalRef, row.ist, row.soll, linieText, geraet]
      .filter(Boolean).join(' ').toLocaleLowerCase('de'),
  };
}

/** Alle Boxen als Zeilen: „Braucht dich" zuerst, dann nach Kunde und Anlage. */
export function boxZeilen(data: Pick<EdgeUpdates, 'fleet'>, now: Date): BoxZeile[] {
  return data.fleet.map((r) => boxZeile(r, now)).sort((a, b) => {
    if (a.brauchtDich !== b.brauchtDich) return a.brauchtDich ? -1 : 1;
    const t = a.ort.localeCompare(b.ort, 'de');
    return t !== 0 ? t : a.name.localeCompare(b.name, 'de');
  });
}

// ── Filter der Box-Liste ────────────────────────────────────────────────────

export type LinienFilter = 'alle' | BoxArt | 'unbekannt';
export type StatusFilter = 'braucht' | 'aelter' | 'offline' | 'lauf';
export interface BoxFilter { linie: LinienFilter; status: StatusFilter | null; suche: string }
export const KEIN_FILTER: BoxFilter = { linie: 'alle', status: null, suche: '' };

const passtLinie = (z: BoxZeile, l: LinienFilter) => l === 'alle' || (l === 'unbekannt' ? z.linie == null : z.linie === l);
const STATUS: Record<StatusFilter, { label: string; passt: (z: BoxZeile) => boolean }> = {
  braucht: { label: 'Braucht dich', passt: (z) => z.brauchtDich },
  aelter: { label: 'Älter', passt: (z) => z.aelter },
  offline: { label: 'Offline', passt: (z) => z.offline },
  lauf: { label: 'Update läuft', passt: (z) => z.laeuftUpdate },
};

export interface FilterZahlen {
  linien: { wert: LinienFilter; label: string; n: number }[];
  status: { wert: StatusFilter; label: string; n: number }[];
}

/**
 * Die Knöpfe der Filterleiste mit Zahl. Die Linien zählen über alle Boxen,
 * der Status innerhalb der gewählten Linie. „Box-Art unbekannt" und „Update
 * läuft" erscheinen nur, wenn es sie gibt - ein leerer Knopf wäre eine Sackgasse.
 */
export function filterZahlen(zeilen: BoxZeile[], linie: LinienFilter): FilterZahlen {
  const linien: FilterZahlen['linien'] = [
    { wert: 'alle', label: 'Alle', n: zeilen.length },
    ...LINIEN.map((l) => ({ wert: l as LinienFilter, label: BOX_ART_LABELS[l], n: zeilen.filter((z) => z.linie === l).length })),
  ];
  const unbekannt = zeilen.filter((z) => z.linie == null).length;
  if (unbekannt > 0) linien.push({ wert: 'unbekannt', label: BOX_ART_UNBEKANNT, n: unbekannt });
  const imBlick = zeilen.filter((z) => passtLinie(z, linie));
  const status = (Object.keys(STATUS) as StatusFilter[])
    .map((wert) => ({ wert, label: STATUS[wert].label, n: imBlick.filter(STATUS[wert].passt).length }))
    .filter((s) => s.wert !== 'lauf' || s.n > 0);
  return { linien, status };
}

export function filterBoxen(zeilen: BoxZeile[], f: BoxFilter): BoxZeile[] {
  const q = f.suche.trim().toLocaleLowerCase('de');
  return zeilen.filter((z) => passtLinie(z, f.linie)
    && (f.status == null || STATUS[f.status].passt(z))
    && (!q || z.suchtext.includes(q)));
}

/** Gruppen der Liste: je Linie, dann die Boxen unbekannter Art. Leere Gruppen fallen weg. */
export function gruppen(zeilen: BoxZeile[]): { linie: BoxArt | null; titel: string; zeilen: BoxZeile[] }[] {
  const out: { linie: BoxArt | null; titel: string; zeilen: BoxZeile[] }[] = [];
  for (const l of [...LINIEN, null] as (BoxArt | null)[]) {
    const z = zeilen.filter((x) => x.linie === l);
    if (z.length) out.push({ linie: l, titel: l ? BOX_ART_LABELS[l] : BOX_ART_UNBEKANNT, zeilen: z });
  }
  return out;
}

// ── Linien-Karten ───────────────────────────────────────────────────────────

export interface Segment { art: SegmentArt; n: number; wort: string }
export interface Plattform { text: string; ton: 'normal' | 'fertig' | 'fehlt' }
export interface LeiterSprosse {
  version: string;
  releaseSeq: number | null;
  neuestes: boolean;
  wer: string;
  deviceIds: string[];
}

export type LinienAktion = 'verteilen' | 'fortschritt' | 'weiter' | 'nachruesten' | 'aktuell' | 'nichts' | 'keins';

export interface LinieKarte {
  boxArt: BoxArt;
  name: string;
  icon: 'layers' | 'cpu';
  muster: Satz;
  gesamt: number;
  neu: { release: EdgeUpdatesRelease; wann: string | null } | null;
  /** `null` = für dieses Release noch unbekannt (Release-Seite nicht geladen). */
  plattformen: Plattform[] | null;
  segmente: Segment[];
  leiter: LeiterSprosse[];
  /** Weitere Stände, die die Leiter nicht mehr zeigt. */
  leiterRest: number;
  releases: number;
  /** Boxen, denen das neueste Release angefragt werden kann und die es weder fahren noch schon angefragt haben. */
  verteilbar: number;
  /** Boxen mit Stufe 1 (nur von Hand), in Listen-Reihenfolge. */
  stufe1: string[];
  aktion: LinienAktion;
  /** Warum nicht verteilt werden kann (bei `nichts`); sichtbar neben dem gesperrten Knopf. */
  sperre: string | null;
  /** Der Lauf dieser Linie (G6): die jüngste Anfrage, solange sie offen ist oder höchstens einen Tag zurückliegt. */
  lauf: LaufInDerKarte | null;
}

const ARCH_GERAET: Record<string, string> = { amd64: 'PC', arm64: 'Raspberry Pi', mipsle: 'Mango' };

/** „linux/arm64" → „Raspberry Pi · arm64". */
export function plattformText(arch: string): string {
  const a = arch.replace(/^linux\//, '');
  const g = ARCH_GERAET[a];
  return g ? `${g} · ${a}` : a;
}

/**
 * Für welche Geräte das neueste Release gebaut ist. Docker: das eine Bild für
 * PC und Raspberry Pi. Edge Light: je Programm im Manifest, mit ✓, wenn es
 * fertig im Portal liegt - fehlt es dort, kann die Box es nicht holen.
 */
export function plattformen(art: BoxArt, seite: EdgeReleaseSeite | null | undefined): Plattform[] | null {
  if (art === 'docker') return DOCKER_PLATTFORMEN.map((p) => ({ text: plattformText(p), ton: 'normal' }));
  if (!seite) return null;
  return seite.programme.map((p) => p.fertig
    ? { text: `${plattformText(p.arch)} ✓`, ton: 'fertig' }
    : { text: `${plattformText(p.arch)} · noch nicht im Portal`, ton: 'fehlt' });
}

const LEITER_MAX = 5;

const STAND_ZUSATZ: Partial<Record<SegmentArt, string>> = {
  lauf: 'Update läuft', halt: 'hält zurück', fehler: 'braucht dich', hand: 'Stufe 1', off: 'offline',
};

function standZusatz(rows: FleetRow[]): string | null {
  const arten = [...new Set(rows.map((r) => segmentArt(r.stand)))];
  if (arten.length !== 1) return null;
  const art = arten[0];
  if (art === 'fehler' && rows.every((r) => r.fakten?.bestaetigt.stand === 'zurueckgenommen')) return 'zurückgenommen';
  return STAND_ZUSATZ[art] ?? null;
}

function wer(rows: FleetRow[]): string {
  if (rows.length === 0) return 'noch keine Box';
  const zusatz = standZusatz(rows);
  const kopf = rows.length === 1 ? boxName(rows[0]) : `${rows.length} Boxen`;
  return zusatz ? `${kopf} · ${zusatz}` : kopf;
}

/** Hat die Box eine offene Anfrage genau für dieses Release? */
const fragtSchon = (r: FleetRow, release: EdgeUpdatesRelease) =>
  anfrageOffen(r.fakten) && r.fakten?.angefragt.releaseSeq === release.releaseSeq;

/**
 * Die Karten je Linie. Leer bleibt eine Linie nur, wenn sie weder ein Release
 * noch eine Box hat - dann fällt sie weg.
 */
export function linienKarten(
  data: Pick<EdgeUpdates, 'releases' | 'fleet' | 'lines'>,
  now: Date,
  seiten: Map<number, EdgeReleaseSeite> = new Map(),
): LinieKarte[] {
  const releases = [...data.releases].sort((a, b) => b.releaseSeq - a.releaseSeq);
  return LINIEN.flatMap((art): LinieKarte[] => {
    const line = data.lines?.find((l) => l.boxArt === art) ?? null;
    const neuRelease = line
      ? (line.newestReleaseSeq == null ? null : releases.find((r) => r.releaseSeq === line.newestReleaseSeq) ?? null)
      : releases.find((r) => releaseBoxArt(r) === art) ?? null;
    const rows = data.fleet.filter((r) => linieDerBox(r) === art);
    if (!neuRelease && rows.length === 0) return [];

    const zaehlung = new Map<SegmentArt, FleetRow[]>();
    for (const r of rows) {
      const a = segmentArt(r.stand);
      zaehlung.set(a, [...(zaehlung.get(a) ?? []), r]);
    }
    const segmente = SEGMENT_REIHE.filter((a) => zaehlung.has(a)).map((a) => {
      const rs = zaehlung.get(a)!;
      let wort = SEGMENT_WORT[a];
      if (a === 'fehler' && rs.every((r) => r.fakten?.bestaetigt.stand === 'zurueckgenommen')) wort = 'zurückgenommen';
      if (a === 'off' && rs.every((r) => anfrageOffen(r.fakten))) wort = 'offline · Update wartet';
      return { art: a, n: rs.length, wort };
    });

    // Die Versionsleiter: aus der API, sonst aus den Boxen (registriert neueste zuerst).
    const byId = new Map(rows.map((r) => [r.deviceId, r]));
    const sprossen: { version: string; releaseSeq: number | null; rows: FleetRow[] }[] = line?.versions
      ? line.versions.map((v) => ({
        version: v.version, releaseSeq: v.releaseSeq,
        rows: v.devices.map((id) => byId.get(id)).filter((r): r is FleetRow => !!r),
      }))
      : (() => {
        const m = new Map<string, { version: string; releaseSeq: number | null; rows: FleetRow[] }>();
        for (const r of rows) {
          if (!r.ist) continue;
          const rel = releases.find((x) => releaseIsRunning(x.version, r.ist!));
          const key = rel?.version ?? r.ist;
          const e = m.get(key) ?? { version: key, releaseSeq: rel?.releaseSeq ?? null, rows: [] };
          e.rows.push(r);
          m.set(key, e);
        }
        return [...m.values()].sort((a, b) => (b.releaseSeq ?? -1) - (a.releaseSeq ?? -1));
      })();
    const leiterAlle = sprossen.map((s) => ({
      version: s.version,
      releaseSeq: s.releaseSeq,
      neuestes: !!neuRelease && s.releaseSeq === neuRelease.releaseSeq,
      wer: wer(s.rows),
      deviceIds: s.rows.map((r) => r.deviceId),
    }));

    // Nur ein SIGNIERTES Release ist verteilbar (das Tor am Release, nie am Zustand einer Box).
    const verteilbar = neuRelease && neuRelease.signed
      ? rows.filter((r) => releaseSperre(neuRelease, r.boxArt, r.trust, r.loader) == null
        && !(r.ist && releaseIsRunning(neuRelease.version, r.ist))
        && !fragtSchon(r, neuRelease)).length
      : 0;
    const stufe1 = rows.filter((r) => segmentArt(r.stand) === 'hand')
      .sort((a, b) => boxName(a).localeCompare(boxName(b), 'de')).map((r) => r.deviceId);
    const laeuft = zaehlung.get('lauf')?.length ?? 0;
    const alleAktuell = rows.every((r) => segmentArt(r.stand) === 'ok');
    const lauf = laufInDerKarte(rows, releases, now);
    const aktion: LinienAktion = !neuRelease ? 'keins'
      : laeuft > 0 ? 'fortschritt'
        // E1 A: nach der ersten Bestätigung trägt der Lauf selbst den Knopf „An die übrigen".
        : lauf?.weiter ? 'weiter'
        : verteilbar > 0 ? 'verteilen'
          : stufe1.length > 0 ? 'nachruesten'
            : alleAktuell ? 'aktuell' : 'nichts';
    const sperre = aktion !== 'nichts' ? null
      : neuRelease && !neuRelease.signed ? 'Nicht signiert – nicht verteilbar.'
        : 'Jede Box hat es schon, wartet auf ihre Anfrage oder nimmt keine Updates an.';
    const info = LINIE_INFO[art];
    return [{
      boxArt: art,
      name: info.name,
      icon: info.icon,
      muster: info.muster,
      // Dieselben Boxen wie im Balken (die Linie aus der API, sonst die Box-Art).
      gesamt: rows.length,
      neu: neuRelease ? { release: neuRelease, wann: wann(neuRelease.createdAt, now) } : null,
      plattformen: neuRelease ? plattformen(art, seiten.get(neuRelease.releaseSeq)) : null,
      segmente,
      leiter: leiterAlle.slice(0, LEITER_MAX),
      leiterRest: Math.max(0, leiterAlle.length - LEITER_MAX),
      releases: line?.releases ?? releases.filter((r) => releaseBoxArt(r) === art).length,
      verteilbar,
      stufe1,
      aktion,
      sperre,
      lauf,
    }];
  });
}

// ── Lauf in der Karte (G6) ──────────────────────────────────────────────────

export interface LaufInDerKarte {
  release: string;
  releaseSeq: number;
  /** Die Boxen dieser Anfrage. */
  deviceIds: string[];
  /** Seit wann (die früheste Anfrage), als Uhrzeit. */
  seit: string | null;
  /** Wer angefragt hat (die jüngste Anfrage). */
  von: string | null;
  angefragt: number;
  angenommen: number;
  bestaetigt: number;
  /** Abgelehnt, fehlgeschlagen, zurückgenommen oder verstummt. */
  gescheitert: number;
  /**
   * E1 A: Hat die Box (oder haben die Boxen) bestätigt und ist nichts
   * gescheitert, bietet die Karte „An die übrigen" an - die Boxen der Linie,
   * die das Release noch nicht haben und es bekommen können. Ein neuer
   * Ein-Schritt-Lauf; im Server wartet nichts.
   */
  weiter: { text: Satz; uebrige: string[] } | null;
}

/** Der jüngste Zeitpunkt einer Anfrage: angefragt, angenommen oder bestätigt. */
function letzteRegung(f: UpdateFakten): number | null {
  const t = [f.angefragt.am, f.angenommen.am, f.bestaetigt.am]
    .map((x) => (x ? Date.parse(x) : Number.NaN)).filter((x) => Number.isFinite(x));
  return t.length ? Math.max(...t) : null;
}

/** Zählt eine Anfrage noch zum Lauf? Offen immer; beendet noch einen Tag lang. */
export function imLauf(f: UpdateFakten | null | undefined, now: Date): boolean {
  if (!f) return false;
  if (anfrageOffen(f)) return true;
  const t = letzteRegung(f);
  return t != null && now.getTime() - t < TRACKER_NACH_BESTAETIGT_MS;
}

const gescheitert = (f: UpdateFakten) => f.angenommen.stand === 'abgelehnt' || ENDE_FEHLER.includes(f.bestaetigt.stand);

const boxWort = (n: number) => (n === 1 ? 'Box' : 'Boxen');

/**
 * Der Lauf einer Linie: die Boxen mit der jüngsten noch laufenden (oder seit
 * höchstens einem Tag beendeten) Anfrage, gezählt in den drei Schritten. Die
 * Fakten sind die heutige Anfrage je Box - ein älterer Auftrag kann nie als
 * Live-Zustand eines neueren erscheinen.
 */
export function laufInDerKarte(rows: FleetRow[], releases: EdgeUpdatesRelease[], now: Date): LaufInDerKarte | null {
  const laufend = rows.filter((r) => imLauf(r.fakten, now));
  if (laufend.length === 0) return null;
  const zeit = (r: FleetRow) => (r.fakten?.angefragt.am ? Date.parse(r.fakten.angefragt.am) : 0);
  const juengste = [...laufend].sort((a, b) => zeit(b) - zeit(a))[0];
  const seq = juengste.fakten!.angefragt.releaseSeq;
  const gruppe = laufend.filter((r) => r.fakten!.angefragt.releaseSeq === seq);
  const f = (r: FleetRow) => r.fakten!;
  const frueheste = Math.min(...gruppe.map(zeit).filter((t) => t > 0));
  const bestaetigt = gruppe.filter((r) => f(r).bestaetigt.stand === 'ja');
  const zahl = {
    angefragt: gruppe.length,
    angenommen: gruppe.filter((r) => f(r).angenommen.stand === 'ja').length,
    bestaetigt: bestaetigt.length,
    gescheitert: gruppe.filter((r) => gescheitert(f(r))).length,
  };
  const release = releases.find((x) => x.releaseSeq === seq) ?? null;
  let weiter: LaufInDerKarte['weiter'] = null;
  if (release && release.signed && zahl.bestaetigt > 0 && zahl.gescheitert === 0
    && gruppe.every((r) => !anfrageOffen(r.fakten))) {
    const inGruppe = new Set(gruppe.map((r) => r.deviceId));
    const uebrige = rows.filter((r) => !inGruppe.has(r.deviceId)
      && releaseSperre(release, r.boxArt, r.trust, r.loader) == null
      && !(r.ist && releaseIsRunning(release.version, r.ist))
      && !anfrageOffen(r.fakten))
      .sort((a, b) => boxName(a).localeCompare(boxName(b), 'de'));
    if (uebrige.length > 0) {
      const wer = bestaetigt.length === 1
        ? `${boxName(bestaetigt[0])} hat bestätigt${uhr(f(bestaetigt[0]).bestaetigt.am, now) ? ` (${uhr(f(bestaetigt[0]).bestaetigt.am, now)})` : ''}.`
        : `${bestaetigt.length} Boxen haben bestätigt.`;
      const staende = [...new Set(uebrige.map((r) => istText(r)))];
      const k = uebrige.length;
      const rest: Satz = staende.length === 1 && staende[0]
        ? [` ${k} ${boxWort(k)} ${k === 1 ? 'läuft' : 'laufen'} noch auf `, { mono: staende[0] }, '.']
        : [` ${k} ${boxWort(k)} ${k === 1 ? 'hat' : 'haben'} es noch nicht.`];
      weiter = { text: [wer, ...rest], uebrige: uebrige.map((r) => r.deviceId) };
    }
  }
  const von = f(juengste).angefragt.von;
  return {
    release: f(juengste).angefragt.release,
    releaseSeq: seq,
    deviceIds: gruppe.map((r) => r.deviceId),
    seit: Number.isFinite(frueheste) ? uhr(new Date(frueheste).toISOString(), now) : null,
    von: von ? actorLabel(von) : null,
    ...zahl,
    weiter,
  };
}

// ── Verteil-Dialog (G6) ─────────────────────────────────────────────────────

export type VerteilGruppeId = 'bereit' | 'wartet' | 'angefragt' | 'aktuell' | 'kann_nicht';
export interface VerteilBox {
  deviceId: string;
  name: string;
  text: string;
  /** Nur „bereit" und „wartet" lassen sich anfragen. */
  waehlbar: boolean;
  /** Stufe 1: der Weg ist Nachrüsten, nicht dieses Release. */
  nachruesten: boolean;
}
export interface VerteilGruppe { id: VerteilGruppeId; titel: string; boxen: VerteilBox[] }

const VERTEIL_GRUPPEN: { id: VerteilGruppeId; titel: string }[] = [
  { id: 'bereit', titel: 'Bereit' },
  { id: 'wartet', titel: 'Wartet, bis sie online ist' },
  { id: 'angefragt', titel: 'Schon angefragt' },
  { id: 'aktuell', titel: 'Schon aktuell' },
  { id: 'kann_nicht', titel: 'Kann nicht' },
];

/**
 * Die Boxen des Dialogs in GENAU einer Gruppe - aus der Eignung des Servers
 * (G1), ergänzt um „schon angefragt": eine Box mit offener Anfrage für genau
 * dieses Release bekäme nur dieselbe Anfrage noch einmal. Ein Wort, das dieser
 * Portal-Stand nicht kennt, landet unter „kann nicht" - nie still „bereit".
 */
export function verteilGruppen(e: EdgeEignung, fleet: FleetRow[], now: Date): VerteilGruppe[] {
  const byId = new Map(fleet.map((r) => [r.deviceId, r]));
  const sammel = new Map<VerteilGruppeId, VerteilBox[]>(VERTEIL_GRUPPEN.map((g) => [g.id, []]));
  for (const b of e.boxen) {
    const row = byId.get(b.deviceId);
    const name = b.siteName?.trim() || b.label || b.externalRef;
    const laeuft = row ? istText(row) : (versionDisplay(b.ist)?.tag ?? b.ist);
    const gemeldet = b.gruppe as string;
    let id: VerteilGruppeId = gemeldet === 'bereit' || gemeldet === 'wartet' || gemeldet === 'aktuell' ? gemeldet : 'kann_nicht';
    const f = row?.fakten ?? null;
    if ((id === 'bereit' || id === 'wartet') && anfrageOffen(f) && f!.angefragt.releaseSeq === e.releaseSeq) id = 'angefragt';
    let text: string;
    if (id === 'bereit') {
      text = ['online', row?.geraetModell ?? null, laeuft ? `läuft ${laeuft}` : 'meldet keine Version'].filter(Boolean).join(' · ');
    } else if (id === 'wartet') {
      const seit = seitDauer(b.lastSeenAt, now);
      text = `${seit ? `offline ${seit}` : 'noch nie gemeldet'} · bekommt die Anfrage, sobald sie sich meldet`;
    } else if (id === 'angefragt') {
      const um = uhr(f!.angefragt.am, now);
      text = `angefragt${um ? ` ${um}` : ''} · die Anfrage läuft schon`;
    } else if (id === 'aktuell') {
      text = laeuft ? `läuft ${laeuft}` : 'läuft dieses Release';
    } else {
      text = b.grund ?? 'Die Box kann dieses Release nicht bekommen.';
    }
    sammel.get(id)!.push({
      deviceId: b.deviceId, name, text, waehlbar: id === 'bereit' || id === 'wartet',
      nachruesten: id === 'kann_nicht' && (row?.stand === 'hand' || row?.stufe1 === true),
    });
  }
  return VERTEIL_GRUPPEN
    .map((g) => ({ ...g, boxen: sammel.get(g.id)!.sort((a, b) => a.name.localeCompare(b.name, 'de')) }))
    .filter((g) => g.boxen.length > 0);
}

/** Vorausgewählt: jede wählbare Box - oder nur die genannten (für „An die übrigen"). */
export function vorauswahl(gruppen: VerteilGruppe[], nur?: string[] | null): string[] {
  const waehlbar = gruppen.flatMap((g) => g.boxen).filter((b) => b.waehlbar).map((b) => b.deviceId);
  return nur ? waehlbar.filter((id) => nur.includes(id)) : waehlbar;
}

/** Die erste Box bei „Erst eine Box": eine bereite (online) vor einer wartenden, in Listen-Reihenfolge. */
export function ersteBox(gruppen: VerteilGruppe[], auswahl: string[]): string | null {
  for (const id of ['bereit', 'wartet'] as VerteilGruppeId[]) {
    const b = gruppen.find((g) => g.id === id)?.boxen.find((x) => auswahl.includes(x.deviceId));
    if (b) return b.deviceId;
  }
  return null;
}

/** Die Boxen, die der Knopf anfragt, in Listen-Reihenfolge (bereit vor wartet). */
export function anzufragen(gruppen: VerteilGruppe[], auswahl: string[], reihenfolge: 'eine' | 'alle', erste: string | null): string[] {
  const reihe = gruppen.flatMap((g) => g.boxen).filter((b) => b.waehlbar && auswahl.includes(b.deviceId)).map((b) => b.deviceId);
  if (reihenfolge === 'eine' && reihe.length > 1) return erste && reihe.includes(erste) ? [erste] : reihe.slice(0, 1);
  return reihe;
}

// ── Braucht dich ────────────────────────────────────────────────────────────

export type AufgabeTon = 'fehler' | 'halt' | 'warn' | 'hand';
export type AufgabeKnopf = 'box' | 'fernwartung' | 'nachruesten' | 'nochmal' | 'zurueckziehen';
export interface Aufgabe {
  id: string;
  ton: AufgabeTon;
  icon: 'alert-triangle' | 'wifi' | 'hand';
  titel: string;
  text: Satz;
  /** Die Boxen der Aufgabe; „Box ansehen"/„Nachrüsten" wirken auf die erste. */
  deviceIds: string[];
  knoepfe: AufgabeKnopf[];
  /** „Anfrage zurückziehen": die Boxen der Aufgabe, die eine Anfrage tragen. */
  anfragen: string[];
  /** „Noch einmal anfragen": dasselbe Release als NEUE Anfrage (neuer `assigned_at`, die Box versucht es wieder). */
  nochmal: { deviceId: string; releaseSeq: number } | null;
}

function fehlerAufgabe(r: FleetRow, now: Date): Aufgabe {
  const name = boxName(r);
  const f = r.fakten ?? null;
  const rel = f?.angefragt.release ?? r.soll ?? null;
  const ist = istText(r);
  const grund = f?.bestaetigt.grund ?? r.reason ?? null;
  let titel = `${name}: Update fehlgeschlagen`;
  let text: Satz;
  if (f?.bestaetigt.stand === 'zurueckgenommen' || r.state === 'zurueckgerollt') {
    titel = `${name}: Update zurückgenommen`;
    text = [
      'Die Box hat ', ...(rel ? [{ mono: rel }] : ['das Update']),
      ` angenommen, der Selbsttest wurde nicht grün${grund ? ` (${grund})` : ''}.`,
      ...(ist ? [' Sie läuft wieder auf ', { mono: ist }, ' und versucht es nicht von selbst noch einmal.']
        : [' Sie versucht es nicht von selbst noch einmal.']),
    ];
  } else if (f?.bestaetigt.stand === 'verstummt' || r.state === 'im_update_verstummt') {
    titel = `${name}: im Update verstummt`;
    const zuletzt = uhr(r.lastSeenAt ?? r.reportedAt, now);
    text = [
      'Die Box hat sich mitten im Update', ...(rel ? [' auf ', { mono: rel }] : []),
      ` nicht mehr gemeldet${zuletzt ? ` (zuletzt ${zuletzt})` : ''}.`,
    ];
  } else {
    text = [
      ...(rel ? ['Die Anfrage ', { mono: rel }, ' ist fehlgeschlagen'] : ['Das Update ist fehlgeschlagen']),
      `${grund ? `: ${grund}` : ''}.`,
      ...(ist ? [' Die Box läuft auf ', { mono: ist }, '.'] : []),
    ];
  }
  // Von selbst versucht die Box es nicht noch einmal; eine neue Anfrage (neuer
  // `assigned_at`) löst ihren Merkzettel - auch für dasselbe Release.
  const nochmal = f ? { deviceId: r.deviceId, releaseSeq: f.angefragt.releaseSeq } : null;
  return {
    id: `fehler-${r.deviceId}`, ton: 'fehler', icon: 'alert-triangle', titel, text, deviceIds: [r.deviceId],
    knoepfe: nochmal ? ['box', 'nochmal'] : ['box'], anfragen: [], nochmal,
  };
}

function haltAufgabe(r: FleetRow): Aufgabe {
  const lever = blockerLever(r.blocker);
  return {
    id: `halt-${r.deviceId}`, ton: 'halt', icon: 'alert-triangle',
    titel: `${boxName(r)}: hält das Update zurück`,
    text: [r.reason ?? 'Die Box nennt keinen Grund.', ...(lever ? [` ${lever}`] : [])],
    deviceIds: [r.deviceId], knoepfe: ['box'], anfragen: [], nochmal: null,
  };
}

function offlineAufgabe(r: FleetRow, now: Date): Aufgabe {
  const seit = seitDauer(r.lastSeenAt ?? null, now);
  const zuletzt = uhr(r.lastSeenAt ?? null, now);
  return {
    id: `offline-${r.deviceId}`, ton: 'warn', icon: 'wifi',
    titel: `${boxName(r)} ist ${seit ?? 'gerade'} offline`,
    text: [
      ...(zuletzt ? [`Letzte Meldung ${zuletzt}. `] : []),
      'Angefragt ist ', { mono: r.fakten!.angefragt.release },
      '; die Box holt es, sobald sie sich wieder meldet. Für das Update ist nichts zu tun.',
    ],
    deviceIds: [r.deviceId], knoepfe: ['fernwartung', 'zurueckziehen'], anfragen: [r.deviceId], nochmal: null,
  };
}

function handAufgabe(rows: FleetRow[]): Aufgabe {
  const namen = rows.map(boxName);
  const titel = namen.length <= 2
    ? `${namen.join(' und ')}: nur von Hand (Stufe 1)`
    : `${namen.length} Edge-Light-Boxen: nur von Hand (Stufe 1)`;
  // Der Grund je Box (Loader vor Vertrauen, wie `BoxArt.sperrgrund`); „Ihr" passt für eine Box wie für mehrere.
  const flash = rows.filter((r) => r.loader === LOADER_FLASH).length;
  const grund = flash === rows.length
    ? 'Ihr Startprogramm startet immer die Fassung aus dem Flash.'
    : flash === 0
      ? `${rows.length === 1 ? 'Ihr' : 'Ihnen'} fehlt das geprüfte Vertrauens-Set.`
      : 'Ihr Startprogramm oder ihr Vertrauens-Set lässt keine Updates aus dem Portal zu.';
  const text: Satz = [
    grund,
    ' Einmal nachrüsten (ca. 1 Min. Unterbrechung), danach kommt jede Fassung über das Portal.',
  ];
  for (const r of rows) {
    const f = r.fakten;
    if (f?.angenommen.stand === 'abgelehnt') {
      text.push(' Die Anfrage ', { mono: kurzeVersion(f.angefragt.release) },
        ` an ${boxName(r)} hat die Box abgelehnt${f.angenommen.grund ? `: ${f.angenommen.grund}` : ''}.`);
    }
  }
  // Eine Anfrage an eine Box mit Stufe 1 kann sie nie annehmen: zurückziehen räumt sie ab.
  const anfragen = rows.filter((r) => !!r.fakten).map((r) => r.deviceId);
  return {
    id: `hand-${rows.map((r) => r.deviceId).join('-')}`, ton: 'hand', icon: 'hand', titel, text,
    deviceIds: rows.map((r) => r.deviceId), knoepfe: anfragen.length ? ['nachruesten', 'zurueckziehen'] : ['nachruesten'],
    anfragen, nochmal: null,
  };
}

/** Was den Betreiber braucht, nach Dringlichkeit: Fehler, Zurückhalten, wartende Anfrage offline, Stufe 1. */
export function aufgaben(data: Pick<EdgeUpdates, 'fleet'>, now: Date): Aufgabe[] {
  const nachName = (a: FleetRow, b: FleetRow) => boxName(a).localeCompare(boxName(b), 'de');
  const rows = [...data.fleet].sort(nachName);
  const out: Aufgabe[] = [];
  for (const r of rows) if (segmentArt(r.stand) === 'fehler') out.push(fehlerAufgabe(r, now));
  for (const r of rows) if (segmentArt(r.stand) === 'halt') out.push(haltAufgabe(r));
  for (const r of rows) {
    if (verbindungSicht(r, now).zustand === 'offline' && anfrageOffen(r.fakten) && segmentArt(r.stand) === 'off') {
      out.push(offlineAufgabe(r, now));
    }
  }
  const hand = rows.filter((r) => segmentArt(r.stand) === 'hand');
  if (hand.length) out.push(handAufgabe(hand));
  return out;
}

// ── Lage ────────────────────────────────────────────────────────────────────

export type LageTon = 'ok' | 'lauf' | 'warn' | 'hand' | 'info';
export type LageZiel = 'braucht' | 'fortschritt' | 'aelter';
export interface Lage {
  ton: LageTon;
  icon: 'check' | 'refresh-cw' | 'alert-triangle' | 'wifi' | 'hand' | 'info';
  text: Satz;
  link: { label: string; ziel: LageZiel } | null;
}

const boxen = (n: number) => `${n} ${n === 1 ? 'Box' : 'Boxen'}`;

/** Ein Satz für die ganze Seite: das Dringendste zuerst, sonst wie die Flotte steht. */
export function lage(data: Pick<EdgeUpdates, 'fleet'>, now: Date): Lage {
  const rows = data.fleet;
  if (rows.length === 0) return { ton: 'info', icon: 'info', text: ['Noch keine Box registriert.'], link: null };
  const nach = (a: SegmentArt) => rows.filter((r) => segmentArt(r.stand) === a);
  const ansehen = { label: 'Ansehen', ziel: 'braucht' as const };

  const fehler = nach('fehler');
  if (fehler.length === 1) {
    const r = fehler[0];
    const was = r.fakten?.bestaetigt.stand === 'zurueckgenommen' || r.state === 'zurueckgerollt'
      ? 'hat das Update zurückgenommen'
      : r.fakten?.bestaetigt.stand === 'verstummt' || r.state === 'im_update_verstummt'
        ? 'ist im Update verstummt' : 'meldet ein fehlgeschlagenes Update';
    return { ton: 'warn', icon: 'alert-triangle', text: [`1 Box braucht dich: ${boxName(r)} ${was}.`], link: ansehen };
  }
  if (fehler.length > 1) {
    return { ton: 'warn', icon: 'alert-triangle', text: [`${fehler.length} Boxen brauchen dich: ihr Update hat nicht geklappt.`], link: ansehen };
  }
  const halt = nach('halt');
  if (halt.length) {
    return {
      ton: 'warn', icon: 'alert-triangle',
      text: [halt.length === 1 ? `1 Box hält ein Update zurück: ${boxName(halt[0])}.` : `${halt.length} Boxen halten ein Update zurück.`],
      link: ansehen,
    };
  }
  const wartet = rows.filter((r) => segmentArt(r.stand) === 'off' && anfrageOffen(r.fakten));
  if (wartet.length === 1) {
    const seit = seitDauer(wartet[0].lastSeenAt ?? null, now);
    return { ton: 'warn', icon: 'wifi', text: [`1 Box ist ${seit ?? 'gerade'} offline. Ihr Update wartet.`], link: ansehen };
  }
  if (wartet.length > 1) {
    return { ton: 'warn', icon: 'wifi', text: [`${wartet.length} Boxen sind offline. Ihre Updates warten.`], link: ansehen };
  }
  const lauf = nach('lauf');
  if (lauf.length) {
    const releases = [...new Set(lauf.map((r) => r.fakten?.angefragt.release).filter((v): v is string => !!v))];
    if (releases.length === 1) {
      const rel = releases[0];
      const angefragt = rows.filter((r) => r.fakten?.angefragt.release === rel);
      const bestaetigt = angefragt.filter((r) => r.fakten?.bestaetigt.stand === 'ja').length;
      const art = linieDerBox(lauf[0]);
      const wer = art === 'light' ? (angefragt.length === 1 ? 'Edge-Light-Box' : 'Edge-Light-Boxen')
        : art === 'docker' ? (angefragt.length === 1 ? 'Docker-Box' : 'Docker-Boxen')
          : (angefragt.length === 1 ? 'Box' : 'Boxen');
      return {
        ton: 'lauf', icon: 'refresh-cw',
        text: ['Ein Update läuft: ', { mono: rel }, ` an ${angefragt.length} ${wer} · ${bestaetigt} bestätigt.`],
        link: { label: 'Fortschritt', ziel: 'fortschritt' },
      };
    }
    return {
      ton: 'lauf', icon: 'refresh-cw',
      text: [`Bei ${boxen(lauf.length)} läuft gerade ein Update.`],
      link: { label: 'Fortschritt', ziel: 'fortschritt' },
    };
  }
  const hand = nach('hand');
  if (hand.length) {
    return {
      ton: 'hand', icon: 'hand',
      text: [hand.length === 1
        ? '1 Edge-Light-Box nimmt keine Updates aus dem Portal an (Stufe 1).'
        : `${hand.length} Edge-Light-Boxen nehmen keine Updates aus dem Portal an (Stufe 1).`],
      link: ansehen,
    };
  }
  const aelter = rows.filter((r) => !!r.istRelease && r.releasesDahinter != null && r.releasesDahinter > 0);
  if (aelter.length) {
    return {
      ton: 'info', icon: 'info',
      text: [aelter.length === 1
        ? '1 Box läuft auf einem älteren Release ihrer Linie.'
        : `${aelter.length} Boxen laufen auf einem älteren Release ihrer Linie.`],
      link: { label: 'Ansehen', ziel: 'aelter' },
    };
  }
  const aktuell = nach('ok').length;
  if (aktuell === rows.length) {
    return {
      ton: 'ok', icon: 'check',
      text: [rows.length === 1 ? 'Die Box läuft auf dem neuesten Release ihrer Linie.'
        : `Alle ${rows.length} Boxen laufen auf dem neuesten Release ihrer Linie.`],
      link: null,
    };
  }
  return {
    ton: 'info', icon: 'info',
    text: [`${aktuell} von ${boxen(rows.length)} laufen auf dem neuesten Release ihrer Linie; die übrigen haben keinen bewertbaren Stand.`],
    link: null,
  };
}

// ── Box-Seite und Release-Seite (G7) ────────────────────────────────────────

export type VerlaufTon = 'ok' | 'lauf' | 'fehler' | 'leer';
export interface VerlaufZeile { wann: string; ton: VerlaufTon; titel: Satz; text: string | null }

/**
 * Ein gemeldeter Stempel als Release-Name: „edge-2026.10.7-c39b18d9c2a4" →
 * „edge-2026.10.7". Ein Stempel ohne Release-Form (Build von Hand) bleibt, wie
 * die Box ihn meldet.
 */
function standText(stamp: string | null): string | null {
  if (!stamp) return null;
  const m = /^(edge(?:-light)?-\d{4}\.\d{2}\.\d+)-[0-9a-f]{12}$/.exec(stamp.trim());
  return m ? m[1] : versionDisplay(stamp)?.tag ?? stamp;
}

/**
 * Hat das Portal diesen Stand angefragt, seit die Box zuletzt gewechselt hat?
 * `aelter` sind die Einträge NACH dem Stand in der Liste (neueste zuerst), bis
 * zum vorigen Wechsel. Nur dann heißt der Wechsel „bestätigt" - ein Stand von
 * Hand (Wartungstunnel, Werkstatt) ist keine Bestätigung einer Anfrage.
 */
function warAngefragt(aelter: VerlaufEintrag[], stamp: string | null): boolean {
  if (!stamp) return false;
  for (const e of aelter) {
    if (e.quelle === 'box' && e.art === 'stand') return false;
    if (e.quelle === 'portal' && e.art === 'angefragt' && e.release && releaseIsRunning(e.release, stamp)) return true;
  }
  return false;
}

/** Der Verlauf einer Box in Worten - was das Portal tat und was die Box meldete. */
export function verlaufSicht(eintraege: VerlaufEintrag[], now: Date): VerlaufZeile[] {
  return eintraege.map((e, i): VerlaufZeile => {
    const wann = uhr(e.am, now) ?? '–';
    const von = e.von ? `von ${actorLabel(e.von)}` : null;
    const rel: Satz = e.release ? [{ mono: e.release }] : [];
    const grund = e.grund ? `: ${e.grund}` : '';
    if (e.quelle === 'portal') {
      switch (e.art) {
        case 'angefragt': return { wann, ton: 'leer', titel: ['angefragt', ...(rel.length ? [': ', ...rel] : [])], text: von };
        case 'zurueckgezogen': return { wann, ton: 'leer', titel: ['Anfrage zurückgezogen', ...(rel.length ? [': ', ...rel] : [])], text: von };
        case 'erneut_gesendet': return { wann, ton: 'leer', titel: ['Anfrage erneut gesendet', ...(rel.length ? [': ', ...rel] : [])], text: von };
        case 'entfernt': return { wann, ton: 'leer', titel: ['Aus der Verteilung entfernt'], text: von };
        default: return { wann, ton: 'leer', titel: [e.art], text: von };
      }
    }
    switch (e.art) {
      case 'stand': {
        const neu = standText(e.release);
        if (!e.vorher) return { wann, ton: 'ok', titel: ['erste Meldung', ...(neu ? [': ', { mono: neu }] : [])], text: null };
        const text = `vorher ${standText(e.vorher)}`;
        return warAngefragt(eintraege.slice(i + 1), e.release)
          ? { wann, ton: 'ok', titel: [{ mono: neu ?? '' }, ' bestätigt'], text }
          : { wann, ton: 'ok', titel: ['läuft jetzt ', { mono: neu ?? '' }], text };
      }
      case 'angenommen':
        return { wann, ton: 'lauf', titel: ['angenommen', ...(rel.length ? [': ', ...rel] : [])], text: 'Die Box hat das Release geprüft und übernimmt es.' };
      case 'abgelehnt': return { wann, ton: 'fehler', titel: [`abgelehnt${grund}`], text: e.release ? `Anfrage ${e.release}` : null };
      case 'zurueckgestellt': return { wann, ton: 'leer', titel: [`zurückgestellt${grund}`], text: e.release ? `Anfrage ${e.release}` : null };
      case 'fehlgeschlagen': return { wann, ton: 'fehler', titel: [`fehlgeschlagen${grund}`], text: e.release ? `Anfrage ${e.release}` : null };
      case 'zurueckgenommen': return { wann, ton: 'fehler', titel: [`zurückgenommen${grund}`], text: e.release ? `Anfrage ${e.release}` : null };
      default: return { wann, ton: 'leer', titel: [e.art], text: null };
    }
  });
}

/** Die jüngste Bestätigung im Verlauf: ein Stand, den das Portal vorher angefragt hatte. */
export function zuletztBestaetigt(eintraege: VerlaufEintrag[]): { release: string; am: string } | null {
  for (let i = 0; i < eintraege.length; i += 1) {
    const e = eintraege[i];
    if (e.quelle === 'box' && e.art === 'stand' && e.vorher && warAngefragt(eintraege.slice(i + 1), e.release)) {
      return { release: standText(e.release) ?? '', am: e.am };
    }
  }
  return null;
}

export interface Fakt { wer: string; wert: string; satz: string }

/**
 * Die drei Kästen der Box-Seite, nie vermischt: läuft (meldet die Box) ·
 * angefragt (Portal) · zuletzt bestätigt (Box). `eintraege` `null` = der Verlauf
 * ist noch nicht da; dann sagt der dritte Kasten das, statt „nie" zu behaupten.
 */
export function boxFakten(row: FleetRow, eintraege: VerlaufEintrag[] | null, now: Date): Fakt[] {
  const f = row.fakten ?? null;
  const laeuft = istText(row);
  const stempel = row.ist && laeuft && row.ist !== laeuft ? `Stempel ${row.ist}` : null;
  const gemeldet = row.lastSeenAt ? fmtRelative(row.lastSeenAt, now) : null;
  const angefragt: Fakt = f
    ? {
      wer: 'Angefragt · Portal', wert: f.angefragt.release,
      satz: [uhr(f.angefragt.am, now), f.angefragt.von ? `von ${actorLabel(f.angefragt.von)}` : null,
        f.angenommen.stand === 'abgelehnt' ? `Box lehnt ab${f.angenommen.grund ? `: ${f.angenommen.grund}` : ''}` : null]
        .filter(Boolean).join(' · '),
    }
    : { wer: 'Angefragt · Portal', wert: '–', satz: 'keine Anfrage' };
  let bestaetigt: Fakt;
  if (f && f.bestaetigt.stand === 'ja') {
    bestaetigt = { wer: 'Zuletzt bestätigt · Box', wert: f.angefragt.release, satz: uhr(f.bestaetigt.am, now) ?? 'bestätigt' };
  } else if (eintraege == null) {
    bestaetigt = { wer: 'Zuletzt bestätigt · Box', wert: '…', satz: 'Der Verlauf wird geladen.' };
  } else {
    const z = zuletztBestaetigt(eintraege);
    bestaetigt = z
      ? { wer: 'Zuletzt bestätigt · Box', wert: z.release, satz: uhr(z.am, now) ?? '' }
      : { wer: 'Zuletzt bestätigt · Box', wert: '–', satz: 'keine Bestätigung im Verlauf' };
  }
  return [
    { wer: 'Läuft · meldet die Box', wert: laeuft ?? '–', satz: [stempel, gemeldet].filter(Boolean).join(' · ') || 'nichts gemeldet' },
    angefragt,
    bestaetigt,
  ];
}

/** Die Box mit Stufe 1 in einem Satz und woran man das Ende des Nachrüstens erkennt. */
export function stufe1Hinweis(row: FleetRow): { grund: string; fertig: string } {
  return row.loader === LOADER_FLASH
    ? {
      grund: 'Ihr Startprogramm startet immer die Fassung aus dem Flash. Das ist kein Defekt.',
      fertig: 'Fertig, sobald die Box meldet, dass ihr Startprogramm Updates kennt und ihr Vertrauens-Set geprüft ist. Das Portal erkennt das selbst.',
    }
    : {
      grund: 'Ihr fehlt das geprüfte Vertrauens-Set. Das ist kein Defekt.',
      fertig: 'Fertig, sobald die Box ihr geprüftes Vertrauens-Set meldet. Das Portal erkennt das selbst.',
    };
}

/** „4,7 MB" - Größen zur Anzeige (dezimal, eine Stelle). */
export function mb(bytes: number): string {
  return `${(bytes / 1e6).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${NBSP}MB`;
}

export interface InhaltZeile { teil: Satz; geraet: string; groesse: string; portal: ZeilenBadge }

/**
 * Was ein Release enthält, je Teil: Docker die Bilder (für PC und Raspberry Pi
 * aus der Registry), Edge Light je Programm mit Gerät, Größe und ob es fertig
 * geprüft im Portal liegt. Die letzte Zeile nennt, was NIE über das Portal
 * kommt (Board Abschnitt 6).
 */
export function releaseInhalt(seite: EdgeReleaseSeite): InhaltZeile[] {
  const art = releaseBoxArt({ boxArt: seite.boxArt === 'light' ? 'light' : 'docker' });
  const zeilen: InhaltZeile[] = seite.inhalt.map((t): InhaltZeile => {
    if (art === 'docker' || !t.arch) {
      return { teil: ['Bild ', { mono: t.name }], geraet: 'PC und Raspberry Pi', groesse: '–', portal: { ton: 'off', text: 'aus der Registry' } };
    }
    const prog = seite.programme.find((x) => x.arch === t.arch) ?? null;
    const portal: ZeilenBadge = !prog ? { ton: 'warn', text: 'fehlt im Portal' }
      : prog.fertig ? { ton: 'ok', text: 'geprüft' }
        : { ton: 'warn', text: `${Math.floor((prog.empfangen * 100) / Math.max(1, prog.groesse))} % empfangen` };
    const a = t.arch.replace(/^linux\//, '');
    return {
      teil: [{ mono: t.name }, ` ${t.arch}`],
      geraet: ARCH_GERAET[a] ?? a,
      groesse: t.gzGroesse ? `${mb(t.gzGroesse)} gepackt` : t.groesse ? mb(t.groesse) : '–',
      portal,
    };
  });
  zeilen.push({
    teil: [art === 'light' ? 'Loader, Dienst, Tunnel-Skripte' : 'Updater und Betriebssystem'],
    geraet: '–', groesse: 'nicht im Update', portal: { ton: 'off', text: 'nur Werkstatt' },
  });
  return zeilen;
}

/** Die Verteilungen eines Releases als Verlauf: wann, an wie viele, wie viele bestätigt. */
export function verteiltSicht(seite: EdgeReleaseSeite, now: Date): VerlaufZeile[] {
  return [...seite.verteilt].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((v) => ({
    wann: uhr(v.createdAt, now) ?? '–',
    ton: v.failed > 0 ? 'fehler' : v.confirmed >= v.total && v.total > 0 ? 'ok' : 'lauf',
    titel: [`an ${boxWort(v.total) === 'Box' ? '1 Box' : `${v.total} Boxen`} angefragt · ${v.confirmed} bestätigt${v.failed ? ` · ${v.failed} gescheitert` : ''}`],
    text: v.createdBy ? `von ${actorLabel(v.createdBy)}` : null,
  }));
}
