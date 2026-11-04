package kacoserial

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// wandler is a Waveshare-like transparent TCP server with one Powador at
// `address` behind it. Its behaviour per connection is scripted.
type wandler struct {
	ln       net.Listener
	mu       sync.Mutex
	requests []string
	script   func(c net.Conn, req string)
}

func startWandler(t *testing.T, script func(c net.Conn, req string)) *wandler {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	w := &wandler{ln: ln, script: script}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				buf := make([]byte, 64)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				w.mu.Lock()
				w.requests = append(w.requests, string(buf[:n]))
				w.mu.Unlock()
				w.script(c, string(buf[:n]))
			}()
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return w
}

func (w *wandler) addr() string { return w.ln.Addr().String() }

// cmd0Frame builds a valid command-"0" frame like the JS test helper.
func cmd0Frame(address int, acPowerW int, typ string) []byte {
	body := fmt.Sprintf("*%02d0 %3d %5s %5s %5d %5s %5s %5d %3d %6d ", address, 4, "585.9", "10.17", 5958, "229.5", "24.90", acPowerW, 36, 17614)
	out := append([]byte{0x0a}, []byte(body)...)
	out = append(out, Checksum([]byte(body)))
	return append(out, []byte(typ+"\r")...)
}

func fast() ReadOptions {
	return ReadOptions{Timeout: 400 * time.Millisecond, ReplyGap: 120 * time.Millisecond}
}

func TestReadOneCycleAgainstTheConverter(t *testing.T) {
	w := startWandler(t, func(c net.Conn, req string) {
		if req == "#010\r" {
			time.Sleep(50 * time.Millisecond) // reply latency of a real unit
			_, _ = c.Write(cmd0Frame(1, 5720, " 9600I"))
		}
		time.Sleep(200 * time.Millisecond)
	})
	raw, err := Read(context.Background(), nil, w.addr(), 1, fast())
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	res := Decode(raw, false)
	if res == nil || res.Reading["pv_power_kw"] != 5.72 || !res.ChecksumOk || res.Meta.InverterType != "9600I" {
		t.Fatalf("decode: %+v", res)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.requests) != 1 || w.requests[0] != "#010\r" {
		t.Fatalf("Anfrage: %q", w.requests)
	}
}

func TestReadAssemblesChunksAndDropsJunk(t *testing.T) {
	frame := cmd0Frame(7, 1216, " 3200I")
	w := startWandler(t, func(c net.Conn, req string) {
		_, _ = c.Write([]byte{0x00, 0xff}) // bus-switching noise
		time.Sleep(30 * time.Millisecond)
		_, _ = c.Write(frame[:20])
		time.Sleep(30 * time.Millisecond)
		_, _ = c.Write(frame[20:])
		time.Sleep(300 * time.Millisecond)
	})
	raw, err := Read(context.Background(), nil, w.addr(), 7, fast())
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(raw) != string(frame) {
		t.Fatalf("Frame nicht bereinigt zusammengesetzt: %q", raw)
	}
	if res := Decode(raw, false); res == nil || res.Address != 7 || res.Reading["pv_power_kw"] != 1.216 {
		t.Fatalf("decode: %+v", res)
	}
}

func TestReadReplyGapEndsAPartialReply(t *testing.T) {
	frame := cmd0Frame(1, 5720, " 9600I")
	partial := frame[:Cmd0MinLen] // checksum there, no CR, no type: complete by length only
	w := startWandler(t, func(c net.Conn, req string) {
		_, _ = c.Write(partial)
		time.Sleep(time.Second) // silence, connection stays open
	})
	start := time.Now()
	raw, err := Read(context.Background(), nil, w.addr(), 1, fast())
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if d := time.Since(start); d > 350*time.Millisecond {
		t.Fatalf("der Leerlauf-Zeitabstand (120 ms) haette die Antwort beendet, dauerte %s", d)
	}
	if string(raw) != string(partial) || Decode(raw, false) == nil {
		t.Fatalf("Teilantwort muss decodierbar durchkommen: %q", raw)
	}
}

func TestReadClassifiesSilenceCloseAndRefusal(t *testing.T) {
	silent := startWandler(t, func(c net.Conn, req string) { time.Sleep(time.Second) })
	if _, err := Read(context.Background(), nil, silent.addr(), 1, fast()); !errors.Is(err, ErrNoAnswer) {
		t.Fatalf("stiller Bus: %v", err)
	}

	closing := startWandler(t, func(c net.Conn, req string) {
		_, _ = c.Write(cmd0Frame(1, 5720, " 9600I")[:30])
	})
	if _, err := Read(context.Background(), nil, closing.addr(), 1, fast()); !errors.Is(err, ErrClosed) {
		t.Fatalf("Verbindung vor dem Ende der Antwort geschlossen: %v", err)
	}

	immediate := startWandler(t, func(c net.Conn, req string) {})
	if _, err := Read(context.Background(), nil, immediate.addr(), 1, fast()); !errors.Is(err, ErrClosed) {
		t.Fatalf("sofort geschlossen: %v", err)
	}

	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := ln.Addr().String()
	_ = ln.Close()
	_, err := Read(context.Background(), nil, dead, 1, fast())
	if err == nil || errors.Is(err, ErrNoAnswer) || errors.Is(err, ErrClosed) {
		t.Fatalf("geschlossener Port muss als Verbindungsfehler kommen: %v", err)
	}

	if _, err := Read(context.Background(), nil, dead, 0, fast()); err == nil || !strings.Contains(err.Error(), "1..32") {
		t.Fatalf("Adresse 0 wird vor dem Verbinden verweigert: %v", err)
	}
}

func TestReadOtherProtocolComesBackForTheCallerToName(t *testing.T) {
	w := startWandler(t, func(c net.Conn, req string) {
		f := cmd0Frame(1, 5720, "")
		f[4] = 'n' // the CRC16 variant answers
		_, _ = c.Write(f)
		time.Sleep(200 * time.Millisecond)
	})
	raw, err := Read(context.Background(), nil, w.addr(), 1, fast())
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if Decode(raw, false) != nil || !ProtocolMismatch(raw) {
		t.Fatalf("ein anderes KACO-Protokoll darf nicht decodiert, muss aber erkannt werden: %q", raw)
	}
}

func TestReadStopsWithTheContext(t *testing.T) {
	w := startWandler(t, func(c net.Conn, req string) { time.Sleep(2 * time.Second) })
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := Read(ctx, nil, w.addr(), 1, ReadOptions{Timeout: 5 * time.Second})
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Fatalf("der Kontext muss die Lesung beenden: %v nach %s", err, time.Since(start))
	}
}
