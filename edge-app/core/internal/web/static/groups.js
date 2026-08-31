// VoltPilot Edge - the four "Einrichten" accordion groups (pure derivations).
//
// THE rule of the reworked page: it shows BIG what needs an action, finished
// things shrink to one line, rare things fold away. Concretely: a fully set-up,
// healthy plant shows exactly FOUR quiet rows - ① Anlage, ② Steuerung,
// ③ Datenfreigabe, ④ Erweitert - all closed, every visit (no accordion
// memory). A group with a non-OK state opens ITSELF, exactly once per new
// problem (shouldAutoOpen), and carries only the status dot on its row - the
// message itself lives INSIDE the group, once, with its "seit" stamp
// (control.js/trackStateSince own that for the Steuerung group).
//
// Everything here is DERIVED from what the existing APIs already report
// (/api/state, /api/sources, /api/mirror) - no new endpoint, no stored
// accordion state. Pure + side-effect free, so it is unit-testable without a
// browser (internal/web/jstest/ui.test.js).
(function (global) {
  "use strict";

  // Same staleness window status.js/commissioning.js use.
  var FRESH_SECONDS = 90;

  function ageSeconds(iso, nowMs) {
    if (!iso) return null;
    var t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, (nowMs - t) / 1000);
  }

  function fmtKwp(v) {
    return (Math.round(v * 10) / 10).toString().replace(".", ",");
  }

  /* ------------------------------------------------------------------
     ① Anlage - "Deye SUN-30K · 2 Erzeuger · 70 kWp · alle liefern".
     Inputs: the /api/state envelope (inverter selection + composite telemetry
     freshness) and the /api/sources payload (sources + per-source statuses).
     tone: "ok" | "warn" | "off"; problemKey: non-null ONLY for a state that
     should open the group by itself (something stopped delivering).
     ------------------------------------------------------------------ */
  function anlageSummary(s, sources, statuses, nowMs, custom) {
    s = s || {};
    sources = sources || [];
    statuses = statuses || {};
    custom = custom || [];
    if (nowMs == null) nowMs = s.server_now_ms || Date.now();

    var inv = s.inverter;
    if (!inv || !inv.configured) {
      // The guided flow leads the page in this state - the group stays a calm
      // pointer, never a second voice nagging about the same thing.
      return { tone: "off", text: "Noch kein Wechselrichter eingerichtet", problemKey: null };
    }

    var parts = [inv.label || "Wechselrichter"];
    var erz = 0, netz = 0, verb = 0, kwp = 0;
    for (var i = 0; i < sources.length; i++) {
      var src = sources[i];
      if (src.role === "grid-meter") netz++;
      else if (src.role === "consumer") verb++;
      else { erz++; if (src.capacity_kwp > 0) kwp += src.capacity_kwp; }
    }
    if (erz > 0) parts.push(erz + " Erzeuger");
    if (netz > 0) parts.push("Netz-Zähler");
    if (verb > 0) parts.push(verb + " Verbraucher");
    if (kwp > 0) parts.push(fmtKwp(kwp) + " kWp");
    // Die selbst angelegten Geräte werden GEZÄHLT, aber sie gehen NICHT in das
    // Liefer-Urteil unten ein: die Box liest sie nicht selbst (ihr Leseplan ist
    // ein generierter Flow), also wäre „wartet auf Daten" eine Aussage über ein
    // Warten, das hier niemand tut - und sie würde die Gruppe grundlos grau
    // färben. Sichtbar sind sie in ihrer eigenen Gruppe, mit ihrer eigenen
    // Pille.
    if (custom.length > 0) {
      parts.push(custom.length + (custom.length === 1 ? " eigenes Gerät" : " eigene Geräte"));
    }

    // Delivery verdict: the primary inverter via the composite telemetry age,
    // every additional source via its own status ("ok"|"warn"|"pending").
    var telAge = ageSeconds(s.last_telemetry, nowMs);
    var everDelivered = telAge != null;
    var stale = [], waiting = [];
    if (!everDelivered) waiting.push(inv.label || "Wechselrichter");
    else if (telAge >= FRESH_SECONDS) stale.push(inv.label || "Wechselrichter");
    for (var j = 0; j < sources.length; j++) {
      var st = statuses[sources[j].id] || "pending";
      var name = sources[j].label || sources[j].brand || "Quelle";
      if (st === "warn") stale.push(name);
      else if (st === "pending") waiting.push(name);
    }

    if (stale.length > 0) {
      parts.push(stale.length === 1
        ? stale[0] + ": keine aktuellen Daten"
        : stale.length + " ohne aktuelle Daten");
      // Keyed by WHO is stale: the same standing fault never re-opens the
      // group, a different one does (the trackStateSince discipline).
      return { tone: "warn", text: parts.join(" · "), problemKey: "stale:" + stale.slice().sort().join(",") };
    }
    if (waiting.length > 0) {
      parts.push(waiting.length === 1
        ? waiting[0] + ": wartet auf Daten"
        : waiting.length + " warten auf Daten");
      // Waiting-for-first-data is a normal commissioning state, not a fault -
      // gray dot, no auto-open (the operator just added the source and is
      // already looking at it).
      return { tone: "off", text: parts.join(" · "), problemKey: null };
    }
    parts.push(sources.length > 0 ? "alle liefern" : "liefert Daten");
    return { tone: "ok", text: parts.join(" · "), problemKey: null };
  }

  /* ------------------------------------------------------------------
     ② Steuerung - "Batterie freigegeben · Abregelung nicht freigegeben".
     The row carries the RELEASE facts + the dot; the full warning message
     (mismatch/blocked/override, with its stable "seit" stamp) renders exactly
     once INSIDE the group, on the Zustand & Bestätigung card (control.js).
     ------------------------------------------------------------------ */
  function steuerungSummary(s) {
    s = s || {};
    var inv = s.inverter;
    if (!inv || !inv.configured) {
      return { tone: "off", text: "Zuerst den Wechselrichter verbinden", problemKey: null };
    }

    var parts = [];
    var tone = "off";
    // Battery release: the per-device First-Light grant the core reports.
    if (s.control_certified === true) {
      parts.push("Batterie freigegeben");
      tone = "ok";
    } else {
      parts.push("Batterie nicht freigegeben");
    }
    // PV curtailment release, only when the device reports units at all.
    var units = s.curtail_units || [];
    if (units.length > 0) {
      var cert = 0;
      for (var i = 0; i < units.length; i++) if (units[i].certified) cert++;
      parts.push(cert === units.length ? "Abregelung freigegeben"
        : cert > 0 ? "Abregelung teilweise freigegeben"
          : "Abregelung nicht freigegeben");
    }
    if (s.mode === "kalibrierung") parts.push("Kalibrierung läuft");
    if (s.control_certified === true && s.control_enabled === false) {
      // The deliberate kill-switch: stated, but never an auto-open alarm.
      parts.push("Steuerung ausgeschaltet");
      tone = "off";
    }

    // Warn states open the group; the message itself lives once on the card
    // inside (with its "Zustand seit HH:MM" stamp) - the row only carries the dot.
    // The problem key follows the CORE's DEBOUNCED confirmation state: a single
    // deviating readback cycle (or one the inverter never answered) must not open
    // the group - that is the ~10 s flap the 2026-07-30 fix removed. An older core
    // sends no `confirm`, so the pre-fix reading applies unchanged there.
    var c = s.control;
    var problemKey = null;
    if (c && c.blocked && c.reason) {
      problemKey = "blocked:" + c.reason;
    } else if (c && c.registers && c.registers.length > 0) {
      var conf = c.confirm || (c.all_match ? "held" : "not_held");
      if (conf === "not_held") problemKey = "mismatch:" + (c.mismatch_roles || []).join(",");
      else if (conf === "no_answer") problemKey = "no_answer";
    }
    for (var j = 0; j < units.length && !problemKey; j++) {
      var u = units[j];
      if (u.possible_override) problemKey = "curtail-override:" + (u.source_id || j);
      else if (u.applied && u.mode === "apply" && u.all_match === false) problemKey = "curtail-mismatch:" + (u.source_id || j);
      else if (u.blocked) problemKey = "curtail-blocked:" + (u.reason || j);
    }
    if (problemKey) tone = "warn";

    return { tone: tone, text: parts.join(" · "), problemKey: problemKey };
  }

  /* ------------------------------------------------------------------
     ③ Datenfreigabe - "Aus" / "An · 192.168.0.10:502 · nur Lesen".
     Input: the /api/mirror object + the page host (the mirror listens on the
     same address the browser reached).
     ------------------------------------------------------------------ */
  function datenfreigabeSummary(m, host) {
    // NOT YET KNOWN is not "Aus" (Backlog vp-mirror-blocks-anzeige, Befund 2):
    // the head used to claim the mirror was off until mirror.js's first poll
    // answered, so a running mirror read "Aus + grauer Punkt" over a card
    // showing "Bereit". Unknown says so; the state arrives within one poll.
    if (!m) return { tone: "off", text: "…", problemKey: null };
    if (!m.enabled) return { tone: "off", text: "Aus", problemKey: null };
    if (m.error) {
      return { tone: "warn", text: "An · Fehler", problemKey: "mirror:" + m.error };
    }
    if (!m.running) return { tone: "off", text: "An · startet …", problemKey: null };
    return {
      tone: "ok",
      text: "An · " + (host || "") + ":" + (m.advertise_port || 502) + " · nur Lesen",
      problemKey: null
    };
  }

  /* ------------------------------------------------------------------
     ④ Erweitert - rare, deliberate settings. Always quiet, never auto-opens;
     "Daten löschen" keeps its red framing + type-to-confirm INSIDE.
     ------------------------------------------------------------------ */
  function erweitertSummary() {
    return { tone: "off", text: "Netzmessung · Ausreißer-Filter · Daten löschen", problemKey: null };
  }

  // shouldAutoOpen: a group opens ITSELF exactly when a NEW problem appears
  // (null -> key, or key A -> key B). The same standing problem re-derived on
  // every poll tick never re-opens a group the operator closed - and nothing
  /* ------------------------------------------------------------------
     EIGENE GERÄTE (Einheitsmodell Stufe 3/4) - die Geräte, die der KUNDE
     im Portal selbst angelegt hat.

     Sie sind die eine Komponentenklasse, die der Applier bewusst überspringt:
     ihr Leseplan reist als generierter Flow über `v2/flows`, sie landen also
     nie in `sources.json` - und tauchten damit auf dieser Seite NIRGENDS auf
     (Scout `vp-portal-box-spiegel-s2`, L5: „der Kunde sieht sein eigenes Gerät
     nur im Portal"). Die Gruppe ist reine ANZEIGE und ohne jede Bedienung:
     angelegt, geändert und gelöscht wird ein Selbstbau-Gerät im Portal.

     ⚠ Die Pille sagt, WAS die Box wirklich gesehen hat - nie „wartet auf erste
     Daten" wie bei einer Quelle. Die Box POLLT dieses Gerät gar nicht selbst;
     ohne Messwert ist die ehrliche Aussage der MECHANISMUS, nicht ein Warten,
     das niemand tut.
     ------------------------------------------------------------------ */

  var EIGEN_GELESEN_VON_REGEL = "Wird über eine Regel gelesen";

  function eigenPill(health) {
    if (health === "ok") return { dot: "ok", pill: "ok", label: "Liefert Daten" };
    if (health === "stale") return { dot: "warn", pill: "warn", label: "Keine aktuellen Daten" };
    return { dot: "off", pill: "off", label: EIGEN_GELESEN_VON_REGEL };
  }

  // eigenAdresse renders host[:port] and the Modbus unit - and NOTHING when the
  // push carries no address: a device we cannot address is still a real device,
  // but its address must never be invented.
  function eigenAdresse(d) {
    d = d || {};
    if (!d.host) return "";
    var a = d.port ? d.host + ":" + d.port : d.host;
    return d.unit_id ? a + " · Unit " + d.unit_id : a;
  }

  // eigenesGeraetRow is everything ONE row of the group shows. Pure: same input,
  // same row - unit-testable without a browser.
  function eigenesGeraetRow(d) {
    d = d || {};
    var meta = ["Selbstbau (Modbus)"];
    var addr = eigenAdresse(d);
    if (addr) meta.push(addr);
    var chans = (d.channels || []).map(function (c) {
      return (c.label || c.channel) + (c.unit ? " (" + c.unit + ")" : "");
    });
    if (chans.length) meta.push(chans.join(", "));
    if (d.switchable) meta.push("schaltbar (im Portal freigegeben)");
    return {
      name: d.label || d.id || "Eigenes Gerät",
      meta: meta.join(" · "),
      pill: eigenPill(d.health)
    };
  }

  // eigenNote is the group's head count ("· 2 eigene Geräte").
  function eigenNote(list) {
    var n = (list || []).length;
    return "· " + n + (n === 1 ? " eigenes Gerät" : " eigene Geräte");
  }

  // ever auto-CLOSES.
  function shouldAutoOpen(prevKey, key) {
    return !!key && key !== prevKey;
  }

  // groupForAnchor maps the legacy deep-link anchors (redirects, commissioning
  // step actions, printed install sheets) onto the group that must open so the
  // target is actually visible. null = not inside the accordion (e.g. #portal).
  var ANCHOR_GROUP = {
    anlage: "anlage",
    wechselrichter: "anlage",
    quellen: "anlage",
    steuerung: "steuerung",
    datenfreigabe: "datenfreigabe",
    erweitert: "erweitert",
    messwerte: "erweitert"
  };
  function groupForAnchor(name) {
    return ANCHOR_GROUP[name] || null;
  }

  global.VPGroups = {
    FRESH_SECONDS: FRESH_SECONDS,
    anlageSummary: anlageSummary,
    EIGEN_GELESEN_VON_REGEL: EIGEN_GELESEN_VON_REGEL,
    eigenesGeraetRow: eigenesGeraetRow,
    eigenAdresse: eigenAdresse,
    eigenNote: eigenNote,
    steuerungSummary: steuerungSummary,
    datenfreigabeSummary: datenfreigabeSummary,
    erweitertSummary: erweitertSummary,
    shouldAutoOpen: shouldAutoOpen,
    groupForAnchor: groupForAnchor
  };
})(window);
