package suche

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/deyedecode"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ebyte"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
)

// erkenneSolarman: a Solarman logger answers a V5 frame with logger serial 0
// and names its own serial in the reply header - no prior knowledge needed
// (Discovery 30.10.2026). The second frame carries that serial and reads the
// Deye type (0x0000, HV/LV) and serial (0x0003-0x0007): FC 3 on 0x0000-0x0007,
// nothing else. The logger serves ONE client: one short session, replies
// checked against the request (on 30.10. the first answer was a foreign
// 118-byte frame), and on Edge Light the Layer-1 logger lane is taken first.
func erkenneSolarman(ctx context.Context, g *geraet, port int, _ *modbus) (geraetesuche.Fund, bool) {
	l := g.lauf
	if l.u.Spur != nil {
		release, ok := l.u.Spur(ctx, netip.AddrPortFrom(g.ip, uint16(port)).String())
		if !ok {
			return geraetesuche.Fund{}, false
		}
		defer release()
	}
	b := g.budget()
	c, err := l.verbinde(ctx, g.ip, port)
	if err != nil {
		return geraetesuche.Fund{}, false
	}
	defer c.Close()

	seq := zufallSeq()
	serial, regs, err := v5Lesen(ctx, c, b, 0, seq, l.u.Takt.zeitlimit())
	if err != nil || serial == 0 {
		return geraetesuche.Fund{}, false
	}
	if regs == nil {
		_, regs, _ = v5Lesen(ctx, c, b, serial, seq+1, l.u.Takt.zeitlimit())
	}
	unit := 1
	logger := strconv.FormatUint(uint64(serial), 10)
	f := geraetesuche.Fund{Schluessel: "solarman:" + logger, Erkenner: "solarman", Art: "wechselrichter",
		Erkennung: geraetesuche.ErkennungWahrscheinlich, Merkmale: []string{"v5_kopf_seriennummer"},
		Verbindung: geraetesuche.Verbindung{Communication: "solarman_v5", IP: g.ip.String(), Port: port,
			Serial: &serial, UnitID: &unit}}
	if len(regs) >= 8 {
		// The inverter answered through the logger: that is the self-report.
		f.Erkennung = geraetesuche.ErkennungSicher
		// The type code names the voltage class and the family (the API offers
		// only the templates of that family); deye_typ_0x.... is the merkmal
		// of both. A code outside the source's lists names neither.
		klasse, mitKlasse := deyedecode.Spannungsklasse(regs[0])
		familie, mitFamilie := deyedecode.FamilieAusTyp(regs[0])
		if mitKlasse || mitFamilie {
			f.Hersteller, f.Spannung, f.Familie = "deye", klasse, familie
			f.Merkmale = append(f.Merkmale, fmt.Sprintf("deye_typ_0x%04x", regs[0]))
		}
		if sn := seriennr(regText(regs[3:8])); sn != "" {
			f.Seriennummer = sn
			f.Merkmale = append(f.Merkmale, "deye_seriennummer_0x0003")
		}
	}
	return f, true
}

func zufallSeq() uint16 {
	var b [2]byte
	_, _ = rand.Read(b[:])
	return binary.LittleEndian.Uint16(b[:])
}

// v5Lesen sends ONE read frame (FC 3, 0x0000, 8 registers) with the given
// logger serial and reads frames until the reply to THIS request arrives:
// control code 0x1510 and the low byte of our sequence. Every other frame is
// skipped. It returns the logger serial from the reply header and, when the
// inverter answered, the registers.
func v5Lesen(ctx context.Context, c net.Conn, b *budget, serial uint32, seq uint16, zeitlimit time.Duration) (uint32, []uint16, error) {
	if err := b.nimm(); err != nil {
		return 0, nil, err
	}
	frist := time.Now().Add(zeitlimit)
	if d, ok := ctx.Deadline(); ok && d.Before(frist) {
		frist = d
	}
	_ = c.SetDeadline(frist)
	if _, err := c.Write(solarmanv5.BuildReadRequest(serial, seq, 1, 0x0000, 8)); err != nil {
		return 0, nil, err
	}
	acc := make([]byte, 0, 512)
	buf := make([]byte, 512)
	for {
		for {
			n, ok, err := solarmanv5.ExpectedFrameLength(acc)
			if err != nil {
				return 0, nil, err
			}
			if !ok || len(acc) < n {
				break
			}
			if n > 4096 {
				return 0, nil, errors.New("solarman: frame too long")
			}
			frame := acc[:n]
			acc = append([]byte(nil), acc[n:]...)
			kopfSerial, passt := v5Antwort(frame, seq)
			if !passt {
				continue
			}
			regs, err := solarmanv5.ReadRegistersFromResponse(frame, solarmanv5.ParseOpts{})
			if err != nil || len(regs) < 8 {
				return kopfSerial, nil, nil
			}
			return kopfSerial, regs[:8], nil
		}
		m, err := c.Read(buf)
		if m > 0 {
			acc = append(acc, buf[:m]...)
			continue
		}
		if err != nil {
			return 0, nil, err
		}
	}
}

// v5Antwort checks a whole frame (start, end, checksum) and whether it is the
// reply to our sequence; it returns the logger serial of its header.
func v5Antwort(f []byte, seq uint16) (uint32, bool) {
	if len(f) < 13 || f[0] != solarmanv5.Start || f[len(f)-1] != solarmanv5.End ||
		solarmanv5.Checksum(f) != f[len(f)-2] {
		return 0, false
	}
	if binary.LittleEndian.Uint16(f[3:]) != solarmanv5.ControlResponse || f[5] != byte(seq) {
		return 0, false
	}
	return binary.LittleEndian.Uint32(f[7:]), true
}

// ebyteModul is the relay count of an M31 model code.
func ebyteModul(modell string) (int, bool) {
	m, ok := ebyte.ParseModule(modell)
	if !ok {
		return 0, false
	}
	return m.DO, true
}
