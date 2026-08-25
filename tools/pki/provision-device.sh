#!/usr/bin/env bash
###############################################################################
# provision-device.sh - end-to-end device onboarding: CLAIM -> ISSUE CERT.
#
# Ties the portal's device-claiming (the DB side, architecture "onboarding =
# one insert") to per-device cert issuance so a claimed device comes out with a
# ready-to-ship mTLS bundle and its connection params.
#
#   ./provision-device.sh \
#       --api-base https://portal.example.com \
#       --token "$ACCESS_TOKEN" \
#       --site 00000000-0000-0000-0000-000000000002 \
#       --external-ref plant-a-inverter-01 \
#       --domain mqtt.example.com
#
# Steps:
#   1. POST /api/v1/devices/claim  -> creates the device row in the caller's
#      tenant (RLS-scoped) and returns its generated device_id (UUID).
#   2. voltpilot-ca.sh issue --tenant <from JWT> --site <given> --device <id>
#      -> mints the client cert bound to those IDs + writes the ACL grant.
#   3. Prints the broker URL, exact topic and the cert bundle path.
#
# tenant_id is read from the access token's `tenant_id` claim (override with
# --tenant). The token is the SAME Keycloak access token the portal uses.
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CA_TOOL="${SCRIPT_DIR}/voltpilot-ca.sh"

api_base="" token="" site="" external_ref="" kind="inverter" tenant="" domain="mqtt.example.com" mqtt_port="8883"

die() { echo "error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-base)     api_base="$2"; shift 2;;
    --token)        token="$2"; shift 2;;
    --token-file)   token="$(cat "$2")"; shift 2;;
    --site)         site="$2"; shift 2;;
    --external-ref) external_ref="$2"; shift 2;;
    --kind)         kind="$2"; shift 2;;
    --tenant)       tenant="$2"; shift 2;;
    --domain)       domain="$2"; shift 2;;
    --mqtt-port)    mqtt_port="$2"; shift 2;;
    *) die "unknown arg '$1'";;
  esac
done

[[ -n "$api_base" && -n "$token" && -n "$site" && -n "$external_ref" ]] || \
  die "required: --api-base, --token(/--token-file), --site, --external-ref"
command -v curl >/dev/null || die "curl is required"
command -v python3 >/dev/null || die "python3 is required (JSON/JWT parsing)"

# --- tenant_id from the JWT (base64url-decode the payload) unless overridden ---
if [[ -z "$tenant" ]]; then
  tenant="$(printf '%s' "$token" | python3 -c '
import sys, base64, json
tok = sys.stdin.read().strip().split(".")
if len(tok) < 2: sys.exit("not a JWT")
pad = tok[1] + "=" * (-len(tok[1]) % 4)
print(json.loads(base64.urlsafe_b64decode(pad)).get("tenant_id", ""))
')"
  [[ -n "$tenant" ]] || die "no tenant_id claim in token; pass --tenant explicitly"
fi

echo ">> claiming '${external_ref}' into site ${site} (tenant ${tenant})" >&2
resp="$(curl -fsS -X POST "${api_base}/api/v1/devices/claim" \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"siteId":sys.argv[1],"externalRef":sys.argv[2],"kind":sys.argv[3]}))' "$site" "$external_ref" "$kind")")" \
  || die "claim failed (already claimed -> 409, site not in tenant -> 404)"

device_id="$(printf '%s' "$resp" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')"
[[ -n "$device_id" ]] || die "claim response had no device id: $resp"
echo ">> claimed device_id=${device_id}" >&2

echo ">> issuing mTLS client cert bound to tenant/site/device" >&2
"$CA_TOOL" issue --tenant "$tenant" --site "$site" --device "$device_id"

bundle="${VP_PKI_OUT:-${SCRIPT_DIR}/out}/devices/${device_id}"
cat <<EOF

============================================================================
 Device provisioned. Hand these connection params to the edge:
============================================================================
  Broker (mTLS, outbound only):  mqtts://${domain}:${mqtt_port}
  Telemetry topic:               ems/${tenant}/${site}/${device_id}/telemetry
  Status topic:                  ems/${tenant}/${site}/${device_id}/status
  Schedule topic (subscribe):    ems/${tenant}/${site}/${device_id}/schedule
  Payload contract:              docs/contracts/mqtt-telemetry.schema.json
  Measurement desired (sub):     ems/${tenant}/${site}/${device_id}/v2/measurement-config
  Measurement status (pub):      ems/${tenant}/${site}/${device_id}/v2/measurement-config-status
  Measurement samples (pub):     ems/${tenant}/${site}/${device_id}/v2/measurement-samples
  Measurement contracts:         docs/contracts/v2/mqtt-measurement-*.schema.json
  Cert bundle:                   ${bundle}/
      device.crt / device.key    client identity (ship device.key SECRETLY)
      device-ca.crt              CA to verify the broker

 Reload broker authz so the new ACL grant applies:
   ./tools/pki/reload-broker-authz.sh
 Then follow docs/connect-a-device.md for the Node-RED MQTT-out config.
============================================================================
EOF
