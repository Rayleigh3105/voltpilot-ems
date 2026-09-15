# UEMS-Kennzahl-Werte lesen: die Kennzahl wird lesbar (AP-11 IP-7)

Neu am 15.09.2026 — Meilenstein „Kennzahl lesbar“; danach kann das Portal (IP-13) bauen. `KennzahlWerteController` →
`uems/KennzahlWerteService` (Wahl, Herkunft, Versionen) mit dem Leser `uems/KennzahlWerteLeser` (`kennzahl_wert` +
`kennzahl_wert_eingang`, RLS). Keine Migration. Vorbild: `uems-versionen-lesen.md` (AP-08 IP-18). Spezifikation: AP-11 §8
IP-7, §4.9 V6, §4.10, E4/E11/E12.

| Route | Recht | Was |
|---|---|---|
| `GET /api/v1/kennzahlen/{id}/werte?periode=&von=&bis=[&version=]` | `messwerte.ansehen` (Kennung) | je Periode ein Schritt `KennzahlDto.Wert` — Trägerform des Messstellen-Werts + `richtung`, `grund`, `definition_fassung` |
| `GET /api/v1/kennzahlen/{id}/werte/versionen?periode=&von=` | `messwerte.ansehen` (Kennung) | Historie EINER Periode: `wert_alt` → `wert_neu`, `gebildet_am`/`nachgezogen_am`, Anlass, wer/wann/warum |

```bash
(cd services/api && ./mvnw test -Dtest='KennzahlSchnittstelleVertragTest,RechteKennungenDerRoutenTest')
(cd services/api && ./mvnw test -Dtest='KennzahlWerteApiTest')   # Testcontainers
```

## Die Fallen

- **Nichts wird nachgerechnet, nichts gerundet.** Wert, Zähler, Nenner, Abdeckung reisen als Dezimaltext der gespeicherten
  NUMERIC (`KennzahlRegeln.text`) — anders als der Messstellen-Wert (JSON-Zahl), gleich wie `VorschauPeriode`. Gerundet
  wird nur im Portal (U4). Die Einheit eines Schritts ist die seiner gelesenen Fassung (`KennzahlService.fassungen`), nicht
  die heutige.
- **Die Wahl folgt der Tabelle:** Zeilen je Periode `version NULLS FIRST, berechnet_am` — die letzte ist die aktuelle;
  `version=n` die letzte der Version n. Eine Version, die es an KEINEM Schritt gibt, ist 404 `version_gibt_es_nicht`
  (`WertVersionenRegeln.pruefeVorhanden`, OpenAPI `MessstelleWerteVersionGibtEsNicht`); am einzelnen Schritt
  `version_nicht_gespeichert`, ohne Zeile `noch_nicht_gebildet` — die zwei Wörter des Messstellen-Werts, neben
  `grund_ohne_zahl` (`KennzahlWerteService.GRUENDE_DES_LESERS`, Vertragstest).
- **Herkunft = `KennzahlRegeln.herkunft` über die gespeicherten Eingänge** — byte-gleich zu jeder Prüfung der Regel
  `herkunft` in `kennzahl-vectors.json` (13 mit Satz; „ohne Anlass“ kann die Tabelle gar nicht speichern). Ohne Version
  (K8: keine Zahl, noch nie eine) ist sie `null` — der Satz verlangt eine Version, `grund` sagt das Warum.
- ⚠ **Zeit-Perioden haben keine Eingänge ihrer Teilperioden** (IP-6 bildet Jahr/gröbere Periode über die EIGENEN
  Teilperioden, der Selbstverweis ist verboten): die Route antwortet dort mit Regel 7, `satz` null, `fehlt` `[eingaenge]`.
  Eine Zusammenfassung schreibt seit **IP-11** ihre Paare derselben Periode als Eingänge (Report K14) — der Leser baut
  daraus den Satz wie jeden anderen und erfindet nichts (`uems-kennzahl-zusammenfassung.md`).
- **wer/wann/warum aus dem Beleg:** nennt `anlass_kennung` eine Korrektur `K-…` oder einen Ersatzwert `EW-…`, liest
  `WertVersionenLeser.fassungen` die jüngste Fassung bis `berechnet_am` der Version und spricht sie über
  `MessstelleWerteService.entscheidung` (paketweit, aufgerufen). Anlass `definition` → die `kennzahl_fassung` der gelesenen
  Nummer (`vorgang` `berechnung`, `art` = ihre Herkunft). ⚠ Ein Beleg ohne solche Kennung — die Bezugsgrößen-Anlässe von
  **IP-9** („correction BZ-1 2026-10 Fassung 1 → 2 (I-2026-0003)“, „Rücknahme I-2026-0001“) — hat KEINE Entscheidung, nur
  den Anlass-Text. Wer IP-9 baut, löst Import/Berichtigung dort auf (`kennungen` + `entscheidungen` im Service).
- **Streng:** fehlender, falsch geformter oder UNBEKANNTER Parameter = 400 `anfrage_ungueltig` mit `feld`; `von` muss
  Periodenbeginn, `bis` Periodenende sein, höchstens 2 200 Perioden. Anfrage vor Existenz (400 vor 404); fremd ist 404.
- **Eigener Controller** neben `KennzahlController` (wie `MessstelleWerteController` neben `MessstelleController`) — mit
  eigenen `@ExceptionHandler`n; der Konstruktor von `KennzahlController` bleibt unberührt.
- **Nicht gebaut:** Durchsetzung des Lesens (AP-03 IP-11), Portal (IP-13/IP-15), Export als Datei (Rundung bleibt beim
  Portal), Wochen-Werte entstehen erst mit IP-12 (die Route liest sie schon).
