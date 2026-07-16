// VoltPilot Edge - "Betrieb" card (PS-3): the technician's at-a-glance
// operating state. Marktoptimierung (plan freshness/mode), Spitzen-Wache
// (peak guard: active + target), the running 15-min import mean, the peak
// reserve, and what happens on a dead cloud link. Read-only; German copy;
// no jargon beyond kW and SoC.
//
// Data path: dashboard.js hands each streamed device state to
// VPBetrieb.onState(state); this reads mode/plan_received plus the additive
// peak fields (peak_target_kw, peak_reserve_soc_pct, peak_guard_active,
// peak_quarter_mean_kw) the core exposes on /api/state.
(function (global) {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

  function fmtClock(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  }

  function show(el, on) { if (el) el.hidden = !on; }
  function set(id, text, ok) {
    var el = $(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("ok", !!ok);
  }

  function onState(s) {
    if (!s) return;

    // Marktoptimierung: what currently drives the battery.
    if (s.mode === "fahrplan") {
      var at = fmtClock(s.plan_received);
      set("btMarkt", "aktiv · Fahrplan " + (at ? at : "empfangen"), true);
    } else if (s.mode === "eigenverbrauch") {
      set("btMarkt", s.plan_received
        ? "Eigenverbrauch · kein aktueller Fahrplan"
        : "Eigenverbrauch", false);
    } else {
      set("btMarkt", "keine Messwerte", false);
    }

    // Spitzen-Wache: module on = a peak target is known from the last plan.
    var target = s.peak_target_kw;
    var moduleOn = target != null;
    if (moduleOn) {
      if (s.peak_guard_active) {
        set("btWache", "aktiv · Ziel " + nf1.format(target) + " kW", true);
      } else {
        set("btWache", "Ziel " + nf1.format(target) + " kW · wartet auf Netz-Messwerte", false);
      }
    } else {
      set("btWache", "inaktiv", false);
    }

    // Running quarter-hour import mean (only meaningful while the module is on).
    var mean = s.peak_quarter_mean_kw;
    show($("btMeanRow"), moduleOn && mean != null);
    if (mean != null) set("btMean", nf1.format(mean) + " kW", false);

    // Reserve held back for peak defense.
    var reserve = s.peak_reserve_soc_pct;
    show($("btReserveRow"), reserve != null);
    if (reserve != null) set("btReserve", nf0.format(reserve) + " % SoC vorgehalten", false);

    // What the device does on a dead cloud link - honest, per module state.
    if (moduleOn) {
      set("btOffline", reserve != null
        ? "Wache läuft lokal weiter, Eigenverbrauch nur bis zur Reserve"
        : "Wache läuft lokal weiter, danach Eigenverbrauch", false);
    } else {
      set("btOffline", "Eigenverbrauch (PV-Überschuss nutzen)", false);
    }
  }

  global.VPBetrieb = { onState: onState };
})(window);
