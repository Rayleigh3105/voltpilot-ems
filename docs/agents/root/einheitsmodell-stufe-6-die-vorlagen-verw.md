# Einheitsmodell Stufe 6: die VORLAGEN-VERWALTUNG — eine geprüfte Vorlage ist ein DATENSATZ

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 29).


Der Abschluss des Programms (Scout `data/vp-komponenten-einheit-h2` Stufenplan Stufe 6 + §3.3;
`vp-modbus-baukasten-k6` §2.8 Stufe 3). Eine neue geprüfte Gerätevorlage entsteht als
Datensatz, nie als Software-Auslieferung — ein SG-Ready-Relais wird eine Vorlage statt eines
Treibers. Alles ist ADDITIV: eine Flotte, die nie eine Vorlage einträgt oder zurückzieht,
verhält sich zeichengleich wie vorher.

- **⚠ ZURÜCKZIEHEN IST KEIN LÖSCHEN, und der Filter steht INNERHALB der Fassungs-Auswahl.**
  Migration `V20260820000000` ergänzt `component_template` um `withdrawn_at`/`withdrawn_by`
  (nullbar, ohne Default, Beides-oder-keines-CHECK), und `ComponentTemplateRepository`s
  `SELECT_NEWEST` filtert `withdrawn_at IS NULL` VOR dem `DISTINCT ON`. Nur so fällt eine
  zurückgezogene Fassung 2 auf Fassung 1 ZURÜCK — genau die Handlung, die man nach einem Fehler
  braucht; stünde der Filter außen, wäre die Vorlage ganz verschwunden. Eine laufende Komponente
  behält ihren Fassungs-Schnappschuss (kein Fremdschlüssel, das `rollout_device.device_ref`-Muster),
  **ein DELETE gibt es deshalb gar nicht** — es wäre die einzige Handlung hier, die eine
  Kundenanlage unerklärbar machen könnte. Die Rücknahme ist umkehrbar (`/restore`).
- **⚠ EINGEBAUTE VORLAGEN SIND NICHT VON HAND EDITIERBAR, und die Ablehnung SAGT WARUM.**
  `ComponentTemplateSeeder` schreibt bei JEDEM Start die 15 `CONTENT_COLUMNS` zurück; eine
  Handänderung wäre spätestens beim nächsten Neustart lautlos weg. `ComponentTemplateAdminService`
  lehnt deshalb jede Änderung an `kind='builtin'` mit 409 ab und nennt den Weg (Go-Katalog +
  `cmd/vp-template-export` + neue Edge-Auslieferung). Admin-Ware ist ausschließlich
  `kind='certified'`.
- **Der Schlüssel wird ABGELEITET, nie getippt** (`ComponentTemplateDefinition.refFor` →
  `certified:<marke>:<modell>`): er ist per Kontrakt opak, und ein Formularfeld dafür wäre die
  Einladung, ihn „schöner" zu machen. Marke und Modell gehören damit zum Schlüssel und lassen
  sich in einer neuen Fassung nicht ändern (409) — sonst wären Schlüssel und Inhalt zwei
  Wahrheiten über dasselbe Produkt.
- **Die Regeln sind REIN** (`templates/ComponentTemplateDefinition`, Docker-frei geprüft — das
  `Tagesprotokoll`/`FleetPflege`/`SelfBuildDefinition`-Muster; alle Mängel werden GESAMMELT).
  Drei tragen Ehrlichkeit: **ein leeres `channels`/`writes`-Array wird ABGELEHNT statt still zu
  NULL gemacht** (es wäre die Behauptung „liefert keine Messwerte" bzw. „kann nichts schalten";
  die Ablehnung nennt den Weg — Feld weglassen), **jede Schreib-Fähigkeit braucht ihren
  `safe_value`** (die dritte k6-Leitplanke: was bei Stille oder Widerruf geschrieben wird; ohne
  ihn bliebe ein Gerät im zuletzt befohlenen Zustand), und **eine Vorlage mit Schreibweg muss
  `certified` sein** — „wir stehen nicht dafür ein" neben „hier ist der Schreibweg" wäre ein
  Widerspruch, und ohne Prüfung gehört der Schreibweg dem Selbstbau-Pfad mit seinem eigenen
  Schalt-Test. `builtin` ist als Prüf-Zustand NICHT wählbar (das Wort sagt „wird mit der
  Edge-Software ausgeliefert", und das wird eine von Hand eingetragene Vorlage nie).
  Einheiten und die Slug-Ableitung teilt sie WÖRTLICH mit `SelfBuildDefinition` — ein zweites
  Einheiten-Verzeichnis wäre genau die Doppeldeutigkeit, die das Einheitsmodell beseitigt.
- **Endpunkte** (`AdminComponentTemplateController`, `/api/v1/admin/component-templates`,
  **klassenweit** `@PreAuthorize("hasRole('platform-admin')")`): `GET` (ALLE Fassungen aller
  Herkunftsarten inkl. der zurückgezogenen, mit der Nutzungszahl je Schlüssel) · `POST` (Fassung 1)
  · `POST /{ref}/versions` · `POST /{ref}/versions/{v}/withdraw|restore`. Geschrieben wird
  ausschließlich über `ComponentTemplateAdminRepository` an der BYPASSRLS-Rolle `voltpilot_admin`
  — `V20260815000000` nimmt der App-Rolle INSERT/UPDATE/DELETE ausdrücklich weg, und
  `ComponentTemplateApiTest.theAppRoleMayReadTemplatesButNeverWriteThem` nagelt das fest.
  **Klassenweit statt je Methode**, weil ein neu hinzugefügter Endpunkt sonst auf die
  Filter-Regel für `/api/v1/admin/**` zurückfiele, die auch die schmale
  `edge-release-publisher`-Rolle zulässt.
- **Die Betriebs-Sicht `GET /api/v1/admin/component-fleet`** (`AdminComponentFleetController` +
  `AdminComponentFleetRepository`, read-only, kein einziger Schreibpfad): eine Zeile je Anlage
  über ALLE Mandanten — Pflege-Ort (`component_authority`), Herkunft der Anbindungen
  (`source_kind`-Zähler), Soll ≠ Ist und die drei Freigabe-Stufen des Konzepts §3.3
  (plattform-scharfgeschaltete Geräte · Komponenten auf einer Vorlage MIT Schreib-Definition ·
  die vom GERÄT gemeldete `cert_source`). Sieben plattformweite gruppierte Aggregate bzw.
  `DISTINCT ON`, danach nur noch `Map.get` — das N+1-Muster von `AdminFleetController.fleet()`.
  **`ComponentService.syncStatus` ist dafür öffentlich geworden**: dieselbe Frage darf nicht zwei
  Antworten haben, eine zweite Ableitung im Admin-Aggregat wäre die Doppeldeutigkeit, gegen die
  das ganze Einheitsmodell gebaut ist. Eine Anlage ohne Zeile FEHLT in der Map — „nicht
  gemessen" ist weder `null` noch `0`.
- **Private Vorlagen sind vollständig** (die Stufe-3-Tabelle `site_component_template`, RLS):
  `PUT /sites/{id}/component-templates/{ref}` benennt um (VOLLE Darstellung von Name und Notiz;
  leerer Name 400, leere Notiz LÖSCHT sie; **keine neue Fassung** — eine Vorlage IST ihr
  Leseplan, und ein Name ändert daran nichts), `DELETE` entfernt, und die Duplizier-Route nimmt
  ihren Namen jetzt über ein validiertes DTO statt einer rohen `Map<String,String>`.
  **Die Adresse des Originals reist wie bisher NICHT mit** — sie ist die Eigenschaft EINES
  Exemplars, nicht des Gerätetyps.
- **Portal:** zwei Plattform-Seiten (`pages/admin/VorlagenPage.tsx` „Gerätevorlagen",
  `KomponentenFlottePage.tsx` „Komponenten") über den reinen Schichten `src/adminVorlagen.ts` +
  `src/adminKomponentenFlotte.ts`, und die Kunden-Fläche „Meine Vorlagen"
  (`components/EigeneVorlagenPanel.tsx` + `src/eigeneVorlagen.ts`) in der Komponenten-Kapsel des
  Anlagen-Modells. Details in `frontend/portal/AGENTS.md`.
- **Politur:** die zwei nativen Rückfragen des Entitäts-Löschens (deren zweite die kWp-Folge in
  einem `\n\n`-Fließtext beschrieb) sind EIN Haus-`ConfirmDialog` mit Folgenliste geworden —
  `ConfirmDialog` bekam dafür den additiven `extra`-Slot für GENAU EINE zusätzliche Entscheidung
  (zwei Rückfragen hintereinander sind das, was der Dialog abschafft). Aufgeräumt: das tote
  `roleLabel` in `edge-app/core/internal/web/static/sources.js` (eine Definition, null Aufrufer im
  ganzen Repo — seit dem Stufe-2-Umbau rendern die Quellen-Zeilen nach Rollen-GRUPPE).
- **Beweise:** rein `ComponentTemplateDefinitionTest` (13) · Testcontainers
  `ComponentTemplateAdminApiTest` (7: die Reise anlegen→versionieren→zurückziehen→freigeben
  inklusive des Rückfalls auf die Vorgänger-Fassung, „zurückziehen bricht keine Komponente" gegen
  echte DB-Zeilen, eingebaut nicht editierbar MIT Grund, jede Ablehnung ohne Schreibvorgang,
  private Vorlagen hinter dem Besitzer-Zaun, die Flotten-Sicht über zwei Mandanten mit ehrlichem
  „unreported", Rollen-Grenze) · Portal `adminVorlagen.test.ts` (12) ·
  `adminKomponentenFlotte.test.ts` (8) · `eigeneVorlagen.test.ts` (8) · `VorlagenPage.test.tsx` (8)
  · `KomponentenFlottePage.test.tsx` (6) · `EigeneVorlagenPanel.test.tsx` (9). Im echten Chrome
  bei 1440 und 375 gemessen: 0 px horizontaler Überlauf, keine Konsolenfehler.
- **NICHT in dieser Stufe:** der Schalt-Executor und der Freigabe-Assistent (Stufe 4, parallel) ·
  HTTP/MQTT-Anbindungsarten (3b) · Vorlagen-Teilen zwischen Kunden (bewusst nie — Captain-Entscheid
  „privat je Anlage").
