// VoltPilot Edge - "First-Light-Kalibrierung": the safe, tightly-bounded surface to
// calibrate a battery inverter's control SIGN + SCALE on the REAL hardware via
// small, observed, auto-reverting test writes, BEFORE the model is certified.
//
// This is the operator surface for the very first real write to a live battery. The
// safety envelope is enforced in the CORE (magnitude cap + TTL auto-revert watchdog +
// guards.Clamp + off by default + global kill-switch); this page only drives it:
// it polls GET /api/calibration for the state + live verdict and POSTs to
// /api/calibration/{arm,test,abort,confirm,correction,certify}. The register-level
// readback ("Kam der Befehl an?") comes from state.control (the card above), handed
// in via VPCalibration.onState(state) from dashboard.js.
(function (global) {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

  var lastCal = null;     // latest /api/calibration snapshot
  var lastControl = null; // state.control (register readback) from the state stream

  function show(el, on) { if (el) el.hidden = !on; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function fmtKw(v) { return v == null ? "–" : nf1.format(v) + " kW"; }
  // Battery power in the SAME convention the portal/cockpit uses: charge POSITIVE,
  // with an explicit sign + a direction word, so the operator can sanity-check it
  // against the cockpit at a glance (e.g. "+31,1 kW · lädt" / "-1,0 kW · entlädt").
  function fmtBatt(v) {
    if (v == null) return "–";
    var body = (v > 0 ? "+" : "") + nf1.format(v) + " kW";
    var word = v > 0.05 ? " · lädt" : v < -0.05 ? " · entlädt" : " · ruht";
    return body + word;
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, body: j }; },
        function () { return { ok: r.ok, body: {} }; });
    });
  }

  function showErr(msg) {
    var e = $("calErr");
    if (!e) return;
    e.textContent = msg || "";
    e.hidden = !msg;
  }

  // applyResp updates the view from a POST response ({calibration, error?}).
  function applyResp(resp) {
    if (resp.body && resp.body.calibration) { lastCal = resp.body.calibration; render(); }
    showErr(!resp.ok && resp.body ? resp.body.error : "");
  }
  var swallow = function () {};

  function fetchCal() {
    fetch("/api/calibration", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.calibration) { lastCal = j.calibration; render(); } })
      .catch(swallow);
  }

  // The magnitude presets, filtered to the hard cap max_kw.
  function populateMag(maxKw) {
    var sel = $("calMag");
    if (!sel || sel.dataset.max === String(maxKw)) return;
    sel.dataset.max = String(maxKw);
    sel.innerHTML = "";
    var presets = [0.2, 0.3, 0.5, 1.0].filter(function (v) { return v <= maxKw + 1e-9; });
    if (presets.length === 0) presets = [maxKw];
    presets.forEach(function (v) {
      var o = document.createElement("option");
      o.value = String(v);
      o.textContent = nf1.format(v) + " kW";
      sel.appendChild(o);
    });
    sel.value = String(presets[Math.min(1, presets.length - 1)]); // default ~0.3 kW
  }

  function setPill(color, text) {
    var w = $("calState");
    show(w, true);
    var dot = w.querySelector(".ss-dot");
    if (dot) dot.style.background = color;
    $("calStateText").textContent = text;
  }

  function statEl(label, val) {
    var d = document.createElement("div");
    d.className = "cal-stat";
    d.innerHTML = '<span class="cal-stat-label">' + esc(label) + '</span>' +
      '<span class="cal-stat-val">' + esc(val) + "</span>";
    return d;
  }

  // "Kam der Befehl an?" from the register readback (state.control).
  function arrived() {
    var c = lastControl;
    if (!c || !c.registers || !c.registers.length) return { ok: null, text: "warte auf Rückmeldung …" };
    return { ok: !!c.all_match, text: c.all_match ? "Register bestätigt" : "Wechselrichter hat den Sollwert nicht übernommen" };
  }

  function checkRow(label, ok, detail) {
    var icon = ok === true ? "✓" : ok === false ? "⚠" : "…";
    var cls = ok === true ? "ok" : ok === false ? "bad" : "wait";
    return '<div class="cal-check ' + cls + '"><span class="cal-check-ico">' + icon + "</span>" +
      '<span class="cal-check-label">' + esc(label) + "</span>" +
      '<span class="cal-check-detail">' + esc(detail) + "</span></div>";
  }

  function renderVerdict(cal) {
    var box = $("calVerdict");
    if (!cal.test) { show(box, false); return; }
    show(box, true);
    var t = cal.test, v = t.verdict || {};
    var dir = t.direction === "charge" ? "Laden" : "Entladen";
    var stale = t.phase === "idle";       // the test is over; the live reading no longer reflects the command
    var landed = !!cal.write_readback_ok; // the CURRENT test's write read back a full register match
    var left = t.phase === "active" ? (t.seconds_left + " s bis Neutral")
      : (t.phase === "revert" ? "schaltet ab …" : (stale ? "veraltet" : "abgeschlossen"));
    var a = arrived();
    var moved = v.measured_kw == null ? "" : " (gemessen " + fmtBatt(v.measured_kw) + ")";

    // "Hat die Batterie sich bewegt?" is only meaningful once the CURRENT test's
    // write has landed (row 1 confirmed) AND while the test is still current. A
    // stale/never-landed test must never show a confident-looking verdict (the exact
    // trap the owner hit); a busy baseline is shown as "not attributable", never a ✓.
    var movementRow;
    if (stale) {
      movementRow = checkRow("Hat die Batterie sich bewegt?", null,
        "Ergebnis vom letzten Test – nicht mehr aktuell. Für ein aktuelles Ergebnis erneut testen.");
    } else if (!landed) {
      movementRow = checkRow("Hat die Batterie sich bewegt?", null,
        "Warte auf bestätigtes Schreiben (siehe oben) – erst danach ist die Bewegung aussagekräftig.");
    } else if (v.baseline_busy) {
      movementRow = checkRow("Hat die Batterie sich bewegt?", null, (v.text || "") + moved);
    } else {
      movementRow = checkRow("Hat die Batterie sich bewegt?", v.sign_ok && v.magnitude_ok, (v.text || "") + moved);
    }

    box.classList.toggle("stale", stale);
    box.innerHTML =
      '<div class="cal-verdict-head"><strong>' + esc(dir) + " · kommandiert " + esc(fmtKw(t.command_kw)) +
      '</strong><span class="cal-count">' + esc(left) + "</span></div>" +
      '<div class="cal-checks">' +
      checkRow("Kam der Befehl an?", a.ok, a.text) +
      movementRow +
      "</div>";
  }

  function render() {
    var cal = lastCal;
    if (!cal || !$("calCard")) return;

    if (!cal.available) {
      show($("calBody"), false);
      show($("calUnavail"), true);
      $("calUnavailText").textContent = cal.reason ||
        "Für diesen Wechselrichter ist keine Batterie-Kalibrierung verfügbar.";
      setPill("var(--muted, #9aa4b2)", cal.certified ? "freigegeben" : "nicht verfügbar");
      return;
    }
    show($("calUnavail"), false);
    show($("calBody"), true);
    populateMag(cal.max_kw || 1);

    var phase = cal.phase;
    var busyPhase = phase === "active" || phase === "revert";
    if (cal.certified) setPill("var(--batt, #34c759)", "freigegeben");
    else if (phase === "active") setPill("var(--brand, #6a8cff)", "Test läuft");
    else if (phase === "revert") setPill("var(--warn, #ff9500)", "schaltet ab");
    else if (cal.armed) setPill("var(--brand, #6a8cff)", "scharf");
    else setPill("var(--muted, #9aa4b2)", "bereit");

    // Live: SoC + measured battery + what is testable right now.
    var live = $("calLive");
    live.innerHTML = "";
    live.appendChild(statEl("Ladestand", cal.soc_pct == null ? "–" : nf0.format(cal.soc_pct) + " %"));
    live.appendChild(statEl("Batterie jetzt", fmtBatt(cal.battery_kw)));
    var testHint = cal.charge_testable && cal.discharge_testable ? "Laden und Entladen testbar"
      : cal.discharge_testable ? "nur Entladen testbar (Akku voll)"
        : cal.charge_testable ? "nur Laden testbar (Akku leer)"
          : "gerade nicht testbar";
    live.appendChild(statEl("Testbar", testHint));

    $("calArm").checked = !!cal.armed;
    $("calArmHint").textContent = cal.certified
      ? "Bereits freigegeben. Sie können bei Bedarf erneut testen."
      : "Erst scharfschalten, dann einen kleinen Test starten. Jeder Test schaltet sich nach kurzer Zeit selbst ab.";

    // Step 2: test controls (only while armed).
    show($("calTestStep"), cal.armed);
    $("calCharge").disabled = !cal.charge_testable || busyPhase;
    $("calDischarge").disabled = !cal.discharge_testable || busyPhase;
    show($("calAbort"), busyPhase);
    if (!busyPhase) showErr("");

    // Step 3: verdict.
    renderVerdict(cal);

    // Correction: once a test has run (so there is something to correct).
    show($("calCorrect"), cal.armed && !!cal.test);
    $("calBattInvert").classList.toggle("active", !!cal.invert_batt_sign);
    $("calInvert").classList.toggle("active", !!cal.invert_control_sign);
    Array.prototype.forEach.call(document.querySelectorAll(".cal-scale-btn"), function (b) {
      b.classList.toggle("active", Number(b.dataset.scale) === cal.power_scale);
    });

    // Confirm + certify. Gap B: the boxes/button only enable once the SYSTEM has
    // objectively observed the movement (write read back + measured verdict) - never on
    // a manual tick alone. An already-set box stays interactive so it can be unticked.
    show($("calConfirm"), cal.armed);
    $("calSign").checked = !!cal.sign_confirmed;
    $("calScale").checked = !!cal.scale_confirmed;
    $("calSign").disabled = !cal.can_confirm_sign && !cal.sign_confirmed;
    $("calScale").disabled = !cal.can_confirm_scale && !cal.scale_confirmed;
    $("calCertify").disabled = !cal.can_certify || cal.certified;
    show($("calDecertify"), !!cal.certified);
    $("calCertHint").textContent = cal.certified
      ? "Dieser Wechselrichter ist freigegeben – der VoltPilot-Fahrplan steuert ihn automatisch. Mit „Freigabe zurücknehmen“ wieder auf nur-lesend stellen."
      : cal.can_certify ? "Vorzeichen und Skala bestätigt – Sie können die Steuerung jetzt freigeben."
        : cal.passed ? "Für die Freigabe fehlt noch eine bestätigte Rückmeldung des Wechselrichters (schreiben + zurücklesen). Bitte einen Testlauf durchführen."
          : "Bestätigen Sie Vorzeichen UND Skala – die Kästchen werden aktiv, sobald sich die Batterie messbar bewegt hat.";
  }

  function startTest(dir) {
    var kw = Number($("calMag").value) || 0.3;
    showErr("");
    post("/api/calibration/test", { direction: dir, magnitude_kw: kw }).then(applyResp).catch(swallow);
  }

  function init() {
    if (!$("calCard")) return;
    $("calArm").addEventListener("change", function () {
      post("/api/calibration/arm", { armed: this.checked }).then(applyResp).catch(swallow);
    });
    $("calCharge").addEventListener("click", function () { startTest("charge"); });
    $("calDischarge").addEventListener("click", function () { startTest("discharge"); });
    $("calAbort").addEventListener("click", function () {
      post("/api/calibration/abort").then(applyResp).catch(swallow);
    });
    $("calBattInvert").addEventListener("click", function () {
      var cur = lastCal && lastCal.invert_batt_sign;
      post("/api/calibration/correction", { invert_batt_sign: !cur }).then(applyResp).catch(swallow);
    });
    $("calInvert").addEventListener("click", function () {
      var cur = lastCal && lastCal.invert_control_sign;
      post("/api/calibration/correction", { invert_control_sign: !cur }).then(applyResp).catch(swallow);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".cal-scale-btn"), function (b) {
      b.addEventListener("click", function () {
        post("/api/calibration/correction", { power_scale: Number(b.dataset.scale) }).then(applyResp).catch(swallow);
      });
    });
    $("calSign").addEventListener("change", function () {
      post("/api/calibration/confirm", { sign: this.checked }).then(applyResp).catch(swallow);
    });
    $("calScale").addEventListener("change", function () {
      post("/api/calibration/confirm", { scale: this.checked }).then(applyResp).catch(swallow);
    });
    $("calCertify").addEventListener("click", function () {
      post("/api/calibration/certify").then(applyResp).catch(swallow);
    });
    $("calDecertify").addEventListener("click", function () {
      post("/api/calibration/decertify").then(applyResp).catch(swallow);
    });
    fetchCal();
    setInterval(fetchCal, 1500);
  }

  // dashboard.js hands each streamed state here for the register readback.
  function onState(s) {
    if (s) lastControl = s.control || null;
    if (lastCal) renderVerdict(lastCal);
  }

  init();
  global.VPCalibration = { onState: onState };
})(window);
