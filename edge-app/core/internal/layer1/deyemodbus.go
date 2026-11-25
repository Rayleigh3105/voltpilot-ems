package layer1

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/steuerplan"
)

// A Deye is read over one of two transports with the SAME register map,
// decoder and control (inverter.CommDeyeModbusTCP): Solarman V5 through its
// logger (8899, the logger serial in every frame), or plain Modbus TCP
// through a newer logger stick that offers it (502, unit 1; field 25.11.2026,
// DYDA_WiBLE - no Solarman V5 there). Solarman V5 carries the very Modbus
// frames the stick's Modbus TCP carries; only the envelope differs. Every
// Deye path of Layer 1 (poll, connection test, Deye as a source, control)
// opens its session here and stays the same above it.

// deyeSitzung is one session to a Deye over either transport.
type deyeSitzung interface {
	ReadHolding(ctx context.Context, start, count uint16) ([]uint16, error)
	ReadPlan(ctx context.Context, plan []solarmanv5.ReadSpec) ([]solarmanv5.Block, error)
	WriteRegister(ctx context.Context, fc byte, reg, value uint16) error
	SetSequence(seq uint16)
	Sequence() uint16
	Close() error
}

// deyeVerbinde opens the session the plan names.
func (r *Runtime) deyeVerbinde(ctx context.Context, p *solarmanPlan) (deyeSitzung, error) {
	if p.Modbus {
		c, err := modbustcp.Dial(ctx, r.dialTCP, p.Addr, p.Slave, r.opts.ConnectTimeout, r.opts.ReadTimeout)
		if err != nil {
			return nil, err
		}
		return &deyeModbus{c: c}, nil
	}
	s, err := solarmanv5.Dial(ctx, r.opts.Dialer, p.Addr, p.Serial, p.Slave, r.opts.ConnectTimeout, r.opts.ReadTimeout)
	if err != nil {
		return nil, err
	}
	return s, nil
}

// deyeModbus is a Deye session over the Modbus TCP of its logger stick, with
// the semantics of solarmanv5.Session: a connection that stood but brought no
// complete answer is solarmanv5.ErrNoAnswer (callers judge "no answer" the
// same on both transports); an exception or a malformed frame is a protocol
// refusal of that one request.
type deyeModbus struct {
	c   *modbustcp.Client
	seq uint16 // Modbus TCP numbers its own transactions; kept for the interface
}

func (d *deyeModbus) Close() error           { return d.c.Close() }
func (d *deyeModbus) SetSequence(seq uint16) { d.seq = seq }
func (d *deyeModbus) Sequence() uint16       { return d.seq }
func (d *deyeModbus) ctxErr(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("%w: %v", solarmanv5.ErrNoAnswer, err)
	}
	return nil
}

// keineAntwort marks a transport failure after the connection stood.
func keineAntwort(err error) error {
	if err == nil || modbustcp.IsException(err) || strings.HasPrefix(err.Error(), "modbus:") {
		return err
	}
	var ne net.Error
	if errors.As(err, &ne) || errors.Is(err, net.ErrClosed) || strings.Contains(err.Error(), "EOF") {
		return fmt.Errorf("%w: %v", solarmanv5.ErrNoAnswer, err)
	}
	return err
}

func (d *deyeModbus) ReadHolding(ctx context.Context, start, count uint16) ([]uint16, error) {
	if err := d.ctxErr(ctx); err != nil {
		return nil, err
	}
	d.seq++
	regs, err := d.c.ReadHolding(start, count)
	return regs, keineAntwort(err)
}

// WriteRegister writes one register: FC 6 (single) or FC 16 (one register as
// a block) - the two forms the Deye control and the installer writes use.
func (d *deyeModbus) WriteRegister(ctx context.Context, fc byte, reg, value uint16) error {
	if err := d.ctxErr(ctx); err != nil {
		return err
	}
	d.seq++
	switch fc {
	case 0x06:
		return keineAntwort(d.c.WriteSingleRegister(reg, value))
	case 0x10:
		return keineAntwort(d.c.WriteRegisters(reg, []uint16{value}))
	}
	return fmt.Errorf("modbus: function 0x%02x is not a register write", fc)
}

// ReadPlan is solarmanv5.Session.ReadPlan over Modbus TCP: a mandatory
// block's failure aborts; an optional block's failure is an empty block with
// its error; after "no answer" a late reply could be read as the next block's,
// so the remaining optional blocks are missing and a remaining mandatory one
// fails the read.
func (d *deyeModbus) ReadPlan(ctx context.Context, plan []solarmanv5.ReadSpec) ([]solarmanv5.Block, error) {
	out := make([]solarmanv5.Block, 0, len(plan))
	for i, r := range plan {
		regs, err := d.ReadHolding(ctx, r.Start, r.Count)
		if err != nil {
			if !r.Optional {
				return nil, err
			}
			out = append(out, solarmanv5.Block{Start: r.Start, Regs: []uint16{}, Err: err})
			if errors.Is(err, solarmanv5.ErrNoAnswer) {
				for _, rest := range plan[i+1:] {
					if !rest.Optional {
						return nil, err
					}
					out = append(out, solarmanv5.Block{Start: rest.Start, Regs: []uint16{}, Err: err})
				}
				return out, nil
			}
			continue
		}
		out = append(out, solarmanv5.Block{Start: r.Start, Regs: regs})
	}
	return out, nil
}

// deyeSpur is the control executor's view of a Deye over the stick's Modbus
// TCP: the twin of solarmanSpur.
type deyeSpur struct{ s deyeSitzung }

// deyeSpurFehler: a Modbus exception or a malformed frame is the device's
// protocol answer (the executor's Protokollfehler), like solarmanv5's.
func deyeSpurFehler(err error) error {
	if err != nil && (modbustcp.IsException(err) || strings.HasPrefix(err.Error(), "modbus:")) {
		return &steuerplan.Protokollfehler{Msg: err.Error()}
	}
	return spurFehler(err)
}

func (d deyeSpur) Lies(ctx context.Context, addr, count int) ([]int, error) {
	regs, err := d.s.ReadHolding(ctx, uint16(addr), uint16(count))
	if err != nil {
		return nil, deyeSpurFehler(err)
	}
	out := make([]int, len(regs))
	for i, v := range regs {
		out[i] = int(v)
	}
	return out, nil
}

func (d deyeSpur) Schreibe(ctx context.Context, fc, addr, value int) error {
	return deyeSpurFehler(d.s.WriteRegister(ctx, byte(fc), uint16(addr), uint16(value)))
}

var _ steuerplan.Spur = deyeSpur{}
