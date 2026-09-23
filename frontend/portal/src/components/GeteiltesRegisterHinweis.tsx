import { UEMS_GETEILT_HINWEIS, UEMS_GETEILT_TITEL } from '../glossar';
import './GeteiltesRegisterHinweis.css';

/**
 * Summen-Wächter des geteilten Punkts (AP-07 IP-18b): je Fund ein Satz („MS-12 und MS-13 hängen am selben Register der
 * VoltPilot-Box.“), eine Warnung NEBEN den Zahlen — sie ändert keine und sperrt nichts. Dieselbe Zeile an Energiebilanz,
 * Formel und Kennzahl; Form wie die Kostenstellen-Warnung „Doppelt gezählt“. Ohne Satz nichts.
 */
export function GeteiltesRegisterHinweis({ saetze }: { saetze: readonly string[] }) {
  if (saetze.length === 0) return null;
  return (
    <p className="vp-geteilt" role="note" data-testid="geteiltes-register">
      <span className="vp-geteilt-punkt" aria-hidden="true" />
      <span>
        <strong>{UEMS_GETEILT_TITEL}:</strong> {saetze.join(' · ')}
        <span className="vp-geteilt-hinweis"> {UEMS_GETEILT_HINWEIS}</span>
      </span>
    </p>
  );
}
