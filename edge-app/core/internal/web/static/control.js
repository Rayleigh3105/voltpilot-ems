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

  function onState(s) {
    var d = deriveState(s);
    if (!d) return;
    syncClock(s.server_now_ms);

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
    ROLE_LABEL: ROLE_LABEL,
    PATH_LABEL: PATH_LABEL
  };
})(window);
