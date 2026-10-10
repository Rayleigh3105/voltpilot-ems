# UEMS-Gebäude/Bereich verschieben: „gültig ab“, Folgen-Vorschau, nichts Elektrisches zieht mit (AP-02 IP-12)

Neu am 15.09.2026 (AP-02 IP-12, Mockups V1–V4, Abnahmefall A13). **Keine Migration.** Verschieben ist eine
Aussage über den ORT: geschrieben werden NUR `ort_zuordnung` (die laufende endet am Vortag, die neue erbt ihr
Ende) und GENAU EIN `ort_aenderung`-Eintrag am Ort.

| Teil | Datei |
|---|---|
| Routen `GET /api/v1/orte/{id}/verschieben/vorschau`, `POST /api/v1/orte/{id}/verschieben` | `web/OrtController` (im `OrtAbgelehntHandler`), `web/dto/OrtVerschiebungDto` |
| Urteil + Eintrag (EIN `planen` für beide) | `uems/OrtVerschiebenService` → `OrtsbaumAbleitung.eintrag` + `verschiebenFolgen` + `OrtService.nameFrei` (AUFGERUFEN) |
| Ziele je Knoten (Menü V1, Zielliste V2) | `uems/OrtAktionen.verschieben` → additiv `aktionen.verschieben {erlaubt, text, ziele}` an `GET …/orte` |
| Abzeichen „ab 01.03.2027 → Werk Ahrenberg Nord“ (V4) | additiv `danach` an Gebäude/Bereich in `uems/OrtsbaumLesemodell` |
| Satz im Protokoll | `AenderungSatz.verschoben`: „Gebäude verschoben: Werk Ahrenberg → Werk Ahrenberg Nord (ST-3)“ aus `eltern_name`/`eltern_kurzzeichen` |
| Portal (rein) | `frontend/portal/src/ortVerschieben.ts` · `ortVerschieben.test.ts` |
| Dialog V2–V4, Zeitstrahl-Baustein, Menü | `components/VerschiebenDialog.tsx` (+ `.css`, `.test.tsx`) · `components/Zeitstrahl.tsx` (+ `.css`, `.test.tsx`) · `ortArchiv.menueEintraege` · `components/Ortsbaum.tsx` |
| 375/1440 px + Bilder | `e2e/ort-verschieben.spec.ts` (Bühne `standorte.html`, Antworten `src/test/ortVerschiebenFixtures.ts`); `ORT_VERSCHIEBEN_BILDER=<Ordner>`, `ANSICHT_VARIANTE=b` |
| Vertrag | `docs/contracts/openapi.yaml` (`OrtVerschiebung*`, `OrtVerschiebenAktion`, `OrtsbaumDanach`), geprüft in `OrtSchnittstelleVertragTest` |

## Die Fallen

1. **A13 ist ein Test, keine Prosa.** `OrtVerschiebenApiTest` baut Halle 2 mit MS-10 … MS-15 an den Orten der
   Referenz (MS-14 direkt am Standort), NA-2 und Box über die Schnittstelle und zählt JE DING an dem Weg, auf dem
   der Kunde es liest: drei Bereiche (Ortsbaum am 28.02./01.03.), fünf abgeleitete Messstellen
   (`…/messstellen/{id}/standort?am=`), Anlage (`/standorte?stichtag=`), NA-2 (`…/netzanschluesse`), MS-14.
   Dazu jeder MQTT-Sender als Mock (0 Aufrufe) und die ganze Datenbank ohne `ort_zuordnung`/`ort_aenderung`.
   Ein neuer Sender gehört in BEIDE Mock-Listen (hier und `AnlageUmzugApiTest`).
2. **Vorschau = Wirkung:** `vorschau` und `verschieben` teilen `planen` — auch die Namensregel (409
   `name_belegt` unter den neuen Geschwistern am ersten Tag und heute). Die Vorschau lehnt mit Status, Code,
   `feld` und Satz ab wie der Eintrag; die Karte urteilt nichts, sie setzt nur Sätze.
3. **„Bleibt“ ist das Urteil des Vertrags, nicht eine Liste aller Anlagen.** `verschiebenFolgen` nennt nur die
   Anlagen der WECHSELNDEN Messstellen (sofern nicht schon am Ziel), ihre Netzanschlüsse und ihre übrigen
   Messstellen. Die Anlage einer Messstelle ist die ihrer Stellung von HEUTE (`MessstelleOrtsbaumMessstellen`),
   nicht die am „gültig ab“. Ohne Messstelle im Teilbaum steht keine Anlage auf der Karte.
4. **Genau EIN Protokolleintrag am Ort** (Regel 14) — anders als der Anlagen-Umzug (drei). `alt`/`neu` tragen
   Elternknoten und Standort mit ID, Kurzzeichen und Namen; jsonb ordnet die Schlüssel selbst.
5. **Die Ziele im Menü sind die von HEUTE** (`standAm` + `ERLAUBTE_ELTERN`, ohne den bisherigen Elternknoten,
   nie ein Bereich; Standorte vor Gebäuden). Ist an einem anderen Tag ein anderer der bisherige, sagt es die
   Vorschau (400 `ziel_ist_bisheriger_eltern` am Feld „Ziel“). Ohne jedes Ziel: `verschieben_gesperrt` mit Satz.
6. **`danach` ist eine Lesung, kein Urteil:** die Zuordnung, die am Tag nach `gueltigBis` beginnt; hängt das
   Ziel an einem Gebäude, der Standort dieses Gebäudes an dem Tag. Ohne Ende oder ohne Anschluss `null`.
7. **Keine freigegebenen Berichte (AP-12 ist nicht gebaut):** die Karte nennt den Zeitraum, der nachträglich
   anders zählt (`rueckwirkendBetroffen`), nie „Revision“. Der A2-Satz „betrifft den freigegebenen Bericht …“
   kommt mit AP-12.
8. **Von Steuern ist keine Rede** (Captain 14.09.2026): „Nichts ändert sich an Anlagen, Netzanschlüssen und
   VoltPilot-Boxen — verschoben wird nur der Ort.“ `ortVerschieben.test.ts` wacht über Steuer/Betriebsmodell/Freigabe/Befehl.
9. **Menü:** Stift UND Menü (Variante A aus IP-15) bleiben; „Verschieben …“ steht vor „Archivieren“. „Änderungen“
   (H2) fehlt bis IP-14. Das Vergleichsbild B („Bearbeiten“ im Menü) entsteht nur im DOM der E2E-Bühne.
10. **Keine Korrektur:** gleicher Tag = 409 `gleicher_tag` wie IP-11.
11. **Nach einem Worktree-Wechsel** meldet Flyway „more than one migration with version …“ aus altem
    `target/classes` — `./mvnw clean test`, kein Code-Fehler.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='OrtAktionenVerschiebenTest,OrtSchnittstelleVertragTest,OrtsbaumLesemodellTest,AenderungSatzTest,RechteKennungenDerRoutenTest')
(cd services/api && ./mvnw test -Dtest=OrtVerschiebenApiTest)   # Testcontainers, ~45 s
(cd frontend/portal && npx vitest run src/ortVerschieben.test.ts src/components/VerschiebenDialog.test.tsx src/components/Zeitstrahl.test.tsx src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/ort-verschieben.spec.ts --project=desktop-chromium)
```
