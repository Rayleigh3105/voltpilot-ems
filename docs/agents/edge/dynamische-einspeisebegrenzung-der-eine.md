# ⚠ Dynamische Einspeisebegrenzung: der EINE Guard, der blind NICHT stillhält (`guards.ExportLimiter`)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 46).


Der Echtzeit-Wächter am Netzverknüpfungspunkt (06.08.2026, live Pilsting): er
regelt die STEUERBAREN Erzeuger gegen die GEMESSENE Netzleistung, damit die
Einspeisegrenze der Anlage hält, egal was das Haus tut — die Aufgabe, die dort
bis dahin eine kundeneigene Loxone übernahm („sonst schiesst der drüber wenn ein
Auto abgesteckt wird"). Betreiber-Ablauf: `nodered/FRONIUS.md` §6d,
Umstellungs-Choreografie in `nodered/CONTROL-BENCH.md`.

- **Die Arbeitsteilung ist die des Hauses, nur mit anderem Absender:** der SOLL
  kommt aus der Cloud (`site.max_feed_in_kw`/FK1 → additives Top-Level-Feld
  `grid_export_limit_kw` im `mqtt-schedule`-Kontrakt), die REGELUNG läuft auf der
  Box. Der Plan konnte diese Grenze nie HALTEN: sie wird mit dem Haus geteilt,
  also hebt ein abgestecktes Auto die Einspeisung INNERHALB des Slots um dessen
  Leistung. **Ohne gepflegte Grenze ist der Wächter inaktiv und sagt das** — eine
  Grenze wird nie erfunden.
- **Das Regelgesetz ist eine Proportionalschleife mit Verstärkung 1**:
  `cap = pv_gesamt + (grenze − einspeisung) − marge`. Haus, Wallboxen und
  Batterie sind automatisch mitverrechnet, weil sie in der Netzmessung schon
  drinstecken — genau das ist der Vorteil gegenüber der Planung. Ergebnis ist eine
  ANLAGEN-Kappe, dieselbe Größe wie `pv_limit_kw`, also teilt der bestehende
  Executor (`sunspec/curtail.js splitPlantCap`) sie unverändert auf die Einheiten
  auf und zieht den nicht steuerbaren Anteil selbst ab.
- **⚠ DIE FAIL-SAFE-REGEL IST DIE UMKEHRUNG ALLER ANDEREN GUARDS.** Trim,
  Load-Follower, Surplus-Charger und Peak-Guard gelten „blind ⇒ INAKTIV, nie
  blind regeln" — eine verpasste Korrektur kostet Geld, nie Sicherheit. Bei einer
  COMPLIANCE-Grenze dreht sich das um: blind darf nicht „unbegrenzt" heißen.
  Deshalb Stufen statt Freigabe: frisch → Schleife; Messlücke ≤
  `ExportHoldWindow` → die letzte Kappe **einfrieren**; darüber → über
  `ExportContractWindow` linear auf die **sichere statische Kappe**
  zusammenziehen; nie gemessen → sofort diese Kappe. **Eine Kontraktion HEBT die
  Kappe nie an.**
- **Die sichere statische Kappe ist `Grenze − befohlene Entladung`** und braucht
  keinen Messwert: `export = pv + entladung − last − ladung ≤ pv + entladung ≤
  grenze`. Sie wird im Sollwert-Pfad gebildet (`agent.exportSafeStaticCap`), weil
  nur dort der endgültige Sollwert bekannt ist.
- **Komposition ist ein MINIMUM.** Der Wächter und die geplante Abregelung
  (Negativpreis/FK1) komponieren most-restrictive-wins; er lockert eine geplante
  Drosselung nie, kommandiert nie die Batterie (das wäre eine Optimierer-
  Entscheidung — `guards.SurplusCharger`) und rührt §14a/EEG/SoC/Nennband nicht an.
- **Sofort verschärfen, langsam freigeben.** Verschärfen ist unbedingt; freigeben
  ist ratenbegrenzt (`ExportReleaseWindow` für den vollen Bereich), damit die
  Schleife nicht ihrer eigenen Stellbewegung (`WMaxLimPct_WinTms`) hinterherjagt.
  `Observe` meldet einen DRINGENDEN Messwert zurück, worauf `onLocalTelemetry`
  den Sollwert sofort neu veröffentlicht — der Executor hängt am Sollwert, und
  eine geänderte Kappe schreibt er ohne das 20-s-Auffrischfenster abzuwarten.
- **Was die Marge NICHT kann:** einen LASTSPRUNG abfangen. 11 kW Wallbox
  verschieben den Arbeitspunkt um 11 kW; das beantwortet nur die Reaktionszeit
  (ein Mess- + Schreibzyklus). Die Marge deckt Rauschen, Rampe und
  Register-Quantisierung. Der eigentliche Schutz zwischen zwei Messwerten ist,
  dass die Kappe IM Wechselrichter steht und dort laufend durchgesetzt wird.
- **Wirkungslosigkeit ist eine LAUTE Aussage, kein Detail** (`Effective`/`Reach`
  in `state.ExportGuardInfo`, gebildet in `agent.exportGuardInfo`): ohne
  abregelbare Einheit, mit Not-Aus oder ohne Freigabe wird die Kappe berechnet
  und NIRGENDWO geschrieben. Der Betreiber steht kurz davor, seinen eigenen
  Regler abzuklemmen — eine Wache, auf die man sich fälschlich verlässt, wäre
  gefährlicher als gar keine. Auch der TEIL-Fall (n von m freigegeben) wird
  genannt.
- **Der deutsche Satz wird EINMAL geschrieben** (im Guard, neben dem
  maschinenlesbaren `State` — das `target_verdict`-neben-`state`-Muster) und
  reist verbatim auf die `:8484`-Karte (PV-Abregelung, NORMAL-Modus) und in den
  Herzschlag (`curtailment.export_guard`). Zwei Renderings desselben Urteils
  könnten es sonst verschieden formulieren. Cloud-seitig braucht das KEINE
  Änderung (der api-Listener liest den Herzschlag als `JsonNode`); bekannte
  Grenze: der `curtailment`-Block wird nur bei ≥ 1 Einheit gesendet, der Fall
  „Grenze ohne abregelbares Gerät" steht deshalb lokal (Karte + Log), nicht in
  der Flottensicht.
- Beweise: `internal/guards/exportlimit_test.go` (abgestecktes Auto → Grenze hält
  ab dem nächsten Zyklus; Freigabe ratenbegrenzt + konvergent; Wolke ohne
  Überschwingen beim Aufreißen; Halten → Zusammenziehen → sichere Kappe, NIE
  Freigabe; jeder Zustand nennt seinen Grund), `internal/agent/export_limit_test.go`
  (Verdrahtung, Komposition in beide Richtungen, die vier Wirkungslos-Fälle,
  Herzschlag == Karte), `curtail-lease.e2e.test.js` EINSPEISE-WACHE (Zustellung
  an echte SunSpec-Register, Aufteilung, unfreigegebene Einheit).

