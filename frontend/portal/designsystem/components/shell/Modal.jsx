import React from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../core/Icon';
import { fokussierbareElemente } from './fokus';
import { useAusblenden } from './ausblenden';

/*
 * Modals may be stacked (for example the measurement library plus its
 * confirmation). A saved `body.style.overflow` per instance is not enough:
 * if two modals unmount in one commit, the later cleanup can restore the
 * other modal's `hidden` value permanently. Keep one shared lock count and
 * restore the page value only after the last modal has gone.
 */
let scrollLocks = 0;
let pageOverflow = '';
const modalStack = [];

function lockBodyScroll() {
  if (scrollLocks === 0) pageOverflow = document.body.style.overflow;
  scrollLocks += 1;
  document.body.style.overflow = 'hidden';

  return () => {
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks === 0) {
      document.body.style.overflow = pageOverflow;
      pageOverflow = '';
    }
  };
}

/**
 * **VoltPilot Modal** — die zentrierte Fläche für BEIDES: „anlegen"-Formulare
 * und Zeilen-Detailansichten (das wiederholbare Entitäts-Muster). Schleier-
 * Klick, ✕ und Escape schließen; der Seiten-Scroll ist gesperrt, der Fokus
 * liegt in der Fläche und bleibt darin, und am Telefon wird sie ein
 * Vollbild-Blatt (shell.css).
 *
 * ⚠ ES GIBT KEINE SEITENLEISTE MEHR (Captain-Entscheid 04.09.2026: „search for
 * sidebars. I dont want them in my project. Every Sidebar should be a modal.").
 * Das frühere rechts einfahrende `Drawer` ist ERSATZLOS in dieses Modal
 * übergegangen — gleiche Prop-Schnittstelle, gleicher Aufbau (`.dhead` /
 * `.dbody` / `.dfoot`), damit die 39 Aufrufer nur Import und Namen tauschen.
 * Wächter gegen die Rückkehr: `src/keineSeitenleisten.test.ts`.
 *
 * ⚠ ES RENDERT NACH `document.body` (`createPortal`) — anders als das alte
 * Drawer, das im Fluss seines Aufrufers stand. Eine zentrierte Fläche darf
 * nicht am `overflow`/`transform` eines Vorfahren hängen; ein Test sucht sie
 * deshalb über `screen`/`document.body`, nie im Render-Container.
 *
 * ⚠ ES BLENDET IMMER AUS (Bewegungs-Programm P6, Konzept §6). Geht `open` auf
 * `false`, bleibt die Fläche noch `--vp-motion-exit` lang im Baum und trägt
 * `is-closing`; erst danach gibt sie Scroll-Sperre und Fokus zurück. Der
 * Zustand kommt aus `useAusblenden` — reines CSS + `useState`, KEIN Motion:
 * das Modal liegt im Einstiegs-Bündel (E10 a, `test/bundle-smoke.sh`).
 *
 * ⚠ ES GIBT KEINEN EIGENEN `prefers-reduced-motion`-BLOCK. Ein- und
 * Ausblenden hängen an der Token-Familie `--vp-motion-*`, und die steht unter
 * `prefers-reduced-motion` an EINER Stelle (dem Media-Block unter dem `:root`
 * von `index.css`) auf 0 — auch die WARTEZEIT, denn `useAusblenden` misst
 * dasselbe Token. Ein zweiter Block wäre ein Zwilling.
 */
export function Modal({
  open,
  onClose,
  title,
  icon = null,
  footer = null,
  children,
  ...props
}) {
  const panelRef = React.useRef(null);
  const closeRef = React.useRef(onClose);
  const tokenRef = React.useRef(null);
  closeRef.current = onClose;
  if (tokenRef.current === null) tokenRef.current = { panelRef };

  // Scroll-Sperre, Fokus-Falle und Escape hängen bewusst an `sichtbar`, nicht
  // an `open`: solange die Fläche noch ausblendet, steht sie im Baum und darf
  // die Seite darunter weder scrollen noch den Fokus verlieren lassen.
  const { sichtbar, schliessend } = useAusblenden(open, panelRef);

  React.useEffect(() => {
    if (!sichtbar) return undefined;
    const token = tokenRef.current;
    const unlockBodyScroll = lockBodyScroll();
    const prevFocus = document.activeElement;
    modalStack.push(token);
    panelRef.current?.focus();
    const onKey = (e) => {
      if (e.key !== 'Escape' || modalStack.at(-1) !== token) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const wasTopmost = modalStack.at(-1) === token;
      const index = modalStack.lastIndexOf(token);
      if (index >= 0) modalStack.splice(index, 1);
      unlockBodyScroll();
      if (wasTopmost && prevFocus?.isConnected && typeof prevFocus.focus === 'function') {
        prevFocus.focus();
      } else if (wasTopmost) {
        modalStack.at(-1)?.panelRef.current?.focus();
      }
    };
    // `onClose` deliberately lives in `closeRef`: controlled fields inside a
    // modal commonly rerender their owner on every key. An inline callback
    // must not tear down the modal effect, steal focus, and re-lock scrolling
    // after each character.
  }, [sichtbar]);

  if (!sichtbar) return null;

  // Die Fokusfalle hält Tab/Shift-Tab in der Fläche. Escape läuft bewusst
  // NICHT hier, sondern über den Stapel oben: er trifft auch dann noch das
  // oberste Modal, wenn der Fokus die Fläche verlassen hat.
  const tastatur = (e) => {
    if (e.key !== 'Tab') return;
    const elemente = fokussierbareElemente(panelRef.current);
    if (elemente.length === 0) return;
    const aktuell = document.activeElement;
    const index = aktuell ? elemente.indexOf(aktuell) : -1;
    const ziel = e.shiftKey
      ? elemente[(index <= 0 ? elemente.length : index) - 1]
      : elemente[(index + 1) % elemente.length];
    e.preventDefault();
    ziel?.focus();
  };

  const modal = (
    <div
      className={schliessend ? 'vp-modal-scrim is-closing' : 'vp-modal-scrim'}
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="vp-modal"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onKeyDown={tastatur}
        {...props}
      >
        <div className="dhead">
          {icon}
          <h2>{title}</h2>
          <button type="button" className="x" aria-label="Schließen" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="dbody">{children}</div>
        {footer && <div className="dfoot">{footer}</div>}
      </div>
    </div>
  );

  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}
