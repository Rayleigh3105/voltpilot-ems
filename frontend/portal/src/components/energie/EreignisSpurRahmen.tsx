import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ART_ORDER,
  EREIGNIS_ARTEN,
  zellenSpanne,
  type ChronikGruppe,
  type EreignisArt,
  type EreignisZelle,
} from '../../historieEreignisse';
import { useContainerWidth } from '../../useContainerWidth';
import { bilanzRand, spurLage, tagRand, type ZeichenArt } from './energieRaster';
import { EreignisSymbol } from './EreignisSymbol';

/**
 * **Die Ereignis-Spur direkt unter dem Energie-Diagramm** (Konzept
 * `data/vp-verlauf-ereignisse-k1`, Entscheid „Spur + Chronik am Diagramm").
 *
 * Je vorkommender Art eine schmale Bahn, darin eine Marke unter jedem Tag
 * (Monat, Stunde), an dem sie vorkam — in der Farbe ihres Bereichs. So
 * beantwortet das Bild selbst, WARUM ein Balken so aussieht; die Chronik
 * darunter sagt, was es war. Die Lage kommt aus derselben Quelle wie das
 * Diagramm (`energieRaster.ts`), die Inhalte aus `ereignisChronik`.
 *
 * Fokus verbindet die beiden: Zeigen auf eine Marke oder eine Chronik-Zeile
 * hebt die Spalte im Diagramm hervor. Ab der Woche öffnet eine Marke ihren
 * Tag (im Jahr ihren Monat) — wie ein Balken.
 */

/** Was gerade gezeigt wird: der Tag/Monat (bzw. am Tag das Ereignis), optional die Art. */
export interface EreignisFokus {
  key: string;
  art: EreignisArt | null;
}

interface Marke {
  key: string;
  art: EreignisArt;
  /** Die Marke selbst. */
  x: number;
  w: number;
  /** Ihre ganze Zelle — die Breite der Hervorhebung. */
  zelleX: number;
  zelleW: number;
  label: string;
  text: string;
  sprung: ChronikGruppe['sprung'];
}

export function EreignisSpurRahmen({
  gruppen,
  zellen,
  art,
  filter,
  fokus,
  onFokus,
  onOeffnen,
  children,
}: {
  /** Die Chronik des Zeitraums (ungefiltert) — dieselben Zeilen wie die Karte. */
  gruppen: readonly ChronikGruppe[];
  /** Die Zellen der x-Achse: Tage/Monate der Bilanz bzw. die Viertelstunden des Tages. */
  zellen: readonly EreignisZelle[];
  art: ZeichenArt;
  /** Die in der Karte gewählte Art — die übrigen Bahnen treten zurück. */
  filter: EreignisArt | null;
  fokus: EreignisFokus | null;
  onFokus: (f: EreignisFokus | null) => void;
  onOeffnen?: (sprung: NonNullable<ChronikGruppe['sprung']>) => void;
  /** Das Diagramm. */
  children: ReactNode;
}) {
  const [ref, breite] = useContainerWidth<HTMLDivElement>();
  const [tip, setTip] = useState<{ marke: Marke; top: number } | null>(null);

  const bahnen = useMemo(() => {
    const n = zellen.length;
    if (!breite || !n) return [];
    const proArt = new Map<EreignisArt, Marke[]>();
    for (const g of gruppen) {
      for (const z of g.zeilen) {
        const spanne = zellenSpanne(zellen, z.start, z.ende);
        if (!spanne) continue;
        const lage = spurLage(art, breite, n, spanne[0], spanne[1]);
        // In der Bilanz steht die Marke wie ein Balken mittig in ihrem Band.
        const rand = art === 'bilanz' ? Math.min(2, lage.w * 0.15) : 0;
        const w = Math.max(3, lage.w - 2 * rand);
        const liste = proArt.get(z.art) ?? [];
        liste.push({
          key: g.key,
          art: z.art,
          x: lage.x + (lage.w - w) / 2,
          w,
          zelleX: lage.x,
          zelleW: Math.max(3, lage.w),
          label: g.label,
          text: `${z.info.label} · ${z.meta} · ${z.zahl}`,
          sprung: g.sprung,
        });
        proArt.set(z.art, liste);
      }
    }
    return ART_ORDER.filter((a) => proArt.has(a)).map((a) => ({ art: a, marken: proArt.get(a) ?? [] }));
  }, [gruppen, zellen, art, breite]);

  const band = useMemo(() => {
    if (!fokus) return null;
    const treffer = bahnen.flatMap((b) => b.marken).filter((m) => m.key === fokus.key);
    if (!treffer.length) return null;
    const x = Math.min(...treffer.map((m) => m.zelleX));
    const ende = Math.max(...treffer.map((m) => m.zelleX + m.zelleW));
    return { x, w: ende - x };
  }, [bahnen, fokus]);

  const rand = art === 'bilanz' ? bilanzRand(breite) : tagRand(breite);
  // Der Hinweis steht über der Bahn der Marke — ihre Lage misst das DOM selbst.
  const zeige = (m: Marke, el: HTMLElement) => {
    setTip({ marke: m, top: el.parentElement?.offsetTop ?? 0 });
    onFokus({ key: m.key, art: m.art });
  };
  const verberge = () => {
    setTip(null);
    onFokus(null);
  };

  return (
    <div className="vp-vr-spurrahmen" ref={ref}>
      {children}
      {band && <div className="vp-vr-fokusband" style={{ left: band.x, width: band.w }} aria-hidden="true" />}
      {bahnen.length > 0 && (
        <div
          className="vp-vr-spur"
          role="group"
          aria-label="Ereignisse am Diagramm"
          style={{ '--spur-l': `${rand.left}px`, '--spur-r': `${rand.right}px` } as CSSProperties}
        >
          {bahnen.map(({ art: a, marken }) => (
            <div
              key={a}
              className={`vp-vr-spur-bahn is-${EREIGNIS_ARTEN[a].farbe}${filter && filter !== a ? ' is-gedimmt' : ''}`}
            >
              <span className="vp-vr-spur-symbol" title={EREIGNIS_ARTEN[a].label}>
                <EreignisSymbol art={a} />
              </span>
              {marken.map((m) => {
                const an = !!fokus && fokus.key === m.key && (!fokus.art || fokus.art === m.art);
                const klasse = `vp-vr-spur-marke${an ? ' is-fokus' : ''}`;
                const lage = { left: m.x, width: m.w };
                const sprung = m.sprung;
                return sprung && onOeffnen ? (
                  <button
                    key={`${m.key}-${m.art}`}
                    type="button"
                    className={klasse}
                    style={lage}
                    aria-label={`${m.label}: ${m.text}, öffnen`}
                    onMouseEnter={(e) => zeige(m, e.currentTarget)}
                    onMouseLeave={verberge}
                    onFocus={(e) => zeige(m, e.currentTarget)}
                    onBlur={verberge}
                    onClick={() => onOeffnen(sprung)}
                  />
                ) : (
                  <span
                    key={`${m.key}-${m.art}`}
                    className={klasse}
                    style={lage}
                    aria-hidden="true"
                    onMouseEnter={(e) => zeige(m, e.currentTarget)}
                    onMouseLeave={verberge}
                  />
                );
              })}
            </div>
          ))}
          {tip && <SpurTip marke={tip.marke} top={tip.top} breite={breite} />}
        </div>
      )}
    </div>
  );
}

/** Der Hinweis über einer Marke — am Rand bündig statt abgeschnitten. */
function SpurTip({ marke, top, breite }: { marke: Marke; top: number; breite: number }) {
  const mitte = marke.x + marke.w / 2;
  const seite = mitte < 120 ? 'links' : mitte > breite - 120 ? 'rechts' : 'mitte';
  const left = seite === 'links' ? marke.x : seite === 'rechts' ? marke.x + marke.w : mitte;
  return (
    <div
      className={`vp-vr-spur-tip is-${seite}`}
      role="tooltip"
      style={{ left, top }}
    >
      <b>{marke.label}</b>
      <span>{marke.text}</span>
    </div>
  );
}
