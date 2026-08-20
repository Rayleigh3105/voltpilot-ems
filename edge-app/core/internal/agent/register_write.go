package agent

// Der PORTAL-TRIGGER des Einmal-Schreibens (Konzept vp-reg-schreib-konzept-p8
// §2.2, Stufe 1; Kontrakt docs/contracts/mqtt-register-write.schema.json).
//
// ⚠ ES IST DER ZWEITE ADAPTER, KEIN ZWEITER SCHREIBWEG. Diese Datei ist
// ausschliesslich VERDRAHTUNG: sie nimmt den Auftrag vom Cloud-Link entgegen,
// laesst `internal/registerwrite` (rein) ueber Form, Identitaet, Verfall, Lane,
// Rate und Selbstkonflikt entscheiden, uebergibt dann an GENAU DIE zwei
// Schichten, die auch die :8484-Taste benutzt -
//
//	POLITIK     installerwrite.Admit  (Allowlist 0x00E7, Wertdeckel 7000,
//	                                   Bestaetigungs-Regel, expected_before)
//	MECHANISMUS Agent.WriteOnce       (lesen, EINMAL schreiben, zurueckelesen)
//
// - und quittiert. Es gibt hier keinen Pfad an `Admit` vorbei: eine
// `installerwrite.AdmittedWrite` entsteht nirgendwo sonst, ihre Felder sind
// unexportiert. Die Portal-Apply-Doktrin, woertlich.
//
// ⚠ WAS STUMM VERWORFEN WIRD, UND WARUM: eine fremde Identitaet (eine Antwort
// bestaetigte einem falsch adressierten Absender die Existenz dieses Geraets)
// und ein verfallener Auftrag (die Portal-Route hat laengst aufgegeben, und
// eine nachgelieferte QoS1-Nachricht wuerde sonst einen weiteren
// EEPROM-Schreibzyklus kosten). Alles andere wird BEANTWORTET - eine Ablehnung,
// die niemand sieht, waere ein Raetsel (die Canary-Soak-Lehre des OTA-Pfads).

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/installerwrite"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/registerwrite"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// registerWriteWindow is how long an order stays executable, counted from its
// OWN `requested_at`. A var so tests can shorten it.
var registerWriteWindow = registerwrite.DefaultWindow

// onRegisterWrite is the cloud link's handler. It runs the CHEAP gate here and
// hands the rest to its own goroutine.
//
// ⚠ That split is not tidiness, it is required: the link is configured with
// paho's SetOrderMatters(true), so incoming messages are dispatched
// SEQUENTIALLY on one router goroutine. Blocking here for the length of a
// write round trip (read + write + ~2 s settle + read) would stall EVERY other
// downlink for that time - the plan, the entity registry, the flow deployment,
// the OTA assignment, the apply approval. An installer write must never be able
// to do that.
//
// What stays synchronous is exactly what costs nothing and must not spawn
// anything: parsing, identity, expiry, replay and the rate limit. So a
// malformed, foreign, expired, repeated or throttled order never starts a
// goroutine at all.
func (a *Agent) onRegisterWrite(payload []byte) {
	now := time.Now()
	req, err := registerwrite.Parse(payload)
	if err != nil {
		slog.Warn("Register-Schreiben: Auftrag verworfen", "grund", err.Error())
		return
	}

	a.entMu.Lock()
	ident := a.entIdentity
	a.entMu.Unlock()
	id := registerwrite.Identity{
		TenantID: ident.TenantID, SiteID: ident.SiteID, DeviceID: ident.DeviceID,
	}
	if !req.Matches(id) {
		// Bewusst OHNE die gemeldete Kennung im Klartext: das Geraet nennt nur,
		// DASS es nicht passt.
		slog.Warn("Register-Schreiben: Auftrag meint ein anderes Geraet - verworfen")
		return
	}
	if req.Expired(now, registerWriteWindow) {
		slog.Warn("Register-Schreiben: verfallener Auftrag verworfen (nachgeliefert?)",
			"request_id", req.RequestID, "requested_at", req.RequestedAt)
		return
	}
	// ⚠ Die Einmaligkeit ist die dritte Sicherung neben „nicht retained" und
	// dem Fenster: eine QoS1-Doppelzustellung, die INNERHALB des Fensters
	// ankommt, darf denselben Auftrag nie ein zweites Mal schreiben.
	if !a.claimRegisterWrite(req.RequestID) {
		slog.Warn("Register-Schreiben: dieselbe Anfrage wurde bereits ausgefuehrt",
			"request_id", req.RequestID)
		go a.publishRegisterWriteResult(registerwrite.Refused(req, id, time.Now(),
			registerwrite.ErrBusy, registerwrite.MsgReplayed))
		return
	}
	if a.registerLimiter != nil && !a.registerLimiter.Allow(now) {
		slog.Warn("Register-Schreiben: Ratenbegrenzung greift", "request_id", req.RequestID)
		go a.publishRegisterWriteResult(registerwrite.Refused(req, id, time.Now(),
			registerwrite.ErrRateLimited, registerwrite.MsgRateLimited))
		return
	}
	go a.runRegisterWrite(req, id)
}

// runRegisterWrite executes an ADMITTED order off the link's router goroutine.
func (a *Agent) runRegisterWrite(req registerwrite.Request, id registerwrite.Identity) {
	// ⚠ HIER STEHT KEIN FEATURE-GATE (Captain-Korrektur 20.08.2026, D2
	// KORRIGIERT). Der Einmal-Schreibpfad ist auf jeder Box verfuegbar; was ihn
	// traegt, sind die INHALTLICHEN Tore, die IMMER laufen: Identitaet
	// (Broker-ACL + mTLS-CN, oben geprueft), das requested_at-Fenster, die
	// Einmaligkeit, die Ratenbegrenzung, die Lane-Politik (Wertgrenzen,
	// LAN-Whitelist), die Selbstkonflikt-Sperre und die Zwei-Schritt-Strecke -
	// plus der Cloud-Not-Aus der Plattform (voltpilot.register-write.enabled am
	// api), der mit deutschem Grund refuesiert statt zu schweigen. Eine
	// Armierung je Box gab es nur in der Canary-Phase; sie war nie das, was den
	// Pfad sicher macht.
	if v := req.Admissible(); !v.OK() {
		a.publishRegisterWriteResult(registerwrite.Refused(req, id, time.Now(),
			v.Code, v.Message))
		return
	}
	// ⚠ DIE SELBSTKONFLIKT-SPERRE - die EINE harte Ablehnung dieses Kanals, und
	// sie greift schon in der VORSCHAU: „wuerde abgelehnt" gehoert in Schritt 1,
	// nie erst nach dem Klick des Menschen.
	if a.registerOwnedByControl(req.Target, req.Register.Address) {
		a.publishRegisterWriteResult(registerwrite.Refused(req, id, time.Now(),
			registerwrite.ErrRefusedControlOwned, registerwrite.MsgControlOwned))
		return
	}

	target, verdict := a.resolveRegisterTarget(req)
	if !verdict.OK() {
		a.publishRegisterWriteResult(registerwrite.Refused(req, id, time.Now(),
			verdict.Code, verdict.Message))
		return
	}
	admitted, err := installerwrite.AdmitExpert(installerwrite.ExpertRequest{
		Kind:           req.Register.Kind,
		Addr:           req.Register.Address,
		Value:          valueOr(req.Value, 0),
		Apply:          req.Apply(),
		Confirm:        req.Confirm,
		ExpectedBefore: req.ExpectedBefore,
		WriteFC:        intOr(req.WriteFC, 0),
		Scale:          a.registerScale(target, req.Register),
	})
	if err != nil {
		// POLITIK: Registerart, Wertebereich, Funktionscode, die
		// Bestaetigungs-Regel. Der deutsche Satz kommt VERBATIM von dort - eine
		// zweite Formulierung hier liesse die zwei Trigger dieselbe Ablehnung
		// verschieden benennen.
		a.publishRegisterWriteResult(registerwrite.Refused(req, id, time.Now(),
			registerwrite.ErrRefusedPolicy, err.Error()))
		return
	}

	res, err := a.WriteOnce(target, admitted) // MECHANISMUS
	if err != nil {
		code := registerwrite.ErrRefusedPolicy
		if err == installerwrite.ErrBusy {
			code = registerwrite.ErrBusy
		}
		msg := err.Error()
		if code == registerwrite.ErrBusy {
			msg = registerwrite.MsgBusy
		}
		a.publishRegisterWriteResult(registerwrite.Refused(req, id, time.Now(), code, msg))
		return
	}

	out := a.installerOutcome(admitted, res)
	// Der Portal-Trigger fuehrt DASSELBE Buch wie die lokale Taste: eine Zeile
	// je bestaetigtem Schreibvorgang, mit der request_id als Kreuz-Schluessel
	// zum Cloud-Journal (zwei unabhaengige Buecher, kreuz-pruefbar).
	if admitted.Apply() {
		a.recordInstallerWriteFrom(admitted, out, registerSource(req), req.RequestID)
	}
	// Nur der PRIMAER-Wechselrichter traegt die Einspeisegrenze, die jede
	// Oberflaeche als „die Grenze im Geraet" zeigt - ein fremdes Geraet auf
	// derselben Adresse darf sie nie ueberschreiben.
	if out.Accepted && out.After != nil && req.Target.Kind == registerwrite.LanePrimary {
		a.noteInstallerExportLimit(*out.After)
	}
	if !res.OK() {
		a.publishRegisterWriteResult(registerwrite.Refused(req, id, time.Now(),
			mechanismCode(res.ErrorCode), out.Message))
		return
	}
	wrote := res.Wrote
	var adopted *bool
	if admitted.Apply() {
		v := res.Adopted
		adopted = &v
	}
	a.publishRegisterWriteResult(registerwrite.NewResult(req, id, time.Now(),
		res.Before, res.After, &wrote, adopted, target.Label, out.Message))
}

// resolveRegisterTarget turns the order's LANE into a concrete write target.
//
// ⚠ THE ASYMMETRY IS THE SECURITY, and it is why the three lanes are three
// lanes and not one parameterised one:
//
//	primary   the cloud names NOTHING - the box takes its own configured
//	          inverter. A crafted order cannot redirect this write.
//	entity    the cloud names only an ID; the ENDPOINT comes from the box's own
//	          applied definition. Same property, one indirection further.
//	lan       the cloud names the endpoint, so it is the only lane whose target
//	          the box has to judge - and it does (registerwrite.Admissible's LAN
//	          whitelist, plus a second check in the node that dials).
func (a *Agent) resolveRegisterTarget(req registerwrite.Request) (installerwrite.Target, registerwrite.Verdict) {
	switch req.Target.Kind {
	case registerwrite.LanePrimary:
		t := a.installerTarget()
		t.Label = a.primaryTargetLabel()
		return t, registerwrite.Verdict{}
	case registerwrite.LaneLAN:
		host := strings.TrimSpace(req.Target.Host)
		port, unit := req.Target.EffectivePort(), req.Target.EffectiveUnit()
		return installerwrite.Target{
			Communication: inverter.CommModbusTCP,
			Host:          host, Port: port, UnitID: unit,
			Label: fmt.Sprintf("Freie Adresse · %s:%d · Unit %d", host, port, unit),
		}, registerwrite.Verdict{}
	case registerwrite.LaneEntity:
		return a.entityWriteTarget(req.Target.EntityID)
	default:
		return installerwrite.Target{},
			registerwrite.Verdict{Code: registerwrite.ErrInvalidRequest,
				Message: registerwrite.MsgLaneUnknown}
	}
}

// entityWriteTarget resolves a COMPONENT of the plant from the applied entity
// registry - never from the order.
//
// ⚠ It deliberately does NOT go through componentapply.ParseDriver: that one
// SKIPS a self-built device (its read plan travels as a generated flow, so it is
// not part of sources.json), and a self-built Modbus device is exactly the kind
// of component a customer wants to write to. What matters here is only whether
// the component names a reachable Modbus-TCP endpoint.
func (a *Agent) entityWriteTarget(entityID string) (installerwrite.Target, registerwrite.Verdict) {
	a.entMu.Lock()
	ent := a.entRegistry.Find(strings.TrimSpace(entityID))
	a.entMu.Unlock()
	if ent == nil {
		return installerwrite.Target{}, registerwrite.Verdict{Code: registerwrite.ErrNotSupported,
			Message: "Diese Komponente ist auf dem Gerät nicht eingerichtet."}
	}
	var d struct {
		Communication string              `json:"communication"`
		Connection    inverter.Connection `json:"connection"`
	}
	if len(ent.Driver) == 0 || json.Unmarshal(ent.Driver, &d) != nil {
		return installerwrite.Target{}, registerwrite.Verdict{Code: registerwrite.ErrNotSupported,
			Message: "Für diese Komponente ist keine Anbindung hinterlegt."}
	}
	// A component read over the Solarman logger belongs to the PRIMARY lane -
	// that socket is owned by the inverter tab, and a second claimant on it is
	// exactly what the one-socket law forbids. Named, never silently redirected.
	if d.Communication == inverter.CommSolarmanV5 {
		return installerwrite.Target{}, registerwrite.Verdict{Code: registerwrite.ErrNotSupported,
			Message: "Diese Komponente wird über den Solarman-Logger gelesen. Bitte den " +
				"primären Wechselrichter als Ziel wählen."}
	}
	host := strings.TrimSpace(d.Connection.IP)
	if host == "" {
		return installerwrite.Target{}, registerwrite.Verdict{Code: registerwrite.ErrNotSupported,
			Message: "Für diese Komponente ist keine IP-Adresse hinterlegt."}
	}
	if !probe.IsPrivateHost(host) {
		return installerwrite.Target{}, registerwrite.Verdict{Code: registerwrite.ErrInvalidRequest,
			Message: registerwrite.MsgHostNotPrivate}
	}
	port := d.Connection.Port
	if port <= 0 || port > 0xffff {
		port = 502
	}
	unit := d.Connection.UnitID
	if unit <= 0 {
		unit = d.Connection.MbSlaveID
	}
	if unit < 0 || unit > 255 {
		unit = 1
	}
	label := strings.TrimSpace(ent.Label)
	if label == "" {
		label = ent.ID
	}
	return installerwrite.Target{
		Communication: inverter.CommModbusTCP,
		Host:          host, Port: port, UnitID: unit,
		Label: fmt.Sprintf("Komponente „%s\" · %s:%d · Unit %d", label, host, port, unit),
	}, registerwrite.Verdict{}
}

// registerScale hands the EXPERT policy a known scale, and only a known one.
//
// The box knows exactly one register's scale by itself: the feed-in limit of its
// own inverter family (the READ-side table). Everything else stays unscaled -
// the cloud's register knowledge renders the customer-facing unit, and the box
// inventing one would be a second, drifting truth about a foreign device.
func (a *Agent) registerScale(target installerwrite.Target, reg registerwrite.Reg) *float64 {
	if target.Host != "" || reg.Kind != installerwrite.KindHolding {
		return nil
	}
	r, ok := inverter.ExportLimitRegisterFor(target.Family)
	if !ok || r.Addr != reg.Address {
		return nil
	}
	kwPerRaw := float64(installerwrite.ScaleW) / 1000
	return &kwPerRaw
}

// stage maps the CONTRACT's stage word onto the mechanism's own. It is the ONE
// place the two vocabularies meet.
func stage(req registerwrite.Request) string {
	if req.Apply() {
		return installerwrite.ModeApply
	}
	return installerwrite.ModeDry
}

// valueOr is the dry-run's placeholder: a preview carries no value at all. Under
// the EXPERT scope 0 is a legitimate register word, so the placeholder is 0 and
// nothing is refused for it - it never reaches a register anyway, because a dry
// run writes nothing.
func valueOr(v *int, fallback int) int {
	if v == nil {
		return fallback
	}
	return *v
}

func intOr(v *int, fallback int) int {
	if v == nil {
		return fallback
	}
	return *v
}

// registerSource names the trigger in the box's own audit, so the log stays
// readable next to the local `wartungszugang` entries.
func registerSource(req registerwrite.Request) string {
	if req.RequestedBy != "" {
		return "portal:" + req.RequestedBy
	}
	return "portal"
}

// mechanismCode maps the mechanism's exchange codes onto the contract's closed
// set. An unmapped one becomes `invalid_response` rather than travelling as an
// invented word the cloud would drop anyway.
func mechanismCode(code string) string {
	switch code {
	case installerwrite.ErrCodeUnreachable:
		return registerwrite.ErrUnreachable
	case installerwrite.ErrCodeTimeout:
		return registerwrite.ErrTimeout
	case installerwrite.ErrCodeBusy:
		return registerwrite.ErrBusy
	case installerwrite.ErrCodePrecondition:
		return registerwrite.ErrRefusedExpectedBefore
	case installerwrite.ErrCodeWriteUnconfirmed:
		return registerwrite.ErrNoAnswer
	default:
		return registerwrite.ErrInvalidResponse
	}
}

// registerOwnedByControl reports whether the RUNNING control loop currently
// commands this address (the self-conflict rule).
//
// It reads the NEWEST control readback - the registers our own executor is
// writing right now - and only counts them while control is really live (kill
// switch AND certification). Without a readback there is nothing to prove, and
// nothing is claimed: an invented conflict would refuse a legitimate write.
func (a *Agent) registerOwnedByControl(target registerwrite.Target, address int) bool {
	// ⚠ THE LOCK IS ABOUT ONE DEVICE, NOT ONE ADDRESS. The readback names the
	// registers our executor writes ON THE PRIMARY INVERTER; the same number on a
	// customer's own Modbus device is a completely unrelated register, and
	// refusing it would be an invented conflict.
	if !a.targetIsPrimary(target) {
		return false
	}
	snap := a.State.Get()
	info := snap.Control
	if info == nil {
		return false
	}
	owned := make([]int, 0, len(info.Registers))
	for _, r := range info.Registers {
		owned = append(owned, r.Addr)
	}
	return registerwrite.ControlOwns(controlLive(snap, info), owned, address)
}

// controlLive is the second half of the self-conflict rule: with the global
// kill switch off or the model uncertified our executor writes nothing at all,
// so the same registers are the installer's domain again.
func controlLive(snap state.Snapshot, info *state.ControlInfo) bool {
	return snap.ControlEnabled && snap.ControlCertified && info.ControlEnabled && info.Certified
}

// targetIsPrimary reports whether this order addresses the very device our own
// control executor writes: the primary lane by definition, and an entity/LAN
// target that resolves to the primary's own endpoint (a customer may reach the
// same inverter over plain Modbus-TCP).
func (a *Agent) targetIsPrimary(target registerwrite.Target) bool {
	if target.Kind == registerwrite.LanePrimary {
		return true
	}
	a.invMu.Lock()
	inv := a.inv
	a.invMu.Unlock()
	if inv == nil {
		return false
	}
	ip := strings.TrimSpace(inv.Connection.IP)
	return ip != "" && strings.EqualFold(ip, strings.TrimSpace(target.Host))
}

// primaryTargetLabel is the box's own ECHO of where it wrote - full, because on
// a plant with several devices the target is a deliberate choice and never a
// default in the dark.
func (a *Agent) primaryTargetLabel() string {
	a.invMu.Lock()
	inv := a.inv
	a.invMu.Unlock()
	if inv == nil {
		return "Primärer Wechselrichter"
	}
	label := inv.Label
	if label == "" {
		label = inv.Brand
	}
	if inv.Connection.IP != "" {
		return label + " · " + inv.Connection.IP
	}
	return label
}

// claimRegisterWrite records a request id as executed and reports whether it is
// the FIRST time. The set is bounded and in memory only: a restart forgets it,
// which is safe because the window (60 s) is far shorter than any restart.
func (a *Agent) claimRegisterWrite(requestID string) bool {
	a.registerMu.Lock()
	defer a.registerMu.Unlock()
	if a.registerSeen == nil {
		a.registerSeen = map[string]time.Time{}
	}
	cutoff := time.Now().Add(-2 * registerWriteWindow)
	for k, t := range a.registerSeen {
		if t.Before(cutoff) {
			delete(a.registerSeen, k)
		}
	}
	if _, seen := a.registerSeen[requestID]; seen {
		return false
	}
	a.registerSeen[requestID] = time.Now()
	return true
}

// publishRegisterWriteResult answers the cloud. Best-effort by nature: the
// portal route waits with its own timeout, so a failed publish is logged and
// nothing is retried - the cloud's honest outcome for silence is „Zustand
// unbekannt", and a duplicate late answer would only confuse a correlation that
// has already been dropped.
//
// a.registerPublish is the TEST SEAM (the a.probePublish precedent): nil means
// the real cloud link, so the production path has no branch of its own and a
// test asserts on the CONTRACT BYTES the box would put on the wire.
func (a *Agent) publishRegisterWriteResult(res registerwrite.Result) {
	raw, err := json.Marshal(res)
	if err != nil {
		slog.Warn("Register-Schreiben: Ergebnis nicht serialisierbar", "err", err)
		return
	}
	if a.registerPublish != nil {
		if err := a.registerPublish(raw); err != nil {
			slog.Warn("Register-Schreiben: Ergebnis konnte nicht gesendet werden",
				"request_id", res.RequestID, "err", err)
		}
		return
	}
	a.linkMu.Lock()
	link := a.link
	a.linkMu.Unlock()
	if link == nil {
		slog.Warn("Register-Schreiben: keine Cloud-Verbindung - Ergebnis nicht gesendet",
			"request_id", res.RequestID)
		return
	}
	if err := link.PublishRegisterWriteResult(raw); err != nil {
		slog.Warn("Register-Schreiben: Ergebnis konnte nicht gesendet werden",
			"request_id", res.RequestID, "err", err)
	}
}

// --- D6: die lokalen Schreibvorgaenge erreichen das Cloud-Journal ------------

// registerWriteUplinkWindow bounds how far back the heartbeat reports. A day is
// plenty for a deliberate, rare act, and it means a healthy box normally sends
// NO block at all.
var registerWriteUplinkWindow = 24 * time.Hour

// maxRegisterWriteUplink bounds how many entries one heartbeat carries.
const maxRegisterWriteUplink = 5

// registerWritesSummary is the additive `register_writes` heartbeat block
// (Captain-Entscheid D6): the box reports its OWN audit so a write made AT THE
// DEVICE (the :8484 maintenance access) is visible in the cloud journal too.
//
// ⚠ It closes the „zwei Wahrheiten ueber denselben Vorgang"-Luecke the concept
// names (§2.9 point 7). Without it the Befehle-Seite would have had to say
// „Vor-Ort-Schreibvorgaenge erscheinen hier nicht" - a permanent hole in the
// one page that answers „was wurde an mein Geraet geschickt?".
//
// It reports EVERY audited operation, not only the local ones: the cloud dedupes
// on (request_id, event), so a portal-triggered write simply matches what is
// already there - and if its receipt was ever lost on the way, the box's own
// book fills the gap. Reporting only half the book would be the fragile choice.
//
// A DRY RUN is never in the log at all (the adapter does not audit it), so this
// block can only ever carry real write attempts.
func (a *Agent) registerWritesSummary() *cloud.RegisterWritesSummary {
	if a.installerLog == nil {
		return nil
	}
	entries := a.installerLog.List() // newest first
	now := time.Now().UTC()
	out := make([]cloud.RegisterWriteEntry, 0, maxRegisterWriteUplink)
	for _, e := range entries {
		if len(out) >= maxRegisterWriteUplink {
			break
		}
		// A request id is the CROSS KEY; an entry without one predates the
		// correlation and is reported by nobody rather than under an invented id.
		if e.RequestID == "" || e.At.IsZero() || now.Sub(e.At) > registerWriteUplinkWindow {
			continue
		}
		out = append(out, cloud.RegisterWriteEntry{
			RequestID: e.RequestID,
			At:        e.At.UTC().Format(time.RFC3339),
			Register:  e.Register,
			Before:    e.Before,
			Requested: e.Requested,
			After:     e.After,
			Result:    e.Result,
			Message:   e.Message,
			Source:    e.Source,
		})
	}
	if len(out) == 0 {
		return nil
	}
	return &cloud.RegisterWritesSummary{ReportedAt: now.Format(time.RFC3339), Entries: out}
}

// newRegisterWriteID mints a correlation id in the CONTRACT's shape
// (`^[0-9a-f]{16,64}$`) for a write nobody else correlated - a local one. It is
// the same shape the cloud generates, so both books speak one key format.
func newRegisterWriteID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// A box without entropy still gets a usable key: the clock is unique
		// enough for a rare, deliberate act, and no id at all would drop the
		// entry from the uplink entirely.
		return hex.EncodeToString([]byte(time.Now().UTC().Format("20060102150405")))[:16]
	}
	return hex.EncodeToString(b)
}
