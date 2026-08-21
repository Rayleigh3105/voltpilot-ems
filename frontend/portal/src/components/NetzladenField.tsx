import { VpPicker } from './VpPicker';

/**
 * The "Netzladen des Speichers" picker + its Ausschließlichkeitsprinzip warning,
 * extracted verbatim from the former `VerguetungEditForm` for v3.1-M3: the
 * grid-charging switch moved OUT of the general Technik "Vergütung & Tarif"
 * section and INTO the Marktoptimierung container (it is the arbitrage lever).
 * The EEG warning copy travels with it word-for-word so nobody flips it
 * uninformed. Presentational: the parent owns the value and the site save.
 *
 * Seit dem Picker-System (`vp-picker-system`) trägt es den Haus-{@link VpPicker}
 * statt des Browser-Auswahlfelds; die zwei Werte und ihre Beschriftungen sind
 * unverändert.
 */
export function NetzladenField({
  value,
  onChange,
  idPrefix,
}: {
  value: boolean;
  onChange: (erlaubt: boolean) => void;
  idPrefix: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <VpPicker
        id={`${idPrefix}-netzladen`}
        label="Netzladen des Speichers"
        options={[
          { value: 'verboten', label: 'Verboten - EEG-Anlage (nur Solarladen)' },
          { value: 'erlaubt', label: 'Erlaubt - Speicher darf aus dem Netz laden' },
        ]}
        value={value ? 'erlaubt' : 'verboten'}
        onChange={(v) => onChange(v === 'erlaubt')}
      />
      <p className="vp-note" style={{ margin: 0 }}>
        EEG-geförderte Anlagen dürfen ihren Speicher nicht aus dem Netz laden
        (Ausschließlichkeitsprinzip). Nur aktivieren, wenn Ihre Anlage keine
        EEG-Vergütung bezieht.
      </p>
    </div>
  );
}
