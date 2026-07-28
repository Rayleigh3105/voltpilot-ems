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
  // The admin token gating the calibration MUTATION endpoints (opt-in: only when the
  // device has VP_CALIBRATION_ADMIN_SECRET set). Kept in sessionStorage so it survives a
  // reload within the tab but never persists to disk; sent as X-VP-Calibration-Token.
  var adminToken = "";
  try { adminToken = sessionStorage.getItem("vp.cal.token") || ""; } catch (e) { adminToken = ""; }

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
  // The -0,0 kW tile fix (Defect 3) already landed on main (#249), so this keeps it.
  function fmtBatt(v) {
    if (v == null) return "–";
    // Collapse a value that rounds to zero at 1 decimal (e.g. a small negative in
    // the "ruht" deadband) to POSITIVE zero, so it never renders as "-0,0 kW" - a
    // negative zero would undermine the very sign-trust this tile exists to build.
    var r = Math.round(v * 10) / 10;
    if (r === 0) r = 0;
    var body = (r > 0 ? "+" : "") + nf1.format(r) + " kW";
    var word = v > 0.05 ? " · lädt" : v < -0.05 ? " · entlädt" : " · ruht";
    return body + word;
  }

  function post(path, body) {
    var headers = { "Content-Type": "application/json" };
    if (adminToken) headers["X-VP-Calibration-Token"] = adminToken;
    return fetch(path, {
      method: "POST",
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; },
        function () { return { ok: r.ok, status: r.status, body: {} }; });
    });
  }

  function showErr(msg) {
    var e = $("calErr");
    if (!e) return;
    e.textContent = msg || "";
    e.hidden = !msg;
  }

  // applyResp updates the view from a POST response ({calibration, error?}). A 401
  // (auth_required) means the admin gate rejected the token: forget it so the card
  // re-shows the password prompt.
  function applyResp(resp) {
    if (resp.status === 401 || (resp.body && resp.body.auth_required)) {
      adminToken = "";
      try { sessionStorage.removeItem("vp.cal.token"); } catch (e) {}
    }
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

  // The test-power ladder, provided by the server derived from the inverter's rated
  // power (Defect 2), so the smallest rung actually moves the battery on a big unit. The
  // server already caps every rung to the hard envelope max_kw.
  function populateMag(cal) {
    var sel = $("calMag");
    if (!sel) return;
    var steps = (cal.test_steps && cal.test_steps.length) ? cal.test_steps.slice()
      : [0.2, 0.3, 0.5, 1.0].filter(function (v) { return v <= (cal.max_kw || 1) + 1e-9; });
    var key = steps.join(",");
    if (sel.dataset.steps !== key) {
      sel.dataset.steps = key;
      sel.innerHTML = "";
      steps.forEach(function (v) {
        var o = document.createElement("option");
        o.value = String(v);
        o.textContent = nf1.format(v) + " kW";
        sel.appendChild(o);
      });
      sel.value = String(steps[Math.min(1, steps.length - 1)]); // default ~3 % rung
    }
    // Defect 3: if rated power is unknown the ladder is a generic fallback - say why,
    // rather than silently offering steps that may not fit the plant size.
    var note = $("calRatedNote");
    if (note) {
      var unknown = !(cal.rated_kw > 0);
      note.hidden = !unknown;
      if (unknown) {
        note.textContent = "Nennleistung des Wechselrichters unbekannt – es werden Standard-Teststufen angeboten. " +
          "Bitte die Wechselrichter-Auswahl erneut speichern, damit die Teststufen zur Anlagengröße passen.";
      }
    }
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
    var active = t.phase === "active";
    var landed = !!cal.write_readback_ok; // the CURRENT test's write read back a full register match
    // Defect 1: after a test auto-reverts, its measured result stays confirmable for a
    // grace window. While it is valid we show the FINISHED test's captured result (with
    // its age), not the reverted-to-neutral live reading; the boxes stay enabled. Past
    // the window it is honestly stale again.
    var showingEvidence = !active && !!cal.evidence_valid;
    var staleExpired = !active && !cal.evidence_valid;

    var left;
    if (active) left = t.seconds_left + " s bis Neutral";
    else if (showingEvidence) left = "Ergebnis des letzten Tests (vor " + nf0.format(cal.evidence_age_seconds || 0) + " s)";
    else if (t.phase === "revert") left = "schaltet ab …";
    else left = "veraltet";

    var a = arrived();
    var moved = v.measured_kw == null ? "" : " (gemessen " + fmtBatt(v.measured_kw) + ")";

    // "Hat die Batterie sich bewegt?" is only meaningful once the CURRENT test's write
    // has landed. A never-landed or fully-expired test must never show a confident-looking
    // verdict (the trap the owner hit); a busy baseline is "not attributable", never a ✓.
    var movementRow;
    if (staleExpired) {
      movementRow = checkRow("Hat die Batterie sich bewegt?", null,
        "Ergebnis vom letzten Test – nicht mehr aktuell. Für ein aktuelles Ergebnis erneut testen.");
    } else if (!active && showingEvidence) {
      // The captured, still-confirmable result of the finished test.
      movementRow = checkRow("Hat die Batterie sich bewegt?", v.sign_ok && v.magnitude_ok, (v.text || "") + moved);
    } else if (!landed) {
      movementRow = checkRow("Hat die Batterie sich bewegt?", null,
        "Warte auf bestätigtes Schreiben (siehe oben) – erst danach ist die Bewegung aussagekräftig.");
    } else if (v.baseline_busy) {
      movementRow = checkRow("Hat die Batterie sich bewegt?", null, (v.text || "") + moved);
    } else {
      // Active + landed. When nothing moved, name the next larger step to try (Defect 2).
      var detail = (v.text || "") + moved;
      var notMoving = !v.sign_ok && !v.magnitude_ok && !v.sign_inverted;
      if (notMoving && t.next_step_kw != null) {
        detail += " – z. B. mit " + nf1.format(t.next_step_kw) + " kW erneut testen.";
      }
      movementRow = checkRow("Hat die Batterie sich bewegt?", v.sign_ok && v.magnitude_ok, detail);
    }

    box.classList.toggle("stale", staleExpired);
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
    populateMag(cal);

    // Admin gate (opt-in): when the device has a secret set and we do not hold a token,
    // show the password prompt; the mutation controls below are enforced server-side.
    show($("calAuth"), !!cal.admin_gate && !adminToken);

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

    // The register evidence table left this page (it is live monitoring and
    // lives on "Betrieb" under Technikmodus) - while a calibration is armed or
    // a test is running, the workflow links to it.
    show($("calRegisterLink"), !!cal.armed || busyPhase);

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

  function unlock() {
    var inp = $("calToken");
    var val = inp ? inp.value.trim() : "";
    if (!val) { showErr("Bitte das Administrator-Kennwort eingeben."); return; }
    adminToken = val;
    try { sessionStorage.setItem("vp.cal.token", val); } catch (e) {}
    if (inp) inp.value = "";
    showErr("");
    render();      // hides the auth block; the token now rides every mutation
    fetchCal();
  }

  function init() {
    if (!$("calCard")) return;
    if ($("calUnlock")) $("calUnlock").addEventListener("click", unlock);
    if ($("calToken")) $("calToken").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); unlock(); }
    });
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
