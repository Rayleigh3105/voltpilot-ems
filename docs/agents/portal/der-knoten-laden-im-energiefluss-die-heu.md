# Der Knoten „Laden" im Energiefluss + die Heute-kWh (Phase 0 PR 3, Phase 0 KOMPLETT)

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 24).


Konzept `vp-verbraucher-cockpit-k1` §6 + §8 Schritte 4–8 (Captain-Entscheide **E3** Abzweig,
**E7** Abnahme am Simulator). Ohne Ladepunkt ist der Energiefluss **zeichengleich** zu vorher —
gepinnt rein (`adaptiveFlow.test.ts`, `migration.test.ts`) UND am DOM
(`AdaptiveEnergyFlow.test.tsx` vergleicht das ganze `<svg>` Zeichen für Zeichen, und beweist im
selben Test, dass der Wächter MIT Knoten wirklich anschlägt).

- **⚠ `charging` ist BEWUSST keine Topologie-Rolle.** `topology.ts` `Role` ist ein VERTRAG mit
  Go- und Java-Zwillingen und geteilten Vektoren (`topology-vectors.json`); ihn für eine reine
  Anzeige-Scheibe zu weiten hiesse, drei Sprachen und eine Kontrakt-Datei für etwas zu ändern,
  das der Server (noch) gar nicht ableitet. Der Knoten ist deshalb ein AUFSATZ aus `/chargers`,
  und `FlowVertexRole = Role | 'charging'` ist die eine Stelle, an der beides zusammenläuft. Die
  echte Rolle kommt in Phase 1 (§8, C2).
- **⚠ Farbe, weiche Füllung und Speichenbreite stehen seither AM Knoten** (`FlowVertex.color`/
  `.soft`/`.baseWidth`), nicht mehr als `ROLE_META[v.role]`-Nachschlag beim Rendern: für
  `charging` gibt es dort keinen Eintrag, und ein Nachschlag wäre die eine Stelle, an der der
  fünfte Knoten strukturell nicht hineinpasst. Der Abzweig ist DÜNNER als eine Hub-Speiche — er
  ist ein Teil, kein Anschluss.
- **⚠ Die Speiche endet am HAUS (`toX`/`toY`), nicht am Hub (E3).** Die Haus-Summe bleibt „alles
  hinter dem Anschluss", und der Abzweig sagt, wie viel davon ins Auto geht — Flussbild,
  Board-Zeile und Captain-Regel sagen dieselbe Zahl. Ein eigener Anschluss wäre ein Knoten AM
  HUB; dafür fehlt in Phase 0 das Flag (§8, C1), und ein geratener zweiter Anschluss wäre eine
  Behauptung über den Zählerschrank des Kunden. Jede andere Speiche lässt `toX`/`toY` weg und
  zielt weiter auf den Hub.
- **⚠ V15 noch einmal, hier SENKRECHT:** der Abzweig endet UNTER dem Beschriftungsblock des
  Hauses, sonst liefen die Laufpunkte mitten durch das Wort „Hausverbrauch". Gerechnet wird mit
  den WIRKLICH gezeichneten Zeilen, damit ein späterer Haus-Zusatz den Abzweig von selbst
  verkürzt statt ihn zu queren.
- **Die eine Ableitung ist `ladenKachel.flussKnoten`** — aus der SCHON gerechneten Kachel-Sicht,
  nie aus einem zweiten Durchlauf über die Stecker: Diagramm und Kachel dürfen über dieselbe
  Säule nichts Verschiedenes behaupten. Er hängt deshalb auch **nicht** an `zeigt('laden')`: die
  Kachel ist abwählbar, der Fluss zeigt trotzdem, wohin der Strom geht (E4 blendet nur die
  ZEILEN der Aufschlüsselung aus).
- **Kein Klick am Laden-Knoten** (§6): die Zusammensetzung wohnt in Kachel und Zeile; ein
  zweites Klickziel im Fluss wäre die Doppelung, die A1 gerade beseitigt hat.

### Heute-kWh: ZWEI Quellen, weil es zwei Dinge sind (`verbrauchHeute.ts`)

- **gemessene Komponente** → `entities/{id}/history?range=day`, Energie = Σ Mittelwert ×
  **gemeldeter** Eimerdauer (nie einer angenommenen). **Ladepunkt** → der ZUWACHS des
  OCPP-Registers `Energy.Active.Import.Register` (`/ocpp/meter-values` mit `from` + `pointKey`).
- **⚠ `max − min` gilt NUR auf einer monoton steigenden Reihe.** Ein Zähler, der mittags von 950
  auf 5 springt (Tausch/Reset/Überlauf), ergäbe 945 kWh statt der wirklichen ~57 — und ein
  Vorzeichen-Test wäre wirkungslos, weil die nackte Differenz positiv ist. Fällt die Reihe
  irgendwo, gibt es GAR KEINE Zahl. Dieselbe Regel wie `energyOverPeriod` und „Eigene
  Auswertung" Stufe 5.
- **⚠ Ein einziger unbelegbarer Stecker macht die SÄULEN-Summe unbelegbar** — eine Teilsumme,
  die sich „vollständig" liest, ist die gefährlichere der beiden Auskünfte (die `restToday`-Regel).
- **Der Abruf ist LAZY und paarig** (`useVerbrauchHeute`): erst beim Aufklappen, EIN
  Register-Abruf für alle Ladepunkte plus je gemessener Komponente ihre Tages-Historie. Ein
  Abruf je Säule wäre bei 25 Ladepunkten ein Sturm für eine Zahl, die eine Antwort schon
  enthält. Fail-soft: ein Fehler liefert keinen Eintrag, die Zeile bleibt bei ihrem „—".
- **⚠ `KomponentenSection` rechnet die Komposition ZWEIMAL, und das ist Absicht:** der erste Lauf
  (ohne Summen) sagt, WELCHE Komponenten eine brauchen, der zweite trägt sie. Die Teile-Menge
  hängt nicht an den Summen, also ist das keine Schleife — ein Hook, der seine eigene Eingabe
  erzeugt, wäre eine. Die Effekt-Abhängigkeit ist deshalb die Id-Menge als STRING.

### Der Sim-Abgleich (E7): `docs/contracts/ocpp-ladezustand-vectors.json`

Das Wort entsteht im Portal, die FORM auf der Box — und keiner kann den anderen prüfen. Also
pinnt EINE Datei beide Enden, und beide Seiten lesen sie PER PFAD:

- `edge-app/test/e2e-ocpp.sh` **L13** fährt jeden Fall am ECHTEN Simulator (der neue Rig-Haken
  `POST /status` des `vp-ocpp-sim` erzeugt die Zustände, die ein Ein-/Ausstecken nicht hergibt)
  und prüft, dass die Box die `edge`-Form meldet.
- `src/ladepunkte.test.ts` prüft, dass `ladeZustand()` aus der `portal`-Form GENAU das erwartete
  Wort + den Ton bildet, dass die zwei Formen dieselbe Aussage tragen und dass **jedes** Wort
  aus §4.2 abgedeckt ist. `verbrauchKomposition.test.ts` fährt dieselben Formen durch die
  Aufschlüsselung und prüft den **Rest-Wert** — inklusive der zwei Fälle, die ihn ehrlich
  unbestimmbar machen (ein ladender Stecker ohne Messung; eine getrennte Säule zieht nichts ab).
- **⚠ L13 ist UMKEHRBAR gebaut:** er fasst keine Säule an, die L4 danach braucht, beweist
  „Säule getrennt" an einer eigenen, nie verbundenen Säule OHNE Stecker (eine echte Trennung
  würde das Budget umverteilen und L4 an einer fremden Ursache scheitern lassen) und gibt
  Stecker 1 am Ende an das Lastmanagement zurück.

