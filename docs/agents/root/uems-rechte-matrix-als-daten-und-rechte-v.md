# UEMS-Rechte-Matrix als Daten und Rechte-Vertrag mit Vektoren

Neu angelegt am 11.09.2026 (AP-03 IP-1, erstes Bau-Paket von „Rollen, Standortrechte und
Unterstützung" im Programm Unternehmens-Energiemanagement — Schritt 1 „Zuweisungen und Rollen",
noch ohne Durchsetzung).

Die Regeln stehen im AP-03-Konzept §4.1–§4.9 (Entscheide E1, E2, E4, E5, E6, E8, E9, E10, E13,
E15 vom 10.09.2026); der Glossar-Hinweis steht in [`docs/fachmodell/glossar.md`](../../fachmodell/glossar.md)
(erzeugt — Quelle `docs/fachmodell/tools/fachmodell.py`, `--check` ist das Gate). Seit IP-1 sind
Matrix und Ableitung Vertrag:

- **[`docs/contracts/v2/rechte-matrix.json`](../../contracts/v2/rechte-matrix.json)** — 48
  Kundenaktionen × 7 Rollen, je Zeile eine stabile Kennung (`messstelle.bearbeiten`, künftig
  `@Recht("…")`), Zellen `U`/`S`/`E`/`-`/`P` und für den Unterstützer `A`/`Ei`/`B` (E9).
  **[`rechte-matrix.md`](../../contracts/v2/rechte-matrix.md) wird daraus ERZEUGT**
  (`python3 docs/contracts/v2/tools/rechte_matrix.py`, `--check`) und ist zeichengleich zur
  Konzept-Tabelle §4.3 — nie von Hand ändern.
- **[`docs/contracts/v2/rechte-vectors.json`](../../contracts/v2/rechte-vectors.json)** — 141
  Fälle in sieben Familien (`darf`, `sichtbare_standorte`, `teilansicht`, `ocpp_stufe`,
  `unterstuetzung`, `entzug`, `aenderung`), A1–A16 je Fall mit `abnahme` markiert, sieben benannte
  Widersprüche in `widersprueche`; dazu Vokabular, Gründe mit HTTP-Status, Kundensätze, Regel-Zahlen.
- **[`docs/contracts/v2/rechte.schema.json`](../../contracts/v2/rechte.schema.json)** — JSON Schema
  2020-12 für BEIDE Dateien (Wurzel = Vektoren, `$defs/matrix` = Matrix).
- **Zwillinge:** Java `services/api/.../uems/RechteAbleitung` (+ `RechteAbleitungVectorsTest`:
  Schema über `UemsSchemaLaeufer`, jeder Fall gegen `uems-referenzunternehmen.json`, die erzeugte
  Tabelle zeilengleich zur Matrix) und TS `frontend/portal/src/rechte.ts` (+ `rechte.test.ts`,
  Schema über `src/test/uemsSchemaLaeufer.ts`).
  **Wer die Regel ändert, ändert beide Seiten UND die Vektor-Datei.**

## ⚠ Noch ruft niemand an

IP-1 erzwingt NICHTS: keine Zuweisungstabelle (IP-2 backfillt jeden Kundenbenutzer als
Kundenadministrator, E12), kein `ZugriffContext`/`/me` (IP-4), keine RLS-Policy `site_scope` (IP-5),
kein `@Recht`-Interceptor (IP-6/IP-7), keine Fläche (IP-12 macht `rollen.ts` zur Rechte-Quelle
und ruft `rechte.ts`). `TenantFilter`, `SecurityConfig`, `OcppActionPolicy` und Keycloak sind unberührt.

## Die Fakten, die man ohne Nachlesen braucht

1. **Geltungsbereich VOR Aktion (Invariante 4, W2).** Außerhalb → 404 ohne Standort im Ergebnis
   (die Existenz wird nie bestätigt); nach Entzug/Ablauf → 404 `zugriff_beendet` mit Satz; innen
   ohne Recht → 403 `recht_fehlt` + `rolle_noetig` (kleinste Rolle: leser < bearbeiter <
   bedienberechtigt < energiemanager < kundenadministrator < voltpilot_betrieb). Dritte bekommen
   statt `rolle_noetig` ein `umfang_noetig` — oder nichts (E9 „nie“).
2. **Eine Anlage wird über ihren Standort ZUM STICHTAG aufgelöst** (Rechte = heutige Zuweisung,
   Daten = Stichtag, A16); eine Anlage ohne Standort sehen nur unternehmensweite Rollen (IP-5).
3. **Partner- und VoltPilot-Konten** erreichen den Kundenbereich NUR über eine wirksame
   Unterstützung (ohne: auch Unternehmens-Aktionen 404). `P`-Zellen bleiben dem Plattform-Konto
   über `/api/v1/admin/**` — unabhängig von einer Unterstützung.
4. **Teilansicht (E10):** Unternehmensebene ab ZWEI zugänglichen Standorten, Kopfzeile bei n < m;
   Unternehmens-Objekte nur für unternehmensweite Rollen (auch bei „2 von 2“); Summen nur über die
   sichtbare Menge, eine Lücke macht die Summe `null`; ein standortübergreifendes Objekt ist
   sichtbar, wenn ALLE seine Standorte zugänglich sind (W-R3), sonst Hinweis ohne Wert.
5. **OCPP-Stufe aus der Zuweisung (E13, Wortlaut):** Kundenadministrator und Bedienberechtigt
   `SITE_ADMIN`, Unterstützer „Einrichten und Bedienen“ `CUSTOMER` (W-R1 — die Matrix-Zeile
   `ladepunkt.betrieb` gibt ihm B, der Entscheid-Wortlaut gilt), VoltPilot `PLATFORM`, alle
   anderen `keine`.
6. **Zeit:** „gültig ab“ ist ein Zeitpunkt; das ENDDATUM einer Unterstützung ist ein Kalendertag
   und gilt einschließlich — „bis 15.12.2026“ endet am 16.12.2026 00:00 (W-R2 aufgelöst,
   Entscheid firstmate 11.09.2026, wie AP-03 A4). Banner und „Endete am“ nennen das Enddatum,
   `endet` ist der Ablauf-Zeitpunkt, die Erinnerung läuft 7 Tage vor dem Ablauf. Nur der
   Notfall-Zugriff ist ein Zeitpunkt-Zeitraum von genau 24 h (`bisZeitpunkt` in beiden
   Zwillingen). Die Anlagen-Zuordnung ist tagesgenau wie im Ortsbaum und in der Referenzdatei
   (letzter Tag einschließlich); der Stichtag gilt an seinem Kalendertag. Ein Entzug schaltet nie: ein Handeingriff wirkt bis zu
   seinem Ablauf, nur das Etikett nennt „(Bedienrecht beendet am …)“ (E15).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='RechteAbleitungVectorsTest')   # 295 Tests, rein
(cd frontend/portal && npx vitest run src/rechte.test.ts)               # 151 Tests
python3 docs/contracts/v2/tools/rechte_matrix.py --check                # Tabelle aktuell
python3 docs/fachmodell/tools/build_fachmodell.py --check               # Glossar aktuell
```

Lokal braucht `./mvnw` ein JDK 21 (`JAVA_HOME`); mit JDK 17 bricht der Compiler mit „release
version 21 not supported" ab, bevor ein Test läuft.
