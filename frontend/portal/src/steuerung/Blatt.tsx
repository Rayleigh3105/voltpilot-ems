/**
 * DAS BLATT der Steuerung: am Telefon von unten, am Rechner zentriert - nie
 * eine Seitenleiste (`keineSeitenleisten.test.ts`).
 *
 * Es hält die Zusagen des Hauses (`BottomSheet`, `Modal`): Fokusfalle,
 * Escape, Rückkehr zum Auslöser (auch auf iOS, wo ein angetippter Knopf nicht
 * fokussiert wird - jeder Öffner fokussiert seinen Knopf vor dem Öffnen,
 * `e.currentTarget.focus()` wie `BenutzerPage`, und das Blatt merkt ihn sich),
 * Scroll-Sperre der Seite darunter und ein Ausblenden in der Dauer der
 * Bewegungs-Familie.
 */
import { useEffect, useId, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { fokussierbare } from '../components/VpPanel';
import { sperreSeitenScroll } from '../../designsystem/components/shell/ueberlagerung';
import { Ic, type IcName } from './Ic';

export interface BlattProps {
  /** Symbol im Kopf. */
  symbol?: IcName | string;
  titel: string;
  unter?: string | null;
  /** Ein eigener Kopf statt Symbol/Titel (z. B. mit Zurück-Pfeil). */
  kopf?: ReactNode;
  fuss?: ReactNode;
  voll?: boolean;
  onClose: () => void;
  children: ReactNode;
}

const AUSBLENDEN_MS = 280;

/**
 * Die offenen Blätter, das oberste zuletzt - dieselbe Stapel-Prüfung wie `Modal.jsx`: Escape trifft nur
 * das oberste, auch wenn der Fokus das Blatt verlassen hat. Safari/WebKit fokussiert einen angetippten
 * Knopf nicht; ein Hörer nur am Blatt selbst bekam Escape danach nie (Gesamtlauf 04./05.10.2026).
 */
const offeneBlaetter: object[] = [];

export function Blatt({ symbol, titel, unter, kopf, fuss, voll, onClose, children }: BlattProps) {
  const [offen, setOffen] = useState(false);
  const titelId = useId();
  const blattRef = useRef<HTMLDivElement>(null);
  const ausloeser = useRef<HTMLElement | null>(null);
  const zu = useRef(false);
  const schliessenRef = useRef<() => void>(() => {});

  useEffect(() => {
    ausloeser.current = (document.activeElement as HTMLElement | null) ?? null;
    const marke = {};
    offeneBlaetter.push(marke);
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || offeneBlaetter[offeneBlaetter.length - 1] !== marke) return;
      // Liegt ein später geöffneter Dialog des Hauses darüber, gehört Escape ihm.
      const dialoge = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialoge.length && dialoge[dialoge.length - 1] !== blattRef.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      schliessenRef.current();
    };
    // Wie `Modal.jsx` in der Bubble-Phase: was im Blatt Escape selbst verbraucht (ein offener Picker), kommt zuerst.
    document.addEventListener('keydown', escape);
    // Der EINE gezählte Sperrer des Hauses (`ueberlagerung.js`), nicht ein eigener „vorher“-Wert.
    const freigeben = sperreSeitenScroll();
    const raf = requestAnimationFrame(() => setOffen(true));
    const fokus = window.setTimeout(() => {
      const f = blattRef.current?.querySelector<HTMLElement>('.sh-head button, .sh-body button, .sh-body input');
      f?.focus({ preventScroll: true });
    }, 60);
    return () => {
      document.removeEventListener('keydown', escape);
      const i = offeneBlaetter.lastIndexOf(marke);
      if (i >= 0) offeneBlaetter.splice(i, 1);
      cancelAnimationFrame(raf);
      window.clearTimeout(fokus);
      freigeben();
      const a = ausloeser.current;
      if (a && a.isConnected) a.focus({ preventScroll: true });
    };
  }, []);

  const schliessen = () => {
    if (zu.current) return;
    zu.current = true;
    setOffen(false);
    window.setTimeout(onClose, AUSBLENDEN_MS);
  };
  schliessenRef.current = schliessen;

  // Escape läuft über den Stapel oben; hier hält nur die Fokusfalle Tab/Shift-Tab im Blatt.
  const taste = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const f = fokussierbare(blattRef.current);
    if (!f.length) return;
    const erstes = f[0];
    const letztes = f[f.length - 1];
    if (e.shiftKey && document.activeElement === erstes) {
      e.preventDefault();
      letztes.focus();
    } else if (!e.shiftKey && document.activeElement === letztes) {
      e.preventDefault();
      erstes.focus();
    }
  };

  return createPortal(
    <div className={`stn-blatt${offen ? ' open' : ''}`} onKeyDown={taste}>
      <div className="sheet-scrim" onClick={schliessen} aria-hidden="true" />
      <div
        ref={blattRef}
        className={`sheet${voll ? ' voll' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titelId}
      >
        <div className="sh-head">
          <div className="grip" aria-hidden="true" />
          {kopf ? (
            <div className="sh-t">
              {kopf}
              <span id={titelId} className="sr">{titel}</span>
              <button type="button" className="ibtn" onClick={schliessen} aria-label="Schließen">
                <Ic n="x" s={22} />
              </button>
            </div>
          ) : (
            <div className="sh-t">
              {symbol && (
                <span className="ico">
                  <Ic n={symbol} s={22} />
                </span>
              )}
              <h2 id={titelId}>
                {titel}
                {unter && <small>{unter}</small>}
              </h2>
              <button type="button" className="ibtn" onClick={schliessen} aria-label="Schließen">
                <Ic n="x" s={22} />
              </button>
            </div>
          )}
        </div>
        <div className="sh-body">{children}</div>
        {fuss && <div className="sh-foot">{fuss}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Ein Blatt schliesst sich auch von innen (z. B. nach „Übernehmen“). */
export type Schliessen = () => void;
