// VoltPilot Edge - inverter selection screen. Catalog-driven: the brand list,
// the per-model list and the connection fields all come from GET /api/inverter,
// so new brands/models/fields need no change here. POST /api/inverter applies a
// choice; the core persists it and re-publishes it retained on the local bus.
//
// The selection unit is the INDIVIDUAL model (the captain's rule: every Deye
// model is pickable on its own, no grouping into families). The form POSTs
// {brand, model, connection}; the core resolves the model to its correct
// register map + scaling server-side.
//
// The model picker is a custom searchable listbox (combobox + listbox ARIA
// pattern): type-to-filter with match highlighting, arrow-key navigation with
// Enter/Escape, grouped by the brand's register-map families (labels straight
// from the catalog's brand.families - still fully data-driven), an explicit
// selected state and an empty state. A brand with a handful of models skips
// the search row entirely.
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var catalog = null;      // {schema_version, brands:[...]}
  var selection = null;    // current selection or null
  var invConnected = false; // whether the inverter has delivered telemetry (live status)
  var lastReading = null;   // the primary's own last accepted reading (per channel)
  var lastTelemetryMs = 0;  // when it was read (epoch ms)
  var stateNowMs = 0;       // device clock at fetch time (honest "vor X")

  var chosenModel = null;  // picked model id for the current brand (or null)
  var visible = [];        // models currently rendered, in list order (keyboard nav)
  var activeIdx = -1;      // keyboard cursor into `visible`

  // Brands with at most this many models get no search row - a filter over a
  // three-entry list is noise, not help.
  var SEARCH_THRESHOLD = 6;

  function brandById(id) {
    if (!catalog) return null;
    for (var i = 0; i < catalog.brands.length; i++) {
      if (catalog.brands[i].id === id) return catalog.brands[i];
    }
    return null;
  }

  function commLabel(id) {
    return id === "solarman_v5" ? "Solarman-V5 (WiFi-Datenlogger)"
      : id === "modbus_tcp" ? "Modbus TCP"
      : id;
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) { for (var k in attrs) { if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]); } }
    if (text != null) e.textContent = text;
    return e;
  }

  // renderBrands fills the brand dropdown once the catalog is loaded.
  function renderBrands() {
    var sel = $("brand");
    sel.innerHTML = "";
    catalog.brands.forEach(function (b) {
      sel.appendChild(el("option", { value: b.id }, b.label));
    });
  }

  /* ---------------- model picker ---------------- */

  function optId(modelId) { return "mopt-" + modelId; }

  // tokens splits the search query into lowercase terms; a model matches when
  // EVERY term occurs somewhere in its label, note or id.
  function tokens(q) {
    return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  function matches(m, terms) {
    var hay = (m.label + " " + (m.note || "") + " " + m.id).toLowerCase();
    for (var i = 0; i < terms.length; i++) {
      if (hay.indexOf(terms[i]) === -1) return false;
    }
    return true;
  }

  // markText renders `text` with every occurrence of every term wrapped in
  // <mark>. Ranges are collected first and merged so overlapping terms never
  // produce nested or broken tags.
  function markText(node, text, terms) {
    var ranges = [];
    var low = text.toLowerCase();
    terms.forEach(function (t) {
      var from = 0, at;
      while ((at = low.indexOf(t, from)) !== -1) {
        ranges.push([at, at + t.length]);
        from = at + t.length;
      }
    });
    if (!ranges.length) { node.textContent = text; return; }
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [ranges[0]];
    for (var i = 1; i < ranges.length; i++) {
      var last = merged[merged.length - 1];
      if (ranges[i][0] <= last[1]) { last[1] = Math.max(last[1], ranges[i][1]); }
      else { merged.push(ranges[i]); }
    }
    var pos = 0;
    merged.forEach(function (r) {
      if (r[0] > pos) node.appendChild(document.createTextNode(text.slice(pos, r[0])));
      node.appendChild(el("mark", null, text.slice(r[0], r[1])));
      pos = r[1];
    });
    if (pos < text.length) node.appendChild(document.createTextNode(text.slice(pos)));
  }

  function buildOption(m, terms) {
    var li = el("li", {
      id: optId(m.id),
      class: "picker-opt",
      role: "option",
      "aria-selected": m.id === chosenModel ? "true" : "false"
    });
    li.dataset.model = m.id;

    var check = el("span", { class: "picker-opt-check", "aria-hidden": "true" });
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"' +
      ' stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    li.appendChild(check);

    var text = el("span", { class: "picker-opt-text" });
    var label = el("span", { class: "picker-opt-label" });
    markText(label, m.label, terms);
    text.appendChild(label);
    if (m.note) {
      var note = el("span", { class: "picker-opt-note" });
      markText(note, m.note, terms);
      text.appendChild(note);
    }
    li.appendChild(text);

    li.addEventListener("click", function () { chooseModel(m.id); });
    return li;
  }

  // renderModels fills the picker list for the chosen brand, honoring the
  // current search filter: grouped by the brand's families (when it has more
  // than one), matches highlighted, empty state when nothing fits.
  function renderModels(brand) {
    var list = $("modelList");
    var q = $("modelSearch").value || "";
    var terms = tokens(q);
    var models = brand.models || [];

    list.innerHTML = "";
    visible = [];

    // Family id -> label, in catalog order; used as group headers only when
    // the brand's models actually span more than one family.
    var families = brand.families || [];
    var famOf = {};
    models.forEach(function (m) { famOf[m.family || ""] = true; });
    var grouped = Object.keys(famOf).length > 1;

    var appendModel = function (m) {
      list.appendChild(buildOption(m, terms));
      visible.push(m);
    };

    if (grouped) {
      var seen = {};
      families.forEach(function (f) {
        var members = models.filter(function (m) { return m.family === f.id && matches(m, terms); });
        if (!members.length) return;
        seen[f.id] = true;
        list.appendChild(el("li", { class: "picker-group", role: "presentation" }, f.label));
        members.forEach(appendModel);
      });
      // Models whose family has no catalog entry still render (trailing, ungrouped).
      models.forEach(function (m) {
        if (!seen[m.family] && matches(m, terms)) appendModel(m);
      });
    } else {
      models.filter(function (m) { return matches(m, terms); }).forEach(appendModel);
    }

    // Empty state + count
    var empty = $("modelEmpty");
    empty.hidden = visible.length > 0;
    list.hidden = visible.length === 0;
    if (!visible.length) {
      $("modelEmptyHint").textContent =
        "Keine Übereinstimmung für „" + q.trim() + "“. " +
        "Oft reicht ein Teil des Namens, z. B. nur „12K“.";
    }
    $("modelCount").textContent = terms.length
      ? visible.length + " von " + models.length + (models.length === 1 ? " Modell" : " Modellen")
      : models.length + (models.length === 1 ? " Modell" : " Modelle");

    // Keyboard cursor: while filtering start on the first match, otherwise none.
    setActive(terms.length && visible.length ? 0 : -1, false);

    renderChosen(brand);
  }

  // renderChosen paints the persistent "which model is picked" summary in the
  // picker footer - visible even when the picked row is filtered out of view.
  function renderChosen(brand) {
    var box = $("modelChosen");
    var m = null;
    (brand.models || []).forEach(function (x) { if (x.id === chosenModel) m = x; });
    if (!m) { box.hidden = true; return; }
    box.hidden = false;
    $("modelChosenLabel").textContent = m.label;
  }

  function setActive(idx, scroll) {
    var list = $("modelList");
    var prev = list.querySelector(".picker-opt.active");
    if (prev) prev.classList.remove("active");
    activeIdx = idx;
    var input = $("modelSearch");
    if (idx < 0 || idx >= visible.length) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    var li = document.getElementById(optId(visible[idx].id));
    if (!li) return;
    li.classList.add("active");
    input.setAttribute("aria-activedescendant", li.id);
    if (scroll) li.scrollIntoView({ block: "nearest" });
  }

  function chooseModel(id) {
    chosenModel = id;
    $("picker").classList.remove("invalid");
    var list = $("modelList");
    list.querySelectorAll(".picker-opt").forEach(function (li) {
      li.setAttribute("aria-selected", li.dataset.model === id ? "true" : "false");
    });
    var brand = brandById($("brand").value);
    if (brand) renderChosen(brand);
  }

  // scrollChosenIntoView centers the picked row after a (re)render, so an
  // existing configuration is immediately visible when the page opens. Only
  // the picker panel scrolls - scrollIntoView would also scroll the PAGE and
  // dump a fresh visitor mid-form.
  function scrollChosenIntoView() {
    if (!chosenModel) return;
    var li = document.getElementById(optId(chosenModel));
    var panel = document.querySelector(".picker-panel");
    if (!li || !panel) return;
    panel.scrollTop += (li.getBoundingClientRect().top - panel.getBoundingClientRect().top)
      - (panel.clientHeight - li.offsetHeight) / 2;
  }

  function onSearchKeydown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (visible.length) setActive(Math.min(activeIdx + 1, visible.length - 1), true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (visible.length) setActive(Math.max(activeIdx - 1, 0), true);
    } else if (e.key === "Enter") {
      // Enter picks, never submits the form from inside the search box.
      e.preventDefault();
      if (activeIdx >= 0 && activeIdx < visible.length) chooseModel(visible[activeIdx].id);
      else if (visible.length === 1) chooseModel(visible[0].id);
    } else if (e.key === "Escape") {
      var input = $("modelSearch");
      if (input.value) {
        e.preventDefault();
        clearSearch();
      }
    }
  }

  function clearSearch() {
    $("modelSearch").value = "";
    $("modelClear").hidden = true;
    var brand = brandById($("brand").value);
    if (brand) renderModels(brand);
    $("modelSearch").focus();
  }

  /* ---------------- connection fields ---------------- */

  // renderFields builds the connection inputs for the chosen brand, prefilled
  // from the current selection (or the field defaults) where available.
  function renderFields(brand) {
    var wrap = $("fields");
    wrap.innerHTML = "";
    var conn = (selection && selection.brand === brand.id && selection.connection) ? selection.connection : {};

    brand.fields.forEach(function (f) {
      var row = el("div", { class: "field" });
      var inputId = "f_" + f.key;

      if (f.type === "checkbox") {
        var cbWrap = el("label", { class: "checkbox-row", for: inputId });
        var cb = el("input", { type: "checkbox", id: inputId });
        cb.dataset.key = f.key;
        cb.dataset.ftype = "checkbox";
        if (conn[f.key] === true) cb.checked = true;
        cbWrap.appendChild(cb);
        cbWrap.appendChild(el("span", null, f.label));
        row.appendChild(cbWrap);
      } else {
        row.appendChild(el("label", { for: inputId }, f.label + (f.required ? " *" : "")));
        var input;
        if (f.type === "select") {
          input = el("select", { id: inputId });
          (f.options || []).forEach(function (o) {
            var opt = el("option", { value: String(o.value) }, o.label);
            input.appendChild(opt);
          });
          var cur = (conn[f.key] != null) ? conn[f.key] : f.default;
          if (cur != null) input.value = String(cur);
        } else {
          input = el("input", { type: f.type === "number" ? "number" : "text", id: inputId });
          if (f.required) input.required = true;
          var val = (conn[f.key] != null && conn[f.key] !== 0 && conn[f.key] !== "") ? conn[f.key]
            : (f.default != null ? f.default : "");
          input.value = val === "" ? "" : String(val);
        }
        input.dataset.key = f.key;
        input.dataset.ftype = f.type;
        row.appendChild(input);
      }
      if (f.help) row.appendChild(el("p", { class: "field-help" }, f.help));
      wrap.appendChild(row);
    });
  }

  // onBrandChange re-renders the model list/comm/fields when the brand changes.
  function onBrandChange() {
    var brand = brandById($("brand").value);
    if (!brand) return;
    $("brandHelp").textContent = brand.note || "";
    $("comm").textContent = brand.comm_label || commLabel(brand.communication);

    var models = brand.models || [];
    // Preselect the persisted choice for this brand; a single-model brand
    // auto-selects. A long list starts unselected on purpose - the customer
    // must consciously pick the exact model (it decides the register map).
    chosenModel = null;
    if (selection && selection.brand === brand.id && selection.model) {
      models.forEach(function (m) { if (m.id === selection.model) chosenModel = m.id; });
    }
    if (!chosenModel && models.length === 1) chosenModel = models[0].id;

    $("pickerSearch").hidden = models.length <= SEARCH_THRESHOLD;
    $("modelSearch").value = "";
    $("modelClear").hidden = true;
    $("picker").classList.remove("invalid");
    renderModels(brand);
    scrollChosenIntoView();
    renderFields(brand);
  }

  // collect builds the SelectionRequest from the form inputs.
  function collect() {
    var conn = {};
    var inputs = $("fields").querySelectorAll("[data-key]");
    inputs.forEach(function (input) {
      var key = input.dataset.key, ftype = input.dataset.ftype;
      if (ftype === "checkbox") {
        conn[key] = input.checked;
      } else if (ftype === "number" || ftype === "select") {
        var raw = input.value;
        if (raw === "") return;
        var n = Number(raw);
        conn[key] = isNaN(n) ? raw : n;
      } else {
        if (input.value.trim() !== "") conn[key] = input.value.trim();
      }
    });
    return { brand: $("brand").value, model: chosenModel, connection: conn };
  }

  // renderSummary paints the "Wechselrichter / Speicher" group row (or the empty
  // state when nothing is configured), with a live status dot + pill. The
  // permanently-open form is gone: the form only shows on "Bearbeiten" / "Jetzt
  // einrichten".
  function renderSummary() {
    var rows = $("invRows"), empty = $("invEmpty");
    if (!selection) {
      rows.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    rows.hidden = false;
    $("invName").textContent = selection.label || selection.brand;
    var c = selection.connection || {};
    var host = c.ip ? (c.ip + (c.port ? ":" + c.port : "")) : "";
    $("invMeta").textContent = commLabel(selection.communication) + (host ? " · " + host : "");
    var st = window.VP.statusPill(invConnected ? "ok" : "pending");
    $("invDot").className = "row-dot " + st.dot;
    var badge = $("invBadge");
    badge.innerHTML = "";
    var pill = window.VP.el("span", { class: "pill " + st.pill });
    pill.appendChild(window.VP.el("span", { class: "dot" }));
    pill.appendChild(document.createTextNode(st.label));
    badge.appendChild(pill);
    renderLastRead();
  }

  // The primary's channels for the "Zuletzt gelesen" line, in display order.
  // Only channels the device actually delivered render (last_reading carries
  // per-channel presence - a batteryless inverter never shows "Speicher 0 %").
  var READ_FIELDS = [
    { key: "pv_power_kw", label: "PV", unit: "kW" },
    { key: "load_kw", label: "Last", unit: "kW" },
    { key: "power_kw", grid: true },
    { key: "soc_pct", label: "Speicher", unit: "%" },
  ];

  function primaryReadingParts() {
    var parts = [];
    if (!lastReading) return parts;
    READ_FIELDS.forEach(function (f) {
      var v = lastReading[f.key];
      if (typeof v !== "number" || !isFinite(v)) return;
      parts.push(f.grid ? window.VP.gridPart(v) : f.label + " " + window.VP.fmtVal(v, f.unit));
    });
    return parts;
  }

  // renderLastRead paints the "Zuletzt gelesen" line under the summary meta: the
  // last accepted values + when they were read. No reading yet -> no line (the
  // pill already says "Wartet auf erste Daten"); never a fabricated value.
  function renderLastRead() {
    var read = $("invRead");
    var line = window.VP.lastReadLine(primaryReadingParts(), lastTelemetryMs, stateNowMs);
    read.hidden = !line;
    read.textContent = line;
  }

  // buildForm fills the form inputs (brand list, model picker, connection fields)
  // for the current selection/catalog. It does NOT show the form.
  function buildForm() {
    renderBrands();
    if (selection) { $("brand").value = selection.brand; }
    onBrandChange();
  }

  // openForm reveals the inverter form (edit or first setup); closeForm hides it
  // back to the summary/empty row.
  function openForm() {
    buildForm();
    $("form").hidden = false;
    $("invRows").hidden = true;
    $("invEmpty").hidden = true;
    $("invCancelBtn").hidden = false;
    $("formOk").hidden = true;
    $("formError").hidden = true;
    window.VP.clearVerify($("invVerify"));
    $("form").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function closeForm() {
    $("form").hidden = true;
    window.VP.clearVerify($("invVerify"));
    renderSummary();
  }

  function loadStatus() {
    fetch("/api/state", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        invConnected = !!(s && s.inverter_connected);
        lastReading = (s && s.last_reading) || null;
        lastTelemetryMs = s && s.last_telemetry ? Date.parse(s.last_telemetry) || 0 : 0;
        stateNowMs = (s && s.server_now_ms) || 0;
        renderSummary();
      })
      .catch(function () { /* status is best-effort; the summary still renders */ });
  }

  function load() {
    fetch("/api/inverter", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        catalog = data.catalog;
        selection = data.selection || null;
        buildForm();
        renderSummary();
        loadStatus();
      })
      .catch(function () {
        $("formError").hidden = false;
        $("formError").textContent = "Konfiguration konnte nicht geladen werden. Bitte Seite neu laden.";
      });
  }

  function submit(e) {
    e.preventDefault();
    $("formError").hidden = true;
    $("formOk").hidden = true;
    if (!chosenModel) {
      $("formError").hidden = false;
      $("formError").textContent = "Bitte wählen Sie Ihr Modell aus der Liste.";
      $("picker").classList.add("invalid");
      $("picker").scrollIntoView({ block: "center", behavior: "smooth" });
      $("modelSearch").focus({ preventScroll: true });
      return;
    }
    var btn = $("saveBtn");
    btn.disabled = true;
    btn.textContent = "Speichern…";
    fetch("/api/inverter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collect())
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) {
          $("formError").hidden = false;
          $("formError").textContent = (res.body && res.body.error) || "Speichern fehlgeschlagen.";
          return;
        }
        selection = res.body.selection;
        // Collapse the form back to the summary row (the row is the confirmation);
        // refresh the live status shortly after so the pill can flip to "Liefert
        // Daten" once telemetry arrives.
        closeForm();
        loadStatus();
        $("invGroup").scrollIntoView({ block: "nearest", behavior: "smooth" });
      })
      .catch(function () {
        $("formError").hidden = false;
        $("formError").textContent = "Verbindung zum Gerät fehlgeschlagen. Bitte erneut versuchen.";
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = "Speichern";
      });
  }

  $("brand").addEventListener("change", function () { onBrandChange(); });
  $("modelSearch").addEventListener("input", function () {
    $("modelClear").hidden = $("modelSearch").value === "";
    var brand = brandById($("brand").value);
    if (brand) renderModels(brand);
  });
  $("modelSearch").addEventListener("keydown", onSearchKeydown);
  $("modelClear").addEventListener("click", clearSearch);
  $("modelReset").addEventListener("click", clearSearch);
  $("form").addEventListener("submit", submit);

  // Edit / first-setup / cancel toggle the inverter form.
  $("invEditBtn").addEventListener("click", openForm);
  $("invSetupBtn").addEventListener("click", openForm);
  $("invCancelBtn").addEventListener("click", closeForm);

  // "Verbindung testen" - a confidence check on the current (unsaved) form; it
  // never blocks Speichern.
  $("invTestBtn").addEventListener("click", function () {
    if (!chosenModel) {
      $("formError").hidden = false;
      $("formError").textContent = "Bitte wählen Sie zuerst Ihr Modell aus der Liste.";
      $("picker").classList.add("invalid");
      return;
    }
    window.VP.testConnection({
      payload: collect(),
      panel: $("invVerify"),
      button: $("invTestBtn"),
    });
  });

  load();
  // Keep the summary's status pill + "Zuletzt gelesen" line live while the
  // page is open. Skipped while the edit form is open - renderSummary would
  // unhide the summary row underneath it.
  setInterval(function () {
    if ($("form").hidden) loadStatus();
  }, 10000);
})();
