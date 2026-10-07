import { useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../designsystem/components/core/Icon';
import { useAusblenden } from '../../designsystem/components/shell/ausblenden';
import { fokusFalle, useUeberlagerung } from '../../designsystem/components/shell/ueberlagerung';
// Die Sheet-Stile (`.vp-bs*`) wohnen in `Verlauf.css`; ohne diesen Import stand
// das Blatt auf jeder Seite ohne Explorer ungestylt da.
import './Verlauf.css';

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
 * ⚠ ES IST EIN BAUSTEIN, KEIN ZWEITER DIALOG-STAPEL. Fokus-Falle,
 * Scroll-Sperre, Escape und Fokus-Rückgabe kommen aus DEMSELBEN Stapel wie im
 * `Modal` (`ueberlagerung.js`): ein gezählter Sperrer und ein Stapel für das
 * ganze Haus. Blätter folgen aufeinander (Gruppe → Teil, Blatt → Modal) und
 * stecken ineinander (Erklär-Blatt im Teil-Blatt); mit einem eigenen „vorher
 * gemerkten" `overflow` blieb die Seite nach Gruppe → Teil → Schließen
 * gesperrt, und Escape im inneren Blatt schloss auch das äußere (Review
 * Nachweisen r1, Q-1/Q-2).
 *
 * ⚠ ES BLENDET AUS, NICHT NUR EIN (Bewegungs-Programm P6, Konzept §6 Zeile
 * „Bottom-Sheet / Picker"): das Blatt federt in `--vp-motion-page` von unten
 * herein (`--vp-ease-feder`, leichtes Überschwingen) und geht in
 * `--vp-motion-exit` wieder nach unten. Bis dahin bleibt es im Baum und trägt
 * `is-closing` — derselbe `useAusblenden`-Baustein wie im Modal, damit „geht
 * gerade" im ganzen Haus dasselbe Wort und dieselbe Dauer hat. Das Wischen
 * bleibt der ZUSATZ; das sichtbare Schließen gilt weiter.
 *
 * ⚠ ES GIBT KEINEN EIGENEN `prefers-reduced-motion`-BLOCK. Die Dauern SIND die
 * Token der Familie `--vp-motion-*`, und P0 nullt sie unter
 * `prefers-reduced-motion` an EINER Stelle, dem Media-Block unter dem `:root`
 * von `index.css` — auch die WARTEZEIT, denn `useAusblenden` misst dasselbe
 * Token. Ein zweiter Block hier wäre ein Zwilling, der abdriften kann.
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
  const { sichtbar, schliessend } = useAusblenden(open, panelRef);

  /* Scroll-Sperre, Fokus hinein, Escape für das oberste Blatt und beim
     Schließen der Fokus ZURÜCK auf den Auslöser - gemerkt beim Öffnen, nicht
     beim Schließen gesucht: zu dem Zeitpunkt liegt der Fokus im Sheet, das
     gleich verschwindet. */
  useUeberlagerung(sichtbar, panelRef, onClose);

  if (!sichtbar) return null;

  const tastatur = (event: ReactKeyboardEvent) => fokusFalle(event, panelRef.current);

  return createPortal(
    <div className={schliessend ? 'vp-bs-wrap is-closing' : 'vp-bs-wrap'}>
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
