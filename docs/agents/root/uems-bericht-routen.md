# UEMS-Berichts-Routen und Rechte (AP-12 IP-7) — Meilenstein „Bericht freigebbar“

Neu angelegt am 15.09.2026. Keine Migration, keine Fläche. Die Regeln sind der Vertrag `docs/contracts/v2/bericht.md`
(D1–D5, F1–F6, R1–R5, G1–G4); Tabellen: `uems-bericht-tabellen.md`, Abzug: `uems-bericht-abzug.md`, Regel-Module:
`uems-bericht-vertrag.md`.

| Was | Wo |
|---|---|
| Routen | `web/BerichtController` (OpenAPI Tag `berichte`): `GET`/`POST /api/v1/berichte`, `GET …/{kennung}`, `GET …/entwurf`, `GET …/entwurf/vergleich?gegen=`, `POST …/freigeben`, `GET …/staende/{nr}`, `POST …/anstoesse/{id}/verwerfen`, `POST …/archivieren` |
| Dienst | `uems/BerichtService` (Reihenfolge, Sperren, D4, F1–F5), `uems/BerichtRepository` (SQL), Ablehnungen `uems/BerichtAbgelehnt` |
| Rechte | `uems/BerichtRechte` → `BerichtRegeln.kennung` (G1) + `RechteAbleitung.darf` (G2) + `BerichtRegeln.teilansicht` (G3); der Aufrufer kommt aus `KennzahlAufrufer` (die EINE Naht für AP-03) |
| Portal | `api.ts`: `Bericht*`-Typen und `api.berichte`, `api.berichtFreigeben` … — noch keine Fläche (IP-13/IP-14) |
| Tests | `BerichtApiTest` (Testcontainers) · `BerichtRechteTest` · `BerichtFreigabeHilfenTest` · `BerichtSchnittstelleVertragTest` · `RechteKennungenDerRoutenTest` |

```bash
(cd services/api && ./mvnw test -Dtest='BerichtRechteTest,BerichtFreigabeHilfenTest,BerichtSchnittstelleVertragTest,RechteKennungenDerRoutenTest,BerichtVectorsTest')
(cd services/api && ./mvnw test -Dtest='BerichtApiTest')   # Testcontainers, Docker nötig
(cd frontend/portal && npm run typecheck)
```

## Die Fallen

- **Neue Zugriffs-Ablehnungen NUR an diesen Routen** (E12): fremder Kundenbereich oder Standort 404 `nicht_gefunden`,
  fehlendes Recht 403 `recht_fehlt` mit dem Satz der Rechte-Ableitung (bericht.md G2 — die Report-Sätze §5.8 gibt es in
  `RechteAbleitung.TEXTE` nicht), die Unterstützung bekommt nie Entwurf oder Stand. Die Liste zeigt nur Lesbares; wer
  nirgends lesen darf, bekommt 403. Den Bestand-Geräte-CSV (`export.standort`) setzt erst IP-10 durch.
- **Das Recht prüft VOR den Regeln:** Bericht (RLS) → `BerichtRechte` → F1/D4. Eine 422 verrät nie einen fremden Bericht.
- **Der Stand ist eine Kopie in SQL:** `INSERT INTO bericht_stand … SELECT e.abzug, e.pruefsumme … FROM bericht_entwurf e
  WHERE … AND e.datenstand = ?` — nie über Java oder Jackson. Lesen prüft `BerichtRegeln.pruefsumme(text)` gegen die
  gespeicherte Summe (500 `abzug_beschaedigt`, der Text verlässt den Server nicht); die Antwort trägt den Text roh
  (`@JsonRawValue`). Zum Abzug gehören Darstellung und Regelwerk aus `abzug.kopf` (F3), die Rolle aus `DarfErgebnis.rolle`.
- **Sperren:** Freigabe, Verwerfen, Archivieren nehmen `bericht` `FOR NO KEY UPDATE` (nicht `FOR UPDATE` — die Kaskade
  schreibt Quellen mit Fremdschlüssel auf `bericht`), die Freigabe dann den Entwurf `FOR SHARE`; die D4-Neubildung nimmt den
  Entwurf `FOR UPDATE` und prüft danach noch einmal.
- **F5 vor F1:** dieselbe Freigabe (Bericht, Datenstand) ist 200 mit dem vorhandenen Stand — auch wenn der Entwurf seitdem
  neu gebildet wurde. Kein zweites Ereignis, kein zweites Protokoll.
- **`jetzt` sekundengenau:** `ZEIT_UTC` der Ereignisse (`bericht_freigegeben`: `zeitpunkt`, `datenstand`) kennt keine
  Bruchteile — Datenstand und Freigabe entstehen darum auf die Sekunde.
- **D4 = eine Abfrage plus die Fristen:** `BerichtRepository.aenderungenSeit` (Versionen, `berechnet_am` von Tag/Monat/Jahr,
  Kennzahl-Werte, Bezugsgrößen-Fassungen, neue Quellenbindung, jede Orts- und Messstellen-Änderung des Kundenbereichs, die in
  den Zeitraum zurückwirkt) und `BerichtService.fristen` (Ende des Zeitraums und jedes „endgültig ab“ eines Tags — der
  Endgültigkeits-Lauf ändert `berechnet_am` nicht). Lieber einmal zu oft neu gebildet als eine Zahl übersehen.
  Kostenstellen-Quellen (IP-6) fragt sie noch nicht; die Viertelstunden-Basis wirkt über Tag und Periode.
- **409 `entwurf_veraltet` hat zwei Gründe:** der übermittelte Datenstand ist nicht der gespeicherte (`datenstand_aktuell` =
  der gespeicherte), ODER der gespeicherte ist selbst nach D2/D3 veraltet (`datenstand_aktuell` null, `aenderungen` nennt,
  was) — dann erst `GET …/entwurf`. `abweichungen` stehen gegen den GÜLTIGEN Stand (der gesehene Entwurf ist nicht
  gespeichert), ohne Stand leer; der Anlass kommt aus `bericht_entwurf_neu_gebildet` (schreibt seit IP-8 die Kaskaden-Naht, `uems-bericht-kaskade.md`).
- **`gebildet_von` ist nicht die Handlung:** `anlegen`, `abruf` (EW1) — `abrufen` lehnt die Bildung ab.
- **Unternehmensbericht:** Anlegen und D4-Neubildung sind 501 `unternehmensbericht_folgt` bis IP-6; Lesen, Freigeben eines
  vorhandenen Entwurfs und alle Rechte gelten schon.
- **`werte_vorlaeufig`:** `vorlaeufig` zählt die Werte, `vorlaeufige` nennt jede Quelle einmal (MS-04 hat zwei Werte).
- **Die Neubildung beim Abruf meldet nichts** (B6). `bericht_freigegeben` hat eine abgeleitete Kennung je Stand.
- **Test-Personen:** `BerichtApiTest` setzt die B13-Personen als `@MockBean KennzahlAufrufer`; die Entwürfe sind die
  kanonisch geschriebenen Vektor-Abzüge `BR-2026-0001/1` und `/2` (Prüfsumme `sha256:b79d0fb8…`), die Uhr über
  `BerichtService.uhrStellen`.
