// VoltPilot Edge - the "Betrieb" page: what the plant is doing RIGHT NOW.
// Loads recent history, then streams live samples + state over SSE (falls back
// to polling if SSE is unavailable). Read-only; everything stays on the device.
//
// This page is customer-grade on purpose: for a plant whose cloud link is down,
// this IS the plant view. Setting anything up (inverter, sources, portal
// pairing, measurement processing, control release, data purge) lives on
// "Einrichten" (einrichten.html / einrichten.js) - never here.
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });


  // ---------- adaptive read-model shared metadata (AE6) ----------
  // The AE1 topology read-model groups entities into four roles; each role has
  // one hue + soft fill (the same --pv/--load/--grid-c/--batt channel hues the
  // v1 diagram and charts use), a KPI accent class and an icon. The adaptive
  // energy diagram and the adaptive tiles both draw from this one map, so the
  // edge :8484 view matches the portal's AE2/AE3 look.
  var ROLE_META = {
    pv:       { label: "PV",          color: cssVar("--pv"),     soft: cssVar("--pv-soft"),   tile: "pv",   icon: "sun" },
    storage:  { label: "Batterie",    color: cssVar("--batt"),   soft: cssVar("--batt-soft"), tile: "batt", icon: "battery" },
    consumer: { label: "Verbraucher", color: cssVar("--load"),   soft: cssVar("--load-soft"), tile: "load", icon: "home" },
    grid:     { label: "Netz",        color: cssVar("--grid-c"), soft: cssVar("--grid-soft"), tile: "grid", icon: "zap" },
    // Laden IST Verbrauch, nur ein benannter Teil davon - deshalb die
    // Verbraucher-Hue, keine sechste Farbe (Konzept vp-verbraucher-cockpit-k1
    // §6, Portal-Parität adaptive.ts ROLE_META).
    charging: { label: "Laden",       color: cssVar("--load"),   soft: cssVar("--load-soft"), tile: "load", icon: "battery-charging" },
    "charging-own": { label: "Laden (eigener Anschluss)", color: cssVar("--load"), soft: cssVar("--load-soft"), tile: "load", icon: "battery-charging" }
  };

  // Inner markup for a 24x24 stroke icon, embedded as a nested <svg> at a node
  // and reused as the tile icon (stroke inherits the accent colour).
  var ICON_PATHS = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    battery: '<rect x="2" y="7" width="16" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/>',
    home: '<path d="M3 9.5 12 3l9 6.5"/><path d="M5 8.5V21h14V8.5"/><path d="M9 21v-6h6v6"/>',
    zap: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
    "battery-charging": '<path d="M15 7h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2"/>' +
      '<path d="M6 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1"/>' +
      '<path d="m11 7-3 5h4l-3 5"/><line x1="22" y1="11" x2="22" y2="13"/>'
  };

  // Whether an /api/state topology block carries any renderable role node (else
  // fall back to the byte-identical v1 diagram + fixed 4 tiles).
  function hasTopology(topo) {
    return !!(topo && topo.nodes && topo.nodes.length > 0);
  }

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

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
  }

  function renderKpis(s) {
    var fresh = s.last_telemetry && (serverAge(s.last_telemetry) < 90);

    // Adaptive path (AE6): when the device carries v2 entities, the tiles are
    // entity/role-driven straight from the topology read-model (a new Wallbox/
    // Heizstab appears on its own). The fixed 4 cards stay as the v1 fallback.
    var adaptive = hasTopology(s.topology);
    var kFixed = $("kpis"), kAdaptive = $("kpisAdaptive");
    kFixed.hidden = adaptive;
    kAdaptive.hidden = !adaptive;
    if (adaptive) {
      renderAdaptiveTiles(kAdaptive, s.topology);
      kAdaptive.classList.toggle("stale", !!s.last_telemetry && !fresh);
      return;
    }

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
    } else if (s.buffer_paused) {
      // Removed (unclaimed) in the cloud: buffering is honestly paused instead
      // of piling up data that can never be sent.
      cv.className = "status-val err"; cv.childNodes[0].nodeValue = "Entfernt";
      csub.textContent = "Aufzeichnung pausiert – Gerät im Portal erneut hinzufügen";
    } else if (s.buffer_data_loss) {
      // Long outage overran the buffer: the oldest samples are being discarded.
      cv.className = "status-val err"; cv.childNodes[0].nodeValue = "Getrennt";
      csub.textContent = "Zwischenspeicher voll - älteste Messwerte werden verworfen";
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

  // ---------- Cloud chip (topbar) ----------
  function renderPill(s) {
    var pill = $("cloudPill"), txt = $("cloudPillText");
    if (!pill) return;
    var dot = pill.querySelector(".dot");
    if (s.cloud_connected) {
      pill.className = "state-chip ok"; txt.textContent = "Portal verbunden"; dot.classList.add("live");
    } else if (s.pairing_state === "geraet_entfernt") {
      pill.className = "state-chip off"; txt.textContent = "Aus dem Portal entfernt"; dot.classList.remove("live");
    } else if (s.last_telemetry && serverAge(s.last_telemetry) < 90) {
      pill.className = "state-chip warn"; txt.textContent = "Lokal aktiv"; dot.classList.remove("live");
    } else {
      pill.className = "state-chip off"; txt.textContent = "Portal getrennt"; dot.classList.remove("live");
    }
  }

  // ---------- Status hero: the plain-German verdict + its CAUSE ----------
  // VPStatus.derive is the single source of truth (status.js). Whatever it
  // returns as `cause` is rendered HERE, in normal mode - Technikmodus never
  // owns a message, only detail.
  var HERO_ICON = {
    ok: '<path d="M20 6 9 17l-5-5"/>',
    warn: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    err: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>'
  };
  function renderStatusHero(s) {
    var hero = $("statusHero");
    if (!hero || !window.VPStatus) return;
    var v = window.VPStatus.derive(s, deviceNow());
    hero.className = "status-hero " + v.tone;
    $("statusHeroTitle").textContent = v.title;
    var det = $("statusHeroDetail");
    det.textContent = v.detail || "";
    det.hidden = !v.detail;
    var cause = $("statusHeroCause");
    cause.textContent = v.cause || "";
    cause.hidden = !v.cause;
    var ico = $("statusHeroIco");
    if (ico) {
      ico.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
        'stroke-linecap="round" stroke-linejoin="round">' + (HERO_ICON[v.tone] || HERO_ICON.err) + "</svg>";
    }
  }

  // The guided onboarding (Wechselrichter -> Portal koppeln) moved to the
  // "Einrichten" page (einrichten.js): one job, one page. This page only ever
  // SHOWS the resulting state, via the status hero above.

  // ---------- Energy flow diagram ----------
  // The controller renders the adaptive N-node topology diagram when the device
  // carries v2 entities, else the byte-identical fixed 4-node diagram.
  var flow = createFlow($("flowWrap"));

  function renderFlow() {
    var topo = lastState ? lastState.topology : null;
    flow.update({
      pv: latestVal("pv"), load: latestVal("load"),
      grid: latestVal("grid"), batt: latestVal("batt"),
      soc: latestVal("soc")
    }, topo);
  }

  // ---------- state application ----------
  function applyState(s) {
    lastState = s;
    syncClock(s.server_now_ms);
    renderPill(s);
    renderStatusHero(s);
    renderInverterCta(s);
    renderKpis(s);
    renderStatus(s);
    renderFlow();
    renderTechSources(s);
    // Hand the state to the Fahrplan view: it refetches the full plan when a new
    // one arrives and keeps the live setpoint + active slot + freshness current.
    if (window.VPPlan) window.VPPlan.onState(s);
    // Hand the state to the "Steuerung & Bestätigung" card (register-level
    // control readback fed by state.control).
    if (window.VPControl) window.VPControl.onState(s);
    // Hand the state to the First-Light calibration card (it also reads
    // state.control for the "Kam der Befehl an?" register readback; its own
    // /api/calibration poll drives the rest).
    if (window.VPCalibration) window.VPCalibration.onState(s);
    // Hand the state to the "Betrieb" card (market optimization + PS-3 peak
    // guard: target, running quarter mean, reserve).
    if (window.VPBetrieb) window.VPBetrieb.onState(s);
    // Hand the state to the read-only "Aktive Steuerung" strip (the RESULT of
    // the portal-composed flows: deployed @vp-flow tabs + per-entity
    // arbitration winner, fed by state.active_control).
    if (window.VPActiveControl) window.VPActiveControl.onState(s);
  }

  // ---------- (Technikmodus) raw measurement sources ----------
  // The picture above is a COMPOSITE: the primary inverter plus every
  // additional Erzeuger / Netz-Zähler / Verbraucher. This block shows the parts
  // it is made of, right under the diagram - the technician's answer to "where
  // do these 21,5 kW come from?". Detail only: a source that is not delivering
  // already says so in the status hero and on "Einrichten".
  var techSources = null;      // last /api/sources payload
  var techSourcesAt = 0;

  var CHANNEL_LABEL = {
    pv_power_kw: "PV", power_kw: "Netz", load_kw: "Haus",
    soc_pct: "SoC", grid_limit_kw: "Netz-Limit", battery_power_kw: "Batterie"
  };
  var HEALTH_LABEL = { ok: "liefert", warn: "veraltet", pending: "wartet" };

  function fmtChannels(map, units) {
    var out = [];
    for (var k in map) {
      if (!map.hasOwnProperty(k) || map[k] == null) continue;
      out.push((CHANNEL_LABEL[k] || k) + " " + nf1.format(map[k]) + (units && k === "soc_pct" ? " %" : " kW"));
    }
    return out.join(" · ") || "keine Werte";
  }

  function loadTechSources() {
    return fetch("/api/sources", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) { techSources = d; techSourcesAt = Date.now(); })
      .catch(function () { /* the block simply stays on the primary reading */ });
  }

  function renderTechSources(s) {
    var body = $("techSourcesBody");
    if (!body) return;
    var rows = [];

    var prim = s.inverter && s.inverter.configured
      ? ((s.inverter.label || "Wechselrichter") + " · " + (s.inverter.host || "?") +
         " · " + (s.inverter.communication || "?"))
      : null;
    if (prim) {
      rows.push(prim + "\n    " + fmtChannels(s.last_reading || {}, true) +
        "  [" + (s.inverter_link === "down" ? "getrennt" : s.inverter_link === "up" ? "verbunden" : "unbekannt") + "]");
    } else {
      rows.push("kein Wechselrichter ausgewählt");
    }

    if (techSources && techSources.sources) {
      for (var i = 0; i < techSources.sources.length; i++) {
        var src = techSources.sources[i];
        var st = (techSources.statuses || {})[src.id] || "pending";
        var rd = (techSources.readings || {})[src.id];
        var conn = src.connection || {};
        var where = conn.ip ? conn.ip + (conn.port ? ":" + conn.port : "") : "?";
        rows.push((src.label || src.model || src.brand || src.id) + " · " + src.role + " · " + where +
          " · " + (src.communication || "?") +
          "\n    " + (rd && rd.values ? fmtChannels(rd.values, true) : "keine Werte") +
          "  [" + (HEALTH_LABEL[st] || st) + "]");
      }
    }
    body.textContent = rows.join("\n");

    var note = $("techSourcesNote");
    if (note) {
      note.textContent = "Rohwerte je Messquelle, vor der Zusammenfassung. " +
        "Zusammensetzung und Verbindungsdaten ändern Sie unter „Einrichten“.";
    }
  }


  // Prominent CTA while no inverter is configured: without it the Node-RED
  // read flow is idle and NO telemetry ever reaches the device (M1). The guided
  // commissioning lives on "Einrichten" now, so this banner is simply the way
  // over there and no longer duplicates an onboarding card on this page.
  function renderInverterCta(s) {
    var el = $("inverterBanner");
    if (el) el.hidden = !!(s.inverter && s.inverter.configured);
    var v = $("version");
    if (v) v.textContent = (!s.version || s.version === "dev") ? "" : "v" + s.version;
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

  // Keep the axes scrolling even when idle.
  setInterval(redrawCharts, 1000);

  // ---------- boot ----------
  fetch("/api/state", { cache: "no-store" }).then(function (r) { return r.json(); })
    .then(applyState).catch(function () {});
  loadHistory().then(startStream);

  // The raw per-source block only matters in Technikmodus, so it is fetched
  // once at boot and refreshed lazily (every 30 s) - never on the hot path.
  loadTechSources().then(function () { if (lastState) renderTechSources(lastState); });
  setInterval(function () {
    loadTechSources().then(function () { if (lastState) renderTechSources(lastState); });
  }, 30000);
  if (window.VPTechnik) {
    window.VPTechnik.onChange(function () {
      if (lastState) renderTechSources(lastState);
      redrawCharts(); // the canvases resize when a block above them appears
    });
  }

  // Inject the flow-spoke keyframes once (shared by the v1 and adaptive
  // diagrams so the animation exists even if only the adaptive one is built).
  function ensureFlowKeyframes() {
    if (document.getElementById("flowKeyframes")) return;
    var st = document.createElement("style");
    st.id = "flowKeyframes";
    st.textContent =
      "@keyframes vpflow{to{stroke-dashoffset:-24}}" +
      ".vp-flow-on{animation:vpflow .9s linear infinite}" +
      ".vp-flow-rev{animation:vpflow .9s linear infinite reverse}";
    document.head.appendChild(st);
  }

  // ==================================================================
  // Flow controller: routes the #flowWrap container between the adaptive
  // topology diagram (v2 entities present) and the fixed 4-node diagram
  // (v1 fallback). Switching modes tears down the previous renderer (so a
  // stale ResizeObserver never squashes the other layout) and rebuilds.
  // ==================================================================
  function createFlow(container) {
    var mode = null, v1 = null, adaptive = null;
    return {
      update: function (scalar, topology) {
        var want = hasTopology(topology) ? "adaptive" : "v1";
        if (want !== mode) {
          if (v1 && v1.destroy) v1.destroy();
          if (adaptive && adaptive.destroy) adaptive.destroy();
          v1 = adaptive = null;
          container.innerHTML = "";
          container.style.height = ""; // reset the v1 narrow-layout height
          mode = want;
        }
        if (mode === "adaptive") {
          if (!adaptive) adaptive = buildAdaptiveFlow(container);
          adaptive.update(topology);
        } else {
          if (!v1) v1 = buildV1Flow(container);
          v1.update(scalar);
        }
      }
    };
  }

  // ==================================================================
  // v1 energy flow diagram: four spokes around a central hub. Flow travels
  // along a spoke; direction encodes import/export & charge/discharge.
  // Unchanged behaviour - the fallback for a device without v2 entities.
  // ==================================================================
  function buildV1Flow(container) {
    var NS = "http://www.w3.org/2000/svg";

    // Two layouts sharing the same node->hub topology, so the animation logic
    // is identical; only the coordinates differ. WIDE is the landscape diamond
    // (tablet/desktop); NARROW is a taller portrait cross that fills a phone's
    // width - the viewBox is close to the container width there, so the labels
    // render near full size instead of shrinking into an unreadable diamond.
    var LAYOUTS = {
      wide:   { W: 400, H: 250, hubR: 22, nodeR: 26, lblF: 10.5, valF: 10,
                hub: { x: 200, y: 128 },
                pos: { pv: { x: 200, y: 40 }, load: { x: 336, y: 128 },
                       grid: { x: 200, y: 216 }, batt: { x: 64, y: 128 } } },
      narrow: { W: 280, H: 344, hubR: 26, nodeR: 32, lblF: 13, valF: 12,
                hub: { x: 140, y: 172 },
                pos: { pv: { x: 140, y: 52 }, load: { x: 214, y: 172 },
                       grid: { x: 140, y: 292 }, batt: { x: 66, y: 172 } } }
    };
    var META = {
      pv:   { label: "PV",       color: cssVar("--pv"),     soft: cssVar("--pv-soft") },
      load: { label: "Haus",     color: cssVar("--load"),   soft: cssVar("--load-soft") },
      grid: { label: "Netz",     color: cssVar("--grid-c"), soft: cssVar("--grid-soft") },
      batt: { label: "Batterie", color: cssVar("--batt"),   soft: cssVar("--batt-soft") }
    };
    var KEYS = ["pv", "load", "grid", "batt"];

    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    // Base spoke lines + animated flow overlays (node -> hub geometry).
    var spokes = {};
    KEYS.forEach(function (k) {
      var base = document.createElementNS(NS, "line");
      base.setAttribute("stroke", "#E3E9F1"); base.setAttribute("stroke-width", "6");
      base.setAttribute("stroke-linecap", "round");
      svg.appendChild(base);
      var flowLine = document.createElementNS(NS, "line");
      flowLine.setAttribute("stroke", META[k].color); flowLine.setAttribute("stroke-width", "3");
      flowLine.setAttribute("stroke-linecap", "round");
      flowLine.setAttribute("stroke-dasharray", "2 10");
      flowLine.style.opacity = "0";
      svg.appendChild(flowLine);
      spokes[k] = { base: base, flow: flowLine };
    });

    // Hub.
    var hubC = document.createElementNS(NS, "circle");
    hubC.setAttribute("fill", "#fff"); hubC.setAttribute("stroke", "#E3E9F1"); hubC.setAttribute("stroke-width", "2");
    svg.appendChild(hubC);
    var hubIco = document.createElementNS(NS, "path");
    hubIco.setAttribute("d", "M13 2 3 14h7l-1 8 10-12h-7l1-8z");
    hubIco.setAttribute("fill", "none"); hubIco.setAttribute("stroke", cssVar("--brand-deep"));
    hubIco.setAttribute("stroke-width", "2"); hubIco.setAttribute("stroke-linejoin", "round"); hubIco.setAttribute("stroke-linecap", "round");
    svg.appendChild(hubIco);

    // Nodes (circle + label + value).
    var nodeEls = {};
    KEYS.forEach(function (k) {
      var g = document.createElementNS(NS, "g");
      var c = document.createElementNS(NS, "circle");
      c.setAttribute("fill", META[k].soft); c.setAttribute("stroke", META[k].color); c.setAttribute("stroke-width", "2");
      g.appendChild(c);
      var lbl = document.createElementNS(NS, "text");
      lbl.setAttribute("text-anchor", "middle"); lbl.setAttribute("font-weight", "700");
      lbl.setAttribute("fill", "#33414F"); lbl.setAttribute("font-family", "Inter, sans-serif");
      lbl.textContent = META[k].label;
      g.appendChild(lbl);
      var val = document.createElementNS(NS, "text");
      val.setAttribute("text-anchor", "middle"); val.setAttribute("font-weight", "600");
      val.setAttribute("fill", META[k].color); val.setAttribute("font-family", "Inter, sans-serif");
      val.textContent = "–";
      g.appendChild(val);
      svg.appendChild(g);
      nodeEls[k] = { circle: c, lbl: lbl, val: val };
    });

    container.innerHTML = "";
    container.appendChild(svg);

    // applyLayout positions every element for the chosen preset. Called on
    // build and whenever the container crosses the narrow/wide threshold.
    var curLayout = null;
    function applyLayout(L) {
      svg.setAttribute("viewBox", "0 0 " + L.W + " " + L.H);
      hubC.setAttribute("cx", L.hub.x); hubC.setAttribute("cy", L.hub.y); hubC.setAttribute("r", L.hubR);
      hubIco.setAttribute("transform", "translate(" + (L.hub.x - 12) + "," + (L.hub.y - 12) + ")");
      KEYS.forEach(function (k) {
        var p = L.pos[k], s = spokes[k], n = nodeEls[k];
        s.base.setAttribute("x1", p.x); s.base.setAttribute("y1", p.y);
        s.base.setAttribute("x2", L.hub.x); s.base.setAttribute("y2", L.hub.y);
        s.flow.setAttribute("x1", p.x); s.flow.setAttribute("y1", p.y);
        s.flow.setAttribute("x2", L.hub.x); s.flow.setAttribute("y2", L.hub.y);
        n.circle.setAttribute("cx", p.x); n.circle.setAttribute("cy", p.y); n.circle.setAttribute("r", L.nodeR);
        n.lbl.setAttribute("x", p.x); n.lbl.setAttribute("y", p.y - L.nodeR * 0.16); n.lbl.setAttribute("font-size", L.lblF);
        n.val.setAttribute("x", p.x); n.val.setAttribute("y", p.y + L.nodeR * 0.44); n.val.setAttribute("font-size", L.valF);
      });
    }
    function pickLayout() {
      var w = container.clientWidth || 400;
      var want = w < 380 ? LAYOUTS.narrow : LAYOUTS.wide;
      if (want !== curLayout) { curLayout = want; applyLayout(want); }
      // For the portrait phone layout, size the container to the layout's own
      // aspect so the SVG fills the width (labels stay full-size) instead of
      // being letterboxed by a fixed min-height. Wide layout keeps its CSS box.
      container.style.height = want === LAYOUTS.narrow
        ? Math.round(w * (want.H / want.W)) + "px" : "";
    }
    pickLayout();
    var ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(pickLayout); ro.observe(container);
    } else {
      window.addEventListener("resize", pickLayout);
    }

    ensureFlowKeyframes();

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
        // PV/Haus/Netz are power in kW; label the unit so the numbers aren't
        // ambiguous next to the battery's "%".
        nodeEls.pv.val.textContent = d.pv == null ? "–" : fmt(d.pv, " kW");
        nodeEls.load.val.textContent = d.load == null ? "–" : fmt(d.load, " kW");
        nodeEls.grid.val.textContent = d.grid == null ? "–" : fmt(Math.abs(d.grid), " kW");
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
      },
      destroy: function () {
        if (ro) ro.disconnect();
        else window.removeEventListener("resize", pickLayout);
      }
    };
  }

  // ==================================================================
  // Adaptive energy flow diagram (AE6): the same lightning-hub / soft-circle-
  // node / animated-dashed-spoke look as the v1 diagram and the portal AE2,
  // but generalised from the fixed 4 nodes to the N role-grouped nodes of the
  // AE1 topology read-model. Producers sit top, storage left, consumers right,
  // grid bottom; each entity contributing to a role is its own circle, and the
  // animated spoke direction encodes the topology flow sign. Read-only.
  //
  // Geometry mirrors the portal's pure adaptiveFlow.layoutFlow so the two views
  // draw the same picture; only the DOM building is vanilla here.
  // ==================================================================
  function buildAdaptiveFlow(container) {
    var NS = "http://www.w3.org/2000/svg";
    // ⚠ Rollen-Plätze, Beschriftung und Layout leben in flowrollen.js
    // (window.VPFlowRollen) - der EINEN, Docker-frei prüfbaren Regel; hier
    // bleibt nur das Zeichnen. Auch die Geometrie kommt von dort, damit
    // Rechnen und Rendern nicht mit zwei Zahlensätzen arbeiten.
    var G = window.VPFlowRollen.GEOM;
    var NODE_R = G.NODE_R, HUB_R = G.HUB_R;
    var LBL_F = G.LBL_F, VAL_F = G.VAL_F;
    var LBL_GAP = G.LBL_GAP, LBL_LH = G.LBL_LH;

    ensureFlowKeyframes();

    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    container.innerHTML = "";
    container.appendChild(svg);

    var sig = null;     // node-set signature: rebuild DOM only when it changes
    var vtxEls = {};    // vertex key -> { flow, val }

    // layout = die reine Regel aus flowrollen.js plus die Farb-/Icon-Zuordnung
    // dieser Seite (ROLE_META hängt an cssVar und ist deshalb nicht rein).
    function layout(topo) {
      var L = window.VPFlowRollen.flowLayout(topo);
      L.vertices.forEach(function (v) {
        var meta = ROLE_META[v.role] || ROLE_META.consumer;
        v.icon = meta.icon; v.color = meta.color; v.soft = meta.soft;
      });
      return L;
    }


    function line(x1, y1, x2, y2, stroke, w) {
      var l = document.createElementNS(NS, "line");
      l.setAttribute("x1", x1); l.setAttribute("y1", y1);
      l.setAttribute("x2", x2); l.setAttribute("y2", y2);
      l.setAttribute("stroke", stroke); l.setAttribute("stroke-width", w);
      l.setAttribute("stroke-linecap", "round");
      return l;
    }

    // Rebuild the whole SVG for a new node set (rare: entity add/remove).
    function rebuild(L) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.setAttribute("viewBox", "0 0 " + L.W + " " + L.H);
      vtxEls = {};

      // Base spokes + animated flow overlays (behind the nodes).
      L.vertices.forEach(function (v) {
        // Ein Knoten ohne eigenes Ziel hängt am Hub; nur der Lade-ABZWEIG nennt
        // eines - er hängt am Haus, nicht am Anschlusspunkt.
        var tx = v.toX != null ? v.toX : L.hubX, ty = v.toY != null ? v.toY : L.hubY;
        svg.appendChild(line(v.x, v.y, tx, ty, "#E3E9F1", String(v.baseWidth || 6)));
        var flow = line(v.x, v.y, tx, ty, v.color, "3");
        flow.setAttribute("stroke-dasharray", "2 10");
        flow.style.opacity = "0";
        svg.appendChild(flow);
        vtxEls[v.key] = { flow: flow };
      });

      // Hub (lightning), matching the v1 diagram.
      var hubC = document.createElementNS(NS, "circle");
      hubC.setAttribute("cx", L.hubX); hubC.setAttribute("cy", L.hubY); hubC.setAttribute("r", HUB_R);
      hubC.setAttribute("fill", "#fff"); hubC.setAttribute("stroke", "#E3E9F1"); hubC.setAttribute("stroke-width", "2");
      svg.appendChild(hubC);
      var hubIco = document.createElementNS(NS, "path");
      hubIco.setAttribute("d", "M13 2 3 14h7l-1 8 10-12h-7l1-8z");
      hubIco.setAttribute("fill", "none"); hubIco.setAttribute("stroke", cssVar("--brand-deep"));
      hubIco.setAttribute("stroke-width", "2"); hubIco.setAttribute("stroke-linejoin", "round"); hubIco.setAttribute("stroke-linecap", "round");
      hubIco.setAttribute("transform", "translate(" + (L.hubX - 12) + "," + (L.hubY - 12) + ")");
      svg.appendChild(hubIco);

      // Nodes (circle + icon + label + value).
      L.vertices.forEach(function (v) {
        var g = document.createElementNS(NS, "g");
        var c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", v.x); c.setAttribute("cy", v.y); c.setAttribute("r", NODE_R);
        c.setAttribute("fill", v.soft); c.setAttribute("stroke", v.color); c.setAttribute("stroke-width", "2");
        g.appendChild(c);

        var ico = document.createElementNS(NS, "svg");
        ico.setAttribute("x", v.x - 8); ico.setAttribute("y", v.y - NODE_R * 0.72);
        ico.setAttribute("width", "16"); ico.setAttribute("height", "16");
        ico.setAttribute("viewBox", "0 0 24 24");
        ico.setAttribute("fill", "none"); ico.setAttribute("stroke", v.color);
        ico.setAttribute("stroke-width", "2"); ico.setAttribute("stroke-linecap", "round"); ico.setAttribute("stroke-linejoin", "round");
        ico.innerHTML = ICON_PATHS[v.icon] || ICON_PATHS.home;
        g.appendChild(ico);

        // The member names as a native tooltip - the visible label is the role
        // word, this is where the devices stay readable.
        var ttl = document.createElementNS(NS, "title");
        ttl.textContent = v.fullLabel;
        g.appendChild(ttl);

        // Role name UNDER the circle, plus the sub line ("3 Geräte" on a
        // multi-device PV = the click affordance, else the state in words). A
        // white halo keeps it legible where it crosses a spoke.
        var lbl = document.createElementNS(NS, "text");
        lbl.setAttribute("x", v.x); lbl.setAttribute("y", v.y + NODE_R + LBL_GAP);
        lbl.setAttribute("text-anchor", "middle"); lbl.setAttribute("font-weight", "700");
        lbl.setAttribute("font-size", LBL_F); lbl.setAttribute("fill", "#33414F");
        lbl.setAttribute("font-family", "Inter, sans-serif");
        lbl.setAttribute("stroke", "#fff"); lbl.setAttribute("stroke-width", "3.5");
        lbl.setAttribute("stroke-linejoin", "round");
        lbl.style.paintOrder = "stroke";
        var t1 = document.createElementNS(NS, "tspan");
        t1.setAttribute("x", v.x); t1.setAttribute("dy", "0");
        t1.textContent = v.label;
        var t2 = document.createElementNS(NS, "tspan");
        t2.setAttribute("x", v.x); t2.setAttribute("dy", LBL_LH);
        t2.setAttribute("font-weight", "600"); t2.setAttribute("fill", "#6B7A89");
        t2.textContent = v.subLine || "";
        lbl.appendChild(t1); lbl.appendChild(t2);
        g.appendChild(lbl);

        var val = document.createElementNS(NS, "text");
        val.setAttribute("x", v.x); val.setAttribute("y", v.y + NODE_R * 0.34);
        val.setAttribute("text-anchor", "middle"); val.setAttribute("font-weight", "600");
        val.setAttribute("font-size", VAL_F); val.setAttribute("fill", v.color);
        val.setAttribute("font-family", "Inter, sans-serif");
        val.textContent = v.value;
        g.appendChild(val);

        // The PV circle opens the per-device composition (portal A1 parity) -
        // a real interactive element: pointer + keyboard, aria-expanded.
        if (v.expandable) {
          g.style.cursor = "pointer";
          g.setAttribute("tabindex", "0");
          g.setAttribute("role", "button");
          g.setAttribute("aria-expanded", compOpen ? "true" : "false");
          g.setAttribute("aria-label", "PV-Erzeugung: Zusammensetzung anzeigen");
          g.addEventListener("click", toggleComposition);
          g.addEventListener("keydown", function (ev) {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleComposition(); }
          });
          vtxEls[v.key].expandG = g;
        }

        svg.appendChild(g);
        vtxEls[v.key].val = val;
        vtxEls[v.key].sub = t2;
      });
    }

    // ---- PV composition panel ("woraus setzt sich die Erzeugung zusammen?").
    // A sibling of the SVG inside the flow container; rows update live. A
    // device without an own value is NAMED with an honest reason, never a
    // silent "–" circle (the old per-member picture).
    var compOpen = false;
    var compEl = null;
    var lastPvMembers = [];

    function toggleComposition() {
      compOpen = !compOpen;
      Object.keys(vtxEls).forEach(function (k) {
        if (vtxEls[k].expandG) vtxEls[k].expandG.setAttribute("aria-expanded", compOpen ? "true" : "false");
      });
      renderComposition();
    }

    function renderComposition() {
      if (!compOpen || lastPvMembers.length < 2) {
        if (compEl) { compEl.remove(); compEl = null; }
        return;
      }
      if (!compEl) {
        compEl = document.createElement("div");
        compEl.className = "flow-comp";
        // A SIBLING of the flow wrap (after the legend), never inside it - the
        // wrap's SVG keeps 100% height, so a child would overlap the legend
        // (the portal A1 panel-is-a-sibling rule).
        (container.parentElement || container).appendChild(compEl);
      }
      var anyValue = lastPvMembers.some(function (m) { return m.value_kw != null; });
      var html = "";
      lastPvMembers.forEach(function (m) {
        var name = (m.label || "").trim() || "Gerät";
        var right = m.value_kw != null
          ? nf1.format(m.value_kw) + " kW"
          : (anyValue ? "über den Wechselrichter mitgemessen" : "wartet auf Daten");
        html += '<div class="flow-comp-row"><span class="flow-comp-name" title="'
          + esc(name) + '">' + esc(name) + '</span><span class="flow-comp-val'
          + (m.value_kw == null ? " muted" : "") + '">' + esc(right) + "</span></div>";
      });
      compEl.innerHTML = html;
    }

    function esc(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    // In-place value + spoke update (same node set): keeps the animation running.
    function apply(L) {
      var pvSeen = false;
      L.vertices.forEach(function (v) {
        if (v.role === "pv") pvSeen = true;
        var e = vtxEls[v.key];
        if (!e) return;
        e.val.textContent = v.value;
        if (e.sub) e.sub.textContent = v.subLine || "";
        var f = e.flow;
        if (v.role === "pv") lastPvMembers = v.members || [];
        if (!v.spokeActive) {
          f.style.opacity = "0"; f.classList.remove("vp-flow-on", "vp-flow-rev");
        } else {
          f.style.opacity = "1";
          f.setAttribute("stroke-width", v.strokeWidth.toFixed(1));
          f.classList.toggle("vp-flow-rev", v.reverse);
          f.classList.toggle("vp-flow-on", !v.reverse);
        }
      });
      if (!pvSeen) lastPvMembers = [];
      renderComposition();
    }

    return {
      update: function (topo) {
        var L = layout(topo);
        var newSig = L.vertices.map(function (v) { return v.key; }).join("|") + "@" + L.W + "x" + L.H;
        if (newSig !== sig) { rebuild(L); sig = newSig; }
        apply(L);
      },
      destroy: function () { if (compEl) { compEl.remove(); compEl = null; } }
    };
  }

  // ==================================================================
  // Adaptive tiles (AE6): entity/role-driven KPI cards from the topology
  // read-model. One aggregate tile per PV/Speicher/Netz role + one per
  // consumer entity (a Wallbox/Heizstab appears on its own). Read-only.
  // Ports the portal's adaptiveLive.deriveTiles so both views agree.
  // ==================================================================
  // Die Kachel-Regel wohnt in flowrollen.js (window.VPFlowRollen) - sie ist
  // rein und Docker-frei geprüft; hier bleibt nur das Rendern.
  function deriveTiles(topo) { return window.VPFlowRollen.deriveTiles(topo); }

  // Cache the adaptive-tile DOM keyed by the tile-set signature, so a per-second
  // state refresh only updates text (never rebuilds - the SoC bar keeps its
  // width transition instead of re-animating from 0 every tick).
  var tileCache = { sig: null, els: {} };

  function tileIconSvg(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + (ICON_PATHS[name] || ICON_PATHS.home) + '</svg>';
  }

  function buildTileCard(t) {
    var card = document.createElement("div");
    card.className = "card kpi " + t.tile;
    card.innerHTML =
      '<div class="kpi-top"><span class="kpi-ico">' + tileIconSvg(t.icon) + '</span>' +
      '<span class="kpi-tag js-tag"></span></div>' +
      '<p class="kpi-label js-title"></p>' +
      '<p class="kpi-value"><span class="js-val"></span><span class="u js-unit"></span></p>' +
      (t.socPct != null || t.tile === "batt"
        ? '<div class="soc-bar"><span class="soc-fill js-soc" style="width:0%"></span></div>' : "") +
      '<p class="kpi-sub js-sub">&nbsp;</p>';
    var el = {
      card: card,
      tag: card.querySelector(".js-tag"), title: card.querySelector(".js-title"),
      val: card.querySelector(".js-val"), unit: card.querySelector(".js-unit"),
      soc: card.querySelector(".js-soc"), sub: card.querySelector(".js-sub")
    };
    el.update = function (t) {
      el.tag.textContent = t.stateLabel;
      el.title.textContent = t.title;
      el.val.textContent = t.valueText;
      el.unit.textContent = t.unit;
      if (el.soc) el.soc.style.width = (t.socPct == null ? 0 : t.socPct) + "%";
      if (t.subLine) {
        var chip = t.arrow === "up" ? "up" : (t.arrow === "down" ? "down" : "idle");
        var glyph = t.arrow === "up" ? "▲ " : (t.arrow === "down" ? "▼ " : "");
        el.sub.innerHTML = t.arrow
          ? "<span class='chip " + chip + "'>" + glyph + escapeHtml(t.subLine) + "</span>"
          : escapeHtml(t.subLine);
      } else {
        el.sub.innerHTML = "&nbsp;";
      }
    };
    return el;
  }

  function renderAdaptiveTiles(container, topo) {
    var tiles = deriveTiles(topo);
    var newSig = tiles.map(function (t) { return t.key; }).join("|");
    if (newSig !== tileCache.sig) {
      container.innerHTML = "";
      tileCache.els = {};
      tiles.forEach(function (t) {
        var el = buildTileCard(t);
        container.appendChild(el.card);
        tileCache.els[t.key] = el;
      });
      tileCache.sig = newSig;
    }
    tiles.forEach(function (t) {
      var el = tileCache.els[t.key];
      if (el) el.update(t);
    });
  }
})();
