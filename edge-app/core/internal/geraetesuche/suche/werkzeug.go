package suche

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"syscall"
	"time"
)

// What a recogniser may do at a device, and nothing else (contract §3 "Nur
// lesen"): a paced TCP connection, an HTTP GET on a fixed path, a Modbus read
// with function code 3, a Solarman V5 read. There is no method that writes,
// logs in or sends a password - the read-only rule is the shape of this file.

var (
	errBudget  = errors.New("geraetesuche: recogniser budget spent")
	errNichtIm = errors.New("geraetesuche: target outside the search range")
)

// budget counts the requests ONE recogniser sends to one device.
type budget struct {
	g    *geraet
	rest int
}

func (g *geraet) budget() *budget { return &budget{g: g, rest: AnfragenJeErkenner} }

func (b *budget) nimm() error {
	if b.rest <= 0 {
		return errBudget
	}
	b.rest--
	return nil
}

// verbinde opens one paced TCP connection to the device. Every connection of
// the search takes its slot here or, for an HTTP request, in get; the range
// rule is checked again at the opener, oeffne (the address of an SSDP answer,
// too).
func (l *Lauf) verbinde(ctx context.Context, ip netip.Addr, port int) (net.Conn, error) {
	if probeZiel(ip, l.bereiche) != "" {
		return nil, errNichtIm
	}
	if err := l.takt.warte(ctx); err != nil {
		return nil, err
	}
	return l.oeffne(ctx, ip, port)
}

// oeffne dials once the slot is taken: verbinde, and get for the one
// connection of its request.
func (l *Lauf) oeffne(ctx context.Context, ip netip.Addr, port int) (net.Conn, error) {
	if probeZiel(ip, l.bereiche) != "" {
		return nil, errNichtIm
	}
	dctx, cancel := context.WithTimeout(ctx, l.u.Takt.zeitlimit())
	defer cancel()
	return l.dial(dctx, netip.AddrPortFrom(ip, uint16(port)).String())
}

// portOffen is the gentle port check: connect, close at once. alive is true
// when the device answered at all (connected or refused).
func (l *Lauf) portOffen(ctx context.Context, ip netip.Addr, port int) (offen, alive bool) {
	c, err := l.verbinde(ctx, ip, port)
	if err == nil {
		_ = c.Close()
		return true, true
	}
	return false, errors.Is(err, syscall.ECONNREFUSED)
}

// ---------------------------------------------------------------- HTTP

const maxKoerper = 64 << 10

type antwort struct {
	status int
	header http.Header
	body   []byte
}

// get sends ONE GET on a fixed path, without credentials, without following a
// redirect, and reads at most 64 KiB.
//
// The device's first HTTP request is repeated once when no answer came in
// time or the connection broke (VoltPilotGATE 30.10.2026: the Shelly Pro 3 at
// -80 dBm missed one search of three with port 80 open). The repeat is a
// request of the recogniser's budget and opens its connection through the
// pacer; an answer - whatever it says - is never repeated, and neither is a
// later request of the device, so the chain of a port does not double.
func (b *budget) get(ctx context.Context, port int, pfad string) (antwort, error) {
	if err := b.nimm(); err != nil {
		return antwort{}, err
	}
	l := b.g.lauf
	a, err := l.get(ctx, b.g.ip, port, pfad)
	erste := !b.g.httpGefragt
	b.g.httpGefragt = true
	if err == nil || !erste || ctx.Err() != nil || !abgerissen(err) {
		return a, err
	}
	if b.nimm() != nil || !ruhe(ctx, httpPause(l.u.Takt)) {
		return antwort{}, err
	}
	return l.get(ctx, b.g.ip, port, pfad)
}

// httpPause is the wait before the repeat of the first HTTP request (1 s).
func httpPause(t Takt) time.Duration { return t.zeitlimit() * 2 / 3 }

// abgerissen: no answer in time, or the connection broke before the answer
// was read. A refused connection is the device's answer, not a lost one.
func abgerissen(err error) bool {
	var ne net.Error
	switch {
	case errors.Is(err, errBudget), errors.Is(err, errNichtIm), errors.Is(err, syscall.ECONNREFUSED):
		return false
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF),
		errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.EPIPE):
		return true
	}
	return errors.As(err, &ne) && ne.Timeout()
}

func (l *Lauf) get(ctx context.Context, ip netip.Addr, port int, pfad string) (antwort, error) {
	if probeZiel(ip, l.bereiche) != "" {
		return antwort{}, errNichtIm
	}
	// The request opens exactly one connection (no keep-alive): its slot is
	// taken here, so that Zeitlimit bounds the request and not the wait for
	// the slot - with 32 devices at 20 connections a second the slot can be
	// further away than Zeitlimit.
	if err := l.takt.warte(ctx); err != nil {
		return antwort{}, err
	}
	rctx, cancel := context.WithTimeout(ctx, l.u.Takt.zeitlimit())
	defer cancel()
	host := ip.String()
	if port != 80 {
		host += ":" + strconv.Itoa(port)
	}
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, "http://"+host+pfad, nil)
	if err != nil {
		return antwort{}, err
	}
	req.Header.Set("User-Agent", "VoltPilot-Geraetesuche/1.0")
	req.Header.Set("Accept", "application/json, text/html;q=0.9, */*;q=0.5")
	resp, err := l.http.Do(req)
	if err != nil {
		return antwort{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxKoerper))
	if err != nil {
		return antwort{}, err
	}
	return antwort{status: resp.StatusCode, header: resp.Header, body: body}, nil
}

func (l *Lauf) neuerHTTPClient() *http.Client {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			ap, err := netip.ParseAddrPort(addr)
			if err != nil {
				return nil, err
			}
			return l.oeffne(ctx, ap.Addr(), int(ap.Port()))
		},
		DisableKeepAlives:      true,
		DisableCompression:     true,
		MaxResponseHeaderBytes: 16 << 10,
		ResponseHeaderTimeout:  l.u.Takt.zeitlimit(),
	}
	return &http.Client{
		Transport: tr,
		// A redirect leads to a page the box did not choose: the answer to the
		// fixed path is the answer.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// ---------------------------------------------------------------- Modbus TCP, FC 3 only

// modbusAusnahme is a Modbus exception reply: the device is there, the
// register is not.
type modbusAusnahme struct{ code byte }

func (e *modbusAusnahme) Error() string { return fmt.Sprintf("modbus exception 0x%02x", e.code) }

// modbus is the ONE Modbus connection to a device port, shared by the
// recognisers of that port one after the other. It can only read holding
// registers: the function code is a constant.
type modbus struct {
	g    *geraet
	port int
	c    net.Conn
	tid  uint16
}

func (g *geraet) modbus(port int) *modbus { return &modbus{g: g, port: port} }

func (m *modbus) schliesse() {
	if m.c != nil {
		_ = m.c.Close()
		m.c = nil
	}
}

// lies reads count holding registers (FC 3) at addr of unit, as one request
// of the recogniser's budget. A timeout or a broken stream closes the
// connection: a late reply must never be read as the next request's answer.
func (m *modbus) lies(ctx context.Context, b *budget, unit byte, addr, count uint16) ([]uint16, error) {
	if count == 0 || count > 125 {
		return nil, fmt.Errorf("modbus: %d registers", count)
	}
	if err := b.nimm(); err != nil {
		return nil, err
	}
	if m.c == nil {
		c, err := m.g.lauf.verbinde(ctx, m.g.ip, m.port)
		if err != nil {
			return nil, err
		}
		m.c = c
	}
	m.tid++
	adu := make([]byte, 12)
	binary.BigEndian.PutUint16(adu[0:], m.tid)
	binary.BigEndian.PutUint16(adu[4:], 6)
	adu[6] = unit
	adu[7] = 0x03
	binary.BigEndian.PutUint16(adu[8:], addr)
	binary.BigEndian.PutUint16(adu[10:], count)
	frist := time.Now().Add(m.g.lauf.u.Takt.zeitlimit())
	if d, ok := ctx.Deadline(); ok && d.Before(frist) {
		frist = d
	}
	_ = m.c.SetDeadline(frist)
	regs, err := m.austausch(adu, unit, count)
	if err != nil {
		var ausnahme *modbusAusnahme
		if !errors.As(err, &ausnahme) {
			m.schliesse()
		}
		return nil, err
	}
	return regs, nil
}

func (m *modbus) austausch(adu []byte, unit byte, count uint16) ([]uint16, error) {
	if _, err := m.c.Write(adu); err != nil {
		return nil, err
	}
	kopf := make([]byte, 7)
	if _, err := io.ReadFull(m.c, kopf); err != nil {
		return nil, err
	}
	if binary.BigEndian.Uint16(kopf[0:]) != m.tid || binary.BigEndian.Uint16(kopf[2:]) != 0 {
		return nil, errors.New("modbus: foreign transaction")
	}
	n := int(binary.BigEndian.Uint16(kopf[4:]))
	if n < 3 || n > 254 {
		return nil, fmt.Errorf("modbus: length %d", n)
	}
	rumpf := make([]byte, n-1)
	if _, err := io.ReadFull(m.c, rumpf); err != nil {
		return nil, err
	}
	if kopf[6] != unit {
		return nil, errors.New("modbus: foreign unit")
	}
	switch {
	case rumpf[0] == 0x83:
		return nil, &modbusAusnahme{code: rumpf[1]}
	case rumpf[0] != 0x03 || int(rumpf[1]) != 2*int(count) || len(rumpf) < 2+2*int(count):
		return nil, errors.New("modbus: malformed reply")
	}
	regs := make([]uint16, count)
	for i := range regs {
		regs[i] = binary.BigEndian.Uint16(rumpf[2+2*i:])
	}
	return regs, nil
}
