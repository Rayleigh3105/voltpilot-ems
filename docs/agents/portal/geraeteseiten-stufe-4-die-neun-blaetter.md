# Geräteseiten Stufe 4: DIE NEUN BLÄTTER — je Gerätetyp genau das, was er braucht

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 12).


Scout `data/vp-geraeteseite-rahmen-r2` §5 (die Geräteliste aus dem Code + die neun Blätter) + §8
Stufe 4; Captain-Entscheide **Batterie = Teil des Hybriden** (kein eigenes Blatt, §5.3) und
**Wärmepumpe = schaltbarer Verbraucher** (Hilfetext, nie Titel). **Reine Portal-Arbeit — kein
Endpunkt, keine Migration, kein Feld auf dem Draht:** jeder Wert kommt aus einer BESTEHENDEN
Ableitung (`controlStrip` · `abregelungDiesesGeraets` · `speicherAktionen` · `sofortAktionen` ·
`fulfilmentSummary` · `consumerHasMeasurement` · `lanZeile` · `einspeiseSektion` ·
`deviceLimitLine` · `channelLabel`), es entsteht kein zweiter Satz und keine zweite Zahl.

- **`src/geraetGesicht.ts` entscheidet je Gattung den HELDEN und die SEKTIONS-MENGE**, die
  Ordnung gehört seit Stufe 1 dem Rahmen (`KANONISCH` filtert die kanonische §4.4-Folge — **ein
  Blatt LÄSST AUS, es sortiert nie um**). `components/GeraetRahmen.tsx` und die Sektions-Bauteile
  sind unverändert geteilt: sieben Gesichter wären sieben Stellen, an denen eine Regel vergessen
  werden kann.
- **⚠ `eigenbau` ist eine EIGENSCHAFT, keine Gattung.** §5.6 und §5.8 überlappen (`modbus-generic`
  steht in beiden), und `komponenten.componentRole` gibt einem selbst gebauten Sensor per Katalog
  die Rolle `grid` → Gattung `zaehler`, einem Schalter `consumer` → `verbraucher`. Der Beleg ist
  `PlantComponent.freigabeFaehig`; ein Eigenbau BEHÄLT damit sein Blatt und bekommt zusätzlich
  seine SELBST definierten Kanäle als Kacheln (`eigenbauKacheln`, in Zähler-, Verbraucher- UND
  Rückfall-Gesicht) — und verliert die Software-Sektion (§5.8: „nicht lesbar → Sektion entfällt").
- **⚠ `Held.zeilen` trägt, was eine Kachel nicht sagen kann** — die D3-Bestätigungsstufe („Energie:
  gemessen" vs. „angenommen (Nennleistung × Zeit)") und die Erfüllungs-Kopfzeile, beide WÖRTLICH
  aus ihrer geteilten Ableitung. **Ohne gemeldete Erfüllung steht dort NICHTS**, und ohne
  `gemessen`-Beleg wird die Stufe gar nicht behauptet.
- **⚠ `HeldKachel.key` ist der stabile Sprung-Anker, NIE das Label** — der Kunde darf eine
  Komponente umbenennen, die Adresse darf davon nicht abhängen. `SPEICHER_KACHEL` ist der eine
  exportierte Schlüssel, den die Batterie-Zeile des Anlagen-Modells anspringt.
- **§5.3 · die Batterie hat KEINE eigene Seite.** Ihre Komponenten-Zeile führt auf das Hybrid-Blatt
  (`abschnittHash(karteHref, 'jetzt', SPEICHER_KACHEL)` → `?abschnitt=jetzt&kachel=speicher`) und
  markiert dort genau ihre Kachel (`.is-markiert`, eine ANTWORT auf den Klick, kein Zustand).
  **`?kachel=` ist ein PARAMETER im Hash, nie eine zweite Raute** (der HashRouter läse sie als
  Route) — gelesen beim Aufbau UND bei `hashchange`, wie der Abschnitts-Sprung des Rahmens.
  Ohne Geräteseite gibt es den Absprung nicht (die `registerZugang`-Regel).
- **§4.6 ist jetzt VOLLSTÄNDIG bedient: `Gesicht.entfallen` trägt je entfallener Sektion ihren
  GRUND**, und der Wirt reicht ihn als `SektionAngebot.grund` weiter — in die Diagnose. Vier
  Sektionen können strukturell wegfallen: `befehle` (an einen Zähler geht keiner), `steuerung`
  (`Gesicht.steuerung` — sie erklärte dort nur ihre eigene Nicht-Zuständigkeit), `register` (HTTP /
  OCPP) und `software` (Eigenbau). Der frühere lokale `ohneRegisterSatz` des Wirts ist ERSATZLOS
  entfallen — zwei Formulierungen desselben Grundes wären zwei Urteile.
- **⚠ „Steuerung & Grenzen" gibt es seit Stufe 4 NICHT mehr immer.** Der Wirt hatte es hart
  verdrahtet („gibt es IMMER: die Steuerungs-Bezüge sind in jeder Gattung dieselbe Auskunft") —
  auf einem Zähler war das eine Sektion, die nur sagt, dass sie nichts zu sagen hat.
- **§5.4 · die primäre Handlung steht IM Helden**, nicht erst in der Aktionszeile darunter — und es
  ist DIESELBE, die die Zeile anbietet (`aktionen.find(a => a.art === 'verbraucher')` → derselbe
  `aktionAusloesen`): **kein zweiter Auslöse-Pfad**, die Folgenliste bleibt im bestehenden Dialog.
- **§5.7 · `blattHinweis` ist ein HILFETEXT, nie ein Titel** (Captain): eine Wärmepumpe ist im
  Katalog kein eigener Typ, sie läuft als `generic-load`/`pump` über ein Schaltrelais. Er steht in
  „Steuerung & Grenzen", wo die Grenzen dieses Geräts stehen. Seine Signatur ist bewusst
  `Pick<GesichtInput, 'komponenten' | 'entities'>` — ein Aufrufer soll dafür keinen ganzen
  Gesichts-Eingang zusammenbauen müssen.
- **⚠ `eigenerVerbraucher` steht im Wirt VOR dem Gesicht**, obwohl `consumers` erst geladen wird,
  wenn das Gesicht die Gattung `verbraucher` gesagt hat: die Gattung hängt an Rolle und
  Entitätstyp, nie an dieser Liste, also konvergiert es in zwei Läufen — eine Schleife gibt es
  nicht. Umgekehrt wäre es ein TDZ-Fehler.
- **§5.9 · die Box** (`BoxSeiteSection`) und **§5.5 · die Ladesäule** (`OcppWallboxPage`) waren
  schon vor dieser Stufe eigene Blätter im Rahmen und sind unangetastet.
- **⚠ Die REGISTER-Sektion gehört Stufe 3a** (`BeobachteteRegister`, der Abschnitt darüber): Stufe 4
  entscheidet nur, OB es sie gibt (`registerMoeglich`) und mit welchem Grund sie sonst entfällt — ihr
  INHALT und ihre Kurzfassung (`beobKurz`) bleiben unangetastet. Die beiden greifen an genau einer
  Stelle ineinander: der frühere lokale `ohneRegisterSatz` des Wirts ist durch `entfallGrund('register')`
  ersetzt, damit derselbe Grund nicht an zwei Stellen formuliert wird.
- **Beweise:** `geraetGesicht.test.ts` (27, davon 9 neu: je Gattung die Kacheln UND die
  „braucht NICHT"-Gegenprobe — Zähler ohne Befehle und ohne Steuerung, Eigenbau ohne Software,
  Wallbox ohne Register, die kanonische Ordnung über alle Gattungen) · `geraetRahmen.test.ts` (47,
  +3 für `?kachel=`) · `pages/GeraetSeiteSection.test.tsx` (38, +4 am DOM) ·
  `pages/AnlagenModellSection.test.tsx` (50, +2 für den §5.3-Absprung). **Die vier DOM-Wächter und
  der Absprung sind mutationsgeprüft** — jede zurückgedrehte Regel lässt sie fallen.

