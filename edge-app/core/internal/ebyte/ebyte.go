// Package ebyte is the driver of the Ebyte M31-U distributed I/O host (the
// M31-AXAX8080G-U: 8 digital inputs + 8 relay outputs, Modbus TCP) and its
// U-series expansion modules. It reads every digital input and relay output of
// the assembled stack and switches single relay outputs for the consumer
// control path.
//
// THE STACK IS DISCOVERED, NEVER CONFIGURED. The host lists its own I/O board
// and every negotiated expansion module in the slave model table (holding
// 0x0C80, 8 registers per slot, "NONE" ends the list). The model code carries
// the channel counts (type letters DI/AI/DO/AO + one count digit each, "A" =
// 16), and the DI/DO Modbus addresses of all modules are CONTIGUOUS in slot
// order: a host with 8 DO plus an 8-DO module exposes coils 0..15. The counts
// are then PROVEN against the device - the last address must answer and the
// next one must be refused - because a wrong count would switch the wrong
// relay. An unproven stack is neither read nor written: every channel number
// would be a guess.
//
// NEGOTIATION IS AN OPERATOR ACT. After a module was added or removed the host
// refuses ALL I/O (exception 2, device error code 2) until the internal bus is
// negotiated again (Reload button double-click or the documented write-protect
// + start registers). The driver reports this honestly and never negotiates on
// its own from the control path: negotiation renumbers the channels.
//
// IDENTITY IS THE MAC, NOT THE ADDRESS. A DHCP-addressed module can move and
// another device can inherit its address; the connection therefore pins the
// MAC seen at setup (holding 0x7534) and the driver refuses every write when
// the device behind the address answers with a different one.
//
// THE DEAD-MAN IS ON THE DEVICE. The host's offline fault output (0x0C35
// offline time in 0.1 s, 0x0C36 enable, 0x1B58+n fault state per DO, 1 = OFF)
// drops the relays when no Modbus request arrives within the offline time.
// Bench findings (firmware 9232-0-13): the settings take effect only after a
// device restart; ANY request (also a pure read, also from another client)
// keeps it alive; it trips between one and two offline times after the last
// request; 0x0C37 counts trips. The executor's periodic re-assert and the
// source poll are the heartbeat, so a dead edge lets the outputs fall off.
package ebyte

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

// Communication is the driver.communication value that selects this driver.
const Communication = "ebyte_modbus_tcp"

// DefaultPort and DefaultUnitID are the factory settings (manual §3.2).
const (
	DefaultPort   = 502
	DefaultUnitID = 1
)

// MaxChannels bounds the DI/DO count of one stack (16 slots x 16 channels).
const MaxChannels = 256

// Documented registers (manual §4.10).
const (
	regHostModel        = 0x0C20 // 12 registers, string
	regHostFirmware     = 0x0C2C // 8 registers, string
	regOfflineTime      = 0x0C35 // 0.1 s
	regOfflineEnable    = 0x0C36
	regFaultFlag        = 0x0C37 // trip counter (bench finding)
	regSlaveModels      = 0x0C80 // 16 slots x 8 registers, string
	regFaultState       = 0x1B58 // one register per DO: 0 hold, 1 off, 2 on
	regDOMode           = 0x32C8 // one register per DO: 0 level, 1 pulse
	regRestart          = 0x0C1D
	regMAC              = 0x7534 // 3 registers
	regDeviceError      = 0x7587
	regNegotiationState = 0x758A // 1 = negotiation required
	restartMagic        = 0x5BB5
	slotCount           = 16
	slotRegisters       = 8
)

// Error codes (the shelly/testconn vocabulary plus the M31 specifics).
const (
	ErrInvalidRequest     = "invalid_request"
	ErrUnreachable        = "unreachable"
	ErrInvalidResponse    = "invalid_response"
	ErrIdentityMismatch   = "identity_mismatch"
	ErrNegotiationPending = "negotiation_pending"
	ErrChannelUnknown     = "channel_unknown"
)

// DriverError is a classified driver failure with a German, surface-verbatim
// message.
type DriverError struct {
	Code    string
	Message string
}

func (e *DriverError) Error() string { return e.Code + ": " + e.Message }

func driverErr(code, msg string) *DriverError { return &DriverError{Code: code, Message: msg} }

// Config is the M31 connection (entity driver.connection or the :8484 form).
type Config struct {
	IP     string `json:"ip"`
	Port   int    `json:"port,omitempty"`
	UnitID int    `json:"unit_id,omitempty"`
	// MAC pins the physical device seen at setup ("00:54:2c:84:9b:90").
	// Empty = not pinned (reads allowed, the connection test reports the MAC).
	MAC string `json:"mac,omitempty"`
	// Channel is the 1-based relay output a consumer entity switches (DO1 = 1),
	// counted across the whole stack. 0 = the device itself (source poll).
	Channel int `json:"channel,omitempty"`
}

// Address renders host:port for the dialer.
func (c Config) Address() string {
	port := c.Port
	if port <= 0 {
		port = DefaultPort
	}
	return net.JoinHostPort(strings.TrimSpace(c.IP), strconv.Itoa(port))
}

func (c Config) unit() byte {
	if c.UnitID <= 0 || c.UnitID > 247 {
		return DefaultUnitID
	}
	return byte(c.UnitID)
}

// Module is one slot of the negotiated stack (slot 0 = the host's own board).
type Module struct {
	Slot  int    `json:"slot"`
	Model string `json:"model"`
	DI    int    `json:"di"`
	AI    int    `json:"ai"`
	DO    int    `json:"do"`
	AO    int    `json:"ao"`
	// DOKind is "relay" or "transistor" (PNP) - what the output switches.
	DOKind string `json:"do_kind,omitempty"`
	// AIKind names the analog/temperature input class; analog channels are
	// listed but not read by this driver version.
	AIKind string `json:"ai_kind,omitempty"`
}

// Identity is the discovered device + stack.
type Identity struct {
	Model    string   `json:"model"`
	Firmware string   `json:"firmware"`
	MAC      string   `json:"mac"`
	Modules  []Module `json:"modules"`
	DI       int      `json:"di"`
	DO       int      `json:"do"`
	// Proven is true when the DI/DO counts were confirmed against the device's
	// address boundaries; writes require it.
	Proven bool `json:"proven"`
	// Unsupported lists analog/temperature modules detected but not read.
	Unsupported []string `json:"unsupported,omitempty"`
}

// Label renders a short human identity line.
func (id Identity) Label() string {
	return fmt.Sprintf("%s (%d Eingänge, %d Ausgänge, Firmware %s)", id.Model, id.DI, id.DO, id.Firmware)
}

var codePattern = regexp.MustCompile(`([ABDEFX]{4})([0-9A]{4})`)

// countDigit decodes one count digit of the model code: 0..9 literally, "A" =
// 16 (M31-AXXXA000G-U = 16 DI, M31-XXAX00A0G-U = 16 DO).
func countDigit(b byte) (int, bool) {
	switch {
	case b >= '0' && b <= '9':
		return int(b - '0'), true
	case b == 'A':
		return 16, true
	}
	return 0, false
}

// ParseModule decodes a model string ("M31-AXAX8080G-U", "GAXAX8080-U",
// "XXAX00A0") into its channel counts. ok=false for an unknown code.
func ParseModule(model string) (Module, bool) {
	m := codePattern.FindStringSubmatch(strings.ToUpper(model))
	if m == nil {
		return Module{}, false
	}
	types, counts := m[1], m[2]
	var n [4]int
	for i := 0; i < 4; i++ {
		v, ok := countDigit(counts[i])
		if !ok {
			return Module{}, false
		}
		// A count without a type letter (or the reverse) is not a real code.
		if (types[i] == 'X') != (v == 0) {
			return Module{}, false
		}
		n[i] = v
	}
	mod := Module{Model: strings.TrimSpace(model), DI: n[0], AI: n[1], DO: n[2], AO: n[3]}
	switch types[2] {
	case 'A':
		mod.DOKind = "relay"
	case 'E':
		mod.DOKind = "transistor"
	}
	switch types[1] {
	case 'A':
		mod.AIKind = "current_single"
	case 'B':
		mod.AIKind = "voltage_single"
	case 'D':
		mod.AIKind = "pt100"
	case 'F':
		mod.AIKind = "current_differential"
	}
	return mod, true
}

func regString(regs []uint16) string {
	b := make([]byte, 2*len(regs))
	for i, r := range regs {
		binary.BigEndian.PutUint16(b[2*i:], r)
	}
	if i := strings.IndexByte(string(b), 0); i >= 0 {
		b = b[:i]
	}
	return strings.TrimSpace(string(b))
}

func formatMAC(regs []uint16) string {
	parts := make([]string, 0, 6)
	for _, r := range regs {
		parts = append(parts, fmt.Sprintf("%02x", r>>8), fmt.Sprintf("%02x", r&0xFF))
	}
	return strings.Join(parts, ":")
}

// NormalizeMAC lower-cases and unifies separators ("00-54-2C-..." -> "00:54:2c:...").
func NormalizeMAC(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	return strings.ReplaceAll(s, "-", ":")
}

// Client runs driver sessions against one device (Dial injected in tests).
type Client struct {
	Dial Dialer
}

func (cl Client) session(ctx context.Context, cfg Config, fn func(*conn) error) *DriverError {
	host := strings.TrimSpace(cfg.IP)
	if host == "" {
		return driverErr(ErrInvalidRequest, "keine IP-Adresse")
	}
	// The LAN rule is repeated at the actual connection opener (the shared
	// lan-host-vectors rule): an I/O module lives in the customer LAN.
	if !probe.IsPrivateHost(host) {
		return driverErr(ErrInvalidRequest, "Die Adresse liegt nicht im lokalen Netz")
	}
	err := withSession(ctx, cl.Dial, cfg.Address(), cfg.unit(), fn)
	if err == nil {
		return nil
	}
	if de, ok := err.(*DriverError); ok {
		return de
	}
	if _, ok := err.(*ExceptionError); ok {
		return driverErr(ErrInvalidResponse, "Das Gerät hat die Anfrage abgelehnt ("+err.Error()+")")
	}
	return driverErr(ErrUnreachable, "Das I/O-Modul ist nicht erreichbar ("+err.Error()+")")
}

// identify reads the identity inside an open session.
func identify(c *conn) (Identity, error) {
	var id Identity
	regs, err := c.readHolding(regHostModel, 12)
	if err != nil {
		return id, err
	}
	id.Model = regString(regs)
	if !strings.HasPrefix(strings.ToUpper(id.Model), "M31-") {
		return id, driverErr(ErrInvalidResponse, fmt.Sprintf("Kein Ebyte-M31-Gerät (Modell %q)", id.Model))
	}
	if regs, err = c.readHolding(regHostFirmware, 8); err != nil {
		return id, err
	}
	id.Firmware = regString(regs)
	if regs, err = c.readHolding(regMAC, 3); err != nil {
		return id, err
	}
	id.MAC = formatMAC(regs)

	state, err := c.readHolding(regDeviceError, 1)
	if err != nil {
		return id, err
	}
	pending, err := c.readHolding(regNegotiationState, 1)
	if err != nil {
		return id, err
	}
	if state[0] == 2 || pending[0] == 1 {
		return id, driverErr(ErrNegotiationPending,
			"Die Erweiterungsmodule sind nicht abgestimmt. Bitte am Gerät die Reload-Taste innerhalb von 2 Sekunden doppelt drücken und danach erneut prüfen.")
	}

	for slot := 0; slot < slotCount; slot++ {
		regs, err := c.readHolding(uint16(regSlaveModels+slot*slotRegisters), slotRegisters)
		if err != nil {
			return id, err
		}
		name := regString(regs)
		if name == "" && slot == 0 {
			name = id.Model // the host board before its first negotiation
		}
		if name == "" || strings.EqualFold(name, "NONE") {
			break
		}
		mod, ok := ParseModule(name)
		if !ok {
			return id, driverErr(ErrInvalidResponse, fmt.Sprintf("Unbekanntes Modul in Steckplatz %d: %q", slot, name))
		}
		mod.Slot = slot
		id.Modules = append(id.Modules, mod)
		id.DI += mod.DI
		id.DO += mod.DO
		if mod.AI > 0 || mod.AO > 0 {
			id.Unsupported = append(id.Unsupported, mod.Model)
		}
	}
	if len(id.Modules) == 0 {
		return id, driverErr(ErrInvalidResponse, "Das Gerät meldet keine I/O-Module")
	}
	if id.DI > MaxChannels || id.DO > MaxChannels {
		return id, driverErr(ErrInvalidResponse, "Zu viele Kanäle gemeldet")
	}
	proven, err := proveCounts(c, id.DI, id.DO)
	if err != nil {
		return id, err
	}
	id.Proven = proven
	return id, nil
}

// proveCounts checks both address boundaries: the last DI/DO must answer and
// the next address must be refused. A transport error aborts; a boundary that
// does not hold yields proven=false.
func proveCounts(c *conn, di, do int) (bool, error) {
	check := func(read func(uint16, uint16) ([]bool, error), n int) (bool, error) {
		if n > 0 {
			if _, err := read(uint16(n-1), 1); err != nil {
				if IllegalAddress(err) {
					return false, nil
				}
				return false, err
			}
		}
		if _, err := read(uint16(n), 1); err == nil {
			return false, nil
		} else if !IllegalAddress(err) {
			return false, err
		}
		return true, nil
	}
	okDI, err := check(c.readDiscreteInputs, di)
	if err != nil {
		return false, err
	}
	okDO, err := check(c.readCoils, do)
	if err != nil {
		return false, err
	}
	return okDI && okDO, nil
}

// Watchdog is the device-side dead-man configuration as read back.
type Watchdog struct {
	Enabled       bool  `json:"enabled"`
	OfflineTenths int   `json:"offline_tenths"`
	FaultOffAll   bool  `json:"fault_off_all"`
	Trips         int   `json:"trips"`
	FaultStates   []int `json:"fault_states,omitempty"`
}

// Armed is true when every output falls off after the offline time.
func (w Watchdog) Armed() bool { return w.Enabled && w.OfflineTenths > 0 && w.FaultOffAll }

// State is one read of the whole stack.
type State struct {
	Inputs   []bool   `json:"inputs"`
	Outputs  []bool   `json:"outputs"`
	Watchdog Watchdog `json:"watchdog"`
}

func readWatchdog(c *conn, do int) (Watchdog, error) {
	var w Watchdog
	regs, err := c.readHolding(regOfflineTime, 3)
	if err != nil {
		return w, err
	}
	w.OfflineTenths, w.Enabled, w.Trips = int(regs[0]), regs[1] == 1, int(regs[2])
	w.FaultOffAll = do > 0
	for off := 0; off < do; off += 100 {
		n := do - off
		if n > 100 {
			n = 100
		}
		st, err := c.readHolding(uint16(regFaultState+off), uint16(n))
		if err != nil {
			return w, err
		}
		for _, v := range st {
			w.FaultStates = append(w.FaultStates, int(v))
			if v != 1 {
				w.FaultOffAll = false
			}
		}
	}
	return w, nil
}

func readIO(c *conn, id Identity) (State, error) {
	var st State
	var err error
	if id.DI > 0 {
		if st.Inputs, err = c.readDiscreteInputs(0, uint16(id.DI)); err != nil {
			return st, err
		}
	}
	if id.DO > 0 {
		if st.Outputs, err = c.readCoils(0, uint16(id.DO)); err != nil {
			return st, err
		}
	}
	st.Watchdog, err = readWatchdog(c, id.DO)
	return st, err
}

func checkMAC(cfg Config, id Identity) *DriverError {
	if cfg.MAC == "" || NormalizeMAC(cfg.MAC) == id.MAC {
		return nil
	}
	return driverErr(ErrIdentityMismatch, fmt.Sprintf(
		"Unter %s antwortet ein anderes Gerät (MAC %s statt %s). Es wird nichts geschaltet; bitte die Adresse prüfen.",
		cfg.IP, id.MAC, NormalizeMAC(cfg.MAC)))
}

// Identify discovers the device and its stack.
func (cl Client) Identify(ctx context.Context, cfg Config) (Identity, *DriverError) {
	var id Identity
	de := cl.session(ctx, cfg, func(c *conn) error {
		var err error
		id, err = identify(c)
		return err
	})
	return id, de
}

// Read identifies the stack and reads every input, output and the watchdog in
// ONE session. A MAC mismatch is reported (the reading belongs to a foreign
// device and must not be attributed to this source).
func (cl Client) Read(ctx context.Context, cfg Config) (Identity, State, *DriverError) {
	var id Identity
	var st State
	de := cl.session(ctx, cfg, func(c *conn) error {
		var err error
		if id, err = identify(c); err != nil {
			return err
		}
		if de := checkMAC(cfg, id); de != nil {
			return de
		}
		if !id.Proven {
			return errUnproven
		}
		st, err = readIO(c, id)
		return err
	})
	return id, st, de
}

var errUnproven = driverErr(ErrChannelUnknown,
	"Die Kanalzahl passt nicht zur Modulliste des Geräts; bitte die Module neu abstimmen (Reload doppelt drücken)")

// SetOutput switches one 1-based output (FC5) after re-proving identity,
// negotiation and channel range in the same session, then reads the whole
// stack back.
func (cl Client) SetOutput(ctx context.Context, cfg Config, channel int, on bool) (Identity, State, *DriverError) {
	var id Identity
	var st State
	de := cl.session(ctx, cfg, func(c *conn) error {
		var err error
		if id, err = identify(c); err != nil {
			return err
		}
		if de := checkMAC(cfg, id); de != nil {
			return de
		}
		if !id.Proven {
			return errUnproven
		}
		if channel < 1 || channel > id.DO {
			return driverErr(ErrChannelUnknown, fmt.Sprintf("Ausgang %d gibt es an diesem Gerät nicht (1..%d)", channel, id.DO))
		}
		// In pulse mode an ON write fires pulses instead of holding the
		// relay: a consumer output must be in level mode.
		mode, err := c.readHolding(uint16(regDOMode+channel-1), 1)
		if err != nil {
			return err
		}
		if mode[0] != 0 {
			return driverErr(ErrInvalidRequest, fmt.Sprintf("Ausgang %d steht im Impulsmodus; geschaltet wird nur im Pegelmodus", channel))
		}
		if err := c.writeSingleCoil(uint16(channel-1), on); err != nil {
			return err
		}
		st, err = readIO(c, id)
		return err
	})
	return id, st, de
}

// WatchdogSetup is the requested device-side dead-man configuration.
type WatchdogSetup struct {
	OfflineTenths int // offline time in 0.1 s
}

// DefaultOfflineTenths is 60 s: the executor re-asserts every 60 s and the
// source poll reads every 10 s, so a live edge never trips it, while a dead
// edge lets every relay fall off within one to two minutes.
const DefaultOfflineTenths = 600

// ArmWatchdog writes the dead-man configuration (fault state OFF for every
// output, offline time, enable) and restarts the device so it takes effect.
// Refused while any output is on: the restart drops every relay, and a running
// load is never interrupted by a configuration step.
func (cl Client) ArmWatchdog(ctx context.Context, cfg Config, setup WatchdogSetup) (Identity, *DriverError) {
	var id Identity
	tenths := setup.OfflineTenths
	if tenths <= 0 {
		tenths = DefaultOfflineTenths
	}
	if tenths > 65535 {
		return id, driverErr(ErrInvalidRequest, "Offline-Zeit zu groß")
	}
	de := cl.session(ctx, cfg, func(c *conn) error {
		var err error
		if id, err = identify(c); err != nil {
			return err
		}
		if de := checkMAC(cfg, id); de != nil {
			return de
		}
		if !id.Proven {
			return errUnproven
		}
		st, err := readIO(c, id)
		if err != nil {
			return err
		}
		for i, on := range st.Outputs {
			if on {
				return driverErr(ErrInvalidRequest, fmt.Sprintf(
					"Ausgang %d ist eingeschaltet; die Einrichtung startet das Gerät neu und wird deshalb nur mit allen Ausgängen aus ausgeführt", i+1))
			}
		}
		faults := make([]uint16, id.DO)
		for i := range faults {
			faults[i] = 1
		}
		for off := 0; off < len(faults); off += 100 {
			end := off + 100
			if end > len(faults) {
				end = len(faults)
			}
			if err := c.writeRegisters(uint16(regFaultState+off), faults[off:end]); err != nil {
				return err
			}
		}
		if err := c.writeRegisters(regOfflineTime, []uint16{uint16(tenths), 1}); err != nil {
			return err
		}
		// The manual documents FC6 for the restart register.
		return c.writeSingleRegister(regRestart, restartMagic)
	})
	return id, de
}
