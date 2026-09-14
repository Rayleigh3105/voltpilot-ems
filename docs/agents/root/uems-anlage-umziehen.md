# UEMS-Anlage zuordnen/umziehen: „gültig ab“, Folgen-Vorschau, kein Regelkreis ändert sich (AP-02 IP-11)

Neu am 14.09.2026 (AP-02 IP-11, Mockups T6/T6b, Abnahmefall A11). **Keine Migration.** Eine Zuordnung ist
eine Aussage über Zugehörigkeit, kein Eingriff in den Betrieb: geschrieben werden NUR `anlage_standort`
(die laufende endet am Vortag, die neue erbt ihr Ende) und `ort_aenderung`.

| Teil | Datei |
|---|---|
| Routen `GET /api/v1/sites/{id}/standort/vorschau`, `PUT /api/v1/sites/{id}/standort` | `web/AnlageStandortController` (im `OrtAbgelehntHandler`), `web/dto/AnlageUmzugDto` |
| Urteil + Eintrag (EIN `planen` für beide) | `uems/AnlageUmzugService` → `OrtsbaumAbleitung.eintrag` (Vorgang VERSCHIEBEN, AUFGERUFEN) |
| Neue Ablehnungs-Codes | `OrtAbgelehnt`: `vor_dem_ersten_intervall` 422, `objekt_archiviert` 409, `gleicher_tag` 409, `ziel_ist_bisheriger_eltern` 400 |
| Sätze im Änderungsprotokoll | `AenderungSatz.verschoben`; Begründung = `neu.begruendung`, im Lesemodell `grund` (Orts-Zweig) |
| Portal (rein) | `frontend/portal/src/anlageUmziehen.ts` · `anlageUmziehen.test.ts` |
| Dialog T6b + Einstieg an der Zeile „Standort“ | `components/AnlageStandortDialog.tsx` (+ `.css`, `.test.tsx`) · `components/AnlageStandortZeile.tsx` |
| 375/1440 px + Bilder | `e2e/anlage-umziehen.spec.ts` (Bühne `meine-anlage.html`); `UMZUG_BILDER=<Ordner>`, `ANSICHT_VARIANTE=b` |
| Vertrag | `docs/contracts/openapi.yaml` (`AnlageUmzug*`, `OrtFehler`), geprüft in `OrtSchnittstelleVertragTest` |
| Übersicht nach dem Umzug (AP-01 IP-6) | `frontend/portal/src/uebersichtNachUmzug.test.ts` gegen `uebersicht.ts` (`standortGruppen`, `kopfzeile`) |

## Die Fallen

1. **Die Kernzusage ist ein Test, keine Prosa.** `AnlageUmzugApiTest` mockt JEDEN MQTT-Sender der Anwendung
   (`jederMqttSenderIstGezaehlt`: Paho-Import UND `.publish(` im Quelltext = Sender, der Kontext muss genau
   diesen Mock tragen) und zählt nach dem Eintrag 0 Aufrufe; dazu die GANZE Datenbank vorher/nachher
   (`Bestandsschutz.fingerabdruck` ohne `anlage_standort`/`ort_aenderung`). Hängt jemand an den Umzug etwas,
   das sendet oder eine andere Tabelle schreibt, bricht der Test — zu Recht. Ein neuer MQTT-Sender gehört in
   die Mock-Liste, sonst fällt die Wache.
2. **Vorschau = Wirkung:** `vorschau` und `umziehen` teilen `planen` (dieselbe Regel, dieselben Fakten, dieselbe
   Form); der Eintrag liest die Zuordnungen danach frisch. Die Folgen-Karte im Portal urteilt nichts — sie setzt
   nur Sätze. Die Vorschau lehnt mit Status, Code und Satz ab wie der Eintrag.
3. **Drei Protokolleinträge statt einem** — bewusst gegen „ein Eintrag je Schreibvorgang“: an der Anlage
   („Standort zugeordnet: Werk Ahrenberg Nord (ST-3)“), am neuen Standort („Anlage zugeordnet: …“, `richtung`
   hinzu) und am bisherigen („Anlage zieht um: … → …“, `richtung` hinaus). Die IP-9-Einträge an der Anlage
   lesen seitdem ebenfalls „Standort zugeordnet: …“ statt „Anlage verschoben“.
4. **`bleibt` ist Code, nicht Prosa, und nennt nur, was es gibt:** `box` nur mit eingebauter Box
   (`device.ausgebaut_am IS NULL`), `ladepark_rahmen` nur mit `site_charging_config` oder
   `site_charge_point_allowlist`; `netzanschluss` am „gültig ab“ aus dem Standort-Lesemodell; `steuern` = die
   laufende Teilnahme und der Standort IHRER Funktion; `befehle` ist immer 0. Die Reihenfolge von
   `AnlageUmzugService.BLEIBT` ist die der OpenAPI und von `BLEIBT_SATZ` (TS).
5. **⚠ Befund Funktionen (offen, AP-01):** `funktion_teilnahme` hängt über `funktion_id` an der Funktion des
   ALTEN Standorts, und der Umzug hängt sie bewusst nicht um (kein Regelkreis). `FunktionService.standortBlock`
   zählt je Standort „heute zugeordnet“ ∪ „Teilnahme an seiner Funktion“ — ab „gültig ab“ steht die Anlage in
   `GET /api/v1/funktionen` darum unter BEIDEN Standorten. Der A11-Satz „zeigt die Teilnahme unter Werk
   Ahrenberg Nord“ ist damit NICHT erfüllt; die Folgen-Karte sagt ehrlich „geführt wird sie weiter bei …“.
   Die Unternehmens-Übersicht (AP-01 IP-6) gruppiert nach `GET /standorte` von heute und zählt „steuert“ über
   die MENGE der aktiven Teilnahmen: nach dem Umzug steht jede Anlage genau einmal beim neuen Standort, „steuert“
   zieht mit, die Kopfzeile zählt nicht doppelt — aber die Zeile „Steuern & Optimieren“ des NEUEN Standorts
   sagt „Noch nicht eingerichtet“, während seine Gruppe „1 steuert“ zählt (`uebersichtNachUmzug.test.ts`).
6. **Keine Korrektur:** `gleicher_tag` sagt „Ändern Sie diese, statt eine zweite anzulegen“ — der Vertrag kennt
   `vorgang: korrektur`, die Route noch nicht. Ausweg heute: ein anderes Datum.
7. **Zeile „Standort“:** der Knopf „Anderem Standort zuordnen“ steht nur, wenn es ein Objekt gibt (ohne Objekt
   bleibt „Meine Anlage“ byte-identisch, IP-8-Snapshots). Endet die heutige Zuordnung, liest die Zeile
   `GET /standorte?stichtag=<Ende+1>` und sagt „bis 28.02.2027 · ab 01.03.2027: Werk Ahrenberg Nord (ST-3)“ —
   ohne Ende kein zweiter Aufruf.
8. **Rechte:** `anlage.zuordnen`, mit „gültig ab“ vor heute zusätzlich `aenderung.rueckwirkend` — Kommentar,
   keine Durchsetzung (AP-03).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='AnlageUmzugApiTest,OrtSchnittstelleVertragTest,AenderungSatzTest,RechteKennungenDerRoutenTest')
(cd frontend/portal && npx vitest run src/anlageUmziehen.test.ts src/components/AnlageStandortDialog.test.tsx src/pages/AnlageTechnik.standort.test.tsx src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/anlage-umziehen.spec.ts --project=desktop-chromium)
```
