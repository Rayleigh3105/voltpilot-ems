#!/usr/bin/env bash
# Selbstauskunft fuer die beiden OTA-Selbsttests (test-release-publish.sh,
# test-release-workflow.sh). Sie prueft NICHTS und entscheidet NICHTS - sie
# sagt nur, in welcher Umgebung gerade gelaufen wird.
#
# WARUM es das gibt (CI-Lauf #183, 07.08.2026): das Leg `ota-release` lief dort
# zum ERSTEN MAL ueberhaupt (es kam mit #327/#329 am 04.08. ins Gate, und das
# geprueft Deployment war seit Lauf #95 nicht mehr von Hand angestossen worden)
# - und es wurde rot. Lokal laufen beide Skripte gruen durch, die Protokolle des
# Laufs sind ueber die Forgejo-API nicht lesbar (siehe AGENTS.md "Einen ROTEN
# CI-Lauf untersuchen"), und auf Verdacht an fremdem Code zu schrauben waere der
# falsche Zug. Also wird stattdessen der NAECHSTE Fehlschlag selbsterklaerend:
# Werkzeuge, Go-Umgebung, Netz und Container-Lage stehen dann im Protokoll, und
# ein Abbruch nennt seine Zeile und sein Kommando.
#
# Nichts hier darf den Lauf beeinflussen: jede Probe ist zeitbegrenzt, fehlertolerant
# und rein informativ.

# Laeuft dieser Job selbst in einem Container? Heuristik, nur zur Anzeige.
ota_in_container() {
	[ -f /.dockerenv ] && return 0
	grep -qaE '(docker|containerd|kubepods|libpod)' /proc/1/cgroup 2>/dev/null && return 0
	return 1
}

# Erreichbarkeit ohne curl (curl ist auf einem Runner nicht garantiert, python3
# ist es hier sehr wohl - beide Skripte brauchen es fuer ihren Stub).
ota_reach() { # host port
	python3 - "$1" "$2" <<'PY' 2>/dev/null || echo "nein"
import socket, sys
try:
    socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=4).close()
    print("ja")
except Exception as e:
    print(f"nein ({type(e).__name__})")
PY
}

# Die Zugriffsrechte einer Datei als Oktalzahl - GNU zuerst, BSD als Rueckfall.
#
# ⚠ Die Reihenfolge ist TRAGEND und war im Leg `ota-release` der zweite
# Linux-Fehlschlag: `stat -f` heisst auf BSD/macOS "Format" und auf GNU/Linux
# "FILESYSTEM-Status". Die naheliegende Schreibweise
# `stat -f '%OLp' … || stat -c '%a' …` sieht portabel aus, ist es aber nicht -
# auf Linux GELINGT `stat -f` (es druckt Dateisystem-Daten), der Rueckfall wird
# also nie erreicht und der Vergleich bekommt einen Absatz statt "600".
# Andersherum stimmt es: BSD kennt `-c` gar nicht und bricht sauber ab.
ota_file_mode() { # datei
	stat -c '%a' "$1" 2>/dev/null || stat -f '%OLp' "$1"
}

ota_env_report() {
	local ctx="host"
	ota_in_container && ctx="container"
	echo "== Umgebung =="
	printf '  laeuft in       %s\n' "$ctx"
	printf '  bash            %s\n' "${BASH_VERSION:-?}"
	printf '  python3         %s\n' "$(python3 -V 2>&1 || echo 'fehlt')"
	# curl ist keine Nebensache: JEDER Netz-Aufruf in release-publish.sh laeuft
	# darueber (Token, Register, Release-Assets). Fehlt es, bricht der Lauf
	# mitten in einer Zuweisung ab und sagt bis heute nicht, warum.
	printf '  curl            %s\n' "$(command -v curl >/dev/null 2>&1 && curl --version 2>/dev/null | head -1 || echo 'FEHLT - release-publish.sh braucht es fuer jeden Aufruf')"
	printf '  go              %s\n' "$(command -v go >/dev/null 2>&1 && go version || echo 'fehlt - die echte Zeremonie wird uebersprungen')"
	if command -v go >/dev/null 2>&1; then
		# Der Modul-Cache ist im Gate leer (setup-go mit cache:false). `go run`
		# des vp-ota braucht zwar nur die Standardbibliothek, aber ein
		# gesperrter Proxy faellt hier auf statt in einer krummen Fehlermeldung.
		printf '  GOPROXY         %s\n' "$(go env GOPROXY 2>/dev/null)"
		printf '  GOTOOLCHAIN     %s\n' "$(go env GOTOOLCHAIN 2>/dev/null)"
		printf '  GOFLAGS         %s\n' "$(go env GOFLAGS 2>/dev/null)"
		printf '  GOMODCACHE      %s\n' "$(go env GOMODCACHE 2>/dev/null)"
	fi
	# Beide Selbsttests binden ihren Stub auf 127.0.0.1 - geht das nicht, war
	# der Grund bisher nirgends zu sehen.
	printf '  Loopback bindbar %s\n' "$(python3 -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print("ja (Port %d)" % s.getsockname()[1])
s.close()' 2>&1 | head -1)"
	printf '  proxy.golang.org %s\n' "$(ota_reach proxy.golang.org 443)"
	echo
}

# Ein Abbruch nennt Zeile und Kommando. Bewusst OHNE `set -E`: die Skripte
# pruefen mit ihrem `fails()`-Helfer absichtlich fehlschlagende Kommandos in
# einer Subshell, und ein vererbter Trap machte daraus Rauschen.
ota_on_err() { # status zeile kommando
	printf '\n!! Abbruch in Zeile %s (Status %s): %s\n' "$2" "$1" "$3" >&2
	printf '   Umgebung siehe den Bericht am Anfang dieses Laufs.\n' >&2
}

ota_install_err_trap() {
	trap 'ota_on_err "$?" "$LINENO" "$BASH_COMMAND"' ERR
}
