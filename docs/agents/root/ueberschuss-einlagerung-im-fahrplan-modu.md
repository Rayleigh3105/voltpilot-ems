# Überschuss-Einlagerung im Fahrplan-Modus: der Ladeboden unter der Ökonomie

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 125).


Der SPIEGEL der Defizit-Deckung darunter (Scout `data/vp-herzogau-einspeisung-statt-laden-h3`
§4/§8 B1, Captain-Auftrag 29.08.2026). Live-Fall Pilsting/Herzogau 10:53:
Speicher 38 %, PV 56,9 kW, Haus 29,0 kW - und der Fahrplan-Slot befahl **+9,82 kW
Ladung**, also gingen **~18 kW ins Netz bei NEGATIVEM Preis**. Die Prognose des
Slots war zu klein, weil der PV-Nowcast der Wolke die von UNSERER EIGENEN
Abregel-Kappe geklemmte Erzeugung gemessen hatte. **Regel seither: ein
GEMESSENER Solar-Überschuss, den der Plan nicht ausschöpft, wird eingelagert -
bis maximal zur Überschusshöhe, nie mehr.**

- **⚠ ZWEI EINTRITTE, und ihr Unterschied IST das Sicherheits-Argument.**
  **(B1) Der Plan LÄDT BEREITS** - die Speicher-gegen-Verkauf-Entscheidung
  dieses Slots hat die Wolke getroffen, korrigiert wird nur die MENGE, es gibt
  hier keinen Verkauf, den sie umdrehen könnte; **kein Diskriminator nötig**.
  **(B2) Der Plan RUHT** - ein ruhender Befehl mit grossem Überschuss kann auch
  „bewusst zum Spitzenpreis einspeisen" heissen, also braucht er den EINEN
  richtigen Diskriminator, den die Wolke ohnehin veröffentlicht:
  `cover_load_from_battery` steht auf einem „Netz ≈ 0"-Eigenverbrauchs-Slot und
  NIE auf einem Verkaufsslot. Der zweite Eintritt verlangt zusätzlich die Tore
  jeder lokal GESTARTETEN Richtung (Not-Aus, Familien-Zertifizierung, frisch
  gehaltenes Rücklesen) und kann erst greifen, nachdem der Follower eine
  veraltete Plan-Entladung auf echte Ruhe reduziert hat.
- **⚠ DIE SoC-BANDGRENZE IST ENTFALLEN (29.08.2026), und das war die eigentliche
  Lücke.** Die enge Ladeseite `guards.HighSocCharge` (`high_soc_charge`,
  „PV-Puffer-Nachladung") griff NUR zwischen `soc_max − 5` und `soc_max`. Der
  Live-Fall 10:14: Speicher **19 %**, PV 39,354 kW, Haus 16,383 kW, **22,8 kW ins
  Netz** - der Plan-Slot befahl eine veraltete Prognose-ENTLADUNG von −7,17 kW,
  die der Follower korrekt auf 0,0 kW begrenzte, und danach hob NICHTS an. Der
  ENTLADE-Zwilling (`guards.CoverDeficit`, PR 548) hatte genau diese Bandgrenze
  am 28.08. fallen lassen; die Ladeseite war zurückgeblieben. `highsoc.go` ist
  ERSATZLOS in `surplusstore.go` aufgegangen - zwei Vertrauensregeln für
  dieselbe Handlung wären zwei Hysteresen und zwei Ausführungs-Namen. Das Wort
  `high_soc_charge` bleibt in api- und Portal-Vokabular stehen, weil eine Box
  auf einem älteren Abbild es weiterhin meldet; **kein aktueller Build erzeugt
  es.**
- **⚠ DER EHRLICHE REST-EINWAND, nicht wegdiskutiert:** bei B2 wird ein
  UNERWARTETER Überschuss in einem ABEND-Deckungsslot eingelagert statt bei bis
  zu ~21 ct verkauft. Die Spanne ist λ gegen den Exportwert, die Menge ist ein
  Prognosefehler EINES Slots, und der nächste 15-Minuten-Lauf korrigiert die
  SoC-Bahn. Wer auch das ausschliessen will, braucht den Exportwert je Slot im
  Fahrplan-Kontrakt - also eine Vertragsänderung plus Edge-Release
  (Captain-Entscheid 29.08.2026: die EINFACHE Variante, kein Vertragsfeld). **B1
  trägt diesen Einwand nicht** - in einem ladenden Slot gibt es keinen Verkauf.
- **⚠ Warum die Wolken-Pflicht die Lücke nicht schliesst:**
  `charge_surplus_to_battery` prüft `η·λ − Verschleiß > Exportwert + Marge`, und
  **λ kollabiert auf ≈ Verschleiß/2, sobald die Plan-Trajektorie den Speicher im
  Horizont ohnehin voll macht** - also genau an den Überschuss-Tagen, für die die
  Pflicht gebaut wurde. Sie schwieg im Vorfall belegbar (`absorb: null` in allen
  Snapshots). Derselbe Befund stand schon in `vp-negativpreis-herzogau-g3` §4(f).
- **Die Edge-Regel ist eine VERTRAUENS-, keine Wirtschaftlichkeitsregel**
  (`edge-app/core/internal/guards/surplusstore.go`). Sie entscheidet nie, OB
  Zyklen sich lohnen; sie weigert sich nur, Energie zu VERSCHENKEN, die die
  Anlage gerade erzeugt, während der Plan sie schon speichern wollte.
- **Sie autorisiert den BESTEHENDEN `SurplusCharger`** statt eines zweiten
  Anhebe-Pfads: der angehobene Zielwert läuft erneut durch die autoritative
  `guards.Clamp` (Nennband, SoC-Decke, EEG-Solarladen, §14a-Hülle) und kann an
  keinem Wächter vorbeischreiben. Ladung ≤ Überschuss ⇒ vorhergesagtes Netz ≤ 0,
  also nie ein Import und ein Export nur in Richtung null.
- **⚠ B1 ist MAGNITUDEN-ONLY, deshalb OHNE gehaltenes Rücklesen** - anders als
  B2 und die anderen Regeln, die eine Richtung aus der Ruhe STARTEN
  (`deficitCover`, `unplannedLoad`, die alle `portableReady` fordern). Die Box
  schreibt diese Richtung ohnehin schon, und eine strengere Bedingung als die
  der grösseren Wolken-Absorption daneben wäre nicht zu begründen.
- **Die native Automatik wird während einer Einlagerung zurückgenommen**
  (`marketCorrectionsAllowed && !surplusStored`), weil ihr Prüfstand-Beleg nur
  autonome ENTLADUNG zertifiziert - unverändert die Regel der abgelösten engen
  Ladeseite.
- **Wo die WOLKE autorisiert hat, behält sie ihren Namen** (`absorb`): die
  lokale Regel etikettiert nie eine Entscheidung um, die der Plan getroffen hat -
  ein unverdienter Ökonomie-Anspruch wäre dieselbe Klasse Unehrlichkeit wie eine
  unbenannte Korrektur.
- **Heartbeat/API/Portal nennen sie `surplus_store` / „Live-Überschussladung"**
  (eigenes Wort, kein `absorb`). Der api-`ControlStatusListener` und die drei
  Portal-Register (`api.ts`, `control.ts`, `fahrplanJetzt.ts`, `flowConflict.ts`)
  kennen es; eine ältere Cloud VERWIRFT ein unbekanntes Wort und degradiert auf
  ihren generischen Satz - der dokumentierte gnädige Pfad.
- **Beweise:** rein `guards/surplusstore_test.go` (beide Live-Vektoren, „Netz
  landet exakt auf 0", jeder SoC unter der Decke, der abgelöste 91-%-Vektor
  unverändert, alle Verweigerungen inkl. „ohne Marke wird nichts umgedeutet") ·
  `agent/surplus_store_test.go` (BEIDE Vorfälle Ende-zu-Ende: +9,82 → +27,894 kW
  und −7,17 → +22,971 kW, je Netz 0,000; Nennband-Deckel; Verkauf / Ruhe ohne
  Marke / Ruhe ohne Rücklesen / blind / Decke unangetastet; die Wolke behält
  ihren Namen; die Pause meldet keine Korrektur) ·
  `agent/load_follow_test.go` (der 91-%-Vektor der abgelösten Regel läuft
  unverändert durch die allgemeine) · api `ControlStatusListenerTest` · portal
  `control.test.ts` · edge `web/jstest/ui.test.js`.
- **Ops:** keine neue Pflicht-Variable, keine Migration, kein Vertragsfeld. Die
  Edge-Hälfte reist mit dem nächsten Edge-Release; api und Portal sind sofort
  lieferbar und degradieren bis dahin auf „kein Modus gemeldet".

