export interface OcppElectrical {
  charge_point_id: string; connector_id: number; voltage_v: number; phases: number[]; max_current_a: number;
}
export interface OcppLimit {
  charge_point_id: string; connector_id: number; limit_kw: number; requested_at: string; expires_at: string;
}
export interface OcppControlPolicy {
  revision: number; enabled?: boolean;
  authorization: { mode: 'free' | 'allowlist'; allowed_tags: string[] };
  electrical: OcppElectrical[]; phase_limits_a: number[]; limits: OcppLimit[];
  test?: { charge_point_id: string; connector_id: number; limit_kw: number; requested_at: string } | null;
}
export interface OcppControlReport {
	 rejected_revision?: number; rejection_reason?: string;
  revision: number; enabled: boolean; authorization_mode: string; seen_tags: string[];
  stations: { id: string; connected: boolean; capabilities_read: boolean; profiles_accepted: boolean; note?: string;
    connectors: { id: number; reconciling: boolean; power_kw?: number; power_at?: string; energy_at?: string; soc_at?: string;
      received_at?: string; fresh_power: boolean; command_status?: string; readback?: string; readback_at?: string }[] }[];
  test?: { charge_point_id: string; connector_id: number; requested_at: string; vendor: string; model: string; firmware: string;
    state: 'running' | 'confirmed' | 'not_confirmed' | 'cancelled'; limited: boolean; paused: boolean; resumed: boolean; baseline_kw?: number };
}
export interface OcppControlView {
  desired: OcppControlPolicy | null;
  observed: { deviceId: string; reportedAt: string; state: OcppControlReport }[];
}

export const initialOcppControl = (): OcppControlPolicy => ({ revision: 0,
  authorization: { mode: 'free', allowed_tags: [] }, electrical: [], phase_limits_a: [], limits: [] });

export function finiteInput(value: string, min: number, max: number, label: string): number {
  const n = Number(value.replace(',', '.'));
  if (!value.trim() || !Number.isFinite(n) || n < min || n > max) throw new Error(`${label}: Bitte einen Wert von ${min} bis ${max} angeben.`);
  return n;
}

export function withOcppLimit(p: OcppControlPolicy, station: string, connector: number, kw: string, minutes: string, now: number): OcppControlPolicy {
  const limit = finiteInput(kw, 0, 1000, 'Ladegrenze');
  const duration = finiteInput(minutes, 1, 1440, 'Dauer');
  return { ...p, limits: [...p.limits.filter((l) => l.charge_point_id !== station || l.connector_id !== connector), {
    charge_point_id: station, connector_id: connector, limit_kw: limit,
    requested_at: new Date(now).toISOString(), expires_at: new Date(now + duration * 60_000).toISOString(),
  }] };
}

export function observedOcpp(view: OcppControlView, station: string, deviceId?: string) {
  return view.observed.find((o) => (!deviceId || o.deviceId === deviceId) && o.state.stations.some((s) => s.id === station));
}

export function ocppReadiness(view: OcppControlView, stationId: string, connectorId: number, now: number, deviceId?: string) {
  const observed = observedOcpp(view, stationId, deviceId);
  const age = observed ? now - Date.parse(observed.reportedAt) : Infinity;
  const fresh = age >= 0 && age <= 90_000;
  const report = observed?.state;
  const station = report?.stations.find((s) => s.id === stationId);
  const connector = station?.connectors.find((c) => c.id === connectorId);
  const sampleAge = connector?.power_at ? now - Date.parse(connector.power_at) : Infinity;
  const readbackAge = connector?.readback_at ? now - Date.parse(connector.readback_at) : Infinity;
  return [
    ['Verbindung', fresh && station?.connected ? 'verbunden' : 'nicht aktuell bestätigt'],
    ['Fähigkeiten', fresh && station?.capabilities_read ? 'von der Säule gelesen' : 'nicht bestätigt'],
    ['Schutzprofile', fresh && station?.profiles_accepted ? 'von der Säule angenommen' : station?.note || 'nicht bestätigt'],
    ['Leistungsmessung', fresh && connector?.fresh_power && sampleAge >= 0 && sampleAge <= 30_000 ? 'aktuell' : 'fehlt oder veraltet'],
    ['Transaktion', !fresh || !connector ? 'nicht aktuell gemeldet' : connector.reconciling ? 'Wiederanlauf wird abgeglichen' : 'kein Wiederanlauf offen'],
    ['Regelung', fresh && report?.enabled ? 'auf der Box freigegeben' : 'nicht als freigegeben bestätigt'],
    ['Rücklesung', fresh && connector?.readback === 'ok' && readbackAge >= 0 && readbackAge <= 90_000 ? 'Ladegrenze bestätigt' : 'nicht aktuell bestätigt'],
    ['Konfiguration', fresh && report?.rejected_revision === view.desired?.revision && report?.rejection_reason ? report.rejection_reason
      : fresh && report?.revision === view.desired?.revision ? 'auf der Box gespeichert' : 'Übernahme noch nicht bestätigt'],
  ] as [string, string][];
}
