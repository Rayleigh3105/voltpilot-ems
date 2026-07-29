import { Input } from '../../designsystem/components/forms/Input';
import type { TarifArt } from '../api';
import { SupplyPriceFields } from './SupplyPriceFields';
import type { SupplyPriceFormValues } from '../supplyPrice';

/**
 * The site tariff inputs (captain decision 1+5, 2026-07-08): a Tarif-Art select
 * (Dynamisch / Fest / Ohne) + a conditional ct/kWh parameter - the fixed retail
 * price for "Fest", the optional Börsenpreis-Aufschlag for "Dynamisch". These
 * live on the Anlage SETTINGS (Technik / gear), never on the money view: the
 * money page shows only the traceable results. Shared by the customer site edit
 * form and the admin create drawer so the wording stays in one place.
 *
 * Pure presentational - the parent owns the state and parses the value with
 * `parsePremiumInput` (empty = null, invalid = undefined -> a German error).
 */
export function TariffFields({
  tarifArt,
  onTarifArt,
  param,
  onParam,
  idPrefix,
  supplyValues,
  onSupplyChange,
}: {
  tarifArt: TarifArt;
  onTarifArt: (art: TarifArt) => void;
  param: string;
  onParam: (text: string) => void;
  idPrefix: string;
  /**
   * The structured Bezugspreis-Komponenten (Stufe 2). When provided, the
   * component fields render behind the Tarif-Art select; omit them to keep the
   * plain tariff form (e.g. the admin create drawer).
   */
  supplyValues?: SupplyPriceFormValues;
  onSupplyChange?: (field: keyof SupplyPriceFormValues, value: string) => void;
}) {
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <label htmlFor={`${idPrefix}-tarifart`} style={{ fontSize: '0.9rem', fontWeight: 600 }}>
          Stromtarif
        </label>
        <select
          id={`${idPrefix}-tarifart`}
          className="vp-select"
          value={tarifArt}
          onChange={(e) => onTarifArt(e.target.value as TarifArt)}
        >
          <option value="dynamisch">Dynamisch (Börsenpreis-gekoppelt)</option>
          <option value="fest">Fest (ct/kWh)</option>
          <option value="ohne">Ohne Angabe</option>
        </select>
        <p className="vp-note" style={{ margin: 0 }}>
          Für den Wert Ihres Eigenverbrauchs. Bei „Ohne Angabe" zeigen wir den
          Eigenverbrauch nur in kWh, nie einen erfundenen Euro-Wert.
        </p>
      </div>
      {tarifArt === 'dynamisch' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <Input
            label="Aufschlag auf den Börsenpreis (ct/kWh)"
            placeholder="z. B. 18"
            inputMode="decimal"
            value={param}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onParam(e.target.value)}
          />
          <p className="vp-note" style={{ margin: 0 }}>
            Netzentgelte, Abgaben &amp; Marge - steht auf Ihrer Stromrechnung. Ohne
            Aufschlag rechnen wir nur zum Börsenpreis (konservativ).
          </p>
        </div>
      )}
      {tarifArt === 'fest' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <Input
            label="Ihr Strompreis (ct/kWh)"
            placeholder="z. B. 32,5"
            inputMode="decimal"
            value={param}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onParam(e.target.value)}
          />
          <p className="vp-note" style={{ margin: 0 }}>
            Ihr fester Arbeitspreis - siehe Stromrechnung.
          </p>
        </div>
      )}
      {supplyValues && onSupplyChange && (
        <SupplyPriceFields
          tarifArt={tarifArt}
          values={supplyValues}
          onChange={onSupplyChange}
          idPrefix={`${idPrefix}-supply`}
        />
      )}
    </>
  );
}
