package csms

import (
	"net"
	"net/netip"
	"sort"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
)

// OCPP "klopft an" (docs/contracts/ocpp-klopft-an.md): a charge point whose
// identity is not on the allowlist is refused - and now also remembered for
// 24 h, so the portal can show "Ladesäule klopft an" and admit it with one tap
// through the existing allowlist route. Nothing here admits anything: only a
// person does, and there is no learning window.
//
// The window lives in RAM: after a restart it starts empty. It holds only
// identities the allowlist could take (geraetesuche.KlopftAnKennung) - any
// other one could never be admitted - and at most klopfMax of them.

const klopfMax = 64

type klopfer struct {
	ip          string
	first, last time.Time
	attempts    int
}

type klopfListe struct {
	mu        sync.Mutex
	eintraege map[string]*klopfer
}

// merkeAbgewiesen records one refused connection attempt.
func (s *Server) merkeAbgewiesen(id, remoteAddr string, now time.Time) {
	if !geraetesuche.KlopftAnKennung(id) {
		return
	}
	ip := remoteAddr
	if h, _, err := net.SplitHostPort(remoteAddr); err == nil {
		ip = h
	}
	k := &s.klopfen
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.eintraege == nil {
		k.eintraege = map[string]*klopfer{}
	}
	k.vergiss(now)
	e, ok := k.eintraege[id]
	if !ok {
		if len(k.eintraege) >= klopfMax {
			k.verdraengeAeltesten()
		}
		e = &klopfer{first: now}
		k.eintraege[id] = e
	}
	e.ip, e.last = ip, now
	if e.attempts < geraetesuche.MaxKlopftAnVersuche {
		e.attempts++
	}
}

func (k *klopfListe) vergiss(now time.Time) {
	for id, e := range k.eintraege {
		if now.Sub(e.last) > geraetesuche.KlopftAnFenster {
			delete(k.eintraege, id)
		}
	}
}

func (k *klopfListe) verdraengeAeltesten() {
	alt := ""
	for id, e := range k.eintraege {
		if alt == "" || e.last.Before(k.eintraege[alt].last) {
			alt = id
		}
	}
	delete(k.eintraege, alt)
}

// KlopfenAn lists the charge points refused in the last 24 h, newest first,
// at most geraetesuche.MaxKlopftAn. An identity that is on the allowlist by
// now is gone. adresseZulassen decides whether the address of an entry may be
// reported (a private host address of the customer network, never the box's
// own, never the bridge of a container); otherwise the entry goes without it.
func (s *Server) KlopfenAn(now time.Time, adresseZulassen func(netip.Addr) bool) []geraetesuche.KlopftAn {
	s.mu.Lock()
	zugelassen := make(map[string]bool, len(s.chargers))
	for id := range s.chargers {
		zugelassen[id] = true
	}
	s.mu.Unlock()

	k := &s.klopfen
	k.mu.Lock()
	k.vergiss(now)
	out := make([]geraetesuche.KlopftAn, 0, len(k.eintraege))
	for id, e := range k.eintraege {
		if zugelassen[id] {
			continue
		}
		eintrag := geraetesuche.KlopftAn{ID: id, FirstSeen: e.first.UTC(), LastSeen: e.last.UTC(), Attempts: e.attempts}
		if a, err := netip.ParseAddr(e.ip); err == nil && adresseZulassen != nil && adresseZulassen(a.Unmap()) {
			eintrag.IP = a.Unmap().String()
		}
		out = append(out, eintrag)
	}
	k.mu.Unlock()
	sort.Slice(out, func(i, j int) bool {
		if !out[i].LastSeen.Equal(out[j].LastSeen) {
			return out[i].LastSeen.After(out[j].LastSeen)
		}
		return out[i].ID < out[j].ID
	})
	if len(out) > geraetesuche.MaxKlopftAn {
		out = out[:geraetesuche.MaxKlopftAn]
	}
	return out
}
