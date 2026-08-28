import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { fokussierbare } from './VpPanel';
import './CenteredConfirmDialog.css';

/**
 * Eine kurze, ZENTRIERTE Rückfrage. Bewusst kein Drawer: Sie bestätigt eine
 * Handlung auf einer bereits sichtbaren Seite und soll weder den Kontext in
 * eine Seitenleiste verschieben noch wie ein zweiter Bearbeitungsort wirken.
 */
export function CenteredConfirmDialog({
  open,
  title,
  intro,
  consequences,
  confirmLabel,
  cancelLabel = 'Abbrechen',
  tone = 'neutral',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  intro: string;
  consequences: string[];
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'neutral' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const vorherigerFokus = document.activeElement as HTMLElement | null;
    const vorherigerOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = vorherigerOverflow;
      vorherigerFokus?.focus();
    };
  }, [open]);

  if (!open) return null;

  const tastatur = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const elemente = fokussierbare(panelRef.current);
    if (elemente.length === 0) return;
    const aktuell = document.activeElement as HTMLElement | null;
    const index = aktuell ? elemente.indexOf(aktuell) : -1;
    const ziel = event.shiftKey
      ? elemente[(index <= 0 ? elemente.length : index) - 1]
      : elemente[(index + 1) % elemente.length];
    event.preventDefault();
    ziel?.focus();
  };

  const dialog = (
    <div
      className="vp-center-confirm-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}
    >
      <div
        ref={panelRef}
        className={`vp-center-confirm${tone === 'danger' ? ' is-danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vp-center-confirm-title"
        tabIndex={-1}
        onKeyDown={tastatur}
      >
        <header>
          <span className="vp-center-confirm-icon" aria-hidden="true">
            <Icon name={tone === 'danger' ? 'alert-triangle' : 'info'} size={20} />
          </span>
          <div>
            <h2 id="vp-center-confirm-title">{title}</h2>
            <p>{intro}</p>
          </div>
        </header>
        <ul>
          {consequences.map((consequence) => <li key={consequence}>{consequence}</li>)}
        </ul>
        <footer>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button
            variant={tone === 'danger' ? 'outline' : 'primary'}
            className={tone === 'danger' ? 'vp-btn-danger' : undefined}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </Button>
        </footer>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
