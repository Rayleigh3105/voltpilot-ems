import type { ReactNode } from 'react';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { useIsPhone } from '../../useIsPhone';
import { BottomSheet } from '../BottomSheet';
import './Nachweisen.css';

/**
 * Das Blatt von Nachweisen (Konzept n1, Runde 2, §6.10/§6.11): am Telefon ein Blatt von unten über der abgedunkelten
 * Seite, am Rechner derselbe Inhalt als Dialog in der Mitte. Erklär-Blatt, Blatt einer Gruppe, „Fristen überfällig“
 * und die geführten Schritte der anderen Nachweisen-PRs stehen alle in diesem einen Behälter.
 *
 * ⚠ ES BAUT AUF DEN BAUSTEINEN DES HAUSES AUF, nicht daneben: am Telefon `BottomSheet` (Fokus hinein und zurück,
 * Scroll-Sperre, Escape, Wischen ist Zusatz, Ausblenden), am Rechner das `Modal` der Schale (dieselben Zusagen, zentriert).
 * Die Weiche ist `useIsPhone` (≤ 720 px), weil sich die STRUKTUR unterscheidet; beide Fassungen nebeneinander im DOM
 * verdoppelten Titel und Inhalt für Vorleser.
 *
 * Gestalt nach dem Konzept (`.sheet`, `.ddlg`): Titel in Navy, keine Linie unter dem Kopf; der Inhalt steht in
 * `.vp-nw-blatt-inhalt`, an dem auch die Breite des Dialogs am Rechner hängt (schmal: Erklärung, Gruppe, Fristen).
 */
export function NwBlatt({
  open,
  titel,
  onClose,
  children,
  fuss,
  breit = false,
  testId,
}: {
  open: boolean;
  /** Die Überschrift - sie benennt das Blatt auch für Vorleser. */
  titel: string;
  onClose: () => void;
  children: ReactNode;
  /** Die klebende Fußzeile (etwa „Weiter“ eines geführten Schritts). */
  fuss?: ReactNode;
  /** Am Rechner breiter (geführte Schritte mit Zusammenfassung daneben); sonst schmal wie das Blatt am Telefon. */
  breit?: boolean;
  testId?: string;
}) {
  const isPhone = useIsPhone();
  const inhalt = (
    <div className={breit ? 'vp-nw-blatt-inhalt is-breit' : 'vp-nw-blatt-inhalt'} data-testid={testId}>
      {children}
    </div>
  );
  if (isPhone) {
    return (
      <BottomSheet open={open} title={titel} onClose={onClose} footer={fuss} className="vp-nw-blatt">
        {inhalt}
      </BottomSheet>
    );
  }
  return (
    <Modal open={open} onClose={onClose} title={titel} footer={fuss}>
      {inhalt}
    </Modal>
  );
}
