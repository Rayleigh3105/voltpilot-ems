import { VpDatePicker } from './VpDatePicker';
import { VpTimePicker } from './VpTimePicker';
import { VpPicker } from './VpPicker';
import { lesen, zonenName, type ZeitpunktEingabe } from '../picker/zeitpunkt';
export function VpZeitpunktPicker({ value, zone, onChange, disabled, error }: { value: ZeitpunktEingabe; zone: string; onChange: (v: ZeitpunktEingabe) => void; disabled?: boolean; error?: string }) {
  const z = lesen(value, zone);
  return <div className="vp-wert-zeitpunkt">
    <p>Zeitzone: {zone}{z.wert ? ` · ${zonenName(z.wert, zone)}` : ''}</p>
    <div className="vp-bz-felder">
      <VpDatePicker id="wert-tag" label="Datum" value={value.tag} onChange={tag => onChange({ ...value, tag, variante: null })} disabled={disabled} />
      <VpTimePicker id="wert-zeit" label="Uhrzeit" value={value.zeit} onChange={zeit => onChange({ ...value, zeit, variante: null })} disabled={disabled} />
    </div>
    {z.varianten.length > 0 && <VpPicker label="Welche Stunde?" value={value.variante} placeholder="Stunde wählen …" options={z.varianten} onChange={variante => onChange({ ...value, variante })} disabled={disabled} />}
    {(error || z.fehler) && <p role="alert">{error || z.fehler}</p>}
  </div>;
}
