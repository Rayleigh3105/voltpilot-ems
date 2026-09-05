# Ein Messpunkt wird ueber SEINE Komponente gelesen (Geraeteseite Stufe 3c)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 82).


Cloud-Seite, Kontrakt und die Server-Haelfte: root `CLAUDE.md` „Mess-Selektion
JE KOMPONENTE" + „Geraeteseite Stufe 3c". Was HIER gelten muss:

- **⚠ DIE LEITREGEL: eine Bindung, die die Box nicht aufloesen kann, wird
  VERWEIGERT — nie gegen den primaeren Wechselrichter gelesen.** Bis zu dieser
  Stufe pollte `vp-measurements.js` JEDEN Punkt gegen `edge/inverter/config`;
  ein auf einem zweiten Fronius oder einer Wallbox gewaehltes Register wurde
  also von der Deye-Adresse gelesen — ein falscher Wert auf einem richtig
  aussehenden Punkt. Genau deshalb blieben 3a/3b ehrlich eingeschraenkt.
- **Die Regel ist rein** (`measurements/measurement-binding.js`, ohne I/O und
  ohne Uhr — das `otaapply`/`probe`-Muster): `entity_id` → der Pin
  `edge_source_id` aus der per-Entitaets-Registry → eine Quelle in
  `edge/sources/config`. Der Knoten abonniert dafuer zusaetzlich `edge/sources/config`
  und `edge/entities/+/config` und ist ausschliesslich Verdrahtung.
- **⚠ Die KOMPONIERTEN Typen (`battery-hybrid`/`grid-meter`/`house-load`) sind
  die eine Ausnahme ohne Pin** — sie SIND die Kanaele des primaeren
  Wechselrichters (`core/internal/entities/compose.go` `composedType`), also ist
  ihre Aufloesung auf den Primaeren die eigene Komposition der Box und zugleich
  byte-identisch zum Vor-3c-Verhalten. Die Liste ist gegen die Go-Datei gepinnt
  — **beide zusammen aendern.**
- **⚠ Der TARGET gehoert in den Gruppierungs-Schluessel.** Zwei Geraete hinter
  EINER Box koennen dieselbe Familie und dasselbe Register tragen; ein
  gemeinsamer Block laese die Adressen des einen ueber die Verbindung des
  anderen. Aus demselben Grund haelt die Runtime die gelesenen Woerter PRO
  TARGET (eine flache Karte dekodierte Geraet A mit den Woertern von B).
- **⚠ Die VERBINDUNG wird zur LESEZEIT aufgeloest** (`resolveDevice`), nie in
  den Plan eingebacken: eine Quelle, die zwischen Plan und Poll verschwindet,
  ergibt eine Luecke in der Zeit — nie eine Lesung des Primaeren.
- **Ein SunSpec-Punkt braucht die Discovery SEINES Geraets** (Adressen sind
  modell-relativ). Ein Target ohne eigene Discovery wird als
  `driver_unavailable` verweigert, statt die Modell-Basis des Primaeren zu
  borgen. Der Knoten laeuft die Discovery je sunspec-Target, serialisiert.
- **Die Verweigerung heilt sich selbst:** Registry und Messplan sind zwei
  unabhaengige retained Dokumente; welches zuletzt landet, loest ein
  Neu-Anwenden aus, also veroeffentlicht ein spaeterer Push einen korrigierten
  Status (`binding_unavailable` ist im Status-Kontrakt UND in der geschlossenen
  `REASONS`-Menge der api — ein Wort, das der Server nicht kennt, verwirft die
  GANZE Quittung).
- **⚠ Ein (Wieder-)Verbinden spielt JEDES retained Dokument auf einmal ein** —
  eine Entitaets-Konfiguration je Komponente. Die bindungs-getriebenen
  Neu-Anwendungen werden deshalb GEBUENDELT; ein neuer PLAN wird weiterhin
  synchron angewandt, weil sein Status die Quittung ist, auf die die Cloud
  wartet. Ohne die Buendelung wird aus einem normalen Reconnect ein
  Status-Sturm, den der Kern eins zu eins in die Cloud weiterreicht.
- **OCPP hat keine Verbindung**, eine Bindung waehlt und verweigert dort also
  nichts; die Zuordnung eines Measurands bleibt geraeteweit. Ebenso trägt der
  SAMPLE-Pfad weiterhin nur `point_key` — „welche Komponente hat das gemessen"
  beantwortet die Auswahl in der Cloud, nicht die Probe.
- **Wirksam mit dem naechsten Edge-Release** — eine laufende Box behaelt ihr
  Image und pollt bis dahin jeden Punkt gegen den Primaeren.
- Beweise: `measurements/measurement-binding.test.js` (die Regel + der
  Lockstep gegen `compose.go`) · `measurement-target.test.js` (Planer/Runtime:
  eigenes Geraet, zwei Geraete auf demselben Register, Verweigerung ohne
  Lesung, eigene SunSpec-Basis, ein ungebundener Plan ist byte-identisch) ·
  `measurement-node.test.js` (die Verdrahtung des Knotens gegen einen
  In-Process-RED/mqtt-Ersatz) · Go `internal/measurements` +
  `agent/measurement_binding_test.go` (die Bindung erreicht Layer 1
  BYTE-IDENTISCH; eine kaputte Kennung erreicht ihn nie).

