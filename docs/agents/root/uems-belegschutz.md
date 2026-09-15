# UEMS-Belegschutz: was ein freigegebener Bericht zitiert, lässt sich nicht löschen (AP-12 IP-12)

Paket AP-12 §8 IP-12 (E13 S2, Referenzfall B12), dazu firstmate 001 = A: zwei Kundenwege über die §8-Zelle hinaus.
Keine Migration. Tests `UemsBelegschutzApiTest` (B12 Ende zu Ende), `KomponenteLoeschenBelegschutzTest`, Portal
`GeraetGefahrenzone.test.tsx`, Bühne `e2e/belegschutz.spec.ts` (`BELEGSCHUTZ_BILDER=<Ordner>`).

## Die Regel

Ein freigegebener Berichtsstand — auch ein ersetzter — zitiert **Messstellen** (`bericht_quelle`: unmittelbar,
mittelbar, Vergleich), nie eine Komponente, Box oder Anlage. `uems_berichts_belege(objekt)` (IP-4) beantwortet „welche
Stände zitieren diese Messstelle“; Entwürfe schützen nichts. Java `uems/BerichtsBelege` geht vom Löschgegenstand zu
seinen Messstellen:

- **Komponente**: jede Messstelle, deren Quelle sie JE war — `messstelle_quelle` (laufend oder beendet), Protokoll
  `quelle_gebunden` (überlebt die Bindungs-Zeile), Messkanal-Term einer Formel; dieselbe Menge wie
  `uems_messreihen_belege`. Eine beendete Bindung schützt also weiter. `pruefeKomponente(site, entity)` wirft
  `BelegeImWeg` mit Gegenstand `KOMPONENTE`.
- **Anlage, Box**: die Messstellen aus `MessreihenBelege`. Ohne Messstellen-Beleg gibt es keinen Berichts-Beleg — an
  diesen Wegen entsteht keine neue Ablehnung, die Antwort bekommt nur die zweite Liste.

## Die Wege

| Weg | Route | Prüfung, jeweils vor dem ersten Schreiben | Antwort |
|---|---|---|---|
| Komponente entfernen (Gefahrenzone, „Zuordnung ändern“) | `DELETE /api/v1/sites/{id}/v2-entities/{entityId}` | `SiteEntityAdoptController.delete`, nach den Grundausstattungs-Wächtern | 409 `berichts_belege` |
| Selbst definiertes Gerät, eigene Batterie | `DELETE …/components/custom/{id}`, `…/components/battery/{id}` | `SelfBuildComponentService`/`UserDefinedBatteryService.delete`, nach 404/409/422, vor `retireActive` | 409 `berichts_belege` |
| Batterie am Standort abmelden ⁺ | `DELETE /api/v1/sites/{id}/battery` | `SiteBatteryController`, vor Asset, Claim und Komponente | 409 `berichts_belege` |
| Verbraucher entfernen ⁺ | `DELETE /api/v1/sites/{id}/consumers/{id}` | `ConsumerService.delete`, nach „noch verbunden“ | 409 `berichts_belege` |
| Datenaufzeichnungen löschen | `POST /api/v1/devices/{id}/purge-data` (+ MQTT) | `DevicePurgeService.purge` (IP-11) | 409 `messstellen_belege` + `berichtsstaende` |
| Anlage entfernen | `DELETE /api/v1/sites/{id}` | `SiteController.deleteSite` (IP-11) | 409 `messstellen_belege` + `berichtsstaende` |

⁺ nicht in der §8-Zelle — dieselbe Komponenten-Zeile, derselbe CASCADE auf `messstelle_quelle`. Der Verbraucher-Fall
tritt heute ein: eine Box liest den Verbraucher ohne Geräte-Pin, die Box wird abgemeldet, der Verbraucher ist damit
„unverbunden“ und war löschbar.

Frei bleiben (S3): Box abmelden, Ort archivieren, Umziehen, Beenden.

## Körper

`BelegeImWeg.koerper()` = `{code, codes, message, messstellen: [{id, kennzeichen, name}], berichtsstaende: [{kennung,
nr}]}`; `codes` in fester Reihenfolge `messstellen_belege`, `berichts_belege`, `code` ist der erste. An der Komponente
sind `messstellen` die zitierten Messstellen, die sie speiste. Satz der Komponente = Vertragssatz
`BerichtRegeln.berichtsBelege` (B12-Vektor); Anlage und Box: der IP-11-Satz + „Freigegebene Berichtsstände, die sie
zitieren: …“. OpenAPI `components/schemas/BelegeImWeg`.

## Portal

`GeraetGefahrenzone`: eine 409 mit `berichts_belege` schließt die Rückfrage, die Zone zeigt den Vertragssatz
(`uemsBericht.berichtsBelege`) und je Messstelle „Zur Messstelle …“ — reine Ableitung `geraetLoeschen.berichtsBelegAus`.
Jede andere Ablehnung bleibt in der Rückfrage. `ZuordnungAendern` zeigt den Server-Satz wie jede Ablehnung.

## Fallen und Befunde

- ⚠ Ein neuer Weg, der `measurement_point` löscht, braucht `pruefeKomponente` — `messstelle_quelle` hängt per
  CASCADE daran.
- Ohne Schutz: das Verwaltungs-Löschen `DELETE /api/v1/admin/sites/{id}/v2-entities/{pointId}` und das Re-Pin-Aufräumen
  (`EntityRegistryService.releaseStalePoint`) — Aufgabe `vp-uems-belegschutz-verwaltungswege`.
- Purge an einer abgemeldeten Box ist 404 (IP-11) und erreicht die Prüfung nicht; B12 prüft Purge VOR dem Abmelden.
- Ort archivieren ist wie heute gesperrt, solange eine Messstelle dort AKTIV ist (AP-02 IP-15 `messstelle_aktiv`); ein
  Beleg fügt keinen Grund hinzu. Der Test zieht MS-12 vorher nach G-2 um.
- Der Satz erscheint NACH dem Bestätigen (nichts geschrieben), nicht statt der Rückfrage wie in Konzept §5.7 — eine
  Vorab-Prüfung bräuchte eine lesende Route.
- Das Portal hat keinen Knopf „Bindung beenden“, obwohl `PUT /api/v1/messstellen/{id}/quellen/{quelleId}/beenden`
  existiert; der Weg aus der Gefahrenzone führt darum zur Messstelle.
