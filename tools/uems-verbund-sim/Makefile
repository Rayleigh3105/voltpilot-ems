# AP-15 IP-28 (NW-3): Simulator-Aufbau zweier Boxen in EINER Anlage.
#   make test        Physik, Profile, Modbus, Nutzlasten gegen die Verträge - ohne Broker
#   make bilder      Bilder einmal aus dem aktuellen Stand bauen
#   make r1          Aufbau hoch, Nutzlasten, R1 45 min (Echtzeit), Protokoll, Aufbau ab
#   make a7          wie r1 (30 min Messung), dazu A7: Netzzähler friert ab T0 bis zum Ende
#   make lint        shellcheck -S warning auf die Skripte
PY ?= PYTHONPATH=. uv run --no-project --with pytest --with jsonschema python
PROTOKOLL ?= $(or $(TMPDIR),/tmp)/uems-verbund-r1.json

.PHONY: test bilder r1 a7 lint
test:
	$(PY) -m pytest -q test_uems_verbund.py test_szenarien.py

bilder:
	./verbund.sh bilder

r1:
	./verbund.sh r1 --protokoll $(PROTOKOLL)

a7:
	VB_DAUER_S=$${VB_DAUER_S:-1800} ./verbund.sh r1 --protokoll $(PROTOKOLL) --stoerung "A7 $${VB_T0_S:-600} 99999"

lint:
	shellcheck -S warning verbund.sh stoerung.sh
