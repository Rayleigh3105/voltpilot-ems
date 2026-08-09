/**
 * The consumer rule builder's policy model (docs/verbrauchssteuerung.md §14.5/
 * §14.7). PURE + unit-tested: `buildPolicyDocument` projects a ConsumerDraft
 * onto ONE consumer-policy-document requirement (validated by validate.ts before
 * save), and `policySentence` renders the SAME document as the permanent German
 * preview - so the sentence and the stored document can never disagree. The
 * review (`reviewFacts`) reads the document too, naming every auto-set fact in
 * Klartext (§14.7).
 *
 * Increment 1 authors a DRAFT: there is no compiler/optimizer/edge command yet,
 * so a flexible task carries the honest §14.7 note "Bei Verbindungsausfall kann
 * diese Aufgabe entfallen." until the local deadline fallback (Increment 6).
 */
import type {
  Condition,
  ConditionLeaf,
  ConsumerPolicyDocument,
  ControlProfileSnapshot,
  PolicyTarget,
  Requirement,
} from './types';
import type { ConsumerContext, ConsumerDraft } from './questions';
import { effectiveEnforcement } from './questions';
import { findSignal } from './signals';

const DEFAULT_TZ = 'Europe/Berlin';

export interface BuildOptions {
  entityId: string;
  requirementId: string;
  ctx: ConsumerContext;
  controlProfile: ControlProfileSnapshot;
  name?: string;
  timezone?: string;
}

/** Project the draft onto a single-requirement consumer-policy document. */
export function buildPolicyDocument(draft: ConsumerDraft, opts: BuildOptions): ConsumerPolicyDocument {
  const enforcement = effectiveEnforcement(draft);
  const req: Requirement = {
    id: opts.requirementId,
    kind: intentToKind(draft),
    enforcement,
    target: normalizeTarget(draft.target),
  };
  if (opts.name && opts.name.trim()) {
    req.name = opts.name.trim();
  }

  if (draft.intent === 'react' || draft.intent === 'cheap') {
    req.condition = buildCondition(draft);
  }
  if (draft.intent === 'schedule' || draft.intent === 'deadline') {
    req.recurrence = { days: draft.recurrence.days, from: draft.recurrence.from, to: draft.recurrence.to };
  }
  if (draft.intent === 'deadline') {
    req.demand = buildDemand(draft);
  }

  // must_run forces grid allow (server enforces too); only a non-must_run rule
  // carries an explicit grid policy.
  if (enforcement !== 'must_run') {
    req.grid_energy_policy = draft.gridEnergyPolicy;
  }
  if (opts.ctx.hasStorage) {
    req.allow_storage_discharge = draft.allowStorageDischarge;
  }

  return {
    schema_version: '1.0',
    entity_id: opts.entityId,
    timezone: opts.timezone ?? DEFAULT_TZ,
    control_profile: opts.controlProfile,
    requirements: [req],
  };
}

function intentToKind(draft: ConsumerDraft): Requirement['kind'] {
  switch (draft.intent) {
    case 'react': return 'reactive';
    case 'schedule': return 'fixed_window';
    case 'deadline': return 'flexible_task';
    case 'cheap': return 'opportunistic';
    default: return 'reactive';
  }
}

function normalizeTarget(t: PolicyTarget): PolicyTarget {
  return { kind: t.kind, value: t.value };
}

function buildCondition(draft: ConsumerDraft): Condition {
  const leaves: ConditionLeaf[] = draft.conditions.map((c) => {
    const leaf: ConditionLeaf = { signal: c.signal, operator: c.operator, value: c.value };
    // Hysteresis only on LOCAL signals (a cloud signal must not carry it, D1).
    if (findSignal(c.signal)?.signalClass === 'local') {
      if (typeof c.resetValue === 'number') leaf.reset_value = c.resetValue;
      if (typeof c.maxAgeS === 'number') leaf.max_age_s = c.maxAgeS;
    }
    return leaf;
  });
  if (leaves.length === 1) {
    return leaves[0];
  }
  return draft.combinator === 'and' ? { all: leaves } : { any: leaves };
}

function buildDemand(draft: ConsumerDraft): Requirement['demand'] {
  if (draft.demandMode === 'energy') {
    return { energy_kwh: draft.energyKwh ?? 0 };
  }
  return { runtime_minutes: draft.runtimeMinutes ?? 0, contiguous: draft.contiguous };
}

// --- sentence preview (§14.5) ----------------------------------------------

const DAY_WORD: Record<string, string> = {
  daily: 'Täglich', weekdays: 'An Werktagen', weekend: 'Am Wochenende',
};

/** The permanent German preview of the WHOLE policy (§14.5). */
export function policySentence(doc: ConsumerPolicyDocument, consumerName: string): string {
  return doc.requirements.map((r) => requirementSentence(r, consumerName)).join(' ');
}

function requirementSentence(r: Requirement, name: string): string {
  const parts: string[] = [];
  const action = targetPhrase(r.target, name);

  if (r.kind === 'reactive') {
    parts.push(`Wenn ${conditionPhrase(r.condition)}, ${action}.`);
  } else if (r.kind === 'opportunistic') {
    parts.push(`Wenn günstig und ${conditionPhrase(r.condition)}, ${action} — ohne Pflicht.`);
  } else if (r.kind === 'fixed_window') {
    parts.push(`${windowPhrase(r)} ${action}.`);
  } else {
    // flexible_task
    parts.push(`${demandPhrase(r)} VoltPilot wählt den besten Zeitpunkt.`);
  }

  parts.push(gridSentence(r));
  const storage = storageSentence(r);
  if (storage) parts.push(storage);

  if (r.kind === 'flexible_task') {
    // §14.7: until the local deadline fallback (Increment 6) exists.
    parts.push('Bei Verbindungsausfall kann diese Aufgabe entfallen.');
  }
  parts.push('Geräteschutz und Netzvorgaben bleiben wirksam.');
  return parts.filter(Boolean).join(' ');
}

function targetPhrase(t: PolicyTarget, name: string): string {
  switch (t.kind) {
    case 'on_off':
      return t.value === true ? `schaltet VoltPilot ${name} ein` : `schaltet VoltPilot ${name} aus`;
    case 'percent':
      return `betreibt VoltPilot ${name} mit ${fmt(t.value)} %`;
    case 'kw':
      return `betreibt VoltPilot ${name} mit ${fmt(t.value)} kW`;
    case 'mode':
      return `stellt VoltPilot ${name} auf Modus „${t.value}“`;
    default:
      return `steuert VoltPilot ${name}`;
  }
}

function conditionPhrase(c: Condition | undefined): string {
  if (!c) return 'die Bedingung gilt';
  if ('all' in c) {
    return c.all.map(conditionPhrase).join(' und ');
  }
  if ('any' in c) {
    return c.any.map(conditionPhrase).join(' oder ');
  }
  if ('not' in c) {
    return `nicht (${conditionPhrase(c.not)})`;
  }
  return leafPhrase(c);
}

function leafPhrase(c: ConditionLeaf): string {
  const sig = findSignal(c.signal);
  const label = sig?.label ?? c.signal;
  if (sig?.valueType === 'boolean') {
    const on = c.value === true;
    if (c.signal === 'consumer.vehicle_connected') return on ? 'das Fahrzeug verbunden ist' : 'kein Fahrzeug verbunden ist';
    if (c.signal === 'consumer.available') return on ? 'das Gerät verfügbar ist' : 'das Gerät nicht verfügbar ist';
    return on ? `${label} zutrifft` : `${label} nicht zutrifft`;
  }
  const op = operatorWord(c.operator);
  const unit = signalUnit(c.signal);
  const subject = signalSubject(c.signal);
  // Threshold comparisons read "… liegt"; eq/ne read "… ist".
  const verb = c.operator === 'eq' || c.operator === 'ne' ? 'ist' : 'liegt';
  return `${subject} ${op} ${fmt(c.value)}${unit} ${verb}`;
}

function operatorWord(op: string): string {
  switch (op) {
    case 'lt': return 'unter';
    case 'lte': return 'höchstens';
    case 'gt': return 'über';
    case 'gte': return 'mindestens';
    case 'eq': return 'gleich';
    case 'ne': return 'ungleich';
    default: return op;
  }
}

function signalSubject(name: string): string {
  switch (name) {
    case 'market.spot_price_ct_kwh': return 'der Börsenpreis';
    case 'market.import_price_ct_kwh': return 'Ihr Bezugspreis';
    case 'storage.soc_pct': return 'der Speicher-Ladestand';
    case 'site.pv_surplus_kw': return 'der PV-Überschuss';
    case 'site.grid_power_kw': return 'der Netzfluss';
    default: return name;
  }
}

function signalUnit(name: string): string {
  if (name.endsWith('_ct_kwh')) return ' ct/kWh';
  if (name === 'storage.soc_pct') return ' %';
  if (name.endsWith('_kw')) return ' kW';
  return '';
}

function windowPhrase(r: Requirement): string {
  const rec = r.recurrence;
  if (!rec) return 'Zu festen Zeiten';
  const day = DAY_WORD[rec.days] ?? rec.days;
  return `${day} von ${rec.from} bis ${rec.to} Uhr`;
}

function demandPhrase(r: Requirement): string {
  const d = r.demand;
  const rec = r.recurrence;
  const until = rec ? ` (Fenster ${rec.from}–${rec.to} Uhr)` : '';
  if (d?.energy_kwh) {
    return `VoltPilot erledigt bis zur Frist eine Energiemenge von ${fmt(d.energy_kwh)} kWh${until}.`;
  }
  const cont = d?.contiguous ? 'zusammenhängend ' : 'aufteilbar ';
  return `VoltPilot erledigt bis zur Frist ${cont}eine Laufzeit von ${fmt(d?.runtime_minutes ?? 0)} Minuten${until}.`;
}

function gridSentence(r: Requirement): string {
  if (r.enforcement === 'must_run') {
    return 'Netzstrom ist erlaubt.';
  }
  switch (r.grid_energy_policy) {
    case 'forbid': return 'Es wird kein Netzstrom verwendet.';
    case 'avoid': return 'Netzstrom wird möglichst vermieden.';
    default: return 'Netzstrom ist erlaubt.';
  }
}

function storageSentence(r: Requirement): string | null {
  if (r.allow_storage_discharge === undefined) return null;
  return r.allow_storage_discharge
    ? 'Der Speicher darf dafür entladen werden.'
    : 'Der Speicher darf dafür nicht entladen werden.';
}

function fmt(v: number | string | boolean): string {
  if (typeof v === 'number') {
    return v.toLocaleString('de-DE', { maximumFractionDigits: 2 });
  }
  return String(v);
}

// --- review (§14.7) --------------------------------------------------------

export interface ReviewItem {
  label: string;
  value: string;
}

/**
 * The Prüfseite facts (§14.7): every auto-set fact in Klartext. The default
 * (no `activationEnabled`) keeps the Increment-1 wording byte-identical - an
 * older environment never promises an activation it cannot perform.
 */
export function reviewFacts(
  doc: ConsumerPolicyDocument,
  consumerName: string,
  activationEnabled = false,
): ReviewItem[] {
  const items: ReviewItem[] = [];
  const r = doc.requirements[0];
  items.push({ label: 'Verbraucher', value: consumerName });
  if (doc.control_profile) {
    items.push({ label: 'Wirksame maximale Leistung', value: `${fmt(doc.control_profile.rated_power_kw)} kW` });
  }
  items.push({ label: 'Regel', value: policySentence(doc, consumerName) });
  items.push({ label: 'Netzstrom', value: gridSentence(r) });
  const storage = storageSentence(r);
  if (storage) items.push({ label: 'Speicher', value: storage });
  items.push({ label: 'Bei fehlenden Signalen', value: 'Der Verbraucher schaltet aus (Failsafe).' });
  items.push({
    label: 'Aktivierung',
    value: activationEnabled
      ? 'Nach dem Aktivieren steuert VoltPilot den Verbraucher nach dieser Regel.'
      : 'Steuerung noch nicht aktiviert - die Regel wird als Entwurf gespeichert.',
  });
  return items;
}
