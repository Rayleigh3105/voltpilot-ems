import { useId } from 'react';
import { useContainerWidth } from '../useContainerWidth';
import { chartLayout, type ChartData, type LayoutText } from '../soVerdient';

/**
 * Das Zwei-Säulen-Bild — ein **reiner Renderer** über `chartLayout()`.
 *
 * Handgerolltes SVG (der `EnergyFlow`-Präzedenzfall): SVG löst `var()` direkt
 * auf, also sind die Farben hier die echten VoltPilot-Chart-Tokens statt
 * kopierter Hexwerte — anders als bei einem Canvas-Chart braucht es dafür kein
 * `chartTheme()`. Für zwei Säulen wäre ECharts ohnehin die schwerere Antwort.
 *
 * Es steckt KEINE Regel in dieser Datei: jede Höhe, jede Kollision und jede
 * Kappung kommt aus dem reinen Modul; hier wird nur gezeichnet.
 */

/** Ab dieser Container-Breite lohnt die breitere Bühne mit größerer Chip-Zone. */
const WIDE_MIN_PX = 460;

/**
 * Ein Wert-Label mit weißem Halo. Die Garantie-Linie läuft über die volle
 * Breite und kann eine Säulen-Beschriftung KREUZEN (im Browser gesehen: die
 * 6,9-ct-Linie schnitt durch „6,1 ct"). Verschoben wird deshalb nichts — die
 * Position IST eine Aussage; lesbar macht sie der Halo.
 */
const HALO = {
  paintOrder: 'stroke' as const,
  stroke: 'var(--vp-surface, #fff)',
  strokeWidth: 3,
  strokeLinejoin: 'round' as const,
};

function Text({
  t,
  children,
  ...rest
}: { t: LayoutText } & React.SVGProps<SVGTextElement>) {
  return (
    <text
      x={t.x}
      y={t.y}
      fontSize={t.fontSize}
      {...(t.textLength ? { textLength: t.textLength, lengthAdjust: 'spacingAndGlyphs' } : {})}
      {...rest}
    >
      {/* Ein vorangestellter Farbpunkt gehört INS Textelement, damit die
          Kappung (`textLength`) ihn mitrechnet statt ihn zu überfahren. */}
      {children}
      {t.text}
    </text>
  );
}

export function SoVerdientChart({ data }: { data: ChartData }) {
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  // Vor der ersten Messung (und in jsdom) gilt die schmale Bühne — sie ist die
  // sichere Vorgabe, weil sie in jeden Container passt.
  const layout = chartLayout(data, { wide: width >= WIDE_MIN_PX });
  const hatchId = `vp-sv-hatch-${useId()}`;

  return (
    <div className="vp-sv-chartbox" ref={ref}>
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={data.ariaLabel}
      >
        <defs>
          <pattern
            id={hatchId}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="6" stroke="#fff" strokeWidth="2" opacity="0.55" />
          </pattern>
        </defs>

        {/* Die Nulllinie — die ehrliche Basis der Skala. */}
        <line
          x1={layout.baseline.x1}
          y1={layout.baseline.y1}
          x2={layout.baseline.x2}
          y2={layout.baseline.y2}
          stroke="var(--vp-chart-axisline, #e9ecef)"
          strokeWidth="1.5"
        />

        {/* Ø-Säule (rezessives Grau: sie ist Kontext, keine Serie). */}
        {layout.oeBar && (
          <>
            <rect
              x={layout.oeBar.x}
              y={layout.oeBar.y}
              width={layout.oeBar.width}
              height={layout.oeBar.height}
              rx="4"
              fill="var(--vp-chart-cloud, #90a4ae)"
              fillOpacity="0.5"
            />
            {data.vorlaeufig && (
              <rect
                x={layout.oeBar.x}
                y={layout.oeBar.y}
                width={layout.oeBar.width}
                height={layout.oeBar.height}
                rx="4"
                fill={`url(#${hatchId})`}
              />
            )}
          </>
        )}
        {layout.oeLine && (
          <line
            x1={layout.oeLine.x1}
            y1={layout.oeLine.y1}
            x2={layout.oeLine.x2}
            y2={layout.oeLine.y2}
            stroke="var(--vp-chart-axis, #6c757d)"
            strokeWidth="1.5"
            strokeDasharray="4 3"
          />
        )}
        {/* S6: ein leerer Platz MIT Grund — nie eine erfundene Säule. */}
        {layout.oePlaceholder && (
          <>
            <rect
              x={layout.oePlaceholder.rect.x}
              y={layout.oePlaceholder.rect.y}
              width={layout.oePlaceholder.rect.width}
              height={layout.oePlaceholder.rect.height}
              rx="8"
              fill="var(--vp-surface-muted, #f8f9fa)"
              stroke="var(--vp-chart-axisline, #e9ecef)"
              strokeDasharray="5 4"
            />
            <Text
              t={layout.oePlaceholder.dash}
              textAnchor="middle"
              fill="var(--vp-chart-axis, #6c757d)"
            />
            {layout.oePlaceholder.grund.map((g) => (
              <Text
                key={g.text}
                t={g}
                textAnchor="middle"
                fill="var(--vp-chart-axis, #6c757d)"
              />
            ))}
          </>
        )}

        {/* Die eigene Säule; der Prämien-Block sitzt mit 2-px-Fuge obenauf. */}
        <rect
          x={layout.erBar.x}
          y={layout.erBar.y}
          width={layout.erBar.width}
          height={layout.erBar.height}
          rx={layout.praemieBar ? 0 : 4}
          fill="var(--vp-chart-price, #2f6bd6)"
        />
        {layout.praemieBar && (
          <rect
            x={layout.praemieBar.x}
            y={layout.praemieBar.y}
            width={layout.praemieBar.width}
            height={layout.praemieBar.height}
            rx="4"
            fill="var(--vp-chart-charge, #2e9e5b)"
          />
        )}
        {/* Die Fuge liegt ÜBER der Grenze — sie trennt optisch, ohne einem der
            beiden Segmente Höhe zu nehmen. */}
        {layout.fuge && (
          <rect
            x={layout.fuge.x}
            y={layout.fuge.y}
            width={layout.fuge.width}
            height={layout.fuge.height}
            fill="var(--vp-surface, #fff)"
          />
        )}
        {/* Die Garantiewert-Linie über die volle Breite. */}
        {layout.awLine && (
          <line
            x1={layout.awLine.x1}
            y1={layout.awLine.y1}
            x2={layout.awLine.x2}
            y2={layout.awLine.y2}
            stroke="var(--vp-chart-plan, #1e3a5f)"
            strokeWidth="2"
            strokeDasharray="7 4"
          />
        )}

        {/* Die Wert-Labels zuletzt: die Garantie-Linie läuft über die volle
            Breite und würde sie sonst überzeichnen. Der Halo schneidet dafür
            eine saubere Lücke in die Linie — verschoben wird nichts. */}
        {layout.oeWert && (
          <Text
            t={layout.oeWert}
            textAnchor="middle"
            fontWeight="700"
            fill="var(--vp-chart-ink, #1a1a1a)"
            {...HALO}
          />
        )}
        {layout.oeStand && (
          <Text t={layout.oeStand} textAnchor="middle" fill="var(--vp-chart-axis, #6c757d)" />
        )}

        <Text
          t={layout.erLabel}
          textAnchor="middle"
          fontWeight="700"
          fill="var(--vp-chart-ink, #1a1a1a)"
          {...HALO}
        />

        {/* Rechte Chips: entzerrt, aber per Leader-Linie an ihrer echten Höhe. */}
        {layout.chips.map((c) => (
          <g key={c.titel.text}>
            <line
              x1={c.leader.x1}
              y1={c.leader.y1}
              x2={c.leader.x2}
              y2={c.leader.y2}
              stroke={
                c.punkt ? 'var(--vp-chart-charge, #2e9e5b)' : 'var(--vp-chart-axis, #6c757d)'
              }
              strokeWidth="1"
            />
            <Text
              t={c.titel}
              fontWeight="700"
              fill={c.punkt ? 'var(--vp-chart-ink, #1a1a1a)' : 'var(--vp-chart-plan, #1e3a5f)'}
            >
              {c.punkt && <tspan fill="var(--vp-chart-charge, #2e9e5b)">● </tspan>}
            </Text>
            <Text t={c.wert} fontWeight="700" fill="var(--vp-chart-ink, #1a1a1a)" />
          </g>
        ))}

        {/* S5: der Grund steht dort, wo sonst die Garantie-Linie beschriftet wäre. */}
        {layout.awFehltNote?.map((n) => (
          <Text key={n.text} t={n} fill="var(--vp-chart-axis, #6c757d)" />
        ))}

        {/* Direktbeschriftung statt Legende — jedes Element benennt sich selbst. */}
        {layout.captions.map((c, i) => (
          <Text
            key={`${c.text}-${i}`}
            t={c}
            textAnchor="middle"
            fontWeight={i === 2 ? '700' : undefined}
            fill={i === 2 ? 'var(--vp-chart-ink, #1a1a1a)' : 'var(--vp-chart-axis, #6c757d)'}
          />
        ))}
      </svg>
    </div>
  );
}
