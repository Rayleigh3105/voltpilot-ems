package layer1

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

type rawNachricht struct {
	Ts     string `json:"ts"`
	Unit   int    `json:"unit"`
	Blocks []struct {
		Start   int      `json:"start"`
		Regs    []uint16 `json:"regs"`
		Learned bool     `json:"learned"`
		Count   int      `json:"count"`
		Error   string   `json:"error"`
	} `json:"blocks"`
}

func rawAus(t *testing.T, m []byte) rawNachricht {
	t.Helper()
	var n rawNachricht
	if err := json.Unmarshal(m, &n); err != nil {
		t.Fatal(err)
	}
	return n
}

func wantSetzen(t *testing.T, r *rig, blocks ...map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"blocks": blocks})
	if err := r.bus.Publish(localbus.TopicRegistersWant, raw, true); err != nil {
		t.Fatal(err)
	}
}

func TestTheDeyePollFeedsTheMirrorWithOneLearnedBlockPerCycle(t *testing.T) {
	r := newRig(t, Options{Poll: 60 * time.Millisecond, FirstPoll: time.Hour})
	l := r.listen(localbus.TopicRegistersRaw)
	liveLV(r.sim)
	r.sim.Set(map[uint16]uint16{0x0300: 11, 0x0301: 12, 0x0480: 21})
	r.sim.Refuse(0x0500, 2)
	wantSetzen(t, r,
		map[string]any{"start": 0x0300, "count": 2},
		map[string]any{"start": 1110, "count": 4}, // the control window: never polled
		map[string]any{"start": 0x0480, "count": 200},
		map[string]any{"start": 0x0500, "count": 1},
		map[string]any{"start": "x", "count": 1},
	)
	time.Sleep(100 * time.Millisecond)
	r.selectDeye("hybrid_3p", map[string]any{"mb_slave_id": 1})

	msgs := l.wait(t, localbus.TopicRegistersRaw, 4, 10*time.Second)
	var gelernt []int
	for i, m := range msgs[:4] {
		n := rawAus(t, m)
		if n.Unit != 1 || n.Ts == "" {
			t.Fatalf("Zyklus %d: unit/ts: %+v", i, n)
		}
		if _, err := time.Parse(time.RFC3339, n.Ts); err != nil {
			t.Fatalf("ts ist die Pollzeit in RFC3339: %q", n.Ts)
		}
		zahl := 0
		for _, b := range n.Blocks {
			if !b.Learned {
				continue
			}
			zahl++
			gelernt = append(gelernt, b.Start)
			switch b.Start {
			case 0x0300:
				if b.Count != 2 || len(b.Regs) != 2 || b.Regs[0] != 11 || b.Regs[1] != 12 {
					t.Errorf("gelernter Block: %+v", b)
				}
			case 0x0480:
				if b.Count != 64 || len(b.Regs) != 64 || b.Regs[0] != 21 {
					t.Errorf("auf 64 Register begrenzt: count %d, %d Woerter", b.Count, len(b.Regs))
				}
			case 0x0500:
				if b.Error == "" || len(b.Regs) != 0 {
					t.Errorf("abgelehnter gelernter Block traegt den Fehler statt Woerter: %+v", b)
				}
			default:
				t.Errorf("unerwarteter gelernter Block %d", b.Start)
			}
		}
		if zahl != 1 {
			t.Fatalf("Zyklus %d: genau ein gelernter Block, nicht %d", i, zahl)
		}
	}
	if gelernt[0] != 0x0300 || gelernt[1] != 0x0480 || gelernt[2] != 0x0500 || gelernt[3] != 0x0300 {
		t.Errorf("reihum, ohne das Steuerfenster: %v", gelernt)
	}
	if r.count(localbus.TopicTelemetry) == 0 {
		t.Fatal("ein abgelehnter gelernter Block reisst den Poll nicht")
	}

	// An empty want set drops every learned block promptly.
	if err := r.bus.Publish(localbus.TopicRegistersWant, nil, true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	before := l.count(localbus.TopicRegistersRaw)
	for _, b := range rawAus(t, l.wait(t, localbus.TopicRegistersRaw, before+1, 5*time.Second)[before]).Blocks {
		if b.Learned {
			t.Fatalf("leere Wunschliste: kein gelernter Block mehr, got %+v", b)
		}
	}
}

func TestTheDeyeExportLimitRidesAlongOncePerDay(t *testing.T) {
	jetzt := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	var uhr struct{ t time.Time }
	uhr.t = jetzt
	r := newRig(t, Options{Poll: 40 * time.Millisecond, FirstPoll: 10 * time.Millisecond,
		Now: func() time.Time { return uhr.t }})
	l := r.listen(localbus.TopicRegistersRaw)
	liveLV(r.sim)
	r.sim.Set(map[uint16]uint16{0x00e7: 3300})
	r.selectDeye("hybrid_3p", nil)

	msgs := l.wait(t, localbus.TopicRegistersRaw, 3, 10*time.Second)
	traegt := func(m []byte) bool {
		for _, b := range rawAus(t, m).Blocks {
			if b.Start == 0x00e7 {
				if len(b.Regs) != 1 || b.Regs[0] != 3300 || b.Count != 0 {
					t.Fatalf("Exportgrenze als Pflichtblock mit einem Wort: %+v", b)
				}
				return true
			}
		}
		return false
	}
	if !traegt(msgs[0]) || traegt(msgs[1]) || traegt(msgs[2]) {
		t.Fatal("die Exportgrenze faehrt im ersten Zyklus mit, danach nicht")
	}
}
