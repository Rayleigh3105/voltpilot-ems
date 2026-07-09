// sources.js - the "Weitere Energiequellen" surface on the inverter page:
// list / add / remove ADDITIONAL read-only measurement points. Two roles today:
// an Erzeuger (a separate PV inverter, whose generation is summed into the site
// PV) and a Netz-Zähler (a grid meter at the point of common coupling, whose
// signed power measures site grid directly). It reuses the SAME option catalog
// as the inverter form (GET /api/sources returns {sources, catalog}), keeps
// control off (a source never gets a control path), and captures a kWp + MaStR
// SEE number for an Erzeuger only (a meter has no nameplate).
// Self-contained, no framework, matches the inverter page's tokens/markup.
(function () {
  "use strict";

  var ROLE_ERZEUGER = "pv-generation";
  var ROLE_NETZ = "grid-meter";

  function $(id) { return document.getElementById(id); }

  function roleLabel(role) {
    return role === ROLE_NETZ ? "Netz-Zähler" : "Erzeuger";
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") e.className = attrs[k];
        else if (k === "html") e.innerHTML = attrs[k];
        else e.setAttribute(k, attrs[k]);
      });
    }
    if (text != null) e.appendChild(document.createTextNode(text));
    return e;
  }

  var catalog = null;

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

  /* ---------------- list ---------------- */

  function renderList(list) {
    var ul = $("srcList");
    ul.innerHTML = "";
    var has = list && list.length > 0;
    $("srcEmpty").hidden = has;
    if (!has) return;
    list.forEach(function (s) {
      var li = el("li", { class: "src-item" });
      var main = el("div", { class: "src-item-main" });
      main.appendChild(el("span", { class: "src-item-name" }, s.label || s.brand));
      var meta = [];
      if (s.capacity_kwp) meta.push(fmtKwp(s.capacity_kwp) + " kWp");
      if (s.connection && s.connection.ip) meta.push(s.connection.ip);
      meta.push(roleLabel(s.role) + " · nur Lesen");
      main.appendChild(el("span", { class: "src-item-meta" }, meta.join(" · ")));
      if (s.registry_unit_id) {
        main.appendChild(el("span", { class: "src-item-see" }, "MaStR: " + s.registry_unit_id));
      }
      li.appendChild(main);
      var del = el("button", { type: "button", class: "src-del", "aria-label": "Quelle entfernen" }, "Entfernen");
      del.addEventListener("click", function () { removeSource(s); });
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  function fmtKwp(v) {
    return (Math.round(v * 10) / 10).toString().replace(".", ",");
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

  // onRoleChange shows the nameplate fields (kWp + MaStR SEE) only for an
  // Erzeuger; a Netz meter has no nameplate, so they are hidden and left blank.
  function onRoleChange() {
    var netz = $("srcRole").value === ROLE_NETZ;
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
    var role = $("srcRole").value || ROLE_ERZEUGER;
    var req = {
      role: role,
      brand: $("srcBrand").value,
      model: $("srcModel").value,
      connection: conn,
      label: $("srcLabel").value.trim(),
    };
    // A meter carries no nameplate/MaStR number; only an Erzeuger does.
    if (role === ROLE_ERZEUGER) {
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

  function openForm() {
    $("srcForm").hidden = false;
    $("srcAddToggle").hidden = true;
    showError(null);
  }

  function closeForm() {
    $("srcForm").hidden = true;
    $("srcAddToggle").hidden = false;
    showError(null);
    $("srcLabel").value = "";
    $("srcKwp").value = "";
    $("srcSee").value = "";
    $("srcRole").value = ROLE_ERZEUGER;
    onRoleChange();
  }

  function addSource(ev) {
    ev.preventDefault();
    showError(null);
    var save = $("srcSave");
    save.disabled = true;
    fetch("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collect()),
    }).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, body: body }; });
    }).then(function (res) {
      save.disabled = false;
      if (!res.ok) {
        showError((res.body && res.body.error) || "Die Energiequelle konnte nicht gespeichert werden.");
        return;
      }
      closeForm();
      load();
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
      renderList(data.sources || []);
      if ($("srcBrand").options.length === 0 && catalog) populateBrands();
    }).catch(function () { /* keep the page usable; the inverter form still works */ });
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!$("sourcesCard")) return;
    $("srcAddToggle").addEventListener("click", openForm);
    $("srcCancel").addEventListener("click", closeForm);
    $("srcBrand").addEventListener("change", onBrandChange);
    $("srcRole").addEventListener("change", onRoleChange);
    $("srcForm").addEventListener("submit", addSource);
    onRoleChange();
    load();
  });
})();
