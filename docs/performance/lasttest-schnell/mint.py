"""Praegt Tokens wie der lokale Keycloak (Claims aus vp-lasttest/werkzeug/lastgen/mint.go), signiert
mit jwt/key.pem per openssl. Aufruf: python3 -I mint.py admin | lt-kunde-<n>"""
import base64, hashlib, json, subprocess, sys, time, os
here = os.path.dirname(os.path.abspath(__file__))
def b64(x): return base64.urlsafe_b64encode(x).rstrip(b'=').decode()
def md5uuid(s):
    h = hashlib.md5(s.encode()).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"
user = sys.argv[1]; now = int(time.time())
c = {"exp": now + 3600, "iat": now, "jti": md5uuid(f"{user}-{now}"), "iss": "http://localhost:18081/realms/voltpilot",
     "typ": "Bearer", "azp": "voltpilot-frontend", "acr": "1", "scope": "email profile", "email_verified": True,
     "preferred_username": user, "given_name": "LT", "sid": md5uuid("sid-" + user)}
if user == "admin":
    c.update(sub="c6ccc66b-8203-410a-af85-8db05fd8e268", realm_access={"roles": ["platform-admin"]},
             name="Platform Admin", family_name="Admin", email="admin@voltpilot.local")
else:
    n = user.removeprefix("lt-kunde-"); i = int(n)
    c.update(sub=md5uuid("lt-user-" + user), aud="account",
             realm_access={"roles": ["default-roles-voltpilot", "offline_access", "uma_authorization", "operator"]},
             resource_access={"account": {"roles": ["manage-account", "manage-account-links", "view-profile"]}},
             tenant_id=md5uuid(f"lt-tenant-{i}"), name="LT Kunde " + n, family_name="Kunde " + n, email=user + "@lt.invalid")
h = b64(json.dumps({"alg": "RS256", "typ": "JWT", "kid": "lasttest-1"}).encode())
p = b64(json.dumps(c).encode())
sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", os.path.join(here, "jwt", "key.pem")],
                     input=f"{h}.{p}".encode(), capture_output=True, check=True).stdout
print(f"{h}.{p}.{b64(sig)}")
