package steuerplan

import "strings"

// The hold check of a control write: the Go twin of
// edge-app/nodered/readback-verify.js. It answers two questions per readback
// cycle separately - does each register satisfy ITS rule, and is the cycle
// evidence at all - because a Solarman logger that cannot reach the inverter
// still answers an all-zero block, and the remote watchdog is a timer the
// inverter counts down, not a value that reads back bit-identically.

// WatchdogOff is the documented "watchdog off" sentinel of Deye register 1101.
const WatchdogOff = 0xffff

// Per-register verdicts and per-cycle verdicts.
const (
	VerdictHeld     = "held"
	VerdictMismatch = "mismatch"
	VerdictUnread   = "unread"

	CycleHeld        = "held"
	CycleMismatch    = "mismatch"
	CycleUnconfirmed = "unconfirmed"
)

// NoAnswerReason is the cycle reason of the logger's all-zero non-answer.
const NoAnswerReason = "Der Wechselrichter hat auf die Ruecklese-Anfrage nicht geantwortet " +
	"(Null-Antwort des Loggers) - der geschriebene Sollwert ist damit weder " +
	"bestaetigt noch widerlegt."

// valueRange is the DOCUMENTED value range per control register: a read
// outside it is a filler the logger substituted, i.e. no answer. The watchdog
// (1101) has none on purpose - 0xFFFF is its real "off" value there.
var valueRange = map[string][2]int{
	"remote_mode":        {0, 3},
	"power_control_mode": {0, 2},
	"battery_strategy":   {0, 5},
	"battery_soc_belt":   {0, 100},
	"pv_max_permille":    {0, 1200},
}

// RuleForRole names the comparison semantics of a control register:
// "countdown" for the armed dead-man's timer, "exact" for everything else.
func RuleForRole(role string) string {
	if role == "remote_watchdog" {
		return "countdown"
	}
	return "exact"
}

// RegDistance is the distance of two register words on the 16-bit ring, right
// for signed and unsigned registers alike.
func RegDistance(a, b int) int {
	d := a&0xffff - b&0xffff
	if d < 0 {
		d = -d
	}
	if 0x10000-d < d {
		return 0x10000 - d
	}
	return d
}

// RueckEintrag is one register of a readback cycle. Actual nil = the read
// produced no value.
type RueckEintrag struct {
	Role      string
	Expect    int
	Actual    *int
	Tolerance float64
	Rule      string
	Error     string
}

// RegisterUrteil is the verdict on one register.
type RegisterUrteil struct {
	Role    string `json:"role"`
	Verdict string `json:"verdict"`
	Note    string `json:"note"`
}

// VerifyRegister is the per-register verdict (readback-verify.js verifyRegister).
func VerifyRegister(e RueckEintrag) RegisterUrteil {
	expect := e.Expect & 0xffff
	if e.Actual == nil {
		note := "nicht gelesen"
		if e.Error != "" {
			note = e.Error
		}
		return RegisterUrteil{e.Role, VerdictUnread, note}
	}
	actual := *e.Actual & 0xffff
	if r, ok := valueRange[e.Role]; ok && (actual < r[0] || actual > r[1]) {
		return RegisterUrteil{e.Role, VerdictUnread, "unplausibler Rueckgabewert " + itoa(actual) +
			" (erlaubt " + itoa(r[0]) + ".." + itoa(r[1]) + ") - keine echte Antwort"}
	}
	rule := e.Rule
	if rule == "" {
		rule = RuleForRole(e.Role)
	}
	if rule == "countdown" {
		switch {
		case actual == expect:
			return RegisterUrteil{e.Role, VerdictHeld, ""}
		case actual == WatchdogOff:
			return RegisterUrteil{e.Role, VerdictMismatch, "Totmannschalter steht auf AUS - die Scharfstellung wurde nicht uebernommen"}
		case actual == 0:
			return RegisterUrteil{e.Role, VerdictMismatch, "Totmannschalter ist abgelaufen - der Wechselrichter hat die Fernsteuerung verlassen"}
		case actual < expect:
			return RegisterUrteil{e.Role, VerdictHeld, "laeuft ab (" + itoa(actual) + " s von " + itoa(expect) + " s)"}
		}
		return RegisterUrteil{e.Role, VerdictMismatch, "Wert hoeher als scharfgestellt (" + itoa(actual) + " s > " + itoa(expect) + " s)"}
	}
	tol := 0.0
	if e.Tolerance > 0 {
		tol = e.Tolerance
	}
	if float64(RegDistance(actual, expect)) <= tol {
		return RegisterUrteil{e.Role, VerdictHeld, ""}
	}
	return RegisterUrteil{e.Role, VerdictMismatch, ""}
}

// IsZeroAnswer is the Solarman "inverter did not answer" stub: every register
// read came back 0 while at least one non-zero value was commanded.
func IsZeroAnswer(entries []RueckEintrag) bool {
	read := 0
	commandedNonZero := false
	for _, e := range entries {
		if e.Expect&0xffff != 0 {
			commandedNonZero = true
		}
		if e.Actual == nil {
			continue
		}
		if *e.Actual&0xffff != 0 {
			return false
		}
		read++
	}
	return read > 0 && commandedNonZero
}

// ZyklusUrteil is the verdict on one readback cycle. AllMatch nil =
// unconfirmed (no verdict).
type ZyklusUrteil struct {
	Cycle         string           `json:"cycle"`
	AllMatch      *bool            `json:"allMatch"`
	Registers     []RegisterUrteil `json:"registers"`
	MismatchRoles []string         `json:"mismatchRoles"`
	UnreadRoles   []string         `json:"unreadRoles"`
	Reason        string           `json:"reason"`
}

// VerifyCycle judges one readback pass: a real mismatch wins over unread
// registers; anything else left unproven makes the cycle unconfirmed, never a
// mismatch.
func VerifyCycle(entries []RueckEintrag) ZyklusUrteil {
	out := ZyklusUrteil{Cycle: CycleUnconfirmed, Registers: []RegisterUrteil{}, MismatchRoles: []string{}, UnreadRoles: []string{}}
	if len(entries) == 0 {
		out.Reason = "Keine Register zurueckgelesen."
		return out
	}
	zero := IsZeroAnswer(entries)
	for _, e := range entries {
		r := RegisterUrteil{e.Role, VerdictUnread, "keine Antwort (Null-Wert)"}
		if !zero {
			r = VerifyRegister(e)
		}
		out.Registers = append(out.Registers, r)
		switch r.Verdict {
		case VerdictMismatch:
			out.MismatchRoles = append(out.MismatchRoles, r.Role)
		case VerdictUnread:
			out.UnreadRoles = append(out.UnreadRoles, r.Role)
		}
	}
	if len(out.MismatchRoles) > 0 {
		f := false
		out.Cycle, out.AllMatch = CycleMismatch, &f
		out.Reason = "Der Wechselrichter haelt den geschriebenen Wert nicht (" + strings.Join(out.MismatchRoles, ", ") + ")."
		return out
	}
	if len(out.UnreadRoles) > 0 {
		out.Cycle = CycleUnconfirmed
		if zero {
			out.Reason = NoAnswerReason
		} else {
			out.Reason = "Rueckmeldung unvollstaendig - nicht gelesen: " + strings.Join(out.UnreadRoles, ", ") + "."
		}
		return out
	}
	t := true
	out.Cycle, out.AllMatch = CycleHeld, &t
	return out
}
