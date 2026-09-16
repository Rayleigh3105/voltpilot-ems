# Ein Summenwert-Assistent (H-5/H-6)

Autorität: [Rollen-Vertrag](../../contracts/v2/rollen-zuordnung.md),
[Formel-Vertrag](../../contracts/v2/messstelle-formel.md),
[H-1/H-2](uems-rollen-zuordnung.md).

- `frontend/portal/src/components/SummenwertAssistent.tsx` implementiert den einen
  Fluss: Register wählen → Rechnen → Name → Rolle → Fertig. Der frühere
  `GesamtwertDialog.tsx` ist nur noch ein kompatibler Einstieg ohne Vorauswahl;
  auch der Kennzahlen-Dialog verwendet ihn. Keine zweite Quellen-/Speicherlogik.
- Karten verwenden `useSummenwertAssistent()`: der Hook liefert
  `oeffneSummenwertAssistent({siteId, deviceId?, entityId?, geraetName?, onGespeichert?})`
  und `assistent` zum Rendern. `onGespeichert` lädt die Anzeige neu und schließt
  **nicht**; „Fertig“ bleibt bis zur ausdrücklichen Bestätigung sichtbar.
- Quellenliste: `GET /api/v1/sites/{siteId}/summenwert-quellen` ordnet Komponenten
  ihrer lesenden Box über **dieselbe `PushJeBox`-Regel wie der Registry-Push** zu.
  `measurement_point.device_id` darf null sein und ist deshalb keine vollständige
  Quellenliste. Ohne zuständige Box bleibt das Gerät mit Grund sichtbar.
- Je gebundener Komponente wird der volle verfügbare Registerkatalog paginiert
  gelesen. Die Geräte-Vorauswahl betrifft nur beobachtete Erzeugungsregister;
  die Anlage startet leer. Weitere Geräte bleiben innerhalb derselben Anlage.
- `summenwertQuellen.ts` enthält den Guard, Sitzungswerte und Stand-Text.
  Ein Sitzungswert überstimmt den Katalogzustand, auch bei einem Lese-Fehler.
  Fehlende/veraltete Eingänge ergeben keine Teilsumme; gerechnet wird nur durch
  `gesamtwert.vorschau` → `gewichteteSumme`.
- Einmal-Lesung: `POST /api/v1/devices/{deviceId}/measurement-selection/lesen`
  mit `entityId` und `pointKey`; `messwerte.ansehen`, keine Selektion, kein Journal.
  `MeasurementPointReadService` nimmt Ziel/Adressen/Skala aus Bindung und Katalog,
  liest über die vorhandene **Vorschau-Lane** (`RegisterWriteService.preview`),
  ausschließlich Modus `lesen`. Das unterstützt auch Solarman, ohne einen zweiten
  Socket zu öffnen. Nicht benachbarte Registerwörter bleiben in Katalogreihenfolge.
- Unterstützt: numerische 16-/32-bit Holding/Input-Register, bekannte Wortfolge,
  Skala `none`, `factor`, `divisor`. Dynamische/bedingte Skalen und andere
  Protokolle werden mit `nicht_lesbar` benannt, niemals geraten. Keine neue
  Edge-Version oder Schreibfreigabe. Bestehender Register-Not-Aus bleibt wirksam.
- Noch unbeobachtete Register werden höchstens einmal je Dialogsitzung gelesen.
  Beobachten erfolgt erst beim Speichern, mit frischer Revision je Box und UUID
  als Idempotenzschlüssel. Die Budgetzeile bleibt sichtbar.
- Rollen-Vorgabe: keine. PV benötigt Erzeugungsleistung, Verbrauch Bezugsleistung,
  Netz richtungslose Leistung (z.B. Bezug minus Abgabe). Rolle nur mit
  `geraet.einrichten`, Anlegen nur mit `messstelle.formel` aus `rollen.ts`.
  Vor Ersetzen werden die aktuellen Halter gelesen und ausdrücklich bestätigt.
- Speichern verwendet H-10: **ein** `POST …/messstellen/berechnet` mit optionalem
  `rolle: {entity_id, role, ersetzen}`. Keine zweistufige Rollen-Kompensation.
- Kundenwort `SUMMENWERT`; `GESAMTWERT` ist nur noch ein gleichwertiger Alias für
  ältere Aufrufer. Seit H-9 hat der Textwächter keine Alttext-Ausnahmen mehr.

Prüfen: `DeviceMeasurementSelectionApiTest`, `SummenwertQuellenServiceTest`,
`RechtRoutenArchitekturTest`, `RechteKennungenDerRoutenTest`; Vitest
`gesamtwert`, `summenwertQuellen`, `components/GesamtwertDialog`, `kennzahlAnlegen`,
`components/KennzahlAnlegenDialog`, `copy`, `migration`, `uemsKeineRechnung`;
Playwright `summenwert`, `gesamtwert`, `summenwert-hybrid`, `kennzahl-anlegen`.
Die E2E-Bühnen stellen Uhr/Cloud; keine echten Kundenwerte fotografieren.
