package csms

import (
	"fmt"
	"math"
	"time"
)

// This file is the PURE half of the OCPP Smart-Charging side: it BUILDS the
// three charging profiles the load management needs and interprets the
// capability keys a station reports. No ocpp-go import — the wire mapping
// lives in ocppmap.go, so every rule here is provable without a station.
//
// THE DEAD MAN'S SWITCH (Konzept §3.1) is the whole design, and it is OCPP's
// own, not an invention of ours:
//
//	ChargePointMaxProfile  — a permanent hard cap for the whole station
//	TxDefaultProfile       — a permanent, SAFE per-connector default
//	TxProfile              — the LIVE allocation, with a SHORT duration,
//	                         refreshed every few seconds
//
// If the box dies, the TxProfile expires ON THE STATION and it falls back to
// the TxDefaultProfile all by itself. Nothing of ours has to work for that —
// which is exactly why the fallback must be the OCPP mechanism and not a
// watchdog we write.

// Charging-profile purposes (OCPP 1.6 vocabulary, verbatim).
const (
	PurposeMax       = "ChargePointMaxProfile"
	PurposeTxDefault = "TxDefaultProfile"
	PurposeTx        = "TxProfile"
)

// Profile ids. They must be unique PER STATION (a SetChargingProfile carrying
// a known id REPLACES that profile), so the live per-connector profile derives
// its id from the connector.
const (
	ProfileIDMax       = 1
	ProfileIDTxDefault = 2
	profileIDTxBase    = 10
)

// TxProfileID is the live profile's id for one connector.
func TxProfileID(connectorID int) int { return profileIDTxBase + connectorID }

// TxProfileDuration is how long a live allocation stays valid on the station
// without a refresh. It is the LENGTH OF THE FUSE: too short and a lost packet
// throttles a customer's car, too long and a dead box keeps a big allocation
// standing. 120 s against the ~15-30 s refresh cadence gives four missed
// refreshes of head room.
const TxProfileDuration = 120 * time.Second

// ChargingProfile is one profile in plain types.
type ChargingProfile struct {
	ID         int
	StackLevel int
	Purpose    string
	// TransactionID binds a TxProfile to the running transaction (0 = none).
	TransactionID int
	// LimitKw is the ceiling. 0 is a LEGITIMATE value and means "do not
	// charge" — that is how a pause is expressed in OCPP, and it is why a
	// paused connector still gets a profile instead of losing its limit.
	LimitKw float64
	// Duration bounds the profile's validity. 0 = permanent (Max/TxDefault).
	Duration time.Duration
	// StartsAt anchors the schedule.
	StartsAt time.Time
}

// MaxProfile is the permanent whole-station cap. It rides connector 0 by
// contract and is the outermost bound: whatever else goes wrong in the stack
// below it, the station may not exceed this.
func MaxProfile(limitKw float64, now time.Time) ChargingProfile {
	return ChargingProfile{
		ID: ProfileIDMax, StackLevel: 0, Purpose: PurposeMax,
		LimitKw: nonNegative(limitKw), StartsAt: now.UTC(),
	}
}

// DefaultProfile is the permanent SAFE per-connector default — the value a
// station falls back to when we go silent. It rides connector 0 so it applies
// to every connector of the station.
func DefaultProfile(limitKw float64, now time.Time) ChargingProfile {
	return ChargingProfile{
		ID: ProfileIDTxDefault, StackLevel: 0, Purpose: PurposeTxDefault,
		LimitKw: nonNegative(limitKw), StartsAt: now.UTC(),
	}
}

// TxProfile is the LIVE allocation for one running transaction. Its Duration
// is what makes the whole construction fail-safe.
func TxProfile(connectorID, transactionID int, limitKw float64, now time.Time, d time.Duration) ChargingProfile {
	if d <= 0 {
		d = TxProfileDuration
	}
	return ChargingProfile{
		ID: TxProfileID(connectorID), StackLevel: 0, Purpose: PurposeTx,
		TransactionID: transactionID, LimitKw: nonNegative(limitKw),
		Duration: d, StartsAt: now.UTC(),
	}
}

// SameAs reports whether two profiles command the same thing. Used to skip a
// pointless rewrite — a station's profile store is not free to hammer (the
// Deye EEPROM lesson generalised). The START TIME is deliberately excluded:
// every refresh carries a new one and would otherwise always look different.
func (p ChargingProfile) SameAs(o ChargingProfile) bool {
	return p.ID == o.ID && p.StackLevel == o.StackLevel && p.Purpose == o.Purpose &&
		p.TransactionID == o.TransactionID && p.Duration == o.Duration &&
		math.Abs(p.LimitKw-o.LimitKw) < 1e-6
}

func nonNegative(v float64) float64 {
	if math.IsNaN(v) || v < 0 {
		return 0
	}
	return v
}

// --- capability keys (GetConfiguration) ---

// Configuration keys we read before commanding anything. Reading them is the
// difference between adapting to a station and ASSUMING what it can do — the
// Deye "FC6 wird angenommen, aber nicht übernommen" lesson, applied before the
// first write rather than after the first surprise.
const (
	KeyAllowedChargingRateUnit  = "ChargingScheduleAllowedChargingRateUnit"
	KeyMaxStackLevel            = "ChargeProfileMaxStackLevel"
	KeyMaxPeriods               = "ChargingScheduleMaxPeriods"
	KeyMaxProfilesInstalled     = "MaxChargingProfilesInstalled"
	KeyMeterValueSampleInterval = "MeterValueSampleInterval"
	KeyMeterValuesSampledData   = "MeterValuesSampledData"
)

// CapabilityKeys is the narrow safety basis used before any charging profile
// is installed. Some deployed OCPP 1.6 stations reject an empty/full
// GetConfiguration request even though they answer a targeted key list.
func CapabilityKeys() []string {
	return []string{KeyAllowedChargingRateUnit, KeyMaxStackLevel,
		KeyMaxPeriods, KeyMaxProfilesInstalled}
}

// InventoryKeys is a separate best-effort full GetConfiguration (empty list =
// all keys in OCPP 1.6). Its wire result feeds Slice 10's complete readonly /
// unknownKey / SupportedFeatureProfiles / vendor-key inventory, but it is never
// load-bearing for the safety profiles above.
func InventoryKeys() []string { return []string{} }

// Capabilities is what a station said about its Smart-Charging support.
type Capabilities struct {
	// Read is false until a GetConfiguration answered. Everything below is
	// then meaningless and Note says why — an UNREAD capability is not an
	// absent one.
	Read bool   `json:"read"`
	Note string `json:"note,omitempty"`
	// WattsAllowed reports whether the station accepts limits in W.
	WattsAllowed bool `json:"watts_allowed"`
	// AmpsAllowed reports whether it accepts limits in A.
	AmpsAllowed bool `json:"amps_allowed"`
	// MaxStackLevel / MaxPeriods / MaxProfiles are 0 when the station did not
	// report the key (it is optional).
	MaxStackLevel int `json:"max_stack_level,omitempty"`
	MaxPeriods    int `json:"max_periods,omitempty"`
	MaxProfiles   int `json:"max_profiles,omitempty"`
	// Unknown lists keys the station said it does not know. Kept because
	// "the key is unknown" and "the key is missing from the answer" are
	// different facts about a firmware.
	Unknown []string `json:"unknown,omitempty"`
}

// Usable reports whether we may command this station at all, with the reason
// when not.
//
// ⚠ W-ONLY IN THIS INCREMENT, and the refusal is deliberate. Converting a kW
// allocation into amperes needs the connector's voltage AND its phase count,
// neither of which OCPP tells us. Guessing them is precisely how a load
// manager overshoots a connection — so an A-only station is NAMED as
// unsupported and gets NO profile, rather than a limit derived from a guess.
// Ampere support with an operator-declared voltage/phase count is the first
// follow-up (and a bench item per station type).
func (c Capabilities) Usable() (bool, string) {
	if !c.Read {
		return false, "Die Ladesäule hat ihre Smart-Charging-Fähigkeiten noch nicht gemeldet."
	}
	if c.WattsAllowed {
		return true, ""
	}
	if c.AmpsAllowed {
		return false, "Diese Ladesäule nimmt Ladegrenzen nur in Ampere entgegen. VoltPilot rechnet in kW und müsste Spannung und Phasenzahl raten — deshalb wird hier nichts vorgegeben."
	}
	return false, "Diese Ladesäule hat keine unterstützte Einheit für Ladegrenzen gemeldet."
}

// ParseCapabilities reads the GetConfiguration answer.
//
// ⚠ A MISSING ChargingScheduleAllowedChargingRateUnit is read as "W allowed".
// The key is OPTIONAL in OCPP 1.6 and plenty of firmware omits it while
// happily taking watt limits; treating the omission as "cannot" would make
// the feature refuse most of the field. The station's own SetChargingProfile
// answer stays the real verdict — it is the one that can say NotSupported,
// and that answer is recorded per connector.
func ParseCapabilities(values map[string]string, unknown []string) Capabilities {
	c := Capabilities{Read: true, Unknown: unknown}
	unit, ok := values[KeyAllowedChargingRateUnit]
	if !ok || trimEmpty(unit) {
		c.WattsAllowed = true
	} else {
		for _, u := range splitList(unit) {
			switch u {
			case "W", "Power", "power":
				c.WattsAllowed = true
			case "A", "Current", "current":
				c.AmpsAllowed = true
			}
		}
	}
	c.MaxStackLevel = atoiOr0(values[KeyMaxStackLevel])
	c.MaxPeriods = atoiOr0(values[KeyMaxPeriods])
	c.MaxProfiles = atoiOr0(values[KeyMaxProfilesInstalled])
	return c
}

// CompositeSchedule is a GetCompositeSchedule answer in plain types: what the
// station says it will ACTUALLY do, its own resolution of every profile in
// its stack. It is the readback — the D3 evidence ladder's middle rung
// (measured > read back > assumed).
type CompositeSchedule struct {
	// Accepted is false when the station refused to report (it is allowed to).
	Accepted bool `json:"accepted"`
	// LimitKw is the limit of the FIRST schedule period, i.e. what applies
	// now. nil = the station reported no schedule, which is not a limit of 0.
	LimitKw   *float64  `json:"limit_kw,omitempty"`
	StartsAt  time.Time `json:"starts_at,omitzero"`
	Connector int       `json:"connector"`
}

// ReadbackVerdict compares a commanded limit against what the station reports.
//
// Three answers, because they cause three different actions (the
// `target_verdict`-next-to-`state` discipline):
//
//	ok         — the station reports the value we commanded
//	abweichend — it reports a DIFFERENT value: our command is not in force
//	unbekannt  — it reported nothing usable; SILENCE IS NOT AGREEMENT
//	             (the PR-280 lesson, applied to OCPP)
const (
	ReadbackOK       = "ok"
	ReadbackMismatch = "abweichend"
	ReadbackUnknown  = "unbekannt"
)

// CompareReadback judges a readback against the commanded limit. tolerance is
// absolute kW; a station rounding to whole watts must not read as a mismatch.
func CompareReadback(commandedKw float64, cs CompositeSchedule, toleranceKw float64) (string, string) {
	if toleranceKw <= 0 {
		toleranceKw = 0.05
	}
	if !cs.Accepted {
		return ReadbackUnknown, "Die Ladesäule konnte ihren aktuellen Ladeplan nicht melden."
	}
	if cs.LimitKw == nil {
		return ReadbackUnknown, "Die Ladesäule hat keinen aktuellen Ladeplan gemeldet."
	}
	if math.Abs(*cs.LimitKw-commandedKw) <= toleranceKw {
		return ReadbackOK, ""
	}
	return ReadbackMismatch, fmt.Sprintf("Vorgegeben %.1f kW, die Ladesäule meldet %.1f kW.", commandedKw, *cs.LimitKw)
}

// --- small helpers, kept here so the parser has no other dependency ---

func trimEmpty(s string) bool {
	for _, r := range s {
		if r != ' ' && r != '\t' {
			return false
		}
	}
	return true
}

func splitList(s string) []string {
	var out []string
	cur := ""
	flush := func() {
		for len(cur) > 0 && (cur[0] == ' ' || cur[0] == '\t') {
			cur = cur[1:]
		}
		for len(cur) > 0 && (cur[len(cur)-1] == ' ' || cur[len(cur)-1] == '\t') {
			cur = cur[:len(cur)-1]
		}
		if cur != "" {
			out = append(out, cur)
		}
		cur = ""
	}
	for _, r := range s {
		if r == ',' || r == ';' {
			flush()
			continue
		}
		cur += string(r)
	}
	flush()
	return out
}

func atoiOr0(s string) int {
	n := 0
	seen := false
	for _, r := range s {
		if r < '0' || r > '9' {
			if seen {
				break
			}
			continue
		}
		seen = true
		n = n*10 + int(r-'0')
		if n > 1_000_000 {
			return 1_000_000
		}
	}
	return n
}
