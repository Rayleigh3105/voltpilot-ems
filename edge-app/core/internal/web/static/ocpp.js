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

  // budgetSourceLine says WHERE the budget came from - the Stufe-2 stages.
  //
  // ⚠ The German sentence is NEVER written here: it is written ONCE in the box
  // (internal/lastmgmt/budget.go) and travels verbatim, exactly like the
  // feed-in watchdog's. Two renderings of the same verdict must not be able to
  // word it differently, and only the box knows the numbers behind it.
  function budgetSourceLine(o) {
    if (!o || !o.enabled || !o.listening) return "";
    return o.budget_note || "";
  }

  // budgetSourceTone maps the stage onto the page's dot vocabulary. A blind
  // stage is a WARNING even while it still charges: the budget is being held or
  // pulled in, and the operator's lever is the measurement.
  function budgetSourceTone(o) {
    if (!o || !o.enabled) return "off";
    switch (o.budget_mode) {
      case "gemessen":
        return "ok";
      case "haelt":
      case "zieht_zusammen":
      case "sicherheitsbudget":
        return "warn";
      default:
        return "off"; // statisch - honest, just not measured
    }
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
      // A boosted charge SAYS so: a full charge nobody asked for would be a
      // silent break of the customer's own source priority.
      var s = con.boost ? "lädt voll auf Ihren Wunsch" : "lädt";
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

  // ---------------------------------------------------------------------
  // Stufe 4: PV-Überschussladen (the SOURCE lane) - Mockups §2b
  // ---------------------------------------------------------------------

  // POLICY_TEXT is the customer's own wording of their three options. It lives
  // ONCE (mirrored by lastmgmt.PolicyText for the sentences the box writes),
  // so the radio label and a paused vehicle's reason can never disagree.
  var POLICY_TEXT = {
    nur_sonne: "Nur Sonnenstrom",
    sonne_zuerst: "Sonne zuerst, Netz wenn günstig",
    schnell: "Schnell laden",
  };

  var POLICY_HELP = {
    nur_sonne:
      "Geladen wird ausschließlich Ihr Überschuss. Zieht eine Wolke auf, pausiert das Laden, statt Netzstrom zu kaufen.",
    sonne_zuerst:
      "Der Überschuss wird immer zuerst genutzt. Netzstrom kommt nur dazu, wenn ein Fahrzeug sonst stehen bliebe - so werden Fahrzeuge planbar voll.",
    schnell:
      "Volle verfügbare Leistung, Quelle egal. Die Anschlussgrenze gilt natürlich weiter.",
  };

  // surplusLine is the ONE sentence about the source lane. It REPEATS the
  // box's own sentence (written once in internal/lastmgmt/surplus.go) and adds
  // nothing - only the box knows the numbers behind it.
  function surplusLine(o) {
    if (!o || !o.enabled || !o.listening) return "";
    return o.surplus_note || "";
  }

  // surplusTone: an unprovable lane is a WARNING only where it actually holds
  // a vehicle back ("Nur Sonnenstrom"); where it fails open it is honest and
  // no alarm.
  function surplusTone(o) {
    if (!o || !o.enabled) return "off";
    if (o.surplus_mode === "gemessen") return "ok";
    if (o.surplus_mode === "nicht_belegbar") return o.surplus_active ? "warn" : "off";
    return "off";
  }

  // sourceCapLine shows BOTH truths side by side (Mockups §1a): what the sun
  // allows and what the connection allows. Without both, a plant throttled at
  // a free connection reads like a defect.
  function sourceCapLine(o) {
    if (!o || !o.surplus_active) return "";
    if (o.surplus_kw === null || o.surplus_kw === undefined) return "";
    var line = "Ladebudget " + fmt1(o.surplus_kw) + " kW aus Sonnenüberschuss";
    if (o.budget_kw > 0) line += " · physisch möglich " + fmt1(o.budget_kw) + " kW";
    if (o.source_allocated_kw > 0) {
      line += " · davon deckt gerade " + fmt1(o.source_allocated_kw) + " kW Ihre Sonne";
    }
    return line + ".";
  }

  // planCapLine names the FAHRPLAN lane when it is what holds the vehicles
  // back (Stufe 4, Weg A). Ohne bindenden Deckel steht dort NICHTS: eine
  // Begrenzung, die gerade nicht greift, ist keine Auskunft - und ein
  // fehlender Plan ist ausdrücklich kein Grund für einen Satz, weil dann die
  // lokale Logik unverändert gilt.
  function planCapLine(o) {
    if (!o || !o.plan_limit_binds) return "";
    if (o.plan_limit_kw === null || o.plan_limit_kw === undefined) return "";
    return "Der Fahrplan hält gerade die Lastspitze - dafür bleiben den " +
      "Fahrzeugen in dieser Viertelstunde " + fmt1(o.plan_limit_kw) + " kW.";
  }

  // boostConsequences is the Haus-Folgenliste of „Jetzt voll laden" - the four
  // points of the approved dialog, WORD FOR WORD, including the one that says
  // what does NOT change.
  function boostConsequences(title) {
    return "„Jetzt voll laden\" für " + (title || "diesen Ladevorgang") + "?\n\n" +
      "· Dieser Ladevorgang lädt ab sofort mit voller verfügbarer Leistung - auch mit Netzstrom.\n" +
      "· Ihre Überschuss-Priorität bleibt für alle anderen Ladevorgänge unverändert.\n" +
      "· Anschlussgrenze, Sicherheitsabstand und Ausfall-Schutz gelten weiter - daran ändert dieser Knopf nichts.\n" +
      "· Gilt, bis das Fahrzeug voll ist, längstens 4 Stunden - danach gilt wieder Ihre Priorität.";
  }

  // boostable reports whether the button may be OFFERED at all: only a running
  // charge can be overridden, and only where a SOURCE lane is actually holding
  // something back. A button that can change nothing is noise.
  function boostable(o, con) {
    if (!o || !o.surplus_active || !con || !con.charging) return false;
    // ⚠ Ein von Hand PAUSIERTER Ladevorgang bekommt „Jetzt voll laden" NICHT
    // angeboten: der Kunde hat ihn gerade gestoppt, und derselbe Knopf würde
    // seinen Eingriff still durch den gegenteiligen ersetzen. Was diese Zeile
    // braucht, ist der Rückweg - und den zeigt sie (siehe `handPaused`).
    return !con.boost && !con.hand_paused;
  }

  // handPaused reports whether THIS plug is held at 0 kW by the customer's own
  // „Laden pausieren" (P3b). Die Box selbst bietet die Pause NICHT an - sie
  // kommt aus dem Portal; diese Karte ZEIGT sie (der Zustands-Satz kommt aus
  // `reason_text`) und bietet den Rückweg „Automatik fortsetzen".
  function handPaused(con) {
    return !!(con && con.hand_paused);
  }

  // zeigeGruppe entscheidet, ob die Einrichten-Seite ihre BEDINGTE
  // Ladepunkte-Gruppe ueberhaupt zeigt.
  //
  // ⚠ Seit VP_OCPP_ENABLED per Vorgabe AN ist (24.08.2026), ist "der Server
  // laeuft" KEIN Signal mehr dafuer, dass diese Anlage mit Ladepunkten zu tun
  // hat - es gilt jetzt auf JEDER Box. Das Signal ist deshalb, ob es wirklich
  // Ladepunkte GIBT: eine eingetragene Kennung oder eine Saeule, die sich
  // gemeldet hat.
  //
  // Die vier festen Gruppen sind die Zusage der Seite ("eine fertig
  // eingerichtete gesunde Anlage zeigt vier ruhige Zeilen"), und eine fuenfte
  // Zeile auf jeder Anlage OHNE Ladesaeulen waere genau das Rauschen, das der
  // Umbau beseitigt hat.
  //
  // ⚠ Der DEEP-LINK (#ladepunkte) blendet sie trotzdem ein - sonst gaebe es
  // lokal keinen Weg zur ERSTEN Saeule, und die gefuehrte Einrichtung eines
  // Ladeparks verlinkt genau dorthin.
  function zeigeGruppe(o, eingetragen, hash) {
    if (!o || !o.enabled) return false;
    if ((eingetragen || []).length > 0) return true;
    if ((o.chargers || []).length > 0) return true;
    return String(hash || "").replace(/^#/, "") === "ladepunkte";
  }

  // removalConsequences is what an operator is told BEFORE a station is
  // revoked. It names what STAYS as well as what goes: a removed station is
  // not a stopped one - it keeps its safe profile and charges slowly on, and
  // hiding that would make the next support call a mystery.
  //
  // ⚠ Das PORTAL sagt dasselbe (`ladesaeuleAnbinden.entfernenFolgen`) - beide
  // Wege duerfen ueber dieselbe Handlung nichts Verschiedenes versprechen.
  function removalConsequences(label) {
    return "Ladepunkt „" + (label || "") + "“ entfernen?\n\n" +
      "· Die Ladesäule wird getrennt und kann sich nicht mehr verbinden.\n" +
      "· Sie behält ihr zuletzt hinterlegtes Sicherheitsprofil und lädt damit weiter - langsam, aber sie lädt.\n" +
      "· Laufende Ladevorgänge werden dadurch nicht beendet.";
  }

  global.VPOcpp = {
    endpointFor: endpointFor,
    POLICY_TEXT: POLICY_TEXT,
    POLICY_HELP: POLICY_HELP,
    surplusLine: surplusLine,
    surplusTone: surplusTone,
    sourceCapLine: sourceCapLine,
    planCapLine: planCapLine,
    boostConsequences: boostConsequences,
    boostable: boostable,
    handPaused: handPaused,
    budgetSourceLine: budgetSourceLine,
    budgetSourceTone: budgetSourceTone,
    removalConsequences: removalConsequences,
    zeigeGruppe: zeigeGruppe,
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
    // ⚠ Die einzige BEDINGTE Gruppe der Seite - die Regel steht in
    // zeigeGruppe() und ist ohne Browser pruefbar. Sichtbar ist sie, sobald es
    // wirklich Ladepunkte gibt (oder der Deep-Link ausdruecklich hierher
    // zeigt), NICHT schon weil der Server laeuft: der laeuft seit der
    // Vorgabe-Umstellung auf jeder Box.
    var gruppe = $("ladepunkte");
    var warVersteckt = !!(gruppe && gruppe.hidden);
    show("ladepunkte", zeigeGruppe(o, data.chargers, location.hash));
    // ⚠ Der Deep-Link kommt VOR den Daten an: einrichten.js hat sein
    // revealHash() schon gefahren, als die Gruppe noch versteckt war. Sobald
    // sie auftaucht, wird der Sprung deshalb einmal nachgeholt - ein Deep-Link,
    // der auf einer unsichtbaren Gruppe landet, ist kein Deep-Link.
    if (warVersteckt && gruppe && !gruppe.hidden
        && (location.hash || "").replace(/^#/, "") === "ladepunkte") {
      window.dispatchEvent(new Event("hashchange"));
    }
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
      var sw = $("ocppStaticBudget");
      if (sw) sw.checked = !!data.settings.static_budget;
      setRadio("ocppPolicy", data.settings.surplus_policy || "schnell");
      setRadio("ocppStorage", data.settings.storage_priority || "speicher_vor_auto");
    }
    var sl = D.surplusLine(o);
    txt("ocppSurplusText", sl);
    show("ocppSurplus", !!sl);
    var sdot = $("ocppSurplusDot");
    if (sdot) sdot.className = "row-dot " + D.surplusTone(o);
    // The storage choice only means something on a plant that HAS a storage -
    // and only the box knows whether one reports. Without a measured battery
    // the row would be a question about a device that is not there.
    show("ocppStorageRow", o.surplus_battery_kw !== null && o.surplus_battery_kw !== undefined);
  }

  function setRadio(name, value) {
    var list = document.getElementsByName(name);
    for (var i = 0; i < list.length; i++) list[i].checked = list[i].value === value;
  }

  function radioVal(name) {
    var list = document.getElementsByName(name);
    for (var i = 0; i < list.length; i++) if (list[i].checked) return list[i].value;
    return null;
    // ⚠ The LIVE budget, not the one these settings alone would yield: since
    // Stufe 2 the two differ whenever the box measures its connection point,
    // and a setup page showing a different number than the operating card
    // would be two truths about one figure.
    if (o.budget_kw !== undefined) {
      txt("ocppBudget", (Math.round(o.budget_kw * 10) / 10).toString().replace(".", ",") + " kW");
    }
    var src = D.budgetSourceLine(o);
    txt("ocppBudgetSourceText", src);
    show("ocppBudgetSource", !!src);
    var dot = $("ocppBudgetDot");
    if (dot) dot.className = "row-dot " + D.budgetSourceTone(o);
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
    // The stage sentence, verbatim from the box. NO colour on this page: the
    // Betrieb view has no dot vocabulary, and the sentence carries the meaning
    // on its own (the house rule that a state is always a WORD, never a hue).
    var src = D.budgetSourceLine(o);
    txt("ocppOpSource", src);
    show("ocppOpSource", !!src);
    // BOTH truths, side by side (Mockups §1a): what the sun allows and what
    // the connection allows. Without both, a plant throttled at a free
    // connection reads like a defect.
    var cap = D.sourceCapLine(o);
    txt("ocppOpSurplus", cap);
    show("ocppOpSurplus", !!cap);
    // Und WER gerade deckelt, wenn es der Fahrplan ist: eine Begrenzung ohne
    // Namen liest sich wie ein Defekt (die Canary-Soak-Lehre).
    var planCap = D.planCapLine(o);
    txt("ocppOpPlan", planCap);
    show("ocppOpPlan", !!planCap);
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
        // „Jetzt voll laden" - offered ONLY where it can change something
        // (a running charge that the source lane is actually holding back).
        if (D.boostable(o, con)) {
          li.appendChild(boostButton(c, con, false));
        } else if (con.boost || D.handPaused(con)) {
          li.appendChild(boostButton(c, con, true));
        }
        rows.appendChild(li);
      });
    });
    show("ocppOpIdle", !any);
  }

  // boostButton is the one customer action of this card. Its consequence list
  // is the Haus-Folgenliste (it also says what does NOT change), and it goes
  // through the same confirm the rest of the page uses.
  function boostButton(c, con, running) {
    var title = (c.label || c.id) + " · Stecker " + con.id;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "btn-inline";
    b.textContent = running ? "Wieder Ihre Priorität" : "Jetzt voll laden";
    b.addEventListener("click", function () {
      if (!running && !window.confirm(D.boostConsequences(title))) return;
      post("/api/ocpp/boost", {
        charge_point_id: c.id, connector_id: con.id, cancel: !!running,
      }, "ocppOpError", function () { load(); });
    });
    return b;
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
          static_budget: !!(($("ocppStaticBudget") || {}).checked),
        };
        var pol = radioVal("ocppPolicy");
        if (pol) body.surplus_policy = pol;
        var sto = radioVal("ocppStorage");
        if (sto) body.storage_priority = sto;
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
      // Ein von Hand eingegebener #ladepunkte soll nicht bis zum naechsten
      // Takt warten, bis die bedingte Gruppe erscheint.
      window.addEventListener("hashchange", function () { load(); });
    });
  }
})();
