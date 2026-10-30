package suche

import (
	"context"
	"sync"
	"time"
)

// The pacing of a search (docs/contracts/v2/mqtt-geraetesuche.md §3, "Takt").
// The box sets it itself; no order carries a field that could widen it. Only a
// test hands in a faster Takt - against simulators on the loopback.
const (
	// JeSekunde bounds the NEW connections of the whole search: every TCP
	// connection, every HTTP request (one connection each) and every UDP
	// nudge waits for its slot.
	JeSekunde = 20
	// Zeitlimit bounds one connection attempt and one request.
	Zeitlimit = 1500 * time.Millisecond
	// AnfragenJeErkenner bounds what ONE recogniser asks of one device. The
	// recognisers of a device run one after the other and stop at the first
	// find, so a device is never asked by two at once.
	AnfragenJeErkenner = 3
	// Arbeiter is how many devices are spoken to at the same time; each device
	// sees one connection at a time (the contract allows two).
	Arbeiter = 32
)

// Takt overrides the pacing; zero fields keep the contract values.
type Takt struct {
	JeSekunde int
	Zeitlimit time.Duration
	// Nachlauf is how long the box listens after the last UDP nudge before it
	// reads the ARP table (Edge Light).
	Nachlauf time.Duration
}

func (t Takt) jeSekunde() int {
	if t.JeSekunde <= 0 {
		return JeSekunde
	}
	return t.JeSekunde
}

func (t Takt) zeitlimit() time.Duration {
	if t.Zeitlimit <= 0 {
		return Zeitlimit
	}
	return t.Zeitlimit
}

func (t Takt) nachlauf() time.Duration {
	if t.Nachlauf <= 0 {
		return 2 * time.Second
	}
	return t.Nachlauf
}

// taktgeber hands out one slot per new connection, evenly spaced: never more
// than JeSekunde in any second, also not in a burst at the start.
type taktgeber struct {
	mu      sync.Mutex
	naechst time.Time
	abstand time.Duration
}

func neuerTaktgeber(jeSekunde int) *taktgeber {
	return &taktgeber{abstand: time.Second / time.Duration(jeSekunde)}
}

// warte blocks until the caller's slot; an ended ctx returns its error (the
// slot is spent - a cancelled search does not hurry).
func (t *taktgeber) warte(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	t.mu.Lock()
	jetzt := time.Now()
	slot := t.naechst
	if slot.Before(jetzt) {
		slot = jetzt
	}
	t.naechst = slot.Add(t.abstand)
	t.mu.Unlock()
	d := time.Until(slot)
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
