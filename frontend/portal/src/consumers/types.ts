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
  controlActivation: 'not_activated';
  hasDraftPolicy: boolean;
  draftPolicyVersion: number | null;
}

export interface ConsumerTypeOption {
  type: string;
  label: string;
  controlKinds: ControlKind[];
  defaultFailsafe: Failsafe;
  releaseAllowed: boolean;
  intents: string[];
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
}

export interface ConsumerPolicyVersion {
  entityId: string;
  version: number;
  lifecycle: 'draft' | 'active' | 'retired';
  document: ConsumerPolicyDocument;
  contentHash: string;
  createdBy: string | null;
}
