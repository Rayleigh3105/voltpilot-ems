// VoltPilot Edge - die REINEN Regeln der Rollen-Anzeige der Betrieb-Seite.
//
// Sie beantworten aus dem AE1-Topologie-Read-Model zwei Fragen, beide ohne DOM,
// ohne Zustand und ohne Uhr - deshalb sind sie Docker-frei prüfbar
// (internal/web/jstest/ui.test.js), während dashboard.js sie nur RENDERT:
//
//   * flowLayout(topo)  - wo welcher Rollen-Kreis des Energieflusses sitzt,
//                         woran seine Speiche hängt und was unter ihm steht.
//   * deriveTiles(topo) - die Kachel-Leiste (Portal-Parität mit
//                         adaptiveLive.deriveTiles).
//
// ⚠ DIE ROLLEN-LISTE IST DER ZWILLING VON internal/topology/topology.go UND
// frontend/portal/src/{topology,adaptive,adaptiveFlow}.ts. Seit PR 550 liefert
// die Go-Ableitung für eine Wallbox/einen Ladepunkt `charging` bzw.
// `charging-own` statt `consumer`; ein Rollen-Wort, das hier fehlt, lässt den
// Knoten und die Kachel STILL verschwinden (Befund L3 des Scouts
// vp-portal-box-spiegel-s2). Wer dort eine Rolle ergänzt, ergänzt sie hier.
(function (global) {
  "use strict";

  var nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

  // Unterhalb dieses Betrags gilt eine Leistung als Ruhe (das Totband der
  // Topologie, internal/topology DeadbandKw).
  var DEADBAND_KW = 0.05;

  // Geometrie des Energiefluss-Diagramms (Proportionen des Portals
  // adaptiveFlow). dashboard.js liest sie HIER, damit Layout und Rendern nicht
  // mit zwei Zahlensätzen arbeiten.
  var GEOM = {
    NODE_R: 30, HUB_R: 24, LEFT_INSET: 62, TOP_INSET: 48,
    LBL_F: 11.5, VAL_F: 11,
    // Der Rollen-Name steht UNTER dem Kreis (Name + Zusatzzeile); LBL_BLOCK ist
    // der Platz, den er unter der untersten Knotenreihe braucht.
    LBL_GAP: 15, LBL_LH: 13, LBL_BLOCK: 32
  };

  // Der Abstand der Lade-Zeile zur Hub-Zeile.
  var CHARGING_DY = 128;

  // ⚠ ZWEI Plätze für die zwei Lade-Rollen, weil es zwei ANSCHLUSSPUNKTE gibt
  // (Konzept vp-verbraucher-cockpit-k1 §6, Captain-Entscheid E3):
  //   * `charging`     hängt am HAUS, nicht am Hub - seine Kilowatt stecken
  //                    schon in der gemessenen Hauslast. Der Abzweig sagt, wie
  //                    viel davon ins Auto geht.
  //   * `charging-own` hängt am HUB neben dem Haus - eine Säule an einem
  //                    EIGENEN Netzanschluss steckt in dieser Messung nie.
  // Sie zu einem Knoten zusammenzuziehen wäre EINE Zahl mit ZWEI Bedeutungen.
  var ROLE_SIDE = {
    pv: "top", storage: "left", consumer: "right", grid: "bottom",
    charging: "right-below", "charging-own": "left-below"
  };

  // Die Kunden-Namen der Rollen-Kreise (Portal ROLE_NODE_LABEL - zusammen
  // ändern mit frontend/portal/src/adaptiveFlow.ts).
  var ROLE_NODE_LABEL = {
    pv: "PV-Erzeugung", storage: "Batteriespeicher", consumer: "Hausverbrauch",
    grid: "Netz", charging: "Laden", "charging-own": "Laden (eigener Anschluss)"
  };

  function isCharging(role) {
    return role === "charging" || role === "charging-own";
  }

  function strokeWidth(mag) { return Math.max(2.5, Math.min(7, 2.5 + Math.abs(mag) * 0.7)); }

  // vertexValue: SoC bei einem Speicher-Knoten, sonst |kW| (Portal-Parität).
  function vertexValue(role, node, memberKw) {
    if (role === "storage" && node.soc_pct != null) return nf0.format(node.soc_pct) + " %";
    if (memberKw == null) return "–";
    return nf1.format(Math.abs(memberKw)) + " kW";
  }

  // Die zweite Zeile unter einem Rollen-Kreis: "N Geräte" auf einer
  // Mehr-Geräte-PV = der Klick-Hinweis; sonst der Zustand in Worten - nie ein
  // Gerätename (die Namen leben in der Zusammensetzung).
  function subLabelFor(role, node, memberCount) {
    if (role === "pv") return memberCount > 1 ? memberCount + " Geräte" : null;
    if (isCharging(role)) {
      if (memberCount > 1) return memberCount + " Ladepunkte";
      return node.flow_active ? "lädt" : null;
    }
    if (!node.flow_active || node.value_kw == null) return null;
    var kw = nf1.format(Math.abs(node.value_kw)) + " kW";
    if (role === "storage") return node.direction === "out" ? "lädt " + kw : "entlädt " + kw;
    if (role === "grid") return node.direction === "in" ? "Bezug" : "Einspeisung";
    return null;
  }

  // flowLayout macht aus der Topologie positionierte Kreis-Ecken - EIN Kreis je
  // ROLLE (Portal-Parität, vp-vier-erzeuger-p9 PR 4b): die viewBox der
  // Grundfigur ist KONSTANT, die Aufschlüsselung je Gerät liegt hinter einem
  // Klick auf den PV-Kreis. Farbe/Icon hängt der Aufrufer aus seiner ROLE_META
  // an - hier lebt nur, was ohne CSS entscheidbar ist.
  function flowLayout(topo) {
    var nodes = (topo && topo.nodes) || [];
    var W = 520, BASE_H = 300 + GEOM.LBL_BLOCK;
    var hubX = W / 2, hubY = (BASE_H - GEOM.LBL_BLOCK) / 2;
    var chargingY = hubY + CHARGING_DY;
    var POS = {
      top: { x: hubX, y: GEOM.TOP_INSET },
      bottom: { x: hubX, y: BASE_H - GEOM.TOP_INSET - GEOM.LBL_BLOCK },
      left: { x: GEOM.LEFT_INSET, y: hubY },
      right: { x: W - GEOM.LEFT_INSET, y: hubY },
      "right-below": { x: W - GEOM.LEFT_INSET, y: chargingY },
      "left-below": { x: GEOM.LEFT_INSET, y: chargingY }
    };

    // Erst die Grundfigur, damit der Abzweig sein Haus schon kennt.
    var vertices = [], hausIdx = -1, ladeNodes = [];
    nodes.forEach(function (node) {
      var side = ROLE_SIDE[node.role];
      if (!side) return; // unbekannte Rolle - übersprungen, nie geraten
      var members = node.members || [];
      if (members.length === 0) return;
      if (isCharging(node.role)) { ladeNodes.push(node); return; }
      var p = POS[side];
      if (node.role === "consumer") hausIdx = vertices.length;
      vertices.push(vertex(node, p, members));
    });

    ladeNodes.forEach(function (node) {
      var haus = hausIdx >= 0 ? vertices[hausIdx] : null;
      // ⚠ Der Abzweig braucht sein Haus: ohne Haus-Knoten gibt es nichts, wovon
      // er ein Teil wäre - ihn stattdessen an den Hub zu hängen behauptete
      // einen EIGENEN Anschluss, also genau das, was `charging-own` heißt.
      // Seine Kachel nennt ihn trotzdem (Portal-Regel, adaptiveFlow.ts).
      if (node.role === "charging" && !haus) return;
      var v = vertex(node, POS[ROLE_SIDE[node.role]], node.members || []);
      if (node.role === "charging") {
        // ⚠ Der Beschriftungs-Block des Hauses liegt ZWISCHEN den beiden
        // Kreisen, also endet die Speiche darunter - sonst liefen die
        // Laufpunkte mitten durch das Wort. Gerechnet mit den WIRKLICH
        // gezeichneten Zeilen.
        var lines = 1 + (haus.subLine ? 1 : 0);
        v.toX = haus.x;
        v.toY = Math.min(
          haus.y + GEOM.NODE_R + GEOM.LBL_GAP + lines * GEOM.LBL_LH,
          v.y - GEOM.NODE_R - 2
        );
        // Der Abzweig ist dünner als eine Hub-Speiche.
        v.baseWidth = 4;
      }
      // `charging-own` lässt toX/toY WEG - der Renderer fällt auf den Hub
      // zurück, und ein gesetztes Ziel wäre eine zweite Wahrheit über denselben
      // Anhängepunkt.
      vertices.push(v);
    });

    var hatLadeZeile = vertices.some(function (v) { return isCharging(v.role); });
    var H = hatLadeZeile
      ? chargingY + GEOM.NODE_R + GEOM.LBL_GAP + 2 * GEOM.LBL_LH + 10
      : BASE_H;
    return { W: W, H: H, hubX: hubX, hubY: hubY, vertices: vertices };
  }

  function vertex(node, p, members) {
    var names = [];
    members.forEach(function (m) {
      var n = (m.label || "").trim();
      if (n) names.push(n);
    });
    return {
      key: node.role + ":" + members.length,
      role: node.role,
      x: p.x, y: p.y,
      label: ROLE_NODE_LABEL[node.role] || node.role,
      fullLabel: names.join(", ") || ROLE_NODE_LABEL[node.role] || node.role,
      subLine: subLabelFor(node.role, node, members.length),
      value: vertexValue(node.role, node, node.value_kw),
      spokeActive: !!node.flow_active,
      reverse: node.direction === "out",
      strokeWidth: strokeWidth(node.value_kw != null ? node.value_kw : 0),
      baseWidth: 6,
      expandable: node.role === "pv" && members.length > 1,
      members: members
    };
  }

  // ---------- Kachel-Leiste ----------

  function signedBattery(n) {
    if (n.value_kw == null || !n.flow_active) return 0;
    return n.direction === "out" ? n.value_kw : (n.direction === "in" ? -n.value_kw : 0);
  }

  function findNode(topo, role) {
    var nodes = (topo && topo.nodes) || [];
    for (var i = 0; i < nodes.length; i++) if (nodes[i].role === role) return nodes[i];
    return null;
  }

  // Eine Kachel je Mitglied - wie bei den Verbrauchern, denn genau so stand
  // eine Wallbox auf jeder Box vor der Rolle `charging` da. `eigen` sagt in der
  // Zusatzzeile, dass diese Säule NICHT hinter dem Hausanschluss hängt.
  function memberTiles(node, opts) {
    return (node.members || []).map(function (m, i) {
      var active = m.value_kw != null && Math.abs(m.value_kw) > DEADBAND_KW;
      return {
        key: opts.keyPrefix + "-" + m.entity_id + "-" + i,
        tile: "load", icon: opts.icon,
        title: (m.label || "").trim() || opts.fallbackTitle,
        valueText: m.value_kw == null ? "–" : nf1.format(Math.abs(m.value_kw)),
        unit: m.value_kw == null ? "" : "kW",
        stateLabel: m.value_kw == null ? "wartet auf Daten" : (active ? opts.onLabel : opts.offLabel),
        subLine: opts.subLine || ""
      };
    });
  }

  function deriveTiles(topo) {
    var tiles = [];
    var pv = findNode(topo, "pv");
    if (pv) {
      var pvActive = pv.flow_active && pv.value_kw != null && pv.value_kw > DEADBAND_KW;
      var pvCount = pv.members.length;
      tiles.push({
        key: "role-pv", tile: "pv", icon: "sun",
        title: pvCount === 1 ? ((pv.members[0].label || "").trim() || "PV-Anlage") : "PV-Erzeugung",
        valueText: pv.value_kw == null ? "–" : nf1.format(pv.value_kw), unit: pv.value_kw == null ? "" : "kW",
        stateLabel: pv.value_kw == null ? "wartet auf Daten" : (pvActive ? "erzeugt" : "keine Erzeugung"),
        subLine: pvCount > 1 ? pvCount + " Erzeuger" : ""
      });
    }
    var st = findNode(topo, "storage");
    if (st) {
      var soc = st.soc_pct != null ? st.soc_pct : null;
      var batt = signedBattery(st);
      var sState = "Bereit", sArrow = null, sSub = "";
      if (soc == null) { sState = "keine Batterie"; }
      else if (batt > DEADBAND_KW) { sState = "Lädt"; sArrow = "up"; sSub = "Ladeleistung " + nf1.format(batt) + " kW"; }
      else if (batt < -DEADBAND_KW) { sState = "Entlädt"; sArrow = "down"; sSub = "Abgabe " + nf1.format(Math.abs(batt)) + " kW"; }
      else if (soc >= 99) { sState = "Voll geladen"; }
      tiles.push({
        key: "role-storage", tile: "batt", icon: "battery",
        title: st.members.length === 1 ? ((st.members[0].label || "").trim() || "Speicher") : "Speicher",
        valueText: soc == null ? "–" : nf0.format(soc), unit: soc == null ? "" : "%",
        stateLabel: sState, arrow: sArrow, subLine: sSub,
        socPct: soc == null ? null : Math.max(0, Math.min(100, soc))
      });
    }
    var cons = findNode(topo, "consumer");
    if (cons) {
      tiles = tiles.concat(memberTiles(cons, {
        keyPrefix: "consumer", icon: "home", fallbackTitle: "Verbraucher",
        onLabel: "aktiv", offLabel: "aus"
      }));
    }
    // Laden steht bei den Verbrauchern - es IST Verbrauch, nur ein benannter
    // Teil davon (deshalb auch die Verbraucher-Kachelklasse, keine sechste
    // Farbe).
    var lade = findNode(topo, "charging");
    if (lade) {
      tiles = tiles.concat(memberTiles(lade, {
        keyPrefix: "charging", icon: "battery-charging", fallbackTitle: "Ladepunkt",
        onLabel: "lädt", offLabel: "lädt nicht"
      }));
    }
    var ladeEigen = findNode(topo, "charging-own");
    if (ladeEigen) {
      tiles = tiles.concat(memberTiles(ladeEigen, {
        keyPrefix: "charging-own", icon: "battery-charging", fallbackTitle: "Ladepunkt",
        onLabel: "lädt", offLabel: "lädt nicht", subLine: "eigener Anschluss"
      }));
    }
    var grid = findNode(topo, "grid");
    if (grid) {
      var gActive = grid.flow_active && grid.value_kw != null && grid.value_kw > DEADBAND_KW;
      var gState = "wartet auf Daten", gArrow = null, gSub = "";
      if (grid.value_kw != null) {
        if (gActive && grid.direction === "in") { gState = "Netzbezug"; gArrow = "up"; gSub = "aus dem Netz"; }
        else if (gActive && grid.direction === "out") { gState = "Einspeisung"; gArrow = "down"; gSub = "ins Netz"; }
        else { gState = "ausgeglichen"; }
      }
      tiles.push({
        key: "role-grid", tile: "grid", icon: "zap", title: "Netz",
        valueText: grid.value_kw == null ? "–" : nf1.format(grid.value_kw), unit: grid.value_kw == null ? "" : "kW",
        stateLabel: gState, arrow: gArrow, subLine: gSub
      });
    }
    return tiles;
  }

  global.VPFlowRollen = {
    DEADBAND_KW: DEADBAND_KW,
    GEOM: GEOM,
    ROLE_SIDE: ROLE_SIDE,
    ROLE_NODE_LABEL: ROLE_NODE_LABEL,
    isCharging: isCharging,
    flowLayout: flowLayout,
    deriveTiles: deriveTiles
  };
})(window);
