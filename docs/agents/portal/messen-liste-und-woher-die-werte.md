# Messen: die Liste der Messstellen und „Woher kommen die Werte?“

Stand: Messen-Bau m2, PR1 (Konzept `data/vp-messen-konzept-m1`, Captain-Freigabe 05.10.2026).

## Liste (`#/portfolio/messstellen`, `#/standort/{id}/messstellen`)

- Die reine Ableitung steht in `src/messstellenListe.ts` (Gruppen je Ort, Suche, Marken, Statuszeile, Reihen); `MessstellenPage.tsx` rendert nur.
- Gesucht und gefiltert wird in der GELADENEN Antwort von `GET /api/v1/messstellen`, nie je Taste beim Server; die Suche steht als `?suche=` in der Adresse, `?ort=`/`?anlage=` bleiben Parameter derselben Route.
- Suchregel: jedes Wort muss passen, normalisiert über `picker/suche.ts`; eine Ziffer am Wortanfang gehört zum Wort davor („halle 1“ → `halle1`, „az 3“ → `az3`), sonst fände „halle 1“ über „ST-1“ jede Messstelle des Standorts.
- Gesucht wird in Name, Kennzeichen, Ort (mit Pfad und Standort), Medium und dem Gerät der führenden Quelle, nie in der Anlage (MS-20 liegt in Halle 2, hängt aber an der Anlage Halle 1).
- Marken erscheinen nur, wenn es sie gibt („1 ohne Quelle“), und filtern; die alten Schalter „Nur ohne Quelle“ und „Nur geplant …“ sind Marken geworden (kein `ohneQuelle`/`geplantFuerEinsatz` mehr aus dem Portal).
- Die ganze Reihe ist ein Verweis (`<a href>`) auf die Seite der Messstelle; mit „Stand am …“ trägt er den Tag als `?periode=` (`onOeffnen(id, periode)`).
- Der Sprung zur Komponente (D1) steht seit PR2 in der Karte „Woher die Werte kommen“ der Seite (`.vp-mss-quelle-sprung`).
- Der Rückweg „‹ Alle Messstellen“ führt über `messstellenRueckweg.ts` in dieselbe Trefferliste (nur Speicher dieser Sitzung).
- „Summenwert anlegen“ gibt es unter Messen nicht mehr (Konzept §6.10); ein Summenwert entsteht an der Anlage.
- Box („zuständig: …“) und Vergleichsquellen stehen nicht mehr in der Liste, sondern auf der Seite; die Tatsache „Einstellung geändert ab …“ (A4) steht leise unter dem Zustand, unbekannte Tatsachen-Codes werden nie roh gezeigt.

## „Woher kommen die Werte?“ (Schritt 3 des Messstellen-Dialogs)

- Zwei gleichwertige Wege, keiner vorgewählt: „Automatisch von einem Gerät“ (Komponente, Messwert, Gilt ab wie bisher) und „Von Hand ablesen“.
- Die Ablesungsquelle entsteht mit der ERSTEN Ablesung (`POST /api/v1/messstellen/{kz}/ablesungen`, ohne `zuordnung_monat`); es gibt keine eigene Route „wird abgelesen“.
- Ablesen geht nur mit einem Zählerstand als Hauptgröße (sonst lehnt `AblesungService` mit `quelle_passt_nicht` ab); der Rhythmus ist fest monatlich (AP-09 Z7, überfällig nach zwei Monaten), nicht einstellbar.
- Beim Bearbeiten ist der Weg der Messstelle fest (`wegBestand` aus `MessstelleRegisterZeile.quelle.stand`); der Wechsel vom Ablesen zum Gerät gehört auf die Seite der Messstelle.
- „Aus anderen Messstellen berechnet“ ist bewusst kein dritter Weg im Dialog.
- Die Wörter kommen aus dem Glossar (`UEMS_WOHER_DIE_WERTE`, `UEMS_WEG_GERAET`, `UEMS_WEG_ABLESEN`, `UEMS_NOCH_KEINE_QUELLE`, `UEMS_ABLESERHYTHMUS`); `copy.test.ts` hält Liste und Dialog daran.

## Bestandsschutz der Bedienelemente (`migration.test.ts`, AP-03 IP-12)

- Jede Änderung eines Bedienelements aus `src/test/kundenBestand-vor-ip12.json` braucht eine Fortschreibung mit `vorher`, `nachher`, `commit` und `grund`.
- Ein ausdrücklich entfallenes Element (Neubau einer Fläche nach Konzept) trägt `"nachher": null`; der Wächter prüft dann, dass es wirklich fehlt.
- Fortschreibungen gelten auch für die Fingerabdrücke eines main-Nachzugs (`nz.main`).
- Die Fingerabdrücke einer Datei lassen sich mit derselben Regel wie im Test berechnen (TypeScript-Printer ohne Kommentare, Leerraum normalisiert, `key=` entfernt, SHA-256); nur Elemente, die schon im Ausgangsstand standen, brauchen einen Eintrag.

## Prüfen

- Echte Abnahme einer schreibenden Fläche neben der Demo: eigene API auf einer DB-Kopie (Rezept in `infra/local/demo/README.md`, „Abnahme einer API-Änderung neben der Demo“), Vorschau des gebauten Portals mit der Demo-CSP und `/api` auf diese API.
- Die Konsole der Keycloak-Anmeldeseite der Demo meldet `authChecker.js` 404 und eine Sandbox-Warnung des Silent-SSO-Rahmens; das ist nicht das Portal.
