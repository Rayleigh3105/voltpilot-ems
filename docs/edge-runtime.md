# Edge-Laufzeit

Der Go-Core hält Identität, Cloud-Verbindung, Puffer und Steuerungsverantwortung. Node-RED übernimmt Geräte-I/O; der OTA-Updater tauscht signierte Softwarestände aus.

## Ausführung

```mermaid
flowchart TD
    Plan["Cloud-Fahrplan"] --> Wunsch["Lokale Wünsche"]
    Flow["Regeln und Flows"] --> Wunsch
    Lokal["Lokale Bedienung / Fallback"] --> Wunsch
    Wunsch --> Arbiter["Vorrang, Besitzer, TTL"]
    Arbiter --> Guards["Freigaben und Schutzgrenzen"]
    Guards --> Adapter["Geräteadapter"]
    Adapter --> Hardware["Physisches Gerät"]
    Hardware --> Rueck["Readback und Messwerte"]
    Rueck --> Core["Core: Zustand und Wirkung"]
```

Nicht jede Quelle darf jede Priorität beanspruchen. Der normale Entitätsflow schreibt keine Register am Arbiter vorbei. Explizite generische Modbus-Knoten sind die gesonderte [Governance-Ausnahme](contracts/v2/flow-graph.md#katalogausnahmen), kein automatisch zertifizierter Steuerpfad. Verbindliche Reihenfolge und Ausnahmen stehen in [Arbitration](contracts/v2/edge-desired-arbitration.md) und [Ausführungsverantwortung](contracts/v2/plan-execution-ownership.md).

## Messwerte

Die Standortbilanz wird in dieser Reihenfolge gebildet: frische PV-Quellen addieren, frischen Standort-Netzzähler gegenüber dem primären Wechselrichter bevorzugen, gemessene Batterieleistung übernehmen und Hauslast ableiten:

`Hauslast = PV + Netzbezug − Batterieladung`

Die Vorzeichen folgen dem lokalen Vertrag. Der primäre Netzwert wird standardmäßig als Standortbilanz verwendet; `PrimaryGridNotSiteTotal` ist der ausdrückliche Ausweg bei anders platziertem CT.

- Batterie wird gemessen, nicht aus der Bilanz als Messwert rekonstruiert.
- Ein nachweislich batterieloses Modell erlaubt Batterie = 0. Bei einem Hybrid ohne Batteriemessung bleibt die abgeleitete Hauslast unbekannt.
- Unbekannte Gerätekategorien und fehlende Standortbilanz verwenden den vorhandenen, gerätespezifischen Rohlastpfad; keine pauschale Ersatzformel ergänzen.
- Quellwechsel und veraltete Messungen müssen im Zustand nachvollziehbar bleiben. Eine Komponente behält Kennung und Historie bei Aliasänderung.

- Eine Box ohne Wechselrichter, die eine Anlagensteuerung liest (Erzeuger-Registerbild), bildet die Standortbilanz aus deren Lesung: PV = Erzeugung, Netz = Netzpunkt, Batterie 0 als Tatsache des Bilds, durch denselben Fold.

Quellen: `agent.onLocalTelemetry`, `agent.foldSiteSample`, `agent.plantControllerSample`, `sources.BalanceSettings`, `inverter.FamilyHasBattery` im [Core](../edge-app/core/internal/).

## Schutzgrenzen

Die konkrete Kette steht unter `internal/guards`. Sie berücksichtigt Nennleistung, SoC, Netzgrenzen sowie aktivierte Betriebsregeln. Solar-only-Laden wird an der **gemessenen PV-Leistung** begrenzt; fehlende PV erlaubt dabei keine Ladung. Die Hauslast darf im PV-Bus-Modell gleichzeitig aus dem Netz versorgt werden.

Weitere lokale Funktionen sind Lastnachführung, PV-Überschussaufnahme, Einspeisebegrenzung, Zyklenschutz, oberer PV-Puffer und native Selbstregelung. Ihre Wirkung ist nicht pauschal „nur weniger Sollwert“: einzelne Funktionen dürfen innerhalb der Schutzgrenzen einen Bedarf erhöhen. Sie brauchen ihre eigenen Voraussetzungen und Tests.

Die messwertgeführten Korrekturen (Trim, Überschuss-Speichern/-Aufnahme, Lastnachführung, Defizitdeckung) laufen hinter dem **gedämpften Folger** (`guards/followdamper.go`): Sie sehen ein neues Messpaar Netz/Batterie erst, wenn beide Hälften nach dem letzten Schreibbefehl plus Einschwingzeit gemessen wurden; die teure Seite (Laden aus dem Netz, Entladen ins Netz) wird sofort verlassen, die billige in Rampen mit Reserve angefahren. Zeigt nach einem Befehl, der das Entladen (oder Laden) **erhöht** hat, schon der nächste frische Netzwert die teure Seite – Einspeisung beim Entladen, Bezug beim Laden –, nimmt die Box den Befehl mit diesem Takt zurück, ohne die Einschwingzeit abzuwarten: auf das, was der Speicher zuletzt gemessen lieferte, minus den Überhang am Zähler, minus die Reserve („Einspeisung schlägt Einschwingzeit“, 10.10.2026). Die Regelmessung selbst rückt dabei nicht vor – ein Netzwert allein ist kein Messpaar. Einschwingzeit und Messtakt stehen je Gerätefamilie im Profil (Deye gemessen: 15 s / 25 s, sonst diese Vorgabe). Ohne gewähltes Gerät und auf Dauerspeicher-Hebeln (Deye-ToU) ist er aus. Schutzgrenzen klemmen den gedämpften Wert weiterhin in jedem Takt mit der Live-Messung.

**Ladung gegen den Überschuss-Verbraucher halten** (NS-3 B, Entscheid vom 15.10.2026, `guards/chargehold.go`): Trägt ein ladender Slot mit `charge_from_surplus_only` das Feld `charge_hold_base_load_kw`, hat die Cloud einen Verbraucher erkannt, der selbst auf null Einspeisung regelt, und die Ladung gegen die Grundlast ohne ihn geplant. Trim und gedämpfter Folger rechnen dann mit der Last `min(gemessene Last, Grundlast)` statt mit der gemessenen Last: was über der Grundlast liegt, senkt die geplante Ladung nicht mehr. Der Verbraucher sieht Bezug, regelt herunter und bekommt, was nach der Ladung übrig bleibt. Ohne das Feld nahm er die 0,5 kW Reserve des Folgers, der Trim folgte sofort, und die Ladung fiel stufenweise von ≈ 25 auf ≈ 1 kW (Herzogau 12.10. 14–15 Uhr, 14.10. 15:00–16:30). Die Ausnahme „Einspeisung schlägt Einschwingzeit“ schweigt auf der Ladeseite, solange gehalten wird. Ein Bezug direkt nach dem Anheben kommt dann vom Verbraucher, der noch nicht heruntergeregelt hat. **Kein Netzladen:** Steht am Netzpunkt 60 s ununterbrochen ein Bezug über der Grundlast-Deckung `max(Grundlast − PV, 0)` plus 0,3 kW (`guards.HoldYieldDwell`, `HoldImportMarginKw`), ist die Last über der Grundlast nicht ausgewichen. Die Box hebt ihre Grundlast dann für den Rest des Slots auf die gemessene Last, und der Trim nimmt den Bezug im selben Takt zurück. Gehalten wird nur auf dem Plan-Pfad und nur in der Laderichtung. Das Halten hebt nie einen Sollwert und ersetzt keinen Wächter: Nennband, SoC-Fenster, BMS, Solar-only-Klemme, §14a, Spitzen- und Einspeisewächter wirken wie bisher. Die native Wegwahl wird nicht befragt, solange gehalten wird (das Gerät würde wieder „Sonne minus Last“ regeln). Lokaler Zustand: `charge_hold`. Prüflauf: `TestSurplusConsumer*` in `agent/surplus_short_consumer_scenario_test.go` mit einem Nulleinspeise-Verbraucher (Stufen 12,5 kW, Einschaltverzug 30 s).

**Kurzer Verbraucher – Haltezeit vor dem Entladen** (Entscheid A vom 13.10.2026; er ersetzt für die Slot-Grenze den Entscheid E2 A vom 10.10.2026, der die Haltezeit nur in der Lade-Viertelstunde kannte): In **jeder** Viertelstunde, in der die Box der Messung nachregelt – Laden, Ruhe, Deck-Viertelstunde (`cover_load_from_battery`, `limit_discharge_to_load`) und ungeplante Lastdeckung (`unplanned_load_discharge`) –, hebt ein gemessenes Defizit die Entladung erst an, wenn es 60 s ununterbrochen gemessen wurde (`guards.DeficitCoverHold`, eine Konstante; Zustand `deficit_hold`) – und seit dem Entscheid A vom 19.10.2026 (**Stufen-Haltezeit**) ebenso jeder **Anstieg** eines schon stehenden Defizits: gedeckt wird höchstens das kleinste Defizit, das in den letzten 60 s gemessen wurde (`guards.DeficitHold.Observe`). Ein Wechselrichter, der einem Befehl später folgt, als der Verbraucher läuft, kann diesen Verbraucher nicht decken – er speist dann nur ein. Die Regel sitzt an der einen Stelle, an der aus einem gemessenen Defizit eine Entladung wird (`guards.LoadFollower`), und gilt für alle drei Befugnisse gleich (`deficit_cover`, `follow`, `idle_follow`). Mehr, als gestanden hat, deckt die Box nur, soweit sie es im Takt davor schon gedeckt hat: eine laufende Deckung fällt bei einer Messlücke also nicht weg, sie wächst nur nicht. Auch die Reserve des gedämpften Folgers wird von diesem deckbaren Defizit gerechnet, nicht vom gemessenen – sonst gäbe jeder kurze Verbraucher sie frei. Das gilt auch für den Planwert einer Deck-Viertelstunde – er ist eine Prognose und wird auf das begrenzt, was das Haus gezeigt hat. **Sofort** bleiben: das Zurücknehmen eines Ladens, das Absenken und die Rücknahme einer laufenden Entladung (auch „Einspeisung schlägt Einschwingzeit“). **Unberührt** bleiben: ein geplanter Verkauf (Planwert ohne Pflicht läuft unverändert), die Reserve (`effective_floor_soc_pct`), der Zyklenschutz, der Rückfall ohne Fahrplan und der Eigenmodus des Geräts – ein Gerät, das den Netzpunkt selbst regelt, kennt den verspäteten Befehl nicht, seine Aufsicht hat dafür `speicher_einspeisung`. Die Deckung eines echten Defizits beginnt damit frühestens 60 s nach dessen Beginn – im Prüflauf am schnellen Gerät nach rund 70 bis 80 s, am Deye-Profil nach rund 90 bis 100 s (Haltezeit plus bis zu zwei Messtakte, weil an Messungen gezählt wird). Dasselbe gilt für einen Lastsprung auf ein stehendes Defizit (nachts: 72 / 92 / 112 s am schnellen Gerät / Deye-Profil / trägen Gerät statt 2 s), und eine Last, die schneller schwankt als die Haltezeit (Kochfeld im Takt), wird nur bis zu ihrer Unterkante gedeckt – das ist der mit dem Entscheid gewählte Preis. Jeder Speicher-Wechselrichter, den die Box nachregelt, besteht vor der Freigabe den Pflichtlauf „Überschuss mit kurzen Verbrauchern“ ([Prüfstände](../edge-app/nodered/CONTROL-BENCH.md)).

Eine Richtung, die die Box selbst **beginnt** (Defizitdeckung, ungeplante Lastdeckung, Überschuss-Speichern aus der Ruhe), verlangt eine gehaltene Rücklesung (`idleReadbackHealthy`) – ein einzelner abweichender Zyklus verweigert den Beginn. **Läuft** sie bereits, endet sie erst nach drei erfolglosen Rücklesungen in Folge oder 30 s ohne gehaltene Rücklesung (`runningReadbackHealthy`); Entlade- und Ladeseite zählen getrennt. Der Sollwert-Pfad führt in jedem Takt Planwert, Halter-Befehl des Arbiters und Slot-Flaggen aus **einem** Plan und Slot aus: steht der Befehl des Plan-Executors noch auf dem Plan oder Slot davor, zieht `applySetpoint` ihn im selben Takt nach (`planExecutorOutdated`).

**Absicht + Fenster** (`guards/intent.go`, K4b): die Box übersetzt die Flaggen eines Slots in eine Absicht mit Leistungsfenster und lässt ein offenes Fenster das Gerät selbst regeln, sobald Layer 1 für genau diese Absicht einen zertifizierten Hebel meldet und ihn im Rücklesen belegt; sonst regelt sie gedämpft wie oben. Umgeschaltet wird nur an Slotgrenzen. Vertrag, Aufsicht und Schreibbudget: [Wer führt den Fahrplan aus?](contracts/v2/plan-execution-ownership.md#absicht--fenster-k4b-24092026). Simulatorbelege ersetzen keinen Hardware-Prüfstand; freigegeben für echte Geräte ist weiterhin nur die Entladeseite des Deye-Piloten.

**Netzseitiger Drossel-Slot** (`guards/gridtarget.go`, `edge-app/nodered/deye-grid-target.js`): in einem Slot, den der Plan abregelt und in dem er die Batterie nicht entlädt, regelt der Hybrid-Wechselrichter den Netzanschluss selbst auf 0 W und drosselt dafür seine **eigene** PV – den Anteil, den die Kappen der AC-gekoppelten Wechselrichter nicht erreichen. Der Core veröffentlicht nur die Absicht; die Freigabe je Modell und die Registerfolge liegen bei Layer 1, belegt wird über die zurückgelesenen Register und beaufsichtigt über den **gemessenen** Netzpunkt. Im Slot führt das Gerät die Batterie, deshalb nimmt der Core mit benanntem Grund zurück (Reserve + 3 %, Messung, Rücklesen, Netz folgt dem Ziel nicht binnen 60 s). Die registrierte Einspeisegrenze bleibt Sache der abregelbaren PV-Wechselrichter. Vertrag und Vektoren: [Wer führt den Fahrplan aus?](contracts/v2/plan-execution-ownership.md#netzseitiger-drossel-slot-08102026), Registerlage und Live-Befunde: [Deye](../edge-app/nodered/DEYE.md#der-netzseitige-drossel-slot-produktivpfad-seit-08102026). Freigegeben ist ein Modell (Deye SUN-30K-SG01HP3, Netz-Sollwert-Test Herzogau 08.10.2026).

**Steuerprofile** (`catalog/control-profiles`, K7): je Gerätefamilie beschreibt ein Profil Hebel, Schreibfolge, Beleg, Rückfall, Totmann, Schreibbudget und Dämpfung je Absicht, mit Quellen und Sicherheit A–D – Wissen, keine Freigabe. Die Box liest daraus nur Einschwingzeit/Messtakt des gedämpften Folgers und das Tagesbudget eines Dauerspeicher-Hebels (`internal/controlprofile`, eingebettet); Schreibfolgen bleiben Code im Adapter, `edge-app/nodered/control-profiles.test.js` hält beide zusammen. Freigegeben wird weiter je Modell + Firmware + Prüfnachweis über das Zertifikat.

**Mehrere Wechselrichter an einem Netzpunkt** (`guards/leader.go`, `guards/exportcascade.go`, K6): Führungsgerät ist die eine steuerbare Speicher-Auswahl der Box; selbst regeln darf sie nur mit Zähler **am Netzpunkt** (Pflichtangabe der Einrichtung, bei vorhandenem Netz-Zähler nachgemessen) und ohne einen weiteren, selbst regelnden Speicher am selben Zähler. Reine PV-Wechselrichter bleiben Stellglieder von Einspeisewächter und Abregelung. Der Einspeisewächter ist der Außenkreis einer Kaskade: er greift erst, wenn der Speicher nichts mehr aufnimmt; im Negativpreis-Slot regelt er die PV auf Einspeisung 0. Einzelheiten: [Wer führt den Fahrplan aus?](contracts/v2/plan-execution-ownership.md#mehrere-wechselrichter-an-einem-netzpunkt-k6-24092026).

### Rückhalt der Einspeisegrenze bei Box-Ausfall (K6)

Eine Einspeisegrenze hält der Einspeisewächter nur, solange die Box lebt. Was danach geschieht, entscheidet der Totmann jedes Geräts (Konzept `vp-wechselrichter-eigenregelung-k1` §6.4, `matrix.json`; A = Hersteller, B = an unserem Gerät gemessen, C = Feldquelle):

| Gerät | Totmann | nach Box-Ausfall | hält die Einspeisegrenze? |
|---|---|---|---|
| Deye mit Fernsteuer-Block (1100–1121) | 1101 = 60 s (B) | eigene Konfiguration (Work Mode, Energy Pattern, ToU) | nur die eigene Erzeugung, über 0x00E7 (EEPROM, von der Box nur gelesen) |
| Deye über ToU (EEPROM) | keiner | zuletzt geschriebener Zeitplan bleibt | wie oben |
| Fronius Eco/Symo/Tauro/Primo (Model 123) | `WMaxLimPct_RvrtTms` = 60 s (B) | volle Leistung | **nein** |
| Fronius GEN24 (Model 124) | keiner dokumentiert (A) | gesetzte Lade-/Entladegrenze bleibt | nur mit eigener dynamischer Leistungsreduzierung |
| SMA (41195, Vorgabe 600 s) | Rückfall-Fenster 44035/44037 (A) | Rückfall-Fenster | über den Home Manager (C) |
| SolarEdge (0xE00B) | Standardmodus 0xE00A (A) | Standardmodus | Export-Steuerblock, im Fernsteuermodus aus (A) |

Die Box schreibt keinen Rückhalt in ein Kundengerät (E5 A). Sie **warnt** im Einspeisewächter (`export_guard.backstop`, Karte „Einspeisegrenze“ auf `:8484`, Log), solange die Grenze nicht geräteseitig gedeckt ist. Gedeckt ist sie, wenn der Installateur auf der Einrichten-Seite „Hält die Anlage die Einspeisegrenze auch ohne Box? – Ja“ angibt, oder wenn die gelesene eigene Grenze des Führungsgeräts (Deye 0x00E7) höchstens 0,5 kW über der Einspeisegrenze liegt, sein Zähler am Netzpunkt sitzt und die weiteren Erzeuger zusammen (Nennleistung) die Grenze allein nicht überschreiten können.

**Empfehlung für den Installateur:**

1. Einen geräteseitigen Rückhalt einrichten, der den **ganzen** Netzpunkt sieht: z. B. die Fronius-eigene dynamische Leistungsreduzierung mit einem Fronius-Zähler am Einspeisepunkt (bei mehreren Fronius die Mehrgeräte-Variante des Herstellers), bei SMA über den Home Manager. Die eigene Grenze eines Hybrid-Wechselrichters reicht nur, wenn die übrigen Erzeuger die Grenze allein nicht überschreiten können.
2. Als Wert die gemeldete Einspeisegrenze einstellen. Die Box regelt auf Grenze − Reserve (2 %, mindestens 0,3 kW); der geräteseitige Rückhalt liegt damit über ihrem Ziel und greift nur, wenn die Box ausfällt – kein zweiter Regler im Normalbetrieb. Die Fronius-Priorität (E/A → dynamische Reduzierung → Modbus, `edge-app/nodered/FRONIUS.md`) lässt eine kleinere Box-Vorgabe weiter wirken.
3. Den Rückhalt auf der Einrichten-Seite als vorhanden angeben; die Warnung verschwindet.

Herzogau: 2 × Fronius Eco 27 (54 kWp) gegen 30 kW Grenze; der Deye hält mit 0x00E7 (gelesen 33,0 kW) nur seine eigene Erzeugung. Ohne Fronius-seitigen Rückhalt gilt nach einem Box-Ausfall nach 60 s keine Grenze mehr – am Gerät zu prüfen und einzurichten.

**Geführter Einmal-Test des Zählerorts** (ohne eigenen Netz-Zähler der Box kann sie ihn nicht nachmessen): Speicher auf Halten, eine bekannte Last (z. B. 2 kW) zuschalten und prüfen, dass der Netzbezug in der Anzeige des Wechselrichters und am Zähler des Hausanschlusses um denselben Betrag steigt; läuft eine weitere PV-Anlage, muss der Wechselrichter deren Einspeisung als Einspeisung zeigen. Erst dann „Am Netzpunkt“ angeben. Mit Netz-Zähler vergleicht die Box beide Zähler laufend (Median über 10 min, Toleranz 1 kW bzw. 10 %).

Bei Cloud-Ausfall gelten Frische-/Fallbackregeln pro Plan und Entität. Eine generelle Zusage „jeder Verbraucher läuft autonom weiter“ wäre falsch. Der [Deadline-Fallback](verbrauchssteuerung.md#offline-verhalten) startet nur bei belegtem Bedarf und zulässiger Ausführung.

## I/O und physische Freigabe

- Poll, Probe und Schreiben teilen den vorgesehenen Verbindungsmanager. Ein langsamer Poll darf keinen zweiten konkurrierenden Socket erzeugen.
- Palette-Knoten prüfen die Struktur. Routing entscheidet, ob ein Transport unterstützt wird, und meldet unverdrahtete Quellen sichtbar.
- Physische Geräteidentität, Connection und Registerziel getrennt erhalten. Eine Auswahl darf keine zweite Quelle erzeugen oder einen fremden Registerauftrag umlenken.
- Plattform-/Modellfreigabe, gerätespezifische Kalibrierung und Laufzeitflags zusammen auswerten. Steuerung muss auch wieder sauber freigegeben werden können.
- Deye-ToU benötigt bekannte Leistungsskalierung. Fronius-PV-Steuerung braucht die belegte Blockschreibfolge. [Deye](../edge-app/nodered/DEYE.md), [Fronius](../edge-app/nodered/FRONIUS.md), [Prüfstand](../edge-app/nodered/CONTROL-BENCH.md).
- Readback bewertet Semantik vor Zahlenvergleich: Füllwerte sind ungelesen, Watchdog-Zähler haben eigene Regeln, signed Register benötigen passende Toleranz. Eine fehlende Antwort ist kein abweichender Messwert.

## OCPP und lokale Netze

Die Box ist OCPP-Central-System auf `ws://<box>:8887/ocpp/<kennung>`. Nur registrierte Kennungen werden angenommen. `VP_OCPP_ENABLED` aktiviert den Server; die optimierte Verteilung benötigt zusätzlich `VP_CONTROL_ENABLED` und `VP_CONSUMER_CONTROL_ENABLED`.

Das Sicherheitsprofil der Säule bleibt bei Box-Ausfall wirksam. Protokollannahme und tatsächliches Laden werden separat erfasst; echte Modelle benötigen einen Prüfstandnachweis.

Web `8484`, Node-RED-Editor `1881` und OCPP `8887` gehören ins Kundennetz. Der lokale MQTT-Bus ist im Standard am Host nur über Loopback `1884` erreichbar. Für Cloud-Verbindung braucht die Box ausgehendes HTTPS und MQTT-mTLS, keine öffentliche Portweiterleitung.

## Prüfpunkte

- `go test ./...` im Core: Guards, Arbitration, Enrollment, Puffern, OCPP und OTA.
- Node-RED-Modul-/Palette-Tests: Routing, Protokolle, eingebettete Flows, Readback.
- `test/e2e-compose.sh`: vollständiger Simulatorpfad.
- `test/e2e-ocpp.sh`: OCPP-Protokoll, Budget und Ausfallverhalten.
- [OTA-Soak](../edge-app/test/ota-soak/README.md): unterbrochene Updates und Rücknahme.

Installationsregeln: [Edge-Deployment](../edge-app/DEPLOY.md). Signatur-/Updatepfad: [OTA](ota-autonomie.md).
