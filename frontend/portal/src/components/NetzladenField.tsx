/**
 * The "Netzladen des Speichers" select + its Ausschließlichkeitsprinzip warning,
 * extracted verbatim from the former `VerguetungEditForm` for v3.1-M3: the
 * grid-charging switch moved OUT of the general Technik "Vergütung & Tarif"
 * section and INTO the Marktoptimierung container (it is the arbitrage lever).
 * The EEG warning copy travels with it word-for-word so nobody flips it
 * uninformed. Presentational: the parent owns the value and the site save.
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
      <label htmlFor={`${idPrefix}-netzladen`} style={{ fontSize: '0.9rem', fontWeight: 600 }}>
        Netzladen des Speichers
      </label>
      <select
        id={`${idPrefix}-netzladen`}
        className="vp-select"
        value={value ? 'erlaubt' : 'verboten'}
        onChange={(e) => onChange(e.target.value === 'erlaubt')}
      >
        <option value="verboten">Verboten - EEG-Anlage (nur Solarladen)</option>
        <option value="erlaubt">Erlaubt - Speicher darf aus dem Netz laden</option>
      </select>
      <p className="vp-note" style={{ margin: 0 }}>
        EEG-geförderte Anlagen dürfen ihren Speicher nicht aus dem Netz laden
        (Ausschließlichkeitsprinzip). Nur aktivieren, wenn Ihre Anlage keine
        EEG-Vergütung bezieht.
      </p>
    </div>
  );
}
