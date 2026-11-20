package layer1

import "sync/atomic"

// The Edge Light release of the Go control path (Steuern in Go, Teil 1b).
//
// A bench release proves the code that ran at the bench. Every Deye release
// in force today was earned with the Node-RED executor of the Docker box, so
// it must not open the Go executor of Edge Light by itself. This table is the
// one place that does: an entry names the family, the control path and the
// bench record of the session that ran THIS code. It ANDs with every gate the
// core and the planner already keep - the kill switch control_enabled, the
// platform certification or the device's First-Light grant, the native
// certificates, the deliberate-fallback gate of the ToU path - and widens none
// of them. Without an entry the family is planned and read (the capability
// probe runs, the plan is visible) but nothing is written.
//
// The bench session itself runs a build with the tag `pruefstand`
// (pruefstand.go), which opens the gate for every family; a release build never
// carries it (edge-light/scripts/test.sh checks the built program).

// Freigabe is one bench release of the Go control path.
type Freigabe struct {
	Familie string // the selection's family ("hybrid_3p"), for the curtailment the source's communication ("fronius_sunspec")
	Pfad    string // "remote", "tou", "abregelung" or "modbus"
	Beleg   string // the bench record: date, device, firmware, cases, who released
}

// freigaben is empty until the captain has released a family at the bench.
var freigaben = []Freigabe{}

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
