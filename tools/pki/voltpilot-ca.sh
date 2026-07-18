#!/usr/bin/env bash
###############################################################################
# voltpilot-ca.sh - VoltPilot device PKI + broker cert tool.
#
# Creates the device CA once, issues the broker server cert and per-device
# client certs whose identity encodes tenant/site/device, maintains an EMQX
# ACL grant per device, and revokes compromised devices (CRL + ACL removal).
#
#   ./voltpilot-ca.sh init-ca   --domain mqtt.example.com [--ip 1.2.3.4]
#   ./voltpilot-ca.sh issue     --tenant <uuid> --site <uuid> --device <uuid>
#   ./voltpilot-ca.sh revoke    --device <uuid>
#   ./voltpilot-ca.sh gen-crl
#   ./voltpilot-ca.sh list
#
# Design (see docs/connect-a-device.md and AGENTS.md):
#   - CN = device_id (UUID, <=64 chars), O = tenant_id, OU = site_id.
#   - EMQX maps peer_cert_as_username = cn, so username == device_id, and each
#     device gets a per-device ACL grant binding its exact
#     ems/{tenant}/{site}/{device}/... topics. A UUID username with no grant is
#     denied by default (revocation = remove the grant, CRL is the crypto backstop).
#
# Private keys are written under an OUTPUT dir that is gitignored. NEVER commit
# CA or device private keys.
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENSSL_CNF="${SCRIPT_DIR}/openssl.cnf"

# Output roots (override via env). Both are gitignored (see tools/pki/.gitignore).
VP_PKI_OUT="${VP_PKI_OUT:-${SCRIPT_DIR}/out}"
export VP_PKI_CA_DIR="${VP_PKI_CA_DIR:-${VP_PKI_OUT}/ca}"
DEVICES_DIR="${VP_PKI_OUT}/devices"
SERVER_DIR="${VP_PKI_OUT}/server"

# ACL file that the per-device grants are written into. Defaults to the
# committed base ACL so a local run is self-contained; point it at your
# deployed copy (the acl/ dir mounted into EMQX) in production via --acl / env.
# Apply changes with tools/pki/reload-broker-authz.sh (a running broker does
# not re-read the file on its own).
ACL_FILE="${VP_ACL_FILE:-${SCRIPT_DIR}/../../infra/mqtt/acl/acl.conf}"

UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

# openssl.cnf references these via ${ENV::...}; give them harmless defaults so
# the config parser never sees an unset variable (real values set per-issue).
export VP_SERVER_SAN="${VP_SERVER_SAN:-DNS:localhost}"
export VP_DEVICE_SAN="${VP_DEVICE_SAN:-URI:spiffe://voltpilot/placeholder}"

die()  { echo "error: $*" >&2; exit 1; }
info() { echo ">> $*" >&2; }

require_uuid() {
  [[ "$2" =~ $UUID_RE ]] || die "$1 must be a UUID, got '$2'"
}

# ---------------------------------------------------------------------------
# init-ca: create the CA (once) and the broker server certificate.
# ---------------------------------------------------------------------------
cmd_init_ca() {
  local domain="" ip=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain) domain="$2"; shift 2;;
      --ip)     ip="$2"; shift 2;;
      *) die "init-ca: unknown arg '$1'";;
    esac
  done
  [[ -n "$domain" ]] || die "init-ca: --domain <broker fqdn> is required (e.g. mqtt.example.com)"

  if [[ -f "${VP_PKI_CA_DIR}/ca.crt" ]]; then
    info "CA already exists at ${VP_PKI_CA_DIR} - keeping it. (Delete the dir to re-init.)"
  else
    info "creating device CA under ${VP_PKI_CA_DIR}"
    mkdir -p "${VP_PKI_CA_DIR}/newcerts" "${VP_PKI_CA_DIR}/certs"
    chmod 700 "${VP_PKI_CA_DIR}"
    : > "${VP_PKI_CA_DIR}/index.txt"
    echo 1000 > "${VP_PKI_CA_DIR}/serial"
    echo 1000 > "${VP_PKI_CA_DIR}/crlnumber"

    openssl genrsa -out "${VP_PKI_CA_DIR}/ca.key" 4096
    chmod 600 "${VP_PKI_CA_DIR}/ca.key"
    openssl req -x509 -new -nodes -key "${VP_PKI_CA_DIR}/ca.key" \
      -sha256 -days 3650 -config "${OPENSSL_CNF}" -extensions v3_ca \
      -subj "/O=VoltPilot/CN=VoltPilot Device CA" \
      -out "${VP_PKI_CA_DIR}/ca.crt"
    info "CA cert: ${VP_PKI_CA_DIR}/ca.crt"
  fi

  # Broker server certificate (signed by the CA).
  info "issuing broker server cert for CN=${domain}"
  mkdir -p "${SERVER_DIR}"
  openssl genrsa -out "${SERVER_DIR}/server.key" 2048
  chmod 600 "${SERVER_DIR}/server.key"

  local san="DNS:${domain}"
  [[ -n "$ip" ]] && san="${san},IP:${ip}"
  export VP_SERVER_SAN="$san"

  openssl req -new -key "${SERVER_DIR}/server.key" -config "${OPENSSL_CNF}" \
    -subj "/O=VoltPilot/CN=${domain}" -out "${SERVER_DIR}/server.csr"

  openssl ca -batch -config "${OPENSSL_CNF}" -extensions v3_server \
    -days 825 -notext -md sha256 \
    -in "${SERVER_DIR}/server.csr" -out "${SERVER_DIR}/server.crt"

  cp "${VP_PKI_CA_DIR}/ca.crt" "${SERVER_DIR}/device-ca.crt"
  info "server cert: ${SERVER_DIR}/server.crt"
  info "server key : ${SERVER_DIR}/server.key"
  info "device CA  : ${SERVER_DIR}/device-ca.crt  (mount all three into EMQX)"

  cmd_gen_crl
  cat >&2 <<EOF

Next: mount these into the broker (see docker-compose.prod.yml):
  ${SERVER_DIR}/server.crt      -> /opt/emqx/etc/certs/server.crt
  ${SERVER_DIR}/server.key      -> /opt/emqx/etc/certs/server.key
  ${SERVER_DIR}/device-ca.crt   -> /opt/emqx/etc/certs/device-ca.crt
EOF
}

# ---------------------------------------------------------------------------
# issue: per-device client cert + ACL grant.
# ---------------------------------------------------------------------------
cmd_issue() {
  local tenant="" site="" device=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tenant) tenant="$2"; shift 2;;
      --site)   site="$2"; shift 2;;
      --device) device="$2"; shift 2;;
      --acl)    ACL_FILE="$2"; shift 2;;
      *) die "issue: unknown arg '$1'";;
    esac
  done
  [[ -n "$tenant" && -n "$site" && -n "$device" ]] || \
    die "issue: --tenant, --site and --device (all UUIDs) are required"
  require_uuid "--tenant" "$tenant"
  require_uuid "--site"   "$site"
  require_uuid "--device" "$device"
  [[ -f "${VP_PKI_CA_DIR}/ca.crt" ]] || die "no CA yet - run 'init-ca' first"

  local dir="${DEVICES_DIR}/${device}"
  mkdir -p "$dir"
  info "issuing client cert for device ${device} (tenant ${tenant}, site ${site})"

  openssl genrsa -out "${dir}/device.key" 2048
  chmod 600 "${dir}/device.key"

  # DN: O=tenant, OU=site, CN=device. Each field <=64 chars (UUIDs are 36).
  openssl req -new -key "${dir}/device.key" -config "${OPENSSL_CNF}" \
    -subj "/O=${tenant}/OU=${site}/CN=${device}" -out "${dir}/device.csr"

  # SPIFFE-style SAN URI for audit + future SAN-based authz.
  export VP_DEVICE_SAN="URI:spiffe://voltpilot/ems/${tenant}/${site}/${device}"
  openssl ca -batch -config "${OPENSSL_CNF}" -extensions v3_device \
    -days 825 -notext -md sha256 \
    -in "${dir}/device.csr" -out "${dir}/device.crt"

  cp "${VP_PKI_CA_DIR}/ca.crt" "${dir}/device-ca.crt"

  write_acl_grant "$tenant" "$site" "$device"

  cat >&2 <<EOF
device bundle written to ${dir}/
  device.crt      client certificate (CN=${device})
  device.key      client private key  (KEEP SECRET, ship to the device only)
  device-ca.crt   CA cert to verify the broker (device trusts this)
ACL grant added to ${ACL_FILE} - reload EMQX authz to apply:
  ./tools/pki/reload-broker-authz.sh
EOF
}

# ---------------------------------------------------------------------------
# ACL grant management. Each device owns a marked block:
#   %%<<device <id> tenant <t> site <s>>>
#   ...four rules (v1 topics + the two v2/# wildcard lines)...
#   %%<<end device <id>>>
#
# EMQX's file authorizer is FIRST-MATCH: a per-device grant is only reachable
# if it sits ABOVE the catch-all UUID default-deny, i.e. INSIDE the
# %%<<BEGIN..>>..%%<<END GENERATED DEVICE GRANTS>> region. Every write is a
# full CANONICALIZING rebuild (normalize_acl below): all device blocks are
# collected wherever they sit, the current device's block is inserted/replaced,
# and the file is re-emitted with exactly one region above exactly one
# default-deny tail. This self-heals a previously corrupted file (a grant
# appended below the deny, a duplicated template tail - the 2026-07-08 prod
# incident) on the next write. Idempotent: an existing block is replaced.
# ---------------------------------------------------------------------------
write_acl_grant() {
  local tenant="$1" site="$2" device="$3"
  local base="ems/${tenant}/${site}/${device}"
  [[ -f "$ACL_FILE" ]] || die "ACL file not found: ${ACL_FILE}"
  grep -qF '%%<<END GENERATED DEVICE GRANTS>>' "$ACL_FILE" \
    || die "ACL anchor '%%<<END GENERATED DEVICE GRANTS>>' missing in ${ACL_FILE}"

  # Template MUST stay byte-identical to AclGrantWriter.grantBlock (Java twin);
  # both sides pin the same vector in their tests. The two v2/# wildcard lines
  # are decision D-2 (docs/contracts/v2/mqtt-schedule-2.0.md #1): one per-device
  # v2 subtree covers every current and future v2 topic kind.
  local blockfile; blockfile="$(mktemp)"
  cat > "$blockfile" <<EOF
%%<<device ${device} tenant ${tenant} site ${site}>>
{allow, {username, "${device}"}, publish,   ["${base}/telemetry", "${base}/status"]}.
{allow, {username, "${device}"}, subscribe, ["${base}/schedule", "${base}/command", "${base}/config"]}.
{allow, {username, "${device}"}, publish,   ["${base}/v2/#"]}.
{allow, {username, "${device}"}, subscribe, ["${base}/v2/#"]}.
%%<<end device ${device}>>
EOF

  normalize_acl "$device" "$blockfile"
  rm -f "$blockfile"
  info "ACL grant written for device ${device}"
}

remove_acl_grant() {
  local device="$1"
  [[ -f "$ACL_FILE" ]] || return 0
  grep -qF '%%<<END GENERATED DEVICE GRANTS>>' "$ACL_FILE" || return 0
  normalize_acl "$device" ""
}

# normalize_acl <device-to-drop> <blockfile-to-insert|"">
# Canonical rebuild that also self-heals a corrupted acl.conf. Collects every
# device grant block (anywhere in the file), drops <device-to-drop>, appends
# the block in <blockfile> if given, then re-emits: preamble + BEGIN + all
# grants + END + a single collapsed tail (duplicate anchors and any tail below
# the first `{allow, all}.` removed). All grants therefore land above the deny.
normalize_acl() {
  local drop_device="$1" blockfile="$2"
  local tmp; tmp="$(mktemp)"
  awk -v drop="$drop_device" -v blockfile="$blockfile" '
    function is_allow_all(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s == "{allow, all}." }
    # ---- split into skeleton (everything else) + device blocks, keyed by id ----
    # A device block opens with "%%<<device <id> ..." so field 2 is the id
    # (portable: no gawk 3-arg match()).
    {
      line = $0
      if (openid != "") {
        block[openid] = block[openid] line "\n"
        if (line ~ ("^%%<<end device " openid ">>")) openid = ""
        next
      }
      if (line ~ /^%%<<device /) {
        id = $2
        if (!(id in seen)) { seen[id] = 1; order[++norder] = id }
        block[id] = line "\n"
        openid = id
        next
      }
      if (line ~ /^%%<<end device /) next          # stray unpaired end marker
      nskel++; skel[nskel] = line
    }
    END {
      # drop the requested device; add/replace the inserted one
      if (drop != "" && (drop in block)) { block[drop] = "" }
      if (blockfile != "") {
        newid = ""; newblock = ""
        while ((getline bl < blockfile) > 0) {
          if (bl ~ /^%%<<device /) { split(bl, f, " "); newid = f[2] }
          newblock = newblock bl "\n"
        }
        close(blockfile)
        if (newid != "" && !(newid in seen)) { seen[newid] = 1; order[++norder] = newid }
        block[newid] = newblock
      }
      # find first BEGIN, then first END after it
      b = 0; e = 0
      for (i = 1; i <= nskel; i++) if (index(skel[i], "%%<<BEGIN GENERATED DEVICE GRANTS>>")) { b = i; break }
      if (b > 0) for (i = b + 1; i <= nskel; i++) if (index(skel[i], "%%<<END GENERATED DEVICE GRANTS>>")) { e = i; break }
      if (b == 0 || e == 0) { print "ACL_NORMALIZE_ERROR" > "/dev/stderr"; exit 3 }
      # preamble + BEGIN
      for (i = 1; i <= b; i++) print skel[i]
      # every device grant, in first-appearance order
      for (k = 1; k <= norder; k++) { id = order[k]; if (block[id] != "") printf "%s", block[id] }
      # END line (exact)
      print skel[e]
      # tail after END: drop duplicate anchors, keep through first allow-all
      done = 0
      for (i = e + 1; i <= nskel; i++) {
        if (done) continue
        if (index(skel[i], "%%<<BEGIN GENERATED DEVICE GRANTS>>")) continue
        if (index(skel[i], "%%<<END GENERATED DEVICE GRANTS>>")) continue
        print skel[i]
        if (is_allow_all(skel[i])) done = 1
      }
    }
  ' "$ACL_FILE" > "$tmp" || { rm -f "$tmp"; die "failed to normalize ${ACL_FILE}"; }
  # mktemp creates 0600 and mv carries that mode onto the ACL file, which the
  # broker (different non-root uid, read-only mount) then cannot read - it
  # fails boot-time config validation on its next restart.
  chmod 644 "$tmp"
  mv "$tmp" "$ACL_FILE"
}

# ---------------------------------------------------------------------------
# revoke: CRL revocation + ACL grant removal (default-deny cuts it off at once).
# ---------------------------------------------------------------------------
cmd_revoke() {
  local device=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --device) device="$2"; shift 2;;
      --acl)    ACL_FILE="$2"; shift 2;;
      *) die "revoke: unknown arg '$1'";;
    esac
  done
  [[ -n "$device" ]] || die "revoke: --device <uuid> required"
  local crt="${DEVICES_DIR}/${device}/device.crt"
  [[ -f "$crt" ]] || die "no issued cert found for device ${device} at ${crt}"

  info "revoking device ${device}"
  openssl ca -batch -config "${OPENSSL_CNF}" -revoke "$crt"
  remove_acl_grant "$device"
  info "ACL grant removed for device ${device} (default-deny now applies)"
  cmd_gen_crl
  cat >&2 <<EOF
device ${device} revoked. Apply on the broker:
  - reload ACL:  ./tools/pki/reload-broker-authz.sh   (default-deny cuts the device off immediately)
  - refresh CRL: copy ${VP_PKI_CA_DIR}/crl.pem to the broker and, if CRL check is
    enabled, reload TLS so the cert is rejected at the handshake.
EOF
}

cmd_gen_crl() {
  [[ -f "${VP_PKI_CA_DIR}/ca.crt" ]] || die "no CA yet"
  openssl ca -batch -config "${OPENSSL_CNF}" -gencrl \
    -crldays 30 -out "${VP_PKI_CA_DIR}/crl.pem"
  info "CRL regenerated: ${VP_PKI_CA_DIR}/crl.pem"
}

cmd_list() {
  [[ -f "${VP_PKI_CA_DIR}/index.txt" ]] || die "no CA yet"
  echo "Status  Expiry(UTC)     Serial          Subject"
  awk -F'\t' '{ printf "%-7s %-15s %-15s %s\n", $1, $2, $4, $6 }' "${VP_PKI_CA_DIR}/index.txt"
}

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    init-ca) cmd_init_ca "$@";;
    issue)   cmd_issue "$@";;
    revoke)  cmd_revoke "$@";;
    gen-crl) cmd_gen_crl "$@";;
    list)    cmd_list "$@";;
    ""|-h|--help|help) usage;;
    *) die "unknown command '$cmd' (try --help)";;
  esac
}

main "$@"
