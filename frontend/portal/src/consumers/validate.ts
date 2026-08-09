/**
 * Client-side validator of a consumer-policy document - the TS twin of the api's
 * ConsumerPolicyValidator (services/api .../consumers/ConsumerPolicyValidator.java),
 * enforcing the SEMANTIC rules JSON Schema cannot express: kind/enforcement
 * coherence, must_run => grid allow, condition-tree depth/size, cloud-vs-local
 * signal hysteresis (D1), catalog signal names, target value coherence,
 * recurrence windows, the D4 power_ranges_kw disjointness and the levels/min/
 * resolution rules. The shared vectors (docs/contracts/v2/consumer-policy-
 * vectors.json) keep the two in lockstep - change both together (the
 * FlowGraphValidator / EdgeRef precedent). Runs LIVE in the rule builder; the
 * server re-validates on save (the authoritative gate).
 */
import { findSignal } from './signals';

export interface ConsumerFinding {
  rule: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export const MAX_REQUIREMENTS = 32;
export const MAX_TREE_DEPTH = 4;
export const MAX_TREE_NODES = 24;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const CHANNEL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const KINDS = new Set(['reactive', 'fixed_window', 'flexible_task', 'opportunistic']);
const ENFORCEMENTS = new Set(['must_run', 'required_by_deadline', 'opportunistic']);
const OPERATORS = new Set(['lt', 'lte', 'gt', 'gte', 'eq', 'ne']);
const TARGET_KINDS = new Set(['on_off', 'percent', 'kw', 'mode']);
const GRID_POLICIES = new Set(['allow', 'avoid', 'forbid']);
const DAYS = new Set(['daily', 'weekdays', 'weekend']);
const CONTROL_KINDS = new Set(['on_off', 'stepped', 'continuous']);

type Obj = Record<string, unknown>;

function err(rule: string, path: string, message: string): ConsumerFinding {
  return { rule, severity: 'error', path, message };
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isValid(findings: ConsumerFinding[]): boolean {
  return findings.every((f) => f.severity !== 'error');
}

export function validatePolicy(doc: unknown): ConsumerFinding[] {
  const out: ConsumerFinding[] = [];
  if (!isObj(doc)) {
    out.push(err('schema', '$', 'Das Regeldokument ist leer oder ungültig.'));
    return out;
  }
  if (doc.schema_version !== '1.0') {
    out.push(err('schema', '$.schema_version', 'Unbekannte Schemaversion.'));
  }
  if (typeof doc.entity_id !== 'string' || doc.entity_id.trim() === '') {
    out.push(err('schema', '$.entity_id', 'entity_id fehlt.'));
  }
  if ('control_profile' in doc) {
    validateControlProfile(doc.control_profile, '$.control_profile', out);
  }
  const reqs = doc.requirements;
  if (!Array.isArray(reqs) || reqs.length === 0) {
    out.push(err('empty_requirements', '$.requirements',
      'Es muss mindestens eine Regel oder Aufgabe geben.'));
    return out;
  }
  if (reqs.length > MAX_REQUIREMENTS) {
    out.push(err('too_many_requirements', '$.requirements',
      'Zu viele Regeln für einen Verbraucher.'));
  }
  const ids = new Set<string>();
  reqs.forEach((r, i) => validateRequirement(r, `$.requirements[${i}]`, ids, out));
  return out;
}

/** Validate ONLY a control-profile object (the Stammdaten write path). */
export function validateControlProfileOnly(profile: unknown): ConsumerFinding[] {
  const out: ConsumerFinding[] = [];
  validateControlProfile(profile, '$', out);
  return out;
}

function validateRequirement(r: unknown, path: string, ids: Set<string>, out: ConsumerFinding[]): void {
  if (!isObj(r)) {
    out.push(err('schema', path, 'Ungültige Regel.'));
    return;
  }
  const id = typeof r.id === 'string' ? r.id : '';
  if (!ID_PATTERN.test(id)) {
    out.push(err('schema', `${path}.id`, 'Ungültige Regel-Kennung.'));
  } else if (ids.has(id)) {
    out.push(err('duplicate_requirement_id', `${path}.id`, 'Zwei Regeln tragen dieselbe Kennung.'));
  } else {
    ids.add(id);
  }

  const kind = r.kind;
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    out.push(err('invalid_kind', `${path}.kind`, 'Unbekannte Regelart.'));
    return;
  }
  const enforcement = r.enforcement;
  if (typeof enforcement !== 'string' || !ENFORCEMENTS.has(enforcement)) {
    out.push(err('invalid_enforcement', `${path}.enforcement`, 'Unbekannte Verbindlichkeit.'));
    return;
  }

  validateTarget(r.target, `${path}.target`, out);

  const hasCondition = 'condition' in r;
  const hasDemand = 'demand' in r;
  const hasRecurrence = 'recurrence' in r;

  switch (kind) {
    case 'reactive':
      if (!hasCondition) {
        out.push(err('reactive_needs_condition', `${path}.condition`,
          'Eine Sofort-Regel braucht eine Bedingung.'));
      }
      if (hasDemand) {
        out.push(err('field_foreign_to_kind', `${path}.demand`,
          'Eine Sofort-Regel hat keine Aufgabe mit Menge.'));
      }
      if (enforcement !== 'must_run' && enforcement !== 'opportunistic') {
        out.push(err('enforcement_kind_mismatch', `${path}.enforcement`,
          'Diese Verbindlichkeit passt nicht zur Sofort-Regel.'));
      }
      break;
    case 'fixed_window':
      if (!hasRecurrence) {
        out.push(err('fixed_window_needs_recurrence', `${path}.recurrence`,
          'Eine Zeitregel braucht ein Zeitfenster.'));
      }
      if (hasCondition || hasDemand) {
        out.push(err('field_foreign_to_kind', path,
          'Eine Zeitregel trägt weder Bedingung noch Aufgabenmenge.'));
      }
      if (enforcement !== 'must_run' && enforcement !== 'opportunistic') {
        out.push(err('enforcement_kind_mismatch', `${path}.enforcement`,
          'Diese Verbindlichkeit passt nicht zur Zeitregel.'));
      }
      break;
    case 'flexible_task':
      if (enforcement !== 'required_by_deadline') {
        out.push(err('enforcement_kind_mismatch', `${path}.enforcement`,
          'Eine flexible Aufgabe ist bis zu einer Frist zu erledigen.'));
      }
      if (hasCondition) {
        out.push(err('field_foreign_to_kind', `${path}.condition`,
          'Eine flexible Aufgabe trägt keine Bedingung.'));
      }
      if (!hasDemand) {
        out.push(err('flexible_needs_demand', `${path}.demand`,
          'Eine flexible Aufgabe braucht eine Menge oder Laufzeit.'));
      }
      break;
    case 'opportunistic':
      if (enforcement !== 'opportunistic') {
        out.push(err('enforcement_kind_mismatch', `${path}.enforcement`,
          'Ein Gelegenheitsbetrieb hat keine Pflicht.'));
      }
      if (hasDemand) {
        out.push(err('field_foreign_to_kind', `${path}.demand`,
          'Ein Gelegenheitsbetrieb trägt keine Aufgabenmenge.'));
      }
      break;
  }

  if ('grid_energy_policy' in r && r.grid_energy_policy != null) {
    const policy = r.grid_energy_policy;
    if (typeof policy !== 'string' || !GRID_POLICIES.has(policy)) {
      out.push(err('schema', `${path}.grid_energy_policy`, 'Unbekannte Netzstrom-Einstellung.'));
    } else if (enforcement === 'must_run' && policy !== 'allow') {
      out.push(err('must_run_grid_conflict', `${path}.grid_energy_policy`,
        'Ein Pflichtlauf erlaubt Netzstrom automatisch und kann ihn nicht verbieten.'));
    }
  }

  if (hasCondition) {
    validateCondition(r.condition, `${path}.condition`, 1, { count: 0 }, out);
  }
  if (hasRecurrence) {
    validateRecurrence(r.recurrence, `${path}.recurrence`, out);
  }
  if (hasDemand) {
    validateDemand(r.demand, `${path}.demand`, out);
  }
}

function validateTarget(t: unknown, path: string, out: ConsumerFinding[]): void {
  if (!isObj(t)) {
    out.push(err('schema', path, 'Das Ziel fehlt.'));
    return;
  }
  const kind = t.kind;
  if (typeof kind !== 'string' || !TARGET_KINDS.has(kind)) {
    out.push(err('schema', `${path}.kind`, 'Unbekannte Zielart.'));
    return;
  }
  const v = t.value;
  let ok = false;
  switch (kind) {
    case 'on_off': ok = typeof v === 'boolean'; break;
    case 'percent': ok = isNum(v) && v >= 0 && v <= 100; break;
    case 'kw': ok = isNum(v) && v >= 0; break;
    case 'mode': ok = typeof v === 'string' && v.trim() !== ''; break;
  }
  if (!ok) {
    out.push(err('target_value_type', `${path}.value`, 'Der Zielwert passt nicht zur Zielart.'));
  }
}

function validateCondition(c: unknown, path: string, depth: number, counter: { count: number },
  out: ConsumerFinding[]): void {
  if (!isObj(c)) {
    out.push(err('schema', path, 'Ungültige Bedingung.'));
    return;
  }
  if (depth > MAX_TREE_DEPTH) {
    out.push(err('condition_tree_too_deep', path, 'Die Bedingung ist zu tief verschachtelt.'));
    return;
  }
  if (++counter.count > MAX_TREE_NODES) {
    out.push(err('condition_tree_too_large', path, 'Die Bedingung hat zu viele Teile.'));
    return;
  }
  if ('any' in c || 'all' in c) {
    const group = 'any' in c ? c.any : c.all;
    if (!Array.isArray(group) || group.length === 0) {
      out.push(err('schema', path, 'Eine Gruppe braucht Bedingungen.'));
      return;
    }
    group.forEach((child, i) => validateCondition(child, `${path}[${i}]`, depth + 1, counter, out));
    return;
  }
  if ('not' in c) {
    validateCondition(c.not, `${path}.not`, depth + 1, counter, out);
    return;
  }
  // Leaf.
  const signalName = typeof c.signal === 'string' ? c.signal : '';
  const sig = findSignal(signalName);
  if (!sig) {
    out.push(err('unknown_signal', `${path}.signal`, 'Dieses Signal kennt VoltPilot nicht.'));
    return;
  }
  if (typeof c.operator !== 'string' || !OPERATORS.has(c.operator)) {
    out.push(err('schema', `${path}.operator`, 'Unbekannter Vergleich.'));
  }
  const valueOk = sig.valueType === 'boolean'
    ? typeof c.value === 'boolean'
    : isNum(c.value);
  if (!valueOk) {
    out.push(err('signal_value_type', `${path}.value`, 'Der Vergleichswert passt nicht zum Signal.'));
  }
  const hasHysteresis = 'reset_value' in c || 'max_age_s' in c;
  if (hasHysteresis && sig.signalClass === 'cloud') {
    out.push(err('cloud_signal_hysteresis', path,
      'Preis- und Zeitbedingungen werden vorausberechnet und brauchen keine Hysterese.'));
  }
}

function validateRecurrence(rec: unknown, path: string, out: ConsumerFinding[]): void {
  if (!isObj(rec)) {
    out.push(err('schema', path, 'Ungültiges Zeitfenster.'));
    return;
  }
  if (typeof rec.days !== 'string' || !DAYS.has(rec.days)) {
    out.push(err('schema', `${path}.days`, 'Unbekannter Tagesbezug.'));
  }
  const from = typeof rec.from === 'string' ? rec.from : '';
  const to = typeof rec.to === 'string' ? rec.to : '';
  const fromOk = TIME_PATTERN.test(from);
  const toOk = TIME_PATTERN.test(to) || to === '24:00';
  if (!fromOk || !toOk) {
    out.push(err('schema', path, 'Ungültige Uhrzeit im Zeitfenster.'));
    return;
  }
  if (from === to) {
    out.push(err('recurrence_invalid_window', path, 'Anfang und Ende des Zeitfensters sind gleich.'));
  }
}

function validateDemand(d: unknown, path: string, out: ConsumerFinding[]): void {
  if (!isObj(d)) {
    out.push(err('schema', path, 'Ungültige Aufgabe.'));
    return;
  }
  const hasRuntime = isNum(d.runtime_minutes) && d.runtime_minutes > 0;
  const hasEnergy = isNum(d.energy_kwh) && d.energy_kwh > 0;
  if (!hasRuntime && !hasEnergy) {
    out.push(err('demand_empty', path, 'Eine Aufgabe braucht eine Laufzeit oder eine Energiemenge.'));
  }
  if (typeof d.contiguous === 'boolean' && !hasRuntime) {
    out.push(err('contiguous_without_runtime', `${path}.contiguous`,
      'Zusammenhängend/aufteilbar gilt nur für eine Laufzeitaufgabe.'));
  }
}

function validateControlProfile(p: unknown, path: string, out: ConsumerFinding[]): void {
  if (!isObj(p)) {
    out.push(err('schema', path, 'Ungültiges Steuerprofil.'));
    return;
  }
  const kind = p.control_kind;
  if (typeof kind !== 'string' || !CONTROL_KINDS.has(kind)) {
    out.push(err('schema', `${path}.control_kind`, 'Unbekannte Regelart.'));
    return;
  }
  if (!isNum(p.rated_power_kw) || p.rated_power_kw <= 0) {
    out.push(err('schema', `${path}.rated_power_kw`, 'Die Nennleistung muss größer als 0 sein.'));
    return;
  }
  const rated = p.rated_power_kw;
  const hasLevels = 'levels_kw' in p;
  const hasRanges = 'power_ranges_kw' in p;
  const hasContinuousFields = 'min_power_kw' in p || 'resolution_kw' in p;

  switch (kind) {
    case 'on_off':
      if (hasContinuousFields || hasLevels) {
        out.push(err('profile_field_wrong_kind', path,
          'Ein Ein/Aus-Verbraucher hat keine Stufen oder Leistungsgrenzen.'));
      }
      if (hasRanges) {
        out.push(err('power_ranges_only_continuous', `${path}.power_ranges_kw`,
          'Leistungsbereiche gibt es nur bei stufenloser Regelung.'));
      }
      break;
    case 'stepped':
      if (hasContinuousFields) {
        out.push(err('profile_field_wrong_kind', path,
          'Feste Stufen haben keine Mindestleistung oder Auflösung.'));
      }
      if (hasRanges) {
        out.push(err('power_ranges_only_continuous', `${path}.power_ranges_kw`,
          'Leistungsbereiche gibt es nur bei stufenloser Regelung.'));
      }
      validateLevels(p.levels_kw, rated, `${path}.levels_kw`, out);
      break;
    case 'continuous':
      if (hasLevels) {
        out.push(err('profile_field_wrong_kind', `${path}.levels_kw`,
          'Stufenlose Regelung hat keine feste Stufenliste.'));
      }
      if (hasRanges) {
        validatePowerRanges(p.power_ranges_kw, rated, `${path}.power_ranges_kw`, out);
      }
      break;
  }
}

function validateLevels(levels: unknown, rated: number, path: string, out: ConsumerFinding[]): void {
  if (!Array.isArray(levels) || levels.length < 2) {
    out.push(err('schema', path, 'Es fehlen die Leistungsstufen.'));
    return;
  }
  let hasZero = false;
  let prev = Number.NEGATIVE_INFINITY;
  for (const l of levels) {
    if (!isNum(l)) {
      out.push(err('schema', path, 'Eine Stufe ist keine Zahl.'));
      return;
    }
    if (l === 0) hasZero = true;
    if (l <= prev) {
      out.push(err('levels_not_ascending', path, 'Die Leistungsstufen müssen streng aufsteigen.'));
      return;
    }
    if (l > rated + 1e-9) {
      out.push(err('levels_exceed_rated', path, 'Eine Stufe ist größer als die Nennleistung.'));
      return;
    }
    prev = l;
  }
  if (!hasZero) {
    out.push(err('levels_need_zero', path, 'Die Stufenliste muss die Stufe 0 (Aus) enthalten.'));
  }
}

function validatePowerRanges(ranges: unknown, rated: number, path: string, out: ConsumerFinding[]): void {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    out.push(err('schema', path, 'Ungültige Leistungsbereiche.'));
    return;
  }
  let prevMax = Number.NEGATIVE_INFINITY;
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2 || !isNum(range[0]) || !isNum(range[1])) {
      out.push(err('schema', path, 'Ein Leistungsbereich braucht genau [min, max].'));
      return;
    }
    const min = range[0];
    const max = range[1];
    if (min < 0 || max <= min || min <= prevMax) {
      out.push(err('power_ranges_not_ascending', path,
        'Die Leistungsbereiche müssen aufsteigend und überschneidungsfrei sein.'));
      return;
    }
    if (max > rated + 1e-9) {
      out.push(err('power_ranges_exceed_rated', path,
        'Ein Leistungsbereich ist größer als die Nennleistung.'));
      return;
    }
    prevMax = max;
  }
}
