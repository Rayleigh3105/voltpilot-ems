"""JWKS zum Laborschluessel: python3 -I jwks.py jwt/key.pem > jwt/jwks.json (kid lasttest-1, wie mint.py)."""
import base64, json, subprocess, sys
mod = subprocess.run(["openssl", "rsa", "-in", sys.argv[1], "-noout", "-modulus"], capture_output=True, text=True,
                     check=True).stdout.strip().split("=", 1)[1]
b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
print(json.dumps({"keys": [{"kty": "RSA", "kid": "lasttest-1", "use": "sig", "alg": "RS256",
                            "n": b(bytes.fromhex(mod)), "e": b((65537).to_bytes(3, "big"))}]}))
