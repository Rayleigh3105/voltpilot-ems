# ⚠ Eine Kennung, die auf dieser Box schon läuft, wird NIE neu vergeben

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 52).


Der Live-Defekt, der die Regel erzwungen hat (Anlage Pilsting/Herzogau, Update
edge-2026.08.5 -> .10): dieselben zwei Fronius lieferten weiter Messwerte, aber
ihre Komponenten im Portal lasen „nicht mehr mit einem gemeldeten Gerät
verbunden" und dieselben Wechselrichter meldeten sich daneben als „Neues Gerät
gefunden". Ursache war KEIN geänderter Fingerabdruck, sondern eine
Vergabe-Lücke:

- **`sources.DeterministicID` wurde ohne Migration eingeführt** (PR 270,
  29.07.2026) - bewusst, denn eine Migration hätte genau die Portal-Pins
  gerissen, die sie schützen sollte. Die Kennung wird ausschliesslich bei
  `AddSource` vergeben. **Jede vor diesem Tag eingerichtete Anlage trägt bis
  heute ZUFÄLLIGE Kennungen.**
- **`componentapply.Derive` leitete die Kennung dagegen jedes Mal neu ab** - und
  auf so einer Anlage kam eine ANDERE heraus. Die Bestands-Übernahme (Stufe 2)
  schrieb damit `sources.json` neu, veröffentlichte `edge/sources/config` neu und
  die Box meldete ab dem nächsten Herzschlag fremde Kennungen. Die Zusage „die
  Übernahme ist ein No-op" galt nur für Anlagen ab PR 270.

Die Regel: **`Derive` bekommt die LAUFENDE Geräteliste als Eingabe und behält
die Kennung jedes Geräts, dessen Transport-Identität sie wiedererkennt** - ganz
gleich, wie diese Kennung aussieht. Eine Kennung wird nur noch für ein Gerät
GEBILDET, das diese Box noch nie gefahren hat. Dazu gehört:

- **`sources.TransportIdentity` ist die EINE Stelle, an der „welches Gerät ist
  das?" beantwortet wird**; `DeterministicID` ist nur noch ihr Hash. Wer den
  Identitäts-Begriff ändert, ändert genau diese Funktion - beide Konsumenten
  ziehen mit.
- **Der Kollisions-Schutz keyt seither auf den FINGERABDRUCK, nicht auf die
  abgeleitete Kennung** („zwei Geräte mit derselben Verbindung"). Sonst könnten
  zwei Entitäten desselben Geräts über zwei geerbte Kennungen aneinander
  vorbeirutschen.
- **Mehrdeutigkeit wird nie geraten:** zwei laufende Quellen mit identischer
  Transport-Identität (nur über den lauten Kollisions-Fallback von `AddSource`
  möglich) übernehmen nichts - ausser die eine, die ohnehin schon die
  deterministische Kennung trägt.
- Cloud-Hälfte (die schon gerissenen Anlagen heilen sich selbst):
  root `AGENTS.md` „Die RE-PIN-BRÜCKE".
- Beweise: `componentapply/continuity_test.go` (die 08.5-Identität gegen das neue
  Schema, die zwei Einheiten hinter EINER IP, ein Rollenwechsel erbt nie,
  Mehrdeutigkeit) + `agent/component_continuity_test.go` (die ECHTE Übernahme
  schreibt `sources.json` byte-gleich nicht neu und wirft keine Messwerte weg) -
  beide mutationsgeprüft.

