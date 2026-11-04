package verbraucherregel

import (
	"math"
	"regexp"
	"time"
	"unicode/utf16"
)

// The desired contract of the local bus (vp-desired.js).
const (
	desiredSchemaVersion = "1.0"
	// TopicPrefix is the entity namespace of the local bus.
	TopicPrefix = "edge/entities/"
	// TopicSite is the composite telemetry of the box.
	TopicSite = "edge/telemetry"
)

var (
	idRE     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	commands = map[string]bool{"setpoint_kw": true, "on_off": true, "limit_pct": true,
		"limit_kw": true, "mode": true}
)

// Config is the compiled config of ONE vp-consumer-policy node, as decoded
// from the artifact bundle (field names as flowc writes them).
type Config map[string]any

func (c Config) get(k string) (any, bool) { v, ok := c[k]; return v, ok }

// truthy is JavaScript truthiness for a decoded JSON value.
func truthy(v any, present bool) bool {
	if !present {
		return false
	}
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

// SiteSignals maps one composite edge/telemetry payload onto the site
// channels (siteSignals): the surplus only when BOTH pv and load were
// measured - never a fabricated 0.
func SiteSignals(obj any) map[string]float64 {
	m, ok := obj.(map[string]any)
	out := map[string]float64{}
	if !ok {
		return out
	}
	num := func(k string) (float64, bool) {
		f, ok := m[k].(float64)
		if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
			return 0, false
		}
		return f, true
	}
	if soc, ok := num("soc_pct"); ok {
		out["soc_pct"] = soc
	}
	if grid, ok := num("power_kw"); ok {
		out["grid_power_kw"] = grid
	}
	pv, okPV := num("pv_power_kw")
	load, okLoad := num("load_kw")
	if okPV && okLoad {
		out["pv_surplus_kw"] = pv - load
	}
	return out
}

// EntitySignals keeps the numeric channels of the entity's own telemetry
// (entitySignals): a boolean-typed value is deliberately dropped.
func EntitySignals(entity string, obj any) map[string]float64 {
	out := map[string]float64{}
	m, ok := obj.(map[string]any)
	if !ok {
		return out
	}
	if sv, _ := m["schema_version"].(string); sv != "1.0" {
		return out
	}
	if id, _ := m["entity_id"].(string); id != entity {
		return out
	}
	channels, ok := m["channels"].(map[string]any)
	if !ok {
		return out
	}
	for k, v := range channels {
		if f, ok := v.(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
			out[k] = f
		}
	}
	return out
}

// Step is the outcome of one runtime event: the engine verdict, the desired
// to publish now (nil = nothing) and whether a due publish had no usable value.
type Step struct {
	Result   Result
	Publish  map[string]any
	Unusable bool
}

// Runtime is ONE generated node (consumer-policy-runtime.js Runtime).
type Runtime struct {
	entity          string
	command         any
	hasCommand      bool
	cfg             Config
	engine          *Engine
	lastFingerprint *string
}

// NewRuntime builds the runtime of one node config.
func NewRuntime(cfg Config) *Runtime {
	ent, hasEnt := cfg.get("entity")
	entity := ""
	if truthy(ent, hasEnt) {
		entity = jsString(ent, true)
	}
	cmd, hasCmd := cfg.get("command")
	cmdStr, _ := cmd.(string)
	od, hasOD := cfg.get("off_delay_s")
	offDelay := jsNumber(od, hasOD)
	if math.IsNaN(offDelay) {
		offDelay = 0
	}
	reqs, _ := cfg["requirements"].([]any)
	return &Runtime{
		entity:     entity,
		command:    cmd,
		hasCommand: hasCmd,
		cfg:        cfg,
		engine:     NewEngine(Spec{Command: cmdStr, OffDelayS: offDelay, Requirements: reqs}),
	}
}

// Entity is the entity the rule addresses.
func (r *Runtime) Entity() string { return r.entity }

// nodeID is config.nodeId || config.id.
func (r *Runtime) nodeID() (any, bool) {
	if v, ok := r.cfg.get("nodeId"); truthy(v, ok) {
		return v, true
	}
	return r.cfg.get("id")
}

// Shape is vp-desired's shape(): the desired payload, or nil when the config
// or value cannot form one.
func (r *Runtime) shape(override bool, value any, hasValue bool, nowMs int64) map[string]any {
	if !idRE.MatchString(r.entity) {
		return nil
	}
	cmd, ok := r.command.(string)
	if !ok || !commands[cmd] {
		return nil
	}
	ttlRaw, hasTTL := r.cfg.get("ttl_s")
	ttl := math.Floor(jsNumber(ttlRaw, hasTTL))
	if !(ttl >= 1 && ttl <= 86400) {
		return nil
	}
	flowID, hasFlow := r.cfg.get("flowId")
	fvRaw, hasFV := r.cfg.get("flowVersion")
	flowVersion := jsNumber(fvRaw, hasFV)
	nodeID, hasNode := r.nodeID()
	if !truthy(flowID, hasFlow) || !(flowVersion >= 1) || !truthy(nodeID, hasNode) {
		return nil
	}

	v := value
	if !hasValue {
		v = nil
	}
	switch cmd {
	case "setpoint_kw", "limit_kw", "limit_pct":
		var f float64
		switch x := v.(type) {
		case string:
			f = jsNumber(x, true)
		case float64:
			f = x
		default:
			return nil
		}
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil
		}
		if cmd == "limit_kw" && f < 0 {
			return nil
		}
		if cmd == "limit_pct" && (f < 0 || f > 100) {
			return nil
		}
		v = f
	case "on_off":
		if f, ok := v.(float64); ok {
			v = f != 0
		}
		if _, ok := v.(bool); !ok {
			return nil
		}
	case "mode":
		s, ok := v.(string)
		if !ok {
			return nil
		}
		if n := len(utf16.Encode([]rune(s))); n < 1 || n > 64 {
			return nil
		}
	}
	payload := map[string]any{
		"schema_version": desiredSchemaVersion,
		"entity_id":      r.entity,
		"request_id":     jsString(nodeID, true) + ":" + jsString(v, true),
		"source": map[string]any{
			"kind":         "flow",
			"flow_id":      flowID,
			"flow_version": flowVersion,
			"node_id":      nodeID,
		},
		"priority":  "flow",
		"command":   map[string]any{"type": cmd, "value": v},
		"ttl_s":     ttl,
		"issued_at": time.UnixMilli(nowMs).UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	if override {
		payload["override"] = true
	}
	return payload
}

func (r *Runtime) evaluate(fromTrigger bool, nowMs int64) Step {
	res := r.engine.Evaluate(nowMs)
	step := Step{Result: res}
	if res.Active {
		payload := r.shape(res.MustRun, res.Value, res.HasValue, nowMs)
		var fp *string
		if payload != nil {
			s := payload["request_id"].(string) + "|" + jsString(res.MustRun, true)
			fp = &s
		}
		changed := (fp == nil) != (r.lastFingerprint == nil) ||
			(fp != nil && r.lastFingerprint != nil && *fp != *r.lastFingerprint)
		if fromTrigger || changed {
			if payload != nil {
				step.Publish = payload
				r.lastFingerprint = fp
			} else {
				step.Unusable = true
			}
		}
	} else {
		r.lastFingerprint = nil
	}
	return step
}

// OnSite handles a composite edge/telemetry message (react immediately).
func (r *Runtime) OnSite(obj any, nowMs int64) Step {
	for k, v := range SiteSignals(obj) {
		r.engine.UpdateSignal("site", k, v, nowMs)
	}
	return r.evaluate(false, nowMs)
}

// OnEntity handles the entity's own telemetry message (react immediately).
func (r *Runtime) OnEntity(obj any, nowMs int64) Step {
	for k, v := range EntitySignals(r.entity, obj) {
		r.engine.UpdateSignal("entity", k, v, nowMs)
	}
	return r.evaluate(false, nowMs)
}

// OnTrigger handles the compiled interval trigger (renewal + staleness check).
func (r *Runtime) OnTrigger(nowMs int64) Step { return r.evaluate(true, nowMs) }
