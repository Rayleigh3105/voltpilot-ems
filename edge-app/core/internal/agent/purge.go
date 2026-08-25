// Data purge ("Datenaufzeichnungen löschen"), device side. Contract:
// docs/contracts/mqtt-data-purge.schema.json. Two triggers meet here:
//
//   - The CUSTOMER on the local web app (PurgeRecordedData, via web.Handler):
//     the local store-and-forward buffer + live-chart history are wiped
//     immediately, and a purge_request is published to the cloud - queued on
//     disk and re-sent on every (re)connect while the cloud has not confirmed,
//     so an offline purge is never lost and never silently dropped.
//
//   - The CLOUD's retained purge_data command (onPurgeCommand, via the cloud
//     link's command subscription): arrives right after any purge (portal- or
//     device-initiated) - on reconnect for a device that was offline - and
//     wipes everything observed at or before the purge watermark BEFORE the
//     publisher replays old buffer entries. It doubles as the confirmation of
//     a device-initiated purge.
package agent

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// purgeRequestFile persists a not-yet-confirmed purge request across restarts.
const purgeRequestFile = "purge-request.json"

type pendingPurge struct {
	RequestedAt time.Time `json:"requested_at"`
}

// PurgeRecordedData is the local web app's purge trigger: wipe the device's
// own recordings NOW and ask the cloud to delete the recorded history too.
// Returns the UI-facing purge state (never an error for the cloud half - a
// device without connectivity queues the request explicitly).
func (a *Agent) PurgeRecordedData() (state.DataPurgeInfo, error) {
	now := time.Now().UTC()
	dropped, err := a.buf.PurgeThrough(now)
	if err != nil {
		return state.DataPurgeInfo{}, err
	}
	a.hist.PurgeThrough(now)
	if a.ocpp != nil {
		if err := a.ocpp.srv.PurgeProtocolEventsThrough(now); err != nil {
			return state.DataPurgeInfo{}, err
		}
	}

	info := state.DataPurgeInfo{RequestedAt: now, CloudState: "ausstehend"}
	if err := a.savePendingPurge(pendingPurge{RequestedAt: now}); err != nil {
		// The local wipe already happened; without the file a restart forgets
		// the cloud request - surface it in the log, keep the in-memory state.
		slog.Warn("purge request not persisted; a restart before the cloud "+
			"confirmation would drop it", "err", err)
	}
	a.State.Update(func(s *state.Snapshot) {
		s.DataPurge = &info
		s.BufferPending = a.buf.Pending()
		s.BufferDataLoss = a.buf.DataLoss()
	})
	slog.Info("local recordings purged on customer request", "dropped_buffered", dropped)
	a.trySendPurgeRequest()
	if dp := a.State.Get().DataPurge; dp != nil {
		return *dp, nil
	}
	return info, nil
}

// trySendPurgeRequest publishes the pending purge request if the cloud link is
// up. Called from PurgeRecordedData and on every cloud (re)connect, so the
// request survives offline phases and broker hiccups. Publishing repeatedly is
// harmless - the cloud purge is idempotent.
func (a *Agent) trySendPurgeRequest() {
	pending, ok := a.loadPendingPurge()
	if !ok {
		return
	}
	a.linkMu.Lock()
	link := a.link
	a.linkMu.Unlock()
	if link == nil || !link.Connected() {
		return
	}
	if err := link.PublishPurgeRequest(pending.RequestedAt); err != nil {
		slog.Warn("purge request publish failed; retried on next connect", "err", err)
		return
	}
	slog.Info("purge request sent to the cloud", "requested_at", pending.RequestedAt)
	a.State.Update(func(s *state.Snapshot) {
		// Replace the pointer, never mutate through it: Snapshot copies handed
		// to readers (web marshaling) share the old target.
		if s.DataPurge != nil && s.DataPurge.CloudState != "bestaetigt" {
			cp := *s.DataPurge
			cp.CloudState = "angefordert"
			s.DataPurge = &cp
		}
	})
}

// onPurgeCommand handles the cloud's (retained) purge_data command: wipe every
// locally recorded sample observed at or before the purge watermark. Runs
// BEFORE the publisher can replay old entries (the command subscription and
// the publisher share the paho client's ordered delivery, and the buffer is
// locked during the wipe), so purged history cannot be re-uploaded.
func (a *Agent) onPurgeCommand(payload []byte) {
	var cmd struct {
		Type         string `json:"type"`
		DeviceID     string `json:"device_id"`
		PurgedBefore string `json:"purged_before"`
	}
	if err := json.Unmarshal(payload, &cmd); err != nil || cmd.Type != "purge_data" {
		if cmd.Type != "" {
			slog.Warn("unknown cloud command ignored", "type", cmd.Type)
		}
		return
	}
	snap := a.State.Get()
	if cmd.DeviceID != "" && snap.DeviceID != "" && cmd.DeviceID != snap.DeviceID {
		slog.Warn("purge command for another device ignored", "payload_device", cmd.DeviceID)
		return
	}
	watermark, err := time.Parse(time.RFC3339Nano, cmd.PurgedBefore)
	if err != nil {
		slog.Warn("purge command with unreadable purged_before ignored", "err", err)
		return
	}
	dropped, err := a.buf.PurgeThrough(watermark)
	if err != nil {
		slog.Error("local buffer purge failed", "err", err)
		return
	}
	a.hist.PurgeThrough(watermark)
	if a.ocpp != nil {
		if err := a.ocpp.srv.PurgeProtocolEventsThrough(watermark); err != nil {
			slog.Error("local OCPP journal purge failed", "err", err)
			return
		}
	}
	slog.Info("cloud purge command applied: local recordings wiped",
		"purged_before", watermark, "dropped_buffered", dropped)

	// Confirmation of a device-initiated purge: the cloud purged at or after
	// our request instant, so the round trip is complete.
	confirmed := false
	if pending, ok := a.loadPendingPurge(); ok && !watermark.Before(pending.RequestedAt) {
		if err := os.Remove(a.purgeRequestPath()); err != nil && !os.IsNotExist(err) {
			slog.Warn("could not clear the pending purge request", "err", err)
		}
		confirmed = true
	}
	a.State.Update(func(s *state.Snapshot) {
		s.BufferPending = a.buf.Pending()
		s.BufferDataLoss = a.buf.DataLoss()
		if confirmed && s.DataPurge != nil {
			cp := *s.DataPurge
			cp.CloudState = "bestaetigt"
			cp.ConfirmedAt = time.Now().UTC()
			s.DataPurge = &cp
		}
	})
}

func (a *Agent) purgeRequestPath() string {
	return filepath.Join(a.Cfg.DataDir, purgeRequestFile)
}

func (a *Agent) savePendingPurge(p pendingPurge) error {
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	tmp := a.purgeRequestPath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, a.purgeRequestPath())
}

func (a *Agent) loadPendingPurge() (pendingPurge, bool) {
	raw, err := os.ReadFile(a.purgeRequestPath())
	if err != nil {
		return pendingPurge{}, false
	}
	var p pendingPurge
	if json.Unmarshal(raw, &p) != nil || p.RequestedAt.IsZero() {
		return pendingPurge{}, false
	}
	return p, true
}

// restorePendingPurge surfaces a persisted, not-yet-confirmed purge request in
// the UI state after a restart; it is re-sent on the next cloud connect.
func (a *Agent) restorePendingPurge() {
	pending, ok := a.loadPendingPurge()
	if !ok {
		return
	}
	info := state.DataPurgeInfo{RequestedAt: pending.RequestedAt, CloudState: "ausstehend"}
	a.State.Update(func(s *state.Snapshot) { s.DataPurge = &info })
	slog.Info("pending purge request restored; will be sent once connected",
		"requested_at", pending.RequestedAt)
}
