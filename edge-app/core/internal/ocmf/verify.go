package ocmf

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"math/big"
	"strings"
)

// Result is the outcome of one signature check.
type Result struct {
	Status string
	Grund  string // empty for gueltig
	// Verfahren is the signature method that was applied (SA or its default).
	Verfahren string
	// SchluesselSHA256 is the hex SHA-256 of the DER key that was used, the
	// fingerprint a later comparison with the meter label can match.
	SchluesselSHA256 string
}

// method is one row of OCMF Table 22. Every method hashes with SHA-256 -
// also the 384-bit curves ("ECDSA-secp384r1-SHA256").
type method struct {
	curve *curve
}

var methods = map[string]method{
	"ECDSA-secp192k1-SHA256":       {secp192k1},
	"ECDSA-secp256k1-SHA256":       {secp256k1},
	"ECDSA-secp192r1-SHA256":       {secp192r1},
	"ECDSA-secp256r1-SHA256":       {secp256r1},
	"ECDSA-brainpool256r1-SHA256":  {brainpoolP256r1},
	"ECDSA-brainpoolP256r1-SHA256": {brainpoolP256r1}, // spelling of the curve name in RFC 5639, used by NZR
	"ECDSA-secp384r1-SHA256":       {secp384r1},
	"ECDSA-brainpool384r1-SHA256":  {brainpoolP384r1},
	"ECDSA-brainpoolP384r1-SHA256": {brainpoolP384r1},
}

// Verify checks the record's signature against a public key: a DER
// SubjectPublicKeyInfo (OCMF Table 23 key types) given as hex or base64, the
// way OCMF tools and OCPP 2.0.1 (publicKey, "Base64 encoded") transmit it.
func Verify(rec Record, publicKey string) Result {
	name := strings.TrimSpace(rec.Signatur.SA)
	if name == "" {
		name = DefaultSignatureMethod
	}
	res := Result{Verfahren: name}
	m, ok := methods[name]
	if !ok {
		return res.fail(StatusNichtPruefbar, GrundVerfahrenUnbekannt)
	}
	if sm := strings.TrimSpace(rec.Signatur.SM); sm != "" && sm != "application/x-der" {
		return res.fail(StatusNichtPruefbar, GrundVerfahrenUnbekannt)
	}
	var sig []byte
	var err error
	switch strings.TrimSpace(rec.Signatur.SE) {
	case "", "hex":
		sig, err = hex.DecodeString(strings.TrimSpace(rec.Signatur.SD))
	case "base64":
		sig, err = base64.StdEncoding.DecodeString(strings.TrimSpace(rec.Signatur.SD))
	default:
		return res.fail(StatusNichtPruefbar, GrundVerfahrenUnbekannt)
	}
	if err != nil {
		return res.fail(StatusNichtPruefbar, GrundSignaturDefekt)
	}
	var rs struct{ R, S *big.Int }
	if rest, err := asn1.Unmarshal(sig, &rs); err != nil || len(rest) != 0 {
		return res.fail(StatusNichtPruefbar, GrundSignaturDefekt)
	}

	if strings.TrimSpace(publicKey) == "" {
		return res.fail(StatusNichtPruefbar, GrundSchluesselFehlt)
	}
	der, ok := DecodeKey(publicKey)
	if !ok {
		return res.fail(StatusNichtPruefbar, GrundSchluesselDefekt)
	}
	sum := sha256.Sum256(der)
	res.SchluesselSHA256 = hex.EncodeToString(sum[:])
	c, x, y, ok := parseKey(der)
	if !ok {
		return res.fail(StatusNichtPruefbar, GrundSchluesselDefekt)
	}
	if c != m.curve {
		return res.fail(StatusUngueltig, GrundSchluesselFremd)
	}
	digest := sha256.Sum256(rec.Payload)
	if !c.verify(x, y, digest[:], rs.R, rs.S) {
		return res.fail(StatusUngueltig, GrundSignaturFalsch)
	}
	res.Status = StatusGueltig
	return res
}

func (r Result) fail(status, grund string) Result {
	r.Status, r.Grund = status, grund
	return r
}

// DecodeKey reads a DER key given as hex or base64; a base64 text that itself
// carries hex (seen in OCPP 2.0.1 implementations) is unwrapped once.
func DecodeKey(s string) ([]byte, bool) {
	s = strings.TrimSpace(s)
	if b, err := hex.DecodeString(s); err == nil && len(b) > 0 {
		return b, true
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) == 0 {
		return nil, false
	}
	if h, err := hex.DecodeString(strings.TrimSpace(string(b))); err == nil && len(h) > 0 {
		return h, true
	}
	return b, true
}

var oidECPublicKey = asn1.ObjectIdentifier{1, 2, 840, 10045, 2, 1}

func parseKey(der []byte) (*curve, *big.Int, *big.Int, bool) {
	var spki struct {
		Algorithm pkix.AlgorithmIdentifier
		PublicKey asn1.BitString
	}
	if rest, err := asn1.Unmarshal(der, &spki); err != nil || len(rest) != 0 {
		return nil, nil, nil, false
	}
	if !spki.Algorithm.Algorithm.Equal(oidECPublicKey) {
		return nil, nil, nil, false
	}
	var oid asn1.ObjectIdentifier
	if _, err := asn1.Unmarshal(spki.Algorithm.Parameters.FullBytes, &oid); err != nil {
		return nil, nil, nil, false
	}
	var c *curve
	for _, k := range curves {
		if k.oid.Equal(oid) {
			c = k
		}
	}
	if c == nil {
		return nil, nil, nil, false
	}
	// Uncompressed point 04 || X || Y (SEC 1, 2.3.3); compressed keys are not
	// named by OCMF and stay unreadable.
	pt := spki.PublicKey.RightAlign()
	size := (c.p.BitLen() + 7) / 8
	if len(pt) != 1+2*size || pt[0] != 4 {
		return nil, nil, nil, false
	}
	x := new(big.Int).SetBytes(pt[1 : 1+size])
	y := new(big.Int).SetBytes(pt[1+size:])
	if !c.onCurve(x, y) {
		return nil, nil, nil, false
	}
	return c, x, y, true
}

// verify is ECDSA verification (SEC 1, 4.1.4). The NIST curves P-256 and
// P-384 go through crypto/ecdsa; the others (brainpool, 192-bit, Koblitz),
// which the standard library does not carry, through the plain affine
// arithmetic below. Verification handles only public data, so constant time
// does not matter here.
func (c *curve) verify(x, y *big.Int, digest []byte, r, s *big.Int) bool {
	if r == nil || s == nil || r.Sign() <= 0 || s.Sign() <= 0 || r.Cmp(c.n) >= 0 || s.Cmp(c.n) >= 0 {
		return false
	}
	if c.std != nil {
		return ecdsa.Verify(&ecdsa.PublicKey{Curve: c.std, X: x, Y: y}, digest, r, s)
	}
	e := hashToInt(digest, c.n)
	w := new(big.Int).ModInverse(s, c.n)
	if w == nil {
		return false
	}
	u1 := new(big.Int).Mul(e, w)
	u1.Mod(u1, c.n)
	u2 := new(big.Int).Mul(r, w)
	u2.Mod(u2, c.n)
	px, _ := c.add(c.mul(c.gx, c.gy, u1), c.mul(x, y, u2))
	if px == nil {
		return false
	}
	v := new(big.Int).Mod(px, c.n)
	return v.Cmp(r) == 0
}

// hashToInt takes the leftmost bits of the digest up to the order's length (SEC 1, 4.1.3 step 5).
func hashToInt(digest []byte, n *big.Int) *big.Int {
	bits := n.BitLen()
	if len(digest)*8 > bits {
		digest = digest[:(bits+7)/8]
	}
	e := new(big.Int).SetBytes(digest)
	if excess := len(digest)*8 - bits; excess > 0 {
		e.Rsh(e, uint(excess))
	}
	return e
}

// curve is a short Weierstrass curve y^2 = x^3 + ax + b over GF(p).
type curve struct {
	name               string
	oid                asn1.ObjectIdentifier
	p, a, b, gx, gy, n *big.Int
	std                elliptic.Curve
}

func (c *curve) onCurve(x, y *big.Int) bool {
	if x.Sign() < 0 || x.Cmp(c.p) >= 0 || y.Sign() < 0 || y.Cmp(c.p) >= 0 {
		return false
	}
	l := new(big.Int).Mul(y, y)
	l.Mod(l, c.p)
	r := new(big.Int).Mul(x, x)
	r.Add(r, c.a)
	r.Mul(r, x)
	r.Add(r, c.b)
	r.Mod(r, c.p)
	return l.Cmp(r) == 0
}

type point struct{ x, y *big.Int } // x == nil is the point at infinity

func (c *curve) add(p, q point) (*big.Int, *big.Int) {
	r := c.addPoints(p, q)
	return r.x, r.y
}

func (c *curve) addPoints(p, q point) point {
	if p.x == nil {
		return q
	}
	if q.x == nil {
		return p
	}
	var lambda *big.Int
	if p.x.Cmp(q.x) == 0 {
		sum := new(big.Int).Add(p.y, q.y)
		if sum.Mod(sum, c.p).Sign() == 0 {
			return point{}
		}
		// doubling: (3x^2 + a) / 2y
		num := new(big.Int).Mul(p.x, p.x)
		num.Mul(num, big.NewInt(3))
		num.Add(num, c.a)
		den := new(big.Int).Lsh(p.y, 1)
		lambda = num.Mul(num, new(big.Int).ModInverse(den.Mod(den, c.p), c.p))
	} else {
		num := new(big.Int).Sub(q.y, p.y)
		den := new(big.Int).Sub(q.x, p.x)
		lambda = num.Mul(num, new(big.Int).ModInverse(den.Mod(den, c.p), c.p))
	}
	lambda.Mod(lambda, c.p)
	x := new(big.Int).Mul(lambda, lambda)
	x.Sub(x, p.x)
	x.Sub(x, q.x)
	x.Mod(x, c.p)
	y := new(big.Int).Sub(p.x, x)
	y.Mul(y, lambda)
	y.Sub(y, p.y)
	y.Mod(y, c.p)
	return point{x, y}
}

func (c *curve) mul(x, y, k *big.Int) point {
	acc := point{}
	base := point{x, y}
	for i := k.BitLen() - 1; i >= 0; i-- {
		acc = c.addPoints(acc, acc)
		if k.Bit(i) == 1 {
			acc = c.addPoints(acc, base)
		}
	}
	return acc
}

func hexInt(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 16)
	if !ok {
		panic("ocmf: bad curve constant " + s)
	}
	return v
}

// Curve parameters: SEC 2 v2 (secp*) and RFC 5639 (brainpool). TestCurveParameters
// checks that each generator lies on its curve and has the stated order.
var (
	secp192r1 = &curve{name: "secp192r1", oid: asn1.ObjectIdentifier{1, 2, 840, 10045, 3, 1, 1},
		p:  hexInt("fffffffffffffffffffffffffffffffeffffffffffffffff"),
		a:  hexInt("fffffffffffffffffffffffffffffffefffffffffffffffc"),
		b:  hexInt("64210519e59c80e70fa7e9ab72243049feb8deecc146b9b1"),
		gx: hexInt("188da80eb03090f67cbf20eb43a18800f4ff0afd82ff1012"),
		gy: hexInt("07192b95ffc8da78631011ed6b24cdd573f977a11e794811"),
		n:  hexInt("ffffffffffffffffffffffff99def836146bc9b1b4d22831")}
	secp192k1 = &curve{name: "secp192k1", oid: asn1.ObjectIdentifier{1, 3, 132, 0, 31},
		p:  hexInt("fffffffffffffffffffffffffffffffffffffffeffffee37"),
		a:  big.NewInt(0),
		b:  big.NewInt(3),
		gx: hexInt("db4ff10ec057e9ae26b07d0280b7f4341da5d1b1eae06c7d"),
		gy: hexInt("9b2f2f6d9c5628a7844163d015be86344082aa88d95e2f9d"),
		n:  hexInt("fffffffffffffffffffffffe26f2fc170f69466a74defd8d")}
	secp256k1 = &curve{name: "secp256k1", oid: asn1.ObjectIdentifier{1, 3, 132, 0, 10},
		p:  hexInt("fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
		a:  big.NewInt(0),
		b:  big.NewInt(7),
		gx: hexInt("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
		gy: hexInt("483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"),
		n:  hexInt("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")}
	secp256r1 = &curve{name: "secp256r1", oid: asn1.ObjectIdentifier{1, 2, 840, 10045, 3, 1, 7},
		p:   elliptic.P256().Params().P,
		a:   new(big.Int).Sub(elliptic.P256().Params().P, big.NewInt(3)),
		b:   elliptic.P256().Params().B,
		gx:  elliptic.P256().Params().Gx,
		gy:  elliptic.P256().Params().Gy,
		n:   elliptic.P256().Params().N,
		std: elliptic.P256()}
	secp384r1 = &curve{name: "secp384r1", oid: asn1.ObjectIdentifier{1, 3, 132, 0, 34},
		p:   elliptic.P384().Params().P,
		a:   new(big.Int).Sub(elliptic.P384().Params().P, big.NewInt(3)),
		b:   elliptic.P384().Params().B,
		gx:  elliptic.P384().Params().Gx,
		gy:  elliptic.P384().Params().Gy,
		n:   elliptic.P384().Params().N,
		std: elliptic.P384()}
	brainpoolP256r1 = &curve{name: "brainpoolP256r1", oid: asn1.ObjectIdentifier{1, 3, 36, 3, 3, 2, 8, 1, 1, 7},
		p:  hexInt("a9fb57dba1eea9bc3e660a909d838d726e3bf623d52620282013481d1f6e5377"),
		a:  hexInt("7d5a0975fc2c3057eef67530417affe7fb8055c126dc5c6ce94a4b44f330b5d9"),
		b:  hexInt("26dc5c6ce94a4b44f330b5d9bbd77cbf958416295cf7e1ce6bccdc18ff8c07b6"),
		gx: hexInt("8bd2aeb9cb7e57cb2c4b482ffc81b7afb9de27e1e3bd23c23a4453bd9ace3262"),
		gy: hexInt("547ef835c3dac4fd97f8461a14611dc9c27745132ded8e545c1d54c72f046997"),
		n:  hexInt("a9fb57dba1eea9bc3e660a909d838d718c397aa3b561a6f7901e0e82974856a7")}
	brainpoolP384r1 = &curve{name: "brainpoolP384r1", oid: asn1.ObjectIdentifier{1, 3, 36, 3, 3, 2, 8, 1, 1, 11},
		p:  hexInt("8cb91e82a3386d280f5d6f7e50e641df152f7109ed5456b412b1da197fb71123acd3a729901d1a71874700133107ec53"),
		a:  hexInt("7bc382c63d8c150c3c72080ace05afa0c2bea28e4fb22787139165efba91f90f8aa5814a503ad4eb04a8c7dd22ce2826"),
		b:  hexInt("04a8c7dd22ce28268b39b55416f0447c2fb77de107dcd2a62e880ea53eeb62d57cb4390295dbc9943ab78696fa504c11"),
		gx: hexInt("1d1c64f068cf45ffa2a63a81b7c13f6b8847a3e77ef14fe3db7fcafe0cbd10e8e826e03436d646aaef87b2e247d4af1e"),
		gy: hexInt("8abe1d7520f9c2a45cb1eb8e95cfd55262b70b29feec5864e19c054ff99129280e4646217791811142820341263c5315"),
		n:  hexInt("8cb91e82a3386d280f5d6f7e50e641df152f7109ed5456b31f166e6cac0425a7cf3ab6af6b7fc3103b883202e9046565")}

	curves = []*curve{secp192r1, secp192k1, secp256k1, secp256r1, secp384r1, brainpoolP256r1, brainpoolP384r1}
)
