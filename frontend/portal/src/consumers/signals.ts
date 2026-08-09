/**
 * The condition-signal catalog - the TS twin of the api's ConsumerSignalCatalog
 * (services/api .../consumers/ConsumerSignalCatalog.java). The two are pinned by
 * the shared vectors (docs/contracts/v2/consumer-policy-vectors.json); change
 * both together. `class` is load-bearing (D1): a CLOUD signal (day-ahead price /
 * full import price) is compiled to concrete UTC windows and therefore carries
 * NO hysteresis and NO max_age_s; a LOCAL signal (SoC / PV-surplus / grid-flow /
 * device availability) is evaluated at the edge and may carry both.
 */

export type SignalClass = 'cloud' | 'local';
export type SignalValueType = 'number' | 'boolean';

export interface SignalDef {
  name: string;
  label: string;
  signalClass: SignalClass;
  valueType: SignalValueType;
}

export const CONSUMER_SIGNALS: SignalDef[] = [
  { name: 'market.spot_price_ct_kwh', label: 'Börsenpreis (ct/kWh)', signalClass: 'cloud', valueType: 'number' },
  { name: 'market.import_price_ct_kwh', label: 'Mein Bezugspreis (ct/kWh)', signalClass: 'cloud', valueType: 'number' },
  { name: 'storage.soc_pct', label: 'Speicher-Ladestand (%)', signalClass: 'local', valueType: 'number' },
  { name: 'site.pv_surplus_kw', label: 'PV-Überschuss (kW)', signalClass: 'local', valueType: 'number' },
  { name: 'site.grid_power_kw', label: 'Netzbezug/-einspeisung (kW)', signalClass: 'local', valueType: 'number' },
  { name: 'consumer.vehicle_connected', label: 'Fahrzeug verbunden', signalClass: 'local', valueType: 'boolean' },
  { name: 'consumer.available', label: 'Gerät verfügbar', signalClass: 'local', valueType: 'boolean' },
];

const BY_NAME = new Map(CONSUMER_SIGNALS.map((s) => [s.name, s]));

export function findSignal(name: string): SignalDef | undefined {
  return BY_NAME.get(name);
}

export function isCloudSignal(name: string): boolean {
  return BY_NAME.get(name)?.signalClass === 'cloud';
}
