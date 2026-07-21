/**
 * M5 — der **Leer-Zustand als Einrichtungspfad** (Projektion #527, Ticket #533).
 *
 * Die Ausprägung „Neu / leer" (report `data/vp-anlagen-face-k9/report.md` §3):
 * eine Anlage ohne Entitäten und ohne Modi bekommt KEINE Platzhalter-Karten —
 * **ihr Cockpit IST der Einrichtungspfad**:
 *
 *     1 Gerät verbinden ✓ → 2 Geräte übernehmen → 3 Steuerung wählen
 *
 * Sobald Entitäten (und damit Modi) da sind, übernimmt der M3-Modul-Stapel;
 * die Seite baut sich „aus genau dem, was gewählt wurde".
 *
 * Reines Daten-/Logikmodul (der `surface.ts`/`cockpit.ts`-Präzedenzfall): keine
 * React-Imports, kein Netzwerk. Die Komponente rendert nur, was hier entschieden
 * wird.
 *
 * ## Die Weiche ist ABSICHTLICH eng (report §6.2, nicht verhandelbar)
 *
 * „Keine v2-Entitäten" allein reicht NICHT: **jede** heutige v1-Anlage hat keine
 * Entitäten, und ihr Cockpit muss byte-identisch bleiben. Der Einrichtungspfad
 * ersetzt das Cockpit deshalb nur, wenn es ehrlich **nichts zu zeigen** gibt —
 * die Anlage hat noch nie Messdaten geliefert (`lastSeenAt`/`live` beide leer).
 * Eine laufende v1-Anlage ohne Entitäten behält ihr Cockpit; ihre gemeldeten
 * Quellen bleiben (admin-first) im Bereich „Geräte" — genau die F6-Grenze
 * („außerhalb des geführten Pfads bleibt Adoption admin-first").
 */

import type { AdoptableSource } from './rollen';

// ---------------------------------------------------------------------------
// Die Weiche
// ---------------------------------------------------------------------------

export interface SetupPathGateInput {
  /** M0 `surface.base.hasEntities`; undefined/null = Read-Model nicht geladen. */
  hasEntities?: boolean | null;
  /** Anzahl aktiver Modi (M0). */
  modeCount?: number | null;
  /** true, sobald die Status-Zeile der Anlage (Overview) aufgelöst ist. */
  statusLoaded?: boolean;
  /** Zeitpunkt der letzten Messung (Overview); null = noch nie. */
  lastSeenAt?: string | null;
  /** Neuester Telemetrie-Datensatz vorhanden? */
  hasLiveSample?: boolean;
}

/**
 * Ist diese Anlage die Ausprägung „Neu / leer"? Nur dann ersetzt der
 * Einrichtungspfad das Cockpit.
 *
 * Alle vier Bedingungen müssen gelten:
 *  1. das Read-Model ist geladen (älteres Backend/Ladefehler ⇒ v1, fail-soft),
 *  2. es gibt keine Entitäten,
 *  3. es läuft kein Modus,
 *  4. die Anlage hat noch **nie** Messdaten geliefert (siehe Kopfkommentar).
 */
export function setupPathActive(input: SetupPathGateInput | null | undefined): boolean {
  const i = input ?? {};
  if (i.hasEntities !== false) return false;
  if ((i.modeCount ?? 0) > 0) return false;
  if (i.statusLoaded !== true) return false;
  if (i.lastSeenAt != null) return false;
  if (i.hasLiveSample === true) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Die drei Schritte
// ---------------------------------------------------------------------------

export type SetupStepId = 'geraet' | 'uebernehmen' | 'steuerung';
export type SetupStepState = 'done' | 'current' | 'todo';

export interface SetupStepAction {
  /** Was der Knopf auslöst: Gerät verbinden · übernehmen · Werkzeugkasten. */
  kind: 'claim' | 'adopt' | 'toolbox';
  label: string;
}

export interface SetupStep {
  id: SetupStepId;
  /** 1 · 2 · 3 — die sichtbare Nummer (erledigte Schritte zeigen ein ✓). */
  num: 1 | 2 | 3;
  title: string;
  line: string;
  state: SetupStepState;
  /** null = kein Knopf (erledigt oder noch nicht an der Reihe). */
  action: SetupStepAction | null;
}

export interface SetupPathView {
  /** EIN deutscher Satz im Kopf der Anlage. */
  statusLine: string;
  title: string;
  steps: SetupStep[];
  /** Der Schritt, an dem der Kunde gerade steht. */
  currentId: SetupStepId;
  /** Die ruhige Schluss-Zeile („die Seite baut sich von selbst"). */
  footNote: string;
}

export interface SetupPathInput {
  /** Beanspruchte Geräte der Anlage (Overview `deviceCount`). */
  deviceCount?: number | null;
  /** Vom Gerät gemeldete, noch nicht übernommene Quellen. */
  reported?: AdoptableSource[] | null;
  /** Bereits übernommene Entitäten dieser Anlage. */
  adoptedCount?: number | null;
}

export const SETUP_STATUS_LINE =
  'Ihre Anlage ist angelegt - jetzt stellen wir Ihr Energie-System zusammen. '
  + 'Drei Schritte, alles Weitere passiert automatisch.';

export const SETUP_TITLE = 'Ihr Weg zum fertigen EMS';

/**
 * Der Übergabe-Satz des AE5-Assistenten in den Einrichtungspfad (M5): der
 * Assistent legt die ANLAGE an, die Anlagen-Seite führt die KETTE zu Ende.
 * Er nennt die zwei verbleibenden Schritte und wirbt für KEINEN Modus (die
 * Profil-Vorauswahl bleibt reiner Vorlagen-Wähler, F5).
 */
export const SETUP_NEXT_HINT =
  'So geht es weiter: Auf Ihrer Anlagen-Seite übernehmen Sie die gemeldeten Geräte '
  + 'und wählen danach Ihre Steuerung - wir führen Sie Schritt für Schritt.';

export const SETUP_FOOT_NOTE =
  'Sobald Geräte und ein Modus da sind, baut sich diese Seite von selbst - '
  + 'aus genau dem, was Sie gewählt haben.';

/** „Deye Wechselrichter und go-e Wallbox" — nie eine erfundene Aufzählung. */
export function reportedNames(reported: AdoptableSource[] | null | undefined): string {
  const names = (reported ?? []).map((r) => r.summary).filter((s) => s.trim() !== '');
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

/** Der Einrichtungspfad als Ansicht — die drei Schritte mit ihrem Zustand. */
export function setupPath(input: SetupPathInput | null | undefined): SetupPathView {
  const i = input ?? {};
  const devices = i.deviceCount ?? 0;
  const reported = i.reported ?? [];
  const adopted = i.adoptedCount ?? 0;

  const geraetDone = devices > 0;
  const uebernehmenDone = adopted > 0;

  const geraet: SetupStep = {
    id: 'geraet',
    num: 1,
    title: geraetDone ? 'Gerät verbunden' : 'Gerät verbinden',
    line: geraetDone
      ? 'Ihre VoltPilot-Box gehört zu dieser Anlage und meldet sich.'
      : 'Verbinden Sie Ihre VoltPilot-Box mit dieser Anlage - Sie brauchen nur die Geräte-ID.',
    state: geraetDone ? 'done' : 'current',
    action: geraetDone ? null : { kind: 'claim', label: 'Gerät verbinden' },
  };

  const uebernehmenLine = !geraetDone
    ? 'Sobald Ihre Box verbunden ist, meldet sie, welche Geräte sie vor Ort erkannt hat.'
    : uebernehmenDone
      ? 'Ihre Geräte sind übernommen - VoltPilot kennt sie jetzt.'
      : reported.length > 0
        ? `Ihr Gerät meldet: ${reportedNames(reported)}. Mit einem Klick werden daraus Ihre Geräte.`
        : 'Ihr Gerät meldet noch keine Geräte. Richten Sie Wechselrichter und Zähler direkt am '
          + 'Gerät ein - danach erscheinen sie hier zum Übernehmen.';

  const uebernehmen: SetupStep = {
    id: 'uebernehmen',
    num: 2,
    title: 'Geräte übernehmen',
    line: uebernehmenLine,
    state: uebernehmenDone ? 'done' : geraetDone ? 'current' : 'todo',
    action:
      geraetDone && !uebernehmenDone && reported.length > 0
        ? {
            kind: 'adopt',
            label:
              reported.length === 1 ? 'Gerät übernehmen' : `${reported.length} Geräte übernehmen`,
          }
        : null,
  };

  const steuerung: SetupStep = {
    id: 'steuerung',
    num: 3,
    title: 'Steuerung wählen',
    line: uebernehmenDone
      ? 'Aus Ihren Geräten schlagen wir passende Modi vor - Eigenverbrauch zuerst. '
        + 'Sie bestätigen, VoltPilot übernimmt.'
      : 'Aus Ihren Geräten schlagen wir passende Modi vor. Dieser Schritt öffnet sich, '
        + 'sobald das erste Gerät übernommen ist.',
    state: uebernehmenDone ? 'current' : 'todo',
    action: uebernehmenDone ? { kind: 'toolbox', label: 'Modus wählen' } : null,
  };

  const steps = [geraet, uebernehmen, steuerung];
  const currentId = (steps.find((s) => s.state === 'current') ?? steuerung).id;

  return {
    statusLine: SETUP_STATUS_LINE,
    title: SETUP_TITLE,
    steps,
    currentId,
    footNote: SETUP_FOOT_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Kundenseitige, KATALOG-GEFÜHRTE Adoption (F6)
// ---------------------------------------------------------------------------

/**
 * Die kundensicheren Typ-Bezeichnungen. Der Backend-Typkatalog
 * (`/api/v1/admin/entity-type-catalog`) ist admin-only, also darf der geführte
 * Pfad NICHT davon abhängen: der Typ wird aus Rolle + Marke **vorgeschlagen**
 * (`rollen.ts suggestEntityType` — dieselbe Regel wie in der Admin-Brücke), und
 * diese Tabelle gibt ihm sein deutsches Wort. Ein geladener Katalog überschreibt
 * das Label; fehlt er (Kunden-Token), bleibt der Pfad vollständig bedienbar.
 */
const TYPE_LABELS: Record<string, string> = {
  producer: 'PV-Erzeuger',
  'grid-meter': 'Netz-Zähler',
  wallbox: 'Wallbox',
  'heating-rod': 'Heizstab',
  'generic-load': 'Verbraucher',
  'modbus-generic': 'Messgerät',
};

/** Typen, die der geführte Kundenpfad übernehmen darf (nie `battery-hybrid`). */
const CUSTOMER_ADOPTABLE = Object.keys(TYPE_LABELS);

/** Steuerbare Typen — nur sie bekommen die „Regel anlegen?"-Brücke. */
const CONTROLLABLE_TYPES = ['wallbox', 'heating-rod', 'generic-load'];

export function typeLabel(entityType: string, catalogLabel?: string | null): string {
  return catalogLabel ?? TYPE_LABELS[entityType] ?? entityType;
}

/** Ein Eingabefeld der geführten Adoption — nur, was NUR der Kunde weiß. */
export interface AdoptionField {
  id: 'kwp' | 'mastr' | 'leistung';
  label: string;
  placeholder: string;
  /** true = Pflichtfeld; alles andere darf leer bleiben. */
  required: boolean;
}

export interface AdoptionPlan {
  sourceId: string;
  /** Der vorgeschlagene Katalog-Typ — im geführten Pfad NICHT frei wählbar. */
  entityType: string;
  typeLabel: string;
  /** „Als Wallbox übernehmen" */
  actionLabel: string;
  /** Was Ihr Gerät meldet (Marke · Modell). */
  summary: string;
  roleLabel: string;
  fields: AdoptionField[];
  /** false = kein sicherer Vorschlag ⇒ der geführte Pfad übernimmt NICHT. */
  guided: boolean;
}

const FIELD_KWP: AdoptionField = {
  id: 'kwp',
  label: 'Anlagenleistung (kWp)',
  placeholder: 'z. B. 9,8',
  required: false,
};
const FIELD_MASTR: AdoptionField = {
  id: 'mastr',
  label: 'MaStR-Nummer (optional)',
  placeholder: 'SEE…',
  required: false,
};
const FIELD_LEISTUNG: AdoptionField = {
  id: 'leistung',
  label: 'Anschlussleistung (kW)',
  placeholder: 'z. B. 11',
  required: false,
};

/**
 * Der katalog-geführte Übernahme-Plan einer gemeldeten Quelle (F6): der Typ
 * kommt aus dem Katalog-Vorschlag, gefragt wird der Kunde **nur** nach dem, was
 * nur er weiß (kWp, MaStR, Anschlussleistung). **Keine freie Guard-Eingabe,
 * keine freie Typwahl** — das bleibt der Admin-Brücke vorbehalten.
 */
export function adoptionPlan(
  source: AdoptableSource,
  catalogLabel?: string | null,
): AdoptionPlan {
  const entityType = source.suggestedType ?? '';
  const guided = CUSTOMER_ADOPTABLE.includes(entityType);
  const label = guided ? typeLabel(entityType, catalogLabel) : '';
  const fields: AdoptionField[] =
    entityType === 'producer'
      ? [FIELD_KWP, FIELD_MASTR]
      : CONTROLLABLE_TYPES.includes(entityType)
        ? [FIELD_LEISTUNG]
        : [];
  return {
    sourceId: source.id,
    entityType,
    typeLabel: label,
    actionLabel: guided ? `Als ${label} übernehmen` : 'Übernehmen',
    summary: source.summary,
    roleLabel: source.roleLabel,
    fields,
    guided,
  };
}

/** Nur die Quellen, die der geführte Kundenpfad sicher übernehmen kann. */
export function guidedAdoptions(
  reported: AdoptableSource[] | null | undefined,
  catalogLabels?: Record<string, string> | null,
): AdoptionPlan[] {
  return (reported ?? [])
    .map((s) => adoptionPlan(s, catalogLabels?.[s.suggestedType ?? ''] ?? null))
    .filter((p) => p.guided);
}

/** Quellen, für die es keinen sicheren Vorschlag gibt — ehrlich benannt. */
export const UNGUIDED_HINT =
  'Für dieses Gerät braucht es eine Einordnung durch VoltPilot - wir melden uns.';

/**
 * Die Brücke nach der Übernahme (report §4 Schritt 1): ein **steuerbares**
 * Gerät bekommt sofort das Angebot, eine Regel dafür anzulegen; alles andere
 * bestätigt nur die Übernahme (nie eine Regel für einen Zähler anbieten).
 */
export interface AdoptedBridge {
  /** „«Wallbox Carport» übernommen." */
  text: string;
  /** null = keine Regel-Brücke (Zähler/Erzeuger). */
  cta: string | null;
  ctaHint: string | null;
}

export function adoptedBridge(input: {
  entityType: string;
  label?: string | null;
  typeLabel?: string | null;
}): AdoptedBridge {
  const name = (input.label ?? '').trim() || typeLabel(input.entityType, input.typeLabel);
  const controllable = CONTROLLABLE_TYPES.includes(input.entityType);
  return {
    text: `„${name}" übernommen.`,
    cta: controllable ? 'Regel dafür anlegen?' : null,
    ctaHint: controllable
      ? 'Zum Beispiel: nur laden, wenn die Sonne scheint.'
      : null,
  };
}

/** Die ehrliche Meldung, wenn das Backend die Übernahme (noch) nicht erlaubt. */
export const ADOPT_FORBIDDEN_MSG =
  'Dieses Gerät kann VoltPilot für Sie übernehmen - bitte sprechen Sie uns an. '
  + 'Ihre Anlage bleibt davon unberührt.';

export const ADOPT_FAILED_MSG =
  'Das Gerät konnte gerade nicht übernommen werden. Bitte versuchen Sie es erneut.';
