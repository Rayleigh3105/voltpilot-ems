import { Switch } from '../../designsystem/components/forms/Switch';
import {
  heuteBerlin,
  LABEL_AB_WANN,
  LABEL_SCHON_IMMER,
  preisGiltAbSatz,
  type PreisGiltAb,
} from '../preisGiltAb';
import { VpDatePicker } from './VpDatePicker';

/**
 * Das Feld „Ab wann?“ unter einer Preisänderung (Stromtarif, Preisblatt,
 * Einspeisevergütung; vp-tarif-ab-tag): ein Tag, vorbelegt mit heute, nie in
 * der Zukunft - und „Schon immer“ für die Berichtigung eines falschen Werts.
 * Der Satz darunter sagt, was die Wahl mit den Erlösen macht.
 */
export function PreisGiltAbFeld({
  idPrefix,
  wert,
  onChange,
  fehler,
}: {
  idPrefix: string;
  wert: PreisGiltAb;
  onChange: (w: PreisGiltAb) => void;
  fehler?: string | null;
}) {
  return (
    <div className="vp-tarif-field vp-preis-giltab" data-testid="preis-gilt-ab">
      <VpDatePicker
        id={`${idPrefix}-gilt-ab`}
        label={LABEL_AB_WANN}
        value={wert.schonImmer ? null : wert.tag}
        max={heuteBerlin()}
        disabled={wert.schonImmer}
        placeholder={wert.schonImmer ? 'Von Anfang an' : 'Datum wählen'}
        onChange={(tag) => onChange({ ...wert, tag })}
        error={fehler ?? undefined}
      />
      <Switch
        id={`${idPrefix}-schon-immer`}
        checked={wert.schonImmer}
        label={LABEL_SCHON_IMMER}
        onChange={(e) => onChange({ ...wert, schonImmer: e.target.checked })}
      />
      <p className="vp-note" style={{ margin: 0 }} aria-live="polite">
        {preisGiltAbSatz(wert)}
      </p>
    </div>
  );
}
