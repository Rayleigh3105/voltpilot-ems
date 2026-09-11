# UEMS-Messstellen-Vertrag: Kennzeichen, Größen, Quellenbindung und Stellung als Vertrag mit Vektoren

Neu angelegt am 11.09.2026 (AP-04 IP-1, das erste Bau-Paket des Messstellenregisters — vor
Migration IP-2 und API IP-3, die sich daran pinnen).

Die Prosa-Wahrheit ist [`docs/contracts/v2/messstelle.md`](../../contracts/v2/messstelle.md).
Dazu:

- **[`messstelle.schema.json`](../../contracts/v2/messstelle.schema.json)** — die WURZEL ist
  EINE Messstelle (Beispiele MS-06 und MS-21 unter
  [`fixtures/messstelle/`](../../contracts/v2/fixtures/messstelle/README.md), ≥ 2 gültig +
  2 ungültig); `$defs/vektorDatei` ist die Form der Vektor-Datei.
- **[`messstelle-vectors.json`](../../contracts/v2/messstelle-vectors.json)** — 87 Fälle in
  acht Familien (`kennzeichen_vorschlag`, `kennzeichen_pruefen`, `groesse`, `lebenszyklus`,
  `passung` — Regel 7 als Tabelle —, `bindung`, `zeitstrahl`, `stellung`), dazu Vokabular,
  Größen-Katalog und Fehlertabelle. Jeder Zweig der Zwillinge ist durch einen Fall belegt
  (mutationsgeprüft); zwei, die die Referenzdatei nicht erreicht, prüfen beide als Einheit.
- **Zwillinge:** Java `services/api/.../uems/MessstelleRegeln` (+ `MessstelleRegelnVectorsTest`)
  und TS `frontend/portal/src/uemsMessstelle.ts` (+ `uemsMessstelle.test.ts`). **Wer eine Regel
  ändert, ändert beide Seiten UND die Vektor-Datei.** Beide prüfen zusätzlich jeden Fall gegen
  `uems-referenzunternehmen.json` (Fälle mit `referenz`, `ergebnis_wie_referenz`,
  `fortschreibung`).
- **Der Schema-Läufer ist geteilt:** Java `services/api/src/test/.../uems/UemsSchemaLaeufer`
  (seit AP-04 IP-1 mit `anyOf`), TS `frontend/portal/src/test/uemsSchemaLaeufer.ts` (benutzt
  vom Referenzunternehmen- und vom Messstellen-Test). Kein neues Schema bekommt einen eigenen
  Läufer.

## ⚠ Noch ruft niemand an

Es gibt keine Tabelle `messstelle`, keinen Endpunkt, keine Fläche. IP-2 (Migration mit
Kennzeichen-Zähler je Mandant), IP-3 (API, Fehler 400/409/422 nach der Tabelle) und IP-13
(Quellenbindung) bauen gegen diesen Vertrag.

## Die Fakten, die man ohne Nachlesen braucht

1. **Kennzeichen (E7):** `MS-0001` fortlaufend je Kundenbereich, der Vorschlag überspringt
   belegte Nummern; änderbar auf `^[A-Z0-9./-]{2,16}$`, NICHTS wird umgewandelt (`ms-01` ist
   400, nie `MS-01`). Belegt ist auch ein archiviertes und das FRÜHERE Kennzeichen einer
   umbenannten Messstelle (Regel 9) — nur sie selbst darf zurück. IP-2 braucht dafür mehr als
   `UNIQUE (tenant_id, kennzeichen)`: die früheren Kennzeichen müssen mitzählen.
2. **Quellenbindung, Prüfreihenfolge:** Medium → Zweck (Vergleich) → Passung (Regel 7:
   `wertart` → `groesse` → `einheit` → `richtung`) → Zeitraum → Messwert führt schon eine
   ANDERE Messstelle → Zeitpunkt vor Vorgänger/Beginn → Überlappung. `wechsel` (Zählerwechsel)
   meldet einen zu frühen Zeitpunkt als `zeitpunkt_vor_vorgaenger`, `binden` als
   `bindung_ueberlappt`. Die EINZIGE Änderung an Bestehendem: eine neue offene führende Quelle
   beendet die laufende genau zu ihrem Beginn. Lücken bleiben als Abschnitt ohne Quelle.
3. **MS-06 hat an 10:40 KEINE Bindungslücke:** Z-5a bis 10:40, Z-5b ab 10:40. Die sieben
   Minuten bis zum ersten Wert von Z-5b sind eine WERTE-Lücke der Beobachtung (AP-07,
   `uems-zustand-vectors.json`), nicht des Zeitstrahls.
4. **Hauptzähler:** je Anlage und RICHTUNG einer, alle am selben Zähler (MS-01 Bezug + MS-02
   Abgabe an K-3 sind erlaubt, MS-03 am Wechselrichter nicht) — dieselbe Lesart wie der
   Invarianten-Test des Referenzunternehmens.
5. **Zwei Zeitformen:** Quellen auf die Minute mit halboffenem Zeitraum; Zuordnungen (Ort,
   Stellung) als Kalendertag mit dem LETZTEN gültigen Tag — die Ortsbaum-Mechanik (AP-02 IP-1).
   Die Referenzdatei schreibt seit Fassung 1.1 dieselbe Form; die Tests vergleichen direkt.
6. **E8/E9:** ohne Quelle eingerichtet und aktiv, Beobachtung „Keine Datenquelle“ (die Tests
   prüfen das über `ZustandAbleitung`/`uemsZustand.ts`); berechnet ohne Formel ist bis AP-10
   IMMER Entwurf und braucht keinen Ort (MS-20).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='MessstelleRegelnVectorsTest')   # 164 Tests, rein
(cd frontend/portal && npx vitest run src/uemsMessstelle.test.ts)       # 167 Tests
python3 docs/fachmodell/tools/build_fachmodell.py --check               # Glossar aktuell
```
