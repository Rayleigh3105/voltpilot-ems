# Teil C: JEDE Installation bringt den Aktualisierer mit - ohne Flag

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 49).


`install.sh`s `pull_and_up()` zieht und startet den ganzen Stapel
(`dc pull` / `dc up -d`) - der `updater` ist seit dem 26.08.2026 ein
GEWOEHNLICHER Dienst ohne Compose-Profil, also braucht es dafuer keine
Sonderbehandlung mehr. `update.sh` bringt ihn aus demselben Grund auf einer
BESTANDSBOX mit: `up -d --remove-orphans` startet ihn wie jeden anderen
Dienst. **Das ist der EINE Handgriff je Bestandsbox** (`cd <deploy-dir> &&
./update.sh`), danach nie wieder.

Der frueher noetige GERAETE-Schalter (`ota/autonomy.json`,
`VP_OTA_AUTONOMOUS`) und sein `:8484`-Knopf sind ERSATZLOS entfallen: es gibt
nichts mehr einzuschalten. Beweis: `edge-app/test/install-selfcheck.sh`
(docker-frei: die generierte Compose traegt GAR KEIN Profil und keinen
Autonomie-Schalter mehr, und `pull`/`up -d` laufen ohne `--profile`).


