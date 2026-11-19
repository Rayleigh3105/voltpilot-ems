// Das Einrichtungs-WLAN "VoltPilot-Einrichtung" auf der Seite am Kabel
// (nur Edge Light): offen oder zu, warum, und wann sich das aendert. An der
// Werkbank sieht man so am Laptop, was die Box gerade tut, statt mit dem
// Handy nach einem WLAN zu suchen, das sie aus gutem Grund nicht zeigt.
//
// Quelle: GET /api/einrichtungs-wlan (einrichtung.go), dahinter
// "einrichtung-wlan.sh status" auf der Box. beschreibe() ist rein und in
// jstest/ui.test.js geprueft; der Rest holt den Zustand alle 20 s und
// zeichnet ihn in #einrichtWlan.
(function (global) {
  "use strict";

  var SSID = "„VoltPilot-Einrichtung“";

  function minuten(s) {
    if (typeof s !== "number" || s <= 60) return "etwa einer Minute";
    return "etwa " + Math.ceil(s / 60) + " Minuten";
  }

  // beschreibe macht aus dem Zustand des Waechters eine Aussage fuer Menschen:
  // { ton: "ok" | "info" | "warn", titel, text, technik, nurTechnik } oder
  // null, wenn es nichts zu zeigen gibt (Docker-Box). nurTechnik: der
  // Normalfall (zu, die Box erreicht die Cloud) steht nur im Technikmodus.
  function beschreibe(z) {
    if (!z || !z.verfuegbar) return null;
    var technik = "Wächter: " + (z.grund || "–") +
      " · Cloud: " + (z.cloud || "–") + (z.cloud_grund ? " (" + z.cloud_grund + ")" : "") +
      " · Funkmodul sendet: " + (z.sendet || "–") + (z.kanal ? ", Kanal " + z.kanal : "") +
      " · Träger an WAN: " + (z.wan_traeger === "1" ? "ja" : z.wan_traeger === "0" ? "nein" : "–");
    var d = { ton: "info", titel: "", text: "", technik: technik, nurTechnik: false };
    var wlan = z.kunden_wlan ? "„" + z.kunden_wlan + "“" : "Ihrem WLAN";

    if (z.takt_ausgeblieben || z.grund === "takt_aus") {
      d.ton = "warn";
      d.titel = "Einrichtungs-WLAN: der Wächter läuft nicht";
      d.text = "Die Box prüft seit einigen Minuten nicht mehr, ob sie das Einrichtungs-WLAN " + SSID +
        " öffnen soll. Trennen Sie die Box kurz vom Strom; danach läuft der Wächter wieder.";
      return d;
    }
    if (z.grund === "kein_takt") {
      d.titel = "Einrichtungs-WLAN: wird gleich geprüft";
      d.text = "Die Box ist eben gestartet. Innerhalb einer Minute entscheidet sie, ob sie " + SSID + " öffnet.";
      return d;
    }
    if (z.einrichtung === "offen") {
      if (z.sendet !== "ja") {
        d.ton = "warn";
        d.titel = "Einrichtungs-WLAN eingeschaltet, aber das Funkmodul sendet es nicht";
        d.text = "Die Box hat " + SSID + " geöffnet, doch das Funkmodul strahlt es nicht aus - ein Handy findet es deshalb nicht. " +
          "Trennen Sie die Box kurz vom Strom. Hilft das nicht, melden Sie sich beim VoltPilot-Support.";
        return d;
      }
      if (z.grund === "cloud_ruhe") {
        d.ton = "ok";
        d.titel = "Einrichtungs-WLAN schließt gleich";
        d.text = "Die Box erreicht die Cloud. " + SSID + " schließt sich in " + minuten(z.zu_in) + " von selbst.";
        return d;
      }
      d.titel = "Einrichtungs-WLAN " + SSID + " ist offen";
      d.text = z.grund === "anlauf"
        ? "Die Box startet gerade und prüft ihre Verbindung zur Cloud."
        : "Die Box erreicht die Cloud nicht. Verbinden Sie ein Handy mit diesem WLAN, um das WLAN Ihres Routers einzutragen.";
      if (typeof z.zu_in === "number") {
        d.text += " Es bleibt noch " + minuten(z.zu_in) + " offen; dann versucht die Box kurz, sich mit " + wlan +
          " zu verbinden, und öffnet es danach wieder.";
      }
      return d;
    }
    switch (z.grund) {
      case "cloud":
        d.ton = "ok";
        d.nurTechnik = true;
        d.titel = "Einrichtungs-WLAN geschlossen";
        d.text = "Die Box erreicht die Cloud. Fehlt die Verbindung länger, öffnet sie " + SSID + " von selbst.";
        return d;
      case "wartet":
        d.ton = "warn";
        d.titel = "Einrichtungs-WLAN öffnet sich in " + minuten(z.auf_in);
        d.text = "Die Box erreicht die Cloud gerade nicht. Sie wartet kurz, ob die Verbindung von selbst zurückkommt; danach öffnet sie " + SSID + ".";
        return d;
      case "versuch":
        d.titel = "Die Box versucht gerade " + wlan;
        d.text = "Klappt die Verbindung nicht, öffnet sich das Einrichtungs-WLAN " + SSID + " in " + minuten(z.auf_in) + " wieder.";
        return d;
      case "anlauf":
        d.titel = "Die Box startet";
        d.text = "Sie prüft gerade ihre Verbindung zur Cloud. Ohne Verbindung öffnet sich " + SSID + " in wenigen Minuten.";
        return d;
      case "gleich":
        d.titel = "Einrichtungs-WLAN öffnet sich gleich";
        d.text = "Die Box erreicht die Cloud nicht und öffnet " + SSID + " innerhalb einer Minute.";
        return d;
    }
    return null;
  }

  function zeichne(z) {
    var el = document.getElementById("einrichtWlan");
    if (!el) return;
    var d = beschreibe(z);
    el.hidden = !d;
    if (!d) return;
    el.setAttribute("data-ton", d.ton);
    el.classList.toggle("tech-only", d.nurTechnik);
    document.getElementById("einrichtWlanTitel").textContent = d.titel;
    document.getElementById("einrichtWlanText").textContent = d.text;
    document.getElementById("einrichtWlanTechnik").textContent = d.technik;
  }

  function hole() {
    global.fetch("/api/einrichtungs-wlan", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(zeichne)
      .catch(function () { /* der naechste Abruf versucht es wieder */ });
  }

  global.VPEinrichtWlan = { beschreibe: beschreibe };

  var document = global.document;
  if (global.fetch && document && document.getElementById("einrichtWlan")) {
    hole();
    global.setInterval(hole, 20000);
  }
})(window);
