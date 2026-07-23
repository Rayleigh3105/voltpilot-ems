import {
  SPEICHERSCHONUNG_INDIVIDUELL_LABEL,
  SPEICHERSCHONUNG_OPTIONS,
  type SpeicherschonungPreset,
} from '../speicherschonung';

/**
 * The "Umgang mit dem Speicher" radio fieldset (Speicherschonung, FK4),
 * extracted verbatim from the former `BatteryEditForm` for v3.1-M3: the setting
 * moved OUT of the general Technik page and INTO the Marktoptimierung /
 * Eigenverbrauch mode containers, so its field is now a reusable presentational
 * piece. The parent owns the selected preset and the send-only-on-change
 * discipline (an untouched form must never overwrite an admin-configured
 * 'individuell' value); this component only renders the choice.
 *
 * `current` is the EFFECTIVE preset the backend derived (one of the three, or
 * 'individuell'); it only drives the honest "picking a preset replaces the
 * custom value" note. `value` is the radio selection (null = nothing selected,
 * the 'individuell' start state).
 */
export function SpeicherschonungField({
  current,
  value,
  onChange,
}: {
  current: string | null | undefined;
  value: SpeicherschonungPreset | null;
  onChange: (preset: SpeicherschonungPreset) => void;
}) {
  return (
    <fieldset className="vp-schonung">
      <legend className="vp-schonung-legend">Umgang mit dem Speicher</legend>
      {SPEICHERSCHONUNG_OPTIONS.map((o) => (
        <label
          key={o.value}
          className={'vp-schonung-opt' + (value === o.value ? ' selected' : '')}
        >
          <input
            type="radio"
            name="speicherschonung"
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
          />
          <span className="vp-schonung-main">
            <span className="vp-schonung-label">
              {o.label}
              {o.recommended ? ' (empfohlen)' : ''}
            </span>
            <span className="vp-schonung-sentence">{o.sentence}</span>
          </span>
        </label>
      ))}
      {current === 'individuell' && value == null && (
        <p className="vp-note" style={{ margin: 0 }}>
          Aktuell: {SPEICHERSCHONUNG_INDIVIDUELL_LABEL}. Die Auswahl einer Option ersetzt
          diese Einstellung.
        </p>
      )}
    </fieldset>
  );
}
