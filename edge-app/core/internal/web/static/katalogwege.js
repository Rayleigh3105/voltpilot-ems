// VoltPilot Edge - die VERBINDUNGSWEGE des Geräte-Katalogs (rein).
//
// Seit der Katalog-Neustruktur (Konzept data/vp-anlegen-rework/konzept.md,
// Stufe 1) ist der Verbindungsweg eine Eigenschaft des GERÄTS, nie des
// Markennamens: ein Fronius Eco 27 spricht SunSpec Modbus, ein GEN24 die Solar
// API - und beide sind ein Fronius. Diese Datei beantwortet daraus die vier
// Fragen, die BEIDE Formulare stellen (das Wechselrichter-Formular und der
// Quellen-Drawer):
//
//   * welche Wege hat dieses Modell (erster = Vorgabe)?
//   * welches Registerprofil gilt auf einem Weg?
//   * welche Felder zeigt das Formular?
//   * welcher Weg steht gerade - und was passiert bei einem Wechsel?
//
// ⚠ Sie ist die Anzeige-Hälfte von `Brand.TransportsFor`/`FieldsFor`/
// `resolveTransport` in `edge-app/core/internal/inverter/inverter.go` - wer die
// Regeln dort ändert, ändert sie hier mit. Sie steht bewusst als EIGENE, reine
// Schicht da (das `VPModellSuche`/`VPControl`-Muster): zwei Kopien in
// inverter.js und sources.js wären zwei Wahrheiten über dieselbe Frage, und
// ohne DOM ist jede Regel ohne Browser prüfbar.
(function (global) {
  "use strict";

  var UEBERSTEUERUNG = "transport"; // der Schlüssel des Auswahlfeldes

  // wege: die Verbindungswege EINES Modells, erster = Vorgabe. Ein Modell ohne
  // eigene Angabe erbt die der Marke (der Normalfall: genau einer).
  function wege(brand, model) {
    if (model && model.transports && model.transports.length) return model.transports;
    return ((brand && brand.transports) || []).map(function (t) { return t.communication; });
  }

  function weg(brand, comm) {
    var found = null;
    ((brand && brand.transports) || []).forEach(function (t) {
      if (t.communication === comm) found = t;
    });
    return found;
  }

  // familie: das Registerprofil - die eigene Angabe des Modells, sonst die des
  // Wegs (bei Fronius/generisch gehört sie dem WEG, bei Deye/KOSTAL dem Produkt).
  function familie(brand, model, comm) {
    if (model && model.family) return model.family;
    var t = weg(brand, comm || wege(brand, model)[0]);
    return t ? (t.family || "") : "";
  }

  // felder: die Formularfelder eines Modells auf EINEM Weg. Bei mehreren Wegen
  // steht das Auswahlfeld des Katalogs voran.
  //
  // ⚠ OHNE gewähltes Modell gibt es nichts zu wählen: die Marke entscheidet
  // dann, und ein Auswahlfeld „Verbindungsweg" ohne Bezug wäre eine Frage zu
  // einem Gerät, das der Kunde noch gar nicht benannt hat.
  function felder(brand, model, comm) {
    var alle = (brand && brand.fields) || [];
    if (!model) return alle;
    var w = wege(brand, model);
    if (w.length < 2) return alle;
    var t = weg(brand, comm || w[0]);
    var basis = t ? (t.fields || []) : alle;
    var wahl = (model.fields || []).filter(function (f) { return f.key === UEBERSTEUERUNG; });
    return wahl.concat(basis);
  }

  // gewaehlterWeg: welcher Weg im Formular gilt.
  //
  // ⚠ Ein MODELLWECHSEL setzt auf den Vorgabeweg des NEUEN Modells zurück - der
  // Kunde hat ein anderes Gerät benannt, und dessen üblicher Weg ist die
  // Aussage. Ein stehengebliebener Weg des Vorgängers wäre eine Übersteuerung,
  // die niemand gewählt hat.
  //
  // `stand` = {modell, feldWert, gespeichert}: das Modell, dessen Formular
  // gerade steht; der Wert des Auswahlfeldes; der Weg einer schon
  // GESPEICHERTEN Auswahl (sie trägt ihn als `communication`).
  function gewaehlterWeg(brand, model, stand) {
    stand = stand || {};
    var w = wege(brand, model);
    var id = model ? model.id : null;
    if (id != null && id === stand.modell && w.indexOf(stand.feldWert) !== -1) {
      return stand.feldWert;
    }
    if (w.indexOf(stand.gespeichert) !== -1) return stand.gespeichert;
    return w[0];
  }

  // vorgaben: {key -> Vorgabewert} einer Feldmenge.
  function vorgaben(liste) {
    var out = {};
    (liste || []).forEach(function (f) { if (f.default != null) out[f.key] = f.default; });
    return out;
  }

  // ⚠ ohneVorgaben streicht jeden Wert, der GENAU die Vorgabe des VORIGEN Wegs
  // ist. Er wurde nicht eingetippt, sondern vorbelegt - und die Vorgabe des
  // einen Wegs ist beim anderen falsch (Port 80 gegen 502). Ein wirklich
  // eingetippter Wert bleibt stehen.
  function ohneVorgaben(conn, alt) {
    var out = {};
    alt = alt || {};
    Object.keys(conn || {}).forEach(function (k) {
      if (alt[k] != null && String(alt[k]) === String(conn[k])) return;
      out[k] = conn[k];
    });
    return out;
  }

  // sichtbar: die Marken, die eine Oberfläche anbieten darf. Eine ALIAS-Marke
  // bleibt auflösbar (eine Bestandsanlage trägt ihre Kennung), wird aber nicht
  // mehr angeboten - sonst stünde „Fronius" zweimal in der Liste.
  function sichtbar(brands) {
    return (brands || []).filter(function (b) { return !b.hidden; });
  }

  global.VPKatalogWege = {
    UEBERSTEUERUNG: UEBERSTEUERUNG,
    wege: wege,
    weg: weg,
    familie: familie,
    felder: felder,
    gewaehlterWeg: gewaehlterWeg,
    vorgaben: vorgaben,
    ohneVorgaben: ohneVorgaben,
    sichtbar: sichtbar
  };
})(typeof window !== "undefined" ? window : this);
