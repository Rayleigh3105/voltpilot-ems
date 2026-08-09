# OTA-Fehlerinjektions-Matrix (Stufe 3 „Autonom")

Der **echte** `vp-edge-updater` gegen einen **echten** docker-Daemon, mit einer
**echten** Signaturkette und einer **echten** Registry. Nur die beiden
getauschten Komponenten sind winzige Stellvertreter — geprüft wird die
ORCHESTRIERUNG, nicht das Verhalten von Node-RED.

```bash
./run.sh            # alle Fälle
./run.sh --list     # die Liste
./run.sh happy prune
./run.sh --keep     # Arbeitsstand nach dem Lauf behalten
```

**Die eine Zusicherung, an jedem Ausgang jedes Falles:**
*entweder der alte Stapel läuft, oder der neue ist bestätigt — nie eine tote Box.*

Fall-Tabelle, Betreiber-Ablauf und das, was zusätzlich auf echter Hardware
gehört: **[`docs/ota-autonomie.md`](../../../docs/ota-autonomie.md) §6.**

---

## Rechner-Disziplin (im Skript verdrahtet, nicht nur zugesagt)

- eigenes Compose-Projekt `vp-ota-soak`, eigene hohe Ports, eigene Volumes —
  ein echter Edge-Stack wird nie berührt;
- **immer nur EIN Stapel gleichzeitig**: nach JEDEM Fall wird abgeräumt, auch
  nach einem Fehlschlag;
- Platz wird vor dem Start geprüft (< 2 GiB frei ⇒ Abbruch);
- **es wird nie ein `docker system prune` ausgeführt.** Der `prune`-Fall räumt
  ausschließlich die eigenen Images weg (genau das, was `prune -a` mit ihnen
  täte) und belegt die Überlebensregel des Rückfall-Images zusätzlich mit einem
  *label-gefilterten* echten `docker image prune -a`;
- am Ende entfernt `purge_all` Container, Images und Arbeitsdateien der Matrix.

## Warum das Sidecar-Image hier neu gebaut wird

Der Sidecar hat **keinen** Umgebungs- oder Pfad-Schalter für die
Vertrauenswurzel — genau die Übernahme, gegen die die kalt/heiß-Trennung gebaut
ist. Die Wurzel wird eingebacken, also backt die Matrix ihre Wegwerf-Wurzel
ebenso ein (`lib.sh build_updater`). Damit prüft sie nebenbei den Weg, den die
echte Zeremonie später geht — und das ausgelieferte Image bleibt fail-closed.

## Wer hier den Kern spielt

Unter Test steht der **Sidecar**. Der Kern ist ein Stellvertreter aus
`lib.sh`: er schreibt `core-signal.json` (Zustand der Anlage, Interlock-Eingang,
Bestätigung des durablen Berichts) und `self-test.json` (das Urteil des neuen
Standes). Die Kern-Hälfte selbst ist in Go unit-getestet —
`edge-app/core/internal/agent/ota_autonomy_test.go`.

Es gibt **keinen Hintergrundprozess**: jeder Warteschritt frischt den
Kern-Zustand selbst auf. Ein Hintergrund-Takt verwaiste bei einem Fehlschlag,
hielt die Ausgabe-Pipe offen und war der einzige nicht-deterministische Teil der
Matrix.

## Nach einem Fehlschlag

`edge-app/test/ota-soak/last-failure/` trägt den Protokollstand (`ota/`), das
Sidecar-Log und die verwendete `.env` — abgelegt BEVOR abgeräumt wird.

## Was diese Matrix im Bau bereits gefunden hat

Vier echte Defekte, alle mit einem Regressionstest festgenagelt:

1. der Motor reichte die Vertrauenswurzel als `nil` weiter, statt die
   eingebackene zu laden — jedes Release wäre mit dem falschen Grund abgelehnt
   worden;
2. `docker compose -f <datei>` löst gegen das ARBEITSVERZEICHNIS auf, nicht
   gegen `--project-directory` — im Container also `/docker-compose.yml`;
3. nach einer Rücknahme begann der nächste Takt denselben Tausch von vorn (die
   Zuweisung liegt ja noch) — eine Endlosschleife aus Tausch und Rücknahme.
   Daraus wurde die Regel „was hier einmal zurückgerollt wurde, läuft nie
   wieder von selbst an" (`/data/ota/failed.json`).
4. das Aufräumen abgelöster Abbilder sammelte auch ein, was VORAUS bereitgelegt
   war: die Matrix legt ihre Stellvertreter für spätere Fälle vorab an, und ein
   früherer Fall nahm sie mit. Daraus wurde die Regel „entfernt wird nur, was
   ÄLTER ist als der hier laufende Stand" — es sind ja *frühere* Releases, die
   weg sollen (`otaapply.PlanPrune`, Anker je Repository).
