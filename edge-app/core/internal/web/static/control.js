// VoltPilot Edge - the control surface. Read-only. Nothing here commands the
// inverter; it renders what the core already decided.
//
// TWO layers, and the split is the point:
//   1. deriveState(s) - a PURE function returning the plain-German STATE of the
//      control path plus, whenever something is wrong, its `reason`. This is
//      what the customer sees on "Betrieb", ALWAYS, with Technikmodus OFF.
//   2. the register table (commanded vs. actual per register, the control path
//      name, the remote status register) - the technician's evidence. On
//      "Betrieb" it sits in a `.tech-only` block; on "Einrichten" the same
//      markup is rendered without that class, because commissioning IS the
//      moment you need it.
// A hidden register table therefore never hides a CAUSE - the cause is in
// layer 1, in normal mode.
//
// Data path: the page controller hands each streamed device state to
// VPControl.onState(state); this reads state.control (the latest edge/control/
// readback the core folded into the snapshot) + state.control_enabled /
// state.control_certified / state.inverter to pick the right honest state.
(function (global) {
  "use strict";

  var $ = function (id) { return global.document.getElementById(id); };
  var nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  var clockOffset = 0;
  function syncClock(ms) { if (ms) clockOffset = ms - Date.now(); }
  function ago(iso) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    var s = Math.max(0, Math.round((Date.now() + clockOffset - t) / 1000));
    if (s < 60) return "vor " + s + " s";
    if (s < 3600) return "vor " + Math.round(s / 60) + " Min.";
    return "vor " + Math.round(s / 3600) + " Std.";
  }

  // Plain-German label per control role (no Modbus jargon leaks into the table
  // text beyond the register address, which the technician needs).
  var ROLE_LABEL = {
    battery_power: "Batterie-Leistung",
    control_enable: "Steuerung aktiv",
    pv_limit: "PV-Begrenzung",
    work_mode: "Arbeitsmodus",
    grid_charge_enable: "Netzladen",
    battery_target_soc: "Ziel-SoC",
    // Deye REMOTE MODE (registers 1100-1121) - the Tier-2 signed-watt setpoint.
    remote_mode: "Fernsteuerung aktiv",
    remote_watchdog: "Totmannschalter",
    power_control_mode: "Regelseite",
    battery_strategy: "Regelstrategie",
    battery_soc_belt: "SoC-Grenze im Gerät",
  };

  // The control PATH this inverter is being steered through. Plain German, because
  // the operator must be able to see WHICH surface is driving the battery.
  var PATH_LABEL = {
    remote: "Fernsteuerung (Remote Mode)",
    tou: "Zeitfenster-Steuerung (ToU)",
  };
  var PATH_HINT = {
    remote: "Direkter Leistungssollwert. Der Wechselrichter bricht die Steuerung von " +
      "selbst ab, wenn VoltPilot verstummt - Ihre Einstellungen werden dabei nicht verändert.",
    tou: "Steuerung über ein Zeitfenster-Programm des Wechselrichters.",
  };

  // Plain-German label per readback source. "calibration" = a First-Light test
  // write (the source the uncertified-device evidence path renders).
  var SRC_LABEL = { schedule: "Fahrplan", "default": "Eigenverbrauch", calibration: "Kalibrier-Test" };

  var MISMATCH_CONFLICT =
    "Der Wechselrichter hält den Sollwert nicht. Möglicher Konflikt: die eigene " +
    "Smart-Steuerung des Wechselrichters oder ein zweites EMS könnte gegensteuern - " +
    "VoltPilot muss der einzige Controller sein (alternativ: Strom-/SoC-Grenze oder Register-Adresse prüfen).";
  var MISMATCH_PLAIN =
    "Der Wechselrichter hat den Sollwert nicht übernommen. " +
    "Mögliche Ursache: Strom-/SoC-Grenze oder eine falsche Register-Adresse.";

  /* ------------------------------------------------------------------
     Layer 1: the pure state derivation.

     Returns { chip: {tone,label}|null, title, text, showNow, showTable,
               calibrating, banner }
     `text` is the plain-German REASON whenever something is not simply fine -
     it is always rendered in normal mode. The branch ORDER is byte-identical
     to the pre-rebuild logic; only the rendering moved.
     ------------------------------------------------------------------ */
  function deriveState(s) {
    if (!s) return null;
    var inv = s.inverter;
    var c = s.control;

    // No inverter chosen yet -> the control surface is not applicable.
    if (!inv || !inv.configured) {
      return {
        chip: null,
        title: "Noch keine Steuerung.",
        text: "Wählen Sie zuerst Ihren Wechselrichter aus. Danach schreibt VoltPilot den " +
          "Fahrplan und liest ihn zurück - hier sehen Sie, ob der Wechselrichter ihn übernimmt.",
        showNow: false, showTable: false, calibrating: false, banner: null
      };
    }

    // First-Light calibration is the chicken-and-egg case: the model is (still)
    // UNCERTIFIED, yet the calibration write produced a register readback - and on
    // an uncertified device a readback can ONLY come from a calibration test
    // (production writes nothing until the family is certified). That evidence must
    // not be swallowed by the read-only banner. Showing evidence certifies NOTHING.
    var calibrating = s.control_certified === false && !!(c && c.registers && c.registers.length > 0);

    // Selected but not bench-certified AND no calibration evidence -> genuinely
    // read-only (keep the honest "not yet released" statement).
    if (s.control_certified === false && !calibrating) {
      return {
        chip: { tone: "muted", label: "nur lesen" },
        title: "Steuerung für dieses Modell noch nicht freigegeben.",
        text: "Dieser Wechselrichter wird ausgelesen, aber noch nicht gesteuert. Die " +
          "Freigabe erfolgt nach der Prüfung am Prüfstand.",
        showNow: false, showTable: false, calibrating: false, banner: null
      };
    }

    // No readback yet (certified path, but nothing written/confirmed so far).
    if (!c || !c.registers || !c.registers.length) {
      if (s.control_enabled === false) {
        return {
          chip: { tone: "muted", label: "ausgeschaltet" },
          title: "Steuerung ist ausgeschaltet.",
          text: "Die Wechselrichter-Steuerung ist als Sicherheitsvorgabe deaktiviert " +
            "(Not-Aus). VoltPilot liest weiter mit, schreibt aber nichts.",
          showNow: false, showTable: false, calibrating: false, banner: null
        };
      }
      if (c && c.blocked && c.reason) {
        // The control plan is EMPTY because something is WRONG (an unknown
        // nameplate / power scale). Show the CAUSE the operator can act on
        // instead of an eternal "warte auf Rückmeldung".
        return {
          chip: { tone: "warn", label: "angehalten" },
          title: "Steuerung kann gerade nicht ausgeführt werden.",
          text: c.reason,
          showNow: false, showTable: false, calibrating: false, banner: null
        };
      }
      return {
        chip: { tone: "brand", label: "wartet" },
        title: "Noch keine Rückmeldung.",
        text: "Sobald der erste Sollwert geschrieben und zurückgelesen wurde, erscheint " +
          "hier die Bestätigung des Wechselrichters.",
        showNow: false, showTable: false, calibrating: false, banner: null
      };
    }

    // A readback exists: either everything matched, or the inverter is not
    // holding what was commanded (that is a cause, so it is in `text`).
    if (c.all_match) {
      return {
        chip: { tone: "ok", label: calibrating ? "Kalibrierung ✓" : "bestätigt" },
        title: calibrating ? "Kalibrier-Test bestätigt." : "VoltPilot steuert die Anlage.",
        text: calibrating
          ? "Der Testbefehl wurde geschrieben und vom Wechselrichter unverändert zurückgelesen."
          : "Der Wechselrichter hat den geschriebenen Sollwert unverändert zurückgemeldet.",
        showNow: true, showTable: true, calibrating: calibrating, banner: null
      };
    }
    var reason = c.possible_conflict ? MISMATCH_CONFLICT : MISMATCH_PLAIN;
    return {
      chip: { tone: "warn", label: calibrating ? "Kalibrierung: Abweichung" : "Abweichung" },
      title: calibrating
        ? "Kalibrier-Test: der Wechselrichter weicht ab."
        : "Der Wechselrichter übernimmt den Sollwert nicht.",
      text: reason,
      showNow: true, showTable: true, calibrating: calibrating, banner: reason
    };
  }

  /* ---------------------------- rendering ---------------------------- */

  var CHIP_COLOR = {
    ok: "var(--batt, #34c759)",
    warn: "var(--warn, #ff9500)",
    muted: "var(--muted, #9aa4b2)",
    brand: "var(--brand, #6a8cff)"
  };

  function show(el, on) { if (el) el.hidden = !on; }

  function fmtKw(kw) { return (kw == null ? "–" : nf1.format(kw) + " kW"); }
  function fmtCell(reg, kwField) {
    // "−4,0 kW (4000)" for a power register; "1" style raw for flags.
    var kw = reg[kwField];
    var raw = kwField === "commanded_kw" ? reg.commanded_raw : reg.actual_raw;
    if (kw != null) return fmtKw(kw) + " (" + raw + ")";
    return "" + raw;
  }

  function renderTable(c, calibrating) {
    var rows = $("ctrlRows");
    if (!rows) return;
    rows.innerHTML = "";
    for (var j = 0; j < c.registers.length; j++) {
      var r = c.registers[j];
      var tr = global.document.createElement("tr");
      if (!r.match) tr.className = "mismatch";
      var label = (ROLE_LABEL[r.role] || r.role) + ' <span class="ctrl-addr">Reg ' + r.addr + "</span>";
      tr.innerHTML =
        "<td>" + label + "</td>" +
        "<td>" + fmtCell(r, "commanded_kw") + "</td>" +
        "<td>" + fmtCell(r, "actual_kw") + "</td>" +
        '<td class="ctrl-verdict ' + (r.match ? "ok" : "bad") + '">' +
          (r.match ? "✓ bestätigt" : "⚠ Abweichung") + "</td>";
      rows.appendChild(tr);
    }

    // The technical note: which surface is steering + the remote status register
    // + the readback age. Detail on top of the sentence above, never instead.
    var note = $("ctrlTechNote");
    if (note) {
      var bits = [];
      bits.push("Familie " + (c.family || "unbekannt"));
      if (c.control_path && PATH_LABEL[c.control_path]) {
        bits.push("Steuerpfad: " + PATH_LABEL[c.control_path]);
        if (c.control_path === "remote" && c.remote_status_raw != null) {
          bits.push("Status-Register 1121: " + c.remote_status_raw);
        }
      }
      if (calibrating) bits.push("Quelle: Kalibrier-Test");
      bits.push("geprüft " + (ago(c.checked_at) || "gerade eben"));
      note.textContent = bits.join(" · ");
      note.title = (c.control_path && PATH_HINT[c.control_path]) || "";
    }
  }

  function renderNow(s, c, calibrating) {
    var val = $("ctrlCmdVal");
    if (!val) return;
    var batt = null;
    for (var i = 0; i < c.registers.length; i++) {
      if (c.registers[i].role === "battery_power") { batt = c.registers[i]; break; }
    }
    val.textContent = batt && batt.commanded_kw != null ? nf1.format(batt.commanded_kw) : "–";
    var lbl = $("ctrlCmdLabel");
    if (lbl) lbl.textContent = calibrating ? "Kalibrier-Sollwert" : "Fahrplan-Sollwert";
    var badge = $("ctrlModeBadge");
    if (badge) {
      badge.textContent = SRC_LABEL[c.source] || "–";
      badge.className = "plan-now-badge " + (c.source === "schedule" ? "charge" : "idle");
    }
    var sub = $("ctrlNowSub");
    if (sub) {
      // "Steuerung ausgeschaltet" is a CAUSE, so it stays in normal mode.
      sub.textContent = (calibrating ? "Kalibrier-Test · " : "") +
        "Geprüft " + (ago(c.checked_at) || "gerade eben") +
        (s.control_enabled === false ? " · Steuerung ausgeschaltet" : "");
    }
  }

  /* ------------------------------------------------------------------
     PV-Abregelung (Fronius Increment 3): the per-unit curtailment evidence.
     Same two-layer split: deriveCurtail(s) is PURE and returns the plain-
     German state + its CAUSE (always rendered in normal mode); the per-unit
     register tables are the technician's evidence beneath it. Hidden entirely
     while the device reports no curtailment units (older build / no Fronius
     sources) - byte-identical page then.
     ------------------------------------------------------------------ */
  var CURTAIL_ROLE_LABEL = {
    pv_limit_pct: "PV-Begrenzung (%)",
    pv_limit_revert_tms: "Rückfall-Timer",
    pv_limit_enable: "Begrenzung aktiv",
  };
  var ENFORCE_LABEL = {
    ok: "Wirkung bestätigt",
    settling: "Wirkung wird geprüft …",
    unknown: "Wirkung nicht prüfbar (kein aktueller Messwert)",
    inactive: "",
    possible_override: "Möglicher Override",
  };

  function deriveCurtail(s) {
    var units = s && s.curtail_units;
    if (!units || !units.length) return null;

    var overrideReason = null, blockedReason = null;
    var applied = 0, released = 0, observed = 0, capSum = 0, mismatch = false;
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.possible_override && !overrideReason) {
        overrideReason = u.override_reason ||
          "Ein Wechselrichter liefert mehr als seine Begrenzung erlaubt - " +
          "eine lokale Einstellung, Solar.web oder ein Smart Meter könnte die " +
          "Modbus-Begrenzung übersteuern. VoltPilot muss der einzige Controller sein.";
      }
      if (u.blocked && !blockedReason) blockedReason = u.reason || "Einheit nicht erreichbar.";
      if (u.applied && u.mode === "apply") {
        applied++;
        if (u.cap_kw != null) capSum += u.cap_kw;
        if (u.all_match === false) mismatch = true;
      } else if (u.applied && u.mode === "release") {
        released++;
      } else {
        observed++;
      }
    }

    if (overrideReason) {
      return {
        tone: "warn", units: units,
        title: "PV-Abregelung: möglicher Override.",
        text: overrideReason, showTable: true
      };
    }
    if (mismatch) {
      return {
        tone: "warn", units: units,
        title: "PV-Abregelung: der Wechselrichter übernimmt die Begrenzung nicht.",
        text: "Ein Begrenzungs-Register wurde geschrieben, liest aber anders zurück. " +
          "Modbus-Steuerung am Datamanager prüfen.",
        showTable: true
      };
    }
    if (applied > 0) {
      return {
        tone: "ok", units: units,
        title: "VoltPilot begrenzt die PV-Einspeisung.",
        text: "Der Fahrplan regelt gerade ab: " + applied + " Wechselrichter auf zusammen " +
          nf1.format(capSum) + " kW begrenzt (bestätigt).",
        showTable: true
      };
    }
    if (blockedReason) {
      return {
        tone: "warn", units: units,
        title: "PV-Abregelung: Einheit nicht erreichbar.",
        text: blockedReason, showTable: true
      };
    }
    if (released > 0 && observed === 0) {
      return {
        tone: "muted", units: units,
        title: "Keine PV-Begrenzung aktiv.",
        text: "Der Fahrplan sieht gerade keine Abregelung vor - die Wechselrichter laufen frei.",
        showTable: true
      };
    }
    // Observed-only: the plan may curtail, but no unit may be written yet -
    // THE honesty sentence (a plan step that cannot execute must never look
    // executed). The cause is named in normal mode.
    return {
      tone: "muted", units: units,
      title: "PV-Abregelung noch nicht freigegeben.",
      text: "Der Fahrplan kann eine Abregelung vorsehen, aber die Fronius-Wechselrichter " +
        "sind dafür noch nicht freigegeben - geplante Abregelung wird NICHT ausgeführt. " +
        "Freigabe: Einrichten → PV-Abregelung kalibrieren.",
      showTable: true
    };
  }

  function renderCurtailUnits(units) {
    var wrap = $("curtailUnits");
    if (!wrap) return;
    wrap.innerHTML = "";
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var div = global.document.createElement("div");
      div.className = "curtail-unit";
      var head = (u.label || u.source_id) + " · " + (u.target || u.unit_key) +
        " · " + (u.certified ? "freigegeben" : "nicht freigegeben") +
        (u.calibration ? " · Kalibrier-Test" : "");
      var rows = "";
      var regs = u.registers || [];
      for (var j = 0; j < regs.length; j++) {
        var r = regs[j];
        var label = (CURTAIL_ROLE_LABEL[r.role] || r.role) + ' <span class="ctrl-addr">Reg ' + r.addr + "</span>";
        rows += "<tr" + (u.applied && !r.match ? ' class="mismatch"' : "") + ">" +
          "<td>" + label + "</td>" +
          "<td>" + fmtCell(r, "commanded_kw") + "</td>" +
          "<td>" + fmtCell(r, "actual_kw") + "</td>" +
          '<td class="ctrl-verdict ' + (u.applied ? (r.match ? "ok" : "bad") : "") + '">' +
          (u.applied ? (r.match ? "✓ bestätigt" : "⚠ Abweichung") : "nur beobachtet") + "</td></tr>";
      }
      var bits = [];
      bits.push(u.mode === "apply"
        ? ("Begrenzung " + (u.cap_kw != null ? nf1.format(u.cap_kw) + " kW" : "–"))
        : "keine Begrenzung (freigegeben)");
      if (u.measured_kw != null) bits.push("gemessen " + nf1.format(u.measured_kw) + " kW");
      var enf = ENFORCE_LABEL[u.enforcement_status];
      if (enf) bits.push(enf);
      if (u.blocked && u.reason) bits.push(u.reason);
      bits.push("geprüft " + (ago(u.checked_at) || "gerade eben"));
      div.innerHTML =
        '<p class="tech-h">' + head + "</p>" +
        (rows
          ? '<div class="ctrl-table-wrap"><table class="ctrl-table"><thead>' +
            "<tr><th>Register</th><th>Befohlen</th><th>Wechselrichter</th><th>Status</th></tr>" +
            "</thead><tbody>" + rows + "</tbody></table></div>"
          : "") +
        '<p class="tech-note">' + bits.join(" · ") + "</p>";
      wrap.appendChild(div);
    }
  }

  function renderCurtail(s) {
    var card = $("curtailCard");
    if (!card) return;
    var d = deriveCurtail(s);
    show(card, !!d);
    if (!d) return;
    var title = $("curtailTitle");
    if (title) title.textContent = d.title;
    var text = $("curtailText");
    if (text) text.textContent = d.text;
    var sum = $("curtailSummary");
    if (sum) sum.className = "ctrl-summary " + d.tone;
    var dot = card.querySelector(".ss-dot");
    if (dot) dot.style.background = CHIP_COLOR[d.tone] || CHIP_COLOR.muted;
    renderCurtailUnits(d.units);
  }

  function onState(s) {
    var d = deriveState(s);
    if (!d) return;
    syncClock(s.server_now_ms);
    renderCurtail(s);

    var chipWrap = $("ctrlState");
    if (chipWrap) {
      show(chipWrap, !!d.chip);
      if (d.chip) {
        var dot = chipWrap.querySelector(".ss-dot");
        if (dot) dot.style.background = CHIP_COLOR[d.chip.tone] || CHIP_COLOR.muted;
        var t = $("ctrlStateText");
        if (t) t.textContent = d.chip.label;
      }
    }

    // Layer 1 - always visible, always names the reason.
    var title = $("ctrlSummaryTitle");
    if (title) title.textContent = d.title;
    var text = $("ctrlSummaryText");
    if (text) text.textContent = d.text;
    var summary = $("ctrlSummary");
    if (summary) summary.className = "ctrl-summary" + (d.chip ? " " + d.chip.tone : "");

    var banner = $("ctrlBanner");
    if (banner) {
      show(banner, !!d.banner);
      if (d.banner) { banner.className = "ctrl-banner warn"; banner.textContent = "⚠ " + d.banner; }
    }

    show($("ctrlNow"), d.showNow);
    show($("ctrlTech"), d.showTable);
    if (d.showNow) renderNow(s, s.control, d.calibrating);
    if (d.showTable) renderTable(s.control, d.calibrating);
  }

  global.VPControl = {
    onState: onState,
    deriveState: deriveState,
    deriveCurtail: deriveCurtail,
    ROLE_LABEL: ROLE_LABEL,
    PATH_LABEL: PATH_LABEL
  };
})(window);
