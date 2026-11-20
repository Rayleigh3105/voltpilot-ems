package layer1

import (
	"context"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/deyedecode"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
)

// A Deye behind its Solarman V5 logger as an ADDITIONAL source: the
// executor's readSolarmanReading. The family's plan blocks only (no learned
// mirror block, no export-limit read - those belong to the primary poll), the
// optional BMS block may fail, decoded with the source's sign and SoC options
// but without the voltage SoC estimate (the executor does not pass it). The
// logger's lane serializes it with the primary poll of the same logger.

// readDeyeSource is one read of a Deye source; requests is the number of
// blocks asked.
func (r *Runtime) readDeyeSource(ctx context.Context, p *solarmanPlan) (*deyedecode.Result, int, error) {
	sess, err := solarmanv5.Dial(ctx, r.opts.Dialer, p.Addr, p.Serial, p.Slave, r.opts.ConnectTimeout, r.opts.ReadTimeout)
	if err != nil {
		return nil, 0, err
	}
	defer sess.Close()
	sess.SetSequence(1)
	blocks, err := sess.ReadPlan(ctx, p.Reads)
	if err != nil {
		return nil, len(p.Reads), err
	}
	cfg := p.Decode
	cfg.SocFromVoltage = nil
	return deyedecode.Decode(toBlocks(blocks), cfg), len(p.Reads), nil
}

// deyeSourceReading is the executor's solarman_v5 branch: PV, grid and load.
func deyeSourceReading(res *deyedecode.Result, err error) inverterSourceReading {
	if err != nil || res == nil || len(res.Reading) == 0 {
		return inverterSourceReading{why: "keine Antwort / kein Deye-Logger (Timeout, Verbindung abgewiesen oder falsche Seriennummer)"}
	}
	return inverterSourceReading{reading: res.Reading, withLoad: true}
}
