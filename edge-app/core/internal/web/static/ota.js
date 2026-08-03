/* OTA Stufe 4 „Politur": die Karte „Software-Aktualisierung" auf Einrichten.
 *
 * Sie schliesst den BEAUFSICHTIGTEN Pfad: entschieden und verteilt wird im
 * Portal, angewandt am Geraet - bisher nur ueber SSH und
 * `update.sh --from-target`, jetzt mit einem Knopf hinter demselben
 * Betreiber-Passwort wie die Kalibrierung.
 *
 * Drei Regeln, die diese Datei traegt:
 *
 *  1. **Keine Karte ohne Gegenstand.** Ohne zugewiesenes Release rendert hier
 *     GAR NICHTS - eine Karte, die nur sagen kann „geht hier nicht", ist Laerm.
 *  2. **Jedes „nein" traegt seinen Grund** (der Server liefert ihn; hier wird
 *     keiner erfunden). Ein ausgegrauter Knopf ohne Begruendung ist eine
 *     Sackgasse - dieselbe Disziplin wie auf der Steuerungs-Karte.
 *  3. **Die Rueckfrage sagt, WAS passiert.** Ein Tausch nimmt der Anlage fuer
 *     Sekunden die Steuerung; das steht VORHER da, nicht hinterher
 *     (window.VPConsequences ist fuer entwertende Aktionen zustaendig - hier
 *     wird nichts entwertet, sondern etwas Sichtbares getan, deshalb ein
 *     eigener, konkreter Text).
 *
 * `static/*` ist //go:embed-ed - nach jeder Aenderung den Kern neu bauen.
 */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  var busy = false;

  function token() {
    // Dasselbe Betreiber-Passwort wie die Kalibrier-Eingriffe: es ist der EINE
    // Geraete-Schutz, und ein zweiter waere einer zu viel.
    try { return sessionStorage.getItem("vp.cal.token") || ""; } catch (e) { return ""; }
  }

  function kv(dl, label, value) {
    if (!value) return;
    var dt = document.createElement("dt");
    dt.textContent = label;
    var dd = document.createElement("dd");
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function render(view) {
    var card = $("otaCard");
    if (!card) return;
    // Ohne Zuweisung gibt es hier nichts zu tun UND nichts zu erklaeren.
    if (!view || !view.release) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    $("otaDesc").textContent = view.autonomous
      ? "Diese Box wendet zugewiesene Stände selbst an."
      : "Das Portal hat dieser Box einen neuen Stand zugewiesen. Angewandt wird er hier.";

    var dl = $("otaKv");
    dl.textContent = "";
    kv(dl, "Zugewiesen", view.release);
    kv(dl, "Aktualisierer", view.updater_present ? "läuft" : "nicht aktiv");
    if (view.requested) kv(dl, "Freigabe", "erteilt – beginnt beim nächsten Takt");

    var reason = $("otaReason");
    reason.textContent = view.reason || "";
    reason.hidden = !view.reason;

    // Der Knopf erscheint NUR, wenn wirklich angewandt werden kann. Ein
    // deaktivierter Knopf neben einem Grund waere doppelt gemoppelt; der Grund
    // allein sagt schon alles.
    $("otaActions").hidden = !view.can_apply;
  }

  function load() {
    fetch("/api/ota/apply", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(render)
      .catch(function () { /* eine Box ohne diesen Endpunkt zeigt die Karte nicht */ });
  }

  function apply() {
    if (busy) return;
    // Was gleich passiert, steht VORHER da: der Tausch nimmt der Anlage fuer
    // Sekunden die Steuerung, und er kann sich selbst zuruecknehmen.
    if (!window.confirm(
      "Den zugewiesenen Stand jetzt anwenden?\n\n"
      + "Die Anlage wird dabei kurz neu gestartet und steuert für einige Sekunden nicht. "
      + "Der neue Stand prüft sich anschließend selbst und wird bei einem Fehler automatisch "
      + "zurückgenommen."
    )) return;

    busy = true;
    $("otaFlash").hidden = true;
    $("otaErr").hidden = true;
    var headers = { "Content-Type": "application/json" };
    var t = token();
    if (t) headers["X-VP-Calibration-Token"] = t;

    fetch("/api/ota/apply", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ by: "8484" })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        return { ok: r.ok, status: r.status, body: body };
      });
    }).then(function (res) {
      busy = false;
      if (res.ok) {
        $("otaFlash").textContent = "Freigegeben – der Aktualisierer beginnt gleich.";
        $("otaFlash").hidden = false;
        render(res.body);
        return;
      }
      $("otaErr").textContent = res.status === 401
        ? "Dafür wird das Betreiber-Passwort gebraucht (siehe Steuerung kalibrieren)."
        : (res.body && res.body.error) || "Die Freigabe wurde abgelehnt.";
      $("otaErr").hidden = false;
      if (res.body && res.body.apply) render(res.body.apply);
    }).catch(function () {
      busy = false;
      $("otaErr").textContent = "Das Gerät hat nicht geantwortet.";
      $("otaErr").hidden = false;
    });
  }

  function init() {
    if (!$("otaCard")) return;
    if ($("otaApplyBtn")) $("otaApplyBtn").addEventListener("click", apply);
    load();
    // Der Aktualisierer taktet alle 30 s; ein halb so schneller Blick reicht,
    // um „beginnt gleich" ohne Neuladen aufzuloesen.
    setInterval(load, 15000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.VPOta = { render: render };
})();
