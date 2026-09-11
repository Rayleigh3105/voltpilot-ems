# UEMS-Funktions-Zustand je Standort und Teilnahme je Anlage als Vertrag mit Vektoren

Neu angelegt am 11.09.2026 (AP-01 IP-1, erstes Bau-Paket von „Portalaufbau" im Programm
Unternehmens-Energiemanagement — nach dem Zustandsvokabular von AP-00 IP-3).

Die Regeln stehen im AP-01-Konzept §4.2–§4.7 (Entscheide E6 = C, E7, E8, E9; Auflösungen
W3, W5, W7); der Glossar-Hinweis steht in [`docs/fachmodell/zustaende.md`](../../fachmodell/zustaende.md)
(erzeugt — Quelle `docs/fachmodell/tools/fachmodell.py`, `--check` ist das Gate). Die ABLEITUNG
lebt seit IP-1 als Vertrag:

- **[`docs/contracts/v2/funktion-zustand-vectors.json`](../../contracts/v2/funktion-zustand-vectors.json)**
  — 107 Fälle in fünf Familien (`teilnahme`, `standort`, `messen`, `uebergaenge`, `bestand`),
  dazu Rangfolge, Prüflisten-Reihenfolge, Aktionen und Grund-Sätze; die Abnahmefälle A1, A3,
  A4, A5, A11, A12 sind je Fall mit `abnahme` markiert.
- **[`docs/contracts/v2/funktion-zustand.schema.json`](../../contracts/v2/funktion-zustand.schema.json)**
  — JSON Schema 2020-12; die Vektor-Datei ist seine Fixture.
- **Zwillinge:** Java `services/api/.../uems/FunktionZustandAbleitung`
  (+ `FunktionZustandAbleitungVectorsTest`) und TS `frontend/portal/src/uemsFunktion.ts`
  (+ `uemsFunktion.test.ts`). Beide rufen für „liefert Daten" und „steuert" das
  Zustandsvokabular (`ZustandAbleitung` / `uemsZustand.ts`), statt es nachzubauen.
  **Wer die Regel ändert, ändert beide Seiten UND die Vektor-Datei.**

## ⚠ Noch ruft niemand an

IP-1 stellt NICHTS um: keine Tabelle (IP-2 `funktion`/`funktion_teilnahme` backfillt nach
dieser Regel), kein Endpunkt (IP-3), keine Fläche (IP-8/IP-11); Steuerung, Publisher und Box
sind unberührt. Der Ruhe-Eintrag ohne Ende (IP-4) ist hier nur ein gelesener FAKT.

## Die fünf Fakten, die man ohne Nachlesen braucht

1. **Rangfolge `kein_objekt < archiviert < entwurf < eingerichtet < angehalten < aktiv`.** Der
   Standort trägt den HÖCHSTEN Zustand seiner Teilnahmen. ⚠ angehalten schlägt eingerichtet
   (A4: „angehalten, solange keine Anlage aktiv teilnimmt"); archiviert liegt UNTER entwurf
   (eine neue Aufnahme nach dem Beenden ist eine neue Einrichtung). `seit` am Standort:
   aktiv/eingerichtet der früheste, angehalten/archiviert der späteste.
2. **Teilnahme je Anlage:** nicht aufgenommen → kein_objekt · beendet → archiviert · gestartet
   mit Ruhe-Eintrag OHNE Ende → angehalten, sonst aktiv · nie gestartet → die Prüfliste
   entscheidet eingerichtet/entwurf. Ein Ruhe-Eintrag MIT Ende ist ein Handeingriff (S7), kein
   Anhalten; nach dem Start ist ein Box-Ausfall Beobachtung, kein Zustandswechsel (A12).
3. **Die Prüfliste** `box → freigabe → verbindungstest → grenze → hauptzaehler → betriebsweise`
   gilt vor dem Start UND beim Fortsetzen (E9 „ein Muster statt zwei"). Box + Hauptzähler kommen
   aus EINEM `liefertDatenAnlage`-Aufruf (stumme Box ⇒ Hauptzähler `null`, nicht prüfbar); ohne
   Freigabe sind Test und Betriebsweise `null`. „Entwurf" nennt, was fehlt, mit Objektnamen.
4. **⚠ Die Naht zu „steuert":** an `ZustandAbleitung.steuert` geht `ruheEintrag = (Zustand
   angehalten)` und `funktionGestartet = aktiv|angehalten` — NIE der rohe Ruhe-Eintrag, sonst
   liest eine eingerichtete, nie gestartete Anlage „angehalten" statt „noch nicht gestartet"
   (Vektor `a3-eingerichtet-ruhe-bis-zum-start`).
5. **Bestand (W5):** eine LAUFENDE Betriebsweise — Betriebsmodell an, Eigenverbrauchs-Fahrplan
   eines scharfgeschalteten Speichers (Grundmodus!) oder Steuerart/Regel — ⇒ aktiv „(übernommen)";
   nur Scharfschaltung ⇒ eingerichtet; sonst kein Objekt. Lesend: kein Schalter, kein
   Ruhe-Eintrag. Messen kennt nur kein_objekt · entwurf · aktiv · archiviert und bleibt nach der
   Einrichtung aktiv.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='FunktionZustandAbleitungVectorsTest')  # 111 Tests, rein
(cd frontend/portal && npx vitest run src/uemsFunktion.test.ts)          # 115 Tests
python3 docs/fachmodell/tools/build_fachmodell.py --check               # Glossar aktuell
```

Lokal braucht `./mvnw` ein JDK 21 (`JAVA_HOME`); mit JDK 17 bricht der Compiler mit „release
version 21 not supported" ab, bevor ein Test läuft.
