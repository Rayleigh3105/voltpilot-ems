# UEMS-Lastprofil und Messung (AP-14 IP-8)

- `tools/edge-simulator/uems_lastprofil.py` ist der additive Lastmodus. Vier
  Ahrenberg-Box-Identitäten liefern je 25 × 13 = 325 Samples/min im bestehenden
  MQTT-Vertrag 2.0. Wegen `maxItems=256` sind es zwei Umschläge je Box und
  Minute; Tests dürfen deshalb nie „ein Umschlag = ein Minutentakt“ annehmen.
- Die Profile sind Dauerlast (Echtzeit oder `--time-scale`), 210-Minuten-
  Outbox-Stoß und Kaltstart-Rückrechnung. Messzeit und simulierte Eingangszeit
  bleiben getrennt; der Stoß spielt FIFO mit Original-Messzeit.
- `tools/lastprofil-messung/lastprofil_messen.py` liest nur API-/Writer-Metriken
  und eine `READ ONLY`-Zählabfrage. Es gibt im Bericht niemals Kennungen aus.
- ⚠ `dropped_samples` ist nur die von der Box gemeldete Pufferverdrängung. Eine
  Quelle für vom Writer verworfene Umschläge/Samples fehlt; der NW-5-Punkt
  „kein Sample verworfen“ bleibt deshalb `NICHT MESSBAR`, nicht 0.
- Ein kurzer Fixture-/Testcontainers-Lauf ist nur Werkzeug-Beleg. Die
  24-Stunden-Abnahme läuft ausschließlich auf der Betreiber-Probe-Umgebung.

Bedienung und Bericht: [Simulator](../../../tools/edge-simulator/README.md) ·
[Messwerkzeug](../../../tools/lastprofil-messung/README.md).
