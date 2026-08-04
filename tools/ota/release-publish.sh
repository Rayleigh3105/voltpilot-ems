#!/usr/bin/env bash
# release-publish.sh - die Schritte, die aus einem `edge-*`-Tag ein
# VEROEFFENTLICHTES Release machen: signieren, gegenpruefen, Assets anhaengen,
# ins Register eintragen.
#
# Es lebt als SKRIPT und nicht als YAML-Block, weil jeder einzelne Schritt
# ohne Forgejo pruefbar sein muss (tools/ota/test-release-publish.sh faehrt sie
# gegen einen lokalen Stub-Server) - dasselbe Muster wie
# tools/deploy/gitops-image-bump.sh und tools/pki/test-acl-grants.sh.
#
# ⚠ SICHERHEITSRAHMEN (Captain-Entscheid 04.08.2026, der D3 bewusst revidiert):
#   1. Die KALTE WURZEL bleibt offline beim Owner. CI sieht sie nie. Ein
#      missbrauchter RELEASE-Schluessel wird durch ein neues root-signiertes
#      Trust-Set entwertet (docs/ota-signing.md §7.1).
#   2. Das Register-Konto darf AUSSCHLIESSLICH registrieren (Realm-Rolle
#      edge-release-publisher). Ein uebernommener Runner kann die Release-Liste
#      verunreinigen - aber keinen Rollout starten und kein Geraet erreichen.
#   3. Der Mensch-Akt bleibt Mensch-Akt: „Rollout starten" ist Portal.
#   4. NICHTS im Wirkpfad haengt an CI (§6-Doktrin). Schlaeft der Runner, taucht
#      das Release nur SPAETER in der Liste auf.
#
# Und die Regel, an der die ganze Kette haengt: eine signierte Datei wird NIE
# umformatiert, nie durch `jq` geschickt, nie aus einem Log kopiert. Sie reist
# als Bytes oder gar nicht.
set -euo pipefail

OTA_PORTAL_DEFAULT="https://portal.voltpilot.de"
OTA_FORGEJO_DEFAULT="https://git.tecmaxx.de"
OTA_REPO_DEFAULT="mamotec/voltpilot-ems"
OTA_REALM_DEFAULT="voltpilot"

# --- kleine Helfer -----------------------------------------------------------

ota_die() {
	printf 'FEHLER: %s\n' "$*" >&2
	exit 1
}

ota_info() { printf '%s\n' "$*"; }

# ota_json_field <feld> - liest ein TOP-LEVEL-Feld aus JSON auf stdin.
# Fehlt es, ist die Ausgabe leer (und der Aufrufer entscheidet, ob das ein
# Fehler ist) - ein stiller Abbruch mitten in einer Pipe waere schlechter.
ota_json_field() {
	python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
v = d.get(sys.argv[1]) if isinstance(d, dict) else None
if v is None:
    sys.exit(0)
print(v if not isinstance(v, bool) else ("true" if v else "false"))
' "$1"
}

# --- Eingaben, die im REPO versioniert sind ----------------------------------

# ota_state_schema <datei> - die /data-Zustandsversion, die dieses Release
# vertraegt. Sie ist eine Eigenschaft des CODES, steht deshalb im Repo neben dem
# Code und nicht in einer Repo-Variable, die niemand mit einem Commit verbindet.
# Format: erste Zeile, die weder leer noch ein `#`-Kommentar ist.
ota_state_schema() {
	local file="$1" line
	[ -f "$file" ] || ota_die "Zustandsversion fehlt: $file"
	line="$(grep -v '^[[:space:]]*#' "$file" | grep -v '^[[:space:]]*$' | head -n 1 | tr -d '[:space:]')"
	case "$line" in
	'' | *[!0-9]*) ota_die "$file enthaelt keine Ganzzahl (gelesen: '${line}')" ;;
	esac
	[ "$line" -ge 1 ] || ota_die "$file muss >= 1 sein (gelesen: $line)"
	printf '%s' "$line"
}

# ota_tag_directive <schluessel> <annotationstext> - liest `schluessel=wert` aus
# der Tag-Annotation. Nur die BEKANNTEN Schluessel gelten als Direktive; alles
# andere ist Fliesstext (siehe ota_tag_notes), damit eine gewoehnliche
# Release-Notiz nie versehentlich zu einer Anweisung wird.
#
# Bekannt: min-from-seq · state-schema · urgent · allow-downgrade
ota_tag_directive() {
	local key="$1" text="${2-}"
	printf '%s\n' "$text" | awk -v k="$key" '
		BEGIN { FS = "=" }
		{
			line = $0
			sub(/^[ \t]+/, "", line)
			sub(/[ \t\r]+$/, "", line)
			idx = index(line, "=")
			if (idx < 2) next
			name = substr(line, 1, idx - 1)
			val = substr(line, idx + 1)
			if (name != k) next
			if (name !~ /^(min-from-seq|state-schema|urgent|allow-downgrade)$/) next
			print val
			exit
		}'
}

# ota_tag_notes <annotationstext> - der Fliesstext der Annotation OHNE die
# Direktiv-Zeilen; das wird die Release-Notiz im Register.
ota_tag_notes() {
	printf '%s\n' "${1-}" | awk '
		{
			line = $0
			sub(/^[ \t]+/, "", line)
			sub(/[ \t\r]+$/, "", line)
			if (line ~ /^(min-from-seq|state-schema|urgent|allow-downgrade)=/) next
			if (line == "") next
			out = (out == "" ? line : out " " line)
		}
		END { print out }'
}

# ota_key_id <schluesseldatei> - die key_id AUS der geheimen Schluesseldatei.
# Bewusst von dort und nicht aus einer Repo-Variable: das Manifest nennt die
# key_id, `vp-ota sign` verweigert eine Abweichung - kommen beide aus DERSELBEN
# Datei, kann es die Abweichung gar nicht geben. Der private Teil wird dabei
# nie gelesen und nie ausgegeben.
ota_key_id() {
	local file="$1" id
	[ -f "$file" ] || ota_die "Schluesseldatei fehlt: $file"
	id="$(ota_json_field key_id <"$file")"
	[ -n "$id" ] || ota_die "$file traegt kein key_id-Feld"
	printf '%s' "$id"
}

# --- Portal (Register) -------------------------------------------------------

# ota_token_url <portal-basis> - Keycloak liegt in prod unter /auth derselben
# Domain (docker-compose.prod.yml: KC_HTTP_RELATIVE_PATH=/auth).
ota_token_url() {
	printf '%s/auth/realms/%s/protocol/openid-connect/token' \
		"${1%/}" "${OTA_REALM:-$OTA_REALM_DEFAULT}"
}

# ota_token <token-url> <client-id> <client-secret>
#
# client_credentials. Der Rumpf geht ueber STDIN und nie ueber argv: eine
# Kommandozeile ist auf dem Runner fuer jeden Prozess lesbar.
ota_token() {
	local url="$1" cid="$2" secret="$3" body res code tok
	body="grant_type=client_credentials&client_id=${cid}&client_secret=${secret}"
	res="$(printf '%s' "$body" | curl -sS -o - -w '\n%{http_code}' \
		-X POST "$url" \
		-H 'Content-Type: application/x-www-form-urlencoded' \
		--data-binary @- || true)"
	code="${res##*$'\n'}"
	if [ "$code" != "200" ]; then
		# Der Rumpf einer abgelehnten Token-Anfrage traegt kein Geheimnis -
		# aber die Ursache (invalid_client / disabled) ist Gold wert.
		ota_die "Token vom Portal abgelehnt (HTTP $code): ${res%$'\n'*}"
	fi
	tok="$(printf '%s' "${res%$'\n'*}" | ota_json_field access_token)"
	[ -n "$tok" ] || ota_die "Token-Antwort enthaelt kein access_token"
	printf '%s' "$tok"
}

# ota_next_seq <portal-basis> <token> - druckt "<nextSeq> <currentSeq>".
# currentSeq ist bei leerem Register 0.
ota_next_seq() {
	local portal="${1%/}" token="$2" res code body next cur
	res="$(curl -sS -o - -w '\n%{http_code}' \
		-H "Authorization: Bearer $token" \
		"$portal/api/v1/admin/edge-releases/next-seq" || true)"
	code="${res##*$'\n'}"
	body="${res%$'\n'*}"
	[ "$code" = "200" ] || ota_die "next-seq abgelehnt (HTTP $code): $body"
	next="$(printf '%s' "$body" | ota_json_field nextSeq)"
	cur="$(printf '%s' "$body" | ota_json_field currentSeq)"
	[ -n "$next" ] || ota_die "next-seq-Antwort enthaelt kein nextSeq: $body"
	printf '%s %s' "$next" "${cur:-0}"
}

# ota_register <portal-basis> <token> <register.json>
#
# 201 = neu eingetragen, 200 = BYTEGLEICHE Wiederholung (ein erneut gelaufener
# Job hinter einer erfolgreichen Registrierung). Alles andere - insbesondere ein
# 409 auf abweichende Bytes - ist ein LAUTER Fehlschlag: das Register ist die
# Papier-Spur, und zwei verschiedene Manifeste unter einer Version waeren genau
# die Luege, die dort niemand mehr bemerkt.
ota_register() {
	local portal="${1%/}" token="$2" file="$3" res code body
	[ -f "$file" ] || ota_die "Register-Rumpf fehlt: $file"
	res="$(curl -sS -o - -w '\n%{http_code}' \
		-X POST "$portal/api/v1/admin/edge-releases" \
		-H "Authorization: Bearer $token" \
		-H 'Content-Type: application/json' \
		--data-binary "@$file" || true)"
	code="${res##*$'\n'}"
	body="${res%$'\n'*}"
	case "$code" in
	201) ota_info "Register: neu eingetragen." ;;
	200) ota_info "Register: bereits BYTEGLEICH eingetragen - Wiederholung, nichts geaendert." ;;
	*) ota_die "Registrierung abgelehnt (HTTP $code): $body" ;;
	esac
}

# --- Forgejo (Release-Assets) ------------------------------------------------

# ota_forgejo_auth_header <token> <user> <password> - druckt den Wert fuer den
# Authorization-Header. Ein Repo-Token ist der Normalfall; die schon
# vorhandenen Registry-Zugangsdaten sind der Rueckfall, damit die Automatik
# nicht an EINEM zusaetzlichen Geheimnis haengt.
ota_forgejo_auth_header() {
	local token="${1-}" user="${2-}" pass="${3-}"
	if [ -n "$token" ]; then
		printf 'token %s' "$token"
	elif [ -n "$user" ] && [ -n "$pass" ]; then
		printf 'Basic %s' "$(printf '%s:%s' "$user" "$pass" | base64 | tr -d '\n')"
	else
		return 1
	fi
}

# ota_forgejo_release_id <basis> <owner/repo> <tag> <auth-header>
# Legt die Release an oder findet die vorhandene (idempotent).
ota_forgejo_release_id() {
	local base="${1%/}" repo="$2" tag="$3" auth="$4" res code body id
	res="$(printf '{"tag_name":"%s","name":"%s"}' "$tag" "$tag" |
		curl -sS -o - -w '\n%{http_code}' \
			-X POST "$base/api/v1/repos/$repo/releases" \
			-H "Authorization: $auth" -H 'Content-Type: application/json' \
			--data-binary @- || true)"
	code="${res##*$'\n'}"
	body="${res%$'\n'*}"
	if [ "$code" = "201" ]; then
		id="$(printf '%s' "$body" | ota_json_field id)"
		[ -n "$id" ] || ota_die "Forgejo-Release ohne id: $body"
		printf '%s' "$id"
		return 0
	fi
	# Schon vorhanden (Wiederholung eines Laufs) - dann die vorhandene nehmen.
	res="$(curl -sS -o - -w '\n%{http_code}' \
		-H "Authorization: $auth" \
		"$base/api/v1/repos/$repo/releases/tags/$tag" || true)"
	code="${res##*$'\n'}"
	body="${res%$'\n'*}"
	[ "$code" = "200" ] || ota_die "Forgejo-Release fuer $tag weder anlegbar noch auffindbar (HTTP $code): $body"
	id="$(printf '%s' "$body" | ota_json_field id)"
	[ -n "$id" ] || ota_die "Forgejo-Release ohne id: $body"
	printf '%s' "$id"
}

# ota_forgejo_upload <basis> <owner/repo> <release-id> <datei> <auth-header>
#
# Idempotent: ein gleichnamiges Asset wird VORHER geloescht. Das ist die
# einzige Stelle, an der ein Wiederholungslauf etwas ersetzt - und die Bytes,
# die dabei hochgehen, sind dieselben (das Manifest ist deterministisch).
ota_forgejo_upload() {
	local base="${1%/}" repo="$2" rel="$3" file="$4" auth="$5" name res code body old
	[ -f "$file" ] || ota_die "Asset fehlt: $file"
	name="$(basename "$file")"
	body="$(curl -sS "$base/api/v1/repos/$repo/releases/$rel/assets" \
		-H "Authorization: $auth" || true)"
	old="$(printf '%s' "$body" | python3 -c '
import json, sys
try:
    items = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(items, list):
    sys.exit(0)
for it in items:
    if isinstance(it, dict) and it.get("name") == sys.argv[1]:
        print(it.get("id"))
        break
' "$name")"
	if [ -n "$old" ]; then
		curl -sS -o /dev/null -X DELETE \
			-H "Authorization: $auth" \
			"$base/api/v1/repos/$repo/releases/$rel/assets/$old" || true
	fi
	# Feldname `attachment` - live gegen git.tecmaxx.de verifiziert.
	res="$(curl -sS -o - -w '\n%{http_code}' \
		-X POST "$base/api/v1/repos/$repo/releases/$rel/assets?name=$name" \
		-H "Authorization: $auth" -F "attachment=@$file" || true)"
	code="${res##*$'\n'}"
	case "$code" in
	200 | 201) ota_info "Asset angehaengt: $name" ;;
	*) ota_die "Asset $name abgelehnt (HTTP $code): ${res%$'\n'*}" ;;
	esac
}

# --- Ablauf ------------------------------------------------------------------

ota_usage() {
	cat >&2 <<'EOF'
release-publish.sh - ein signiertes Edge-Release veroeffentlichen

  sign        <manifest> <keyfile>                signieren + gegen die eingebackene Wurzel pruefen
  publish     <manifest> <tag>                    Forgejo-Assets + Register-Eintrag
  next-seq    <portal> <token>                    "<nextSeq> <currentSeq>"
  token       <token-url> <client-id> <secret>    client_credentials-Token

Umgebung (publish): VP_OTA_PORTAL, VP_OTA_PORTAL_TOKEN, VP_OTA_FORGEJO_BASE,
VP_OTA_FORGEJO_REPO, VP_OTA_FORGEJO_TOKEN | FORGEJO_USERNAME+FORGEJO_PASSWORD,
VP_OTA_TRUST_SET.

Vollstaendiger Ablauf + einmalige Einrichtung: docs/ota-signing.md
EOF
}

# ota_sign <manifest> <keyfile> [trust-set]
#
# Signieren und danach GEGENPRUEFEN - mit `--root baked`, also gegen exakt die
# Wurzel, die im Image steckt. Das ist dieselbe Pruefung, die das Geraet
# ausfuehrt, nur vorgezogen vor die Auslieferung: ein Manifest, das hier
# durchfaellt, darf die Registry nie erreichen.
ota_sign() {
	local manifest="$1" keyfile="$2" trust="${3:-${VP_OTA_TRUST_SET:-edge-app/ota/trust-set.json}}"
	local core="${VP_OTA_CORE_DIR:-edge-app/core}"
	[ -f "$manifest" ] || ota_die "Manifest fehlt: $manifest"
	[ -f "$trust" ] || ota_die "Trust-Set fehlt: $trust (im Repo versioniert - siehe edge-app/ota/README.md)"
	[ -f "$trust.sig" ] || ota_die "Trust-Set-Signatur fehlt: $trust.sig"

	(cd "$core" && go run ./cmd/vp-ota sign \
		--key "$(ota_abs "$keyfile")" --domain release --in "$(ota_abs "$manifest")") ||
		ota_die "Signieren fehlgeschlagen"

	(cd "$core" && go run ./cmd/vp-ota verify --root baked \
		--trust-set "$(ota_abs "$trust")" --manifest "$(ota_abs "$manifest")") ||
		ota_die "Gegenpruefung gegen die EINGEBACKENE Wurzel fehlgeschlagen - dieses Release wuerde auf jedem Geraet abgelehnt. Es geht nichts hinaus."
}

ota_abs() {
	case "$1" in
	/*) printf '%s' "$1" ;;
	*) printf '%s/%s' "$(pwd -P)" "$1" ;;
	esac
}

# ota_publish <manifest> <tag>
ota_publish() {
	local manifest="$1" tag="$2" dir auth rel
	dir="$(dirname "$manifest")"
	[ -f "$manifest.sig" ] || ota_die "Signatur fehlt: $manifest.sig"
	[ -f "$dir/register.json" ] || ota_die "Register-Rumpf fehlt: $dir/register.json (entsteht beim Signieren)"

	local trust="${VP_OTA_TRUST_SET:-edge-app/ota/trust-set.json}"
	auth="$(ota_forgejo_auth_header "${VP_OTA_FORGEJO_TOKEN:-}" \
		"${FORGEJO_USERNAME:-}" "${FORGEJO_PASSWORD:-}")" ||
		ota_die "Keine Forgejo-Zugangsdaten (VP_OTA_FORGEJO_TOKEN oder FORGEJO_USERNAME/FORGEJO_PASSWORD)"

	rel="$(ota_forgejo_release_id "${VP_OTA_FORGEJO_BASE:-$OTA_FORGEJO_DEFAULT}" \
		"${VP_OTA_FORGEJO_REPO:-$OTA_REPO_DEFAULT}" "$tag" "$auth")"
	local f
	for f in "$manifest" "$manifest.sig" "$trust" "$trust.sig"; do
		ota_forgejo_upload "${VP_OTA_FORGEJO_BASE:-$OTA_FORGEJO_DEFAULT}" \
			"${VP_OTA_FORGEJO_REPO:-$OTA_REPO_DEFAULT}" "$rel" "$f" "$auth"
	done

	ota_register "${VP_OTA_PORTAL:-$OTA_PORTAL_DEFAULT}" \
		"${VP_OTA_PORTAL_TOKEN:?VP_OTA_PORTAL_TOKEN fehlt}" "$dir/register.json"
}

ota_main() {
	local cmd="${1:-}"
	shift || true
	case "$cmd" in
	sign) ota_sign "$@" ;;
	publish) ota_publish "$@" ;;
	next-seq) ota_next_seq "$@" ;;
	token) ota_token "$@" ;;
	state-schema) ota_state_schema "$@" ;;
	-h | --help | help | '') ota_usage; return 2 ;;
	*)
		printf 'Unbekannter Befehl: %s\n\n' "$cmd" >&2
		ota_usage
		return 2
		;;
	esac
}

# Nur ausfuehren, wenn direkt aufgerufen - der Selbsttest SOURCED die Datei und
# ruft die Funktionen einzeln auf (das Muster von install.sh/update.sh).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	ota_main "$@"
fi
