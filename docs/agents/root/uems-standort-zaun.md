# UEMS-Standort-Zaun: Policy `site_scope`, Prüfpunkt `Geltungsbereich`, Architektur-Test (AP-03 IP-5)

Neu angelegt am 15.09.2026. Spezifikation: AP-03 §6.2 Punkte 3–4, §8 IP-5, Fälle A1, A13, A16. Code:
`V20260915190000__uems_site_scope.sql`, `zugriff/Geltungsbereich` (ersetzt `SiteRepository.existsForCurrentTenant`
an 39 Einstiegen; die Methode gibt es nicht mehr), `MeasurementHistoryService.history` (Verlauf und Geräte-CSV). Beweis:
`RlsIsolationTest` (A1, A13, A16, Schreiben, fail closed, Mandanten-Zaun), `SiteScopeBestandTest` (vorher/nachher je
Kundenbereich und Tabelle), `ZugriffZaunApiTest` (157 lesende Routen gleich, standortbeschränkte Konten; seit 21.09.2026 die 18 nach IP-4
eingeführten Lese-Routen mit echtem Objekt und Zaun-Paar Bearbeiter hier/anderswo, `PROBEN`),
`SiteScopeArchitekturTest` (Messdaten ohne `site`). Seit der Inventur vom 21.09.2026 misst
`ZugriffZaunApiTest#jedeLesendeRouteMitKennungZeigtIhrObjektNurAmStandortDesObjekts` jede übrige Leseroute mit Kennung
(Abschnitt „Inventur der Lesewege“).

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

- **`messstelle`: Lesewege gezäunt seit 21.09.2026** (`vp-uems-zaun-messstelle-vorlagen-lesen`). Die Tabelle trägt
  weiter nur die Mandanten-Policy; die ROUTEN lesen über `RechtPruefung#pruefenLesen`/`#lesbar` mit
  `RechtZiel.MESSSTELLE` (Auflösung über `messstelle_ort`, wie die Schreibseite). Außerhalb = Status und Körper der
  unbekannten Kennung, nach der Prüfung der Parameter.
  - Gezäunt: `GET /messstellen` (beide Listen und Aggregat, `MessstelleRegisterService#liste(…, sichtbar)`), `/{id}`,
    `/{id}/standort`, `/{id}/quellen`, `…/quellen/{quelleId}`, `…/kadenz`, `/{kennzeichen}/werte`, `…/werte/versionen`,
    `/{id}/formel`, `/{id}/wert`, `/{id}/verlauf`, `/{id}/verteilung`, `/{id}/prozesse`, `/{id}/aenderungen`.
    Schon vorher: `…/ablesungen`, `…/ersatzwerte/luecken`.
  - Ort „Unternehmen“ (MS-19) sieht nur eine unternehmensweite Rolle (A1). **Ohne Ort (Entwurf)** liest jedes Konto
    mit dem Recht irgendwo, wie die Schreibseite — Entscheid firstmate 21.09.2026 (Lesart A; der Anlege-Fluss liest den
    eben angelegten Entwurf weiter). Sobald die Messstelle einen Ort hat, gilt der Zaun ohne Ausnahme.
  - Interne Leser (`MessstelleService#eine`, `MessstelleRegisterService#liste(Instant, Filter)`, Bilanz, Formel,
    Kennzahl, Standort-Übersicht) bleiben ungezäunt. Beweis: `LesewegImZugriffApiTest`.
  - Offen: die Werte einer Messstelle, die über `measurement_point` laufen, fallen weiter über `site_scope` weg.
- **Vorlagen und Import-Protokoll** (gleiches Paket): `GET /bezugsdaten/vorlagen` zeigt nur Vorlagen, deren Bezüge
  (`bezugsdaten_vorlage_bezug`) alle `#lesbar` sind (AP-09 E12); `GET /bezugsdaten/importe` lässt einen Import mit
  einem Ziel außerhalb weg (`RechtPruefung#erlaubt`, dieselbe Prüfung wie das Detail), statt die ganze Liste mit 404
  abzulehnen.
- **`bezugsgroesse`: geschlossen mit PR 1000 (Befund 21.09.2026).** Die Tabelle trägt weiter nur die
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

## Inventur der Lesewege (21.09.2026)

148 der 184 lesenden Kundenrouten tragen eine Kennung im Pfad. Woran ihr Zaun hängt (Objekt → Art, Beleg):

| Objekt (Routen) | Zaun | Beleg |
|---|---|---|
| Anlage `/sites/{siteId}/…` (85) | `Geltungsbereich.requireSite`, Unterobjekte über `(siteId, id)` | z. B. `web/SiteConsumerController.java:122` |
| Standort (11), Gerät `geraete` (5), Box `devices` (5), Ort `orte` (2) | RLS `site_scope` | `V20260915190000__uems_site_scope.sql:110-149`, `V20260918102000…:21` |
| Bericht (6) | `Geltungsbereich.requireScope` | `uems/BerichtService.java:584` |
| Korrektur, Ersatzwert-Lücken (2) | Standort jeder Reihe/Quelle | PR 998 |
| Bezugsgröße (5), Import (2), Ablesung (1), Kennzahl (5) | `RechtPruefung`/`sicht` | `zugriff/RechtPruefung.java:550-575`, `uems/KennzahlService.java:484` |
| **Messstelle (13), Kostenstelle (2), Prozess (1)** | **nichts — offen** | `ZAUN_OFFEN` |
| Unterstützung, Komponenten-Vorlage, Enrollment (3) | kein Standortbezug (Recht + Mandant, globaler Katalog, öffentlich) | — |

- **Offen (22 Muster in `ZAUN_OFFEN`, jedes gemessen):** Messstelle `/{id}`, `/aenderungen`, `/prozesse`,
  `/verteilung` (ganz), `/quellen`, `/standort`, `/{kennzeichen}/werte(/versionen)` (Teile), `/quellen/{quelleId}`,
  `…/kadenz`, `/formel`, `/wert`, `/verlauf` (Existenz); Kostenstelle `/{id}`, `/{id}/energie`, Prozess `/{id}`; die Listen
  `/messstellen`, `/unternehmen/kostenstellen`, `/unternehmen/prozesse`, `/bezugsdaten/vorlagen`,
  `/unternehmen/aenderungen`; `/berichte/betroffen?objekt=` (Existenz). Kostenstelle/Prozess haben Geltung
  Unternehmen: nach R-A1 nur unternehmensweite Rollen.
- **Messform:** erste Kennung = Objekt der Bühne (`behaelter`), Bearbeiter hier sieht es (sonst Kundenadministrator),
  Bearbeiter anderswo = Status und Körper der unbekannten Kennung. Zwei gleiche Ablehnungen sind „ohne Aussage“, zwei
  verschiedene ein Loch (Existenz). Listen: anderswo fehlt das Objekt.
- ⚠ Die Inventur setzt ihre Pfade selbst und fasst `PROBEN` (Bestandsvergleich) nicht an. 18 Muster bleiben „ohne
  Aussage“ (Unterobjekte der Anlage ohne Objekt, Pflichtparameter), 11 ohne Objekt der Bühne (Bericht, Kennzahl).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='SiteScopeArchitekturTest')
(cd services/api && ./mvnw test -Dtest='RlsIsolationTest,SiteScopeBestandTest')
(cd services/api && ./mvnw test -Dtest='ZugriffZaunApiTest')
```
