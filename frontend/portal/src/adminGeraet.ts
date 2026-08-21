/**
 * Die GERÄTE-DETAILSEITE als reine Ableitung (Admin-Umbau Stufe 2 „Der Anker",
 * Konzept `data/vp-admin-neu-konzept-a9` §4, Captain-Entscheid F2).
 *
 * Der belegte Schmerz war der ORT, nicht die Daten: ein Gerät lag über drei
 * Flächen verstreut (Registry: der Aufkleber · Edge-Updates: das Update ·
 * Plattform-Übersicht: die Anlage), obwohl vier längst existierende
 * Admin-Reads alles darüber wissen. Diese Datei komponiert die sieben
 * Sektionen aus genau diesen vier Antworten - **es entsteht KEIN neues
 * Backend und, wichtiger, KEINE zweite Wahrheit:** jedes Urteil kommt aus dem
 * Modul, das es schon fällt (`adminEdgeUpdates` · `adminFleet` ·
 * `curtailment` · `controlCertification` · `onboardingFunnel`).
 *
 * Vier Regeln tragen die Fläche, alle sind Haus-Regeln:
 *
 * 1. **Die REFERENZ ist der Schlüssel**, nicht die Geräte-UUID - sie überlebt
 *    Unclaim/Re-Claim (der dokumentierte Identitäts-Drift), also überlebt auch
 *    ein Lesezeichen darauf.
 * 2. **Ein Beleg gehört dem Gerät, das ihn gemeldet hat.** Steuerungs- und
 *    Abregel-Block reisen im Flotten-Aggregat je ANLAGE; auf einer Anlage mit
 *    mehreren Geräten stammen sie von genau einem. Sie werden deshalb nur
 *    gezeigt, wenn ihre `deviceId` zu DIESEM Gerät gehört - sonst wäre die
 *    Zuschreibung erfunden.
 * 3. **Unbekannt ist nie „nein".** Ein fehlender Block heißt „nicht gemeldet"
 *    und trägt seinen Grund; ein fehlender Wert ist `—`, nie eine 0.
 * 4. **Die Sätze der Box werden DURCHGEREICHT** (Wächter, Blocker, Grund),
 *    nie neu formuliert - `:8484`, Puls und diese Seite dürfen dasselbe
 *    Urteil nicht verschieden benennen.
 */
import type { AdminDeviceRow, ControlCandidate } from './admin/adminApi';
import type { AdminFleetSite } from './admin/fleetApi';
import {
  applyView,
  blockerLever,
  crossoverState,
  formatTrustStamp,
  stateLabel,
  type ApplyView,
  type CrossoverState,
  type EdgeUpdatesRelease,
  type JournalEntry,
  type UpdateTone,
} from './adminEdgeUpdates';
import {
  controlMatrixRow,
  DASH,
  PLAN_STALE_MS,
  relAge,
  sourceHealth,
  type Tone,
} from './adminFleet';
import { certSourceLabel, isoDate, plantCertView, type PlantCertView } from './controlCertification';
import { exportGuardView, releaseNote, type ExportGuardView } from './curtailment';
import { deviceKindLabel, fmtRelative } from './format';
import { versionLabel } from './onboardingFunnel';

/** Wie viele Journal-Einträge die Verlaufs-Sektion höchstens zeigt. */
export const VERLAUF_MAX = 20;

/**
 * Die vier Reads, die die Seite komponieren - jeder EINZELN optional, weil
 * jeder einzeln ausfallen darf. Ein fehlgeschlagener Nebenabruf macht die
 * Seite nicht unbenutzbar; er macht seine Sektion ehrlich leer.
 */
export interface GeraetInput {
  /** Die Referenz aus der Adresse (`?geraet=`). */
  ref: string;
  /** `GET /admin/devices` - die Vereinigung von Registry und echter Flotte. */
  devices: AdminDeviceRow[] | null;
  /** `GET /admin/fleet` - je Anlage Quellen, Plan-Alter, Steuerung, Abregelung. */
  sites: AdminFleetSite[] | null;
  /** `GET /admin/control-candidates` - die Freigabe-Lage je Gerät. */
  candidates: ControlCandidate[] | null;
  /** `GET /admin/edge-updates` - Register + Journal (für Zuweisung + Verlauf). */
  releases: EdgeUpdatesRelease[];
  journal: JournalEntry[];
}

/** Eine Zeile einer Sektion: Beschriftung, Wert, optional Grund + Ton. */
export interface Zeile {
  label: string;
  wert: string;
  detail?: string | null;
  tone?: Tone;
}

/** Der Kopf: WER ist das, wo steht es, meldet es sich. */
export interface GeraetKopf {
  /** Der Name des GERÄTS (nicht der Anlage) - sonst die Referenz. */
  name: string;
  ref: string;
  /** „Wechselrichter" o. ä.; null, wenn die Art nicht bekannt ist. */
  typ: string | null;
  /** „Demo Site Berlin · Tenant A"; leer, solange nichts verbunden ist. */
  kontext: string;
  /** Die Lebendigkeit aus der Telemetrie - der Zustands-Pill. */
  lebendigkeit: { label: string; tone: Tone; detail: string };
  /** „Zur Anlage (Mandanten-Ansicht)" - null, solange kein Mandant/keine Anlage feststeht. */
  sprungAnlage: { tenantId: string; siteId: string } | null;
  /** „Befehle ansehen" (Kommando-Transparenz) - dieselbe Bedingung. */
  sprungBefehle: { tenantId: string; siteId: string } | null;
}

/** Der Software-Stand samt der drei Handlungen, die ihn ändern. */
export interface GeraetSoftware {
  zeilen: Zeile[];
  /** Der Hebel zu einer stehenden Sperre; null = keine gemeldet. */
  hebel: string | null;
  /**
   * Sagt die Warnung VOR dem Anwenden-Knopf denselben Satz? Dann gehört er
   * genau EINMAL auf die Karte - und zwar dorthin, wo gleich geklickt wird
   * (die Haus-Regel „nichts steht zweimal auf einer Karte"). Im Browser
   * aufgefallen, nicht im Test.
   */
  hebelDoppelt: boolean;
  /** Der Satz der Box zum aktuellen Zustand, VERBATIM. */
  grund: string | null;
  /** Die EINE Apply-Ableitung - Handeln-Karte, Drawer und Seite sagen dasselbe. */
  apply: ApplyView;
  /** Darf hier überhaupt etwas zugewiesen werden? (nur ein verbundenes Gerät) */
  verbunden: boolean;
  /** Signierte Releases - nur die sind verteilbar. */
  signierteReleases: EdgeUpdatesRelease[];
}

export interface GeraetVertrauen {
  state: CrossoverState;
  label: string;
  tone: UpdateTone;
  detail: string | null;
  /** Die key_ids des GEPRÜFTEN Vertrauens-Sets; leer = keine gemeldet. */
  trustSet: string[];
  /** „vom 04.08.2026"; leer, wenn kein Stand gemeldet wurde. */
  trustSetStand: string;
}

export interface GeraetSteuerung {
  /** Die vier Situationen der Modell-Freigabe (`plantCertView`). */
  freigabe: PlantCertView | null;
  zeilen: Zeile[];
  /** Der Steuer-Beleg, wortgleich mit der Puls-Matrix. */
  beleg: { text: string; detail: string | null; tone: Tone } | null;
  /** „Rücklesen vor 12 Min." bzw. „kein Beleg". */
  belegAlter: string | null;
  belegStale: boolean;
  /** Warum es hier nichts zu zeigen gibt - nie ein stilles Nichts. */
  leerGrund: string | null;
}

export interface GeraetGrenzen {
  /** Der Einspeisewächter - die Sätze der Box, durchgereicht. */
  guard: ExportGuardView | null;
  /** „0 von 2 Wechselrichtern freigegeben" - der Pilsting-Fall. */
  freigabeText: string | null;
  /** Die Abregel-Zelle, wortgleich mit der Puls-Matrix. */
  abregelung: { text: string; detail: string | null; tone: Tone } | null;
  leerGrund: string | null;
}

export interface GeraetVerbindung {
  zeilen: Zeile[];
}

/** Die ganze Seite - sieben Sektionen aus vier Antworten. */
export interface GeraetView {
  kopf: GeraetKopf;
  software: GeraetSoftware;
  vertrauen: GeraetVertrauen;
  steuerung: GeraetSteuerung;
  grenzen: GeraetGrenzen;
  verbindung: GeraetVerbindung;
  verlauf: JournalEntry[];
  /** Die Rohzeile - Aktionen brauchen die Geräte-Id, nicht die Referenz. */
  device: AdminDeviceRow;
}

/** Wortlaute, die die Detailseite mit dem Drawer TEILT (eine Wahrheit). */
export const REGISTRY_AUFKLEBER = 'Aufkleber-ID registriert';
export const REGISTRY_SELBST =
  'Nicht aus der Aufkleber-Registry (selbst erzeugte Referenz)';

/** Der ehrliche Satz, wenn die Referenz in keinem Inventar vorkommt. */
export const NICHT_GEFUNDEN =
  'Zu dieser Geräte-ID gibt es keinen Eintrag - weder eine gedruckte Aufkleber-ID '
  + 'noch ein verbundenes Gerät. Möglicherweise wurde sie entfernt.';

/**
 * Das Gerät zu einer Referenz. Verglichen wird UNABHÄNGIG von der
 * Groß-/Kleinschreibung: `VP-`Aufkleber werden großgeschrieben gespeichert,
 * `edge-`Referenzen klein, und eine Adresse aus einer Zwischenablage trägt
 * beides - ein Lesezeichen darf daran nicht scheitern.
 */
export function findeGeraet(
  devices: AdminDeviceRow[] | null,
  ref: string,
): AdminDeviceRow | null {
  if (!devices || !ref) return null;
  const key = ref.trim().toLowerCase();
  return devices.find((d) => d.externalRef.trim().toLowerCase() === key) ?? null;
}

/**
 * Die ganze Detailseite. `null`, wenn die Referenz nirgends vorkommt - die
 * Fläche zeigt dann {@link NICHT_GEFUNDEN} statt einer Seite voller `—`.
 */
export function geraetView(input: GeraetInput, now: Date = new Date()): GeraetView | null {
  const device = findeGeraet(input.devices, input.ref);
  if (!device) return null;

  const site = device.siteId
    ? (input.sites ?? []).find((s) => s.siteId === device.siteId) ?? null
    : null;
  const candidate = device.deviceId
    ? (input.candidates ?? []).find((c) => c.deviceId === device.deviceId) ?? null
    : null;

  // Regel 2: ein Beleg gehört dem Gerät, das ihn gemeldet hat. Auf einer
  // Anlage mit mehreren Geräten stammt der Block aus dem Flotten-Aggregat von
  // genau einem - ihn hier ungeprüft zu zeigen wäre eine erfundene Zuschreibung.
  const control = eigenerBeleg(site?.control ?? null, device.deviceId);
  const curtailment = eigenerBeleg(site?.curtailment ?? null, device.deviceId);

  return {
    device,
    kopf: kopf(device, now),
    software: software(device, input.releases, now),
    vertrauen: vertrauen(device),
    steuerung: steuerung(device, site, candidate, control, curtailment, now),
    grenzen: grenzen(device, site, curtailment, now),
    verbindung: verbindung(device, site, now),
    verlauf: verlauf(device, input.journal),
  };
}

/** Gehört dieser Beleg wirklich zu diesem Gerät? Sonst: nicht behaupten. */
function eigenerBeleg<T extends { deviceId: string }>(
  block: T | null,
  deviceId: string | null,
): T | null {
  if (!block || !deviceId) return null;
  return block.deviceId === deviceId ? block : null;
}

// ---------------------------------------------------------------------------
// Kopf
// ---------------------------------------------------------------------------

/**
 * Die Lebendigkeit aus `lastSeenAt` - dieselbe Frage und dasselbe
 * 5-Minuten-Fenster wie überall im Portal. **`now` ist die ANTWORTZEIT des
 * Servers, nie eine laufende Uhr** (`liveness.ts`): Zustand und Bezugszeit
 * werden gemeinsam gesetzt, sonst verfällt ein stehender Schnappschuss zu
 * „meldet sich nicht", ohne dass jemand etwas Neues wüsste.
 */
export function lebendigkeit(
  lastSeenAt: string | null | undefined,
  now: Date,
): { label: string; tone: Tone; detail: string } {
  if (!lastSeenAt) {
    return {
      label: 'wartet auf erste Daten',
      tone: 'off',
      detail: 'Dieses Gerät hat noch nie Messwerte geschickt.',
    };
  }
  const age = now.getTime() - Date.parse(lastSeenAt);
  if (!Number.isFinite(age)) {
    return { label: 'unbekannt', tone: 'off', detail: 'Kein verwertbarer Zeitstempel.' };
  }
  const frisch = age <= 5 * 60 * 1000;
  return {
    label: frisch ? 'meldet sich' : 'meldet sich nicht',
    tone: frisch ? 'ok' : 'warn',
    // `relAge` bringt seinen Punkt selbst mit - ein zweiter ergäbe „vor 2 Min..".
    detail: `Zuletzt gemeldet ${relAge(age)}`,
  };
}

function kopf(device: AdminDeviceRow, now: Date): GeraetKopf {
  // Der Name des GERÄTS führt (die Anlage steht als Kontext darunter) - auf
  // einer Seite ÜBER ein Gerät wäre der Anlagenname die falsche Überschrift.
  const name = device.label?.trim() || device.externalRef;
  const sprung =
    device.tenantId && device.siteId
      ? { tenantId: device.tenantId, siteId: device.siteId }
      : null;
  return {
    name,
    ref: device.externalRef,
    typ: device.kind ? deviceKindLabel(device.kind) : null,
    kontext: [device.siteName, device.tenantName].filter(Boolean).join(' · '),
    lebendigkeit: lebendigkeit(device.lastSeenAt, now),
    // Ein Sprung, der strukturell nirgends hinführt, wird nicht angeboten -
    // eine gedruckte, noch nicht verbundene ID hat keine Anlage.
    sprungAnlage: sprung,
    sprungBefehle: sprung,
  };
}

// ---------------------------------------------------------------------------
// Software
// ---------------------------------------------------------------------------

/**
 * ⚠ `now` ist die ANTWORTZEIT des Servers, nicht `new Date()`: „Ist gemeldet"
 * beantwortet dieselbe Frage wie die Lebendigkeit im Kopf, muss also gegen
 * DIESELBE Bezugszeit rechnen - sonst behaupten zwei Zeilen derselben Seite
 * verschiedene Alter für denselben Schnappschuss.
 */
function software(
  device: AdminDeviceRow,
  releases: EdgeUpdatesRelease[],
  now: Date,
): GeraetSoftware {
  const verbunden = device.deviceId != null;
  const st = stateLabel(device.state);
  const zeilen: Zeile[] = [];
  if (verbunden) {
    zeilen.push({ label: 'Ist', wert: versionLabel(device.ist, releases) });
    zeilen.push({
      label: 'Ist gemeldet',
      wert: device.reportedAt ? fmtRelative(device.reportedAt, now) : 'noch nie',
    });
    zeilen.push({
      label: 'Soll',
      wert: device.soll ? versionLabel(device.soll, releases) : DASH,
    });
    zeilen.push({ label: 'Zustand', wert: st.label, tone: toneOf(st.tone) });
    zeilen.push({
      label: 'Kanal',
      wert: device.channel ?? DASH,
      detail: device.pinned
        ? 'Festgenagelt - ein Rollout überspringt dieses Gerät sichtbar.'
        : null,
    });
  }
  const hebel = blockerLever(device.blocker);
  const apply = applyView(device);
  return {
    zeilen,
    hebel,
    hebelDoppelt: hebel != null && hebel === apply.warn,
    grund: device.reason ?? null,
    apply,
    verbunden,
    signierteReleases: releases.filter((r) => r.signed),
  };
}

/** Der Update-Ton (`busy` inklusive) auf die drei Töne der Admin-Flächen. */
function toneOf(tone: UpdateTone): Tone {
  return tone === 'busy' ? 'off' : tone;
}

// ---------------------------------------------------------------------------
// Vertrauen
// ---------------------------------------------------------------------------

function vertrauen(device: AdminDeviceRow): GeraetVertrauen {
  const cross = crossoverState(device.trust);
  const set = device.trust?.trustSetKeyIds ?? [];
  const stand = device.trust?.trustSetGeneratedAt;
  return {
    state: cross.state,
    label: cross.label,
    tone: cross.tone,
    detail: cross.detail,
    trustSet: set,
    trustSetStand: stand ? `vom ${formatTrustStamp(stand)}` : '',
  };
}

// ---------------------------------------------------------------------------
// Steuerung
// ---------------------------------------------------------------------------

function steuerung(
  device: AdminDeviceRow,
  site: AdminFleetSite | null,
  candidate: ControlCandidate | null,
  control: AdminFleetSite['control'],
  curtailment: AdminFleetSite['curtailment'],
  now: Date,
): GeraetSteuerung {
  if (!device.deviceId) {
    return {
      freigabe: null,
      zeilen: [],
      beleg: null,
      belegAlter: null,
      belegStale: false,
      leerGrund:
        'Diese Geräte-ID ist noch mit keinem Kundenkonto verbunden - über ihre '
        + 'Steuerung ist deshalb nichts zu sagen.',
    };
  }

  const zeilen: Zeile[] = [];
  let freigabe: PlantCertView | null = null;
  if (candidate) {
    freigabe = plantCertView(candidate.activated, candidate.platformCertVerdict);
    zeilen.push({
      label: 'Gemeldetes Modell',
      wert: candidate.platformCertModel || DASH,
      detail: candidate.platformCertModel
        ? null
        : 'Das Gerät hat noch nicht gemeldet, welches Modell es fährt.',
    });
    zeilen.push({
      label: 'Scharfgeschaltet',
      wert: candidate.activated
        ? [isoDate(candidate.activatedAt), candidate.activatedBy].filter(Boolean).join(' · ')
          || 'ja'
        : 'nein',
    });
  }

  // Die Quelle steht getrennt, weil `null` hier „nicht gemeldet" heißt und nie
  // „nicht freigegeben" - die Abwesenheit ist keine Aussage über die Quelle.
  const quelle = certSourceLabel(candidate?.certSource ?? control?.certSource);
  zeilen.push({
    label: 'Herkunft der Freigabe',
    wert: quelle || DASH,
    detail: quelle ? null : 'Das Gerät hat die Herkunft nicht gemeldet.',
  });

  // Der Beleg kommt aus DERSELBEN Ableitung wie die Puls-Matrix - eine
  // Support-Sicht darf technischer beschriftet sein, nie etwas anderes sagen.
  const matrix = site
    ? controlMatrixRow(
        {
          siteId: site.siteId,
          siteName: site.siteName,
          tenantId: site.tenantId,
          tenantName: site.tenantName,
          control,
          curtailment,
        },
        now,
      )
    : null;

  return {
    freigabe,
    zeilen,
    beleg: ohneDoppelung(matrix?.battery ?? null),
    belegAlter: matrix ? matrix.belegText : null,
    belegStale: matrix?.belegStale ?? false,
    leerGrund:
      candidate == null && control == null
        ? 'Für dieses Gerät liegt keine Freigabe-Lage vor - es hat sich dazu noch nicht gemeldet.'
        : null,
  };
}

/**
 * Ein Grund, der den Zustand nur WIEDERHOLT, wird nicht zweimal gesagt.
 *
 * Die Puls-Zellen tragen den Freigabestand als Text UND - wenn er zugleich die
 * Ursache ist - noch einmal als Begründung; nebeneinander in EINER Karte stand
 * derselbe Satz damit doppelt (im Browser aufgefallen, nicht im Test). Es ist
 * dieselbe Haus-Regel wie an den Regel-Karten der Steuerung.
 */
function ohneDoppelung<T extends { text: string; detail: string | null }>(
  zelle: T | null,
): T | null {
  if (!zelle?.detail) return zelle;
  const gleich = (a: string) => a.replace(/[.\s]+$/, '').trim().toLowerCase();
  return gleich(zelle.detail) === gleich(zelle.text) ? { ...zelle, detail: null } : zelle;
}

// ---------------------------------------------------------------------------
// Grenzen & Wächter
// ---------------------------------------------------------------------------

function grenzen(
  device: AdminDeviceRow,
  site: AdminFleetSite | null,
  curtailment: AdminFleetSite['curtailment'],
  now: Date,
): GeraetGrenzen {
  if (!curtailment) {
    return {
      guard: null,
      freigabeText: null,
      abregelung: null,
      leerGrund: device.deviceId
        ? 'Dieses Gerät meldet weder einen Einspeisewächter noch eine Abregel-Einheit.'
        : 'Diese Geräte-ID ist noch mit keinem Kundenkonto verbunden.',
    };
  }
  const matrix = site
    ? controlMatrixRow(
        {
          siteId: site.siteId,
          siteName: site.siteName,
          tenantId: site.tenantId,
          tenantName: site.tenantName,
          control: null,
          curtailment,
        },
        now,
      )
    : null;
  return {
    guard: exportGuardView(curtailment, now),
    freigabeText:
      curtailment.units > 0
        ? releaseNote(curtailment.certifiedUnits, curtailment.units)
        : null,
    abregelung: ohneDoppelung(matrix?.curtail ?? null),
    leerGrund: null,
  };
}

// ---------------------------------------------------------------------------
// Verbindung & Onboarding
// ---------------------------------------------------------------------------

function verbindung(
  device: AdminDeviceRow,
  site: AdminFleetSite | null,
  now: Date,
): GeraetVerbindung {
  const zeilen: Zeile[] = [];
  zeilen.push({
    label: 'Herkunft',
    wert: device.provisioned === false ? REGISTRY_SELBST : REGISTRY_AUFKLEBER,
  });
  zeilen.push({
    label: 'Verbunden',
    wert: device.deviceId
      ? [device.tenantName, device.siteName].filter(Boolean).join(' · ') || 'ja'
      : 'noch nicht',
    detail: device.deviceId
      ? null
      : 'Ein Kunde muss diese ID erst verbinden, bevor etwas passiert.',
    tone: device.deviceId ? 'ok' : 'off',
  });
  if (device.note) zeilen.push({ label: 'Notiz', wert: device.note });

  // Quellen-Gesundheit + Plan-Alter beschreiben die ANLAGE, nicht das Gerät -
  // sie erscheinen deshalb nur, wenn dieses Gerät wirklich an einer hängt.
  const health = sourceHealth(site?.sources ?? null);
  zeilen.push({
    label: 'Quellen',
    wert: health ? health.text : DASH,
    detail: health
      ? (health.stale > 0 || health.never > 0
        ? `${health.stale} veraltet · ${health.never} noch nie`
        : null)
      : 'Das Gerät hat noch keine Quellen gemeldet.',
    tone: health?.tone ?? 'off',
  });
  if (site) {
    const plan = site.lastPlanGeneratedAt;
    const age = plan ? now.getTime() - Date.parse(plan) : null;
    zeilen.push({
      label: 'Letzter Fahrplan',
      wert: age == null || !Number.isFinite(age) ? 'kein Lauf im Fenster' : relAge(age),
      tone: age == null || age > PLAN_STALE_MS ? 'warn' : 'ok',
    });
  }
  return { zeilen };
}

// ---------------------------------------------------------------------------
// Verlauf
// ---------------------------------------------------------------------------

/**
 * Die Update-Historie DIESES Geräts. Eine gedruckte, noch nicht verbundene ID
 * hat keine Geräte-Id, also auch keinen Verlauf - und bekommt bewusst eine
 * leere Liste statt des Flotten-Journals.
 */
export function verlauf(device: AdminDeviceRow, journal: JournalEntry[]): JournalEntry[] {
  if (!device.deviceId) return [];
  return journal.filter((e) => e.deviceId === device.deviceId).slice(0, VERLAUF_MAX);
}

// ---------------------------------------------------------------------------
// Der Weg in die KUNDEN-Geräteseite
// ---------------------------------------------------------------------------

/**
 * Der AUSGANG einer `?geraet=<referenz>`-Adresse (Anlagen-Zentrale Stufe 3,
 * PR 3b). Die Plattform-Liste hat seit Stufe 1 keine zweite Vollansicht mehr;
 * eine solche Adresse tut deshalb genau eines von zwei Dingen:
 *
 * - **weiterleiten** auf die EINE Geräteseite in der Mandanten-Ansicht, wenn
 *   die Referenz wirklich ein verbundenes Gerät ist ({@link kundenGeraetZiel});
 * - **einen Hinweis nennen**, sonst. Es gibt bewusst KEINEN dritten Ausgang:
 *   eine Seite voller „—" über einer gedruckten ID war genau die Vollansicht,
 *   die diese Stufe abräumt.
 *
 * Die drei Hinweis-Fälle sind verschieden und werden deshalb verschieden
 * gesagt: unbekannt · gedruckt, aber noch nicht verbunden · verbunden, aber
 * ohne Anlage/Mandant (dann ist die Adresse nicht auflösbar, und das zu
 * verschweigen hieße, den Leser in eine tote Adresse zu schicken).
 */
export type GeraetLinkAusgang =
  | { kind: 'weiterleiten'; tenantId: string; siteId: string; ref: string }
  | { kind: 'hinweis'; text: string };

/** Der Satz für eine gedruckte, noch nicht verbundene Aufkleber-ID. */
export const NOCH_KEIN_GERAET =
  'Diese Geräte-ID ist registriert, aber noch mit keinem Kundenkonto verbunden - '
  + 'es gibt also noch kein Gerät, über das etwas zu sagen wäre. Sie steht unten '
  + 'in der Liste.';

/** Der Satz, wenn ein verbundenes Gerät keine auflösbare Anlage nennt. */
export const OHNE_ANLAGE =
  'Dieses Gerät nennt keine Anlage - seine Geräteseite ist deshalb nicht '
  + 'adressierbar. Bitte prüfen Sie die Zuordnung im Mandanten.';

export function geraetLinkAusgang(
  devices: AdminDeviceRow[] | null,
  ref: string,
): GeraetLinkAusgang {
  const device = findeGeraet(devices, ref);
  if (!device) return { kind: 'hinweis', text: NICHT_GEFUNDEN };
  const ziel = kundenGeraetZiel(device);
  if (ziel) return { kind: 'weiterleiten', ...ziel };
  return { kind: 'hinweis', text: device.deviceId ? OHNE_ANLAGE : NOCH_KEIN_GERAET };
}

/**
 * Wohin ein Klick auf ein Gerät der Plattform-Liste führt (Anlagen-Zentrale
 * Stufe 1 PR 1f).
 *
 * Ein VERBUNDENES Gerät hat seit dieser Stufe genau EINEN Ort: die
 * Geräte-Detailseite seiner Anlage. Der Weg dorthin führt über den
 * Mandanten-Umschalter - die Seite liegt hinter dem RLS-Zaun, also muss der
 * Mandant gesetzt sein, bevor die Adresse gilt.
 *
 * **Eine gedruckte, noch nicht verbundene Aufkleber-ID hat KEINE Geräteseite**
 * (es gibt kein Gerät, über das etwas zu sagen wäre) - sie bekommt `null` und
 * bleibt Zeile der Plattform-Liste mit ihrer eigenen Vollansicht. Dasselbe für
 * eine Zeile, der Mandant oder Anlage fehlt: ein Sprung ohne beides landete auf
 * einer Adresse, die niemand auflösen kann.
 */
export function kundenGeraetZiel(
  device: AdminDeviceRow | null | undefined,
): { tenantId: string; siteId: string; ref: string } | null {
  if (!device?.deviceId) return null;
  if (!device.siteId || !device.tenantId) return null;
  return { tenantId: device.tenantId, siteId: device.siteId, ref: device.externalRef };
}
