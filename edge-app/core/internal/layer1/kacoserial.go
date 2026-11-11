package layer1

import (
	"context"
	"errors"
	"strconv"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/kacoserial"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// KACO Powador (serial generation) behind a transparent RS485-to-Ethernet
// converter: the Go twin of the flow's "KACO seriell lesen" node (build-flows.js
// kacoSerialReadFunc) on top of kaco-serial-decode.js makeKacoSerialReader. ONE
// TCP raw socket per cycle (the converter serves one client), the request
// `#<adr>0\r`, the reply framed by length + CR or ended by the reply gap. The
// converter's address is a lane: poll and connection test never overlap.
//
// Read only - this device generation has no remote control at all.

// Defaults of the flow's reader (makeKacoSerialReader deps).
const (
	DefaultKacoTimeout  = 5 * time.Second
	DefaultKacoReplyGap = 300 * time.Millisecond
)

// The flow's warnFail text when a cycle yields no sample.
const kacoNoAnswer = "keine Antwort (Timeout, falsches Protokoll oder falsche Adresse)"

func (r *Runtime) kacoOpts() kacoserial.ReadOptions {
	return kacoserial.ReadOptions{Timeout: r.opts.KacoTimeout, ReplyGap: r.opts.KacoReplyGap}
}

// kacoLabel names the target like the flow: "ip:port Adresse n".
func kacoLabel(p *kacoSerialPlan) string { return p.Addr + " Adresse " + strconv.Itoa(p.Address) }

// pollKacoSerial is one tick of the self-wiring poll.
func (r *Runtime) pollKacoSerial(ctx context.Context, p *kacoSerialPlan) {
	release, ok := r.lanes.tryAcquire(p.Addr)
	if !ok {
		r.log.Debug("Wandler belegt - Lesen uebersprungen", "ziel", p.Addr)
		return
	}
	defer release()

	raw, err := kacoserial.Read(ctx, r.dialTCP, p.Addr, p.Address, r.kacoOpts())
	if err != nil {
		r.noteError(p.Addr, "KACO seriell ("+kacoLabel(p)+"): "+kacoNoAnswer+": "+err.Error())
		return
	}
	res := kacoserial.Decode(raw, false)
	if res == nil {
		why := kacoNoAnswer
		if c, ok := kacoserial.ReplyCommandByte(raw); ok && kacoserial.ProtocolMismatch(raw) {
			why = "Kommando-Byte " + strconv.Quote(string(c)) + " - ein anderes KACO-Protokoll, nicht die Powador-Serie 00 (siehe KACO.md)"
		}
		r.noteError(p.Addr, "KACO seriell ("+kacoLabel(p)+"): "+why)
		return
	}
	if !res.ChecksumOk {
		// The flow publishes the sample and shows "(Pruefsummenfehler)" in the
		// node status - RS485 bus collisions are not rare, the fields usually
		// still read right.
		r.log.Debug("KACO seriell: Pruefsummenfehler, Probe trotzdem uebernommen", "ziel", p.Addr)
	}
	r.publishTelemetry(p.Addr, telemetryFrom(res.Reading, nil, "", r.opts.Now()))
}

// testKacoSerial is "Verbindung testen" for a Powador behind its converter,
// classified like test-read.js readKacoSerial (since #1672): a failed connect
// is unreachable, connected but silent is no_answer, bytes that do not decode
// are invalid_response. On top, a reply head with another KACO protocol's
// command byte is NAMED in the message instead of guessed at.
func (r *Runtime) testKacoSerial(ctx context.Context, p *kacoSerialPlan, role string) testReadResult {
	release, ok := r.lanes.acquire(ctx, p.Addr, r.opts.LaneWait)
	if !ok {
		return testReadResult{ErrorCode: testconn.ErrNoAnswer,
			Message: "Der Wandler ist gerade mit einer anderen Abfrage beschäftigt - bitte gleich noch einmal testen."}
	}
	defer release()

	raw, err := kacoserial.Read(ctx, r.dialTCP, p.Addr, p.Address, r.kacoOpts())
	switch {
	case errors.Is(err, kacoserial.ErrNoAnswer), errors.Is(err, context.DeadlineExceeded):
		return testReadResult{ErrorCode: testconn.ErrNoAnswer}
	case errors.Is(err, kacoserial.ErrClosed):
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse,
			Message: "Der Wandler hat die Verbindung geschlossen, bevor eine Antwort kam - ist er im transparenten TCP-Server-Modus und gerade nicht von einem anderen Client belegt?"}
	case err != nil:
		return testReadResult{ErrorCode: testconn.ErrUnreachable}
	}
	res := kacoserial.Decode(raw, false)
	if res == nil {
		if c, ok := kacoserial.ReplyCommandByte(raw); ok && kacoserial.ProtocolMismatch(raw) {
			return testReadResult{ErrorCode: testconn.ErrInvalidResponse,
				Message: "Das Gerät antwortet mit dem Kommando-Byte " + strconv.Quote(string(c)) + " - ein anderes KACO-Protokoll, nicht die Powador-Serie 00."}
		}
		return testReadResult{ErrorCode: testconn.ErrInvalidResponse}
	}
	return testReadResult{OK: true, Reading: toTestReading(res.Reading, role)}
}
