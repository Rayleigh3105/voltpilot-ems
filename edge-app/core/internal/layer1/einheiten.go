package layer1

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// The multi-inverter search (makeProbeUnits of test-read.js): a Fronius
// Datamanager serves several inverters on ONE address, one Modbus unit id per
// inverter. A source with the default unit 1 reads only inverter 1 - so the
// add/test flow probes the same address for further unit ids. Bounded and read
// only: ONE connection, one 2-register FC3 read of the SunSpec marker "SunS"
// per (unit, base), a short timeout per id, a hard overall budget after which
// whatever was found is returned.
//
// A late answer to a timed-out probe is dropped by its transaction id (the
// scan keeps waiting for its own), which is why this does not use the
// modbustcp client: that one fails on a foreign transaction.

const (
	probeMaxUnitID      = 10
	probeIDTimeout      = 1500 * time.Millisecond
	probeOverallTimeout = 12 * time.Second
)

// probeBases are the SunSpec base addresses tried per unit id; once a unit
// answered at a base, the scan stays there (a Datamanager serves all its
// inverters at the same base).
var probeBases = []int{40000, 50000, 0}

// sidOutcome is one probe: the marker found, an exception (absent unit - try
// the next base), or silence (skip the remaining bases of this id).
type sidOutcome int

const (
	sidException sidOutcome = iota
	sidFound
	sidSilent
	sidOther
)

func (r *Runtime) probeIDWait() time.Duration {
	if r.opts.ProbeIDTimeout > 0 {
		return r.opts.ProbeIDTimeout
	}
	return probeIDTimeout
}

func (r *Runtime) probeOverall() time.Duration {
	if r.opts.ProbeOverallTimeout > 0 {
		return r.opts.ProbeOverallTimeout
	}
	return probeOverallTimeout
}

func (r *Runtime) probeUnits(ctx context.Context, req *testReadRequest) testReadResult {
	if !isSunSpecComm(req.Communication) {
		return testReadResult{ErrorCode: testconn.ErrInvalidRequest,
			Message: "Die Suche nach weiteren Wechselrichtern gibt es nur für SunSpec (Modbus TCP)."}
	}
	ip, _ := req.Connection["ip"].(string)
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return testReadResult{ErrorCode: testconn.ErrInvalidRequest, Message: "keine IP-Adresse"}
	}
	port := int(num(req.Connection["port"], 502))
	addr := netJoin(ip, port)
	release, ok := r.lanes.acquire(ctx, addr, r.opts.LaneWait)
	if !ok {
		return testReadResult{ErrorCode: testconn.ErrNoAnswer,
			Message: "Das Gerät ist gerade mit einer anderen Abfrage beschäftigt - bitte gleich noch einmal suchen."}
	}
	defer release()

	dctx, cancel := context.WithTimeout(ctx, r.opts.ConnectTimeout)
	conn, err := r.dialTCP(dctx, addr)
	cancel()
	if err != nil {
		return testReadResult{ErrorCode: testconn.ErrUnreachable}
	}
	defer conn.Close()
	deadline := time.Now().Add(r.probeOverall())
	found := []int{}
	var tid uint16
	bases := probeBases
	for unit := 1; unit <= probeMaxUnitID && time.Now().Before(deadline); unit++ {
		for _, base := range bases {
			tid++
			out, err := probeSID(conn, tid, byte(unit), base, r.probeIDWait(), deadline)
			if err != nil {
				// The connection is gone: what was found stands, otherwise the
				// address is unreachable (test-read.js: the socket's error).
				if len(found) > 0 {
					return testReadResult{OK: true, FoundUnits: found}
				}
				return testReadResult{ErrorCode: testconn.ErrUnreachable}
			}
			if out == sidFound {
				found = append(found, unit)
				bases = []int{base}
				break
			}
			if out == sidSilent {
				break
			}
		}
	}
	return testReadResult{OK: true, FoundUnits: found}
}

// probeSID sends one FC3 read of 2 registers at base for unit and waits for
// THIS transaction's answer until the per-id timeout (or the overall
// deadline); frames of other transactions are dropped.
func probeSID(conn net.Conn, tid uint16, unit byte, base int, wait time.Duration, overall time.Time) (sidOutcome, error) {
	req := make([]byte, 12)
	binary.BigEndian.PutUint16(req[0:], tid)
	binary.BigEndian.PutUint16(req[4:], 6)
	req[6], req[7] = unit, 0x03
	binary.BigEndian.PutUint16(req[8:], uint16(base))
	binary.BigEndian.PutUint16(req[10:], 2)
	until := time.Now().Add(wait)
	if overall.Before(until) {
		until = overall
	}
	_ = conn.SetDeadline(until)
	if _, err := conn.Write(req); err != nil {
		return sidOther, err
	}
	for {
		hdr := make([]byte, 6)
		if _, err := io.ReadFull(conn, hdr); err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				return sidSilent, nil
			}
			return sidOther, err
		}
		body := make([]byte, int(binary.BigEndian.Uint16(hdr[4:])))
		if _, err := io.ReadFull(conn, body); err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				return sidSilent, nil
			}
			return sidOther, err
		}
		if binary.BigEndian.Uint16(hdr[0:]) != tid {
			continue // a late answer to a timed-out probe
		}
		if len(body) < 2 || body[1]&0x80 != 0 || body[1] != 0x03 || len(body) < 7 || body[2] < 4 {
			return sidException, nil
		}
		if binary.BigEndian.Uint16(body[3:]) == 0x5375 && binary.BigEndian.Uint16(body[5:]) == 0x6e53 {
			return sidFound, nil
		}
		return sidOther, nil
	}
}
