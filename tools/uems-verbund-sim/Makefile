# AP-15 IP-28 (NW-3): Simulator-Aufbau zweier Boxen in EINER Anlage.
#   make test        Physik, Profile, Modbus, Nutzlasten gegen die Verträge - ohne Broker
#   make bilder      Bilder einmal aus dem aktuellen Stand bauen
#   make r1          Aufbau hoch, Nutzlasten, R1 45 min (Echtzeit), Protokoll, Aufbau ab
#   make a7          wie r1 (30 min Messung), dazu A7: Netzzähler friert ab T0 bis zum Ende
#   make blatt       IP-29: jede Matrixzeile als Lauf (Stunden, Echtzeit), dann das Ergebnisblatt
#   make blatt-md    IP-29: nur das Ergebnisblatt aus vorhandenen Protokollen
#   make lint        shellcheck -S warning auf die Skripte
PY ?= PYTHONPATH=. uv run --no-project --with pytest --with jsonschema python
PROTOKOLL ?= $(or $(TMPDIR),/tmp)/uems-verbund-r1.json
PROTOKOLLE ?= protokolle
NW2 ?= $(or $(TMPDIR),/tmp)/ip27-zwei-agenten-protokoll.md
BLATT ?= ../../docs/rollout/gemeinsame-steuerung-ausfalltests.md
LAEUFE ?= R1 A7 A1 A2 A3 A4 A5 A9 A10 A11 A12 A13 A14 A15 A18 A20 R1n A2n A7n

.PHONY: test bilder r1 a7 blatt blatt-md lint
test:
	$(PY) -m pytest -q test_uems_verbund.py test_szenarien.py

bilder:
	./verbund.sh bilder

r1:
	./verbund.sh r1 --protokoll $(PROTOKOLL)

a7:
	VB_DAUER_S=$${VB_DAUER_S:-1800} ./verbund.sh r1 --protokoll $(PROTOKOLL) --stoerung "A7 $${VB_T0_S:-600} 99999"

blatt:
	python3 szenarien.py fahre $(LAEUFE) --protokolle $(PROTOKOLLE)
	$(MAKE) blatt-md

# NW-2 als Vergleichsspalte: (cd ../../edge-app/core && go test ./internal/agent/ -run TestZweiAgentenAusfallmatrix)
blatt-md:
	python3 szenarien.py blatt --protokolle $(PROTOKOLLE) --nw2 $(NW2) --aus $(BLATT)

lint:
	shellcheck -S warning verbund.sh stoerung.sh ladepunkte.sh
