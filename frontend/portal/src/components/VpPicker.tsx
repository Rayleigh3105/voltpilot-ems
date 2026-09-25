import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
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
  ansage,
  ausloeserText,
  ersteAktive,
  naechster,
  suche as sucheOptionen,
  sucheSichtbar,
  tippSprung,
  TIPP_PUFFER_MS,
  umschalten,
  waehlbare,
  type SuchModus,
  type VpGruppe,
  type VpOption,
  type VpZeile,
} from '../picker/optionen';
import type { TextTeil } from '../picker/suche';

/**
 * `VpPicker` - DER Auswahl-Picker des Portals (Konzept `vp-picker-system`,
 * Captain-genehmigt 21.08.2026: „alle Picker … eigene Komponenten erstellen wo
 * man drin suchen kann. Ich will nichts Browser-Standard-Zeug.").
 *
 * <b>Warum überhaupt.</b> Ein natives Auswahlfeld (`select`) kann drei Dinge nicht, die
 * dieses Portal überall braucht: darin SUCHEN, je Zeile eine NEBENZEILE (Ort,
 * „30 kW · Hybrid", eine Kennung) zeigen und am Telefon eine Fläche sein, die
 * ein Daumen trifft. Es sieht ausserdem auf jedem Betriebssystem anders aus als
 * der Rest der Seite.
 *
 * <b>Wo er wohnt und warum nicht in `designsystem/`.</b> Die
 * Designsystem-Ordner tragen `.jsx` + handgeschriebene `.d.ts` und werden vom
 * `tsc`-Lauf gar nicht erfasst (`tsconfig.json` `include: ["src"]`). Dieser
 * Picker trägt REGELN (Tastatur-Arithmetik, Kalender, tolerante Suche), und
 * genau die sind im Haus immer eine geprüfte reine TS-Schicht - hier
 * `src/picker/*`. Er wohnt deshalb wie jede andere regel-tragende
 * Haus-Komponente (`ConfirmDialog`, `DangerZone`, `RowMenu`) in
 * `src/components/`; die OPTIK kommt unverändert aus den Designsystem-Tokens.
 *
 * <b>Die Varianten kommen aus EINER Basis:</b> Einfachauswahl · Mehrfachauswahl
 * (Chips) · Gruppen (Marke → Modelle) · async geladene Optionen (Lade-, Leer-
 * und Fehlerzustand ehrlich) · „+ Neu anlegen"-Fusszeile. Datum und Zeit sind
 * dieselbe Schale mit anderem Inhalt ({@link VpDatePicker},
 * {@link VpTimePicker}).
 *
 * <b>⚠ A11y ist hier Gegenstand, nicht Beiwerk.</b> Der Eigenbau darf dem
 * nativen Select in NICHTS nachstehen - deshalb `combobox`/`listbox`-Rollen,
 * `aria-activedescendant` statt Fokus-Wanderung, Pfeile/Pos1/Ende/Bild-auf-ab,
 * Enter, Escape, Tippen-zum-Springen, Fokus-Falle im Panel und eine
 * `aria-live`-Ansage der Trefferzahl. Der Durchstich ohne Maus ist ein
 * TESTFALL (`VpPicker.test.tsx`), keine Absichtserklärung.
 */
export interface VpPickerProps {
  /** Die Beschriftung über dem Feld. Ohne sie MUSS `ariaLabel` gesetzt sein. */
  label?: ReactNode;
  /** Der barrierefreie Name, wenn die Fläche keine sichtbare Beschriftung hat. */
  ariaLabel?: string;
  options: VpOption[];
  /** Einfachauswahl: der Wert (oder `null`). */
  value?: string | null;
  onChange?: (value: string) => void;
  /** Mehrfachauswahl (Chips) - ihre Anwesenheit schaltet sie ein. */
  values?: string[];
  onChangeMany?: (values: string[]) => void;
  /** Reihenfolge + Beschriftung der Gruppen. Ohne sie: Reihenfolge des Vorkommens. */
  groups?: VpGruppe[];
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  id?: string;
  /** Trägt den Wert als `<input type="hidden">` in ein umgebendes `<form>`. */
  name?: string;
  /** `auto` (Vorgabe) blendet die Suche ab {@link SUCHE_AB} Zeilen ein. */
  search?: SuchModus;
  searchPlaceholder?: string;
  /** Der Satz, wenn die Suche nichts findet - sonst formuliert ihn der Picker. */
  emptyText?: (query: string) => string;
  /** async: es wird noch geladen - das Panel sagt es, statt „nichts gefunden". */
  loading?: boolean;
  /** async: das Laden ist gescheitert - der GRUND, nie eine leere Liste. */
  loadError?: string | null;
  onRetry?: () => void;
  /** Die Fusszeile „+ Neu anlegen". Ohne `onCreate` gibt es sie nicht. */
  createLabel?: string;
  onCreate?: () => void;
  className?: string;
  /** Zusätzliche Klasse am Auslöser (schmale/eingebettete Fassungen). */
  triggerClassName?: string;
  /**
   * Mehrfachauswahl als FILTER-KNOPF (Aufbau-Tabelle): der Auslöser zeigt statt
   * der gewählten Chips nur seinen Namen - den Platzhalter - und die ZAHL der
   * gewählten Werte („Art 2"). Die Werte selbst stehen dann als Chips neben
   * der Tabelle, nicht ein zweites Mal im Knopf.
   */
  zaehler?: boolean;
}

function Teile({ teile }: { teile: TextTeil[] }) {
  return (
    <>
      {teile.map((t, i) =>
        t.treffer ? <mark key={i}>{t.text}</mark> : <span key={i}>{t.text}</span>,
      )}
    </>
  );
}

export function VpPicker({
  label,
  ariaLabel,
  options,
  value = null,
  onChange,
  values,
  onChangeMany,
  groups,
  placeholder = 'Bitte wählen …',
  hint,
  error,
  disabled = false,
  id,
  name,
  search = 'auto',
  searchPlaceholder = 'Suchen …',
  emptyText,
  loading = false,
  loadError = null,
  onRetry,
  createLabel,
  onCreate,
  className,
  triggerClassName,
  zaehler = false,
}: VpPickerProps) {
  const reactId = useId();
  const basisId = id ?? `vpp-${reactId}`;
  const listeId = `${basisId}-liste`;
  const mehrfach = Array.isArray(values);
  const isPhone = useIsPhone();

  const [offen, setOffen] = useState(false);
  const [query, setQuery] = useState('');
  const [aktiv, setAktiv] = useState(-1);
  const sucheRef = useRef<HTMLInputElement>(null);
  const listeRef = useRef<HTMLDivElement>(null);
  const tippRef = useRef<{ puffer: string; zeit: number }>({ puffer: '', zeit: 0 });
  /**
   * ⚠ Der Anker, den ein Tastendruck auf dem GESCHLOSSENEN Feld gesetzt hat.
   * Ohne ihn überschriebe der Öffnen-Effekt darunter ihn sofort wieder mit dem
   * gewählten Wert - „Tippen-zum-Springen" spränge also nirgendwohin.
   */
  const saatRef = useRef<number | null>(null);

  const gruppen = useMemo(() => groups ?? [], [groups]);
  const s = useMemo(
    () => sucheOptionen(options, query, gruppen, emptyText),
    [options, query, gruppen, emptyText],
  );
  const zeilen: VpZeile[] = s.zeilen;
  const mitSuche = sucheSichtbar(options.length, search);

  // ⚠ `value === ''` ist eine gültige Wahl, wenn die Liste sie führt (das
  // native `<option value="">`) - `value ? …` verlöre den Haken darauf.
  const gewaehlt = useMemo(
    () => new Set(mehrfach ? values ?? [] : value != null ? [value] : []),
    [mehrfach, values, value],
  );

  const schliessen = useCallback((fokusZurueck = true) => {
    setOffen(false);
    setQuery('');
    setAktiv(-1);
    if (fokusZurueck) document.getElementById(basisId)?.focus();
  }, [basisId]);

  // Beim Öffnen steht der Anker auf dem GEWÄHLTEN Wert (wie im nativen
  // Select), sonst auf der ersten wählbaren Zeile.
  useEffect(() => {
    if (!offen) return;
    const saat = saatRef.current;
    saatRef.current = null;
    setAktiv(saat != null && saat >= 0 ? saat : ersteAktive(zeilen, mehrfach ? null : value));
    // Nur beim Öffnen - während des Tippens rechnet der Effekt darunter weiter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offen]);

  // Beim Tippen wandert der Anker auf den ersten Treffer: Enter wählt damit
  // immer das, was oben steht.
  useEffect(() => {
    if (!offen) return;
    setAktiv((a) => (waehlbare(zeilen).includes(a) ? a : ersteAktive(zeilen, null)));
  }, [offen, zeilen]);

  // Die aktive Zeile bleibt im Bild - ohne sie ist Pfeil-Navigation auf einer
  // langen Liste blind.
  useLayoutEffect(() => {
    if (!offen || aktiv < 0) return;
    listeRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${aktiv}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [offen, aktiv]);

  const waehle = (opt: VpOption) => {
    if (opt.disabled) return;
    if (mehrfach) {
      onChangeMany?.(umschalten(values ?? [], opt.value));
      // Das Panel BLEIBT offen: eine Mehrfachauswahl, die nach jedem Haken
      // zuklappt, ist keine.
      return;
    }
    onChange?.(opt.value);
    schliessen();
  };

  const aufTaste = (e: ReactKeyboardEvent) => {
    // Escape + Tab (Fokus-Falle) gehören der Schale - sie sind für jeden
    // Panel-Inhalt gleich und stehen deshalb genau EINMAL in `VpPanel`.
    if (e.key === 'Escape' || e.key === 'Tab') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setAktiv((a) => naechster(zeilen, a, e.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      setAktiv((a) => naechster(zeilen, a, e.key === 'PageDown' ? 10 : -10));
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const ziele = waehlbare(zeilen);
      if (ziele.length > 0) setAktiv(e.key === 'Home' ? ziele[0] : ziele[ziele.length - 1]);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const z = zeilen[aktiv];
      if (z && z.art === 'option') waehle(z.treffer.option);
      return;
    }
    if (mehrfach && e.key === 'Backspace' && query === '' && (values ?? []).length > 0) {
      // Rücktaste im leeren Suchfeld nimmt den letzten Chip zurück - die
      // Geste, die jedes Chip-Feld kennt.
      e.preventDefault();
      onChangeMany?.((values ?? []).slice(0, -1));
      return;
    }
    if (!mitSuche && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // TIPPEN-ZUM-SPRINGEN - ohne sichtbares Suchfeld genau wie nativ.
      e.preventDefault();
      const jetzt = Date.now();
      const puffer =
        jetzt - tippRef.current.zeit > TIPP_PUFFER_MS ? e.key : tippRef.current.puffer + e.key;
      tippRef.current = { puffer, zeit: jetzt };
      const i = tippSprung(zeilen, puffer, aktiv);
      if (i >= 0) setAktiv(i);
    }
  };

  /** Tippen auf dem GESCHLOSSENEN Auslöser öffnet und nimmt das Zeichen mit. */
  const aufAusloeserTaste = (e: ReactKeyboardEvent): boolean => {
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey || e.key === ' ') return false;
    e.preventDefault();
    if (mitSuche) {
      setQuery(e.key);
    } else {
      tippRef.current = { puffer: e.key, zeit: Date.now() };
      saatRef.current = tippSprung(zeilen, e.key, -1);
    }
    setOffen(true);
    return true;
  };

  const text = ausloeserText(options, mehrfach ? values ?? [] : value, placeholder);
  // „Leer" heisst: der Auslöser zeigt den PLATZHALTER - nicht „der Wert ist
  // eine leere Zeichenkette" (die kann eine echte Zeile sein, s. o.).
  const leer = mehrfach
    ? (values ?? []).length === 0
    : !options.some((o) => o.value === value);
  const chips = mehrfach
    ? (values ?? [])
        .map((v) => options.find((o) => o.value === v))
        .filter((o): o is VpOption => !!o)
    : [];

  const nameFuerAria = ariaLabel ?? (typeof label === 'string' ? label : undefined);

  const panel = (
    <VpPanel
      basisId={basisId}
      listeId={listeId}
      label={label}
      ariaLabel={ariaLabel}
      text={text}
      leer={leer}
      offen={offen}
      setOffen={setOffen}
      schliessen={schliessen}
      disabled={disabled}
      hint={hint}
      error={error}
      className={className}
      triggerClassName={triggerClassName}
      isPhone={isPhone}
      onTriggerKey={aufAusloeserTaste}
      onOpened={() => (mitSuche ? sucheRef.current : listeRef.current)?.focus()}
      ausloeserInhalt={
        mehrfach && zaehler ? (
          <span className="vp-picker-zaehler">
            <span>{placeholder}</span>
            {chips.length > 0 && (
              <span className="vp-picker-anzahl" aria-label={`${chips.length} gewählt`}>
                {chips.length}
              </span>
            )}
          </span>
        ) : mehrfach && chips.length > 0 ? (
          <span className="vp-picker-chips">
            {chips.map((c) => (
              <span key={c.value} className="vp-picker-chip">
                {c.label}
              </span>
            ))}
          </span>
        ) : undefined
      }
    >
      <div className="vp-picker-inhalt" onKeyDown={aufTaste}>
        {mitSuche && (
          <div className="vp-picker-suche">
            <Icon name="search" size={16} aria-hidden="true" />
            <input
              ref={sucheRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listeId}
              aria-autocomplete="list"
              aria-activedescendant={aktiv >= 0 ? `${basisId}-o${aktiv}` : undefined}
              aria-label={`${nameFuerAria ?? 'Auswahl'} durchsuchen`}
              placeholder={searchPlaceholder}
              value={query}
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
            />
            {isPhone && (
              <button
                type="button"
                className="vp-picker-zu"
                aria-label="Auswahl schliessen"
                onClick={() => schliessen()}
              >
                <Icon name="x" size={18} />
              </button>
            )}
          </div>
        )}
        <div
          ref={listeRef}
          id={listeId}
          role="listbox"
          aria-label={nameFuerAria}
          aria-multiselectable={mehrfach || undefined}
          aria-activedescendant={aktiv >= 0 ? `${basisId}-o${aktiv}` : undefined}
          tabIndex={mitSuche ? -1 : 0}
          className="vp-picker-liste"
        >
          {loading && <p className="vp-picker-status">Wird geladen …</p>}
          {!loading && loadError && (
            <div className="vp-picker-status is-fehler">
              <p>{loadError}</p>
              {onRetry && (
                <button type="button" className="vp-picker-retry" onClick={onRetry}>
                  Erneut versuchen
                </button>
              )}
            </div>
          )}
          {!loading && !loadError && s.leer && (
            // ⚠ Der sichtbare Satz IST die Ansage - eine zweite, versteckte
            // Kopie liesse Vorlesesoftware dieselbe Auskunft zweimal lesen.
            <p className="vp-picker-status" role="status" aria-live="polite">
              {s.leer}
            </p>
          )}
          {!loading
            && !loadError
            && zeilen.map((z, i) =>
              z.art === 'gruppe' ? (
                <div key={`g-${z.key}`} className="vp-picker-gruppe" role="presentation">
                  {z.label}
                </div>
              ) : (
                <div
                  key={z.key}
                  id={`${basisId}-o${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={gewaehlt.has(z.key)}
                  aria-disabled={z.treffer.option.disabled || undefined}
                  className={
                    'vp-picker-zeile'
                    + (i === aktiv ? ' is-aktiv' : '')
                    + (gewaehlt.has(z.key) ? ' is-gewaehlt' : '')
                    + (z.treffer.option.disabled ? ' is-gesperrt' : '')
                  }
                  onMouseMove={() => !z.treffer.option.disabled && setAktiv(i)}
                  onClick={() => waehle(z.treffer.option)}
                >
                  {z.treffer.option.dot && (
                    <span
                      className={`vp-picker-dot state-${z.treffer.option.dot}`}
                      aria-hidden="true"
                    />
                  )}
                  <span className="vp-picker-text">
                    <span className="vp-picker-haupt">
                      <Teile teile={z.treffer.label} />
                    </span>
                    {z.treffer.sub && (
                      <span className="vp-picker-neben">
                        <Teile teile={z.treffer.sub} />
                      </span>
                    )}
                    {z.treffer.option.disabled && z.treffer.option.disabledHint && (
                      <span className="vp-picker-sperrgrund">
                        {z.treffer.option.disabledHint}
                      </span>
                    )}
                  </span>
                  {gewaehlt.has(z.key) && (
                    <Icon name="check" size={16} className="vp-picker-haken" />
                  )}
                </div>
              ),
            )}
        </div>
        {onCreate && (
          <button
            type="button"
            className="vp-picker-neu"
            onClick={() => {
              schliessen(false);
              onCreate();
            }}
          >
            <Icon name="plus" size={16} />
            {createLabel ?? 'Neu anlegen'}
          </button>
        )}
        <p className="vp-visually-hidden" role="status" aria-live="polite">
          {s.leer ? '' : ansage(s, query)}
        </p>
      </div>
    </VpPanel>
  );

  // ⚠ Der Formular-Wert steht AUSSERHALB der Schale: ihr Panel rendert nur im
  // offenen Zustand, ein Feld darin wäre also die meiste Zeit gar nicht da.
  return name ? (
    <>
      {panel}
      <input type="hidden" name={name} value={mehrfach ? (values ?? []).join(',') : value ?? ''} />
    </>
  ) : (
    panel
  );
}

export type { VpOption, VpGruppe } from '../picker/optionen';
