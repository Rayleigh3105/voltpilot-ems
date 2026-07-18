// Package flowdeploy consumes the retained flow deployment set
// (docs/contracts/v2/flow-artifact.md, schema flow-artifact.schema.json):
// verify identity, content hash (RFC 8785 canonicalization of the bundle),
// version gates and capability requirements per artifact; persist the set;
// materialize the @vp-flow tabs in the Node-RED runtime via the Admin API;
// acknowledge per artifact in the status heartbeat's `flows` block.
//
// Apply is per artifact, atomic per flow: a failing artifact is skipped and
// acked error/unsupported, the rest of the set still applies. Rollback IS a
// deployment (the cloud republishes the previous set); the persisted copy +
// the periodic reconcile give the regenerate-from-truth self-heal the
// contract's §4 demands.
package flowdeploy

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

// SchemaVersion of the flow-artifact contract.
const SchemaVersion = "1.0"

// The contract's size budgets (schema x-limits).
const (
	maxArtifactBytes   = 262144
	maxDeploymentBytes = 524288
)

// OwnershipMarker tags artifact tabs (flow-artifact.md §2/§4): the reseed
// mechanism preserves tabs whose info field starts with it.
const OwnershipMarker = "@vp-flow"

// Artifact is one compiled flow as received (fields per $defs/artifact).
type Artifact struct {
	SchemaVersion     string           `json:"schema_version"`
	Kind              string           `json:"kind"`
	ArtifactID        string           `json:"artifact_id"`
	FlowID            string           `json:"flow_id"`
	FlowVersion       int              `json:"flow_version"`
	Runtime           string           `json:"runtime"`
	ContentHash       string           `json:"content_hash"`
	MinPaletteVersion string           `json:"min_palette_version"`
	MinCoreVersion    string           `json:"min_core_version"`
	RequiredEntities  []RequiredEntity `json:"required_entities"`
	Bundle            Bundle           `json:"bundle"`
}

// RequiredEntity is one capability requirement.
type RequiredEntity struct {
	EntityID     string   `json:"entity_id"`
	Capabilities []string `json:"capabilities"`
}

// Bundle is the compiled Node-RED payload.
type Bundle struct {
	Format       string            `json:"format"`
	TabIDs       []string          `json:"tab_ids"`
	NoderedFlows []json.RawMessage `json:"nodered_flows"`
}

// Deployment is the parsed retained set.
type Deployment struct {
	TenantID  string
	SiteID    string
	DeviceID  string
	Artifacts []Artifact
	// rawArtifacts keeps each artifact's raw JSON for the size budget.
	rawArtifacts []json.RawMessage
}

// Identity is the device identity a deployment must address.
type Identity struct{ TenantID, SiteID, DeviceID string }

// ParseDeployment validates the envelope (kind, schema_version, identity,
// size). Per-artifact verification happens in Apply (per-artifact acks).
func ParseDeployment(payload []byte, id Identity) (*Deployment, error) {
	if len(payload) > maxDeploymentBytes {
		return nil, fmt.Errorf("deployment exceeds the %d-byte budget", maxDeploymentBytes)
	}
	var msg struct {
		SchemaVersion string            `json:"schema_version"`
		Kind          string            `json:"kind"`
		TenantID      string            `json:"tenant_id"`
		SiteID        string            `json:"site_id"`
		DeviceID      string            `json:"device_id"`
		Artifacts     []json.RawMessage `json:"artifacts"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return nil, fmt.Errorf("deployment unreadable: %w", err)
	}
	if msg.SchemaVersion != SchemaVersion || msg.Kind != "deployment" {
		return nil, fmt.Errorf("not a %s deployment payload (kind %q, schema_version %q)",
			SchemaVersion, msg.Kind, msg.SchemaVersion)
	}
	if !strings.EqualFold(msg.DeviceID, id.DeviceID) ||
		!strings.EqualFold(msg.TenantID, id.TenantID) ||
		!strings.EqualFold(msg.SiteID, id.SiteID) {
		return nil, fmt.Errorf("deployment identity %s/%s/%s does not match this device",
			msg.TenantID, msg.SiteID, msg.DeviceID)
	}
	d := &Deployment{TenantID: msg.TenantID, SiteID: msg.SiteID, DeviceID: msg.DeviceID}
	seen := map[string]bool{}
	for _, raw := range msg.Artifacts {
		var a Artifact
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, fmt.Errorf("artifact unreadable: %w", err)
		}
		if a.FlowID == "" || seen[a.FlowID] {
			return nil, fmt.Errorf("artifact flow_id missing or duplicated (%q)", a.FlowID)
		}
		seen[a.FlowID] = true
		d.Artifacts = append(d.Artifacts, a)
		d.rawArtifacts = append(d.rawArtifacts, raw)
	}
	return d, nil
}

// verifyArtifact runs the per-artifact gates. Returns the ack state
// ("active" when everything passed) + a German detail for refusals.
func (dep *Deployer) verifyArtifact(a Artifact, raw []byte) (string, string) {
	if a.SchemaVersion != SchemaVersion || a.Kind != "artifact" {
		return "error", "kein gültiges Artefakt (kind/schema_version)"
	}
	if a.Runtime != "edge" {
		return "unsupported", "Laufzeit " + a.Runtime + " wird auf dem Gerät nicht ausgeführt"
	}
	if len(raw) > maxArtifactBytes {
		return "error", fmt.Sprintf("Artefakt überschreitet das Größenbudget (%d Bytes)", maxArtifactBytes)
	}
	if a.Bundle.Format != "nodered-tabs" || len(a.Bundle.TabIDs) == 0 || len(a.Bundle.NoderedFlows) == 0 {
		return "error", "Bundle-Format nicht unterstützt oder leer"
	}
	// Integrity: re-canonicalize the bundle and verify the hash.
	bundleRaw, err := json.Marshal(a.Bundle)
	if err != nil {
		return "error", "Bundle nicht serialisierbar"
	}
	hash, err := ContentHash(bundleRaw)
	if err != nil {
		return "error", "Bundle nicht kanonisierbar: " + err.Error()
	}
	if hash != a.ContentHash {
		return "error", "content_hash stimmt nicht mit dem Bundle überein"
	}
	// The reseed coexistence contract (D-12) depends on the ownership marker:
	// refuse a bundle whose tabs are unmarked instead of deploying tabs the
	// next reseed would treat as vendor property.
	tabs, err := bundleTabs(a.Bundle)
	if err != nil {
		return "error", err.Error()
	}
	for _, tab := range tabs {
		if !strings.HasPrefix(tab.Info, OwnershipMarker) {
			return "error", "Tab ohne @vp-flow-Eigentumsmarkierung"
		}
	}
	// Version gates: refuse instead of deploying a bundle the runtime cannot
	// execute (the fleet is heterogeneous, no OTA).
	pal, palErr := dep.paletteVersion()
	if palErr != nil {
		return "error", "Palette-Version nicht ermittelbar: " + palErr.Error()
	}
	if !versionSatisfies(pal, a.MinPaletteVersion) {
		return "unsupported", fmt.Sprintf("benötigt Palette >= %s (installiert: %s)", a.MinPaletteVersion, pal)
	}
	if !versionSatisfies(dep.coreVersion, a.MinCoreVersion) {
		return "unsupported", fmt.Sprintf("benötigt Core >= %s (installiert: %s)", a.MinCoreVersion, dep.coreVersion)
	}
	// Capability requirements vs the entity registry view. No partial deploys.
	reg := dep.registry()
	for _, req := range a.RequiredEntities {
		e := reg.Find(req.EntityID)
		if e == nil {
			return "unsupported", "Entität " + req.EntityID + " ist auf dem Gerät nicht bekannt"
		}
		for _, cap := range req.Capabilities {
			if !entityHasCapability(*e, cap) {
				return "unsupported", "Entität " + req.EntityID + " bietet " + cap + " nicht"
			}
		}
	}
	return "active", ""
}

// entityHasCapability checks one "measure:<channel>" / "actuate:<command>"
// descriptor against the registry entity.
func entityHasCapability(e entities.Entity, cap string) bool {
	kind, name, ok := strings.Cut(cap, ":")
	if !ok {
		return false
	}
	switch kind {
	case "measure":
		for _, m := range e.Capabilities.Measure {
			if m.Channel == name {
				return true
			}
		}
	case "actuate":
		return e.Supports(name)
	}
	return false
}

// tabNode is the slice of a bundle node the deployer needs.
type tabNode struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Label string `json:"label"`
	Info  string `json:"info"`
	Z     string `json:"z"`
}

// bundleTabs extracts the tab nodes named by tab_ids from the bundle.
func bundleTabs(b Bundle) ([]tabNode, error) {
	want := map[string]bool{}
	for _, id := range b.TabIDs {
		want[id] = true
	}
	var tabs []tabNode
	for _, raw := range b.NoderedFlows {
		var n tabNode
		if err := json.Unmarshal(raw, &n); err != nil {
			return nil, errors.New("Bundle-Knoten nicht lesbar")
		}
		if n.Type == "tab" && want[n.ID] {
			tabs = append(tabs, n)
		}
	}
	if len(tabs) != len(b.TabIDs) {
		return nil, errors.New("tab_ids und Bundle-Tabs stimmen nicht überein")
	}
	return tabs, nil
}

// versionSatisfies reports installed >= minimum for x.y.z versions. An
// unparseable INSTALLED version passes (a dev/unstamped build is the newest
// code; any core running this deployer is at least E2-level - documented
// trade-off); an unparseable MINIMUM refuses (a garbled gate must not deploy).
func versionSatisfies(installed, minimum string) bool {
	min, ok := parseSemver(minimum)
	if !ok {
		return false
	}
	inst, ok := parseSemver(installed)
	if !ok {
		return true
	}
	for i := 0; i < 3; i++ {
		if inst[i] != min[i] {
			return inst[i] > min[i]
		}
	}
	return true
}

func parseSemver(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.SplitN(strings.TrimPrefix(strings.TrimSpace(v), "v"), ".", 3)
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		// Tolerate a trailing pre-release/build suffix on the patch part.
		if i == 2 {
			if cut := strings.IndexAny(p, "-+"); cut >= 0 {
				p = p[:cut]
			}
		}
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// --- Deployer ---------------------------------------------------------------

// Deps wires the deployer into the agent.
type Deps struct {
	// NR is the Node-RED admin client; nil = flow deployment disabled (a
	// received set is verified + persisted, every deployable artifact acked
	// 'error' with a detail naming the missing configuration).
	NR NRClient
	// DataDir persists the last deployment (flows-deployment.json).
	DataDir string
	// CoreVersion is the running vp-edge-core version (agent.Version).
	CoreVersion string
	// Registry returns the current entity-registry view.
	Registry func() entities.Registry
	// Identity returns the device identity a deployment must address.
	Identity func() Identity
}

// Deployer consumes deployments and tracks acks.
type Deployer struct {
	mu          sync.Mutex
	nr          NRClient
	dir         string
	coreVersion string
	registry    func() entities.Registry
	identity    func() Identity

	applied     []cloud.AppliedFlow
	current     *Deployment
	lastPayload []byte
	palVersion  string
	palFetched  time.Time
}

// NewDeployer builds the deployer (nothing applied yet).
func NewDeployer(d Deps) *Deployer {
	reg := d.Registry
	if reg == nil {
		reg = func() entities.Registry { return entities.Registry{} }
	}
	id := d.Identity
	if id == nil {
		id = func() Identity { return Identity{} }
	}
	return &Deployer{nr: d.NR, dir: d.DataDir, coreVersion: d.CoreVersion,
		registry: reg, identity: id}
}

// paletteVersion queries (and caches) the installed vp-palette version from
// the Node-RED admin API.
func (dep *Deployer) paletteVersion() (string, error) {
	if dep.nr == nil {
		return "", errors.New("Flow-Runtime nicht konfiguriert (VP_NODERED_ADMIN_URL)")
	}
	if dep.palVersion != "" && time.Since(dep.palFetched) < 5*time.Minute {
		return dep.palVersion, nil
	}
	v, err := dep.nr.PaletteVersion()
	if err != nil {
		return "", err
	}
	dep.palVersion, dep.palFetched = v, time.Now()
	return v, nil
}

// HandleDeployment ingests one retained …/v2/flows payload. An EMPTY payload
// clears every artifact tab (retained-clear). The full desired-state set is
// applied per artifact; acks land in Summary().
func (dep *Deployer) HandleDeployment(payload []byte) {
	dep.mu.Lock()
	defer dep.mu.Unlock()
	if len(payload) == 0 {
		dep.current = &Deployment{}
		dep.lastPayload = nil
		dep.persistLocked(nil)
		dep.applyLocked()
		return
	}
	d, err := ParseDeployment(payload, dep.identity())
	if err != nil {
		slog.Warn("flow deployment rejected", "err", err)
		return
	}
	dep.current = d
	dep.lastPayload = payload
	dep.persistLocked(payload)
	dep.applyLocked()
}

// Reconcile re-applies the current (or persisted) deployment - the self-heal
// half of the reseed contract (§4): dropped artifact tabs are restored from
// truth. Safe to call periodically; it only writes on drift.
func (dep *Deployer) Reconcile() {
	dep.mu.Lock()
	defer dep.mu.Unlock()
	if dep.current == nil {
		dep.loadPersistedLocked()
	}
	if dep.current == nil {
		return
	}
	dep.applyLocked()
}

// Summary returns the heartbeat flows block (nil until a deployment was seen).
func (dep *Deployer) Summary() *cloud.FlowsSummary {
	dep.mu.Lock()
	defer dep.mu.Unlock()
	if dep.current == nil {
		return nil
	}
	sum := &cloud.FlowsSummary{
		CoreVersion: dep.coreVersion,
		Applied:     append([]cloud.AppliedFlow(nil), dep.applied...),
	}
	if sum.Applied == nil {
		sum.Applied = []cloud.AppliedFlow{}
	}
	sum.PaletteVersion = dep.palVersion
	return sum
}

// applyLocked converges the Node-RED runtime to the current set via ONE
// full-config roundtrip: fetch the running config, drop every @vp-flow tab
// (and its nodes), append the verified artifacts' bundles with their
// DETERMINISTIC ids, and POST it back with deployment type 'flows' (only
// changed flows restart - vendor tabs keep running). The per-flow API is
// deliberately NOT used: POST /flow ignores client-supplied flow ids, which
// breaks redeploy-replaces AND the marker-based sweep (caught live by the
// September-Gate rig).
func (dep *Deployer) applyLocked() {
	d := dep.current
	acks := make([]cloud.AppliedFlow, 0, len(d.Artifacts))
	verified := make([]Artifact, 0, len(d.Artifacts))
	ackIdx := map[string]int{}
	for i, a := range d.Artifacts {
		ack := cloud.AppliedFlow{FlowID: a.FlowID, FlowVersion: a.FlowVersion, ContentHash: a.ContentHash}
		state, detail := dep.verifyArtifact(a, d.rawArtifacts[i])
		switch {
		case state != "active":
			ack.State, ack.Detail = state, detail
		case dep.nr == nil:
			ack.State = "error"
			ack.Detail = "Flow-Runtime nicht konfiguriert (VP_NODERED_ADMIN_URL)"
		default:
			ack.State = "active"
			verified = append(verified, a)
		}
		ackIdx[a.FlowID] = len(acks)
		acks = append(acks, ack)
	}
	if dep.nr != nil {
		if err := dep.converge(verified); err != nil {
			slog.Warn("flow-runtime convergence failed", "err", err)
			for _, a := range verified {
				acks[ackIdx[a.FlowID]].State = "error"
				acks[ackIdx[a.FlowID]].Detail = "Übernahme in die Flow-Runtime fehlgeschlagen: " + err.Error()
			}
		}
	}
	dep.applied = acks
}

// converge performs the full-config merge; a no-op when the runtime already
// carries exactly the desired artifact nodes (no redeploy churn).
func (dep *Deployer) converge(artifacts []Artifact) error {
	existing, err := dep.nr.GetFlows()
	if err != nil {
		return err
	}
	// Identify @vp-flow tabs currently in the runtime + their nodes.
	artifactTabIDs := map[string]bool{}
	for _, raw := range existing {
		var n tabNode
		if json.Unmarshal(raw, &n) == nil && n.Type == "tab" && strings.HasPrefix(n.Info, OwnershipMarker) {
			artifactTabIDs[n.ID] = true
		}
	}
	kept := make([]json.RawMessage, 0, len(existing))
	current := map[string]json.RawMessage{}
	for _, raw := range existing {
		var n tabNode
		_ = json.Unmarshal(raw, &n)
		if artifactTabIDs[n.ID] || (n.Z != "" && artifactTabIDs[n.Z]) {
			current[n.ID] = raw
			continue
		}
		kept = append(kept, raw)
	}
	// The desired artifact node set (deterministic ids).
	desired := map[string]json.RawMessage{}
	var appendix []json.RawMessage
	for _, a := range artifacts {
		for _, raw := range a.Bundle.NoderedFlows {
			var n tabNode
			_ = json.Unmarshal(raw, &n)
			desired[n.ID] = raw
			appendix = append(appendix, raw)
		}
	}
	if sameNodeSet(current, desired) {
		return nil // converged - nothing to deploy
	}
	slog.Info("deploying flow artifacts to the runtime",
		"artifacts", len(artifacts), "replacing_nodes", len(current), "with_nodes", len(desired))
	return dep.nr.PostFlows(append(kept, appendix...))
}

// sameNodeSet compares two node maps on canonical bytes.
func sameNodeSet(a, b map[string]json.RawMessage) bool {
	if len(a) != len(b) {
		return false
	}
	for id, rawA := range a {
		rawB, ok := b[id]
		if !ok {
			return false
		}
		ca, errA := Canonicalize(rawA)
		cb, errB := Canonicalize(rawB)
		if errA != nil || errB != nil || string(ca) != string(cb) {
			return false
		}
	}
	return true
}

// --- persistence ------------------------------------------------------------

func (dep *Deployer) persistPath() string {
	return filepath.Join(dep.dir, "flows-deployment.json")
}

func (dep *Deployer) persistLocked(payload []byte) {
	if dep.dir == "" {
		return
	}
	if payload == nil {
		if err := os.Remove(dep.persistPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Warn("flow deployment not cleared on disk", "err", err)
		}
		return
	}
	tmp := dep.persistPath() + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o644); err != nil {
		slog.Warn("flow deployment not persisted", "err", err)
		return
	}
	if err := os.Rename(tmp, dep.persistPath()); err != nil {
		slog.Warn("flow deployment not persisted", "err", err)
	}
}

func (dep *Deployer) loadPersistedLocked() {
	if dep.dir == "" {
		return
	}
	raw, err := os.ReadFile(dep.persistPath())
	if err != nil {
		return
	}
	d, err := ParseDeployment(raw, dep.identity())
	if err != nil {
		slog.Warn("persisted flow deployment unreadable", "err", err)
		return
	}
	dep.current = d
	dep.lastPayload = raw
}
