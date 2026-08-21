import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useIsPhone } from '../useIsPhone';
import { VpPanel } from './VpPanel';
import { anzeige, imBereich, naechsteZeile, raster, RASTER_MIN, zeitLesen } from '../picker/zeit';

/**
 * `VpTimePicker` - die ZEIT-Variante derselben Anatomie. Sie löst
 * `<input type="time">` ab (Konzept `vp-picker-system`, Captain-Entscheid 1).
 *
 * <b>⚠ DAS RASTER IST EIN VORSCHLAG, KEINE VALIDIERUNG.</b> Die Liste zeigt
 * Viertelstunden, weil das die Zeiten sind, die in diesem Portal wirklich
 * getippt werden - aber getippt wird FREI. Ein Raster als einzige
 * Eingabemöglichkeit würde ändern, WELCHE Werte ein Formular annimmt, und die
 * Zusage der Umstellung lautet: keine Verhaltensänderung der Formulare. Eine
 * Regel, die heute 06:07 erlaubt, darf das morgen nicht plötzlich verbieten.
 *
 * <b>Das Feld ist deshalb ein echtes Eingabefeld</b> (`combobox` mit
 * `aria-autocomplete: list`), kein Knopf: darin tippt man `1807`, `18.07` oder
 * `18` und bekommt `18:07` bzw. `18:00` ({@link zeitLesen} - dieselbe Toleranz
 * wie die Modell-Suche, nur auf Uhrzeiten).
 *
 * <b>⚠ Der WERT bleibt `HH:MM`</b>, byte-gleich mit dem abgelösten nativen
 * Feld. Eine unleserliche Eingabe wird NIE geraten: das Feld meldet sie und
 * behält den letzten gültigen Wert.
 */
export function VpTimePicker({
  label,
  ariaLabel,
  value,
  onChange,
  step = RASTER_MIN,
  min,
  max,
  hint,
  error,
  disabled = false,
  id,
  name,
  placeholder = 'hh:mm',
  className,
  triggerClassName,
}: {
  label?: ReactNode;
  ariaLabel?: string;
  /** `HH:MM`; `''`/`null` = nichts gewählt. */
  value: string | null;
  onChange: (wert: string) => void;
  /** Abstand der Vorschlagsliste in Minuten. */
  step?: number;
  /** Grenzen als `HH:MM` (einschliesslich). */
  min?: string | null;
  max?: string | null;
  hint?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  id?: string;
  name?: string;
  placeholder?: string;
  className?: string;
  triggerClassName?: string;
}) {
  const reactId = useId();
  const basisId = id ?? `vpt-${reactId}`;
  const listeId = `${basisId}-liste`;
  const isPhone = useIsPhone();
  const [offen, setOffen] = useState(false);
  /** Was im Feld STEHT - nicht zwangsläufig ein gültiger Wert. */
  const [text, setText] = useState(value ?? '');
  const [fehler, setFehler] = useState<string | null>(null);
  const [aktiv, setAktiv] = useState(-1);
  const feldRef = useRef<HTMLInputElement>(null);
  const listeRef = useRef<HTMLDivElement>(null);

  // Ein Wert von aussen gewinnt - aber nur, wenn hier gerade nicht getippt wird.
  useEffect(() => {
    if (!offen) setText(value ?? '');
  }, [value, offen]);

  const zeilen = useMemo(
    () => raster(step, min ?? '00:00', max),
    [step, min, max],
  );

  useEffect(() => {
    if (!offen) return;
    setAktiv(value ? naechsteZeile(zeilen, value) : 0);
  }, [offen, value, zeilen]);

  useLayoutEffect(() => {
    if (!offen || aktiv < 0) return;
    listeRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${aktiv}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [offen, aktiv]);

  const schliessen = (fokusZurueck = true) => {
    setOffen(false);
    setAktiv(-1);
    if (fokusZurueck) feldRef.current?.focus();
  };

  /** Übernehmen, was im Feld steht - oder den Grund nennen. */
  const uebernehmen = (roh: string, schliessen_ = false) => {
    const t = roh.trim();
    if (t === '') {
      setFehler(null);
      onChange('');
      if (schliessen_) schliessen();
      return;
    }
    const gelesen = zeitLesen(t);
    if (!gelesen) {
      setFehler('Das ist keine Uhrzeit. Beispiel: 18:30 oder 1830.');
      return;
    }
    if (!imBereich(gelesen, min, max)) {
      setFehler(
        min && max
          ? `Bitte zwischen ${min} und ${max} Uhr.`
          : min
            ? `Frühestens ${min} Uhr.`
            : `Spätestens ${max} Uhr.`,
      );
      return;
    }
    setFehler(null);
    setText(gelesen);
    onChange(gelesen);
    if (schliessen_) schliessen();
  };

  const aufTaste = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') return; // gehören der Schale
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!offen) {
        setOffen(true);
        return;
      }
      setAktiv((a) => {
        const n = a + (e.key === 'ArrowDown' ? 1 : -1);
        return Math.min(Math.max(n, 0), zeilen.length - 1);
      });
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      if (!offen) return;
      e.preventDefault();
      setAktiv(e.key === 'Home' ? 0 : zeilen.length - 1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Eine getippte Zeit schlägt die markierte Zeile: wer tippt, meint das
      // Getippte - sonst überschriebe die Liste eine bewusste Eingabe.
      const gelesen = zeitLesen(text);
      if (gelesen && gelesen !== value) uebernehmen(text, true);
      else if (offen && aktiv >= 0) {
        setText(zeilen[aktiv]);
        onChange(zeilen[aktiv]);
        setFehler(null);
        schliessen();
      } else uebernehmen(text, true);
    }
  };

  const feld = (
    <input
      ref={feldRef}
      id={basisId}
      type="text"
      inputMode="numeric"
      role="combobox"
      aria-expanded={offen}
      aria-controls={offen ? listeId : undefined}
      aria-autocomplete="list"
      aria-activedescendant={offen && aktiv >= 0 ? `${basisId}-o${aktiv}` : undefined}
      aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
      aria-invalid={error || fehler ? true : undefined}
      placeholder={placeholder}
      autoComplete="off"
      disabled={disabled}
      value={text}
      className={`vp-picker-zeitfeld${triggerClassName ? ` ${triggerClassName}` : ''}`}
      onChange={(e) => {
        setText(e.target.value);
        setFehler(null);
      }}
      /**
       * ⚠ Das Feld öffnet auf KLICK und Pfeil-ab, NICHT auf blossen Fokus.
       * Zwei Gründe, beide im Browser aufgefallen bzw. abgewogen: (1) beim
       * Schliessen kehrt der Fokus ins Feld zurück - ein Öffnen-bei-Fokus
       * riss das Panel damit sofort wieder auf, eine Auswahl liess sich gar
       * nicht abschliessen; (2) wer mit Tab durch ein Formular geht, will
       * nicht bei jedem Halt ein Panel aufklappen sehen.
       */
      onClick={() => setOffen(true)}
      onBlur={() => uebernehmen(text)}
      onKeyDown={aufTaste}
    />
  );

  return (
    <div className={`vp-picker vp-picker-zeit${className ? ` ${className}` : ''}`}>
      {/* Die Zeit hat KEINEN Knopf-Auslöser, sondern ein echtes Eingabefeld -
          siehe oben: das Raster ist ein Vorschlag, kein Zwang. Die Schale
          liefert nur Panel, Verankerung und Sheet. */}
      <VpPanel
        basisId={`${basisId}-anker`}
        listeId={listeId}
        label={label}
        ariaLabel={ariaLabel}
        text={anzeige(value ?? '') ?? placeholder}
        leer={!value}
        offen={offen}
        setOffen={setOffen}
        schliessen={schliessen}
        disabled={disabled}
        hint={hint}
        error={error ?? fehler}
        icon="history"
        isPhone={isPhone}
        onOpened={() => feldRef.current?.focus()}
        ausloeserInhalt={feld}
        triggerAsField
      >
        <div
          ref={listeRef}
          id={listeId}
          role="listbox"
          aria-label={ariaLabel ?? (typeof label === 'string' ? label : 'Uhrzeit')}
          className="vp-picker-liste vp-picker-zeitliste"
          onKeyDown={aufTaste}
        >
          {zeilen.map((z, i) => (
            <div
              key={z}
              id={`${basisId}-o${i}`}
              data-idx={i}
              role="option"
              aria-selected={z === value}
              className={
                'vp-picker-zeile'
                + (i === aktiv ? ' is-aktiv' : '')
                + (z === value ? ' is-gewaehlt' : '')
              }
              onMouseMove={() => setAktiv(i)}
              onClick={() => {
                setText(z);
                setFehler(null);
                onChange(z);
                schliessen();
              }}
            >
              <span className="vp-picker-text">
                <span className="vp-picker-haupt">{z}</span>
              </span>
            </div>
          ))}
        </div>
        {name && <input type="hidden" name={name} value={value ?? ''} />}
      </VpPanel>
    </div>
  );
}
