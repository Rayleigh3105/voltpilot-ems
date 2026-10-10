# UEMS-Teilansicht serverseitig: Summen über die sichtbaren Standorte und `teilansicht` (AP-03 IP-10)

Neu angelegt am 16.09.2026. Spezifikation: AP-03 §6.2 Punkt 6, §4.5 Regel R-A2, §8 IP-10, Entscheid E10,
Fälle A1, A2. Code: `repo/OverviewRepository.storageTotals` (Zaun-Fix), `zugriff/TeilansichtDienst`,
`zugriff/Geltungsbereich.requireStandort`, `web/dto/TeilansichtDto`, `web/OverviewController`,
`web/EarningsController`, `web/StandortController`, `uems/StandortLesemodell.StandorteAmStichtag`.
Beweis: `TeilansichtApiTest` (A1, A2, Reichweite je Route, „kein Feld trägt die Gesamtsumme“, Bestand W11),
`TeilansichtSchnittstelleVertragTest` (openapi ↔ Java, die benannte Lücke).

## Was gilt

- **Die Durchsetzung liegt in RLS und in den Repositories, nie im Portal.** `site_scope` (IP-5) schneidet schon
  jede Liste, die über `site`, `device` oder `standort` läuft. Das Portal rechnet nur noch über das, was es
  bekommt (R-A2).
- **Eine Summe über eine UNGEZÄUNTE Tabelle muss selbst über `site` gehen.** `asset`,
  `telemetry_rollup_15m`, `schedule`, `flow_definition`, `site_charging_config` tragen nur die
  Mandanten-Policy. Für eine Abfrage JE ANLAGE ist das harmlos — der Controller liest daraus nur die
  Einträge der sichtbaren Anlagen. Für eine Σ über alle Zeilen ist es ein Leck.
- **Das war der eine echte Befund:** `OverviewRepository.storageTotals` las `FROM asset` ohne `JOIN site`.
  Ein Bearbeiter EINES Standorts bekam die Speicher-Summe ALLER Standorte seines Unternehmens und konnte die
  fremde Kapazität als Differenz ableiten. Gemessen: Peter (nur ST-2) sah 210 600 statt 9 100, Claudia
  (2 von 3) 210 600 statt 174 400. Jetzt mit `JOIN site`.
- **`teilansicht {sichtbar, gesamt}`** ist additiv an `/overview`, `/earnings` und `/standorte`.
  `gesamt` ist eine ANZAHL VON STANDORTEN — keine Energie- und keine Geldsumme; es ist die einzige Zahl
  dieser Antworten, die über die sichtbare Menge hinausweist, und bewusst nur eine Kardinalzahl.
  Gezählt wird ohne archivierte Standorte, genau wie in der Selbstauskunft — sonst widersprächen sich
  Kopfzeile („Teilansicht: n von m Standorten“, aus `/me`) und Antwort.
- **`TeilansichtDienst` hebt den Zaun für `gesamt` auf** (`Geltungsbereich.ganzenKundenbereichLesen`) und
  hält die Aufhebung in einer EIGENEN Transaktion (`PROPAGATION_REQUIRES_NEW`), damit das
  `set_config(…, true)` mit ihr endet. Er ist neben der Selbstauskunft der zweite und letzte Aufrufer;
  `SiteScopeArchitekturTest` hält die Liste.
- **`/earnings` nimmt eine Standort-MENGE** (`?standort=…&standort=…`, wiederholbar) statt „eine oder alle“.
  Ohne sie antwortet die Route über alle sichtbaren Anlagen — zeichengleich zu vorher. Mit ihr über die
  Anlagen, die HEUTE an einem der Standorte hängen (`StandortLesemodell.bezugJeAnlage`). Ein Standort
  außerhalb des Zugriffs ist 404, nie 403 (A14). `vergleich` summiert seither über die Zeilen der Antwort,
  nicht über alles, was `EarningsRepository.aggregate` zurückgibt.
- **Bestand (W11):** ein unternehmensweiter Zugriff antwortet zeichengleich zu vorher, bis auf das additive
  Feld; dann ist `sichtbar == gesamt`. Ein Kundenbereich ohne Standorte antwortet `{0, 0}`.

## Fallen

- ⚠ **`/sites`, `/devices` und `/edge-versions` tragen `teilansicht` NICHT.** Sie antworten mit einer nackten
  Liste; ein Umschlag `{eintraege, teilansicht}` wäre ein Bruch des Vertrags an drei Kernrouten. Benannte
  Abweichung von der Abnahmezeile „in allen sechs Antworten belegt“ (firstmate 16.09.2026, Option C),
  **einzulösen mit AP-03 IP-12**, wo `api.ts` und die Kundenflächen ohnehin umgestellt werden. Ihre
  REICHWEITE ist schon heute richtig — der Zaun schneidet sie. `TeilansichtSchnittstelleVertragTest` nagelt
  fest, dass die Form eine Liste geblieben ist und der Vertrag die Adresse nennt.
- ⚠ **Ein Test, der eine Antwort dieser Routen zeichenweise vergleicht, muss `teilansicht` ausblenden, wenn
  sich zwischen den beiden Ständen die Zahl der Standorte ändert.** Genau das passiert in
  `BestandsuebernahmeApiTest`: die Übernahme legt die Standorte ja an, die das Feld zählt. Dort blendet
  `ohneStandort` es mit aus und prüft den neuen Wert daneben positiv.
- ⚠ **Die §8-Zelle nennt sechs Routen, als liefen sie alle am Zaun vorbei.** Gemessen war es genau eine
  Zahl. Wer hier weiterbaut, sucht die Aggregationen selbst (`rg` auf die Tabelle), statt der Zelle zu
  glauben.
- ⚠ **`teilansicht.sichtbar` beschreibt die Menge DIESER Antwort**, nicht immer die sichtbare Menge: mit
  einer gewählten Standort-Menge an `/earnings` ist es deren Anzahl.
