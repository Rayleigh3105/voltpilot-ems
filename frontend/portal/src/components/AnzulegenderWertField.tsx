import { Input } from '../../designsystem/components/forms/Input';

/**
 * The "Anzulegender Wert (ct/kWh)" input + help copy, extracted verbatim from
 * the former `VerguetungEditForm` for v3.1-M3: the Direktvermarktungs-Vertragsfakt
 * of the Marktprämie moved OUT of the general Technik "Vergütung & Tarif"
 * section and INTO the Marktoptimierung container. Presentational: the parent
 * owns the German-decimal text and parses it (`parsePremiumInput`).
 */
export function AnzulegenderWertField({
  value,
  onChange,
}: {
  value: string;
  onChange: (text: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <Input
        label="Anzulegender Wert (ct/kWh)"
        placeholder="z. B. 8,11"
        inputMode="decimal"
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      />
      <p className="vp-note" style={{ margin: 0 }}>
        Steht in Ihrem EEG-Zuschlag bzw. Direktvermarktungsvertrag. Optional -
        wenn angegeben, rechnen wir Ihre Marktprämie (anzulegender Wert minus
        Monatsmarktwert Solar) in Ihren Mehrerlös ein; bei negativen
        Börsenpreisen entfällt sie.
      </p>
    </div>
  );
}
