// VoltPilot Edge - the guided commissioning flow on "Einrichten".
//
// Three steps, ending at "Daten kommen an". Coupling comes FIRST and is never
// locked: the box is coupled with the VoltPilot-Portal right away and its
// devices are then set up there. No device type is a prerequisite - neither
// for the coupling nor for the order of the steps. Releasing CONTROL is
// deliberately NOT part of it - that is its own, separately gated step further
// down the page (First-Light calibration behind the admin token).
//
// Everything here is DERIVED from what the existing APIs already report:
//   /api/state    pairing_state, cloud_connected, inverter.configured,
//                 inverter_link, last_telemetry, ocpp.chargers,
//                 charge_point_connected, ref
//   /api/sources  the further sources and own devices, plus portal_managed -
//                 Einheitsmodell Stufe 2
// No new endpoint, no new server state, no persisted "wizard progress" - the
// plant's real condition IS the progress.
//
// ⚠ Auf einer PORTAL-verwalteten Anlage ist diese Seite ein SPIEGEL: die Geräte
// werden im VoltPilot-Portal angelegt, hier ist nichts anzulegen. Der Flow sagt
// das dann auch, statt Handlungen zu versprechen, die auf dieser Box gesperrt
// sind (Befund L6). Lokal bleibt die Geräte-Einrichtung möglich, solange das
// Portal die Anlage nicht übernommen hat - sie kommt nur nicht mehr zuerst.
//
// Pure + side-effect free, so it is unit-testable without a browser
// (internal/web/jstest/ui.test.js).
(function (global) {
  "use strict";

  var FRESH_SECONDS = 90;

  function ageSeconds(iso, nowMs) {
    if (!iso) return null;
    var t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, (nowMs - t) / 1000);
  }

  // paired mirrors web.go's `paired()`: a certificate is on disk. geraet_entfernt
  // is deliberately NOT paired - the claim step re-opens so the customer can
  // re-add the device in the portal.
  function paired(st) {
    return st === "verbunden" || st === "zertifikat_erhalten" ||
      st === "cloud_getrennt" || st === "cloud_fehler";
  }

  function plural(n, one, many) { return n === 1 ? "1 " + one : n + " " + many; }

  // derive(state, sourceCount, nowMs, portalManaged) -> { steps, doneCount, activeNum, allDone }
  //
  // sourceCount = further sources + own devices from /api/sources.
  // Each step is { key, num, title, state, detail, cause, action }:
  //   state  "done" | "active" | "todo" | "blocked"
  //   cause  plain German reason whenever something is wrong or waiting -
  //          ALWAYS rendered in normal mode (Technikmodus adds detail only).
  //   action { label, href, ghost } | null - where the operator goes next.
  function derive(s, sourceCount, nowMs, portalManaged) {
    s = s || {};
    sourceCount = sourceCount || 0;
    var portal = !!portalManaged;
    if (nowMs == null) nowMs = s.server_now_ms || Date.now();

    var configured = !!(s.inverter && s.inverter.configured);
    var label = (s.inverter && s.inverter.label) || "Wechselrichter";
    // ⚠ Ein LADEPARK hat keinen Wechselrichter: seine Messwerte kommen aus den
    // Ladesäulen selbst (Schritt 3).
    var chargers = (s.ocpp && s.ocpp.chargers) || [];
    var chargePark = chargers.length > 0 && !configured;
    var chargerSeen = !!s.charge_point_connected;
    var telAge = ageSeconds(s.last_telemetry, nowMs);
    var everDelivered = telAge != null;
    var fresh = everDelivered && telAge < FRESH_SECONDS;
    var linkDown = s.inverter_link === "down";
    var isPaired = paired(s.pairing_state);

    // --- 1 Mit dem Portal koppeln ---
    // Never locked: the reference is on this page from the start, whatever is
    // (not yet) connected. geraet_entfernt is not paired - the step re-opens.
    var one;
    if (isPaired && s.cloud_connected) {
      one = { state: "done", detail: "Mit dem VoltPilot-Portal verbunden.", cause: "" };
    } else if (isPaired) {
      one = {
        state: "active",
        detail: "Gerät ist gekoppelt, die Verbindung wird aufgebaut.",
        cause: "Die Verbindung zum Portal steht gerade nicht. Das Gerät versucht es automatisch erneut; die Messwerte werden bis dahin auf dem Gerät gespeichert."
      };
    } else {
      one = {
        state: "active",
        detail: "Referenz-ID im Portal eintragen.",
        cause: "Das Gerät ist im Portal noch keiner Anlage zugeordnet."
      };
    }
    one.key = "portal"; one.num = 1; one.title = "Mit dem Portal koppeln";
    one.action = { label: "Zur Kopplung", href: "#portal", ghost: one.state === "done" };

    // --- 2 Geräte einrichten ---
    // ANY device counts - inverter, meter, further source, charge point,
    // Anlagensteuerung, own device. None of them is a prerequisite; the step
    // only says what is there and where the rest is added.
    var parts = [];
    if (configured) parts.push(label);
    if (sourceCount > 0) {
      parts.push(portal ? plural(sourceCount, "weiteres Gerät", "weitere Geräte")
        : plural(sourceCount, "weitere Quelle", "weitere Quellen"));
    }
    if (chargers.length > 0) parts.push(plural(chargers.length, "Ladesäule", "Ladesäulen"));
    var two;
    if (parts.length > 0) {
      two = { state: "done", detail: parts.join(" · ") + (portal ? " – aus dem Portal." : "."), cause: "" };
    } else if (portal) {
      two = {
        state: "active",
        detail: "Noch kein Gerät im Portal angelegt.",
        cause: "Die Geräte dieser Anlage werden im VoltPilot-Portal angelegt und erscheinen dann hier."
      };
    } else if (isPaired) {
      two = {
        state: "active",
        detail: "Noch kein Gerät eingerichtet.",
        cause: "Legen Sie die Geräte dieser Anlage – Wechselrichter, Zähler, Ladepunkte – im VoltPilot-Portal an. Ein Gerät lässt sich auch hier auf der Box einrichten."
      };
    } else {
      two = {
        state: "todo",
        detail: "Noch kein Gerät eingerichtet.",
        cause: "Nach der Kopplung legen Sie die Geräte im VoltPilot-Portal an. Kein Gerät muss vorher verbunden sein."
      };
    }
    two.key = "geraete"; two.num = 2;
    // Konzept vp-komponenten-einheit-h2 §4.3: „Geräte im PORTAL anlegen" - auf
    // einer portal-verwalteten Anlage verweist der Schritt ins Portal, statt
    // eine lokale Eingabe anzukündigen, die es hier nicht gibt.
    two.title = portal ? "Geräte im Portal anlegen" : "Geräte einrichten";
    if (parts.length > 0) {
      two.action = { label: "Geräte ansehen", href: "#anlage", ghost: true };
    } else {
      two.action = portal ? null : { label: "Hier auf der Box einrichten", href: "#anlage", ghost: true };
    }

    // --- 3 Messwerte prüfen ("Daten kommen an") ---
    // ⚠ Auf einem Ladepark misst kein Wechselrichter: die Messwerte kommen aus
    // den Ladesäulen selbst. `last_telemetry` bliebe dort für immer leer, und
    // "noch keine Messwerte" wäre die falscheste aller Aussagen über eine
    // Anlage, die gerade Autos lädt.
    var three;
    if (chargePark) {
      var meters = 0;
      for (var mi = 0; mi < chargers.length; mi++) {
        var cons = chargers[mi].connectors || [];
        for (var mj = 0; mj < cons.length; mj++) {
          if (cons[mj].power_kw != null) meters++;
        }
      }
      if (meters > 0) {
        three = { state: "done", detail: "Messwerte kommen aus den Ladesäulen.", cause: "" };
      } else if (chargerSeen) {
        three = {
          state: "done",
          detail: "Keine Ladevorgänge - keine Messwerte.",
          cause: "Eine Ladesäule meldet Leistung erst, während sie lädt. Das ist der Normalfall, solange kein Fahrzeug angesteckt ist."
        };
      } else {
        three = {
          state: "active",
          detail: "Noch hat sich keine Ladesäule gemeldet.",
          cause: "Die Säule wählt dieses Gerät selbst an — bitte die angezeigte Adresse und Kennung in der Säule eintragen."
        };
      }
      three.action = chargerSeen
        ? { label: "Werte ansehen", href: "index.html", ghost: true }
        : { label: "Zu den Ladepunkten", href: "#ladepunkte" };
    } else {
      if (fresh) {
        three = { state: "done", detail: "Aktuelle Messwerte kommen an.", cause: "" };
      } else if (everDelivered) {
        three = {
          state: "blocked",
          detail: "Die Messwerte sind nicht mehr aktuell.",
          cause: "Der letzte Messwert kam vor " +
            (telAge < 3600 ? Math.round(telAge / 60) + " Minuten" : Math.round(telAge / 3600) + " Stunden") +
            ". Bitte " + (configured ? "den Wechselrichter" : "die Geräte") + " und die Netzwerkverbindung prüfen."
        };
      } else if (configured) {
        three = {
          state: "active",
          detail: "Noch keine Messwerte.",
          cause: linkDown
            ? label + " antwortet nicht. Bitte prüfen, ob er eingeschaltet und im Netzwerk erreichbar ist."
            : "Es ist noch kein Messwert angekommen. Mit „Verbindung testen“ lässt sich die Verbindung sofort prüfen."
        };
      } else if (parts.length > 0) {
        three = {
          state: "active",
          detail: "Noch keine Messwerte.",
          cause: "Es ist noch kein Messwert angekommen. Unter „Anlage“ zeigt jedes Gerät, ob es antwortet."
        };
      } else {
        three = { state: "todo", detail: "Noch keine Messwerte.", cause: "" };
      }
      // The connection test is LOCAL and changes nothing - so it stays offered
      // on a portal-managed plant too (the button sits at the ROW, inverter.js
      // invRowTestBtn, not in the hidden edit form).
      if (everDelivered) three.action = { label: "Werte ansehen", href: "index.html", ghost: true };
      else if (configured) three.action = { label: "Verbindung prüfen", href: "#wechselrichter" };
      else three.action = null;
    }
    three.key = "messwerte"; three.num = 3; three.title = "Messwerte prüfen";

    var steps = [one, two, three];
    var doneCount = 0, activeNum = null;
    for (var i = 0; i < steps.length; i++) {
      if (steps[i].state === "done") doneCount++;
      else if (activeNum === null) activeNum = steps[i].num;
    }
    // activeNum is the FIRST step that is not done - never doneCount+1, which
    // would say "Schritt 3 von 3" while step 2 is the one still open.
    return { steps: steps, doneCount: doneCount, activeNum: activeNum, allDone: activeNum === null };
  }

  global.VPCommissioning = {
    FRESH_SECONDS: FRESH_SECONDS,
    derive: derive,
    paired: paired
  };
})(window);
