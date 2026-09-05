# Die `:8484`-Ladepunkt-Flaeche ist die EINZIGE bedingte Accordion-Gruppe

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 66).


- **⚠ Die Gruppe „Ladepunkte" wird `hidden` AUSGELIEFERT und von `ocpp.js`
  eingeblendet.** Die VIER festen Gruppen sind die Zusage der Seite („eine
  fertig eingerichtete gesunde Anlage zeigt vier ruhige Zeilen") — eine fuenfte
  Zeile auf jeder Anlage OHNE Ladesaeulen waere genau das Rauschen, das der
  Umbau beseitigt hat. `TestEinrichtenAccordionIsFourClosedGroups` zaehlt sie
  deshalb heraus und nagelt zugleich fest, dass sie versteckt ausgeliefert wird.
- **⚠ Das Einblende-SIGNAL ist seit dem 24.08.2026 ein anderes, und genau
  deshalb haelt die Zusage weiter.** Vorher genuegte „der Server laeuft"
  (`ocpp.enabled`) — mit `VP_OCPP_ENABLED` als Opt-out laeuft er auf JEDER Box,
  die Gruppe waere also die staendige fuenfte Zeile geworden. `VPOcpp.zeigeGruppe`
  fragt seither, ob es wirklich LADEPUNKTE gibt: eingetragene Kennungen ODER
  gemeldete Saeulen — plus den Tiefenlink `#ladepunkte`, damit ein Verweis von
  aussen nie ins Leere fuehrt. **Wer das Signal wieder auf `enabled` verkuerzt,
  bricht die Vier-Gruppen-Zusage; wer die Deep-Link-Haelfte streicht, bricht den
  Verweis.** Beides steht als eigener Fall in `jstest/ui.test.js`.
- **⚠ Der Host im Kopier-Feld kommt aus der ADRESSZEILE des Browsers, der Port
  von der Box.** Die Box weiss nicht, unter welchem Namen das LAN sie
  erreicht; ein erfundener Hostname auf einem Kopier-Feld ist schlimmer als
  keiner. Der Port ist dagegen die eigene Einstellung der Box.
  (`VPOcpp.endpointFor`, rein + getestet.)
- **READ + SETUP, kein Befehlspfad.** Es gibt bewusst KEINE Route, die eine
  Ladegrenze setzt — Grenzen kommen allein aus dem Lastmanagement, damit diese
  Flaeche nie ein zweiter, unarbitrierter Schreiber auf eine Kundenanlage wird.
  `TestThereIsNoRouteThatCommandsAChargingLimit` ist der strukturelle Waechter.
- **⚠ Die Stufen-Zeile (Stufe 2) WIEDERHOLT den Satz der Box, sie formuliert
  ihn nie neu** (`VPOcpp.budgetSourceLine` reicht `budget_note` durch): der
  deutsche Satz wird EINMAL geschrieben, in `lastmgmt/budget.go`, wie beim
  Einspeise-Waechter — zwei Renderings desselben Urteils koennten es sonst
  verschieden sagen, und nur die Box kennt die Zahlen dahinter. `budgetSourceTone`
  faerbt nur: jede BLINDE Stufe ist eine Warnung, „statisch" ist ehrlich und
  kein Fehler, und ein unbekanntes Wort wird nie zu einer erfundenen Warnung.
- **Die Einrichten-Seite zeigt das LEBENDE Budget** (`ocpp.budget_kw`), nicht
  das, was die Einstellungen allein ergaeben (`settings.budget_kw`) — seit
  Stufe 2 sind das zwei Zahlen, und eine Einrichtungsseite, die eine andere
  nennt als die Betriebskarte, waeren zwei Wahrheiten ueber eine Groesse.
- Jede Ableitung liegt rein in `window.VPOcpp` (`jstest/ui.test.js`): die
  Budget-Zeile behauptet nie einen Messwert, den niemand gemeldet hat; die
  Ausfall-Zeile zeigt die RECHNUNG statt einer nackten Zahl und wiederholt
  ohne berechenbaren Wert den GRUND; eine getrennte Saeule nennt die FOLGE
  („behaelt ihr Sicherheitsprofil"), nicht nur die Tatsache; und das
  Entfernen sagt vorher, was BLEIBT.
- **⚠ `static/*` ist `//go:embed`-t — nach jeder Aenderung den Core neu bauen.**

