package csms

import (
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppcontrol"
	"testing"
	"time"
)

func TestPhaseChangeRequiresIdleStationsAndEveryNewSafetyProfile(t *testing.T) {
	now := time.Now().UTC()
	s := recoveryServer(t, t.TempDir(), now)
	p := ocppcontrol.Policy{Revision: 1, Authorization: ocppcontrol.Authorization{Mode: "free"}, PhaseLimitsA: []float64{32, 32, 32},
		Electrical: []ocppcontrol.Electrical{{ChargePointID: "CP", ConnectorID: 1, VoltageV: 253, Phases: []int{1}, MaxCurrentA: 32}}}
	if err := s.SetControlPolicy(p); err == nil {
		t.Fatal("offline phase change accepted")
	}
	if s.ControlPolicy().Revision != 0 {
		t.Fatal("rejected policy became active")
	}
	s.onConnect("CP")
	s.onStatus("CP", 1, StatusAvailable, "NoError", now)
	if err := s.SetControlPolicy(p); err != nil {
		t.Fatal(err)
	}
	if s.startReady("CP") {
		t.Fatal("starts unlocked before profiles accepted")
	}
	max, fallback := 7.0, 1.0
	s.recordCommission("CP", &max, &fallback, nil)
	if !s.startReady("CP") {
		t.Fatal("confirmed policy remains blocked")
	}
	s.onBoot("CP", bootInfo{}, now.Add(time.Second))
	if s.startReady("CP") {
		t.Fatal("previous boot proof reused")
	}
	p.Revision++
	p.PhaseLimitsA[0] = 16
	s.onStatus("CP", 1, StatusCharging, "NoError", now)
	if err := s.SetControlPolicy(p); err == nil {
		t.Fatal("phase change while charging accepted")
	}
}

func TestClosedStartCannotResurrectAndOldMismatchCannotUndoNewEvidence(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	dir := t.TempDir()
	s := recoveryServer(t, dir, now)
	id := s.onStartTransaction("CP", 1, "card", 10, now)
	kw := 5.0
	s.onMeterSample("CP", 1, MeterReading{PowerKw: &kw}, now.Add(2*time.Second), now.Add(2*time.Second), &id)
	wrong := id + 1
	s.onMeterSample("CP", 1, MeterReading{PowerKw: &kw}, now.Add(time.Second), now.Add(2*time.Second), &wrong)
	c, _ := s.Snapshot().ChargerByID("CP")
	if c.Connectors[0].Session.Reconciling {
		t.Fatal("older mismatch poisoned fresh evidence")
	}
	s.onStopTransaction("CP", id, now.Add(3*time.Second))
	s = recoveryServer(t, dir, now)
	if duplicate := s.onStartTransaction("CP", 1, "card", 10, now); duplicate != 0 {
		t.Fatal("closed Start replay resurrected transaction")
	}
	if next := s.onStartTransaction("CP", 1, "card", 11, now.Add(4*time.Second)); next <= id {
		t.Fatal("new transaction was not assigned a new ID")
	}
}

func TestRegulationProofNeedsAllMeasuredStepsAndSameSession(t *testing.T) {
	for _, variant := range []string{"complete", "accepted-only", "missing-readback", "other-transaction", "other-firmware", "old-sample", "cancelled"} {
		t.Run(variant, func(t *testing.T) {
			now := time.Now().UTC().Truncate(time.Second)
			s := recoveryServer(t, t.TempDir(), now)
			id := s.onStartTransaction("CP", 1, "card", 0, now)
			s.onBoot("CP", bootInfo{Vendor: "Test", Model: "AC", Firmware: "1"}, now)
			baseline := 7.0
			s.onMeterSample("CP", 1, MeterReading{PowerKw: &baseline}, now, now, &id)
			p := ocppcontrol.Policy{Revision: 1, Authorization: ocppcontrol.Authorization{Mode: "free"}, Test: &ocppcontrol.TestRequest{ChargePointID: "CP", ConnectorID: 1, LimitKw: 2, RequestedAt: now}}
			if err := s.SetControlPolicy(p); err != nil {
				t.Fatal(err)
			}
			for step, power := range []float64{2, 0, 2} {
				at := now.Add(time.Duration(step)*time.Minute + 10*time.Second)
				con := s.chargers["CP"].connector(1)
				con.CommandStatus, con.Readback = "Accepted", ReadbackOK
				con.CommandedKw, con.PowerKw = &power, &power
				con.CommandedAt, con.CommandedChangedAt, con.ReadbackAt, con.MeteredAt = at, at, at, at
				if variant == "accepted-only" {
					con.PowerKw = &baseline
				}
				if variant == "missing-readback" {
					con.Readback = ReadbackUnknown
				}
				if variant == "other-transaction" {
					con.Session.TransactionID = id + 1
				}
				if variant == "other-firmware" {
					s.chargers["CP"].Firmware = "different"
				}
				if variant == "old-sample" {
					con.MeteredAt = now.Add(-time.Hour)
				}
				s.ControlStatus(variant != "cancelled", at)
			}
			result := s.ControlStatus(true, now.Add(3*time.Minute)).Test
			want := "not_confirmed"
			if variant == "complete" {
				want = "confirmed"
			}
			if variant == "cancelled" {
				want = "cancelled"
			}
			if result.State != want {
				t.Fatalf("got %+v, want %s", result, want)
			}
			restored := recoveryServer(t, s.opts.DataDir, now)
			if restored.ControlStatus(true, now.Add(4*time.Minute)).Test.State != want {
				t.Fatal("result did not survive restart")
			}
		})
	}
}
