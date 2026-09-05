# Geräteseite Stufe 3c: die Box liest einen Punkt über SEINE Komponente

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 158).


Die Edge-Hälfte der Mess-Selektion (Scout `data/vp-geraeteseite-rahmen-r2` §2.3 Schicht 3 + §7.4;
sie schließt das dritte und letzte Loch des Messbibliothek-Bugs). **Alles ist ADDITIV: ein Plan ohne
eine einzige `entity_id` — also jede Anlage, deren Portal-Fläche 3a noch nicht ausgeliefert ist —
wird byte-identisch geplant wie vorher** (in `measurement-target.test.js` festgenagelt).

- **⚠ DER BEHOBENE BEFUND: die Box pollte JEDEN Punkt gegen `edge/inverter/config`.** Ein auf einem
  zweiten Fronius oder einer Wallbox gewähltes Register wurde also von der DEYE-Adresse gelesen — ein
  falscher Wert auf einem richtig aussehenden Punkt. Genau deshalb mussten 3a und 3b ehrlich
  eingeschränkt bleiben („Beobachten wird für dieses Gerät mit dem nächsten Box-Stand möglich").
- **⚠ DIE LEITREGEL: eine Bindung, die die Box nicht auflösen kann, wird VERWEIGERT — nie gegen den
  Primären gelesen.** Der Kontrakt bekam dafür EIN neues Wort im geschlossenen Ablehnungs-Vokabular:
  **`binding_unavailable`** (`mqtt-measurement-config-status.schema.json`). **Es musste an DREI
  Stellen nachgezogen werden** — Schema, Go `measurements.reasons` und die Java-Menge
  `MeasurementConfigStatusListener.REASONS`: ein Wort, das der Server nicht kennt, verwirft die
  GANZE Quittung, und jeder Punkt des Geräts bliebe für immer `pending_edge` (genau der Defekt, den
  PR 536 behoben hat). **Wer eine weitere Ablehnung einführt, zieht alle drei mit.**
- **Die Regel ist rein** (`edge-app/nodered/measurements/measurement-binding.js`, ohne I/O und ohne
  Uhr — das `otaapply`/`probe`-Muster): `entity_id` → der Pin `edge_source_id` aus der
  per-Entitäts-Registry (`edge/entities/{id}/config`) → eine Quelle in `edge/sources/config`, über
  deren Verbindung gelesen wird. `vp-measurements.js` abonniert die zwei retained Dokumente
  zusätzlich und ist ausschließlich Verdrahtung.
- **⚠ Die drei Auflösungen zum PRIMÄREN sind Absicht, nicht Bequemlichkeit:** kein `entity_id`
  (der Vor-3c-Vertrag), der Pin `inverter` (die reservierte Kennung der Box) und eine
  PLATTFORM-KOMPONIERTE Zeile ohne Pin (`battery-hybrid`/`grid-meter`/`house-load` — sie SIND die
  Kanäle des primären Wechselrichters, `edge-app/core/internal/entities/compose.go` `composedType`).
  Die Liste ist beidseitig gepinnt — **beide zusammen ändern**; eine dort ergänzte Komponente wird
  hier sonst ehrlich verweigert, verliert aber ihre Beobachtung.
- **⚠ Der TARGET gehört in den Gruppierungs-Schlüssel des Planers, und die Runtime hält die
  gelesenen Wörter PRO TARGET.** Zwei Geräte hinter EINER Box können dieselbe Familie und dasselbe
  Register tragen; ein gemeinsamer Block läse die Adressen des einen über die Verbindung des
  anderen, und eine flache Wort-Karte dekodierte Gerät A mit den Wörtern von B.
- **Die VERBINDUNG wird zur LESEZEIT aufgelöst**, nie in den Plan eingebacken: eine Quelle, die
  zwischen Plan und Poll verschwindet, ergibt eine Lücke in der Zeit — nie eine Lesung des Primären.
  Dieselbe Regel deckt die core-eigenen Transporte ab (eine Shelly-Quelle steht per Konstruktion
  nicht in `edge/sources/config`, ihre Bindung ist also unauflösbar und wird benannt).
- **Ein SunSpec-Punkt braucht die Discovery SEINES Geräts** (Adressen sind modell-relativ): der
  Knoten läuft sie je sunspec-Target serialisiert, und ein Target ohne eigene Discovery wird als
  `driver_unavailable` verweigert, statt die Modell-Basis des Primären zu borgen.
- **Die Verweigerung heilt sich selbst:** Registry und Messplan sind zwei unabhängige retained
  Dokumente; welches zuletzt landet, löst ein Neu-Anwenden aus, also veröffentlicht ein späterer
  Push einen korrigierten Status.
- **⚠ OCPP hat keine Verbindung**, eine Bindung wählt und verweigert dort also nichts (ein
  Ladepunkt ist eine echte Komponente ohne Pin — ihn zu verweigern schaltete OCPP still ab). Ebenso
  trägt der SAMPLE-Pfad weiterhin nur `point_key`: **„schon gemessen" bleibt geräteweit**, die
  Komponenten-Zuordnung beantwortet allein die Auswahl in der Cloud.
- **Go-seitig ändert sich nur die Prüfung:** die Bytes reisen unverändert an Layer 1 (die Signatur
  liegt über genau ihnen), und `entity_id` wird zusätzlich gegen die UUID-Form des Kontrakts geprüft
  — eine kaputte Kennung ist ein defektes DOKUMENT, keine fehlende Komponente, und darf die
  Bindungs-Schicht nie als unauflösbarer Schlüssel erreichen.
- **⚠ Wirksam erst mit dem NÄCHSTEN Edge-Release** — eine laufende Box behält ihr Image; bis dahin
  überliest sie `entity_id` und pollt jeden Punkt gegen den Primären (das dokumentierte
  Vor-3c-Verhalten). Cloud, Portal und Server sind unverändert lieferbar.
- **Beweise:** rein `measurement-binding.test.js` (die Regel + der Lockstep gegen `compose.go`) ·
  `measurement-target.test.js` (Planer/Runtime: eigenes Gerät, zwei Geräte auf DEMSELBEN Register,
  Verweigerung ohne eine einzige Lesung, eigene SunSpec-Basis, ein ungebundener Plan ist
  byte-identisch, HTTP-Gruppen und Byte-Order je Target) · `measurement-node.test.js` (die
  Verdrahtung des Knotens gegen einen In-Process-RED/mqtt-Ersatz: Abonnements, Annahme, Ablehnung,
  Selbstheilung, „eine unbrauchbare Quellenliste bindet nichts ab") · Go `internal/measurements`
  (Form + Vokabular) + `agent/measurement_binding_test.go` (die Bindung erreicht Layer 1
  BYTE-IDENTISCH; eine kaputte Kennung erreicht ihn nie). Vier der fünf tragenden Regeln sind
  mutationsgeprüft.

