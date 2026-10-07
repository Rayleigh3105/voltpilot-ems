# Messen: die Ablese-Runde je Gebäude

Stand: Messen-Bau m2, PR3 (Konzept `data/vp-messen-konzept-m1` §6.5 Variante 3A, Entscheid 11).

## Adresse und Einstiege

- Die Runde ist ein Zustand der Messstellen-Route: `#/portfolio/messstellen?ablesen=G-1` (am Standort `#/standort/{id}/messstellen?ablesen=G-1`); `MessstellenPage` liest den Parameter über `hashchange` und zeigt statt der Liste `AbleseRunde`.
- Einstiege: „Ablesen ›“ im Kopf einer Ortskarte der Liste (nur heute, nur mit `ablesung.erfassen` am Standort des Orts) und der Schritt „Ablesungen eintragen“ der Wiedervorlage (`eintragSprung`, mehr als ein Zähler).
- „Öffnen“ im Jahresplan der Wiedervorlage bleibt ein Ansehen: `ansehenSprung` macht aus `?ablesen=G-1` das Register desselben Orts (`?ort=G-1`).
- Das Ziel der Wiedervorlage (`data-entscheid="zaehlerablesung"`) ist das erste noch nicht gespeicherte Feld der Runde.

## Regeln

- Welche Zähler: die Ablesezähler, deren Ableseort der Ort ist (`ableseortVon` in `messstellenListe.ts`, dieselbe Regel wie `MessstelleRegisterService.ableseort`: das erste Gebäude auf dem Pfad, ohne Gebäude der Standort), im Ort der Hauptzähler zuerst, dann nach Kennzeichen - wie die Runde der Wiedervorlage.
  Die Runde eines Standorts nimmt also nur die Zähler ohne Gebäude; ein Bereich hat keine eigene Runde, seine Ortskarte öffnet die seines Gebäudes.
- Ein Gebäude nur mit Zählern in Bereichen kennt das Register nicht beim Namen; den Titel liefert dann der Ortsbaum (`standortOrte`), bis dahin das Kurzzeichen.
- Gleiche Route (`POST …/ablesungen`), gleiche Rechte, gleiche Prüfung wie „Ablesung eintragen“; der Monat ist die Vorgabe des Zwillings `bezugsdaten.zuordnung` (größter Anteil).
- Was die Runde nicht selbst entscheidet, steht als Satz am Zähler und wird an der Messstelle eingetragen: ein Zeitpunkt vor der letzten Ablesung und ein Zeitraum über drei oder mehr Monate (keine Vorgabe).
- Felder sind während des Speicherns `readOnly`, nie `disabled` - sonst verliert das Feld den Fokus und der Kunde muss nach einer Ablehnung neu hineintippen.
- „Fertig“ speichert, was eingetragen und noch nicht gespeichert ist; ein abgelehnter, seither unveränderter Stand geht nicht noch einmal hinaus, und die Runde bleibt dann offen.
- Ein neuer Zeitpunkt setzt jede abgelehnte Reihe zurück auf offen (der Satz galt dem alten Zeitpunkt); „Fertig“ schickt sie dann noch einmal.
- Wer ein Feld mit neuem Stand verlässt, speichert ihn wie mit „Weiter“ (am iPhone hat das Ziffernfeld keine Eingabetaste); läuft das Speichern einer Reihe schon, wartet jeder weitere Weg darauf (`laufend`), es geht nie ein zweiter POST hinaus.
- Die Felder tragen 16 px, sonst zoomt iOS beim Antippen heran.
  Ob Enter und ∧∨ am echten iPhone so laufen, belegt nur ein Gerät, nicht Playwright `mobile-webkit`.

## Prüfen

- `src/ableseRunde.test.ts` (rein), `src/components/AbleseRunde.test.tsx`, `e2e/ablese-runde.spec.ts` (Bühne `messstelle-seite.html?wirt=1#/portfolio/messstellen?ablesen=G-1`, Uhr 02.11.2026, gestellte Antworten von `POST …/ablesungen`).
- Schreibende Abnahme nur gegen eine eigene API auf einer Kopie der Demo-Datenbank; jeder Lauf hinterlässt dort Ablesungen, ein zweiter Lauf zur selben Minute trifft „Zu diesem Zeitpunkt gibt es bereits …“.
