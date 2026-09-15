# UEMS-Messstellen-Dialog: anlegen und bearbeiten in drei Schritten

Neu am 15.09.2026 (AP-04 IP-6, Mockups D1–D3). `frontend/portal/src/components/MessstelleDialog.tsx`
rendert, `src/messstelleDialog.ts` entscheidet (rein). Zentriertes `Modal` (am Telefon Vollbild),
Schritte Identität · Zuordnung · Quelle. Beweis: `messstelleDialog.test.ts` (Pflichtfelder,
Kennzeichen-Format und Vorbelegung, jeder Satz gegen die FEHLER-Tabelle §5.12 wörtlich),
`components/MessstelleDialog.test.tsx` (gestellte Schnittstelle: 409 belegt, 409 Hauptzähler →
Wortlaut), `e2e/messstelle-dialog.spec.ts` (375 und 1440 px, 0 px Querlauf am Dokument und im Dialog;
Bilder mit `MESSSTELLE_DIALOG_BILDER=<Ordner>`). Fixtures: `src/test/messstelleDialogFixtures.ts`.

## Öffnen

`<MessstelleDialog open messstelleId={null | id} standortId={…} onClose onGespeichert />` — `null`
legt an, eine ID bearbeitet; `standortId` ist die Vorgabe des Orts (§5.1). `onGespeichert` kommt JE
SCHRITT, der gespeichert hat. Geöffnet wird er vom Register (`pages/MessstellenPage.tsx`, IP-5): „Messstelle anlegen“ im Kopf
bzw. im Leerzustand „noch keine Messstelle“, `standortId` = Standort der Seite; hat ein Schritt
gespeichert, liest das Register nach dem Schließen neu. „Bearbeiten“ hat noch keinen Einstieg — der
kommt mit der Messstellen-Seite (IP-8).

## ⚠ Die Fallen

- **Jeder Schritt speichert seinen Teil** über die Route, die es gibt — eine Transaktion über POST,
  PUT ort, PUT stellung und POST quellen gibt es nicht. „Weiter: Zuordnung“ legt an (ohne Ort ein
  ehrlicher Entwurf), „Weiter: Quelle“ schreibt Ort und Stellung ab dem Tag, „Fertigstellen“ bindet.
  Eine Ablehnung lässt den Dialog im Schritt, und von DIESEM Schritt ist nichts gespeichert (beim
  Hauptzähler-409 steht der Ort schon, die Stellung nicht — genau das Verhalten der Tabelle). Der
  `ZuordnungBestand` verhindert, dass ein Wiederholen den Ort doppelt schreibt; derselbe Tag wie
  das laufende Intervall wird `korrektur: true`.
- **Nach dem ersten Speichern sind Art, Medium, Hauptgröße und Nebengrößen fest** — die Schnittstelle
  hat dafür keinen Schreibweg (`PUT` = Kennzeichen · Name · Notiz · Anschlussleistung). Nebengrößen
  gibt es darum NUR beim Anlegen, und der Passungs-Satz nennt „ändern Sie die Wertart“ im Dialog nie
  (`passtNichtSatz(…, wertartAenderbar: false)`; der Test pinnt die volle Tabellen-Fassung mit `true`).
- **PUT ersetzt ganz:** `bearbeitenAnfrage` schickt `anschlussleistung_kw` aus dem Bestand mit
  (AP-08 IP-7), sonst wäre sie nach dem Umbenennen leer.
- **Kennzeichen:** vorbelegt aus `GET …/kennzeichen-vorschlag`; unverändert oder leer fehlt es in der
  Anfrage (nur dann rückt der Zähler vor). Nichts wird umgewandelt (`ms-01` ist ein Formfehler).
  „Vorschlag bleibt stehen“ ist der Knopf „Vorschlag MS-0022 übernehmen“.
- **Sätze nur aus der FEHLER-Tabelle, gebaut aus den Fakten** (`ablehnung`): der Hauptzähler-Satz
  braucht den Anlagen-Namen aus den geladenen Standorten; kennt der Dialog ihn nicht, gilt der Satz
  der Schnittstelle (derselbe Wortlaut), ihr Zusatzsatz bei anderer Richtung bleibt. Ein neuer Satz
  gehört in `messstelleDialog.ts` UND in die Tabelle von `messstelleDialog.test.ts`.
- **Regeln aufrufen, nie nachbauen:** Form `kennzeichenFormatGueltig`, Katalog `GROESSEN_KATALOG` /
  `groessePruefen` (ohne `saldiert`), Passung `passung` (Regel 7). Der Hauptzähler wird nur ANGEZEIGT
  („in … schon MS-01, MS-02“), nie gesperrt: zwei Hauptzähler desselben Zählers sind erlaubt, urteilen
  kann nur der Server an jedem Tag.
- **Bearbeiten löst nie still einen Zählerwechsel aus:** hat eine Größe eine laufende oder
  angekündigte führende Quelle (`laufendeQuelle`), bietet Schritt 3 für sie keinen Messwert an — eine
  neue Quelle beendete die laufende (Regel 2).
- **Prozess und Kostenstelle (D2) stehen NICHT im Dialog:** sie haben eigene Wege
  (`PUT …/prozesse`, Verteilung AP-10 IP-8) und gehören zur Messstellen-Seite (IP-8, Karte
  „Organisation“). Beide sind für „eingerichtet“ keine Voraussetzung.
- **Zeitpunkt der Quelle** über `geraetEinstellungen.zeitpunktAus` (Europe/Berlin, nie geraten an der
  Zeitumstellung) — Wien und Zürich haben dieselben Regeln; eine andere Zeitzone bräuchte die
  Erweiterung dort.
- **Steuern und Geld kommen nicht vor** (Captain-Regeln „wer nur misst, hört nichts vom Steuern“ und
  „keine Geldanzeige“).
- **Das Register von heute** (Hauptzähler, „Unterzähler von“) liest der Dialog über dieselbe
  `api.messstellenRegister()` wie die Register-Fläche (IP-5), ohne Filter und ohne Stichtag.
