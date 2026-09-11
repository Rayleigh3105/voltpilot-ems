# UEMS-Bestandsübernahme der Standorte: eine Anlage automatisch, mehrere als Vorschlag

Neu am 11.09.2026 (AP-02 IP-9; Entscheide E5 = A, E9, E10 = A, Abnahme A5/A6, §6.3, W5).
Regel als reine Funktion: `services/api/.../uems/BestandsuebernahmeAbleitung.java` mit dem
TS-Zwilling `frontend/portal/src/uemsBestandsuebernahme.ts`, Vektoren in der Familie
`bestandsuebernahme` von `docs/contracts/v2/ortsbaum-vectors.json` (12 Fälle, Schema
`ortsbaum.schema.json`). Angewandt: `uems/BestandsuebernahmeService` (je Kundenbereich EINE
Transaktion) über den Start-Läufer `uems/BestandsuebernahmeLaeufer`. Anlage anlegen und löschen:
`uems/AnlageStandortService` + `web/SiteController`. Migration `V20260911290000`
(`standort_vorschlag`). Beweis: `uems/OrtsbaumAbleitungVectorsTest` (Regel),
`uems/BestandsuebernahmeApiTest` (Dev-Saat: A5 für `demo2` UND das Referenzunternehmen,
A6 für `demo`, zweiter Lauf, `POST`/`DELETE /api/v1/sites`, Zaun, Rücknahme),
`uems/UemsStandortVorschlagMigrationTest`, `uems/BestandsuebernahmeWiringTest`.

## Die Regel (eine Frage nach der anderen)

1. kein Unternehmen · keine Anlage · **schon ein Standort — auch ein archivierter** → nichts.
2. schon Vorschläge → der Vorschau-Weg bleibt: nur eine Anlage OHNE Vorschlag bekommt ihren,
   nie ein automatischer Standort (auch dann nicht, wenn nur noch eine Anlage übrig ist).
3. **genau eine Anlage** → Standort mit ihrem Namen, Zustand `entwurf`, „es fehlt: Adresse“
   (nie eine erfundene), Zeitzone des Unternehmens, Zuordnung ab dem TAG von
   `site.created_at` in dieser Zeitzone.
4. **mehrere Anlagen** → je Anlage eine Zeile `standort_vorschlag`, KEINE Zuordnung.

Der Name folgt der Namensregel des Standorts: ohne Randleerzeichen, höchstens 120 Zeichen
(nach Unicode-Zeichen), leer → das Kundenwort „Standort“.

## ⚠ Die Fallen

- **Der Läufer läuft beim START, nicht getaktet.** `voltpilot.uems.bestandsuebernahme.enabled`
  ist in `application.yml` AN und im Testlauf AUS (surefire-Eigenschaft in `pom.xml`) — sonst
  bekäme `demo2` in JEDER Testklasse mit Dev-Saat (`@ActiveProfiles("local")`) einen Standort
  und `demo` drei Vorschläge. Wer ihn prüft, ruft `lauf()` selbst. Keine Flyway-Migration:
  die Regel lebt in Java, ist Vertrag mit einem Zwilling und muss abschaltbar bleiben.
- **Ein Kundenbereich ohne Standort, der seine erste Anlage anlegt, wartet auf den nächsten
  Start.** `POST /api/v1/sites` ordnet nur zu, wenn es schon einen Standort gibt (§6.3: bis
  dahin „noch nicht zugeordnet“).
- **`POST /api/v1/sites` nimmt additiv `standortId`** — bei genau einem Standort vorbelegt,
  bei mehreren Pflicht (422 `standort_waehlen` mit der Auswahl in `standorte`), ein
  archivierter 409 `ziel_archiviert`, ein unbekannter oder fremder 400 `anfrage_ungueltig`
  (`feld: standortId`). Nur DIESE Route liest das Feld: die Plattform-Route
  `POST /api/v1/admin/tenants/{tenantId}/sites` überliest es und legt ohne Zuordnung an.
  Mehrere Standorte entstehen heute nur über `POST /api/v1/standorte`.
- **W5 — die Anlage darf gehen, ihre Zuordnung bleibt.** `V20260911290000` lässt den
  Fremdschlüssel `anlage_standort_site_fk` fallen (sonst endete „Anlage löschen“ für jede
  zugeordnete Anlage in einem Fehler 500); seine EINFÜGE-Hälfte hält ein Trigger mit
  DERSELBEN Ablehnung (23503, Constraint-Name `anlage_standort_site_fk`, `FOR KEY SHARE` auf
  die Anlage). Beim Löschen endet das Intervall heute (ein erst später beginnendes wird
  aufgehoben) und ein Eintrag `geloescht` am Objekt `anlage` bleibt stehen.
- **Ein Vorschlag ist keine Zuordnung.** `standort_vorschlag` hat keine Historie: er geht mit
  seiner Anlage (`ON DELETE CASCADE`) und bekommt KEINEN Protokolleintrag. Die App-Rolle darf
  nur lesen und anlegen; was die Vorschau mit ihm tut, bringt IP-10.
- **Protokoll: „VoltPilot (Bestandsübernahme)“** (`ProtokollAkteur.bestandsuebernahme()`,
  `akteur_sub` NULL) — je angelegtem Standort und je Zuordnung genau EIN Eintrag, beide mit
  „gilt ab“ = dem Tag der Zuordnung; bei einer Bestandsanlage von 2024 ist das rückwirkend
  (A5: 12.03.2024, 933 Tage). Das `created_at` des Standorts bleibt der ehrliche Zeitpunkt —
  dass er FRÜHER besteht, leitet das Lesemodell aus der Zuordnung ab (IP-3).
- **Der Lauf ändert keine Anlage.** Er schreibt nur in `standort`, `anlage_standort`,
  `ort_aenderung`, `ort_kurzzeichen(_seq)` und `standort_vorschlag` und kennt keinen
  Publisher; die einzige sichtbare Folge ist das additive Feld `standort` an
  `/api/v1/overview` und `/api/v1/sites/{id}` der einen zugeordneten Anlage
  (`BestandsuebernahmeApiTest` prüft jede andere Tabelle auf Zeichengleichheit).
- **Rücknahme (§6.3): Zuordnung aufheben, Standort archivieren — die Anlage bleibt.** Der
  nächste Lauf legt nichts wieder an, weil auch ein archivierter Standort zählt.
- **Nicht hier:** die Vorschau-Fläche und das Bestätigen/Zusammenlegen der Vorschläge (IP-10),
  der Umzug einer Anlage (IP-11), die Einführung im Großen (AP-14).
