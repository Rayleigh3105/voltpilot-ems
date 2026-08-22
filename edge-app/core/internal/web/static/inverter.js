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
// selected state and an empty state.
//
// DIE SUCHE IST DER PRIMÄRE WEG und läuft über ALLE Marken (Captain 21.08.2026):
// wer den Namen vom Typenschild abtippt, kennt seine Marke oft nicht als
// Katalog-Eintrag - die frühere Suche filterte nur INNERHALB der schon
// gewählten Marke und war zudem gegen Schreibweisen (Bindestriche,
// Leerzeichen) blind. Das Marken-Stufenmenü darüber bleibt der Stöber-Weg;
// die Regeln der Suche liegen rein in modellsuche.js (window.VPModellSuche).
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var catalog = null;      // {schema_version, brands:[...]}
  var selection = null;    // current selection or null
  var invConnected = false; // whether the inverter has delivered telemetry (live status)
  var lastReading = null;   // the primary's own last accepted reading (per channel)
  var lastTelemetryMs = 0;  // when it was read (epoch ms)
  var stateNowMs = 0;       // device clock at fetch time (honest "vor X")

  // The last /api/calibration snapshot, ONLY so a save can name what it does to
  // an existing Steuerungs-Freigabe (E3). Best-effort: null = say nothing.
  var lastCal = null;

  // Der Marken-Picker (VpPicker der Box, vppicker.js). Er ERSETZT das frühere
  // native Auswahlfeld: gleiche Werte, gleicher `onBrandChange`-Ablauf, nur
  // eine andere Präsentation - dafür mit Tastatur, Nebenzeile und einer
  // Bedienfläche, die am Telefon ein Daumen trifft.
  var brandPicker = null;

  var chosenModel = null;  // picked model id for the current brand (or null)
  var visible = [];        // models currently rendered, in list order (keyboard nav)
  var visibleBrand = [];   // die Marke je Eintrag - bei einer marken-übergreifenden
                           // Suche gehört ein Treffer nicht zur gewählten Marke.
  var activeIdx = -1;      // keyboard cursor into `visible`

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

  /* ---------------- Verbindungsweg je Modell ----------------
     Seit der Katalog-Neustruktur hängt der Verbindungsweg am GERÄT, nicht am
     Markennamen. Die REGELN dazu wohnen rein in katalogwege.js
     (`window.VPKatalogWege`) - dieselbe Schicht, die auch der Quellen-Drawer
     benutzt; hier steht nur die Verdrahtung. */

  var W = function () { return window.VPKatalogWege; };

  // ⚠ Der Stand des Formulars: WELCHES Modell es zeigt und auf WELCHEM Weg.
  // Daran erkennt `gewaehlterWeg` einen Modellwechsel (er setzt dann auf den
  // Vorgabeweg des neuen Modells zurück), und ein Wechsel des Wegs weiß, WESSEN
  // Vorgaben er gerade verlässt.
  var aktuellerWeg = null;
  var aktuellesModell = null;

  function modelById(brand, id) {
    var found = null;
    (brand.models || []).forEach(function (m) { if (m.id === id) found = m; });
    return found;
  }

  // Der Weg, den das Formular gerade zeigt.
  function weg(brand, model) {
    var host = $("f_transport");
    return W().gewaehlterWeg(brand, model, {
      modell: aktuellesModell,
      feldWert: host && host.dataset ? host.dataset.value : null,
      gespeichert: (selection && selection.brand === brand.id && model
        && selection.model === model.id) ? selection.communication : null
    });
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) { for (var k in attrs) { if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]); } }
    if (text != null) e.textContent = text;
    return e;
  }

  // brandValue: die aktuell gewählte Marke. EINE Stelle, an der die Auswahl
  // gelesen wird - vor dem Picker war das `$("brand").value` an zehn Stellen.
  function brandValue() { return brandPicker ? brandPicker.wert() : null; }

  // renderBrands baut den Marken-Picker, sobald der Katalog geladen ist. Die
  // Nebenzeile beantwortet „ist das meins?" ohne Klick (Anbindungsart), die
  // Stichwörter machen die Suche tolerant, ohne die Zeile zu füllen.
  function renderBrands() {
    // ⚠ Eine ALIAS-Marke bleibt auflösbar (eine Bestandsanlage trägt ihre
    // Kennung), wird aber nicht mehr angeboten - sonst stünde „Fronius" zweimal
    // in der Liste.
    var optionen = W().sichtbar(catalog.brands).map(function (b) {
      return {
        value: b.id,
        label: b.label,
        sub: b.comm_label || commLabel(b.communication),
        keywords: [b.id, b.communication].join(" ")
      };
    });
    if (brandPicker) { brandPicker.setOptionen(optionen); return; }
    brandPicker = window.VPPicker.montiere($("brandPicker"), {
      id: "brand",
      optionen: optionen,
      labelledBy: "brandLabel",
      ariaLabel: "Marke",
      platzhalter: "Marke wählen …",
      suchPlatzhalter: "Marke suchen …",
      onChange: function () { onBrandChange(); }
    });
  }

  /* ---------------- model picker ---------------- */

  function optId(modelId) { return "mopt-" + modelId; }

  // Die Zerlegung und der Vergleich kommen aus der reinen Schicht - Suche im
  // Portal und Suche hier sollen dieselbe Schreibweise finden.
  function tokens(q) { return window.VPModellSuche.begriffe(q); }

  function matches(m, terms) {
    var hay = window.VPModellSuche.normalisiere(
      [m.label, m.note, m.id, m.family].filter(Boolean).join(" "));
    for (var i = 0; i < terms.length; i++) {
      if (hay.indexOf(terms[i]) === -1) return false;
    }
    return true;
  }

  // markText malt `text` mit den Fundstellen als <mark>. Die STELLEN kommen aus
  // der reinen Schicht (sie kennt die Rückbildung normalisiert -> Original),
  // hier wird nur noch gezeichnet.
  function markText(node, text, terms) {
    node.textContent = "";
    window.VPModellSuche.hervorheben(text, terms).forEach(function (teil) {
      if (!teil.text) return;
      if (teil.treffer) node.appendChild(el("mark", null, teil.text));
      else node.appendChild(document.createTextNode(teil.text));
    });
  }

  function buildOption(m, terms, brandId, zusatz) {
    var li = el("li", {
      id: optId(m.id),
      class: "picker-opt",
      role: "option",
      "aria-selected": m.id === chosenModel ? "true" : "false"
    });
    li.dataset.model = m.id;
    if (brandId) li.dataset.brand = brandId;

    var check = el("span", { class: "picker-opt-check", "aria-hidden": "true" });
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"' +
      ' stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    li.appendChild(check);

    var text = el("span", { class: "picker-opt-text" });
    var label = el("span", { class: "picker-opt-label" });
    markText(label, m.label, terms);
    text.appendChild(label);
    // Der Zusatz beantwortet „ist das meins?" ohne Klick (Leistung, Bauart,
    // Anbindung) - bei einer Suche über alle Marken ist er die einzige Stelle,
    // an der Bauart und Anbindung überhaupt stehen.
    var untertext = zusatz || m.note;
    if (untertext) {
      var note = el("span", { class: "picker-opt-note" });
      markText(note, untertext, terms);
      text.appendChild(note);
    }
    li.appendChild(text);

    li.addEventListener("click", function () {
      if (brandId && brandId !== brandValue()) waehleUeberMarken(brandId, m.id);
      else chooseModel(m.id);
    });
    return li;
  }

  // renderModels fills the picker list for the chosen brand, honoring the
  // current search filter: grouped by the brand's families (when it has more
  // than one), matches highlighted, empty state when nothing fits.
  function renderModels(brand) {
    var list = $("modelList");
    var q = $("modelSearch").value || "";
    var terms = tokens(q);

    list.innerHTML = "";
    visible = [];
    visibleBrand = [];

    if (terms.length) renderSuche(q);
    else renderMarke(brand);

    // Empty state + count
    var empty = $("modelEmpty");
    empty.hidden = visible.length > 0;
    list.hidden = visible.length === 0;
    if (!visible.length) {
      $("modelEmptyHint").textContent =
        "Keine Übereinstimmung für „" + q.trim() + "“. " +
        "Oft reicht ein Teil des Namens, z. B. nur „12K“.";
    }

    // Keyboard cursor: while filtering start on the first match, otherwise none.
    setActive(terms.length && visible.length ? 0 : -1, false);

    renderChosen(brand);
  }

  // renderSuche zeigt die Treffer über ALLE Marken, nach Marke gruppiert - der
  // Kopf ist Teil der Aussage: welche Marke man wählt, entscheidet den
  // Registersatz, und ein nackter Modellname sagt das nicht.
  function renderSuche(q) {
    var res = window.VPModellSuche.suche(catalog, q, function (id, m) {
      var b = brandById(id);
      if (!b) return "";
      // Die Anbindung DIESES Modells auf seinem Vorgabeweg - nicht die der
      // Marke: an der Marke gemessen stünde an der Eco-Zeile der Weg des GEN24.
      var t = W().weg(b, W().wege(b, m)[0]);
      return t ? t.label : (b.comm_label || commLabel(b.communication));
    });
    var terms = tokens(q);
    var list = $("modelList");
    var letzteMarke = null;

    res.treffer.forEach(function (t) {
      if (t.brand !== letzteMarke) {
        list.appendChild(el("li", { class: "picker-group", role: "presentation" }, t.brandLabel));
        letzteMarke = t.brand;
      }
      list.appendChild(buildOption(t.model, terms, t.brand, t.zusatz));
      visible.push(t.model);
      visibleBrand.push(t.brand);
    });

    // Eine Kappung wird GESAGT, nie verschwiegen.
    $("modelCount").textContent = res.zaehler || "";
    if (!res.treffer.length && res.leer) $("modelEmptyHint").textContent = res.leer;
  }

  // renderMarke ist der Stöber-Weg: die Modelle der gewählten Marke, nach ihren
  // Registersatz-Familien gruppiert (Labels aus dem Katalog).
  function renderMarke(brand) {
    var list = $("modelList");
    var models = brand.models || [];
    var families = brand.families || [];
    var famOf = {};
    models.forEach(function (m) { famOf[W().familie(brand, m) || ""] = true; });
    var grouped = Object.keys(famOf).length > 1;

    var appendModel = function (m) {
      list.appendChild(buildOption(m, []));
      visible.push(m);
      visibleBrand.push(brand.id);
    };

    if (grouped) {
      var seen = {};
      families.forEach(function (f) {
        var members = models.filter(function (m) { return W().familie(brand, m) === f.id; });
        if (!members.length) return;
        seen[f.id] = true;
        list.appendChild(el("li", { class: "picker-group", role: "presentation" }, f.label));
        members.forEach(appendModel);
      });
      // Models whose family has no catalog entry still render (trailing, ungrouped).
      models.forEach(function (m) { if (!seen[W().familie(brand, m)]) appendModel(m); });
    } else {
      models.forEach(appendModel);
    }

    $("modelCount").textContent =
      models.length + (models.length === 1 ? " Modell" : " Modelle");
  }

  // waehleUeberMarken übernimmt einen Treffer einer ANDEREN Marke: erst die
  // Marke umstellen (sie entscheidet Anbindung und Verbindungsfelder), dann das
  // Modell setzen. Ohne den ersten Schritt stünde unter dem gewählten Modell
  // das Formular der vorigen Marke.
  function waehleUeberMarken(brandId, modelId) {
    if (brandValue() !== brandId) {
      brandPicker.setWert(brandId);
      onBrandChange();
    }
    chooseModel(modelId);
    var brand = brandById(brandId);
    if (brand) { renderModels(brand); scrollChosenIntoView(); }
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
    var vorher = chosenModel;
    chosenModel = id;
    $("picker").classList.remove("invalid");
    var list = $("modelList");
    list.querySelectorAll(".picker-opt").forEach(function (li) {
      li.setAttribute("aria-selected", li.dataset.model === id ? "true" : "false");
    });
    var brand = brandById(brandValue());
    if (!brand) return;
    renderChosen(brand);
    // Der Verbindungsweg - und damit die Feldmenge - hängt am MODELL. Ohne das
    // stünde unter einem Fronius Eco das Solar-API-Formular des GEN24.
    if (vorher !== id) renderFields(brand);
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
      var idx = (activeIdx >= 0 && activeIdx < visible.length) ? activeIdx
        : (visible.length === 1 ? 0 : -1);
      if (idx >= 0) waehleUeberMarken(visibleBrand[idx], visible[idx].id);
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
    var brand = brandById(brandValue());
    if (brand) renderModels(brand);
    $("modelSearch").focus();
  }

  /* ---------------- connection fields ---------------- */

  // renderFields builds the connection inputs for the chosen brand, prefilled
  // from the current selection (or the field defaults) where available.
  //
  // Bei einem Modell mit mehreren Verbindungswegen hängen die Felder AM WEG
  // (Port 80 gegen 502, Unit-Id gegen keine) - ein Wechsel zeichnet das
  // Formular deshalb neu, statt eine Feldmenge zu zeigen, die zum gewählten Weg
  // nicht passt. `keep` trägt die schon EINGETIPPTEN Werte hinüber.
  function renderFields(brand, comm, keep) {
    var wrap = $("fields");
    var model = modelById(brand, chosenModel);
    var gewaehlt = comm || weg(brand, model);
    aktuellerWeg = gewaehlt;
    aktuellesModell = model ? model.id : null;
    wrap.innerHTML = "";
    var conn = keep || ((selection && selection.brand === brand.id && selection.connection)
      ? selection.connection : {});
    conn = Object.assign({}, conn, { transport: gewaehlt });
    // Die Anbindungs-Zeile nennt den WIRKLICH gewählten Weg, nicht den
    // Vorgabeweg der Marke - sonst stünde „Solar API" über einem
    // SunSpec-Formular.
    var aktiv = W().weg(brand, gewaehlt);
    $("comm").textContent = aktiv ? aktiv.label
      : (brand.comm_label || commLabel(brand.communication));

    W().felder(brand, model, gewaehlt).forEach(function (f) {
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
        // Ein Auswahl-Feld bekommt sein `for` vom Picker selbst (er kennt die
        // id seines Auslösers erst, wenn er ihn gebaut hat) - siehe vppicker.js.
        var lblAttrs = { id: inputId + "-lbl" };
        if (f.type !== "select") lblAttrs["for"] = inputId;
        var lblEl = el("label", lblAttrs, f.label + (f.required ? " *" : ""));
        row.appendChild(lblEl);
        var input;
        if (f.type === "select") {
          // Auch ein Verbindungsfeld mit Auswahl bekommt den Haus-Picker - ein
          // einzelnes natives Feld zwischen lauter Pickern sähe aus wie ein
          // Fremdkörper und verhielte sich am Telefon anders als alles daneben.
          // Der WERT wohnt in `dataset.value`; `collect()` liest ihn dort.
          input = el("div", { id: inputId });
          var cur = (conn[f.key] != null) ? conn[f.key] : f.default;
          montiereFeldPicker(input, f, cur, inputId, lblEl);
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

  // onTransportChange: der Kunde hat den Verbindungsweg umgestellt - das
  // Formular des NEUEN Wegs zeichnen, mit den schon EINGETIPPTEN Werten.
  function onTransportChange() {
    var brand = brandById(brandValue());
    if (!brand) return;
    var model = modelById(brand, chosenModel);
    var alt = W().vorgaben(W().felder(brand, model, aktuellerWeg));
    var eingetragen = W().ohneVorgaben(collect().connection, alt);
    renderFields(brand, eingetragen.transport, eingetragen);
  }

  // montiereFeldPicker baut den Picker eines Verbindungsfeldes vom Typ
  // „Auswahl". Ausgelagert, weil das Wechselrichter-Formular und der
  // Quellen-Drawer dieselben Katalog-Felder rendern - zwei Fassungen desselben
  // Feldes wären zwei Wahrheiten über dieselbe Angabe.
  function montiereFeldPicker(host, f, cur, inputId, lblEl) {
    var optionen = (f.options || []).map(function (o) {
      return { value: String(o.value), label: o.label };
    });
    window.VPPicker.montiere(host, {
      id: inputId + "-p",
      optionen: optionen,
      wert: cur != null ? String(cur) : (optionen.length ? optionen[0].value : null),
      labelledBy: inputId + "-lbl",
      labelEl: lblEl,
      ariaLabel: f.label,
      // Nur der Verbindungsweg zeichnet das Formular neu - er entscheidet,
      // WELCHE Felder überhaupt gelten.
      onChange: f.key === W().UEBERSTEUERUNG ? onTransportChange : null
    });
  }

  // onBrandChange re-renders the model list/comm/fields when the brand changes.
  function onBrandChange() {
    var brand = brandById(brandValue());
    if (!brand) return;
    $("brandHelp").textContent = brand.note || "";

    var models = brand.models || [];
    // Preselect the persisted choice for this brand; a single-model brand
    // auto-selects. A long list starts unselected on purpose - the customer
    // must consciously pick the exact model (it decides the register map).
    chosenModel = null;
    if (selection && selection.brand === brand.id && selection.model) {
      models.forEach(function (m) { if (m.id === selection.model) chosenModel = m.id; });
    }
    if (!chosenModel && models.length === 1) chosenModel = models[0].id;

    // Die Suchzeile bleibt IMMER sichtbar - sie ist der primäre Weg zum Modell.
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
        // ⚠ Ein Auswahl-Feld ist kein natives Element mehr: sein Wert wohnt im
        // `data-value` des Picker-Wirts (vppicker.js), nicht in `.value`.
        var raw = ftype === "select" ? (input.dataset.value || "") : input.value;
        if (raw === "") return;
        var n = Number(raw);
        conn[key] = isNaN(n) ? raw : n;
      } else {
        if (input.value.trim() !== "") conn[key] = input.value.trim();
      }
    });
    return { brand: brandValue(), model: chosenModel, connection: conn };
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
    if (selection) brandPicker.setWert(selection.brand);
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
    loadCalibration();
    $("form").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function closeForm() {
    $("form").hidden = true;
    window.VP.clearVerify($("invVerify"));
    renderSummary();
  }

  // The release state is read fresh whenever the form opens, so the save-time
  // question is about what is true NOW - never a stale claim.
  function loadCalibration() {
    fetch("/api/calibration", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) { lastCal = (j && j.calibration) || null; })
      .catch(function () { /* best-effort: without it the save just stays silent */ });
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
        // Einheitsmodell Stufe 2: gepflegt wird im Portal, hier wird gespiegelt.
        // Ein älterer Kern sendet das Feld nicht -> undefined -> bedienbar wie
        // bisher.
        window.VP.setPortalManaged($("anlageCard"), !!data.portal_managed,
          "anlagePortalNote");
        buildForm();
        renderSummary();
        loadStatus();
      })
      .catch(function () {
        $("formError").hidden = false;
        $("formError").textContent = "Konfiguration konnte nicht geladen werden. Bitte Seite neu laden.";
      });
  }

  // familyOf resolves the register-map family of a picked model from the
  // catalog - the form POSTs only {brand, model, connection}, the family is
  // what the CERTIFICATION is keyed on (agent.controlCertified).
  function familyOf(brandID, modelID) {
    var b = brandById(brandID);
    if (!b) return "";
    var out = "";
    (b.models || []).forEach(function (m) { if (m.id === modelID) out = m.family || ""; });
    return out;
  }

  // Nebenwirkungs-Regel (E3, Audit): dieses Formular ist der ZWEITE Weg an
  // genau die Werte, die die Kalibrier-Korrektur schützt (Vorzeichen,
  // Leistungsskalierung, Schreib-Funktionscode, Fernsteuerung) - nur setzt der
  // Server hier nichts zurück. Ein anderes Modell nimmt der Anlage faktisch die
  // Steuerung (die Freigabe hängt an der bisherigen Familie); geänderte
  // Steuerwerte bei gleicher Familie lassen die Freigabe bestehen, machen ihren
  // Nachweis aber veraltet. consequences.js sagt beides getrennt und ehrlich -
  // und schweigt, solange nichts freigegeben ist (der Normalfall).
  function askInverterChange(next) {
    var C = window.VPConsequences;
    if (!C || !lastCal) return true;
    var current = {
      family: selection ? selection.family : "",
      connection: (selection && selection.connection) || {},
    };
    return C.ask(C.inverterChange(lastCal, current, next));
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
    var payload = collect();
    payload.family = familyOf(payload.brand, payload.model);
    if (!askInverterChange(payload)) return;
    delete payload.family; // derived client-side only; the server owns it
    var btn = $("saveBtn");
    btn.disabled = true;
    btn.textContent = "Speichern…";
    fetch("/api/inverter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
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

  // Der Marken-Picker meldet seine Wahl über `onChange` (siehe renderBrands) -
  // ein `change`-Ereignis gibt es nicht mehr, weil es kein natives Feld mehr gibt.
  $("modelSearch").addEventListener("input", function () {
    $("modelClear").hidden = $("modelSearch").value === "";
    var brand = brandById(brandValue());
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
    var payload = collect();
    var b = brandById(payload.brand);
    window.VP.testConnection({
      payload: payload,
      panel: $("invVerify"),
      button: $("invTestBtn"),
      // Multi-inverter hint (Fronius Datamanager): a successful SunSpec test
      // also scans the address for further inverter unit ids - the further
      // devices belong on the "Meine Anlage" card as eigene Erzeuger-Quellen.
      probePayload: b && b.communication === "fronius_sunspec" ? payload : null,
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
