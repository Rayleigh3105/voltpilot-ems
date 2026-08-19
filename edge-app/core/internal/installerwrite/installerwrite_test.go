package installerwrite

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The captain's case, end to end through the admission: raise Anlage Herzogau
// from its installer cap of 33,0 kW (raw 3300) to the registered 70,0 kW
// (raw 7000).
func TestTheHerzogauCaseIsAdmittedWithTheRightScale(t *testing.T) {
	plan, err := Admit("hybrid_3p", Request{Register: "0x00E7", Value: 7000, Mode: ModeApply, Confirm: "0x00E7=7000"})
	if err != nil {
		t.Fatalf("admit: %v", err)
	}
	if plan.Addr() != 0x00e7 || plan.Register() != "0x00e7" {
		t.Fatalf("register: %#v", plan)
	}
	if plan.Value() != 7000 || plan.Kw() != 70 {
		t.Fatalf("value/kw: %d / %v", plan.Value(), plan.Kw())
	}
	if !plan.Apply() {
		t.Fatal("confirmed request must apply")
	}
	if got := KwFor(3300); got != 33 {
		t.Fatalf("33,0 kW must decode from the old cap, got %v", got)
	}
}

// The DEFAULT stage is the dry run: saying nothing gets you the safe stage.
func TestTheDefaultStageIsADryRun(t *testing.T) {
	for _, mode := range []string{"", "dry_run", "DRY", "garbage"} {
		plan, err := Admit("hybrid_3p", Request{Value: 5000, Mode: mode})
		if err != nil {
			t.Fatalf("mode %q: %v", mode, err)
		}
		if plan.Apply() {
			t.Fatalf("mode %q must not apply", mode)
		}
	}
}

// A real write needs the exact confirm token - and the token names BOTH the
// register and the value, so a confirm copied from an earlier attempt with a
// different value does not authorise this one.
func TestApplyNeedsTheExactConfirmToken(t *testing.T) {
	cases := []struct{ name, confirm string }{
		{"empty", ""},
		{"just yes", "ja"},
		{"register only", "0x00E7"},
		{"another value", "0x00E7=3300"},
		{"another register", "0x0028=7000"},
	}
	for _, c := range cases {
		if _, err := Admit("hybrid_3p", Request{Value: 7000, Mode: ModeApply, Confirm: c.confirm}); err == nil {
			t.Fatalf("%s: expected refusal", c.name)
		}
	}
	// The canonical token works, and so does a lowercase spelling of the hex.
	for _, ok := range []string{"0x00E7=7000", "0x00e7=7000", "  0x00E7=7000  "} {
		if _, err := Admit("hybrid_3p", Request{Value: 7000, Mode: ModeApply, Confirm: ok}); err != nil {
			t.Fatalf("confirm %q: %v", ok, err)
		}
	}
}

// The value ceiling. 0 is refused as an obvious mis-entry rather than written:
// it would forbid feed-in entirely, and this path exists to RAISE a limit.
func TestTheValueCeilingIsHard(t *testing.T) {
	for _, v := range []int{-1, 0} {
		if _, err := Admit("hybrid_3p", Request{Value: v}); err == nil {
			t.Fatalf("value %d must be refused", v)
		}
	}
	if _, err := Admit("hybrid_3p", Request{Value: MaxRaw}); err != nil {
		t.Fatalf("the ceiling itself must be admissible: %v", err)
	}
	if _, err := Admit("hybrid_3p", Request{Value: MaxRaw + 1}); err == nil {
		t.Fatalf("one above the ceiling must be refused")
	}
	if MaxKw != 70 {
		t.Fatalf("the ceiling is 70,0 kW by design, got %v", MaxKw)
	}
}

// ⚠ The allowlist is the READ-side honesty table, and hybrid_1p is the case it
// exists for: there the feed-in cap register IS our own discharge lever.
func TestOnlyTheFamilyWhose0x00E7IsADedicatedCapMayBeWritten(t *testing.T) {
	if !AllowedFamily("hybrid_3p") {
		t.Fatal("hybrid_3p must be allowed")
	}
	for _, fam := range []string{"", "hybrid_1p", "string", "micro", "sunspec", "sunspec_live", "kostal_bi", "made_up"} {
		if AllowedFamily(fam) {
			t.Fatalf("family %q must NOT be allowed", fam)
		}
		if _, err := Admit(fam, Request{Value: 7000, Mode: ModeApply, Confirm: ConfirmToken(RegisterAddr, 7000)}); err == nil {
			t.Fatalf("family %q: expected refusal", fam)
		}
	}
}

// A register named in the request must be THE register - a copy-paste from
// another device's instructions is refused, never silently redirected.
func TestANamedRegisterMustBeTheAllowlistedOne(t *testing.T) {
	for _, ok := range []string{"0x00E7", "0x00e7", "00E7", "e7", "231"} {
		if _, err := Admit("hybrid_3p", Request{Register: ok, Value: 100}); err != nil {
			t.Fatalf("register spelling %q: %v", ok, err)
		}
	}
	for _, bad := range []string{"0x0028", "0x00F5", "0x008F", "40", "quatsch"} {
		if _, err := Admit("hybrid_3p", Request{Register: bad, Value: 100}); err == nil {
			t.Fatalf("register %q must be refused", bad)
		}
	}
}

// Every refusal is a ValidationError carrying a German sentence a curl user can
// act on - never a bare error.
func TestEveryRefusalCarriesAGermanSentence(t *testing.T) {
	_, err := Admit("hybrid_1p", Request{Value: 7000, Mode: ModeApply, Confirm: ConfirmToken(RegisterAddr, 7000)})
	var ve *ValidationError
	if !errors.As(err, &ve) || ve.Msg == "" {
		t.Fatalf("expected a ValidationError with a message, got %v", err)
	}
}

func TestConfirmTokenNamesRegisterAndValue(t *testing.T) {
	if got := ConfirmToken(RegisterAddr, 7000); got != "0X00E7=7000" && got != "0x00E7=7000" {
		t.Fatalf("token: %q", got)
	}
}

// --- the audit log --------------------------------------------------------

func TestTheAuditLogSurvivesAReopenAndIsNewestFirst(t *testing.T) {
	dir := t.TempDir()
	l, err := NewLog(dir)
	if err != nil {
		t.Fatal(err)
	}
	before, after := 3300, 7000
	kw := 70.0
	for i, e := range []Entry{
		{Register: RegisterLabel, Before: &before, Requested: 5000, Result: ResultMismatch, Source: "wartungszugang"},
		{Register: RegisterLabel, Before: &before, Requested: 7000, After: &after, Kw: &kw, Result: ResultApplied, Source: "wartungszugang"},
	} {
		e.At = time.Date(2026, 8, 19, 10, i, 0, 0, time.UTC)
		if err := l.Append(e); err != nil {
			t.Fatal(err)
		}
	}
	// A FRESH handle, i.e. the restart case.
	reopened, err := NewLog(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := reopened.List()
	if len(got) != 2 {
		t.Fatalf("want 2 entries, got %d", len(got))
	}
	if got[0].Result != ResultApplied || got[0].Requested != 7000 {
		t.Fatalf("newest first expected, got %#v", got[0])
	}
	if got[0].Before == nil || *got[0].Before != 3300 || got[0].After == nil || *got[0].After != 7000 {
		t.Fatalf("before/after must survive: %#v", got[0])
	}
	if got[1].After != nil {
		t.Fatalf("an unread after must stay ABSENT, not become 0: %#v", got[1])
	}
}

// A read of 0 is a VALUE („may not feed in at all"), never an absence - the
// pointer discipline of the whole feature.
func TestAZeroReadingIsAValueNotAnAbsence(t *testing.T) {
	dir := t.TempDir()
	l, _ := NewLog(dir)
	zero := 0
	if err := l.Append(Entry{Register: RegisterLabel, Before: &zero, Requested: 7000, Result: ResultApplied}); err != nil {
		t.Fatal(err)
	}
	got := l.List()
	if len(got) != 1 || got[0].Before == nil || *got[0].Before != 0 {
		t.Fatalf("a 0 reading must round-trip as a value: %#v", got)
	}
}

func TestTheLogIsBoundedAndKeepsTheNewest(t *testing.T) {
	dir := t.TempDir()
	l, _ := NewLog(dir)
	for i := 0; i < MaxEntries+10; i++ {
		if err := l.Append(Entry{Register: RegisterLabel, Requested: i + 1, Result: ResultApplied}); err != nil {
			t.Fatal(err)
		}
	}
	got := l.List()
	if len(got) != MaxEntries {
		t.Fatalf("want %d entries, got %d", MaxEntries, len(got))
	}
	if got[0].Requested != MaxEntries+10 {
		t.Fatalf("newest must survive, got %d", got[0].Requested)
	}
}

// A corrupt log must not block the write that is about to happen - the record
// of THIS attempt matters more than the unreadable history.
func TestACorruptLogStillAcceptsANewEntry(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	l, _ := NewLog(dir)
	if got := l.List(); len(got) != 0 {
		t.Fatalf("corrupt log must read as empty, got %d", len(got))
	}
	if err := l.Append(Entry{Register: RegisterLabel, Requested: 7000, Result: ResultApplied}); err != nil {
		t.Fatal(err)
	}
	if got := l.List(); len(got) != 1 {
		t.Fatalf("want the new entry, got %d", len(got))
	}
}

// ⚠ THE STRUCTURAL NARROWNESS: an AdmittedWrite has no exported fields, so no
// adapter anywhere can hand the mechanism a register or a value nobody admitted.
// Admit is the ONLY constructor - this test would stop compiling if that
// changed, which is the point.
func TestOnlyAdmitCanBuildAnAdmittedWrite(t *testing.T) {
	var zero AdmittedWrite
	if zero.Addr() != 0 || zero.Value() != 0 || zero.Apply() || zero.ExpectedBefore() != nil {
		t.Fatalf("the zero value must be inert: %#v", zero)
	}
	w, err := Admit("hybrid_3p", Request{Value: 7000})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := w.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	var back struct {
		Register string  `json:"register"`
		Addr     int     `json:"addr"`
		Value    int     `json:"value"`
		Kw       float64 `json:"kw"`
		Apply    bool    `json:"apply"`
		Expected *int    `json:"expected_before"`
	}
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if back.Register != RegisterLabel || back.Addr != RegisterAddr || back.Value != 7000 || back.Kw != 70 || back.Apply {
		t.Fatalf("marshalled shape: %s", raw)
	}
	if back.Expected != nil {
		t.Fatalf("an absent precondition must not be rendered: %s", raw)
	}
}

// The OPTIONAL precondition: a trigger that decided minutes ago says „only write
// if the register still reads X". It is carried through admission and validated
// as a register word.
func TestThePreconditionIsOptionalAndMustBeARegisterWord(t *testing.T) {
	w, err := Admit("hybrid_3p", Request{Value: 7000})
	if err != nil {
		t.Fatal(err)
	}
	if w.ExpectedBefore() != nil {
		t.Fatal("absent = no expectation")
	}
	want := 3300
	w, err = Admit("hybrid_3p", Request{Value: 7000, ExpectedBefore: &want})
	if err != nil {
		t.Fatal(err)
	}
	if w.ExpectedBefore() == nil || *w.ExpectedBefore() != 3300 {
		t.Fatalf("the expectation must survive admission: %#v", w.ExpectedBefore())
	}
	// A 0 IS a valid expectation („the register currently forbids feed-in").
	zero := 0
	if _, err := Admit("hybrid_3p", Request{Value: 7000, ExpectedBefore: &zero}); err != nil {
		t.Fatalf("0 is a register word: %v", err)
	}
	for _, bad := range []int{-1, 0x10000} {
		v := bad
		if _, err := Admit("hybrid_3p", Request{Value: 7000, ExpectedBefore: &v}); err == nil {
			t.Fatalf("expected_before %d must be refused", bad)
		}
	}
	// The caller's own copy cannot be mutated afterwards to change the plan.
	orig := 3300
	w, _ = Admit("hybrid_3p", Request{Value: 7000, ExpectedBefore: &orig})
	orig = 9999
	if *w.ExpectedBefore() != 3300 {
		t.Fatal("the admitted write must own its precondition")
	}
}

func TestTheMechanismResultKeepsNotReadApartFromZero(t *testing.T) {
	zero := 0
	r := WriteOnceResult{Before: &zero}
	if !r.OK() {
		t.Fatal("an empty error code is a clean exchange")
	}
	if r.Before == nil || *r.Before != 0 || r.After != nil {
		t.Fatalf("0 is a value, an unread register is nil: %#v", r)
	}
	if (WriteOnceResult{ErrorCode: ErrCodePrecondition}).OK() {
		t.Fatal("an error code is not OK")
	}
}
