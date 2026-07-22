package entities

// Local composition of the COMPOSED v2 entities (M-B3-local).
//
// A v1→v2 migrated plant gets its entity registry pushed by the cloud, but its
// Layer-1 flows still publish ONE composite site sample on edge/telemetry -
// nothing on the device produces per-entity telemetry. Cloud-side that gap is
// closed by the timescale-writer's ComposedEntityFanout; on the device the
// :8484 dashboard flipped to the entity-driven tiles and read "wartet auf
// Daten". ComposeLocal is the LOCAL twin of that fan-out: it derives the
// composed entities' channels from the site sample so the device's OWN view
// has values again.
//
// Boundary (deliberate, see the package doc of agent/entities.go): the result
// is DISPLAY-ONLY. It never enters the store-and-forward buffer and is never
// uplinked - the cloud already receives the v1 sample and fans it out itself,
// so uplinking here would double-write telemetry_v2.
//
// Channel map (byte-for-byte the fan-out's, report §3):
//
//	battery-hybrid   soc_pct          <- soc_pct
//	battery-hybrid   pv_power_kw      <- pv_power_kw
//	battery-hybrid   battery_power_kw <- power_kw - load_kw + pv_power_kw
//	grid-meter       power_kw         <- power_kw   (signed, +import/-export)
//	house-load       power_kw         <- load_kw
//
// An absent site channel produces NO entity value (never a fabricated 0); the
// derived battery power needs all three of its inputs. Only channels the
// entity actually DECLARES as a measure capability are composed, and only the
// composed types are touched - a producer entity is fed by its own source, a
// wallbox by its own driver.

// TypeHouseLoad is the composed house-consumption entity (catalog category
// consumer, controllable:false). It has no pinned guard semantics here - it is
// measure-only - so it lives next to the other composed type names.
const TypeHouseLoad = "house-load"

// composedTypes are the entity types the cloud composes from v1 master data
// and therefore the only ones this local twin may feed.
func composedType(t string) bool {
	switch t {
	case TypeBatteryHybrid, TypeGridMeter, TypeHouseLoad:
		return true
	}
	return false
}

// ComposeLocal derives the per-entity channel values of the registry's composed
// entities from one gated composite site sample. Entities with nothing
// derivable are omitted entirely.
func ComposeLocal(reg Registry, site map[string]float64) map[string]map[string]float64 {
	get := func(k string) *float64 {
		v, ok := site[k]
		if !ok {
			return nil
		}
		return &v
	}
	power, load, pv, soc := get("power_kw"), get("load_kw"), get("pv_power_kw"), get("soc_pct")

	// The documented v1 balance; needs all three inputs. With the house
	// standard (load = pv + grid - battery) this resolves to exactly the
	// hybrid's MEASURED battery register.
	var battery *float64
	if power != nil && load != nil && pv != nil {
		b := *power - *load + *pv
		battery = &b
	}

	out := map[string]map[string]float64{}
	for _, e := range reg.Entities {
		if !composedType(e.Type) {
			continue
		}
		vals := map[string]float64{}
		put := func(channel string, v *float64) {
			if v == nil || !e.declaresMeasure(channel) {
				return
			}
			vals[channel] = *v
		}
		switch e.Type {
		case TypeBatteryHybrid:
			put("soc_pct", soc)
			put("pv_power_kw", pv)
			put("battery_power_kw", battery)
		case TypeGridMeter:
			put("power_kw", power)
		case TypeHouseLoad:
			put("power_kw", load)
		}
		if len(vals) > 0 {
			out[e.ID] = vals
		}
	}
	return out
}

// declaresMeasure reports whether the entity declares the channel as a measure
// capability (the registry is the contract for what an entity reports).
func (e Entity) declaresMeasure(channel string) bool {
	for _, m := range e.Capabilities.Measure {
		if m.Channel == channel {
			return true
		}
	}
	return false
}
