import { useEffect, useRef } from 'react';
import * as echarts from './echarts';
import { FOKUS_GRIFF } from './chartFokus';
import {
  chartMotion,
  mergeArt,
  mergeMotion,
  type ChartPhase,
  type TypSpur,
} from './chartMotion';

/**
 * Shared ECharts lifecycle for every portal chart: init once on mount, dispose
 * on unmount, and re-render through a ResizeObserver on the container itself -
 * not just window resize - so a chart follows its container through sidebar
 * collapse, grid reflow and drawer layout. The render callback receives the
 * chart plus its current pixel width, so width-aware options (tick density,
 * axis names, legend room) re-evaluate at every size, and the canvas can never
 * end up wider than its container (the fluid-resize requirement).
 *
 * ## ⚠ DER EINE BEWEGUNGS-HEBEL (Bewegungs-Programm P1)
 *
 * Konzept `data/vp-motion-konzept-m1/report.md` §4.3/§5, Captain-Entscheid
 * 04.09.2026. **Jede ECharts-Flaeche des Portals geht durch diesen Haken**,
 * also sitzt die Bewegung HIER — und kein einziger der 16 Konsumenten wurde
 * dafuer angefasst:
 *
 * 1. **Einstieg = Maske, nie Wachstum.** Gezeichnet wird mit `animation: false`
 *    (jeder Wert steht ab Bild 1), aufgebaut wird die FORM von einer CSS-Maske
 *    am Container (`is-entering` + `@keyframes vp-chart-reveal`, `index.css`).
 * 2. **Genau EINMAL, beim ersten Sichtbarwerden.** Ein IntersectionObserver
 *    wartet, bis das Bild GEZEICHNET ist UND Breite hat UND im Blick liegt —
 *    ein Diagramm im zugeklappten Aufklapper deckt sich erst beim Oeffnen auf,
 *    ein schon sichtbares sofort. Ein Groessenwechsel loest KEINEN zweiten
 *    Einstieg aus (`aufgedeckt` rastet ein).
 * 3. **Danach Morph.** Ab dem Aufdecken traegt jedes weitere `setOption` die
 *    Update-Phase: alt → neu in `--vp-motion-chart-update`.
 * 4. **Die Optionen des Konsumenten gewinnen** (`mergeMotion`).
 *
 * ⚠ **Warum die Phase am AUFDECKEN haengt und nicht an einem Zaehler:** ein
 * Diagramm, das im zugeklappten Aufklapper montiert, zeichnet zuerst mit Breite
 * 0 und danach mit voller Breite. Wuerde die Phase schon beim zweiten
 * `setOption` umschlagen, waere genau dieser Sprung ein Morph aus einem
 * entarteten Zustand — also Balken, die aus der Null wachsen. Die Phase schlaegt
 * deshalb erst um, wenn das Bild nachweislich richtig und sichtbar stand.
 */
export function useEChart(
  render: (chart: echarts.ECharts, width: number) => void,
  deps: unknown[],
) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const renderRef = useRef(render);
  renderRef.current = render;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const inst = echarts.init(el);
    chart.current = inst;
    // ⚠ Der Aufdeck-Haken haengt an DIESER Marke, nicht an `.vp-chart`: nicht
    // jeder Behaelter traegt sie (`.vp-measure-chart` in `Messwerte.css`), und
    // `.vp-chart` einfach dazuzuschreiben brächte deren `height: clamp(...)`
    // mit - ein Hoehenstreit, den die Kaskade in einem Lazy-Stueck entscheidet.
    // Die Marke selbst traegt KEIN Aussehen, nur den Anker fuer die Maske.
    //
    // ## ⚠ SIE MUSS NACHGESETZT WERDEN — REACT SCHREIBT `class` GANZ
    //
    // Hier steht ein IMPERATIVES `classList.add` an einem Element, dessen
    // `className` REACT gehoert. Aendert die Flaeche ihre Klassenkette (die
    // Messwerte-Historie haengt `vp-chart-clickable` an, sobald ein Sprung-
    // hinweis dazukommt), schreibt React das Attribut als GANZES neu — und die
    // Marke ist weg. Im Browser gemessen: nach einem Wechsel Tag→Woche trug
    // der Behaelter `vp-c-bild vp-chart tall vp-chart-clickable` und KEIN
    // `vp-chart-motion` mehr; die Maske haette danach keinen Anker.
    //
    // Deshalb wird sie in der `setOption`-Huelle bei jedem Bild nachgesetzt
    // (`marke()`): das ist die eine Stelle, die ohnehin bei jedem Zustand
    // laeuft, und `classList.add` auf eine schon vorhandene Klasse ist ein
    // No-op. Kein Beobachter, kein zweiter Lebenszyklus.
    const marke = () => el.classList.add('vp-chart-motion');
    marke();

    // --- Der Fokus-Griff fuer die HTML-Legende (P2) -----------------------
    // Die Legende des Portals ist HTML und kann von sich aus nichts
    // hervorheben. Sie bekommt hier EINE Funktion an den Behaelter gehaengt
    // statt Zugriff auf die Instanz — siehe {@link fokusGriff}. `downplay`
    // ohne Namen nimmt jede Hervorhebung zurueck, auch die einer anderen
    // Serie: ein haengender Dimm-Zustand ist die eine Sache, die hier nicht
    // passieren darf.
    (el as unknown as Record<string, unknown>)[FOKUS_GRIFF] = (serie: string | null) => {
      if (!chart.current) return;
      if (serie) chart.current.dispatchAction({ type: 'highlight', seriesName: serie });
      else chart.current.dispatchAction({ type: 'downplay' });
    };

    // --- Bewegung: Phase + Aufdecken (P1) --------------------------------
    const phase: { current: ChartPhase } = { current: 'enter' };
    // Das Gedaechtnis DIESES Diagramms ueber seine Serien (P2). Es lebt genau
    // so lange wie die ECharts-Instanz: eine neu montierte Flaeche faengt bei
    // null an, und das ist richtig — sie hat kein Vorbild, gegen das sie
    // morphen koennte.
    const spur: TypSpur = { serien: new Map() };
    let gezeichnet = false;
    let imBlick = false;
    let aufgedeckt = false;
    let aufraeumen: number | undefined;

    const fertig = () => {
      window.clearTimeout(aufraeumen);
      el.removeEventListener('animationend', fertig);
      el.classList.remove('is-entering');
    };

    const aufdecken = () => {
      if (aufgedeckt) return;
      aufgedeckt = true;
      // Ab jetzt morpht jeder weitere Zustand.
      phase.current = 'update';
      const m = chartMotion();
      // Schalter 0: kein Aufdecken, kein Klassenwechsel - das Bild steht.
      if (m.scale === 0 || m.enter <= 0) return;
      el.classList.add('is-entering');
      // ⚠ Nie von `animationend` ABHAENGEN (Konzept §7.4): ein Tabwechsel
      // mitten in der Maske liefert das Ereignis nie, und die Klasse bliebe
      // mit ihrem `both`-Fuellmodus stehen. Die Frist ist der Endzustand.
      el.addEventListener('animationend', fertig);
      aufraeumen = window.setTimeout(fertig, m.enter + 120);
    };

    const vielleichtAufdecken = () => {
      if (aufgedeckt || !gezeichnet || !imBlick) return;
      if (el.clientWidth === 0) return;
      aufdecken();
    };

    // --- Die Huelle um `setOption` ---------------------------------------
    const orig = inst.setOption.bind(inst);
    type SetOption = typeof inst.setOption;
    (inst as unknown as { setOption: SetOption }).setOption = ((
      opt: echarts.EChartsCoreOption,
      ...rest: unknown[]
    ) => {
      const gemischt = mergeMotion(
        opt as Record<string, unknown>,
        chartMotion(),
        phase.current,
        spur,
      ) as echarts.EChartsCoreOption;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = (orig as any)(gemischt, ...mergeArt(rest));
      marke();
      gezeichnet = true;
      // Ein schon sichtbares Diagramm deckt sich sofort auf: der Beobachter
      // meldet nur AENDERUNGEN, und wer beim Zeichnen bereits im Blick lag,
      // bekaeme sonst nie ein zweites Ereignis.
      vielleichtAufdecken();
      return r;
    }) as SetOption;

    // ⚠ jsdom (und sehr alte Maschinen) kennen den Beobachter nicht. Dann gibt
    // es kein Aufdecken - und damit auch keine Maske, die haengen bleiben
    // koennte; die Diagramme stehen einfach, wie vor P1.
    const io =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(
            (entries) => {
              imBlick = entries.some((e) => e.isIntersecting);
              vielleichtAufdecken();
            },
            { threshold: 0.15 },
          )
        : null;
    io?.observe(el);

    const observer = new ResizeObserver(() => {
      if (!chart.current || !ref.current) return;
      if (ref.current.clientWidth === 0) return; // hidden - nothing to lay out
      chart.current.resize();
      renderRef.current(chart.current, chart.current.getWidth());
    });
    observer.observe(el);
    return () => {
      fertig();
      delete (el as unknown as Record<string, unknown>)[FOKUS_GRIFF];
      io?.disconnect();
      observer.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (chart.current) render(chart.current, chart.current.getWidth());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}
