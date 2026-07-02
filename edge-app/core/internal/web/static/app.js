// VoltPilot Edge local UI - polls /api/state and renders it. Read-only.
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var kw = function (v) { return nf1.format(v) + " kW"; };
  var pct = function (v) { return nf1.format(v) + " %"; };

  function ago(iso) {
    if (!iso) return null;
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 0) s = 0;
    if (s < 60) return "vor " + s + " s";
    if (s < 3600) return "vor " + Math.round(s / 60) + " min";
    return "vor " + (s / 3600).toFixed(1).replace(".", ",") + " h";
  }

  function setPairing(state) {
    var steps = { claim: 0, cert: 1, connected: 2 };
    var reached;
    if (state === "verbunden") reached = 2;
    else if (state === "zertifikat_erhalten") reached = 1;
    else reached = 0;
    var items = document.querySelectorAll("#pairing li");
    items.forEach(function (li, i) {
      li.classList.toggle("done", i < reached || (i === 2 && reached === 2));
      li.classList.toggle("active", i === reached && reached < 2);
    });
    var err = $("pairingError");
    if (state === "schluessel_konflikt") {
      err.hidden = false;
      err.textContent = "Registrierung gesperrt: Für diese Referenz wurde bereits ein anderes Gerät registriert. Bitte kontaktieren Sie den Support.";
    } else if (state === "referenz_unbekannt") {
      err.hidden = false;
      err.textContent = "Diese Geräte-ID ist dem System nicht bekannt. Bitte prüfen Sie die Referenz auf dem Aufkleber.";
    } else {
      err.hidden = true;
    }
  }

  function render(s) {
    $("ref").textContent = s.ref || "…";
    $("version").textContent = !s.version || s.version === "dev" ? "" : "v" + s.version;
    setPairing(s.pairing_state);

    var cloud = $("cloud"), cloudSub = $("cloudSub");
    if (s.cloud_connected) {
      cloud.textContent = "verbunden";
      cloud.className = "stat-value ok";
      cloudSub.textContent = s.mqtt_host || "";
    } else {
      cloud.textContent = "getrennt";
      cloud.className = "stat-value warn";
      cloudSub.textContent = s.buffer_pending > 0
        ? s.buffer_pending + " Messwerte werden zwischengespeichert"
        : "Daten werden lokal gepuffert";
    }

    var tel = $("telemetry"), telSub = $("telemetrySub");
    var telAgo = ago(s.last_telemetry);
    if (telAgo) {
      var fresh = (Date.now() - new Date(s.last_telemetry).getTime()) < 60000;
      tel.textContent = telAgo;
      tel.className = "stat-value " + (fresh ? "ok" : "warn");
      telSub.textContent = fresh ? "Anlage liefert Daten" : "Keine aktuellen Daten";
    } else {
      tel.textContent = "keine";
      tel.className = "stat-value warn";
      telSub.textContent = "Warte auf erste Daten der Anlage";
    }

    var mode = $("mode"), modeSub = $("modeSub");
    if (s.mode === "fahrplan") {
      mode.textContent = "folgt Fahrplan";
      mode.className = "stat-value ok";
      modeSub.textContent = s.slot_start ? "aktueller Slot ab " + new Date(s.slot_start).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr" : "";
    } else if (s.mode === "eigenverbrauch") {
      mode.textContent = "Eigenverbrauch-Notbetrieb";
      mode.className = "stat-value warn";
      modeSub.textContent = "Kein aktueller Fahrplan – Batterie folgt PV und Verbrauch";
    } else {
      mode.textContent = "wartet";
      mode.className = "stat-value warn";
      modeSub.textContent = "Noch keine Messwerte vom Wechselrichter";
    }

    var inv = $("inverter"), invSub = $("inverterSub");
    if (s.inverter_link === "up") {
      inv.textContent = "verbunden";
      inv.className = "stat-value ok";
      invSub.textContent = "";
    } else if (s.inverter_link === "down") {
      inv.textContent = "getrennt";
      inv.className = "stat-value err";
      invSub.textContent = "Verbindung zum Wechselrichter prüfen";
    } else {
      inv.textContent = "unbekannt";
      inv.className = "stat-value warn";
      invSub.textContent = "Noch keine Meldung der Anlagenanbindung";
    }

    $("setpoint").textContent = (s.mode === "keine_messwerte") ? "–" : kw(s.setpoint_kw) + (s.setpoint_kw > 0 ? " (laden)" : (s.setpoint_kw < 0 ? " (entladen)" : ""));
    $("soc").textContent = s.last_telemetry ? pct(s.soc_pct) : "–";
    $("pv").textContent = s.last_telemetry ? kw(s.pv_kw) : "–";
    $("load").textContent = s.last_telemetry ? kw(s.load_kw) : "–";
    $("buffer").textContent = s.buffer_pending + " ausstehend";
    $("plan").textContent = s.plan_slots > 0
      ? s.plan_slots + " Slots, empfangen " + (ago(s.plan_received) || "")
      : "noch keiner empfangen";
  }

  function poll() {
    fetch("/api/state", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () { /* next poll retries */ });
  }

  $("copyBtn").addEventListener("click", function () {
    var ref = $("ref").textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(ref) : Promise.reject())
      .then(function () {
        $("copyBtn").textContent = "Kopiert ✓";
        setTimeout(function () { $("copyBtn").textContent = "Kopieren"; }, 1500);
      })
      .catch(function () { /* selection fallback: the field is user-selectable */ });
  });

  poll();
  setInterval(poll, 2000);
})();
