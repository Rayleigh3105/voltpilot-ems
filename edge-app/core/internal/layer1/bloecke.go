package layer1

import (
	"context"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
)

// blockSpec is one register block of a fixed read plan with its function code.
type blockSpec struct {
	FC    int
	Start int
	Count int
}

// readBlock is one block as read.
type readBlock struct {
	FC    int
	Start int
	Regs  []uint16
}

// blockRead is one session over a fixed plan (the makeKostalReader /
// makeAisweiReader pattern): blocks in order over ONE connection; a refused
// or garbled block only drops its channels, a timeout or a lost connection
// ends the whole read.
type blockRead struct {
	Blocks   []readBlock
	Attempts int
}

func (r *Runtime) readBlocks(ctx context.Context, addr string, unit byte, plan []blockSpec) (*blockRead, error) {
	c, err := modbustcp.Dial(ctx, r.dialTCP, addr, unit, r.opts.ConnectTimeout, r.opts.ReadTimeout)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	out := &blockRead{}
	for _, b := range plan {
		out.Attempts++
		var regs []uint16
		if b.FC == 4 {
			regs, err = c.ReadInput(uint16(b.Start), uint16(b.Count))
		} else {
			regs, err = c.ReadHolding(uint16(b.Start), uint16(b.Count))
		}
		switch {
		case err == nil:
			out.Blocks = append(out.Blocks, readBlock{FC: b.FC, Start: b.Start, Regs: regs})
		case modbustcp.IsException(err) || strings.HasPrefix(err.Error(), "modbus:"):
			// per-block isolation: the next block is still read
		default:
			return out, err
		}
	}
	return out, nil
}

// blockTestResult is the connection test of a fixed-plan Modbus reader
// (readKostal / readAiswei): no connection = unreachable; connected but no
// decodable measurement (refused blocks, a read running into its timeout) =
// invalid_response.
func blockTestResult(rd *blockRead, err error, decoded bool) (string, bool) {
	switch {
	case err != nil && isDialError(err):
		return "unreachable", false
	case err != nil || rd == nil || len(rd.Blocks) == 0 || !decoded:
		return "invalid_response", false
	}
	return "", true
}
