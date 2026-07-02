#!/usr/bin/env python3
"""Automated, Docker-free verification of the VoltPilot secure-broker design.

Proves the three guarantees the secure MQTT listener must enforce, using the
SAME machinery EMQX uses:

  (A) mTLS transport - a real TLS mutual-auth handshake with Python's ssl module
      (verify_mode=CERT_REQUIRED, the device CA as the trust anchor), exactly
      what EMQX's listener does with `verify=verify_peer` +
      `fail_if_no_peer_cert=true`:
        A1 a client presenting a valid issued device cert connects,
        A2 a client with NO cert is rejected,
        A3 a client with an UNTRUSTED cert (different CA) is rejected.

  (B) ACL policy - a faithful re-implementation of EMQX's file-authorizer
      semantics (top-down, first-match-wins, MQTT topic-filter matching)
      evaluated against the real infra/mqtt/acl/acl.conf, proving:
        B1 a device may publish its own telemetry/status,
        B2 a device may subscribe its own schedule/command/config,
        B3 a device is DENIED publishing another tenant's telemetry (cross-tenant),
        B4 a device is DENIED publishing to its own schedule (down-only topic),
        B5 a revoked/ungranted device UUID is denied everything,
        B6 the internal "vp-internal" backbone user keeps full ems/# access,
        B7 an anonymous dev client (empty username, plaintext 1883) is allowed.

Run:  python3 tools/pki/verify_mqtt_security.py
Exit code 0 = all checks passed. Requires openssl on PATH; no Docker, no broker.

The live-broker equivalents (EMQX on a throwaway port + mosquitto) are documented
in docs/connect-a-device.md; this harness stands in where Docker is unavailable.
"""
from __future__ import annotations

import os
import re
import ssl
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "pki" / "voltpilot-ca.sh"
ACL = REPO / "infra" / "mqtt" / "acl" / "acl.conf"

TENANT_A = "00000000-0000-0000-0000-000000000001"
SITE_A = "00000000-0000-0000-0000-000000000002"
DEVICE_A = "00000000-0000-0000-0000-000000000003"  # the seeded demo device (has an ACL grant)
TENANT_B = "10000000-0000-0000-0000-000000000001"
SITE_B = "10000000-0000-0000-0000-000000000002"
DEVICE_B = "10000000-0000-0000-0000-000000000003"

PASS, FAIL = "\033[32mPASS\033[0m", "\033[31mFAIL\033[0m"
_failures: list[str] = []


def check(name: str, ok: bool) -> None:
    print(f"  [{PASS if ok else FAIL}] {name}")
    if not ok:
        _failures.append(name)


# ---------------------------------------------------------------------------
# (A) mTLS handshake using the real issued certs.
# ---------------------------------------------------------------------------
def build_pki(out: Path) -> dict:
    """Drive the real CA tool to mint the CA, server cert and a device cert."""
    env = dict(os.environ, VP_PKI_OUT=str(out), VP_ACL_FILE=str(out / "acl.conf"))
    # Use a throwaway ACL copy so the test never mutates the committed file.
    (out / "acl.conf").write_text(ACL.read_text())
    run = lambda *a: subprocess.run([str(TOOL), *a], env=env, check=True,
                                    capture_output=True, text=True)
    run("init-ca", "--domain", "localhost", "--ip", "127.0.0.1")
    run("issue", "--tenant", TENANT_A, "--site", SITE_A, "--device", DEVICE_A)
    return {
        "ca": out / "ca" / "ca.crt",
        "server_crt": out / "server" / "server.crt",
        "server_key": out / "server" / "server.key",
        "dev_crt": out / "devices" / DEVICE_A / "device.crt",
        "dev_key": out / "devices" / DEVICE_A / "device.key",
    }


def make_untrusted_cert(out: Path) -> tuple[Path, Path]:
    """A self-signed cert from a CA the broker does NOT trust."""
    crt, key = out / "rogue.crt", out / "rogue.key"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
         "-keyout", str(key), "-out", str(crt), "-days", "1",
         "-subj", f"/O={TENANT_A}/OU={SITE_A}/CN={DEVICE_A}"],
        check=True, capture_output=True,
    )
    return crt, key


def tls_handshake(paths: dict, client_cert: tuple | None) -> tuple[bool, str | None]:
    """Run one mutual-TLS handshake on a loopback socket, EMQX-style.

    Returns (handshake_ok, peer_cn_seen_by_server).
    """
    srv_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    srv_ctx.load_cert_chain(paths["server_crt"], paths["server_key"])
    srv_ctx.verify_mode = ssl.CERT_REQUIRED  # fail_if_no_peer_cert=true
    srv_ctx.load_verify_locations(paths["ca"])  # device CA is the trust anchor

    cli_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    cli_ctx.check_hostname = False
    cli_ctx.load_verify_locations(paths["ca"])  # device trusts the broker's CA
    if client_cert:
        cli_ctx.load_cert_chain(client_cert[0], client_cert[1])

    lsock = socket.socket()
    lsock.bind(("127.0.0.1", 0))
    lsock.listen(1)
    port = lsock.getsockname()[1]

    result: dict = {}

    def server():
        try:
            raw, _ = lsock.accept()
            with srv_ctx.wrap_socket(raw, server_side=True) as s:
                peer = s.getpeercert() or {}
                cn = None
                for rdn in peer.get("subject", ()):  # extract CN
                    for k, v in rdn:
                        if k == "commonName":
                            cn = v
                result["cn"] = cn
                result["ok"] = True
        except ssl.SSLError as e:
            result["ok"] = False
            result["err"] = str(e)
        except OSError as e:
            result["ok"] = False
            result["err"] = str(e)

    t = threading.Thread(target=server)
    t.start()
    client_ok = True
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=5) as raw:
            with cli_ctx.wrap_socket(raw, server_hostname="localhost") as s:
                s.do_handshake()
    except (ssl.SSLError, OSError):
        client_ok = False
    t.join(timeout=5)
    lsock.close()
    server_ok = result.get("ok", False)
    return (client_ok and server_ok), result.get("cn")


def verify_mtls(out: Path) -> None:
    print("(A) mTLS transport (real TLS handshake, verify_peer + fail_if_no_peer_cert):")
    paths = build_pki(out)

    ok, cn = tls_handshake(paths, (paths["dev_crt"], paths["dev_key"]))
    check(f"A1 valid device cert connects (broker sees CN={cn})", ok and cn == DEVICE_A)

    ok, _ = tls_handshake(paths, None)
    check("A2 client with NO cert is rejected", not ok)

    rogue = make_untrusted_cert(out)
    ok, _ = tls_handshake(paths, rogue)
    check("A3 client with UNTRUSTED cert (foreign CA) is rejected", not ok)

    # Cryptographic revocation backstop: revoke DEVICE_A and prove the CRL now
    # fails chain validation (openssl verify -crl_check), mirroring EMQX CRL check.
    env = dict(os.environ, VP_PKI_OUT=str(out), VP_ACL_FILE=str(out / "acl.conf"))
    subprocess.run([str(TOOL), "revoke", "--device", DEVICE_A],
                   env=env, check=True, capture_output=True, text=True)
    r = subprocess.run(
        ["openssl", "verify", "-crl_check", "-CAfile", str(paths["ca"]),
         "-CRLfile", str(out / "ca" / "crl.pem"), str(paths["dev_crt"])],
        capture_output=True, text=True,
    )
    check("A4 revoked cert fails CRL validation", r.returncode != 0 and "revoked" in r.stdout + r.stderr)


# ---------------------------------------------------------------------------
# (B) EMQX file-ACL semantics, evaluated against the real acl.conf.
# ---------------------------------------------------------------------------
class Rule:
    __slots__ = ("permission", "who", "action", "topics")

    def __init__(self, permission, who, action, topics):
        self.permission = permission  # "allow" | "deny"
        self.who = who                # ("all",) | ("username", str) | ("username_re", str) | ("clientid", str) | ("ipaddr", str)
        self.action = action          # "publish" | "subscribe" | "all"
        self.topics = topics          # list[str], [] means all


_WHO_RE = re.compile(
    r"""\{\s*(?P<perm>allow|deny)\s*,\s*
        (?:
          (?P<all>all)
          |
          \{\s*username\s*,\s*\{\s*re\s*,\s*"(?P<ure>(?:[^"\\]|\\.)*)"\s*\}\s*\}
          |
          \{\s*username\s*,\s*"(?P<uname>[^"]*)"\s*\}
          |
          \{\s*clientid\s*,\s*"(?P<cid>[^"]*)"\s*\}
          |
          \{\s*ipaddr\s*,\s*"(?P<ip>[^"]*)"\s*\}
        )
        \s*,\s*(?P<action>publish|subscribe|all)\s*,\s*\[(?P<topics>.*)\]\s*\}\.\s*$
    """,
    re.VERBOSE,
)
_SHORT_RE = re.compile(r"^\{\s*(allow|deny)\s*,\s*all\s*\}\.\s*$")


def parse_acl(text: str) -> list[Rule]:
    rules: list[Rule] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("%%"):
            continue
        m = _SHORT_RE.match(line)
        if m:
            rules.append(Rule(m.group(1), ("all",), "all", []))
            continue
        m = _WHO_RE.match(line)
        if not m:
            raise ValueError(f"unparseable ACL rule: {line}")
        if m.group("all"):
            who = ("all",)
        elif m.group("ure") is not None:
            who = ("username_re", m.group("ure").replace('\\"', '"'))
        elif m.group("uname") is not None:
            who = ("username", m.group("uname"))
        elif m.group("cid") is not None:
            who = ("clientid", m.group("cid"))
        else:
            who = ("ipaddr", m.group("ip"))
        topics = re.findall(r'"((?:[^"\\]|\\.)*)"', m.group("topics"))
        rules.append(Rule(m.group("perm"), who, m.group("action"), topics))
    return rules


def mqtt_match(filt: str, topic: str) -> bool:
    """MQTT topic-filter match (+ single level, # multi level)."""
    f, t = filt.split("/"), topic.split("/")
    i = 0
    for i, seg in enumerate(f):
        if seg == "#":
            return True
        if i >= len(t):
            return False
        if seg == "+":
            continue
        if seg != t[i]:
            return False
    return len(f) == len(t)


def who_matches(who, client: dict) -> bool:
    kind = who[0]
    if kind == "all":
        return True
    if kind == "username":
        return client.get("username") == who[1]
    if kind == "username_re":
        return re.search(who[1], client.get("username") or "") is not None
    if kind == "clientid":
        return client.get("clientid") == who[1]
    if kind == "ipaddr":
        return client.get("ipaddr") == who[1]
    return False


def evaluate(rules: list[Rule], client: dict, action: str, topic: str) -> str:
    """First-match-wins. Returns 'allow', 'deny', or 'nomatch'."""
    for r in rules:
        if not who_matches(r.who, client):
            continue
        if r.action != "all" and r.action != action:
            continue
        if r.topics:
            interp = [t.replace("${username}", client.get("username") or "") for t in r.topics]
            if not any(mqtt_match(f, topic) for f in interp):
                continue
        return r.permission
    return "nomatch"


def verify_acl() -> None:
    print("(B) ACL policy (EMQX file-authorizer semantics on infra/mqtt/acl/acl.conf):")
    rules = parse_acl(ACL.read_text())

    dev = {"username": DEVICE_A, "clientid": DEVICE_A, "ipaddr": "203.0.113.9"}
    own = f"ems/{TENANT_A}/{SITE_A}/{DEVICE_A}"
    other = f"ems/{TENANT_B}/{SITE_B}/{DEVICE_B}"

    check("B1 device publishes its own /telemetry -> allow",
          evaluate(rules, dev, "publish", f"{own}/telemetry") == "allow")
    check("B2 device subscribes its own /schedule -> allow",
          evaluate(rules, dev, "subscribe", f"{own}/schedule") == "allow")
    check("B3 device publishes ANOTHER tenant's /telemetry -> deny (cross-tenant)",
          evaluate(rules, dev, "publish", f"{other}/telemetry") == "deny")
    check("B4 device publishes its OWN /schedule (down-only) -> deny",
          evaluate(rules, dev, "publish", f"{own}/schedule") == "deny")
    check("B5 device tries a non-ems topic -> deny",
          evaluate(rules, dev, "publish", "foo/bar") == "deny")

    ungranted = {"username": DEVICE_B, "clientid": DEVICE_B, "ipaddr": "203.0.113.9"}
    check("B5b revoked/ungranted device UUID -> denied everything",
          evaluate(rules, ungranted, "publish", f"{other}/telemetry") == "deny"
          and evaluate(rules, ungranted, "subscribe", f"{other}/schedule") == "deny")

    internal = {"username": "vp-internal", "clientid": "voltpilot-ingest-1", "ipaddr": "10.0.0.5"}
    check("B6 internal backbone user reads ems/+/+/+/telemetry -> allow",
          evaluate(rules, internal, "subscribe", f"{other}/telemetry") == "allow")

    anon = {"username": "", "clientid": "nodered-dev", "ipaddr": "172.20.0.4"}
    check("B7 anonymous dev client (empty username, 1883) -> allow",
          evaluate(rules, anon, "publish", f"{own}/telemetry") == "allow")


def main() -> int:
    if not TOOL.exists():
        print(f"missing {TOOL}", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="vp-verify-") as tmp:
        verify_mtls(Path(tmp))
    verify_acl()
    print()
    if _failures:
        print(f"{len(_failures)} check(s) FAILED: " + "; ".join(_failures))
        return 1
    print("all secure-broker checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
