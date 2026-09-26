// VoltPilot Edge - the control surface. Read-only. Nothing here commands the
// inverter; it renders what the core already decided.
//
// TWO layers, and the split is the point:
//   1. deriveState(s) - a PURE function returning the plain-German STATE of the
//      control path plus, whenever something is wrong, its `reason`. This is
//      what the customer sees on "Betrieb", ALWAYS, with Technikmodus OFF.
//   2. the register table (commanded vs. actual per register, the control path
//      name, the remote status register) - the technician's evidence. On
//      "Betrieb" it sits in a `.tech-only` block; on "Einrichten" the same
//      markup is rendered without that class, because commissioning IS the
//      moment you need it.
// A hidden register table therefore never hides a CAUSE - the cause is in
// layer 1, in normal mode.
//
// Data path: the page controller hands each streamed device state to
// VPControl.onState(state); this reads state.control (the latest edge/control/
// readback the core folded into the snapshot) + state.control_enabled /
// state.control_certified / state.inverter to pick the right honest state.
(function (global) {
  "use strict";

  var $ = function (id) { return global.document.getElementById(id); };
  var nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  var clockOffset = 0;
  function syncClock(ms) { if (ms) clockOffset = ms - Date.now(); }
  function ago(iso) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    var s = Math.max(0, Math.round((Date.now() + clockOffset - t) / 1000));
    if (s < 60) return "vor " + s + " s";
    if (s < 3600) return "vor " + Math.round(s / 60) + " Min.";
    return "vor " + Math.round(s / 3600) + " Std.";
  }

  // Plain-German label per control role (no Modbus jargon leaks into the table
  // text beyond the register address, which the technician needs).
  var ROLE_LABEL = {
    battery_power: "Batterie-Leistung",
    control_enable: "Steuerung aktiv",
    pv_limit: "PV-Begrenzung",
    work_mode: "Arbeitsmodus",
    grid_charge_enable: "Netzladen",
    battery_target_soc: "Ziel-SoC",
    // Deye REMOTE MODE (registers 1100-1121) - the Tier-2 signed-watt setpoint.
    remote_mode: "Fernsteuerung aktiv",
    remote_watchdog: "Totmannschalter",
    power_control_mode: "Regelseite",
    battery_strategy: "Regelstrategie",
    battery_soc_belt: "SoC-Grenze im Gerät",
    // Netz-Sollwert-Test (Konzept `vp-deye-netzseitig-drossel-k2` P1). Drei Rollen
    // auf DERSELBEN Adresse 1109 - die Beschriftung ist das Einzige, woran ein
    // Mensch in der Register-Tabelle sieht, welche Regelseite gerade gilt.
    grid_power: "Netz-Sollwert",
    ac_power: "AC-Sollwert",
    grid_neutral: "Neutralschritt",
    pv_max_permille: "PV-Kappe im Gerät",
  };

  // The control PATH this inverter is being steered through. Plain German, because
  // the operator must be able to see WHICH surface is driving the battery.
  var PATH_LABEL = {
    remote: "Fernsteuerung (Remote Mode)",
    tou: "Zeitfenster-Steuerung (ToU)",
  };
  var PATH_HINT = {
    remote: "Direkter Leistungssollwert. Der Wechselrichter bricht die Steuerung von " +
      "selbst ab, wenn VoltPilot verstummt - Ihre Einstellungen werden dabei nicht verändert.",
    tou: "Steuerung über ein Zeitfenster-Programm des Wechselrichters.",
  };

  // Plain-German label per readback source. "calibration" = a First-Light test
  // write (the source the uncertified-device evidence path renders).
  var SRC_LABEL = { schedule: "Fahrplan", "default": "Eigenverbrauch", calibration: "Kalibrier-Test" };

  var MISMATCH_CONFLICT =
    "Der Wechselrichter hält den Sollwert nicht. Möglicher Konflikt: die eigene " +
    "Smart-Steuerung des Wechselrichters oder ein zweites EMS könnte gegensteuern - " +
    "VoltPilot muss der einzige Controller sein (alternativ: Strom-/SoC-Grenze oder Register-Adresse prüfen).";
  var MISMATCH_PLAIN =
    "Der Wechselrichter hat den Sollwert nicht übernommen. " +
    "Mögliche Ursache: Strom-/SoC-Grenze oder eine falsche Register-Adresse.";
  // Silence is its OWN state, never "not adopted": the setpoint was written and is
  // still active, only the confirmation is missing (typically a Solarman logger that
  // cannot reach the inverter right now). Naming it correctly is the whole point of
  // the 2026-07-30 flap fix.
  var NO_ANSWER =
    "Der Wechselrichter antwortet gerade nicht auf die Rückfrage, ob er den Sollwert " +
    "hält. Der geschriebene Sollwert bleibt aktiv - es fehlt nur die Bestätigung. " +
    "Hält das an, ist meist die Verbindung zum Wechselrichter (Datenlogger/Netzwerk) die Ursache.";
  var NOT_CONFIRMED_YET =
    "Der Sollwert ist geschrieben, der Wechselrichter hat ihn aber noch nicht " +
    "bestätigt zurückgemeldet.";

  // The confirmation state the card renders. `confirm` is computed by the CORE
  // (agent.applyControlConfirm): one deviating readback cycle is a flicker, and only
  // a CONFIRMED run of them ("not_held") is a warning. An older core sends no
  // `confirm`, so it falls back to the pre-fix two-state reading.
  function confirmState(c) {
    if (c.confirm) return c.confirm;
    return c.all_match ? "held" : "not_held";
  }

  /* ------------------------------------------------------------------
     Layer 1: the pure state derivation.

     Returns { chip: {tone,label}|null, title, text, showNow, showTable,
               calibrating, banner }
     `text` is the plain-German REASON whenever something is not simply fine -
     it is always rendered in normal mode. The branch ORDER is byte-identical
     to the pre-rebuild logic; only the rendering moved.
     ------------------------------------------------------------------ */
  function deriveState(s) {
    if (!s) return null;
    var inv = s.inverter;
    var c = s.control;

    // No inverter chosen yet -> the control surface is not applicable.
    if (!inv || !inv.configured) {
      return {
        chip: null,
        title: "Noch keine Steuerung.",
        text: "Wählen Sie zuerst Ihren Wechselrichter aus. Danach schreibt VoltPilot den " +
          "Fahrplan und liest ihn zurück - hier sehen Sie, ob der Wechselrichter ihn übernimmt.",
        showNow: false, showTable: false, calibrating: false, banner: null,
        stateKey: "no-inverter"
      };
    }

    // First-Light calibration is the chicken-and-egg case: the model is (still)
    // UNCERTIFIED, yet the calibration write produced a register readback - and on
    // an uncertified device a readback can ONLY come from a calibration test
    // (production writes nothing until the family is certified). That evidence must
    // not be swallowed by the read-only banner. Showing evidence certifies NOTHING.
    var calibrating = s.control_certified === false && !!(c && c.registers && c.registers.length > 0);

    // Selected but not bench-certified AND no calibration evidence -> genuinely
    // read-only (keep the honest "not yet released" statement).
    if (s.control_certified === false && !calibrating) {
      return {
        chip: { tone: "muted", label: "nur lesen" },
        title: "Steuerung für dieses Modell noch nicht freigegeben.",
        text: "Dieser Wechselrichter wird ausgelesen, aber noch nicht gesteuert. Die " +
          "Freigabe erfolgt nach der Prüfung am Prüfstand.",
        showNow: false, showTable: false, calibrating: false, banner: null,
        stateKey: "uncertified"
      };
    }

    // No readback yet (certified path, but nothing written/confirmed so far).
    if (!c || !c.registers || !c.registers.length) {
      if (s.control_enabled === false) {
        return {
          chip: { tone: "muted", label: "ausgeschaltet" },
          title: "Steuerung ist ausgeschaltet.",
          text: "Die Wechselrichter-Steuerung ist als Sicherheitsvorgabe deaktiviert " +
            "(Not-Aus). VoltPilot liest weiter mit, schreibt aber nichts.",
          showNow: false, showTable: false, calibrating: false, banner: null,
          stateKey: "off"
        };
      }
      if (c && c.blocked && c.reason) {
        // The control plan is EMPTY because something is WRONG (an unknown
        // nameplate / power scale). Show the CAUSE the operator can act on
        // instead of an eternal "warte auf Rückmeldung".
        return {
          chip: { tone: "warn", label: "angehalten" },
          title: "Steuerung kann gerade nicht ausgeführt werden.",
          text: c.reason,
          showNow: false, showTable: false, calibrating: false, banner: null,
          // keyed WITH the reason: a different cause is a different state (its own
          // "seit"), the SAME cause re-reported every readback stays one state.
          stateKey: "blocked:" + c.reason
        };
      }
      return {
        chip: { tone: "brand", label: "wartet" },
        title: "Noch keine Rückmeldung.",
        text: "Sobald der erste Sollwert geschrieben und zurückgelesen wurde, erscheint " +
          "hier die Bestätigung des Wechselrichters.",
        showNow: false, showTable: false, calibrating: false, banner: null,
        stateKey: "waiting"
      };
    }

    // A readback exists. FOUR outcomes, and telling them apart is the fix:
    //   held/checking - the inverter is holding what we command (a single deviating
    //                   cycle is a flicker; the count lives in the tech note)
    //   no_answer     - the readback got no answer for a while: honest, calm, NOT
    //                   "not adopted"
    //   pending       - written, never yet confirmed
    //   not_held      - a CONFIRMED refusal: the warning, with its cause
    var st = confirmState(c);
    if (st === "held" || st === "checking") {
      return {
        chip: { tone: "ok", label: calibrating ? "Kalibrierung ✓" : "bestätigt" },
        title: calibrating ? "Kalibrier-Test bestätigt." : "VoltPilot steuert die Anlage.",
        text: calibrating
          ? "Der Testbefehl wurde geschrieben und vom Wechselrichter unverändert zurückgelesen."
          : "Der Wechselrichter hat den geschriebenen Sollwert unverändert zurückgemeldet.",
        showNow: true, showTable: true, calibrating: calibrating, banner: null,
        // The state key deliberately does NOT change while a flicker is being
        // checked: the "Zustand seit" stamp must not move for noise.
        stateKey: calibrating ? "ok-cal" : "ok"
      };
    }
    if (st === "no_answer") {
      return {
        chip: { tone: "warn", label: "keine Rückmeldung" },
        title: "Keine Bestätigung vom Wechselrichter.",
        text: (c.reason || NO_ANSWER),
        showNow: true, showTable: true, calibrating: calibrating, banner: null,
        stateKey: "no-answer"
      };
    }
    if (st === "pending") {
      return {
        chip: { tone: "brand", label: "wartet" },
        title: "Noch keine Bestätigung.",
        text: NOT_CONFIRMED_YET,
        showNow: true, showTable: true, calibrating: calibrating, banner: null,
        stateKey: "not-confirmed"
      };
    }
    var reason = c.possible_conflict ? MISMATCH_CONFLICT : MISMATCH_PLAIN;
    var mmRoles = (c.mismatch_roles || []).join(",");
    return {
      chip: { tone: "warn", label: calibrating ? "Kalibrierung: Abweichung" : "Abweichung" },
      title: calibrating
        ? "Kalibrier-Test: der Wechselrichter weicht ab."
        : "Der Wechselrichter übernimmt den Sollwert nicht.",
      text: reason,
      // ONE message, ONE place: the reason lives in `text` (with its stable
      // "seit" stamp) - the old extra `banner` rendered the SAME paragraph a
      // second time on the same card, and with the ~10 s readback cadence the
      // page read as a warning fired every tick (live Pilsting, 2026-07-28).
      showNow: true, showTable: true, calibrating: calibrating, banner: null,
      stateKey: (calibrating ? "mismatch-cal:" : "mismatch:") + mmRoles
    };
  }

  /* ------------------------------------------------------------------
     The REASON line: why the setpoint is what it is.

     "Fahrplan-Sollwert 10,8 kW -> Wechselrichter bestätigt 10,8 kW" reads like a
     stubborn order and is exactly what made the owner ask whether that is smart
     (Pilsting, 2026-07-30). The card therefore names the reason underneath - and
     the ONE reason the DEVICE itself owns is the price-aware in-slot trim: the
     cloud marked this slot's grid purchases uneconomic, so the commanded charge
     is being held at the measured solar surplus.

     Deliberately no second explain logic here: the per-slot Fahrplan reason
     (roles, water value) lives in the cloud's why-layer and is rendered by the
     PORTAL card, which has that data. The edge explains what the edge decided.
     No trim -> no line, and the card reads exactly as before.
     ------------------------------------------------------------------ */
  function deriveTrim(s) {
    var t = s && s.trim;
    if (!t || !t.active) return null;
    var held = t.surplus_kw != null ? nf1.format(t.surplus_kw) + " kW" : null;
    var planned = t.planned_kw != null ? nf1.format(t.planned_kw) + " kW" : null;
    var text =
      "Auf den gemessenen Solarüberschuss begrenzt" + (held ? " (" + held + ")" : "") +
      ": Netzstrom ist in dieser Viertelstunde teurer als der Wert der zusätzlich " +
      "gespeicherten Energie" + (planned ? " – der Fahrplan wollte " + planned : "") +
      ". Das ist eine bewusste Begrenzung, kein Fehler des Wechselrichters.";
    return { text: text };
  }

  /* ------------------------------------------------------------------
     The DISCHARGE-side mirror: in-slot load following, BOTH directions.

     "Fahrplan-Sollwert -4,3 kW -> bestätigt -4,3 kW" while the house draws
     7,1 kW and the difference is bought at ~32,5 ct is the night half of the
     same defect (Pilsting, 2026-07-30) - and its mirror image an hour later:
     -6,7 kW into a 5,1-kW-Haus, also 1,4 kW verschenkt. Where the cloud marked
     the slot worth covering, the device TRACKS the measured house load: it
     raises the discharge where the plan falls short and limits it where the plan
     overshoots. An unnamed correction reads as a defect just like an unnamed
     limitation, so the card says which of the two it did. Mutually exclusive
     with the trim by construction (one acts on charge, the other on discharge).
     ------------------------------------------------------------------ */
  function deriveFollow(s) {
    var f = s && s.follow;
    if (!f || !f.active) return null;
    var covered = f.deficit_kw != null ? " (" + nf1.format(f.deficit_kw) + " kW)" : "";
    var planned = f.planned_kw != null
      ? " – der Fahrplan hatte " + nf1.format(Math.abs(f.planned_kw)) + " kW vorgesehen"
      : "";
    var head;
    if (f.direction === "reduce") {
      // The 23:12 half: the plan discharged past the house, so the difference
      // was leaving the site. The honest cause is the giveaway, not the import.
      head =
        "Folgt dem gemessenen Hausverbrauch" + covered + " – Entladung begrenzt: " +
        "was darüber hinausgeht, würde ins Netz abfließen, wo die gespeicherte " +
        "Energie weniger einbringt, als sie später wert ist";
    } else {
      // "deepen" and - defensively - an older device that reports no direction:
      // never claim one it did not send.
      head =
        "Deckt den gemessenen Hausverbrauch aus dem Speicher" + covered +
        (f.direction === "deepen" ? " – Entladung angehoben" : "") +
        ": Netzstrom ist in dieser Viertelstunde teurer als die gespeicherte Energie";
    }
    return {
      text: head + planned +
        ". Das ist eine bewusste Nachführung, kein Fehler des Wechselrichters."
    };
  }

  /* ------------------------------------------------------------------
     The CHARGE-side counterpart that RAISES: in-slot surplus absorption.

     "Fahrplan-Sollwert 0,0 kW -> bestätigt 0,0 kW" while 23,9 kW of PV meets a
     4,3-kW-Haus and 16,6 kW leaves the site at a NEGATIVE price - with the
     battery at 7 % SoC - is the morning half of the same defect (Pilsting,
     2026-08-02). Where the cloud marked storing worth more than selling, the
     device RAISES the charge to the measured surplus. A setpoint far ABOVE the
     Fahrplan value with no reason next to it reads as a defect just like a
     limitation does, so the card names it. Disjoint from the other two by
     construction (it only ever raises a non-negative command, up to the
     surplus).
     ------------------------------------------------------------------ */
  function deriveAbsorb(s) {
    var a = s && s.absorb;
    if (!a || !a.active) return null;
    var stored = a.surplus_kw != null ? " (" + nf1.format(a.surplus_kw) + " kW)" : "";
    var planned = a.planned_kw != null
      ? " – der Fahrplan hatte " + nf1.format(a.planned_kw) + " kW vorgesehen"
      : "";
    if (a.path === "surplus_store") {
      return {
        text: "Lädt den gemessenen Solarüberschuss" + stored +
          " – Ladung angehoben" + planned +
          ". Der Fahrplan hatte den Überschuss zu niedrig geschätzt; " +
          "gespeichert wird nur, was gemessen übrig ist – Netzstrom nie."
      };
    }
    var text =
      "Lädt den gemessenen Solarüberschuss" + stored + " – Ladung angehoben: " +
      "die gespeicherte Energie ist mehr wert als die Einspeisung in dieser " +
      "Viertelstunde einbringt" + planned +
      ". Das ist eine bewusste Nachführung, kein Fehler des Wechselrichters.";
    return { text: text };
  }

  /* ------------------------------------------------------------------
     deriveNative - „Wechselrichter-Automatik" (Selbstregel-Modus).

     In a slot the cloud marked worth covering from the battery, the SETPOINT
     ITSELF was handed back to the inverter: it now decides how many watts to
     pull, and VoltPilot writes nothing for the rest of the slot. That is the
     outermost fact about this quarter hour, so it LEADS the reason chain - while
     it holds, no setpoint is being written at all, and naming one of the in-slot
     corrections here would explain a value nobody sent.

     It keeps „gewollt" and „bestätigt" apart, because „wir haben aufgehört zu
     schreiben" and „VoltPilot ist gestorben" must never read the same on a
     surface. The German sentence is the CORE's (guards.NativeMode writes it
     once); this card renders it and invents nothing.
     ------------------------------------------------------------------ */
  function deriveNative(s) {
    var n = s && s.native;
    if (!n || !n.active) return null;
    // The reference value is still computed and published so the take-back is
    // instant and the surfaces have a number - it is simply not written.
    var ref = (typeof n.reference_kw === "number" && isFinite(n.reference_kw))
      ? " (Vergleichswert: " + nf1.format(n.reference_kw) + " kW)" : "";
    var head = n.proven
      ? "Wechselrichter-Automatik (hält): VoltPilot schreibt in dieser Viertelstunde " +
        "keinen Sollwert" + ref + "."
      : "Wechselrichter-Automatik angefordert: bis der Wechselrichter sie bestätigt, " +
        "führt VoltPilot den Sollwert weiter nach" + ref + ".";
    return {
      text: head + (n.text ? " " + n.text : "") +
        " Das ist eine bewusste Übergabe, kein Fehler des Wechselrichters."
    };
  }

  /* ------------------------------------------------------------------
     deriveCarsFirst - „Auto vor Speicher" (OCPP-Lastmanagement Stufe 4).

     The customer decided their VEHICLES get the PV surplus before the battery
     does, so while cars are drawing the battery may only charge what is left
     of the measured surplus. A battery that suddenly charges far below the
     Fahrplan value with no reason next to it reads as a defect - so the card
     names the choice that caused it. It is restrict-only and charge-only:
     nothing here can raise a setpoint or touch a discharge.
     ------------------------------------------------------------------ */
  function deriveCarsFirst(s) {
    var cap = s && s.cars_first_cap_kw;
    if (cap === null || cap === undefined) return null;
    return {
      text: "Die Ladung ist auf " + nf1.format(cap) + " kW begrenzt: Ihre Fahrzeuge " +
        "bekommen den Sonnenüberschuss zuerst (Ihre Wahl „Auto vor Speicher“). " +
        "Der Speicher lädt, was davon übrig bleibt.",
    };
  }

  /* ------------------------------------------------------------------
     trackStateSince - the stable "seit <Uhrzeit>" behind the card's ONE truth.

     The underlying readback re-fires every ~10 s tick, so any timestamp taken
     per render churns and the card reads like a NEW warning every tick (the
     live flap symptom). This pure helper keeps the FIRST-seen time of the
     current stateKey: the record only changes when the state itself changes,
     so the rendered "Zustand seit 14:51 Uhr" stays put while the state holds.
     Session-scoped by design (a page reload starts a fresh observation window;
     the readback carries no server-side state history to be more precise from).
     ------------------------------------------------------------------ */
  function trackStateSince(prev, key, nowMs) {
    if (prev && prev.key === key) return prev;
    return { key: key, at: nowMs };
  }

  var sinceRec = null;
  var timeFmt = null;
  function fmtSince(atMs) {
    try {
      if (!timeFmt) timeFmt = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
      return timeFmt.format(new Date(atMs));
    } catch (e) {
      return "";
    }
  }

  /* ---------------------------- rendering ---------------------------- */

  var CHIP_COLOR = {
    ok: "var(--batt, #34c759)",
    warn: "var(--warn, #ff9500)",
    muted: "var(--muted, #9aa4b2)",
    brand: "var(--brand, #6a8cff)"
  };

  function show(el, on) { if (el) el.hidden = !on; }

  function fmtKw(kw) { return (kw == null ? "–" : nf1.format(kw) + " kW"); }
  function fmtCell(reg, kwField) {
    // "−4,0 kW (4000)" for a power register; "1" style raw for flags. A register
    // WITHOUT an answer has actual_raw null (never a fabricated 0) -> "–".
    var kw = reg[kwField];
    var raw = kwField === "commanded_kw" ? reg.commanded_raw : reg.actual_raw;
    if (raw == null && kw == null) return "–";
    if (kw != null) return fmtKw(kw) + " (" + raw + ")";
    return "" + raw;
  }

  // Per-register verdict: 'unread' is neither a hold nor a deviation (the inverter
  // did not answer this register). An older Layer 1 sends no verdict, so `match` is
  // the only truth there and 'unread' cannot occur.
  function regVerdict(r) {
    if (r.verdict === "held" || r.verdict === "mismatch" || r.verdict === "unread") return r.verdict;
    return r.match ? "held" : "mismatch";
  }
  var REG_VERDICT_TEXT = { held: "✓ bestätigt", mismatch: "⚠ Abweichung", unread: "– keine Antwort" };
  var REG_VERDICT_CLASS = { held: "ok", mismatch: "bad", unread: "" };

  function renderTable(c, calibrating) {
    var rows = $("ctrlRows");
    if (!rows) return;
    rows.innerHTML = "";
    for (var j = 0; j < c.registers.length; j++) {
      var r = c.registers[j];
      var v = regVerdict(r);
      var tr = global.document.createElement("tr");
      if (v === "mismatch") tr.className = "mismatch";
      var label = (ROLE_LABEL[r.role] || r.role) + ' <span class="ctrl-addr">Reg ' + r.addr + "</span>";
      if (r.note) label += ' <span class="ctrl-addr">' + r.note + "</span>";
      tr.innerHTML =
        "<td>" + label + "</td>" +
        "<td>" + fmtCell(r, "commanded_kw") + "</td>" +
        "<td>" + fmtCell(r, "actual_kw") + "</td>" +
        '<td class="ctrl-verdict ' + REG_VERDICT_CLASS[v] + '">' + REG_VERDICT_TEXT[v] + "</td>";
      rows.appendChild(tr);
    }

    // The technical note: which surface is steering + the remote status register
    // + the readback age. Detail on top of the sentence above, never instead.
    var note = $("ctrlTechNote");
    if (note) {
      var bits = [];
      bits.push("Familie " + (c.family || "unbekannt"));
      if (c.control_path && PATH_LABEL[c.control_path]) {
        bits.push("Steuerpfad: " + PATH_LABEL[c.control_path]);
        if (c.control_path === "remote" && c.remote_status_raw != null) {
          bits.push("Status-Register 1121: " + c.remote_status_raw);
        }
      }
      if (calibrating) bits.push("Quelle: Kalibrier-Test");
      // The DETAIL behind the debounce: a deviation being checked, or a run of
      // unanswered cycles. Detail beneath the sentence above, never instead of it.
      if (c.mismatch_cycles > 0) bits.push("Abweichung in " + c.mismatch_cycles + " Prüfzyklus/-zyklen (Warnung ab 3)");
      if (c.unconfirmed_cycles > 0) bits.push("ohne Antwort: " + c.unconfirmed_cycles + " Zyklen" + (c.unread_roles && c.unread_roles.length ? " (" + c.unread_roles.join(", ") + ")" : ""));
      bits.push("geprüft " + (ago(c.checked_at) || "gerade eben"));
      note.textContent = bits.join(" · ");
      note.title = (c.control_path && PATH_HINT[c.control_path]) || "";
    }
  }

  function renderNow(s, c, calibrating) {
    var val = $("ctrlCmdVal");
    if (!val) return;
    var batt = null;
    for (var i = 0; i < c.registers.length; i++) {
      if (c.registers[i].role === "battery_power") { batt = c.registers[i]; break; }
    }
    val.textContent = batt && batt.commanded_kw != null ? nf1.format(batt.commanded_kw) : "–";
    var lbl = $("ctrlCmdLabel");
    if (lbl) lbl.textContent = calibrating ? "Kalibrier-Sollwert" : "Fahrplan-Sollwert";
    var badge = $("ctrlModeBadge");
    if (badge) {
      badge.textContent = SRC_LABEL[c.source] || "–";
      badge.className = "plan-now-badge " + (c.source === "schedule" ? "charge" : "idle");
    }
    var sub = $("ctrlNowSub");
    if (sub) {
      // "Steuerung ausgeschaltet" is a CAUSE, so it stays in normal mode.
      sub.textContent = (calibrating ? "Kalibrier-Test · " : "") +
        "Geprüft " + (ago(c.checked_at) || "gerade eben") +
        (s.control_enabled === false ? " · Steuerung ausgeschaltet" : "");
    }
  }

  /* ------------------------------------------------------------------
     PV-Abregelung (Fronius Increment 3): the per-unit curtailment evidence.
     Same two-layer split: deriveCurtail(s) is PURE and returns the plain-
     German state + its CAUSE (always rendered in normal mode); the per-unit
     register tables are the technician's evidence beneath it. Hidden entirely
     while the device reports no curtailment units (older build / no Fronius
     sources) - byte-identical page then.
     ------------------------------------------------------------------ */
  var CURTAIL_ROLE_LABEL = {
    pv_limit_pct: "PV-Begrenzung (%)",
    pv_limit_revert_tms: "Rückfall-Timer",
    pv_limit_enable: "Begrenzung aktiv",
  };
  var ENFORCE_LABEL = {
    ok: "Wirkung bestätigt",
    settling: "Wirkung wird geprüft …",
    unknown: "Wirkung nicht prüfbar (kein aktueller Messwert)",
    inactive: "",
    possible_override: "Möglicher Override",
  };

  /* ------------------------------------------------------------------
     Dynamische Einspeisebegrenzung am Netzverknüpfungspunkt.

     The German sentence is NOT written here: guards.ExportLimiter writes it
     once (state + reason travel together, the target_verdict-beside-state
     pattern), so this page and the cloud can never word the same verdict
     differently. This function only decides the TONE and puts the two
     sentences the core owns - the state's reason and the reach - in order.

     The reach is the safety-critical half: the operator is preparing to
     disconnect the customer's own controller, so a watchdog that computes a
     perfect cap and writes it NOWHERE must say so instead of letting anyone
     rely on a protection that does not exist.
     ------------------------------------------------------------------ */
  function deriveExportGuard(s) {
    var g = s && s.export_guard;
    if (!g || typeof g.limit_kw !== "number") return null;
    var text = "Einspeisegrenze " + nf1.format(g.limit_kw) + " kW. " + (g.reason || "");
    if (g.reach) text += " " + g.reach;
    // K6: the cascade with the leader's own regulation, and whether the limit
    // survives the box (the core writes both sentences).
    if (g.cascade_text) text += " " + g.cascade_text;
    var backstopMissing = !!g.backstop && !g.backstop_covered;
    if (backstopMissing) text += " " + g.backstop;
    return {
      // Not effective outranks everything (a plant that believes it is
      // protected and is not); running blind is a warning too - "the
      // measurement went away" must never look like "everything is fine" -
      // and so is a limit that only holds while the box lives.
      tone: (!g.effective || g.blind || backstopMissing) ? "warn" : "ok",
      backstopMissing: backstopMissing,
      title: g.effective
        ? "Einspeisegrenze wird überwacht."
        : "Einspeisegrenze NICHT wirksam.",
      text: text.trim(),
      effective: !!g.effective,
      blind: !!g.blind,
      limiting: !!g.limiting
    };
  }

  /* ------------------------------------------------------------------
     Die Einspeisegrenze, die der WECHSELRICHTER SELBST hält („Grenzen &
     Wächter" Stufe 0): eine fremde Wahrheit im Gerät, die die Box aus dessen
     eigenem Register LIEST und nie schreibt.

     In Herzogau hielt der Deye 33,0 kW in 0x00E7, während im Portal 70 kW
     hinterlegt waren - zwei Untersuchungsrunden lang unsichtbar, weil das
     Register niemand las.

     Das REGISTER steht bewusst hinter dem Technikmodus (die Zeile selbst nie):
     „auf 33,0 kW begrenzt" ist die Aussage, „0x00e7" der Beleg dafür.
     ------------------------------------------------------------------ */
  function deriveDeviceExportLimit(s) {
    var d = s && s.device_export_limit;
    if (!d || typeof d.limit_kw !== "number") return null;
    return {
      text: "Ihr Wechselrichter begrenzt die Einspeisung am Netzpunkt auf "
        + nf1.format(d.limit_kw) + " kW.",
      register: d.register || "",
      limitKw: d.limit_kw
    };
  }

  /* ------------------------------------------------------------------
     Die LIVE-Abregelung (Fix D): der Fahrplan regelt diesen Slot ab, und das
     Gerät folgt dabei der MESSUNG statt 15 Minuten auf dem Planwert zu stehen.

     Der deutsche Satz wird auch hier NICHT geschrieben - guards.CurtailTracker
     schreibt ihn einmal (state + reason reisen zusammen), damit diese Seite und
     die Cloud dieselbe Entscheidung nie verschieden benennen.

     Die Zeile erscheint nur, wenn der befohlene Wert wirklich vom Planwert
     abweicht: eine Korrektur ohne Grund daneben liest sich als Defekt, in
     BEIDE Richtungen - eine über den Planwert angehobene Kappe genauso wie eine
     darunter gezogene.
     ------------------------------------------------------------------ */
  function deriveCurtailTrack(s) {
    var c = s && s.curtail_track;
    if (!c || typeof c.cap_kw !== "number" || typeof c.plan_cap_kw !== "number") return null;
    if (Math.abs(c.cap_kw - c.plan_cap_kw) < 0.05) return null;
    return {
      text: c.reason || "",
      capKw: c.cap_kw,
      planCapKw: c.plan_cap_kw,
      blind: !!c.blind,
      raised: c.cap_kw > c.plan_cap_kw
    };
  }

  function deriveCurtail(s) {
    var eg = deriveExportGuard(s);
    var dl = deriveDeviceExportLimit(s);
    var d = deriveCurtailUnits(s);
    if (!d) {
      // No curtailment-capable unit at all. Without a feed-in limit AND without
      // a device limit there is nothing to say and the card stays hidden
      // (byte-identical page); WITH a limit, the card exists precisely to say
      // which one holds - and, for the watchdog, that it reaches nothing.
      if (!eg && !dl) return null;
      return {
        tone: eg ? eg.tone : "muted",
        units: [],
        title: eg ? eg.title : "Einspeisegrenze im Gerät",
        text: eg ? eg.text : dl.text,
        showTable: false,
        exportGuard: eg,
        curtailTrack: deriveCurtailTrack(s),
        // With no watchdog the device limit IS the card's sentence; repeating it
        // below would be noise.
        deviceLimit: eg ? dl : null
      };
    }
    d.exportGuard = eg;
    d.deviceLimit = dl;
    d.curtailTrack = deriveCurtailTrack(s);
    if (eg && !eg.effective) d.tone = "warn";
    return d;
  }

  function deriveCurtailUnits(s) {
    var units = s && s.curtail_units;
    if (!units || !units.length) return null;

    var overrideReason = null, blockedReason = null;
    var applied = 0, released = 0, observed = 0, capSum = 0, mismatch = false;
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.possible_override && !overrideReason) {
        overrideReason = u.override_reason ||
          "Ein Wechselrichter liefert mehr als seine Begrenzung erlaubt - " +
          "eine lokale Einstellung, Solar.web oder ein Smart Meter könnte die " +
          "Modbus-Begrenzung übersteuern. VoltPilot muss der einzige Controller sein.";
      }
      if (u.blocked && !blockedReason) blockedReason = u.reason || "Einheit nicht erreichbar.";
      if (u.applied && u.mode === "apply") {
        applied++;
        if (u.cap_kw != null) capSum += u.cap_kw;
        if (u.all_match === false) mismatch = true;
      } else if (u.applied && u.mode === "release") {
        released++;
      } else {
        observed++;
      }
    }

    if (overrideReason) {
      return {
        tone: "warn", units: units,
        title: "PV-Abregelung: möglicher Override.",
        text: overrideReason, showTable: true
      };
    }
    if (mismatch) {
      return {
        tone: "warn", units: units,
        title: "PV-Abregelung: der Wechselrichter übernimmt die Begrenzung nicht.",
        text: "Ein Begrenzungs-Register wurde geschrieben, liest aber anders zurück. " +
          "Modbus-Steuerung am Datamanager prüfen.",
        showTable: true
      };
    }
    if (applied > 0) {
      return {
        tone: "ok", units: units,
        title: "VoltPilot begrenzt die PV-Einspeisung.",
        text: "Der Fahrplan regelt gerade ab: " + applied + " Wechselrichter auf zusammen " +
          nf1.format(capSum) + " kW begrenzt (bestätigt).",
        showTable: true
      };
    }
    if (blockedReason) {
      return {
        tone: "warn", units: units,
        title: "PV-Abregelung: Einheit nicht erreichbar.",
        text: blockedReason, showTable: true
      };
    }
    if (released > 0 && observed === 0) {
      return {
        tone: "muted", units: units,
        title: "Keine PV-Begrenzung aktiv.",
        text: "Der Fahrplan sieht gerade keine Abregelung vor - die Wechselrichter laufen frei.",
        showTable: true
      };
    }
    // Observed-only: the plan may curtail, but no unit may be written yet -
    // THE honesty sentence (a plan step that cannot execute must never look
    // executed). The cause is named in normal mode.
    return {
      tone: "muted", units: units,
      title: "PV-Abregelung noch nicht freigegeben.",
      text: "Der Fahrplan kann eine Abregelung vorsehen, aber die Fronius-Wechselrichter " +
        "sind dafür noch nicht freigegeben - geplante Abregelung wird NICHT ausgeführt. " +
        "Freigabe: Einrichten → PV-Abregelung kalibrieren.",
      showTable: true
    };
  }

  function renderCurtailUnits(units) {
    var wrap = $("curtailUnits");
    if (!wrap) return;
    wrap.innerHTML = "";
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var div = global.document.createElement("div");
      div.className = "curtail-unit";
      var head = (u.label || u.source_id) + " · " + (u.target || u.unit_key) +
        " · " + (u.certified ? "freigegeben" : "nicht freigegeben") +
        (u.calibration ? " · Kalibrier-Test" : "");
      var rows = "";
      var regs = u.registers || [];
      for (var j = 0; j < regs.length; j++) {
        var r = regs[j];
        var label = (CURTAIL_ROLE_LABEL[r.role] || r.role) + ' <span class="ctrl-addr">Reg ' + r.addr + "</span>";
        rows += "<tr" + (u.applied && !r.match ? ' class="mismatch"' : "") + ">" +
          "<td>" + label + "</td>" +
          "<td>" + fmtCell(r, "commanded_kw") + "</td>" +
          "<td>" + fmtCell(r, "actual_kw") + "</td>" +
          '<td class="ctrl-verdict ' + (u.applied ? (r.match ? "ok" : "bad") : "") + '">' +
          (u.applied ? (r.match ? "✓ bestätigt" : "⚠ Abweichung") : "nur beobachtet") + "</td></tr>";
      }
      var bits = [];
      bits.push(u.mode === "apply"
        ? ("Begrenzung " + (u.cap_kw != null ? nf1.format(u.cap_kw) + " kW" : "–"))
        : "keine Begrenzung (freigegeben)");
      if (u.measured_kw != null) bits.push("gemessen " + nf1.format(u.measured_kw) + " kW");
      var enf = ENFORCE_LABEL[u.enforcement_status];
      if (enf) bits.push(enf);
      if (u.blocked && u.reason) bits.push(u.reason);
      bits.push("geprüft " + (ago(u.checked_at) || "gerade eben"));
      div.innerHTML =
        '<p class="tech-h">' + head + "</p>" +
        (rows
          ? '<div class="ctrl-table-wrap"><table class="ctrl-table"><thead>' +
            "<tr><th>Register</th><th>Befohlen</th><th>Wechselrichter</th><th>Status</th></tr>" +
            "</thead><tbody>" + rows + "</tbody></table></div>"
          : "") +
        '<p class="tech-note">' + bits.join(" · ") + "</p>";
      wrap.appendChild(div);
    }
  }

  function renderCurtail(s) {
    var card = $("curtailCard");
    if (!card) return;
    var d = deriveCurtail(s);
    show(card, !!d);
    if (!d) return;
    var title = $("curtailTitle");
    if (title) title.textContent = d.title;
    var text = $("curtailText");
    if (text) text.textContent = d.text;
    var sum = $("curtailSummary");
    if (sum) sum.className = "ctrl-summary " + d.tone;
    var dot = card.querySelector(".ss-dot");
    if (dot) dot.style.background = CHIP_COLOR[d.tone] || CHIP_COLOR.muted;
    // The watchdog line only appears NEXT TO a curtailment sentence; with no
    // units the guard IS the card's sentence and repeating it would be noise.
    var exp = $("curtailExport");
    if (exp) {
      var showExp = !!(d.exportGuard && d.units && d.units.length);
      show(exp, showExp);
      if (showExp) exp.textContent = d.exportGuard.text;
    }
    // Die LIVE-Abregelung steht daneben: sie erklärt, warum der befohlene Wert
    // vom Fahrplan abweicht. Ohne Abweichung sagt sie nichts (kein Rauschen).
    var trk = $("curtailTrack");
    if (trk) {
      show(trk, !!d.curtailTrack);
      if (d.curtailTrack) trk.textContent = d.curtailTrack.text;
    }
    // Die Grenze IM Gerät steht daneben - dieselbe Größe am selben Netzpunkt,
    // nur von jemand anderem gesetzt. Das REGISTER ist der Beleg und bleibt
    // Technikmodus; die Aussage steht immer.
    var dev = $("curtailDevice");
    if (dev) {
      show(dev, !!d.deviceLimit);
      if (d.deviceLimit) dev.textContent = d.deviceLimit.text;
    }
    var devReg = $("curtailDeviceReg");
    if (devReg) {
      var showReg = !!(d.deviceLimit && d.deviceLimit.register);
      show(devReg, showReg);
      if (showReg) devReg.textContent = "Register " + d.deviceLimit.register;
    }
    show($("curtailTech"), !!(d.units && d.units.length));
    renderCurtailUnits(d.units);
  }

  function onState(s) {
    var d = deriveState(s);
    if (!d) return;
    syncClock(s.server_now_ms);
    renderCurtail(s);

    var chipWrap = $("ctrlState");
    if (chipWrap) {
      show(chipWrap, !!d.chip);
      if (d.chip) {
        var dot = chipWrap.querySelector(".ss-dot");
        if (dot) dot.style.background = CHIP_COLOR[d.chip.tone] || CHIP_COLOR.muted;
        var t = $("ctrlStateText");
        if (t) t.textContent = d.chip.label;
      }
    }

    // Layer 1 - always visible, always names the reason. ONE stable truth: the
    // summary carries the state's FIRST-seen time ("Zustand seit …"), which only
    // moves when the state itself changes - never re-announced per readback tick.
    sinceRec = trackStateSince(sinceRec, d.stateKey || d.title, Date.now());
    var title = $("ctrlSummaryTitle");
    if (title) title.textContent = d.title;
    var text = $("ctrlSummaryText");
    if (text) {
      var since = fmtSince(sinceRec.at);
      text.textContent = d.text + (since ? " (Zustand seit " + since + " Uhr)" : "");
    }
    var summary = $("ctrlSummary");
    if (summary) summary.className = "ctrl-summary" + (d.chip ? " " + d.chip.tone : "");

    // The reason for the current setpoint - NORMAL mode, right under the state
    // it explains (a limitation that is not named reads as a defect).
    var reasonEl = $("ctrlReason");
    if (reasonEl) {
      // Order mirrors the setpoint chain, last correction first: the
      // absorption runs last, so where it bit its value is the published one.
      // Order mirrors the setpoint chain, last correction first. The
      // cars-first cap runs AFTER the absorption (with cars-first that surplus
      // is not the battery's to take), so where it bit its value is the
      // published one and it speaks first.
      // The native mode speaks FIRST: while the setpoint is handed over, none of
      // the in-slot corrections below is being written, so any of their lines
      // would explain a value that never left the box.
      var reason = d.showNow
        ? (deriveNative(s) || deriveCarsFirst(s) || deriveAbsorb(s) || deriveTrim(s) || deriveFollow(s))
        : null;
      show(reasonEl, !!reason);
      if (reason) reasonEl.textContent = reason.text;
    }

    var banner = $("ctrlBanner");
    if (banner) {
      show(banner, !!d.banner);
      if (d.banner) { banner.className = "ctrl-banner warn"; banner.textContent = "⚠ " + d.banner; }
    }

    show($("ctrlNow"), d.showNow);
    show($("ctrlTech"), d.showTable);
    if (d.showNow) renderNow(s, s.control, d.calibrating);
    if (d.showTable) renderTable(s.control, d.calibrating);
  }

  global.VPControl = {
    onState: onState,
    deriveState: deriveState,
    deriveTrim: deriveTrim,
    deriveFollow: deriveFollow,
    deriveAbsorb: deriveAbsorb,
    deriveNative: deriveNative,
    deriveCarsFirst: deriveCarsFirst,
    deriveCurtail: deriveCurtail,
    deriveExportGuard: deriveExportGuard,
    deriveCurtailTrack: deriveCurtailTrack,
    deriveDeviceExportLimit: deriveDeviceExportLimit,
    trackStateSince: trackStateSince,
    ROLE_LABEL: ROLE_LABEL,
    PATH_LABEL: PATH_LABEL
  };
})(window);
