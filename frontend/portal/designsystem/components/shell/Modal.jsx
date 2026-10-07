import React from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../core/Icon';
import { useAusblenden } from './ausblenden';
import { fokusFalle, useUeberlagerung } from './ueberlagerung';

/**
 * **VoltPilot Modal** — die zentrierte Fläche für BEIDES: „anlegen"-Formulare
 * und Zeilen-Detailansichten (das wiederholbare Entitäts-Muster). Schleier-
 * Klick, ✕ und Escape schließen; der Seiten-Scroll ist gesperrt, der Fokus
 * liegt in der Fläche und bleibt darin, und am Telefon wird sie ein
 * Vollbild-Blatt (shell.css). Mit `blatt` ist sie am Telefon ein Blatt von
 * unten, so hoch wie sein Inhalt (kurze Abläufe: melden, prüfen, planen -
 * Verbessern-Konzept v1 §6.9), am Rechner dieselbe zentrierte Fläche; `breit`
 * gibt ihr am Rechner 840 px (ein Dialog mit Zusammenfassung daneben).
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
  blatt = false,
  breit = false,
  children,
  ...props
}) {
  const panelRef = React.useRef(null);

  // Scroll-Sperre, Fokus und Escape hängen bewusst an `sichtbar`, nicht an `open`: solange die Fläche noch ausblendet,
  // steht sie im Baum und darf die Seite darunter weder scrollen noch den Fokus verlieren lassen. Modale dürfen
  // gestapelt sein (die Messwert-Bibliothek samt Rückfrage, ein Blatt und sein Modal): Sperre, Fokus-Rückgabe und
  // Escape laufen deshalb über den EINEN Stapel der Überlagerungen (`ueberlagerung.js`), den auch das Bottom-Sheet nutzt.
  const { sichtbar, schliessend } = useAusblenden(open, panelRef);
  useUeberlagerung(sichtbar, panelRef, onClose);

  if (!sichtbar) return null;

  // Die Fokusfalle hält Tab/Shift-Tab in der Fläche. Escape läuft bewusst NICHT hier, sondern über den Stapel: er
  // trifft auch dann noch das oberste Modal, wenn der Fokus die Fläche verlassen hat.
  const tastatur = (e) => fokusFalle(e, panelRef.current);

  const modal = (
    <div
      className={`vp-modal-scrim${blatt ? ' is-blatt' : ''}${schliessend ? ' is-closing' : ''}`}
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`vp-modal${blatt ? ' is-blatt' : ''}${breit ? ' is-breit' : ''}`}
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
