// VoltPilot Edge - Netz-Sollwert-Test (Konzept `vp-deye-netzseitig-drossel-k2`
// P1, Captain-Entscheide E1/E2/E5/E7).
//
// Die Flaeche des begrenzten, armierten Testpfads fuer die NETZSEITIGE
// Regelseite des Deye (Register 1104 = 2). Drei Dinge, die sie tut, und nichts
// darueber hinaus:
//
//   1. Sie NENNT die Voraussetzungen aus §3.1 EINZELN, mit ihrem eigenen
//      Urteil - ein ausgegrauter Knopf ohne Grund waere ein Raetsel (die
//      Canary-Soak-Lehre).
//   2. Sie armiert einen Lauf (POST) und zeigt seine Schritte, seine Messwerte
//      und die verbleibende Zeit.
//   3. Sie bricht ihn ab - und der Abbruch ist der EINE Knopf, der immer da
//      ist, solange etwas laeuft.
//
// ⚠ SIE ENTSCHEIDET NICHTS. Jede Regel (Vorbedingung, Schrittfolge, Frist,
// Urteil) lebt in `internal/curtailcal` und wird hier nur gerendert - eine
// zweite Ableitung im Browser koennte von der des Kerns abdriften, und dann
// stuende auf dem Bildschirm etwas anderes, als das Geraet tut.
//
// Mutationen teilen sich das Betreiber-Kennwort mit der Kalibrierung
// (X-VP-Calibration-Token, sessionStorage "vp.cal.token").
(function (global) {
  "use strict";

  var $ = function (id) { return global.document.getElementById(id); };
  var nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  var adminToken = "";
  try { adminToken = sessionStorage.getItem("vp.cal.token") || ""; } catch (e) { adminToken = ""; }

  // Die deutschen Woerter der Schritte. Sie stehen HIER, weil sie eine reine
  // Anzeige sind; das Vokabular selbst kommt aus dem Kern (`GridStep*`), und
  // ein Schritt, den diese Karte nicht kennt, wird unveraendert ausgegeben
  // statt geraten.
  var STEP_LABEL = {
    neutral: "Neutralschritt (Sollwert auf 0)",
    halten: "Halten: der gemessene Export wird netzseitig kommandiert",
    pv_kappe: "PV-Kappe 999 gesetzt (Register 1115)",
    schritt: "Kleiner Schritt Richtung Netzanschlusspunkt",
    null_export: "Ziel: kein Export mehr (0 kW am Netzpunkt)",
    ac_probe: "AC-seitige Probe (60 s)",
    rueckkehr: "Rueckkehr auf die Batterieseite",
  };
  var SIDE_LABEL = { battery: "Batterieseite", grid: "netzseitig", ac: "AC-seitig" };
  var VERDICT_LABEL = {
    running: "laeuft",
    passed: "bestanden",
    unprovable: "nicht beweisbar",
    no_proof: "kein Nachweis",
    aborted: "abgebrochen",
  };
  var VERDICT_TONE = { passed: "ok", unprovable: "", no_proof: "warn", aborted: "warn", running: "" };

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
    var e = $("gridTestErr");
    if (!e) return;
    e.textContent = msg || "";
    e.hidden = !msg;
  }

  // Ein 401 heisst: das Betreiber-Kennwort fehlt. Genau EINMAL fragen (an den
  // Tab gebunden) - dasselbe Muster wie die Kalibrier-Karte.
  function ensureToken(resp) {
    if (resp.status !== 401 && !(resp.body && resp.body.auth_required)) return false;
    var val = "";
    try { val = global.prompt("Der Netz-Sollwert-Test ist geschützt. Administrator-Kennwort:") || ""; } catch (e) { val = ""; }
    if (!val) { showErr("Ohne Administrator-Kennwort sind keine Änderungen möglich."); return false; }
    adminToken = val;
    try { sessionStorage.setItem("vp.cal.token", val); } catch (e) { /* nur dieser Tab */ }
    return true;
  }

  function act(path, body) {
    showErr("");
    post(path, body).then(function (resp) {
      if (ensureToken(resp)) {
        post(path, body).then(function (retry) {
          if (!retry.ok) showErr((retry.body && retry.body.error) || "Aktion fehlgeschlagen.");
          render(retry.body && retry.body.grid_test);
        });
        return;
      }
      if (!resp.ok) showErr((resp.body && resp.body.error) || "Aktion fehlgeschlagen.");
      render(resp.body && resp.body.grid_test);
    });
  }

  function pill(text, tone) {
    return '<span class="pill ' + (tone || "") + '">' + text + "</span>";
  }

  function kw(v) { return v == null ? "unbekannt" : nf1.format(v) + " kW"; }

  // Die Voraussetzungen, EINZELN. Erfuellte werden ruhig gelistet, offene
  // zuerst - wer den Knopf nicht druecken kann, soll in einer Zeile sehen,
  // woran es liegt.
  function renderPreconditions(pre) {
    if (!pre || !pre.length) return "";
    var open = [], done = [];
    for (var i = 0; i < pre.length; i++) {
      var p = pre[i];
      var line = (p.ok ? "✓ " : "✗ ") + p.label + (p.value ? " (" + p.value + ")" : "");
      (p.ok ? done : open).push(line);
    }
    var out = "";
    if (open.length) out += '<p class="cal-hint grid-open">' + open.join("<br>") + "</p>";
    if (done.length) out += '<p class="cal-hint muted tech-only">' + done.join("<br>") + "</p>";
    return out;
  }

  function renderRun(run) {
    var lines = [];
    lines.push("Schritt: " + (STEP_LABEL[run.step] || run.step) +
      " · " + (SIDE_LABEL[run.side] || run.side));
    if (run.target_kw != null) lines.push("Sollwert am Netzpunkt: " + kw(run.target_kw));
    lines.push("Noch " + run.seconds_remaining + " s");
    lines.push("Register: " + (run.register_ok ? "✓ bestätigt" : "warte auf Bestätigung …"));
    // Der BEWEIS ist ein Plateau am Ziel, nicht ein einzelner Treffer - deshalb
    // zeigt die Karte den Fortschritt dieses Plateaus, nie nur den Messwert.
    lines.push("Am Ziel eingependelt: " + (run.plateau_samples || 0) + " von " +
      (run.plateau_required || 0) + " Messwerten");
    if (run.grid_kw != null) lines.push("Netzpunkt: " + kw(run.grid_kw));
    if (run.deye_pv_kw != null) lines.push("Deye-PV: " + kw(run.deye_pv_kw));
    if (run.ambient_pv_kw != null) lines.push("Vergleichswert (Fronius): " + kw(run.ambient_pv_kw));
    if (run.pv_cap_written) lines.push("PV-Kappe 999 geschrieben (Register 1115)");
    return '<p class="cal-hint">' + lines.join(" · ") + "</p>" +
      '<div class="cal-actions">' +
      '<button type="button" class="cal-btn ghost" data-act="abort">Test abbrechen</button>' +
      "</div>";
  }

  function renderEvidence(ev) {
    if (!ev) return "";
    var lines = [];
    lines.push("Letzter Lauf (" + (SIDE_LABEL[ev.mode === "ac" ? "ac" : "grid"] || ev.mode) + "): " +
      (VERDICT_LABEL[ev.verdict] || ev.verdict));
    if (ev.reason) lines.push(ev.reason);
    lines.push("Register " + (ev.register_confirmed ? "✓" : "✗") +
      " · Wirkung " + (ev.follow_observed ? "✓" : "✗"));
    if (ev.min_grid_kw != null && ev.max_grid_kw != null) {
      lines.push("Netzpunkt im Lauf: " + kw(ev.min_grid_kw) + " bis " + kw(ev.max_grid_kw));
    }
    lines.push("Ausgangslage: Netz " + kw(ev.base_grid_kw) + " · Deye-PV " +
      kw(ev.base_deye_pv_kw) + " · Ladestand " + nf1.format(ev.base_soc_pct) + " %");
    return '<p class="tech-h">Ergebnis ' +
      pill(VERDICT_LABEL[ev.verdict] || ev.verdict, VERDICT_TONE[ev.verdict]) + "</p>" +
      '<p class="cal-hint">' + lines.join(" · ") + "</p>";
  }

  function render(v) {
    var card = $("gridTestCard");
    if (!card) return;
    // Die Karte gibt es nur, wo sie etwas bedeuten kann - genau wie die
    // Fronius-Karte ohne Fronius verschwindet.
    card.hidden = !(v && v.supported);
    if (!v || !v.supported) return;

    var body = $("gridTestBody");
    var empty = $("gridTestEmpty");
    var emptyText = $("gridTestEmptyText");
    if (!body) return;

    var html = "";
    if (v.label || v.target) {
      html += '<p class="tech-h">' + [v.label, v.target].filter(Boolean).join(" · ") + "</p>";
    }

    if (v.run) {
      html += renderRun(v.run);
      if (empty) empty.hidden = true;
      body.innerHTML = html;
      bind(body);
      return;
    }

    html += renderEvidence(v.evidence);
    html += renderPreconditions(v.preconditions);

    if (v.available) {
      html += '<div class="cal-actions">' +
        '<button type="button" class="cal-btn primary" data-act="start">Netz-Sollwert-Test starten (' +
        v.ttl_seconds + " s)</button>" +
        '<button type="button" class="cal-btn ghost tech-only" data-act="start-ac">AC-seitige Probe (' +
        v.ac_ttl_seconds + " s)</button>" +
        "</div>";
      if (empty) empty.hidden = true;
    } else if (empty && emptyText) {
      // Der GRUND bleibt sichtbar, nie ein leeres Feld.
      empty.hidden = false;
      emptyText.textContent = v.reason || "Der Test ist derzeit nicht möglich.";
    }

    body.innerHTML = html;
    bind(body);
  }

  function bind(el) {
    el.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var a = t.getAttribute("data-act");
      if (a === "start") act("/api/curtail/grid-test", { mode: "grid" });
      else if (a === "start-ac") act("/api/curtail/grid-test", { mode: "ac" });
      else if (a === "abort") act("/api/curtail/grid-test/abort");
    });
  }

  function refresh() {
    return fetch("/api/curtail/grid-test").then(function (r) { return r.json(); }).then(function (j) {
      render(j && j.grid_test);
    }).catch(function () { /* voruebergehend - der naechste Takt */ });
  }

  if ($("gridTestCard")) {
    refresh();
    // Waehrend eines Laufs zaehlt jede Sekunde sichtbar herunter; 2 s ist der
    // Kompromiss zwischen „lebendig" und „hoert nie auf zu fragen".
    global.setInterval(refresh, 2000);
  }

  global.VPGridTest = { refresh: refresh, render: render };
})(window);
