// sources.js - the "Erzeuger" + "Netz-Zähler" + "Verbraucher" groups of the
// "Meine Anlage" card: list (grouped by role, with a live status dot/pill per
// source) + add (in a focused drawer) + remove ADDITIONAL read-only measurement
// points. Three roles: an Erzeuger (a separate PV inverter, summed into the site
// PV), a Netz-Zähler (a grid meter at the point of common coupling, 0-1 per
// site) and a Verbraucher (e.g. a go-e wallbox read over its local HTTP API, its
// consumption only measured, never controlled). It reuses the SAME option
// catalog as the inverter form (GET /api/sources returns {sources, statuses,
// catalog}), keeps control off (a source never gets a control path), and
// captures a kWp + MaStR SEE number for an Erzeuger only.
// Self-contained, no framework; shares VP (verify.js) with the inverter form.
(function () {
  "use strict";

  var ROLE_ERZEUGER = "pv-generation";
  var ROLE_NETZ = "grid-meter";
  var ROLE_CONSUMER = "consumer";
  // Communication of a consumer-only driver (a go-e wallbox). Used to filter the
  // brand list per role: a consumer picks a consumer brand, an Erzeuger/Netz
  // picks a generation/meter brand - never mixed.
  var CONSUMER_COMM = "goe_http_api";

  function $(id) { return document.getElementById(id); }
  var el = window.VP.el;

  function roleLabel(role) {
    if (role === ROLE_NETZ) return "Netz-Zähler";
    if (role === ROLE_CONSUMER) return "Verbraucher";
    return "Erzeuger";
  }

  var catalog = null;
  var statuses = {};       // source id -> "ok"|"warn"|"pending"
  var readings = {};       // source id -> {pv_kw?, power_kw?, read_at_ms} ("Zuletzt gelesen")
  var serverNowMs = 0;     // device clock at fetch time (honest "vor X" ages)
  var hasNetz = false;     // whether a Netz-Zähler already exists (role-lock)
  var currentRole = ROLE_ERZEUGER;
  var currentList = [];    // the sources as last loaded (for the unit-id offer)

  function brandById(id) {
    if (!catalog) return null;
    for (var i = 0; i < catalog.brands.length; i++) {
      if (catalog.brands[i].id === id) return catalog.brands[i];
    }
    return null;
  }

  function commLabel(c) {
    if (c === "solarman_v5") return "Solarman-V5 (WiFi-Datenlogger)";
    if (c === "goe_http_api") return "go-e HTTP-API";
    if (c === "fronius_solar_api") return "Fronius Solar-API";
    if (c === "fronius_sunspec") return "SunSpec (Modbus TCP)";
    return "Modbus TCP";
  }

  function fmtKwp(v) {
    return (Math.round(v * 10) / 10).toString().replace(".", ",");
  }

  /* ---------------- list (grouped by role) ---------------- */

  // readingParts renders a source's last accepted reading as German value
  // chips: PV generation for an Erzeuger, Bezug/Einspeisung for a Netz meter.
  // Only channels the source actually delivered appear - never a fabricated 0.
  function readingParts(lr) {
    var parts = [];
    if (!lr) return parts;
    if (typeof lr.pv_kw === "number" && isFinite(lr.pv_kw)) {
      parts.push("PV " + window.VP.fmtVal(lr.pv_kw, "kW"));
    }
    if (typeof lr.power_kw === "number" && isFinite(lr.power_kw)) {
      parts.push(window.VP.gridPart(lr.power_kw));
    }
    if (typeof lr.load_kw === "number" && isFinite(lr.load_kw)) {
      parts.push("Verbrauch " + window.VP.fmtVal(lr.load_kw, "kW"));
    }
    return parts;
  }

  function readAtMs(lr) { return lr && lr.read_at_ms ? lr.read_at_ms : 0; }

  // buildRow renders one source row: status dot + name + meta + status pill +
  // an "Entfernen" (unclaim) action. There is no per-source edit (the edge has
  // no source-edit endpoint - identity/transport is set at add time).
  function buildRow(s) {
    var li = el("li", { class: "row" });
    var st = window.VP.statusPill(statuses[s.id] || "pending");
    li.appendChild(el("span", { class: "row-dot " + st.dot, "aria-hidden": "true" }));

    var main = el("div", { class: "row-main" });
    main.appendChild(el("span", { class: "row-name" }, s.label || s.brand));
    var meta = [];
    if (s.capacity_kwp) meta.push(fmtKwp(s.capacity_kwp) + " kWp");
    meta.push(commLabel(s.communication));
    if (s.connection && s.connection.ip) meta.push(s.connection.ip);
    main.appendChild(el("span", { class: "row-meta" }, meta.join(" · ")));
    // "Zuletzt gelesen": the source's last accepted value + when it was read.
    // No reading yet -> no line at all (the pill already says "Wartet auf
    // erste Daten"); a stale one keeps showing with its honest age. The raw
    // line is Technik detail - the pill carries the customer verdict.
    var line = window.VP.lastReadLine(readingParts(readings[s.id]), readAtMs(readings[s.id]), serverNowMs);
    if (line) main.appendChild(el("span", { class: "row-meta row-read tech-only" }, line));
    li.appendChild(main);

    var badge = el("span", { class: "row-badge" });
    var pill = el("span", { class: "pill " + st.pill });
    pill.appendChild(el("span", { class: "dot" }));
    pill.appendChild(document.createTextNode(st.label));
    badge.appendChild(pill);
    li.appendChild(badge);

    var actions = el("span", { class: "row-actions" });
    var ren = el("button", { type: "button", class: "icon-btn",
      title: "Umbenennen (Enter speichert, Esc bricht ab)", "aria-label": "Quelle umbenennen",
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>' });
    ren.addEventListener("click", function () { startRename(li, s); });
    actions.appendChild(ren);
    var del = el("button", { type: "button", class: "icon-btn danger", title: "Entfernen", "aria-label": "Quelle entfernen",
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>' });
    del.addEventListener("click", function () { removeSource(s); });
    actions.appendChild(del);
    li.appendChild(actions);
    return li;
  }

  // startRename swaps the row's name for an inline input (Enter = speichern,
  // Escape/Blur = abbrechen). Rename is LABEL-ONLY on purpose: the source id -
  // and with it the portal's adoption pin (measurement_point.edge_source_id) -
  // stays. Before this endpoint existed the only "rename" was delete + re-add,
  // which minted a new id and orphaned the pin (vp-vier-erzeuger-p9).
  function startRename(li, s) {
    var nameEl = li.querySelector(".row-name");
    if (!nameEl || li.querySelector(".row-rename")) return;
    var input = el("input", { type: "text", class: "row-rename", maxlength: "64",
      "aria-label": "Neuer Name" });
    input.value = s.label || "";
    var err = el("span", { class: "row-meta row-rename-err" });
    err.hidden = true;
    nameEl.replaceWith(input);
    input.insertAdjacentElement("afterend", err);
    input.focus();
    input.select();
    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      var v = (input.value || "").trim();
      if (!save || v === "" || v === s.label) { load(); return; }
      fetch("/api/sources/" + encodeURIComponent(s.id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: v })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          if (!r.ok) throw new Error((b && b.error) || "Umbenennen fehlgeschlagen.");
        });
      }).then(function () { load(); }).catch(function (e) {
        done = false;
        err.hidden = false;
        err.textContent = e.message;
        input.focus();
      });
    }
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", function () { finish(false); });
  }

  function renderGroups(list) {
    currentList = list || [];
    var erz = [], netz = [], verb = [];
    (list || []).forEach(function (s) {
      if (s.role === ROLE_NETZ) netz.push(s);
      else if (s.role === ROLE_CONSUMER) verb.push(s);
      else erz.push(s);
    });
    hasNetz = netz.length > 0;

    var erzUl = $("erzList"); erzUl.innerHTML = "";
    erz.forEach(function (s) { erzUl.appendChild(buildRow(s)); });
    $("erzNote").textContent = "· " + erz.length + (erz.length === 1 ? " zusätzliche Quelle" : " zusätzliche Quellen");

    var netzUl = $("netzList"); netzUl.innerHTML = "";
    netz.forEach(function (s) { netzUl.appendChild(buildRow(s)); });
    // At most one grid meter per plant: the add-row disappears once one exists.
    $("netzAdd").hidden = hasNetz;
    $("netzNote").textContent = hasNetz ? "· 1 von 1" : "· optional, max. 1";

    var verbUl = $("verbList"); verbUl.innerHTML = "";
    verb.forEach(function (s) { verbUl.appendChild(buildRow(s)); });
    $("verbNote").textContent = "· " + verb.length + (verb.length === 1 ? " Verbraucher" : " Verbraucher");
    renderBalance();
  }

  /* ---- expert OPT-OUT from the house-consumption standard (Netz group) ----
     The standard (default ON, captain decree 2026-07-17): house = pv_total +
     grid − battery, with the primary inverter's own grid reading serving as
     the site grid when no dedicated Netz-Zähler is configured. The checkbox is
     the expert opt-out for the genuinely different topology where the
     primary's CT does NOT sit at the point of common coupling. Persisted on
     the edge (POST /api/balance); a configured Netz-Zähler always takes
     precedence over both. */

  var BALANCE_HELP =
    "Standardmäßig wird der Hausverbrauch aus der Leistungsbilanz berechnet: Erzeugung + Netz − Batterie. Die " +
    "Netzmessung des Wechselrichters gilt dabei als Messung am Hausanschluss (inkl. der Einspeisung zusätzlicher " +
    "Erzeuger). Nur aktivieren, wenn der Messwandler (CT) des Wechselrichters bei Ihnen NICHT am Hausanschluss " +
    "sitzt – dann wird wieder die Last-Anzeige des Wechselrichters verwendet. Ein eigener Netz-Zähler ist die " +
    "sichere Alternative und hat immer Vorrang.";

  var balance = { primary_grid_not_site_total: false };

  function renderBalance() {
    // A save is in flight (toggle disabled): don't let a periodic refresh
    // visually flip the checkbox back; the save response re-renders.
    if ($("primGridToggle").disabled) return;
    $("primGridToggle").checked = !!balance.primary_grid_not_site_total;
    $("primGridHelp").textContent = hasNetz
      ? "Ihr Netz-Zähler hat Vorrang – diese Einstellung wirkt nur, solange kein aktueller Zähler-Messwert vorliegt. " + BALANCE_HELP
      : BALANCE_HELP;
  }

  function saveBalance() {
    var toggle = $("primGridToggle");
    var next = { primary_grid_not_site_total: toggle.checked };
    toggle.disabled = true;
    fetch("/api/balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, body: body }; });
    }).then(function (res) {
      toggle.disabled = false;
      if (!res.ok) { renderBalance(); return; } // revert to the persisted state
      balance = (res.body && res.body.balance) || next;
      renderBalance();
    }).catch(function () {
      toggle.disabled = false;
      renderBalance(); // network error: revert, a reload re-syncs
    });
  }

  /* ---------------- add form ---------------- */

  // brandsForRole filters the catalog to the brands that make sense for the
  // chosen role: a Verbraucher picks a consumer driver (go-e), an Erzeuger/Netz
  // picks a generation/meter driver (everything else) - so an inverter brand is
  // never offered for a wallbox, nor go-e for a PV source.
  function brandsForRole(role) {
    return (catalog.brands || []).filter(function (b) {
      var isConsumerBrand = b.communication === CONSUMER_COMM;
      return role === ROLE_CONSUMER ? isConsumerBrand : !isConsumerBrand;
    });
  }

  function populateBrands() {
    var sel = $("srcBrand");
    sel.innerHTML = "";
    brandsForRole(currentRole).forEach(function (b) {
      sel.appendChild(el("option", { value: b.id }, b.label));
    });
    onBrandChange();
  }

  function onBrandChange() {
    var brand = brandById($("srcBrand").value);
    if (!brand) return;
    $("srcComm").textContent = brand.comm_label || commLabel(brand.communication);
    var msel = $("srcModel");
    msel.innerHTML = "";
    (brand.models || []).forEach(function (m) {
      msel.appendChild(el("option", { value: m.id }, m.label));
    });
    renderFields(brand);
  }

  function renderFields(brand) {
    var wrap = $("srcFields");
    wrap.innerHTML = "";
    (brand.fields || []).forEach(function (f) {
      var row = el("div", { class: "field" });
      var inputId = "sf_" + f.key;
      if (f.type === "checkbox") {
        var cbWrap = el("label", { class: "checkbox-row", for: inputId });
        var cb = el("input", { type: "checkbox", id: inputId });
        cb.dataset.key = f.key;
        cb.dataset.ftype = "checkbox";
        cbWrap.appendChild(cb);
        cbWrap.appendChild(el("span", null, f.label));
        row.appendChild(cbWrap);
      } else {
        row.appendChild(el("label", { for: inputId }, f.label + (f.required ? " *" : "")));
        var input;
        if (f.type === "select") {
          input = el("select", { id: inputId });
          (f.options || []).forEach(function (o) {
            input.appendChild(el("option", { value: String(o.value) }, o.label));
          });
          if (f.default != null) input.value = String(f.default);
        } else {
          input = el("input", { type: f.type === "number" ? "number" : "text", id: inputId });
          if (f.required) input.required = true;
          if (f.default != null) input.value = String(f.default);
        }
        input.dataset.key = f.key;
        input.dataset.ftype = f.type;
        row.appendChild(input);
      }
      if (f.help) row.appendChild(el("p", { class: "field-help" }, f.help));
      wrap.appendChild(row);
    });
  }

  // setRole selects a role card and shows the nameplate fields (kWp + MaStR SEE)
  // only for an Erzeuger; a Netz meter and a Verbraucher have no nameplate. The
  // Netz card is locked (and never selectable) once one already exists. Changing
  // the role re-filters the brand list (a Verbraucher offers only consumer
  // drivers, an Erzeuger/Netz never offers a wallbox).
  function setRole(role) {
    if (role === ROLE_NETZ && hasNetz) return;
    var prev = currentRole;
    currentRole = role;
    $("roleErz").classList.toggle("sel", role === ROLE_ERZEUGER);
    $("roleNetz").classList.toggle("sel", role === ROLE_NETZ);
    $("roleVerbraucher").classList.toggle("sel", role === ROLE_CONSUMER);
    var nameplate = role === ROLE_ERZEUGER; // only an Erzeuger carries kWp + SEE
    $("srcKwpField").hidden = !nameplate;
    $("srcSeeField").hidden = !nameplate;
    if (role === ROLE_NETZ) {
      $("srcRoleHelp").textContent = "Ein eigener Zähler am Netzübergang. Sein gemessener Bezug/Einspeisung ersetzt den Wert des Speicher-Wechselrichters.";
      $("srcLabel").placeholder = "z. B. Netz-Zähler Hausanschluss";
    } else if (role === ROLE_CONSUMER) {
      $("srcRoleHelp").textContent = "Ein zusätzlicher Verbraucher (z. B. eine Wallbox). Sein Verbrauch wird nur mitgemessen, nicht gesteuert.";
      $("srcLabel").placeholder = "z. B. Wallbox Garage";
    } else {
      $("srcRoleHelp").textContent = "Eine zusätzliche PV-Anlage, deren Erzeugung mitgezählt wird.";
      $("srcLabel").placeholder = "z. B. PV Dach Süd";
    }
    // Consumer <-> non-consumer switches the available brand set, so repopulate.
    if (catalog && isConsumerRole(prev) !== isConsumerRole(role)) populateBrands();
  }

  function isConsumerRole(role) { return role === ROLE_CONSUMER; }

  function collect() {
    var conn = {};
    $("srcFields").querySelectorAll("[data-key]").forEach(function (input) {
      var key = input.dataset.key, ftype = input.dataset.ftype;
      if (ftype === "checkbox") {
        conn[key] = input.checked;
      } else if (ftype === "number" || ftype === "select") {
        var raw = input.value;
        if (raw === "") return;
        var n = Number(raw);
        conn[key] = isNaN(n) ? raw : n;
      } else if (input.value.trim() !== "") {
        conn[key] = input.value.trim();
      }
    });
    var req = {
      role: currentRole,
      brand: $("srcBrand").value,
      model: $("srcModel").value,
      connection: conn,
      label: $("srcLabel").value.trim(),
    };
    if (currentRole === ROLE_ERZEUGER) {
      var kwp = Number($("srcKwp").value);
      if ($("srcKwp").value !== "" && !isNaN(kwp)) req.capacity_kwp = kwp;
      var see = $("srcSee").value.trim();
      if (see) req.registry_unit_id = see;
    }
    return req;
  }

  function showError(msg) {
    var e = $("srcError");
    if (!msg) { e.hidden = true; e.textContent = ""; return; }
    e.hidden = false;
    e.textContent = msg;
  }

  /* ---------------- drawer ---------------- */

  // openDrawer(role): each per-category "+ hinzufügen" row opens the drawer
  // with ITS role preselected; the role picker stays available to change it.
  function openDrawer(role) {
    // Reset the form and role selection each time it opens.
    $("srcLabel").value = "";
    $("srcKwp").value = "";
    $("srcSee").value = "";
    showError(null);
    window.VP.clearVerify($("srcVerify"));
    // Lock the Netz role card when one already exists.
    $("roleNetz").disabled = hasNetz;
    $("roleNetz").classList.toggle("locked", hasNetz);
    $("netzLockedNote").hidden = !hasNetz;
    setRole(role === ROLE_NETZ || role === ROLE_CONSUMER ? role : ROLE_ERZEUGER);
    if ($("srcBrand").options.length === 0 && catalog) populateBrands();
    else onBrandChange();
    $("srcDrawerBackdrop").hidden = false;
    document.body.classList.add("drawer-open");
    $("srcLabel").focus();
  }

  function closeDrawer() {
    $("srcDrawerBackdrop").hidden = true;
    document.body.classList.remove("drawer-open");
  }

  // isSunspecBrand: only fronius_sunspec sources have a unit-id fan-out worth
  // probing (a Datamanager exposes one Modbus unit id per inverter).
  function isSunspecBrand(brandId) {
    var b = brandById(brandId);
    return !!(b && b.communication === "fronius_sunspec");
  }

  /* ---- multi-inverter auto-detection (Fronius Datamanager) ----
     After adding a fronius_sunspec Erzeuger, the same address is probed for
     FURTHER inverter unit ids (bounded scan, read-only). If more inverters
     exist than are configured, the operator is asked - never a silent
     auto-add - and on confirmation one source per further unit is created
     (name suffix "(Unit-ID n)"; the entered kWp is per-inverter and copied). */

  function configuredUnitsAt(ip) {
    var units = {};
    currentList.forEach(function (s) {
      if (s.connection && s.connection.ip === ip) {
        var u = Number(s.connection.unit_id);
        units[u > 0 ? u : 1] = true;
      }
    });
    return units;
  }

  function offerFurtherUnits(req) {
    if (req.role !== ROLE_ERZEUGER || !isSunspecBrand(req.brand)) return;
    var ip = req.connection && req.connection.ip;
    if (!ip) return;
    window.VP.probeUnits(req).then(function (found) {
      if (!found || found.length < 2) return;
      var configured = configuredUnitsAt(ip);
      var own = Number(req.connection.unit_id);
      configured[own > 0 ? own : 1] = true;
      var extras = found.filter(function (u) { return !configured[u]; });
      if (!extras.length) return;
      var kwpNote = req.capacity_kwp
        ? "\n\nDie eingetragene Leistung (" + fmtKwp(req.capacity_kwp) + " kWp) wird je Wechselrichter übernommen – bitte je Wechselrichter die eigene Leistung angeben, nicht die Gesamtleistung."
        : "";
      var msg = "An dieser Adresse wurden " + found.length + " Wechselrichter gefunden (Unit-IDs " + found.join(", ") + ").\n" +
        "Sollen die weiteren Wechselrichter (Unit-ID " + extras.join(", ") + ") jetzt als eigene Quellen angelegt werden?" + kwpNote;
      if (!window.confirm(msg)) return;
      var baseLabel = req.label || (brandById(req.brand) || {}).label || "Wechselrichter";
      extras.reduce(function (p, u) {
        return p.then(function () {
          var extraReq = JSON.parse(JSON.stringify(req));
          extraReq.connection.unit_id = u;
          extraReq.label = baseLabel + " (Unit-ID " + u + ")";
          return fetch("/api/sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(extraReq),
          }).catch(function () { /* idle-safe: skip, the operator can add manually */ });
        });
      }, Promise.resolve()).then(load);
    });
  }

  function addSource(ev) {
    ev.preventDefault();
    showError(null);
    var save = $("srcSave");
    save.disabled = true;
    var req = collect();
    fetch("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, body: body }; });
    }).then(function (res) {
      save.disabled = false;
      if (!res.ok) {
        showError((res.body && res.body.error) || "Die Energiequelle konnte nicht gespeichert werden.");
        return;
      }
      closeDrawer();
      load();
      offerFurtherUnits(req);
    }).catch(function () {
      save.disabled = false;
      showError("Netzwerkfehler. Bitte erneut versuchen.");
    });
  }

  // Nebenwirkungs-Regel (E3): der Rollen-Satz stand hier schon, die
  // ABREGELUNGS-Freigabe fehlte - eine freigegebene Fronius-Quelle zu
  // entfernen beendet still ihre Abregelung (ohne Quelle gibt es nichts mehr
  // zu begrenzen). Die Freigabe-Lage kommt frisch von /api/curtail; schlägt
  // der Abruf fehl, gilt die zuletzt bekannte Liste, und ohne das
  // Abregel-Modul bleibt es beim reinen Rollen-Satz.
  function removeSource(s) {
    var C = window.VPConsequences;
    var cur = window.VPCurtail;
    var fresh = cur && cur.refresh ? Promise.resolve(cur.refresh()).catch(function () {}) : Promise.resolve();
    fresh.then(function () {
      var units = cur && cur.units ? cur.units() : [];
      var msg = C ? C.sourceRemoval(s, units) : "Diese Energiequelle entfernen?";
      if (C ? !C.ask(msg) : !window.confirm(msg)) return;
      fetch("/api/sources/" + encodeURIComponent(s.id), { method: "DELETE" })
        .then(function () { load(); })
        .catch(function () { /* leave the list; a reload will re-sync */ });
    });
  }

  /* ---------------- load ---------------- */

  function load() {
    fetch("/api/sources").then(function (r) { return r.json(); }).then(function (data) {
      catalog = data.catalog;
      statuses = data.statuses || {};
      readings = data.readings || {};
      serverNowMs = data.server_now_ms || 0;
      if (data.balance) balance = data.balance;
      renderGroups(data.sources || []);
      // The guided commissioning flow counts sources for its step 2; tell it
      // immediately instead of making it wait for its own slow refresh.
      try {
        window.dispatchEvent(new CustomEvent("vp:sources-changed",
          { detail: { count: (data.sources || []).length } }));
      } catch (e) { /* older browsers: the periodic refresh still catches up */ }
    }).catch(function () { /* keep the page usable; the inverter form still works */ });
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!$("anlageCard")) return;
    // One "+ hinzufügen" row per category (the empty-state cards are gone);
    // each opens the drawer with its role preselected.
    $("erzAdd").addEventListener("click", function () { openDrawer(ROLE_ERZEUGER); });
    $("netzAdd").addEventListener("click", function () { openDrawer(ROLE_NETZ); });
    $("verbAdd").addEventListener("click", function () { openDrawer(ROLE_CONSUMER); });
    $("srcClose").addEventListener("click", closeDrawer);
    $("srcDrawerBackdrop").addEventListener("click", function (e) {
      if (e.target === $("srcDrawerBackdrop")) closeDrawer();
    });
    $("roleErz").addEventListener("click", function () { setRole(ROLE_ERZEUGER); });
    $("roleNetz").addEventListener("click", function () { setRole(ROLE_NETZ); });
    $("roleVerbraucher").addEventListener("click", function () { setRole(ROLE_CONSUMER); });
    $("srcBrand").addEventListener("change", onBrandChange);
    $("srcForm").addEventListener("submit", addSource);
    $("primGridToggle").addEventListener("change", saveBalance);
    $("srcTestBtn").addEventListener("click", function () {
      var payload = collect();
      window.VP.testConnection({
        payload: payload,
        panel: $("srcVerify"),
        button: $("srcTestBtn"),
        // Multi-inverter hint: a successful SunSpec test also scans the address
        // for further inverter unit ids ("An dieser Adresse wurden N
        // Wechselrichter gefunden ...").
        probePayload: isSunspecBrand(payload.brand) ? payload : null,
      });
    });
    load();
    // Keep the status pills + "Zuletzt gelesen" lines live while the page is
    // open. Same GET the initial load does; renderBalance skips an in-flight
    // toggle save, and the add drawer is untouched by a list re-render.
    setInterval(load, 10000);
  });
})();
