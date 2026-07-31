// VoltPilot Edge - PV-Abregelung kalibrieren (Fronius Increment 3).
// The per-UNIT First-Light surface for feed-in curtailment on the
// fronius_sunspec Erzeuger sources: start the bounded test (cap = 80 % of the
// unit's current output, auto-reverting), watch the evidence build (register
// readback confirmed + measured power dropped to the cap), then certify /
// decertify the unit. Mutations share the calibration admin gate
// (X-VP-Calibration-Token, sessionStorage "vp.cal.token" - the calibration.js
// pattern). Polls GET /api/curtail while the card is on screen.
(function (global) {
  "use strict";

  var $ = function (id) { return global.document.getElementById(id); };
  var nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  var adminToken = "";
  try { adminToken = sessionStorage.getItem("vp.cal.token") || ""; } catch (e) { adminToken = ""; }

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
    var e = $("curtailErr");
    if (!e) return;
    e.textContent = msg || "";
    e.hidden = !msg;
  }

  // A 401 means the admin gate rejected the token: prompt once (tab-scoped),
  // exactly like the battery calibration card.
  function ensureToken(resp) {
    if (resp.status !== 401 && !(resp.body && resp.body.auth_required)) return false;
    var val = "";
    try { val = global.prompt("Die Kalibrierung ist geschützt. Administrator-Kennwort:") || ""; } catch (e) { val = ""; }
    if (!val) { showErr("Ohne Administrator-Kennwort sind keine Änderungen möglich."); return false; }
    adminToken = val;
    try { sessionStorage.setItem("vp.cal.token", val); } catch (e) { /* tab-only */ }
    return true; // caller may retry once
  }

  function act(path, body) {
    showErr("");
    post(path, body).then(function (resp) {
      if (ensureToken(resp)) {
        post(path, body).then(function (retry) {
          if (!retry.ok) showErr((retry.body && retry.body.error) || "Aktion fehlgeschlagen.");
          refresh();
        });
        return;
      }
      if (!resp.ok) showErr((resp.body && resp.body.error) || "Aktion fehlgeschlagen.");
      refresh();
    });
  }

  function pill(text, tone) {
    return '<span class="pill ' + (tone || "") + '">' + text + "</span>";
  }

  function renderUnit(v, u) {
    var div = global.document.createElement("div");
    div.className = "cal-unit curtail-unit";
    var head = (u.label || u.source_id) + " · " + u.target;
    var status = u.certified
      ? pill("Abregelung freigegeben", "ok")
      : pill("noch nicht freigegeben", "warn");
    var lines = [];
    if (u.live_pv_kw != null) lines.push("Aktuelle Leistung: " + nf1.format(u.live_pv_kw) + " kW");
    else lines.push("Kein aktueller Messwert - der Test braucht Live-Daten.");
    // The CAUSE of a failed/hanging execution is never hidden: the latest
    // blocked reason from the write path (Gateway nicht erreichbar, Timeout,
    // Discovery fehlgeschlagen, ...) renders right on the card.
    var lastErr = "";
    if (u.last_error) {
      lastErr = "⚠ Letzte Störung: " + u.last_error +
        (u.last_error_age_seconds ? " (vor " + u.last_error_age_seconds + " s)" : "");
    }

    var body = "";
    if (u.test) {
      lines.push("Test läuft: Begrenzung auf " + nf1.format(u.test.cap_kw) + " kW (von " +
        nf1.format(u.test.before_kw) + " kW), noch " + u.test.seconds_remaining + " s");
      lines.push("Register: " + (u.test.register_ok ? "✓ bestätigt" : "warte auf Bestätigung …"));
      lines.push("Tiefster Messwert: " + (u.test.min_observed_kw != null ? nf1.format(u.test.min_observed_kw) + " kW" : "–"));
      body += '<button type="button" class="cal-btn ghost" data-act="abort">Test abbrechen</button>';
    } else {
      if (u.evidence && u.evidence.valid) {
        lines.push("Letzter Test (vor " + u.evidence.age_seconds + " s): Register " +
          (u.evidence.register_confirmed ? "✓" : "✗") + " · Leistung gefallen " +
          (u.evidence.drop_observed ? "✓ (auf " + (u.evidence.min_observed_kw != null ? nf1.format(u.evidence.min_observed_kw) : "?") + " kW)" : "✗"));
      }
      if (u.test_cap_kw != null) {
        body += '<button type="button" class="cal-btn" data-act="test">Test: auf ' +
          nf1.format(u.test_cap_kw) + " kW begrenzen (80 %)</button>";
      } else if (!u.certified) {
        lines.push("Für den Test muss der Wechselrichter mindestens " + nf1.format(v.min_pv_kw) + " kW liefern.");
      }
      if (u.can_certify && !u.certified) {
        body += '<button type="button" class="cal-btn primary" data-act="certify">Abregelung freigeben</button>';
      }
      if (u.certified) {
        body += '<button type="button" class="cal-btn ghost" data-act="decertify">Freigabe zurücknehmen</button>';
      }
    }

    div.innerHTML =
      '<p class="tech-h">' + head + " " + status + "</p>" +
      '<p class="cal-hint">' + lines.join(" · ") + "</p>" +
      (lastErr ? '<p class="cal-hint curtail-err">' + lastErr + "</p>" : "") +
      '<div class="cal-actions">' + body + "</div>";

    div.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var a = t.getAttribute("data-act");
      if (a === "test") act("/api/curtail/test", { source_id: u.source_id });
      else if (a === "abort") act("/api/curtail/abort");
      else if (a === "certify") act("/api/curtail/certify", { source_id: u.source_id });
      else if (a === "decertify") {
        // Nebenwirkungs-Regel (E3): die Rücknahme nennt vorher, was sie für
        // die Anlage bedeutet - der Fahrplan kann diesen Wechselrichter dann
        // nicht mehr abregeln, auch nicht bei negativen Preisen.
        var C = global.VPConsequences;
        if (C && !C.ask(C.curtailDecertify(u))) return;
        act("/api/curtail/decertify", { source_id: u.source_id });
      }
    });
    return div;
  }

  function render(v) {
    var card = $("curtailCalCard");
    if (!card) return;
    var hasUnits = v && v.units && v.units.length > 0;
    card.hidden = !hasUnits;
    if (!hasUnits) return;

    var empty = $("curtailCalEmpty");
    var emptyText = $("curtailCalEmptyText");
    var wrap = $("curtailCalUnits");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!v.available) {
      // The CAUSE (kill-switch off / no sources) stays visible, never a blank.
      if (empty && emptyText) {
        empty.hidden = false;
        emptyText.textContent = v.reason || "Abregelung derzeit nicht verfügbar.";
      }
      return;
    }
    if (empty) empty.hidden = true;
    for (var i = 0; i < v.units.length; i++) wrap.appendChild(renderUnit(v, v.units[i]));
  }

  // The last fetched unit list, so another surface can ask "is this source
  // curtailment-certified?" without owning a second /api/curtail caller
  // (sources.js needs it to name the consequence of deleting the source).
  var lastUnits = [];

  // refresh returns its promise so a caller can await a FRESH answer before
  // asking a consequence question; it never rejects (a transient failure keeps
  // the previous list rather than claiming there are no units).
  function refresh() {
    return fetch("/api/curtail").then(function (r) { return r.json(); }).then(function (j) {
      var v = j && j.curtail;
      lastUnits = (v && v.units) || [];
      render(v);
    }).catch(function () { /* transient - next poll */ });
  }

  if ($("curtailCalCard")) {
    refresh();
    global.setInterval(refresh, 3000);
  }

  global.VPCurtail = { refresh: refresh, render: render, units: function () { return lastUnits; } };
})(window);
