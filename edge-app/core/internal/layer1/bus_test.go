package layer1

import (
	"strconv"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

// A retained config is a state: Layer 1 must see the messages of one topic in
// the order the core sent them, the retained one delivered on subscribe first,
// and must end on the newest. With paho's OrderMatters(false) every handler
// ran in its own goroutine, and the retained edge/sources/config with 0
// entries sometimes overtook the newer one - TestEdgeLightReadsAGoeSourceIntoTheCore
// then never read the go-e. A repeated subscribe (the connect handler) may
// deliver the retained message again; it is then the CURRENT one, so the
// sequence may repeat a value but never go back.
func TestTheBusDeliversOneTopicInOrder(t *testing.T) {
	addr := freeAddr(t)
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bus.Close() })
	if err := bus.Publish(TopicSourcesConfig, []byte("0"), true); err != nil {
		t.Fatal(err)
	}
	client, err := DialMQTT(addr, "vp-layer1-order-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)

	const n = 200
	var mu sync.Mutex
	var got []int
	if err := client.Subscribe(TopicSourcesConfig, func(_ string, p []byte) {
		v, _ := strconv.Atoi(string(p))
		mu.Lock()
		got = append(got, v)
		mu.Unlock()
	}); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= n; i++ {
		if err := bus.Publish(TopicSourcesConfig, []byte(strconv.Itoa(i)), true); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		mu.Lock()
		seq := append([]int(nil), got...)
		mu.Unlock()
		for i := 1; i < len(seq); i++ {
			if seq[i] < seq[i-1] {
				t.Fatalf("%d kam nach %d an - ein aelterer Stand ueberholte den neueren: %v", seq[i], seq[i-1], seq)
			}
		}
		if len(seq) > 0 && seq[len(seq)-1] == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("der neueste Stand %d kam nicht an: %v", n, seq)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
