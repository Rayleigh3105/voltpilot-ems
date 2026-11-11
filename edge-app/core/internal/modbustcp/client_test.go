package modbustcp

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

// fakeServer answers FC3 from an absolute register image; `refuse` addresses
// get exception 2, `wrongTid` answers with a foreign transaction id, `short`
// truncates the length field.
type fakeServer struct {
	ln       net.Listener
	regs     map[uint16]uint16
	refuse   map[uint16]bool
	wrongTid bool
	silent   bool
}

func startFake(t *testing.T, regs map[uint16]uint16) *fakeServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &fakeServer{ln: ln, regs: regs, refuse: map[uint16]bool{}}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(c)
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return s
}

func (s *fakeServer) serve(c net.Conn) {
	defer c.Close()
	for {
		hdr := make([]byte, 7)
		if _, err := io.ReadFull(c, hdr); err != nil {
			return
		}
		n := int(binary.BigEndian.Uint16(hdr[4:]))
		body := make([]byte, n-1)
		if _, err := io.ReadFull(c, body); err != nil {
			return
		}
		if s.silent {
			continue
		}
		tid := binary.BigEndian.Uint16(hdr[0:])
		if s.wrongTid {
			tid++
		}
		fc := body[0]
		addr := binary.BigEndian.Uint16(body[1:])
		count := binary.BigEndian.Uint16(body[3:])
		var resp []byte
		if fc != FcReadHolding || s.refuse[addr] {
			resp = []byte{fc | 0x80, 2}
		} else {
			resp = []byte{fc, byte(count * 2)}
			for i := uint16(0); i < count; i++ {
				resp = binary.BigEndian.AppendUint16(resp, s.regs[addr+i])
			}
		}
		out := make([]byte, 7, 7+len(resp))
		binary.BigEndian.PutUint16(out[0:], tid)
		binary.BigEndian.PutUint16(out[4:], uint16(len(resp)+1))
		out[6] = hdr[6]
		_, _ = c.Write(append(out, resp...))
	}
}

func TestReadHoldingBigEndianWords(t *testing.T) {
	s := startFake(t, map[uint16]uint16{32064: 0x0000, 32065: 0x09c4, 37113: 0xffff, 37114: 0xfed4})
	c, err := Dial(context.Background(), nil, s.ln.Addr().String(), 1, time.Second, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	regs, err := c.ReadHolding(32064, 2)
	if err != nil || len(regs) != 2 || regs[0] != 0 || regs[1] != 2500 {
		t.Fatalf("FC3 32064+2: %v %v", regs, err)
	}
	regs, err = c.ReadHolding(37113, 2)
	if err != nil || int32(uint32(regs[0])<<16|uint32(regs[1])) != -300 {
		t.Fatalf("FC3 37113+2 signed: %v %v", regs, err)
	}
	// Transaction ids advance per exchange on the same session.
	if c.tid != 2 {
		t.Fatalf("tid = %d", c.tid)
	}
}

func TestExceptionIsTyped(t *testing.T) {
	s := startFake(t, nil)
	s.refuse[37113] = true
	c, err := Dial(context.Background(), nil, s.ln.Addr().String(), 1, time.Second, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, err = c.ReadHolding(37113, 2)
	var ex *ExceptionError
	if !errors.As(err, &ex) || ex.Code != 2 || ex.Function != FcReadHolding || !IllegalAddress(err) || !IsException(err) {
		t.Fatalf("exception: %v", err)
	}
	if IllegalAddress(errors.New("x")) || IsException(nil) {
		t.Fatal("plain errors are no exception")
	}
	// The session survives an exception: the next read works.
	if _, err := c.ReadHolding(0, 1); err != nil {
		t.Fatalf("after exception: %v", err)
	}
}

func TestForeignTransactionAndSilenceAreErrors(t *testing.T) {
	s := startFake(t, nil)
	s.wrongTid = true
	c, err := Dial(context.Background(), nil, s.ln.Addr().String(), 1, time.Second, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.ReadHolding(0, 1); err == nil || IsException(err) {
		t.Fatalf("foreign tid must be a plain error: %v", err)
	}
	_ = c.Close()

	s.wrongTid, s.silent = false, true
	c, err = Dial(context.Background(), nil, s.ln.Addr().String(), 1, time.Second, 150*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, err = c.ReadHolding(0, 1)
	var ne net.Error
	if !errors.As(err, &ne) || !ne.Timeout() {
		t.Fatalf("silence must be a timeout: %v", err)
	}
}

func TestDialFailureAndInjectedDialer(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	_ = ln.Close()
	if _, err := Dial(context.Background(), nil, addr, 1, 500*time.Millisecond, time.Second); err == nil {
		t.Fatal("closed port must fail to dial")
	}
	called := ""
	dial := func(_ context.Context, a string) (net.Conn, error) { called = a; return nil, errors.New("nein") }
	if _, err := Dial(context.Background(), dial, "10.0.0.1:502", 1, time.Second, time.Second); err == nil || called != "10.0.0.1:502" {
		t.Fatalf("injected dialer: %v %q", err, called)
	}
}
