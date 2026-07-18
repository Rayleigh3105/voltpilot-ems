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

// applyLocked converges the Node-RED runtime to the current set.
func (dep *Deployer) applyLocked() {
	d := dep.current
	acks := make([]cloud.AppliedFlow, 0, len(d.Artifacts))
	desiredTabs := map[string]bool{}
	for i, a := range d.Artifacts {
		ack := cloud.AppliedFlow{FlowID: a.FlowID, FlowVersion: a.FlowVersion, ContentHash: a.ContentHash}
		state, detail := dep.verifyArtifact(a, d.rawArtifacts[i])
		if state != "active" {
			ack.State, ack.Detail = state, detail
			acks = append(acks, ack)
			continue
		}
		if dep.nr == nil {
			ack.State = "error"
			ack.Detail = "Flow-Runtime nicht konfiguriert (VP_NODERED_ADMIN_URL)"
			acks = append(acks, ack)
			continue
		}
		if err := dep.materialize(a); err != nil {
			ack.State = "error"
			ack.Detail = "Übernahme in die Flow-Runtime fehlgeschlagen: " + err.Error()
			acks = append(acks, ack)
			continue
		}
		for _, id := range a.Bundle.TabIDs {
			desiredTabs[id] = true
		}
		ack.State = "active"
		acks = append(acks, ack)
	}
	// Remove @vp-flow tabs the set no longer contains (undeploy / clear).
	if dep.nr != nil {
		if tabs, err := dep.nr.ListTabs(); err == nil {
			for _, t := range tabs {
				if strings.HasPrefix(t.Info, OwnershipMarker) && !desiredTabs[t.ID] {
					if err := dep.nr.DeleteFlow(t.ID); err != nil {
						slog.Warn("artifact tab removal failed", "tab", t.ID, "err", err)
					} else {
						slog.Info("artifact tab removed (not in deployment set)", "tab", t.ID)
					}
				}
			}
		} else {
			slog.Warn("flow-runtime tab listing failed", "err", err)
		}
	}
	dep.applied = acks
}

// materialize idempotently creates/updates each tab of one artifact via the
// per-flow Admin API (deterministic tab ids: redeploy replaces).
func (dep *Deployer) materialize(a Artifact) error {
	tabs, err := bundleTabs(a.Bundle)
	if err != nil {
		return err
	}
	nodesByTab := map[string][]json.RawMessage{}
	for _, raw := range a.Bundle.NoderedFlows {
		var n tabNode
		if err := json.Unmarshal(raw, &n); err != nil {
			return errors.New("Bundle-Knoten nicht lesbar")
		}
		if n.Type == "tab" {
			continue
		}
		if n.Z != "" {
			nodesByTab[n.Z] = append(nodesByTab[n.Z], raw)
		}
	}
	for _, tab := range tabs {
		flow := NRFlow{ID: tab.ID, Label: tab.Label, Info: tab.Info, Nodes: nodesByTab[tab.ID]}
		if flow.Nodes == nil {
			flow.Nodes = []json.RawMessage{}
		}
		existing, found, err := dep.nr.GetFlow(tab.ID)
		if err != nil {
			return err
		}
		if found {
			if sameFlow(existing, flow) {
				continue // already converged - no redeploy churn
			}
			if err := dep.nr.UpdateFlow(tab.ID, flow); err != nil {
				return err
			}
		} else {
			if err := dep.nr.CreateFlow(flow); err != nil {
				return err
			}
		}
	}
	return nil
}

// sameFlow compares the runtime's flow with the desired one on the canonical
// bytes of what we deploy (label, info, nodes).
func sameFlow(existing json.RawMessage, want NRFlow) bool {
	var have NRFlow
	if err := json.Unmarshal(existing, &have); err != nil {
		return false
	}
	norm := func(f NRFlow) string {
		f.ID = ""
		raw, _ := json.Marshal(f)
		c, err := Canonicalize(raw)
		if err != nil {
			return ""
		}
		return string(c)
	}
	a, b := norm(have), norm(want)
	return a != "" && a == b
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
