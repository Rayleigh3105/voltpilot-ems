#!/usr/bin/env bash
# Prüft die Auswirkungs-Karte (`docs/fachmodell/auswirkungen.md`) in beide Richtungen:
#
#   1. Jede HEUTIGE Tabelle, die die Karte nennt, existiert wirklich als `CREATE TABLE`
#      in den Flyway-Migrationen. Eine Karte, die von einer Tabelle erzählt, die es nicht
#      gibt, führt jedes Bau-Paket in die Irre.
#   2. Jede Tabelle dieser Liste kommt in der Karte auch vor — sonst wandert eine Zeile
#      still aus der Karte, ohne dass es auffällt.
#   3. Die Portal-Dateien, die die Karte nennt, existieren.
#
#   bash docs/fachmodell/tools/check_auswirkungen.sh
#
# NEUE Objekte des Fachmodells (`messstelle`, `data_source`, `messreihe_*` …) werden hier
# erst geprüft, wenn ihr Bau-Paket sie angelegt hat: dann trägt es sie in GEBAUT ein, und
# ab da gilt für sie dieselbe Regel wie für die heutigen Tabellen.
set -uo pipefail

cd "$(dirname "$0")/../../.." || exit 1
MIG="services/api/src/main/resources/db/migration"
KARTE="docs/fachmodell/auswirkungen.md"

[ -f "$KARTE" ] || { echo "FEHLER: $KARTE fehlt"; exit 1; }

# Die heutigen Tabellen, über die die Karte eine Aussage macht.
TABELLEN="
tenant
site
site_supply_price
device
device_enrollment
device_edge_version
device_source_status
device_site_assignment
device_control_activation
measurement_point
component_definition
component_change_event
component_activation_outbox
telemetry_v2
device_measurement_sample
device_measurement_selection
entity_registry_state
entity_role_assignment
site_profile_state
flow_definition
consumer_policy
site_charging_config
"

# Die neuen Tabellen, die ein UEMS-Bau-Paket schon angelegt hat (je Paket eine Zeile).
GEBAUT="
unternehmen
standort
anlage_standort
ort_aenderung
messstelle
messstelle_groesse
messstelle_kennzeichen
messstelle_kennzeichen_seq
messstelle_aenderung
"

# Portal- und Vertrags-Dateien, die die Karte namentlich anführt.
DATEIEN="
frontend/portal/src/nav.ts
frontend/portal/src/anlageNav.ts
frontend/portal/src/copy.test.ts
frontend/portal/src/glossar.ts
frontend/portal/src/komponenten.ts
frontend/portal/src/betriebsmodelle.ts
frontend/portal/src/pages/AnlageTechnik.tsx
frontend/portal/src/components/Betriebsmodelle.tsx
docs/contracts/v2/edge-entity.schema.json
docs/contracts/v2/mqtt-telemetry-2.0.schema.json
docs/contracts/v2/topology-read-model.md
docs/architecture.md
"

fehler=0
n_tab=0
n_dat=0

for t in $TABELLEN $GEBAUT; do
  n_tab=$((n_tab + 1))
  if ! grep -rlEz "CREATE TABLE[^;]*[^a-z_]${t}[^a-z_]" "$MIG" >/dev/null 2>&1; then
    echo "FEHLER  Tabelle \`$t\` hat kein CREATE TABLE in $MIG"
    fehler=$((fehler + 1))
  fi
  if ! grep -qF "\`$t\`" "$KARTE"; then
    echo "FEHLER  Tabelle \`$t\` fehlt in $KARTE"
    fehler=$((fehler + 1))
  fi
done

for f in $DATEIEN; do
  n_dat=$((n_dat + 1))
  if [ ! -f "$f" ]; then
    echo "FEHLER  $f existiert nicht"
    fehler=$((fehler + 1))
  fi
done

echo "$n_tab Tabellen und $n_dat Dateien geprüft · $fehler Fehler"
[ "$fehler" -eq 0 ] || exit 1
