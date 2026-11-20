package layer1

import "sync/atomic"

// The Edge Light release of the Go control path (Steuern in Go, Teil 1b).
//
// A release proves the code that will run in the field. Every Deye release
// in force on the Docker box today was earned with its Node-RED executor, so
// it must not open the Go executor of Edge Light by itself. This table is the
// one place that does: an entry names the family, the control path and the
// record of why Edge Light may write for it. It ANDs with every gate the
// core and the planner already keep - the kill switch control_enabled, the
// platform certification or the device's First-Light grant, the native
// certificates, the deliberate-fallback gate of the ToU path - and widens none
// of them. Without an entry the family is planned and read (the capability
// probe runs, the plan is visible) but nothing is written.
//
// The normal record is a bench session: the captain runs the Go build at the
// bench against the real device and the entry's Beleg names that session. The
// captain can also release a family without a bench session, as he did for
// Deye hybrid_3p and hybrid_1p (remote, tou) and Fronius fronius_sunspec
// (abregelung) on 20.11.2026, resting the Beleg on the equality with the
// Node-RED executor's behaviour instead (the shared vectors of PR #1965 and
// PR #1967). Such a Beleg says so honestly, by name; the bench steps from
// those PRs stay recommended before the family's first field deployment,
// they are just not a precondition any more.
//
// A build with the tag `pruefstand` (pruefstand.go) opens the gate for every
// family regardless of this table, for the bench session itself; a release
// build never carries it (edge-light/scripts/test.sh checks the built
// program).

// Freigabe is one release of the Go control path.
type Freigabe struct {
	Familie string // the selection's family ("hybrid_3p"), for the curtailment the source's communication ("fronius_sunspec")
	Pfad    string // "remote", "tou", "abregelung" or "modbus"
	Beleg   string // why it is released: bench record, or the captain's own release and its grounds
}

// freigaben holds the families and paths the captain has released so far.
var freigaben = []Freigabe{
	{Familie: "hybrid_3p", Pfad: "remote", Beleg: "Freigabe durch den Captain am 20.11.2026 ohne Prüfstand, " +
		"gestützt auf die Gleichheit mit dem Node-RED-Verhalten (gemeinsame Vektoren, PR #1965)"},
	{Familie: "hybrid_3p", Pfad: "tou", Beleg: "Freigabe durch den Captain am 20.11.2026 ohne Prüfstand, " +
		"gestützt auf die Gleichheit mit dem Node-RED-Verhalten (gemeinsame Vektoren, PR #1965)"},
	{Familie: "fronius_sunspec", Pfad: "abregelung", Beleg: "Freigabe durch den Captain am 20.11.2026 ohne Prüfstand, " +
		"gestützt auf die Gleichheit mit dem Node-RED-Verhalten (gemeinsame Vektoren, PR #1967)"},
	{Familie: "hybrid_1p", Pfad: "remote", Beleg: "Freigabe durch den Captain am 20.11.2026 ohne Prüfstand, " +
		"gestützt auf die Gleichheit mit dem Node-RED-Verhalten (gemeinsame Vektoren, PR #1965)"},
	{Familie: "hybrid_1p", Pfad: "tou", Beleg: "Freigabe durch den Captain am 20.11.2026 ohne Prüfstand, " +
		"gestützt auf die Gleichheit mit dem Node-RED-Verhalten (gemeinsame Vektoren, PR #1965)"},
}

// pruefstandBuild is true only in a build with the tag `pruefstand`.
var pruefstandBuild atomic.Bool

// PruefstandBuild says whether this program is the bench build.
func PruefstandBuild() bool { return pruefstandBuild.Load() }

// steuernFreigegeben says whether Edge Light may write to a device of this
// family over this path.
func steuernFreigegeben(familie, pfad string) bool {
	if pruefstandBuild.Load() {
		return true
	}
	for _, f := range freigaben {
		if f.Familie == familie && f.Pfad == pfad && f.Beleg != "" {
			return true
		}
	}
	return false
}
