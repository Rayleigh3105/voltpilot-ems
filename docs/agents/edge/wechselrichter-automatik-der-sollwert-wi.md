# Wechselrichter-Automatik: der Sollwert wird ABGEGEBEN, die Aufsicht NIE

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 78).


Der Selbstregel-Modus (Konzept: firstmate `vp-verbrauch-decken-selbstregel`;
Captain-Entscheide 26.08.2026). In einem Slot, den die WOLKE als „Verbrauch
decken lohnt sich" markiert, hört die Box auf, alle 10 s einen Sollwert zu
schreiben, und übergibt die Regelung an die Eigenverbrauchs-Schleife des
Wechselrichters. **Kein Vertragsfeld** — die Wolke sagt längst, OB Decken
ökonomisch ist; WIE es ausgeführt wird, war immer eine Edge-Entscheidung.

- **⚠ DER SATZ, an dem alles hängt: „selbst regeln" heisst SOLLWERT WEGLASSEN,
  NICHT AUFSICHT WEGLASSEN.** Die Guard-Kette schützt einen Wert, den wir
  KOMMANDIEREN; ohne kommandierten Wert wird jeder Guard, der bisher über den
  Sollwert biss, zu einer BEOBACHTUNG mit RÜCKNAHME. Die Regel ist rein
  (`core/internal/guards/nativemode.go`, jede Funktion nimmt ihr `now` — das
  `otaapply`/`calibration`-Muster), `agent/native.go` ist nur Verdrahtung.
- **⚠ DIE ZWEITE TEILUNG, INNERHALB der Edge, ist der Grund für die
  Beweis-Schleife:** der KERN kennt Slot-Pflicht, Messwerte, Reserve-Boden und
  Lastspitzen-Budget — aber nur LAYER 1 kennt die Registerkarte und damit, ob
  dieses Modell+diese Firmware überhaupt eine Prüfstand-Freigabe hat
  (`nodered/unplanned-load-native.js`). Der Kern veröffentlicht deshalb eine
  ABSICHT (`battery_mode: "native"` auf `edge/setpoint`, additiv — ABWESEND =
  `setpoint` = byte-identisch zu vorher), und Layer 1 antwortet mit einem BELEG
  (`mode: "native"` auf `edge/control/readback`). **Eine Absicht, die nie
  bestätigt wird, wird nach einer begrenzten Frist ZURÜCKGENOMMEN** — sonst wären
  „wir haben aufgehört zu schreiben" und „wir sind tot" derselbe Zustand
  (Risiko 5 des Scouts). Nur ein BESTÄTIGTER Modus wird der Cloud als
  `execution.mode = autonomous_discharge` gemeldet.
- **Die Rücknahme-Gründe sind ein GESCHLOSSENES Vokabular mit je einem deutschen
  Satz** (`guards.NativeReasonText`) — eine Verweigerung, die niemand benennt,
  liest sich wie ein Defekt (die Canary-Soak-Lehre, auf den Sollwert-Pfad
  angewandt).
- **⚠ RÜCKNAHME vs. VERWEIGERUNG, und der Unterschied ist absichtlich:** eine
  RÜCKNAHME (Reserve-Boden, veraltete Messung, verlorenes Rücklesen, bedrohte
  Lastspitze, fehlender Nachweis) ist ein EREIGNIS auf einem flatternden Kanal
  und wird für den REST DES SLOTS gemerkt — ein Wiedereintritt würde den Modus
  des Geräts im 10-Sekunden-Takt umschalten. Eine VERWEIGERUNG (Anlagen-Pause,
  der Betreiber-Schalter) ist ein ZUSTAND, den jemand bewusst gesetzt hat: fällt
  er weg, ist sofortiges Wiederaufnehmen genau das Gewollte.
- **⚠ Die Lastspitzen-Frage keyt auf den ZÄHLER, nicht auf eine Korrektur**
  (`guards.NativePeakThreat` + `PeakTracker.HeldImport`): „würde PeakShave den
  Referenzwert senken?" könnte in einem Deckungs-Slot nie feuern (der Referenzwert
  treibt das Netz ohnehin auf 0), die Aufsicht wäre also dekorativ.
- **⚠ EEG: die Netzlade-Sperre wandert in die GERÄTE-Konfiguration**, sobald wir
  aufhören zu kommandieren. Das Gerät muss es also BELEGEN (`gridChargeProof` je
  Adapter, im Rücklesen als `native.grid_charge_blocked`); Schweigen zählt als
  NICHT belegt. Ein Tier ohne solches Register wird auf einer EEG-Anlage
  verweigert, statt zu hoffen.
- **⚠ WANN der EEG-Beleg fällig ist (K3, 24.09.2026):** die ÜBERGABE schuldet
  ihn, nicht die ABSICHT. Der Beleg ist eine Lesung, die der Executor erst macht,
  wenn die Absicht steht; wer ihn schon vor der Absicht verlangte, nahm im ersten
  Takt zurück (gerastet) — die Automatik war an jeder EEG-Anlage tot. Seitdem:
  „darf aus dem Netz laden" (vor oder nach der Übergabe) → sofort zurück; im
  Eigenmodus ohne eigenen Beleg → sofort zurück; noch nicht übergeben und noch
  keine Antwort → die Absicht bleibt `nachweis_ausstehend` bis zur Frist (dann
  `netzladen_am_geraet`). Die Sperre VOR der Übergabe hält Layer 1
  (`deyeNativePrecondition`, `0x00AC == Disabled`); der Executor meldet dieselbe
  Lesung als `native_precondition.grid_charge_blocked` — getrennt vom Beleg im
  Eigenmodus, den sie nie ersetzt. Agent-Test:
  `core/internal/agent/native_eeg_handover_test.go`.
- **Der Adapter-Primitive ist der RELEASE-Plan seines Tiers PLUS ein
  Zustands-Rücklesen als Beleg — einmal schreiben, dann nur lesen**
  (`nodered/inverter-control-routing.js` `nativeSelfConsumption`; Sequenzen,
  Beleg-Register und was der Prüfstand noch beweisen muss: die vier Adapter-Docs
  + `UNPLANNED-LOAD-BENCH.md`). **Deye ToU ist bewusst NICHT unterstützt**
  (EEPROM-Wechsel, ~20 s Latenz — „nativ" kostete dort mehr, als es spart).
- **⚠ Die ABREGELUNG ist NICHT Teil der Übergabe:** der Modus betrifft die
  BATTERIE; die Einspeise-Kappe des Slots ist ein eigenes, wolken-eigenes
  Kommando, und sie einzufrieren liesse eine Drosselung ihren Slot überleben.
  Sie reitet als GEWÖHNLICHER Schreibbefehl mit (am gewöhnlichen Steuer-Tor, nie
  am Zertifikat) und gehört zur Einmal-Signatur, damit eine GEÄNDERTE Kappe neu
  geschrieben wird.
- **Das Zertifikat ATTESTIERT die Bytes des Adapters, es definiert sie nicht**
  (`certificateMatchesPlan`): driften Prüfstands-Aufzeichnung und ausgelieferter
  Adapter auseinander, wurde an diesem Gerät nichts gemessen ⇒ Verweigerung. Der
  Deye-Interlock fällt nur per Eintrag, mit `interlockLifted: 'deye'` UND einem
  benannten `benchRecord` — nie durch Löschen des Zweigs.
- **⚠ `SIMULATOR_NATIVE_CAPABILITIES` zertifiziert SOFTWARE, nie ein Gerät.** Sein
  Tripel (`generic_modbus` / `sunspec-sim` / `sim`) kann nur den Simulator treffen,
  und er ist ausschliesslich im SIMULATOR-Tab verdrahtet (dessen Auswahl ein
  fester Literal ist). Der Auto-Tab reicht den PRODUKTIONS-Katalog durch.
- **⚠ DER PRODUKTIONS-KATALOG TRÄGT SEIT DEM 26.08.2026 GENAU EINEN EINTRAG: den
  Deye-Piloten** (Captain-Entscheid „kein separater Prüfstand — der Pilot IST der
  Prüfstand"). Gebunden an `deye` + die KATALOG-MODELL-ID `sun-30k-sg01hp3` + die
  vom GERÄT gesondete PR-978-Registerlage — **nicht an die Familie und nicht an
  einen getippten Firmware-String**: `nativeSelectionKey` nimmt die
  `firmwareEvidence` des Tiers (`DEYE_REMOTE_PR978_FIRMWARE`) VOR
  `connection.firmware`, also stoppt ein Firmware-Update, das den Block 1100-1121
  entfernt, die Freigabe von selbst, und ein alter String im gespeicherten
  Verbindungssatz kann sie weder erschleichen noch blockieren. Der Deye-Interlock
  ist damit NICHT gefallen — er ist per Eintrag gehoben (`interlockLifted` +
  `benchRecord`), jedes andere Deye-Modell fällt weiter durch ihn.
- **⚠ Und die Freigabe allein reicht nicht: `deyeNativePrecondition` verweigert
  zur LAUFZEIT**, wenn die EIGENE Konfiguration des Wechselrichters die Deckung
  nicht hergibt — Zeitfenster-Programm nicht aktiv (Deye-Handbuch: ohne ToU
  entlädt er nicht in die Hausanschlüsse), Ziel-Ladeniveau über der
  Reserve-Untergrenze, oder auf einer EEG-Anlage eine Program-1-Charging-Enum
  ungleich `Disabled`. **Unbekannt zählt als Verweigerung** — die Aufsicht könnte
  diesen Fall nicht fangen (das Gerät meldet den Modus korrekt, es deckt nur
  nicht). Die Registerliste dafür steht als `preconditions` auf dem Ergebnis: ein
  Executor liest sie VOR der Übergabe und reicht die Werte als `deyeOwnConfig`
  zurück.
- **DER DEYE-AUSFÜHRUNGSPFAD (26.08.2026): `nativePlanDeye` + die zwei Lesungen
  des Executors.** Der Plan-Knoten deckt seit dieser Runde ZWEI Tiers ab —
  `nativePlanGeneric` (modbus_tcp/SunSpec) und `nativePlanDeye` (die
  Fernsteuer-Registerlage), beide synchron gehaltene Kopien von
  `nativeSelfConsumption` und beide von `flows-sync.test.js` gegen das Modul
  gepinnt. HINEIN = **ein** Schreibvorgang `1100 <- 0`, danach nur noch Lesen;
  HINAUS = der unveränderte gewöhnliche Fernsteuer-Plan (`1101`, `1104`, `1105`,
  `1109`, `1100 <- 1` ZULETZT). Es gibt keine zweite Rücknahme-Sequenz.
- **⚠ DIE VORBEDINGUNG GREIFT VOR DER ÜBERGABE, und sie braucht eine Lesung, die
  ein Plan-Knoten nicht machen kann.** Deshalb liest der **Executor** die drei
  Register (`0x0092` Zeitfenster-Freigabe, `0x00A6` Ziel-Ladeniveau, `0x00AC`
  Program-1-Charging) auf jedem Takt, an dem eine Absicht auf Selbstregelung
  steht — **vor jedem Schreibvorgang dieses Zyklus** — und legt sie je Logger
  unter `deye_native_cfg:<host:port>` (flüchtig, wie `deye_cap:`) ab; der
  Plan-Knoten urteilt daraus mit der synchron gehaltenen Kopie von
  `deyeNativePrecondition`. **Nicht gelesen = nicht bekannt = Verweigerung**, mit
  deutschem Grund. Folge, die man kennen muss: der ERSTE Takt eines Decken-Slots
  verweigert ehrlich („die eigene Konfiguration … ist nicht bekannt"), der zweite
  schaltet um — weit innerhalb der Nachweisfrist des Kerns (~60 s). Und der Stand
  ist nie älter als EIN Takt, weil er in jedem native-Takt neu gelesen wird; ein
  Wechsel der Geräte-Konfiguration innerhalb dieser 10 s wird also erst vom
  nächsten Takt bemerkt, der die Batterie dann zurückholt.
- **⚠ `mode: "native"` wird NUR gemeldet, wenn `1100` wirklich 0 zurückliest.**
  Alles andere ist kein Beleg und wird als gewöhnlicher Zyklus veröffentlicht —
  der Kern sieht keine Bestätigung und nimmt die Batterie nach seiner Frist
  zurück (`nachweis_fehlt`). Nur ein belegter Takt liest zusätzlich den
  `gridChargeProof` und veröffentlicht ihn als `native.grid_charge_blocked`;
  sein FEHLEN heißt „das Gerät hat nichts gesagt" und zählt auf einer EEG-Anlage
  als nicht belegt (dieselbe Dreiwertigkeit wie im generischen Executor). Ein
  NICHT belegter Takt, der die Vorbedingungen gelesen hat, meldet die Antwort aus
  `0x00AC` stattdessen als `native_precondition.grid_charge_blocked` (Plan-Knoten
  reicht dafür `nativeGridChargeProof` neben `nativePreconditions` mit).
- **Ein stehender Grund wird EINMAL gesagt, nicht alle 10 s.** Der Plan-Knoten
  merkt sich den letzten Verweigerungs-Grund und schreibt nur bei einer
  ÄNDERUNG eine Zeile — ein Wechselrichter mit abgeschaltetem Zeitfenster-Programm
  füllte sonst das Protokoll für den ganzen Slot und begrübe genau die Zeilen,
  die die Beobachtungs-Checkliste liest. Der Knoten-Status trägt den Zustand
  ohnehin durchgehend.
- **Die `:8484`-Betriebsseite nennt den Modus** (`control.js deriveNative`): die
  Begründungszeile liest „Wechselrichter-Automatik (hält)" bzw. „… angefordert",
  hält also „gewollt" und „bestätigt" auseinander, und sie steht **an erster
  Stelle** der Begründungskette — solange die Automatik hält, wird gar kein
  Sollwert geschrieben, und eine Zeile über Nachführung/Begrenzung erklärte einen
  Wert, den niemand gesendet hat.
- **Der Simulator hat dafür ein Eigenverbrauchs-Modell bekommen**
  (`edge/sim/sunspec-sim.js`): bei `setpoint_enable = 0` folgt die Batterie
  `pv - load`, sonst dem Sollwert. Vorher gehorchte er ewig dem letzten Wert und
  LOGGTE das Flag nur — „übergeben" und „tot" waren dort buchstäblich derselbe
  Zustand, und der Modus wäre nicht beweisbar gewesen.
- **Schalter:** `VP_NATIVE_SELF_REGULATION_ENABLED` (Vorgabe AN, ein OPT-OUT wie
  `VP_OCPP_ENABLED`) — das echte Tor ist der Zertifikats-Katalog, dieser Schalter
  ist der Hebel, EINE Anlage ohne Image-/Zertifikats-/Plan-Änderung auf die
  bewiesene Nachführung zurückzunehmen.
- Beweise: `guards/nativemode_test.go` · `agent/native_mode_test.go` (die vier
  Fragen: Bestandsanlage byte-identisch, Übergabe nur bestätigt, jede
  Aufsichts-Bedingung nimmt zurück + rastet, EEG) ·
  `nodered/inverter-control-routing.test.js` (die Sequenz + das Beleg-Register je
  Adapter) · `nodered/unplanned-load-native.test.js` (Interlock, Drift, Simulator)
  · `nodered/flows-sync.test.js` (die inline Kopie == das Modul; jedes nicht
  abgedeckte Tier VERWEIGERT statt zu improvisieren) ·
  **`nodered/native-selfregulation.e2e.test.js`** (docker-frei, die ECHTEN
  Knoten-Bodies aus `flows.json` gegen einen selbst-regelnden In-Process-Server:
  Decken-Slot → nativ → EIN Schreibvorgang → keine Sollwert-Writes mehr → Netz ≈ 0
  ohne unser Zutun → Rücknahme im nächsten Takt; ohne Zertifikat bleibt es bei
  der Nachführung, und der Rücklese-`mode` behauptet NIE einen Zustand, in dem
  das Gerät nicht ist).

