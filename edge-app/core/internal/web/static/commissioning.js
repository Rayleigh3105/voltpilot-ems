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
//   /api/sources  the additional Erzeuger / Netz-Zähler / Verbraucher
// No new endpoint, no new server state, no persisted "wizard progress" - the
// plant's real condition IS the progress.
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

  // derive(state, sourceCount, nowMs) -> { steps, doneCount, allDone }
  //
  // Each step is { key, num, title, state, detail, cause, action }:
  //   state  "done" | "active" | "todo" | "blocked"
  //   cause  plain German reason whenever something is wrong or waiting -
  //          ALWAYS rendered in normal mode (Technikmodus adds detail only).
  //   action { label, href } | null - where the operator goes next.
  function derive(s, sourceCount, nowMs) {
    s = s || {};
    sourceCount = sourceCount || 0;
    if (nowMs == null) nowMs = s.server_now_ms || Date.now();

    var configured = !!(s.inverter && s.inverter.configured);
    var label = (s.inverter && s.inverter.label) || "Wechselrichter";
    var telAge = ageSeconds(s.last_telemetry, nowMs);
    var everDelivered = telAge != null;
    var fresh = everDelivered && telAge < FRESH_SECONDS;
    var linkDown = s.inverter_link === "down";
    var isPaired = paired(s.pairing_state);

    // --- 1 Wechselrichter verbinden ---
    var one;
    if (configured && everDelivered) {
      one = { state: "done", detail: label + " liefert Messwerte.", cause: "" };
    } else if (configured) {
      one = {
        state: "active",
        detail: label + " ist ausgewählt.",
        cause: linkDown
          ? label + " antwortet nicht. Bitte prüfen, ob er eingeschaltet und im Netzwerk erreichbar ist."
          : "Es ist noch kein Messwert angekommen. Mit „Verbindung testen“ lässt sich die Verbindung sofort prüfen."
      };
    } else {
      one = {
        state: "todo",
        detail: "Noch kein Wechselrichter ausgewählt.",
        cause: "Ohne Wechselrichter empfängt dieses Gerät keine Messwerte."
      };
    }
    one.key = "inverter"; one.num = 1; one.title = "Wechselrichter verbinden";
    one.action = one.state === "done"
      ? { label: "Ändern", href: "#wechselrichter", ghost: true }
      : { label: configured ? "Verbindung prüfen" : "Wechselrichter auswählen", href: "#wechselrichter" };

    // --- 2 Erzeuger / Zähler erfassen ---
    // Optional by nature: a plant with one inverter needs none. It is only
    // "todo" while step 1 is unfinished - it must never block the flow.
    var two;
    if (!(configured && everDelivered)) {
      two = {
        state: "todo",
        detail: "Erst den Wechselrichter verbinden.",
        cause: ""
      };
    } else if (sourceCount > 0) {
      two = {
        state: "done",
        detail: sourceCount === 1 ? "1 weitere Quelle erfasst." : sourceCount + " weitere Quellen erfasst.",
        cause: ""
      };
    } else {
      two = {
        state: "done",
        detail: "Keine weitere Quelle erfasst.",
        cause: "Bei einer Anlage mit nur einem Wechselrichter ist das der Normalfall. Eine zweite PV-Anlage, ein eigener Netz-Zähler oder eine Wallbox werden hier nachgetragen."
      };
    }
    two.key = "sources"; two.num = 2; two.title = "Erzeuger & Zähler erfassen";
    two.action = two.state === "todo" ? null : { label: "Quellen ansehen", href: "#quellen", ghost: true };

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
        cause: "Die Referenz-ID wird erst angezeigt, wenn der Wechselrichter tatsächlich Daten liefert - so wird nie ein Gerät gekoppelt, das gar nichts misst."
      };
    }
    three.key = "portal"; three.num = 3; three.title = "Mit dem Portal koppeln";
    three.action = three.state === "todo" ? null : { label: "Zur Kopplung", href: "#portal", ghost: three.state === "done" };

    // --- 4 Messwerte prüfen ("Daten kommen an") ---
    var four;
    if (fresh) {
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
    four.key = "messwerte"; four.num = 4; four.title = "Messwerte prüfen";
    four.action = everDelivered ? { label: "Werte ansehen", href: "index.html", ghost: true } : null;

    var steps = [one, two, three, four];
    var doneCount = 0;
    for (var i = 0; i < steps.length; i++) if (steps[i].state === "done") doneCount++;
    return { steps: steps, doneCount: doneCount, allDone: doneCount === steps.length };
  }

  global.VPCommissioning = {
    FRESH_SECONDS: FRESH_SECONDS,
    derive: derive,
    paired: paired
  };
})(window);
