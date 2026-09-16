# Rollen-Zuordnung (H-1)

Autorität: [Vertrag](../../contracts/v2/rollen-zuordnung.md),
[Vektoren](../../contracts/v2/rollen-zuordnung-vectors.json),
[Schema](../../contracts/v2/rollen-zuordnung.schema.json).
Zwillinge `services/api/.../uems/RollenZuordnungRegeln.java` und
`frontend/portal/src/uemsRollen.ts`. Noch kein Laufzeit-Aufrufer; H-2 schließt
Server/Protokoll, H-3 Cockpit, H-5/H-7 Assistent und Karten an.

- Kanalidentität vor der Regel aus Capability/Formel-Term auf dieselbe
  Komponente + denselben Punkt auflösen; `enthaelt` rekursiv vollständig,
  auch bei stummen Eingängen. Nicht aus Box, Name oder Transport ableiten.
- Eine mehrfach zugeordnete Summe und ihre zusätzlich zugeordneten inneren
  Summen/Blätter zählen nur einmal. Bei stummer Summe kein Blatt-Rückfall.
  Teilweise überlappende unabhängige Summen sind kein auswertbarer Eingang.
- Netz höchstens ein Wert je Anlage; dieselbe Summe über mehrere Geräte ist
  einer. PV/Verbrauch benannte Teilsumme, innerhalb einer Summe `null`.
- 300 s einschließlich Grenze für alle Beiträge der Anlagen-Übersicht;
  Formel-Route bleibt bei 15 min. Stand je Quelle prüfen, niemals null als 0.
- Rolle ab jetzt, `rolle_gesetzt`/`rolle_entzogen`; keine Rollen-Zeitreise.
  Formel-Fassungen, Größen, Rechte und Steuerpfade bleiben eigene Verträge.
- Neues Kundenwort ausschließlich `SUMMENWERT`. `GESAMTWERT` ist bis H-5/H-7
  eingefrorener Bestandsexport. Text-Ausnahmen stehen einzeln in
  `copy.test.ts` und dürfen nur schrumpfen; bestehende Kundennamen bleiben.

Prüfen: `RollenZuordnungRegelnVectorsTest`, `uemsRollen.test.ts`,
`copy.test.ts`, Portal-Typecheck/-Build, `bash tools/agents-md-budget.sh`.
Bei Vertragsänderung immer alle Leser über `rg -l` finden und laufen lassen.
Keine Testcontainers für diese reine Schicht.
