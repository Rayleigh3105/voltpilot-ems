# Steuerung Stufe 0 „Entwirrung": das Regal sind die BETRIEBSMODELLE

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 117).


Erste Stufe des Steuerungs-Umbaus (Konzept `data/vp-steuerung-konzept-b3` §2/§5 Stufe 0/§6b #1;
Captain-Entscheide 25.08.2026). **Reines Ausblenden — KEINE Datenänderung:** keine Migration, keine
Zeile in `site_profile_state` wird gelöscht oder geändert (das ist Paket 8/9), und alles ausserhalb
des Regals verhält sich zeichengleich wie vorher.

- **⚠ Der behobene Befund ist ZUSCHNITT, nicht Datenlage.** Das Regal zeigte NEUN Zeilen in EINER
  Optik: zwei BASIS-Anwendungen mit einem `role="switch"`, den `SiteProfileService` mit **400**
  („ist immer an und lässt sich nicht abschalten") beantwortet; drei REGEL-Anwendungen mit einem
  Schalter, der ausser einer Absichts-Zeile **nichts** auslöst (kein Gate, kein Starter); und die
  vier Geschäfts-Anwendungen. Dazu als Untertitel je Zeile der BEITRAG — eine Zahl nur bei einem
  aktiven Modus, sonst „—", auf einer Privat-Anlage also **neun Mal „—"**.
- **Das Katalog-Feld `regal`** (`anwendungen/catalog.json`, beide byte-gleichen Kopien) ist seither
  die Regal-Frage; `sichtbar` bleibt daneben die ANDERE Frage („GIBT es die Anwendung schon?" —
  `reserviert` = false). `regal` steht auf true für genau die vier Geschäfts-Anwendungen; das
  Kundenwort dafür ist **„Betriebsmodell"** (Captain 25.08.: „Anwendung" ist kein Kundenwort mehr).
  `AnwendungKatalog.regal()` liefert sie, `ausserhalbRegal()` den Rest, `sichtbare()` beides.
- **⚠ ZWEI Listen in `SiteProfilesDto`, und die zweite war eine NOTWENDIGKEIT.** `profiles` ist das
  Regal (server-seitig gefiltert), `weitere` trägt die Karten der Basis- und Regel-Anwendungen.
  Sie mussten mitreisen, weil zwei bestehende Flächen sie LESEN und ein blosses Weglassen dort eine
  stille Regression gewesen wäre: das Cockpit-Tor „ist Eigene Auswertung an?" (Anwendungs-Programm
  Stufe 5) und das Willens-Overlay der M0-Projektion, das ein gespeichertes `aus` sonst verlöre und
  einen abgeschalteten Modus wiederbelebte. **Stufe 0 blendet aus, sie löscht nicht** — jeder Zustand
  wird weiter beantwortet, und `PUT /profiles` bleibt für JEDE sichtbare Anwendung erreichbar. Das
  Feld ist additiv: ein älteres Portal liest nur `profiles` und sieht damit genau das Regal.
- **⚠ Der Phantom-Satz ist aus dem Katalog verschwunden.** Die zwei `leer_zustand`-Sätze der
  Regel-Anwendungen schickten den Kunden „unter „Komponenten & Regeln"" — eine Seite, die es NICHT
  gibt (die Navigation kennt „Anlagen-Modell" und „Steuerung"; die Regel-Liste wohnt auf derselben
  Seite eine Kapsel tiefer). Sie nennen jetzt „Regeln" auf dieser Seite; ein Test auf BEIDEN Seiten
  verbietet den alten Namen katalogweit.
- **⚠ Je Profil trägt HÖCHSTENS EIN Betriebsmodell `preset = "an"`** (Konzept §3.9): der Assistent
  schlägt genau eines vor, nie zwei. Dafür ist `marktvermarktung.preset.gewerbe` auf `angeboten`
  gerückt — `an` ist das STARTMODELL eines Profils, `angeboten` sein Rückfall, wenn dessen
  Voraussetzungen fehlen („Gewerbe: Lastspitzenkappung, wenn Leistungspreis hinterlegt, sonst
  Marktoptimierung, wenn Marktzugang"). Ein Profil OHNE `an` (Privat) schlägt NICHTS vor — der
  Eigenverbrauchs-Fahrplan ist Grundverhalten, kein Modus. `vorauswahl` läuft beidseitig über das
  Regal und liefert deshalb höchstens einen Eintrag; die Auswahl-Regel selbst lebt rein im Portal
  (`anwendungen.betriebsmodellVorschlag`), die DATEN-Invariante „höchstens ein `an`" ist in
  `AnwendungKatalogTest` festgenagelt.
- **Beweise:** rein `AnwendungKatalogTest` (22: Regal = die vier Betriebsmodelle, `regal` folgt der
  Klasse, ausgeblendet ≠ gelöscht, kein Phantom-Satz, höchstens ein Vorschlag je Profil) ·
  Testcontainers `SiteProfileApiTest` (echte DB + Keycloak: `profiles` = das Regal, `weitere` = der
  Rest, `berichte` in keiner der beiden, kein Phantom-Satz auf dem Draht). Portal-Seite (die Kapsel
  „Betriebsmodelle", der zweite Filter, der Wizard-Schritt „Betrieb") in `frontend/portal/AGENTS.md`.
- **NICHT in dieser Stufe:** die Jetzt-Zone (Stufe 1) · Regel-Karten + Folgen-Karte (Stufe 2) · und
  ausdrücklich die DATENBEREINIGUNG (Stufe 9: eine Migration löscht die
  `site_profile_state`-Zeilen der Klassen `basis`/`regel`). Die EXKLUSIVITÄT ist Stufe 5 — siehe
  den nächsten Abschnitt.

