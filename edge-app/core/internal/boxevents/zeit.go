package boxevents

import (
	"sync"
	"time"
)

// Uhr answers two questions at once: what the wall clock says, and how long this
// process has been running by a clock that cannot jump. Every time in this package
// comes from here, so a test injects a jumping clock instead of waiting for one.
type Uhr func() (wand time.Time, laufzeit time.Duration)

// ZeitWache notices that the wall clock of this box jumped.
//
// WHY it does not report it: `clock_jump` is NOT a box art. Its Urheber is
// `datenannahme` (events-vocabulary.md §4, column "Box" = "-"), it lies on the
// INGRESS axis, and the cloud derives it by comparing two successive envelopes of
// the same box (§7). A box that sent it would violate the closed vocabulary and
// have its whole envelope rejected. So the box does the ONE thing a jump really
// asks of it: it never stamps an event from a wall clock it saw move.
//
// Startzeit is therefore always "now minus uptime", recomputed at stamping time,
// never the wall time read at boot. A box without an RTC that boots at 1970 and
// gets NTP three minutes later reports its restart with the CORRECTED time.
type ZeitWache struct {
	mu       sync.Mutex
	wand     time.Time
	laufzeit time.Duration
	spruenge int
	letzterS int64
}

// NeueZeitWache takes the first reading; from here on every Pruefe compares.
func NeueZeitWache(u Uhr) *ZeitWache {
	wand, laufzeit := u()
	return &ZeitWache{wand: wand, laufzeit: laufzeit}
}

// Pruefe compares one new reading against the previous one. The wall clock and
// the monotonic clock must advance by the same amount; anything beyond
// SprungSchwelleS seconds is a jump. It returns the signed jump in seconds.
func (z *ZeitWache) Pruefe(u Uhr) (sprungS int64, sprang bool) {
	wand, laufzeit := u()
	z.mu.Lock()
	defer z.mu.Unlock()
	abweichung := (wand.Sub(z.wand) - (laufzeit - z.laufzeit)) / time.Second
	z.wand, z.laufzeit = wand, laufzeit
	if abweichung > SprungSchwelleS || abweichung < -SprungSchwelleS {
		z.spruenge++
		z.letzterS = int64(abweichung)
		return int64(abweichung), true
	}
	return int64(abweichung), false
}

// Startzeit is when this runtime started, by the clock of RIGHT NOW.
func (z *ZeitWache) Startzeit(u Uhr) time.Time {
	wand, laufzeit := u()
	return wand.Add(-laufzeit).UTC().Truncate(time.Second)
}

// Spruenge and LetzterSprungS are local evidence only - a log line and a counter,
// never a wire field.
func (z *ZeitWache) Spruenge() int {
	z.mu.Lock()
	defer z.mu.Unlock()
	return z.spruenge
}

func (z *ZeitWache) LetzterSprungS() int64 {
	z.mu.Lock()
	defer z.mu.Unlock()
	return z.letzterS
}
