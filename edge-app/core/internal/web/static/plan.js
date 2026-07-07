// VoltPilot Edge - Fahrplan (battery dispatch plan) view.
// Read-only. Draws the cached plan the device holds on disk: per-slot
// charge/discharge bars over the plan horizon, the executing slot highlighted,
// planned PV curtailment marked, the live guard-clamped setpoint, and plan
// freshness against the 20-min staleness window. Dependency-free canvas (no
// CDN, works offline), HiDPI-aware, matching the dashboard's hand-rolled charts.
//
// Data path: the full plan comes from GET /api/plan; dashboard.js hands the
// streamed device state to VPPlan.onState(), which refetches the plan whenever a
// new one arrives (plan_received changes) and keeps the live setpoint + active
// slot + freshness ticking every second. The device's own execution is
// untouched - nothing here commands the battery.
(function (global) {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  // --- device-clock alignment (server_now_ms from /api/plan + /api/state) ---
  var clockOffset = 0;
  function deviceNow() { return Date.now() + clockOffset; }
  function syncClock(ms) { if (ms) clockOffset = ms - Date.now(); }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function hhmm(ms) { var d = new Date(ms); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  var plan = null;          // last /api/plan response
  var liveState = null;     // last streamed device state (setpoint/mode/freshness)
  var lastReceived = null;  // plan.received_at we last fetched a plan for

  // ---------------- Bar chart ----------------
  // Draws one signed bar per slot over a shared time axis: charge above the
  // zero line, discharge below. The active slot gets a highlight band; slots
  // with a planned PV cap get a curtailment tick; a "Jetzt" line marks now.
  function PlanChart(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.slots = [];
    this.slotMs = 15 * 60 * 1000;
    this.hover = null;
    this._geom = null;
    var self = this;
    canvas.addEventListener("mousemove", function (e) {
      var r = canvas.getBoundingClientRect();
      self.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      self.draw();
    });
    canvas.addEventListener("mouseleave", function () { self.hover = null; self.draw(); });
    canvas.addEventListener("touchmove", function (e) {
      var t = e.touches[0]; if (!t) return;
      var r = canvas.getBoundingClientRect();
      self.hover = { x: t.clientX - r.left, y: t.clientY - r.top };
      self.draw();
    }, { passive: true });
    canvas.addEventListener("touchend", function () { self.hover = null; self.draw(); });
    if (global.ResizeObserver) {
      new ResizeObserver(function () { self.draw(); }).observe(canvas);
    } else {
      global.addEventListener("resize", function () { self.draw(); });
    }
  }

  PlanChart.prototype.setSlots = function (slots, slotMinutes) {
    this.slots = slots || [];
    this.slotMs = Math.max(1, slotMinutes || 15) * 60 * 1000;
    this.draw();
  };

  PlanChart.prototype.draw = function () {
    var canvas = this.canvas, ctx = this.ctx;
    var css = getComputedStyle(document.documentElement);
    var muted = (css.getPropertyValue("--muted") || "#64748B").trim();
    var grid = (css.getPropertyValue("--grid") || "#E9EEF5").trim();
    var surface = (css.getPropertyValue("--surface") || "#fff").trim();
    var charge = (css.getPropertyValue("--batt") || "#16A34A").trim();
    var discharge = (css.getPropertyValue("--brand-deep") || "#3E72CE").trim();
    var curtail = (css.getPropertyValue("--grid-c") || "#0EA5A3").trim();

    var dpr = global.devicePixelRatio || 1;
    var W = canvas.clientWidth || 600, H = canvas.clientHeight || 220;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var padL = 40, padR = 12, padT = 12, padB = 24;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    if (plotW <= 0 || plotH <= 0 || !this.slots.length) return;

    var xMin = this.slots[0].startMs;
    var xMax = this.slots[this.slots.length - 1].startMs + this.slotMs;

    // Symmetric y-extent around zero so charge/discharge share a scale.
    var maxAbs = 0.5;
    this.slots.forEach(function (s) { maxAbs = Math.max(maxAbs, Math.abs(s.kw)); });
    maxAbs *= 1.15;
    var yMin = -maxAbs, yMax = maxAbs;

    function X(t) { return padL + ((t - xMin) / (xMax - xMin)) * plotW; }
    function Y(v) { return padT + (1 - (v - yMin) / (yMax - yMin)) * plotH; }
    this._geom = { padL: padL, padT: padT, plotW: plotW, plotH: plotH, X: X, Y: Y, xMin: xMin, xMax: xMax };

    // Y grid + labels (kW).
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    var step = niceStep(maxAbs * 2, 4);
    ctx.strokeStyle = grid; ctx.fillStyle = muted; ctx.lineWidth = 1;
    for (var v = Math.ceil(yMin / step) * step; v <= yMax + 1e-9; v += step) {
      var y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(W - padR, y + 0.5); ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(Math.abs(v) < 1e-9 ? "0" : nf1.format(v), padL - 6, y);
    }

    // X ticks (time).
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = muted;
    var span = xMax - xMin;
    var xStep = niceTimeStep(span);
    var t0 = Math.ceil(xMin / xStep) * xStep;
    for (var t = t0; t <= xMax; t += xStep) {
      var x = X(t);
      ctx.strokeStyle = grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 0.5, padT); ctx.lineTo(x + 0.5, padT + plotH); ctx.stroke();
      ctx.fillStyle = muted; ctx.fillText(hhmm(t), x, padT + plotH + 6);
    }

    var yZero = Y(0);
    var self = this;
    var slotPx = ((this.slotMs) / (xMax - xMin)) * plotW;
    var barW = Math.max(1, slotPx - (slotPx > 6 ? 1.5 : 0.4));

    // Active-slot highlight band (behind the bars).
    this.slots.forEach(function (s) {
      if (!s.active) return;
      var x0 = X(s.startMs);
      ctx.fillStyle = hexA(cssVar("--brand") || "#5A8DE8", 0.14);
      ctx.fillRect(x0, padT, Math.max(barW, slotPx), plotH);
    });

    // Bars.
    this.slots.forEach(function (s) {
      var xc = X(s.startMs + self.slotMs / 2);
      var x0 = xc - barW / 2;
      var yv = Y(s.kw);
      var col = s.kw >= 0 ? charge : discharge;
      if (Math.abs(s.kw) < 0.001) return;
      ctx.fillStyle = s.active ? col : hexA(col, 0.62);
      if (s.kw >= 0) ctx.fillRect(x0, yv, barW, yZero - yv);
      else ctx.fillRect(x0, yZero, barW, yv - yZero);
    });

    // Curtailment markers: a teal cap tick at the top of curtailed slots.
    this.slots.forEach(function (s) {
      if (!s.curtailed) return;
      var xc = X(s.startMs + self.slotMs / 2);
      var w = Math.max(2, barW * 0.7);
      ctx.fillStyle = curtail;
      ctx.fillRect(xc - w / 2, padT + 1, w, 3);
    });

    // "Jetzt" marker at the current device time (only within the horizon).
    var nowMs = deviceNow();
    if (nowMs >= xMin && nowMs <= xMax) {
      var nx = X(nowMs);
      ctx.strokeStyle = cssVar("--ink-2") || "#33414F"; ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(nx + 0.5, padT); ctx.lineTo(nx + 0.5, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar("--ink-2") || "#33414F";
      ctx.font = "600 10px Inter, system-ui, sans-serif";
      ctx.textBaseline = "top";
      ctx.textAlign = nx > padL + plotW - 34 ? "right" : "left";
      ctx.fillText("Jetzt", ctx.textAlign === "right" ? nx - 3 : nx + 3, padT + 1);
    }

    // Emphasized zero line.
    ctx.strokeStyle = "#C9D2DE"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(padL, yZero + 0.5); ctx.lineTo(W - padR, yZero + 0.5); ctx.stroke();

    if (this.hover) this._drawHover(surface);
  };

  PlanChart.prototype._drawHover = function () {
    var g = this._geom; if (!g || !this.slots.length) return;
    var ctx = this.ctx;
    // Which slot does the pointer sit over?
    var tx = g.xMin + ((this.hover.x - g.padL) / g.plotW) * (g.xMax - g.xMin);
    var self = this, best = null;
    this.slots.forEach(function (s) {
      if (tx >= s.startMs && tx < s.startMs + self.slotMs) best = s;
    });
    if (!best) return;
    var hx = g.X(best.startMs + this.slotMs / 2);

    var timeStr = hhmm(best.startMs) + "–" + hhmm(best.startMs + this.slotMs);
    var act = best.kw >= 0 ? "Laden" : "Entladen";
    var lines = [timeStr, act + "  " + nf1.format(Math.abs(best.kw)) + " kW"];
    if (best.curtailed) {
      lines.push("PV-Begrenzung  " + (best.pv_limit_kw != null ? nf1.format(best.pv_limit_kw) + " kW" : "aktiv"));
    }
    if (best.active) lines.push("Läuft gerade");

    ctx.font = "11px Inter, system-ui, sans-serif";
    var tw = 0;
    lines.forEach(function (l) { tw = Math.max(tw, ctx.measureText(l).width); });
    var rowH = 16, boxW = tw + 24, boxH = 10 + lines.length * rowH;
    var bx = hx + 10, by = g.padT + 4;
    if (bx + boxW > g.padL + g.plotW) bx = hx - boxW - 10;
    if (bx < g.padL) bx = g.padL + 2;

    roundRect(ctx, bx, by, boxW, boxH, 8);
    ctx.fillStyle = "rgba(23,32,46,0.92)"; ctx.fill();
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillStyle = "#E7ECF3"; ctx.font = "600 11px Inter, system-ui, sans-serif";
    ctx.fillText(lines[0], bx + 12, by + 5 + rowH / 2);
    ctx.font = "11px Inter, system-ui, sans-serif";
    for (var i = 1; i < lines.length; i++) {
      ctx.fillText(lines[i], bx + 12, by + 5 + rowH * i + rowH / 2);
    }
  };

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function niceStep(range, target) {
    if (range <= 0) return 1;
    var rough = range / target;
    var mag = Math.pow(10, Math.floor(Math.log10(rough)));
    var norm = rough / mag, step;
    if (norm < 1.5) step = 1; else if (norm < 3) step = 2; else if (norm < 7) step = 5; else step = 10;
    return step * mag;
  }
  function niceTimeStep(span) {
    var steps = [15 * 60e3, 30 * 60e3, 60 * 60e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3];
    for (var i = 0; i < steps.length; i++) { if (span / steps[i] <= 8) return steps[i]; }
    return steps[steps.length - 1];
  }
  function hexA(hex, a) {
    hex = (hex || "").replace("#", "");
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length < 6) return "rgba(90,141,232," + a + ")";
    var r = parseInt(hex.substr(0, 2), 16), g = parseInt(hex.substr(2, 2), 16), b = parseInt(hex.substr(4, 2), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  var chart = new PlanChart($("planChart"));

  // ---------------- render ----------------
  function fetchPlan() {
    return fetch("/api/plan", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        syncClock(d.server_now_ms);
        plan = d;
        if (d && d.plan) lastReceived = d.plan.received_at;
        render();
      })
      .catch(function () { /* the next state tick retries */ });
  }

  // recomputeActive marks the slot covering "now" and mirrors the server's
  // freshness rule (no active slot once the plan is stale), so the highlight
  // advances client-side between plan refetches.
  function buildSlots() {
    if (!plan || !plan.plan || !plan.plan.slots) return [];
    var p = plan.plan;
    var slotMs = Math.max(1, p.slot_minutes || 15) * 60 * 1000;
    var now = deviceNow();
    var fresh = ageMs() < staleAfterMs();
    return p.slots.map(function (s) {
      var startMs = new Date(s.start).getTime();
      return {
        startMs: startMs,
        kw: s.battery_setpoint_kw,
        curtailed: !!s.curtailed,
        pv_limit_kw: s.pv_limit_kw,
        active: fresh && now >= startMs && now < startMs + slotMs
      };
    });
  }

  function ageMs() {
    if (!plan || !plan.plan || !plan.plan.received_at) return Infinity;
    return Math.max(0, deviceNow() - new Date(plan.plan.received_at).getTime());
  }
  function staleAfterMs() {
    return ((plan && plan.plan && plan.plan.stale_after_seconds) || 1200) * 1000;
  }

  function render() {
    var hasPlan = !!(plan && plan.has_plan && plan.plan && plan.plan.slots && plan.plan.slots.length);
    $("planEmpty").hidden = hasPlan;
    $("planBody").hidden = !hasPlan;
    if (!hasPlan) { chart.setSlots([], 15); renderFresh(false); return; }

    var slots = buildSlots();
    chart.setSlots(slots, plan.plan.slot_minutes);

    // Curtailment legend only when the plan actually curtails.
    var anyCurtail = slots.some(function (s) { return s.curtailed; });
    $("planCurtailLegend").hidden = !anyCurtail;

    renderNow(slots);
    renderFresh(true);
  }

  // Current guard-clamped setpoint + operating mode (from the live state, which
  // is fresher than the plan snapshot; falls back to the plan response).
  function renderNow(slots) {
    var box = $("planNow");
    var mode = (liveState && liveState.mode) || (plan && plan.mode);
    var setpoint = liveState && liveState.setpoint_kw != null ? liveState.setpoint_kw
      : (plan ? plan.setpoint_kw : null);
    box.hidden = false;

    var valEl = $("planNowVal"), badge = $("planNowBadge"), sub = $("planNowSub");
    if (mode === "fahrplan" && setpoint != null) {
      var charging = setpoint >= 0;
      valEl.textContent = (charging ? "" : "−") + nf1.format(Math.abs(setpoint));
      badge.textContent = charging ? "Laden" : "Entladen";
      badge.className = "plan-now-badge " + (charging ? "charge" : "discharge");
      var act = slots.filter(function (s) { return s.active; })[0];
      sub.textContent = act
        ? "Aktiver Slot " + hhmm(act.startMs) + "–" + hhmm(act.startMs + chart.slotMs) + " Uhr · begrenzt durch die Geräteschutzgrenzen"
        : "kostenoptimiert nach Fahrplan";
    } else if (mode === "eigenverbrauch") {
      valEl.textContent = setpoint != null ? (setpoint >= 0 ? "" : "−") + nf1.format(Math.abs(setpoint)) : "–";
      badge.textContent = "Eigenverbrauch";
      badge.className = "plan-now-badge idle";
      sub.textContent = "Kein aktueller Fahrplan - die Batterie folgt PV und Verbrauch (Rückfallbetrieb).";
    } else {
      valEl.textContent = "–";
      badge.textContent = "Wartet";
      badge.className = "plan-now-badge idle";
      sub.textContent = "Noch keine Messwerte - es wird kein Sollwert vorgegeben.";
    }
  }

  // Plan freshness: green when recent, amber as it approaches the 20-min
  // staleness window, and an explicit stale/fallback state past it.
  function renderFresh(hasPlan) {
    var el = $("planFresh"), txt = $("planFreshText");
    if (!hasPlan) {
      el.className = "plan-fresh"; txt.textContent = "kein Fahrplan";
      return;
    }
    var age = ageMs();
    var stale = staleAfterMs();
    var mins = age / 60000;
    var ageStr = age < 60000 ? "gerade eben" : "vor " + Math.round(mins) + " Min";
    if (age >= stale) {
      el.className = "plan-fresh err";
      txt.textContent = "veraltet (" + ageStr + ") · Rückfallbetrieb";
    } else if (age >= stale - 5 * 60000) {
      // Within the last 5 min before the window closes.
      el.className = "plan-fresh warn";
      txt.textContent = "Stand " + ageStr + " · läuft bald ab";
    } else {
      el.className = "plan-fresh ok";
      txt.textContent = "Stand " + ageStr;
    }
  }

  // ---------------- public hook (called by dashboard.js) ----------------
  global.VPPlan = {
    onState: function (s) {
      liveState = s;
      if (s && s.server_now_ms) syncClock(s.server_now_ms);
      // A new plan arrived (or the first one, or it was cleared): refetch.
      var rx = s ? (s.plan_received || null) : null;
      var haveSlots = plan && plan.has_plan;
      if (rx !== lastReceived || (!rx && haveSlots) || (rx && !haveSlots)) {
        lastReceived = rx;
        fetchPlan();
        return;
      }
      render();
    }
  };

  // Keep the "Jetzt" line, active slot and freshness ticking even when idle.
  setInterval(render, 1000);

  // First paint (empty until a plan is fetched via onState / this call).
  fetchPlan();
})(window);
