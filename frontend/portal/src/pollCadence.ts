/**
 * DIE POLL-TAKTE DES PORTALS - EIN Ort, zwei Zahlen.
 *
 * Bis zum 31.08.2026 stand die 30 an rund fünfzehn Stellen als Literal; eine
 * Änderung des Takts war damit eine Suche über den halben Quelltext. Seither
 * importiert jede pollende Fläche ihre Kadenz von hier.
 *
 * **Warum 10 s für die Live-Flächen:** die Box liest ihre Wechselrichter alle
 * 5 s und schickt jede Messung sofort in die Cloud (`edge-app/core`
 * `publisherLoop`), der Lebenszeichen-Puls kommt alle 15 s. Am Server liegen
 * die Werte also rund 5 s frisch - das Portal holte sie aber nur alle 30 s und
 * zeigte damit im Mittel 15 s alte Zahlen. Schneller als der MESSTAKT der Box
 * zu fragen bringt nichts (es käme dieselbe Zeile zurück), deshalb ist 10 s der
 * Kompromiss: sichtbar frischer, ohne unter die Messung zu rutschen, zum Preis
 * von rund der dreifachen Anfragezahl je offener Live-Fläche.
 *
 * **Warum 30 s für den Rest:** Listen, Admin-Übersichten und die
 * Geräte-Lebendigkeit ändern sich nicht sekündlich - die Lebendigkeit misst
 * ausdrücklich gegen ein 5-Minuten-Fenster (`liveness.ts`), ein schnellerer
 * Takt könnte ihr Urteil gar nicht ändern.
 *
 * **Die Zuordnungsregel** für eine neue Fläche: zeigt sie gemessene IST-Werte
 * (Leistung, Ladestand, Steuerungs-Rückmeldung, Ladevorgang), gilt
 * `LIVE_POLL_MS`; zeigt sie eine Liste, eine Aggregation über einen Zeitraum
 * oder einen Verwaltungs-Stand, gilt `LIST_POLL_MS`.
 *
 * NICHT hier zuhause und bewusst eigenständig: Frische-FENSTER (etwa das
 * 30-s-Fenster in `fahrplanJetzt.ts`, gegen das ein Rücklese-Alter geprüft
 * wird - eine Aussage über die Daten, kein Takt) und Kadenzen mit eigener
 * Begründung (`deployWatch.ts`, `StrompreisStrip.tsx`, `ocppWallbox.ts`,
 * `SimulationView.tsx`).
 */

/**
 * Der Takt der Flächen, die gemessene Ist-Werte zeigen: Cockpit und
 * Anlagen-Seite samt Topologie, Portfolio-Cockpit, Komponenten, Geräte- und
 * Box-Seite, Befehls-Verlauf, Live-Daten, Ladevorgänge.
 *
 * Er ist zugleich die OBERGRENZE für eine Uhr, die „vor x Sekunden" anzeigt:
 * ein Zeitstempel darf nicht seltener neu gerechnet werden, als neue Daten
 * ankommen, sonst behauptet die Fläche ein Alter, das sie längst überholt hat.
 */
export const LIVE_POLL_MS = 10_000;

/**
 * Der Takt der Flächen ohne sekündliche Bewegung: Listen, die
 * Geräte-Lebendigkeit, die Plattform-Übersicht, Edge-Aktualisierungen, der
 * Flow-Editor und Zeitraum-Aggregate (Historie-Summen).
 */
export const LIST_POLL_MS = 30_000;
