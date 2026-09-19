# UEMS-Ruhe bis zum Start: die Anlage ruht OHNE Enddatum (AP-01 IP-4, Regel R0)

Neu angelegt am 14.09.2026 (AP-01 IP-4, Entscheid E7 = A). Eine Anlage, die zur Funktion
„Steuern & Optimieren" gehört, aber nicht gestartet ist (oder angehalten wurde), ruht im
heutigen Pause-Zustand der Box — **ohne** Enddatum statt mit einem erfundenen fernen Zeitpunkt.
Sie ist die Zeile `device_override` mit `kind = pause` und `herkunft = 'funktion'`.

- **Vertrag:** [`docs/contracts/v2/override-vectors.json`](../../contracts/v2/override-vectors.json)
  — Blöcke `zeilen` (was die Tabelle annimmt), `push` (was der Publisher sendet), `box` / `box_alt`
  (was eine neue bzw. ältere Box daraus macht), `erneuerung`. Registry-Push-Felder im Schema
  `edge-entity.schema.json` `$defs/registry_push` (dort fehlte auch `automation_paused_until`).
- **Zwillinge gegen dieselbe Datei:** Java `uems/RuheRegel` (`RuheRegelVectorsTest`, der echte Push
  in `EntityRegistryRuhePushTest`, die CHECKs in `UemsRuheBisZumStartMigrationTest`) ⟷ Go
  `entities.Registry.Paused` (`internal/entities/ruhe_vectors_test.go`), Agent-Beweis
  `internal/agent/ruhe_bis_zum_start_test.go`.
- **Migration `V20260914193000`: eine Lockerung, kein Umbau.** `herkunft` nullbar (Bestand leer =
  Handeingriff), `ends_at` ohne NOT NULL, drei CHECKs in Namensreihenfolge: `…_ende_chk` (Ende
  Pflicht außer für die Ruhe) → `…_funktion_ohne_ende_chk` (die Ruhe hat NIE ein Ende — eine Pause
  mit Ende ist nach `funktion-zustand` ein Handeingriff) → `…_herkunft_chk` (nur „funktion", nur
  `pause`). Postgres meldet den ersten Verstoß in dieser Ordnung; die reine Regel prüft genauso,
  zwei Vektoren mit Doppelverstoß pinnen das.
- **⚠ Draht: ein NEUES Feld, das alte bleibt.** Die Ruhe sendet `automation_paused_until_revoked:
  true` UND `automation_paused_until` = Push-Zeit + 4 h. Die neue Box ruht bis auf Widerruf (keine Uhr
  und kein abgelaufenes Ende hebt sie auf, nur ein Push OHNE das Feld; der Stand überlebt den
  Neustart im gespeicherten Registry). Eine ältere Box überliest das Feld und ruht bis zum rollierenden
  Ende; `DeviceOverrideRenewalRunner` pusht die Registry nach 3 h erneut (B6-Zahlen: D-5-Kappe 4 h,
  Erneuerung 3 h, Takt 10 min). Fällt die Cloud länger als 4 h aus, läuft die ältere Box wieder —
  dort trägt R1 (vor dem Start ist nichts „an") die Sicherung allein, wie heute.
- **⚠ Ein Tor für alle drei Pausen-Hälften:** Fahrplan-Ausführer (`runPlanExecutors`), Arbiter
  (`Suspended`) und der v1-Pfad `applySetpoint` fragen alle `Registry.Paused` — `plan` selbst ist
  unverändert. Die Guard-Kette, § 14a, Abregelung, Einspeise-Wache und jeder Wunsch über `market`
  laufen weiter (Agent-Test: SoC-Fenster klemmt den Eigenverbrauch, `grid` hält).
- **⚠ Kein Handweg hebt die Ruhe auf:** `putPause` schreibt nichts, `clearPause` löscht nur Zeilen ohne
  Herkunft; `DeviceOverrideService` antwortet dann **409** „Diese Anlage ist in Ruhe, bis ihre
  Steuerung gestartet wird." ohne Audit-Zeile. `GET /interventions` zeigt die Ruhe NICHT (sie ist kein
  Handeingriff; die Steuerungsseite zeigt sie mit IP-11). Die Ablauf-Filter (`ends_at > now()`,
  `purgeExpired`, `dueForRenewal`) überspringen sie per Konstruktion; `active`/`activePause` lesen sie.
- **Schreibweg für IP-3:** `DeviceOverrideRepository.putRuhe` (macht aus einer Handpause die Ruhe,
  eine bestehende Ruhe bleibt unverändert; `renewed_at` leer → der nächste Takt pusht) und
  `clearRuhe` (lässt eine Handpause stehen). Seit IP-3 ruft `FunktionService` an: Anhalten und Beenden
  setzen die Ruhe, Starten und Fortsetzen heben sie auf (`uems-funktionen-routen.md`).
- **X7-Satz auf der Kundenfläche:** `GET /api/v1/funktionen` liefert je Teilnahme lesend
  `ruhe_hinweis.jetzt` und `ruhe_hinweis.beim_anhalten`. `RuheHinweisRegel` entscheidet allein aus
  Ruhe/Anhalten und der Fähigkeit `automation_paused_until_revoked` der führenden Box — genau dem
  Zustellziel des Registry-Pushs; eine andere Box der Anlage zählt nicht. Fehlende Meldung ist
  unbekannt und beweist die Fähigkeit nicht. Das Portal zeigt wörtlich: „Diese Box hält die Ruhe nur,
  solange sie mit VoltPilot verbunden ist.“ Eine aktive Bestandsanlage sieht ihn nicht, weil die
  Übernahme keine Ruhe anlegt; beim späteren bewussten Anhalten steht er im Bestätigungsweg.
- **Wirkt an einer echten Box erst mit einem Edge-Release.** `RUNTIME_VERSION` (Katalog-Laufzeitstand)
  ist unberührt, `schema_version` des Pushs bleibt `1.0`.
