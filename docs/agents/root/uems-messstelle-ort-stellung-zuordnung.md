# UEMS-Messstelle zuordnen: Ort und elektrische Stellung, zeitgültig je Tag

Neu am 11.09.2026 (AP-04 IP-7, Teil Ort und Stellung). Tabellen `messstelle_ort` und
`messstelle_stellung` (Migration `V20260911230000`), Routen `PUT /api/v1/messstellen/{id}/ort`,
`PUT …/{id}/stellung`, `GET …/{id}/standort?am=` — Arbeit in `uems/MessstelleZuordnungService`,
Lesen in `uems/MessstelleService` (`orte`, `elektrische_stellung` der Antwort),
`uems/MessstelleZuordnungRepository`. Die Bean hinter dem Haken `OrtsbaumMessstellen` ist
`uems/MessstelleOrtsbaumMessstellen` (Archiv-Sperre eines Standorts, `messstellenZahl` im Ortsbaum
`GET /api/v1/standorte/{id}/orte`). Beweis: `uems/MessstelleZuordnungApiTest` (baut das ganze
Referenzunternehmen über die Schnittstelle), `uems/MessstelleZuordnungMigrationTest`,
`MessstelleSchnittstelleVertragTest` (DTO ⟷ OpenAPI ⟷ `$defs/ortZuordnung|stellungZuordnung`).
**Prozess-Zuordnung** seit AP-10 IP-7: `messstelle_prozess` + `PUT …/messstellen/{id}/prozesse`
(`uems-kostenstelle-prozess.md`). Die Kostenstellen-„Zuordnung“ ist die Verteilung (AP-10 IP-8,
`messstelle_verteilung`) — eine `messstelle_kostenstelle` gibt es nicht.

## ⚠ Die Fallen

- **Keine zweite Regel-Logik.** Ort: `OrtsbaumAbleitung.eintrag` gegen DENSELBEN Baum wie die
  Standort-/Ort-Routen (`StandortService.baum(messstellen)`, Kurzzeichen als Schlüssel) — Tages-
  Mechanik UND „Ziel besteht an jedem Tag“. Stellung: `MessstelleRegeln.stellungPruefen` an JEDEM
  Tag des neuen Intervalls, an dem sich im Stand etwas ändert, für die Messstelle UND für jede, die
  an dem Tag Unterzähler von ihr ist (`betroffen`). Die Tages-Mechanik der Stellung
  (`Schritt`) ist die des Ortsbaums mit denselben `EintragGrund`-Wörtern.
- **Status:** `ort_ungueltig` 422 (Ziel unbekannt, gab es noch nicht, archiviert, `U` für eine
  gemessene — Messstellen-Vertrag §7, NICHT die 409 von AP-02), `zuordnung_ueberlappt` 409
  (`gleicher_tag` — der Weg ist `korrektur: true`), `zuordnung_unveraendert` 400, `zuordnung_ungueltig`
  422, `stellung_ungueltig` 422 / `hauptzaehler_vorhanden` 409 mit `tag`. Unbekannte Anlage: 400
  `anfrage_ungueltig` `feld: anlage` (auch eine fremde — nie verraten).
- **Der Hauptzähler und seine Quelle (IP-13).** `MessstelleZuordnungService.komponente` liest die
  Komponente der führenden Quelle der Hauptgröße an dem Tag aus `messstelle_quelle` (zu Beginn des
  Tages, sonst die erste, die an ihm beginnt). Ohne Quelle an dem Tag ist sie unbekannt, und der
  Zwilling urteilt nie „derselbe Zähler“: dann ist auch ein zweiter Hauptzähler in ANDERER Richtung
  409 — MS-02 (Abgabe) neben MS-01 (Bezug) geht mit ihren Quellen an K-3
  (`uems-quellenbindung-messstelle-messkanal.md`).
- **„Ort vorhanden“ (Lebenszyklus) = ein wirksames Ort-Intervall, gleich ab wann** — auch ein
  geplantes; WO sie an einem Tag sitzt, sagt nur `…/standort?am=` (Verortung des Ortsbaums).
- **Archivieren einer Messstelle** beendet Ort und Stellung am Vortag des Archivtags, ein erst an
  ihm oder später beginnendes Intervall wird aufgehoben (A13); der Eintrag „archiviert“ trägt
  `zuordnungen_bis`. Übergänge liegen nie vor dem Beginn (Mitternacht des ersten Orts, 422 mit `beginn`).
- **Tage in der Zeitzone des Unternehmens** (Berlin/Wien/Zürich haben dieselben Regeln).
  `rueckwirkend` im Protokoll: `gilt_ab` (Mitternacht) vor dem Eintragstag; der CHECK verlangt
  `gilt_ab < created_at` — eine Test-Uhr in der Zukunft darf deshalb keinen rückwirkenden Eintrag
  schreiben, der nach dem echten „jetzt“ liegt.
- **Serialisiert über die Sperre auf `unternehmen`** (wie `OrtService`): Hauptzähler-Regel und
  Zyklus stehen in keinem Index. Die Datenbank hält nur die zeitlose Hälfte (Vokabular, genau ein
  Ziel, Bezug ⇔ Unterzähler, nicht selbst, Überlappung `daterange(…,'[]')`, Mandant in jedem FK).
- **Tests mit dem Haken:** `StandortApiTest` legt seine Vektor-Messstellen weiter über eine
  `@Primary`-Bean in den Haken; ohne `@Primary` gäbe es zwei Beans und `getIfAvailable` wirft.
