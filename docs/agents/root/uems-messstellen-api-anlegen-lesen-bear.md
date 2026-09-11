# UEMS-Messstellen-API: anlegen, lesen, bearbeiten, anhalten, fortsetzen, archivieren

Neu am 11.09.2026 (AP-04 IP-3). `POST/GET /api/v1/messstellen`, `GET/PUT …/{id}`,
`POST …/{id}/anhalten|fortsetzen|archivieren`, `GET …/kennzeichen-vorschlag` — Controller
`services/api/.../web/MessstelleController.java`, Arbeit in `uems/MessstelleService.java`, Formen
in `web/dto/MessstelleDto.java`, OpenAPI-Tag `messstellen` in `docs/contracts/openapi.yaml`.
Beweis: `uems/MessstelleApiTest` (Testcontainers + Keycloak, spielt die Kennzeichen-, Größen- und
herstellbaren Lebenszyklus-Fälle von `messstelle-vectors.json` über HTTP) und
`uems/MessstelleSchnittstelleVertragTest` (rein: DTO ⟷ OpenAPI ⟷ `messstelle.schema.json`).
Unterbau: `uems-messstellen-tabellen-messstelle-ne.md`, Regeln: `uems-messstellen-vertrag-kennzeichen-gro.md`.

## ⚠ Die Fallen

- **snake_case, anders als der Rest der API.** Die Antwort IST eine Messstelle nach
  `messstelle.schema.json` plus `id`, `fehlt`, `angehalten_ab`, `archiviert_am`. Wer ein Feld
  ergänzt (IP-7 Ort/Stellung, IP-13 Quellen), ergänzt DTO, OpenAPI und — falls neu — das
  Schema zusammen; `MessstelleSchnittstelleVertragTest` wird sonst rot.
- **Die Anfrage wird STRENG gelesen.** Ein unbekanntes Feld ist 400 `anfrage_ungueltig` mit
  `feld` (nie still verworfen — ein mitgeschickter Ort wäre sonst scheinbar gespeichert).
  `@JsonIgnoreProperties(ignoreUnknown = false)` erzwingt das NICHT (Spring Boot schaltet
  `FAIL_ON_UNKNOWN_PROPERTIES` global ab); der Controller liest `JsonNode` mit
  `ObjectMapper.copy().enable(FAIL_ON_UNKNOWN_PROPERTIES)`.
- **Keine zweite Regel-Logik.** Kennzeichen-Form/-Belegung, Größen-Katalog und Lebenszyklus
  urteilt `MessstelleRegeln`; der Status eines Vertrags-Codes kommt aus `MessstelleRegeln.Fehler`.
  Die Schnittstelle hat drei EIGENE Codes (`MessstelleAbgelehnt.Schnittstelle`):
  `anfrage_ungueltig` 400, `zustand_passt_nicht` 409, `zeitpunkt_in_zukunft` 422. Der
  OpenAPI-Enum `MessstelleFehler.code` ist gegen `MessstelleAbgelehnt.CODES` gepinnt.
- **Der Urheber hat EINE Stelle: `uems/ProtokollAkteur`.** Kundenbenutzer →
  `kundenadministrator`/`kunde` (AP-03 E12), Plattform-Admin (über `X-Tenant-Id`) →
  `voltpilot_betrieb`/`voltpilot`. Die Rechte-Matrix gibt `voltpilot_betrieb`
  `messstelle.bearbeiten` NICHT — bis AP-03 durchsetzt, gilt `authenticated()` + RLS wie unter
  `/api/v1/sites/**`; jede Route nennt ihre Kennung nur im Kommentar.
- **Ohne Ort ist jede gemessene Messstelle ein Entwurf** (`fehlt: ["ort"]`), eine berechnete ohne
  Formel ebenso — ehrlich, bis IP-7/AP-10 kommen. Die Stufe wird abgeleitet, nie gespeichert.
- **Übergänge:** Zeitpunkt auf die Minute (sonst 400), Vorgabe jetzt, vor jetzt = rückwirkend im
  Protokoll, die ZUKUNFT nicht (die Tabelle kennt nur den heutigen Eingang `angehalten_ab` — ein
  angekündigtes Anhalten verlöre sein Ende beim Fortsetzen). Jeder Übergang liegt STRENG NACH dem
  letzten Anhalten/Fortsetzen (422 `zeitpunkt_vor_vorgaenger`, A15); wann zuletzt fortgesetzt
  wurde, weiß nur `messstelle_aenderung` (`MessstelleAenderungRepository.letzterUebergang`).
  Archiviert ist eingefroren: jeder weitere Schreibvorgang 409.
- **Medium:** die Schnittstelle nimmt das volle Vokabular über den Größen-Katalog (Gas/Volumen =
  MS-21 anlegbar); „nur Strom“ (AP-00 E11) und „kein berechnet“ (E9) sind Regeln der FLÄCHE.
- **Genau ein Protokolleintrag je Schreibvorgang**, keiner bei Ablehnung oder unverändertem PUT;
  `alt`/`neu` tragen bei „bearbeitet“ nur die geänderten Felder.
- **Tests laufen gegen die echte Uhr:** Übergänge mit Zeitpunkten in der Vergangenheit; die
  Ahrenberg-Archivierung am 30.06.2027 (A13) ist über die Schnittstelle nicht nachspielbar.
