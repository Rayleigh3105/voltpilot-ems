# Formel-Vertrag der berechneten Messstelle (UEMS AP-10, Typ „gewichtete Summe")

Stand 12.09.2026 · Vertrag 1.0 (additiv zum Messstellen-Vertrag
[`messstelle.md`](./messstelle.md)) · Captain-Rahmenentscheide aus dem Konzept
`vp-helfer-konzept-h1`.

Dieser Vertrag löst die im Messstellen-Vertrag reservierte AP-10-Stelle ein: die **Formel**
einer Messstelle mit `art = berechnet` (messstelle.md:39 „`berechnet` (E9)", :108 „Formel +
alle Eingänge", FEHLT-Reihenfolge `… formel · eingaenge`).
Der erste — und vorerst einzige — Formel-Typ ist die **gewichtete Summe**: eine geordnete
Liste von **Termen**, je Term ein vorhandener Messkanal (oder eine andere Messstelle), mit
**Vorzeichen** und **optionalem Faktor**. **KEIN zweites Modell** neben der Messstelle
(Hausregel „Verträge sind additiv / erweitern statt duplizieren").

| Datei | Rolle |
|---|---|
| [`messstelle-formel-vectors.json`](./messstelle-formel-vectors.json) | die geteilten Vektoren: `groesse` (Ableitung), `zyklus`, `summe` (die Rechnung inkl. Ehrlichkeit) |
| `services/api/.../uems/MessstelleFormelRegeln.java` | der Java-Zwilling (rein: ohne Spring, ohne DB, ohne Uhr) — stützt sich auf `MessstelleRegeln`s Größen-Katalog |
| `frontend/portal/src/uemsMessstelleFormel.ts` | der TS-Zwilling |
| `…/uems/MessstelleFormelRegelnVectorsTest.java` · `src/uemsMessstelleFormel.test.ts` | beide fahren DIESELBE Vektor-Datei |

**Wer eine Regel ändert, ändert beide Zwillinge UND die Vektor-Datei.**

> **Wer anruft (Stand AP-10):** die Tabelle `messstelle_formel_term`
> (`V20260912093000`), der Dienst `MessstelleFormelService` und die Endpunkte
> `POST /api/v1/messstellen/berechnet`, `GET …/{id}/formel`, `…/{id}/wert`,
> `…/{id}/verlauf`. Die Box kennt keine berechnete Messstelle; der Edge-Vertrag bleibt
> unverändert. Das Kundenwort („Gesamtwert") kommt erst mit dem Frontend-Assistenten.

## 1. Der Term (`messstelle_formel_term`)

Ein Term je Zeile, mandantengebunden (RLS wie alle UEMS-Tabellen), nur an einer **berechneten**
Messstelle (Trigger `messstelle_formel_term_nur_berechnet`):

| Feld | Regel |
|---|---|
| `position` | die stabile Reihenfolge, je Messstelle eindeutig |
| `eingang_art` | `messkanal` \| `messstelle` — der CHECK bindet ENTWEDER das eine ODER das andere |
| `entity_id` + `point_key` | bei `messkanal`: die Quellenbindung wie IP-13 (Komponente + Kanalname) — das Gerät wird NICHT gespeichert, der Cloud-Rechenweg löst die lesende Box zur Rechenzeit über `device_measurement_selection` auf |
| `quell_messstelle_id` | bei `messstelle`: die verkettete Messstelle (Baustein), nie sich selbst (CHECK), nie im Kreis (Zwilling) |
| `vorzeichen` | `+` \| `-` |
| `faktor` | numeric, Vorgabe 1, nie 0 |

Die Terme sind die AKTUELLE Definition (keine Historie): die App-Rolle darf sie ersetzen; das
Ändern schreibt `messstelle_aenderung`. `→ messstelle` ist `ON DELETE RESTRICT`
(archivieren statt löschen), `→ measurement_point` ist `ON DELETE CASCADE` wie jede Tabelle an
einer Komponente.

## 2. Die abgeleitete Hauptgröße (`formelGroesse`)

Die Hauptgröße der berechneten Messstelle wird aus den Termen **abgeleitet**, nie gewählt — so
ist sie sofort katalogkonform:

- Alle Terme tragen **dieselbe Vertrags-Größe** (Größe + Wertart), sonst `groessen_gemischt`
  mit dem ersten verletzten Merkmal (`groesse` → `wertart`).
- Die **Einheit** ist die Katalog-Einheit der Größe (W/kW/MW normiert die Berechnung, nicht die
  Definition).
- Die **Richtung** ist die gemeinsame Richtung, wenn alle Terme dieselbe tragen UND alle mit `+`
  eingehen; sonst `richtungslos` (ein Netto). Ergibt sich eine Größe, die der Katalog nicht
  kennt (z. B. ein Netto einer Größe ohne `richtungslos`), ist das ebenfalls `groessen_gemischt`
  (Grund `richtung`).
- Ein Messwert **ohne Vertrags-Richtung** (ein Vorzeichen-Wert `import_export`, oder ein Kanal,
  dem der Katalog keine Richtung gibt) ist kein Term — seine Aufteilung wartet auf AP-08 (wie im
  Messstellen-Vertrag §5).

## 3. Die Berechnung (Cloud, `MessstelleFormelBerechnung`/`gewichteteSumme`)

- **Live-Wert:** die gewichtete Summe der JEWEILS FRISCHESTEN Eingangswerte (aus
  `device_measurement_sample`), je Term auf die Anzeige-Einheit normiert.
- **Verlauf:** je 15-min-Bucket (aus `device_measurement_rollup_15m`) summiert, WENN alle Terme
  im Bucket einen Wert haben.
- **Die eine harte Regel — `null` statt Teilsumme:** fehlt oder veraltet EIN Pflicht-Term, ist
  das Ergebnis **`null` („unvollständig")**, NIE eine stillschweigend um den fehlenden Term
  reduzierte Summe — eine Summe mit heimlich fehlendem Summanden wäre ein Falschwert
  (unterschätzt). Die Antwort nennt, welcher Term fehlt (und warum: `kein_geraet` · `kein_wert`
  · `veraltet` · `unvollstaendig`). `null` und `0` sehen nie gleich aus.
- Ein `messstelle`-Term liest bei einer berechneten Quelle rekursiv, bei einer gemessenen aus
  ihrer führenden Quelle; ein Kreis (bereits besucht, oder zu tief) fehlt.

## 4. Lebenszyklus

Der Formel-Stand geht in `MessstelleRegeln.lebenszyklus` ein (die EINE Stelle, messstelle.md
§4): ohne Term ist die Messstelle **Entwurf** (`fehlt: formel`), mit einem Term, dessen Eingang
nicht mehr auflösbar ist, **Entwurf** (`fehlt: eingaenge`); sonst — mit Kennzeichen, Name,
abgeleiteter Hauptgröße, Formel und eingerichteten Eingängen — von selbst **aktiv** (eine
berechnete Messstelle braucht keinen Ort).

## 5. Fehler-Codes

| Code | Status | Fakten | Wann |
|---|---|---|---|
| `groessen_gemischt` | 422 | `grund` (`groesse` · `wertart` · `richtung`) | die Terme tragen nicht dieselbe Vertrags-Größe |
| `formel_zyklus` | 422 | `kette` | ein `messstelle`-Term verkettet im Kreis (beim Bearbeiten) |
| `anfrage_ungueltig` | 400 | `feld` | ein Feld fehlt, ist leer oder ohne Vertrags-Messgröße |

Eine fremde Messstelle ist 404, nie 403 (AP-03).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='MessstelleFormelRegelnVectorsTest')          # rein, kein Docker
(cd frontend/portal && npx vitest run src/uemsMessstelleFormel.test.ts)
(cd services/api && ./mvnw test -Dtest='MessstelleFormelTermMigrationTest,MessstelleFormelApiTest')  # gegen die DB
```
