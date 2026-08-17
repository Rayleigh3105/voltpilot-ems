package agent

// „Grenzen & Wächter" Stufe 0 / Vierer #4, agent half: the DEVICE'S OWN feed-in
// limit is decoded out of the raw register bytes the poll already publishes, and
// reported with its own read timestamp.
//
// What this file protects is the honesty of a customer sentence ("Ihr
// Wechselrichter begrenzt die Einspeisung am Netzpunkt auf 33 kW") plus the ONE
// SOCKET LAW: this path must never dial anything - it only reads bytes that were
// already on the local bus.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/mirror"
)

// selectDeyeFamily points the agent at a Deye MODEL of the given register-map
// family, the way the operator's inverter selection does. (selectDeye in
// calibration_test.go picks the pilot hybrid_3p; this file needs hybrid_1p too,
// because the honesty rule lives exactly there.)
func selectDeyeFamily(t *testing.T, a *Agent, model string) {
	t.Helper()
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand: inverter.BrandDeye, Model: model,
		Connection: inverter.Connection{IP: "192.168.0.28", Serial: "2985159064"},
	}); err != nil {
		t.Fatalf("SetInverter: %v", err)
	}
}

// The pilot models per family - hybrid_3p is the Herzogau/Pilsting SUN-30K.
const (
	modelHybrid3p = "sun-30k-sg01hp3"
	modelHybrid1p = "sun-8k-sg03lp1"
)

// rawBlocks is the payload shape of edge/registers/raw.
func rawBlocks(ts time.Time, unit int, blocks []mirror.RawBlock) []byte {
	raw, _ := json.Marshal(map[string]any{
		"ts":     ts.Format(time.RFC3339Nano),
		"unit":   unit,
		"blocks": blocks,
	})
	return raw
}

// The Herzogau reading, end to end through the REAL bus handler: the poll
// appends 0x00E7 to its plan once a day, the word arrives inside the retained
// raw message, and the box reports 33,0 kW with the register it came from.
func TestTheDeviceExportLimitIsDecodedFromTheRawRegisterMessage(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeyeFamily(t, a, modelHybrid3p)

	read := time.Now().UTC().Truncate(time.Second)
	a.onRegistersRaw(localbus.TopicRegistersRaw, rawBlocks(read, 1, []mirror.RawBlock{
		{Start: 0x0000, Regs: []uint16{0x0006}},
		{Start: 0x00e7, Regs: []uint16{3300}},
	}))

	d := a.State.Get().DeviceExportLimit
	if d == nil {
		t.Fatal("expected the device's own feed-in limit to be reported")
	}
	if d.LimitKw != 33 {
		t.Fatalf("raw 3300 x scale 10 = 33,0 kW, got %v", d.LimitKw)
	}
	if d.Register != "0x00e7" {
		t.Fatalf("the value must name its register, got %q", d.Register)
	}
	if !d.ReadAt.Equal(read) {
		t.Fatalf("read time must be the POLL time %v, got %v", read, d.ReadAt)
	}

	// It rides the heartbeat next to the watchdog, with its OWN timestamp.
	addFronius(t, a, 1, 27)
	sum := a.curtailmentSummary()
	if sum == nil || sum.DeviceExportLimitKw == nil {
		t.Fatalf("the curtailment block must carry the device limit, got %+v", sum)
	}
	if *sum.DeviceExportLimitKw != 33 || sum.DeviceExportLimitRegister != "0x00e7" {
		t.Fatalf("heartbeat and device page disagree: %+v vs %+v", sum, d)
	}
	if sum.DeviceExportLimitReadAt == "" {
		t.Fatal("the device limit must carry its OWN freshness anchor, never borrow checked_at")
	}
}

// A cycle WITHOUT the register is the normal case (it rides along at most once a
// day) - the previous value must STAY, because "we did not read it now" is not
// "the limit went away".
func TestACycleWithoutTheRegisterKeepsTheLastKnownLimit(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeyeFamily(t, a, modelHybrid3p)

	now := time.Now().UTC()
	a.onRegistersRaw("", rawBlocks(now, 1, []mirror.RawBlock{{Start: 0x00e7, Regs: []uint16{3300}}}))
	// The ordinary measurement cycle: identity + the measurement block only.
	a.onRegistersRaw("", rawBlocks(now.Add(5*time.Second), 1, []mirror.RawBlock{
		{Start: 0x0000, Regs: []uint16{0x0006}},
		{Start: 0x024c, Regs: make([]uint16, 121)},
	}))

	d := a.State.Get().DeviceExportLimit
	if d == nil || d.LimitKw != 33 {
		t.Fatalf("the last known limit must stand, got %+v", d)
	}
	if !d.ReadAt.Equal(now) {
		t.Fatalf("its read time must stay the time it was READ, got %v", d.ReadAt)
	}
}

// The honesty rules, each one its own reason to report NOTHING.
func TestTheDeviceExportLimitStaysSilentWhereItCannotBeTrusted(t *testing.T) {
	now := time.Now().UTC()
	blocks := []mirror.RawBlock{{Start: 0x00e7, Regs: []uint16{3300}}}

	t.Run("a family whose register WE write is never read", func(t *testing.T) {
		cfg := config.Defaults()
		cfg.DataDir = t.TempDir()
		a, _ := startBusOnlyAgent(t, cfg)
		selectDeyeFamily(t, a, modelHybrid1p)
		a.onRegistersRaw("", rawBlocks(now, 1, blocks))
		if d := a.State.Get().DeviceExportLimit; d != nil {
			t.Fatalf("hybrid_1p would report OUR own command as the device limit: %+v", d)
		}
	})

	t.Run("no inverter selected", func(t *testing.T) {
		cfg := config.Defaults()
		cfg.DataDir = t.TempDir()
		a, _ := startBusOnlyAgent(t, cfg)
		a.onRegistersRaw("", rawBlocks(now, 1, blocks))
		if d := a.State.Get().DeviceExportLimit; d != nil {
			t.Fatalf("without a selection there is no register map: %+v", d)
		}
	})

	t.Run("a failed read is not a limit of 0", func(t *testing.T) {
		cfg := config.Defaults()
		cfg.DataDir = t.TempDir()
		a, _ := startBusOnlyAgent(t, cfg)
		selectDeyeFamily(t, a, modelHybrid3p)
		a.onRegistersRaw("", rawBlocks(now, 1, []mirror.RawBlock{
			{Start: 0x00e7, Regs: []uint16{0}, Err: "Modbus-Ausnahme 0x02"},
		}))
		if d := a.State.Get().DeviceExportLimit; d != nil {
			t.Fatalf("a refused read must report nothing: %+v", d)
		}
	})

	t.Run("a block from ANOTHER slave says nothing about our inverter", func(t *testing.T) {
		cfg := config.Defaults()
		cfg.DataDir = t.TempDir()
		a, _ := startBusOnlyAgent(t, cfg)
		selectDeyeFamily(t, a, modelHybrid3p)
		a.onRegistersRaw("", rawBlocks(now, 7, blocks))
		if d := a.State.Get().DeviceExportLimit; d != nil {
			t.Fatalf("unit 7 is not our unit 1: %+v", d)
		}
	})

	t.Run("a block that does not actually cover the register", func(t *testing.T) {
		cfg := config.Defaults()
		cfg.DataDir = t.TempDir()
		a, _ := startBusOnlyAgent(t, cfg)
		selectDeyeFamily(t, a, modelHybrid3p)
		// A block that ENDS one word before it, and an empty block AT it: both
		// must be walked past, never read out of bounds.
		a.onRegistersRaw("", rawBlocks(now, 1, []mirror.RawBlock{
			{Start: 0x00e0, Regs: make([]uint16, 7)},
			{Start: 0x00e7, Regs: nil},
		}))
		if d := a.State.Get().DeviceExportLimit; d != nil {
			t.Fatalf("the register was not in these blocks: %+v", d)
		}
	})

	t.Run("a limit of 0 IS a value, not an absence", func(t *testing.T) {
		cfg := config.Defaults()
		cfg.DataDir = t.TempDir()
		a, _ := startBusOnlyAgent(t, cfg)
		selectDeyeFamily(t, a, modelHybrid3p)
		a.onRegistersRaw("", rawBlocks(now, 1, []mirror.RawBlock{{Start: 0x00e7, Regs: []uint16{0}}}))
		d := a.State.Get().DeviceExportLimit
		if d == nil || d.LimitKw != 0 {
			t.Fatalf("0 kW means 'may not feed in at all' and must be reported: %+v", d)
		}
	})
}

// A box that never read the register sends the curtailment block WITHOUT the
// device-limit fields - so "absent" can only ever mean "not reported", never
// "the device has no limit". This is what keeps the ingest additive.
func TestAHeartbeatWithoutTheReadingOmitsTheDeviceLimitEntirely(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	a, _ := startBusOnlyAgent(t, cfg)
	addFronius(t, a, 1, 27)

	sum := a.curtailmentSummary()
	if sum == nil {
		t.Fatal("a plant with a curtailment unit must still report its block")
	}
	if sum.DeviceExportLimitKw != nil || sum.DeviceExportLimitRegister != "" ||
		sum.DeviceExportLimitReadAt != "" {
		t.Fatalf("nothing was read - nothing may be claimed: %+v", sum)
	}
	raw, err := json.Marshal(sum)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "device_export_limit") {
		t.Fatalf("the fields must be OMITTED on the wire, got %s", raw)
	}
}
