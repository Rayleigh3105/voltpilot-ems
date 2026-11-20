package messwerte

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// The device-side helpers of vp-measurements.js: the SunSpec model walk a
// target needs before its model-relative points have an address, and how an
// HTTP point names its request.

// LeseFunktion reads count holding registers from start of one target.
type LeseFunktion func(ctx context.Context, start, count int) ([]uint16, error)

// Erkenne is discoverSunSpec(): "SunS" at 40000, 50000 or 0, then the model
// chain (at most 256 models within 8192 words); model 160 gets its live module
// count. A failed header read is an error (the caller keeps no discovery); no
// marker at all is an empty discovery.
func Erkenne(ctx context.Context, lies LeseFunktion) (*Discovery, error) {
	for _, kandidat := range []int{40000, 50000, 0} {
		sid, err := lies(ctx, kandidat, 2)
		if err != nil || len(sid) < 2 || sid[0] != 0x5375 || sid[1] != 0x6e53 {
			continue
		}
		models := map[int]Modell{}
		address := kandidat + 2
		for i := 0; i < 256 && address-kandidat < 8192; i++ {
			header, err := lies(ctx, address, 2)
			if err != nil {
				return nil, err
			}
			if len(header) < 2 {
				break
			}
			id, length := int(header[0]), int(header[1])
			if id == 0xffff || length > 8192 {
				break
			}
			m := Modell{Base: address + 2, ModuleCount: -1}
			if id == 160 {
				if n, err := lies(ctx, m.Base+8, 1); err != nil {
					return nil, err
				} else if len(n) > 0 && 10+int(n[0])*20 <= length {
					m.ModuleCount = int(n[0])
				}
			}
			models[id] = m
			address += 2 + length
		}
		return &Discovery{Models: models}, nil
	}
	return &Discovery{Models: map[int]Modell{}}, nil
}

// JSONPfad is the request path of an HTTP point group, with the go-e filter.
func JSONPfad(points []*Punkt, filter, serial string) (string, error) {
	if len(points) == 0 {
		return "", errors.New("keine Punkte")
	}
	var pfad string
	switch points[0].SourceKind {
	case "http_api_key":
		pfad = "/api/status"
	case "rest_json":
		ep, err := jsonEndpoint(points[0].Selector, serial)
		if err != nil {
			return "", err
		}
		pfad = ep
	default:
		ep, err := jsonEndpoint(points[0].Selector, serial)
		if err != nil {
			return "", err
		}
		pfad = "/rpc/Shelly.GetStatus"
		if strings.HasPrefix(ep, "Shelly.GetDeviceInfo") {
			pfad = "/rpc/Shelly.GetDeviceInfo"
		}
	}
	if filter != "" {
		u, err := url.Parse(pfad)
		if err != nil {
			return "", err
		}
		q := u.Query()
		q.Set("filter", filter)
		u.RawQuery = q.Encode()
		pfad = u.String()
	}
	return pfad, nil
}

// jsonEndpoint is inverterJSONEndpoint(): the selector before '#', with
// {serial} filled (a KACO device answers nothing without it).
func jsonEndpoint(selector, serial string) (string, error) {
	ep, _, _ := strings.Cut(selector, "#")
	if !strings.Contains(ep, "{serial}") {
		return ep, nil
	}
	if serial == "" {
		return "", errors.New("keine Seriennummer")
	}
	return strings.ReplaceAll(ep, "{serial}", encodeURIComponent(serial)), nil
}

// encodeURIComponent escapes everything but A-Z a-z 0-9 - _ . ! ~ * ' ( ).
func encodeURIComponent(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// ShellyStatus is shapeShellyStatus(): a Shelly.GetStatus answer cut down to
// the component the group reads; a component per id becomes one answer per
// instance carrying its id.
func ShellyStatus(points []*Punkt, status any) []any {
	selector := ""
	if len(points) > 0 {
		selector = points[0].Selector
	}
	endpoint, _, _ := strings.Cut(selector, "#")
	method, _, _ := strings.Cut(endpoint, "?")
	if method == "Shelly.GetDeviceInfo" {
		return []any{status}
	}
	var prefixes []string
	for _, p := range strings.Split(strings.TrimSuffix(method, ".GetStatus"), "|") {
		prefixes = append(prefixes, strings.ToLower(p))
	}
	o, _ := status.(*Objekt)
	if strings.Contains(endpoint, "id=*") {
		out := []any{}
		if o == nil {
			return out
		}
		for _, key := range o.keys {
			split := strings.LastIndex(key, ":")
			prefix, rest := key, ""
			if split >= 0 {
				prefix, rest = key[:split], key[split+1:]
			}
			id := jsStringToNumber(rest)
			value, isObj := o.vals[key].(*Objekt)
			if !contains(prefixes, strings.ToLower(prefix)) || id != float64(int64(id)) || !isObj {
				continue
			}
			inst := &Objekt{vals: map[string]any{}}
			inst.set("id", id)
			for _, k := range value.keys {
				inst.set(k, value.vals[k])
			}
			out = append(out, inst)
		}
		return out
	}
	for _, p := range prefixes {
		if o != nil {
			if v, ok := o.vals[p]; ok {
				return []any{v}
			}
		}
	}
	return []any{status}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
