# UEMS-Maßnahme: Routen (AP-18 IP-10, M1–M4, M6, M7, RE1–RE3)

Neu am 24.09.2026: `MassnahmeController` → `uems/MassnahmeService`, DTO `web/dto/MassnahmeDto`, Ablehnungen
`VerbesserungAbgelehnt`. Keine Migration (Tabellen und Trigger: [Datenhaltung](uems-verbesserung-datenhaltung.md) IP-9),
keine Fläche (IP-13). Die Wirkung (IP-11) und die Bewertung (IP-12) stehen in den Abschnitten unten. OpenAPI `/api/v1/massnahmen…`.

| Route | Recht | Was |
|---|---|---|
| `GET /api/v1/massnahmen?zustand=&ueberfaellig=&kennzahl=&einsatz=` | `verbesserung.ansehen` (Kommentar) | Register im Zaun (RLS `site_scope` + Kennzahl lesbar); `ueberfaellig` über `VerbesserungRegeln.frist` mit der Uhr der Kennzahlen |
| `POST /api/v1/massnahmen` | `@Recht verbesserung.verwalten`, DIENST | mit `kennzahl`: freigegebene, heute geltende Fassung (sonst 422 `kennzahl_ohne_bezugsbasis`), Ausgangslage = Kopie von `BezugsbasisVergleich.fuerZiel` über `monate` (Vorgabe: letzter abgeschlossener Monat), `BerichtRegeln.kanonisch` + `pruefsumme`; Standort = der der Kennzahl. Ohne `kennzahl`: Zahl 422 `ohne_messgrundlage` (+ `kennzeichen`, `hinweis`), Standort gewählt (ohne = Unternehmen), Recht über `KennzahlService.darf` am Standort. Herkunft aus dem Energiemanagement (AP-19 IP-17): `nichtkonformitaet` F-… nur an einer OFFENEN Feststellung (gesperrt `FOR SHARE` gegen einen schließenden Stand; sonst 422 `feststellung_nicht_offen`), `audit` AU-… nur durchgeführt/abgeschlossen (422 `audit_nicht_durchgefuehrt`), `managementbewertung` BR-…/Bn bis IP-23 immer unbekannt; unbekannt oder außerhalb des Zauns 422 `herkunft_kennung`, falsches Muster 400 — Prüfung in `MassnahmeService#herkunftPruefen` in der Anlege-Transaktion. `abweichung` prüft weiter nur das Muster (W14, AP-18-Sache) |
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

## Bewerten: Stand Nr. n (AP-18 IP-12, WK6)

`uems/MassnahmeBewertung` (eigene Klasse: `MassnahmeWirkung` hängt an `MassnahmeService`), DTO `MassnahmeDto.Bewertung`,
keine Migration (Tabelle `massnahme_bewertung` mit Triggern aus IP-9). Form und Fehlerwörter wie das Energieziel (IP-7).

| Route | Recht | Was |
|---|---|---|
| `GET …/{id}/bewertungen` | ansehen (Kommentar) | alle Stände nach Nr., auch beantragte und abgelehnte |
| `POST …/{id}/bewertungen` | `@Recht verbesserung.abschliessen`, DIENST | nur `umgesetzt`/`bewertet` (409 `massnahme_nicht_umgesetzt`); `belegt · nicht_belegt · nicht_messbar` + Begründung 10–500 (422 `begruendung_fehlt`); ohne Messgrundlage nur `nicht_messbar` (422 `ohne_messgrundlage`, Stand ohne Kopie); 201 mit der Maßnahme, Zustand `bewertet`, Protokoll `massnahme_bewertet`; ein weiterer Stand ist Nr. n + 1 |
| `POST …/bewertungen/beantragen` · `…/freigeben` · `…/ablehnen` | ebenso | Vier-Augen nach `unternehmen.vieraugen_freigabe`: `vieraugen_beantragen`/`vieraugen_aus` (409), offener Antrag 409 `bewertung_beantragt`, ohne Antrag 409 `bewertung_nicht_beantragt`; die zweite Person nie der Urheber (422 `vieraugen_urheber`), nie der Verantwortliche der Maßnahme (422 `vieraugen_verantwortlich`), Rolle KA/EM (403 `vieraugen_rolle`); Ablehnung mit Begründung behält die Nr. |

`GET …/{id}` und das Register tragen `bewertung` (jüngster BEWERTETER Stand, sonst `null` — die Fläche sagt dann
„beobachtet — nicht belegt“, Satz `bewertung_offen`) und `bewertung_antrag` (offener Antrag oder `null`); `satz` des
Stands ist `bewertung_belegt` bzw. `bewertung_nicht_messbar` (§5.9 hat keinen für `nicht_belegt`).

⚠ **Die Kopie ist NICHT die Leser-Antwort** (die trägt `massnahme.frist` und ist nicht tagesstabil), sondern die Form der
Referenzdatei 1.9 `massnahmen[].bewertungen[].kopie`: Anker, `umgesetzt_am`, `nachher`, `abruf` (= Bewertungstag), je
ENDGÜLTIGEM Nachher-Monat (ohne Umsetzungsmonat) `version`, die Einflussgröße unter ihrer Einheit (`kg`), `kwh`,
`erwartet_kwh` (ganz), `delta_prozent`, `urteil`, `grund`, dazu `wirkung` (Σ ÷ Σ, `monate_gesamt` = endgültige
Nachher-Monate, Ausschlüsse ohne Umsetzungsmonat) und `erwartete_wirkung_prozent`. R6 trifft deren Prüfsumme
`sha256:4635…` byte-gleich; wer die Form ändert, bricht R6. ⚠ `massnahme.zustand = 'bewertet'` erst NACH dem bewerteten
Stand (Trigger `massnahme_bewertet_mit_stand`). Neuer Stand nach einem Anstoß (`neu_bewertet`, IP-17): [Anstoß am
Vorgang](uems-vorgang-anstoss.md). ⚠ Nicht gebaut: die Fläche (IP-20). Nachweis: `MassnahmeApiTest` (`r6StandNr1BelegtMitPruefsummeUndNr2`,
`r7OhneMessgrundlageNurNichtMessbarRechtUndZaun`, `vierAugenNichtDerUrheberNichtDerVerantwortliche`),
`MassnahmeSchnittstelleVertragTest`, Zeilen in `RechtMatrixApiTest`, `RechtRoutenArchitekturTest.DIENST`.

## Abnahme der Plan-Konstruktion (AP-18 IP-22, NW-6)

`UemsMassnahmeAbnahmeTest` fährt die Zeitachse der Referenzdatei 1.9 (R8, R2, R3, R5–R7, R10, R12) über die Routen und
prüft die zwei Sätze des Auftrags: verbunden (Ziel, Verantwortlicher, Messgrundlage, Ergebnis) und keine Ursache ohne
„Aussage von“ — im Quelltext der Leser (`LESER`, `VerbesserungRegeln.SAETZE`) UND in jeder Leser-Antwort des Plans.
⚠ Ein neuer Leser mit Kundensätzen gehört in `LESER`; ein neuer Text mit „Ursache“ ohne „Aussage von“ macht den Test
rot (Ausnahme nur die zwei Eingabe-Ablehnungen in `ABLEHNUNGEN`). Die Welt (KZ-0004 × BB-0001 F1/F2, EE-3, fünf
Personen) steht einmal in `MassnahmeWelt` und wird von `MassnahmeApiTest` und der Abnahme geteilt — keine zweite
Welt bauen. ⚠ `bewertung: null` ist die ganze API-Aussage „ohne Person“; den Satz `bewertung_offen` („Beobachtet — nicht
belegt …“) bildet die Fläche aus ihrem Zwilling, die API liefert ihn nicht.
