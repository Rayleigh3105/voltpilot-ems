package agent

import (
	"log/slog"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/boxevents"
)

// meldeBoxEreignis is the ONE way an event of this box reaches the cloud:
// local bus or core → durable outbox → .../v2/events. Identity comes from the
// enrollment, never from the payload, and the envelope's observed_at is stamped
// from the guarded clock.
func (a *Agent) meldeBoxEreignis(events ...boxevents.Ereignis) {
	if len(events) == 0 || a.boxEventOutbox == nil {
		return
	}
	a.measurementMu.Lock()
	id := a.measurementIdentity
	a.measurementMu.Unlock()
	if id.DeviceID == "" || id.TenantID == "" || id.SiteID == "" {
		// Before enrollment there is no topic to send on. Dropping is honest:
		// a stamp without identity could never be attributed to a box.
		slog.Warn("Box-Ereignis ohne Kennung verworfen", "anzahl", len(events))
		return
	}
	wand, _ := a.boxClock()
	if _, sprang := a.zeitWache.Pruefe(a.boxClock); sprang {
		slog.Warn("Uhrsprung der Box bemerkt; Stempel kommen aus der korrigierten Uhr",
			"sprung_s", a.zeitWache.LetzterSprungS(), "spruenge", a.zeitWache.Spruenge())
	}
	if _, err := a.boxEventOutbox.Append(events,
		boxevents.Identity{TenantID: id.TenantID, SiteID: id.SiteID, DeviceID: id.DeviceID},
		wand); err != nil {
		slog.Warn("Box-Ereignis nicht abgelegt", "err", err)
		return
	}
	a.kick()
}

// onBoxEvent takes ONE device event off the local bus. A driver states what it
// saw; this layer checks it against the closed vocabulary and refuses anything a
// driver may not report - a forged box_restart or a fabricated buffer gap above
// all, because only the core can know either.
func (a *Agent) onBoxEvent(_ string, payload []byte) {
	ereignis, err := boxevents.VomTreiber(payload, boxevents.NeueID)
	if err != nil {
		slog.Warn("lokales Geraete-Ereignis verworfen", "err", err)
		return
	}
	a.meldeBoxEreignis(ereignis)
}

// meldeBoxNeustart reports THIS runtime's start, exactly once per start and only
// once identity is known. The start time is recomputed from the current wall
// clock minus the monotonic uptime, so a box whose clock was still wrong at boot
// reports the corrected time instead of 1970 (see boxevents.ZeitWache).
func (a *Agent) meldeBoxNeustart() {
	a.boxEventMu.Lock()
	if a.boxRestartGemeldet || a.boxEventOutbox == nil {
		a.boxEventMu.Unlock()
		return
	}
	a.boxRestartGemeldet = true
	a.boxEventMu.Unlock()
	ereignis, err := boxevents.BoxNeustart(boxevents.NeueID(), a.zeitWache.Startzeit(a.boxClock))
	if err != nil {
		slog.Warn("Neustart-Ereignis nicht gebildet", "err", err)
		return
	}
	a.meldeBoxEreignis(ereignis)
}

// meldeVerdraengung turns a completed eviction of the SAMPLE outbox into the box's
// own data_gap (erkannt_aus: verdraengung) with the window it actually lost.
func (a *Agent) meldeVerdraengung() {
	if a.measurementOutbox == nil {
		return
	}
	von, bis, samples, ok := a.measurementOutbox.Verdraengung()
	if !ok {
		return
	}
	ereignis, err := boxevents.PufferVerdraengung(boxevents.NeueID(), von, bis, samples, "")
	if err != nil {
		slog.Warn("Verdraengungs-Ereignis nicht gebildet", "err", err)
		return
	}
	slog.Warn("Puffer verdraengt; Luecke wird gemeldet",
		"von", von, "bis", bis, "erwartet_fehlend", samples)
	a.meldeBoxEreignis(ereignis)
}

// boxClock is the injectable clock of every box-event stamp.
func (a *Agent) boxClock() (time.Time, time.Duration) {
	if a.uhr != nil {
		return a.uhr()
	}
	return time.Now(), time.Since(a.gestartet)
}
