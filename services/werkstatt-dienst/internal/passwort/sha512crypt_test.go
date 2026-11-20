package passwort

import (
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// Der erste Wert steht in der Beschreibung des Verfahrens (Drepper); die
// übrigen hat "openssl passwd -6 -salt <salt> <passwort>" (OpenSSL 3.6.5)
// gerechnet: ein Passwort in der Form des Dienstes und Passwörter um die
// Blockgrenze (64, 65 und 144 Zeichen).
func TestSha512CryptWieDieReferenz(t *testing.T) {
	lang := strings.Repeat("a", 144)
	for _, f := range []struct{ pw, salt, soll string }{
		{"Hello world!", "saltstring", "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1"},
		{"x7Kq-9mPz-aB3d-Yt5W-qq2R", "abcdefghijklmnop", "$6$abcdefghijklmnop$RZBuOYj9SB8pYfPE7rK9Wljy40rvTvvME9lBEzk/bS4UYC.2.GsAOvx5MkOJ4u19iwl6XrjDHFoKBAhh/78ax."},
		{lang, "s", "$6$s$kiYH/J9y3lChWP0DSiAcmOkiY4coTM72a4bwsx1WRyObe7raukkORbJPPjGLCsiUwXsHznBRBmNcFw46ctrM41"},
		{lang[:64], "s", "$6$s$e/ci9X0P/si6JKhId/bD59PwDCRUXGfXtlmFJBl9WlbG81lQ4/GNHZY264VcCPxDM9r6CfZeIDoPfOHTcfX4A/"},
		{lang[:65], "s", "$6$s$rKIFf36U8QHwzVezr2.b8ooIdwyjNXpiQhA5b0vKHEMvibJLTqdx46XC6sq8KYrzKiLt240J/ZBV8u4q9rGy30"},
	} {
		ist, err := Sha512Crypt(f.pw, f.salt)
		if err != nil || ist != f.soll {
			t.Errorf("Salt %q: %q (%v), erwartet %q", f.salt, ist, err, f.soll)
		}
	}
}

func TestSha512CryptWeistFalschesSaltAb(t *testing.T) {
	for _, salt := range []string{"", "mit$zeichen", "siebzehnZeichen..x", "leer zeichen"} {
		if h, err := Sha512Crypt("x", salt); err == nil {
			t.Errorf("Salt %q angenommen: %s", salt, h)
		}
	}
}

// Jeder Hash hat ein eigenes Salt, die Form von /etc/shadow, und kein Zeichen,
// das ein Befehl auf dem Gerät oder eine URI-Kodierung anders läse.
func TestShadowHash(t *testing.T) {
	pw := geheim.Neu("abcd-efgh-jkmn-pqrs-tuvw")
	a, err := ShadowHash(pw)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := ShadowHash(pw)
	if a == b {
		t.Fatal("zweimal dasselbe Salt")
	}
	teile := strings.Split(a, "$")
	if len(teile) != 4 || teile[1] != "6" || len(teile[2]) != 16 || len(teile[3]) != 86 {
		t.Fatalf("Form: %q", a)
	}
	if strings.Trim(a, saltZeichen+"$") != "" {
		t.Fatalf("fremde Zeichen in %q", a)
	}
	if strings.Contains(a, pw.Offenbaren()) {
		t.Fatal("das Passwort steht im Hash")
	}
	if soll, _ := Sha512Crypt(pw.Offenbaren(), teile[2]); soll != a {
		t.Fatalf("%q ist nicht der Hash zu seinem Salt (%q)", a, soll)
	}
}
