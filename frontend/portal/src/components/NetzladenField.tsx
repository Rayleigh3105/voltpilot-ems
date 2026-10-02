import { netzladenHinweis, netzladenZeile, type FoerderwegWert } from '../mispelFoerderweg';
import { VpPicker } from './VpPicker';

/**
 * The "Netzladen des Speichers" picker, extracted from the former `VerguetungEditForm` for v3.1-M3: the
 * grid-charging switch moved OUT of the general Technik "Vergütung & Tarif" section and INTO the
 * Marktoptimierung container (it is the arbitrage lever). Presentational: the parent owns the value and the
 * site save.
 *
 * Seit dem Picker-System (`vp-picker-system`) trägt es den Haus-{@link VpPicker} statt des
 * Browser-Auswahlfelds.
 *
 * Seit MiSpeL MP-17 (W2, Captain 02.10.2026 Auflösung B) steht unter dem Feld der Satz des FÖRDERWEGS
 * (`netzladenHinweis`) statt „EEG-geförderte Anlagen dürfen ihren Speicher nicht aus dem Netz laden“ — mit der
 * Abgrenzungsoption darf eine EEG-Anlage es. Schließt der Förderweg Netzladen aus, ist „Erlaubt“ gesperrt mit
 * Grund; ohne bekannten Förderweg (`undefined`/`null`) bleibt die Wahl offen und der Satz neutral.
 */
export function NetzladenField({
  value,
  onChange,
  idPrefix,
  foerderweg = null,
}: {
  value: boolean;
  onChange: (erlaubt: boolean) => void;
  idPrefix: string;
  foerderweg?: FoerderwegWert | null;
}) {
  const zeile = foerderweg ? netzladenZeile(foerderweg) : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <VpPicker
        id={`${idPrefix}-netzladen`}
        label="Netzladen des Speichers"
        options={[
          { value: 'verboten', label: 'Verboten - nur Solarladen' },
          {
            value: 'erlaubt',
            label: 'Erlaubt - Speicher darf aus dem Netz laden',
            disabled: zeile != null && !zeile.offen,
            disabledHint: zeile != null && !zeile.offen ? zeile.satz : null,
          },
        ]}
        value={value ? 'erlaubt' : 'verboten'}
        onChange={(v) => onChange(v === 'erlaubt')}
      />
      <p className="vp-note" style={{ margin: 0 }} data-testid={`${idPrefix}-netzladen-hinweis`}>
        {netzladenHinweis(foerderweg)}
      </p>
    </div>
  );
}
