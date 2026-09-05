# Der Register-Drawer wählt seit Stufe 2 ZUERST das ZIEL

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 4).


`components/RegisterWriteDrawer.tsx` über der reinen `src/registerWrite.ts`
(Konzept `data/vp-reg-schreib-konzept-p8` §2.3; Cloud-Seite: root `AGENTS.md`
„Register schreiben über das Portal, Stufe 2"). Er RENDERT nur - jeder Satz,
jede Warnklasse und jedes Urteil liegt in der reinen Schicht.

- **Vier Schritte statt drei: Ziel → Register + Ist lesen → Wert + bestätigen →
  Beleg.** Auf einer Anlage mit mehreren Geräten ist das Ziel eine bewusste
  Auswahl, nie ein Default im Verborgenen (§2.3 „Einheiten-/Mehr-Geräte-
  Klarheit"); ohne gewähltes Ziel ist „Ist-Wert lesen" gesperrt.
- **⚠ EIN GERÄT OHNE SCHREIBWEG STEHT IN DER LISTE - mit seinem Grund, nur
  nicht wählbar.** Es wegzublenden erzeugte die Frage „warum fehlt meine
  Wallbox?" und beantwortete sie nirgends; das ist derselbe
  Schutz-durch-Information, aus dem auch die Warnklassen nichts sperren.
  `writable` ist eine ANZEIGE-Hilfe des Servers, kein Tor - was wirklich geht,
  entscheidet die Box.
- **Die „Freie Adresse im Netzwerk" ist eine EIGENE Wahl**, keine Zeile des
  Pickers: sie meint ein Gerät, das niemand eingerichtet hat. `freieAdresseFehler`
  prüft nur die FORM - **ob eine Adresse belegbar PRIVAT ist, entscheidet die
  BOX**; eine zweite Wahrheit über ein Netz, das dieses Portal nie gesehen hat,
  wäre genau der Zwilling, den das Haus vermeidet.
- **⚠ DIE EINHEIT KOMMT VOM SERVER (`scaleUnit`) UND WIRD NIE GERATEN.**
  `wertAnzeige`/`bestaetigenLabel` hängen ohne sie KEIN „kW" an - ein Register
  ohne bekannte Skala zeigt nur die rohe Zahl. Ein „kW" hinter einem Ampere-
  oder Prozent-Register wäre die gefährlichste Beschriftung dieses Pfades. Aus
  demselben Grund sagt `registerKenntnis` bei einem Ziel ohne Familie
  ausdrücklich, dass geschrieben trotzdem geht - die Freiheit IST der Kern
  dieser Stufe, nur der Name fehlt.
- **Der Schreibzähler ist eine Information, keine Sperre** (`schreibzaehler`,
  EEPROM-Ehrlichkeit §2.9 Punkt 3) und steht in SCHRITT 2, also VOR dem Klick.
  Ohne Schreibvorgang heute wird auch nichts gesagt - eine „0×"-Zeile wäre Lärm.
- Der Picker ist fail-soft: ein Fehlschlag der Ziel-Liste blockiert die Strecke
  nie (die primäre Lane funktioniert auch ohne ihn).
- **⚠ EIN LANGER VORGANG SAGT SICH AN** (`LESE_LAEUFT` + `LESE_DAUER_HINWEIS`,
  Produktionsvorfall 20.08.2026). Eine Lesung darf bis zu einer halben Minute
  dauern — der Modbus-Knoten der Box hängt hinter der EINEN Warteschlange je
  Ziel und muss erst den laufenden Poll abwarten; die Cloud wartet seither
  entsprechend länger (Zeitfenster-Invariante, root `AGENTS.md`). Ein bloß
  ausgegrauter Knopf über 40 Sekunden liest sich als Defekt — genau dieser
  Eindruck entstand, als das Budget noch zu kurz war und der Vorgang wie ein
  Fehler aussah, während er in Wahrheit lief. Der Lese-Zustand hat deshalb einen
  EIGENEN Schalter (`liest`): während eines Schreibvorgangs ist `busy` ebenfalls
  gesetzt, und „Wird gelesen …" wäre dort schlicht falsch.
- Beweise: `registerWrite.test.ts` (+13) · `RegisterWriteDrawer.test.tsx` (+6:
  Ziel-Pflicht, das genannte Gerät ohne Weg, „nur die Kennung, nie ein Host",
  die freie Adresse, Zähler + Hinweis, keine erfundene Einheit).

