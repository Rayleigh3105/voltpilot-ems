// VoltPilot Edge - inverter selection screen. Catalog-driven: the brand list,
// the per-model list and the connection fields all come from GET /api/inverter,
// so new brands/models/fields need no change here. POST /api/inverter applies a
// choice; the core persists it and re-publishes it retained on the local bus.
//
// The selection unit is the INDIVIDUAL model (the captain's rule: every Deye
// model is pickable on its own, no grouping into families). The form POSTs
// {brand, model, connection}; the core resolves the model to its correct
// register map + scaling server-side.
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var catalog = null;      // {schema_version, brands:[...]}
  var selection = null;    // current selection or null

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

  // modelOptionLabel builds the visible label for one model row.
  function modelOptionLabel(m) {
    return m.note ? m.label + " – " + m.note : m.label;
  }

  // cssEscape - minimal attribute-selector escaping for model ids (which may
  // contain '.'), so querySelector('option[value="..."]') is safe.
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  // renderModels fills the model dropdown for the chosen brand, honoring the
  // current search filter. The filter narrows a long per-model list without ever
  // hiding the currently-selected model; a single model just auto-selects.
  function renderModels(brand) {
    var sel = $("model");
    var q = ($("modelSearch").value || "").trim().toLowerCase();
    var want = (selection && selection.brand === brand.id && selection.model) ? selection.model : sel.value;
    sel.innerHTML = "";
    var models = brand.models || [];
    var shown = 0;
    models.forEach(function (m) {
      var hay = (m.label + " " + (m.note || "") + " " + m.id).toLowerCase();
      if (q && hay.indexOf(q) === -1 && m.id !== want) return;
      sel.appendChild(el("option", { value: m.id }, modelOptionLabel(m)));
      shown++;
    });
    if (want && sel.querySelector('option[value="' + cssEscape(want) + '"]')) {
      sel.value = want;
    } else if (sel.options.length) {
      sel.selectedIndex = 0;
    }
    $("modelHelp").textContent = shown === 0
      ? "Kein Modell gefunden – Suche anpassen."
      : "Wählen Sie Ihr genaues Wechselrichter-Modell.";
  }

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
    $("modelSearch").value = "";
    renderModels(brand);
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
    return { brand: $("brand").value, model: $("model").value, connection: conn };
  }

  function showCurrent() {
    var box = $("current");
    if (!selection) { box.hidden = true; return; }
    box.hidden = false;
    $("currentModel").textContent = selection.label;
    var c = selection.connection || {};
    var host = c.ip ? (c.ip + (c.port ? ":" + c.port : "")) : "";
    $("currentDetail").textContent =
      commLabel(selection.communication) + (host ? " · " + host : "");
  }

  function render() {
    renderBrands();
    if (selection) { $("brand").value = selection.brand; }
    onBrandChange();
    showCurrent();
  }

  function load() {
    fetch("/api/inverter", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        catalog = data.catalog;
        selection = data.selection || null;
        render();
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
    if (!$("model").value) {
      $("formError").hidden = false;
      $("formError").textContent = "Bitte wählen Sie ein Modell.";
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
        showCurrent();
        $("formOk").hidden = false;
        window.scrollTo({ top: 0, behavior: "smooth" });
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
    var brand = brandById($("brand").value);
    if (brand) renderModels(brand);
  });
  $("form").addEventListener("submit", submit);

  load();
})();
