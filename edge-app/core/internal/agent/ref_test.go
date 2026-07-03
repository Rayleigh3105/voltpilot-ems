package agent

// Tests for the self-generated device reference and its check character. The
// api-side validator (EdgeRef.java) MUST agree with refCheckChar byte for byte;
// EdgeRefTest.java exercises the same vectors from the Java side.

import (
	"strings"
	"testing"
)

// refValid mirrors EdgeRef.isValid on the api side: an "edge-" ref must be the
// prefix + six body chars + one matching check char, all in the alphabet.
func refValid(ref string) bool {
	if !strings.HasPrefix(ref, generatedRefPrefix) {
		return false
	}
	rest := ref[len(generatedRefPrefix):]
	if len(rest) != 7 {
		return false
	}
	for i := 0; i < 6; i++ {
		if strings.IndexByte(refAlphabet, rest[i]) < 0 {
			return false
		}
	}
	return rest[6] == refCheckChar(rest[:6])
}

func TestGeneratedRefIsValid(t *testing.T) {
	for i := 0; i < 1000; i++ {
		ref := newGeneratedRef()
		if !strings.HasPrefix(ref, "edge-") {
			t.Fatalf("ref %q missing prefix", ref)
		}
		if len(ref) != len("edge-")+7 {
			t.Fatalf("ref %q has unexpected length %d", ref, len(ref))
		}
		if !refValid(ref) {
			t.Fatalf("freshly generated ref %q failed its own checksum", ref)
		}
	}
}

func TestSingleCharTypoBreaksChecksum(t *testing.T) {
	// A fixed, known-valid ref so the mutation vectors are deterministic.
	ref := "edge-" + "abcdef" + string(refCheckChar("abcdef"))
	if !refValid(ref) {
		t.Fatalf("baseline ref %q should be valid", ref)
	}
	body := ref[len("edge-"):] // 7 chars incl. check
	detected, total := 0, 0
	for pos := 0; pos < len(body); pos++ {
		for _, c := range refAlphabet {
			if byte(c) == body[pos] {
				continue // no change
			}
			mutated := "edge-" + body[:pos] + string(byte(c)) + body[pos+1:]
			total++
			if !refValid(mutated) {
				detected++
			}
		}
	}
	if detected != total {
		t.Fatalf("single-char substitution not always detected: %d/%d", detected, total)
	}
}

func TestAdjacentTranspositionBreaksChecksum(t *testing.T) {
	ref := "edge-" + "mnpqrs" + string(refCheckChar("mnpqrs"))
	body := ref[len("edge-"):]
	for pos := 0; pos < len(body)-1; pos++ {
		if body[pos] == body[pos+1] {
			continue
		}
		swapped := "edge-" + body[:pos] + string(body[pos+1]) + string(body[pos]) + body[pos+2:]
		if refValid(swapped) {
			t.Fatalf("adjacent transposition at %d not detected: %q", pos, swapped)
		}
	}
}

func TestWrongLengthRejected(t *testing.T) {
	// A deletion (6 body chars) or insertion (8) must not pass.
	if refValid("edge-abcdef") {
		t.Fatal("6-char body should be rejected")
	}
	if refValid("edge-abcdefgh") {
		t.Fatal("8-char body should be rejected")
	}
}
