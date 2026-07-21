// VoltPilot Edge - "Aktive Steuerung" strip (report §7): the READ-ONLY RESULT
// of the portal-composed flows. It shows WHAT is running (the deployed
// @vp-flow tabs with their last ack) and WHAT is steering each entity right now
// (the per-entity arbitration winner). The edge shows the RESULT, never the
// flow graph - composition stays 100% in the portal, so there is no editor and
// no write path here.
//
// Data path: dashboard.js hands each streamed device state to
// VPActiveControl.onState(state); this reads the additive state.active_control
// block the core exposes on /api/state ({palette_version, flows[], entities[]}).
// Empty flows AND empty entities => the honest empty state.
(function (global) {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  function show(el, on) { if (el) el.hidden = !on; }

  // MODE_LABELS are the CANONICAL customer names of the modes ("Modi", the
  // customer word per report decision F3 - "Strategien" stays catalog
  // vocabulary, Automationen stay Automationen). They mirror the portal
  // read-model `frontend/portal/src/surface.ts` MODE_LABELS byte-for-byte, so
  // the edge names what runs exactly like the portal does; keep the two in
  // lockstep when a mode is renamed or added. Display only - the edge derives
  // NO mode here (it never sees the flow graph), it only speaks the same words.
  var MODE_LABELS = {
    lastspitzenkappung: "Lastspitzenkappung",
    "atypische-netznutzung": "Atypische Netznutzung",
    marktvermarktung: "Marktvermarktung",
    eigenverbrauch: "Eigenverbrauch",
  };

  // ackPill maps a flow ack state to a status pill (class + German label).
  function ackPill(state) {
    switch (state) {
      case "active":      return { cls: "ok",   label: "aktiv" };
      case "unsupported": return { cls: "off",  label: "nicht unterstützt" };
      case "error":       return { cls: "warn", label: "Fehler" };
      default:            return { cls: "off",  label: state || "unbekannt" };
    }
  }

  // typeLabel names an entity type in plain German (falls back to the raw type
  // for a future catalog type this build does not know yet).
  var TYPE_LABELS = {
    "battery-hybrid": "Speicher",
    "producer": "Erzeuger",
    "grid-meter": "Netz-Zähler",
    "wallbox": "Wallbox",
    "heating-rod": "Heizstab",
    "generic-load": "Verbraucher",
    "consumer": "Verbraucher",
  };
  function typeLabel(t) { return TYPE_LABELS[t] || t || "Einheit"; }

  // winnerLabel names the arbitration winner from source (plan|desired|failsafe)
  // enriched by the holder kind - "was steuert diese Einheit gerade". The plan
  // is the JOINT result of every active mode (VoltPilot optimizes them
  // together), so it is deliberately not named after a single mode; the
  // failsafe IS the Eigenverbrauch mode and is named by its canonical label.
  function winnerLabel(source, holder) {
    var plan = "Fahrplan (VoltPilot-Optimierung)";
    if (source === "plan") return plan;
    if (source === "failsafe" || source === "") {
      return MODE_LABELS.eigenverbrauch + " (Grundzustand)";
    }
    // source === "desired": a wish won - name who emitted it.
    switch (holder) {
      case "flow":          return "Automation";
      case "local-ui":      return "Manuelle Vorgabe";
      case "cloud-command": return "Portal-Vorgabe";
      case "plan-executor": return plan;
      default:              return "Vorgabe";
    }
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function pill(cls, label) {
    var p = el("span", "pill " + cls);
    p.appendChild(el("span", "dot"));
    p.appendChild(document.createTextNode(label));
    return p;
  }

  // renderFlows fills the "Aktive Modi & Automationen" list from the deployed
  // flow acks.
  function renderFlows(flows, palette) {
    var group = $("actFlowsGroup"), list = $("actFlowsList");
    if (!group || !list) return false;
    list.innerHTML = "";
    if (!flows || flows.length === 0) { show(group, false); return false; }
    flows.forEach(function (f) {
      var li = el("li", "actctrl-row");
      var main = el("div", "actctrl-main");
      // The flow_id is the portal-side identity; a short label is honest here
      // (the edge never sees the customer's flow name NOR whether the flow is a
      // Modus or an Automation - both live in the portal), so the row names the
      // pair in the customer vocabulary and keeps the id/version operators use.
      main.appendChild(el("span", "actctrl-name", "Modus/Automation " + (f.flow_id || "?")
        + (f.flow_version ? " · v" + f.flow_version : "")));
      if (f.detail) main.appendChild(el("span", "actctrl-sub", f.detail));
      li.appendChild(main);
      var ap = ackPill(f.state);
      li.appendChild(pill(ap.cls, ap.label));
      list.appendChild(li);
    });
    var pal = $("actPalette");
    if (pal) pal.textContent = palette ? "Palette " + palette : "";
    show(group, true);
    return true;
  }

  // renderEntities fills the "Steuert gerade" list from the per-entity winners.
  function renderEntities(entities) {
    var group = $("actEntsGroup"), list = $("actEntsList");
    if (!group || !list) return false;
    list.innerHTML = "";
    if (!entities || entities.length === 0) { show(group, false); return false; }
    entities.forEach(function (e) {
      var li = el("li", "actctrl-row");
      var main = el("div", "actctrl-main");
      main.appendChild(el("span", "actctrl-name", e.label || typeLabel(e.entity_type)));
      var sub = winnerLabel(e.source, e.holder);
      if (typeof e.setpoint_kw === "number" && isFinite(e.setpoint_kw)) {
        sub += " · " + nf1.format(e.setpoint_kw) + " kW";
      }
      main.appendChild(el("span", "actctrl-sub", sub));
      li.appendChild(main);
      // A readback verdict, when present, tells the customer the command was
      // confirmed by the hardware (register-level detail stays on the
      // Steuerung & Bestätigung card).
      if (e.all_match === true) li.appendChild(pill("ok", "bestätigt"));
      else if (e.all_match === false) li.appendChild(pill("warn", "Abweichung"));
      else li.appendChild(pill("off", typeLabel(e.entity_type)));
      list.appendChild(li);
    });
    show(group, true);
    return true;
  }

  function onState(s) {
    if (!s) return;
    var ac = s.active_control || {};
    var hasFlows = renderFlows(ac.flows, ac.palette_version);
    var hasEnts = renderEntities(ac.entities);
    var any = hasFlows || hasEnts;
    show($("actctrlBody"), any);
    show($("actctrlEmpty"), !any);
  }

  global.VPActiveControl = { onState: onState };
})(window);
