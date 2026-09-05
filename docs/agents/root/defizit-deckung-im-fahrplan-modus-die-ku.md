# Defizit-Deckung im Fahrplan-Modus: die Kundenvertrauens-Regel unter der Ökonomie

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 126).


Captain-Entscheid 28.08.2026 („beides bauen"), Live-Fall Pilsting/Herzogau
19:37: 92 % Speicher, PV 1,3 kW, Haus 2,7 kW - **1,4 kW Netzbezug zu ~25 ct**,
während der Plan-Slot 19:30-19:45 `battery_setpoint_kw = 0` sagte und die Box
das starr ausführte. **Regel seither: ein GEMESSENES Haus-Defizit wird in jedem
Fahrplan-Slot aus dem Speicher gedeckt, in dem der Plan nicht lädt und kein
Halte-Grund besteht - bis maximal zur Defizithöhe, nie mehr.**

- **Sie hat ZWEI Hälften, und das ist der Kern des Entscheids.** Cloud: der
  Optimierer markiert den Slot ökonomisch (`unplanned_load_discharge`,
  `slot_trim.py`). Edge: `guards.CoverDeficit` deckt das Defizit AUCH ohne diese
  Marke. Die zweite Hälfte ist nötig, weil die erste auf der PROGNOSE des Slots
  ruht - und genau die versagt in der Dämmerung.
- **⚠ Der behobene Cloud-Befund war die PLANNED-EXPORT-Sperre.** Sie las die
  prognostizierte Einspeisung des Slots als „bewussten Verkauf" und verweigerte
  die Pflicht genau dem Slot, der sie brauchte. In einem RUHENDEN Slot gibt es
  aber keinen Batterie-Verkauf zu schützen (die Einspeisung ist PV), und die Box
  deckelt auf das GEMESSENE Defizit - sie greift also nur dort, wo real bezogen
  wird. Die Schwester `cover_load_from_battery` behält die beidseitige Sperre:
  ihre Edge-Durchsetzung BEGRENZT auch, ein markierter Verkaufs-Slot würde also
  auf Netz 0 zurückgeschnitten.
- **⚠ Die Edge-Regel ist eine VERTRAUENS-, keine Wirtschaftlichkeitsregel**
  (`edge-app/core/internal/guards/deficitcover.go`). Sie entscheidet nie, OB
  Zyklen sich lohnen; sie weigert sich nur, Energie zu KAUFEN, auf der die
  Anlage steht, während der Plan nichts verlangt. Jeder echte Preis-Entscheid
  des Plans bleibt unberührt: eine geplante LADUNG wird nie umgedeutet, ein
  geplanter VERKAUF tiefer als das Defizit lässt gar keinen Restbezug übrig
  (Eintritts-Totband 0,2 kW), und die Korrektur ist **DEEPEN-ONLY** - eine
  Entladung zu BEGRENZEN ist ein Preis-Entscheid und bleibt bei der Wolke.
- **Die Halte-Gründe wohnen beim Aufrufer** (`agent.applySetzpoint`-Kette), weil
  nur er sie sieht: Anlagen-Pause, fremder Holder (Handeingriff „Speicher
  halten", jeder Flow/Override-Wunsch), `owner_claimed`, die
  Eigenverbrauchs-Sicherung (die ohnehin PV − Last folgt), ein veralteter Plan
  und die beiden Schreib-Tore samt gehaltenem Rücklesen. In der Entscheidung
  selbst: Lade-Slot, Reserve-Boden (`effective_floor_soc_pct`, der VOLLE
  Stapel), veraltete Messung, Verkaufs-Schutz. **⚠ Es gibt genau EINE
  Hysterese, und sie gehört dem Follower** (Eintritt ab 0,2 kW, Freigabe
  nach 90 s) - die Entscheidung schärft nur über einem Rausch-Boden von
  0,05 kW; eine zweite Schwelle stritte mit ihr genau an dem Wert, an dem
  es zählt.
- **⚠ Der Peak-Guard braucht KEINE eigene Sperre** (bewusste Abweichung vom
  Auftrags-Wortlaut): seine Reserve steckt bereits im `effective_floor`, und er
  läuft NACH der Korrektur und senkt den Sollwert nur weiter - ein Vertiefen
  kann eine Spitzenverteidigung also nicht rückgängig machen. Ihn pauschal als
  Halte-Grund zu lesen (`peakActive` ist „das Modul misst", nicht „es greift")
  hätte die Deckung auf JEDER Lastspitzen-Anlage dauerhaft abgeschaltet.
- **⚠ Die enge Vollakku-Entlastung von 27.08. ist ERSETZT, nicht ergänzt.** Sie
  griff nur ab `soc_max − 1` und gab nur ein Fünf-Punkte-Band frei - beides ist
  in der allgemeinen Regel strikt enthalten (deren Boden ist der volle
  Reserve-Stapel). Zwei Vertrauensregeln für dieselbe Handlung wären zwei
  Hysteresen und zwei Ausführungs-Namen. Das Wort `high_soc_follow` bleibt in
  api- und Portal-Vokabular stehen, weil eine Box auf einem älteren Abbild es
  weiterhin meldet; kein aktueller Build erzeugt es. Die LADE-Hälfte
  (`guards.HighSocCharge` / `high_soc_charge` / „PV-Puffer-Nachladung") ist
  unverändert geblieben - sie füllt das obere Band in einem ausdrücklich als
  `cover_load_from_battery` markierten Slot aus gemessenem PV-Überschuss nach.
- **⚠ Sie autorisiert die Wechselrichter-Automatik NICHT.** Der native Modus ist
  eine prüfstand-gegatete Gerätefähigkeit an der ökonomischen Wolken-Pflicht;
  die lokale Regel fährt den bewährten exakten Sollwert-Pfad und meldet ihren
  eigenen Ausführungs-Modus **`deficit_cover`** / „Live-Lastdeckung".
- **Beweise:** rein `guards/deficitcover_test.go` (jeder SoC über der Reserve,
  nie darunter, Verkauf/Ladung/Rauschen/blind) + der Deepen-only-Block in
  `guards/loadfollow_test.go` (inkl. des nicht-vakuumen Kontrasts: dieselbe
  Zahlenlage BEGRENZT die Wolken-Pflicht sehr wohl) ·
  `agent/load_follow_test.go` (der 19:37-Fall Ende-zu-Ende bis 0 kW Netz, die
  Freigabe am Reserve-Boden, Verkauf und Ladung unangetastet) ·
  `tests/test_unplanned_load_discharge.py` (die Prognose-Einspeisung sperrt
  nicht mehr, die Schwester schon) · api `ControlStatusListenerTest` (das neue
  Wort wird verstanden - sonst verwürfe der Ingest den GANZEN Block) · Portal
  `control.test.ts`.
- **Ops:** keine neue Pflicht-Variable, keine Migration. Cloud-Hälfte wirkt mit
  dem Deploy; die Edge-Hälfte reist mit dem nächsten Edge-Release.

