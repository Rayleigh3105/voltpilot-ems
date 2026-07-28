// VoltPilot Edge - the plain-German status line ("Wie geht es der Anlage?").
//
// THE LOAD-BEARING RULE OF THIS PAGE: what is hidden must never hide a CAUSE.
// derive() is the ONE place that decides what the device is currently saying,
// and every non-ok verdict carries a `cause` written in plain German. The
// status hero renders that cause in NORMAL mode (Technikmodus OFF) - the
// technical blocks only ever add DETAIL (registers, raw frames, addresses)
// underneath it, never the message itself.
//
// Pure + side-effect free on purpose, so it can be unit-tested without a
// browser (see internal/web/jstest/ui.test.js).
(function (global) {
  "use strict";

  // A reading older than this counts as stale (same window dashboard.js uses
  // for the "keine aktuellen Daten" chip).
  var FRESH_SECONDS = 90;

  // Pairing states that are a REAL problem, each with the operator-facing
  // cause. Mirrors the enroll.State vocabulary (core/internal/enroll).
  var PAIRING = {
    schluessel_konflikt: {
      tone: "err",
      title: "Registrierung gesperrt",
      cause: "Für diese Referenz ist bereits ein anderes Gerät registriert. Bitte den VoltPilot-Support kontaktieren."
    },
    referenz_unbekannt: {
      tone: "err",
      title: "Geräte-ID unbekannt",
      cause: "Diese Referenz ist dem Portal nicht bekannt. Bitte die Referenz auf dem Aufkleber prüfen."
    },
    geraet_fehler: {
      tone: "err",
      title: "Fehler auf dem Gerät",
      cause: "Auf dem Gerät ist ein Fehler aufgetreten (z. B. Speicher nicht beschreibbar). Bitte das Gerät neu starten; hält der Fehler an, den Support kontaktieren."
    },
    geraet_entfernt: {
      tone: "warn",
      title: "Gerät aus dem Portal entfernt",
      cause: "Das Gerät wurde im Portal entfernt. Die lokale Anzeige läuft weiter, die Aufzeichnung für das Portal ist pausiert. Fügen Sie das Gerät im Portal wieder hinzu."
    },
    portal_nicht_erreichbar: {
      tone: "warn",
      title: "Portal nicht erreichbar",
      cause: "Das Gerät erreicht das VoltPilot-Portal nicht. Bitte die Internetverbindung prüfen - es wird automatisch weiter versucht."
    },
    cloud_fehler: {
      tone: "warn",
      title: "Verbindung zum Portal fehlgeschlagen",
      cause: "Die Verbindung zu VoltPilot konnte nicht aufgebaut werden. Das Gerät versucht es automatisch erneut."
    }
  };

  function ageSeconds(iso, nowMs) {
    if (!iso) return null;
    var t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, (nowMs - t) / 1000);
  }

  function ago(seconds) {
    if (seconds == null) return "";
    if (seconds < 60) return "vor " + Math.round(seconds) + " Sekunden";
    if (seconds < 3600) return "vor " + Math.round(seconds / 60) + " Minuten";
    if (seconds < 86400) return "vor " + Math.round(seconds / 3600) + " Stunden";
    return "vor " + Math.round(seconds / 86400) + " Tagen";
  }

  function inverterName(s) {
    return (s.inverter && s.inverter.label) ? s.inverter.label : "Der Wechselrichter";
  }

  // derive returns { tone: "ok"|"warn"|"err", title, detail, cause }.
  // `cause` is "" only for the ok verdict - every problem names its reason.
  function derive(s, nowMs) {
    if (!s) {
      return {
        tone: "warn",
        title: "Zustand nicht abrufbar",
        detail: "",
        cause: "Die Geräteseite konnte den aktuellen Zustand nicht laden. Bitte die Seite neu laden."
      };
    }
    if (nowMs == null) nowMs = s.server_now_ms || Date.now();

    var telAge = ageSeconds(s.last_telemetry, nowMs);
    var fresh = telAge != null && telAge < FRESH_SECONDS;
    var configured = !!(s.inverter && s.inverter.configured);
    var linkDown = s.inverter_link === "down";

    // 1) A broken pairing/enrollment beats everything - it is the reason
    //    nothing else will work.
    var p = PAIRING[s.pairing_state];
    if (p) {
      return { tone: p.tone, title: p.title, detail: "", cause: p.cause };
    }

    // 2) Nothing to measure with yet.
    if (!configured) {
      return {
        tone: "warn",
        title: "Anlage noch nicht eingerichtet",
        detail: "",
        cause: "Es ist kein Wechselrichter ausgewählt. Ohne ihn empfängt dieses Gerät keine Messwerte."
      };
    }

    // 3) Configured, but nothing has ever arrived.
    if (telAge == null) {
      return {
        tone: "warn",
        title: "Warte auf die ersten Messwerte",
        detail: "",
        cause: linkDown
          ? inverterName(s) + " antwortet nicht. Bitte prüfen, ob er eingeschaltet und im Netzwerk erreichbar ist."
          : inverterName(s) + " ist eingerichtet, es ist aber noch kein Messwert angekommen."
      };
    }

    // 4) Data has stopped coming - the most urgent everyday failure.
    if (!fresh) {
      return {
        tone: "warn",
        title: "Keine aktuellen Messwerte",
        detail: "",
        cause: "Der letzte Messwert kam " + ago(telAge) + "." +
          (linkDown
            ? " " + inverterName(s) + " antwortet gerade nicht."
            : " Bitte prüfen, ob der Wechselrichter eingeschaltet und erreichbar ist.")
      };
    }

    // 5) The control path refused with a stated reason. It is EMPTY on purpose
    //    (unknown nameplate / power scale), not "still waiting" - say so.
    if (s.control && s.control.blocked && s.control.reason) {
      return {
        tone: "warn",
        title: "Steuerung angehalten",
        detail: "Messwerte kommen weiterhin an.",
        cause: s.control.reason
      };
    }

    // 6) The inverter is not holding what VoltPilot commanded. The hero carries a
    //    SHORT cause + a pointer; the FULL explanation (with its stable "Zustand
    //    seit" stamp) lives exactly ONCE per page, on the Steuerung & Bestätigung
    //    card - the same paragraph used to render three times on one screen and,
    //    re-fired per ~10 s readback, read as a warning every tick (live Pilsting).
    if (s.control && s.control.registers && s.control.registers.length && !s.control.all_match) {
      var mmRoles = (s.control.mismatch_roles || []).join(", ");
      return {
        tone: "warn",
        title: "Wechselrichter übernimmt den Sollwert nicht",
        detail: "Messwerte kommen weiterhin an.",
        cause: (mmRoles
          ? "Der Wechselrichter hält den geschriebenen Wert nicht (" + mmRoles + ")."
          : "Der Wechselrichter hält einen geschriebenen Wert nicht.")
          + " Details unter „Steuerung & Bestätigung“."
      };
    }

    // 7) Buffer overrun during a long outage: data is being dropped.
    if (s.buffer_data_loss) {
      return {
        tone: "warn",
        title: "Zwischenspeicher voll",
        detail: "Die Anlage läuft, die Verbindung zum Portal fehlt.",
        cause: "Die Verbindung zum Portal fehlt so lange, dass die ältesten zwischengespeicherten Messwerte verworfen werden."
      };
    }

    // 8) Plain cloud outage - local operation is unaffected.
    if (!s.cloud_connected) {
      return {
        tone: "warn",
        title: "Portal nicht verbunden",
        detail: "Die Anlage läuft und misst weiter.",
        cause: (s.buffer_pending > 0
          ? s.buffer_pending + " Messwerte werden auf dem Gerät zwischengespeichert und nachgesendet, sobald die Verbindung steht."
          : "Die Messwerte werden auf dem Gerät zwischengespeichert und nachgesendet, sobald die Verbindung steht.")
      };
    }

    // Everything is fine: name the three things that make it fine.
    var parts = ["Anlage läuft", "Portal verbunden"];
    if (s.mode === "fahrplan") parts.push("Fahrplan aktiv");
    else if (s.mode === "kalibrierung") parts.push("Kalibrierung läuft");
    else if (s.mode === "wunsch") parts.push("Automation aktiv");
    else if (s.mode === "eigenverbrauch") parts.push("Eigenverbrauch");
    return { tone: "ok", title: "Alles in Ordnung", detail: parts.join(" · "), cause: "" };
  }

  global.VPStatus = {
    FRESH_SECONDS: FRESH_SECONDS,
    derive: derive,
    ago: ago,
    ageSeconds: ageSeconds
  };
})(window);
