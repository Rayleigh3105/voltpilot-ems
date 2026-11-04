import {
  forwardRef,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { imBereich, isoMonat, MONATE } from '../picker/datum';

/** Die Kurzform im Raster („Jan", „Mär") - der volle Name steht im Vorlese-Text. */
export const MONATE_RASTER = MONATE.map((m) => m.slice(0, 3));

function monatIso(jahr: number, monat0: number): string {
  return `${jahr}-${String(monat0 + 1).padStart(2, '0')}`;
}

/** `JJJJ-MM` um `schritt` Monate verschoben. */
export function monatVerschoben(wert: string, schritt: number): string {
  const [j, m] = wert.split('-').map(Number);
  const d = new Date(j, m - 1 + schritt, 1, 12);
  return isoMonat(d);
}

/**
 * `VpMonatsRaster` - die MONATS-Auswahl des Picker-Systems: zwölf Monate als
 * Raster (4 × 3), das Jahr als Überschrift, ‹ › blättern das Jahr.
 *
 * ⚠ Vorher wählte man einen Monat in einem TAGES-Gitter (jeder Tag des Monats
 * war Ziel) oder im ⋯-Popover der Zeit-Leiste in einem waagerecht scrollenden
 * Streifen aus Monats-Chips ohne Jahr, mit Scroll-Leiste und doppeltem
 * Tooltip. Der Captain: „ich weiß nicht mal, was das ist". Ein Monat ist eine
 * von zwölf Kacheln unter seinem Jahr - auf einen Blick lesbar.
 *
 * Der WERT bleibt ISO (`JJJJ-MM`); `min`/`max` sind ebenfalls `JJJJ-MM`.
 *
 * <b>Tastatur</b> wie im Tageskalender: Pfeile ±1 Monat bzw. ±1 Zeile (3),
 * Bild auf/ab ±1 Jahr, Pos1/Ende Jahresanfang/-ende, Enter wählt.
 */
export const VpMonatsRaster = forwardRef<
  HTMLDivElement,
  {
    /** Gewählter Monat `JJJJ-MM` oder null. */
    wert: string | null;
    onWaehle: (monat: string) => void;
    min?: string | null;
    max?: string | null;
    /** Der laufende Monat `JJJJ-MM` (markiert, Ziel von „Dieser Monat"). */
    heute: string;
    ariaLabel: string;
    /** Ohne Fuß („Dieser Monat") - z. B. wo die Leiste schon „Heute" trägt. */
    ohneFuss?: boolean;
  }
>(function VpMonatsRaster({ wert, onWaehle, min, max, heute, ariaLabel, ohneFuss = false }, ref) {
  const start = wert ?? heute;
  const [jahr, setJahr] = useState(() => Number(start.slice(0, 4)));
  const [fokus, setFokus] = useState(start);
  useEffect(() => {
    const s = wert ?? heute;
    setJahr(Number(s.slice(0, 4)));
    setFokus(s);
  }, [wert, heute]);

  const waehlbar = (m: string) => imBereich(m, min, max);
  // Ein Jahr ganz außerhalb der Grenzen ist kein Ziel - die Pfeile sperren dort.
  const vorigesJahrMoeglich = !min || `${jahr - 1}-12` >= min;
  const naechstesJahrMoeglich = !max || `${jahr + 1}-01` <= max;

  const bewege = (schritt: number) => {
    const neu = monatVerschoben(fokus, schritt);
    setFokus(neu);
    setJahr(Number(neu.slice(0, 4)));
  };

  /** Das Jahr blättern - der Tastatur-Fokus bleibt auf demselben Monat. */
  const jahrBlaettern = (schritt: number) => {
    setJahr(jahr + schritt);
    setFokus(monatIso(jahr + schritt, Number(fokus.slice(5, 7)) - 1));
  };

  const waehle = (m: string) => {
    if (waehlbar(m)) onWaehle(m);
  };

  const aufTaste = (e: ReactKeyboardEvent) => {
    const tasten: Record<string, () => void> = {
      ArrowLeft: () => bewege(-1),
      ArrowRight: () => bewege(1),
      ArrowUp: () => bewege(-3),
      ArrowDown: () => bewege(3),
      PageUp: () => bewege(-12),
      PageDown: () => bewege(12),
      Home: () => setFokus(monatIso(jahr, 0)),
      End: () => setFokus(monatIso(jahr, 11)),
      Enter: () => waehle(fokus),
      ' ': () => waehle(fokus),
    };
    const t = tasten[e.key];
    if (!t) return;
    e.preventDefault();
    t();
  };

  const zeilen = [0, 1, 2, 3].map((z) => [0, 1, 2].map((s) => z * 3 + s));

  return (
    <div className="vp-picker-kalender vp-monatsraster">
      <div className="vp-kal-kopf">
        <button
          type="button"
          aria-label="Voriges Jahr"
          disabled={!vorigesJahrMoeglich}
          onClick={() => jahrBlaettern(-1)}
        >
          <Icon name="chevron-left" size={18} />
        </button>
        <span aria-live="polite">{jahr}</span>
        <button
          type="button"
          aria-label="Nächstes Jahr"
          disabled={!naechstesJahrMoeglich}
          onClick={() => jahrBlaettern(1)}
        >
          <Icon name="chevron-right" size={18} />
        </button>
      </div>
      <div
        ref={ref}
        className="vp-kal-gitter vp-monats-gitter"
        role="grid"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={aufTaste}
      >
        {zeilen.map((zeile) => (
          <div key={zeile[0]} className="vp-monats-zeile" role="row">
            {zeile.map((m0) => {
              const m = monatIso(jahr, m0);
              const gewaehlt = m === wert;
              return (
                <button
                  key={m}
                  type="button"
                  role="gridcell"
                  tabIndex={-1}
                  disabled={!waehlbar(m)}
                  aria-selected={gewaehlt}
                  aria-current={m === heute ? 'date' : undefined}
                  aria-label={`${MONATE[m0]} ${jahr}`}
                  data-monat={m}
                  className={
                    'vp-kal-tag vp-monats-kachel'
                    + (gewaehlt ? ' is-gewaehlt' : '')
                    + (m === fokus ? ' is-fokus' : '')
                    + (m === heute ? ' is-heute' : '')
                  }
                  onClick={() => waehle(m)}
                  onMouseEnter={() => setFokus(m)}
                >
                  {MONATE_RASTER[m0]}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {!ohneFuss && (
        <div className="vp-kal-fuss">
          <button
            type="button"
            className="vp-kal-heute"
            disabled={!waehlbar(heute)}
            onClick={() => waehle(heute)}
          >
            Dieser Monat
          </button>
        </div>
      )}
    </div>
  );
});
