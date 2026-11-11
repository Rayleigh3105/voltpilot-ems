package csms_test

// OCPP "klopft an" end to end on the websocket: a station whose identity is
// not on the allowlist is refused at the upgrade - and remembered with its
// attempts and address (klopftan_test.go has the window and the bounds).

import (
	"net/netip"
	"testing"
	"time"

	ocpp16 "github.com/lorenzodonini/ocpp-go/ocpp1.6"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
)

func alleAdressen(netip.Addr) bool { return true }

func TestEineAbgewieseneSaeuleKlopftAn(t *testing.T) {
	s, endpoint := startServer(t, "SAEULE-1")
	for i := 0; i < 2; i++ {
		cp := ocpp16.NewChargePoint("SAEULE1", nil, nil)
		if err := cp.Start(endpoint); err == nil {
			cp.Stop()
			t.Fatal("an unregistered charge point was allowed to connect")
		}
	}
	liste := s.KlopfenAn(time.Now(), alleAdressen)
	if len(liste) != 1 || liste[0].ID != "SAEULE1" || liste[0].Attempts != 2 || liste[0].IP != "127.0.0.1" {
		t.Fatalf("knocking: %+v", liste)
	}
	if len(s.Snapshot().Chargers) != 1 {
		t.Fatal("a knock is no admission")
	}
	// The same check the box runs before it sends (loopback is no LAN address).
	if err := geraetesuche.PruefeKlopftAn(s.KlopfenAn(time.Now(), func(a netip.Addr) bool {
		return geraetesuche.KlopftAnAdresse(a.String(), nil)
	}), nil); err != nil {
		t.Fatal(err)
	}
}
