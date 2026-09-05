# ⚠ Ein Auftrag OHNE Abonnent ist spurlos - und eine VORSCHAU hinterlaesst nie eine Spur

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 61).


Produktionsvorfall 20.08.2026 („der Downlink kommt auf der Box nie an").
Cloud-Haelfte + die Adressierungs-Regel: root `AGENTS.md` „DIE ADRESSE IST NICHT
DAS ZIEL". Was HIER gelten muss:

- **Die Box abonniert GENAU EIN Topic** (`Link.topic("v2/register-write")`), und
  der Auftrag ist NICHT-retained: landet er auf der Kennung einer anderen
  Geraete-Zeile, gibt es keinen Abonnenten, keine Ablehnung und keine Zeile - auf
  keiner der beiden Seiten. Das ist der Preis der Einmal-Semantik und der Grund,
  warum die Adresse aus dem ZIEL abgeleitet werden muss und nicht aus einer
  Behauptung des Aufrufers.
- **⚠ EINE VORSCHAU WIRD NICHT AUDITIERT** (`runRegisterWrite`:
  `if admitted.Apply()`) - genauso wenig wie die `:8484`-Taste einen Probelauf
  protokolliert (es gibt kein „nachher", und ein Log der Lesevorgaenge begruebe
  die Schreibvorgaenge, fuer die es das Buch gibt). Folge, die eine Untersuchung
  sonst in die falsche Richtung schickt: **eine leere
  `GET /api/installer-write`-Liste beweist NICHT, dass ein Auftrag nicht
  angekommen ist** - bei einer funktionierenden Vorschau sieht sie exakt genauso
  aus.
- **Deshalb protokolliert die Box jetzt den GLUECKLICHEN Pfad**: eine INFO-Zeile,
  wenn ein Auftrag ANGENOMMEN wird (id, Modus, Lane, Register), und eine, wenn
  das Ergebnis hinausgeht. Bis dahin loggten nur Ablehnungen - „ist der Auftrag
  ueberhaupt angekommen?" war aus dem Geraet heraus unbeantwortbar. Es ist die
  Kehrseite derselben Regel, aus der jede Ablehnung sichtbar sein muss: Stille
  ist kein Beleg.
- **⚠ Ein Test, der den TOPIC beweisen soll, darf den Handler nicht direkt
  aufrufen.** `agent/register_write_test.go` ruft `a.onRegisterWrite(payload)` -
  das Abonnement des Cloud-Links kommt darin gar nicht vor, eine vertauschte
  Kennung waere dort strukturell unsichtbar.
  `agent/register_write_integration_test.go` schliesst das Gelenk: echter Agent,
  echter Broker, der Auftrag auf dem WOERTLICH gebauten Vertrags-Topic - und die
  Gegenprobe mit einer VIERTEN Kennung, die nichts ausloesen darf.

