# UEMS-Fläche: Assistent „Messen & Auswerten" — der Rahmen mit Schritt 1 und 2 (AP-01 IP-9a)

Neu am 15.09.2026 (AP-01 IP-9a, Konzept §5.2; Entscheide firstmate 001 = A Schreibweg, 002 = A Standort ohne
Anlage). Keine Migration. Ein kleiner Schreibweg, den IP-3 ausdrücklich hierher gelegt hat
(`uems-funktionen-routen.md`: „Messen hat noch keinen Schreibweg (IP-9a)").

| Teil | Datei |
|---|---|
| Route `PUT /api/v1/standorte/{id}/funktionen/messen` `{"aktion":"einrichten"}` → 200 `{aktion, standort}`; 409 `bereits_angelegt`/`standort_archiviert`, 404 fremd, 400 sonst | `web/FunktionController`, `uems/FunktionService.messenStandort`, `uems/FunktionAbgelehnt` · `FunktionApiTest`, `FunktionSchnittstelleVertragTest` |
| Reine Regel: Schrittfolge, „Schritt n von 5", Entwurf im Browser, Start/Wiedereinstieg, Einstieg für die Karte, Sätze | `frontend/portal/src/messenAssistent.ts` · `messenAssistent.test.ts` |
| Fläche: Schale `AnlegenDialog`, Schritt 1 (`VpPicker` + `StandortDialog`), Schritt 2 (`AddDeviceDrawer`, `AnlegenFlow`) | `src/components/MessenAssistent.tsx` (+ `.css`, `.test.tsx`) |
| 375/1440 px + Bilder | `e2e/messen-assistent.spec.ts` auf der Bühne `messen-assistent.html/.tsx`; `MESSEN_ASSISTENT_BILDER=<Ordner>` |
| Fixture „Messen im Entwurf" (Satz aus `messen()`) | `src/test/funktionenFixtures.ts` `funktionMessenEntwurf` |

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
6. **Schritte 3–5 (IP-9b) einhängen:** Rumpf in `MessenAssistent.tsx` rendern und `GEBAUTE_SCHRITTE` ergänzen.
   `vor` betritt nie einen ungebauten Schritt; ohne Schritt 3 endet Schritt 2 mit „Später fortsetzen", mit ihm
   von selbst mit „Weiter". Fertig (5) sollte den Entwurf mit `entwurfVerwerfen` löschen.
7. **Kein Einstiegsknopf in diesem Paket.** Die Karte „Funktionen" (IP-8) nennt ihren Schritt weiter als
   Hinweis; `messenEinstieg(fs, entwurf)` liefert ihr Text und Start („Messen & Auswerten für Werk Lindach
   einrichten" / „Einrichtung fortsetzen (Schritt 2 von 5)"), der Knopf ist eine eigene Entscheidung.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='FunktionApiTest')                    # 7, Testcontainers
(cd services/api && ./mvnw test -Dtest='FunktionSchnittstelleVertragTest')    # 4, rein
(cd frontend/portal && npx vitest run src/messenAssistent.test.ts src/components/MessenAssistent.test.tsx src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/messen-assistent.spec.ts --project=desktop-chromium)
```
