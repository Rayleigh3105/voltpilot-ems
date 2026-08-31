// VoltPilot Edge - the "Einrichten" page controller.
//
// One rule governs this page: it shows BIG what needs an action, finished
// things shrink to one line, rare things fold away. Concretely:
//   * While the plant is not commissioned, the guided four-step flow leads
//     the page (commissioning.js) together with the Portal-Kopplung block.
//   * Once everything runs, BOTH disappear (no green banner - Betrieb's status
//     hero is the single health voice) and the steady state is exactly FOUR
//     quiet accordion rows: Anlage / Steuerung / Datenfreigabe / Erweitert.
//   * Healthy = all groups closed, EVERY visit (no accordion memory). A group
//     with a NEW non-OK state opens itself (VPGroups.shouldAutoOpen); nothing
//     ever auto-closes over the operator.
//
// This file owns only what is NOT already owned by the per-card scripts
// (inverter.js, sources.js, mirror.js, control.js, calibration.js, curtail.js,
// einstellungen.js):
//   * the derived four-step flow (commissioning.js)
//   * the portal pairing block (reference + copy + honest error copy),
//     tech-only once paired
//   * the accordion shell: summaries (groups.js), auto-open, deep-link anchors
//   * the data purge (guarded destructive action)
//   * feeding /api/state to VPControl and VPCalibration
//
// Nothing here changes a gate: the calibration mutations remain protected by
// the admin token (server-side calGuard), and the purge still runs through the
// unchanged POST /api/purge-data with its type-to-confirm gate in BOTH modes.
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

  var lastState = null;
  // portalManaged spiegelt /api/sources portal_managed: ein älterer Kern sendet
  // das Feld nicht -> false -> der geführte Flow spricht wie bisher.
  var sourcesData = { sources: [], statuses: {}, portalManaged: false, custom: [] };
  var clockOffset = 0;

  function deviceNow() { return Date.now() + clockOffset; }
  function syncClock(ms) { if (ms) clockOffset = ms - Date.now(); }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
  }

  /* ---------------- top bar ---------------- */

  function renderPill(s) {
    var pill = $("cloudPill"), txt = $("cloudPillText");
    if (!pill) return;
    var dot = pill.querySelector(".dot");
    if (s.cloud_connected) {
      pill.className = "state-chip ok"; txt.textContent = "Portal verbunden"; dot.classList.add("live");
    } else if (s.pairing_state === "geraet_entfernt") {
      pill.className = "state-chip off"; txt.textContent = "Aus dem Portal entfernt"; dot.classList.remove("live");
    } else {
      pill.className = "state-chip off"; txt.textContent = "Portal getrennt"; dot.classList.remove("live");
    }
    var v = $("version");
    if (v) v.textContent = (!s.version || s.version === "dev") ? "" : "v" + s.version;
  }

  /* ---------------- the four accordion groups ----------------
     The head rows are real <button>s (aria-expanded/-controls); the summaries
     and the auto-open decision are the PURE derivations in groups.js. There is
     deliberately NO stored open/closed state: healthy = all closed, every
     visit, and a group with a NEW problem opens itself. */

  var acc = {}; // group id -> { head, body, dot, summary, problemKey }

  function initAccordion() {
    var groups = document.querySelectorAll(".acc-group");
    Array.prototype.forEach.call(groups, function (g) {
      var id = g.dataset.group;
      acc[id] = {
        head: g.querySelector(".acc-head"),
        body: g.querySelector(".acc-body"),
        dot: g.querySelector(".acc-dot"),
        summary: g.querySelector(".acc-summary"),
        problemKey: null
      };
      acc[id].head.addEventListener("click", function () { toggleGroup(id); });
    });
  }

  function setOpen(id, open) {
    var a = acc[id];
    if (!a) return;
    a.body.hidden = !open;
    a.head.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function toggleGroup(id) {
    var a = acc[id];
    if (!a) return;
    setOpen(id, a.body.hidden);
  }
  function openGroup(id) { setOpen(id, true); }

  // applySummary renders one group row (dot + one summary line - the row never
  // carries the warning message itself) and opens the group when a NEW problem
  // appeared. The same standing problem never re-opens a group the operator
  // closed, and nothing is ever auto-closed.
  function applySummary(id, sum) {
    var a = acc[id];
    if (!a || !sum) return;
    a.summary.textContent = sum.text;
    a.dot.className = "acc-dot " + (sum.tone || "off");
    if (window.VPGroups.shouldAutoOpen(a.problemKey, sum.problemKey)) openGroup(id);
    a.problemKey = sum.problemKey;
  }

  // Deep links (redirects from the retired pages, the guided flow's step
  // actions, printed install sheets) must land on a VISIBLE target: open the
  // group that contains the anchor, then scroll to it.
  function revealHash() {
    var h = (location.hash || "").replace(/^#/, "");
    if (!h) return;
    var g = window.VPGroups.groupForAnchor(h);
    if (g) openGroup(g);
    var el = document.getElementById(h);
    if (el) el.scrollIntoView({ block: "start" });
  }

  /* ---------------- the guided flow ---------------- */

  function stepMarkup(step) {
    var glyph = step.state === "done" ? "✓" : (step.state === "blocked" ? "!" : String(step.num));
    var html =
      '<li class="setup-step ' + step.state + '">' +
      '<span class="n" aria-hidden="true">' + glyph + "</span>" +
      "<div>" +
      '<div class="t">' + escapeHtml(step.title) + "</div>" +
      '<div class="s">' + escapeHtml(step.detail) + "</div>";
    // The cause is ALWAYS rendered - Technikmodus never owns a reason.
    if (step.cause) html += '<div class="cause">' + escapeHtml(step.cause) + "</div>";
    if (step.action) {
      html += '<a class="step-link' + (step.action.ghost ? " ghost" : "") + '" href="' +
        escapeHtml(step.action.href) + '">' + escapeHtml(step.action.label) + "</a>";
    }
    return html + "</div></li>";
  }

  // Once all four steps are done the WHOLE flow disappears - finished is
  // finished, there is no receded green line (Betrieb's status hero is the
  // single health voice). It returns, leading again, when a step regresses.
  function renderSetup(s) {
    if (!window.VPCommissioning) return;
    var res = window.VPCommissioning.derive(s, sourcesData.sources.length, deviceNow(),
      sourcesData.portalManaged);
    var card = $("setupCard");
    if (card) card.hidden = res.allDone;
    if (res.allDone) return;

    var list = $("setupSteps");
    if (list) {
      var html = "";
      for (var i = 0; i < res.steps.length; i++) html += stepMarkup(res.steps[i]);
      list.innerHTML = html;
    }
    var prog = $("setupProgress");
    if (prog) prog.textContent = "Schritt " + res.activeNum + " von " + res.steps.length;
  }

  /* ---------------- portal pairing block ---------------- */

  // Honest, actionable copy per enroll state. Same vocabulary the status hero on
  // "Betrieb" uses (status.js) - the two must never contradict each other.
  var PAIR_ERROR = {
    schluessel_konflikt: "Registrierung gesperrt: Für diese Referenz ist bereits ein anderes Gerät registriert. Bitte den Support kontaktieren.",
    geraet_entfernt: "Gerät wurde aus dem Portal entfernt – es wartet auf eine erneute Beanspruchung. Fügen Sie das Gerät im Portal wieder hinzu (Referenz unten); die lokale Anzeige läuft weiter, die Aufzeichnung für das Portal ist pausiert.",
    referenz_unbekannt: "Diese Geräte-ID ist dem System nicht bekannt. Bitte die Referenz auf dem Aufkleber prüfen.",
    portal_nicht_erreichbar: "Gerät kann das Portal nicht erreichen - bitte die Internetverbindung prüfen. Es wird automatisch weiter versucht.",
    geraet_fehler: "Auf dem Gerät ist ein Fehler aufgetreten (z. B. Speicher nicht beschreibbar). Bitte das Gerät neu starten; hält der Fehler an, den Support kontaktieren.",
    cloud_fehler: "Verbindung zu VoltPilot konnte nicht aufgebaut werden. Das Gerät versucht es automatisch erneut."
  };
  var PAIR_SOFT = { cloud_getrennt: "Verbindung zu VoltPilot unterbrochen - sie wird automatisch wiederhergestellt." };

  function renderPairing(s) {
    var refEl = $("ref");
    if (refEl) refEl.textContent = s.ref || "…";

    var unlocked = !!s.claim_unlocked;
    var isPaired = window.VPCommissioning && window.VPCommissioning.paired(s.pairing_state);

    // Once paired, the pairing card leaves the normal-mode page entirely - the
    // reference lives only in the Technikmodus identity block (next to the
    // version). While NOT paired (incl. geraet_entfernt) the guided flow still
    // needs it, so it renders as today. A regression of the cloud LINK on a
    // paired device is carried by the guided flow's step 3 + Betrieb's status
    // hero - one message, one place.
    var isTechOnly = !!isPaired;
    var area = $("portal"), card = $("pairingCard");
    if (area) area.classList.toggle("tech-only", isTechOnly);
    if (card) card.classList.toggle("tech-only", isTechOnly);

    var locked = $("pairLocked"), open = $("pairUnlocked");
    if (locked) locked.hidden = unlocked;
    if (open) open.hidden = !unlocked;

    var state = $("pairState");
    if (state) {
      if (isPaired && s.cloud_connected) {
        state.className = "pair-state ok";
        state.textContent = "Dieses Gerät ist mit dem VoltPilot-Portal verbunden.";
      } else if (isPaired) {
        state.className = "pair-state warn";
        state.textContent = "Gerät ist gekoppelt – die Verbindung zum Portal wird gerade aufgebaut.";
      } else if (unlocked) {
        state.className = "pair-state warn";
        state.textContent = "Noch nicht gekoppelt. Tragen Sie die Referenz-ID im Portal ein.";
      } else {
        state.className = "pair-state";
        state.textContent = "Die Kopplung wird freigeschaltet, sobald der Wechselrichter Daten liefert.";
      }
    }

    var err = $("pairingError");
    if (err) {
      var msg = PAIR_ERROR[s.pairing_state] || PAIR_SOFT[s.pairing_state] || null;
      err.hidden = !msg;
      if (msg) { err.textContent = msg; err.classList.toggle("soft", !PAIR_ERROR[s.pairing_state]); }
    }

    var tech = $("pairTech");
    if (tech) {
      var rows = [
        ["Referenz", s.ref || "(noch nicht freigegeben)"],
        ["Version", (!s.version || s.version === "dev") ? "dev" : "v" + s.version],
        ["Kopplungszustand", s.pairing_state || "–"],
        ["Geräte-ID", s.device_id || "–"],
        ["Anlagen-ID", s.site_id || "–"],
        ["Mandanten-ID", s.tenant_id || "–"],
        ["MQTT-Endpunkt", s.mqtt_host || "–"],
        ["Zwischenspeicher", nf0.format(s.buffer_pending || 0) + " Messwerte" +
          (s.buffer_paused ? " (pausiert)" : "") + (s.buffer_data_loss ? " · älteste werden verworfen" : "")]
      ];
      var html = "";
      for (var i = 0; i < rows.length; i++) {
        html += "<div><b>" + escapeHtml(rows[i][0]) + "</b><span>" + escapeHtml(rows[i][1]) + "</span></div>";
      }
      tech.innerHTML = html;
    }
  }

  /* ---------------- copy the reference ---------------- */
  // Served over plain HTTP on a LAN IP - an insecure context where
  // navigator.clipboard is unavailable. Fall back to a hidden textarea, and on
  // genuine failure tell the user to copy manually instead of silently no-opping.
  function copyRef(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
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
      } catch (e) { reject(e); }
    });
  }

  /* ---------------- data purge (guarded destructive action) ---------------- */
  // Unchanged behaviour: expand -> read the consequences -> type LÖSCHEN ->
  // confirm -> POST /api/purge-data. The cloud half is tracked via
  // s.data_purge (ausstehend -> angefordert -> bestaetigt, see the contract).
  function renderPurge(s) {
    var box = $("purgeStatus"), txt = $("purgeStatusText");
    if (!box) return;
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

  /* ---------------- state application ---------------- */

  function applyState(s) {
    lastState = s;
    syncClock(s.server_now_ms);
    renderPill(s);
    renderSetup(s);
    renderPairing(s);
    renderPurge(s);
    applySummary("anlage", window.VPGroups.anlageSummary(s, sourcesData.sources,
      sourcesData.statuses, deviceNow(), sourcesData.custom));
    applySummary("steuerung", window.VPGroups.steuerungSummary(s));
    // The control state (control.js owns the verdict; its register evidence
    // lives on Betrieb under Technikmodus, not on this page).
    if (window.VPControl) window.VPControl.onState(s);
    // The First-Light calibration card (it also reads state.control for the
    // "Kam der Befehl an?" readback; its own /api/calibration poll drives it).
    if (window.VPCalibration) window.VPCalibration.onState(s);
  }

  function loadSources() {
    return fetch("/api/sources", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        // custom_devices ist ADDITIV: eine ältere Box liefert es nicht, dann
        // zählt die Kopfzeile keine eigenen Geräte - wie vorher.
        sourcesData = {
          sources: d.sources || [], statuses: d.statuses || {},
          portalManaged: !!d.portal_managed,
          custom: d.custom_devices || []
        };
      })
      .catch(function () { /* the step falls back to "keine weitere Quelle" */ });
  }

  function poll() {
    fetch("/api/state", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(applyState)
      .catch(function () {});
  }

  /* ---------------- wiring ---------------- */

  initAccordion();
  applySummary("erweitert", window.VPGroups.erweitertSummary());
  // mirror.js is the ONE source of the mirror state (it owns the /api/mirror
  // poll): the head seeds from its last answer - null until the first poll,
  // which renders as "…", never as a claimed "Aus" - and follows every later
  // one through the event. Head and card therefore read the same object.
  function renderDatenfreigabe(m) {
    applySummary("datenfreigabe", window.VPGroups.datenfreigabeSummary(m, location.hostname));
  }
  renderDatenfreigabe(window.VPMirror ? window.VPMirror.state() : null);
  window.addEventListener("vp:mirror-state", function (ev) { renderDatenfreigabe(ev.detail); });

  window.addEventListener("hashchange", revealHash);

  var copyBtn = $("copyBtn");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      copyRef($("ref").textContent)
        .then(function () {
          $("copyLabel").textContent = "Kopiert ✓";
          setTimeout(function () { $("copyLabel").textContent = "Kopieren"; }, 1500);
        })
        .catch(function () {
          $("copyLabel").textContent = "Bitte manuell markieren und kopieren";
          setTimeout(function () { $("copyLabel").textContent = "Kopieren"; }, 3000);
        });
    });
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
        if (lastState) { lastState.data_purge = res.body.data_purge; renderPurge(lastState); }
      })
      .catch(function (e) {
        var err = $("purgeError");
        err.hidden = false;
        err.textContent = (e && e.message) ||
          "Die Aufzeichnungen konnten nicht gelöscht werden. Bitte versuchen Sie es erneut.";
      })
      .then(function () { btn.textContent = "Endgültig löschen"; });
  });

  // The add/remove of a source changes step 2 AND the Anlage row - re-derive
  // when the list moves.
  window.addEventListener("vp:sources-changed", function () {
    loadSources().then(function () { if (lastState) applyState(lastState); });
  });

  /* ---------------- boot ---------------- */
  loadSources().then(function () { poll(); revealHash(); });
  setInterval(poll, 3000);
  setInterval(loadSources, 30000);
})();
