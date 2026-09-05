# Zusätzliche Messwerte: Bibliothek und Historie (Slice 9)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 156).


- Die gemeinsame Messbibliothek hängt an jeder Komponenten-Geräteseite
  einschließlich OCPP. **⚠ Ihr Bauteil heißt seit Geräteseiten Stufe 3a
  `components/BeobachteteRegister.tsx`** (`MeasurementLibrary` ist darin
  aufgelöst, siehe `frontend/portal/AGENTS.md`): sie FÜHRT jetzt mit den
  beobachteten Punkten, der vollständige Katalog liegt hinter
  „＋ Register/Messwert beobachten" und bietet serverseitige Suche/Facetten
  sowie den getrennten read-only-Freiregisterweg. Verfügbarkeit bedeutet entweder
  tatsächlich gelesen oder ausdrücklich nur „für die konfigurierte Familie
  vorgesehen, noch nicht gelesen“; eine Familienzuordnung ist kein Beweis, dass
  ein konkretes Modell/Register antwortet.
- `MeasurementCatalogFamilies` ist die verbindliche Brücke von `builtin.json`
  zum kanonischen Katalog: `sunspec|sunspec_live` expandieren auf alle 19
  `sunspec.model_*`, go-e/Shelly/OCPP auf ihre Katalogfamilien, direkte Deye-,
  Fronius-, KACO- und KOSTAL-Familien bleiben exakt. Der katalogweite Test lädt
  das echte `builtin.json`; eine neue Binding-Familie ohne Katalogabdeckung muss
  rot werden.
- Punktverläufe liegen unter
  `/api/v1/devices/{deviceId}/measurement-selection/{pointKey}/history|export`.
  Bis 48 h wird qualitätsgefiltertes Raw gebucketet, längere Bereiche lesen die
  dauerhaften 5-/15-min-Rollups; jede Abfrage partitioniert historisch nach
  Tenant, Standort, Gerät und Punkt. Gauge-Buckets liefern gewichtetes
  Mittel/Min/Max, Counter nur standortlokale positive Deltas, Zustände den
  letzten Wert; Auswahl-/Ack-/First-Sample-, Lücken-, Reset-, State-, Fehler-,
  Bitfield-, Text- und komponentengenaue Familienmarker bleiben getrennt.
  Für den Familienmarker bindet die Geräteseite ihre konkrete
  `measurement_point`-ID als `entityId`; nur Gerät/Familienname zu vergleichen
  ist bei zwei gleichen Wechselrichtern am selben Gateway unzulässig.
  State/Event/Bitfield/Text sind außerdem echte 15-min-Langzeitreihen (nicht
  nur Marker): am Fensteranfang wird der letzte Zustand davor als Startwert
  eingesetzt, auch wenn die 90-Tage-Rohdaten schon gelöscht sind.
  Rohwahl gibt es nur bei vorhandenen Wire-Rohdaten. CSV trägt Point-Key,
  Standort, Labels, Einheit, Aggregation, Semantik, Katalogversion und
  Darstellung und neutralisiert Spreadsheet-Formelpräfixe. Die Katalogroute
  liest Verfügbarkeit/letzten Wert ausschließlich aus dem writer-gepflegten,
  RLS-gesicherten `device_measurement_point_state`, nie per DISTINCT-Scan aus
  dem Raw-Hypertable. Die Anlagen-Auswahl liefert höchstens 40 kürzlich gemessene,
  semantisch bekannte numerische Optionen und vergleicht höchstens drei
  kompatible Punkte; unterschiedliche Einheiten erhalten getrennte Achsen.
- Neue Portalflächen dürfen keine nativen `select`, `date`, `time`,
  `datetime-local` oder `datalist` einführen; der repo-weite Nullbestandstest in
  `frontend/portal/src/migration.test.ts` erzwingt `VpPicker`, `VpDatePicker`
  und `VpTimePicker`. Eine Punkt-/Drawer-Öffnung beginnt immer dekodiert; ein
  abgelehntes Rohfenster bietet sichtbar die Rückkehr zu dekodierten Werten.
  Zeitraum- und Darstellungs-Schalter sind echte Toggle-Gruppen und müssen
  ihren Zustand zusätzlich zur Farbe mit `aria-pressed` ausgeben. Öffnet der
  Verlauf aus der Bibliothek, ersetzt er deren Modal vollständig; Escape
  schließt den Verlauf und stellt genau diese Bibliothek wieder her, sodass nie
  zwei `aria-modal`-Dialoge gleichzeitig exponiert sind.

