# UEMS-Kennzahl-Rechenlauf (AP-11 IP-6)

Der Kennzahl-Schritt im Stundentakt `EndgueltigkeitLaeufer`: Endgültigkeit → Tage → Monat/Jahr → berechnete Messstellen →
**Kennzahlen** → Korrektur-Vorschläge. Code: `uems/KennzahlLauf`, Leser `uems/KennzahlEingangLeser`, Regel
`uems/KennzahlRegeln.wert` (die EINZIGE Stelle, die rechnet). Spezifikation: AP-11 §8 IP-6, E3/E4/E5, Q1–Q10.

## Was er tut

- **Ordnung** über `BerechnetePeriode.reihenfolge` (aufgerufen, nicht nachgebaut): Kanten = Kennzahl-Eingänge jeder wirksamen
  Fassung. Kreis → `Lauf.abgelehnt` mit `formel_kreis` + Kette bzw. `haengt_an_kreis`, keine Zeile. Archivierte Kennzahlen sind
  kein Knoten (V5: gelesen, nicht gerechnet).
- **Lesen** nur über `KennzahlEingangLeser` — dieselben Wege nutzt die Vorschau (`KennzahlVorschauService`). Messstelle über
  `MessstelleWerteService.werte` (gemessen und berechnet), Bezugsgröße über die wirksame Fassung, Stammdatum am Stichtag
  (`BezugsgroesseService.stammdatum`), Kennzahl über ihre gespeicherte Zeile derselben Periode.
- **Drei Wege je Periode** (`KennzahlLauf.weg`): `direkt` (Grundperiode; gröbere, wenn jeder Eingang sie selbst liefert —
  Messstelle, Stammdatum, Kennzahl), `ebene` (Zusammenfassung über ihre Paare), `zeit` (gröbere Periode einer Zusammenfassung
  oder mit feinerer Periodenwert-Bezugsgröße: Σ ÷ Σ über die EIGENEN Teilperioden, K14).
- **Schreiben** als `adminJdbcTemplate` (einzige Rolle mit INSERT), eine Transaktion je Periode, Advisory-Lock je Kennzahl.
  Flag `voltpilot.uems.kennzahlen.enabled` (Vorgabe an) schaltet nur diesen Schritt ab.

## Fallen

- ⚠ **Kein Mittel, keine Division** außerhalb von `KennzahlRegeln` — `KennzahlLaufQuelltextTest` wacht über Lauf, Leser und
  Vorschau. 0,32 (K3) und 0,2346 (K14) prüft `UemsKennzahlRechenlaufTest` gegen JEDE Zahl des Kundenbereichs.
- ⚠ **Zeile oder keine (P4/P6):** ohne jeden Periodenwert-Eingang keine Zeile (ein Stammdatum zählt nicht); laufende Periode
  mit Periodenwert-Nenner = „keine Werte“ `periode_nicht_zu_ende`, sonst erst, wenn alle Eingänge eine Zahl tragen.
- ⚠ **Endgültig bleibt stehen:** der Regellauf bildet NIE Version n + 1 (kein Anlass). Das tut die Kaskade über denselben
  Code, `KennzahlLauf.nachKorrektur` (IP-8, `uems-kennzahl-kaskade.md`; der Nenner-/Definitions-Auslöser IP-9 folgt).
- **`kennzahl_neu_gebildet` schreibt der Regellauf nicht — und muss es nicht:** der Vertrag meldet NUR einen ENDGÜLTIGEN Wert
  als Version n + 1 mit Anlass, vorläufige ziehen ohne Meldung nach. Erzeuger ist die Kaskade (`KennzahlNeuGebildet`,
  Vokabular seit `V20260915061500`). AP-12 erkennt eine erste Bildung oder ein Nachziehen ohne das Ereignis über die
  Versions-Zeilen (`berechnet_am`).
- ⚠ **Nachziehen trägt den Anlass seiner Version** (Trigger `kennzahl_wert_version_folgt`): eine vorläufige Version 2 der
  Kaskade zieht im Regellauf mit `K-…` nach, nicht mit NULL.
- ⚠ **V3 über den Vergleich:** unverändert = gleiche Zahl, Zustände, Kennzeichen, Fassung UND gleiche Eingänge
  (`KennzahlRepository.eingaengeText`); `berechnet_am` muss nach der neuesten Zeile liegen (Trigger), sonst Warnung ohne Zeile.
- ⚠ **Zeit-Perioden haben keine Eingangs-Zeilen ihrer Teilperioden:** die Teilperioden sind Zeilen derselben Kennzahl,
  `kennzahl_wert_eingang` verbietet den Selbstverweis. Eine Zusammenfassung nennt stattdessen ihre Paare DERSELBEN Periode
  (IP-11, `uems-kennzahl-zusammenfassung.md`); jede andere Zeit-Periode hat keine Eingänge — die Herkunft der Route (IP-7)
  ist dort `satz` null, `fehlt` `[eingaenge]`.
- ⚠ **Paar ohne Zahl (Nenner 0) zählt mit (K9)** — ohne Version trägt die Zeile keinen vorläufig/endgültig-Zustand; als Teil
  ist sie endgültig, wenn ihre eigenen Eingänge es sind (`KennzahlLauf.zaehltMit`, IP-11). Zustand des Paars = schlechtester
  seiner Eingänge (`eingangZustand`).
- ⚠ **Nicht gebaut / nicht erreichbar:** Wochen (IP-12), Bezugsfläche als Nenner (keine Bezugsgröße mit Kennzeichen, K12 nur
  mit Stammdatum), Kanal-Bezugsgröße mit eigenem AP-08-Zustand (AP-09 IP-17), Hinweis „Eingang außerhalb“ (K22).
- ⚠ `EndgueltigkeitLaeufer` hat zwei Konstruktoren: der alte (5 Argumente) ohne Kennzahl-Schritt für die Tests der Stufen
  davor, der `@Autowired` mit `@Nullable KennzahlLauf`.

## Prüfen

`KennzahlLaufQuelltextTest`, `EndgueltigkeitLaeuferReihenfolgeTest`, `EndgueltigkeitWiringTest` (rein);
`UemsKennzahlRechenlaufTest`, `KennzahlApiTest` (Testcontainers).
