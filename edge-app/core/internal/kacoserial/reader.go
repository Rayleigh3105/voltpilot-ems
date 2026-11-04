package kacoserial

import (
	"context"
	"errors"
	"io"
	"net"
	"time"
)

// Dialer opens the TCP connection to the converter (injected in tests).
type Dialer func(ctx context.Context, address string) (net.Conn, error)

func defaultDialer(ctx context.Context, address string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "tcp", address)
}

// ReadOptions pace one cycle (the module's makeKacoSerialReader deps).
type ReadOptions struct {
	// Timeout is the inactivity timeout of the socket (connect, then every
	// wait for the first byte): 5 s like the flow.
	Timeout time.Duration
	// ReplyGap: no further byte within this time after the last chunk means
	// "the answer is finished, even if not complete by length" - the fallback
	// for a partial reply (300 ms like the flow).
	ReplyGap time.Duration
}

// Classified outcomes of one cycle (the connection test tells them apart).
var (
	// ErrNoAnswer: connected, request sent, not a single byte came back.
	ErrNoAnswer = errors.New("keine Antwort vom Wandler")
	// ErrClosed: the converter closed the connection before the reply was
	// complete (the flow's 'close' -> null: the partial bytes are not decoded).
	ErrClosed = errors.New("Verbindung vor dem Ende der Antwort geschlossen")
)

// Read runs ONE cycle against the RS485-to-Ethernet converter at addr
// ("ip:port"): open a connection, send `#<address>0\r`, collect the reply
// (length-gated + CR like IsCmd0Complete, else the reply-gap fallback), close.
// It returns the TRIMMED bytes that arrived (possibly nothing decodable, which
// the caller classifies with Decode / ProtocolMismatch). A dial failure is
// returned as is (the converter is unreachable); ErrNoAnswer and ErrClosed are
// the two other outcomes without bytes.
//
// NO connection pooling: the converter typically serves ONE TCP client at a
// time, so every cycle opens and closes its own connection - the converter
// stays free for the next poll even if the previous one hung in a timeout.
func Read(ctx context.Context, dial Dialer, addr string, address int, opts ReadOptions) ([]byte, error) {
	if opts.Timeout <= 0 {
		opts.Timeout = 5 * time.Second
	}
	if opts.ReplyGap <= 0 {
		opts.ReplyGap = 300 * time.Millisecond
	}
	req, err := BuildRequest(address, CmdMeasure)
	if err != nil {
		return nil, err
	}
	if dial == nil {
		dial = defaultDialer
	}
	dctx, cancel := context.WithTimeout(ctx, opts.Timeout)
	defer cancel()
	conn, err := dial(dctx, addr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	// The context ends the read early (the caller's overall budget).
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
	defer stop()

	_ = conn.SetWriteDeadline(time.Now().Add(opts.Timeout))
	if _, err := conn.Write(req); err != nil {
		return nil, err
	}

	var buf []byte
	received := false
	chunk := make([]byte, 256)
	for {
		wait := opts.Timeout
		if received {
			wait = opts.ReplyGap
		}
		_ = conn.SetReadDeadline(time.Now().Add(wait))
		n, err := conn.Read(chunk)
		if n > 0 {
			received = true
			buf = TrimLeadingJunk(append(buf, chunk[:n]...))
			if IsCmd0Complete(buf) {
				return buf, nil
			}
		}
		if err == nil {
			continue
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var ne net.Error
		switch {
		case errors.As(err, &ne) && ne.Timeout():
			if !received {
				return nil, ErrNoAnswer
			}
			return buf, nil // the reply gap: finished, complete or not
		case errors.Is(err, io.EOF):
			if n > 0 && IsCmd0Complete(buf) {
				return buf, nil
			}
			return nil, ErrClosed
		default:
			return nil, err
		}
	}
}
