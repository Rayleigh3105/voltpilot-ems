// VoltPilot Edge - Neutral-Zeit messen (docs/ota-autonomie.md §3).
// The guided First-Light test that MEASURES the inverter's
// Kommunikations-Verlust-Zeit T at the device instead of a bench session
// with a physically cut cable: command a small departure from neutral,
// confirm it landed, then go completely silent while the normal telemetry
// read path watches the return. Mutations share the calibration admin gate
// (X-VP-Calibration-Token, sessionStorage "vp.cal.token" - the same token
// calibration.js/curtail.js already prompt for on this device). Polls
// GET /api/neutral while the card is on screen.
(function (global) {
  "use strict";

  var $ = function (id) { return global.document.getElementById(id); };

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
    var e = $("neutralErr");
    if (!e) return;
    e.textContent = msg || "";
    e.hidden = !msg;
  }

  // A 401 means the admin gate rejected the token: prompt once (tab-scoped),
  // exactly like the battery calibration + PV-Abregelung cards.
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

  // The honest verdict, in the operator's words - never disguise "nicht
  // beweisbar" (a statement about the RUN, not a defect of the inverter) as
  // either a pass or a failure.
  function verdictPill(verdict) {
    switch (verdict) {
      case "bestanden": return pill("bestanden", "ok");
      case "nicht_beweisbar": return pill("nicht beweisbar", "warn");
      case "kein_nachweis": return pill("kein Nachweis", "warn");
      case "laeuft": return pill("läuft …", "");
      default: return "";
    }
  }

  function render(v) {
    var card = $("neutralCard");
    if (!card) return;
    card.hidden = !v;
    if (!v) return;

    var empty = $("neutralEmpty");
    var body = $("neutralBody");
    if (!body) return;
    if (!v.available) {
      if (empty) { empty.hidden = false; var t = $("neutralEmptyText"); if (t) t.textContent = v.reason || "Neutral-Zeit-Test derzeit nicht verfügbar."; }
      body.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    body.hidden = false;

    var lines = [];
    var actions = "";

    if (v.recorded) {
      lines.push("Belegte Neutral-Zeit: " + v.recorded.seconds + " s (gemessen " + v.recorded.measured_at + ")");
    } else {
      lines.push("Für dieses Modell ist noch keine Neutral-Zeit belegt.");
    }

    if (v.test) {
      var phaseText = v.test.phase === "aktiv"
        ? "Test läuft: Sollwert " + v.test.test_kw + " kW wird geschrieben und bestätigt …"
        : v.test.phase === "still"
          ? "Test läuft: es wird JETZT NICHTS mehr geschrieben - die Box beobachtet, wie lange der Wechselrichter den Sollwert von selbst hält."
          : "Test läuft …";
      lines.push(phaseText);
      lines.push("Register: " + (v.test.register_confirmed ? "✓ bestätigt" : "warte auf Bestätigung …"));
      lines.push("Abweichung von neutral: " + (v.test.departure_confirmed ? "✓ gemessen" : "wird geprüft …"));
      if (v.test.departure_confirmed) {
        lines.push("Rückkehr nach neutral: " + (v.test.settle_samples || 0) + " von " +
          (v.test.settle_required || 0) + " Messwerten in Folge");
      }
      if (v.test.live_battery_kw != null) {
        lines.push("Batterie jetzt: " + v.test.live_battery_kw.toFixed(2) + " kW");
      }
      lines.push("Verbleibende Zeit bis zum sicheren Abbruch: " + (v.test.seconds_remaining || 0) + " s");
      actions += '<button type="button" class="cal-btn ghost" data-act="abort">Test abbrechen</button>';
    } else {
      actions += '<button type="button" class="cal-btn" data-act="test">Neutral-Zeit-Test starten (' +
        v.test_kw + ' kW, max. ' + Math.round((v.test_ttl_seconds || 0) / 60) + ' min)</button>';
    }

    if (v.evidence && v.evidence.valid) {
      var ev = v.evidence;
      var line = "Letztes Ergebnis (vor " + ev.age_seconds + " s): " + verdictPill(ev.verdict);
      if (ev.verdict === "bestanden" && ev.measured_seconds != null) {
        line += " - gemessen " + ev.measured_seconds + " s";
      }
      lines.push(line);
      if (ev.reason) lines.push(ev.reason);
      if (v.can_record) {
        actions += '<button type="button" class="cal-btn primary" data-act="record">Als Nachweis übernehmen</button>';
      }
    }

    body.innerHTML =
      '<p class="cal-hint">' + lines.join("<br>") + "</p>" +
      '<div class="cal-actions">' + actions + "</div>";

    body.onclick = function (ev2) {
      var t = ev2.target;
      if (!t || !t.getAttribute) return;
      var a = t.getAttribute("data-act");
      if (a === "test") act("/api/neutral/test");
      else if (a === "abort") act("/api/neutral/abort");
      else if (a === "record") act("/api/neutral/record");
    };
  }

  function refresh() {
    return fetch("/api/neutral").then(function (r) { return r.json(); }).then(function (j) {
      render(j && j.neutral);
    }).catch(function () { /* transient - next poll */ });
  }

  if ($("neutralCard")) {
    refresh();
    global.setInterval(refresh, 3000);
  }

  // --- Teil C: der Autonomie-Schalter OHNE SHELL (ota/autonomy.json). -----
  // Er setzt AUSSCHLIESSLICH die eine Datei, die der Sidecar ohnehin jeden
  // Takt liest - jedes Tor der Torkette gilt unveraendert.
  var autonomyErr = $("autonomyErr");
  var autonomyToggle = $("autonomyToggle");

  function showAutonomyErr(msg) {
    if (!autonomyErr) return;
    autonomyErr.textContent = msg || "";
    autonomyErr.hidden = !msg;
  }

  function refreshAutonomy() {
    return fetch("/api/ota/autonomy").then(function (r) { return r.json(); }).then(function (au) {
      if (autonomyToggle) autonomyToggle.checked = !!(au && au.enabled);
    }).catch(function () { /* transient - next poll */ });
  }

  if (autonomyToggle) {
    autonomyToggle.addEventListener("change", function () {
      var enabled = autonomyToggle.checked;
      showAutonomyErr("");
      post("/api/ota/autonomy", { enabled: enabled }).then(function (resp) {
        if (ensureToken(resp)) {
          post("/api/ota/autonomy", { enabled: enabled }).then(function (retry) {
            if (!retry.ok) { showAutonomyErr((retry.body && retry.body.error) || "Aktion fehlgeschlagen."); refreshAutonomy(); }
          });
          return;
        }
        if (!resp.ok) { showAutonomyErr((resp.body && resp.body.error) || "Aktion fehlgeschlagen."); refreshAutonomy(); }
      });
    });
    refreshAutonomy();
    global.setInterval(refreshAutonomy, 5000);
  }

  global.VPNeutral = { refresh: refresh, render: render };
})(window);
