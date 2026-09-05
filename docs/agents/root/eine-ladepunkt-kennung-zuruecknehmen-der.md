# Eine Ladepunkt-Kennung ZURÜCKNEHMEN: der GRABSTEIN, nicht das Löschen

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 151).


Captain-Order 24.08.2026 („ebenso will ich die möglichkeit haben eingebene
kennungen zu löschen"). Sie revidiert die Add-only-Zusage des Abschnitts darüber
ausdrücklich; alles hier ist ADDITIV — eine Flotte, die nie eine Kennung
zurücknimmt, verhält sich zeichengleich wie vorher.

- **⚠ DAS KERNPROBLEM IST DER RETAINED-KANAL, und daraus folgt die ganze Form.**
  Das Konfigurations-Dokument wird als GANZES ersetzt, und `charge_points` FÜGT
  auf der Box nur HINZU (der Grund: eine Box, die beim Speichern offline war,
  darf ihre Kennungen nicht verlieren, wenn ein späteres Dokument sie nicht mehr
  aufzählt). Eine Kennung schlicht WEGZULASSEN erreicht damit genau die Box
  nicht, die sie am dringendsten vergessen müsste. Die Rücknahme braucht deshalb
  ihre EIGENE, ausdrückliche Liste, und die muss in JEDEM folgenden Dokument
  mitreisen: **`removed_charge_point_ids`** (Top-Level, additiv,
  `schema_version` bleibt 1.0; Fixture
  `mqtt-charging-config.valid.saeule-entfernen.json`, vom Go-Parser PER PFAD
  gelesen). **Ein `removed: true` INNERHALB von `charge_points` kam nicht in
  Frage:** eine ältere Box liest unbekannte Felder weg und würde die gerade
  gelöschte Kennung ZULASSEN — genau die Falschantwort, gegen die additive
  Verträge gebaut sind.
- **⚠ Die drei Kompatibilitäts-Regeln, alle gepinnt:** ein ALTES Dokument ohne
  das Feld ist byte-kompatible PATCH-Semantik („abwesend = behalten"); eine
  ÄLTERE Box, die das Feld nicht kennt, tut NICHTS FALSCHES (Gos
  `encoding/json` überliest es, die Säule bleibt zugelassen — der vorige
  Zustand, nie eine falsche Handlung); und die LEERE Liste wird gar nicht erst
  gesendet (sie ist keine Aussage, wie schon die leere `charge_points`).
- **Auf der Box: `applyChargePointRemovals`, NACH `applyChargePoints` und VOR
  dem Vorrang.** Sie entfernt nur, was diese Box wirklich KENNT (`csms.Remove`
  trennt die Verbindung, ein Wiederverbinden wird abgewiesen), protokolliert
  jede Rücknahme und ist idempotent — ein Grabstein, der in jedem Dokument
  wieder mitreist, darf nicht bei jedem Takt etwas tun. **⚠ Bei einem
  WIDERSPRUCH gewinnt die Rücknahme:** steht eine Kennung in beiden Listen,
  wird sie aus `charge_points` GESTRICHEN, bevor irgendetwas zugelassen wird —
  ein Dokument, das eine gerade gelöschte Kennung wieder einträgt, darf sie
  nicht durch die Hintertür zurückbringen.
- **In der Cloud ist es ein SOFT-Delete** (`site_charge_point_allowlist.removed_at`
  /`removed_by`, Migration `V20260837000000` — reines `ADD COLUMN`, **kein neues
  Recht**: die Rücknahme ist ein UPDATE, und das hatte die App-Rolle längst).
  Die Zeile BLEIBT stehen, weil der Grabstein dauerhaft geführt werden muss;
  `allowlist()` filtert `removed_at IS NULL`, `removedChargePointIds()` liefert
  die Gegenmenge (neueste zuerst, gedeckelt auf `MAX_REMOVED` = 64 wie der
  Kontrakt). **⚠ Gekappt wird die ÄLTESTE Rücknahme** — eine, die so lange her
  ist, hat jede lebende Box längst gesehen.
- **⚠ Ein erneutes Eintragen BELEBT die Zeile wieder** (`removed_at = NULL` im
  Upsert): eine Kennung steht deshalb nie in beiden Listen, und der Weg zurück
  braucht keinen Sonderfall. `POST` bleibt der Weg hinein, `DELETE
  /api/v1/sites/{siteId}/charging-config/charge-points/{chargePointId}` der
  Weg hinaus (RLS-gefenced wie jede `/sites/**`-Route; eine Kennung, die diese
  Anlage nicht (mehr) führt, ist ein **404** — nie ein stiller Erfolg über
  etwas, das es nicht gab).
- **Unclaim räumt weiterhin nur den retained Slot** — die Zeilen sterben am
  FK-Cascade, und ein DELETE von der falschen Verbindung aus wäre die
  dokumentierte Selbst-Blockade der Steuerungs-Freigabe.
- **⚠ Wirkung erst mit dem NÄCHSTEN Edge-Release:** eine laufende Box behält ihr
  Image, kennt das Feld also noch nicht und lässt die Säule zu (Regel 2 oben).
  Die Portal-Fläche sagt das auch (`ENTFERNEN_HINWEIS`: „sobald Ihre Box das
  nächste Mal verbunden ist. Bis dahin gilt, was sie zuletzt übernommen hat.").
- **⚠ Die Folgenliste sagt die WAHRHEIT, nicht das Naheliegende:** ein laufender
  Ladevorgang endet dadurch NICHT. OCPP kennt seinen eigenen Totmann, das
  Sicherheitsprofil liegt IN der Säule, und sie lädt damit weiter — langsam,
  aber sie lädt. Der `:8484`-Text und die Portal-Folgenliste sagen deshalb
  dasselbe; „der Ladevorgang endet" wäre eine Falschaussage über eine
  Kundenanlage.
- **Bekannte Grenze, unverändert:** die Box bleibt auf `:8484` editierbar, es
  gilt last-writer-wins, und ein retained Dokument setzt sich beim nächsten
  Verbindungsaufbau wieder durch. **Der Grabstein macht die Portal-Seite dabei
  zur stabileren:** eine dort entfernte Kennung kommt nicht zurück, weil sie in
  jedem folgenden Dokument als entfernt genannt wird.
- **Beweise:** Go `internal/chargingcfg` (+3, inkl. der neuen Fixture PER PFAD)
  + `agent/charging_config_test.go` (+3: ausdrückliche Rücknahme + wiederholter
  Grabstein als No-op, Widerspruch lässt NIE zu, eine Box ohne OCPP überlebt es)
  · api `ChargingConfigPublisherTest` (+3: die Draht-Form, die leere wird
  weggelassen, die Kontrakt-Fixture) +
  `ChargerApiTest.anAdmittedChargePointIsWithdrawnAsATombstoneAndReAdmittingRevivesIt`
  (echtes EMQX + DB + Keycloak) · Portal `ladesaeuleAnbinden.test.ts` (+4) +
  `LadesaeuleAnbinden.test.tsx` (+2).

