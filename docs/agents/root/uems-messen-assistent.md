# UEMS-Fläche: Assistent „Messen & Auswerten" — Rahmen, Schritt 1 und 2 (AP-01 IP-9a), Schritte 3 bis 5 (IP-9b)

Neu am 15.09.2026 (AP-01 IP-9a, Konzept §5.2; Entscheide firstmate 001 = A Schreibweg, 002 = A Standort ohne
Anlage). Keine Migration. Ein kleiner Schreibweg, den IP-3 ausdrücklich hierher gelegt hat
(`uems-funktionen-routen.md`: „Messen hat noch keinen Schreibweg (IP-9a)").

Schritte 3–5 neu am 15.09.2026 (AP-01 IP-9b, Konzept §5.2): KEINE Route, keine Migration. Schritt 3 ruft die
Vorschlags-Routen aus AP-04 IP-16 (`uems-messstellen-vorschlagsliste-bestand.md`) und für Gebäude/Bereich
`PUT /api/v1/messstellen/{id}/ort`; Schritt 4 liest `GET /funktionen`, `/standorte`, das Register und `/devices`.

| Teil | Datei |
|---|---|
| Route `PUT /api/v1/standorte/{id}/funktionen/messen` `{"aktion":"einrichten"}` → 200 `{aktion, standort}`; 409 `bereits_angelegt`/`standort_archiviert`, 404 fremd, 400 sonst | `web/FunktionController`, `uems/FunktionService.messenStandort`, `uems/FunktionAbgelehnt` · `FunktionApiTest`, `FunktionSchnittstelleVertragTest` |
| Reine Regel: Schrittfolge, „Schritt n von 5", Entwurf im Browser, Start/Wiedereinstieg, Einstieg für die Karte, Sätze | `frontend/portal/src/messenAssistent.ts` · `messenAssistent.test.ts` |
| Fläche: Schale `AnlegenDialog`, Schritt 1 (`VpPicker` + `StandortDialog`), Schritt 2 (`AddDeviceDrawer`, `AnlegenFlow`) | `src/components/MessenAssistent.tsx` (+ `.css`, `.test.tsx`) |
| 375/1440 px + Bilder | `e2e/messen-assistent.spec.ts` auf der Bühne `messen-assistent.html/.tsx`; `MESSEN_ASSISTENT_BILDER=<Ordner>` |
| Fixture „Messen im Entwurf" (Satz aus `messen()`) | `src/test/funktionenFixtures.ts` `funktionMessenEntwurf` |
| Schritte 3–5 rein: Auswahl, Hauptzähler-Regel, Anfrage, Ort-Korrekturen, Prüfliste (`fehltArt` + Fakten), Fertig-Satz | `messenAssistent.ts` · `messenAssistentSchritte.test.ts` |
| Fläche Schritte 3–5 | `MessenAssistent.tsx` · `components/MessenAssistentSchritte.test.tsx`; Spec-Fall „Schritt 3 → 4 → 5" |
| Fixture WAGO C-1 / Halle 2 (GEBILDET von `vorschlagsliste` und `messen()`) | `src/test/messenAssistentFixtures.ts` |
| API: C-1 ergibt vier Messstellen, genau ein Hauptzähler je Anlage (Satz aus PR 788) | `MessstelleVorschlagApiTest` `wagoC1…`, `einBestehenderHauptzaehler…` |

## Die Fallen

1. **Der Server entscheidet vor dem Browser.** Kennt `GET /funktionen` „Messen & Auswerten" am Standort
   (≠ `kein_objekt`), ist Schritt 1 erledigt — der Entwurf im Browser (`vp.uems.messen-assistent.entwurf.v1`)
   merkt sich nur Standort und Schritt. Ein Entwurf zu einem Standort, den der Server nicht mehr nennt, wird
   verworfen (neu wählen). Speicherzugriffe werfen nie (gesperrter Speicher = Stand des Servers).
2. **Genau einmal:** Schritt 1 ruft `PUT …/messen` nur, wenn `mussEinrichten` (kein Objekt oder unbekannt);
   ein 409 `bereits_angelegt` ist KEIN Fehler, sondern „weiter" (`istBereitsAngelegt`). Die Sitzung merkt sich
   angelegte Standorte zusätzlich, falls `GET /funktionen` nicht lesbar war. Der Server legt nie eine zweite
   Zeile an (Vertrag `uebergangMessen` + `uq_funktion_je_standort`).
3. **`messen()` sagt ohne Funktion „kein Objekt" — auch am archivierten Standort.** Der Dienst gibt dem Übergang
   darum bei `archiviert_am` ausdrücklich `ARCHIVIERT` (sonst bekäme ein archivierter Standort eine Funktion).
4. **Nichts nachbauen.** Schale = `AnlegenDialog` (Rechner: benannte Leiste, Telefon: Zähler + Balken), Wahl =
   `standortWahl` aus `anlageStandort.ts` (filtert `bestand = vorhanden`, nicht archiviert). Unterabläufe
   (Standort-Dialog, „Gerät verbinden", Komponenten-Assistent) ERSETZEN die Schale, solange sie offen sind —
   NICHT stapeln: das Haus-`Modal` liegt mit seinem Schleier auf Ebene 60, der Anlege-Dialog auf 61, „Gerät
   hinzufügen" stand darum unsichtbar UNTER dem Assistenten (Playwright 1440 px). Zustand, Wahl und Schritt leben
   in `MessenAssistent`, nicht in der Schale; nach dem Schließen steht sie wieder da und liest nach.
5. **Steuern-Regel: der Anlage-Assistent (`AnlageFlow`) gehört NICHT hinein** — er fragt nach Netzladen,
   Einspeiseleistung, „PV & Speicher" und Betriebsmodell. Ohne Anlage am Standort nennt Schritt 2 den Zustand
   und WO die Anlage entsteht (`keineAnlageWeg`: genau eine Anlage → „Anlage hinzufügen" oben, sonst
   „Anlage anlegen" auf der Übersicht), ohne Knopf, dazu „Anderen Standort wählen" und „Später fortsetzen".
   Eine reine Messanlage ohne Steuer- und Geldwörter anzulegen ist ein eigenes Folgepaket.
6. **Schritte 3–5 sind eingehängt** (`GEBAUTE_SCHRITTE` = 1…5; eine Bühne kann mit `gebaut` weniger tragen, `vor`
   betritt nie einen ungebauten Schritt). Ohne Anlage am Standort bleibt Schritt 2 trotzdem bei „Später fortsetzen"
   (Entscheid 002) — kein „Weiter" in eine leere Liste. „Fertig" (5) löscht den Entwurf und hat kein Zurück.
8. **375 px:** am Telefon heißt die Schale nur „Messen & Auswerten" (`MESSEN_TITEL_KURZ`) — neben Zurück-Pfeil und
   Kreuz wurde „… einrichten" zu „Messen & Auswerten ein…" gekürzt (Variante B empfohlen; A „Titel umbrechen"
   hätte die gemeinsame Kopf-CSS des Anlege-Dialogs geändert, nur als Foto gezeigt). „Anderen Standort wählen"
   steht im Rumpf, nicht im Fuß (dort breiter als sein halber Platz). Die Spec misst gekürzte Titel und Knöpfe.
7. **Kein Einstiegsknopf in diesem Paket.** Die Karte „Funktionen" (IP-8) nennt ihren Schritt weiter als
   Hinweis; `messenEinstieg(fs, entwurf)` liefert ihr Text und Start („Messen & Auswerten für Werk Lindach
   einrichten" / „Einrichtung fortsetzen (Schritt 2 von 5)"), der Knopf ist eine eigene Entscheidung.

9. **Die Liste urteilt, Schritt 3 wählt nur.** Was vorgeschlagen wird und mit welcher Stellung, entscheidet der
   Server (`vorschlagsliste`). Zurück geht jede gewählte Zeile wie gezeigt — nur `name` darf anders sein; ein
   leerer Name fehlt in der Anfrage. 409 `vorschlag_geaendert` lädt die Liste neu, der Satz bleibt stehen.
10. **Hauptzähler-Regel vor dem Senden:** `hauptzaehlerFehlt` spricht den Satz von `MessstelleVorschlagService.bezug`
    Wort für Wort (der Test liest die Java-Datei) — kein zweiter Satz. Ein Unterzähler eines BESTEHENDEN
    Hauptzählers hängt an nichts; einen zweiten Hauptzähler schlägt die Liste nie vor (die Netzmessung wird
    `vergleich_kandidat`). Den 409 `hauptzaehler_vorhanden` spricht nur die AP-04-Stellungsroute.
11. **Ort = zweiter Schreibweg, keine gemeinsame Transaktion.** Die Übernahme setzt den STANDORT ab dem
    Verlaufsbeginn; Gebäude/Bereich schreibt `ortKorrekturen` danach als `korrektur: true` am Tag `orte[].gueltig_ab`
    (nur, wo die Messstelle noch am vorgeschlagenen Standort steht). Scheitert ein Ort, stehen die Messstellen
    trotzdem — Schritt 3 nennt „MS-… bleibt am Standort …: <Satz des Servers>" und geht mit „Weiter" weiter.
12. **Prüfliste: das Urteil ist die Regel, die Sätze sind Fakten.** Rot/grün je Zeile aus `funktion.messen.fehlt`
    (Wörter von `messen()`; `fehltArt` ordnet zu, der Test hält jedes Wort der Vektoren fest), die Sätze aus
    Standort, `/devices` (5-min-Fenster wie `FunktionFakten`), Register und `datenlage`. „Weiter" nur bei
    `zustand = aktiv`; die Zeile „Hauptzähler" nur, wo die Regel einen verlangt oder das Register einen kennt.
13. **Befund: `funktion.eingerichtet_am` schreibt für Messen niemand** (`FunktionRepository.zustandSetzen` rufen nur
    der Bestands-Läufer und die Steuern-Teilnahmen). „aktiv" gilt, solange `fehlt` leer ist; fällt eine Messstelle
    aus, liest der Standort wieder „Entwurf", und „Eingerichtet am …" (§5.2) erscheint nie. Braucht einen eigenen
    Schreibweg — nicht still im Lesen nachholen.
14. **Konzept-Satz gekürzt:** §5.2 „Kennzahlen und Berichte richten Sie unter Unternehmen › Kennzahlen ein" zeigt auf
    eine Seite, die es noch nicht gibt (AP-13) — „Fertig" nennt stattdessen „Messstellen ansehen"
    (`standortMessstellenRoute`). Mit AP-13 den Satz ergänzen.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='FunktionApiTest')                    # 7, Testcontainers
(cd services/api && ./mvnw test -Dtest='FunktionSchnittstelleVertragTest')    # 4, rein
(cd services/api && ./mvnw test -Dtest='MessstelleVorschlagApiTest')          # 8, Testcontainers (IP-9b: 2)
(cd frontend/portal && npx vitest run src/messenAssistent.test.ts src/messenAssistentSchritte.test.ts src/components/MessenAssistent.test.tsx src/components/MessenAssistentSchritte.test.tsx src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/messen-assistent.spec.ts --project=desktop-chromium)
```
