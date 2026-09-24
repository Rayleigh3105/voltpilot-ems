# UEMS-Maßnahme: Routen (AP-18 IP-10, M1–M4, M6, M7, RE1–RE3)

Neu am 24.09.2026: `MassnahmeController` → `uems/MassnahmeService`, DTO `web/dto/MassnahmeDto`, Ablehnungen
`VerbesserungAbgelehnt`. Keine Migration (Tabellen und Trigger: [Datenhaltung](uems-verbesserung-datenhaltung.md) IP-9),
keine Fläche (IP-13), keine Bewertung (IP-12). Die Wirkung (IP-11) steht im Abschnitt unten. OpenAPI `/api/v1/massnahmen…`.

| Route | Recht | Was |
|---|---|---|
| `GET /api/v1/massnahmen?zustand=&ueberfaellig=&kennzahl=&einsatz=` | `verbesserung.ansehen` (Kommentar) | Register im Zaun (RLS `site_scope` + Kennzahl lesbar); `ueberfaellig` über `VerbesserungRegeln.frist` mit der Uhr der Kennzahlen |
| `POST /api/v1/massnahmen` | `@Recht verbesserung.verwalten`, DIENST | mit `kennzahl`: freigegebene, heute geltende Fassung (sonst 422 `kennzahl_ohne_bezugsbasis`), Ausgangslage = Kopie von `BezugsbasisVergleich.fuerZiel` über `monate` (Vorgabe: letzter abgeschlossener Monat), `BerichtRegeln.kanonisch` + `pruefsumme`; Standort = der der Kennzahl. Ohne `kennzahl`: Zahl 422 `ohne_messgrundlage` (+ `kennzeichen`, `hinweis`), Standort gewählt (ohne = Unternehmen), Recht über `KennzahlService.darf` am Standort |
| `GET …/{id}` | ansehen | mit `verlauf` (Protokoll inkl. Kommentare), Sätze `massnahme_kopf`, `messgrundlage`, `ohne_messgrundlage`, `ueberfaellig` |
| `PUT …/{id}` · `PUT …/{id}/verantwortlicher` | verwalten | nur geplant (409 `massnahme_nicht_geplant`), Begründung 10–500; Verantwortlicher nur aktives Konto (422 `benutzer_unbekannt`) |
| `POST …/{id}/umgesetzt` · `…/verwerfen` · `…/eintraege` | verwalten | einmalig aus `geplant` (409); `am` nie nach heute (422 `umgesetzt_in_der_zukunft`); Kommentar 1–2 000 an geplant/umgesetzt |

⚠ **Rechnet nichts:** die Ausgangslage ist die Monatszeile und der Zeitraum des Lesers, wie sie sind; sie trägt KEIN
Abrufdatum und keinen Stand-Satz, damit die zweite Bildung byte-gleich ist. ⚠ `umgesetzt_gemeldet_am` und `angelegt_am`
setzt der Schreibweg aus `KennzahlService.jetzt()` — ohne sie nimmt der Trigger die DB-Uhr (Tests mit gestellter Uhr
brechen). ⚠ **Nicht gebaut:** Messgrundlage nachträglich ändern (M2 „solange geplant“, braucht eine neue Kopie), der
Anlass einer Abweichung als Vorgabe der Monate (IP-14/IP-16), Einsatz als Zaun-Anker (der Standort wird ohne Kennzahl
gewählt). Nachweis: `MassnahmeApiTest` (R3, R7, R9 der Referenzdatei 1.9), `MassnahmeSchnittstelleVertragTest`, Zeilen
in `RechtMatrixApiTest`, `RechtRoutenArchitekturTest.DIENST`, `RechteKennungenDerRoutenTest`.

## Wirkung lesen (AP-18 IP-11, WK1–WK5)

`GET /api/v1/massnahmen/{id}/wirkung?monate=` (ansehen, Kommentar) → `uems/MassnahmeWirkung`, DTO
`MassnahmeDto.Wirkung`. Ein Leser, kein gespeicherter Wert, keine Migration: `BezugsbasisVergleich.fuerZiel` vom
Umsetzungsmonat bis `monate` Monate danach (Fassung am letzten Tag, P4), dann `VerbesserungRegeln.wirkung` über den
Umsetzungsmonat (immer, zählt nie) und die **endgültigen** Nachher-Monate. `monate` 12 … 36 (Vorgabe 12), die Grenze
prüft die Operation selbst (`fehler: nachher_monate` → 400); ein anderer Parameter 400; Zaun zuerst (fremd 404, auch
bei `monate=37`). `grund` `ohne_messgrundlage` = nur der Satz der Maßnahme, keine Zahl; `nicht_umgesetzt` = keine
Monate, kein Satz (§5.9 hat keinen). Erwartete Wirkung und Ausgangslage stehen unverändert in `massnahme`.

⚠ **Spannweite im Satz:** `wirkung_nicht_bewertbar` nennt die TOLERIERTE Spannweite (`Spannweite.toleriert_von/bis`
aus dem Eingang, 228 600–375 100 kg); der Monatssatz des Vergleich-Lesers nennt die rohe (254 000–341 000). ⚠
`ZielMonat` trägt dafür `kennzahl` (roh, ohne Wort) und `variable` (die des Monatssatzes). ⚠ `{energie}` ist das
Medium der Zähler-Messstellen, bei keinem oder mehreren „Energie“. ⚠ Der Summensatz nutzt `wirkung_vorlaeufig` auch
nach zwölf Monaten (die Schablone trägt kein „vorläufig“; das sagt das Feld). Nachweis: `MassnahmeApiTest`
(`r5r6WirkungNachDerUmsetzung`, `wk4BasisNachDerUmsetzung`, `wirkungOhneMessgrundlageVorDerUmsetzungUndZaun`).
