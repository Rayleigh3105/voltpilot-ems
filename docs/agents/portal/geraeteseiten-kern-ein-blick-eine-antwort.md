# Geräteseiten: der KERN — ein Blick, eine Antwort

Konzept „Geräteseiten: Ein Blick, eine Antwort" (25.09.2026), freigegeben mit Streichliste
S1–S7, V1–V9, K1–K4 und E1–E5 = a. Löst den Sektions-Rahmen aus
[Stufe 1](geraeteseiten-stufe-1-der-rahmen-durch-d.md) ab. **Rein Portal — kein Endpunkt,
keine Migration.**

- **Jede Geräteseite beantwortet im ersten Bildschirm drei Fragen** (ist alles in Ordnung ·
  was tut das Gerät · was kann ich tun) mit denselben FÜNF Bausteinen:
  Jetzt (Bühne) · Steuerung · Heute · Aktivität · Gerät & Verbindung. Die Ordnung lebt rein in
  `src/geraetRahmen.ts` (`BAUSTEIN_ORDNUNG`, `bausteine()`), die Fläche in
  `components/GeraetRahmen.tsx`. **Fehlt einem Typ ein Baustein, fällt er STILL weg** — kein
  Kasten, der erklärt, dass er leer ist (S5).
- **„Technik & Diagnose" ist eine eigene ADRESSE** (`?ansicht=technik[&abschnitt=teil]`, E1 a):
  Register/Messwerte · OCPP · Auswertung · Einrichtung · Rohdaten · Plattform-Sicht. Am Telefon
  schiebt sie, am Rechner blendet sie (`runPageTransition`). **Alte Lesezeichen bleiben gültig**
  (`ALTER_ABSCHNITT`: `?abschnitt=register` → Technik › Register, `jetzt` → Bühne,
  `befehle` → Aktivität …). Gesprungen wird weiter über `id` + Fokus, nie über einen `#anker`.
  ⚠ In Tests ist die Ansicht eine Adresse: nach einem Test, der sie öffnet, den Hash zurücksetzen.
- **Layout per Container-Abfrage** auf den Kern (≥ 860 px): links Bühne + Heute, rechts
  Steuerung + Aktivität, „Gerät & Verbindung" und „Technik & Diagnose" über die volle Breite
  darunter. Am Telefon stellt CSS `order` die kanonische Reihenfolge her; „Gerät & Verbindung"
  startet dort zu. Keine Sprungleiste (S4).
- **Nichts steht zweimal auf einem Bildschirm.** Die Bühne zeigt keine Chips für Zahlen, die ihre
  Grafik beschriftet (`grafikZeigt`); „nur Messung", „maßgeblich" und „VoltPilot steuert" stehen
  NUR als Kopf-Abzeichen; der Freigabe-Stand NUR in „Gerät & Verbindung"; der Grund einer Wallbox
  NUR in der Steuerung. Zustand und Datenalter trägt allein der Live-Punkt (S6/V1).
- **Die Grafik liest dieselben Zahlen wie die Kacheln** (`Held.werte`). Am Wechselrichter ist das
  Haus eine Rechnung — „abgeleitet" steht direkt am Wert. Bewegung nur über die bestehenden
  Fluss-Linien (`.vp-flow-line` + `useFlowTempo`), unter 0,05 kW keine Punkte.
- **Steuerung (K1) = EIN Schalter mit dem echten Zustand**, abgeleitet in `geraetSteuerung.ts`
  aus `steuerungJetzt` (keine zweite Steuerungs-Ableitung). Ein Segment öffnet nur den
  BESTEHENDEN Dialog. ⚠ An der Wallbox gilt die Zeile nur mit AKTUELLEM Beleg desselben
  Anschlusses (dieselbe Regel wie Freigabe und Grund) — sonst kein Schalter, und die Zeile
  „Sofort laden: nicht verfügbar" steht in den Details.
- **Heute (E2 a)** liest `entities/{id}/history?range=day`: keine erfundene Tagessumme (nur
  Höchst-/Tiefstwert mit Uhrzeit), Lücken und Zukunft bleiben `null`, immer der ganze Tag, die
  Achse an den WAHREN Stellen der Stunden (23/25-Stunden-Tage). Eine Reihe ohne Richtung
  behält ihr Vorzeichen und trägt keine Entlade-Farbe.
- **Das Unumkehrbare wohnt im Menü „⋯"** (V7): Entfernen/Löschen öffnen dieselben Rückfragen mit
  denselben Folgen wie vorher. Ein belegter Befund eines Technik-Teils steht schon an der
  geschlossenen Zeile (`TechnikTeil.hinweis`, z. B. OCPP-Lücken).
- **K4 · I/O-Modul:** ein Verbraucher am Relais eines Moduls hat die Seite `io-<Entität>`
  (`geraetAdresse`), gebunden über `plantModel(…, ioBindungenAus(consumers))`. Die Modul-Seite
  zeigt den Klemmenplan (belegter Ausgang führt zu seinem Verbraucher, freier Ausgang schaltbar);
  das Modul selbst gilt nicht als gesteuert. **Befehle eines `io-`Verbrauchers fragt die Seite
  über seine Komponente** (`?entity=`), nie über `device=io-…`. „Ist es ein Modul?" beantwortet
  EINE Regel (`geraetSeite.istIoModul`). Die freie Zuordnung von Aus- UND Eingängen ist ein
  eigenes, späteres Paket (E4 Schritt 2).
- **Beweise:** `geraetRahmen.test.ts`, `geraetSteuerung.test.ts`, `geraetHeute.test.ts`,
  `components/GeraetBuehne.test.tsx`, `consumers/ioZustand.test.ts`, K4-Blöcke in
  `geraetSeite.test.ts`/`komponenten.test.ts`/`GeraetSeiteSection.test.tsx`, dazu die Wirte
  `GeraetSeiteSection`, `BoxSeiteSection`, `OcppWallboxPage`. Browser bei 375 und 1440 px:
  kein Überlauf, keine Konsolenfehler.
