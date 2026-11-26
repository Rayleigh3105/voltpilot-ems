package agent

// Direktvermarktung wiring (Stage 2, vp-direktvermarktung-konzept d2 §5.4
// bis §5.6): the agent's only duties here are feeding the partner's Modbus
// interface from the SAME gated composite the dashboard and cloud see (never
// a device read), composing the partner's fresh set-point into the guard
// chain as a MANDATORY limit, and exposing the §5.4 status. Everything
// partner-shaped - tunnel, firewall, interface lifecycle, events - lives in
// internal/vermarktertunnel.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/vermarktertunnel"
)

// vermarkterDienst is what the agent needs from the tunnel manager
// (internal/vermarktertunnel.Manager implements it; the tests use a fake).
type vermarkterDienst interface {
	Run(ctx context.Context)
	Anschluss() (vermarktertunnel.Anschluss, bool)
	SetValues(at time.Time, values map[string]float64)
	Grenze() (kw float64, wirktAuf string, aktiv bool)
	Status() vermarktertunnel.Status
	// The delivery's half (task vp-dv-zustellung): the interface snapshot for
	// the heartbeat block and the dv.* points, and the one flash event list.
	ServerStand() (direktvermarkter.ServerStand, bool)
	Ereignis(text string)
}

// netzbetreiberOhneSignalPct is what the input register
// netzbetreiber_vorgabe_pct shows while the site has no registered feed-in
// limit: 100 (= no curtailment by the grid operator). PROVISIONAL - F7 of
// the concept asks luox whether a fixed 70 % belongs there instead; this one
// constant is the only place that answer lands.
const netzbetreiberOhneSignalPct = 100.0

type vermarkterState struct {
	mu sync.Mutex
	// the registered feed-in limit of the last applySetpoint tick, for the
	// input register netzbetreiber_vorgabe_pct (nil = none configured)
	netzgrenzeKw *float64
}

// initVermarkter builds the tunnel manager (from New). On a box without a
// delivered anschluss.json it idles in "ohne_profil" and starts nothing.
func (a *Agent) initVermarkter() {
	a.vermarkter = vermarktertunnel.New(vermarktertunnel.Options{
		Dir:                     a.dvDir(),
		RAM:                     a.Cfg.VermarkterRAMDir,
		OpenVPNBin:              a.Cfg.VermarkterOpenVPN,
		LebenszeichenHoechstens: time.Duration(a.Cfg.VermarkterLebenszeichenS) * time.Second,
		// OnEreignis stays empty for now: the manager writes the flash list
		// and logs each event itself; Stage 3 hooks the heartbeat in here.
	})
}

// startVermarkter runs the manager's convergence loop (from Start).
func (a *Agent) startVermarkter(ctx context.Context) {
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		a.vermarkter.Run(ctx)
	}()
}

// feedVermarkter serves the partner's input registers from the gated
// composite site sample (called at the foldSiteSample choke point, right
// beside the Modbus mirror's feed): the grid value with its sign FLIPPED
// (grid is +import/-export, the register counts feed-in positive), the PV
// sum, the delivered reference power, and the grid operator's percentage
// from the registered feed-in limit. Absent channels are absent - the
// interface answers 0x0B for them, never a fabricated 0 (§5.1).
func (a *Agent) feedVermarkter(ts time.Time, werte map[string]float64) {
	if a.vermarkter == nil {
		return
	}
	anschluss, ok := a.vermarkter.Anschluss()
	if !ok {
		return
	}
	out := map[string]float64{
		"referenz_w":                anschluss.ReferenzWp,
		"netzbetreiber_vorgabe_pct": a.netzbetreiberPct(anschluss.ReferenzWp),
	}
	if grid, ok := werte["power_kw"]; ok {
		out["nvp_einspeisung_w"] = -grid * 1000
	}
	if pv, ok := werte["pv_power_kw"]; ok {
		out["erzeugung_w"] = math.Max(pv, 0) * 1000
	}
	a.vermarkter.SetValues(ts, out)
}

// netzbetreiberPct derives the input register netzbetreiber_vorgabe_pct from
// the registered feed-in limit the last tick carried, relative to the
// delivered reference power (F7: without a signal, 100).
func (a *Agent) netzbetreiberPct(referenzWp float64) float64 {
	a.vermarkterSt.mu.Lock()
	grenze := a.vermarkterSt.netzgrenzeKw
	a.vermarkterSt.mu.Unlock()
	if grenze == nil || referenzWp <= 0 {
		return netzbetreiberOhneSignalPct
	}
	pct := math.Round(*grenze * 1000 * 100 / referenzWp)
	return math.Max(0, math.Min(100, pct))
}

// merkeNetzgrenze keeps the plan's registered feed-in limit for the feed
// above (called every applySetpoint tick, where the plan is read anyway).
func (a *Agent) merkeNetzgrenze(exportLimit *float64) {
	a.vermarkterSt.mu.Lock()
	defer a.vermarkterSt.mu.Unlock()
	if exportLimit == nil {
		a.vermarkterSt.netzgrenzeKw = nil
		return
	}
	v := *exportLimit
	a.vermarkterSt.netzgrenzeKw = &v
}

// vermarkterGrenzen composes the partner's limit into the guard chain
// (decision E2 = A, concept §5.6): while the watchdog is fresh and the
// set-point is below the rest value,
//
//   - acting on the FEED-IN (the provisional reading of F5): the returned
//     exportLimit is min(registered limit, partner limit) - the export
//     watchdog then holds it as a COMPLIANCE limit, so the battery cascade
//     charges first and only the rest is curtailed;
//   - acting on the GENERATION (profile value vorgabe_wirkt_auf, should
//     luox answer F5 that way): the same limit returns as a PV cap instead,
//     composed min with the plant cap after the watchdog.
//
// An expired watchdog or a missing connection returns the inputs untouched:
// no partner limit is ever invented (§5.1 "ohne Lebenszeichen gilt keine
// Vorgabe").
func (a *Agent) vermarkterGrenzen(exportLimit *float64) (eff *float64, pvCap *float64) {
	if a.vermarkter == nil {
		return exportLimit, nil
	}
	kw, wirktAuf, aktiv := a.vermarkter.Grenze()
	if !aktiv {
		return exportLimit, nil
	}
	if wirktAuf == direktvermarkter.WirktAufErzeugung {
		v := kw
		return exportLimit, &v
	}
	if exportLimit == nil || kw < *exportLimit {
		v := kw
		return &v, nil
	}
	return exportLimit, nil
}

// Direktvermarktung is the §5.4 status for the local web app (web.Handler
// picks it up as the optional DirektvermarktungController).
func (a *Agent) Direktvermarktung() vermarktertunnel.Status {
	if a.vermarkter == nil {
		return vermarktertunnel.Status{Lage: vermarktertunnel.LageOhneProfil}
	}
	return a.vermarkter.Status()
}

// --- the DELIVERY between cloud and box (task vp-dv-zustellung) -----------------
//
// Contract docs/contracts/v2/direktvermarktung-zustellung.md: the retained
// profile document on .../v2/direktvermarktung picks the partner and carries
// the reference power and the expected access fingerprint; the access itself
// is asked for (never retained) and acknowledged. The handlers here only
// WRITE AND REMOVE the tunnel manager's files
// (internal/vermarktertunnel/zugang.go) - the manager converges on its next
// tick, so delivery and tunnel share one source of truth on disk. NOTHING in
// this file ever logs key material; the only loggable identifier is the
// fingerprint.

// dvAnfrageAbstand bounds how often the box re-asks for a missing access
// while the link stays up (the retained redelivery already re-asks on every
// reconnect; this covers a cloud that missed the request).
const dvAnfrageAbstand = 10 * time.Minute

// dvDir is the delivery dir - the SAME resolution initVermarkter uses, so
// the delivery writes exactly where the manager reads.
func (a *Agent) dvDir() string {
	if a.Cfg.VermarkterDir != "" {
		return a.Cfg.VermarkterDir
	}
	return filepath.Join(a.Cfg.DataDir, "vermarkter")
}

func (a *Agent) dvZustellungPfad() string {
	return filepath.Join(a.dvDir(), vermarktertunnel.ZustellungDatei)
}

// dvDokument is the persisted retained document (the delivery's bookkeeping:
// revision and the expected access fingerprint); nil without one.
func (a *Agent) dvDokument() *direktvermarkter.ProfilDokument {
	raw, err := os.ReadFile(a.dvZustellungPfad())
	if err != nil {
		return nil
	}
	doc, err := direktvermarkter.ParseProfilDokument(raw)
	if err != nil {
		slog.Warn("direktvermarktung: gespeicherte Zustellung beschaedigt - verworfen", "err", err)
		return nil
	}
	return doc
}

// dvEreignis records a delivery event in the connection's one flash list.
func (a *Agent) dvEreignis(text string) {
	if a.vermarkter != nil {
		a.vermarkter.Ereignis(text)
	}
}

// onDirektvermarktung consumes the retained profile document - on every
// (re)connect and on every change. An EMPTY payload is the retained-clear:
// the box deletes access and profile files and acknowledges "geloescht" (the
// box swap waits for exactly that acknowledgement before the new box
// receives).
func (a *Agent) onDirektvermarktung(payload []byte) {
	doc, err := direktvermarkter.ParseProfilDokument(payload)
	if err != nil {
		slog.Warn("direktvermarktung: Profil verworfen", "err", err)
		return
	}
	dir := a.dvDir()
	if doc == nil {
		alterZugang := ""
		if z, ok, _ := vermarktertunnel.LadeZugang(dir); ok {
			alterZugang = z.Fingerabdruck
		}
		// Access FIRST, choice second, bookkeeping last: a failure midway
		// leaves no half state, and nothing is acknowledged that is not
		// really gone - the retained clear is redelivered on the next
		// reconnect and the deletion tried again.
		if err := vermarktertunnel.LoescheZugang(dir); err != nil {
			slog.Warn("direktvermarktung: Ruecknahme (zugang) fehlgeschlagen", "err", err)
			return
		}
		if err := vermarktertunnel.LoescheAnschluss(dir); err != nil {
			slog.Warn("direktvermarktung: Ruecknahme (anschluss) fehlgeschlagen", "err", err)
			return
		}
		hatteZustellung := false
		if _, err := os.Stat(a.dvZustellungPfad()); err == nil {
			hatteZustellung = true
		}
		if err := os.Remove(a.dvZustellungPfad()); err != nil && !os.IsNotExist(err) {
			slog.Warn("direktvermarktung: Ruecknahme (zustellung) fehlgeschlagen", "err", err)
			return
		}
		if hatteZustellung || alterZugang != "" {
			slog.Info("direktvermarktung: Profil zurueckgezogen (retained clear)")
			a.dvEreignis("zustellung zurueckgezogen")
		}
		if alterZugang != "" {
			a.sendeDvQuittung(alterZugang, direktvermarkter.QuittungGeloescht)
		}
		a.requestStatusHeartbeat()
		return
	}
	// Topic identity == payload identity, the rule of every v2 downlink. The
	// link only subscribes its OWN topic, so a mismatch is a misaddressed
	// publish - never something to act on.
	a.entMu.Lock()
	id := a.entIdentity
	a.entMu.Unlock()
	if id.DeviceID != "" && !doc.BelongsTo(id.TenantID, id.SiteID, id.DeviceID) {
		slog.Warn("direktvermarktung: fremde Identitaet im Profil - verworfen", "device_id", doc.DeviceID)
		return
	}
	vorher := a.dvDokument()
	if err := vermarktertunnel.SpeichereAnschluss(dir,
		vermarktertunnel.Anschluss{Partner: doc.Partner, ReferenzWp: doc.ReferenzWp}); err != nil {
		slog.Warn("direktvermarktung: Anschluss nicht gespeichert", "err", err)
		return
	}
	if raw, err := json.Marshal(doc); err == nil {
		tmp := a.dvZustellungPfad() + ".tmp"
		if err := os.WriteFile(tmp, raw, 0o600); err == nil {
			_ = os.Rename(tmp, a.dvZustellungPfad())
		}
	}
	bekannt := vorher != nil && vorher.Revision == doc.Revision && vorher.Partner == doc.Partner &&
		vorher.ZugangFingerabdruck == doc.ZugangFingerabdruck
	if !bekannt {
		slog.Info("direktvermarktung: Profil uebernommen", "partner", doc.Partner, "revision", doc.Revision)
		a.dvEreignis("zustellung uebernommen (" + doc.Partner + ")")
	}
	z, zugangDa, _ := vermarktertunnel.LadeZugang(dir)
	if zugangDa && z.Fingerabdruck == doc.ZugangFingerabdruck {
		// Redelivery with the access already stored: confirm idempotently, so
		// the cloud's zugestellt_am survives a lost first acknowledgement.
		a.sendeDvQuittung(doc.ZugangFingerabdruck, direktvermarkter.QuittungZugestellt)
		a.requestStatusHeartbeat()
		return
	}
	if zugangDa {
		// The profile names a DIFFERENT access: the old one is obsolete and
		// is deleted before the new one is asked for - the box never holds
		// two (§8 "Ein Zertifikat, eine Anlage").
		if err := vermarktertunnel.LoescheZugang(dir); err != nil {
			slog.Warn("direktvermarktung: alter Zugang nicht geloescht", "err", err)
			return
		}
		a.dvEreignis("zugang geloescht (ersetzt)")
		a.sendeDvQuittung(z.Fingerabdruck, direktvermarkter.QuittungGeloescht)
	}
	a.sendeDvAnfrage(doc.ZugangFingerabdruck)
	a.requestStatusHeartbeat()
}

// onDirektvermarktungZugang consumes the one-time access answer.
func (a *Agent) onDirektvermarktungZugang(payload []byte) {
	z, err := direktvermarkter.ParseZugangAntwort(payload)
	if err != nil {
		// The error never carries content, only which part was missing.
		slog.Warn("direktvermarktung: Zugang verworfen", "err", err)
		return
	}
	a.entMu.Lock()
	id := a.entIdentity
	a.entMu.Unlock()
	if id.DeviceID != "" && !z.BelongsTo(id.TenantID, id.SiteID, id.DeviceID) {
		slog.Warn("direktvermarktung: fremde Identitaet im Zugang - verworfen", "device_id", z.DeviceID)
		return
	}
	doc := a.dvDokument()
	if doc == nil || doc.ZugangFingerabdruck != z.ZugangFingerabdruck {
		slog.Warn("direktvermarktung: Zugang mit fremdem Fingerabdruck - verworfen")
		return
	}
	var gueltigBis time.Time
	if z.GueltigBis != "" {
		if t, err := time.Parse(time.RFC3339, z.GueltigBis); err == nil {
			gueltigBis = t
		}
	}
	material := vermarktertunnel.Material{
		vermarktertunnel.CADatei:         []byte(z.Dateien.CAPEM),
		vermarktertunnel.ZertifikatDatei: []byte(z.Dateien.ZertifikatPEM),
		vermarktertunnel.SchluesselDatei: []byte(z.Dateien.SchluesselPEM),
	}
	if z.Dateien.TLSSchluesselPEM != "" {
		material[vermarktertunnel.TLSSchluesselDatei] = []byte(z.Dateien.TLSSchluesselPEM)
	}
	if err := vermarktertunnel.SpeichereZugang(a.dvDir(), vermarktertunnel.Zugang{
		Gegenstelle: vermarktertunnel.Gegenstelle{Host: z.Gegenstelle.Host, Port: z.Gegenstelle.Port,
			Protokoll: z.Gegenstelle.Protokoll},
		TLSSchluessel: z.TLSSchluessel,
		GueltigBis:    gueltigBis,
		Fingerabdruck: z.ZugangFingerabdruck,
	}, material); err != nil {
		slog.Warn("direktvermarktung: Zugang nicht gespeichert", "err", err)
		return
	}
	slog.Info("direktvermarktung: Zugang gespeichert", "partner", z.Partner,
		"fingerabdruck", z.ZugangFingerabdruck)
	a.dvEreignis("zugang gespeichert")
	a.sendeDvQuittung(z.ZugangFingerabdruck, direktvermarkter.QuittungZugestellt)
	a.requestStatusHeartbeat()
}

func (a *Agent) sendeDvAnfrage(fingerabdruck string) {
	a.dvMu.Lock()
	a.dvLetzteAnfrage = time.Now()
	a.dvMu.Unlock()
	if err := a.publishDv(func(link *cloud.Link) error {
		return link.PublishDirektvermarktungAnfrage(direktvermarkter.NeueAnfrage(fingerabdruck, time.Now()))
	}); err != nil {
		slog.Warn("direktvermarktung: Zugangs-Anfrage nicht gesendet", "err", err)
	}
}

func (a *Agent) sendeDvQuittung(fingerabdruck, ereignis string) {
	if err := a.publishDv(func(link *cloud.Link) error {
		return link.PublishDirektvermarktungQuittung(direktvermarkter.NeueQuittung(fingerabdruck, ereignis, time.Now()))
	}); err != nil {
		slog.Warn("direktvermarktung: Quittung nicht gesendet", "ereignis", ereignis, "err", err)
	}
}

func (a *Agent) publishDv(send func(*cloud.Link) error) error {
	a.linkMu.Lock()
	link := a.link
	a.linkMu.Unlock()
	if link == nil {
		return errKeinCloudLink
	}
	return send(link)
}

// dvNachfassen re-asks for a still-missing access at most every
// dvAnfrageAbstand. Called from the heartbeat tick - the one place that
// already runs exactly while the link is up.
func (a *Agent) dvNachfassen() {
	doc := a.dvDokument()
	if doc == nil {
		return
	}
	if z, ok, _ := vermarktertunnel.LadeZugang(a.dvDir()); ok && z.Fingerabdruck == doc.ZugangFingerabdruck {
		return
	}
	a.dvMu.Lock()
	letzte := a.dvLetzteAnfrage
	a.dvMu.Unlock()
	if !letzte.IsZero() && time.Since(letzte) < dvAnfrageAbstand {
		return
	}
	a.sendeDvAnfrage(doc.ZugangFingerabdruck)
}

// dvSummary is the heartbeat block (nil = no connection delivered): the
// tunnel manager's §5.4 view plus the interface's own snapshot. It also
// derives the queries-per-minute rate between two heartbeats.
func (a *Agent) dvSummary() *cloud.DirektvermarktungSummary {
	if a.vermarkter == nil {
		return nil
	}
	st := a.vermarkter.Status()
	if st.Lage == vermarktertunnel.LageOhneProfil {
		return nil
	}
	doc := a.dvDokument()
	out := &cloud.DirektvermarktungSummary{
		Partner: st.Partner,
		Lage:    st.Lage,
	}
	if doc != nil {
		out.Revision = doc.Revision
	}
	if z, ok, _ := vermarktertunnel.LadeZugang(a.dvDir()); ok {
		out.ZugangFingerabdruck = z.Fingerabdruck
	}
	out.VorgabePct = st.VorgabePct
	out.GrenzeKw = st.GrenzeKw
	if st.LetzteAbfrage != nil {
		ts := st.LetzteAbfrage.UTC()
		out.LetzteAbfrageAm = &ts
	}
	if st.Gegenstelle != "" || st.TunnelLebteZuletzt != nil {
		tunnel := &cloud.DirektvermarktungTunnel{Gegenstelle: st.Gegenstelle}
		if st.TunnelLebteZuletzt != nil {
			ts := st.TunnelLebteZuletzt.UTC()
			tunnel.HandshakeAm = &ts
		}
		out.Tunnel = tunnel
	}
	s, ok := a.vermarkter.ServerStand()
	if !ok {
		return out
	}
	now := time.Now()
	if !s.Lebenszeichen.IsZero() {
		ts := s.Lebenszeichen.UTC()
		out.LebenszeichenAm = &ts
	}
	if !s.LetzteSchreibung.IsZero() {
		ts := s.LetzteSchreibung.UTC()
		out.LetzteSchreibungAm = &ts
	}
	a.dvMu.Lock()
	if !a.dvRateAt.IsZero() && now.After(a.dvRateAt) && s.Abfragen >= a.dvRateCount {
		minutes := now.Sub(a.dvRateAt).Minutes()
		if minutes > 0 {
			rate := float64(s.Abfragen-a.dvRateCount) / minutes
			out.AbfragenJeMinute = &rate
		}
	}
	a.dvRateAt = now
	a.dvRateCount = s.Abfragen
	a.dvMu.Unlock()
	if len(s.Werte) > 0 && !s.WerteStand.IsZero() && now.Sub(s.WerteStand) <= dvWerteFrisch {
		w := &cloud.DirektvermarktungWerte{}
		if v, ok := s.Werte["nvp_einspeisung_w"]; ok {
			n := int(v)
			w.EinspeisungW = &n
		}
		if v, ok := s.Werte["erzeugung_w"]; ok {
			n := int(v)
			w.ErzeugungW = &n
		}
		if v, ok := s.Werte["netzbetreiber_vorgabe_pct"]; ok {
			n := int(v)
			w.NetzbetreiberPct = &n
		}
		if v, ok := s.Werte["referenz_w"]; ok {
			n := int(v)
			w.ReferenzW = &n
		}
		out.Werte = w
	}
	return out
}

// dvWerteFrisch mirrors the interface's own input-cache bound: values the
// partner would get a stale exception for are not reported either (§5.1
// "veraltete Telemetrie ist nicht aktuell").
const dvWerteFrisch = 30 * time.Second

var errKeinCloudLink = errors.New("no cloud link")
