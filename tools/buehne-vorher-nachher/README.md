# AP-14 IP-20: Bühne „Bestandskunde vorher/nachher“

Die Bühne zeigt den belegten `main`-Stand `4aa1e7fb` und den aktuellen UEMS-Zweig
für die Referenzfälle U1 und U2 bei 375 und 1440 Pixeln. Sie benutzt weder den
lokalen VoltPilot-Stack noch feste Datenbankports: Testcontainers startet
nacheinander je eine Wegwerf-TimescaleDB mit eigenem Zufallspräfix; eine zweite
eigene Container-Ressource ist höchstens der Testcontainers-Aufräumer.

## Aufruf

Voraussetzungen: Docker, JDK 21, Node/npm mit den installierten Portal-Paketen,
Python 3 und ein freier Playwright-Port 4174. Das Skript wartet, solange dort
eine andere Bühne läuft oder solange weniger als 35 % Speicher frei sind.
Fremde Container werden weder als eigene gezählt noch angefasst; die eigenen
Datenbanken tragen das Präfix `vp-buehne-ip20-`. Der serielle
Testcontainers-Lauf hält selbst höchstens Datenbank und Aufräumer gleichzeitig.

```sh
bash tools/buehne-vorher-nachher/run.sh \
  --output "$TMPDIR/vp-buehne-bilder" \
  --review "$TMPDIR/vp-buehne-bestandskunde.html"
```

Der Lauf legt `main` als detached `git worktree` in einem eigenen temporären
Verzeichnis an; nur so kann der Aufnahme-Wächter den exakten Commit belegen.
Er führt dort denselben MockMvc-Nachweis wie auf UEMS aus: 168
`main`-Migrationen, `main-seed.sql` für U1 und `u2-main-seed.sql` für drei
Bestandsanlagen. Auf UEMS folgen die übrigen Migrationen sowie Standort-,
Funktions- und Rechte-Bestandsläufer. Danach werden nur die Antworten der
Startseiten-Routen aufgezeichnet und mit dem jeweils echten Portal-Build über
Playwright wiedergegeben.

## Was echt ist – und was nicht

Echt sind die beiden Portal-Quellstände, ihre Produktionskomponenten und die
HTTP-Antworten der echten Controller, Dienste und Repositories gegen die
Wegwerf-Datenbanken. Auch die Bestätigung in U2 wird einmal wirklich gegen die
API ausgeführt; der Nachher-Bildlauf gibt genau diese Antwort und den danach
aufgezeichneten Datenstand wieder.

Ersetzt sind Keycloak-Anmeldung und HTTP-Netztransport: MockMvc bekommt einen
Kunden-JWT, und Playwright beantwortet dieselben Routen aus den JSON-Aufnahmen.
Es gibt keine Live-Telemetrie, keine echte Box und keine Anmeldung; fehlende
Messwerte werden nicht als Null erfunden. Temporäre Antworten und Logs liegen
nur im eigenen `mktemp`-Verzeichnis und werden am Ende entfernt; der temporäre
Worktree wird dabei über Git abgemeldet. Das Skript entfernt keine fremden
Container, Netze, Volumes oder Dateien.

U1 ist bei 375 und 1440 Pixeln nach dem gezielten Einfrieren reiner
Endlos-Animationen bytegleich: Text-Differenz 0, Pixel-Differenz 0. Die in B9
genannten Einstiege sind additiv erreichbar, verändern die gezeigte
Cockpit-Startansicht aber nicht.

## Befund U2

Der entschiedene Referenzfall verlangt zwei Standorte: AN-1 und AN-2 gemeinsam,
AN-3 separat. Die gebaute Vorschau bietet bei drei Gruppen jedoch nur „alle
zusammenlegen“ oder „wieder getrennt lassen“. Eine gezielte Gruppierung 2 + 1
ist nicht bedienbar. Die Bühne dokumentiert deshalb den echten Standardweg mit
drei Standorten und repariert diese Produktabweichung ausdrücklich nicht.
