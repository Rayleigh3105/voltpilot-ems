/**
 * **Der Fokus-Griff und die Zeiger-Frage** (Bewegungs-Programm P2).
 *
 * ## ⚠ WARUM DAS EIN EIGENES MODUL IST — GEMESSEN, NICHT GESCHMACK
 *
 * Beides braucht die HTML-Legende (`ChartExplain`), und die steckt im
 * EINSTIEGS-Buendel (das Cockpit zeigt Legenden im ersten Bild). Wuerde sie
 * dafuer `chartMotion` importieren, haenge die GANZE Bewegungs-Schicht am
 * Einstieg — gemessen 1,4 kB gz, und der Waechter `test/bundle-smoke.sh` sagt
 * dazu zu Recht „neues Gewicht gehoert in ein Lazy-Stueck". Diese Datei traegt
 * nur, was die Legende wirklich braucht; `chartMotion` liest von hier mit.
 */

/**
 * Kann der Zeiger dieses Geraets SCHWEBEN?
 *
 * ## ⚠ WARUM DAS FUER DIE BEWEGUNG ZAEHLT (Spec §5, „Telefon: Tipp statt Hover")
 *
 * Fokus und Dimmen sind ein SCHWEBE-Zustand: ECharts hebt an `mouseover` hervor
 * und nimmt an `mouseout` zurueck. Auf einem Beruehrungs-Bildschirm gibt es das
 * zweite Ereignis nicht verlaesslich — ein Tipp auf eine Linie liesse die
 * anderen Serien auf einem Viertel stehen, und der Kunde haette keine Geste,
 * das rueckgaengig zu machen. Ein haengendes Dimmen ist schlimmer als gar kein
 * Fokus: es liest sich wie „diese Daten sind ausgegraut", also wie eine
 * AUSSAGE ueber die Zahlen.
 *
 * Deshalb ist der Fokus an das Schweben-Koennen gebunden, nicht an die Breite:
 * ein Tablet mit Maus bekommt ihn, ein 1440er Touch-Bildschirm nicht.
 * Dieselbe Frage stellt {@link InfoTip} seit je (`(hover: hover)`).
 *
 * **Ohne `matchMedia` (jsdom, Server-Rendern) gilt `true`** — die Maus-Fassung
 * ist die Vorgabe, und ohne Zeiger gibt es ohnehin keinen Schwebe-Zustand, der
 * haengen bleiben koennte.
 */
export function zeigerSchwebt(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(hover: hover)').matches;
}

/**
 * Der Fokus-Griff, den {@link useEChart} an seinen Behaelter haengt.
 *
 * Die Legende des Portals ist HTML (`ChartLegend`), nicht die von ECharts —
 * sie kann also nicht von selbst hervorheben. Sie braucht dafuer den Zugriff
 * auf die Diagramm-Instanz, und den soll sie NICHT bekommen: `ChartExplain`
 * duerfte sonst `echarts` importieren, und die Bibliothek haenge damit auch an
 * jeder Seite, die nur eine Legende zeigt. Stattdessen legt die Huelle EINE
 * Funktion an den Behaelter, und die Legende ruft sie.
 */
export type FokusGriff = (serie: string | null) => void;

/** Der Name des Griffs am DOM-Knoten. */
export const FOKUS_GRIFF = '__vpFokus';

/**
 * Den Fokus-Griff des Diagramms finden, in dessen Karte dieses Element steckt.
 *
 * ⚠ Gesucht wird nach OBEN und dann nach unten: die Legende ist ein
 * Geschwister des Diagramms, kein Vorfahr. Der Aufstieg ist auf wenige Ebenen
 * begrenzt, damit eine Legende nie das Diagramm einer FREMDEN Karte fokussiert
 * (auf einer Flaeche mit mehreren Diagrammen waere das die falsche Antwort).
 */
export function fokusGriff(von: Element | null, ebenen = 4): FokusGriff | null {
  let knoten: Element | null = von;
  for (let i = 0; knoten && i <= ebenen; i++, knoten = knoten.parentElement) {
    const ziel = knoten.querySelector?.('.vp-chart-motion');
    const griff = (ziel as unknown as Record<string, unknown> | null)?.[FOKUS_GRIFF];
    if (typeof griff === 'function') return griff as FokusGriff;
  }
  return null;
}
