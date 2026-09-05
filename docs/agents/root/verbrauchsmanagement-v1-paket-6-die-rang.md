# Verbrauchsmanagement v1 — Paket 6: die RANGLISTE erreicht die Box

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 114).


P4 hat die Reihenfolge gebaut und auf vier bestehende Felder projiziert; was
fehlte, war die Position der SÄULEN und die des SPEICHERS („wer zwischen ihnen
zuerst darf, bleibt die Vorrang-Wahl" — P4-Doku). P6 trägt genau diese zwei
Zahlen zur Box und lässt die go-e-Wallbox dem Ladepark-Rahmen beitreten.
**Alles ist ADDITIV: ohne einen einzigen Rang verteilt die Box byte-identisch
wie vor P6**, und das ist auf beiden Seiten als Test festgenagelt.

- **⚠ ES IST EINE MENGE, ZWEIMAL GELESEN, NIE ZWEI TÖPFE.** `storage_rank` steht
  NEBEN `storage_priority`, nicht an ihrer Stelle: eine Säule mit
  `rank < storage_rank` greift in den GANZEN gemessenen Überschuss, eine
  darunter nur in das, was der Speicher übrig lässt. Fehlt eine der beiden
  Zahlen, entscheidet weiter allein die anlagenweite Wahl.
- **⚠ GLEICHE ZAHLEN SIND GLEICHRANGIG.** Die Fläche zeigt die Säulen EINER
  Seite als EINE Zeile (`RanglisteProjektion.gruppe`), der Kunde hat zwischen
  ihnen also gar keine Reihenfolge gewählt — verschiedene Zahlen behaupteten
  eine, und die Box hörte auf, zwischen ihnen abzuwechseln. `RanglisteAbleitung`
  gibt deshalb allen Säulen einer Seite die Position der ERSTEN von ihnen; die
  Gruppe belegt trotzdem so viele Plätze, wie sie Geräte hat (die P4-Regel „die
  Positionen zählen GERÄTE, nicht Zeilen").
- **⚠ Eine EIGENE Tabelle `site_charge_point_rank`** (Migration
  `V20260865000000`, RLS + FORCE wie alles auf diesem Pfad): die Allowlist ist
  die ZULASSUNG, die Rangliste die Reihenfolge — dort eine Zeile anzulegen, weil
  jemand sortiert hat, wäre eine Zulassung als Nebenwirkung.
  `site_charge_point_priority` scheidet aus dem gespiegelten Grund aus (dort IST
  die Anwesenheit der Zeile die Vorrang-Aussage, und eine Säule UNTER dem
  Speicher hat keinen Vorrang, braucht aber eine Position).
- **⚠ Der Rang wird GESPEICHERT, auch für eine Säule, die nicht zugelassen ist**
  — die Reihenfolge gehört dem Kunden, und ob sie eine Säule ERREICHT,
  entscheidet erst der Publisher (er iteriert `chargePoints`, also die
  Allowlist). Deshalb liest der Änderungs-Vergleich in `RanglisteService` die
  GESPEICHERTEN Ränge (`ChargingConfigRepository.chargePointRanks`) und nicht
  die der zugelassenen Säulen: über die Allowlist gemessen sähe eine Anlage ohne
  Portal-Zulassung ihre Ränge nie als „geändert" und speicherte sie nie.
  Mutationsgeprüft (`VerbraucherApiTest`).
  **Bekannte Grenze:** eine Säule, die nur an der Box eingetragen ist, bekommt
  ihren Rang erst, wenn sie über das Portal zugelassen wird; bis dahin ordnet
  die Vorrang-MENGE sie relativ zum Speicher (unverändertes P4-Verhalten).
- **`ChargingConfigService.saveRangliste` ist der EINE Schreibweg der
  Rangliste** — Vorrang, Speicher-Frage und die zwei P6-Zahlen in EINEM Vorgang
  mit GENAU EINEM Push (das retained Dokument wird als Ganzes ersetzt, zwei
  Aufrufe wären zwei Rundläufe für denselben Zustand). Er ist bewusst von
  `save` getrennt: dort pflegt ein KUNDE einzelne Felder, hier schreibt die
  Rangliste eine zusammenhängende Reihenfolge zurück.
- **Die WALLBOX (`wallboxes[]`) tritt dem Ladepark-Rahmen als virtuelle Sitzung
  bei:** die Box zählt ihre gemessene Leistung ins Budget zurück und deckelt sie
  über den Verbraucher-Sollwert, nie über OCPP. Die Cloud liest sie aus den
  `wallbox`-Komponenten mit `consumer_profile` (Nennleistung, Mindestleistung
  und der Rang, den P4/P6 ohnehin schreibt) — **gefiltert NUR über den Typ**: ob
  eine Wallbox wirklich teilnimmt (Messung ∧ Kommando), entscheidet die BOX, und
  die Cloud hat dafür keine Grundlage. **⚠ Eine LEERE Liste ist hier — anders
  als bei der Allowlist — die Aussage „keine nimmt teil"**, sonst könnte eine
  entfernte Wallbox nie wieder aus dem Rahmen fallen. Die Cloud emittiert
  bewusst KEINE `source` je Wallbox (der Kontrakt kennt das Feld; eine erfundene
  Quelle wäre eine Netzstrom-Freigabe, die niemand erteilt hat) — es gilt der
  Anlagen-Standard.
- **Wirkt SOFORT** (Deploy): das Speichern der Ränge, ihr Weg ins retained
  Dokument, die Wallbox-Liste. **Braucht das nächste EDGE-RELEASE:** dass die
  Box `rank`/`storage_rank`/`wallboxes[]` LIEST. Eine laufende Box überliest die
  Felder (`encoding/json` ohne `DisallowUnknownFields`) und verteilt weiter wie
  vor P6 — der Kompatibilitäts-Beweis ist beidseitig ein Test.
- **Beweise:** rein `RanglisteAbleitungTest` (+5, mutationsgeprüft) ·
  `ChargingConfigPublisherTest` (+4: die Kontrakt-Fixture bytegenau, ohne Rang
  reist nichts mit, eine 0 ist keine Position, die Wallbox samt leerer Liste) ·
  Testcontainers
  `VerbraucherApiTest.dieRaengeErreichenDieMaschineUndGleichrangigeSaeulenTeilenSichEINEZahl`
  · Edge `internal/lastmgmt/rangliste_test.go` (12),
  `internal/agent/ocpp_rangliste_test.go`, `internal/agent/ocpp_wallbox_test.go`
  (8) · Rig `edge-app/test/e2e-ocpp.sh` **L15a–c** (Docker-frei, an den
  Ladeprofilen gemessen: zwei geranktete Säulen bei knapper Leistung + die
  Gegenprobe der Gleichrangigkeit · dieselbe Sonne, andere Position zum Speicher
  · die Wallbox nimmt 11 kW aus dem Budget, ohne Eintrag ist sie bloße
  Gebäudelast). Edge-Details: `edge-app/CLAUDE.md`.

