// VoltPilot Edge - the "Ladepunkte" surface (OCPP load management).
//
// Two places, two jobs, the same data:
//   Einrichten  the endpoint a station is configured with, the list of
//               registered stations, and the site's limits.
//   Betrieb     what is charging right now and why somebody waits.
//
// Every DERIVATION lives in window.VPOcpp as a pure function, so the sentences
// this page shows are unit-testable without a browser (jstest/ui.test.js) -
// the house rule that a surface renders and does not decide.
(function (global) {
  "use strict";

  var fmt1 = function (v) {
    if (v === null || v === undefined || isNaN(v)) return "–";
    return (Math.round(v * 10) / 10).toString().replace(".", ",");
  };

  // endpointFor renders the FULL url an operator types into ONE station.
  //
  // ⚠ The HOST comes from the browser's own address bar, never from the box:
  // the box does not know which name the LAN reaches it under, and a
  // fabricated hostname on a copy field is worse than none. The port comes
  // from the box (it is the box's own setting).
  function endpointFor(base, locationHost, chargePointId) {
    if (!base) return "";
    var url = base;
    var m = /^ws:\/\/([^/]*)(\/.*)$/.exec(base);
    if (m) {
      var port = "";
      var pm = /:(\d+)$/.exec(m[1]);
      if (pm) port = ":" + pm[1];
      var host = (locationHost || "").replace(/:\d+$/, "");
      if (host) url = "ws://" + host + port + m[2];
    }
    if (chargePointId) url += "/" + chargePointId;
    return url;
  }

  // budgetLine is the one sentence over the Betrieb card. It NEVER claims a
  // measurement nobody reported: without a single meter value it says what is
  // ALLOCATED and stops there.
  function budgetLine(o) {
    if (!o) return "";
    if (!o.enabled) return "";
    if (!o.listening) {
      return "Der Ladepunkt-Server läuft nicht" + (o.error ? ": " + o.error : ".");
    }
    if (!(o.budget_kw > 0)) {
      return "Es ist noch keine Anschlussgrenze hinterlegt - solange wird nicht geladen.";
    }
    var line = fmt1(o.allocated_kw) + " von " + fmt1(o.budget_kw) + " kW vergeben";
    if (o.reserved_kw > 0) {
      line += " (" + fmt1(o.reserved_kw) + " kW für nicht erreichbare Säulen zurückgehalten)";
    }
    if (o.measured_kw !== null && o.measured_kw !== undefined) {
      line += " · gemessen " + fmt1(o.measured_kw) + " kW";
    }
    return line + ".";
  }

  // failsafeLine shows the customer the ARITHMETIC behind the emergency
  // profile rather than a bare number, exactly as the approved mockups do.
  // Without a computable value it repeats the reason - never a friendly zero.
  function failsafeLine(o) {
    if (!o || !o.enabled) return "";
    if (!(o.safe_default_kw > 0)) {
      return o.safe_default_note || "Für das Sicherheitsprofil fehlen noch Angaben.";
    }
    return "Fällt die Box aus, begrenzt sich jede Säule selbst auf " +
      fmt1(o.safe_default_kw) + " kW je Stecker: " +
      o.connector_count + " × " + fmt1(o.safe_default_kw) + " kW + " +
      fmt1(o.max_house_load_kw) + " kW Gebäudelast = " +
      fmt1(o.safe_worst_case_kw) + " kW" +
      (o.safe_default_holds ? " < " : " > ") + fmt1(o.grid_limit_kw) + " kW Anschlussgrenze" +
      (o.safe_default_holds ? " ✓" : " ⚠") + ".";
  }

  // connectorLine is ONE charging row: state word first, then the numbers.
  // A waiting vehicle carries its reason and, when it is computable, its
  // estimated turn - "ca." because the queue may change.
  function connectorLine(con, nowMs) {
    if (!con) return "";
    if (!con.charging) {
      return con.status === "Available" || !con.status ? "frei" : (con.status || "frei");
    }
    if (con.reason === "laedt" || (con.allocated_kw > 0)) {
      var s = "lädt";
      if (con.power_kw !== null && con.power_kw !== undefined) s += " · " + fmt1(con.power_kw) + " kW";
      if (con.allocated_kw !== null && con.allocated_kw !== undefined) {
        s += " (zugeteilt " + fmt1(con.allocated_kw) + " kW)";
      }
      if (con.soc_pct !== null && con.soc_pct !== undefined) s += " · Fahrzeug " + fmt1(con.soc_pct) + " %";
      return s;
    }
    var text = con.reason_text || "wartet";
    if (con.next_turn_ms && nowMs && con.next_turn_ms > nowMs) {
      var mins = Math.max(1, Math.round((con.next_turn_ms - nowMs) / 60000));
      text += " · dran in ca. " + mins + " Min.";
    }
    return text;
  }

  // chargerNote is the one honest line under a station's name.
  function chargerNote(c) {
    if (!c) return "";
    if (!c.connected) {
      return c.note || "getrennt - sie begrenzt sich selbst auf ihr Sicherheitsprofil";
    }
    if (!c.ready) return c.note || "wird eingerichtet …";
    var parts = [];
    if (c.model) parts.push(c.model);
    if (c.vendor) parts.push(c.vendor);
    if (c.firmware) parts.push("Firmware " + c.firmware);
    return parts.join(" · ");
  }

  // controlNote surfaces the SECOND gate. A refusal nobody can see is a riddle.
  function controlNote(o) {
    if (!o || !o.enabled || !o.listening) return "";
    if (o.control_enabled) return "";
    return o.control_note || "Die Verteilung ist an dieser Box nicht freigegeben.";
  }

  // removalConsequences is what an operator is told BEFORE a station is
  // revoked. It names what STAYS as well as what goes: a removed station is
  // not a stopped one - it keeps its safe profile and charges slowly on, and
  // hiding that would make the next support call a mystery.
  function removalConsequences(label) {
    return "Ladepunkt „" + (label || "") + "“ entfernen?\n\n" +
      "· Die Ladesäule wird getrennt und kann sich nicht mehr verbinden.\n" +
      "· Sie behält ihr zuletzt hinterlegtes Sicherheitsprofil und lädt damit weiter - langsam, aber sie lädt.\n" +
      "· Laufende Ladevorgänge werden dadurch nicht beendet.";
  }

  global.VPOcpp = {
    endpointFor: endpointFor,
    removalConsequences: removalConsequences,
    budgetLine: budgetLine,
    failsafeLine: failsafeLine,
    connectorLine: connectorLine,
    chargerNote: chargerNote,
    controlNote: controlNote,
  };
})(window);

// ---------------------------------------------------------------------------
// Rendering. Everything above is pure; everything below only puts it on the
// page. Both surfaces poll ONE endpoint (/api/ocpp) so they can never disagree.
(function () {
  "use strict";
  var D = window.VPOcpp;

  function $(id) { return document.getElementById(id); }
  function txt(id, s) { var e = $(id); if (e) e.textContent = s; }
  function show(id, on) { var e = $(id); if (e) e.hidden = !on; }

  var lastSettings = null;

  function renderSetup(data) {
    var o = data.ocpp;
    if (!$("ocppCard")) return;
    // ⚠ The Ladepunkte group is the page's only CONDITIONAL one: without the
    // feature it does not appear at all. The four fixed groups are the page's
    // promise, and a fifth row on every plant WITHOUT charge points would be
    // exactly the noise the rework removed.
    show("ladepunkte", !!(o && o.enabled));
    if (!o || !o.enabled) return;
    txt("ocppEndpoint", D.endpointFor(o.endpoint, location.host, ""));
    txt("ocppServerNote", o.listening ? "" : (o.error || "Der Server läuft nicht."));
    show("ocppServerNote", !o.listening);
    txt("ocppFailsafe", D.failsafeLine(o));
    var note = D.controlNote(o);
    txt("ocppControlNote", note);
    show("ocppControlNote", !!note);

    var list = $("ocppList");
    if (list) {
      list.textContent = "";
      (data.chargers || []).forEach(function (c) {
        var live = null;
        (o.chargers || []).forEach(function (x) { if (x.id === c.id) live = x; });
        var li = document.createElement("li");
        li.className = "row";
        var dot = document.createElement("span");
        dot.className = "row-dot " + (live && live.connected ? (live.ready ? "ok" : "warn") : "off");
        li.appendChild(dot);
        var main = document.createElement("span");
        main.className = "row-main";
        var name = document.createElement("span");
        name.className = "row-name";
        name.textContent = c.label || c.id;
        main.appendChild(name);
        var meta = document.createElement("span");
        meta.className = "row-meta";
        meta.textContent = D.chargerNote(live) || "noch nicht gemeldet";
        main.appendChild(meta);
        var url = document.createElement("span");
        url.className = "row-meta row-read";
        url.textContent = D.endpointFor(o.endpoint, location.host, c.id);
        main.appendChild(url);
        li.appendChild(main);
        if (c.priority) {
          var b = document.createElement("span");
          b.className = "row-badge";
          b.textContent = "Vorrang";
          li.appendChild(b);
        }
        var del = document.createElement("button");
        del.type = "button";
        del.className = "icon-btn";
        del.setAttribute("data-vp-edit", "");
        del.title = "Ladepunkt entfernen";
        del.textContent = "×";
        del.addEventListener("click", function () { removeCharger(c.id, c.label || c.id); });
        li.appendChild(del);
        list.appendChild(li);
      });
      show("ocppEmpty", (data.chargers || []).length === 0);
    }

    if (!lastSettings && data.settings) {
      lastSettings = data.settings;
      setVal("ocppGridLimit", data.settings.grid_limit_kw);
      setVal("ocppHouseReserve", data.settings.house_reserve_kw);
      setVal("ocppMargin", data.settings.margin_pct);
      setVal("ocppMinPower", data.settings.min_power_kw);
      setVal("ocppRotation", data.settings.rotation_minutes);
      setVal("ocppMaxHouse", data.settings.max_house_load_kw);
    }
    if (data.settings) txt("ocppBudget", (Math.round(data.settings.budget_kw * 10) / 10).toString().replace(".", ",") + " kW");
  }

  function setVal(id, v) { var e = $(id); if (e) e.value = (v === 0 ? "" : String(v).replace(".", ",")); }
  function numVal(id) {
    var e = $(id);
    if (!e) return null;
    var raw = (e.value || "").trim().replace(",", ".");
    if (raw === "") return 0;
    var n = Number(raw);
    return isNaN(n) ? null : n;
  }

  function renderBetrieb(data) {
    var o = data.ocpp;
    if (!$("ocppOpCard")) return;
    var on = !!(o && o.enabled);
    show("ocppOpCard", on);
    if (!on) return;
    txt("ocppOpBudget", D.budgetLine(o));
    var note = D.controlNote(o);
    txt("ocppOpNote", note);
    show("ocppOpNote", !!note);
    var rows = $("ocppOpRows");
    if (!rows) return;
    rows.textContent = "";
    var now = data.server_now_ms || Date.now();
    var any = false;
    (o.chargers || []).forEach(function (c) {
      (c.connectors || []).forEach(function (con) {
        if (!con.charging) return;
        any = true;
        var li = document.createElement("li");
        li.className = "row";
        var dot = document.createElement("span");
        dot.className = "row-dot " + (con.allocated_kw > 0 ? "ok" : "off");
        li.appendChild(dot);
        var main = document.createElement("span");
        main.className = "row-main";
        var name = document.createElement("span");
        name.className = "row-name";
        name.textContent = (c.label || c.id) + " · Stecker " + con.id;
        main.appendChild(name);
        var meta = document.createElement("span");
        meta.className = "row-meta";
        meta.textContent = D.connectorLine(con, now);
        main.appendChild(meta);
        li.appendChild(main);
        rows.appendChild(li);
      });
    });
    show("ocppOpIdle", !any);
  }

  function load() {
    return fetch("/api/ocpp", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        renderSetup(d);
        renderBetrieb(d);
      })
      .catch(function () { /* the page keeps its last honest state */ });
  }

  // removeCharger asks first, through the SAME consequence mechanism the rest
  // of this page uses (window.VPConsequences.ask). The wording is the pure
  // VPOcpp.removalConsequences, so the sentence is testable.
  function removeCharger(id, label) {
    if (window.VPConsequences && !window.VPConsequences.ask(D.removalConsequences(label))) return;
    fetch("/api/ocpp/chargers/" + encodeURIComponent(id), { method: "DELETE" })
      .then(function () { load(); });
  }

  function wire() {
    var add = $("ocppAddForm");
    if (add) {
      add.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var body = {
          id: ($("ocppAddId") || {}).value || "",
          label: ($("ocppAddLabel") || {}).value || "",
          rated_kw: Number((($("ocppAddRated") || {}).value || "0").replace(",", ".")) || 0,
          connectors: Number(($("ocppAddConnectors") || {}).value || "0") || 0,
          priority: !!(($("ocppAddPriority") || {}).checked),
        };
        post("/api/ocpp/chargers", body, "ocppAddError", function () {
          add.reset();
          load();
        });
      });
    }
    var settings = $("ocppSettingsForm");
    if (settings) {
      settings.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var body = {
          grid_limit_kw: numVal("ocppGridLimit"),
          house_reserve_kw: numVal("ocppHouseReserve"),
          margin_pct: numVal("ocppMargin"),
          min_power_kw: numVal("ocppMinPower"),
          rotation_minutes: numVal("ocppRotation"),
          max_house_load_kw: numVal("ocppMaxHouse"),
        };
        post("/api/ocpp/settings", body, "ocppSettingsError", function () {
          lastSettings = null;
          load();
        });
      });
    }
  }

  function post(url, body, errID, ok) {
    show(errID, false);
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (r.ok) { ok(); return; }
      return r.text().then(function (t) {
        txt(errID, (t || "").trim() || "Die Eingabe konnte nicht gespeichert werden.");
        show(errID, true);
      });
    }).catch(function () {
      txt(errID, "Die Box ist gerade nicht erreichbar.");
      show(errID, true);
    });
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("DOMContentLoaded", function () {
      wire();
      load();
      setInterval(load, 5000);
    });
  }
})();
