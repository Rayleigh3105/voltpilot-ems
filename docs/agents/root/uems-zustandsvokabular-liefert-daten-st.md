# UEMS-Zustandsvokabular „liefert Daten“ / „steuert“ als Vertrag mit Vektoren

Neu angelegt am 11.09.2026 (AP-00 IP-3, zweites Bau-Paket des Programms
Unternehmens-Energiemanagement — nach dem Fachmodell selbst).

Die Prosa-Wahrheit steht in [`docs/fachmodell/zustaende.md`](../../fachmodell/zustaende.md)
(erzeugt, nie von Hand ändern — Quelle ist `docs/fachmodell/tools/fachmodell.py`, Generator
`python3 docs/fachmodell/tools/build_fachmodell.py`, `--check` ist das Gate). Die
ABLEITUNG lebt seit IP-3 als Vertrag:

- **[`docs/contracts/v2/uems-zustand-vectors.json`](../../contracts/v2/uems-zustand-vectors.json)**
  — 55 Fälle, zwei Familien, dazu Vokabular, Einheiten-Tabelle und Regel-Konstanten.
- **[`docs/contracts/v2/uems-zustand.schema.json`](../../contracts/v2/uems-zustand.schema.json)**
  — JSON Schema 2020-12 für Eingang, Ergebnis und die Vektor-Datei selbst.
- **Zwillinge:** Java `services/api/.../uems/ZustandAbleitung` (+ `ZustandAbleitungVectorsTest`)
  und TS `frontend/portal/src/uemsZustand.ts` (+ `uemsZustand.test.ts`). Beide fahren dieselbe
  Datei; **wer die Regel ändert, ändert beide Seiten UND die Vektor-Datei.**

## ⚠ Noch ruft niemand an

IP-3 stellt KEINE Fläche um. `services/api` (`OverviewRepository`, `AdminFleetRepository`) und
das Portal (`api.ts ONLINE_WINDOW_MS`/`deviceLiveStatus`, `komponenten.ts deviceState`) leiten
„liefert Daten“ weiterhin über das harte 5-Minuten-Fenster ab und behalten ihre heutigen
Wörter („Meldet sich gerade nicht“, „Wartet auf die ersten Daten“). Der Vertrag ist das Ziel,
gegen das die Umstellung gebaut wird — nicht ihr Vollzug.

## Die vier Fakten, die man ohne Nachlesen braucht

1. **Die Toleranz ist `min( max( 3 × Kadenz , 300 s ) , 86 400 s )`** (AP-07 E9 vom 10.09.2026
   für Faktor und Boden, AP-00 §4.3 Übergänge für den Deckel). Die Kante gehört zu „liefert“
   (`<=`, wie `deviceLiveStatus` heute).
   ⚠ **Der Fall, den man falsch erwartet:** 60 s Kadenz und 190 s Alter überschreiten
   3 × Kadenz = 180 s — es gilt trotzdem „Liefert Daten“, weil das Mindestfenster größer ist.
   Der Vektor `mindestfenster-schlaegt-drei-kadenzen` pinnt genau das.
2. **Die LÜCKE ist eine andere Aussage** (AP-07 E9/IP-9): ab 2 × Kadenz ohne guten Wert, ohne
   Boden und ohne Deckel. Sie zählt fehlende WERTE, sie zeigt kein Abzeichen — eine Reihe darf
   „Liefert Daten“ tragen und zugleich eine offene Lücke haben (und umgekehrt: ein Tageszähler
   liefert nach 30 h keine Daten mehr, hat aber noch keine Lücke).
3. **Vier Zustände, geschlossen:** `liefert` · `liefert_nicht_seit` (immer MIT Zeitpunkt, mit
   Datum sobald er nicht mehr am heutigen Tag des Standorts liegt) · `wartet_auf_erste_daten`
   (auch dann, wenn Werte ankamen, aber keiner mit Qualität „gut“) · `keine_datenquelle`
   (AP-04 E8; schlägt jeden alten Wert — ein bekannter Grund ist nie eine Störung). Darüber
   drei Ableitungen: `anlage` (alle Boxen verbunden UND Hauptzähler liefert), `aggregat`
   („x von y“, nur `liefert` zählt im Zähler) und `berechnet` („Vollständig“ nur, wenn ALLE
   Eingänge liefern; sonst „Unvollständig seit … (fehlt: MS-12)“ mit dem FRÜHESTEN Zeitpunkt).
4. **„steuert“ nennt GENAU EINEN Grund**, in dieser Reihenfolge (hier festgelegt, IP-3):
   `angehalten` → `nicht_freigegeben` → `funktion_nicht_gestartet` → `kein_betriebsmodell` →
   `box_meldet_sich_nicht` → `box_bestaetigt_nicht`. Von der eigenen Entscheidung des Kunden
   nach außen zur Maschine: wer „angehalten“ nicht zuerst liest, sucht einen Fehler, den er
   selbst gesetzt hat; und eine abwesende Box erklärt die fehlende Bestätigung, die fehlende
   Bestätigung erklärt nichts.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='ZustandAbleitungVectorsTest')   # 59 Tests, rein
(cd frontend/portal && npx vitest run src/uemsZustand.test.ts)          # 64 Tests
python3 docs/fachmodell/tools/build_fachmodell.py --check               # Glossar aktuell
```

Die Tests prüfen nicht nur die Fälle: sie stellen auch die Regel-Konstanten, das geschlossene
Vokabular **in seiner Reihenfolge** (die Reihenfolge IST die Regel) und die Einheiten-Tabelle
gegen die Vektor-Datei — ein geänderter Faktor fiele sonst erst in einem einzelnen Zahlenfall
auf.
