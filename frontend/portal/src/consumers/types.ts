/**
 * Shared TS types for the steuerbare-Verbraucher surface (Increment 1). The
 * policy document mirrors docs/contracts/v2/consumer-policy.schema.json; the API
 * DTOs mirror services/api ConsumerService. Kept minimal - only what the wizard,
 * the rule builder and the validator read.
 */

export type ControlKind = 'on_off' | 'stepped' | 'continuous';
export type RequirementKind = 'reactive' | 'fixed_window' | 'flexible_task' | 'opportunistic';
export type Enforcement = 'must_run' | 'required_by_deadline' | 'opportunistic';
export type GridEnergyPolicy = 'allow' | 'avoid' | 'forbid';
export type Failsafe = 'off' | 'release';
export type TargetKind = 'on_off' | 'percent' | 'kw' | 'mode';
export type Operator = 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'ne';
export type RecurrenceDays = 'daily' | 'weekdays' | 'weekend';

export interface PolicyTarget {
  kind: TargetKind;
  value: boolean | number | string;
}

export interface ConditionLeaf {
  signal: string;
  operator: Operator;
  value: number | boolean;
  reset_value?: number;
  max_age_s?: number;
}

export type Condition =
  | ConditionLeaf
  | { any: Condition[] }
  | { all: Condition[] }
  | { not: Condition };

export interface Recurrence {
  days: RecurrenceDays;
  from: string;
  to: string;
}

export interface Demand {
  runtime_minutes?: number;
  energy_kwh?: number;
  contiguous?: boolean;
}

export interface ControlProfileSnapshot {
  control_kind: ControlKind;
  rated_power_kw: number;
  min_power_kw?: number;
  resolution_kw?: number;
  levels_kw?: number[];
  power_ranges_kw?: number[][];
}

export interface Requirement {
  id: string;
  name?: string;
  active?: boolean;
  kind: RequirementKind;
  enforcement: Enforcement;
  target: PolicyTarget;
  condition?: Condition;
  recurrence?: Recurrence;
  demand?: Demand;
  grid_energy_policy?: GridEnergyPolicy;
  allow_storage_discharge?: boolean;
  service_rank?: number;
}

export interface ConsumerPolicyDocument {
  schema_version: '1.0';
  entity_id: string;
  timezone?: string;
  control_profile?: ControlProfileSnapshot;
  requirements: Requirement[];
}

// --- API DTOs (mirror services/api ConsumerService) ------------------------

export interface Consumer {
  id: string;
  type: string;
  typeLabel: string;
  name: string;
  controlKind: ControlKind;
  ratedPowerKw: number;
  minPowerKw: number | null;
  levelsKw: number[] | null;
  resolutionKw: number | null;
  powerRangesKw: number[][] | null;
  storageRelation: 'consumer_first' | 'storage_first';
  defaultGridEnergyPolicy: GridEnergyPolicy;
  allowStorageDischarge: boolean;
  failsafe: Failsafe;
  enabled: boolean;
  version: number;
  connection: 'connected' | 'disconnected';
  edgeSourceId: string | null;
  /**
   * Derived server-side (Inkrement 4): 'active' = an active policy is in
   * force, 'paused' = active policy with the pause failsafe, else the honest
   * 'not_activated'.
   */
  controlActivation: 'not_activated' | 'active' | 'paused';
  hasDraftPolicy: boolean;
  draftPolicyVersion: number | null;
  /**
   * The D3 confirmation channel derived at creation from the bound edge
   * source (services/api ConsumerService): 'power_kw' = proven power
   * measurement (Stufe 2), 'relay_state' = relay readback only (Stufe 3,
   * energy "angenommen"), null = unbound draft / a consumer created before
   * this field existed (then the TYPE default decides, the pre-existing
   * behavior).
   */
  confirmationChannel?: string | null;
}

export interface ConsumerTypeOption {
  type: string;
  label: string;
  controlKinds: ControlKind[];
  defaultFailsafe: Failsafe;
  releaseAllowed: boolean;
  intents: string[];
  /**
   * SERVER-Wahrheit, ob die Nennleistung angegeben werden MUSS (P8). Die
   * SG-Ready-Wärmepumpe darf sie weglassen: sie ist eine Angabe ÜBER die Pumpe,
   * kein Steuerwert - geschaltet wird eine Freigabe. `undefined` (älteres
   * Backend) heißt „wie bisher": Pflicht.
   */
  ratedPowerRequired?: boolean;
}

export interface ConsumerSignalOption {
  name: string;
  label: string;
  signalClass: 'cloud' | 'local';
  valueType: 'number' | 'boolean';
}

export interface ConsumerIntentOption {
  key: string;
  title: string;
  customerLine: string;
}

export interface ConsumerReportedSource {
  sourceId: string;
  label: string | null;
  brand: string | null;
  role: string | null;
  /**
   * The source PROVABLY measures power (its reported reading carries
   * load_kw - a metering Shelly 1PM / go-e). false = no proven measurement
   * (a bare relay, or not reported yet); absent = an older backend (no
   * claim either way).
   */
  measuresPower?: boolean;
  health: 'ok' | 'stale' | 'never';
}

export interface ConsumerOptions {
  types: ConsumerTypeOption[];
  signals: ConsumerSignalOption[];
  intents: ConsumerIntentOption[];
  hasStorage: boolean;
  reportedSources: ConsumerReportedSource[];
  defaultStorageRelation: 'consumer_first' | 'storage_first';
  defaultGridEnergyPolicy: GridEnergyPolicy;
  /**
   * Whether the environment can really activate a rule (Inkrement 4 flags:
   * consumer control + policy compiler). OPTIONAL so an older backend reads as
   * false - the surface then stays byte-identical to Increment 1 ("Steuerung
   * noch nicht aktiviert"), never a button that dead-ends.
   */
  policyActivationEnabled?: boolean;
}

export interface ConsumerPolicyVersion {
  entityId: string;
  version: number;
  lifecycle: 'draft' | 'active' | 'retired';
  document: ConsumerPolicyDocument;
  contentHash: string;
  createdBy: string | null;
}
