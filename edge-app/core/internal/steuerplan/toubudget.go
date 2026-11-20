package steuerplan

import (
	"fmt"
	"math"
	"time"
)

// The day budget of the Deye Time-of-Use path: the Go twin of
// edge-app/nodered/deye-tou-budget.js. The unit is a PLAN CHANGE (one executor
// tick that writes at least one register of the ToU plan); a change is
// admitted only while the day keeps room for itself AND the way back, so the
// day's last room always belongs to the release.

// TouPlanChangesPerDay is the Vorgabe (guards.NativeWriteBudgetPerDay, the
// deye_tou profile).
const TouPlanChangesPerDay = 20

// TouBudget is the durable per-logger record { day, changes, held }.
type TouBudget struct {
	Day     string `json:"day"`
	Changes int    `json:"changes"`
	Held    bool   `json:"held"`
}

// TouBudgetReport is the additive tou_budget block on the control readback.
type TouBudgetReport struct {
	Day     string `json:"day"`
	Changes int    `json:"changes"`
	Limit   int    `json:"limit"`
	Held    bool   `json:"held"`
}

// TouBudgetLimit is the budget in force: the core's persistent_write_budget
// when it is an integer in (0, 20], else the Vorgabe - a profile may tighten
// it, never loosen it.
func TouBudgetLimit(stated any) int {
	if isNum(stated) {
		n := num(stated)
		if finite(n) && n == float64(int(n)) && n > 0 && n <= TouPlanChangesPerDay {
			return int(n)
		}
	}
	return TouPlanChangesPerDay
}

// TouBudgetDay is the box's local calendar day of now as YYYY-MM-DD.
func TouBudgetDay(now time.Time) string {
	return fmt.Sprintf("%04d-%02d-%02d", now.Year(), int(now.Month()), now.Day())
}

// TouBudgetToday is the record for the day of now: a record of another day
// starts over, a record of today whose count is not a count reads as spent
// (fail-closed - EEPROM wear is not undone by a corrupt file).
func TouBudgetToday(record any, now time.Time) TouBudget {
	day := TouBudgetDay(now)
	r := obj(record)
	if r == nil || str(get(r, "day")) != day || !isStr(get(r, "day")) {
		return TouBudget{Day: day}
	}
	changes := TouPlanChangesPerDay
	if c := get(r, "changes"); isNum(c) {
		f := num(c)
		if finite(f) && f == math.Trunc(f) && f >= 0 && f < 1<<53 {
			changes = int(f)
		}
	}
	return TouBudget{Day: day, Changes: changes, Held: isTrue(get(r, "held"))}
}

// TouBudgetAdmits says whether one more plan change may happen today.
func TouBudgetAdmits(b TouBudget, limit int) bool {
	return !b.Held && b.Changes+2 <= limit
}

// TouBudgetCounted is the record after a tick that wrote.
func TouBudgetCounted(b TouBudget) TouBudget {
	return TouBudget{Day: b.Day, Changes: b.Changes + 1, Held: b.Held}
}

// TouBudgetHeld is the record after a refused plan change.
func TouBudgetHeld(b TouBudget) TouBudget {
	return TouBudget{Day: b.Day, Changes: b.Changes, Held: true}
}

// TouBudgetReason is the German sentence for the log and the readback.
func TouBudgetReason(b TouBudget, limit int) string {
	return "Tagesbudget der Zeitfenster-Steuerung erreicht (" + itoa(b.Changes) + " von " + itoa(limit) +
		" Planwechseln im Dauerspeicher): bis Mitternacht keine weiteren Planwechsel - " +
		"der Wechselrichter läuft in seiner eigenen Einstellung"
}

// Report is the tou_budget block.
func (b TouBudget) Report(limit int) TouBudgetReport {
	return TouBudgetReport{Day: b.Day, Changes: b.Changes, Limit: limit, Held: b.Held}
}
