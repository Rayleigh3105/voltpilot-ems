package agent

// Der EINE Applier (Einheitsmodell Stufe 1, Konzept vp-komponenten-einheit-h2
// §7.1/§7.2): auf einer PORTAL-verwalteten Anlage leitet die Box ihre lokale
// Geräte-Konfiguration - Wechselrichter-Auswahl und sources.json - aus dem
// Registry-Push ab, statt sie auf :8484 entstehen zu lassen.
//
// Diese Datei ist ausschliesslich die VERDRAHTUNG. Jede Regel, die eine
// Ableitung verhindern kann, liegt in `internal/componentapply` und ist ohne
// Datei, ohne Bus und ohne Uhr pruefbar (das otaapply/probe-Muster).
//
// ⚠ Es entsteht KEIN zweiter Mechanismus. Angewandt wird ueber genau die
// Speicher und genau die retained Topics, die :8484 seit je benutzt
// (inverter.Store + edge/inverter/config, sources.Store + edge/sources/config) -
// die Selbstverdrahtung, die Telemetrie und jeder Guard sehen byte-identisch
// dasselbe wie vorher. Es wechselt nur der SCHREIBER der lokalen Dateien.
//
// ⚠ NIE teilweise. Der ganze Plan wird zuerst abgeleitet und validiert; laesst
// sich auch nur EIN Geraet nicht uebersetzen, bleibt der bisherige Zustand
// vollstaendig stehen und der Grund wandert in den Herzschlag. Ein halb
// angewandter Lesepfad ist der eine Fehler, der eine Live-Anlage blind macht.

import (
	"errors"
	"fmt"
	"log/slog"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/componentapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// portalManagedHint is the ONE sentence every locally refused edit carries. It
// names the place, never just the refusal - a customer who cannot save must
// know where saving works.
const portalManagedHint = "Die Geräte dieser Anlage werden im VoltPilot-Portal verwaltet. " +
	"Bitte ändern Sie sie dort - diese Seite zeigt hier nur, was gerade läuft."

// restoreComponentRecord loads the persisted apply outcome at boot. It runs
// BEFORE the first push of the session arrives, which is what makes the local
// edit refusal honest while the box is offline: a portal-managed plant stays
// portal-managed across a restart.
func (a *Agent) restoreComponentRecord() {
	if a.compStore == nil {
		return
	}
	rec, ok, err := a.compStore.Load()
	if err != nil {
		slog.Warn("gespeicherter Anwende-Stand der Komponenten unlesbar; Anlage gilt als box-verwaltet",
			"err", err)
		return
	}
	if !ok {
		return
	}
	a.compMu.Lock()
	a.compRecord = rec
	a.compMu.Unlock()
	slog.Info("Komponenten-Verwaltung wiederhergestellt", "authority", rec.Authority,
		"revision", rec.Revision)
}

// componentRecord returns the current apply record (a copy).
func (a *Agent) componentRecord() componentapply.Record {
	a.compMu.Lock()
	defer a.compMu.Unlock()
	return a.compRecord
}

// PortalManagedComponents reports whether this plant's device configuration is
// owned by the portal. Only TRUE once a portal-managed push was really applied:
// the marker alone is not a takeover, because a plant whose portal has no
// components yet must keep its working local setup AND its local edit surface.
func (a *Agent) PortalManagedComponents() bool {
	r := a.componentRecord()
	return r.Authority == componentapply.AuthorityPortal && r.Revision != ""
}

// refuseIfPortalManaged is the gate every LOCAL device-configuration mutation
// passes. It is the enforcement of §7.2's "je Anlage genau EIN Autoritaets-
// Zustand" - without it a portal-managed plant would have two writers and the
// next push would silently discard whatever was typed at the device.
//
// Deliberately NOT applied to the read paths, to the calibration/curtailment
// surfaces or to any of the box-local features (Portal-Kopplung, Not-Aus,
// Despike, OTA, Modbus-Spiegel): those stay at the device by design (§4.3), and
// the :8484 read-only mirror of the device groups is Stufe 2.
func (a *Agent) refuseIfPortalManaged() error {
	if !a.PortalManagedComponents() {
		return nil
	}
	return &inverter.ValidationError{Msg: portalManagedHint}
}

// applyComponentsFromRegistry is called with EVERY applied registry. It decides
// in this order: is this plant portal-managed at all -> does the push name any
// device -> does the whole derivation validate -> does it change anything.
//
// Returns without touching a thing on a box-managed plant, so a plant that
// exists today behaves byte-for-byte as before this build.
func (a *Agent) applyComponentsFromRegistry(reg entities.Registry) {
	if !componentapply.IsPortalManaged(reg) {
		// A box-managed plant. If we PREVIOUSLY were portal-managed, the portal
		// handed authority back - record that, but never undo the configuration:
		// what runs keeps running, it is simply editable at the device again.
		a.releaseComponentAuthority(reg)
		return
	}

	// Die aktuell laufende Geräteliste reist MIT in die Ableitung: ein Gerät,
	// das diese Box schon fährt, behält seine lokale Kennung, statt eine neue
	// zu bekommen (componentapply, vierte Regel). Ohne das riss eine Übernahme
	// die Portal-Pins jeder Anlage auf, deren Quellen vor den deterministischen
	// Kennungen entstanden sind.
	a.srcMu.Lock()
	running := append([]sources.Source(nil), a.srcs...)
	a.srcMu.Unlock()

	plan, err := componentapply.Derive(reg, a.invCat, running, time.Now())
	if err != nil {
		if errors.Is(err, componentapply.ErrNoConfiguration) {
			// The plant is portal-managed but the portal has not described a
			// device yet. That is a normal state during onboarding - and it is
			// emphatically NOT an instruction to clear anything.
			slog.Info("Portal-verwaltete Anlage ohne Geräte-Konfiguration; lokal bleibt alles unverändert",
				"revision", reg.Revision)
			return
		}
		a.recordComponentRefusal(reg.Revision, err.Error())
		slog.Error("Geräte-Konfiguration aus dem Portal NICHT angewandt (nichts geändert)",
			"revision", reg.Revision, "grund", err.Error())
		return
	}

	a.invMu.Lock()
	current := a.inv
	a.invMu.Unlock()
	a.srcMu.Lock()
	currentSources := append([]sources.Source(nil), a.srcs...)
	a.srcMu.Unlock()

	if plan.SameAs(current, currentSources) {
		// The Übernahme-is-a-no-op property, made observable: an unchanged plan
		// writes no file and republishes no retained topic.
		a.markComponentsApplied(plan.Revision)
		slog.Info("Geräte-Konfiguration aus dem Portal: keine Änderung", "revision", plan.Revision)
		return
	}

	if err := a.writeComponentPlan(plan); err != nil {
		a.recordComponentRefusal(reg.Revision, err.Error())
		slog.Error("Geräte-Konfiguration aus dem Portal konnte nicht gespeichert werden",
			"revision", reg.Revision, "err", err)
		return
	}
	a.markComponentsApplied(plan.Revision)
	slog.Info("Geräte-Konfiguration aus dem Portal angewandt", "revision", plan.Revision,
		"wechselrichter", plan.Inverter != nil, "geraete", len(plan.Sources))
}

// writeComponentPlan persists and publishes the derived configuration.
//
// Ordering is deliberate: BOTH files are written before ANY retained publish.
// A failed write therefore leaves disk and the local bus consistent with the
// previous state (the AddSource/DeleteSource rollback discipline), instead of a
// Node-RED that self-wires to a configuration the box forgets on reboot.
func (a *Agent) writeComponentPlan(plan componentapply.Plan) error {
	if plan.Inverter != nil && a.invStore != nil {
		if err := a.invStore.Save(*plan.Inverter); err != nil {
			return fmt.Errorf("Wechselrichter-Auswahl nicht gespeichert: %w", err)
		}
	}
	if a.srcStore != nil {
		if err := a.srcStore.Save(plan.Sources); err != nil {
			return fmt.Errorf("Geräteliste nicht gespeichert: %w", err)
		}
	}

	if plan.Inverter != nil {
		sel := *plan.Inverter
		a.invMu.Lock()
		a.inv = &sel
		a.invMu.Unlock()
		a.State.Update(func(s *state.Snapshot) { s.Inverter = inverterInfo(&sel) })
		a.applyMirrorNativeUnit()
		// The platform control certification is matched on brand+model+family, so
		// a changed selection can gain or lose the grant (the SetInverter rule).
		a.refreshPlatformCertAfterSelectionChange()
	}
	a.srcMu.Lock()
	a.srcs = append([]sources.Source(nil), plan.Sources...)
	// Readings of devices that are no longer configured must not keep feeding
	// the fold (the DeleteSource discipline).
	for id := range a.srcReadings {
		if !hasSourceID(plan.Sources, id) {
			delete(a.srcReadings, id)
		}
	}
	a.srcMu.Unlock()

	a.publishInverterConfig()
	a.publishSourcesConfig()
	a.reapplyEnvelope()
	return nil
}

func hasSourceID(list []sources.Source, id string) bool {
	for _, s := range list {
		if s.ID == id {
			return true
		}
	}
	return false
}

// markComponentsApplied records a successful apply (and clears any previous
// refusal - a later push that works is the answer to an earlier one that did not).
func (a *Agent) markComponentsApplied(revision string) {
	a.compMu.Lock()
	rec := componentapply.NewRecord(componentapply.AuthorityPortal, revision, time.Now()).Cleared()
	a.compRecord = rec
	a.compMu.Unlock()
	a.persistComponentRecord(rec)
}

// recordComponentRefusal keeps the LAST APPLIED revision and records why the
// newest one was refused. The box keeps running what really works; claiming the
// new revision is live would be the fabrication this codebase does not do.
func (a *Agent) recordComponentRefusal(revision, reason string) {
	a.compMu.Lock()
	rec := a.compRecord
	rec.Authority = componentapply.AuthorityPortal
	rec = rec.WithRefusal(revision, reason)
	a.compRecord = rec
	a.compMu.Unlock()
	a.persistComponentRecord(rec)
}

// releaseComponentAuthority records that the plant is (again) box-managed. It
// never rewrites the configuration: handing authority back means the device may
// be edited locally again, not that what runs should change.
func (a *Agent) releaseComponentAuthority(reg entities.Registry) {
	a.compMu.Lock()
	if a.compRecord.Authority != componentapply.AuthorityPortal {
		a.compMu.Unlock()
		return
	}
	rec := componentapply.Record{Version: componentapply.StateVersion,
		Authority: componentapply.AuthorityBox}
	a.compRecord = rec
	a.compMu.Unlock()
	a.persistComponentRecord(rec)
	slog.Info("Geräte-Konfiguration wieder box-verwaltet", "revision", reg.Revision)
}

func (a *Agent) persistComponentRecord(rec componentapply.Record) {
	if a.compStore == nil {
		return
	}
	if err := a.compStore.Save(rec); err != nil {
		slog.Error("Anwende-Stand der Komponenten nicht gespeichert", "err", err)
	}
}
