import { Input } from '../../designsystem/components/forms/Input';
import type { TarifArt } from '../api';
import {
  SUPPLY_PRICE_FEST_HINT,
  SUPPLY_PRICE_FIELDS,
  SUPPLY_PRICE_SOURCE_NOTE,
  showSupplyPriceFields,
  supplyPriceComponentsSumCt,
  type SupplyPriceFormValues,
} from '../supplyPrice';
import { supplyComponentWarning } from '../tariffInput';
import './TariffFields.css';

/**
 * The structured Bezugspreis components behind the Tarif-Art select (report
 * vp-nacht-bezug-e7 §3.1, Stufe 2): Netzentgelt-Arbeitspreis, Stromsteuer,
 * Konzessionsabgabe, Umlagen (one sum), Vertriebsaufschlag, USt and the
 * Preisblatt-Stand. Shown only for the structured tariffs (`dynamisch`/`ohne`);
 * for `fest` a hint explains the all-in price wins.
 *
 * The values are prefilled with the researched suggestions (Stand 2026) with a
 * VISIBLE source note - they become the maintained sheet only when the parent
 * saves. Pure presentational: the parent owns the {@link SupplyPriceFormValues}
 * state and its parsing/persistence.
 */
export function SupplyPriceFields({
  tarifArt,
  values,
  onChange,
  idPrefix,
}: {
  tarifArt: TarifArt;
  values: SupplyPriceFormValues;
  onChange: (field: keyof SupplyPriceFormValues, value: string) => void;
  idPrefix: string;
}) {
  if (!showSupplyPriceFields(tarifArt)) {
    return (
      <p className="vp-note" style={{ margin: 0 }}>
        {SUPPLY_PRICE_FEST_HINT}
      </p>
    );
  }
  const sum = supplyPriceComponentsSumCt(values);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div>
        <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>Bezugspreis-Komponenten</div>
        <p className="vp-note" style={{ margin: '0.2rem 0 0' }}>
          Die Bestandteile Ihres Bezugspreises (Preisblatt Ihres Netzbetreibers +
          Stromrechnung). Damit bewerten wir Netzbezug realistisch statt nur zum
          Börsenpreis. {SUPPLY_PRICE_SOURCE_NOTE}
        </p>
      </div>
      {SUPPLY_PRICE_FIELDS.map((f) => {
        // E2: dieselbe Plausibilitäts-WARNUNG wie bei der Schnell-Zahl - der
        // „Vertriebsaufschlag" heißt fast wie der Sammelaufschlag eine Maske
        // höher und meint doch nur die Marge.
        const warn = supplyComponentWarning(f.key, values[f.key]);
        return (
          <div key={f.key} className="vp-tarif-field">
            <Input
              id={`${idPrefix}-${f.key}`}
              label={f.label}
              hint={f.help}
              inputMode="decimal"
              placeholder={String(f.suggestion)}
              value={values[f.key]}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(f.key, e.target.value)}
            />
            {warn && <p className="vp-tarif-warn">{warn}</p>}
          </div>
        );
      })}
      <Input
        id={`${idPrefix}-ustPct`}
        label="Umsatzsteuer (%)"
        hint="19 % für Haushalte; 0 bei Vorsteuer-Abzug (Gewerbe)."
        inputMode="decimal"
        placeholder="19"
        value={values.ustPct}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange('ustPct', e.target.value)}
      />
      <Input
        id={`${idPrefix}-komponentenStand`}
        label="Preisblatt gültig ab (optional)"
        hint="Datum Ihres Netzbetreiber-Preisblatts."
        type="date"
        value={values.komponentenStand}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
          onChange('komponentenStand', e.target.value)
        }
      />
      <p className="vp-note" style={{ margin: 0 }}>
        Summe der Komponenten:{' '}
        {sum.toLocaleString('de-DE', { maximumFractionDigits: 3 })} ct/kWh netto
        (zzgl. Börsenpreis und USt).
      </p>
    </div>
  );
}
