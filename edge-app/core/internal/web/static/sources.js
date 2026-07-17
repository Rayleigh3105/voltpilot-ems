// sources.js - the "Erzeuger" + "Netz-Zähler" groups of the "Meine Anlage" card:
// list (grouped by role, with a live status dot/pill per source) + add (in a
// focused drawer) + remove ADDITIONAL read-only measurement points. Two roles:
// an Erzeuger (a separate PV inverter, summed into the site PV) and a Netz-Zähler
// (a grid meter at the point of common coupling, 0-1 per site). It reuses the
// SAME option catalog as the inverter form (GET /api/sources returns {sources,
// statuses, catalog}), keeps control off (a source never gets a control path),
// and captures a kWp + MaStR SEE number for an Erzeuger only.
// Self-contained, no framework; shares VP (verify.js) with the inverter form.
(function () {
  "use strict";

  var ROLE_ERZEUGER = "pv-generation";
  var ROLE_NETZ = "grid-meter";

  function $(id) { return document.getElementById(id); }
  var el = window.VP.el;

  function roleLabel(role) {
    return role === ROLE_NETZ ? "Netz-Zähler" : "Erzeuger";
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
    return c === "solarman_v5" ? "Solarman-V5 (WiFi-Datenlogger)" : "Modbus TCP";
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
    // erste Daten"); a stale one keeps showing with its honest age.
    var line = window.VP.lastReadLine(readingParts(readings[s.id]), readAtMs(readings[s.id]), serverNowMs);
    if (line) main.appendChild(el("span", { class: "row-meta row-read" }, line));
    li.appendChild(main);

    var badge = el("span", { class: "row-badge" });
    var pill = el("span", { class: "pill " + st.pill });
    pill.appendChild(el("span", { class: "dot" }));
    pill.appendChild(document.createTextNode(st.label));
    badge.appendChild(pill);
    li.appendChild(badge);

    var actions = el("span", { class: "row-actions" });
    var del = el("button", { type: "button", class: "icon-btn danger", title: "Entfernen", "aria-label": "Quelle entfernen",
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>' });
    del.addEventListener("click", function () { removeSource(s); });
    actions.appendChild(del);
    li.appendChild(actions);
    return li;
  }

  function renderGroups(list) {
    currentList = list || [];
    var erz = [], netz = [];
    (list || []).forEach(function (s) {
      if (s.role === ROLE_NETZ) netz.push(s); else erz.push(s);
    });
    hasNetz = netz.length > 0;

    var erzUl = $("erzList"); erzUl.innerHTML = "";
    erz.forEach(function (s) { erzUl.appendChild(buildRow(s)); });
    $("erzEmpty").hidden = erz.length > 0;
    $("erzNote").textContent = "· " + erz.length + (erz.length === 1 ? " zusätzliche Quelle" : " zusätzliche Quellen");

    var netzUl = $("netzList"); netzUl.innerHTML = "";
    netz.forEach(function (s) { netzUl.appendChild(buildRow(s)); });
    $("netzEmpty").hidden = netz.length > 0;
    $("netzNote").textContent = hasNetz ? "· 1 von 1" : "· optional, max. 1";
    renderBalance();
  }

  /* ---- "Primär misst den gesamten Netzübergang" toggle (Netz group) ----
     The meter-less alternative: when the primary inverter's CT sits at the
     point of common coupling (and therefore already measures additional
     Erzeugers' feed-in), the core derives the true house consumption from the
     power balance using the primary's own grid reading. Persisted on the edge
     (POST /api/balance); a configured Netz-Zähler always takes precedence. */

  var BALANCE_HELP =
    "Nur aktivieren, wenn der Messwandler (CT) des Wechselrichters am Hausanschluss sitzt und dadurch auch die " +
    "Einspeisung zusätzlicher Erzeuger erfasst – dann wird der echte Hausverbrauch ohne eigenen Netz-Zähler aus der " +
    "Leistungsbilanz berechnet. Bitte am Gerät prüfen (Vorzeichen/Einbauort); ein eigener Netz-Zähler ist die " +
    "sichere Alternative und hat immer Vorrang.";

  var balance = { primary_grid_is_site_total: false };

  function renderBalance() {
    // A save is in flight (toggle disabled): don't let a periodic refresh
    // visually flip the checkbox back; the save response re-renders.
    if ($("primGridToggle").disabled) return;
    $("primGridToggle").checked = !!balance.primary_grid_is_site_total;
    $("primGridHelp").textContent = hasNetz
      ? "Ihr Netz-Zähler hat Vorrang – diese Einstellung wirkt nur, solange kein aktueller Zähler-Messwert vorliegt. " + BALANCE_HELP
      : BALANCE_HELP;
  }

  function saveBalance() {
    var toggle = $("primGridToggle");
    var next = { primary_grid_is_site_total: toggle.checked };
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

  function populateBrands() {
    var sel = $("srcBrand");
    sel.innerHTML = "";
    catalog.brands.forEach(function (b) {
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
  // only for an Erzeuger; a Netz meter has no nameplate. The Netz card is locked
  // (and never selectable) once one already exists.
  function setRole(role) {
    if (role === ROLE_NETZ && hasNetz) return;
    currentRole = role;
    $("roleErz").classList.toggle("sel", role === ROLE_ERZEUGER);
    $("roleNetz").classList.toggle("sel", role === ROLE_NETZ);
    var netz = role === ROLE_NETZ;
    $("srcKwpField").hidden = netz;
    $("srcSeeField").hidden = netz;
    $("srcRoleHelp").textContent = netz
      ? "Ein eigener Zähler am Netzübergang. Sein gemessener Bezug/Einspeisung ersetzt den Wert des Speicher-Wechselrichters."
      : "Eine zusätzliche PV-Anlage, deren Erzeugung mitgezählt wird.";
    $("srcLabel").placeholder = netz ? "z. B. Netz-Zähler Hausanschluss" : "z. B. PV Dach Süd";
  }

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

  function openDrawer() {
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
    setRole(ROLE_ERZEUGER);
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

  function removeSource(s) {
    var msg = s.role === ROLE_NETZ
      ? "Diesen Netz-Zähler entfernen? Der Netzbezug wird dann wieder vom Speicher-Wechselrichter gemessen."
      : "Diese Energiequelle entfernen? Ihre Erzeugung fließt dann nicht mehr in die Gesamt-PV ein.";
    if (!window.confirm(msg)) return;
    fetch("/api/sources/" + encodeURIComponent(s.id), { method: "DELETE" })
      .then(function () { load(); })
      .catch(function () { /* leave the list; a reload will re-sync */ });
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
    }).catch(function () { /* keep the page usable; the inverter form still works */ });
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!$("anlageCard")) return;
    $("srcAddToggle").addEventListener("click", openDrawer);
    $("srcClose").addEventListener("click", closeDrawer);
    $("srcDrawerBackdrop").addEventListener("click", function (e) {
      if (e.target === $("srcDrawerBackdrop")) closeDrawer();
    });
    $("roleErz").addEventListener("click", function () { setRole(ROLE_ERZEUGER); });
    $("roleNetz").addEventListener("click", function () { setRole(ROLE_NETZ); });
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
