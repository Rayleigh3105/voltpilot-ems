package installerwrite

import "testing"

// Der EXPERTEN-Umfang (Stufe 2 „Freie Register"). Bewiesen wird, WAS er
// freigibt - und dass er die tragenden Regeln der engen Schwester woertlich
// teilt statt sie neu zu erfinden.

func TestTheExpertScopeAdmitsEveryRegisterWord(t *testing.T) {
	for _, addr := range []int{0, 0x0028, 0x00e7, 0x1234, 0xffff} {
		for _, value := range []int{0, 1, 7000, 7001, 65535} {
			w, err := AdmitExpert(ExpertRequest{
				Kind: KindHolding, Addr: addr, Value: value, Apply: true,
				Confirm: ConfirmToken(addr, value),
			})
			if err != nil {
				t.Fatalf("addr %d value %d: %v", addr, value, err)
			}
			if w.Addr() != addr || w.Value() != value || w.Kind() != KindHolding {
				t.Fatalf("die zugelassene Schreibung traegt, was gefragt wurde: %+v", w)
			}
			if w.KwKnown() {
				t.Fatalf("ohne Skala gibt es keine Einheit (addr %d)", addr)
			}
		}
	}
}

func TestTheExpertScopeRefusesWhatIsNotARegisterWord(t *testing.T) {
	cases := []ExpertRequest{
		{Kind: KindHolding, Addr: -1, Value: 1},
		{Kind: KindHolding, Addr: 0x10000, Value: 1},
		{Kind: KindHolding, Addr: 1, Value: -1},
		{Kind: KindHolding, Addr: 1, Value: 65536},
		{Kind: "spule", Addr: 1, Value: 1},
		// ⚠ Eine Spule kennt nur zwei Zustaende - ein 300 dort ist ein
		// Anfrage-Fehler, und ihn erst das Geraet ablehnen zu lassen hiesse,
		// einen Rahmen fuer eine Zahl hinauszuschicken, die es nicht geben kann.
		{Kind: KindCoil, Addr: 1, Value: 300},
		// Funktionscode und Registerart muessen zusammenpassen.
		{Kind: KindCoil, Addr: 1, Value: 1, WriteFC: WriteFCMultiple},
		{Kind: KindHolding, Addr: 1, Value: 1, WriteFC: WriteFCCoil},
		{Kind: KindHolding, Addr: 1, Value: 1, WriteFC: 3},
	}
	for i, c := range cases {
		c.Apply = true
		c.Confirm = ConfirmToken(c.Addr, c.Value)
		if _, err := AdmitExpert(c); err == nil {
			t.Fatalf("Fall %d haette abgelehnt werden muessen: %+v", i, c)
		} else if _, ok := err.(*ValidationError); !ok {
			t.Fatalf("Fall %d: eine Ablehnung ist ein Bedienfehler, kein Ausfall: %v", i, err)
		}
	}
}

// Der Bestaetigungs-Token ist WOERTLICH derselbe wie beim engen Umfang - beide
// Trigger und die Cloud bauen dieselbe Zeichenkette.
func TestBothScopesShareTheConfirmToken(t *testing.T) {
	if ConfirmToken(RegisterAddr, 7000) != "0X00E7=7000" {
		t.Fatalf("die Schreibweise ist gepinnt: %q", ConfirmToken(RegisterAddr, 7000))
	}
	if _, err := AdmitExpert(ExpertRequest{
		Kind: KindHolding, Addr: 0x1234, Value: 5, Apply: true, Confirm: "0X1234=6",
	}); err == nil {
		t.Fatal("eine Bestaetigung aus einem anderen Versuch autorisiert diesen nicht")
	}
	// Ein PROBELAUF braucht gar keine Bestaetigung - er schreibt nichts.
	if _, err := AdmitExpert(ExpertRequest{Kind: KindHolding, Addr: 0x1234}); err != nil {
		t.Fatalf("ein Probelauf braucht keine Bestaetigung: %v", err)
	}
}

// Eine BEKANNTE Skala reist als reine Anzeige mit - und nur dann.
func TestAKnownScaleTravelsAsDisplayOnly(t *testing.T) {
	scale := 0.01
	w, err := AdmitExpert(ExpertRequest{
		Kind: KindHolding, Addr: RegisterAddr, Value: 7000, Apply: true,
		Confirm: ConfirmToken(RegisterAddr, 7000), Scale: &scale,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !w.KwKnown() || w.Kw() != 70 {
		t.Fatalf("70,0 kW erwartet: known=%v kw=%v", w.KwKnown(), w.Kw())
	}
	without, _ := AdmitExpert(ExpertRequest{
		Kind: KindHolding, Addr: RegisterAddr, Value: 7000, Apply: true,
		Confirm: ConfirmToken(RegisterAddr, 7000),
	})
	if without.KwKnown() || without.Kw() != 0 {
		t.Fatal("ohne Skala wird keine Einheit behauptet")
	}
}

// Der ENGE Umfang der :8484-Taste bleibt eng - die Ablösung gilt dem
// PORTAL-Kanal, nicht dem lokalen Knopf.
func TestTheNarrowScopeIsUnchanged(t *testing.T) {
	if _, err := Admit("hybrid_3p", Request{
		Value: 7001, Mode: ModeApply, Confirm: ConfirmToken(RegisterAddr, 7001),
	}); err == nil {
		t.Fatal("der Deckel der lokalen Taste steht weiterhin bei 7000")
	}
	if _, err := Admit("hybrid_3p", Request{
		Value: 0, Mode: ModeApply, Confirm: ConfirmToken(RegisterAddr, 0),
	}); err == nil {
		t.Fatal("0 bleibt fuer die lokale Taste ein offensichtlicher Vertipper")
	}
	if _, err := Admit("hybrid_1p", Request{Value: 3300}); err == nil {
		t.Fatal("die Familien-Regel der lokalen Taste steht")
	}
	w, err := Admit("hybrid_3p", Request{Value: 7000})
	if err != nil {
		t.Fatal(err)
	}
	if w.Kind() != KindHolding || !w.KwKnown() || w.Kw() != 70 {
		t.Fatalf("der enge Umfang liefert Registerart und Einheit wie bisher: %+v", w)
	}
}
