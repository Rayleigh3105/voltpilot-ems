package csms

// The OCPP 2.1 lane of the box's central system (MiSpeL MP-37, Bauplan § 8).
// A station that offers ONLY the websocket subprotocol "ocpp2.1" lands here.
// OCPP 2.1 keeps every 2.0.1 message the box uses (Boot, Status, Authorize,
// TransactionEvent, MeterValues, Device Model, K01-K10), so the lane runs the
// 2.0.1 transport unchanged (ocpp201map.go, ocpp201profiles.go) and adds what
// is new for V2X:
//
//   - the ISO 15118-20 data a station reports in NotifyEVChargingNeeds (2.1
//     shape: requestedEnergyTransfer AC_BPT/DC_BPT, v2xChargingParameters,
//     dcChargingParameters.stateOfCharge, departureTime) become the
//     connector's EVNeeds - telemetry of the plugged vehicle;
//   - a V2X charging profile with operationMode CentralSetpoint and a signed
//     setpoint (negative = discharging, OCPP 2.1 ChargingSchedulePeriodType),
//     sent ONLY when Options.V2XDischarge is on. Nothing in the box's own
//     regulation calls it: discharging with protection limits is MP-39.
//
// ocpp-go knows no 2.1 types, and its 2.0.1 validation would refuse the new
// enum values. The tap below therefore answers the two 2.1 Smart-Charging
// notifications itself and brings 2.1-only trigger reasons into the 2.0.1
// vocabulary before the library parses a TransactionEvent. Field names and
// vocabularies follow the OCPP 2.1 JSON schemas (NotifyEVChargingNeedsRequest,
// SetChargingProfileRequest, TransactionEventRequest). Table:
// docs/edge-ocpp21.md.

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/lorenzodonini/ocpp-go/ocpp"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/smartcharging"
	"github.com/lorenzodonini/ocpp-go/ws"
)

// OCPPVersion21 is ChargerState.OCPPVersion of a station on the 2.1 lane.
const OCPPVersion21 = "2.1"

var (
	// ErrNotOCPP21 refuses a V2X call to a station that is not connected
	// over OCPP 2.1 (1.6 and 2.0.1 have no setpoint and no discharge).
	ErrNotOCPP21 = errors.New("die Ladesäule ist nicht über OCPP 2.1 verbunden")
	// ErrV2XDischargeOff is the switch (Options.V2XDischarge, default off):
	// no V2X profile leaves the box while it is off.
	ErrV2XDischargeOff = errors.New("V2X-Sollwerte sind auf dieser Box ausgeschaltet")
)

// isOCPP2x reports whether a station runs on a 2.x lane (Device Model,
// 2.x charging profiles) rather than on 1.6.
func isOCPP2x(version string) bool {
	return version == OCPPVersion201 || version == OCPPVersion21
}

// lane2x is the 2.x transport of an OCPPVersion.
func (t *transport) lane2x(version string) *transport201 {
	switch version {
	case OCPPVersion201:
		return t.v201
	case OCPPVersion21:
		return t.v21
	}
	return nil
}

func newTransport21(s *Server, lane *protocolLane, stopping func() bool) *transport201 {
	return newTransport2x(s, lane, stopping, OCPPVersion21, func(t *transport201) ws.Server {
		return &v2xTap21{scheduleTap201: scheduleTap201{protocolLane: lane, t: t}}
	})
}

// EVNeeds is what a vehicle told the station over ISO 15118-20 and the
// station reported in NotifyEVChargingNeeds (OCPP 2.1). Every value is as
// reported, converted to the box's units (kW, kWh, %); a value the vehicle
// did not report is nil - unknown, never 0. It describes the plugged
// vehicle NOW (Ist), not the customer's expectation: the vehicle window of
// the MiSpeL charge-point contract (mispel-ladepunkt-bidirektional.md § 5)
// stays the plan, these values are the telemetry next to it.
type EVNeeds struct {
	// ReportedAt is when the box received the report - stale data is not
	// current, the reader judges its age.
	ReportedAt time.Time `json:"reported_at"`
	// EnergyTransfer is requestedEnergyTransfer verbatim (AC_BPT, DC_BPT, ...);
	// Available the availableEnergyTransfer list. Bidirectional is true when
	// the requested mode is a BPT mode (bidirectional power transfer).
	EnergyTransfer string   `json:"energy_transfer"`
	Available      []string `json:"available_energy_transfer,omitempty"`
	Bidirectional  bool     `json:"bidirectional"`
	// ControlMode is ScheduledControl or DynamicControl (ISO 15118-20).
	ControlMode string `json:"control_mode,omitempty"`
	// DepartureAt is departureTime: when the driver wants to leave.
	DepartureAt *time.Time `json:"departure_at,omitempty"`
	// SocPct is dcChargingParameters.stateOfCharge (only DC reports it here;
	// AC vehicles report their SoC as a meter value, Connector.SocPct).
	SocPct *float64 `json:"soc_pct,omitempty"`
	// TargetSocPct is v2xChargingParameters.targetSoC: SoC at departure.
	TargetSocPct *float64 `json:"target_soc_pct,omitempty"`
	// CapacityKwh is dcChargingParameters.evEnergyCapacity.
	CapacityKwh *float64 `json:"capacity_kwh,omitempty"`
	// Energy requests to the target / minimum / maximum SoC
	// (evTargetEnergyRequest, evMinEnergyRequest, evMaxEnergyRequest) and to
	// the minimum / maximum SoC of V2X cycling (evMinV2XEnergyRequest,
	// evMaxV2XEnergyRequest; positive = below that range). AC: energyAmount
	// lands in TargetEnergyKwh when no V2X value is given.
	TargetEnergyKwh *float64 `json:"target_energy_kwh,omitempty"`
	MinEnergyKwh    *float64 `json:"min_energy_kwh,omitempty"`
	MaxEnergyKwh    *float64 `json:"max_energy_kwh,omitempty"`
	MinV2XEnergyKwh *float64 `json:"min_v2x_energy_kwh,omitempty"`
	MaxV2XEnergyKwh *float64 `json:"max_v2x_energy_kwh,omitempty"`
	// Vehicle limits (v2xChargingParameters; DC evMaxPower as fallback for
	// MaxChargeKw). Discharge powers are MAGNITUDES (>= 0, as the schema
	// defines them) - charging and discharging never share one signed field.
	MinChargeKw    *float64 `json:"min_charge_kw,omitempty"`
	MaxChargeKw    *float64 `json:"max_charge_kw,omitempty"`
	MinDischargeKw *float64 `json:"min_discharge_kw,omitempty"`
	MaxDischargeKw *float64 `json:"max_discharge_kw,omitempty"`
}

// V2XSetpoint is the last V2X profile the box sent to a connector and the
// station's answer to it. A setpoint is a request: whether the vehicle
// follows it shows only in the meter values (plan, accepted command,
// register answer and measured effect stay separate).
type V2XSetpoint struct {
	// SetpointKw: positive = charge, negative = discharge (feed back), the
	// sign of the OCPP 2.1 setpoint.
	SetpointKw float64   `json:"setpoint_kw"`
	Status     string    `json:"status"`
	SentAt     time.Time `json:"sent_at"`
}

// --- station -> box: the 2.1 tap ---

// v2xTap21 is the 2.1 lane as the library sees it: the 2.0.1 schedule tap
// plus the frames the library cannot parse in their 2.1 shape.
type v2xTap21 struct {
	scheduleTap201
}

func (l *v2xTap21) SetMessageHandler(handler ws.MessageHandler) {
	l.scheduleTap201.SetMessageHandler(func(c ws.Channel, data []byte) error {
		answer, rewritten, handled := l.t.intercept21(c.ID(), data)
		if handled {
			return l.protocolLane.Write(c.ID(), answer)
		}
		if rewritten != nil {
			data = rewritten
		}
		return handler(c, data)
	})
}

// triggerReasons21 brings the trigger reasons OCPP 2.1 added to
// TriggerReasonEnumType into the 2.0.1 vocabulary the library validates. The
// box decides nothing on triggerReason; without this, the library would
// refuse a whole TransactionEvent (and its meter values) of a V2X session.
var triggerReasons21 = map[string]string{
	"LimitSet":             "ChargingRateChanged",
	"OperationModeChanged": "ChargingRateChanged",
	"SoCLimitReached":      "EnergyLimitReached",
	"CostLimitReached":     "EnergyLimitReached",
	"TxResumed":            "ChargingStateChanged",
	"RunningCost":          "MeterValuePeriodic",
	"TariffChanged":        "Trigger",
	"TariffNotAccepted":    "Trigger",
}

// intercept21 looks at one incoming frame. handled = the box answered it
// itself (answer is the CALLRESULT); rewritten != nil = hand this frame to
// the library instead of the original.
func (t *transport201) intercept21(id string, data []byte) (answer, rewritten []byte, handled bool) {
	if !bytes21(data, `"NotifyEVChargingNeeds"`, `"NotifyEVChargingSchedule"`, `"triggerReason"`) {
		return nil, nil, false
	}
	var frame []json.RawMessage
	if json.Unmarshal(data, &frame) != nil || len(frame) != 4 || string(frame[0]) != "2" {
		return nil, nil, false
	}
	var action string
	if json.Unmarshal(frame[2], &action) != nil {
		return nil, nil, false
	}
	switch action {
	case "NotifyEVChargingNeeds":
		status := t.onEVChargingNeeds21(id, frame[3])
		return callResult(frame[1], map[string]string{"status": status}), nil, true
	case "NotifyEVChargingSchedule":
		// Kenntnisnahme, as on 2.0.1 - but a 2.1 schedule may carry
		// setpoint-only periods the library's 2.0.1 type refuses.
		return callResult(frame[1], map[string]string{"status": "Accepted"}), nil, true
	case "TransactionEvent":
		var payload map[string]json.RawMessage
		if json.Unmarshal(frame[3], &payload) != nil {
			return nil, nil, false
		}
		var reason string
		if json.Unmarshal(payload["triggerReason"], &reason) != nil {
			return nil, nil, false
		}
		mapped, ok := triggerReasons21[reason]
		if !ok {
			return nil, nil, false
		}
		t.srv.log.Debug("OCPP-2.1-Auslöser auf 2.0.1 abgebildet", "charge_point_id", id, "von", reason, "nach", mapped)
		payload["triggerReason"], _ = json.Marshal(mapped)
		frame[3], _ = json.Marshal(payload)
		out, err := json.Marshal(frame)
		if err != nil {
			return nil, nil, false
		}
		return nil, out, false
	}
	return nil, nil, false
}

func bytes21(data []byte, words ...string) bool {
	s := string(data)
	for _, w := range words {
		if strings.Contains(s, w) {
			return true
		}
	}
	return false
}

func callResult(uniqueID json.RawMessage, payload any) []byte {
	p, _ := json.Marshal(payload)
	out, _ := json.Marshal([]json.RawMessage{json.RawMessage("3"), uniqueID, p})
	return out
}

// notifyEVChargingNeeds21 is NotifyEVChargingNeedsRequest in the OCPP 2.1
// JSON schema (only the fields the box keeps). Numbers are pointers: absent
// is unknown, never 0.
type notifyEVChargingNeeds21 struct {
	EvseID        int `json:"evseId"`
	ChargingNeeds struct {
		RequestedEnergyTransfer string   `json:"requestedEnergyTransfer"`
		AvailableEnergyTransfer []string `json:"availableEnergyTransfer"`
		ControlMode             string   `json:"controlMode"`
		DepartureTime           *string  `json:"departureTime"`
		V2X                     *struct {
			MinChargePower        *float64 `json:"minChargePower"`
			MaxChargePower        *float64 `json:"maxChargePower"`
			MinDischargePower     *float64 `json:"minDischargePower"`
			MaxDischargePower     *float64 `json:"maxDischargePower"`
			EVTargetEnergyRequest *float64 `json:"evTargetEnergyRequest"`
			EVMinEnergyRequest    *float64 `json:"evMinEnergyRequest"`
			EVMaxEnergyRequest    *float64 `json:"evMaxEnergyRequest"`
			EVMinV2XEnergyRequest *float64 `json:"evMinV2XEnergyRequest"`
			EVMaxV2XEnergyRequest *float64 `json:"evMaxV2XEnergyRequest"`
			TargetSoC             *float64 `json:"targetSoC"`
		} `json:"v2xChargingParameters"`
		DC *struct {
			EVMaxPower       *float64 `json:"evMaxPower"`
			EVEnergyCapacity *float64 `json:"evEnergyCapacity"`
			EnergyAmount     *float64 `json:"energyAmount"`
			StateOfCharge    *float64 `json:"stateOfCharge"`
		} `json:"dcChargingParameters"`
		AC *struct {
			EnergyAmount *float64 `json:"energyAmount"`
		} `json:"acChargingParameters"`
	} `json:"chargingNeeds"`
}

// NotifyEVChargingNeeds statuses (OCPP 2.1 NotifyEVChargingNeedsStatusEnumType).
const (
	evNeedsNoChargingProfile = "NoChargingProfile"
	evNeedsRejected          = "Rejected"
)

// onEVChargingNeeds21 keeps the report on its connector and answers
// NoChargingProfile: the box takes note and computes no ISO 15118 schedule
// from it in this package; the regular TxProfile of the load management
// still applies as the limit. A report the box cannot read is Rejected.
func (t *transport201) onEVChargingNeeds21(id string, payload json.RawMessage) string {
	var req notifyEVChargingNeeds21
	if json.Unmarshal(payload, &req) != nil || req.EvseID <= 0 || req.ChargingNeeds.RequestedEnergyTransfer == "" {
		return evNeedsRejected
	}
	now := t.srv.opts.Now()
	n := evNeedsFrom21(req, now)
	s := t.srv
	s.mu.Lock()
	c, ok := s.chargers[id]
	if ok {
		c.connector(req.EvseID).EV = &n
	}
	s.mu.Unlock()
	if !ok {
		return evNeedsRejected
	}
	s.notifyChanged()
	return evNeedsNoChargingProfile
}

func evNeedsFrom21(req notifyEVChargingNeeds21, now time.Time) EVNeeds {
	cn := req.ChargingNeeds
	n := EVNeeds{ReportedAt: now.UTC(), EnergyTransfer: cn.RequestedEnergyTransfer,
		Available: cn.AvailableEnergyTransfer, ControlMode: cn.ControlMode,
		Bidirectional: strings.Contains(cn.RequestedEnergyTransfer, "BPT")}
	if cn.DepartureTime != nil {
		if at, err := time.Parse(time.RFC3339, *cn.DepartureTime); err == nil {
			at = at.UTC()
			n.DepartureAt = &at
		}
	}
	if v := cn.V2X; v != nil {
		n.TargetSocPct = clonePtr(v.TargetSoC)
		n.TargetEnergyKwh = kilo(v.EVTargetEnergyRequest)
		n.MinEnergyKwh = kilo(v.EVMinEnergyRequest)
		n.MaxEnergyKwh = kilo(v.EVMaxEnergyRequest)
		n.MinV2XEnergyKwh = kilo(v.EVMinV2XEnergyRequest)
		n.MaxV2XEnergyKwh = kilo(v.EVMaxV2XEnergyRequest)
		n.MinChargeKw = kilo(v.MinChargePower)
		n.MaxChargeKw = kilo(v.MaxChargePower)
		n.MinDischargeKw = kiloAbs(v.MinDischargePower)
		n.MaxDischargeKw = kiloAbs(v.MaxDischargePower)
	}
	if dc := cn.DC; dc != nil {
		n.SocPct = clonePtr(dc.StateOfCharge)
		n.CapacityKwh = kilo(dc.EVEnergyCapacity)
		if n.MaxChargeKw == nil {
			n.MaxChargeKw = kilo(dc.EVMaxPower)
		}
		if n.TargetEnergyKwh == nil {
			n.TargetEnergyKwh = kilo(dc.EnergyAmount)
		}
	}
	if ac := cn.AC; ac != nil && n.TargetEnergyKwh == nil {
		n.TargetEnergyKwh = kilo(ac.EnergyAmount)
	}
	return n
}

func kilo(v *float64) *float64 {
	if v == nil {
		return nil
	}
	k := *v / 1000
	return &k
}

func kiloAbs(v *float64) *float64 {
	if v == nil {
		return nil
	}
	k := math.Abs(*v) / 1000
	return &k
}

// clearEVNeeds drops the vehicle's report when the connector is free again:
// the next vehicle is another one. A no-op on every lane that never stored
// one (1.6, 2.0.1).
func (s *Server) clearEVNeeds(id string, evseID int) {
	s.mu.Lock()
	changed := false
	if c, ok := s.chargers[id]; ok {
		for i := range c.Connectors {
			if c.Connectors[i].ID == evseID && c.Connectors[i].EV != nil {
				c.Connectors[i].EV = nil
				changed = true
			}
		}
	}
	s.mu.Unlock()
	if changed {
		s.notifyChanged()
	}
}

// --- box -> station: the V2X profile (behind the switch) ---

// chargingSchedulePeriod21 is ChargingSchedulePeriodType of OCPP 2.1 with the
// fields the box sends. limit and dischargeLimit bound the overshoot around
// the setpoint (2.1: "the overshoot when following setpoint must remain
// within these values"); dischargeLimit is <= 0 like the setpoint.
type chargingSchedulePeriod21 struct {
	StartPeriod    int     `json:"startPeriod"`
	Limit          float64 `json:"limit"`
	DischargeLimit float64 `json:"dischargeLimit"`
	Setpoint       float64 `json:"setpoint"`
	OperationMode  string  `json:"operationMode"`
}

type chargingSchedule21 struct {
	ID                     int                        `json:"id"`
	StartSchedule          string                     `json:"startSchedule"`
	Duration               int                        `json:"duration"`
	ChargingRateUnit       string                     `json:"chargingRateUnit"`
	ChargingSchedulePeriod []chargingSchedulePeriod21 `json:"chargingSchedulePeriod"`
}

type chargingProfile21 struct {
	ID                     int                  `json:"id"`
	StackLevel             int                  `json:"stackLevel"`
	ChargingProfilePurpose string               `json:"chargingProfilePurpose"`
	ChargingProfileKind    string               `json:"chargingProfileKind"`
	TransactionID          string               `json:"transactionId"`
	ChargingSchedule       []chargingSchedule21 `json:"chargingSchedule"`
}

// setChargingProfile21 is SetChargingProfileRequest in its 2.1 shape. It
// rides the library's own request queue under the 2.0.1 feature name, so
// OCPP-J's one-open-CALL rule holds next to the load management's calls; the
// answer has the same shape in both versions.
type setChargingProfile21 struct {
	EvseID          int               `json:"evseId"`
	ChargingProfile chargingProfile21 `json:"chargingProfile"`
}

func (setChargingProfile21) GetFeatureName() string {
	return smartcharging.SetChargingProfileFeatureName
}

var _ ocpp.Request = setChargingProfile21{}

// operationModeCentralSetpoint: the EV follows the setpoint of the CSMS
// (OCPP 2.1 OperationModeEnumType).
const operationModeCentralSetpoint = "CentralSetpoint"

// SetV2XSetpoint21 sends one V2X TxProfile to a connector of an OCPP 2.1
// station: operationMode CentralSetpoint, setpoint in W with the 2.1 sign
// (negative = discharge), bounded by limit = max(setpoint, 0) and
// dischargeLimit = min(setpoint, 0). It takes the place of the live TxProfile
// (same id, same 120-s fuse, bound to the station's transactionId): when the
// box stops renewing it, the station falls back to the TxDefaultProfile,
// which only charges.
//
// ⚠ Nothing in the box's regulation calls this (MiSpeL MP-37). Discharging
// with protection limits - export limit, § 14a, minimum SoC, the driver's
// consent, abort on unplugging - is MP-39; until then the switch
// Options.V2XDischarge stays off and the call is refused before anything is
// sent.
func (s *Server) SetV2XSetpoint21(ctx context.Context, chargerID string, connector int, setpointKw float64) (V2XSetpoint, error) {
	if !s.opts.V2XDischarge {
		return V2XSetpoint{}, ErrV2XDischargeOff
	}
	if math.IsNaN(setpointKw) || math.IsInf(setpointKw, 0) || connector <= 0 {
		return V2XSetpoint{}, errors.New("V2X-Sollwert ungültig")
	}
	t, version, err := s.liveStation(chargerID)
	if err != nil {
		return V2XSetpoint{}, err
	}
	if version != OCPPVersion21 || t.v21 == nil {
		return V2XSetpoint{}, ErrNotOCPP21
	}
	now := s.opts.Now()
	s.mu.Lock()
	txID := 0
	if c, ok := s.chargers[chargerID]; ok {
		if con := c.ConnectorByID(connector); con != nil && con.Session != nil {
			txID = con.Session.TransactionID
		}
	}
	s.mu.Unlock()
	stationTx, ok := s.stationTransaction201(chargerID, connector, txID)
	if !ok {
		return V2XSetpoint{}, errors.New("V2X-Sollwert nicht gesendet: die Ladesäule hat für diese Sitzung keine Transaktionskennung gemeldet")
	}
	w := setpointKw * 1000
	profileID := TxProfileID(connector)
	req := setChargingProfile21{EvseID: connector, ChargingProfile: chargingProfile21{
		ID: profileID, StackLevel: 0, ChargingProfilePurpose: PurposeTx,
		ChargingProfileKind: "Absolute", TransactionID: stationTx,
		ChargingSchedule: []chargingSchedule21{{
			ID: profileID, StartSchedule: now.UTC().Format(time.RFC3339),
			Duration: int(TxProfileDuration / time.Second), ChargingRateUnit: "W",
			ChargingSchedulePeriod: []chargingSchedulePeriod21{{
				StartPeriod: 0, Setpoint: w, Limit: math.Max(w, 0), DischargeLimit: math.Min(w, 0),
				OperationMode: operationModeCentralSetpoint,
			}},
		}},
	}}
	conf, err := await(ctx, func(cb func(ocpp.Response, error)) error {
		return t.v21.cs.SendRequestAsync(chargerID, req, cb)
	})
	status := ""
	switch r := conf.(type) {
	case *smartcharging.SetChargingProfileResponse:
		status = string(r.Status)
	}
	if err == nil && status == "" {
		err = errors.New("leere Antwort auf SetChargingProfile")
	}
	if err != nil {
		status = "nicht beantwortet: " + err.Error()
	}
	out := V2XSetpoint{SetpointKw: setpointKw, Status: status, SentAt: now.UTC()}
	s.mu.Lock()
	if c, ok := s.chargers[chargerID]; ok {
		set := out
		c.connector(connector).V2X = &set
	}
	s.mu.Unlock()
	s.notifyChanged()
	return out, err
}
