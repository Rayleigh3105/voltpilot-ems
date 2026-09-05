# Das Trust-Set kommt beim EINRICHTEN mit - nie zur Laufzeit

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 32).


Captain-Order 04.08.2026 (der erste Live-Rollout wurde mit „Das Vertrauens-Set
oder seine Signatur fehlt." abgelehnt). Cloud-Seite, Endpunkte und die volle
Begruendung: root `AGENTS.md` „Trust-Set-Bereitstellung beim Einrichten" +
[`docs/ota-signing.md`](../docs/ota-signing.md) §6.0. Was HIER gelten muss:

- **`install.sh` holt und legt ab, `update.sh` NENNT nur den Weg.** Die
  Installation ist ein sanktionierter TOFU-Moment (die Box hat sich ihre IMAGES
  ueber denselben Kanal geholt und prueft die Root-Signatur weiterhin SELBST);
  eine LAUFENDE Box holt sich nie ein Trust-Set ueber das Netz - das waere der
  Widerrufs-Anker ueber den Kanal, den er widerruft. Der CORE kennt die Route
  gar nicht, und `update-selfcheck.sh` nagelt fest, dass in `update.sh` weder
  ein Download noch die Route vorkommt.
- **⚠ Es werden DATEIEN kopiert, nie das VERZEICHNIS.** `docker cp` eines
  Verzeichnisses setzt den Besitzer des ZIELVERZEICHNISSES auf die uid des
  Hosts (nachgemessen `root:root` / `501:root`); `/data/ota` gehoerte danach
  nicht mehr dem unprivilegierten `voltpilot`-Benutzer des Images, und der
  koennte weder `target.json` noch `current.json` schreiben - OTA waere still
  tot. `place_trust_set()` kopiert deshalb je Datei in ein BESTEHENDES
  Verzeichnis, und `agent/ota.go otaCheckLoop` legt `<data>/ota` beim Start
  selbst an (damit es dem Core gehoert, auch ohne `exec`). Die Regel gilt fuer
  JEDE Datei, die kuenftig von aussen in ein Container-Volume wandert.
- **`--refresh-trust` ist der Bestandsbox-Pfad** (nur holen + ablegen, kein
  Login, kein Pull, kein `up -d`, keine `.env`-Aenderung) - eine ausdrueckliche
  Handlung des Betreibers an DIESER Box, der Ersatz fuer den scp-Zweizeiler,
  kein Flotten-Fan-out.
- **Ein fehlendes Set ist KEIN Installationsfehler:** laute Warnung + Handpfad,
  Installation gilt als erfolgreich. Eine Box ohne Trust-Set arbeitet
  vollstaendig, sie kann nur (noch) kein Release anwenden.
- Beweis (echter Docker, mutationsgetestet - die naive Verzeichnis-Kopie faellt
  durch): `test/install-selfcheck.sh` Abschnitte 2b/2c.

