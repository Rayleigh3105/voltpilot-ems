# Geräteseiten Stufe 1: die ABREGELUNG sagt, an WEN sie geht (`per_unit`)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 145).


Scout `data/vp-geraeteseite-rev-b8` R4a + Captain-Entscheid **E2** (Abnahme
21.08.2026). Bis hierher konnte die Cloud die Abregelung nur ZÄHLEN („0 von 2
Wechselrichtern freigegeben"); WELCHE Einheit freigegeben ist, welche Kappe sie
hält und ob ihr Rücklesen bestätigt hat, war nirgends. Deshalb musste jede
Fläche „an alle freigegebenen Wechselrichter" sagen, und eine PV-Geräteseite
konnte ihre EIGENE Abregelung gar nicht zeigen.

- **⚠ E2 hat die Cloud-Heuristik ausdrücklich VERWORFEN** („alle PV-Geräte mit
  SunSpec-Steuerpfad gelten als Ziel"): nur die BOX weiß, welche Einheit sie
  beschrieben und was sie zurückgelesen hat — eine Ableitung wäre genau die
  erfundene Zuordnung, gegen die `ANLAGENWEITE_BEFEHLE` gebaut ist. Die Box
  meldet die Liste deshalb additiv, die Cloud reicht sie DURCH.
- **⚠ Der Schlüssel heißt `per_unit`, NICHT `units`** — `units` ist die ZAHL und
  liegt seit dem Bau des Blocks auf dem Draht; sie umzubenennen bräche jeden
  ausgelieferten Leser für einen rein kosmetischen Gewinn.
- **⚠ Die Liste kann KÜRZER sein als `units`.** Eine Einheit ohne `source_id`
  trägt keinen Join-Schlüssel auf die gemeldeten Quellen — sie wird auf BEIDEN
  Seiten verworfen, statt sie niemandem zuzuordnen. **`units` bleibt DIE Zahl;
  nie aus der Länge der Liste ableiten.**
- **⚠ Die Freigabe kommt aus dem KERN der Box, nie aus dem `certified`-Stempel
  des Rücklesens** (`granted[u.UnitKey]` aus derselben Karte, aus der auch
  `certified_units` gezählt wird) — die Trennung, die der `control`-Block auf
  die harte Tour gelernt hat: ein Rücklese-Stempel ist eine Layer-1-Beobachtung,
  nie eine Tor-Autorität. So können Liste und Zähler daneben nicht auseinanderlaufen.
- **Bewusst MINIMAL: vier Felder.** Label, Register und Durchsetzungs-Urteil
  bleiben LOKAL (die `:8484`-Karte) — die Cloud benennt ein Gerät über ihren
  EINEN Namensbildner aus den gemeldeten Quellen, und ein Name über den Draht
  wäre eine zweite Namens-Wahrheit. `applied_cap_kw` steht unter GENAU der
  Bedingung, unter der auch das Aggregat `Active`/`AppliedCapKw` bildet; `match`
  ist dreiwertig (nil = nur beobachtet, nichts befohlen).
- **Speicher: `device_curtailment_unit`** (Migration `V20260833000000`, RLS +
  FORCE wie `device_curtailment_status`), PK `(device_id, source_id)`, **je
  Herzschlag GANZ ersetzt** (das `device_source_status`-Muster — eine
  verschwundene Einheit darf nicht als Geist stehen bleiben). **Sie trägt
  bewusst KEIN eigenes `checked_at`:** die Liste reist IM `curtailment`-Block
  und altert an dessen Anker — ein zweiter Frische-Stempel für dieselbe
  Beobachtung wäre eine zweite Antwort auf dieselbe Frage.
- **`CurtailmentStatusDto.perUnit` ist DREIWERTIG:** `null` = auf diesem Pfad
  nicht geladen (das Flotten-Aggregat teilt sich `COLUMNS`/`map` und rendert
  keine Einheiten-Liste), `[]` = die Box hat keine gemeldet (ältere Edge), sonst
  die Liste. Der 11-stellige Konstruktor bleibt als Bequemlichkeit, damit kein
  Aufrufer eine 12-Argument-Kopie pflegen muss.
- **Portal:** die reine `curtailment.abregelZiel(status, nameOf)` ist die EINE
  Ableitung des Ziel-Satzes — sie nennt die freigegebenen Einheiten beim NAMEN,
  fällt ohne Liste auf „an alle freigegebenen Wechselrichter (N von M)" zurück
  und **benennt NIEMANDEN halb** (ein unauflösbarer Name lässt den ganzen Satz
  auf die Zahl zurückfallen — eine Liste, die zwei von drei nennt, liest sich
  als Vollständigkeit). Ohne Freigabe wird kein Ziel behauptet, sondern der
  Grund gesagt. Gerendert als Zeile „Abregelung" in „Schutz & Grenzen" der
  BOX-Seite — dort, wo die anlagenweiten Befehle seit der Attribution wohnen.
- **Beweise:** Go `agent/curtail_test.go` (die Liste aus derselben Quelle wie
  die Aggregate, Einzelkappen == Aggregat-Kappe, Freigabe aus dem KERN, ein
  Release ohne Kappe/Urteil samt Draht-Prüfung, ohne Join-Schlüssel keine
  Zeile) · api `CurtailmentStatusListenerTest` (+5: Feld für Feld, verworfener
  Schlüssel, Duplikat, unplausible Kappe, ältere Edge ⇒ leerer Satz) ·
  Testcontainers `PortalApiTest.theCurtailmentUnitsAreIngestedPerHeartbeatAndReplacedWholesale`
  · portal `curtailment.test.ts` (+7) + `boxSeite.test.ts` (+3).
- **Ops:** keine neue Pflicht-Variable — die Liste reitet auf dem schon
  gesetzten `VOLTPILOT_CURTAILMENT_MQTT_LISTENER_ENABLED`. **Sie wirkt erst mit
  dem nächsten Edge-Release;** bis dahin bleibt der ehrliche Sammel-Satz.

