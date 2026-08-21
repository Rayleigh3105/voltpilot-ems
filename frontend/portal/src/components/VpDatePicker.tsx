import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { useIsPhone } from '../useIsPhone';
import { VpPanel } from './VpPanel';
import {
  anzeige,
  blaettern,
  datumVon,
  isoTag,
  monatsGitter,
  monatsTitel,
  tagWaehlbar,
  verschiebe,
  wertVon,
  WOCHENTAGE,
  type DatumsArt,
} from '../picker/datum';

/**
 * `VpDatePicker` - die DATUMS-Variante derselben Anatomie (Konzept
 * `vp-picker-system`, Captain-Entscheid 1: „wirklich nichts Browser-Standard
 * mehr; Kalender-Panel … in Portal-Optik").
 *
 * <b>EINE Komponente, drei Arten.</b> `tag` · `woche` · `monat` lösen
 * `<input type="date|week|month">` ab. Sie teilen sich dasselbe Gitter: die
 * Wochen-Auswahl markiert die ganze Zeile, die Monats-Auswahl den ganzen
 * Monat - eine zweite Kalender-Implementierung je Art wären drei Wahrheiten
 * über denselben August.
 *
 * <b>⚠ Der WERT bleibt ISO</b> (`JJJJ-MM-TT` / `JJJJ-Www` / `JJJJ-MM`),
 * byte-gleich mit dem abgelösten nativen Feld - die Zusage „keine
 * Verhaltensänderung der Formulare". Deutsch ist nur die ANZEIGE.
 *
 * <b>⚠ Die Woche beginnt am MONTAG</b> und die Zeile trägt ihre
 * Kalenderwoche - der Browser-Kalender richtet sich nach der Spracheinstellung
 * des Systems und beginnt auf einem englischen Rechner am Sonntag.
 *
 * <b>Tastatur</b> (der Durchstich ohne Maus ist Testfall): Pfeile ±1/±7 Tage,
 * Bild auf/ab ±1 Monat, Pos1/Ende Monatsanfang/-ende, Enter wählt, Escape
 * schliesst - dazu die Blätter-Knöpfe als echte Ziele.
 */
export function VpDatePicker({
  label,
  ariaLabel,
  value,
  onChange,
  art = 'tag',
  min,
  max,
  hint,
  error,
  disabled = false,
  id,
  name,
  placeholder = 'Datum wählen',
  className,
  triggerClassName,
}: {
  label?: ReactNode;
  ariaLabel?: string;
  /** ISO der jeweiligen Art; `''`/`null` = nichts gewählt. */
  value: string | null;
  onChange: (wert: string) => void;
  art?: DatumsArt;
  /** Grenzen im Format der ART (nie in die Zukunft, nie vor die ersten Daten). */
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
  const basisId = id ?? `vpd-${reactId}`;
  const isPhone = useIsPhone();
  const [offen, setOffen] = useState(false);
  const gitterRef = useRef<HTMLDivElement>(null);

  const gewaehlt = value ? datumVon(value, art) : null;
  const [anker, setAnker] = useState<Date>(() => gewaehlt ?? new Date());
  // Der Anker (welcher Monat steht im Panel) folgt dem Wert - aber nur, wenn
  // er sich von aussen ändert; beim Blättern gehört er dem Panel.
  useEffect(() => {
    if (gewaehlt) setAnker(gewaehlt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, art]);

  /** Der Tag, auf dem die Tastatur steht (immer ein echter Tag). */
  const [fokusTag, setFokusTag] = useState<string>(() => isoTag(gewaehlt ?? new Date()));
  useEffect(() => {
    if (offen) setFokusTag(isoTag(gewaehlt ?? anker));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offen]);

  const jahr = anker.getFullYear();
  const monat0 = anker.getMonth();
  const gitter = useMemo(() => monatsGitter(jahr, monat0), [jahr, monat0]);
  const heute = isoTag(new Date());

  const schliessen = (fokusZurueck = true) => {
    setOffen(false);
    if (fokusZurueck) document.getElementById(basisId)?.focus();
  };

  const waehle = (iso: string) => {
    const d = datumVon(iso, 'tag');
    if (!d || !tagWaehlbar(iso, art, min, max)) return;
    onChange(wertVon(d, art));
    schliessen();
  };

  const bewege = (tage: number, monate = 0) => {
    const neu = verschiebe(fokusTag, tage, monate);
    setFokusTag(neu);
    const d = datumVon(neu, 'tag');
    if (d && (d.getMonth() !== monat0 || d.getFullYear() !== jahr)) setAnker(d);
  };

  const aufTaste = (e: ReactKeyboardEvent) => {
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        bewege(-1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        bewege(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        bewege(-7);
        break;
      case 'ArrowDown':
        e.preventDefault();
        bewege(7);
        break;
      case 'PageUp':
        e.preventDefault();
        bewege(0, -1);
        break;
      case 'PageDown':
        e.preventDefault();
        bewege(0, 1);
        break;
      case 'Home': {
        e.preventDefault();
        setFokusTag(isoTag(new Date(jahr, monat0, 1, 12)));
        break;
      }
      case 'End': {
        e.preventDefault();
        setFokusTag(isoTag(new Date(jahr, monat0 + 1, 0, 12)));
        break;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        waehle(fokusTag);
        break;
      default:
        break;
    }
  };

  const text = value ? anzeige(value, art) ?? placeholder : placeholder;
  const wochenWert = (w: string) => w;

  const panel = (
    <div className="vp-picker-kalender">
      <div className="vp-kal-kopf">
        <button
          type="button"
          aria-label="Voriger Monat"
          onClick={() => {
            const [j, m] = blaettern(jahr, monat0, -1);
            setAnker(new Date(j, m, 1, 12));
          }}
        >
          <Icon name="chevron-left" size={18} />
        </button>
        <span aria-live="polite">{monatsTitel(jahr, monat0)}</span>
        <button
          type="button"
          aria-label="Nächster Monat"
          onClick={() => {
            const [j, m] = blaettern(jahr, monat0, 1);
            setAnker(new Date(j, m, 1, 12));
          }}
        >
          <Icon name="chevron-right" size={18} />
        </button>
      </div>
      <div
        ref={gitterRef}
        className={`vp-kal-gitter art-${art}`}
        role="grid"
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : 'Kalender')}
        tabIndex={0}
        onKeyDown={aufTaste}
      >
        <div className="vp-kal-zeile vp-kal-namen" role="row">
          <span className="vp-kal-kw" role="columnheader" aria-label="Kalenderwoche">
            KW
          </span>
          {WOCHENTAGE.map((t) => (
            <span key={t} role="columnheader">
              {t}
            </span>
          ))}
        </div>
        {gitter.map((w) => {
          const wocheGewaehlt = art === 'woche' && value === wochenWert(w.woche);
          return (
            <div
              key={w.woche}
              className={`vp-kal-zeile${wocheGewaehlt ? ' is-gewaehlt' : ''}`}
              role="row"
            >
              <span className="vp-kal-kw">{w.kw}</span>
              {w.tage.map((t) => {
                const waehlbarT = tagWaehlbar(t.iso, art, min, max);
                const d = datumVon(t.iso, 'tag');
                const istGewaehlt =
                  !!d && !!value
                  && (art === 'tag'
                    ? value === t.iso
                    : art === 'woche'
                      ? value === w.woche
                      : value === wertVon(d, 'monat'));
                return (
                  <button
                    key={t.iso}
                    type="button"
                    role="gridcell"
                    tabIndex={-1}
                    disabled={!waehlbarT}
                    aria-selected={istGewaehlt}
                    aria-current={t.iso === heute ? 'date' : undefined}
                    data-iso={t.iso}
                    className={
                      'vp-kal-tag'
                      + (t.imMonat ? '' : ' is-rand')
                      + (istGewaehlt ? ' is-gewaehlt' : '')
                      + (t.iso === fokusTag ? ' is-fokus' : '')
                      + (t.iso === heute ? ' is-heute' : '')
                    }
                    onClick={() => waehle(t.iso)}
                    onMouseEnter={() => setFokusTag(t.iso)}
                  >
                    {t.tag}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="vp-kal-fuss">
        <button
          type="button"
          className="vp-kal-heute"
          disabled={!tagWaehlbar(heute, art, min, max)}
          onClick={() => waehle(heute)}
        >
          Heute
        </button>
      </div>
    </div>
  );

  return (
    <VpPanel
      basisId={basisId}
      label={label}
      ariaLabel={ariaLabel}
      text={text}
      leer={!value}
      offen={offen}
      setOffen={setOffen}
      schliessen={schliessen}
      disabled={disabled}
      hint={hint}
      error={error}
      className={className}
      triggerClassName={triggerClassName}
      icon="calendar"
      haspopup="dialog"
      isPhone={isPhone}
      onOpened={() => gitterRef.current?.focus()}
    >
      {panel}
      {name && <input type="hidden" name={name} value={value ?? ''} />}
    </VpPanel>
  );
}
