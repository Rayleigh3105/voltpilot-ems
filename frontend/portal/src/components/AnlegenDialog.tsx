import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../designsystem/components/core/Icon';
import { useIsPhone } from '../useIsPhone';
import { fokussierbare } from './VpPanel';
import { fortschritt, fortschrittAnteil } from '../anlegenFlow';
import './AnlegenDialog.css';

/**
 * Die SCHALE des Anlege-Flusses (Anlegen-Rework Stufe 2, Captain-Entscheidung 1):
 * **Desktop = zentrierter Schritt-Dialog** (~2/3 Bildschirm, Schritt-Leiste oben,
 * der Kontext bleibt dahinter sichtbar), **Telefon = Vollbild-Schrittfolge**
 * (ein Schritt je Bild, Fortschritt oben).
 *
 * <b>Warum kein `Drawer` mehr.</b> Der Haus-Drawer ist eine 560-px-Seitenleiste -
 * für eine EINZELNE Frage (eine Zeile bearbeiten, eine Rückfrage) genau richtig,
 * für einen mehrstufigen Vorgang mit Formular, Testergebnis und Messwert-Tabelle
 * zu schmal: die Captain-Order nennt ihn wörtlich „unübersichtlich". Der Dialog
 * ist deshalb keine Kosmetik, sondern der Platz, den die Schritte brauchen.
 *
 * <b>⚠ Der Unterschied ist STRUKTURELL, nicht nur geometrisch</b> - deshalb
 * verzweigt er über {@link useIsPhone} und nicht nur per Medienabfrage: der
 * Rechner zeigt die BENANNTEN Schritte („Verbinden"), das Telefon den ZÄHLER
 * („Schritt 3 von 5") plus einen Balken. Beide Fassungen nebeneinander im DOM
 * zu halten verdoppelte die Schrittnamen für Vorlesesoftware.
 *
 * <b>⚠ Die Fokus-Falle ist Gegenstand, nicht Beiwerk.</b> Ein modaler Dialog,
 * aus dem der Tabulator in die Seite dahinter läuft, ist für eine Bedienung ohne
 * Maus kaputt - der Haus-`Drawer` hat sie nicht, dieser hier hat sie
 * (dieselbe Mechanik wie {@link VpPanel}). Escape schließt, der Rumpf hinter dem
 * Dialog scrollt nicht mit, der Fokus kehrt beim Schließen zurück.
 */
export function AnlegenDialog({
  titel,
  schritte: schrittListe,
  aktiv,
  onClose,
  onBack,
  footer,
  children,
}: {
  titel: string;
  /** Die Schritt-Leiste dieses Weges - sie hängt am Gerätetyp. */
  schritte: string[];
  /** Der laufende Schritt, 1-basiert. */
  aktiv: number;
  onClose: () => void;
  /**
   * Der Zurück-Weg der Vollbild-Fassung. Ohne ihn zeigt der Kopf am Telefon
   * nur das Schließen-Kreuz - ein Pfeil, der nichts tut, wäre schlimmer als
   * keiner.
   */
  onBack?: (() => void) | null;
  /**
   * Die Bedienzeile („Zurück"/„Weiter"). Sie steht KLEBEND am Fuß, damit sie
   * am Telefon nicht hinter einer langen Messwert-Liste verschwindet.
   */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const isPhone = useIsPhone();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const rumpfRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const prevFocus = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    };
  }, []);

  /*
    ⚠ Bei einem Schritt-Wechsel wandert der Fokus zurück ins Panel und der
    Rumpf nach oben. Ohne das fällt der Fokus auf den `body`, sobald der
    gedrückte Knopf verschwindet - wer ohne Maus arbeitet, steht dann wieder am
    Anfang des DOKUMENTS statt im Dialog (im Browser-Durchstich gefunden). Die
    Ansage daneben sagt Vorlesesoftware, WO man gelandet ist.
  */
  useEffect(() => {
    panelRef.current?.focus();
    if (rumpfRef.current) rumpfRef.current.scrollTop = 0;
  }, [aktiv]);

  const aufTaste = (e: ReactKeyboardEvent) => {
    /*
      ⚠ Nur Tasten aus dem Dialog SELBST. Ein Picker-Panel hängt an
      `document.body`, bleibt aber im React-Baum ein Kind dieses Dialogs -
      sein Tastendruck blubbert also hierher. Ohne diese Grenze würde die
      Fokus-Falle des Dialogs die des Panels überschreiben: der Tabulator
      spränge aus der offenen Geräteliste zurück in den Dialogkopf.
    */
    const quelle = e.target as Node | null;
    if (quelle && panelRef.current && !panelRef.current.contains(quelle)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const f = fokussierbare(panelRef.current);
    if (f.length === 0) return;
    const jetzt = document.activeElement as HTMLElement | null;
    const i = jetzt ? f.indexOf(jetzt) : -1;
    const ziel = e.shiftKey ? f[(i <= 0 ? f.length : i) - 1] : f[(i + 1) % f.length];
    e.preventDefault();
    ziel?.focus();
  };

  const dialog = (
    <>
      <div className="vp-anlegen-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={titel}
        className={`vp-anlegen-dialog${isPhone ? ' is-vollbild' : ''}`}
        onKeyDown={aufTaste}
      >
        <div className="vp-anlegen-kopf">
          {isPhone && onBack && (
            <button
              type="button"
              className="vp-anlegen-zurueck"
              aria-label="Einen Schritt zurück"
              onClick={onBack}
            >
              <Icon name="chevron-left" size={20} />
            </button>
          )}
          <div className="vp-anlegen-titel">
            <h2>{titel}</h2>
            {isPhone && (
              <p className="vp-anlegen-zaehler">{fortschritt(schrittListe, aktiv)}</p>
            )}
          </div>
          <button
            type="button"
            className="vp-anlegen-x"
            aria-label="Schließen"
            onClick={onClose}
          >
            <Icon name="x" size={20} />
          </button>
        </div>

        {isPhone ? (
          <div
            className="vp-anlegen-balken"
            role="progressbar"
            aria-valuenow={Math.min(aktiv, schrittListe.length)}
            aria-valuemin={1}
            aria-valuemax={schrittListe.length}
            aria-label={fortschritt(schrittListe, aktiv)}
          >
            <span style={{ width: `${fortschrittAnteil(schrittListe, aktiv) * 100}%` }} />
          </div>
        ) : (
          <ol className="vp-anlegen-steps" aria-label="Schritte">
            {schrittListe.map((s, i) => (
              <li
                key={s}
                className={aktiv === i + 1 ? 'is-active' : aktiv > i + 1 ? 'is-done' : ''}
                aria-current={aktiv === i + 1 ? 'step' : undefined}
              >
                <span className="vp-anlegen-step-n">{i + 1}</span>
                <span className="vp-anlegen-step-l">{s}</span>
              </li>
            ))}
          </ol>
        )}

        <p className="vp-anlegen-sr" role="status" aria-live="polite">
          {`${fortschritt(schrittListe, aktiv)}: ${
            schrittListe[Math.min(Math.max(aktiv, 1), schrittListe.length) - 1] ?? ''
          }`}
        </p>
        <div className="vp-anlegen-rumpf" ref={rumpfRef}>
          {children}
        </div>
        {footer && (
          <div className="vp-anlegen-fuss" data-testid="anlegen-fuss">
            {footer}
          </div>
        )}
      </div>
    </>
  );

  // Wie das Picker-Panel hängt der Dialog an `document.body`: seine Wirte
  // (Karten, Tabellen) tragen `overflow: hidden`, und ein zentrierter Dialog
  // darin wäre abgeschnitten (der dokumentierte `RowMenu`-Präzedenzfall).
  if (typeof document === 'undefined') return dialog;
  return createPortal(dialog, document.body);
}
