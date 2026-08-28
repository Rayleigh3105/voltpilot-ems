import type {
  OcppAction,
  OcppActionIntent,
  OcppConnectorState,
  OcppMeterSample,
  OcppStation,
  OcppTransaction,
} from './api';

export type OcppActionGroup = 'alltag' | 'betrieb' | 'protokoll';
export type OcppRole = 'operator' | 'site-admin' | 'platform-admin';
export type OcppFieldKind = 'text' | 'number' | 'datetime-local' | 'select' | 'textarea';

export interface OcppActionField {
  key: string;
  label: string;
  kind: OcppFieldKind;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string;
}

export interface OcppActionDefinition {
  action: string;
  label: string;
  group: OcppActionGroup;
  role: OcppRole;
  impact: string;
  confirmation: string;
  hard?: boolean;
  capability?: string;
  fields: OcppActionField[];
}

const connector: OcppActionField = {
  key: 'connectorId', label: 'Stecker', kind: 'number', required: true,
  defaultValue: '1', help: '0 adressiert die gesamte Station, sofern OCPP dies für die Aktion erlaubt.',
};
const idTag: OcppActionField = {
  key: 'idTag', label: 'Autorisierung (idTag)', kind: 'text', required: true,
  placeholder: 'max. 20 Zeichen', help: 'Wird im Journal und in späteren Ansichten maskiert.',
};

/** One canonical catalog: visibility, grouping, role copy and form all derive from it. */
export const OCPP_ACTIONS: OcppActionDefinition[] = [
  { action: 'RemoteStartTransaction', label: 'Laden starten', group: 'alltag', role: 'operator',
    impact: 'Fordert die Station auf, am gewählten freien Stecker eine Transaktion zu beginnen.',
    confirmation: 'Stecker und Autorisierung prüfen; danach wartet VoltPilot auf StartTransaction.',
    fields: [connector, idTag, { key: 'profileLimit', label: 'Optionales Limit', kind: 'number', placeholder: '11', help: 'kW; leer lässt das Stationsprofil unverändert.' }] },
  { action: 'RemoteStopTransaction', label: 'Laden stoppen', group: 'alltag', role: 'operator',
    impact: 'Beendet den ausgewählten laufenden Ladevorgang.', confirmation: 'Aktive Transaktion und bisher geladene Energie unmittelbar vor dem Senden prüfen.',
    fields: [{ key: 'transactionId', label: 'Transaktion', kind: 'number', required: true }] },
  { action: 'UnlockConnector', label: 'Stecker entriegeln', group: 'alltag', role: 'operator',
    impact: 'Fordert die mechanische Entriegelung an. Eine OCPP-Antwort beweist noch keinen offenen Stecker.',
    confirmation: 'Einen laufenden Ladevorgang möglichst zuerst beenden.', fields: [connector] },
  { action: 'ReserveNow', label: 'Reservieren', group: 'alltag', role: 'site-admin', capability: 'Reservation',
    impact: 'Reserviert den Stecker bis zum Ablaufzeitpunkt für die angegebene Autorisierung.',
    confirmation: 'Stecker, Ablauf und Autorisierung prüfen.', fields: [connector, idTag,
      { key: 'expiryDate', label: 'Ablauf', kind: 'datetime-local', required: true },
      { key: 'reservationId', label: 'Reservierungs-ID', kind: 'number', required: true, defaultValue: '1' },
      { key: 'parentIdTag', label: 'Optionaler parentIdTag', kind: 'text' }] },
  { action: 'CancelReservation', label: 'Reservierung aufheben', group: 'alltag', role: 'site-admin', capability: 'Reservation',
    impact: 'Hebt eine aktive Reservierung auf.', confirmation: 'Reservierungs-ID und zugehörigen Stecker prüfen.', fields: [connector,
      { key: 'reservationId', label: 'Reservierungs-ID', kind: 'number', required: true }] },
  { action: 'SetChargingProfile', label: 'Ladeprofil setzen', group: 'alltag', role: 'site-admin', capability: 'SmartCharging',
    impact: 'Setzt ein OCPP-TxProfile; die aktuell geltende Freigabe bleibt bis zum Readback ehrlich getrennt.',
    confirmation: 'Leistung, Einheit, Zweck und Stack-Level prüfen.', fields: [connector,
      { key: 'profileId', label: 'Profil-ID', kind: 'number', required: true, defaultValue: '1' },
      { key: 'stackLevel', label: 'Stack-Level', kind: 'number', required: true, defaultValue: '0' },
      { key: 'purpose', label: 'Zweck', kind: 'select', required: true, defaultValue: 'TxProfile', options: [
        { value: 'TxProfile', label: 'TxProfile' }, { value: 'TxDefaultProfile', label: 'TxDefaultProfile' }, { value: 'ChargePointMaxProfile', label: 'ChargePointMaxProfile' }] },
      { key: 'rateUnit', label: 'Einheit', kind: 'select', required: true, defaultValue: 'W', options: [{ value: 'W', label: 'Watt' }, { value: 'A', label: 'Ampere' }] },
      { key: 'limit', label: 'Limit', kind: 'number', required: true, placeholder: '11000' },
      { key: 'duration', label: 'Dauer in Sekunden', kind: 'number', placeholder: '3600' }] },
  { action: 'ClearChargingProfile', label: 'Ladeprofil löschen', group: 'alltag', role: 'site-admin', capability: 'SmartCharging',
    impact: 'Löscht nur Profile, die den angegebenen Filtern entsprechen.', confirmation: 'Filter und betroffene Profile prüfen.', fields: [
      { key: 'profileId', label: 'Profil-ID', kind: 'number' }, connector,
      { key: 'purpose', label: 'Zweck', kind: 'select', options: [{ value: '', label: 'alle Zwecke' }, { value: 'TxProfile', label: 'TxProfile' }, { value: 'TxDefaultProfile', label: 'TxDefaultProfile' }, { value: 'ChargePointMaxProfile', label: 'ChargePointMaxProfile' }] },
      { key: 'stackLevel', label: 'Stack-Level', kind: 'number' }] },
  { action: 'GetCompositeSchedule', label: 'Angewandten Ladeplan lesen', group: 'alltag', role: 'site-admin', capability: 'SmartCharging',
    impact: 'Liest den von der Station zusammengesetzten, tatsächlich angewandten Plan.', confirmation: 'Stecker, Zeitraum und Einheit prüfen.', fields: [connector,
      { key: 'duration', label: 'Dauer in Sekunden', kind: 'number', required: true, defaultValue: '3600' },
      { key: 'rateUnit', label: 'Einheit', kind: 'select', defaultValue: 'W', options: [{ value: 'W', label: 'Watt' }, { value: 'A', label: 'Ampere' }] }] },
  { action: 'ChangeAvailability', label: 'Verfügbarkeit ändern', group: 'betrieb', role: 'site-admin',
    impact: 'Setzt einen Stecker oder die Station auf betriebsbereit bzw. außer Betrieb. Eine laufende Transaktion kann die Änderung vormerken.',
    confirmation: 'Betroffene laufende Transaktionen werden vor dem Senden nochmals geprüft.', fields: [connector,
      { key: 'type', label: 'Zielzustand', kind: 'select', required: true, defaultValue: 'Operative', options: [{ value: 'Operative', label: 'Betriebsbereit' }, { value: 'Inoperative', label: 'Außer Betrieb' }] }] },
  { action: 'SoftReset', label: 'Sanft neu starten', group: 'betrieb', role: 'site-admin',
    impact: 'Unterbricht die Stationsverbindung kurz; alle Stecker sind betroffen.', confirmation: 'Die Station sollte innerhalb von drei Minuten wieder booten.', fields: [] },
  { action: 'HardReset', label: 'Hart neu starten', group: 'betrieb', role: 'platform-admin', hard: true,
    impact: 'Startet die gesamte Station hart neu. Laufende Ladevorgänge können abbrechen.',
    confirmation: 'Starke Bestätigung: Der Server erzeugt eine einmalige Phrase; Wirkung wird bis zu zehn Minuten beobachtet.', fields: [] },
  { action: 'GetDiagnostics', label: 'Diagnose anfordern', group: 'betrieb', role: 'platform-admin', capability: 'FirmwareManagement',
    impact: 'Lädt Diagnosematerial ausschließlich zu einem kurzlebigen, signierten HTTPS-Ziel hoch.', confirmation: 'Ziel, Zeitraum und Retries prüfen; URL und Token erscheinen nicht im Journal.', fields: [
      { key: 'location', label: 'Kurzlebiges Diagnoseziel', kind: 'text', required: true, placeholder: 'https://…' },
      { key: 'startTime', label: 'Von', kind: 'datetime-local' }, { key: 'stopTime', label: 'Bis', kind: 'datetime-local' },
      { key: 'retries', label: 'Wiederholungen', kind: 'number', defaultValue: '1' }, { key: 'retryInterval', label: 'Abstand in Sekunden', kind: 'number', defaultValue: '60' }] },
  { action: 'UpdateFirmware', label: 'Firmware aktualisieren', group: 'betrieb', role: 'platform-admin', capability: 'FirmwareManagement', hard: true,
    impact: 'Lädt eine signierte Firmware und installiert sie. Alle Ladepunkte können zeitweise ausfallen.',
    confirmation: 'Starke Bestätigung mit einmaliger Server-Phrase; Installation und anschließender Boot werden getrennt beobachtet.', fields: [
      { key: 'location', label: 'Allowlisted Firmware-URL', kind: 'text', required: true, placeholder: 'https://…' },
      { key: 'retrieveDate', label: 'Abruf ab', kind: 'datetime-local', required: true },
      { key: 'sha256', label: 'SHA-256', kind: 'text', required: true }, { key: 'signature', label: 'Signatur', kind: 'textarea', required: true },
      { key: 'retries', label: 'Wiederholungen', kind: 'number', defaultValue: '1' }, { key: 'retryInterval', label: 'Abstand in Sekunden', kind: 'number', defaultValue: '60' }] },
  { action: 'TriggerMessage', label: 'Nachricht anfordern', group: 'protokoll', role: 'site-admin', capability: 'RemoteTrigger',
    impact: 'Fordert eine konkrete OCPP-Nachricht innerhalb von 20 Sekunden an.', confirmation: 'Nachricht und optionalen Stecker prüfen.', fields: [
      { key: 'requestedMessage', label: 'Nachricht', kind: 'select', required: true, defaultValue: 'StatusNotification', options: ['BootNotification','DiagnosticsStatusNotification','FirmwareStatusNotification','Heartbeat','MeterValues','StatusNotification'].map((value) => ({ value, label: value })) },
      { ...connector, required: false, label: 'Optionaler Stecker' }] },
  { action: 'GetConfiguration', label: 'Konfiguration lesen', group: 'protokoll', role: 'site-admin',
    impact: 'Aktualisiert bekannte Werte und unknownKey getrennt.', confirmation: 'Leere Schlüsselliste liest alles, was die Station zurückgibt.', fields: [
      { key: 'keys', label: 'Optional: Schlüssel, kommasepariert', kind: 'textarea' }] },
  { action: 'ChangeConfiguration', label: 'Konfiguration ändern', group: 'protokoll', role: 'site-admin',
    impact: 'Ändert genau einen serverseitig freigegebenen Schlüssel und liest ihn danach erneut.', confirmation: 'Aktuellen Wert, Wertebereich und Auswirkung prüfen. Ein nötiger Neustart erfolgt nie automatisch.', fields: [
      { key: 'key', label: 'Freigegebener Schlüssel', kind: 'text', required: true }, { key: 'value', label: 'Neuer Wert', kind: 'text', required: true }] },
  { action: 'ClearCache', label: 'Autorisierungs-Cache leeren', group: 'protokoll', role: 'site-admin',
    impact: 'Entfernt den lokalen Autorisierungs-Cache; Offline-Autorisierung kann danach eingeschränkt sein.', confirmation: 'Auswirkung auf Offline-Laden bestätigen.', fields: [] },
  { action: 'GetLocalListVersion', label: 'LocalList-Version lesen', group: 'protokoll', role: 'site-admin', capability: 'LocalAuthListManagement',
    impact: 'Liest die Versionsnummer der lokalen Autorisierungsliste.', confirmation: 'Keine weiteren Eingaben.', fields: [] },
  { action: 'SendLocalList', label: 'LocalList senden', group: 'protokoll', role: 'site-admin', capability: 'LocalAuthListManagement',
    impact: 'Ersetzt die lokale Liste vollständig oder ergänzt sie differentiell; Tags werden in der Oberfläche maskiert.',
    confirmation: 'Ein vollständiger Ersatz verlangt eine starke, einmalige Server-Phrase.', fields: [
      { key: 'listVersion', label: 'Neue Version', kind: 'number', required: true },
      { key: 'updateType', label: 'Art', kind: 'select', required: true, defaultValue: 'Differential', options: [{ value: 'Differential', label: 'Differentiell' }, { value: 'Full', label: 'Vollständig ersetzen' }] },
      { key: 'tags', label: 'idTags, eine pro Zeile', kind: 'textarea', help: 'Personenbezug minimieren; maximal 20 Zeichen je Eintrag.' }] },
  { action: 'DataTransfer', label: 'Hersteller-Healthcheck', group: 'protokoll', role: 'platform-admin',
    impact: 'Sendet ausschließlich das registrierte Schema voltpilot.health-check.v1 an de.voltpilot.',
    confirmation: 'Kein freies JSON: Vendor, Message und Felder sind serverseitig gebunden.', fields: [
      { key: 'nonce', label: 'Nonce', kind: 'text', required: true, placeholder: 'eindeutige Prüfkennung' }] },
];

export const ACTION_GROUP_LABEL: Record<OcppActionGroup, string> = {
  alltag: 'Alltag', betrieb: 'Betrieb', protokoll: 'Protokoll',
};

export const ROLE_LABEL: Record<OcppRole, string> = {
  operator: 'Kundenoperator', 'site-admin': 'Anlagenadministrator', 'platform-admin': 'Plattformoperator',
};

export const OCPP_FRESH_MS = 5 * 60_000;
export const OCPP_LATE_EFFECT_POLL_MS = 10 * 60_000;

export function actionNeedsIntent(action: string, values: Record<string, string>): boolean {
  return action === 'HardReset' || action === 'UpdateFirmware'
    || (action === 'SendLocalList' && values.updateType === 'Full');
}

const number = (value: string): number | undefined => value.trim() === '' ? undefined : Number(value);
const instant = (value: string): string | undefined => value ? new Date(value).toISOString() : undefined;
const compact = (obj: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
  Object.entries(obj).filter(([, value]) => value !== undefined && value !== ''),
);

function numericOperationSeed(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return Math.abs(hash % 1_000_000) || 1;
}

/** Build only server-allowlisted OCPP fields; no arbitrary JSON crosses this boundary. */
export function actionRequest(action: string, values: Record<string, string>, operationSeed = 'preview'): Record<string, unknown> {
  const connectorId = number(values.connectorId ?? '');
  switch (action) {
    case 'RemoteStartTransaction': {
      const limit = number(values.profileLimit ?? '');
      return compact({ connectorId, idTag: values.idTag,
        chargingProfile: limit == null ? undefined : {
          // One dialog intention owns one seed: retries are byte-identical,
          // while a changed form intention gets a new profile identity.
          chargingProfileId: numericOperationSeed(operationSeed), stackLevel: 0,
          chargingProfilePurpose: 'TxProfile', chargingProfileKind: 'Relative',
          chargingSchedule: { chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: limit * 1000 }] },
        } });
    }
    case 'RemoteStopTransaction': return { transactionId: number(values.transactionId)! };
    case 'UnlockConnector': return { connectorId };
    case 'ReserveNow': return compact({ connectorId, expiryDate: instant(values.expiryDate), idTag: values.idTag,
      reservationId: number(values.reservationId), parentIdTag: values.parentIdTag });
    case 'CancelReservation': return { reservationId: number(values.reservationId)! };
    case 'SetChargingProfile': return { connectorId, csChargingProfiles: compact({
      chargingProfileId: number(values.profileId), stackLevel: number(values.stackLevel),
      chargingProfilePurpose: values.purpose, chargingProfileKind: 'Relative',
      chargingSchedule: compact({ duration: number(values.duration), chargingRateUnit: values.rateUnit,
        chargingSchedulePeriod: [{ startPeriod: 0, limit: number(values.limit) }] }),
    }) };
    case 'ClearChargingProfile': return compact({ id: number(values.profileId), connectorId,
      chargingProfilePurpose: values.purpose, stackLevel: number(values.stackLevel) });
    case 'GetCompositeSchedule': return compact({ connectorId, duration: number(values.duration), chargingRateUnit: values.rateUnit });
    case 'ChangeAvailability': return { connectorId, type: values.type };
    case 'SoftReset': case 'HardReset': case 'ClearCache': case 'GetLocalListVersion': return {};
    case 'TriggerMessage': return compact({ requestedMessage: values.requestedMessage, connectorId });
    case 'GetConfiguration': return values.keys?.trim()
      ? { key: values.keys.split(',').map((key) => key.trim()).filter(Boolean) } : {};
    case 'ChangeConfiguration': return { key: values.key, value: values.value };
    case 'GetDiagnostics': return compact({ location: values.location, retries: number(values.retries),
      retryInterval: number(values.retryInterval), startTime: instant(values.startTime), stopTime: instant(values.stopTime) });
    case 'UpdateFirmware': return compact({ location: values.location, retrieveDate: instant(values.retrieveDate),
      retries: number(values.retries), retryInterval: number(values.retryInterval), sha256: values.sha256,
      signature: values.signature });
    case 'SendLocalList': return { listVersion: number(values.listVersion), updateType: values.updateType,
      localAuthorizationList: (values.tags ?? '').split('\n').map((tag) => tag.trim()).filter(Boolean)
        .map((tag) => ({ idTag: tag, idTagInfo: { status: 'Accepted' } })) };
    case 'DataTransfer': return { schemaId: 'voltpilot.health-check.v1', vendorId: 'de.voltpilot',
      messageId: 'HealthCheck', data: { nonce: values.nonce } };
    default: return {};
  }
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sorted(child)]));
}

/** Stable identity of one physical operator intention; transport retries keep its key. */
export function actionFingerprint(action: string, connectorId: number | undefined,
  transactionId: number | undefined, request: Record<string, unknown>): string {
  return JSON.stringify(sorted({ action, connectorId, transactionId, request }));
}

export interface OcppActionHandoff {
  version: 1;
  siteId: string;
  chargePointId: string;
  action: string;
  connectorId?: number;
  transactionId?: number;
  request: Record<string, unknown>;
  intent: OcppActionIntent;
}

const HANDOFF_PREFIX = 'VP-OCPP-INTENT-1:';

/** Portable, server-verified handoff: the server remains the authority for actor, payload and expiry. */
export function actionHandoffCode(handoff: OcppActionHandoff): string {
  return `${HANDOFF_PREFIX}${JSON.stringify(sorted(handoff))}`;
}

export function parseActionHandoff(code: string, expected: {
  siteId: string; chargePointId: string; action: string; now?: number;
}): OcppActionHandoff {
  if (!code.trim().startsWith(HANDOFF_PREFIX)) throw new Error('format');
  let parsed: unknown;
  try { parsed = JSON.parse(code.trim().slice(HANDOFF_PREFIX.length)); } catch { throw new Error('format'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('format');
  const value = parsed as Partial<OcppActionHandoff>;
  if (value.version !== 1 || value.siteId !== expected.siteId
      || value.chargePointId !== expected.chargePointId || value.action !== expected.action
      || !value.intent || typeof value.intent.id !== 'string' || typeof value.intent.phrase !== 'string'
      || typeof value.intent.expiresAt !== 'string' || value.intent.action !== expected.action || !value.intent.fourEyes
      || !value.request || typeof value.request !== 'object' || Array.isArray(value.request)
      || (value.connectorId != null && !Number.isInteger(value.connectorId))
      || (value.transactionId != null && !Number.isInteger(value.transactionId))) throw new Error('binding');
  const expires = Date.parse(value.intent.expiresAt);
  if (!Number.isFinite(expires)) throw new Error('binding');
  if (expires <= (expected.now ?? Date.now())) throw new Error('expired');
  return value as OcppActionHandoff;
}

export interface OcppHero {
  transaction: OcppTransaction | null;
  power: string | null;
  energy: string | null;
  duration: string | null;
  release: string;
  applied: string;
}

function latest(samples: OcppMeterSample[], transaction: OcppTransaction, measurand: string, now: number): OcppMeterSample | null {
  return samples.filter((sample) => sample.transactionId === transaction.transactionId
    && sample.connectorId === transaction.connectorId
    && [sample.measurand, sample.pointKey].some((value) => value?.toLowerCase() === measurand.toLowerCase())
    && Number.isFinite(Date.parse(sample.sampledAt))
    && now - Date.parse(sample.sampledAt) >= -60_000
    && now - Date.parse(sample.sampledAt) <= OCPP_FRESH_MS)
    .sort((a, b) => Date.parse(b.sampledAt) - Date.parse(a.sampledAt))[0] ?? null;
}

function powerValue(sample: OcppMeterSample | null): string | null {
  if (!sample) return null;
  if (sample.numericValue == null) return null;
  let value = sample.numericValue;
  let unit = sample.unit ?? '';
  const normalized = unit.toLowerCase();
  if (normalized === 'w') { value /= 1000; unit = 'kW'; }
  else if (normalized !== 'kw') return null;
  return `${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })} ${unit}`;
}

/**
 * OCPP's `Energy.Active.Import.Register` is normally a cumulative register,
 * not the energy of the current session. It becomes session energy only when
 * the fresh sample belongs to the same transaction/connector and can be
 * subtracted from StartTransaction.meterStart (whose OCPP unit is Wh).
 */
function sessionEnergy(sample: OcppMeterSample | null, transaction: OcppTransaction): string | null {
  if (!sample || sample.numericValue == null || !Number.isFinite(transaction.meterStart)) return null;
  const unit = (sample.unit ?? '').toLowerCase();
  const currentWh = unit === 'wh'
    ? sample.numericValue
    : unit === 'kwh'
      ? sample.numericValue * 1000
      : null;
  if (currentWh == null) return null;
  const deltaWh = currentWh - transaction.meterStart;
  if (!Number.isFinite(deltaWh) || deltaWh < 0) return null;
  return `${(deltaWh / 1000).toLocaleString('de-DE', { maximumFractionDigits: 2 })} kWh`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function scheduleLimit(value: unknown): { limit: number; unit: 'W' | 'A' } | null {
  const root = record(value);
  if (!root) return null;
  const profile = record(root.csChargingProfiles);
  const schedule = record(profile?.chargingSchedule) ?? record(root.chargingSchedule) ?? root;
  const unit = schedule.chargingRateUnit;
  const periods = schedule.chargingSchedulePeriod;
  const limit = Array.isArray(periods) ? record(periods[0])?.limit : undefined;
  return (unit === 'W' || unit === 'A') && typeof limit === 'number' && Number.isFinite(limit)
    ? { limit, unit } : null;
}

function formatLimit(value: { limit: number; unit: 'W' | 'A' } | null): string | null {
  if (!value) return null;
  if (value.unit === 'W' && Math.abs(value.limit) >= 1000) {
    return `${(value.limit / 1000).toLocaleString('de-DE', { maximumFractionDigits: 2 })} kW`;
  }
  return `${value.limit.toLocaleString('de-DE', { maximumFractionDigits: 2 })} ${value.unit}`;
}

function actionMatchesTransaction(action: OcppAction, transaction: OcppTransaction): boolean {
  return action.connectorId === transaction.connectorId
    && action.transactionId === transaction.transactionId;
}

function actionIsFresh(action: OcppAction, now: number): boolean {
  const updated = Date.parse(action.updatedAt);
  return Number.isFinite(updated) && now - updated >= -60_000 && now - updated <= OCPP_FRESH_MS;
}

export function wallboxHero(transactions: OcppTransaction[], samples: OcppMeterSample[], actions: OcppAction[], now = Date.now()): OcppHero {
  const transaction = transactions.filter((tx) => tx.stoppedAt == null)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] ?? null;
  const power = transaction ? latest(samples, transaction, 'Power.Active.Import', now) : null;
  const energy = transaction ? latest(samples, transaction, 'Energy.Active.Import.Register', now) : null;
  const successful = new Set(['accepted_waiting_effect', 'effect_observed', 'completed']);
  const profile = transaction ? actions.filter((action) => action.action === 'SetChargingProfile'
    && successful.has(action.state) && actionMatchesTransaction(action, transaction) && actionIsFresh(action, now))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] : undefined;
  const readback = transaction ? actions.filter((action) => action.action === 'GetCompositeSchedule'
    && (action.state === 'completed' || action.state === 'effect_observed')
    && actionMatchesTransaction(action, transaction) && actionIsFresh(action, now))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] : undefined;
  const wanted = scheduleLimit(profile?.request);
  const applied = scheduleLimit(readback?.effect) ?? scheduleLimit(readback?.response);
  const started = transaction ? Date.parse(transaction.startedAt) : NaN;
  const minutes = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 60_000)) : null;
  return {
    transaction,
    power: powerValue(power),
    energy: transaction ? sessionEnergy(energy, transaction) : null,
    duration: minutes == null ? null : minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`,
    release: formatLimit(wanted) ?? 'keine bestätigte Freigabe gemeldet',
    applied: formatLimit(applied) ?? 'noch nicht erfolgreich zurückgelesen',
  };
}

export interface OcppConnectionFallback {
  connected: boolean;
  lastSeen?: string | null;
  reportedAt?: string | null;
  connectors?: Array<{
    connectorId: number;
    status?: string | null;
    charging?: boolean;
  }> | null;
}

export interface StationConnection {
  online: boolean;
  sendable: boolean;
  label: string;
  detail: string;
  lastSeen: string | null;
  source: 'station' | 'edge' | 'none';
}

function evidenceTime(value: string | null | undefined): number {
  if (!value) return NaN;
  return Date.parse(value);
}

function freshEvidence(at: number, now: number): boolean {
  const age = now - at;
  return Number.isFinite(at) && age >= -60_000 && age <= OCPP_FRESH_MS;
}

/**
 * Display truth uses the newest fresh connection evidence. The local Edge
 * heartbeat can therefore correct a lagging OCPP journal, while command
 * sendability remains tied to the fresh CSMS station read model.
 */
export function stationConnection(
  station: OcppStation | null,
  now = Date.now(),
  fallback: OcppConnectionFallback | null = null,
): StationConnection {
  const stationSeen = evidenceTime(station?.connected
    ? station.lastSeen
    : station?.disconnectedAt ?? station?.lastSeen);
  const edgeSeen = evidenceTime(fallback?.reportedAt ?? fallback?.lastSeen);
  const stationFresh = freshEvidence(stationSeen, now);
  const edgeFresh = freshEvidence(edgeSeen, now);
  const source = edgeFresh && (!stationFresh || edgeSeen > stationSeen) ? 'edge'
    : stationFresh ? 'station' : 'none';
  const online = source === 'edge' ? fallback!.connected
    : source === 'station' ? Boolean(station?.connected) : false;
  const lastSeen = source === 'edge'
    ? fallback?.reportedAt ?? fallback?.lastSeen ?? null
    : source === 'station'
      ? station?.connected ? station.lastSeen : station?.disconnectedAt ?? station?.lastSeen ?? null
      : station?.lastSeen ?? fallback?.reportedAt ?? fallback?.lastSeen ?? null;
  const sendable = online && Boolean(station?.connected) && stationFresh;

  if (source === 'edge' && online) return {
    online, sendable, label: 'Online', lastSeen, source,
    detail: sendable
      ? `Zuletzt gesehen ${new Date(edgeSeen).toLocaleString('de-DE')}.`
      : 'Die VoltPilot-Box meldet die Wallbox als verbunden. OCPP-Detaildaten werden noch synchronisiert.',
  };
  if (source !== 'none' && online) return {
    online, sendable, label: 'Online', lastSeen, source,
    detail: `Zuletzt gesehen ${new Date(stationSeen).toLocaleString('de-DE')}.`,
  };
  if (source === 'edge') return {
    online: false, sendable: false, label: 'Offline', lastSeen, source,
    detail: 'Die VoltPilot-Box meldet keine aktive OCPP-Verbindung.',
  };
  if (source === 'station') return {
    online: false, sendable: false, label: 'Offline', lastSeen, source,
    detail: 'Keine aktive OCPP-Verbindung.',
  };
  if (station?.connected || fallback?.connected) return {
    online: false, sendable: false, label: 'Keine aktuellen Daten', lastSeen, source,
    detail: lastSeen
      ? `Zuletzt gesehen ${new Date(lastSeen).toLocaleString('de-DE')}.`
      : 'Es liegt noch kein aktueller Verbindungsstatus vor.',
  };
  return {
    online: false, sendable: false, label: 'Offline', lastSeen, source,
    detail: 'Keine aktive OCPP-Verbindung.',
  };
}

export type WallboxStateKind =
  | 'charging'
  | 'waiting'
  | 'available'
  | 'unavailable'
  | 'offline'
  | 'stale'
  | 'faulted'
  | 'unknown';

export interface WallboxState {
  kind: WallboxStateKind;
  tone: 'ok' | 'warn' | 'error' | 'off';
  badge: string;
  sentence: string;
  detail: string;
  connectorId: number | null;
  connectorStatus: string | null;
  action: 'RemoteStartTransaction' | 'RemoteStopTransaction' | 'UnlockConnector' | 'service' | null;
  actionLabel: string | null;
}

export interface WallboxConnectorSnapshot {
  connector: OcppConnectorState | null;
  connectorId: number | null;
  fresh: boolean;
  detail: string;
}

/**
 * One connector truth for the whole page. An active transaction may only use
 * its exact connector; a fresh station heartbeat never freshens an old
 * StatusNotification.
 */
export function wallboxConnectorSnapshot(
  station: OcppStation | null,
  transaction: OcppTransaction | null,
  now = Date.now(),
): WallboxConnectorSnapshot {
  const connector = transaction
    ? station?.connectors.find((item) => item.connectorId === transaction.connectorId) ?? null
    : station?.connectors[0] ?? null;
  const connectorId = transaction?.connectorId ?? connector?.connectorId ?? null;
  if (!connector) return {
    connector: null,
    connectorId,
    fresh: false,
    detail: connectorId == null
      ? 'Die Wallbox hat noch keinen Anschlusszustand gemeldet.'
      : `Für Anschluss ${connectorId} liegt kein aktueller Zustand vor.`,
  };
  const reportedAt = Date.parse(connector.reportedAt);
  const age = now - reportedAt;
  const fresh = Number.isFinite(reportedAt) && age >= -60_000 && age <= OCPP_FRESH_MS;
  const lastReported = Number.isFinite(reportedAt)
    ? new Date(reportedAt).toLocaleString('de-DE')
    : 'ohne gültigen Zeitstempel';
  return {
    connector,
    connectorId,
    fresh,
    detail: fresh
      ? `Anschluss ${connector.connectorId} wurde aktuell gemeldet.`
      : `Anschluss ${connector.connectorId} wurde zuletzt ${lastReported} gemeldet.`,
  };
}

/** Customer-language state for one physical wallbox; raw OCPP stays secondary. */
export function wallboxState(
  station: OcppStation | null,
  hero: OcppHero,
  now = Date.now(),
  fallback: OcppConnectionFallback | null = null,
): WallboxState {
  const connection = stationConnection(station, now, fallback);
  const stationSnapshot = wallboxConnectorSnapshot(station, hero.transaction, now);
  const edgeReportedAt = evidenceTime(fallback?.reportedAt ?? fallback?.lastSeen);
  const edgeFresh = freshEvidence(edgeReportedAt, now);
  const edgeConnector = edgeFresh
    ? hero.transaction
      ? fallback?.connectors?.find((item) => item.connectorId === hero.transaction!.connectorId) ?? null
      : fallback?.connectors?.[0] ?? null
    : null;
  const useEdgeConnector = edgeConnector != null
    && (connection.source === 'edge' || !stationSnapshot.fresh);
  const connector = useEdgeConnector ? edgeConnector : stationSnapshot.connector;
  const connectorId = hero.transaction?.connectorId ?? connector?.connectorId ?? stationSnapshot.connectorId;
  const rawStatus = useEdgeConnector
    ? edgeConnector.status ?? (edgeConnector.charging ? 'Charging' : null)
    : stationSnapshot.connector?.status ?? null;
  const connectorFresh = stationSnapshot.fresh || useEdgeConnector;
  const connectorError = useEdgeConnector ? null : stationSnapshot.connector?.errorCode;
  const connectorName = connectorId == null ? 'Der Anschluss' : `Anschluss ${connectorId}`;

  if (!station && connection.source === 'none') return {
    kind: 'unknown', tone: 'off', badge: 'Keine Gerätedaten',
    sentence: 'Die Wallbox hat noch keinen aktuellen Gerätestatus gemeldet.',
    detail: 'Sobald die erste OCPP-Nachricht eintrifft, erscheint hier ihr Zustand.',
    connectorId, connectorStatus: rawStatus, action: 'service', actionLabel: 'Verbindung prüfen',
  };
  if (connection.source === 'none' && (station?.connected || fallback?.connected)) return {
    kind: 'stale', tone: 'warn', badge: 'Daten veraltet',
    sentence: 'Die Wallbox liefert gerade keine aktuellen Daten.',
    detail: connection.detail,
    connectorId, connectorStatus: rawStatus, action: 'service', actionLabel: 'Verbindung prüfen',
  };
  if (!connection.online) return {
    kind: 'offline', tone: 'off', badge: 'Offline',
    sentence: connection.lastSeen
      ? `Wallbox seit ${new Date(connection.lastSeen).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr nicht erreichbar.`
      : 'Wallbox noch nicht erreichbar.',
    detail: 'Ein lokaler Ladevorgang kann an der Wallbox weiterlaufen.',
    connectorId, connectorStatus: rawStatus, action: 'service', actionLabel: 'Verbindung prüfen',
  };
  if (!connectorFresh) return {
    kind: connector ? 'stale' : 'unknown', tone: 'warn',
    badge: connector ? 'Anschlussdaten veraltet' : 'Anschlussstatus fehlt',
    sentence: connectorId == null
      ? 'Wallbox online · der Anschlusszustand ist noch nicht gemeldet.'
      : `Wallbox online · der Zustand von Anschluss ${connectorId} ist nicht aktuell.`,
    detail: connection.source === 'edge' ? connection.detail : stationSnapshot.detail,
    connectorId, connectorStatus: rawStatus, action: 'service', actionLabel: 'Status prüfen',
  };
  if (rawStatus === 'Faulted' || Boolean(connectorError && connectorError !== 'NoError')) return {
    kind: 'faulted', tone: 'error', badge: 'Störung',
    sentence: `Wallbox online · ${connectorName} meldet eine Störung.`,
    detail: 'Stecker trennen, 10 Sekunden warten und erneut verbinden. Technische Angaben stehen unter Service & Diagnose.',
    connectorId, connectorStatus: rawStatus, action: 'service', actionLabel: 'Störung prüfen',
  };
  if (rawStatus === 'Finishing') return {
    kind: 'waiting', tone: 'warn', badge: 'Wartet auf Abstecken',
    sentence: `Wallbox online · ${connectorName} beendet den Ladevorgang.`,
    detail: 'Wenn das Kabel nach Ladeende feststeckt, kann die Wallbox den Anschluss entriegeln.',
    connectorId, connectorStatus: rawStatus,
    action: !hero.transaction && connection.sendable ? 'UnlockConnector' : 'service',
    actionLabel: !hero.transaction && connection.sendable ? 'Stecker entriegeln' : 'Ladevorgang prüfen',
  };
  if (rawStatus === 'Preparing' || rawStatus === 'SuspendedEV' || rawStatus === 'SuspendedEVSE') return {
    kind: 'waiting', tone: 'warn', badge: 'Wartet',
    sentence: `Wallbox online · ${connectorName} ist angesteckt und wartet.`,
    detail: rawStatus === 'SuspendedEVSE'
      ? 'Die Wallbox pausiert das Laden nach der aktuell geltenden Steuerung.'
      : rawStatus === 'SuspendedEV'
        ? 'Das angeschlossene Fahrzeug ruft gerade keine Leistung ab.'
        : 'Der Anschluss bereitet den nächsten Ladevorgang vor.',
    connectorId, connectorStatus: rawStatus,
    action: hero.transaction ? 'service' : connection.sendable ? 'RemoteStartTransaction' : null,
    actionLabel: hero.transaction ? 'Ladevorgang prüfen' : connection.sendable ? 'Jetzt laden' : null,
  };
  if (rawStatus === 'Unavailable' || rawStatus === 'Reserved') return {
    kind: 'unavailable', tone: 'warn', badge: 'Nicht verfügbar',
    sentence: `Wallbox online · ${connectorName} ist derzeit nicht verfügbar.`,
    detail: rawStatus === 'Reserved' ? 'Der Anschluss ist reserviert.' : 'Die Wallbox hat den Anschluss außer Betrieb gemeldet.',
    connectorId, connectorStatus: rawStatus, action: 'service', actionLabel: 'Status prüfen',
  };
  if (rawStatus === 'Charging') return {
    kind: 'charging', tone: 'ok', badge: 'Lädt',
    sentence: `Wallbox online · ${connectorName} lädt${hero.power ? ` mit ${hero.power}` : ''}.`,
    detail: hero.transaction
      ? `Ladevorgang seit ${new Date(hero.transaction.startedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr.`
      : 'Die Wallbox meldet einen Ladevorgang; die zugehörigen Sitzungsdaten fehlen noch.',
    connectorId, connectorStatus: rawStatus,
    action: hero.transaction && connection.sendable ? 'RemoteStopTransaction' : 'service',
    actionLabel: hero.transaction && connection.sendable ? 'Laden stoppen' : 'Ladevorgang prüfen',
  };
  if (rawStatus === 'Available') return {
    kind: 'available', tone: 'ok', badge: 'Verfügbar',
    sentence: `Wallbox online · ${connectorName} ist verfügbar.`,
    detail: 'Sobald ein Fahrzeug angeschlossen ist, kann der Ladevorgang beginnen.',
    connectorId, connectorStatus: rawStatus,
    action: hero.transaction ? 'service' : connection.sendable ? 'RemoteStartTransaction' : null,
    actionLabel: hero.transaction ? 'Ladevorgang prüfen' : connection.sendable ? 'Laden starten' : null,
  };
  return {
    kind: 'unknown', tone: 'warn', badge: 'Status fehlt',
    sentence: 'Wallbox online · der Anschlusszustand ist noch nicht gemeldet.',
    detail: 'VoltPilot wartet auf die nächste Statusmeldung der Wallbox.',
    connectorId, connectorStatus: rawStatus, action: 'service', actionLabel: 'Status prüfen',
  };
}

export type ActionTone = 'ok' | 'warn' | 'error' | 'neutral';
export function actionState(state: string): { response: string; effect: string; tone: ActionTone; pending: boolean } {
  switch (state) {
    case 'prepared': return { response: 'Vorbereitet', effect: 'Noch nicht an die Station übergeben', tone: 'neutral', pending: true };
    case 'sent': return { response: 'Gesendet · OCPP-Antwort ausstehend', effect: 'Wirkung noch nicht prüfbar', tone: 'warn', pending: true };
    case 'accepted_waiting_effect': return { response: 'CallResult · Befehl angenommen', effect: 'Wirkung noch nicht bestätigt', tone: 'warn', pending: true };
    case 'effect_observed': return { response: 'CallResult · Befehl angenommen', effect: 'Wirkung beobachtet', tone: 'ok', pending: false };
    case 'completed': return { response: 'CallResult · abgeschlossen', effect: 'Keine getrennte Folgewirkung erforderlich', tone: 'ok', pending: false };
    case 'rejected': return { response: 'CallResult · von der Station abgelehnt', effect: 'Keine Wirkung erwartet', tone: 'error', pending: false };
    case 'call_error': return { response: 'CallError der Station', effect: 'Keine Wirkung erwartet', tone: 'error', pending: false };
    case 'not_sendable': return { response: 'Nicht sendbar', effect: 'Station war offline oder Ziel veraltet', tone: 'error', pending: false };
    case 'transport_failed': return { response: 'Transport fehlgeschlagen', effect: 'Keine bestätigte Zustellung', tone: 'error', pending: false };
    case 'edge_rejected': return { response: 'Edge hat den Versand abgelehnt', effect: 'Keine Wirkung erwartet', tone: 'error', pending: false };
    case 'effect_failed': return { response: 'CallResult · Befehl angenommen', effect: 'Wirkung widerspricht oder ist fehlgeschlagen', tone: 'error', pending: false };
    case 'timed_out': case 'effect_timeout': return { response: 'Frist abgelaufen', effect: 'Wirkung nicht innerhalb der Frist beobachtet', tone: 'warn', pending: false };
    case 'late_response': return { response: 'Antwort verspätet eingetroffen', effect: 'Ursprünglicher Abschluss bleibt bestehen', tone: 'warn', pending: false };
    case 'late_effect': return { response: 'Wirkung verspätet beobachtet', effect: 'Ursprünglicher Abschluss bleibt bestehen', tone: 'warn', pending: false };
    case 'cancelled': return { response: 'Vor Versand abgebrochen', effect: 'Keine Wirkung', tone: 'neutral', pending: false };
    default: return { response: state || 'Unbekannter Zustand', effect: 'Technischen Zustand prüfen', tone: 'neutral', pending: false };
  }
}

export function actionNeedsPolling(action: OcppAction, now = Date.now()): boolean {
  if (actionState(action.state).pending) return true;
  if ((action.state !== 'timed_out' && action.state !== 'effect_timeout') || action.effectAt) return false;
  const deadline = Date.parse(action.deadlineAt);
  return Number.isFinite(deadline) && now <= deadline + OCPP_LATE_EFFECT_POLL_MS;
}

const SECRET_KEY = /password|secret|token|signature|location|endpoint|callback(?:url|uri)?|(?:^|[_-])url(?:$|[_-])|(?:^|[_-])uri(?:$|[_-])|idtag|imsi|iccid|credential|authorization/i;
const ASSIGNED_SECRET = /\b(?:token|secret|password|signature|credential|authorization|idtag|url|uri|endpoint|callback(?:url|uri)?)\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const URI_VALUE = /\b[a-z][a-z0-9+.-]*:(?:\/\/)?[^\s"'<>]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const OPAQUE_SECRET = /\b[A-Za-z0-9_-]{40,}\b/g;
const LONG_IDENTIFIER = /\b\d{14,22}\b/g;

/** Last-resort UI privacy barrier, recursive by key and by string value form. */
export function redactSensitiveText(value: string): string {
  return value.replace(ASSIGNED_SECRET, '••••••••')
    .replace(URI_VALUE, '••••••••')
    .replace(BEARER, '••••••••')
    .replace(JWT, '••••••••')
    .replace(OPAQUE_SECRET, '••••••••')
    .replace(LONG_IDENTIFIER, '••••••••');
}

export function safeJson(value: unknown): string {
  const redact = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(redact);
    if (typeof input === 'string') return redactSensitiveText(input);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, child]) => [key,
      SECRET_KEY.test(key) ? '••••••••' : redact(child)]));
  };
  return JSON.stringify(redact(value), null, 2);
}

/** Customer-safe action error copy. Raw backend/proxy exception text never crosses into the DOM. */
export function safeActionError(cause: unknown): string {
  const status = cause && typeof cause === 'object' && 'status' in cause
    ? Number((cause as { status?: unknown }).status) : 0;
  if (status === 400 || status === 422) return 'Die Eingaben wurden nicht akzeptiert. Prüfen Sie die markierten Werte und versuchen Sie es erneut.';
  if (status === 403) return 'Ihr Konto darf diese Aktion nicht ausführen. Die erforderliche Rolle ist im Aktionskatalog angegeben.';
  if (status === 409) return 'Die Aktion steht im Konflikt mit einem laufenden Vorgang oder einer abgelaufenen Bestätigung. Laden Sie den Stand neu.';
  if (status === 429) return 'Zu viele Aktionen in kurzer Zeit. Warten Sie einen Moment und versuchen Sie es erneut.';
  return 'Die Aktion konnte nicht sicher abgeschlossen werden. Sie können denselben Versuch erneut senden; VoltPilot verhindert eine Doppelwirkung.';
}

export function maskReference(value: string | null): string {
  if (!value) return '—';
  if (value.length <= 6) return '••••';
  return `${value.slice(0, 3)}••••${value.slice(-3)}`;
}

export function stationTitle(station: OcppStation | null, fallback: string): string {
  const parts = [station?.chargePointVendor, station?.chargePointModel].filter(Boolean);
  return parts.length ? redactSensitiveText(parts.join(' ')) : fallback;
}
