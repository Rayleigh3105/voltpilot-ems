import type {
  OcppAction,
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
  { action: 'ReserveNow', label: 'Reservieren', group: 'alltag', role: 'operator', capability: 'Reservation',
    impact: 'Reserviert den Stecker bis zum Ablaufzeitpunkt für die angegebene Autorisierung.',
    confirmation: 'Stecker, Ablauf und Autorisierung prüfen.', fields: [connector, idTag,
      { key: 'expiryDate', label: 'Ablauf', kind: 'datetime-local', required: true },
      { key: 'reservationId', label: 'Reservierungs-ID', kind: 'number', required: true, defaultValue: '1' },
      { key: 'parentIdTag', label: 'Optionaler parentIdTag', kind: 'text' }] },
  { action: 'CancelReservation', label: 'Reservierung aufheben', group: 'alltag', role: 'operator', capability: 'Reservation',
    impact: 'Hebt eine aktive Reservierung auf.', confirmation: 'Reservierungs-ID und zugehörigen Stecker prüfen.', fields: [connector,
      { key: 'reservationId', label: 'Reservierungs-ID', kind: 'number', required: true }] },
  { action: 'SetChargingProfile', label: 'Ladeprofil setzen', group: 'alltag', role: 'operator', capability: 'SmartCharging',
    impact: 'Setzt ein OCPP-TxProfile; die aktuell geltende Freigabe bleibt bis zum Readback ehrlich getrennt.',
    confirmation: 'Leistung, Einheit, Zweck und Stack-Level prüfen.', fields: [connector,
      { key: 'profileId', label: 'Profil-ID', kind: 'number', required: true, defaultValue: '1' },
      { key: 'stackLevel', label: 'Stack-Level', kind: 'number', required: true, defaultValue: '0' },
      { key: 'purpose', label: 'Zweck', kind: 'select', required: true, defaultValue: 'TxProfile', options: [
        { value: 'TxProfile', label: 'TxProfile' }, { value: 'TxDefaultProfile', label: 'TxDefaultProfile' }, { value: 'ChargePointMaxProfile', label: 'ChargePointMaxProfile' }] },
      { key: 'rateUnit', label: 'Einheit', kind: 'select', required: true, defaultValue: 'W', options: [{ value: 'W', label: 'Watt' }, { value: 'A', label: 'Ampere' }] },
      { key: 'limit', label: 'Limit', kind: 'number', required: true, placeholder: '11000' },
      { key: 'duration', label: 'Dauer in Sekunden', kind: 'number', placeholder: '3600' }] },
  { action: 'ClearChargingProfile', label: 'Ladeprofil löschen', group: 'alltag', role: 'operator', capability: 'SmartCharging',
    impact: 'Löscht nur Profile, die den angegebenen Filtern entsprechen.', confirmation: 'Filter und betroffene Profile prüfen.', fields: [
      { key: 'profileId', label: 'Profil-ID', kind: 'number' }, connector,
      { key: 'purpose', label: 'Zweck', kind: 'select', options: [{ value: '', label: 'alle Zwecke' }, { value: 'TxProfile', label: 'TxProfile' }, { value: 'TxDefaultProfile', label: 'TxDefaultProfile' }, { value: 'ChargePointMaxProfile', label: 'ChargePointMaxProfile' }] },
      { key: 'stackLevel', label: 'Stack-Level', kind: 'number' }] },
  { action: 'GetCompositeSchedule', label: 'Angewandten Ladeplan lesen', group: 'alltag', role: 'operator', capability: 'SmartCharging',
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

export function actionNeedsIntent(action: string, values: Record<string, string>): boolean {
  return action === 'HardReset' || action === 'UpdateFirmware'
    || (action === 'SendLocalList' && values.updateType === 'Full');
}

const number = (value: string): number | undefined => value.trim() === '' ? undefined : Number(value);
const instant = (value: string): string | undefined => value ? new Date(value).toISOString() : undefined;
const compact = (obj: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
  Object.entries(obj).filter(([, value]) => value !== undefined && value !== ''),
);

/** Build only server-allowlisted OCPP fields; no arbitrary JSON crosses this boundary. */
export function actionRequest(action: string, values: Record<string, string>): Record<string, unknown> {
  const connectorId = number(values.connectorId ?? '');
  switch (action) {
    case 'RemoteStartTransaction': {
      const limit = number(values.profileLimit ?? '');
      return compact({ connectorId, idTag: values.idTag,
        chargingProfile: limit == null ? undefined : {
          chargingProfileId: Date.now() % 1_000_000, stackLevel: 0,
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

export interface OcppHero {
  transaction: OcppTransaction | null;
  power: string | null;
  energy: string | null;
  soc: string | null;
  duration: string | null;
  release: string;
  applied: string;
}

function latest(samples: OcppMeterSample[], transactionId: number | null, token: string): OcppMeterSample | null {
  return samples.filter((sample) => (transactionId == null || sample.transactionId === transactionId)
    && `${sample.measurand ?? ''} ${sample.pointKey}`.toLowerCase().includes(token))
    .sort((a, b) => Date.parse(b.sampledAt) - Date.parse(a.sampledAt))[0] ?? null;
}

function sampleValue(sample: OcppMeterSample | null, kind: 'power' | 'energy' | 'soc'): string | null {
  if (!sample) return null;
  if (sample.numericValue == null) return `${sample.value}${sample.unit ? ` ${sample.unit}` : ''}`;
  let value = sample.numericValue;
  let unit = sample.unit ?? '';
  if (kind === 'power' && unit.toLowerCase() === 'w') { value /= 1000; unit = 'kW'; }
  if (kind === 'energy' && unit.toLowerCase() === 'wh') { value /= 1000; unit = 'kWh'; }
  return `${value.toLocaleString('de-DE', { maximumFractionDigits: kind === 'soc' ? 0 : 1 })}${unit ? ` ${unit}` : ''}`;
}

function deepNumber(value: unknown, keys: string[]): number | null {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(key) && typeof child === 'number' && Number.isFinite(child)) return child;
    const nested = deepNumber(child, keys);
    if (nested != null) return nested;
  }
  return null;
}

export function wallboxHero(transactions: OcppTransaction[], samples: OcppMeterSample[], actions: OcppAction[], now = Date.now()): OcppHero {
  const transaction = transactions.filter((tx) => tx.stoppedAt == null)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] ?? null;
  const relevant = samples.filter((sample) => !transaction || sample.transactionId === transaction.transactionId);
  const power = latest(relevant, transaction?.transactionId ?? null, 'power.active.import')
    ?? latest(relevant, transaction?.transactionId ?? null, 'power');
  const energy = latest(relevant, transaction?.transactionId ?? null, 'energy.active.import.register')
    ?? latest(relevant, transaction?.transactionId ?? null, 'energy');
  const soc = latest(relevant, transaction?.transactionId ?? null, 'soc');
  const profile = actions.filter((action) => action.action === 'SetChargingProfile')
    .sort((a, b) => Date.parse(b.preparedAt) - Date.parse(a.preparedAt))[0];
  const readback = actions.filter((action) => action.action === 'GetCompositeSchedule'
    && (action.state === 'completed' || action.state === 'effect_observed'))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const wanted = deepNumber(profile?.request, ['limit']);
  const applied = deepNumber(readback?.effect ?? readback?.response, ['limit']);
  const started = transaction ? Date.parse(transaction.startedAt) : NaN;
  const minutes = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 60_000)) : null;
  return {
    transaction,
    power: sampleValue(power, 'power'), energy: sampleValue(energy, 'energy'), soc: sampleValue(soc, 'soc'),
    duration: minutes == null ? null : minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`,
    release: wanted == null ? 'keine Freigabe gemeldet' : `${wanted.toLocaleString('de-DE')} ${wanted > 1000 ? 'W' : 'A/W laut Profil'}`,
    applied: applied == null ? 'noch nicht zurückgelesen' : `${applied.toLocaleString('de-DE')} laut CompositeSchedule`,
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
    case 'cancelled': return { response: 'Vor Versand abgebrochen', effect: 'Keine Wirkung', tone: 'neutral', pending: false };
    default: return { response: state || 'Unbekannter Zustand', effect: 'Technischen Zustand prüfen', tone: 'neutral', pending: false };
  }
}

export function maskReference(value: string | null): string {
  if (!value) return '—';
  if (value.length <= 6) return '••••';
  return `${value.slice(0, 3)}••••${value.slice(-3)}`;
}

export function stationTitle(station: OcppStation | null, fallback: string): string {
  const parts = [station?.chargePointVendor, station?.chargePointModel].filter(Boolean);
  return parts.length ? parts.join(' ') : fallback;
}
