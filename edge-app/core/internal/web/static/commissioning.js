// VoltPilot Edge - the guided commissioning flow on "Einrichten".
//
// Four steps, ending at "Daten kommen an". Releasing CONTROL is deliberately
// NOT part of it - that is its own, separately gated step further down the
// page (First-Light calibration behind the admin token).
//
// Everything here is DERIVED from what the existing APIs already report:
//   /api/state    inverter.configured, inverter_link, inverter_connected,
//                 last_telemetry, pairing_state, cloud_connected,
//                 onboarding_step, claim_unlocked, ref
//   /api/sources  the additional Erzeuger / Netz-Zähler / Verbraucher, plus
//                 portal_managed - Einheitsmodell Stufe 2
// No new endpoint, no new server state, no persisted "wizard progress" - the
// plant's real condition IS the progress.
//
// ⚠ Auf einer PORTAL-verwalteten Anlage ist diese Seite ein SPIEGEL: die Geräte
// werden im VoltPilot-Portal angelegt, hier ist nichts anzulegen. Der Flow sagt
// das dann auch, statt Handlungen zu versprechen, die auf dieser Box gesperrt
// sind (Befund L6). Was BLEIBT: Koppeln, Messwerte prüfen und der lokale
// Verbindungstest (der sitzt seither als eigene, nicht editierende Taste an der
// Zeile - siehe inverter.js/sources.js). `portalManaged` ist der VIERTE, additive
// Eingang: fehlt er (älterer Aufrufer), ist jedes Wort zeichengleich wie vorher.
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

  // derive(state, sourceCount, nowMs, portalManaged) -> { steps, doneCount, allDone }
  //
  // Each step is { key, num, title, state, detail, cause, action }:
  //   state  "done" | "active" | "todo" | "blocked"
  //   cause  plain German reason whenever something is wrong or waiting -
  //          ALWAYS rendered in normal mode (Technikmodus adds detail only).
  //   action { label, href } | null - where the operator goes next.
  function derive(s, sourceCount, nowMs, portalManaged) {
    s = s || {};
    sourceCount = sourceCount || 0;
    var portal = !!portalManaged;
    if (nowMs == null) nowMs = s.server_now_ms || Date.now();

    var configured = !!(s.inverter && s.inverter.configured);
    var label = (s.inverter && s.inverter.label) || "Wechselrichter";
    // ⚠ Ein LADEPARK hat keinen Wechselrichter. Solange keine Ladesäule
    // eingetragen ist, bleibt jeder Satz hier unverändert (jede Bestandsbox
    // sieht exakt dieselben vier Schritte); sobald eine eingetragen ist, ist
    // SIE die tragende Komponente und Schritt 1 spricht von ihr.
    var chargers = (s.ocpp && s.ocpp.chargers) || [];
    var chargePark = chargers.length > 0 && !configured;
    var chargerSeen = !!s.charge_point_connected;
    var telAge = ageSeconds(s.last_telemetry, nowMs);
    var everDelivered = telAge != null;
    var fresh = everDelivered && telAge < FRESH_SECONDS;
    var linkDown = s.inverter_link === "down";
    var isPaired = paired(s.pairing_state);

    // --- 1 Wechselrichter verbinden (bzw. Ladepunkt, auf einem Ladepark) ---
    var one;
    if (chargePark) {
      var seen = 0;
      for (var ci = 0; ci < chargers.length; ci++) {
        if (chargers[ci].last_seen_ms || chargers[ci].connected) seen++;
      }
      if (chargerSeen) {
        one = {
          state: "done",
          detail: seen === 1 ? "1 Ladesäule hat sich gemeldet." : seen + " Ladesäulen haben sich gemeldet.",
          cause: ""
        };
      } else {
        one = {
          state: "active",
          detail: chargers.length === 1 ? "1 Ladesäule eingetragen." : chargers.length + " Ladesäulen eingetragen.",
          cause: "Noch hat sich keine Ladesäule gemeldet. Die Säule wählt dieses Gerät selbst an — bitte die angezeigte Adresse und Kennung in der Säule eintragen."
        };
      }
      one.key = "inverter"; one.num = 1; one.title = "Ladepunkt verbinden";
      one.action = { label: one.state === "done" ? "Ladepunkte ansehen" : "Zu den Ladepunkten", href: "#ladepunkte", ghost: one.state === "done" };
    } else if (configured && everDelivered) {
      one = { state: "done", detail: label + " liefert Messwerte.", cause: "" };
    } else if (configured) {
      one = {
        state: "active",
        detail: label + " ist ausgewählt.",
        cause: linkDown
          ? label + " antwortet nicht. Bitte prüfen, ob er eingeschaltet und im Netzwerk erreichbar ist."
          : "Es ist noch kein Messwert angekommen. Mit „Verbindung testen“ lässt sich die Verbindung sofort prüfen."
      };
    } else if (portal) {
      one = {
        state: "todo",
        detail: "Noch kein Wechselrichter im Portal angelegt.",
        cause: "Die Geräte dieser Anlage werden im VoltPilot-Portal angelegt. Sobald dort ein Wechselrichter eingetragen ist, erscheint er hier."
      };
    } else {
      one = {
        state: "todo",
        detail: "Noch kein Wechselrichter ausgewählt.",
        cause: "Ohne Wechselrichter empfängt dieses Gerät keine Messwerte."
      };
    }
    if (!chargePark) {
      one.key = "inverter"; one.num = 1; one.title = "Wechselrichter verbinden";
      // ⚠ Auf einer portal-verwalteten Anlage gibt es hier nichts AUSZUWÄHLEN
      // und nichts zu ÄNDERN - beides ist gesperrt. Was es gibt: ansehen, und
      // (sobald etwas ausgewählt ist) die Verbindung prüfen. Genau die zwei
      // Handlungen bietet der Schritt dann an, nie eine dritte.
      if (portal) {
        one.action = one.state === "todo"
          ? null
          : { label: one.state === "done" ? "Gerät ansehen" : "Verbindung prüfen", href: "#wechselrichter", ghost: one.state === "done" };
      } else {
        one.action = one.state === "done"
          ? { label: "Ändern", href: "#wechselrichter", ghost: true }
          : { label: configured ? "Verbindung prüfen" : "Wechselrichter auswählen", href: "#wechselrichter" };
      }
    }

    // --- 2 Erzeuger / Zähler erfassen ---
    // Optional by nature: a plant with one inverter needs none. It is only
    // "todo" while step 1 is unfinished - it must never block the flow.
    var two;
    if (one.state !== "done") {
      two = {
        state: "todo",
        detail: chargePark ? "Erst einen Ladepunkt verbinden." : "Erst den Wechselrichter verbinden.",
        cause: ""
      };
    } else if (sourceCount > 0) {
      two = {
        state: "done",
        detail: portal
          ? (sourceCount === 1 ? "1 weiteres Gerät aus dem Portal." : sourceCount + " weitere Geräte aus dem Portal.")
          : (sourceCount === 1 ? "1 weitere Quelle erfasst." : sourceCount + " weitere Quellen erfasst."),
        cause: ""
      };
    } else {
      two = {
        state: "done",
        detail: portal ? "Kein weiteres Gerät im Portal angelegt." : "Keine weitere Quelle erfasst.",
        cause: portal
          ? "Bei einer Anlage mit nur einem Wechselrichter ist das der Normalfall. Eine zweite PV-Anlage, ein eigener Netz-Zähler oder eine Wallbox werden im VoltPilot-Portal angelegt und erscheinen dann hier."
          : "Bei einer Anlage mit nur einem Wechselrichter ist das der Normalfall. Eine zweite PV-Anlage, ein eigener Netz-Zähler oder eine Wallbox werden hier nachgetragen."
      };
    }
    two.key = "sources"; two.num = 2;
    // Konzept vp-komponenten-einheit-h2 §4.3: „2 · Geräte im PORTAL anlegen" -
    // der Schritt verweist ins Portal, statt eine lokale Eingabe anzukündigen,
    // die es hier nicht gibt. Der ERLEDIGT-Stand kommt dabei aus dem GEMELDETEN
    // Bestand (die Quellen, die der Registry-Push angelegt hat), nie aus einer
    // lokalen Eingabe - auf einer portal-verwalteten Anlage gibt es keine.
    two.title = portal ? "Geräte im Portal anlegen" : "Erzeuger & Zähler erfassen";
    two.action = two.state === "todo"
      ? null
      : { label: portal ? "Geräte ansehen" : "Quellen ansehen", href: "#quellen", ghost: true };

    // --- 3 Mit dem Portal koppeln ---
    // Mirrors the server-side gate: the reference is withheld until the
    // inverter proves it delivers data (web.go claim_unlocked).
    var three;
    if (isPaired && s.cloud_connected) {
      three = { state: "done", detail: "Mit dem VoltPilot-Portal verbunden.", cause: "" };
    } else if (isPaired) {
      three = {
        state: "active",
        detail: "Gerät ist gekoppelt, die Verbindung wird aufgebaut.",
        cause: "Die Verbindung zum Portal steht gerade nicht. Das Gerät versucht es automatisch erneut; die Messwerte werden bis dahin auf dem Gerät gespeichert."
      };
    } else if (s.claim_unlocked) {
      three = {
        state: "active",
        detail: "Referenz-ID im Portal eintragen.",
        cause: "Das Gerät ist im Portal noch keiner Anlage zugeordnet."
      };
    } else {
      three = {
        state: "todo",
        detail: "Noch gesperrt.",
        cause: chargePark
          ? "Die Referenz-ID wird erst angezeigt, wenn sich eine Ladesäule wirklich gemeldet hat - so wird nie ein Gerät gekoppelt, das gar nichts misst."
          : "Die Referenz-ID wird erst angezeigt, wenn der Wechselrichter tatsächlich Daten liefert - so wird nie ein Gerät gekoppelt, das gar nichts misst."
      };
    }
    three.key = "portal"; three.num = 3; three.title = "Mit dem Portal koppeln";
    three.action = three.state === "todo" ? null : { label: "Zur Kopplung", href: "#portal", ghost: three.state === "done" };

    // --- 4 Messwerte prüfen ("Daten kommen an") ---
    // ⚠ Auf einem Ladepark misst kein Wechselrichter: die Messwerte kommen aus
    // den Ladesäulen selbst. `last_telemetry` bliebe dort für immer leer, und
    // "noch keine Messwerte" wäre die falscheste aller Aussagen über eine
    // Anlage, die gerade Autos lädt.
    var four;
    if (chargePark) {
      var meters = 0;
      for (var mi = 0; mi < chargers.length; mi++) {
        var cons = chargers[mi].connectors || [];
        for (var mj = 0; mj < cons.length; mj++) {
          if (cons[mj].power_kw != null) meters++;
        }
      }
      if (meters > 0) {
        four = { state: "done", detail: "Messwerte kommen aus den Ladesäulen.", cause: "" };
      } else if (chargerSeen) {
        four = {
          state: "done",
          detail: "Keine Ladevorgänge - keine Messwerte.",
          cause: "Eine Ladesäule meldet Leistung erst, während sie lädt. Das ist der Normalfall, solange kein Fahrzeug angesteckt ist."
        };
      } else {
        four = { state: "todo", detail: "Noch keine Messwerte.", cause: "" };
      }
      four.key = "messwerte"; four.num = 4; four.title = "Messwerte prüfen";
      four.action = chargerSeen ? { label: "Werte ansehen", href: "index.html", ghost: true } : null;
    } else if (fresh) {
      four = { state: "done", detail: "Aktuelle Messwerte kommen an.", cause: "" };
    } else if (everDelivered) {
      four = {
        state: "blocked",
        detail: "Die Messwerte sind nicht mehr aktuell.",
        cause: "Der letzte Messwert kam vor " +
          (telAge < 3600 ? Math.round(telAge / 60) + " Minuten" : Math.round(telAge / 3600) + " Stunden") +
          ". Bitte den Wechselrichter und die Netzwerkverbindung prüfen."
      };
    } else {
      four = { state: "todo", detail: "Noch keine Messwerte.", cause: "" };
    }
    if (!chargePark) {
      four.key = "messwerte"; four.num = 4; four.title = "Messwerte prüfen";
      four.action = everDelivered ? { label: "Werte ansehen", href: "index.html", ghost: true } : null;
    }

    var steps = [one, two, three, four];
    var doneCount = 0, activeNum = null;
    for (var i = 0; i < steps.length; i++) {
      if (steps[i].state === "done") doneCount++;
      else if (activeNum === null) activeNum = steps[i].num;
    }
    // activeNum is the FIRST step that is not done - never doneCount+1, which
    // would say "Schritt 4 von 4" while step 3 is the one still open.
    return { steps: steps, doneCount: doneCount, activeNum: activeNum, allDone: activeNum === null };
  }

  global.VPCommissioning = {
    FRESH_SECONDS: FRESH_SECONDS,
    derive: derive,
    paired: paired
  };
})(window);
