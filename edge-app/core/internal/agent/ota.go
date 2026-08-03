package agent

// OTA Stufe 0 „Sehen" (scout vp-ota-rollout-h4 §9): the device's own report of
// what it is running and what it is doing about it. There is NO write path
// here and no target on the device - this whole file is observation.
//
// It closes the first of the three documented holes in the fleet's version
// view: the core version used to travel ONLY inside the `flows` ack block, and
// the edge does not build that block until it has seen its first flow
// deployment - so a box on which no automation was ever rolled out reported no
// version at all. The top-level `version` field now rides every heartbeat
// (see cloud.Link.version), and the `update` block below rides next to it.

import "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"

// updateSummary builds the additive `update` heartbeat block.
//
// **Everything it cannot honestly know stays absent.** In Stufe 0 the device
// has no release register, no assigned target and no applied-update history,
// so `current_seq`, `target*`, `channel` and `last_known_good` are omitted
// rather than guessed - the cloud orders releases by its register's
// `release_seq`, and a fabricated sequence number here would corrupt exactly
// that ordering. `current` is the stamped version VERBATIM: an existing build
// is stamped with a bare 12-char commit SHA, and splitting or reformatting it
// would invent a release tag the box was never built with.
//
// `state` is idle because nothing on the device applies anything yet - saying
// anything else would claim an activity that does not exist.
func (a *Agent) updateSummary() *cloud.UpdateSummary {
	return &cloud.UpdateSummary{
		Backend: cloud.UpdateBackendCompose,
		Current: Version,
		State:   cloud.UpdateStateIdle,
	}
}
