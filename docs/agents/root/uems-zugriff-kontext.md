# UEMS-Zugriff-Kontext je Anfrage und die Selbstauskunft `/me` (AP-03 IP-4)

Neu angelegt am 15.09.2026. Spezifikation: AP-03 §6.2 (Punkte 1–2, Schnittstellen-Tabelle), W3, §8 IP-4. Code:
`zugriff/ZugriffContext`, `zugriff/ZugriffKontextLader`, `zugriff/ZugriffFilter` (in `SecurityConfig` direkt nach dem
`TenantFilter`), `tenant/TenantAwareDataSource` (Sitzungs-Einstellungen), `zugriff/Selbstauskunft`, `web/MeController`,
`web/dto/SelbstauskunftDto`, `zugriff/RechteMatrixDatei`. Schnittstelle: OpenAPI `/api/v1/me`, `Selbstauskunft*`,
Parameter `Kundenbereich`, Tag `zugriff`; Typen `Selbstauskunft*` in `frontend/portal/src/api.ts`. Beweis:
`TenantAwareDataSourceSitzungTest`, `SelbstauskunftApiTest` (gegen `rechte-vectors.json`), `ZugriffZaunApiTest` (alle
Routen), `SelbstauskunftSchnittstelleVertragTest`, `RechteKennungenDerRoutenTest`.

## Was gilt

- Je Anfrage unter `/api/v1/` (nicht `/api/v1/admin/**`) lädt der Filter den `ZugriffContext`. Er enthält die
  Kontoart aus `KONTO_*`, den Kundenbereich, die wirksamen Zuweisungen und den Zugang:
  - `konto`: das Kundenkonto. Der Kundenbereich kommt aus dem Token, geladen werden alle wirksamen Zuweisungen. Ein
    Kundenkonto wird nie abgewiesen.
  - `unterstuetzung`: Partner oder Plattform mit `X-Kundenbereich`. Der Kopf wird NUR gegen eine wirksame
    Unterstützung in genau diesem Kundenbereich angenommen (Partner: `installateur`; Plattform: `voltpilot` oder
    `notfall`). Dann setzt der Filter den `TenantContext`.
  - `umschalter`: die Plattform ohne `X-Kundenbereich` mit `X-Tenant-Id`, wie vor IP-4. Die Umstellung ist IP-8 (W3).
- **Abgewiesen** werden ein Partner ohne Kopf und Partner oder Plattform mit einem Kopf ohne wirksame Unterstützung.
  Die Antwort ist 404 per `sendError` auf JEDER Kundenroute, auch für Methoden, die es dort nicht gibt. Nur
  `/api/v1/me` antwortet 200 ohne Kundenbereich.
- **Sitzungs-Einstellungen** in derselben `set_config`-Anweisung wie `app.tenant_id`, beim Zurückgeben zusammen
  zurückgesetzt:
  - `app.zugriff` ist `unternehmen` bei einem Kundenkonto mit wirksamer mandantenweiter Zuweisung oder ganz ohne je
    eine Zuweisung (E12, seit IP-5) und am Umschalter, sonst `standorte`.
  - `app.standort_ids` ist das Array-Literal `{uuid,…}` der standortbezogenen Zuweisungen, sortiert, auch `{}`.
- **`GET /api/v1/me`** (Recht `konto.eigenes`) leitet ausschließlich mit `RechteAbleitung` ab:
  - `sichtbareStandorte` liefert Standorte, künftige Zuweisungen, den Satz ohne Standort und die Teilansicht.
  - `darf` für jede Aktion der GANZEN Matrix liefert `rechte` je Standort und `unternehmen_rechte`; dazu `ocppStufe`.
  - `unterstuetzung` liefert die Banner-Sätze.
  - Außerdem: Kundenadministratoren (wirksam), `eigene` Unterstützungen (Partner, Plattform), `gewaehrte` (Kundenkonto).

## ⚠ Fallen für die Folgepakete

- ⚠ **`site_scope` (IP-5, `uems-standort-zaun.md`):** Ohne Zugriff sind beide Einstellungen LEER: `''` nach einem
  Zurücksetzen, NULL auf einer frischen Verbindung. Das betrifft Jobs, Takt, Bestandslauf, Admin-Routen und die
  Plattform ohne Kopf. Die Policy liest leer als „kein Standort-Zaun" (nur Mandant). Ein Kundenkonto, das NIE eine
  Zuweisung hatte, trägt `unternehmen` (Bestandsregel E12); eines mit nur beendeten oder künftigen `standorte` + `{}`.
- ⚠ Die Einstellungen gelten nur, wenn der `TenantContext` der Kundenbereich des Zugriffs ist. Ein Hörer, der im
  Anfrage-Thread umschaltet (`ZugriffBestand.beiAnlage`), bekommt sie leer.
- ⚠ **Seit IP-5 liest ein angenommener Unterstützer nur seine Standorte; bis IP-6 schreibt er dort wie ein
  Kundenkonto.** Heute legt keine Route eine Unterstützung an (IP-8). Wer IP-8 vor IP-6 ausliefert, öffnet genau das.
- ⚠ **Nicht umgestellt:** `KennzahlAufrufer`, `KorrekturRechte.benutzer`, `BerichtRechte` und `ProtokollAkteur` legen
  die Rolle weiter fest (Kundenkonto = Kundenadministrator). Wer durchsetzt, liest `ZugriffContext.get()`, nie einen
  Anfragekörper.
- ⚠ **Die Matrix zur Laufzeit** ist die Vertragsdatei selbst: `pom.xml` legt `docs/contracts/v2/rechte-matrix.json`
  als `uems/rechte-matrix.json` ins Jar, das `Dockerfile` kopiert sie in die Build-Stufe. Eine neue Build-Umgebung
  braucht dieselbe Zeile, sonst scheitert NUR `/me` (die Datei wird erst beim ersten Aufruf geladen). Die Routen mit
  wenigen Zeilen behalten ihre gepinnte Kopie.
- ⚠ Name und Zustand kommen aus dem Spiegel `benutzer`; ohne Spiegel gelten der Token-Name und `aktiv`. `angelegt`
  bleibt `angelegt` und hat in `/me` keine Rechte, bis IP-14 den Übergang bei der ersten Anmeldung schreibt.
- ⚠ Archivierte Standorte zählen nicht, weder als sichtbar noch in `gesamt`.
- ⚠ `eigene` Unterstützungen stehen nur im angenommenen Kundenbereich. Die Liste ALLER Kundenbereiche eines Partners
  (Wechsel) ist IP-8 und braucht einen eigenen, kontogebundenen Leseweg.
- ⚠ `gewaehrte` Unterstützungen erscheinen nur an sichtbaren Standorten, und der Banner-Satz nennt nur sichtbare
  Standortnamen.
- ⚠ **Abweichung vom Vektor:** Bei nicht angenommenem `X-Kundenbereich` fehlt in `/me` die `teilansicht`. Der Vektor
  `voltpilot-ohne-gewaehrung-sieht-nichts` nennt `gesamt`, doch über einen nicht angenommenen Kundenbereich steht
  nichts in der Antwort.
- ⚠ **Tests:** `authentication(new KeycloakRealmRoleConverter().convert(jwt))` statt `jwt()`, sonst fehlt `KONTO_*`
  und damit der Kontext. Die Uhr stellt `ZugriffKontextLader.uhrStellen` (Filter UND `/me`).
- ⚠ **Kosten:** eine Abfrage (`ZugriffRepository.wirksam`) je Kundenanfrage eines Kundenkontos. Ein Lesefehler lässt
  den Kontext eines Kundenkontos ohne Zuweisung und weist Partner oder Plattform ab. Zähler:
  `voltpilot_zugriff_kontext_total{ergebnis="unterstuetzung|abgewiesen|fehler"}`.
- CORS erlaubt `X-Kundenbereich`.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='TenantAwareDataSourceSitzungTest,SelbstauskunftSchnittstelleVertragTest,RechteKennungenDerRoutenTest')
(cd services/api && ./mvnw test -Dtest='SelbstauskunftApiTest')
(cd services/api && ./mvnw test -Dtest='ZugriffZaunApiTest')
```
