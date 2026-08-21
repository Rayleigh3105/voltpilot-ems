import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../designsystem/components/core/Icon';
import type { IconName } from '../../designsystem/components/core/Icon';
import './VpPicker.css';

/**
 * Die SCHALE aller VpPicker-Varianten: Auslöser in Feld-Optik + Panel.
 *
 * Auswahl, Kalender und Zeit-Raster sind DREI Inhalte in EINER Anatomie -
 * Verankerung, Kollisions-Umschlag, Bottom-Sheet, Fokus-Falle, Escape und
 * Klick-daneben gehören ihnen gemeinsam. Sie hier zu bündeln ist der
 * Unterschied zwischen einem Picker-SYSTEM und drei Pickern, die sich mit der
 * Zeit auseinanderentwickeln.
 *
 * <b>⚠ Das Panel hängt an `document.body`</b> mit FESTEN Koordinaten, nie
 * `absolute` im Feld. Die Haus-Regel (`AGENTS.md`): die Wirte (`Card`,
 * Tabellen, die Seitenleiste) tragen `overflow: hidden` - ein absolut
 * positioniertes Panel wäre dort abgeschnitten und seine unteren Zeilen
 * unklickbar (der `RowMenu`-Präzedenzfall).
 *
 * <b>⚠ Kein verstecktes natives Element als Krücke.</b> Ein `<select hidden>`
 * daneben wäre eine zweite Wahrheit über denselben Wert - und Vorlesesoftware
 * fände beide.
 */
export interface PanelPlatz {
  top: number;
  left: number;
  width: number;
  /** Nach OBEN aufgeklappt (Kollisions-Umschlag)? */
  oben: boolean;
}

/** Schmaler wird das Panel nie - darunter passt keine Nebenzeile mehr. */
export const MIN_PANEL_PX = 240;

/**
 * Die NATÜRLICHE Breite eines Kalenders bzw. eines Zeit-Rasters.
 *
 * ⚠ Eine AUSWAHL-Liste nimmt die Breite ihres Feldes - ihre Zeilen sind Text
 * und lesen sich in einem breiten Feld genauso gut. Ein KALENDER ist dagegen
 * ein Gitter mit sieben Spalten: über ein sehr breites Feld gezogen wird aus
 * dem Datumsblock eine Tapete, in der niemand mehr eine Woche als Zeile sieht
 * (im Browser an einem 1136 px breiten Feld gemessen). Er bekommt deshalb eine
 * Obergrenze und bleibt sonst linksbündig unter seinem Feld.
 */
export const MAX_KALENDER_PX = 320;

/** Ab wie vielen Pixeln ein Zug am Sheet-Griff wirklich schliesst. */
export const WISCH_ZU_PX = 90;

/**
 * KOLLISIONS-UMSCHLAG: unter dem Feld, sonst darüber - und immer waagerecht in
 * den sichtbaren Bereich geklemmt.
 */
export function platziere(
  feld: HTMLElement,
  panel: HTMLElement,
  maxPx?: number,
): PanelPlatz {
  const r = feld.getBoundingClientRect();
  const ph = panel.offsetHeight;
  const rand = 12;
  const luft = 4;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const roh = Math.max(r.width, MIN_PANEL_PX);
  const width = maxPx ? Math.min(roh, Math.max(maxPx, MIN_PANEL_PX)) : roh;
  const left = Math.max(rand, Math.min(r.left, Math.max(rand, vw - width - rand)));
  let top = r.bottom + luft;
  let oben = false;
  if (top + ph > vh - rand && r.top - luft - ph > rand) {
    top = r.top - luft - ph;
    oben = true;
  }
  top = Math.max(rand, Math.min(top, Math.max(rand, vh - ph - rand)));
  return { top, left, width, oben };
}

/** Alles Fokussierbare im Panel - die Fokus-Falle braucht die Ränder. */
export function fokussierbare(el: HTMLElement | null): HTMLElement[] {
  if (!el) return [];
  return Array.from(
    el.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

export function VpPanel({
  basisId,
  label,
  ariaLabel,
  text,
  leer,
  offen,
  setOffen,
  schliessen,
  disabled = false,
  hint,
  error,
  className,
  triggerClassName,
  icon,
  isPhone,
  children,
  onOpened,
  onTriggerKey,
  ausloeserInhalt,
  /** Für den Auswahl-Picker: die Liste, die der Auslöser ankündigt. */
  listeId,
  /** Wie sich das Panel anmeldet: `listbox` (Auswahl) oder `dialog` (Kalender). */
  haspopup = 'listbox',
  triggerAsField = false,
  labelFor,
  maxPanelPx,
}: {
  basisId: string;
  label?: ReactNode;
  ariaLabel?: string;
  text: string;
  leer: boolean;
  offen: boolean;
  setOffen: (v: boolean) => void;
  schliessen: (fokusZurueck?: boolean) => void;
  disabled?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  triggerClassName?: string;
  icon?: IconName;
  isPhone: boolean;
  children: ReactNode;
  /** Läuft, sobald das Panel im DOM steht - der Fokus geht HINEIN. */
  onOpened?: () => void;
  /** Tastendrücke auf dem GESCHLOSSENEN Auslöser (Tippen-zum-Springen). */
  onTriggerKey?: (e: ReactKeyboardEvent) => boolean;
  /** Ersetzt den Text im Auslöser (Chips der Mehrfachauswahl). */
  ausloeserInhalt?: ReactNode;
  listeId?: string;
  haspopup?: 'listbox' | 'dialog';
  /**
   * ⚠ Der Auslöser IST das Eingabefeld (Zeit-Variante), kein Knopf, der eines
   * enthält - ein `<input>` in einem `<button>` ist ungültiges HTML und für
   * Vorlesesoftware ein Knopf ohne Feld. Die Schale zeichnet dann nur den
   * Rahmen drumherum und überlässt Rolle, Fokus und Tastatur dem Inhalt.
   */
  triggerAsField?: boolean;
  /**
   * ⚠ Das Ziel der Beschriftung, wenn der Auslöser das Feld nur UMSCHLIESST.
   * In {@link triggerAsField}-Fassung traegt der Rahmen (`span`) keine `id`,
   * `htmlFor={basisId}` zeigte also ins Leere - Chrome meldet das als
   * „Incorrect use of `<label for=…>`", und ein Klick auf die Beschriftung
   * fokussierte nichts. Der Inhalt nennt hier die `id` seines echten Felds.
   */
  labelFor?: string;
  /** Obergrenze der Panel-Breite - siehe {@link MAX_KALENDER_PX}. */
  maxPanelPx?: number;
}) {
  const [platz, setPlatz] = useState<PanelPlatz | null>(null);
  const [wisch, setWisch] = useState(0);
  const wischStart = useRef<number | null>(null);
  const ausloeserRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const anhaengen = useCallback(() => {
    const feld = ausloeserRef.current;
    const panel = panelRef.current;
    if (!feld || !panel) return;
    setPlatz(platziere(feld, panel, maxPanelPx));
  }, [maxPanelPx]);

  useLayoutEffect(() => {
    if (!offen || isPhone) {
      setPlatz(null);
      return;
    }
    anhaengen();
  }, [offen, isPhone, anhaengen]);

  /**
   * ⚠ DER FOKUS GEHT ERST INS PANEL, WENN ES WIRKLICH SICHTBAR IST.
   *
   * Im echten Chrome gemessen (jsdom kann es nicht sehen - es kennt keine
   * Sichtbarkeit): `element.focus()` auf einem Nachfahren eines Elements mit
   * `visibility: hidden` ist ein NO-OP. Das Panel steht im ersten Durchgang
   * genau so da (es ist noch nicht vermessen), also lief der Fokus ins Leere -
   * das Suchfeld bekam ihn nie, und die ganze Tastatur-Bedienung war auf dem
   * Desktop tot, während jeder Test grün blieb.
   *
   * Zwei Riegel dagegen: der unvermessene Zustand ist jetzt `opacity: 0`
   * (fokussierbar) statt `visibility: hidden`, UND der Fokus wartet auf die
   * Verankerung.
   */
  const bereit = isPhone || platz != null;
  const fokussiert = useRef(false);
  useEffect(() => {
    if (!offen) {
      fokussiert.current = false;
      return;
    }
    if (!bereit || fokussiert.current) return;
    fokussiert.current = true;
    onOpened?.();
    // Der Fokus gehört danach dem Inhalt - deshalb genau EINMAL je Öffnen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offen, bereit]);

  useEffect(() => {
    if (!offen || isPhone) return;
    const neu = () => anhaengen();
    window.addEventListener('scroll', neu, true);
    window.addEventListener('resize', neu);
    return () => {
      window.removeEventListener('scroll', neu, true);
      window.removeEventListener('resize', neu);
    };
  }, [offen, isPhone, anhaengen]);

  useEffect(() => {
    if (!offen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || ausloeserRef.current?.contains(t)) return;
      schliessen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [offen, schliessen]);

  /** Escape + Fokus-Falle gelten für JEDEN Inhalt - deshalb hier. */
  const aufPanelTaste = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      schliessen();
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

  const panel = (
    <div
      ref={panelRef}
      className={
        `vp-picker-panel${isPhone ? ' is-sheet' : ''}`
        + (!isPhone && platz?.oben ? ' is-oben' : '')
      }
      style={
        isPhone
          ? wisch > 0
            ? { transform: `translateY(${wisch}px)` }
            : undefined
          : {
              // Vor der ersten Messung durchsichtig und unberührbar - sonst
              // blitzt das Panel für einen Frame links oben auf. ⚠ NICHT
              // `visibility: hidden`: darin ist `focus()` ein No-op (siehe
              // oben), und das Panel muss den Fokus sofort annehmen können.
              top: platz?.top ?? 0,
              left: platz?.left ?? 0,
              width: platz?.width,
              opacity: platz ? undefined : 0,
              pointerEvents: platz ? undefined : 'none',
            }
      }
      onKeyDown={aufPanelTaste}
    >
      {isPhone && (
        // WISCH-SCHLIESSEN: der Griff ist am Telefon die erwartete Geste. Ein
        // ZEIGER-Ereignis deckt Finger und Maus in EINEM Pfad ab.
        <div
          className="vp-picker-griff"
          role="presentation"
          onPointerDown={(e) => {
            wischStart.current = e.clientY;
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (wischStart.current == null) return;
            setWisch(Math.max(0, e.clientY - wischStart.current));
          }}
          onPointerUp={(e) => {
            const weg = wischStart.current == null ? 0 : e.clientY - wischStart.current;
            wischStart.current = null;
            setWisch(0);
            // Ein kurzer Zupfer schliesst NICHT - sonst fällt das Sheet bei
            // jedem Scroll-Versuch zu.
            if (weg > WISCH_ZU_PX) schliessen();
          }}
          onPointerCancel={() => {
            wischStart.current = null;
            setWisch(0);
          }}
        >
          <span />
        </div>
      )}
      {children}
    </div>
  );

  return (
    <div className={`vp-picker${className ? ` ${className}` : ''}${error ? ' is-fehler' : ''}`}>
      {label && (
        <label className="vp-picker-label" htmlFor={labelFor ?? basisId}>
          {label}
        </label>
      )}
      <div className="vp-picker-anker">
        {triggerAsField ? (
          <span
            className={
              `vp-picker-ausloeser is-feld${triggerClassName ? ` ${triggerClassName}` : ''}`
              + (leer ? ' is-leer' : '')
              + (disabled ? ' is-gesperrt' : '')
            }
            ref={(el) => {
              // Die Verankerung misst dieses Element - der Ref-Typ der Schale
              // ist ein Knopf, das Feld ist ein `span`. Beide sind HTMLElement,
              // und mehr braucht `getBoundingClientRect` nicht.
              (ausloeserRef as { current: HTMLElement | null }).current = el;
            }}
          >
            {icon && <Icon name={icon} size={16} className="vp-picker-ic" aria-hidden="true" />}
            {ausloeserInhalt}
            <button
              type="button"
              className="vp-picker-caretbtn"
              tabIndex={-1}
              aria-hidden="true"
              disabled={disabled}
              onClick={() => (offen ? schliessen() : setOffen(true))}
            >
              <Icon name="chevron-down" size={16} className="vp-picker-caret" />
            </button>
          </span>
        ) : (
        <button
          ref={(el) => {
            ausloeserRef.current = el;
          }}
          id={basisId}
          type="button"
          role="combobox"
          aria-haspopup={haspopup}
          aria-expanded={offen}
          aria-controls={offen ? listeId ?? `${basisId}-panel` : undefined}
          aria-label={ariaLabel}
          aria-invalid={error ? true : undefined}
          disabled={disabled}
          className={
            `vp-picker-ausloeser${triggerClassName ? ` ${triggerClassName}` : ''}`
            + (leer ? ' is-leer' : '')
          }
          onClick={() => (offen ? schliessen() : setOffen(true))}
          onKeyDown={(e) => {
            if (disabled) return;
            if (onTriggerKey?.(e)) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOffen(true);
            }
          }}
        >
          {icon && <Icon name={icon} size={16} className="vp-picker-ic" aria-hidden="true" />}
          <span className="vp-picker-wert">{ausloeserInhalt ?? text}</span>
          <Icon name="chevron-down" size={16} className="vp-picker-caret" aria-hidden="true" />
        </button>
        )}
      </div>
      {offen
        && createPortal(
          isPhone ? (
            <>
              <div
                className="vp-picker-backdrop"
                role="presentation"
                onClick={() => schliessen()}
              />
              {panel}
            </>
          ) : (
            panel
          ),
          document.body,
        )}
      {(hint || error) && (
        <span className={`vp-picker-hint${error ? ' is-fehler' : ''}`}>{error || hint}</span>
      )}
    </div>
  );
}
