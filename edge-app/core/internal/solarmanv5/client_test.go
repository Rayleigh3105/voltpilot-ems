package solarmanv5_test

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5/v5sim"
)

const serial = 2985159064

func startSim(t *testing.T) *v5sim.Sim {
	t.Helper()
	s, err := v5sim.Start("127.0.0.1:0", serial)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func dial(t *testing.T, addr string, readTimeout time.Duration) *solarmanv5.Session {
	t.Helper()
	sess, err := solarmanv5.Dial(context.Background(), nil, addr, serial, 1, time.Second, readTimeout)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sess.Close() })
	return sess
}

func TestReadPlanAgainstTheSimulator(t *testing.T) {
	sim := startSim(t)
	sim.Set(map[uint16]uint16{0x0000: 0x0005, 0x024c: 57, 0x02c4: 0xffff})
	sess := dial(t, sim.Addr(), time.Second)
	blocks, err := sess.ReadPlan(context.Background(), []solarmanv5.ReadSpec{
		{Start: 0x0000, Count: 1},
		{Start: 0x024b, Count: 0x7a},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 2 || blocks[0].Regs[0] != 0x0005 {
		t.Fatalf("Bloecke: %+v", blocks)
	}
	if got := blocks[1].Regs[0x024c-0x024b]; got != 57 {
		t.Errorf("SoC-Register = %d, want 57", got)
	}
	if got := blocks[1].Regs[0x02c4-0x024b]; got != 0xffff {
		t.Errorf("letztes Register = %#x", got)
	}
	if sess.Sequence() != 2 {
		t.Errorf("Sequenz = %d, want 2 (eine je Block)", sess.Sequence())
	}
}

func TestOptionalBlockRefusalKeepsTheRestOfThePoll(t *testing.T) {
	sim := startSim(t)
	sim.Set(map[uint16]uint16{0x024c: 57})
	sim.Refuse(0x00d2, 0x02)
	sess := dial(t, sim.Addr(), time.Second)
	blocks, err := sess.ReadPlan(context.Background(), []solarmanv5.ReadSpec{
		{Start: 0x024b, Count: 0x7a},
		{Start: 0x00d2, Count: 0x0e, Optional: true},
	})
	if err != nil {
		t.Fatalf("ein optionaler Block darf den Poll nicht reissen: %v", err)
	}
	if len(blocks) != 2 || len(blocks[1].Regs) != 0 || blocks[1].Err == nil {
		t.Fatalf("optionaler Block muss leer mit Fehler stehen: %+v", blocks[1])
	}
}

func TestMandatoryBlockRefusalFailsThePoll(t *testing.T) {
	sim := startSim(t)
	sim.Refuse(0x024b, 0x02)
	sess := dial(t, sim.Addr(), time.Second)
	_, err := sess.ReadPlan(context.Background(), []solarmanv5.ReadSpec{{Start: 0x024b, Count: 0x7a}})
	if err == nil || !solarmanv5.IsProtocolError(err) {
		t.Fatalf("Pflichtblock-Ablehnung muss als Protokollfehler scheitern, got %v", err)
	}
}

func TestSilentLoggerIsNoAnswerNotUnreachable(t *testing.T) {
	sim := startSim(t)
	sim.SetSilent(true)
	sess := dial(t, sim.Addr(), 200*time.Millisecond)
	_, err := sess.ReadHolding(context.Background(), 0, 1)
	if !errors.Is(err, solarmanv5.ErrNoAnswer) {
		t.Fatalf("stummer Logger = no_answer, got %v", err)
	}
}

func TestClosedPortIsUnreachable(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	_, err = solarmanv5.Dial(context.Background(), nil, addr, serial, 1, 300*time.Millisecond, time.Second)
	if !errors.Is(err, solarmanv5.ErrDial) {
		t.Fatalf("geschlossener Port = unreachable, got %v", err)
	}
}

func TestWrongSerialIsRefused(t *testing.T) {
	sim := startSim(t)
	sess, err := solarmanv5.Dial(context.Background(), nil, sim.Addr(), serial+1, 1, time.Second, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()
	if _, err := sess.ReadHolding(context.Background(), 0, 1); err == nil || !solarmanv5.IsProtocolError(err) {
		t.Fatalf("Antwort eines anderen Loggers muss abgelehnt werden, got %v", err)
	}
}
