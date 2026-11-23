import type { AdminDeviceRow, PendingEnrollment, ProvisionedDevice } from './admin/adminApi';
import { crossoverState } from './adminEdgeUpdates';
import { DASH, relAge, type BoxErreichbarkeit, type BoxVerbindung } from './adminFleet';
import { WARTET_ONLINE_WINDOW_MS, WARTET_NIE_ZUGEORDNET_ONLINE_WINDOW_MS } from './boxLebenszeichen';

/**
 * Die reine Schicht der Plattform-Seite **„Geräte"**: der Onboarding-Funnel
 * (Admin-Umbau Stufe 1, B3) und - seit der Konsolidierung P2 - das INVENTAR
 * über den ganzen Lebenszyklus.
 *
 * Ein Gerät nimmt VIER Stufen: **registriert** (die Aufkleber-ID steht in der
 * Manufacturing-Registry) → **wartet auf Zuordnung** (das Gerät hat sich
 * gemeldet und einen CSR hochgeladen, aber kein Claim passt dazu) →
 * **verbunden** (ein Kundenkonto hat es beansprucht) → **Vertrauen gekreuzt**
 * (erst der TOFU-Crossover macht die Box update-fähig).
 *
 * Die Seite zeigte bisher nur die erste und dritte Stufe. Die zweite ist das
 * Fenster, in dem sich das Gerät meldet, aber kein Claim dazu passt - sichtbar
 * war das auf keiner der beiden Seiten, obwohl der Endpunkt seit dem
 * Enrollment-Bau existiert. Dass ein Kunde dabei etwas falsch getippt hat, ist
 * NICHT die einzige Erklärung: eine Box kann sich auch selbst, ohne jeden
 * Kunden-Tastendruck, melden (vp-geraete-herkunft) - die Fläche behauptet
 * seither keine Ursache mehr, nur die Wartezeit. Die vierte wohnte als SPALTE
 * in der Flotten-Matrix der ANDEREN Seite, der Funnel hörte also eine Stufe zu
 * früh auf.
 *
 * Reine Ableitung: hier wird nur gezählt und formuliert, nie geraten. Was der
 * Server nicht liefert, behauptet dieses Modul auch nicht.
 */

/**
 * Ab dieser Wartezeit verdient ein meldendes Gerät ohne Claim besondere
 * Aufmerksamkeit (bernstein markiert). Bewusst großzügig: eine Einrichtung,
 * bei der Kunde und Techniker nicht am selben Tag arbeiten, ist normal —
 * erst danach lohnt der Anruf. Die Schwelle markiert nur „länger als normal",
 * NIE eine Vermutung über die Ursache (Firstmate vp-geraete-herkunft: die
 * Ursache war bisher ein erfundener „Tippfehler", obwohl kein Kunde je etwas
 * getippt haben muss — die Box kann sich auch nur selbst angemeldet haben).
 */
export const TYPO_SUSPECT_AFTER_MS = 24 * 60 * 60 * 1000;

export type FunnelStageId = 'registriert' | 'wartet' | 'verbunden' | 'vertrauen';

/** Eine Stufe des Funnels: Zahl + Wort, sonst nichts. */
export interface FunnelStage {
  id: FunnelStageId;
  label: string;
  count: number;
  /** Ein Satz, der die Zahl einordnet — nie eine Handlungsaufforderung ohne Grund. */
  note: string;
  /** True, sobald die Stufe Aufmerksamkeit verdient (nur „wartet" kann das). */
  attention: boolean;
}

/**
 * Die VIER Stufen aus dem, was die Seite ohnehin lädt. `pending` ist
 * mandantenlos (ein Enrollment kennt keinen Mandanten), `registry` ist die
 * Aufkleber-Registry, `fleet` das Geräte-Inventar.
 *
 * **Die vierte Stufe „Vertrauen gekreuzt" schließt den Funnel** (UX-Konzept §3
 * Befund C): „verbunden" ist nicht das Onboarding-ENDE - erst der TOFU-
 * Crossover macht eine Box update-fähig. Diese Information existierte schon,
 * wohnte aber als SPALTE in der Flotten-Matrix der ANDEREN Seite; der Funnel
 * hörte damit eine Stufe zu früh auf.
 *
 * **Gezählt wird nur, was belegt ist:** ein Gerät, das seinen Vertrauensanker
 * gar nicht meldet, ist „unbekannt" und geht weder in den Zähler noch in die
 * offene Zahl ein - `crossoverState` ist dieselbe Ableitung, die auch die
 * Geräte-Zeile rendert.
 *
 * `verbunden` zählt seit dem Umbau die ECHTE Flotte, nicht mehr nur die
 * beanspruchten Aufkleber-IDs: die Bestandsboxen verbinden sich über selbst
 * generierte `edge-`Referenzen und kamen in dieser Zahl gar nicht vor.
 */
export function funnelStages(
  registry: ProvisionedDevice[],
  pending: PendingEnrollment[],
  fleet: AdminDeviceRow[] = [],
): FunnelStage[] {
  const registered = registry.length;
  const waiting = pending.length;
  const connectedRows = fleet.filter((d) => d.deviceId != null);
  // Ohne Inventar (älteres Backend) bleibt die alte Quelle gültig - dann zählt
  // die Stufe eben nur die beanspruchten Aufkleber, statt zu schweigen.
  const connected = fleet.length > 0
    ? connectedRows.length
    : registry.filter((d) => d.claimed).length;
  let crossed = 0;
  let open = 0;
  let vonHand = 0;
  let vonHandIndustrie = 0;
  for (const d of connectedRows) {
    const s = crossoverState(d.trust, d.boxArt, d.loader).state;
    if (s === 'gekreuzt') crossed += 1;
    else if (s === 'offen' || s === 'fehler') open += 1;
    // Edge Light ohne Stufe 2 (und Edge Industrie ohne Updates aus dem Portal)
    // ist keine offene Aufgabe, aber auch nicht update-fähig über das Portal -
    // benannt, nicht mitgezählt.
    else if (s === 'von_hand' && d.boxArt === 'industrie') vonHandIndustrie += 1;
    else if (s === 'von_hand') vonHand += 1;
  }
  const stages: FunnelStage[] = [
    {
      id: 'registriert',
      label: 'Registriert',
      count: registered,
      note:
        registered === 0
          ? 'Noch keine Geräte-ID registriert.'
          : 'Geräte-IDs, die Kunden verbinden können.',
      attention: false,
    },
    {
      id: 'wartet',
      label: 'Wartet auf Zuordnung',
      count: waiting,
      note:
        waiting === 0
          ? 'Kein Gerät wartet gerade auf einen Claim.'
          : 'Diese Geräte melden sich, treffen aber auf kein Kundenkonto.',
      attention: waiting > 0,
    },
    {
      id: 'verbunden',
      label: 'Verbunden',
      count: connected,
      note:
        connected === 0
          ? 'Noch kein Gerät mit einem Kundenkonto verbunden.'
          : 'Mit einem Kundenkonto verbunden.',
      attention: false,
    },
  ];
  // Die vierte Stufe erscheint nur, wenn es überhaupt eine Flotte gibt, über
  // die sie etwas sagen könnte - eine „0 von 0"-Kachel wäre kein Befund.
  if (connectedRows.length > 0) {
    stages.push({
      id: 'vertrauen',
      label: 'Vertrauen gekreuzt',
      count: crossed,
      note:
        (open > 0
          ? open === 1
            ? '1 Gerät ist noch nicht update-fähig.'
            : `${open} Geräte sind noch nicht update-fähig.`
          : crossed === 0
            ? 'Noch kein Gerät meldet einen geprüften Vertrauensanker.'
            : 'Diese Geräte können Releases anwenden.')
        + (vonHand === 0 ? ''
          : vonHand === 1
            ? ' 1 Edge-Light-Box bekommt Updates von Hand (Stufe 1).'
            : ` ${vonHand} Edge-Light-Boxen bekommen Updates von Hand (Stufe 1).`)
        + (vonHandIndustrie === 0 ? ''
          : vonHandIndustrie === 1
            ? ' 1 Edge-Industrie-Box bekommt Updates von Hand.'
            : ` ${vonHandIndustrie} Edge-Industrie-Boxen bekommen Updates von Hand.`),
      // Ein offener Crossover ist eine AUFGABE, kein Fehler - aber er ist der
      // Grund, warum ein Rollout auf dieser Box nichts bewirkt.
      attention: open > 0,
    });
  }
  return stages;
}

/**
 * Ein wartendes Gerät ist bei KEINEM Kunden eingerichtet — kein Kunde, kein
 * Benutzer, keine Anlage (Firstmate vp-werkstatt-laeuft-anzeige, Captain
 * 09.11.2026: „ist das verbunden? ist es schon beim Kunden eingerichtet?").
 * Wahr für jede Zeile aus {@link pendingRows}, darum ein fester Satz statt
 * eines Felds je Zeile.
 */
export const PENDING_KONTEXT = 'Noch bei keinem Kunden eingerichtet';

/**
 * Wortlaut der Erreichbarkeit EINES wartenden Geräts - nie „Verbunden": das
 * Gerät ist erreichbar, nicht mit einem Kunden verbunden.
 */
const PENDING_ERREICHBAR_TEXT: Record<BoxErreichbarkeit, string> = {
  online: 'Online', verzoegert: 'Verzögert', offline: 'Meldet sich nicht', nie: 'Wartet auf erste Meldung',
};

export function pendingErreichbarText(v: BoxVerbindung): string {
  return PENDING_ERREICHBAR_TEXT[v.zustand];
}

/**
 * Die zwei Online-Fenster leben in `boxLebenszeichen.ts` (neutral, keine Admin-Worte) - EIN
 * Ort für die Zahl, damit Kundenflächen wie `AnlageFlow.tsx` dasselbe Fenster verwenden
 * können, ohne diese Admin-only-Schicht zu importieren (siehe `copy.test.ts` "the
 * admin-only pure layers are really admin-only"). Re-export hier erhält bestehende Importe.
 * vp-entkoppelte-box-meldet-verbunden (D3 = A) und vp-wartend-online-aktuell (19.11.2026)
 * begründen die beiden Werte.
 */
export { WARTET_ONLINE_WINDOW_MS, WARTET_NIE_ZUGEORDNET_ONLINE_WINDOW_MS };

/**
 * Erreichbarkeit einer wartenden Box aus ihrem letzten Lebenszeichen: die spätere von
 * letzter CSR (`csrUpdatedAt`) und letzter Zertifikats-Abfrage (`zuletztAbgefragtAm`).
 * Eine Box mit Zertifikat schickt nie wieder eine CSR - ohne die Abfrage stünde sie nach
 * einer Trennung für immer auf „Meldet sich nicht", auch wenn sie im Takt fragt.
 *
 * Das Fenster selbst folgt `everIssued` (vp-wartend-online-aktuell): eine nie zugeordnete
 * Box fragt sehr viel öfter als eine getrennte mit Zertifikat, darum braucht sie ein viel
 * engeres Fenster, um „ziemlich aktuell" zu sein - EIN Ort für diese Entscheidung, den auch
 * die Akte und die Kopfzeile lesen (`pendingRows`).
 */
export function wartendeVerbindung(
  p: { csrUpdatedAt: string | null; zuletztAbgefragtAm?: string | null; everIssued: boolean },
  now: Date,
): BoxVerbindung {
  const zeiten = [p.csrUpdatedAt, p.zuletztAbgefragtAm ?? null]
    .map((t) => (t ? Date.parse(t) : Number.NaN))
    .filter((t) => Number.isFinite(t));
  if (zeiten.length === 0) {
    return { zustand: 'nie', tone: 'off', text: 'Wartet auf erste Meldung', lastSeenText: DASH };
  }
  const age = now.getTime() - Math.max(...zeiten);
  const window = p.everIssued ? WARTET_ONLINE_WINDOW_MS : WARTET_NIE_ZUGEORDNET_ONLINE_WINDOW_MS;
  if (age <= window) {
    return { zustand: 'online', tone: 'ok', text: 'Online', lastSeenText: relAge(age) };
  }
  return { zustand: 'offline', tone: 'warn', text: 'Meldet sich nicht', lastSeenText: relAge(age) };
}

/** Eine Zeile der Sektion „Wartet auf Zuordnung". */
export interface PendingRow {
  externalRef: string;
  /** Was das Gerät über sich sagt; null wenn es nichts gesagt hat. */
  deviceInfo: string | null;
  csrUpdatedAt: string;
  /** Der eine einordnende Satz — die einzige Wertung dieser Fläche. */
  hint: string;
  /** True für die Hervorhebung nach {@link TYPO_SUSPECT_AFTER_MS} (die Zeile wird bernstein markiert). */
  suspect: boolean;
  /** Ist die Box gerade erreichbar? Aus ihrem letzten Lebenszeichen (`wartendeVerbindung`, D3 = A). */
  erreichbar: BoxVerbindung;
  /** Herkunft (vp-geraete-herkunft): die Werkstatt-Abnahme dieser Referenz; `null` = selbst angemeldet. */
  werkstattAbnahmeAm: string | null;
  /**
   * N3 (vp-box-rueckkehr-diagnose, Abschnitt 6): war schon einmal ein Zertifikat ausgestellt.
   * Löscht man diesen Eintrag trotzdem, bekommt die Box nie wieder eins (`geraeteListe.ts`,
   * `loeschKandidat`) - eine neu aufgesetzte Box unter derselben Kennung scheitert zusätzlich
   * am festgehaltenen Schlüssel.
   */
  everIssued: boolean;
}

/** Dauer in ganzen Tagen, nie 0 — ab {@link TYPO_SUSPECT_AFTER_MS} ist mindestens ein Tag vergangen. */
function seitTagen(waitedMs: number): string {
  const tage = Math.max(1, Math.floor(waitedMs / (24 * 60 * 60 * 1000)));
  return tage === 1 ? '1 Tag' : `${tage} Tagen`;
}

/**
 * Die wartenden Geräte, das LÄNGSTE Warten zuerst — genau das ist der Fall, der
 * jemanden braucht. Der Hinweis unterscheidet nur die drei Zustände, die die
 * Daten wirklich hergeben:
 *
 * - länger als {@link TYPO_SUSPECT_AFTER_MS} → wie lange die Box schon ohne
 *   Kunden meldet — ohne eine Vermutung über die Ursache (Firstmate
 *   vp-geraete-herkunft: nie wieder „vermutlich Tippfehler", wenn nie ein
 *   Kunde etwas getippt haben muss).
 * - frisch → normal während der Einrichtung
 * - `everIssued` → das Gerät WAR verbunden und wurde getrennt; das ist etwas
 *   anderes als „nie angekommen" und darf nie als Tippfehler gelesen werden.
 */
export function pendingRows(
  pending: PendingEnrollment[],
  now: Date = new Date(),
): PendingRow[] {
  return [...pending]
    .sort((a, b) => Date.parse(a.csrUpdatedAt) - Date.parse(b.csrUpdatedAt))
    .map((p) => {
      const waitedMs = Math.max(0, now.getTime() - Date.parse(p.csrUpdatedAt));
      const suspect = !p.everIssued && waitedMs >= TYPO_SUSPECT_AFTER_MS;
      return {
        externalRef: p.externalRef,
        deviceInfo: p.deviceInfo && p.deviceInfo.trim() ? p.deviceInfo.trim() : null,
        csrUpdatedAt: p.csrUpdatedAt,
        hint: p.everIssued
          ? 'War schon einmal verbunden und wurde getrennt'
          : suspect
            ? `Meldet sich seit ${seitTagen(waitedMs)}, noch keinem Kunden zugeordnet`
            : 'Frisch — normal während der Einrichtung',
        suspect,
        erreichbar: wartendeVerbindung(p, now),
        werkstattAbnahmeAm: p.werkstattAbnahmeAm,
        everIssued: p.everIssued,
      };
    });
}

/**
 * Herkunft (vp-geraete-herkunft): die eine ehrliche Angabe, die die Plattform zu einer Box
 * hat — aus der Werkstatt (mit Abnahme-Datum) oder selbst angemeldet. Keine dritte Wertung.
 */
export function herkunftText(werkstattAbnahmeAm: string | null): string {
  if (!werkstattAbnahmeAm) return 'Selbst angemeldet';
  const datum = new Date(werkstattAbnahmeAm).toLocaleDateString('de-DE',
    { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `Aus der Werkstatt · ${datum}`;
}

// ── Das INVENTAR: eine Tabelle über den ganzen Lebenszyklus ────────────────

/** Wo im Lebenszyklus steht diese Zeile? */
export type DeviceLifecycle = 'gedruckt' | 'verbunden';

/** Eine Zeile der EINEN Geräte-Tabelle. */
export interface DeviceRow {
  key: string;
  row: AdminDeviceRow;
  lifecycle: DeviceLifecycle;
  /** Was die Zeile in der Spalte „Gerät" trägt - nie eine UUID. */
  name: string;
  /** Anlage · Mandant, wo bekannt. */
  context: string | null;
  /** Steht diese Referenz in der Aufkleber-Registry? */
  provisioned: boolean;
}

/**
 * Das Inventar, sortiert: erst was Aufmerksamkeit braucht, dann die verbundene
 * Flotte, zuletzt die gedruckten IDs, die noch niemand verbunden hat.
 *
 * Die Reihenfolge INNERHALB der verbundenen Geräte ist die des Flotten-Pulses
 * (warn-first) - eine zweite Rangfolge für dieselbe Frage wäre eine zweite
 * Wahrheit; sie kommt deshalb aus `sortFleet`s Rang-Tabelle über `stateRank`.
 */
export function deviceRows(devices: AdminDeviceRow[]): DeviceRow[] {
  const rows: DeviceRow[] = devices.map((row) => ({
    key: row.externalRef,
    row,
    lifecycle: row.deviceId != null ? 'verbunden' : 'gedruckt',
    // Ein verbundenes Gerät heißt nach seiner Anlage bzw. seinem Namen; eine
    // gedruckte ID hat noch keinen - dann IST die Referenz der Name.
    name: row.siteName ?? row.label ?? row.externalRef,
    context: row.tenantName ?? null,
    provisioned: row.provisioned,
  }));
  return rows.sort((a, b) => {
    if (a.lifecycle !== b.lifecycle) return a.lifecycle === 'verbunden' ? -1 : 1;
    const ra = stateRank(a.row.state);
    const rb = stateRank(b.row.state);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, 'de');
  });
}

/** Warn-first, dieselbe Ordnung wie im Flotten-Puls. */
function stateRank(state: string | null): number {
  switch (state) {
    case 'fehlgeschlagen':
    case 'zurueckgerollt':
    case 'im_update_verstummt':
      return 0;
    case 'wartet_auf_anwendung':
      return 1;
    case 'blockiert':
      return 2;
    case 'wendet_an':
    case 'laedt':
    case 'selbsttest':
      return 3;
    case 'ausstehend':
      return 4;
    case 'zurueckgestellt':
      return 5;
    case 'offline_holt_nach':
      return 6;
    case 'unbekannt':
      return 7;
    default:
      return 8;
  }
}

// ⚠ `versionDisplay`/`versionLabel` sind nach `src/edgeVersionLabel.ts`
// gezogen: seit der BOX-Seite (Geräteseiten Stufe 1) liest sie auch eine
// KUNDEN-Fläche, und der Copy-Wächter verbietet einer Kundenfläche zu Recht,
// eine reine ADMIN-Schicht zu importieren. Re-Export, damit jeder bestehende
// Aufrufer unverändert gilt.
export { versionDisplay, versionLabel } from './edgeVersionLabel';

