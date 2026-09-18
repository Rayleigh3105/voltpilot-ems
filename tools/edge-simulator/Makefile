# VoltPilot Edge-Simulator — Prüfläufe und Störungs-Szenarien (AP-07 IP-20).
#
#   make test        alle Tests des Simulators, ohne Broker und ohne Datenbank
#   make plan        die fünf Szenarien als JSON (Trockenlauf, nichts wird gesendet)
#   make szenarien   spielt alle fünf Szenarien gegen VP_SIM_BROKER
#   make abnahme     erzeugt die Abnahme-Vorlage für AP-07 IP-21 neu
#
# Der Broker wird IMMER über die Umgebung genannt, nie fest verdrahtet:
#
#   VP_SIM_BROKER=localhost VP_SIM_PORT=1883 make szenarien
#   VP_SIM_BROKER=mqtt.example.com VP_SIM_PORT=8883 VP_SIM_TLS=1 \
#     VP_SIM_USER=… VP_SIM_PASSWORD=… make szenarien SZENARIO="--szenario A3"
#
# `make szenarien` sendet echte MQTT-Nachrichten. Es gehört an einen Stack, der
# dafür vorgesehen ist; die Prüfung der erzeugten Zeilen und Ereignisse in der
# Datenbank ist AP-07 IP-21.

PY ?= python3
PYTEST ?= $(PY) -m pytest
TESTS := test_edge_sim.py test_uems_ahrenberg.py test_uems_szenarien.py \
	test_ap07_abnahme_fixture.py
SZENARIO ?=

VP_SIM_PORT ?= 1883

.PHONY: help test plan szenarien zustellungen abnahme abhaengigkeiten

help:
	@awk '/^#/ { sub(/^# ?/, ""); print; next } { exit }' $(firstword $(MAKEFILE_LIST))

abhaengigkeiten:
	$(PY) -m pip install -r requirements-dev.txt

test:
	PYTHONPATH=. $(PYTEST) $(TESTS) -q

plan:
	$(PY) uems_szenarien.py --plan $(SZENARIO)

zustellungen:
	$(PY) uems_szenarien.py --zustellungen $(SZENARIO)

szenarien:
	@test -n "$(VP_SIM_BROKER)" || { \
	  echo "VP_SIM_BROKER fehlt — nennen Sie den Broker über die Umgebung:"; \
	  echo "  VP_SIM_BROKER=localhost make szenarien"; \
	  exit 2; }
	$(PY) uems_szenarien.py --broker "$(VP_SIM_BROKER)" --port "$(VP_SIM_PORT)" $(SZENARIO)

# Die Vorlage, aus der der Java-Abnahmelauf (AP-07 IP-21) die Zustellungen,
# Ereignisse und Stammdaten liest. Erzeugt, nie von Hand geschrieben:
# test_ap07_abnahme_fixture.py hält sie an diesen Befehl.
ABNAHME := ../../services/timescale-writer/src/test/resources/uems/ap07-abnahme-szenarien.json

abnahme:
	$(PY) uems_szenarien.py --abnahme > $(ABNAHME)
	@echo "$(ABNAHME) neu erzeugt — Abnahme-Klassen erneut fahren"
