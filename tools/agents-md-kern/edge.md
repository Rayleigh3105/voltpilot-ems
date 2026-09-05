# edge-app — Project agent memory (Wegweiser)

**Diese Datei wird beim Arbeiten in `edge-app` in den Kontext geladen** (`CLAUDE.md` ist ein
Symlink darauf). Sie ist ein WEGWEISER: hier steht, was fast jede Edge-Sitzung braucht; jedes
Detail wohnt byte-verbatim in `docs/agents/edge/` und ist über den **Themen-Index** unten zu
finden. **Nie eine `docs/agents/`-Datei ganz lesen — greppen.**
Plattform-Wissen (Dienste, Verträge, Migrationen): `../AGENTS.md`.

## Was das ist

Die **installierbare Kunden-Box**, ein Docker-Compose-Paket aus zwei Schichten.
Sie ist NICHT `edge/` (die dünne Dev-Edge des Cloud-Stacks) und NICHT
`tools/edge-simulator` (ein reiner MQTT-Publisher) — die drei nie verwechseln.

- **Layer 2 `core/` (Go, `vp-edge-core`)** — bei jedem Kunden identisch und das EINZIGE, das
  mit der Cloud spricht: Erst-Enrollment über HTTPS, EINE ausgehende mTLS-MQTT-Verbindung,
  Store-and-forward-Puffer, Fahrplan-Zwischenspeicher + Ausführung, die Wächter
  (`internal/guards`), der eingebettete lokale MQTT-Bus, das lokale Web unter `:8484`,
  das OCPP-CSMS (`internal/csms`) und der OTA-Pfad.
- **Layer 1 `nodered/`** — die je Kunde verdrahtete I/O-Schicht: Palette `vp-*`, Treiber
  (Deye/Solarman-V5, Fronius, KACO, KOSTAL, SunSpec, go-e, Shelly, generisches Modbus),
  Mess-/Steuer-Flows. Vom VoltPilot-Team verdrahtet, nie vom Kunden.

## Bauen & testen

```bash
(cd core && go test ./...)                 # + `-race` im Tag-Gate
(cd nodered && npm test)                   # NICHT `node --test` an der Wurzel: sammelt vp-palette mit ein
(cd nodered/vp-palette && npm ci && npm test)
test/e2e-compose.sh        # isoliertes Compose-Rig (Docker, eigener Projektname + hohe Ports)
test/e2e-v2-compose.sh     # v2-Strecke: Registry → Flow → Wunsch → Arbitrierung → Wächter → Schreiben
test/e2e-ocpp.sh           # Lastmanagement-/Ladepark-Rig — DOCKER-FREI, misst an den Zählern
test/install-selfcheck.sh  test/update-selfcheck.sh   # Installer/Updater gegen echten Docker
```

⚠ `core/internal/web/static/*` ist `//go:embed`-t — nach jeder UI-Änderung das Core-Binär neu
bauen (`go test ./internal/web` bettet neu ein), sonst liefert der laufende Prozess das ALTE
Blatt aus. Ein Node-RED-Flow ist selbstenthaltenes JSON und kann keine Repo-Datei `require`n:
die Funktionsknoten tragen SYNCHRONISIERTE Kopien der Module, `flows-sync.test.js` ist der
Drift-Wächter, und `nodered/build-flows.js` erzeugt `flows.json` (nie von Hand editieren).

## Die harten Hausregeln

- **Der Edge rechnet NIE mit Preisen.** Die Wolke entscheidet die Ökonomie und markiert den
  Slot; die Box setzt das gegen ihre GEMESSENEN Werte durch. Eine Preisregel auf der Box wäre
  eine zweite Preiswahrheit.
- **Jeder Sollwert läuft durch `guards.Clamp`** (Nennband, SoC-Fenster, §14a-Hülle,
  EEG-Solarladen) — kein Pfad schreibt daran vorbei. Wer eine Richtung aus der Ruhe STARTET,
  braucht zusätzlich ein frisches Rücklesen und die Schreib-Tore.
- **Blind heißt INAKTIV — außer bei einer Compliance-Grenze.** Ein ökonomischer Wächter, dem
  die Messung fehlt, hält still; eine Einspeise-/Netzgrenze zieht sich stattdessen auf eine
  sichere statische Kappe zusammen und gibt NIE frei.
- **Ein Fehlschlag ist nie ein erfundener Wert.** Kein Sample ohne echte Lesung, keine
  fabrizierte 0, ein unplausibler Wert wird VERWORFEN (Lücke) statt gezeigt. Schweigen ist
  keine Aussage: „nicht bestätigt" ≠ „abweichend".
- **EIN Socket je Wechselrichter, mit Warteschlange.** Lesen, Vorschau, Steuern und
  Einmal-Schreiben teilen sich dieselbe Lane je (Host, Port); wer freigibt, ÜBERGIBT.
  Ein zweiter TCP-Pfad zum selben Gerät ist die dokumentierte Kollisionslektion.
- **Ein Rücklesen ist ein SEMANTIK-Vergleich, kein Zahlenvergleich**, und es wird entprellt.
- **Die Freigabe kommt aus dem KERN, nie aus einem Layer-1-Stempel.** Zertifizierung hat zwei
  Hälften (Flotten-Allowlist + Laufzeit-Freigabe je Gerät); ein Prüfstands-Beleg deckt genau
  das Modell, das auf dem Tisch stand.
- **Ein `.env`-Schalter muss in der Compose auch WEITERGEREICHT werden** — sonst ist er in
  Produktion nachweislich wirkungslos. Not-Aus-Flags haben die Vorgabe AN.
- **Eine Kennung, die auf dieser Box schon läuft, wird NIE neu vergeben**; Umbenennen ist
  label-only.
- **Ein SELBSTBAU-Gerät darf den Registry-Push nie scheitern lassen** — die Ableitung ist
  alles-oder-nichts, ein unbekannter Typ wird ÜBERSPRUNGEN, nicht abgelehnt.
- **Wer etwas ANDERES entwertet, nennt die Folge VORHER** (`static/consequences.js`).
- **Eine Edge-Änderung wirkt erst mit dem nächsten Edge-Release** — eine laufende Box behält
  ihr Image und überliest jedes neue Vertragsfeld. Verträge sind deshalb additiv.

## Rig- und CI-Fallen (gemessen, nicht vermutet)

Der Forgejo-Runner fährt selbst in einem Container am Docker-Socket des HOSTS: ein
veröffentlichter Port und ein Bind-Mount aus dem Workspace gehören dem HOST, nicht dem Job —
Dateien kommen über einen BUILD-KONTEXT herein, Anfragen laufen als Seitenwagen IM
Compose-Netz. Der Runner läuft als ROOT: ein Fehlschlag darf nie über Dateirechte erzwungen
werden, sondern über eine TYP-Kollision. Ein Test, der auf die Zustellreihenfolge zweier
I/O-Ereignisse baut, ist ein Rennen; eine Frist wird gegen eine INJIZIERTE Uhr geprüft, nie
gegen ihren eigenen Timer. Details: der Themen-Index unten und `../AGENTS.md` „Lieferweg".
