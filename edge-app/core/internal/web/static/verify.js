// verify.js - the shared "Verbindung testen" helper for the inverter form AND
// the add-source drawer, plus the per-source/-inverter status pill mapping.
// Both inverter.js and sources.js reuse it so the confidence-check UX and the
// German copy live in ONE place. Self-contained, no framework.
//
// window.VP:
//   VP.el(tag, attrs, text)        small DOM builder
//   VP.statusPill(status)          {dot, pill, label} for "ok"|"warn"|"pending"
//   VP.testConnection(opts)        POST /api/test-connection + render the panel
//   VP.clearVerify(panel)          hide/empty a verify panel
(function () {
  "use strict";

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

  // The honest failure copy (kept in sync with the edge core's testconn error
  // codes). invalid_request additionally shows the server's specific field hint.
  var MESSAGES = {
    unreachable: { title: "Gerät nicht erreichbar", body: "IP-Adresse, Port und Netzwerk prüfen." },
    no_answer: { title: "Verbindung offen, aber keine Antwort", body: "Seriennummer/Slave-ID prüfen." },
    invalid_response: { title: "Antwort ungültig", body: "Bitte Modell/Familie prüfen." },
    implausible: { title: "Verbindung ok, aber die Werte ergeben keinen Sinn", body: "Bitte Modell/Anschluss prüfen." },
    fronius_api: { title: "Verbindung fehlgeschlagen", body: "Ist die Solar API aktiviert? HTTPS-Zertifikat prüfen." },
    invalid_request: { title: "Angaben unvollständig", body: "Bitte prüfen Sie die Verbindungsdaten." },
    timeout: { title: "Keine Antwort erhalten", body: "Das Gerät hat nicht rechtzeitig geantwortet. Bitte Angaben prüfen und erneut versuchen." },
  };

  // The reading fields, in display order, with their channel colour + unit. Only
  // the fields the device actually reported are shown (never a fabricated 0).
  var FIELDS = [
    { key: "pv_kw", label: "PV", unit: "kW", color: "var(--pv)" },
    { key: "load_kw", label: "Last", unit: "kW", color: "var(--load)" },
    { key: "grid_kw", label: "Netzbezug", unit: "kW", color: "var(--grid-c)" },
    { key: "soc_pct", label: "Speicher", unit: "%", color: "var(--batt)" },
  ];

  function fmt(n, unit) {
    var v = unit === "%" ? Math.round(n) : Math.round(n * 10) / 10;
    return String(v).replace(".", ",") + " " + unit;
  }

  var SVG_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  var SVG_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.86 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.86a2 2 0 0 0-3.4 0Z"/></svg>';

  function showPanel(panel, cls, inner) {
    panel.className = "verify-panel " + cls;
    panel.innerHTML = "";
    inner.forEach(function (n) { panel.appendChild(n); });
    panel.hidden = false;
  }

  function renderLoading(panel) {
    var text = el("div");
    text.appendChild(el("p", { class: "vp-title" }, "Verbindung wird geprüft …"));
    text.appendChild(el("p", { class: "vp-body" }, "Das kann bis zu 10 Sekunden dauern."));
    showPanel(panel, "loading", [el("span", { class: "spin" }), text]);
  }

  function renderErr(panel, title, body) {
    var text = el("div");
    text.appendChild(el("p", { class: "vp-title" }, title));
    text.appendChild(el("p", { class: "vp-body" }, body));
    showPanel(panel, "err", [el("span", { class: "verify-ico", html: SVG_WARN }), text]);
  }

  function renderOk(panel, reading) {
    var text = el("div");
    text.appendChild(el("p", { class: "vp-title" }, "Verbindung erfolgreich geprüft"));
    text.appendChild(el("p", { class: "vp-body" }, "Diese Werte hat das Gerät gerade gemeldet:"));
    var chips = el("div", { class: "verify-readings" });
    var any = false;
    FIELDS.forEach(function (f) {
      var v = reading[f.key];
      if (typeof v !== "number" || !isFinite(v)) return;
      any = true;
      var chip = el("span", { class: "vr-chip" });
      chip.appendChild(el("span", { class: "sw", style: "background:" + f.color }));
      chip.appendChild(document.createTextNode(f.label + " " + fmt(v, f.unit)));
      chips.appendChild(chip);
    });
    if (any) text.appendChild(chips);
    else text.appendChild(el("p", { class: "vp-body" }, "Das Gerät hat geantwortet, aber keine auswertbaren Messwerte geliefert."));
    showPanel(panel, "ok", [el("span", { class: "verify-ico", html: SVG_CHECK }), text]);
  }

  function renderResult(panel, res) {
    if (res && res.ok) { renderOk(panel, res.reading || {}); return; }
    var code = (res && res.error_code) || "timeout";
    var m = MESSAGES[code] || MESSAGES.timeout;
    var body = (res && res.message) ? res.message : m.body;
    renderErr(panel, m.title, body);
  }

  // testConnection posts the current (unsaved) form to the test endpoint and
  // renders the result panel. It NEVER blocks Speichern. opts:
  //   { payload, panel, button }  panel = the .verify-panel element.
  function testConnection(opts) {
    var panel = opts.panel;
    var btn = opts.button;
    if (btn) { btn.disabled = true; btn.classList.add("is-busy"); }
    renderLoading(panel);
    fetch("/api/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts.payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) { renderResult(panel, res); })
      .catch(function () { renderResult(panel, { ok: false, error_code: "timeout" }); })
      .then(function () { if (btn) { btn.disabled = false; btn.classList.remove("is-busy"); } });
  }

  function clearVerify(panel) {
    if (!panel) return;
    panel.hidden = true;
    panel.innerHTML = "";
  }

  // statusPill maps a live delivery status to the dot class, pill class and
  // label. Shared by the inverter summary row and every source row.
  function statusPill(status) {
    if (status === "ok") return { dot: "ok", pill: "ok", label: "Liefert Daten" };
    if (status === "warn") return { dot: "warn", pill: "warn", label: "Keine aktuellen Daten" };
    return { dot: "off", pill: "off", label: "Wartet auf erste Daten" };
  }

  window.VP = { el: el, statusPill: statusPill, testConnection: testConnection, clearVerify: clearVerify };
})();
