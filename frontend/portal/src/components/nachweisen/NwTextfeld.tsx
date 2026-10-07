import { useId } from 'react';
import './NwZeilen.css';

/**
 * Ein Textfeld in einem Blatt (Konzept n1, `.feld`): die Frage als Etikett darüber, das Feld mit dem Feldrand der Familie;
 * mehrzeilig für einen Satz oder einen Wortlaut. Der Wortlaut des Kunden zählt nicht in die Text-Grenze des Blatts.
 */
export function NwTextfeld({
  label,
  wert,
  onWert,
  mehrzeilig = false,
  platzhalter,
  fehler,
  hoechstens,
  gesperrt = false,
  testid,
}: {
  label: string;
  wert: string;
  onWert: (wert: string) => void;
  mehrzeilig?: boolean;
  platzhalter?: string;
  fehler?: string | null;
  hoechstens?: number;
  /** Steht fest (z. B. der Titel eines schon angelegten Dokuments): sichtbar, nicht änderbar. */
  gesperrt?: boolean;
  testid?: string;
}) {
  const id = `nw-feld-${useId().replace(/:/g, '')}`;
  const gemeinsam = {
    id,
    value: wert,
    placeholder: platzhalter,
    maxLength: hoechstens,
    disabled: gesperrt || undefined,
    'aria-invalid': fehler ? true : undefined,
    'aria-describedby': fehler ? `${id}-fehler` : undefined,
    'data-testid': testid,
    className: 'vp-nw-feld-in',
  };
  return (
    <div className="vp-nw-feld">
      <label htmlFor={id}>{label}</label>
      {mehrzeilig ? (
        <textarea {...gemeinsam} rows={3} onChange={(e) => onWert(e.target.value)} />
      ) : (
        <input {...gemeinsam} type="text" onChange={(e) => onWert(e.target.value)} />
      )}
      {fehler && (
        <p id={`${id}-fehler`} className="vp-nw-feld-fehler" role="alert">
          {fehler}
        </p>
      )}
    </div>
  );
}
