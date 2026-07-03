// VoltPilot Edge dashboard - renders the device's own live energy data.
// Loads recent history, then streams live samples + state over SSE (falls back
// to polling if SSE is unavailable). Read-only; everything stays on the device.
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

  // --- clock alignment: chart timestamps are device epoch ms ---
  var clockOffset = 0; // deviceNow = Date.now() + clockOffset
  function deviceNow() { return Date.now() + clockOffset; }
  function syncClock(serverMs) { if (serverMs) clockOffset = serverMs - Date.now(); }

  var pts = [];            // {t,pv,load,grid,soc,batt,limit}
  var rangeMin = 60;       // selected window (minutes)
  var lastState = null;

  // --- charts ---
  var powerChart = new TimeChart($("powerChart"), {
    unit: "kW", zeroLine: true, series: [
      { key: "pv", label: "PV", color: cssVar("--pv"), area: true },
      { key: "load", label: "Haus", color: cssVar("--load") },
      { key: "grid", label: "Netz", color: cssVar("--grid-c") },
      { key: "batt", label: "Batterie", color: cssVar("--batt") }
    ]
  });
  var socChart = new TimeChart($("socChart"), {
    unit: "%", yFixed: [0, 100], series: [
      { key: "soc", label: "SoC", color: cssVar("--batt"), area: true }
    ]
  });

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function windowMs() { return rangeMin * 60 * 1000; }

  function redrawCharts() {
    var xMax = deviceNow();
    var xMin = xMax - windowMs();
    var win = pts.filter(function (p) { return p.t >= xMin - 5000; });
    powerChart.setData(win, xMin, xMax);
    socChart.setData(win, xMin, xMax);

    var hasPower = win.some(function (p) { return p.pv != null || p.load != null || p.grid != null; });
    var hasSoc = win.some(function (p) { return p.soc != null; });
    $("powerEmpty").hidden = hasPower;
    $("socEmpty").hidden = hasSoc;
  }

  function pushSample(s) {
    pts.push(s);
    // Trim to a little beyond the largest window (3h) to bound memory.
    var cutoff = deviceNow() - (180 * 60 * 1000 + 60000);
    while (pts.length && pts[0].t < cutoff) pts.shift();
  }

  // ---------- KPI + status rendering ----------
  function latestVal(key) {
    for (var i = pts.length - 1; i >= 0; i--) {
      if (pts[i][key] != null && !isNaN(pts[i][key])) return pts[i][key];
    }
    return null;
  }

  function kw(v) { return v == null ? "–" : nf1.format(v); }

  function renderKpis(s) {
    var fresh = s.last_telemetry && (serverAge(s.last_telemetry) < 90);
    var pv = latestVal("pv"), load = latestVal("load"), grid = latestVal("grid");
    var soc = latestVal("soc"), batt = latestVal("batt");

    // PV
    $("pvVal").textContent = kw(pv);
    $("pvSub").textContent = pv == null ? "wartet auf Daten" : (pv > 0.05 ? "Anlage erzeugt" : "keine Erzeugung");

    // Battery
    $("socVal").textContent = soc == null ? "–" : nf0.format(soc);
    $("socFill").style.width = (soc == null ? 0 : Math.max(0, Math.min(100, soc))) + "%";
    var bs = $("battState"), bsub = $("battSub");
    if (soc == null) {
      bs.textContent = "–"; bsub.textContent = "keine Batterie erkannt";
    } else if (batt != null && batt > 0.05) {
      bs.textContent = "Lädt"; bsub.innerHTML = "<span class='chip down'>▲ " + nf1.format(batt) + " kW</span> Ladeleistung";
    } else if (batt != null && batt < -0.05) {
      bs.textContent = "Entlädt"; bsub.innerHTML = "<span class='chip up'>▼ " + nf1.format(-batt) + " kW</span> Abgabe";
    } else if (soc >= 99) {
      bs.textContent = "Voll"; bsub.innerHTML = "<span class='chip idle'>bereit</span> vollgeladen";
    } else {
      bs.textContent = "Bereit"; bsub.innerHTML = "<span class='chip idle'>im Ruhezustand</span>";
    }

    // Load
    $("loadVal").textContent = kw(load);
    $("loadSub").textContent = load == null ? "wartet auf Daten" : (load > 0.05 ? "aktueller Bedarf" : "kein Verbrauch");

    // Grid
    $("gridVal").textContent = grid == null ? "–" : nf1.format(Math.abs(grid));
    var gl = $("gridLabel"), gt = $("gridTag"), gsub = $("gridSub");
    if (grid == null) {
      gl.textContent = "Netzanschluss"; gt.textContent = "Netz"; gsub.textContent = "wartet auf Daten";
    } else if (grid > 0.05) {
      gl.textContent = "Netzbezug"; gt.textContent = "Bezug";
      gsub.innerHTML = "<span class='chip up'>▲ Import</span> aus dem Netz";
    } else if (grid < -0.05) {
      gl.textContent = "Netzeinspeisung"; gt.textContent = "Einspeisung";
      gsub.innerHTML = "<span class='chip down'>▼ Export</span> ins Netz";
    } else {
      gl.textContent = "Netzanschluss"; gt.textContent = "Netz";
      gsub.innerHTML = "<span class='chip idle'>ausgeglichen</span>";
    }

    var kpis = $("kpis");
    kpis.classList.toggle("stale", !!s.last_telemetry && !fresh);
  }

  function serverAge(iso) {
    if (!iso) return Infinity;
    return Math.max(0, (deviceNow() - new Date(iso).getTime()) / 1000);
  }
  function ago(iso) {
    var s = serverAge(iso);
    if (!isFinite(s)) return null;
    if (s < 60) return "vor " + Math.round(s) + " s";
    if (s < 3600) return "vor " + Math.round(s / 60) + " min";
    return "vor " + nf1.format(s / 3600) + " h";
  }

  function renderStatus(s) {
    // Mode
    var mv = $("modeVal"), msub = $("modeSub");
    if (s.mode === "fahrplan") {
      mv.className = "status-val ok"; mv.childNodes[0].nodeValue = "Folgt Fahrplan";
      msub.textContent = s.slot_start ? "Slot ab " + hm(s.slot_start) + " Uhr" : "kostenoptimiert";
    } else if (s.mode === "eigenverbrauch") {
      mv.className = "status-val"; mv.childNodes[0].nodeValue = "Eigenverbrauch";
      msub.textContent = "PV & Verbrauch (kein aktueller Fahrplan)";
    } else {
      mv.className = "status-val warn"; mv.childNodes[0].nodeValue = "Wartet";
      msub.textContent = "noch keine Messwerte";
    }

    // Cloud
    var cv = $("cloudVal"), csub = $("cloudSub");
    if (s.cloud_connected) {
      cv.className = "status-val ok"; cv.childNodes[0].nodeValue = "Verbunden";
      csub.textContent = "Daten werden übertragen";
    } else {
      cv.className = "status-val warn"; cv.childNodes[0].nodeValue = "Getrennt";
      csub.textContent = s.buffer_pending > 0
        ? nf0.format(s.buffer_pending) + " Messwerte zwischengespeichert"
        : "Daten werden lokal gepuffert";
    }

    // Inverter link
    var iv = $("invVal"), isub = $("invSub");
    var model = (s.inverter && s.inverter.configured) ? s.inverter.label : null;
    if (s.inverter_link === "up") {
      iv.className = "status-val ok"; iv.childNodes[0].nodeValue = "Verbunden";
      isub.textContent = model || "";
    } else if (s.inverter_link === "down") {
      iv.className = "status-val err"; iv.childNodes[0].nodeValue = "Getrennt";
      isub.textContent = "Verbindung prüfen";
    } else if (model) {
      iv.className = "status-val"; iv.childNodes[0].nodeValue = model;
      isub.textContent = "wartet auf Verbindung";
    } else {
      iv.className = "status-val warn"; iv.childNodes[0].nodeValue = "Nicht eingerichtet";
      isub.innerHTML = "";
      isub.textContent = "unter „Wechselrichter einrichten“";
    }

    // Plan
    var pv = $("planVal"), psub = $("planSub");
    if (s.plan_slots > 0) {
      pv.className = "status-val"; pv.childNodes[0].nodeValue = nf0.format(s.plan_slots) + " Slots";
      psub.textContent = "empfangen " + (ago(s.plan_received) || "");
    } else {
      pv.className = "status-val"; pv.childNodes[0].nodeValue = "–";
      psub.textContent = "noch keiner empfangen";
    }

    // Telemetry freshness
    var tv = $("telVal"), tsub = $("telSub");
    var a = ago(s.last_telemetry);
    if (a) {
      var fresh = serverAge(s.last_telemetry) < 90;
      tv.className = "status-val " + (fresh ? "ok" : "warn");
      tv.childNodes[0].nodeValue = a;
      tsub.textContent = fresh ? "Anlage liefert Daten" : "keine aktuellen Daten";
    } else {
      tv.className = "status-val warn"; tv.childNodes[0].nodeValue = "keine";
      tsub.textContent = "warte auf erste Daten";
    }
  }

  function hm(iso) { return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); }

  // ---------- Cloud pill (topbar) ----------
  function renderPill(s) {
    var pill = $("cloudPill"), txt = $("cloudPillText"), dot = pill.querySelector(".dot");
    if (s.cloud_connected) {
      pill.className = "pill ok"; txt.textContent = "Cloud verbunden"; dot.classList.add("live");
    } else if (s.last_telemetry && serverAge(s.last_telemetry) < 90) {
      pill.className = "pill warn"; txt.textContent = "Lokal aktiv · Cloud getrennt"; dot.classList.remove("live");
    } else {
      pill.className = "pill off"; txt.textContent = "Cloud getrennt"; dot.classList.remove("live");
    }
  }

  // ---------- Pairing card ----------
  function renderPairing(s) {
    $("ref").textContent = s.ref || "…";
    $("version").textContent = (!s.version || s.version === "dev") ? "" : "v" + s.version;

    var reached = s.pairing_state === "verbunden" ? 2
      : s.pairing_state === "zertifikat_erhalten" ? 1 : 0;
    document.querySelectorAll("#steps li").forEach(function (li, i) {
      li.classList.toggle("done", i < reached || (i === 2 && reached === 2));
      li.classList.toggle("active", i === reached && reached < 2);
    });

    var err = $("pairingError");
    if (s.pairing_state === "schluessel_konflikt") {
      err.hidden = false; err.textContent = "Registrierung gesperrt: Für diese Referenz ist bereits ein anderes Gerät registriert. Bitte den Support kontaktieren.";
    } else if (s.pairing_state === "referenz_unbekannt") {
      err.hidden = false; err.textContent = "Diese Geräte-ID ist dem System nicht bekannt. Bitte die Referenz auf dem Aufkleber prüfen.";
    } else { err.hidden = true; }

    // Once fully connected, collapse the onboarding card to a slim confirmation.
    var card = $("pairingCard");
    var connected = s.pairing_state === "verbunden";
    card.classList.toggle("compact", connected);
    $("refBlock").hidden = connected;
    $("refHint").hidden = connected;
    $("steps").hidden = connected;
    if (connected) {
      $("pairingTitle").textContent = "Gerät verbunden";
      $("pairingLead").innerHTML = "Referenz <strong>" + escapeHtml(s.ref || "") + "</strong> · erfolgreich mit VoltPilot gekoppelt.";
    } else {
      $("pairingTitle").textContent = "Gerät mit VoltPilot verbinden";
      $("pairingLead").textContent = "Geben Sie die Referenz-ID im Portal ein - alles Weitere passiert automatisch.";
    }
  }

  function escapeHtml(s) { return s.replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  // ---------- Energy flow diagram ----------
  var flow = buildFlow($("flowWrap"));

  function renderFlow() {
    flow.update({
      pv: latestVal("pv"), load: latestVal("load"),
      grid: latestVal("grid"), batt: latestVal("batt"),
      soc: latestVal("soc")
    });
  }

  // ---------- state application ----------
  function applyState(s) {
    lastState = s;
    syncClock(s.server_now_ms);
    renderPill(s);
    renderPairing(s);
    renderKpis(s);
    renderStatus(s);
    renderFlow();
  }

  // ---------- data loading + streaming ----------
  function loadHistory() {
    return fetch("/api/history?minutes=" + Math.max(rangeMin, 180), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        syncClock(d.server_now_ms);
        pts = (d.samples || []).slice();
        redrawCharts();
        renderFlow();
        if (lastState) renderKpis(lastState);
      })
      .catch(function () { /* stream/poll will fill in */ });
  }

  function startStream() {
    if (!window.EventSource) { startPolling(); return; }
    var es = new EventSource("/api/stream");
    es.addEventListener("state", function (e) {
      try { applyState(JSON.parse(e.data)); redrawCharts(); } catch (_) {}
    });
    es.addEventListener("sample", function (e) {
      try { pushSample(JSON.parse(e.data)); redrawCharts(); if (lastState) { renderKpis(lastState); renderFlow(); } } catch (_) {}
    });
    es.onerror = function () { /* EventSource auto-reconnects */ };
  }

  function startPolling() {
    setInterval(function () {
      fetch("/api/state", { cache: "no-store" }).then(function (r) { return r.json(); })
        .then(function (s) { applyState(s); }).catch(function () {});
      loadHistory();
    }, 3000);
  }

  // ---------- range toggle ----------
  $("rangeSeg").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    rangeMin = parseInt(b.getAttribute("data-min"), 10);
    document.querySelectorAll("#rangeSeg button").forEach(function (x) { x.classList.toggle("active", x === b); });
    redrawCharts();
  });

  // ---------- copy ----------
  $("copyBtn").addEventListener("click", function () {
    var ref = $("ref").textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(ref) : Promise.reject())
      .then(function () {
        $("copyLabel").textContent = "Kopiert ✓";
        setTimeout(function () { $("copyLabel").textContent = "Kopieren"; }, 1500);
      })
      .catch(function () {});
  });

  // Keep the axes scrolling even when idle.
  setInterval(redrawCharts, 1000);

  // ---------- boot ----------
  fetch("/api/state", { cache: "no-store" }).then(function (r) { return r.json(); })
    .then(applyState).catch(function () {});
  loadHistory().then(startStream);

  // ==================================================================
  // Energy flow diagram: four spokes around a central hub. Flow travels
  // along a spoke; direction encodes import/export & charge/discharge.
  // ==================================================================
  function buildFlow(container) {
    var NS = "http://www.w3.org/2000/svg";
    var W = 400, H = 250, hub = { x: 200, y: 128 };
    var nodes = {
      pv:   { x: 200, y: 40,  label: "PV",       color: cssVar("--pv"),     soft: cssVar("--pv-soft") },
      load: { x: 336, y: 128, label: "Haus",     color: cssVar("--load"),   soft: cssVar("--load-soft") },
      grid: { x: 200, y: 216, label: "Netz",     color: cssVar("--grid-c"), soft: cssVar("--grid-soft") },
      batt: { x: 64,  y: 128, label: "Batterie", color: cssVar("--batt"),   soft: cssVar("--batt-soft") }
    };
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    // Base spoke lines + animated flow overlays (node -> hub geometry).
    var spokes = {};
    ["pv", "load", "grid", "batt"].forEach(function (k) {
      var n = nodes[k];
      var base = document.createElementNS(NS, "line");
      base.setAttribute("x1", n.x); base.setAttribute("y1", n.y);
      base.setAttribute("x2", hub.x); base.setAttribute("y2", hub.y);
      base.setAttribute("stroke", "#E3E9F1"); base.setAttribute("stroke-width", "6");
      base.setAttribute("stroke-linecap", "round");
      svg.appendChild(base);
      var flowLine = document.createElementNS(NS, "line");
      flowLine.setAttribute("x1", n.x); flowLine.setAttribute("y1", n.y);
      flowLine.setAttribute("x2", hub.x); flowLine.setAttribute("y2", hub.y);
      flowLine.setAttribute("stroke", n.color); flowLine.setAttribute("stroke-width", "3");
      flowLine.setAttribute("stroke-linecap", "round");
      flowLine.setAttribute("stroke-dasharray", "2 10");
      flowLine.style.opacity = "0";
      svg.appendChild(flowLine);
      spokes[k] = { base: base, flow: flowLine };
    });

    // Hub.
    var hubC = document.createElementNS(NS, "circle");
    hubC.setAttribute("cx", hub.x); hubC.setAttribute("cy", hub.y); hubC.setAttribute("r", "22");
    hubC.setAttribute("fill", "#fff"); hubC.setAttribute("stroke", "#E3E9F1"); hubC.setAttribute("stroke-width", "2");
    svg.appendChild(hubC);
    var hubIco = document.createElementNS(NS, "path");
    hubIco.setAttribute("d", "M13 2 3 14h7l-1 8 10-12h-7l1-8z");
    hubIco.setAttribute("transform", "translate(" + (hub.x - 12) + "," + (hub.y - 12) + ")");
    hubIco.setAttribute("fill", "none"); hubIco.setAttribute("stroke", cssVar("--brand-deep"));
    hubIco.setAttribute("stroke-width", "2"); hubIco.setAttribute("stroke-linejoin", "round"); hubIco.setAttribute("stroke-linecap", "round");
    svg.appendChild(hubIco);

    // Nodes (circle + label + value).
    var nodeEls = {};
    Object.keys(nodes).forEach(function (k) {
      var n = nodes[k];
      var g = document.createElementNS(NS, "g");
      var c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", n.x); c.setAttribute("cy", n.y); c.setAttribute("r", "26");
      c.setAttribute("fill", n.soft); c.setAttribute("stroke", n.color); c.setAttribute("stroke-width", "2");
      g.appendChild(c);
      var lbl = document.createElementNS(NS, "text");
      lbl.setAttribute("x", n.x); lbl.setAttribute("y", n.y - 3);
      lbl.setAttribute("text-anchor", "middle"); lbl.setAttribute("font-size", "10.5");
      lbl.setAttribute("font-weight", "700"); lbl.setAttribute("fill", "#33414F");
      lbl.setAttribute("font-family", "Inter, sans-serif"); lbl.textContent = n.label;
      g.appendChild(lbl);
      var val = document.createElementNS(NS, "text");
      val.setAttribute("x", n.x); val.setAttribute("y", n.y + 11);
      val.setAttribute("text-anchor", "middle"); val.setAttribute("font-size", "10");
      val.setAttribute("font-weight", "600"); val.setAttribute("fill", n.color);
      val.setAttribute("font-family", "Inter, sans-serif"); val.textContent = "–";
      g.appendChild(val);
      svg.appendChild(g);
      nodeEls[k] = { val: val };
    });

    container.innerHTML = "";
    container.appendChild(svg);

    // Inject the flow keyframes once.
    if (!document.getElementById("flowKeyframes")) {
      var st = document.createElement("style");
      st.id = "flowKeyframes";
      st.textContent =
        "@keyframes vpflow{to{stroke-dashoffset:-24}}" +
        ".vp-flow-on{animation:vpflow .9s linear infinite}" +
        ".vp-flow-rev{animation:vpflow .9s linear infinite reverse}";
      document.head.appendChild(st);
    }

    function setSpoke(k, active, reverse, magnitude) {
      var f = spokes[k].flow;
      if (!active) {
        f.style.opacity = "0"; f.classList.remove("vp-flow-on", "vp-flow-rev"); return;
      }
      f.style.opacity = "1";
      var w = Math.max(2.5, Math.min(7, 2.5 + Math.abs(magnitude) * 0.7));
      f.setAttribute("stroke-width", w.toFixed(1));
      f.classList.toggle("vp-flow-rev", reverse);
      f.classList.toggle("vp-flow-on", !reverse);
    }

    function fmt(v, unit) {
      if (v == null || isNaN(v)) return "–";
      return nf1.format(v) + (unit || "");
    }

    return {
      update: function (d) {
        // Node value labels.
        nodeEls.pv.val.textContent = d.pv == null ? "–" : fmt(d.pv, "");
        nodeEls.load.val.textContent = d.load == null ? "–" : fmt(d.load, "");
        nodeEls.grid.val.textContent = d.grid == null ? "–" : fmt(Math.abs(d.grid), "");
        nodeEls.batt.val.textContent = d.soc == null ? "–" : nf0.format(d.soc) + "%";

        // Geometry is node->hub. Inflow (node into hub) = normal animation.
        // PV: generation flows into the hub.
        setSpoke("pv", d.pv != null && d.pv > 0.05, false, d.pv);
        // Haus: always consumes -> hub to node -> reverse.
        setSpoke("load", d.load != null && d.load > 0.05, true, d.load);
        // Netz: import (grid>0) node->hub normal; export (grid<0) reverse.
        setSpoke("grid", d.grid != null && Math.abs(d.grid) > 0.05, d.grid < 0, d.grid);
        // Batterie: discharge (batt<0) node->hub normal; charge (batt>0) reverse.
        setSpoke("batt", d.batt != null && Math.abs(d.batt) > 0.05, d.batt > 0, d.batt);
      }
    };
  }
})();
