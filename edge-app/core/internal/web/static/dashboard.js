// VoltPilot Edge dashboard - renders the device's own live energy data.
// Loads recent history, then streams live samples + state over SSE (falls back
// to polling if SSE is unavailable). Read-only; everything stays on the device.
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

  // Below this magnitude a power reading counts as idle (the topology deadband).
  var DEADBAND_KW = 0.05;

  // ---------- adaptive read-model shared metadata (AE6) ----------
  // The AE1 topology read-model groups entities into four roles; each role has
  // one hue + soft fill (the same --pv/--load/--grid-c/--batt channel hues the
  // v1 diagram and charts use), a KPI accent class and an icon. The adaptive
  // energy diagram and the adaptive tiles both draw from this one map, so the
  // edge :8484 view matches the portal's AE2/AE3 look.
  var ROLE_META = {
    pv:       { label: "PV",          color: cssVar("--pv"),     soft: cssVar("--pv-soft"),   tile: "pv",   icon: "sun" },
    storage:  { label: "Batterie",    color: cssVar("--batt"),   soft: cssVar("--batt-soft"), tile: "batt", icon: "battery" },
    consumer: { label: "Verbraucher", color: cssVar("--load"),   soft: cssVar("--load-soft"), tile: "load", icon: "home" },
    grid:     { label: "Netz",        color: cssVar("--grid-c"), soft: cssVar("--grid-soft"), tile: "grid", icon: "zap" }
  };

  // Inner markup for a 24x24 stroke icon, embedded as a nested <svg> at a node
  // and reused as the tile icon (stroke inherits the accent colour).
  var ICON_PATHS = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    battery: '<rect x="2" y="7" width="16" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/>',
    home: '<path d="M3 9.5 12 3l9 6.5"/><path d="M5 8.5V21h14V8.5"/><path d="M9 21v-6h6v6"/>',
    zap: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>'
  };

  // Whether an /api/state topology block carries any renderable role node (else
  // fall back to the byte-identical v1 diagram + fixed 4 tiles).
  function hasTopology(topo) {
    return !!(topo && topo.nodes && topo.nodes.length > 0);
  }
  function truncate(s, max) {
    max = max || 11;
    var t = (s || "").trim();
    return t.length <= max ? t : t.slice(0, max - 1) + "…";
  }

  // Diagram node names: an entity label carries a technical qualifier in
  // parentheses ("Batteriespeicher (Hybrid-Wechselrichter)") that is pure noise
  // in a 30px circle - drop it, keep the head noun. The full label always stays
  // reachable as the node's <title> tooltip, so nothing is lost.
  function shortEntityName(raw) {
    var t = (raw || "").trim();
    var head = t.replace(/\s*\([^()]*\)\s*$/, "").trim();
    return head.length >= 3 ? head : t;
  }

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

    // Adaptive path (AE6): when the device carries v2 entities, the tiles are
    // entity/role-driven straight from the topology read-model (a new Wallbox/
    // Heizstab appears on its own). The fixed 4 cards stay as the v1 fallback.
    var adaptive = hasTopology(s.topology);
    var kFixed = $("kpis"), kAdaptive = $("kpisAdaptive");
    kFixed.hidden = adaptive;
    kAdaptive.hidden = !adaptive;
    if (adaptive) {
      renderAdaptiveTiles(kAdaptive, s.topology);
      kAdaptive.classList.toggle("stale", !!s.last_telemetry && !fresh);
      return;
    }

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
  // The controller renders the adaptive N-node topology diagram when the device
  // carries v2 entities, else the byte-identical fixed 4-node diagram.
  var flow = createFlow($("flowWrap"));

  function renderFlow() {
    var topo = lastState ? lastState.topology : null;
    flow.update({
      pv: latestVal("pv"), load: latestVal("load"),
      grid: latestVal("grid"), batt: latestVal("batt"),
      soc: latestVal("soc")
    }, topo);
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
    // Hand the state to the "Betrieb" card (market optimization + PS-3 peak
    // guard: target, running quarter mean, reserve).
    if (window.VPBetrieb) window.VPBetrieb.onState(s);
    // Hand the state to the read-only "Aktive Steuerung" strip (the RESULT of
    // the portal-composed flows: deployed @vp-flow tabs + per-entity
    // arbitration winner, fed by state.active_control).
    if (window.VPActiveControl) window.VPActiveControl.onState(s);
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

  // Inject the flow-spoke keyframes once (shared by the v1 and adaptive
  // diagrams so the animation exists even if only the adaptive one is built).
  function ensureFlowKeyframes() {
    if (document.getElementById("flowKeyframes")) return;
    var st = document.createElement("style");
    st.id = "flowKeyframes";
    st.textContent =
      "@keyframes vpflow{to{stroke-dashoffset:-24}}" +
      ".vp-flow-on{animation:vpflow .9s linear infinite}" +
      ".vp-flow-rev{animation:vpflow .9s linear infinite reverse}";
    document.head.appendChild(st);
  }

  // ==================================================================
  // Flow controller: routes the #flowWrap container between the adaptive
  // topology diagram (v2 entities present) and the fixed 4-node diagram
  // (v1 fallback). Switching modes tears down the previous renderer (so a
  // stale ResizeObserver never squashes the other layout) and rebuilds.
  // ==================================================================
  function createFlow(container) {
    var mode = null, v1 = null, adaptive = null;
    return {
      update: function (scalar, topology) {
        var want = hasTopology(topology) ? "adaptive" : "v1";
        if (want !== mode) {
          if (v1 && v1.destroy) v1.destroy();
          if (adaptive && adaptive.destroy) adaptive.destroy();
          v1 = adaptive = null;
          container.innerHTML = "";
          container.style.height = ""; // reset the v1 narrow-layout height
          mode = want;
        }
        if (mode === "adaptive") {
          if (!adaptive) adaptive = buildAdaptiveFlow(container);
          adaptive.update(topology);
        } else {
          if (!v1) v1 = buildV1Flow(container);
          v1.update(scalar);
        }
      }
    };
  }

  // ==================================================================
  // v1 energy flow diagram: four spokes around a central hub. Flow travels
  // along a spoke; direction encodes import/export & charge/discharge.
  // Unchanged behaviour - the fallback for a device without v2 entities.
  // ==================================================================
  function buildV1Flow(container) {
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
    var ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(pickLayout); ro.observe(container);
    } else {
      window.addEventListener("resize", pickLayout);
    }

    ensureFlowKeyframes();

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
      },
      destroy: function () {
        if (ro) ro.disconnect();
        else window.removeEventListener("resize", pickLayout);
      }
    };
  }

  // ==================================================================
  // Adaptive energy flow diagram (AE6): the same lightning-hub / soft-circle-
  // node / animated-dashed-spoke look as the v1 diagram and the portal AE2,
  // but generalised from the fixed 4 nodes to the N role-grouped nodes of the
  // AE1 topology read-model. Producers sit top, storage left, consumers right,
  // grid bottom; each entity contributing to a role is its own circle, and the
  // animated spoke direction encodes the topology flow sign. Read-only.
  //
  // Geometry mirrors the portal's pure adaptiveFlow.layoutFlow so the two views
  // draw the same picture; only the DOM building is vanilla here.
  // ==================================================================
  function buildAdaptiveFlow(container) {
    var NS = "http://www.w3.org/2000/svg";
    var ROLE_SIDE = { pv: "top", storage: "left", consumer: "right", grid: "bottom" };
    // Layout constants (portal adaptiveFlow proportions).
    var NODE_R = 30, HUB_R = 24, LEFT_INSET = 62, TOP_INSET = 48,
        COL_GAP = 148, ROW_GAP = 104, LBL_F = 11.5, VAL_F = 11;
    // The name sits BELOW the circle (two lines max) instead of inside it: a
    // 30px circle only fits ~11 characters, which rendered two different nodes
    // of the same entity as an identical "Batteriesp…". LBL_BLOCK is the room
    // reserved for it under the lowest row of nodes.
    var LBL_GAP = 15, LBL_LH = 13, LBL_BLOCK = 32, LBL_MAX = 18;

    ensureFlowKeyframes();

    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    container.innerHTML = "";
    container.appendChild(svg);

    var sig = null;     // node-set signature: rebuild DOM only when it changes
    var vtxEls = {};    // vertex key -> { flow, val }

    function strokeWidth(mag) { return Math.max(2.5, Math.min(7, 2.5 + Math.abs(mag) * 0.7)); }

    // vertexValue: SoC for a storage node, |kW| otherwise (portal parity).
    function vertexValue(role, node, memberKw) {
      if (role === "storage" && node.soc_pct != null) return nf0.format(node.soc_pct) + " %";
      if (memberKw == null) return "–";
      return nf1.format(Math.abs(memberKw)) + " kW";
    }

    // layout turns the topology's role nodes into positioned circle vertices.
    function layout(topo) {
      var nodes = (topo && topo.nodes) || [];
      var bySide = function (s) {
        for (var i = 0; i < nodes.length; i++) if (ROLE_SIDE[nodes[i].role] === s) return nodes[i];
        return null;
      };
      var count = function (s) { var n = bySide(s); return n ? n.members.length : 0; };
      var cols = Math.max(count("top"), count("bottom"), 1);
      var rows = Math.max(count("left"), count("right"), 1);
      var W = Math.max(520, (cols - 1) * COL_GAP + 2 * (LEFT_INSET + NODE_R + 40));
      var H = Math.max(300, (rows - 1) * ROW_GAP + 2 * (TOP_INSET + NODE_R + 34)) + LBL_BLOCK;
      var hubX = W / 2, hubY = (H - LBL_BLOCK) / 2;
      var leftX = LEFT_INSET, rightX = W - LEFT_INSET, topY = TOP_INSET, bottomY = H - TOP_INSET - LBL_BLOCK;
      var vertices = [];
      nodes.forEach(function (node) {
        var side = ROLE_SIDE[node.role];
        if (!side) return; // unknown role - skip (never guessed)
        var n = node.members.length;
        if (n === 0) return;
        var reverse = node.direction === "out";
        node.members.forEach(function (m, i) {
          var spread = i - (n - 1) / 2, x, y;
          if (side === "top") { x = hubX + spread * COL_GAP; y = topY; }
          else if (side === "bottom") { x = hubX + spread * COL_GAP; y = bottomY; }
          else if (side === "left") { x = leftX; y = hubY + spread * ROW_GAP; }
          else { x = rightX; y = hubY + spread * ROW_GAP; }
          var meta = ROLE_META[node.role] || ROLE_META.consumer;
          var mag = m.value_kw != null ? m.value_kw : (node.value_kw != null ? node.value_kw : 0);
          vertices.push({
            key: m.entity_id + ":" + node.role + ":" + i,
            role: node.role,
            x: x, y: y,
            label: truncate(shortEntityName(m.label) || meta.label, LBL_MAX),
            fullLabel: (m.label || "").trim() || meta.label,
            roleLabel: meta.label,
            value: vertexValue(node.role, node, m.value_kw),
            spokeActive: !!node.flow_active,
            reverse: reverse,
            strokeWidth: strokeWidth(mag),
            icon: meta.icon, color: meta.color, soft: meta.soft
          });
        });
      });
      // One entity can sit on SEVERAL role nodes (a hybrid inverter is both a
      // producer and the storage), and two entities can share a head noun - in
      // both cases the bare name renders twice and the nodes stop being
      // tellable apart. Any name that occurs more than once gets its role as a
      // second line ("Batteriespeicher / · Batterie" vs "… / · PV").
      var seen = {};
      vertices.forEach(function (v) {
        var k = v.label.toLowerCase();
        seen[k] = (seen[k] || 0) + 1;
      });
      vertices.forEach(function (v) {
        v.roleLine = seen[v.label.toLowerCase()] > 1 ? "· " + v.roleLabel : "";
      });
      return { W: W, H: H, hubX: hubX, hubY: hubY, vertices: vertices };
    }

    function line(x1, y1, x2, y2, stroke, w) {
      var l = document.createElementNS(NS, "line");
      l.setAttribute("x1", x1); l.setAttribute("y1", y1);
      l.setAttribute("x2", x2); l.setAttribute("y2", y2);
      l.setAttribute("stroke", stroke); l.setAttribute("stroke-width", w);
      l.setAttribute("stroke-linecap", "round");
      return l;
    }

    // Rebuild the whole SVG for a new node set (rare: entity add/remove).
    function rebuild(L) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.setAttribute("viewBox", "0 0 " + L.W + " " + L.H);
      vtxEls = {};

      // Base spokes + animated flow overlays (behind the nodes).
      L.vertices.forEach(function (v) {
        svg.appendChild(line(v.x, v.y, L.hubX, L.hubY, "#E3E9F1", "6"));
        var flow = line(v.x, v.y, L.hubX, L.hubY, v.color, "3");
        flow.setAttribute("stroke-dasharray", "2 10");
        flow.style.opacity = "0";
        svg.appendChild(flow);
        vtxEls[v.key] = { flow: flow };
      });

      // Hub (lightning), matching the v1 diagram.
      var hubC = document.createElementNS(NS, "circle");
      hubC.setAttribute("cx", L.hubX); hubC.setAttribute("cy", L.hubY); hubC.setAttribute("r", HUB_R);
      hubC.setAttribute("fill", "#fff"); hubC.setAttribute("stroke", "#E3E9F1"); hubC.setAttribute("stroke-width", "2");
      svg.appendChild(hubC);
      var hubIco = document.createElementNS(NS, "path");
      hubIco.setAttribute("d", "M13 2 3 14h7l-1 8 10-12h-7l1-8z");
      hubIco.setAttribute("fill", "none"); hubIco.setAttribute("stroke", cssVar("--brand-deep"));
      hubIco.setAttribute("stroke-width", "2"); hubIco.setAttribute("stroke-linejoin", "round"); hubIco.setAttribute("stroke-linecap", "round");
      hubIco.setAttribute("transform", "translate(" + (L.hubX - 12) + "," + (L.hubY - 12) + ")");
      svg.appendChild(hubIco);

      // Nodes (circle + icon + label + value).
      L.vertices.forEach(function (v) {
        var g = document.createElementNS(NS, "g");
        var c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", v.x); c.setAttribute("cy", v.y); c.setAttribute("r", NODE_R);
        c.setAttribute("fill", v.soft); c.setAttribute("stroke", v.color); c.setAttribute("stroke-width", "2");
        g.appendChild(c);

        var ico = document.createElementNS(NS, "svg");
        ico.setAttribute("x", v.x - 8); ico.setAttribute("y", v.y - NODE_R * 0.72);
        ico.setAttribute("width", "16"); ico.setAttribute("height", "16");
        ico.setAttribute("viewBox", "0 0 24 24");
        ico.setAttribute("fill", "none"); ico.setAttribute("stroke", v.color);
        ico.setAttribute("stroke-width", "2"); ico.setAttribute("stroke-linecap", "round"); ico.setAttribute("stroke-linejoin", "round");
        ico.innerHTML = ICON_PATHS[v.icon] || ICON_PATHS.home;
        g.appendChild(ico);

        // Full entity name as a native tooltip - the visible label is shortened
        // and may be truncated, this is where the whole thing stays readable.
        var ttl = document.createElementNS(NS, "title");
        ttl.textContent = v.roleLine ? v.fullLabel + " (" + v.roleLabel + ")" : v.fullLabel;
        g.appendChild(ttl);

        // Name UNDER the circle (one line, plus the role line when two nodes
        // would otherwise read the same). A white halo keeps it legible where
        // it crosses a spoke.
        var lbl = document.createElementNS(NS, "text");
        lbl.setAttribute("x", v.x); lbl.setAttribute("y", v.y + NODE_R + LBL_GAP);
        lbl.setAttribute("text-anchor", "middle"); lbl.setAttribute("font-weight", "700");
        lbl.setAttribute("font-size", LBL_F); lbl.setAttribute("fill", "#33414F");
        lbl.setAttribute("font-family", "Inter, sans-serif");
        lbl.setAttribute("stroke", "#fff"); lbl.setAttribute("stroke-width", "3.5");
        lbl.setAttribute("stroke-linejoin", "round");
        lbl.style.paintOrder = "stroke";
        lbl.textContent = v.label;
        if (v.roleLine) {
          lbl.textContent = "";
          var t1 = document.createElementNS(NS, "tspan");
          t1.setAttribute("x", v.x); t1.setAttribute("dy", "0");
          t1.textContent = v.label;
          var t2 = document.createElementNS(NS, "tspan");
          t2.setAttribute("x", v.x); t2.setAttribute("dy", LBL_LH);
          t2.setAttribute("font-weight", "600"); t2.setAttribute("fill", v.color);
          t2.textContent = v.roleLine;
          lbl.appendChild(t1); lbl.appendChild(t2);
        }
        g.appendChild(lbl);

        var val = document.createElementNS(NS, "text");
        val.setAttribute("x", v.x); val.setAttribute("y", v.y + NODE_R * 0.34);
        val.setAttribute("text-anchor", "middle"); val.setAttribute("font-weight", "600");
        val.setAttribute("font-size", VAL_F); val.setAttribute("fill", v.color);
        val.setAttribute("font-family", "Inter, sans-serif");
        val.textContent = v.value;
        g.appendChild(val);

        svg.appendChild(g);
        vtxEls[v.key].val = val;
      });
    }

    // In-place value + spoke update (same node set): keeps the animation running.
    function apply(L) {
      L.vertices.forEach(function (v) {
        var e = vtxEls[v.key];
        if (!e) return;
        e.val.textContent = v.value;
        var f = e.flow;
        if (!v.spokeActive) {
          f.style.opacity = "0"; f.classList.remove("vp-flow-on", "vp-flow-rev"); return;
        }
        f.style.opacity = "1";
        f.setAttribute("stroke-width", v.strokeWidth.toFixed(1));
        f.classList.toggle("vp-flow-rev", v.reverse);
        f.classList.toggle("vp-flow-on", !v.reverse);
      });
    }

    return {
      update: function (topo) {
        var L = layout(topo);
        var newSig = L.vertices.map(function (v) { return v.key; }).join("|") + "@" + L.W + "x" + L.H;
        if (newSig !== sig) { rebuild(L); sig = newSig; }
        apply(L);
      },
      destroy: function () {}
    };
  }

  // ==================================================================
  // Adaptive tiles (AE6): entity/role-driven KPI cards from the topology
  // read-model. One aggregate tile per PV/Speicher/Netz role + one per
  // consumer entity (a Wallbox/Heizstab appears on its own). Read-only.
  // Ports the portal's adaptiveLive.deriveTiles so both views agree.
  // ==================================================================
  function signedBattery(n) {
    if (n.value_kw == null || !n.flow_active) return 0;
    return n.direction === "out" ? n.value_kw : (n.direction === "in" ? -n.value_kw : 0);
  }

  function findNode(topo, role) {
    var nodes = (topo && topo.nodes) || [];
    for (var i = 0; i < nodes.length; i++) if (nodes[i].role === role) return nodes[i];
    return null;
  }

  function deriveTiles(topo) {
    var tiles = [];
    var pv = findNode(topo, "pv");
    if (pv) {
      var pvActive = pv.flow_active && pv.value_kw != null && pv.value_kw > DEADBAND_KW;
      var pvCount = pv.members.length;
      tiles.push({
        key: "role-pv", tile: "pv", icon: "sun",
        title: pvCount === 1 ? ((pv.members[0].label || "").trim() || "PV-Anlage") : "PV-Erzeugung",
        valueText: pv.value_kw == null ? "–" : nf1.format(pv.value_kw), unit: pv.value_kw == null ? "" : "kW",
        stateLabel: pv.value_kw == null ? "wartet auf Daten" : (pvActive ? "erzeugt" : "keine Erzeugung"),
        subLine: pvCount > 1 ? pvCount + " Erzeuger" : ""
      });
    }
    var st = findNode(topo, "storage");
    if (st) {
      var soc = st.soc_pct != null ? st.soc_pct : null;
      var batt = signedBattery(st);
      var sState = "Bereit", sArrow = null, sSub = "";
      if (soc == null) { sState = "keine Batterie"; }
      else if (batt > DEADBAND_KW) { sState = "Lädt"; sArrow = "up"; sSub = "Ladeleistung " + nf1.format(batt) + " kW"; }
      else if (batt < -DEADBAND_KW) { sState = "Entlädt"; sArrow = "down"; sSub = "Abgabe " + nf1.format(Math.abs(batt)) + " kW"; }
      else if (soc >= 99) { sState = "Voll geladen"; }
      tiles.push({
        key: "role-storage", tile: "batt", icon: "battery",
        title: st.members.length === 1 ? ((st.members[0].label || "").trim() || "Speicher") : "Speicher",
        valueText: soc == null ? "–" : nf0.format(soc), unit: soc == null ? "" : "%",
        stateLabel: sState, arrow: sArrow, subLine: sSub,
        socPct: soc == null ? null : Math.max(0, Math.min(100, soc))
      });
    }
    var cons = findNode(topo, "consumer");
    if (cons) {
      cons.members.forEach(function (m, i) {
        var active = m.value_kw != null && Math.abs(m.value_kw) > DEADBAND_KW;
        tiles.push({
          key: "consumer-" + m.entity_id + "-" + i, tile: "load", icon: "home",
          title: (m.label || "").trim() || "Verbraucher",
          valueText: m.value_kw == null ? "–" : nf1.format(Math.abs(m.value_kw)), unit: m.value_kw == null ? "" : "kW",
          stateLabel: m.value_kw == null ? "wartet auf Daten" : (active ? "aktiv" : "aus")
        });
      });
    }
    var grid = findNode(topo, "grid");
    if (grid) {
      var gActive = grid.flow_active && grid.value_kw != null && grid.value_kw > DEADBAND_KW;
      var gState = "wartet auf Daten", gArrow = null, gSub = "";
      if (grid.value_kw != null) {
        if (gActive && grid.direction === "in") { gState = "Netzbezug"; gArrow = "up"; gSub = "aus dem Netz"; }
        else if (gActive && grid.direction === "out") { gState = "Einspeisung"; gArrow = "down"; gSub = "ins Netz"; }
        else { gState = "ausgeglichen"; }
      }
      tiles.push({
        key: "role-grid", tile: "grid", icon: "zap", title: "Netz",
        valueText: grid.value_kw == null ? "–" : nf1.format(grid.value_kw), unit: grid.value_kw == null ? "" : "kW",
        stateLabel: gState, arrow: gArrow, subLine: gSub
      });
    }
    return tiles;
  }

  // Cache the adaptive-tile DOM keyed by the tile-set signature, so a per-second
  // state refresh only updates text (never rebuilds - the SoC bar keeps its
  // width transition instead of re-animating from 0 every tick).
  var tileCache = { sig: null, els: {} };

  function tileIconSvg(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + (ICON_PATHS[name] || ICON_PATHS.home) + '</svg>';
  }

  function buildTileCard(t) {
    var card = document.createElement("div");
    card.className = "card kpi " + t.tile;
    card.innerHTML =
      '<div class="kpi-top"><span class="kpi-ico">' + tileIconSvg(t.icon) + '</span>' +
      '<span class="kpi-tag js-tag"></span></div>' +
      '<p class="kpi-label js-title"></p>' +
      '<p class="kpi-value"><span class="js-val"></span><span class="u js-unit"></span></p>' +
      (t.socPct != null || t.tile === "batt"
        ? '<div class="soc-bar"><span class="soc-fill js-soc" style="width:0%"></span></div>' : "") +
      '<p class="kpi-sub js-sub">&nbsp;</p>';
    var el = {
      card: card,
      tag: card.querySelector(".js-tag"), title: card.querySelector(".js-title"),
      val: card.querySelector(".js-val"), unit: card.querySelector(".js-unit"),
      soc: card.querySelector(".js-soc"), sub: card.querySelector(".js-sub")
    };
    el.update = function (t) {
      el.tag.textContent = t.stateLabel;
      el.title.textContent = t.title;
      el.val.textContent = t.valueText;
      el.unit.textContent = t.unit;
      if (el.soc) el.soc.style.width = (t.socPct == null ? 0 : t.socPct) + "%";
      if (t.subLine) {
        var chip = t.arrow === "up" ? "up" : (t.arrow === "down" ? "down" : "idle");
        var glyph = t.arrow === "up" ? "▲ " : (t.arrow === "down" ? "▼ " : "");
        el.sub.innerHTML = t.arrow
          ? "<span class='chip " + chip + "'>" + glyph + escapeHtml(t.subLine) + "</span>"
          : escapeHtml(t.subLine);
      } else {
        el.sub.innerHTML = "&nbsp;";
      }
    };
    return el;
  }

  function renderAdaptiveTiles(container, topo) {
    var tiles = deriveTiles(topo);
    var newSig = tiles.map(function (t) { return t.key; }).join("|");
    if (newSig !== tileCache.sig) {
      container.innerHTML = "";
      tileCache.els = {};
      tiles.forEach(function (t) {
        var el = buildTileCard(t);
        container.appendChild(el.card);
        tileCache.els[t.key] = el;
      });
      tileCache.sig = newSig;
    }
    tiles.forEach(function (t) {
      var el = tileCache.els[t.key];
      if (el) el.update(t);
    });
  }
})();
