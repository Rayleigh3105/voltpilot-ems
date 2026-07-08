// VoltPilot Edge - "Steuerung & Bestätigung" (inverter control confirmation).
// Read-only. Renders register-level proof that the inverter accepted what the
// schedule dictated: per register the role + address, the commanded value
// (kW + raw), the read-back actual (kW + raw), and an accept/mismatch verdict,
// plus a mismatch banner (report §5.2). Nothing here commands the inverter.
//
// Data path: dashboard.js hands each streamed device state to
// VPControl.onState(state); this reads state.control (the latest edge/control/
// readback the core folded into the snapshot) + state.control_enabled /
// state.control_certified / state.inverter to pick the right honest state.
(function (global) {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
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
  };

  function fmtKw(kw) { return (kw == null ? "–" : nf1.format(kw) + " kW"); }
  function fmtCell(reg, kwField) {
    // "−4,0 kW (4000)" for a power register; "1" style raw for flags.
    var kw = reg[kwField];
    var raw = kwField === "commanded_kw" ? reg.commanded_raw : reg.actual_raw;
    if (kw != null) return fmtKw(kw) + " (" + raw + ")";
    return "" + raw;
  }

  function show(el, on) { if (el) el.hidden = !on; }

  function setState(fill, text) {
    var wrap = $("ctrlState");
    show(wrap, true);
    var dot = wrap.querySelector(".ss-dot");
    if (dot) dot.style.background = fill;
    $("ctrlStateText").textContent = text;
  }

  // Show the calm "not yet controlled" / read-only empty state with honest copy.
  function renderEmpty(title, text) {
    show($("ctrlBody"), false);
    show($("ctrlEmpty"), true);
    $("ctrlEmptyTitle").textContent = title;
    $("ctrlEmptyText").textContent = text;
  }

  function onState(s) {
    if (!s) return;
    syncClock(s.server_now_ms);
    var inv = s.inverter;
    var c = s.control;

    // No inverter chosen yet -> the control surface is not applicable.
    if (!inv || !inv.configured) {
      show($("ctrlState"), false);
      renderEmpty("Noch keine Steuerung.",
        "Wählen Sie zuerst Ihren Wechselrichter aus. Danach schreibt VoltPilot den " +
        "Fahrplan und liest ihn zurück - hier sehen Sie register-genau die Bestätigung.");
      return;
    }

    // Selected but the model is not bench-certified for control -> read-only.
    if (s.control_certified === false) {
      setState("var(--muted, #9aa4b2)", "nur lesen");
      renderEmpty("Steuerung für dieses Modell noch nicht freigegeben.",
        "Dieser Wechselrichter wird ausgelesen, aber noch nicht gesteuert. Die " +
        "Freigabe erfolgt nach der Prüfung am Prüfstand.");
      return;
    }

    // No readback yet (certified, but nothing written/confirmed so far).
    if (!c || !c.registers || !c.registers.length) {
      if (s.control_enabled === false) {
        setState("var(--muted, #9aa4b2)", "ausgeschaltet");
        renderEmpty("Steuerung ist ausgeschaltet.",
          "Die Wechselrichter-Steuerung ist als Sicherheitsvorgabe deaktiviert " +
          "(Not-Aus). VoltPilot liest weiter mit, schreibt aber nichts.");
      } else {
        setState("var(--brand, #6a8cff)", "wartet");
        renderEmpty("Noch keine Rückmeldung.",
          "Sobald der erste Sollwert geschrieben und zurückgelesen wurde, erscheint " +
          "hier die register-genaue Bestätigung.");
      }
      return;
    }

    // We have a readback: render the confirmation table.
    show($("ctrlEmpty"), false);
    show($("ctrlBody"), true);

    var batt = null;
    for (var i = 0; i < c.registers.length; i++) {
      if (c.registers[i].role === "battery_power") { batt = c.registers[i]; break; }
    }
    $("ctrlCmdVal").textContent = batt && batt.commanded_kw != null ? nf1.format(batt.commanded_kw) : "–";
    var badge = $("ctrlModeBadge");
    var src = c.source === "schedule" ? "Fahrplan" : (c.source === "default" ? "Eigenverbrauch" : "–");
    badge.textContent = src;
    badge.className = "plan-now-badge " + (c.source === "schedule" ? "charge" : "idle");
    var enabledNote = s.control_enabled === false ? " · Steuerung ausgeschaltet" : "";
    $("ctrlNowSub").textContent = "Geprüft " + (ago(c.checked_at) || "gerade eben") + enabledNote;

    var banner = $("ctrlBanner");
    if (c.all_match) {
      setState("var(--batt, #34c759)", "bestätigt");
      show(banner, false);
    } else {
      setState("var(--warn, #ff9500)", "Abweichung");
      show(banner, true);
      banner.className = "ctrl-banner warn";
      banner.textContent = "⚠ Der Wechselrichter hat den Sollwert nicht übernommen. " +
        "Mögliche Ursache: Strom-/SoC-Grenze oder eine falsche Register-Adresse.";
    }

    var rows = $("ctrlRows");
    rows.innerHTML = "";
    for (var j = 0; j < c.registers.length; j++) {
      var r = c.registers[j];
      var tr = document.createElement("tr");
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
  }

  global.VPControl = { onState: onState };
})(window);
