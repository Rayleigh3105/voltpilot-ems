# Der Befehls-Verlauf hat eine SUCHE und einen FILTER (Geräteseiten Stufe 3, R3)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 149).


Scout `data/vp-geraeteseite-rev-b8` §6 + Captain-Punkt 4 („Befehls-Log: SUCHE
und FILTER"). Der Verlauf kannte nur Heute/Woche und KEIN Bedienelement, obwohl
jede Zeile Strom, Herkunft, Urteil, Modus und Roh-Blick trägt. **Alles ist
additiv: ohne einen einzigen der neuen Parameter antwortet die Route
zeichengleich wie vorher** (in `CommandHistoryApiTest` beidseitig festgenagelt).

- **⚠ STRUKTUR serverseitig, TEXT clientseitig — das ist die tragende Teilung
  (§6 Regel 1).** Zeitraum · Befehlsart · Herkunft · Ergebnis entscheidet der
  Server (`command/CommandFilter`, rein + Docker-frei geprüft); der FREITEXT
  bleibt im Portal, weil die deutschen Sätze dort entstehen (`befehle.ts film()`).
  Eine Server-Suche fände nur Rohfelder und widerspräche damit dem, was der Kunde
  LIEST — genau die zweite Wahrheit, gegen die das Haus baut.
- **⚠ Ein unbekanntes Wort ist eine BENANNTE Ablehnung, nie ein stiller
  Rückfall.** Ein ignorierter Filter zeigte MEHR Zeilen als verlangt und läse
  sich als „es gibt keine weiteren" — die gefährlichere der beiden Auskünfte. Die
  Meldung nennt das erlaubte Vokabular (die `ChargingConfigService`-Disziplin);
  dafür trägt `SiteCommandHistoryController` seit dieser Stufe den
  `ResponseStatusException`-`@ExceptionHandler` (die Filter-Leiste ist eine
  Kunden-Fläche, ein nacktes 400 wäre dort keine Antwort).
- **Der TREFFER-ZÄHLER ist die Ehrlichkeit der Stufe:** die Antwort trägt
  additiv `total` (die Zeilen des Zeitraums OHNE Filter) und `matched` (mit ihm).
  Ohne beide Zahlen wäre ein scharfer Filter von einem leeren Zeitraum nicht zu
  unterscheiden, und die Fläche behauptete „in dieser Woche wurde nichts
  geschickt", wo 212 Zeilen liegen.
- **⚠ Der Seiten-Cursor `before` vergleicht `<=`, nicht `<`.** Zwei Zeilen dürfen
  denselben Beginn tragen; ein striktes Kleiner verlöre die zweite lautlos an der
  Seitengrenze. Die Grenzzeile kommt deshalb ZWEIMAL, und das Portal mischt die
  Seiten über die `id` — lieber doppelt als verloren. `nextBefore` ist `null`,
  sobald das Fenster vollständig gezeigt ist (nie ein Knopf ins Leere).
- **`range` kennt zusätzlich `month`, ein eigener Zeitraum reist als
  `from`/`to` (Kalendertage, `to` EINSCHLIESSLICH).** **⚠ Weiter zurück als die
  Aufbewahrung wird ABGELEHNT statt still gekappt** — ein Fenster dahinter fände
  nichts und läse sich als „damals wurde nichts geschickt", eine entlastende
  Aussage über eine gelöschte Zeit. `year` gibt es aus demselben Grund nicht.
- **Die zwei Ergebnis-Vokabulare beantworten verschiedene Fragen** („hält das
  Gerät den Befehl" gegen „ist der eine Schreibvorgang angekommen"), also
  schliesst ein Filter aus dem einen den anderen SPEICHER aus — `includesLog`/
  `includesRegister` stellen die Abfrage dann gar nicht erst. `fremdeinfluss` und
  `notaus` sind bewusst KEINE Rücklese-Urteile: sie leben in eigenen Spalten,
  weil sie andere Fragen beantworten (die `target_verdict`-neben-`state`-Regel).
- **⚠ Die drei Register-Ausgänge sind eine ABBILDUNG, keine Spalte.** Das Journal
  kennt sechs (`uebernommen`, `nicht_uebernommen`, `abgelehnt`, `fehler`,
  `unbekannt`, `gelesen`), ein Kunde fragt nach dreien: „nicht übernommen"
  bündelt Widerspruch, Ablehnung und Fehler, „keine Quittung" ist ausdrücklich
  das SCHWEIGEN — die PR-280-Lehre auf dem Register-Pfad. Gefiltert wird als
  `HAVING` über den GEFALTETEN Vorgang (das Ergebnis steht auf der Quittung, die
  Herkunft auf der Anforderung — ein Prädikat auf einer Zeile beantwortete
  jeweils nur die halbe Frage).
- **Beweise:** rein `CommandFilterTest` (14) · Testcontainers
  `CommandHistoryApiTest` (+3: Struktur-Filter mit beiden Zahlen und der
  benannten Ablehnung, `month`/eigener Zeitraum/Aufbewahrungs-Grenze, Deckel +
  Cursor inkl. der doppelten Grenzzeile). Portal-Seite in
  `frontend/portal/AGENTS.md`.

