# UEMS-Standort-Zaun: Policy `site_scope`, Prüfpunkt `Geltungsbereich`, Architektur-Test (AP-03 IP-5)

Neu angelegt am 15.09.2026. Spezifikation: AP-03 §6.2 Punkte 3–4, §8 IP-5, Fälle A1, A13, A16. Code:
`V20260915190000__uems_site_scope.sql`, `zugriff/Geltungsbereich` (ersetzt `SiteRepository.existsForCurrentTenant`
an 39 Einstiegen; die Methode gibt es nicht mehr), `MeasurementHistoryService.history` (Verlauf und Geräte-CSV). Beweis:
`RlsIsolationTest` (A1, A13, A16, Schreiben, fail closed, Mandanten-Zaun), `SiteScopeBestandTest` (vorher/nachher je
Kundenbereich und Tabelle), `ZugriffZaunApiTest` (157 lesende Routen gleich, standortbeschränkte Konten; seit 21.09.2026 die 18 nach IP-4
eingeführten Lese-Routen mit echtem Objekt und Zaun-Paar Bearbeiter hier/anderswo, `PROBEN`),
`SiteScopeArchitekturTest` (Messdaten ohne `site`).

## Was gilt

- **RESTRICTIVE Policy `site_scope`** auf `site`, `standort`, `anlage_standort`, `ort`, `measurement_point` und
  `device`. Sie ist UND-verknüpft mit der Mandanten-Policy, die unverändert bleibt.
- **`app.zugriff` leer** (NULL auf frischer Verbindung, `''` nach dem Zurücksetzen) **oder `unternehmen`**: alle Zeilen
  des Kundenbereichs, wie vor dem Paket. Jeder andere Wert ist der enge Zaun mit `app.standort_ids`, auch ein Tippfehler.
- **Enger Zaun, je Tabelle:**
  - `standort`: `id` in den Kennungen.
  - `anlage_standort`: `standort_id` in den Kennungen, auch beendete Zeilen. Berichte über die Vergangenheit bleiben
    lesbar (A16).
  - `site`, `measurement_point`, `device`: die Anlage hängt **heute** an einem der Standorte
    (`uems_zugriff_anlage_sichtbar`). Heute ist der Tag in der Zeitzone des Unternehmens (`uems_zugriff_heute`, wie
    `StandortLesemodell.heute`).
  - `ort`: das Gebäude hängt heute am Standort, der Bereich am Standort oder an einem solchen Gebäude (eine Stufe).
- **Schreiben (WITH CHECK):** `standort`, `anlage_standort`, `measurement_point` und `device` prüfen dieselbe Bedingung.
  `site` und `ort` lassen das Anlegen zu, denn ihr Standort kommt erst mit der Zuordnung. Das Anlegen ist ein Recht
  (IP-6). Ändern und Löschen treffen nur sichtbare Zeilen.
- **`Geltungsbereich.requireSite(siteId)`** antwortet 404 „Anlage nicht gefunden.“, **`siteVisible`** ist für eigene
  Fehlerbilder. Beide fragen `site` unter RLS; die Antwort gibt die Policy. Der Geräte-Verlauf prüft die Anlage des
  Geräts UND `?siteId=`.
- **`Geltungsbereich.ganzenKundenbereichLesen()`** hebt den Standort-Zaun für den Rest der laufenden Transaktion auf
  (`set_config(…, true)`), ohne Transaktion `IllegalStateException`. Allein die Selbstauskunft `/me` ruft es — sie rechnet
  „n von m Standorten“ selbst nach dem Vertrag; `SiteScopeArchitekturTest` hält die Aufruferliste. IP-10 (Teilansicht
  `gesamt`) kommt auf dieselbe Liste.
- **Architektur-Test:** eine Anweisung auf `telemetry*`, `telemetry_v2*`, `device_measurement_sample` oder
  `device_measurement_rollup_*` geht über `site`, oder sie steht mit Grund und Beleg in `SiteScopeArchitekturTest.LISTE`.
  Gezählt wird je Datei und Tabelle; mehr ist rot, weniger auch.

## ⚠ Fallen für die Folgepakete

- ⚠ **Offen, nicht gezäunt:** `messstelle` und ihre Tabellen haben keinen Standort-Zaun.
  - `GET /api/v1/messstellen` (`MessstelleRegisterRepository`, in der Liste `OFFEN`) liest alle Messstellen. Die
    Formel-Kanäle liest es über `device_measurement_selection` ohne Anlage.
  - Die Werte einer Messstelle kommen nur über `measurement_point` und fallen darum weg. Die Messstelle selbst bleibt
    sichtbar.
  - Das gehört zu IP-10/IP-11 (A1: MS-19 unsichtbar).
- **`bezugsgroesse`: geschlossen mit PR-NR (Befund 21.09.2026).** Die Tabelle trägt weiter nur die
  Mandanten-Policy; gezäunt wird in der Anwendungsschicht über die Geltung, mit DERSELBEN Auflösung wie die
  Schreibseite: `RechtPruefung#pruefenLesen` (Einzelroute) und `#lesbar` (Liste), Aktion `messwerte.ansehen`.
  - Standort/Gebäude/Bereich/Messstelle: nur mit Zuweisung dort; Unternehmen/Prozess/Kostenstelle: nur
    unternehmensweite Rollen (AP-03 R-A1, §4.9). Außerhalb = Status und Körper einer unbekannten Kennung.
  - Gezäunt: `GET /bezugsgroessen` (Liste), `/{id}`, `/{id}/werte`, `/{id}/stammdatum`, `/{id}/kanalbindung`,
    `/{id}/kanalbindung/kanaele`. Interne Leser (`BezugsgroesseService#werte`/`#stammdatum`, `KanalbindungService#liste`,
    `BezugsgroesseRepository#finde`) bleiben ungezäunt — Kennzahl, Import, Berichtigung bedienen keine Anfrage
    nach dieser Kennung. Wer eine neue Leseroute baut, nimmt den `…ImGeltungsbereich`-Einstieg.
  - `ZugriffZaunApiTest.ZAUN_OFFEN` ist leer und bleibt als Zusicherung stehen; je Geltungsart
    `BezugsgroesseApiTest#jedeLeserouteZeigtDieBezugsgroesseNurImGeltungsbereich`.
- ⚠ **Summen:** `/overview` und `/earnings` lesen je Anlage des ganzen Kundenbereichs (`ZEIGT_NUR_SICHTBARE`). Die Antwort
  nimmt nur Anlagen aus `sites.findAll()`. Die Teilansicht der Summen ist IP-10.
- ⚠ Übrige Tabellen mit `site_id` (Konfiguration, Verbraucher, Ladepunkte, `ort_zuordnung` …) sind nur über ihre
  Einstiege gezäunt (`requireSite`). Eine neue Route ohne Anlage im Pfad braucht den Prüfpunkt selbst. Der
  Rechte-Interceptor (IP-6, `uems-rechte-schreibrouten.md`) reicht eine unsichtbare Anlage an die Route durch — die 404
  bleibt deren Sache.
- ⚠ **Anlage ohne gültige Zuordnung:** für standortbeschränkte Nutzer unsichtbar, für unternehmensweite sichtbar
  (§8 IP-5). Das trifft auch Bestandsanlagen, die die Übernahme nur als Vorschlag führt, und Zuordnungen mit
  `gueltig_ab` in der Zukunft bis zu diesem Tag.
- ⚠ **Anlegen am Standort:** Eine Anlage, die der enge Zaun nicht sieht, kann er nicht zuordnen. Die
  Einfüge-Prüfung `uems_anlage_standort_anlage_pruefen` liest `site` unter derselben Rolle und meldet
  `anlage_standort_site_fk`. Ein `INSERT … RETURNING` auf `site` oder `ort` scheitert im engen Zaun, weil die neue Zeile
  noch keine Zuordnung hat. Seit IP-6 vergibt `OrtRepository.anlegen` die Kennung selbst (ohne `RETURNING`). `site`
  legt nur der Kundenadministrator an (`anlage.verwalten`, unternehmensweit).
- ⚠ **Bestandsregel E12 in der Anfrage, seit 16.09.2026 MIT STICHTAG** (`uems-zugriff-stichtag.md`): ein Kundenkonto,
  das in diesem Kundenbereich NIE eine Zuweisung hatte, trägt `unternehmen` (`ZugriffContext.Zugriff.bestandskonto`,
  eine Abfrage mehr nur ohne wirksame Zuweisung) — **solange der Kundenbereich keine Zeile in `zugriff_bestand` hat**.
  Sonst sperrte der Zaun jedes Konto aus, das der Start-Lauf noch nicht übernommen hat (Not-Aus, Keycloak nicht
  erreichbar, Testlauf). Ist der Bestand übernommen, ist ein Konto ohne Zuweisung ein NEUES Konto: `standorte` + `{}`.
  Mit nur beendeten oder künftigen Zuweisungen trägt es `standorte` + `{}` und sieht keine Anlage (Entzug wirkt sofort).
  ⚠ IP-13/IP-14: die Zuweisung eines neuen Kontos muss VOR seiner ersten Anfrage stehen.
- ⚠ Jobs, Takt, Hörer und `/admin/**` laufen ohne Zugriff und sehen den ganzen Kundenbereich. Ein Hörer, der im
  Anfrage-Thread den Kundenbereich wechselt, bekommt leere Einstellungen, sieht also alles.
- ⚠ **Scanner-Grenzen:** `SqlAnweisungen` liest String-Literale, Textblöcke und Konstanten DERSELBEN Datei.
  - Eine Anweisung endet an `;`, `{` oder `}`; über `StringBuilder` gebautes SQL zählt je Stück.
  - Ein Tabellenname als eigenes Literal zählt als Zugriff.
  - Ein `FROM site` irgendwo in der Anweisung gilt als Join. Prüf beim Eintragen, dass er die Messdaten wirklich bindet.
- ⚠ **Tests:** ein Mockito-Mock von `Geltungsbereich` tut bei `requireSite` nichts (void). `siteVisible` liefert
  `false`, bis man es stubbt.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='SiteScopeArchitekturTest')
(cd services/api && ./mvnw test -Dtest='RlsIsolationTest,SiteScopeBestandTest')
(cd services/api && ./mvnw test -Dtest='ZugriffZaunApiTest')
```
