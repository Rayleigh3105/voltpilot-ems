# Der eigene Anschluss ist eine eigene GRUPPE und ein eigener KNOTEN (Cockpit Phase 1 / C2)

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 27).


Konzept `data/vp-verbraucher-cockpit-k1` §6 (E3) + §3 Regel 5; die drei Zwillinge und die
Vektoren stehen in `../../AGENTS.md` „Cockpit Phase 1 / C2". Der Laden-Kreis war seit Phase 0
ein Aufsatz aus `/chargers`; jetzt gibt es ZWEI Kreise, und die Aufschlüsselung hinter der
Haus-Zeile trennt mit. **Ohne eine einzige `eigen`-Säule ist beides zeichengleich zu vorher** —
das Flussbild als ganzes `<svg>`-Vergleich, die Aufschlüsselung im reinen Test.

- **⚠ Die ZAHL des Lade-Kreises kommt weiter aus `/chargers`, nicht aus dem Read-Model.** Sein
  WORT („lädt" / „Auto eingesteckt" / „kein Auto") ist ein OCPP-ZUSTAND, den die Topologie
  nicht trägt — zwei Quellen für denselben Kreis wären zwei Zahlen, die sich widersprechen
  können. `FlowVertexRole` IST seit C2 die Topologie-Rolle (der frühere Sonderwert `charging`
  neben `Role` ist entfallen), also schlägt die Fläche Farbe und Beschriftung wieder im
  Katalog nach statt in eigenen Konstanten.
- **⚠ Der PLATZ eines Lade-Kreises sagt, WORAN er hängt** (`Side` kennt dafür zwei neue Werte):
  `right-below` = unter dem Haus mit einer Speiche ZUM HAUS (der Abzweig, die Haus-Summe bleibt
  „alles hinter dem Anschluss"), `left-below` = unten links mit einer Speiche ZUM HUB (ein
  eigener Anschluss neben dem Haus). Zwei verschiedene Plätze, damit eine Anlage mit BEIDEN
  Arten zwei Kreise bekommt statt zweier übereinander. Beide werden AUSSERHALB der Hub-Schleife
  platziert (`CHARGING_ROLES`) — einer von ihnen hängt am Haus, eine Geometrie, die die
  Schleife nicht kennt.
- **`ladenKachel.ladeFlussKnoten(charging)` ist die EINE Ableitung beider Kreise** — sie
  filtert die Säulen und schickt jede Hälfte durch DIESELBE `ladenKachel`-Sicht, die auch die
  Kachel rendert. Ein zweiter Rechenweg wäre die Stelle, an der Kachel und Diagramm sich
  widersprechen; `c.connection !== 'eigen'` ist dabei die sichere Richtung (`null` = eine
  ältere Box meldet es nicht = `haus`).
- **Die Gruppe „Laden (eigener Anschluss)" ist in `verbrauchKomposition.ts` verdrahtet**
  (das Vokabular lag seit C1 bereit, es routete nur nichts hinein). `eigeneKeys` ist die eine
  Menge, aus der DREI Regeln folgen: sie werden **nicht vom Haus abgezogen** (sie waren nie
  darin — `hausTeile`), sie zählen **nicht in „davon Laden"** (`ladenKw`/`subLine` beschreiben
  einen Teil DES Hauses), und sie bilden **ihre eigene Gruppe NEBEN dem Haus**.
- **⚠ Eine Lücke NEBEN dem Haus ist keine Lücke IM Haus.** Ein ladender `eigen`-Stecker OHNE
  Messwert macht den Rest NICHT unbestimmbar — die Blocker-Regel läuft seit C2 nur noch über
  `hausTeile`. Dasselbe gilt für `restToday`: seine kWh liefen woanders.
- **⚠ Kopf und Kollaps-Satz einer Lade-Gruppe zählen NUR ihre eigenen Zeilen** (`stecker` /
  `punkte` aus `sorted`, statt der anlagenweiten Zähler): „1 von 2 lädt" über einer Gruppe mit
  EINER Zeile wäre eine Aussage über Stecker, die dort gar nicht stehen. Beide Lade-Gruppen
  kollabieren gemeinsam mit der Kachel (E4 — sie wohnen beide darin).
- **⚠ Der TYP entscheidet in `defaultRole` mit, also mussten drei Portal-Leser nachziehen**
  (`rollen.isAutoAssigned`, `surface.baseSurface`, `flows/templateFilter.plantRoles`): der
  Katalogtyp `ev-charger` deklariert `soc_pct`, und ohne den Typ zählte der Ladestand des
  AUTOS als Speicher-Nachweis — eine Anlage mit Wallbox und ohne Batterie bekäme die
  Speicher-Flächen. `TopologyEntity.connection` reist dafür mit, damit `isAutoAssigned` die
  Server-Auflösung nachvollzieht statt sie zu raten.
- **⚠ Der Test-Helfer `charger()` muss `connection` durchreichen** — er baut sein Objekt
  explizit auf, und ein vergessenes Feld lässt jeden C2-Fall am falschen Ende scheitern (beim
  Bau genau so passiert: drei Fehlschläge, alle aus derselben Ursache).
- **Beweise:** `verbrauchKomposition.test.ts` (+10, die drei Regeln mutationsgeprüft) ·
  `topology.test.ts` (die geteilten Vektoren) · `adaptiveFlow.test.ts` +
  `AdaptiveEnergyFlow.test.tsx` (ohne Ladepunkt ist das ganze `<svg>` zeichengleich — und der
  Wächter schlägt MIT Knoten wirklich an) · `ladenKachel.test.ts` (die zwei Hälften).

