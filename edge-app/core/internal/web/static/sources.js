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
  // Die GERÄTETYPEN, die als Verbraucher zählen (Wallbox, schaltbarer
  // Verbraucher). Sie filtern die Markenliste je Rolle: ein Verbraucher wählt
  // einen Verbraucher-Typ, ein Erzeuger/Netz alles andere - nie gemischt.
  //
  // ⚠ Seit der Katalog-Neustruktur ist das der GERÄTETYP der Marke, nicht mehr
  // ihre Anbindung: der Verbindungsweg ist eine Eigenschaft des MODELLS (ein
  // Fronius spricht je nach Modell Solar API ODER SunSpec), an der Marke
  // gemessen fiele ein Fronius Eco hier heraus.
  var CONSUMER_TYPES = ["wallbox", "switch"];
  // Rückfall für einen älteren Katalog ohne Typ-Dimension.
  var CONSUMER_COMMS = ["goe_http_api", "shelly_http"];
  function isConsumerComm(c) { return CONSUMER_COMMS.indexOf(c) !== -1; }
  function isConsumerBrandObj(b) {
    return !!(b && (b.device_type ? CONSUMER_TYPES.indexOf(b.device_type) !== -1
      : isConsumerComm(b.communication)));
  }

  /* ---------------- Verbindungsweg je Modell ----------------
     Die REGELN wohnen rein in katalogwege.js (`window.VPKatalogWege`) - dieselbe
     Schicht, die auch das Wechselrichter-Formular benutzt. */

  var W = function () { return window.VPKatalogWege; };

  // Der Stand des Drawer-Formulars (siehe inverter.js).
  var aktuellerWeg = null;
  var aktuellesModell = null;

  function modelById(brand, id) {
    var found = null;
    ((brand && brand.models) || []).forEach(function (m) { if (m.id === id) found = m; });
    return found;
  }

  function weg(brand, model) {
    var host = $("sf_transport");
    return W().gewaehlterWeg(brand, model, {
      modell: aktuellesModell,
      feldWert: host && host.dataset ? host.dataset.value : null
    });
  }

  function $(id) { return document.getElementById(id); }
  var el = window.VP.el;

  var catalog = null;
  var statuses = {};       // source id -> "ok"|"warn"|"pending"
  var readings = {};       // source id -> {pv_kw?, power_kw?, read_at_ms} ("Zuletzt gelesen")
  var serverNowMs = 0;     // device clock at fetch time (honest "vor X" ages)
  var hasNetz = false;     // whether a Netz-Zähler already exists (role-lock)
  var currentRole = ROLE_ERZEUGER;
  var currentList = [];    // the sources as last loaded (for the unit-id offer)

  // Die zwei Picker des Drawers (VpPicker der Box, vppicker.js). Sie ERSETZEN
  // die früheren nativen Auswahlfelder: gleiche Werte in `collect()`, gleicher
  // `onBrandChange`-Ablauf - nur Tastatur, Nebenzeile und eine Bedienfläche,
  // die am Telefon ein Daumen trifft. Der MODELL-Picker trägt zusätzlich die
  // Suche: der Deye-Katalog hat 47 Modelle (pickerregeln.js SUCHE_AB).
  var brandPicker = null;
  var modelPicker = null;

  function brandValue() { return brandPicker ? brandPicker.wert() : null; }
  function modelValue() { return modelPicker ? modelPicker.wert() : null; }

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
    if (c === "shelly_http") return "Shelly HTTP-API";
    if (c === "fronius_solar_api") return "Fronius Solar-API";
    // Beide Kennungen desselben Wegs (fronius_sunspec = persistiert,
    // sunspec_tcp = marken-neutral) - siehe inverter.IsSunSpecTCP.
    if (c === "fronius_sunspec" || c === "sunspec_tcp") return "SunSpec (Modbus TCP)";
    if (c === "kaco_http") return "KACO App-Schnittstelle (HTTP)";
    if (c === "kaco_modbus") return "KACO NH3 (Registerkarte)";
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
    if (typeof lr.relay_on === "boolean") {
      // A relay consumer (shelly): the switch state is a real fact even on
      // the non-metering class, which never claims a load value.
      parts.push("Relais " + (lr.relay_on ? "Ein" : "Aus"));
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
    // ⚠ KEIN data-vp-edit: „Verbindung prüfen" ÄNDERT NICHTS und bleibt deshalb
    // auch auf einer portal-verwalteten Anlage erreichbar (Befund L6). Er testet
    // die GESPEICHERTE Verbindung dieser Quelle; der Test im Hinzufügen-Drawer
    // daneben testet die noch nicht gespeicherte Eingabe. Der Beleg landet in
    // einer eigenen Panel-Zeile direkt unter DIESER Quelle - nie in einem
    // gemeinsamen Kasten, in dem man nicht mehr sieht, wem er gehört.
    var panel = panelFor(s.id);
    var test = el("button", { type: "button", class: "icon-btn",
      title: "Verbindung prüfen", "aria-label": "Verbindung dieser Quelle prüfen",
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12a7 7 0 0 1 12-5M19 12a7 7 0 0 1-12 5M15 3v4h-4M9 21v-4h4"/></svg>' });
    test.addEventListener("click", function () { testSource(s, panel, test); });
    actions.appendChild(test);
    li.vpVerifyPanel = panel;
    var ren = el("button", { type: "button", class: "icon-btn", "data-vp-edit": "",
      title: "Umbenennen (Enter speichert, Esc bricht ab)", "aria-label": "Quelle umbenennen",
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>' });
    ren.addEventListener("click", function () { startRename(li, s); });
    actions.appendChild(ren);
    var del = el("button", { type: "button", class: "icon-btn danger", "data-vp-edit": "", title: "Entfernen", "aria-label": "Quelle entfernen",
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>' });
    del.addEventListener("click", function () { removeSource(s); });
    actions.appendChild(del);
    li.appendChild(actions);
    return li;
  }

  // testSource prüft die GESPEICHERTE Verbindung einer Quelle. Es ist dieselbe
  // Route (/api/test-connection) und derselbe Ergebnis-Block wie im Drawer -
  // nur kommt die Anfrage aus dem, was wirklich gespeichert ist, statt aus einem
  // Formular. Bewusst OHNE `control_test`: der Zeilen-Knopf ist ein reiner
  // Lese-Test, ein Schreibversuch gehört an die ausdrückliche Handlung im
  // Einrichten-Drawer.
  function testSource(s, panel, btn) {
    var payload = {
      role: s.role || "",
      brand: s.brand,
      model: s.model || "",
      family: s.family || "",
      connection: s.connection || {}
    };
    testsInFlight++;
    window.VP.testConnection({
      payload: payload,
      panel: panel,
      button: btn,
      probePayload: isSunspecSource(payload) ? payload : null,
      onDone: function () { testsInFlight = Math.max(0, testsInFlight - 1); },
    });
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

  // ⚠ Die Liste wird alle 10 s NEU GEZEICHNET (innerHTML = ""). Ein Ergebnis-
  // Kasten, der bei jedem Zeichnen neu entstünde, wäre also spätestens 10 s
  // nach dem Klick weg - mitten in einem Test, der genau so lange dauern darf.
  // Deshalb leben die Kästen JE QUELLEN-ID hier und werden beim Zeichnen nur
  // wieder eingehängt; und solange ein Test läuft, überspringt der Takt das
  // Neuzeichnen ganz (dieselbe Disziplin wie inverter.js beim offenen Formular).
  var verifyPanels = {};
  var testsInFlight = 0;

  function panelFor(id) {
    if (!verifyPanels[id]) {
      var p = el("li", { class: "verify-panel row-verify" });
      p.hidden = true;
      verifyPanels[id] = p;
    }
    return verifyPanels[id];
  }

  // appendRow hängt die Zeile UND ihren (zunächst verborgenen) Ergebnis-Kasten
  // an - beide gehören zusammen, damit ein Beleg immer unter seiner Quelle steht.
  function appendRow(ul, s) {
    var li = buildRow(s);
    ul.appendChild(li);
    if (li.vpVerifyPanel) ul.appendChild(li.vpVerifyPanel);
  }

  function renderGroups(list) {
    currentList = list || [];
    var alive = {};
    (list || []).forEach(function (s) { alive[s.id] = true; });
    Object.keys(verifyPanels).forEach(function (id) {
      if (!alive[id]) delete verifyPanels[id];
    });
    var erz = [], netz = [], verb = [];
    (list || []).forEach(function (s) {
      if (s.role === ROLE_NETZ) netz.push(s);
      else if (s.role === ROLE_CONSUMER) verb.push(s);
      else erz.push(s);
    });
    hasNetz = netz.length > 0;

    var erzUl = $("erzList"); erzUl.innerHTML = "";
    erz.forEach(function (s) { appendRow(erzUl, s); });
    $("erzNote").textContent = "· " + erz.length + (erz.length === 1 ? " zusätzliche Quelle" : " zusätzliche Quellen");

    var netzUl = $("netzList"); netzUl.innerHTML = "";
    netz.forEach(function (s) { appendRow(netzUl, s); });
    // At most one grid meter per plant: the add-row disappears once one exists.
    $("netzAdd").hidden = hasNetz;
    $("netzNote").textContent = hasNetz ? "· 1 von 1" : "· optional, max. 1";

    var verbUl = $("verbList"); verbUl.innerHTML = "";
    verb.forEach(function (s) { appendRow(verbUl, s); });
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
    // Eine ALIAS-Marke bleibt auflösbar, wird aber nicht mehr angeboten.
    return W().sichtbar(catalog.brands).filter(function (b) {
      var consumerBrand = isConsumerBrandObj(b);
      return role === ROLE_CONSUMER ? consumerBrand : !consumerBrand;
    });
  }

  function populateBrands() {
    var optionen = brandsForRole(currentRole).map(function (b) {
      return {
        value: b.id,
        label: b.label,
        sub: b.comm_label || commLabel(b.communication),
        keywords: [b.id, b.communication].join(" ")
      };
    });
    if (brandPicker) brandPicker.setOptionen(optionen);
    else brandPicker = window.VPPicker.montiere($("srcBrandPicker"), {
      id: "srcBrand",
      optionen: optionen,
      labelledBy: "srcBrandLabel",
      ariaLabel: "Marke",
      platzhalter: "Marke wählen …",
      suchPlatzhalter: "Marke suchen …",
      onChange: onBrandChange
    });
    onBrandChange();
  }

  // Die Modell-Zeilen einer Marke: gruppiert nach ihren Register-Familien (die
  // Beschriftung kommt aus dem Katalog - weiterhin vollständig datengetrieben).
  //
  // ⚠ Die Nebenzeile ist die NOTIZ des Katalogs, nicht eine daraus gebaute
  // Aufzählung: sie trägt Nennleistung, Bauart und Speicherklasse längst in
  // einem Satz („5 kW · Hybrid · 3-phasig · Niedervolt-Speicher (LV)"). Die
  // Familie steht als GRUPPEN-Überschrift darüber - sie ein zweites Mal in die
  // Zeile zu schreiben las sich als „5 kW · Hybrid, 3-phasig · 5 kW · …".
  // Was der Katalog nicht kennt, steht NICHT da (nie eine erfundene 0 kW).
  function modelOptionen(brand) {
    var famLabel = {};
    (brand.families || []).forEach(function (f) { famLabel[f.id] = f.label; });
    var mehrfachFamilie = (brand.families || []).length > 1;
    return (brand.models || []).map(function (m) {
      var neben = m.note || null;
      if (!neben && typeof m.rated_kw === "number" && m.rated_kw > 0) {
        neben = (Math.round(m.rated_kw * 10) / 10).toLocaleString("de-DE") + " kW";
      }
      // Die Familie folgt bei mehreren Wegen dem Verbindungsweg des Modells.
      var fam = W().familie(brand, m);
      return {
        value: m.id,
        label: m.label,
        sub: neben,
        group: mehrfachFamilie && famLabel[fam] ? fam : null,
        // Durchsucht, aber nicht angezeigt: die Kennung und die Familie - so
        // findet „hybrid 3" sein Gerät auch bei einer Marke ohne Gruppen.
        keywords: [m.id, fam, famLabel[fam]].filter(Boolean).join(" ")
      };
    });
  }

  function modelGruppen(brand) {
    if ((brand.families || []).length < 2) return [];
    return (brand.families || []).map(function (f) { return { key: f.id, label: f.label }; });
  }

  function onBrandChange() {
    var brand = brandById(brandValue());
    if (!brand) return;
    var optionen = modelOptionen(brand), gruppen = modelGruppen(brand);
    if (modelPicker) modelPicker.setOptionen(optionen, gruppen);
    else modelPicker = window.VPPicker.montiere($("srcModelPicker"), {
      id: "srcModel",
      optionen: optionen,
      gruppen: gruppen,
      labelledBy: "srcModelLabel",
      ariaLabel: "Modell",
      platzhalter: "Modell wählen …",
      suchPlatzhalter: "Modell suchen, z. B. SUN-30K",
      // Der Verbindungsweg - und damit die Feldmenge - hängt am MODELL.
      //
      // ⚠ Die Marke wird hier FRISCH gelesen, nie aus dem Abschluss geerbt: der
      // Picker wird EINMAL montiert und danach nur noch mit `setOptionen`
      // gefüttert, ein hier eingefangenes `brand` bliebe also für immer die
      // Marke des ersten Aufrufs - und ein Modellwechsel zeichnete danach die
      // Felder der FALSCHEN Marke (im Browser gefunden).
      onChange: function () {
        var b = brandById(brandValue());
        if (b) renderFields(b);
      }
    });
    renderFields(brand);
  }

  // onTransportChange zeichnet das Formular des NEU gewählten Verbindungswegs,
  // mit den schon EINGETIPPTEN Werten (siehe inverter.js).
  function onTransportChange() {
    var brand = brandById(brandValue());
    if (!brand) return;
    var model = modelById(brand, modelPicker ? modelPicker.wert() : null);
    var alt = W().vorgaben(W().felder(brand, model, aktuellerWeg));
    var eingetragen = W().ohneVorgaben(collectConnection(), alt);
    renderFields(brand, eingetragen.transport, eingetragen);
  }

  function renderFields(brand, comm, keep) {
    var wrap = $("srcFields");
    var model = modelById(brand, modelPicker ? modelPicker.wert() : null);
    var gewaehlt = comm || weg(brand, model);
    aktuellerWeg = gewaehlt;
    aktuellesModell = model ? model.id : null;
    wrap.innerHTML = "";
    var aktiv = W().weg(brand, gewaehlt);
    $("srcComm").textContent = aktiv ? aktiv.label
      : (brand.comm_label || commLabel(brand.communication));
    var vor = Object.assign({}, keep || {}, { transport: gewaehlt });
    W().felder(brand, model, gewaehlt).forEach(function (f) {
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
        // Ein Auswahl-Feld bekommt sein `for` vom Picker selbst (er kennt die
        // id seines Auslösers erst, wenn er ihn gebaut hat) - siehe vppicker.js.
        var lblAttrs = { id: inputId + "-lbl" };
        if (f.type !== "select") lblAttrs["for"] = inputId;
        var lblEl = el("label", lblAttrs, f.label + (f.required ? " *" : ""));
        row.appendChild(lblEl);
        var input;
        var cur = (vor[f.key] != null && vor[f.key] !== "") ? vor[f.key] : f.default;
        if (f.type === "select") {
          // Auch hier der Haus-Picker statt eines nativen Feldes - ein
          // einzelnes Browser-Element zwischen lauter Pickern verhielte sich am
          // Telefon anders als alles daneben. Der WERT wohnt in `dataset.value`.
          input = el("div", { id: inputId });
          window.VPPicker.montiere(input, {
            id: inputId + "-p",
            optionen: (f.options || []).map(function (o) {
              return { value: String(o.value), label: o.label };
            }),
            wert: cur != null ? String(cur)
              : ((f.options || []).length ? String(f.options[0].value) : null),
            labelledBy: inputId + "-lbl",
            labelEl: lblEl,
            ariaLabel: f.label,
            // Nur der Verbindungsweg zeichnet das Formular neu.
            onChange: f.key === W().UEBERSTEUERUNG ? onTransportChange : null
          });
        } else {
          input = el("input", { type: f.type === "number" ? "number" : "text", id: inputId });
          if (f.required) input.required = true;
          if (cur != null) input.value = String(cur);
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

  // collectConnection liest NUR die Verbindungsfelder - geteilt von `collect()`
  // und dem Neuzeichnen nach einem Wechsel des Verbindungswegs.
  function collectConnection() {
    var conn = {};
    $("srcFields").querySelectorAll("[data-key]").forEach(function (input) {
      var key = input.dataset.key, ftype = input.dataset.ftype;
      if (ftype === "checkbox") {
        conn[key] = input.checked;
      } else if (ftype === "number" || ftype === "select") {
        // ⚠ Ein Auswahl-Feld ist kein natives Element mehr: sein Wert wohnt im
        // `data-value` des Picker-Wirts (vppicker.js), nicht in `.value`.
        var raw = ftype === "select" ? (input.dataset.value || "") : input.value;
        if (raw === "") return;
        var n = Number(raw);
        conn[key] = isNaN(n) ? raw : n;
      } else if (input.value.trim() !== "") {
        conn[key] = input.value.trim();
      }
    });
    return conn;
  }

  function collect() {
    var conn = collectConnection();
    var req = {
      role: currentRole,
      brand: brandValue(),
      model: modelValue(),
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
    if (!brandPicker && catalog) populateBrands();
    else onBrandChange();
    $("srcDrawerBackdrop").hidden = false;
    document.body.classList.add("drawer-open");
    $("srcLabel").focus();
  }

  function closeDrawer() {
    $("srcDrawerBackdrop").hidden = true;
    document.body.classList.remove("drawer-open");
  }

  // isSunspecSource: nur eine über SunSpec Modbus gelesene Fronius-Quelle hat
  // eine Unit-Id-Fächerung, die sich zu suchen lohnt (ein Datamanager stellt je
  // Wechselrichter eine Modbus-Unit-Id bereit).
  //
  // ⚠ Sie fragt den WEG DIESER QUELLE, nicht die Marke: seit der
  // Katalog-Neustruktur ist Fronius EINE Marke, deren Vorgabeweg die Solar API
  // ist - an der Marke gemessen verlöre ein Fronius Eco seine Geschwister-Suche.
  function isSunspecSource(payload) {
    var b = brandById(payload && payload.brand);
    if (!b) return false;
    var isSs = function (c) { return c === "fronius_sunspec" || c === "sunspec_tcp"; };
    if (payload.connection && payload.connection.transport) {
      return isSs(payload.connection.transport);
    }
    return isSs(W().wege(b, modelById(b, payload.model))[0]);
  }

  // isConsumerBrand: the consumer drivers (go-e wallbox, Shelly relay) get the
  // D11 control short-test on their "Verbindung testen" - each proves its
  // write path without disturbing a running charge/heat cycle (go-e: a
  // value-identical amp re-write; shelly: an off-write only while the relay
  // is already off).
  function isConsumerBrand(brandId) {
    return isConsumerBrandObj(brandById(brandId));
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
    if (req.role !== ROLE_ERZEUGER || !isSunspecSource(req)) return;
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
      // ⚠ Die zwei Picker des Drawers entstehen SCHON HIER, nicht erst beim
      // Öffnen. Erst das Montieren verknüpft die Beschriftung mit dem Auslöser
      // (vppicker.js setzt `label.htmlFor`) - bis dahin steht über dem Feld eine
      // Beschriftung, die auf nichts zeigt und beim Klick nichts fokussiert.
      // Das frühere native Feld stand von Anfang an da; das hier ist der
      // Ersatz für diese Selbstverständlichkeit.
      if (!brandPicker) populateBrands();
      // NACH renderGroups: die Zeilen-Knöpfe (Umbenennen/Entfernen) entstehen
      // dort erst, also muss die Sperre danach über die frische Karte laufen.
      window.VP.setPortalManaged($("anlageCard"), !!data.portal_managed,
        "anlagePortalNote");
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
    $("srcForm").addEventListener("submit", addSource);
    $("primGridToggle").addEventListener("change", saveBalance);
    $("srcTestBtn").addEventListener("click", function () {
      var payload = collect();
      // D11: a go-e wallbox test ALSO asks for the non-disruptive control
      // short-test (the core re-writes the charger's current amp value and
      // reads it back - proves the write path without touching a charge).
      if (isConsumerBrand(payload.brand)) payload.control_test = true;
      window.VP.testConnection({
        payload: payload,
        panel: $("srcVerify"),
        button: $("srcTestBtn"),
        // Multi-inverter hint: a successful SunSpec test also scans the address
        // for further inverter unit ids ("An dieser Adresse wurden N
        // Wechselrichter gefunden ...").
        probePayload: isSunspecSource(payload) ? payload : null,
      });
    });
    load();
    // Keep the status pills + "Zuletzt gelesen" lines live while the page is
    // open. Same GET the initial load does; renderBalance skips an in-flight
    // toggle save, and the add drawer is untouched by a list re-render.
    setInterval(function () { if (testsInFlight === 0) load(); }, 10000);
  });
})();
