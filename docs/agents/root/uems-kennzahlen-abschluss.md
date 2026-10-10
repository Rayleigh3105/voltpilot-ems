# UEMS-Kennzahlen: Abschluss, Bestandsschutz und Flag-Nachweis (AP-11 IP-16, Meilenstein 6)

Das letzte der sechzehn AP-11-Pakete. Diese Seite ist der Einstieg in den ganzen Kennzahlenbaukasten: welcher Wegweiser
welche Schicht trägt, womit bewiesen ist, dass der Kern unberührt bleibt, was der Schalter wirklich schaltet — und was ein
Kunde am Tag der Freigabe kann und was nicht. Stand: `uems` c6af1ffd (15.09.2026).

## Einstieg je Schicht

| Schicht | Wegweiser | Pakete |
|---|---|---|
| Vertrag, Vektoren, Zwillinge Java ⟷ TS | `uems-kennzahl-vertrag.md` | IP-1 bis IP-3 |
| Tabellen (Fassungen, Werte append-only) | `uems-kennzahl-tabellen.md` | IP-4 |
| Schreibwege, Vorschau, Ablehnungen | `uems-kennzahl-schreibwege.md` | IP-5 |
| Rechenlauf, Zusammenfassung, Wochen | `uems-kennzahl-rechenlauf.md`, `uems-kennzahl-zusammenfassung.md`, `uems-kennzahl-wochen.md` | IP-6, IP-11, IP-12 |
| Werte lesen, Versionen, Herkunft | `uems-kennzahl-werte-lesen.md` | IP-7 |
| Kaskaden-Naht und Auslöser | `uems-kennzahl-kaskade.md`, `uems-kennzahl-ausloeser.md` | IP-8, IP-9 |
| Vorlagen-Katalog | `uems-kennzahl-vorlagen.md` | IP-10 |
| Portal | `uems-kennzahlen-portal.md`, `uems-kennzahl-anlegen.md`, `uems-kennzahl-aendern.md` | IP-13 bis IP-15 |

## Bestandsschutz

- **`UemsKennzahlenBestandsschutzTest`** fährt die ganze Maschine in Betriebsreihenfolge über Ahrenberg im März 2026:
  Anlegen über die Route, den Kennzahl-Schritt des Stundentakts (seine Stelle im Takt: `EndgueltigkeitLaeuferReihenfolgeTest`),
  eine rückwirkende Fassung durch die Korrektur-Kaskade
  (Version 2 „Berechnung geändert“), die Naht auf dem Reihen-Pfad (Version 2 „korrigiert“). Vergleichsstand ist der Takt
  in der Verdrahtung von VOR AP-11 (`new EndgueltigkeitLaeufer(…)` ohne Kennzahl-Schritt), bevor es eine Kennzahl gibt.
  Danach byte-gleich: jede Tabelle außerhalb `kennzahl%` (`Bestandsschutz.fingerabdruck`), die sechs Rollup-Tabellen
  (Telemetrie v1 15 min/1 h/1 Tag, v2 15 min, Geräte-Messwerte 5/15 min) und Verlauf plus Export eines Messwerts über
  zwei Stunden (gelesen, roh) und einen Monat.
- ⚠ **Geteilte Tabellen mit Namen, nie ausgenommen:** AP-11 schreibt `kennzahl_neu_gebildet` in `messreihe_ereignis` und
  `kennzahl_fassung:…` in `messreihe_kaskade_wirkung`; der Test nimmt genau diese Zeilen heraus (und die Korrektur, die
  er an Stelle von AP-08 schreibt). Wer eine neue AP-11-Schreibstelle in eine geteilte Tabelle legt, trägt sie dort ein.
- ⚠ **Die Rollups fasst AP-11 nicht an.** Die Rollups bilden Datenbank-Jobs (`refresh_telemetry_rollups`,
  `refresh_telemetry_v2_rollups`, `refresh_device_measurement_rollup`); der Test schaltet die Jobs ab
  (`alter_job … scheduled => false`), sonst rechnen sie zwischen den Fingerabdrücken. Der 5-Minuten-Rollup liest nur
  Reihen mit Langzeit-Takt 300 s.
- ⚠ **Zwei Zeitquellen, die keine Kennzahl sind:** der Verlauf trägt `rohGrenze` aus der Uhr (der Test setzt dem Dienst eine
  feste), und JEDER Takt verschiebt `messreihe_tag_lauf` — darum rechnet der Test den Kennzahl-Schritt einzeln statt eines
  zweiten ganzen Takts.
- **Stand vor AP-11:** seit 7d2713c0 (Elter von #774) ändert kein AP-11-Commit Rollup-Prozeduren, Verlauf oder Export —
  den Export hat nur AP-12 IP-10 geändert (neun Kopfzeilen, `BestandGeraeteCsvTest`). `UemsLesepfadMengenTest.FLAECHE_VORHER`
  ist auf 0de28e6e aufgenommen, also vor AP-11.
- **Formel-Maschine unverändert:** seit 7d2713c0 kein Commit an `messstelle-formel-vectors.json`, `MessstelleFormelRegeln`
  oder `uemsMessstelleFormel.ts`; AP-11 RUFT `zyklus`/`fassungEintrag`/`fassungAm` nur auf.

## Der Schalter `voltpilot.uems.kennzahlen.enabled`

- **Fundstellen:** `application.yml` `kennzahlen.enabled: ${VOLTPILOT_UEMS_KENNZAHLEN_ENABLED:true}`, `KennzahlLauf`
  `@Value("${voltpilot.uems.kennzahlen.enabled:true}")`. Vorgabe AN.
- **Was er schaltet:** NUR den Kennzahl-Schritt im Stundentakt (`KennzahlLauf.lauf` → leerer `Lauf`). Der Takt selbst
  hängt an `voltpilot.uems.endgueltigkeit.enabled` (Vorgabe AN, erste Runde 2 min nach dem Start). **Nicht** geschaltet:
  die Naht `KennzahlKaskade` (läuft in der Korrektur-Kaskade, `voltpilot.uems.kaskade.enabled`), die Routen, das Portal,
  die Berichte. Aus heißt also: Kennzahlen bleiben anlegbar und sichtbar, bekommen aber keine Werte mehr aus dem Takt,
  während Korrekturen weiter Versionen bilden. Ein Not-Aus des Baukastens ist er nicht.
- ⚠ **Nicht in surefire eintragen.** Anders als die übrigen UEMS-Schalter steht er nicht in `pom.xml` — zu Recht: der
  Takt ist dort über `endgueltigkeit.enabled=false` aus, und die Tests rufen `KennzahlLauf.lauf` direkt. `false` in
  surefire machte jeden dieser Tests still leer.
- **Deploy:** `.forgejo/workflows/deploy-fast.yaml` baut Images und hebt die Tags im gitops-Repo — keine Umgebung.
  gitops `mamotec/gitops` main 83170cb (15.09.2026): die `api` liest `base/api/api.env`, `base/config/common.env`,
  `site.env` und Secrets; **kein** `VOLTPILOT_UEMS_*`. Ohne Eintrag gilt die Vorgabe AN — für alle zwölf
  `VOLTPILOT_UEMS_*_ENABLED` der `application.yml` (Liste `vp-uems-mainmerge-checkliste`).
- **Erstes Ausrollen:** der Takt läuft stündlich für alle Kundenbereiche; der Kennzahl-Schritt fragt nur
  `SELECT DISTINCT tenant_id FROM kennzahl WHERE archiviert_am IS NULL` und findet nichts — keine Migration, kein
  Dev-Seed, keine Bestandsübernahme legt eine Kennzahl an. Er rechnet ab der ersten Kennzahl, die ein Kunde anlegt, ohne
  weiteren Schalter.

## Am Tag der Freigabe

**Ein Kunde kann:** Kennzahlen anlegen (Assistent, acht Vorlagen, Kopieren), die Berechnung ab einem Tag ändern (auch
rückwirkend), Stammdaten ändern, archivieren, ohne Werte löschen; Quotient, Anteil und Zusammenfassung über Ebenen
(Summe ÷ Summe); je Tag, Woche, Monat, Jahr; Werte vorläufig, dann endgültig, mit Versionen und Herkunft; Korrekturen an
Messreihen, rückwirkende Fassungen, Bezugsgrößen-Berichtigungen und rückwirkende Stammdaten ziehen als Version n + 1
durch; Nenner aus Messstellen, anderen Kennzahlen, Stammdaten (Mitarbeitende) und Periodenwert-Bezugsgrößen (Stück, kg —
die Werte heute nur über die API, siehe 1.); Berichte übernehmen Kennzahl-Werte (AP-12).

**Ein Kunde kann nicht:**

1. **Stück- oder kg-Werte im Portal eingeben oder importieren** — AP-09 IP-9/IP-10 sind nicht gebaut; `POST
   …/bezugsgroessen/{id}/werte` und `POST /api/v1/bezugsdaten/importe/vorschau` haben keinen Portal-Aufrufer. „kWh je
   Stück“ (K1–K3, die Plan-Abnahme) zeigt ohne API-Eintrag „keine Werte“.
2. **Eine Fläche als Nenner** (`vp-uems-flaeche-als-nenner`): Eingänge nur `messstelle`, `bezugsgroesse`, `kennzahl`;
   die Vorlage „je m²“ läuft leer.
3. **Lesen je Person begrenzen:** jede Person im Kundenbereich sieht jede Kennzahl (R-A1 ∧ R-A6 erst mit AP-03 IP-11);
   Definieren ist durchgesetzt (`KennzahlRechte`).
4. **Eine Bezugsgröße löschen, die eine Kennzahl liest** — 500 statt benannter Ablehnung; Bezugsgrößen haben keine
   Löschvorschau.
5. **Eine archivierte Kennzahl wiederherstellen** (keine Route); ein archivierter Eingang stößt keine Neubildung an.
6. **Die Entscheidung zu `BK-…` oder einer Import-Rücknahme sehen** — die Versionen tragen nur den Anlass-Text.
7. **In der Vorschau** laufende Perioden, Wochen oder `vor_bestehen` sehen.
8. **Versionen einer Woche** (`version_nicht_gebildet`); berechnete Messstellen haben keine Woche.
9. **„gemessen“ / „eingegeben von“ in der Herkunft**; R-A7 ist nur ein 404 der Werte-Route.
10. **Beim „Eigenverbrauchsanteil“ eine Richtungsprüfung** — die Vorlage verlangt keine, IP-14 hat keine gebaut.
11. **Kennzahlen aus Gebäude oder Standort öffnen** — „Kennzahlen“ bleibt Portfolio-Welt bis AP-13.
12. **Einen Messkanal als Bezugsgröße** (Kanal-Nenner, K11) — die Kanal-Bezugsgröße mit eigenem AP-08-Zustand ist AP-09
    IP-17 und nicht gebaut; Wertarten heute `periodenwert`, `stand`, `stammdatum`.
13. **Den Hinweis „Eingang außerhalb des Geltungsbereichs“** (K22) — nicht gebaut (`uems-kennzahl-rechenlauf.md`).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest=UemsKennzahlenBestandsschutzTest)   # Docker
(cd services/api && ./mvnw test -Dtest=MessstelleFormelRegelnVectorsTest,MessstelleFormelTypenTest,MessstelleFormelFassungRegelnTest)
(cd frontend/portal && npx vitest run src/uemsMessstelleFormel.test.ts src/uemsMessstelleFormelTypen.test.ts)
bash tools/agents-md-budget.sh
```
