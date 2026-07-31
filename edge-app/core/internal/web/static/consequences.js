// VoltPilot Edge - die Nebenwirkungs-Regel (Settings-Inkrement E3).
//
// REGEL: Ein Bedienelement, das ANDERSWO einen freigegebenen, bestätigten oder
// aufgezeichneten Zustand entwertet, NENNT diese Folge in seiner eigenen
// Rückfrage - vorher, nicht als Meldung hinterher.
//
// Der behobene Fall (Wunde 2 des Settings-Reports): die Kalibrier-Korrekturen
// ("Steuer-Vorzeichen umkehren", "Mess-Vorzeichen der Batterie umkehren",
// "Leistungsskalierung ×1/×10") nehmen die Steuerungs-Freigabe dieses Geräts
// zurück (agent/calibration.go CalibrationCorrection: ResetConfirmations +
// delete(a.calCert, family)). Fachlich ist das RICHTIG - nach einer
// Vorzeichenänderung ist der Beweis wertlos. Falsch war nur, dass es niemand
// ankündigte: der Knopf sagte "umkehren", nicht "und die Freigabe erlischt",
// und ohne Freigabe steuert der VoltPilot-Fahrplan diesen Wechselrichter nicht
// mehr.
//
// Dieses Modul ist REIN (kein DOM, kein fetch, kein Zustand): jede Funktion
// baut aus einem Zustands-Schnappschuss den deutschen Rückfrage-Text - oder
// null, wenn diese Aktion nachweislich NICHTS entwertet. null heißt
// ausdrücklich "keine Rückfrage": ein Dialog ohne Folge wäre Lärm, und ein
// Dialog, der eine Folge BEHAUPTET, die nicht eintritt, wäre eine Lüge. Die
// Texte nennen deshalb nur, was der Server an dieser Stelle wirklich tut.
//
// `ask` ist die eine Stelle, an der aus dem Text eine Rückfrage wird - nach
// dem Bestandsmuster der Box (window.confirm, wie sources.js es für das
// Entfernen einer Energiequelle schon nutzt).
(function (global) {
  "use strict";

  // Wer erneut bestätigen/freigeben muss, soll auch wissen wie - eine Folge
  // ohne Weg wäre nur eine Drohung.
  var AGAIN = "Danach mit einem neuen Testlauf erneut bestätigen und freigeben.";
  var PLAN_STOPS =
    "Der VoltPilot-Fahrplan steuert diesen Wechselrichter dann nicht mehr, bis Sie ihn erneut freigeben.";

  function join(intro, lines, question) {
    var body = lines.map(function (l) { return "• " + l; }).join("\n");
    return intro + "\n\n" + body + "\n\n" + question;
  }

  // Was eine Kalibrier-Korrektur (Vorzeichen / Skalierung) wirklich entwertet -
  // abgeleitet aus dem /api/calibration-Schnappschuss, damit der Text nie mehr
  // behauptet als der Server tut:
  //   device_certified    -> die auf DIESEM Gerät erteilte Freigabe fällt weg
  //   sign/scaleConfirmed -> die Haken werden zurückgesetzt
  //   evidence/readback   -> das Ergebnis des letzten Tests wird verworfen
  // Nichts davon gesetzt (frisch scharfgeschaltet, noch nichts bewiesen) ->
  // leer: dann speichert die Korrektur nur einen Verbindungswert.
  //
  // Load-bearing: es zählt `device_certified`, NICHT `certified`. `certified`
  // ist die VEREINIGUNG aus der flottenweiten Allowlist
  // (VP_CONTROL_CERTIFIED_FAMILIES, per Default `sunspec`) und der auf diesem
  // Gerät per First-Light erteilten Freigabe - die Korrektur entfernt aber nur
  // die zweite Hälfte (agent/calibration.go: delete(a.calCert, family)). Auf
  // einer allowlist-freigegebenen Familie wäre "die Freigabe wird
  // zurückgenommen" also schlicht falsch - live nachgemessen.
  function calibrationCorrectionEffects(cal) {
    var c = cal || {};
    var out = [];
    if (c.device_certified) {
      out.push({
        key: "freigabe",
        text: "Die Steuerungs-Freigabe dieses Wechselrichters wird zurückgenommen. " + PLAN_STOPS,
      });
    }
    if (c.sign_confirmed || c.scale_confirmed) {
      out.push({
        key: "bestaetigungen",
        text: "Ihre Bestätigungen für Vorzeichen und Skala werden zurückgesetzt.",
      });
    }
    if (c.evidence_valid || c.write_readback_ok) {
      out.push({ key: "testergebnis", text: "Das Ergebnis des letzten Testlaufs wird verworfen." });
    }
    return out;
  }

  // label = der Knopftext, damit die Rückfrage die Aktion beim Namen nennt.
  function calibrationCorrection(cal, label) {
    var effects = calibrationCorrectionEffects(cal);
    if (!effects.length) return null;
    var what = label ? "„" + label + "“" : "Diese Korrektur";
    return join(
      what + " hat eine Folge:",
      effects.map(function (e) { return e.text; }),
      AGAIN + "\n\nFortfahren?"
    );
  }

  // "Freigabe zurücknehmen" nennt seine eigene Wirkung schon im Knopftext -
  // aber nicht, was sie für die ANLAGE bedeutet. Genau das steht hier. Und
  // wieder gilt die Zwei-Hälften-Regel: kommt die Freigabe aus der
  // flottenweiten Allowlist, nimmt dieser Knopf sie NICHT zurück - dann sagt
  // der Dialog genau das, statt eine Wirkung zu versprechen, die ausbleibt.
  function calibrationDecertify(cal) {
    var c = cal || {};
    if (!c.certified) return null;
    if (!c.device_certified) {
      return join(
        "Diese Freigabe stammt nicht von diesem Gerät:",
        [
          "Der Wechselrichter ist über die VoltPilot-Konfiguration freigegeben, " +
            "nicht über eine Kalibrierung auf diesem Gerät.",
          "Dieser Knopf kann sie deshalb nicht zurücknehmen - der Wechselrichter " +
            "bleibt steuerbar. Bitte wenden Sie sich an VoltPilot.",
        ],
        "Trotzdem fortfahren?"
      );
    }
    return join(
      "Die Steuerungs-Freigabe zurücknehmen hat eine Folge:",
      [
        "Der Wechselrichter wird wieder auf nur-lesend gestellt. " + PLAN_STOPS,
        "Ihre Bestätigungen bleiben erhalten - Sie können jederzeit erneut freigeben.",
      ],
      "Fortfahren?"
    );
  }

  // Dasselbe je physischer Einheit für die PV-Abregelung.
  function curtailDecertify(unit) {
    if (!unit || !unit.certified) return null;
    var name = unit.label || unit.source_id || "dieser Wechselrichter";
    return join(
      "Die Abregelungs-Freigabe von „" + name + "“ zurücknehmen hat eine Folge:",
      [
        "Der Fahrplan kann diesen Wechselrichter dann nicht mehr abregeln - " +
          "auch nicht bei negativen Strompreisen.",
        "Die Anlage läuft weiter, sie wird nur nicht mehr begrenzt.",
      ],
      "Fortfahren?"
    );
  }

  // Eine Energiequelle zu entfernen entwertet je nach Rolle etwas anderes -
  // und wenn sie für die Abregelung FREIGEGEBEN ist, fällt diese Freigabe
  // faktisch mit weg (ohne Quelle gibt es nichts zu begrenzen).
  // curtailUnits = die units-Liste aus /api/curtail (darf fehlen).
  function sourceRemoval(source, curtailUnits) {
    var s = source || {};
    var lines = [];
    if (s.role === "grid-meter") {
      lines.push("Der Netzbezug wird dann wieder vom Speicher-Wechselrichter gemessen.");
    } else if (s.role === "consumer") {
      lines.push("Sein Verbrauch wird dann nicht mehr mitgemessen.");
    } else {
      lines.push("Ihre Erzeugung fließt dann nicht mehr in die Gesamt-PV ein.");
    }
    if (isCurtailCertified(s.id, curtailUnits)) {
      lines.push(
        "Die Abregelungs-Freigabe dieses Wechselrichters verfällt damit - " +
          "der Fahrplan kann ihn nicht mehr abregeln."
      );
    }
    var name = s.label || s.id || "diese Energiequelle";
    return join("„" + name + "“ entfernen hat eine Folge:", lines, "Fortfahren?");
  }

  function isCurtailCertified(sourceID, units) {
    if (!sourceID || !units || !units.length) return false;
    for (var i = 0; i < units.length; i++) {
      if (units[i] && units[i].source_id === sourceID && units[i].certified) return true;
    }
    return false;
  }

  // Die Wechselrichter-Auswahl ist der ZWEITE Weg an dieselben Werte, die die
  // Kalibrier-Korrektur schützt (Vorzeichen, Leistungsskalierung,
  // Schreib-Funktionscode, Fernsteuerung) - nur nimmt der Server hier NICHTS
  // zurück. Beide Fälle werden deshalb ehrlich unterschieden:
  //
  //   Familienwechsel (anderes Modell)  -> die Freigabe gilt für die bisherige
  //       Modell-Familie; für die neue besteht keine, der Fahrplan steuert also
  //       ab dem Speichern nicht mehr.
  //   gleiche Familie, geänderte Steuerwerte -> die Freigabe BLEIBT, obwohl sie
  //       mit den bisherigen Werten nachgewiesen wurde. Das ist keine
  //       Entwertung, sondern ein veralteter Beweis - und genau so wird es
  //       gesagt, nie als "wird zurückgenommen".
  //
  // Auch hier zählt NUR die auf diesem Gerät erteilte Freigabe: über die
  // flottenweite Allowlist ist nicht entscheidbar, ob sie das neue Modell
  // ebenfalls abdeckt - dann wird lieber nichts behauptet als etwas Falsches.
  // Ohne Freigabe (der Normalfall) gibt es nichts zu nennen -> null.
  var CONTROL_KEYS = [
    "invert_control_sign",
    "power_scale",
    "control_write_fc",
    "remote_mode",
    "remote_battery_strategy",
    "remote_watchdog_s",
    "invert_batt_sign",
  ];

  function inverterChange(cal, current, next) {
    var c = cal || {};
    if (!c.device_certified) return null;
    var cur = current || {};
    var nxt = next || {};
    var curFamily = norm(cur.family || c.family);
    var nextFamily = norm(nxt.family);
    if (nextFamily && curFamily && nextFamily !== curFamily) {
      return join(
        "Ein anderes Modell zu wählen hat eine Folge:",
        [
          "Die auf diesem Gerät erteilte Steuerungs-Freigabe gilt für das bisherige " +
            "Modell. Für das neue Modell besteht hier noch keine Freigabe.",
          PLAN_STOPS,
        ],
        AGAIN + "\n\nFortfahren?"
      );
    }
    if (!changedControlKeys(cur.connection, nxt.connection).length) return null;
    return join(
      "Diese Änderung betrifft Werte, mit denen die Steuerung nachgewiesen wurde:",
      [
        "Die Steuerungs-Freigabe bleibt bestehen - sie wurde aber mit den " +
          "bisherigen Werten nachgewiesen und ist damit nicht mehr belegt.",
        "Bitte die Steuerung anschließend erneut testen (Steuerung kalibrieren).",
      ],
      "Fortfahren?"
    );
  }

  function changedControlKeys(a, b) {
    var x = a || {};
    var y = b || {};
    var out = [];
    for (var i = 0; i < CONTROL_KEYS.length; i++) {
      var k = CONTROL_KEYS[i];
      if (!(k in x) && !(k in y)) continue;
      if (!same(x[k], y[k])) out.push(k);
    }
    return out;
  }

  // Ein leeres Feld und ein fehlendes Feld sind derselbe "nicht gesetzt";
  // die Selects liefern Strings, der Server Zahlen - also über String
  // vergleichen, Booleans über die Wahrheit.
  function same(a, b) {
    if (a === undefined || a === null || a === "") a = "";
    if (b === undefined || b === null || b === "") b = "";
    if (typeof a === "boolean" || typeof b === "boolean") return !!a === !!b;
    return String(a) === String(b);
  }

  function norm(s) {
    return String(s == null ? "" : s).trim().toLowerCase();
  }

  // Aus dem Text wird hier - und nur hier - eine Rückfrage. Ohne Text
  // (nichts wird entwertet) läuft die Aktion unverändert durch; ohne
  // verfügbares confirm (Test/Kiosk) wird NICHT blockiert, sondern
  // durchgelassen - eine Rückfrage darf eine Bedienung nie unmöglich machen.
  function ask(message) {
    if (!message) return true;
    if (typeof global.confirm !== "function") return true;
    return !!global.confirm(message);
  }

  global.VPConsequences = {
    calibrationCorrection: calibrationCorrection,
    calibrationCorrectionEffects: calibrationCorrectionEffects,
    calibrationDecertify: calibrationDecertify,
    curtailDecertify: curtailDecertify,
    sourceRemoval: sourceRemoval,
    inverterChange: inverterChange,
    changedControlKeys: changedControlKeys,
    ask: ask,
    CONTROL_KEYS: CONTROL_KEYS,
  };
})(window);
