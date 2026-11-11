// VoltPilot Edge - the row "Förderweg" of the Lade- & Entladeplan card
// (MiSpeL MP-14, Bedienkonzept BK-14 Variante A).
//
// The Förderweg comes with the plan from the portal; nothing here switches
// anything. derive() only WORDS what the core decided: the clamp itself
// (`solar_only`) comes from the core's own plan view (plan.FoerderwegView),
// never re-derived here. Terms are the contract's
// (docs/contracts/v2/mispel-foerderweg.md § 1). Where the box charges only
// from the sun, the Netzladen-Sperre (EN-1 A) holds the charge to the measured
// surplus, never while the site imports - the sentence says so.
//
// Pure + side-effect free, so it is unit-tested without a browser
// (internal/web/jstest/ui.test.js).
(function (global) {
  "use strict";

  var BEGRIFF = {
    einspeiseverguetung: "Einspeisevergütung",
    marktpraemie_ausschliesslichkeit: "Marktprämie mit Ausschließlichkeitsoption",
    marktpraemie_abgrenzung: "Marktprämie mit Abgrenzungsoption",
    marktpraemie_pauschal: "Marktprämie mit Pauschaloption",
    ungefoerdert: "Ungeförderte Direktvermarktung"
  };
  // Where the Förderweg leaves grid charging to the customer (contract § 1,
  // column "Netzladen": Einstellung des Kunden).
  var NETZLADEN_KUNDE = {
    marktpraemie_abgrenzung: true,
    marktpraemie_pauschal: true,
    ungefoerdert: true
  };

  var SICHER = "Die Box lädt sicherheitshalber nur mit Sonnenstrom.";
  var NUR_SONNE = "Laden nur mit Sonnenstrom: Die Box lädt nur aus dem gemessenen Überschuss, nie während die Anlage Netzstrom bezieht.";
  var NETZ_ERLAUBT = "Laden aus dem Netz: erlaubt — Ihre Einstellung im Portal.";
  var NETZ_AUS = "Laden aus dem Netz: aus — Ihre Einstellung im Portal.";

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function hhmm(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function field(v) {
    if (v === undefined || v === null || v === "") return "–";
    return String(v);
  }

  // derive(plan) -> { title, text, tech[] }
  //   plan: the "plan" object of GET /api/plan, or null when the box holds no
  //         plan. Its `foerderweg` block is the core's FoerderwegView.
  function derive(plan) {
    if (!plan) {
      return { title: "Noch nicht bekannt", text: SICHER, tech: [] };
    }
    var fw = plan.foerderweg || {};
    var weg = fw.foerderweg || "";
    var bekannt = !!fw.bekannt && Object.prototype.hasOwnProperty.call(BEGRIFF, weg);
    var solarOnly = fw.solar_only !== false; // missing verdict = the safe one
    var out = {
      title: bekannt ? BEGRIFF[weg] : "Unbekannt",
      text: "",
      tech: []
    };
    if (!bekannt) {
      out.text = SICHER;
    } else if (NETZLADEN_KUNDE[weg]) {
      out.text = solarOnly ? NETZ_AUS : NETZ_ERLAUBT;
    } else {
      out.text = NUR_SONNE;
    }

    var zeit = hhmm(plan.generated_at);
    var empfangen = hhmm(plan.received_at);
    out.tech.push(["Planzeit", (zeit ? "Fahrplan von " + zeit : "–") + (empfangen ? " · empfangen " + empfangen : "")]);
    out.tech.push(["foerderweg", field(weg)]);
    out.tech.push(["grid_charge_allowed", field(fw.grid_charge_allowed)]);
    out.tech.push(["grid_export_limit_kw", field(fw.grid_export_limit_kw)]);
    out.tech.push(["Solarlade-Klemme", solarOnly
      ? "an (Laden ≤ gemessene PV; Netzladen-Sperre: Laden ≤ PV − Last − 1 kW, nie bei Netzbezug)"
      : "aus (Förderweg und Einstellung erlauben Netzladen)"]);
    return out;
  }

  global.VPFoerderweg = { derive: derive };
})(window);
