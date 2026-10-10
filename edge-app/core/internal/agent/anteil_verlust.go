package agent

import (
	"log/slog"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

// AP-15 IP-22: the loss of a fixed feed-in share (E1 = A, R2). The counter
// (guards/anteilverlust.go) is fed after every CapAnteil in applySetpoint and
// reported in the heartbeat block gemeinsame_steuerung - only while the box
// holds a share document. Without a document it is never fed and never sent:
// the heartbeat stays byte for byte what it was.

// verlustZone is the local day of the plant - the day the cloud stores under
// (the Tag der Anlage of every UEMS table is Europe/Berlin).
const verlustZone = "Europe/Berlin"

// restoreVerlust creates the counter in New and loads today's count from
// disk, so a restart in the middle of the day continues it.
func (a *Agent) restoreVerlust(dir string) {
	loc, err := time.LoadLocation(verlustZone)
	if err != nil {
		loc = time.Local
	}
	a.verlust = guards.NewAnteilVerlust(loc, dir)
	if err := a.verlust.Laden(time.Now()); err != nil {
		// unreadable = start the day at 0: never report more than was counted
		slog.Warn("stored share loss counter unreadable; starting at 0", "err", err)
	}
}

// anteilVerlust is the heartbeat field; the caller sends it only with a
// share document.
func (a *Agent) anteilVerlust() *cloud.AnteilVerlust {
	if a.verlust == nil {
		return nil
	}
	heute, vortag := a.verlust.Stand()
	out := &cloud.AnteilVerlust{Tag: heute.Tag, Kwh: heute.Kwh, GebundenS: int64(heute.GebundenS)}
	if heute.Tag == "" {
		out.Tag = a.verlust.TagVon(time.Now())
	}
	if vortag != nil {
		out.Vortag = &cloud.AnteilVerlustVortag{Tag: vortag.Tag, Kwh: vortag.Kwh, GebundenS: int64(vortag.GebundenS)}
	}
	return out
}
