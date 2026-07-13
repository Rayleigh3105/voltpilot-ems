// VoltPilot Edge dashboard - renders the device's own live energy data.
// Loads recent history, then streams live samples + state over SSE (falls back
// to polling if SSE is unavailable). Read-only; everything stays on the device.
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

  // --- clock alignment: chart timestamps are device epoch ms ---
  var clockOffset = 0; // deviceNow = Date.now() + clockOffset
  function deviceNow() { return Date.now() + clockOffset; }
  function syncClock(serverMs) { if (serverMs) clockOffset = serverMs - Date.now(); }

  var pts = [];            // {t,pv,load,grid,soc,batt,limit}
  var rangeMin = 60;       // selected window (minutes)
  var lastState = null;

  // --- charts ---
  var powerChart = new TimeChart($("powerChart"), {
    unit: "kW", zeroLine: true, series: [
      { key: "pv", label: "PV", color: cssVar("--pv"), area: true },
      { key: "load", label: "Haus", color: cssVar("--load") },
      { key: "grid", label: "Netz", color: cssVar("--grid-c") },
      { key: "batt", label: "Batterie", color: cssVar("--batt") }
    ]
  });
  var socChart = new TimeChart($("socChart"), {
    unit: "%", yFixed: [0, 100], series: [
      { key: "soc", label: "SoC", color: cssVar("--batt"), area: true }
    ]
  });

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function windowMs() { return rangeMin * 60 * 1000; }

  function redrawCharts() {
    var xMax = deviceNow();
    var xMin = xMax - windowMs();
    var win = pts.filter(function (p) { return p.t >= xMin - 5000; });
    powerChart.setData(win, xMin, xMax);
    socChart.setData(win, xMin, xMax);

    var hasPower = win.some(function (p) { return p.pv != null || p.load != null || p.grid != null; });
    var hasSoc = win.some(function (p) { return p.soc != null; });
    $("powerEmpty").hidden = hasPower;
    $("socEmpty").hidden = hasSoc;
  }

  function pushSample(s) {
    pts.push(s);
    // Trim to a little beyond the largest window (3h) to bound memory.
    var cutoff = deviceNow() - (180 * 60 * 1000 + 60000);
    while (pts.length && pts[0].t < cutoff) pts.shift();
  }

  // ---------- KPI + status rendering ----------
  function latestVal(key) {
    for (var i = pts.length - 1; i >= 0; i--) {
      if (pts[i][key] != null && !isNaN(pts[i][key])) return pts[i][key];
    }
    return null;
  }

  function kw(v) { return v == null ? "–" : nf1.format(v); }

  function renderKpis(s) {
    var fresh = s.last_telemetry && (serverAge(s.last_telemetry) < 90);
    var pv = latestVal("pv"), load = latestVal("load"), grid = latestVal("grid");
    var soc = latestVal("soc"), batt = latestVal("batt");

    // PV
    $("pvVal").textContent = kw(pv);
    $("pvSub").textContent = pv == null ? "wartet auf Daten" : (pv > 0.05 ? "Anlage erzeugt" : "keine Erzeugung");

    // Battery
    $("socVal").textContent = soc == null ? "–" : nf0.format(soc);
    $("socFill").style.width = (soc == null ? 0 : Math.max(0, Math.min(100, soc))) + "%";
    var bs = $("battState"), bsub = $("battSub");
    if (soc == null) {
      bs.textContent = "–"; bsub.textContent = "keine Batterie erkannt";
    } else if (batt != null && batt > 0.05) {
      bs.textContent = "Lädt"; bsub.innerHTML = "<span class='chip down'>▲ " + nf1.format(batt) + " kW</span> Ladeleistung";
    } else if (batt != null && batt < -0.05) {
      bs.textContent = "Entlädt"; bsub.innerHTML = "<span class='chip up'>▼ " + nf1.format(-batt) + " kW</span> Abgabe";
    } else if (soc >= 99) {
      bs.textContent = "Voll"; bsub.innerHTML = "<span class='chip idle'>bereit</span> vollgeladen";
    } else {
      bs.textContent = "Bereit"; bsub.innerHTML = "<span class='chip idle'>im Ruhezustand</span>";
    }

    // Load
    $("loadVal").textContent = kw(load);
    $("loadSub").textContent = load == null ? "wartet auf Daten" : (load > 0.05 ? "aktueller Bedarf" : "kein Verbrauch");

    // Grid
    $("gridVal").textContent = grid == null ? "–" : nf1.format(Math.abs(grid));
    var gl = $("gridLabel"), gt = $("gridTag"), gsub = $("gridSub");
    if (grid == null) {
      gl.textContent = "Netzanschluss"; gt.textContent = "Netz"; gsub.textContent = "wartet auf Daten";
    } else if (grid > 0.05) {
      gl.textContent = "Netzbezug"; gt.textContent = "Bezug";
      gsub.innerHTML = "<span class='chip up'>▲ Import</span> aus dem Netz";
    } else if (grid < -0.05) {
      gl.textContent = "Netzeinspeisung"; gt.textContent = "Einspeisung";
      gsub.innerHTML = "<span class='chip down'>▼ Export</span> ins Netz";
    } else {
      gl.textContent = "Netzanschluss"; gt.textContent = "Netz";
      gsub.innerHTML = "<span class='chip idle'>ausgeglichen</span>";
    }

    var kpis = $("kpis");
    kpis.classList.toggle("stale", !!s.last_telemetry && !fresh);
  }

  function serverAge(iso) {
    if (!iso) return Infinity;
    return Math.max(0, (deviceNow() - new Date(iso).getTime()) / 1000);
  }
  function ago(iso) {
    var s = serverAge(iso);
    if (!isFinite(s)) return null;
    if (s < 60) return "vor " + Math.round(s) + " s";
    if (s < 3600) return "vor " + Math.round(s / 60) + " min";
    return "vor " + nf1.format(s / 3600) + " h";
  }

  function renderStatus(s) {
    // Mode
    var mv = $("modeVal"), msub = $("modeSub");
    if (s.mode === "fahrplan") {
      mv.className = "status-val ok"; mv.childNodes[0].nodeValue = "Folgt Fahrplan";
      msub.textContent = s.slot_start ? "Slot ab " + hm(s.slot_start) + " Uhr" : "kostenoptimiert";
    } else if (s.mode === "eigenverbrauch") {
      mv.className = "status-val"; mv.childNodes[0].nodeValue = "Eigenverbrauch";
      msub.textContent = "PV & Verbrauch (kein aktueller Fahrplan)";
    } else {
      mv.className = "status-val warn"; mv.childNodes[0].nodeValue = "Wartet";
      msub.textContent = "noch keine Messwerte";
    }

    // Cloud
    var cv = $("cloudVal"), csub = $("cloudSub");
    if (s.cloud_connected) {
      cv.className = "status-val ok"; cv.childNodes[0].nodeValue = "Verbunden";
      csub.textContent = "Daten werden übertragen";
    } else if (s.buffer_paused) {
      // Removed (unclaimed) in the cloud: buffering is honestly paused instead
      // of piling up data that can never be sent.
      cv.className = "status-val err"; cv.childNodes[0].nodeValue = "Entfernt";
      csub.textContent = "Aufzeichnung pausiert – Gerät im Portal erneut hinzufügen";
    } else if (s.buffer_data_loss) {
      // Long outage overran the buffer: the oldest samples are being discarded.
      cv.className = "status-val err"; cv.childNodes[0].nodeValue = "Getrennt";
      csub.textContent = "Zwischenspeicher voll - älteste Messwerte werden verworfen";
    } else {
      cv.className = "status-val warn"; cv.childNodes[0].nodeValue = "Getrennt";
      csub.textContent = s.buffer_pending > 0
        ? nf0.format(s.buffer_pending) + " Messwerte zwischengespeichert"
        : "Daten werden lokal gepuffert";
    }

    // Inverter link
    var iv = $("invVal"), isub = $("invSub");
    var model = (s.inverter && s.inverter.configured) ? s.inverter.label : null;
    if (s.inverter_link === "up") {
      iv.className = "status-val ok"; iv.childNodes[0].nodeValue = "Verbunden";
      isub.textContent = model || "";
    } else if (s.inverter_link === "down") {
      iv.className = "status-val err"; iv.childNodes[0].nodeValue = "Getrennt";
      isub.textContent = "Verbindung prüfen";
    } else if (model) {
      iv.className = "status-val"; iv.childNodes[0].nodeValue = model;
      isub.textContent = "wartet auf Verbindung";
    } else {
      iv.className = "status-val warn"; iv.childNodes[0].nodeValue = "Nicht eingerichtet";
      isub.innerHTML = "";
      isub.textContent = "unter „Wechselrichter einrichten“";
    }

    // Plan
    var pv = $("planVal"), psub = $("planSub");
    if (s.plan_slots > 0) {
      pv.className = "status-val"; pv.childNodes[0].nodeValue = nf0.format(s.plan_slots) + " Slots";
      psub.textContent = "empfangen " + (ago(s.plan_received) || "");
    } else {
      pv.className = "status-val"; pv.childNodes[0].nodeValue = "–";
      psub.textContent = "noch keiner empfangen";
    }

    // Telemetry freshness
    var tv = $("telVal"), tsub = $("telSub");
    var a = ago(s.last_telemetry);
    if (a) {
      var fresh = serverAge(s.last_telemetry) < 90;
      tv.className = "status-val " + (fresh ? "ok" : "warn");
      tv.childNodes[0].nodeValue = a;
      tsub.textContent = fresh ? "Anlage liefert Daten" : "keine aktuellen Daten";
    } else {
      tv.className = "status-val warn"; tv.childNodes[0].nodeValue = "keine";
      tsub.textContent = "warte auf erste Daten";
    }
  }

  function hm(iso) { return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); }

  // ---------- Cloud pill (topbar) ----------
  function renderPill(s) {
    var pill = $("cloudPill"), txt = $("cloudPillText"), dot = pill.querySelector(".dot");
    if (s.cloud_connected) {
      pill.className = "pill ok"; txt.textContent = "Cloud verbunden"; dot.classList.add("live");
    } else if (s.pairing_state === "geraet_entfernt") {
      pill.className = "pill off"; txt.textContent = "Aus Cloud entfernt"; dot.classList.remove("live");
    } else if (s.last_telemetry && serverAge(s.last_telemetry) < 90) {
      pill.className = "pill warn"; txt.textContent = "Lokal aktiv · Cloud getrennt"; dot.classList.remove("live");
    } else {
      pill.className = "pill off"; txt.textContent = "Cloud getrennt"; dot.classList.remove("live");
    }
  }

  // ---------- Guided two-step onboarding card ----------
  // The customer MUST connect the inverter first; the portal-claim step (with
  // the reference) stays LOCKED until the inverter actually delivers data. The
  // gate itself is computed server-side (s.onboarding_step / s.inverter_connected),
  // and the reference is withheld from /api/state until unlocked, so the wrong
  // path (claiming before the inverter works) is not reachable in the UI.
  function renderPairing(s) {
    var st = s.pairing_state;
    var step = s.onboarding_step || "inverter"; // "inverter" | "claim" | "done"
    $("ref").textContent = s.ref || "…";
    $("version").textContent = (!s.version || s.version === "dev") ? "" : "v" + s.version;

    var connected = st === "verbunden";
    var done = step === "done";

    // Progress rail: 1 = inverter, 2 = portal, 3 = verbunden.
    // reached = index of the last completed dot; active = the current dot.
    var reached = done ? (connected ? 3 : 2) : (step === "claim" ? 1 : 0);
    var activeIdx = done ? (connected ? 3 : 3) : (step === "claim" ? 2 : 1);
    document.querySelectorAll("#onboardProgress li[data-p]").forEach(function (li) {
      var p = parseInt(li.getAttribute("data-p"), 10);
      li.classList.toggle("done", p <= reached);
      li.classList.toggle("active", p === activeIdx && p > reached);
    });

    renderPairingError(st);

    // Collapse the whole onboarding body once the device is claimed (a
    // certificate is on disk): don't re-prompt on a mere cloud blip.
    $("pairingCard").classList.toggle("compact", done);
    $("onboardBody").hidden = done;

    if (done) {
      if (connected) {
        $("pairingTitle").textContent = "Gerät verbunden";
        $("pairingLead").innerHTML = "Referenz <strong>" + escapeHtml(s.ref || "") + "</strong> · erfolgreich mit VoltPilot gekoppelt.";
      } else {
        $("pairingTitle").textContent = "Gerät wird verbunden";
        $("pairingLead").textContent = "Das Gerät ist eingerichtet und stellt die Verbindung zu VoltPilot her.";
      }
      return;
    }

    // Onboarding in progress.
    $("pairingTitle").textContent = "In zwei Schritten startklar";
    $("pairingLead").textContent = step === "claim"
      ? "Ihr Wechselrichter liefert Daten. Schließen Sie jetzt die Kopplung im Portal ab."
      : "Zuerst den Wechselrichter verbinden - danach schalten Sie das Gerät im Portal frei.";

    renderStep1(s, step);
    renderStep2(s, step);
  }

  // Schritt 1 - Wechselrichter verbinden.
  function renderStep1(s, step) {
    var block = $("step1");
    var configured = !!(s.inverter && s.inverter.configured);
    var invConnected = !!s.inverter_connected;
    var stateEl = $("step1Status"), txt = $("step1StatusText");
    var desc = $("step1Desc"), cta = $("step1Cta"), ctaLabel = $("step1CtaLabel");

    // done whenever the customer is past step 1 (inverter delivers data).
    block.classList.toggle("done", step !== "inverter");
    block.classList.toggle("active", step === "inverter");

    if (step !== "inverter") {
      // Inverter connected and delivering data.
      stateEl.className = "step-status ok";
      txt.textContent = "Verbunden";
      desc.textContent = s.inverter && s.inverter.label
        ? s.inverter.label + " liefert Messwerte."
        : "Wechselrichter liefert Messwerte.";
      ctaLabel.textContent = "Einstellungen ändern";
      cta.className = "step-cta ghost";
    } else if (!configured) {
      // Not configured yet - the active task.
      stateEl.className = "step-status warn";
      txt.textContent = "Jetzt einrichten";
      desc.textContent = "Wählen Sie Ihren Wechselrichter aus, damit dieses Gerät Messwerte empfängt. Das dauert nur eine Minute.";
      ctaLabel.textContent = "Wechselrichter einrichten";
      cta.className = "step-cta";
    } else if (!invConnected) {
      // Configured but no data yet.
      stateEl.className = "step-status wait";
      txt.innerHTML = "<span class='ss-spin'></span>Warte auf erste Daten…";
      desc.textContent = s.inverter && s.inverter.label
        ? s.inverter.label + " ist eingerichtet - warte auf die ersten Messwerte vom Wechselrichter. Bitte prüfen, ob der Wechselrichter eingeschaltet und erreichbar ist."
        : "Wechselrichter ist eingerichtet - warte auf die ersten Messwerte.";
      ctaLabel.textContent = "Einstellungen prüfen";
      cta.className = "step-cta ghost";
    }
  }

  // Schritt 2 - Mit dem VoltPilot-Portal verbinden. Locked until Schritt 1 done.
  function renderStep2(s, step) {
    var block = $("step2");
    var unlocked = step === "claim"; // done is handled by the compact collapse
    block.classList.toggle("locked", !unlocked);
    block.classList.toggle("active", unlocked);
    $("step2Locked").hidden = unlocked;
    $("step2Unlocked").hidden = !unlocked;

    var stateEl = $("step2Status"), txt = $("step2StatusText");
    if (unlocked) {
      stateEl.className = "step-status warn";
      txt.textContent = "Jetzt koppeln";
    } else {
      stateEl.className = "step-status locked";
      txt.textContent = "Gesperrt";
    }
  }

  // The pairing error / status box: transport, local-init and cloud failures
  // each get an actionable German message.
  function renderPairingError(st) {
    var err = $("pairingError");
    var msg = null, soft = false;
    if (st === "schluessel_konflikt") {
      msg = "Registrierung gesperrt: Für diese Referenz ist bereits ein anderes Gerät registriert. Bitte den Support kontaktieren.";
    } else if (st === "geraet_entfernt") {
      msg = "Gerät wurde aus der Cloud entfernt – es wartet auf eine erneute Beanspruchung. Fügen Sie das Gerät im Portal wieder hinzu (Referenz unten); die lokale Anzeige läuft weiter, die Aufzeichnung für die Cloud ist pausiert.";
    } else if (st === "referenz_unbekannt") {
      msg = "Diese Geräte-ID ist dem System nicht bekannt. Bitte die Referenz auf dem Aufkleber prüfen.";
    } else if (st === "portal_nicht_erreichbar") {
      msg = "Gerät kann das Portal nicht erreichen - bitte die Internetverbindung prüfen. Es wird automatisch weiter versucht.";
    } else if (st === "geraet_fehler") {
      msg = "Auf dem Gerät ist ein Fehler aufgetreten (z. B. Speicher nicht beschreibbar). Bitte das Gerät neu starten; hält der Fehler an, den Support kontaktieren.";
    } else if (st === "cloud_fehler") {
      msg = "Verbindung zu VoltPilot konnte nicht aufgebaut werden. Das Gerät versucht es automatisch erneut.";
    } else if (st === "cloud_getrennt") {
      msg = "Verbindung zu VoltPilot unterbrochen - sie wird automatisch wiederhergestellt."; soft = true;
    }
    if (msg) { err.hidden = false; err.textContent = msg; err.classList.toggle("soft", soft); }
    else { err.hidden = true; err.classList.remove("soft"); }
  }

  function escapeHtml(s) { return s.replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  // ---------- Energy flow diagram ----------
  var flow = buildFlow($("flowWrap"));

  function renderFlow() {
    flow.update({
      pv: latestVal("pv"), load: latestVal("load"),
      grid: latestVal("grid"), batt: latestVal("batt"),
      soc: latestVal("soc")
    });
  }

  // ---------- state application ----------
  function applyState(s) {
    lastState = s;
    syncClock(s.server_now_ms);
    renderPill(s);
    renderPairing(s);
    renderInverterCta(s);
    renderKpis(s);
    renderStatus(s);
    renderPurge(s);
    renderFlow();
    // Hand the state to the Fahrplan view: it refetches the full plan when a new
    // one arrives and keeps the live setpoint + active slot + freshness current.
    if (window.VPPlan) window.VPPlan.onState(s);
    // Hand the state to the "Steuerung & Bestätigung" card (register-level
    // control readback fed by state.control).
    if (window.VPControl) window.VPControl.onState(s);
  }

  // ---------- data purge ("Datenaufzeichnungen löschen") ----------
  // Guarded destructive action: expand -> read the consequences -> type
  // LÖSCHEN -> confirm. The cloud half is tracked via s.data_purge
  // (ausstehend -> angefordert -> bestaetigt, see the contract).
  function renderPurge(s) {
    var box = $("purgeStatus"), txt = $("purgeStatusText");
    var dp = s.data_purge;
    if (!dp) { box.hidden = true; return; }
    box.hidden = false;
    if (dp.cloud_state === "bestaetigt") {
      box.className = "purge-status ok";
      txt.textContent = "Löschung abgeschlossen - Gerät und Portal sind bereinigt. Neue Messwerte werden wieder aufgezeichnet.";
    } else if (dp.cloud_state === "angefordert") {
      box.className = "purge-status wait";
      txt.textContent = "Auf dem Gerät gelöscht. Die Löschung im Portal wurde angefordert und wird gleich bestätigt…";
    } else {
      box.className = "purge-status wait";
      txt.textContent = "Auf dem Gerät gelöscht. Die Löschung im Portal wird nachgeholt, sobald das Gerät wieder mit der Cloud verbunden ist.";
    }
  }

  function purgeConfirmOpen(open) {
    $("purgeConfirm").hidden = !open;
    $("purgeOpenBtn").hidden = open;
    $("purgeError").hidden = true;
    var input = $("purgeTypeInput");
    input.value = "";
    $("purgeGoBtn").disabled = true;
    if (open) input.focus();
  }

  $("purgeOpenBtn").addEventListener("click", function () { purgeConfirmOpen(true); });
  $("purgeCancelBtn").addEventListener("click", function () { purgeConfirmOpen(false); });
  $("purgeTypeInput").addEventListener("input", function () {
    $("purgeGoBtn").disabled = this.value.trim().toUpperCase() !== "LÖSCHEN";
  });

  $("purgeGoBtn").addEventListener("click", function () {
    var btn = this;
    btn.disabled = true;
    btn.textContent = "Wird gelöscht…";
    fetch("/api/purge-data", { method: "POST" })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body && res.body.error);
        purgeConfirmOpen(false);
        // Drop the local chart data right away; the state stream carries the
        // cloud progress (renderPurge).
        pts = [];
        redrawCharts();
        if (lastState) {
          lastState.data_purge = res.body.data_purge;
          renderPurge(lastState);
          renderKpis(lastState);
          renderFlow();
        }
      })
      .catch(function (e) {
        var err = $("purgeError");
        err.hidden = false;
        err.textContent = (e && e.message) ||
          "Die Aufzeichnungen konnten nicht gelöscht werden. Bitte versuchen Sie es erneut.";
      })
      .then(function () {
        btn.textContent = "Endgültig löschen";
      });
  });

  // Prominent CTA while no inverter is configured: without it the Node-RED
  // read flow is idle and NO telemetry ever reaches the device (M1). During
  // onboarding, Schritt 1 already owns this guidance, so the banner only shows
  // AFTER the device is paired (step "done") if the inverter is ever missing -
  // otherwise it would duplicate the onboarding card.
  function renderInverterCta(s) {
    var need = !(s.inverter && s.inverter.configured) && s.onboarding_step === "done";
    $("inverterBanner").hidden = !need;
  }

  // ---------- data loading + streaming ----------
  function loadHistory() {
    return fetch("/api/history?minutes=" + Math.max(rangeMin, 180), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        syncClock(d.server_now_ms);
        pts = (d.samples || []).slice();
        redrawCharts();
        renderFlow();
        if (lastState) renderKpis(lastState);
      })
      .catch(function () { /* stream/poll will fill in */ });
  }

  function startStream() {
    if (!window.EventSource) { startPolling(); return; }
    var es = new EventSource("/api/stream");
    es.addEventListener("state", function (e) {
      try { applyState(JSON.parse(e.data)); redrawCharts(); } catch (_) {}
    });
    es.addEventListener("sample", function (e) {
      try { pushSample(JSON.parse(e.data)); redrawCharts(); if (lastState) { renderKpis(lastState); renderFlow(); } } catch (_) {}
    });
    es.onerror = function () { /* EventSource auto-reconnects */ };
  }

  function startPolling() {
    setInterval(function () {
      fetch("/api/state", { cache: "no-store" }).then(function (r) { return r.json(); })
        .then(function (s) { applyState(s); }).catch(function () {});
      loadHistory();
    }, 3000);
  }

  // ---------- range toggle ----------
  $("rangeSeg").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    rangeMin = parseInt(b.getAttribute("data-min"), 10);
    document.querySelectorAll("#rangeSeg button").forEach(function (x) { x.classList.toggle("active", x === b); });
    redrawCharts();
  });

  // ---------- copy ----------
  // The dashboard is served over plain HTTP on a LAN IP - an insecure context
  // where navigator.clipboard is unavailable (only localhost/https expose it).
  // Fall back to a hidden-textarea execCommand("copy"), and on genuine failure
  // tell the user to copy manually instead of silently no-opping.
  function copyRef(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error("execCommand copy failed"));
      } catch (e) {
        reject(e);
      }
    });
  }

  $("copyBtn").addEventListener("click", function () {
    var ref = $("ref").textContent;
    copyRef(ref)
      .then(function () {
        $("copyLabel").textContent = "Kopiert ✓";
        setTimeout(function () { $("copyLabel").textContent = "Kopieren"; }, 1500);
      })
      .catch(function () {
        $("copyLabel").textContent = "Bitte manuell markieren und kopieren";
        setTimeout(function () { $("copyLabel").textContent = "Kopieren"; }, 3000);
      });
  });

  // Keep the axes scrolling even when idle.
  setInterval(redrawCharts, 1000);

  // ---------- boot ----------
  fetch("/api/state", { cache: "no-store" }).then(function (r) { return r.json(); })
    .then(applyState).catch(function () {});
  loadHistory().then(startStream);

  // ==================================================================
  // Energy flow diagram: four spokes around a central hub. Flow travels
  // along a spoke; direction encodes import/export & charge/discharge.
  // ==================================================================
  function buildFlow(container) {
    var NS = "http://www.w3.org/2000/svg";

    // Two layouts sharing the same node->hub topology, so the animation logic
    // is identical; only the coordinates differ. WIDE is the landscape diamond
    // (tablet/desktop); NARROW is a taller portrait cross that fills a phone's
    // width - the viewBox is close to the container width there, so the labels
    // render near full size instead of shrinking into an unreadable diamond.
    var LAYOUTS = {
      wide:   { W: 400, H: 250, hubR: 22, nodeR: 26, lblF: 10.5, valF: 10,
                hub: { x: 200, y: 128 },
                pos: { pv: { x: 200, y: 40 }, load: { x: 336, y: 128 },
                       grid: { x: 200, y: 216 }, batt: { x: 64, y: 128 } } },
      narrow: { W: 280, H: 344, hubR: 26, nodeR: 32, lblF: 13, valF: 12,
                hub: { x: 140, y: 172 },
                pos: { pv: { x: 140, y: 52 }, load: { x: 214, y: 172 },
                       grid: { x: 140, y: 292 }, batt: { x: 66, y: 172 } } }
    };
    var META = {
      pv:   { label: "PV",       color: cssVar("--pv"),     soft: cssVar("--pv-soft") },
      load: { label: "Haus",     color: cssVar("--load"),   soft: cssVar("--load-soft") },
      grid: { label: "Netz",     color: cssVar("--grid-c"), soft: cssVar("--grid-soft") },
      batt: { label: "Batterie", color: cssVar("--batt"),   soft: cssVar("--batt-soft") }
    };
    var KEYS = ["pv", "load", "grid", "batt"];

    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    // Base spoke lines + animated flow overlays (node -> hub geometry).
    var spokes = {};
    KEYS.forEach(function (k) {
      var base = document.createElementNS(NS, "line");
      base.setAttribute("stroke", "#E3E9F1"); base.setAttribute("stroke-width", "6");
      base.setAttribute("stroke-linecap", "round");
      svg.appendChild(base);
      var flowLine = document.createElementNS(NS, "line");
      flowLine.setAttribute("stroke", META[k].color); flowLine.setAttribute("stroke-width", "3");
      flowLine.setAttribute("stroke-linecap", "round");
      flowLine.setAttribute("stroke-dasharray", "2 10");
      flowLine.style.opacity = "0";
      svg.appendChild(flowLine);
      spokes[k] = { base: base, flow: flowLine };
    });

    // Hub.
    var hubC = document.createElementNS(NS, "circle");
    hubC.setAttribute("fill", "#fff"); hubC.setAttribute("stroke", "#E3E9F1"); hubC.setAttribute("stroke-width", "2");
    svg.appendChild(hubC);
    var hubIco = document.createElementNS(NS, "path");
    hubIco.setAttribute("d", "M13 2 3 14h7l-1 8 10-12h-7l1-8z");
    hubIco.setAttribute("fill", "none"); hubIco.setAttribute("stroke", cssVar("--brand-deep"));
    hubIco.setAttribute("stroke-width", "2"); hubIco.setAttribute("stroke-linejoin", "round"); hubIco.setAttribute("stroke-linecap", "round");
    svg.appendChild(hubIco);

    // Nodes (circle + label + value).
    var nodeEls = {};
    KEYS.forEach(function (k) {
      var g = document.createElementNS(NS, "g");
      var c = document.createElementNS(NS, "circle");
      c.setAttribute("fill", META[k].soft); c.setAttribute("stroke", META[k].color); c.setAttribute("stroke-width", "2");
      g.appendChild(c);
      var lbl = document.createElementNS(NS, "text");
      lbl.setAttribute("text-anchor", "middle"); lbl.setAttribute("font-weight", "700");
      lbl.setAttribute("fill", "#33414F"); lbl.setAttribute("font-family", "Inter, sans-serif");
      lbl.textContent = META[k].label;
      g.appendChild(lbl);
      var val = document.createElementNS(NS, "text");
      val.setAttribute("text-anchor", "middle"); val.setAttribute("font-weight", "600");
      val.setAttribute("fill", META[k].color); val.setAttribute("font-family", "Inter, sans-serif");
      val.textContent = "–";
      g.appendChild(val);
      svg.appendChild(g);
      nodeEls[k] = { circle: c, lbl: lbl, val: val };
    });

    container.innerHTML = "";
    container.appendChild(svg);

    // applyLayout positions every element for the chosen preset. Called on
    // build and whenever the container crosses the narrow/wide threshold.
    var curLayout = null;
    function applyLayout(L) {
      svg.setAttribute("viewBox", "0 0 " + L.W + " " + L.H);
      hubC.setAttribute("cx", L.hub.x); hubC.setAttribute("cy", L.hub.y); hubC.setAttribute("r", L.hubR);
      hubIco.setAttribute("transform", "translate(" + (L.hub.x - 12) + "," + (L.hub.y - 12) + ")");
      KEYS.forEach(function (k) {
        var p = L.pos[k], s = spokes[k], n = nodeEls[k];
        s.base.setAttribute("x1", p.x); s.base.setAttribute("y1", p.y);
        s.base.setAttribute("x2", L.hub.x); s.base.setAttribute("y2", L.hub.y);
        s.flow.setAttribute("x1", p.x); s.flow.setAttribute("y1", p.y);
        s.flow.setAttribute("x2", L.hub.x); s.flow.setAttribute("y2", L.hub.y);
        n.circle.setAttribute("cx", p.x); n.circle.setAttribute("cy", p.y); n.circle.setAttribute("r", L.nodeR);
        n.lbl.setAttribute("x", p.x); n.lbl.setAttribute("y", p.y - L.nodeR * 0.16); n.lbl.setAttribute("font-size", L.lblF);
        n.val.setAttribute("x", p.x); n.val.setAttribute("y", p.y + L.nodeR * 0.44); n.val.setAttribute("font-size", L.valF);
      });
    }
    function pickLayout() {
      var w = container.clientWidth || 400;
      var want = w < 380 ? LAYOUTS.narrow : LAYOUTS.wide;
      if (want !== curLayout) { curLayout = want; applyLayout(want); }
      // For the portrait phone layout, size the container to the layout's own
      // aspect so the SVG fills the width (labels stay full-size) instead of
      // being letterboxed by a fixed min-height. Wide layout keeps its CSS box.
      container.style.height = want === LAYOUTS.narrow
        ? Math.round(w * (want.H / want.W)) + "px" : "";
    }
    pickLayout();
    if (window.ResizeObserver) {
      new ResizeObserver(pickLayout).observe(container);
    } else {
      window.addEventListener("resize", pickLayout);
    }

    // Inject the flow keyframes once.
    if (!document.getElementById("flowKeyframes")) {
      var st = document.createElement("style");
      st.id = "flowKeyframes";
      st.textContent =
        "@keyframes vpflow{to{stroke-dashoffset:-24}}" +
        ".vp-flow-on{animation:vpflow .9s linear infinite}" +
        ".vp-flow-rev{animation:vpflow .9s linear infinite reverse}";
      document.head.appendChild(st);
    }

    function setSpoke(k, active, reverse, magnitude) {
      var f = spokes[k].flow;
      if (!active) {
        f.style.opacity = "0"; f.classList.remove("vp-flow-on", "vp-flow-rev"); return;
      }
      f.style.opacity = "1";
      var w = Math.max(2.5, Math.min(7, 2.5 + Math.abs(magnitude) * 0.7));
      f.setAttribute("stroke-width", w.toFixed(1));
      f.classList.toggle("vp-flow-rev", reverse);
      f.classList.toggle("vp-flow-on", !reverse);
    }

    function fmt(v, unit) {
      if (v == null || isNaN(v)) return "–";
      return nf1.format(v) + (unit || "");
    }

    return {
      update: function (d) {
        // Node value labels.
        // PV/Haus/Netz are power in kW; label the unit so the numbers aren't
        // ambiguous next to the battery's "%".
        nodeEls.pv.val.textContent = d.pv == null ? "–" : fmt(d.pv, " kW");
        nodeEls.load.val.textContent = d.load == null ? "–" : fmt(d.load, " kW");
        nodeEls.grid.val.textContent = d.grid == null ? "–" : fmt(Math.abs(d.grid), " kW");
        nodeEls.batt.val.textContent = d.soc == null ? "–" : nf0.format(d.soc) + "%";

        // Geometry is node->hub. Inflow (node into hub) = normal animation.
        // PV: generation flows into the hub.
        setSpoke("pv", d.pv != null && d.pv > 0.05, false, d.pv);
        // Haus: always consumes -> hub to node -> reverse.
        setSpoke("load", d.load != null && d.load > 0.05, true, d.load);
        // Netz: import (grid>0) node->hub normal; export (grid<0) reverse.
        setSpoke("grid", d.grid != null && Math.abs(d.grid) > 0.05, d.grid < 0, d.grid);
        // Batterie: discharge (batt<0) node->hub normal; charge (batt>0) reverse.
        setSpoke("batt", d.batt != null && Math.abs(d.batt) > 0.05, d.batt > 0, d.batt);
      }
    };
  }
})();
