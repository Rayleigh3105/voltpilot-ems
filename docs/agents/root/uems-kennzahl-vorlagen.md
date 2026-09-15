# UEMS-Kennzahl-Vorlagen: der Katalog, der den Assistenten vorbelegt (AP-11 IP-10)

Neu am 15.09.2026, E9 = A: acht VoltPilot-Vorlagen — kein Kundenobjekt, keine Fassung, kein Mandant, kein Recht.
Kanonisch `services/api/src/main/resources/kennzahlen/kennzahl-vorlagen.json`; Portal-Kopie
`frontend/portal/src/kennzahlen/kennzahl-vorlagen.json` (byte-gleich); Form
`docs/contracts/v2/kennzahl-vorlagen.schema.json`; Vertrag `kennzahl.md` §11. Nach diesem Paket kommt der Assistent
„Kennzahl anlegen“ (IP-14).

| Stelle | Was |
|---|---|
| `uems/KennzahlVorlagen` | liest den Katalog beim Start (bricht ab bei doppelter Kennung oder einem Namen ohne „ — {Geltungsbereich}“); `katalog()` für die Route; `vorbelegung(...)` → `KennzahlDto.Anfrage` |
| `GET /api/v1/kennzahl-vorlagen` (`KennzahlVorlagenController`) | keine eigene Kennung; Knoten für Knoten die Datei ohne `_comment`, `$schema_datei`, `herkunft`; OpenAPI `KennzahlVorlagen` |
| `kennzahlVorlagen.ts` + `api.kennzahlVorlagen()` | `KENNZAHL_VORLAGEN`, `kennzahlVorlage`, `vorlagenTitel` (Karte in Schritt 1), `vorbelegung` (ruft `vorlage` aus `uemsKennzahl.ts`) |

```bash
(cd services/api && ./mvnw test -Dtest='KennzahlVorlagenTest,RechteKennungenDerRoutenTest,KennzahlSchnittstelleVertragTest')
(cd services/api && ./mvnw test -Dtest='KennzahlApiTest')   # K20 an der Route; Docker nötig
(cd frontend/portal && npx vitest run src/kennzahlVorlagen.test.ts src/kennzahlVorlagen.sync.test.ts src/copy.test.ts)
```

## Die Fallen

- **Beide Kopien zusammen ändern** — `kennzahlVorlagen.sync.test.ts` vergleicht Bytes, nicht JSON.
- **Die Aufzählungen des Schemas sind die Wörter der Nachbarverträge**: `messstelle.schema.json` (`groesseName`,
  `richtung`, `art`, `wertart` ohne Momentanwert) und `bezugsdaten-vectors.json` (`arten.je_art`, `vokabulare.wertart`
  ohne `stand`). `KennzahlVorlagenTest` vergleicht sie — eine neue Art oder Richtung dort zieht das Schema nach.
- **Jede Vorlage muss bildbar sein**: jede erwartete Seite geht durch `KennzahlRegeln.einheit` und den TS-Zwilling
  (Anteil → %, Quotient → ungekürztes Paar). Einheiten werden nie umgerechnet — „je t“ wäre eine eigene Vorlage.
- **Der Name-Vorschlag endet auf „ — {Geltungsbereich}“** — genau die Endung, die `kopie` gegen den neuen Ort tauscht.
- **Die Vorbelegung setzt nur Rechenform, Name, Zweck und beim Anteil das Komplement** (sonst `null`) — keine Eingänge,
  kein Kennzeichen, kein Verantwortlich. Die Vorschau-Route bleibt unverändert: IP-14 schickt die vorbelegte Anfrage
  mit den gebundenen Eingängen (`KennzahlApiTest.k20DieVorschauAusDerVorlageSchreibtNichts`).
- **Kundentext im JSON**: `copy.test.ts` (§4.13) liest Name, Zweck, Hilfesatz und die Sätze der Erwartungen — der
  Datei-Walker sieht keine JSON-Dateien.
- ⚠ **Eigenverbrauchsanteil:** der Teil ist ein Gesamtwert „Erzeugung − Einspeisung“. Wie er gebildet wird, legt IP-10
  nicht fest: `rest` ergibt fest Wirkenergie · Bezug, eine `gewichtete_summe` mit Minus wird `richtungslos` und damit
  `groessen_gemischt` (`messstelle-formel.md` §2). Die Vorlage verlangt deshalb nur `berechnet` und keine Richtung
  (`richtungen: null`) — die angekündigte Prüfung am echten Gesamtwert hat IP-14 NICHT gebaut (Befund in
  `uems-kennzahlen-abschluss.md`).
- ⚠ **Namen:** §4.12 sagt „Anteil am Netzbezug“, K20 zählt „Anteil am Gesamtbezug“ auf — gebaut ist §4.12. Die in §5
  erwähnte Vorlage „Zusammenfassung“ steht nicht im Satz von §4.12; die Form bleibt „ohne Vorlage“ wählbar, das
  Schema erlaubt nur `quotient` und `anteil`.
