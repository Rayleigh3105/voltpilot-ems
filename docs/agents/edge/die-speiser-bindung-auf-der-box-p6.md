# Die SPEISER-BINDUNG auf der Box (P6)

Die Edge-Hälfte des Pakets P6 (Konzept `vp-deye-diybms-luecke-l5` §3.2b,
Captain-Entscheid E6 (a)). Der Cloud-Teil steht in
`../root/die-speiser-bindung-p6-die-eigene-batter.md`.

**Es entsteht KEIN neuer Weg.** Was die Box zeichnet, entscheidet weiterhin
`topology.Resolve` aus dem additiven `descriptor.role_assignment` des
Registry-Pushes (Befund L4) — die Cloud materialisiert die Bindung genau
dorthin. `driver.connection.binding` reist zwar mit, ist für die Box aber eine
ANGABE und keine Anweisung; eine zweite Auswertung wäre eine zweite Wahrheit
über denselben Speicher-Knoten, und eine ältere Box überliest das Feld
folgenlos.

## Zwei Änderungen in `internal/topology`

1. **`IsSelfBuiltType` kennt `user-defined-battery`.** Sie ist Kategorie
   `storage` — ohne diesen Eintrag liefen ihr `soc_pct` und ihr `power_kw` von
   selbst in den Speicher-Knoten, also die automatische Bindung, die E6
   ausschliesst. Eine ausdrückliche Zuordnung aus der Cloud schlägt die Vorgabe
   weiterhin (`Resolve`), genau dafür gibt es sie.
2. **Der Speicher-Knoten bekommt `soc_source` und `limits`** (Vertrag
   `docs/contracts/v2/topology-read-model.md`, geteilte Vektoren
   `topology-vectors.json`, byte-gleich mit dem TS-Zwilling). `soc_pct` und die
   vier Grenz-/Freigabe-Kanäle sind Speicher-EIGENSCHAFTEN, nie Fluss-Mitglieder
   — ein Ampere und ein Ja/Nein sind keine Kilowatt. Damit trägt auch
   `/api/state` auf `:8484` die Auskunft, WOHER der Ladestand kommt.

Eine Freigabe reist als ZAHL (der Kanal-Vertrag kennt nur Zahlen): alles ausser
0 heisst „ja". Ein abwesendes Feld fehlt im Block, statt als „erlaubt" gelesen
zu werden.
