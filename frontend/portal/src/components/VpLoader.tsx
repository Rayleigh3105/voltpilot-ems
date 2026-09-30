import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { readBootPulsePhase } from '../bootHandoff';
// ⚠ Das Wortmarken-PNG wird über `build.assetsInlineLimit` (vite.config.ts) IMMER
// als Data-URI ins Bündel gebacken - beim Mount sofort da (kein Netz-Request,
// kein spätes Auftauchen) und byte-genau DASSELBE Bild wie der Inline-Lader in
// `index.html`. So sind beide Fassungen pixelgleich (Beweis:
// `e2e/loader-parity.spec.ts` + Differenzbild + `test:bundle`). KEIN `?inline`:
// das ist ein Vite-6-Feature und liesse die Marke auf Vite 5.4 als Netz-Asset
// stehen (Review SOLLTE-1).
import wordmarkUrl from '../../designsystem/assets/voltpilot-wordmark.png';

/**
 * DER VOLTPILOT-LADE-MOMENT (`VpLoader`) - Konzept „Der Puls" (Captain-Entscheid
 * 2026-09-30).
 *
 * Ein einziger Marken-Lader für das ganze Portal - vom allerersten Bild bis zum
 * ersten echten Inhalt. Die Marke steht ruhig (Kopf + Blitz im Marken-Verlauf);
 * weiche Ringe strahlen in gleichmässigem Rhythmus aus - klar als „lädt"
 * lesbar, kein generischer Kreisel. Zwischen Marke und Ringen bleibt Luft
 * (die Ringe beginnen AUSSERHALB der Marke, kollidieren also nie mit dem Kopf).
 *
 * ## Regeln (alle load-bearing)
 * - **Nur SVG + CSS.** Keine schwere Abhängigkeit, kein GIF/Lottie. Die Bewegung
 *   läuft ausschliesslich über `transform`/`opacity` (GPU) und hat KEINEN
 *   JS-Timer - die eine Loop `vp-loader-pulse` steht in `src/index.css` (dort
 *   auch der `prefers-reduced-motion`-Halt, der EINE Schalter des Portals).
 * - **CLS 0.** Der Mark-Rahmen hat feste Grösse je `size`, die Fläche
 *   reserviert ihre Höhe.
 * - **⚠ Eindeutige IDs je Instanz** (`useId`). Inline-Lader (`index.html`) und
 *   React-Lader laufen bei der Übergabe GLEICHZEITIG, dazu eingebettete Lader in
 *   mehreren Karten. Doppelte SVG-`id`s sind ungültiges HTML, und `url(#id)`
 *   löst immer auf das ERSTE passende Element im Dokument auf - liegt das in
 *   einem `display:none`- oder gerade entfernten Teilbaum, malt Chrome den
 *   Verlauf falsch. Gegenprobe: `VpLoader.test.tsx` rendert zwei Instanzen.
 * - **Barrierefreiheit.** `role="status"` + `aria-live="polite"` + ein
 *   Screenreader-Text; unter reduzierter Bewegung ruhen die Ringe, die Marke
 *   steht, die Aussage trägt dann der Text.
 * - **Geschützter Umbruch der Auslassungspunkte.** Die Texte tragen ein
 *   geschütztes Leerzeichen vor dem „…" (`LOADER_TEXT`), damit es nie allein in
 *   eine zweite Zeile rutscht.
 */

/** Die ehrlichen, knappen Phasentexte. ` ` schützt das „…" vor dem Umbruch. */
export const LOADER_TEXT = {
  auth: 'Anmeldung wird geprüft …',
  sites: 'Ihre Anlagen werden geladen …',
  page: 'Wird geladen …',
} as const;

/** Bei ungewöhnlich langer Ladezeit ein ruhiger Hinweis statt endlosem Kreisen. */
export const LOADER_HINT_SLOW = 'Das dauert gerade etwas länger als sonst …';

type LoaderSize = 'boot' | 'page' | 'section';

/**
 * Der reine Lade-Block (Marke + Text). Für Vollbild/Boot nutzt {@link VpLoaderScreen}
 * ihn in der Marken-Bühne; eingebettet (Karte/Bereich) steht er für sich.
 */
export function VpLoader({
  text = LOADER_TEXT.page,
  hint,
  size = 'page',
  className,
}: {
  text?: ReactNode;
  hint?: ReactNode;
  size?: LoaderSize;
  className?: string;
}) {
  // ⚠ Eindeutig je Instanz - siehe Kopf. `useId` liefert stabile IDs; die
  // Doppelpunkte müssen für `url(#…)` raus (sonst ungültiger Selektor).
  const raw = useId();
  const uid = raw.replace(/:/g, '');
  const fill = `vplFill-${uid}`;
  // ⚠ SAUBERER, geschlossener Blitz-Pfad (kein Selbstschnitt) - die Form der
  // Wortmarke, nur skaliert/positioniert. Der Kopf-Punkt steht FREI ÜBER dem
  // Blitz (Lücke über Position, nicht durch Verzerren des Pfads); die Ringe
  // (Basis-Radius 19) lassen rundum Luft.
  const bolt = 'M34 25 L25 37.5 L31 37.5 L30 46 L39 33.5 L33 33.5 Z';
  return (
    <div
      className={`vp-loader vp-loader-${size}${className ? ` ${className}` : ''}`}
      data-vp-loader={size}
      role="status"
      aria-live="polite"
    >
      <svg className="vp-loader-mark" viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={fill} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#B8D4FF" />
            <stop offset="0.5" stopColor="#7BA3F7" />
            <stop offset="1" stopColor="#5A8DE8" />
          </linearGradient>
        </defs>
        {/* Ausstrahlende Puls-Ringe (gleichmässiger Rhythmus = „lädt"). Sie
            beginnen AUSSERHALB der Marke (r=19 > Marken-Radius) - keine Kollision
            mit dem Kopf. */}
        <circle className="vp-loader-ring r1" cx="32" cy="32" r="19" stroke="#95B9FF" strokeWidth="2" />
        <circle className="vp-loader-ring r2" cx="32" cy="32" r="19" stroke="#95B9FF" strokeWidth="2" />
        <circle className="vp-loader-ring r3" cx="32" cy="32" r="19" stroke="#95B9FF" strokeWidth="2" />
        {/* Die ruhige Marke: Kopf (Pilot) FREI über dem Blitz + Blitz im
            Marken-Verlauf. */}
        <circle cx="32" cy="19" r="3.4" fill="#12151b" />
        <path d={bolt} fill={`url(#${fill})`} />
      </svg>
      <span className="vp-loader-text">{text}</span>
      {hint ? <span className="vp-loader-hint">{hint}</span> : null}
      <span className="vp-sr-only">Wird geladen…</span>
    </div>
  );
}

/**
 * Die ECHTE Wortmarke „Volt◁Pilot / ENERGY MANAGEMENT" (das Portal-Logo, nicht
 * eine Textfassung). BYTE-GENAU dasselbe Bild wie im Inline-Lader von
 * `index.html` (dort als Data-URI) - beide Fassungen sind damit pixelgleich, und
 * der React-Lader zeigt sie ohne Nachladen (`?inline` bäckt sie ins Bündel).
 */
export function VpLoaderWordmark() {
  return <img className="vp-loader-word" src={wordmarkUrl} alt="VoltPilot" width={640} height={152} />;
}

/**
 * Die VOLLBILD-Marken-Bühne des Ladens: 3-px-Marken-Streifen oben, Wortmarke,
 * darunter zentriert der {@link VpLoader}. **Deckungsgleich** zum Inline-Lader
 * in `index.html` (gleiche Wortmarke, gleiche Grössen, gleiche Positionen,
 * gleiche Statuszeile) - damit der Übergang Inline → React → Inhalt EIN
 * durchgehender Moment ist, kein Sprung.
 *
 * `leaving` blendet die Bühne aus (Überblenden zum Inhalt); der Aufrufer hält
 * sie so lange montiert (P6-Muster `useAusblenden`).
 */
export function VpLoaderScreen({
  text = LOADER_TEXT.sites,
  hint,
  leaving = false,
}: {
  text?: ReactNode;
  hint?: ReactNode;
  leaving?: boolean;
}) {
  // ⚠ PHASEN-ÜBERGABE (Review NICE-2): einmal beim Mount die laufende Phase des
  // Inline-Laders lesen und als `--vp-loader-phase` weiterreichen, damit die
  // React-Ringe rhythmus-nahtlos anknüpfen (siehe `src/bootHandoff.ts`). Beim
  // Boot steht der Inline-Lader noch im Dokument (er wird erst NACH diesem ersten
  // Bild entfernt); bei späteren Ladern liefert `readBootPulsePhase` `null` und
  // die Ringe starten wie bisher bei Phase 0. Lazy-Init = genau EINE Messung.
  const [phase] = useState(readBootPulsePhase);
  const style = phase ? ({ ['--vp-loader-phase']: phase } as CSSProperties) : undefined;
  return (
    <div
      className={`vp-loader-screen${leaving ? ' is-leaving' : ''}`}
      aria-hidden={leaving}
      style={style}
    >
      <div className="vp-loader-strip" />
      <div className="vp-loader-stage">
        <VpLoaderWordmark />
        <VpLoader size="boot" text={text} hint={hint} />
      </div>
    </div>
  );
}
