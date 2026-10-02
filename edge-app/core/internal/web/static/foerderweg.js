// VoltPilot Edge - the row "Förderweg" of the Lade- & Entladeplan card
// (MiSpeL MP-14, Bedienkonzept BK-14 Variante A).
//
// The Förderweg comes with the plan from the portal; nothing here switches
// anything. derive() only WORDS what the core decided: the clamp itself
// (`solar_only`) comes from the core's own plan view (plan.FoerderwegView),
// never re-derived here. Terms are the contract's
// (docs/contracts/v2/mispel-foerderweg.md § 1); the strict reading
// (MP-45) shows only while the plan carries strict_exclusivity=true, as a
// yellow row that says who switched it on.
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
  var NUR_SONNE = "Laden nur mit Sonnenstrom: Die Box begrenzt das Laden auf die gemessene PV-Leistung.";
  var NETZ_ERLAUBT = "Laden aus dem Netz: erlaubt — Ihre Einstellung im Portal.";
  var NETZ_AUS = "Laden aus dem Netz: aus — Ihre Einstellung im Portal.";
  var STRENG_LEAD = "Strenge Lesart, von VoltPilot eingeschaltet:";
  var STRENG_TEXT = "kein Laden in einer Viertelstunde, in der die Anlage Netzstrom bezieht (Anlage 1 S. 11).";

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

  // derive(plan) -> { title, text, lead, streng, tech[] }
  //   plan: the "plan" object of GET /api/plan, or null when the box holds no
  //         plan. Its `foerderweg` block is the core's FoerderwegView.
  function derive(plan) {
    if (!plan) {
      return { title: "Noch nicht bekannt", text: SICHER, lead: "", streng: false, tech: [] };
    }
    var fw = plan.foerderweg || {};
    var weg = fw.foerderweg || "";
    var bekannt = !!fw.bekannt && Object.prototype.hasOwnProperty.call(BEGRIFF, weg);
    var solarOnly = fw.solar_only !== false; // missing verdict = the safe one
    var out = {
      title: bekannt ? BEGRIFF[weg] : "Unbekannt",
      text: "",
      lead: "",
      streng: !!fw.strict_exclusivity,
      tech: []
    };
    if (out.streng) {
      out.lead = STRENG_LEAD;
      out.text = STRENG_TEXT;
    } else if (!bekannt) {
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
    out.tech.push(["strict_exclusivity", fw.strict_exclusivity ? "true" : "–"]);
    out.tech.push(["strict_exclusivity_tolerance_kwh", fw.strict_exclusivity ? field(fw.strict_exclusivity_tolerance_kwh === undefined ? 0 : fw.strict_exclusivity_tolerance_kwh) : "–"]);
    out.tech.push(["grid_export_limit_kw", field(fw.grid_export_limit_kw)]);
    out.tech.push(["Solarlade-Klemme", solarOnly
      ? "an (Laden ≤ gemessene PV" + (out.streng ? ", strenge Lesart: Laden ≤ PV − Last + Toleranz)" : ")")
      : "aus (Förderweg und Einstellung erlauben Netzladen)"]);
    return out;
  }

  global.VPFoerderweg = { derive: derive };
})(window);
