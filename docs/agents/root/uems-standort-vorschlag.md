# UEMS: Standort-Vorschlag bestätigen

AP-02 IP-10 schließt die in `standort_vorschlag` wartende Bestandsübernahme ab.

- `GET /api/v1/standorte/vorschlag` ist strikt lesend und liefert zunächst eine Gruppe je Anlage.
- `POST /api/v1/standorte/vorschlag/bestaetigen` verlangt jede aktuell offene Vorschlagszeile genau einmal. Die Gruppen dürfen zusammengelegt und Name sowie Adresse geändert werden.
- Erst die Bestätigung legt Standorte, Zuordnungen ab dem ursprünglichen Tag von `site.created_at` und die vorhandenen Ortsprotokolle an. Alles geschieht in einer Transaktion; eine veraltete Vorschau ist `409 vorschlag_geaendert`.
- `V20260916230000` gibt der API nur das zum Verbrauch der bestätigten Vorschlagszeilen nötige `DELETE`; RLS und `FORCE ROW LEVEL SECURITY` bleiben aus `V20260911290000` bestehen.
- Im Portal lädt `PortfolioCockpit` die additive Karte nur auf der Unternehmensebene, mit `standort.verwalten` und mindestens einem Vorschlag. Ohne Vorschläge bleibt das Portfolio zeichengleich. `StandortVorschau` kann jede Anlage über „Gehört zu“ in eine andere Gruppe legen oder wieder zu einem eigenen Standort machen; leere Gruppen verschwinden. Die Abkürzungen „alle zusammen“ und „wieder getrennt“ bleiben erhalten. Name, Adresse und Zeitzone gelten je Zielgruppe; `AnlagenTabelle` zeigt den Chip nur für die betroffenen Anlagen.
- Alle Gruppierungsänderungen laufen durch die reine Funktion `gruppierungAendern` in `standortVorschlag.ts`; `wasSichAendert` erhält danach die tatsächliche Zahl der Zielgruppen. Deshalb verspricht 2 + 1 die Unternehmens-Übersicht, 3 → 1 dagegen nicht.

Prüfstellen: `BestandsuebernahmeApiTest#vorschauZusammenlegenUndBestaetigen` (U2: 2 + 1), `PortfolioCockpit.test.tsx`, `standortVorschlag.test.ts`, `standort-vorschlag.spec.ts`, `migration.test.ts`.
