import { forwardRef, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { DEVICE_ID_FIELD, normalizeDeviceIdInput } from '../anlageFlow';
import { kennungFehler, pruefeKennung } from '../edgeRef';

/**
 * Das EINE Feld für die Kennung einer VoltPilot-Box (Anlage-Flow a1, B4): im Anlege-Schritt
 * „Box“ und im Dialog „VoltPilot-Box hinzufügen“. Es nimmt, was der Kunde tippt oder einfügt,
 * ergänzt „edge-“, setzt Kleinschreibung und prüft das Prüfzeichen beim Tippen (`edgeRef.ts`) -
 * ein verwechseltes Zeichen wird nie ein Gerät, das sich nie meldet.
 *
 * `frei`: die Plattform darf weiter freie Kennungen verbinden (Entwicklung, Integrationen; der
 * Server erlaubt sie nur ihr) - dann ohne Prüfung, wie bisher.
 */
export const KennungFeld = forwardRef<
  HTMLInputElement,
  {
    id?: string;
    wert: string;
    onWert: (wert: string) => void;
    /** Der Kunde hat gesendet: jetzt sagt auch ein leeres oder unvollständiges Feld etwas. */
    abgeschickt: boolean;
    /** Ein Satz des Servers (422/409) am Feld. */
    serverFehler?: string | null;
    frei?: boolean;
    pflicht?: boolean;
    onEnter?: () => void;
  }
>(function KennungFeld({ id, wert, onWert, abgeschickt, serverFehler = null, frei = false, pflicht = false, onEnter }, ref) {
  const [verlassen, setVerlassen] = useState(false);
  const pruefung = pruefeKennung(wert);
  const fehler = serverFehler
    ?? (frei
      ? abgeschickt && !wert.trim() ? 'Bitte tragen Sie die Kennung Ihrer Box ein.' : null
      : kennungFehler(pruefung, abgeschickt || (verlassen && pruefung.zustand !== 'leer')));
  const stimmt = !frei && !fehler && pruefung.zustand === 'gueltig';
  return (
    <Input
      ref={ref}
      id={id}
      label={`${DEVICE_ID_FIELD.label}${pflicht ? ' *' : ''}`}
      placeholder={DEVICE_ID_FIELD.placeholder}
      value={wert}
      autoComplete="off"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
        onWert(frei ? normalizeDeviceIdInput(e.target.value) : e.target.value.toLowerCase());
        setVerlassen(false);
      }}
      onBlur={() => {
        setVerlassen(true);
        // Beim Verlassen steht im Feld, was gesendet wird („k7m2xq3“ → „edge-k7m2xq3“).
        if (!frei && pruefung.zustand !== 'leer' && pruefung.zustand !== 'zeichen') onWert(pruefung.kennung);
      }}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === 'Enter') onEnter?.();
      }}
      error={fehler}
      hint={
        stimmt ? (
          <span style={{ color: 'var(--vp-ok-ink)' }}>
            <Icon name="check" size={12} strokeWidth={3} style={{ verticalAlign: '-1px', marginRight: 4 }} />
            {pruefung.kennung === wert ? 'Kennung stimmt' : `Kennung stimmt: ${pruefung.kennung}`}
          </span>
        ) : null
      }
    />
  );
});
