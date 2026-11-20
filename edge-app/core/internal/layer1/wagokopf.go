package layer1

import (
	"context"
	"net"
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/erzeugerbild"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbusprofil"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/wagobild"
)

// opWagoKopf names the probe step that reads ONLY the head of a
// "VoltPilot-Registerbild WAGO v1" - no card, no value (vp-modbus-probe.js
// runWagoKopf). The step DECODES, the core judges (agent.wagoKopfResult).
const opWagoKopf = "wago_kopf"

// wagoKopfProbe reads the twelve head words in one session under the lane of
// the controller and, when asked, the nameplate - which is only ever shown:
// whether 0xFA10 answers without a running runtime is not established, so its
// silence is never a failure of the step.
func (r *Runtime) wagoKopfProbe(ctx context.Context, op erzeugerbild.ProbeOp) probeAntwort {
	fehler := func(code, satz string) probeAntwort {
		return probeAntwort{ProbeErgebnis: erzeugerbild.ProbeErgebnis{ID: op.ID, ErrorCode: code, Message: satz}}
	}
	host := strings.TrimSpace(op.Host)
	if host == "" || op.Address < 0 || op.Address > 65535 {
		return fehler(modbusprofil.ErrInvalidRequest, "Der Prüfschritt ist unvollständig.")
	}
	port, unit, fc := op.Port, op.UnitID, 3
	if port < 1 || port > 65535 {
		port = 502
	}
	if unit < 0 || unit > 255 {
		unit = 1
	}
	if op.FC == 4 {
		fc = 4
	}
	klasse := func(meldung string) probeAntwort { return fehler(modbusprofil.Klassifiziere(meldung)) }
	if !probe.IsPrivateHost(host) {
		return klasse(modbusprofil.MeldungAufbau + "Adresse liegt nicht im Kundennetz")
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	release, ok := r.lanes.acquire(ctx, addr, r.opts.LaneWait)
	if !ok {
		return klasse(modbusprofil.MeldungWarteschlange + " für " + addr + " belegt - Gerät liest gerade")
	}
	defer release()
	c, err := modbustcp.Dial(ctx, r.dialTCP, addr, byte(unit), r.opts.ConnectTimeout, r.opts.ReadTimeout)
	if err != nil {
		if isTimeout(err) {
			return klasse(modbusprofil.MeldungAufbauTimeout + " (" + millis(r.opts.ConnectTimeout) + ")")
		}
		return klasse(modbusprofil.MeldungAufbau + err.Error())
	}
	defer c.Close()
	lies := func(start, count int) ([]uint16, error) {
		if fc == 4 {
			return c.ReadInput(uint16(start), uint16(count))
		}
		return c.ReadHolding(uint16(start), uint16(count))
	}
	kopf, err := lies(op.Address, wagobild.KopflaengeMin)
	if err != nil {
		return klasse(modbusMeldung(err, r.opts.ReadTimeout))
	}
	var schild []uint16
	if op.Nameplate {
		if w, err := lies(wagobild.TypenschildAdresse, wagobild.TypenschildWoerter); err == nil {
			schild = w
		}
	}
	wortfolge := "big"
	if op.WordOrder == "little" {
		wortfolge = "little"
	}
	bericht := wagobild.BerichteKopf(kopf, wortfolge, schild)
	return probeAntwort{ProbeErgebnis: erzeugerbild.ProbeErgebnis{ID: op.ID, OK: true}, WagoKopf: &bericht}
}
