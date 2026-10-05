package csms

import (
	"testing"
	"time"

	"github.com/lorenzodonini/ocpp-go/ws"
)

type fakeChannel struct{ ws.Channel }

func (fakeChannel) ID() string { return "WB-RAW" }

// A real 2.0.1 station answers GetCompositeSchedule in the final schema
// (schedule.scheduleStart / chargingRateUnit / chargingSchedulePeriod); the
// library only knows the draft shape and drops it. The lane's tap keeps it.
func TestFinalSchemaCompositeScheduleIsReadFromTheRawFrame(t *testing.T) {
	frame := []byte(`[3,"m-17",{"status":"Accepted","schedule":{"evseId":1,"duration":120,` +
		`"scheduleStart":"2026-10-02T10:00:00Z","chargingRateUnit":"W",` +
		`"chargingSchedulePeriod":[{"startPeriod":0,"limit":7400},{"startPeriod":60,"limit":3000}]}}]`)
	tr := &transport201{composite: map[string]compositeSchedule201{}}
	tap := &scheduleTap201{protocolLane: &protocolLane{}, t: tr}
	passed := false
	tap.SetMessageHandler(func(ws.Channel, []byte) error { passed = true; return nil })
	if err := tap.protocolLane.handlers().message(fakeChannel{}, frame); err != nil || !passed {
		t.Fatalf("the frame must still reach the library: %v %v", err, passed)
	}
	cs, ok := tr.composite["WB-RAW"]
	if !ok || cs.ChargingRateUnit != "W" || cs.EvseID != 1 || len(cs.ChargingSchedulePeriod) != 2 ||
		cs.ChargingSchedulePeriod[0].Limit != 7400 || cs.ScheduleStart == nil {
		t.Fatalf("tapped schedule = %+v (%v)", cs, ok)
	}

	// Draft shape, a CALL, and an answer without a schedule are left alone.
	for _, other := range []string{
		`[3,"m-18",{"status":"Accepted","schedule":{"startDateTime":"2026-10-02T10:00:00Z","chargingSchedule":{"id":0,"chargingRateUnit":"W","chargingSchedulePeriod":[{"startPeriod":0,"limit":1}]}}}]`,
		`[2,"m-19","NotifyEVChargingSchedule",{"scheduleStart":"x"}]`,
		`[3,"m-20",{"status":"Rejected"}]`,
	} {
		if _, ok := parseComposite201([]byte(other)); ok {
			t.Fatalf("parsed as a final-schema schedule: %s", other)
		}
	}
}

func TestEvery16GuardKeyHasA201Variable(t *testing.T) {
	for _, k := range append(CapabilityKeys()[:3], KeyMeterValueSampleInterval, "AllowOfflineTxForUnknownId",
		"AuthorizationCacheEnabled", "LocalPreAuthorize", "LocalAuthorizeOffline", "LocalAuthListEnabled",
		"StopTransactionOnInvalidId", "MaxEnergyOnInvalidId", "AuthorizeRemoteTxRequests") {
		if Config201Variable(k) == "" {
			t.Fatalf("%s has no Device Model variable", k)
		}
	}
	if Config201Variable(KeyMaxProfilesInstalled) != "" {
		t.Fatal("MaxChargingProfilesInstalled is a characteristic in 2.0.1, not a readable variable")
	}
	if purpose201(PurposeMax) != "ChargingStationMaxProfile" || purpose201(PurposeTxDefault) != "TxDefaultProfile" {
		t.Fatal("purpose mapping")
	}
}

// The 2.0.1 twin of TestTheWireScheduleStartsInThePastAndEndsOnTime: toProfile201
// carries the same lead as toOcppProfile - start profileStartLead in the past,
// end where the builder said, a permanent profile stays permanent.
func TestThe201WireScheduleStartsInThePastAndEndsOnTime(t *testing.T) {
	s := &Server{chargers: map[string]*ChargerState{"A": {
		Charger: Charger{ID: "A"},
		Connectors: []Connector{{ID: 1, Session: &Session{TransactionID: 4711,
			StationTransactionID: "st-4711"}}},
	}}}
	tr := &transport201{srv: s}
	wire, err := tr.toProfile201("A", 1, TxProfile(1, 4711, 41, pt0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if wire.TransactionID != "st-4711" || len(wire.ChargingSchedule) != 1 {
		t.Fatalf("wire profile = %+v", wire)
	}
	sch := wire.ChargingSchedule[0]
	if sch.StartSchedule == nil || !sch.StartSchedule.Time.Equal(pt0.Add(-profileStartLead)) {
		t.Fatalf("the schedule must start %v before now: %+v", profileStartLead, sch.StartSchedule)
	}
	if sch.Duration == nil {
		t.Fatal("the live profile must carry its duration")
	}
	end := sch.StartSchedule.Time.Add(time.Duration(*sch.Duration) * time.Second)
	if !end.Equal(pt0.Add(TxProfileDuration)) {
		t.Fatalf("the live limit ends at %v, want %v", end, pt0.Add(TxProfileDuration))
	}
	perm, err := tr.toProfile201("A", 0, MaxProfile(240, pt0))
	if err != nil {
		t.Fatal(err)
	}
	if d := perm.ChargingSchedule[0].Duration; d != nil {
		t.Fatalf("a permanent profile stays permanent: %v", *d)
	}
}
