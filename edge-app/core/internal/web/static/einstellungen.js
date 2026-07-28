// VoltPilot Edge - Ausreißer-Filter settings. Data-driven from GET /api/despike:
// the channel list (labels/units/help), the preset names and the current
// per-channel numbers all come from the backend, so new channels/presets need
// no change here. A preset click POSTs {preset}; the expert form POSTs a custom
// per-channel set. Everything applies live (the core persists + reconfigures the
// running filter). Drop counters are polled so the operator sees the filter work.
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var status = null; // {settings, counters, channels, presets}
  var dirty = false; // expert inputs edited but not yet saved

  var PRESET_LABEL = {
    aus: "Aus", locker: "Locker", normal: "Normal", streng: "Streng",
    benutzerdefiniert: "Benutzerdefiniert"
  };
  var PRESET_NOTE = {
    aus: "Filter ausgeschaltet – alle Messwerte werden unverändert übernommen.",
    locker: "Nur grobe Ausreißer werden gefiltert – lässt viel durch.",
    normal: "Empfohlen. Filtert deutliche Ausreißer und lässt normale schnelle Schwankungen unangetastet.",
    streng: "Filtert auch kleinere Sprünge – bei ruhigen Anlagen sinnvoll.",
    benutzerdefiniert: "Eigene Werte aktiv (siehe Expertenwerte)."
  };

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) { for (var k in attrs) { if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]); } }
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtInt(n) {
    try { return new Intl.NumberFormat("de-DE").format(n); } catch (e) { return String(n); }
  }

  /* ---------------- preset segmented control ---------------- */

  function renderPresetSeg() {
    var seg = $("presetSeg");
    seg.innerHTML = "";
    (status.presets || []).forEach(function (p) {
      var btn = el("button", { type: "button", class: "seg-btn", "data-preset": p }, PRESET_LABEL[p] || p);
      btn.setAttribute("aria-pressed", p === status.settings.preset ? "true" : "false");
      btn.addEventListener("click", function () { applyPreset(p); });
      seg.appendChild(btn);
    });
    // A custom configuration is not one of the buttons - show it as a note.
    var cur = status.settings.preset;
    $("presetNote").textContent = PRESET_NOTE[cur] || PRESET_NOTE.benutzerdefiniert;
  }

  /* ---------------- expert per-channel rows ---------------- */

  function renderChannels() {
    var list = $("chanList");
    list.innerHTML = "";
    (status.channels || []).forEach(function (meta) {
      var cs = status.settings.channels[meta.key] || { enabled: true, max_rate_per_sec: 0, margin: 0 };
      var count = (status.counters && status.counters[meta.key]) || 0;

      var card = el("div", { class: "chan-card" });
      card.dataset.key = meta.key;

      var head = el("div", { class: "chan-head" });
      var toggle = el("label", { class: "chan-toggle" });
      var cb = el("input", { type: "checkbox" });
      cb.className = "chan-enabled";
      if (cs.enabled) cb.checked = true;
      cb.addEventListener("change", function () { markDirty(); syncDisabled(card); });
      toggle.appendChild(cb);
      toggle.appendChild(el("span", { class: "chan-name" }, meta.label));
      head.appendChild(toggle);

      var counter = el("span", { class: "chan-counter" + (count > 0 ? " has" : "") });
      counter.dataset.counter = meta.key;
      counter.textContent = count > 0 ? (fmtInt(count) + " gefiltert") : "0 gefiltert";
      head.appendChild(counter);
      card.appendChild(head);

      card.appendChild(el("p", { class: "chan-help" }, meta.help));

      var inputs = el("div", { class: "chan-inputs" });
      inputs.appendChild(numberField("Max. Änderung", "rate", cs.max_rate_per_sec, meta.rate_unit,
        "Größere Änderung pro Sekunde gilt als Ausreißer."));
      inputs.appendChild(numberField("Toleranz", "margin", cs.margin, meta.unit,
        "Grundtoleranz für Rauschen/Rundung."));
      card.appendChild(inputs);

      list.appendChild(card);
      syncDisabled(card);
    });
  }

  function numberField(label, role, value, unit, help) {
    var wrap = el("div", { class: "field-inline" });
    wrap.appendChild(el("label", null, label));
    var iu = el("div", { class: "input-unit" });
    var input = el("input", { type: "number", step: "any", min: "0", inputmode: "decimal" });
    input.className = "chan-num";
    input.dataset.role = role;
    input.value = String(value);
    input.addEventListener("input", markDirty);
    iu.appendChild(input);
    iu.appendChild(el("span", { class: "unit" }, unit));
    wrap.appendChild(iu);
    if (help) wrap.appendChild(el("p", { class: "field-help" }, help));
    return wrap;
  }

  // syncDisabled greys the numeric inputs of a channel whose gate is switched off.
  function syncDisabled(card) {
    var on = card.querySelector(".chan-enabled").checked;
    card.classList.toggle("off", !on);
    card.querySelectorAll(".chan-num").forEach(function (i) { i.disabled = !on; });
  }

  function markDirty() {
    dirty = true;
    hideFlash();
  }

  /* ---------------- apply ---------------- */

  function collectCustom() {
    var channels = {};
    $("chanList").querySelectorAll(".chan-card").forEach(function (card) {
      var key = card.dataset.key;
      var enabled = card.querySelector(".chan-enabled").checked;
      var rate = Number(card.querySelector('.chan-num[data-role="rate"]').value);
      var margin = Number(card.querySelector('.chan-num[data-role="margin"]').value);
      channels[key] = { enabled: enabled, max_rate_per_sec: rate, margin: margin };
    });
    return { preset: "benutzerdefiniert", channels: channels };
  }

  function applyPreset(preset) { post({ preset: preset }); }
  function applyCustom() { post(collectCustom()); }

  function post(payload) {
    hideFlash();
    setBusy(true);
    fetch("/api/despike", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) {
          showError((res.body && res.body.error) || "Speichern fehlgeschlagen.");
          return;
        }
        status = res.body;
        dirty = false;
        renderPresetSeg();
        renderChannels();
        showFlash();
      })
      .catch(function () {
        showError("Verbindung zum Gerät fehlgeschlagen. Bitte erneut versuchen.");
      })
      .finally(function () { setBusy(false); });
  }

  function setBusy(b) {
    $("despikeSaveBtn").disabled = b;
    $("despikeResetBtn").disabled = b;
    $("presetSeg").querySelectorAll(".seg-btn").forEach(function (btn) { btn.disabled = b; });
  }

  function showFlash() { $("flash").hidden = false; $("err").hidden = true; }
  function showError(msg) { $("err").textContent = msg; $("err").hidden = false; $("flash").hidden = true; }
  function hideFlash() { $("flash").hidden = true; $("err").hidden = true; }

  /* ---------------- counter polling (see the filter work) ---------------- */

  function pollCounters() {
    fetch("/api/despike", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.counters) return;
        status.counters = data.counters;
        (status.channels || []).forEach(function (meta) {
          var node = document.querySelector('[data-counter="' + meta.key + '"]');
          if (!node) return;
          var n = data.counters[meta.key] || 0;
          node.textContent = n > 0 ? (fmtInt(n) + " gefiltert") : "0 gefiltert";
          node.classList.toggle("has", n > 0);
        });
      })
      .catch(function () { /* transient; try again next tick */ });
  }

  /* ---------------- boot ---------------- */

  function load() {
    fetch("/api/despike", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        status = data;
        renderPresetSeg();
        renderChannels();
        setInterval(pollCounters, 5000);
      })
      .catch(function () {
        showError("Einstellungen konnten nicht geladen werden. Bitte Seite neu laden.");
      });
  }

  $("expertToggle").addEventListener("click", function () {
    var body = $("expertBody");
    var open = body.hidden;
    body.hidden = !open;
    $("expertToggle").setAttribute("aria-expanded", open ? "true" : "false");
  });
  $("despikeSaveBtn").addEventListener("click", applyCustom);
  $("despikeResetBtn").addEventListener("click", function () { applyPreset("normal"); });

  load();
})();
