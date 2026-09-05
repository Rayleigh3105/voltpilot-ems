# Trust-Set-Bereitstellung beim Einrichten: das Portal ist der Auslieferpunkt

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 13).


Captain-Order 04.08.2026, nachdem der erste Live-Rollout mit „Das Vertrauens-Set
oder seine Signatur fehlt." abgelehnt wurde: eine NEUE Box kommt in die
Vertrauenskette, ohne dass jemand zwei Dateien von Hand kopiert.
Betreiber-Handbuch: [`docs/ota-signing.md`](docs/ota-signing.md) §6.0.

- **DIE VERTRAUENSGRENZE (wörtlich so in Code UND Doku, weil alles daran hängt):**
  (1) **Die Installation ist ein SANKTIONIERTER TOFU-Moment** — eine Box, die
  gerade eingerichtet wird, vertraut ihrem Installationskanal per Definition
  (sie hat sich soeben ihre IMAGES darüber geholt). Das aktuelle root-signierte
  Trust-Set über denselben Kanal auszuliefern fügt KEIN neues Vertrauen hinzu:
  die Box prüft die ROOT-Signatur weiterhin SELBST gegen ihre eingebackene
  Wurzel, der Kanal transportiert nur öffentliches Material. (2) **Der spätere
  Austausch bleibt out-of-band** — eine LAUFENDE Box holt sich NIE ein Trust-Set
  über das Netz (das wäre der Widerrufs-Anker über genau den Kanal, den er
  widerruft; die Rotations-Verteilung aus Stufe 4 bleibt offen). Der Core kennt
  die Route nicht; `update.sh` DARF ein fehlendes Set erkennen und den Weg
  NENNEN — es lädt nie eines herunter (im Selbst-Check festgenagelt).
- **api:** Tabelle `edge_trust_set` (Migration `V20260806010000`) ist ein
  **SINGLETON** — die Frage ist „welches Set gilt JETZT", und der VERLAUF liegt
  schon im Git (`edge-app/ota/`, eine Rotation ist ein reviewbarer Commit); eine
  zweite Historie hätte keinen Leser. `trust_set`/`signature` sind `text`, NIE
  `jsonb` (dieselbe Begründung wie `edge_release.manifest`). Routen in
  `EdgeTrustSetController`: `PUT /api/v1/admin/edge-trust-set` (platform-admin
  ODER `edge-release-publisher` — das Set entsteht in derselben Zeremonie wie
  der Release-Schlüssel; die Rolle wird dadurch nicht mächtiger),
  `GET /api/v1/admin/edge-trust-set` (Betreiber-Sicht) und **unauthentifiziert**
  `GET /api/v1/edge/trust-set/trust-set.json(.sig)`.
- **Die öffentlichen Routen liefern ROHE BYTES und heißen wie die ZIELDATEIEN** —
  kein JSON-Umschlag: darin stünde das Dokument als ESCAPED Zeichenkette, und
  der Abnehmer ist ein Shell-Installer, der sie dekodieren müsste; genau dort
  entstehen die stillen Byte-Abweichungen, an denen die Signatur scheitert. Im
  Controller **`byte[]` statt `String`** zurückgeben: ein `String`-Rumpf kann
  vom Jackson-Konverter als JSON-Zeichenkette SERIALISIERT werden (Quotes +
  Escapes) — dieselbe Fehlerklasse, gegen die `text` statt `jsonb` schützt.
- **Die api prüft die SIGNATUR nicht** (Doktrin des Registers: der einzige
  Verifizierer, auf den es ankommt, ist das Gerät). Geprüft wird nur die FORM —
  und dabei gilt **das Gegenteil der Release-Regel:** dort MÜSSEN Manifest und
  Signatur dieselbe `key_id` nennen, hier müssen sie sich UNTERSCHEIDEN. Der
  signierende (WURZEL-)Schlüssel darf NICHT im Set stehen, sonst könnte ein
  Trust-Set die Wurzel ERWEITERN (derselbe Invariant, den `vp-ota trust-set`
  erzwingt).
- **⚠ `docker cp` eines VERZEICHNISSES setzt den Besitzer des ZIELVERZEICHNISSES
  auf die uid des Hosts** (nachgemessen: `root:root` bzw. `501:root`). `/data/ota`
  gehörte danach nicht mehr dem unprivilegierten Core-Benutzer (`voltpilot`), und
  der könnte weder `target.json` (seine Zuweisung) noch `current.json` (den
  bezeugten Stand) schreiben — ein OTA-Totalausfall aus einer Kopier-Bequemlichkeit.
  Deshalb kopiert `install.sh` **einzelne DATEIEN in ein BESTEHENDES Verzeichnis**
  (dann bleibt dessen Besitz unberührt), und `agent/ota.go` legt `<data>/ota` beim
  Start selbst an, damit es dem Core gehört. Gilt für JEDE künftige Datei, die von
  aussen in ein Container-Volume wandert. Beweis (echter Docker, mutationsgetestet):
  `edge-app/test/install-selfcheck.sh`.
- **⚠ Eine Migration muss NACH dem höchsten schon ausgelieferten Stand sortieren,
  auch wenn sie fachlich zu einer früheren Stufe gehört.** Eine Version unterhalb
  des Stands einer langlebigen DB ist für Flyway „out of order" und wird bei der
  Vorgabe-Konfiguration NIE angewandt — die Selbstheilung repariert Prüfsummen,
  sie holt keine übersprungene Migration nach. (Deshalb heißt die Trust-Set-
  Migration `V20260806010000` und nicht `V20260804010000`.)
- **⚠ Wer eine Migration UMBENENNT, muss `target/` wegräumen — sonst prüft der
  Testlauf den ALTEN Stand mit** (echter Fall beim Rebase der Steuerung Stufe 4,
  25.08.2026). Maven kopiert Ressourcen nach `target/classes`, LÖSCHT dort aber
  nichts: nach einem `git mv` liegen beide Dateien nebeneinander, und wenn die
  alte Version mit einer inzwischen gemergten fremden Migration kollidiert,
  bricht Flyway mit `Found more than one migration with version …` ab. Der
  Schaden sieht dabei NICHT nach seiner Ursache aus — der Spring-Kontext kommt
  gar nicht hoch, also fallen DUTZENDE Testklassen mit `Errors` (nicht
  `Failures`) in einer Kaskade, deren erste Zeile von einer beliebigen Bohne
  handelt (`chargerComponentComposer`), und die echte Ursache steht erst am Ende
  der `Caused by`-Kette. **Regel: nach jedem Umbenennen/Löschen einer Migration
  `./mvnw clean test`, nie nur `test`** — und bei einer Fehler-Kaskade über
  fremde Klassen zuerst `ls target/classes/db/migration` lesen, bevor man den
  eigenen Code verdächtigt.
- **⚠ ZWEI GLEICHZEITIGE MAVEN-LÄUFE IM SELBEN MODUL ZERSTÖREN SICH GEGENSEITIG
  — und der Schaden sieht exakt aus wie ein echter Testfehler** (beim Bau von P7
  passiert). `target/` gehört dem MODUL, nicht dem Lauf: ein
  `./mvnw clean test` und ein paralleles `./mvnw test -Dtest=…` löschen bzw.
  überschreiben einander die `.class`-Dateien, und der Verlierer bricht mit
  `BeanDefinitionStoreException: I/O failure … Caused by:
  java.io.FileNotFoundException: class path resource […].class cannot be opened
  because it does not exist` ab — auf einer Bohne, die mit der Änderung nichts
  zu tun hat, in einer Testklasse, die mit ihr nichts zu tun hat. **Der
  Diskriminator ist die `FileNotFoundException` auf eine `.class`, deren QUELLE
  es gibt:** dann ist der Baum gesund und der Lauf kaputt, nie umgekehrt.
  **Regel: im selben Modul läuft IMMER nur EIN Maven-Prozess** — wer einen
  Vollauf fährt, wartet ihn ab, statt daneben eine Einzelklasse zu prüfen (das
  ist auch der Grund, warum die zwei Zahlen sonst nicht zusammenpassen: der
  Vollauf zählt Klassen mit, die bereits kontaminiert liefen). Der saubere
  Vollauf des Moduls `services/api` ist **1609 Tests in ~55 min** (Testcontainers,
  Docker vorausgesetzt) — wer die Zeit nicht hat, fährt die berührten Klassen
  einzeln UND wartet jede ab, bevor er die nächste startet.
- **⚠ Dieselbe Klasse trifft eine MUTATIONSPROBE: Maven vergleicht Zeitstempel,
  und ein per `mv`/`cp` zurückgespieltes Original ist ÄLTER als die mutierte
  `.class`.** Der nächste `./mvnw test` übersetzt es dann gar nicht neu, und die
  Mutation läuft weiter — sichtbar als eine Testklasse, die auf einem
  nachweislich sauberen Quelltext rot bleibt (beim Bau von Befund L8 genau so
  passiert: 10 rote Fälle in `ComponentSyncStatusTest` gegen eine unveränderte
  Datei). **Nach jedem Zurückspielen `touch` auf die Datei** (oder `clean`), und
  bei einem unerklärlichen Fehlschlag zuerst prüfen, ob die Quelle wirklich noch
  die Mutation trägt.
- **Betreiber-Ablauf:** einmalig je Flotte das Set ins Portal (`PUT`, curl in
  §6.0), danach bekommt es JEDE neue Box automatisch; eine BESTANDSBOX holt es
  mit `./install.sh --refresh-trust` nach (ausdrückliche Handlung des Betreibers
  an DIESER Box — der Ersatz für den scp-Zweizeiler, kein Automatismus und kein
  Flotten-Fan-out). Fehlt es im Portal, WARNT der Installer laut und die
  Installation gilt trotzdem als erfolgreich: eine Box ohne Trust-Set arbeitet
  vollständig, sie kann nur (noch) kein Release anwenden.
- **Beweise:** `AdminApiTest.theTrustSetIsUploadedByBothRolesAndServedByteExactToAnAnonymousInstaller`
  (echtes Keycloak + DB: beide Rollen laden hoch, ANONYMER Abruf bekommt die
  „unaufgeräumten" Bytes Zeichen für Zeichen zurück, Form-Ablehnungen inkl.
  „Wurzel gehört nie ins Set", Rollen-Grenze unverändert) ·
  `edge-app/test/install-selfcheck.sh` (gegen echten Docker: holen, ablegen,
  bytegenau, andere Dateien in `/data/ota` überleben, Verzeichnis bleibt
  schreibbar) · `edge-app/test/update-selfcheck.sh` (Weg genannt, nichts geladen).

