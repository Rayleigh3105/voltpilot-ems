# UEMS-Datenquelle und Zuständigkeit als Vertrag mit Vektoren

Neu angelegt am 11.09.2026 (AP-06 IP-1, erstes Bau-Paket von „Mehrere Edges“ im Programm
Unternehmens-Energiemanagement).

Die Regeln stehen im AP-06-Konzept §4.1–§4.7 (Entscheide E1, E2, E3, E5, E7, E8, E9,
E10 = B, E11, E12); der Glossar-Hinweis steht bei „Datenquelle“ in
[`docs/fachmodell/glossar.md`](../../fachmodell/glossar.md) (erzeugt — Quelle
`docs/fachmodell/tools/fachmodell.py`, `--check` ist das Gate). Seit IP-1 ist es Vertrag:

- **[`docs/contracts/v2/data-source-assignment.md`](../../contracts/v2/data-source-assignment.md)**
  — die Prosa: Objekt, Identität, Zeiträume, Prüfreihenfolge, Doppel-Lesen, Fehlerklassen,
  führende Box, Fähigkeiten, acht benannte Widersprüche.
- **[`data-source-vectors.json`](../../contracts/v2/data-source-vectors.json)** + Schema
  `data-source-assignment.schema.json` — 56 Fälle in acht Familien (`antrag`, `zeitraeume`,
  `zustaendig`, `box_tausch`, `fuehrende_box`, `faehigkeiten`, `fehlerklasse`, `bestand`); die
  Abnahmefälle A3, A4, A5, A7, A8, A9, A11, A12, A13 sind je Fall mit `abnahme` markiert.
- **[`edge-capabilities.json`](../../contracts/v2/edge-capabilities.json)** + Schema — die
  Tabelle „Software-Stand → Fähigkeiten“ als DATEN (E12).
- **Zwillinge:** Java `services/api/.../uems/DatenquelleRegeln` (+ `DatenquelleRegelnVectorsTest`,
  der auch beide Schemas über `UemsSchemaLaeufer` und jeden Fall gegen das Referenzunternehmen
  prüft) und TS `frontend/portal/src/uemsDatenquelle.ts` (+ `.test.ts`, Schemas über
  `src/test/uemsSchemaLaeufer.ts`).
  **Wer die Regel ändert, ändert beide Seiten UND die Vektor-Datei.**

## ⚠ Noch ruft niemand an

IP-1 stellt NICHTS um: keine Tabelle (IP-2 `data_source`, `data_source_assignment`,
`site.lead_device_id`), kein Endpunkt (IP-3), keine Vorschlagsliste (IP-4), kein Push je Box
(E4), kein Herzschlag-Block (IP-13/IP-18). `gatewayDevice` bleibt die heutige Weiche — bis
IP-5: seitdem stellt `LeadDeviceService` Registry-Push und Flow-Aktivierung der führenden Box zu
(`DatenquelleRegeln.fuehrung` + `lead-device-vectors.json`, `uems-fuehrende-box-lead-device-service.md`).
Seit IP-4 ruft `DatenquelleVorschlagService` die Regel `vorschlagsliste` (Familie `bestand`,
`uems-datenquelle-vorschlagsliste-bestand.md`).

## Die fünf Fakten, die man ohne Nachlesen braucht

1. **Zeiträume sind halboffen auf die Minute** (`effective_from` ≤ t < `effective_to`, `null` =
   offen), überlappen nie, dürfen Lücken haben („angehalten“), werden BEENDET statt
   überschrieben und beginnen nie rückwirkend — „jetzt“ zählt auf die Minute abgerundet. Einzige
   Ausnahme: die Vorschlagsliste der Bestands-Übernahme (ab Reihenbeginn). Die Speicher-Regel
   (`pruefeZeitraum`) beendet NICHTS; das tut nur der Wechsel (`pruefeAntrag`).
2. **Prüfreihenfolge eines Antrags** (der erste Grund entscheidet): Protokoll → volle Minute →
   rückwirkend → (Wechsel) Steuerquelle → späterer Wechsel geplant → schon zuständig →
   Eindeutigkeit je Box → Netzlage fehlt → nur ein Leser → Vergleich bestätigen → Prüfung fehlt →
   Prüfung gescheitert. Die Prüfung zählt nur von GENAU der Ziel-Box.
3. **Doppel-Lesen (E10 = B):** gleiche Adresse + gleiche DOKUMENTIERTE Netzlage an einer anderen
   Box → nur als gekennzeichnete Vergleichsquelle nach Bestätigung; gesperrt, wenn eine Seite
   `mehrere_leser = false` (Vorgabe!) oder Steuerquelle ist. Fehlt eine Netzlage → abgelehnt,
   nie „anderes Netz“ geraten.
4. **Fehlerklassen = Wörter des Verbindungstests** (`edge-app/core/internal/testconn`) + `budget`
   + `layout_changed` von der Box, `box_meldet_sich_nicht` nur aus der Cloud. ⚠ Das Konzept schrieb
   `timeout`/`exception`; es gilt `no_answer`/`invalid_response` (E5-Wortlaut), `exception` wird
   verworfen.
5. **Fähigkeiten:** `supports[]` übersteuert (auch leer); sonst zählt die Ordnung des
   Release-Registers (`release_seq`, D5), nie ein String-Vergleich; ein Stempel ohne Release
   beweist nichts. Heute ist `ab_release` bei BEIDEN Fähigkeiten `null` — wer das Release baut,
   trägt es ein.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='DatenquelleRegelnVectorsTest')   # 117 Tests, rein
(cd frontend/portal && npx vitest run src/uemsDatenquelle.test.ts)       # 61 Tests
python3 docs/fachmodell/tools/build_fachmodell.py --check                # Glossar aktuell
```

Lokal braucht `./mvnw` ein JDK 21 (`JAVA_HOME`); mit JDK 17 bricht der Compiler mit „release
version 21 not supported" ab, bevor ein Test läuft.
