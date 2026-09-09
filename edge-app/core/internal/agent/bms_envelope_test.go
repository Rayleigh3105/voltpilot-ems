package agent

// P5c: die BMS-Huelle des Schutz-/Grenzbausteins erreicht den WAECHTER.
//
// Die Grenzen entstehen auf der BATTERIE (vp-limit-guard veroeffentlicht
// charge_limit_a / discharge_limit_a / charge_allowed / discharge_allowed),
// der Sollwert geht an den SPEICHER-Knoten - auf einer Hybrid-Anlage sind das
// zwei verschiedene Entitaeten. Die SPEISER-BINDUNG (P6) ist das Band dazwischen:
// sie schreibt fuer genau diese Kanaele eine Rollen-Zuordnung `storage` auf die
// Batterie, und der Registry-Push traegt sie zur Box.
//
// Diese Datei faehrt genau diese Strecke: Telemetrie der Batterie -> Rollen-
// Zuordnung -> guards.Limits des Wechselrichters. Und sie beweist die
// Ehrlichkeitsregeln daran: Schweigen ist keine Sperre, eine alte Grenze ist
// keine Grenze, und ohne gemessene Packspannung gibt es keine Strom-Kappe.

import (
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/topology"
)

const (
	envBatteryID  = "diybms-176s"
	envInverterID = "deye-hp3"
)

// boundBatteryRegistry is the P6 shape: a self-connected battery that feeds the
// storage node of a hybrid inverter.
func boundBatteryRegistry() entities.Registry {
	assigned := make([]entities.RoleAssignment, 0, 4)
	for _, ch := range []string{chargeLimitChannel, dischargeLimitChannel,
		chargeAllowedChannel, dischargeAllowedChannel} {
		assigned = append(assigned, entities.RoleAssignment{
			Channel: ch, Role: topology.RoleStorage, Primary: true})
	}
	return entities.Registry{Entities: []entities.Entity{
		{ID: envInverterID, Type: entities.TypeBatteryHybrid, Label: "Deye HP3"},
		{ID: envBatteryID, Type: "user-defined-battery", Label: "DIYBMS 176s",
			RoleAssignment: assigned},
	}}
}

func withBatteryReading(a *Agent, channels map[string]float64, age time.Duration) {
	a.entMu.Lock()
	defer a.entMu.Unlock()
	if a.entReadings == nil {
		a.entReadings = map[string]entReading{}
	}
	now := time.Now()
	a.entReadings[envBatteryID] = entReading{
		channels: channels, ts: now.Add(-age), recv: now.Add(-age)}
}

// TestBoundBatteryLimitsReachTheInverterGuard is the whole point of P5c: the
// protection block publishes on the BATTERY, and the cap binds the setpoint of
// the INVERTER - because the Speiser-Bindung said the two belong together.
func TestBoundBatteryLimitsReachTheInverterGuard(t *testing.T) {
	a := newGateTestAgent(t)
	a.applyEntityRegistry(boundBatteryRegistry())
	withBatteryReading(a, map[string]float64{
		chargeLimitChannel:      22,
		dischargeLimitChannel:   342,
		chargeAllowedChannel:    1,
		dischargeAllowedChannel: 1,
		packVoltageChannel:      560,
	}, 0)

	env := a.bmsEnvelope(envInverterID)
	if env == nil {
		t.Fatal("die gebundene Batterie speist ihre Grenzen NICHT in den Speicher-Knoten")
	}
	// 22 A x 560 V = 12,32 kW - dieselbe Rechnung wie in den geteilten Vektoren.
	if math.Abs(env.ChargeKw-12.32) > 1e-9 {
		t.Fatalf("Ladegrenze = %v kW, want 12.32", env.ChargeKw)
	}
	if math.Abs(env.DischargeKw-191.52) > 1e-9 {
		t.Fatalf("Entladegrenze = %v kW, want 191.52", env.DischargeKw)
	}
	if env.ChargeBlocked || env.DischargeBlocked {
		t.Fatalf("keine Richtung ist gesperrt, aber %+v sagt etwas anderes", *env)
	}
}

// TestBlockedDirectionArrivesAsABlock: eine 0 in einem Freigabe-Kanal ist eine
// AUSSAGE und wird als Sperre weitergereicht - beide Richtungen getrennt.
func TestBlockedDirectionArrivesAsABlock(t *testing.T) {
	a := newGateTestAgent(t)
	a.applyEntityRegistry(boundBatteryRegistry())
	withBatteryReading(a, map[string]float64{
		chargeLimitChannel:      0,
		chargeAllowedChannel:    0,
		dischargeAllowedChannel: 1,
		packVoltageChannel:      560,
	}, 0)

	env := a.bmsEnvelope(envInverterID)
	if env == nil || !env.ChargeBlocked {
		t.Fatalf("charge_allowed = 0 muss als Sperre ankommen, got %+v", env)
	}
	if env.DischargeBlocked {
		t.Fatal("eine Lade-Sperre darf die Entlade-Seite nicht anfassen")
	}
	if env.ChargeKw != 0 {
		t.Fatalf("0 A sind 0 kW, got %v", env.ChargeKw)
	}
}

// TestSilenceIsNotAProhibition: die zentrale Ehrlichkeitsregel dieses Pakets.
// Ein Schweigen - keine Batterie, keine Telemetrie, eine ALTE Telemetrie, oder
// eine Batterie ohne Schutzbaustein - ergibt KEINE Huelle. Eine 0 daraus zu
// machen hiesse, jede Anlage stillzulegen, die nie eine hatte.
func TestSilenceIsNotAProhibition(t *testing.T) {
	t.Run("keine Entitaeten", func(t *testing.T) {
		a := newGateTestAgent(t)
		if env := a.bmsEnvelope(envInverterID); env != nil {
			t.Fatalf("ohne Registry darf es keine Huelle geben, got %+v", env)
		}
	})

	t.Run("gebunden, aber noch nie gemeldet", func(t *testing.T) {
		a := newGateTestAgent(t)
		a.applyEntityRegistry(boundBatteryRegistry())
		if env := a.bmsEnvelope(envInverterID); env != nil {
			t.Fatalf("ohne Telemetrie darf es keine Huelle geben, got %+v", env)
		}
	})

	t.Run("Telemetrie ohne Schutz-Kanaele", func(t *testing.T) {
		a := newGateTestAgent(t)
		a.applyEntityRegistry(boundBatteryRegistry())
		withBatteryReading(a, map[string]float64{
			"soc_pct": 50, "cell_min_mv": 3600, packVoltageChannel: 560}, 0)
		if env := a.bmsEnvelope(envInverterID); env != nil {
			t.Fatalf("eine Batterie ohne Schutzbaustein sagt nichts, got %+v", env)
		}
	})

	t.Run("zu alte Meldung", func(t *testing.T) {
		a := newGateTestAgent(t)
		a.applyEntityRegistry(boundBatteryRegistry())
		withBatteryReading(a, map[string]float64{
			chargeLimitChannel: 22, chargeAllowedChannel: 1, packVoltageChannel: 560,
		}, bmsEnvelopeWindow+time.Second)
		if env := a.bmsEnvelope(envInverterID); env != nil {
			t.Fatalf("eine Grenze, die niemand mehr wiederholt, gilt nicht mehr: %+v", env)
		}
	})
}

// TestAmpereLimitNeedsAMeasuredPackVoltage: ohne gemessene Packspannung gibt es
// KEINE Strom-Kappe (eine geratene Nennspannung waere eine erfundene
// Leistungsgrenze) - die Freigabe-Flags binden trotzdem weiter.
func TestAmpereLimitNeedsAMeasuredPackVoltage(t *testing.T) {
	a := newGateTestAgent(t)
	a.applyEntityRegistry(boundBatteryRegistry())
	withBatteryReading(a, map[string]float64{
		chargeLimitChannel:      22,
		chargeAllowedChannel:    1,
		dischargeAllowedChannel: 0,
	}, 0)

	env := a.bmsEnvelope(envInverterID)
	if env == nil {
		t.Fatal("die Freigaben allein sind schon eine Aussage")
	}
	if !math.IsNaN(env.ChargeKw) {
		t.Fatalf("ohne Packspannung darf keine Leistungsgrenze entstehen, got %v", env.ChargeKw)
	}
	if !env.DischargeBlocked {
		t.Fatal("die Entlade-Sperre gilt auch ohne Packspannung")
	}
}

// TestStandaloneBatterySpeaksForItself: der eigenstaendige Fall (P6
// `standalone`) braucht keine Bindung - die kommandierte Entitaet IST die
// Batterie und liefert ihre Grenzen selbst.
func TestStandaloneBatterySpeaksForItself(t *testing.T) {
	a := newGateTestAgent(t)
	a.applyEntityRegistry(entities.Registry{Entities: []entities.Entity{
		{ID: envBatteryID, Type: "user-defined-battery", Label: "DIYBMS 176s"},
	}})
	withBatteryReading(a, map[string]float64{
		chargeLimitChannel: 22, packVoltageChannel: 560}, 0)

	env := a.bmsEnvelope(envBatteryID)
	if env == nil || math.Abs(env.ChargeKw-12.32) > 1e-9 {
		t.Fatalf("die eigenstaendige Batterie muss fuer sich selbst sprechen, got %+v", env)
	}
}
