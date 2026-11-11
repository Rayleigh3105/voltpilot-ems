package inverter

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// ChannelSet is the output set of ONE shelly_http device over several switch
// outputs, in the order the driver block names them (L1, L2, L3 of a heating
// rod). It is a comparable value on purpose - sources.Source is compared with
// == - so it lives as the canonical text "0,1,2" and travels as the JSON array
// the driver block carries ([0,1,2]).
type ChannelSet string

// ChannelSetOf renders a list as the canonical set ("" for an empty list).
func ChannelSetOf(chs []int) ChannelSet {
	parts := make([]string, len(chs))
	for i, ch := range chs {
		parts[i] = strconv.Itoa(ch)
	}
	return ChannelSet(strings.Join(parts, ","))
}

// Ints returns the outputs in their order (nil for an empty set).
func (s ChannelSet) Ints() []int {
	if s == "" {
		return nil
	}
	parts := strings.Split(string(s), ",")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil // never produced by UnmarshalJSON/ChannelSetOf
		}
		out = append(out, n)
	}
	return out
}

// Problem names what is wrong with the set for a Shelly ("" = fine): at most
// four outputs, each 0-3, none twice.
func (s ChannelSet) Problem() string {
	chs := s.Ints()
	if len(chs) > 4 {
		return "Ein Gerät umfasst höchstens vier Ausgänge."
	}
	seen := map[int]bool{}
	for _, ch := range chs {
		if ch < 0 || ch > 3 {
			return "Der Schaltkanal muss zwischen 0 und 3 liegen."
		}
		if seen[ch] {
			return fmt.Sprintf("Ausgang %d steht zweimal in der Ausgangsmenge.", ch)
		}
		seen[ch] = true
	}
	return ""
}

// MarshalJSON writes the set as the array of outputs.
func (s ChannelSet) MarshalJSON() ([]byte, error) {
	chs := s.Ints()
	if chs == nil {
		chs = []int{}
	}
	return json.Marshal(chs)
}

// UnmarshalJSON reads the array of outputs (null or [] = no set).
func (s *ChannelSet) UnmarshalJSON(b []byte) error {
	var chs []int
	if err := json.Unmarshal(b, &chs); err != nil {
		return fmt.Errorf("channels: eine Liste von Ausgängen erwartet: %w", err)
	}
	*s = ChannelSetOf(chs)
	return nil
}
