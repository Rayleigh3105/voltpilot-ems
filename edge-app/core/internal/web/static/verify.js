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
//   VP.fmtVal(n, unit)             German number + unit ("20,1 kW")
//   VP.gridPart(kw)                signed grid kW -> "Netzbezug/Einspeisung X kW"
//   VP.lastReadLine(parts, readAtMs, serverNowMs)
//                                  the shared "Zuletzt gelesen: … · vor X (HH:MM:SS)" line
//   VP.portalManagedNote(flag)     the ONE sentence a portal-managed plant shows
//                                  instead of its edit buttons (null = editable)
//   VP.setPortalManaged(root, flag) hide every edit affordance under root
//   VP.readingChips(reading)       the reported values as display chips
//   VP.befundText(finding, hatWerte)
//                                  the named plausibility violation in plain German
//   VP.portalWegText(finding)      the way forward, ONLY where one exists
//   VP.fehlerAnsicht(res)          the PURE derivation of the failure panel
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

  // readingChips turns what the device REALLY answered into display chips, in
  // FIELDS order. Only the fields it actually reported appear (never a
  // fabricated 0). PURE - it is the one place a reading becomes a chip, shared
  // by the success panel AND the failure panel (a failed read that still
  // decoded three of four channels is a diagnosis, not a dead end).
  function readingChips(reading) {
    var out = [];
    if (!reading || typeof reading !== "object") return out;
    FIELDS.forEach(function (f) {
      var v = reading[f.key];
      if (typeof v !== "number" || !isFinite(v)) return;
      out.push({ key: f.key, color: f.color, text: f.label + " " + fmt(v, f.unit) });
    });
    return out;
  }

  function chipsEl(chips) {
    var box = el("div", { class: "verify-readings" });
    chips.forEach(function (c) {
      var chip = el("span", { class: "vr-chip" });
      chip.appendChild(el("span", { class: "sw", style: "background:" + c.color }));
      chip.appendChild(document.createTextNode(c.text));
      box.appendChild(chip);
    });
    return box;
  }

  function renderErr(panel, view) {
    var text = el("div");
    text.appendChild(el("p", { class: "vp-title" }, view.title));
    text.appendChild(el("p", { class: "vp-body" }, view.body));
    // Everything below is present ONLY when the device supplied the fact for
    // it - a failure with no reading and no finding renders exactly the two
    // lines it always did.
    if (view.werte.length) {
      text.appendChild(el("p", { class: "vp-body vp-werte-intro" }, view.werteIntro));
      text.appendChild(chipsEl(view.werte));
    }
    if (view.befund) text.appendChild(el("p", { class: "vp-body vp-befund" }, view.befund));
    if (view.weg) text.appendChild(el("p", { class: "vp-body vp-weg" }, view.weg));
    showPanel(panel, "err", [el("span", { class: "verify-ico", html: SVG_WARN }), text]);
  }

  function renderOk(panel, reading) {
    var text = el("div");
    text.appendChild(el("p", { class: "vp-title" }, "Verbindung erfolgreich geprüft"));
    text.appendChild(el("p", { class: "vp-body" }, "Diese Werte hat das Gerät gerade gemeldet:"));
    var chips = readingChips(reading);
    if (chips.length) text.appendChild(chipsEl(chips));
    else text.appendChild(el("p", { class: "vp-body" }, "Das Gerät hat geantwortet, aber keine auswertbaren Messwerte geliefert."));
    showPanel(panel, "ok", [el("span", { class: "verify-ico", html: SVG_CHECK }), text]);
  }

  // controlCheckLine renders the D11 write short-test verdict (go-e): the
  // honest one-liner under an OK read panel. "" when no check ran.
  function controlCheckLine(check) {
    if (!check) return "";
    if (check.ok) {
      // A shelly check (gen present) carries its own honest sentence incl.
      // the detected device; the go-e wording stays verbatim.
      if (check.gen) return check.message || "Schalt-Schreibtest bestätigt.";
      var line = "Steuer-Schreibtest bestätigt: die Wallbox hat den Schreibbefehl übernommen und zurückgemeldet.";
      if (typeof check.phases_in_use === "number" && check.phases_in_use > 0) {
        line += " Lädt aktuell " + (check.phases_in_use === 1 ? "1-phasig" : check.phases_in_use + "-phasig") + ".";
      }
      return line;
    }
    if (check.skipped) {
      // Deliberately not run (shelly: relay on, a running heat cycle is never
      // interrupted) - an honest state, not a failure.
      return check.message || "Der Schalttest wurde übersprungen.";
    }
    return check.message || "Der Steuer-Schreibtest war nicht erfolgreich.";
  }

  // shellyCapabilityLine names what the detected device CAN (D3): with power
  // metering the fulfilment proof is Stufe 2 (real measurements); without it
  // the runtime is confirmed via the relay and the energy is honestly labeled
  // "angenommen" (Nennleistung x Zeit) - the wizard says so BEFORE anything
  // is saved.
  function shellyCapabilityLine(check) {
    if (!check || typeof check.metering !== "boolean") return "";
    return check.metering
      ? "Dieses Shelly misst die Leistung: Laufzeit und Energie werden aus echten Messwerten bestätigt."
      : "Dieses Shelly misst keine Leistung: die Laufzeit wird über das Relais bestätigt, die Energie wird als angenommen (Nennleistung × Zeit) gekennzeichnet.";
  }

  /* ---- der BEFUND: WELCHER Kanal WELCHE Regel verletzt hat ----------------
   *
   * ⚠ ZWILLINGS-DISZIPLIN: diese Sätze leben ZWEIMAL - hier in Vanilla-JS
   * (Box-Oberfläche :8484) und als `regelText()`/`overrideFuer()` in
   * frontend/portal/src/komponentenAssistent.ts (Portal, TS). Verschiedene
   * Laufzeiten, KEIN geteilter Code - aber DIESELBEN Sätze: derselbe Mensch
   * liest beide Flächen, und derselbe Gerätezustand darf dort nicht anders
   * heißen. WER EINE SEITE ÄNDERT, ÄNDERT BEIDE; die Vektoren sind beidseitig
   * gepinnt (hier jstest/ui.test.js, dort komponentenAssistent.test.ts).
   *
   * Ein unbekanntes (Kanal, Regel)-Paar erzeugt KEINEN Satz - die Haus-Regel
   * "ohne Fakt nur die Beobachtung": eine geratene Ursache ist schlimmer als
   * gar keine. (Genau daran ist der alte Zweizeiler gescheitert: "Bitte
   * Modell/Anschluss prüfen" ist eine Ursachen-BEHAUPTUNG, und im
   * `missing`-Fall ist sie nachweislich falsch - Modell und Anschluss stimmen,
   * das BMS fehlt.)
   */
  function fmtPct(v) {
    if (typeof v !== "number" || !isFinite(v)) return "einen unmöglichen Wert";
    return v.toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " %";
  }

  function befundText(finding, hatWerte) {
    if (!finding || finding.channel !== "soc_pct") return "";
    var rest = hatWerte ? " Spannung, Strom und Leistung sind lesbar." : "";
    if (finding.rule === "missing") {
      return "Der Ladestand liest 0 % - bei einer Eigenbau- oder nicht gekoppelten Batterie "
        + "heißt das: das BMS liefert keine Daten an den Wechselrichter." + rest;
    }
    if (finding.rule === "out_of_range") {
      return "Der Ladestand liest " + fmtPct(finding.value) + " - das kann kein Ladestand sein "
        + "(gültig sind 1 bis 100 %). Meist passt die Modellauswahl nicht zum Gerät.";
    }
    if (finding.rule === "no_answer") {
      return "Das Gerät hat geantwortet, aber alle Register standen auf 0 - so antwortet der "
        + "Datenlogger, wenn er den Wechselrichter selbst nicht erreicht.";
    }
    return "";
  }

  // ⚠ Die Box setzt das Opt-in NIE selbst: ob ein fehlender Ladestand
  // hinnehmbar ist, entscheidet der Mensch im Portal. Sie DIAGNOSTIZIERT und
  // VERWEIST - mehr nicht. Die Design-Grenze bleibt, nur ihre Unsichtbarkeit
  // fällt weg. Deshalb genau EIN Satz, und nur für die eine Regel, die ein
  // Gerätezustand ist statt eines Lesefehlers.
  var PORTAL_WEG = "Ein Speicher ohne gekoppeltes BMS lässt sich im VoltPilot-Portal anlegen — nur lesend.";

  function portalWegText(finding) {
    if (!finding || finding.channel !== "soc_pct" || finding.rule !== "missing") return "";
    return PORTAL_WEG;
  }

  // fehlerAnsicht ist die EINE reine Ableitung des Fehler-Panels: aus der
  // Antwort der Box wird, was die Fläche zeichnet. Ohne `reading` und ohne
  // `finding` (jede andere Fehlerklasse, jede ältere Box) kommt exakt der
  // Zweizeiler heraus, den die Seite immer schon zeigte.
  function fehlerAnsicht(res) {
    var code = (res && res.error_code) || "timeout";
    var m = MESSAGES[code] || MESSAGES.timeout;
    var werte = readingChips(res && res.reading);
    var finding = (res && res.finding) || null;
    return {
      title: m.title,
      body: (res && res.message) ? res.message : m.body,
      werte: werte,
      werteIntro: werte.length ? "Das hat das Gerät trotzdem gemeldet:" : "",
      befund: befundText(finding, werte.length > 0),
      weg: portalWegText(finding),
    };
  }

  function renderResult(panel, res) {
    if (res && res.ok) {
      renderOk(panel, res.reading || {});
      // The D11 control short-test rides an OK read: append its honest verdict
      // (confirmed or the named failure) - never silently dropped.
      var line = controlCheckLine(res.control_check);
      if (line) appendPanelNote(panel, line);
      var cap = shellyCapabilityLine(res.control_check);
      if (cap) appendPanelNote(panel, cap);
      return;
    }
    renderErr(panel, fehlerAnsicht(res));
  }

  /* ---- multi-inverter unit-ID probe (Fronius Datamanager) ---- */

  // probeUnits asks the edge to scan the (unsaved) fronius_sunspec connection's
  // address for further inverter unit ids (Datamanager convention: inverter
  // number = Modbus unit id). Resolves the found unit-id array or null on any
  // failure - idle-safe, callers just skip the hint then.
  function probeUnits(payload) {
    return fetch("/api/probe-units", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        return res && res.ok && Array.isArray(res.found_units) ? res.found_units : null;
      })
      .catch(function () { return null; });
  }

  // foundUnitsLine renders the honest multi-inverter hint; "" when there is
  // nothing worth saying (probe failed, or at most one inverter found).
  function foundUnitsLine(found) {
    if (!found || found.length < 2) return "";
    return "An dieser Adresse wurden " + found.length + " Wechselrichter gefunden (Unit-IDs " + found.join(", ") + ").";
  }

  // appendPanelNote appends one extra line to a currently-shown OK panel (used
  // for the async multi-inverter hint after the test result already rendered).
  function appendPanelNote(panel, text) {
    if (!panel || panel.hidden || panel.className.indexOf("ok") < 0) return;
    var body = panel.lastElementChild;
    if (!body) return;
    body.appendChild(el("p", { class: "vp-body vp-units" }, text));
  }

  // testConnection posts the current (unsaved) form to the test endpoint and
  // renders the result panel. It NEVER blocks Speichern. opts:
  //   { payload, panel, button }  panel = the .verify-panel element.
  //   probePayload  (optional) when set and the test succeeds, the same form is
  //                 probed for FURTHER inverter unit ids at that address and the
  //                 hint line is appended to the OK panel (fronius_sunspec only
  //                 - callers pass it only for that brand).
  //   onUnitsFound  (optional) callback receiving the found unit-id array.
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
      .then(function (res) {
        renderResult(panel, res);
        if (res && res.ok && opts.probePayload) {
          probeUnits(opts.probePayload).then(function (found) {
            var line = foundUnitsLine(found);
            if (line) appendPanelNote(panel, line);
            if (opts.onUnitsFound) opts.onUnitsFound(found || []);
          });
        }
      })
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

  /* ---- "Zuletzt gelesen" (last-read line per device/source) ---- */

  // gridPart renders a signed grid power (+Bezug/-Einspeisung) as honest German
  // instead of a bare signed number. Shared by the primary row and a Netz row.
  function gridPart(kw) {
    return kw < 0 ? "Einspeisung " + fmt(-kw, "kW") : "Netzbezug " + fmt(kw, "kW");
  }

  // fmtAgo renders a relative age. The age is computed by the CALLER against
  // the device clock (server_now_ms), so browser clock skew never lies here.
  function fmtAgo(ageMs) {
    var s = Math.max(0, Math.round(ageMs / 1000));
    if (s < 5) return "gerade eben";
    if (s < 60) return "vor " + s + " s";
    if (s < 3600) return "vor " + Math.round(s / 60) + " Min.";
    return "vor " + Math.round(s / 3600) + " Std.";
  }

  // lastReadLine builds the shared "Zuletzt gelesen" line: the value parts, a
  // relative age against the device clock and the absolute local time. Returns
  // "" when there is nothing honest to show (no reading yet) - the caller then
  // renders nothing and the status pill keeps saying "Wartet auf erste Daten".
  function lastReadLine(parts, readAtMs, serverNowMs) {
    if (!parts || !parts.length || !readAtMs) return "";
    var now = typeof serverNowMs === "number" && serverNowMs > 0 ? serverNowMs : Date.now();
    var clock = new Date(readAtMs).toLocaleTimeString("de-DE",
      { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return "Zuletzt gelesen: " + parts.join(" · ") + " – " + fmtAgo(now - readAtMs) + " (" + clock + " Uhr)";
  }

  // Einheitsmodell Stufe 2: auf einer portal-verwalteten Anlage ist diese Seite
  // ein SPIEGEL. Der Satz sagt, was gilt UND wo es gepflegt wird - eine
  // Oberfläche, die nur "geht nicht" sagt, wäre eine Sackgasse. Was die Box
  // physisch braucht (Koppeln, Netzwerk, Steuerungs-Freigabe, Not-Aus,
  // Messwert-Aufbereitung) bleibt unberührt lokal; nur die GERÄTE-Einrichtung
  // wandert.
  var PORTAL_MANAGED_NOTE = "Die Geräte dieser Anlage werden im VoltPilot-Portal "
    + "gepflegt. Hier sehen Sie, was auf diesem Gerät läuft; ändern lässt es sich "
    + "im Portal.";

  function portalManagedNote(flag) {
    return flag ? PORTAL_MANAGED_NOTE : null;
  }

  // setPortalManaged blendet JEDE Bearbeitungs-Möglichkeit unterhalb von root
  // aus (Knöpfe tragen dafür data-vp-edit) und zeigt den Hinweis. Sehen bleibt
  // immer erlaubt - gesperrt wird ausschließlich das Ändern.
  function setPortalManaged(root, flag, noteId) {
    if (!root) return;
    var edits = root.querySelectorAll("[data-vp-edit]");
    for (var i = 0; i < edits.length; i++) {
      edits[i].hidden = !!flag;
    }
    var note = noteId ? document.getElementById(noteId) : null;
    if (note) {
      note.textContent = portalManagedNote(flag) || "";
      note.hidden = !flag;
    }
  }

  window.VP = {
    el: el,
    portalManagedNote: portalManagedNote,
    setPortalManaged: setPortalManaged,
    statusPill: statusPill,
    testConnection: testConnection,
    probeUnits: probeUnits,
    foundUnitsLine: foundUnitsLine,
    clearVerify: clearVerify,
    readingChips: readingChips,
    befundText: befundText,
    portalWegText: portalWegText,
    fehlerAnsicht: fehlerAnsicht,
    fmtVal: fmt,
    gridPart: gridPart,
    fmtAgo: fmtAgo,
    lastReadLine: lastReadLine,
  };
})();
