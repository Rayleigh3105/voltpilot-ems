import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../designsystem/components/core/Icon';
import { fokussierbare } from './VpPanel';

/**
 * **Das Bottom-Sheet des Verlaufs** (Konzept `data/vp-verlauf-sprache-konzept-v5`
 * §3.2 V9; Captain-Entscheid E5 wörtlich: „a) echtes Bottom-Sheet (V9)").
 *
 * Der behobene Befund ist B8: es GAB zwei Blätter, und keines war ein Sheet.
 * Das Explorer-Blatt stand `position: static` IM FLUSS (nur sein Schleier war
 * `fixed`), war auf `80vh` statt `dvh` gedeckelt, sperrte den Seiten-Scroll
 * NICHT, hielt den Fokus NICHT und kannte keine Safe-Area; das ⋯-Blatt der
 * Zeit-Leiste stand ebenso im Fluss und ließ die Seite um 226 px wachsen.
 * Beides sind Zusagen, die eine Fläche entweder hält oder nicht — deshalb
 * wohnen sie ab jetzt an EINER Stelle statt zweimal halb.
 *
 * ⚠ ES IST EIN BAUSTEIN, KEIN ZWEITER DIALOG-STAPEL. Die Fokus-Falle,
 * der Scroll-Sperrer und die Fokus-Rückgabe sind wörtlich das Muster des
 * Hauses (`CenteredConfirmDialog` + `fokussierbare` aus `VpPanel`) — ein
 * zweiter Mechanismus für dieselbe Zusage wäre genau die Uneinheitlichkeit,
 * die dieses Paket abstellt.
 *
 * ⚠ ES GIBT KEINEN EIGENEN `prefers-reduced-motion`-BLOCK. Die Einblendung
 * hängt an `--vp-c-motion`, und P0 setzt genau dieses Token unter
 * `prefers-reduced-motion` auf 0 — an EINER Stelle, dem Media-Block unter dem
 * `:root` von `index.css`. Ein zweiter Block hier wäre ein Zwilling, der
 * abdriften kann.
 *
 * ⚠ ES IST DIE TELEFON-FORM. Am Rechner (≥ 721 px) bleibt der Explorer seine
 * Rail; der Aufrufer entscheidet über `useIsPhone`, ob er dieses Sheet
 * überhaupt öffnet. Der Baustein selbst kennt keine Breite — er wäre sonst
 * die zweite Stelle, an der die 720-px-Grenze steht.
 */
export function BottomSheet({
  open,
  title,
  onClose,
  children,
  footer,
  className,
}: {
  open: boolean;
  /** Die Überschrift — sie benennt das Sheet auch für Screenreader (`aria-labelledby`). */
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Die klebende Fußzeile („Fertig"), inklusive Safe-Area-Polster. */
  footer?: ReactNode;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  /* Scroll-Sperre + Fokus hinein und beim Schließen ZURÜCK auf den Auslöser.
     Der Auslöser wird beim Öffnen gemerkt, nicht beim Schließen gesucht: zu
     dem Zeitpunkt liegt der Fokus im Sheet, das gleich verschwindet. */
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
      onClose();
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

  return createPortal(
    <div className="vp-bs-wrap">
      <div className="vp-bs-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className={className ? `vp-bs ${className}` : 'vp-bs'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={tastatur}
      >
        <div className="vp-bs-grip" aria-hidden="true" />
        <div className="vp-bs-head">
          <h2 id={titleId} className="vp-bs-title">
            {title}
          </h2>
          <button type="button" className="vp-bs-close" aria-label="Schließen" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="vp-bs-body">{children}</div>
        {footer ? <div className="vp-bs-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
