// VoltPilot Edge - die MODELL-SUCHE des Wechselrichter-Pickers (rein).
//
// Sie ist der PRIMÄRE Weg zum Modell: getippt wird der Name vom Typenschild,
// gesucht wird über ALLE Marken des Katalogs. Das Marken-Stufenmenü daneben
// bleibt der Stöber-Weg - wer seine Marke kennt, klickt sie weiter an.
//
// Zwei Regeln, und beide sind der Grund für diese Datei:
//
//   * SCHREIBWEISEN-TOLERANT. Ein Typenschild trägt "SUN-30K-SG01HP3-EU",
//     getippt wird "sun 30k" oder "SUN30K". Verglichen wird deshalb auf einer
//     normalisierten Fassung (klein, ohne Umlaute/ß, ohne Trenner) - die
//     frühere Suche verglich roh und fand genau diese Eingaben nicht.
//   * HERVORGEHOBEN wird im ORIGINAL. Die Fundstelle liegt in der
//     normalisierten Fassung, markiert werden muss aber der Text, den der
//     Kunde liest - dafür trägt `normalisiere` eine Rückbildung Zeichen für
//     Zeichen (`idx`).
//
// Der Portal-Assistent trägt dieselbe Suche in `frontend/portal/src/
// komponentenAssistent.ts`; beide Seiten sprechen dieselbe Sprache, weil der
// Kunde denselben Namen tippt. Sie teilen KEINEN Code (verschiedene Laufzeiten,
// verschiedene Katalog-Formen) - wer die Regeln ändert, ändert beide.
(function (global) {
  "use strict";

  // Höchstens so viele Treffer werden gezeigt; der Rest wird GEZÄHLT, nie
  // verschwiegen (eine gekappte Liste, die so tut, als wäre sie vollständig,
  // ist die schlechtere Auskunft).
  var MAX_TREFFER = 12;

  var UMLAUTE = { "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss" };

  // normalisiere gibt die Vergleichsfassung UND die Rückbildung: idx[i] ist der
  // Index im ORIGINAL, an dem das normalisierte Zeichen i entstanden ist.
  function normalisiere(text) {
    var s = String(text == null ? "" : text);
    var norm = "", idx = [];
    for (var i = 0; i < s.length; i++) {
      var c = s[i].toLowerCase();
      var ersatz = UMLAUTE[c];
      if (ersatz === undefined) {
        // Akzente entfernen (é -> e); ein Zeichen ohne Zerlegung bleibt es selbst.
        var zerlegt = c.normalize ? c.normalize("NFD").replace(/[̀-ͯ]/g, "") : c;
        ersatz = zerlegt;
      }
      // Trenner fallen ganz weg - "SUN-30K" und "sun 30k" sind dasselbe Gerät.
      ersatz = ersatz.replace(/[\s\-_./]/g, "");
      for (var k = 0; k < ersatz.length; k++) { norm += ersatz[k]; idx.push(i); }
    }
    return { norm: norm, idx: idx };
  }

  function normText(text) { return normalisiere(text).norm; }

  // begriffe zerlegt die Eingabe in UND-verknüpfte Begriffe: jeder muss
  // vorkommen, sonst fände "deye 30k" jede Deye UND jedes 30K-Gerät.
  function begriffe(query) {
    return String(query == null ? "" : query)
      .split(/\s+/)
      .map(normText)
      .filter(function (t) { return t.length > 0; });
  }

  // hervorheben schneidet den ORIGINALTEXT in Stücke und markiert die
  // Fundstellen. Trenner, die ZWISCHEN zwei markierten Zeichen liegen, werden
  // mitmarkiert - sonst zerfiele "SUN-30K" bei der Suche "sun30k" sichtbar in
  // zwei Treffer mit einem unmarkierten Bindestrich dazwischen.
  function hervorheben(text, terme) {
    var s = String(text == null ? "" : text);
    if (!terme || !terme.length) return [{ text: s, treffer: false }];
    var n = normalisiere(s);
    var mark = new Array(s.length);
    var i;
    for (i = 0; i < s.length; i++) mark[i] = false;

    terme.forEach(function (t) {
      var von = 0, at;
      while ((at = n.norm.indexOf(t, von)) !== -1) {
        for (var k = at; k < at + t.length; k++) mark[n.idx[k]] = true;
        von = at + t.length;
      }
    });

    // Trenner zwischen zwei markierten Zeichen einschließen.
    for (i = 1; i < s.length - 1; i++) {
      if (mark[i] || !/[\s\-_./]/.test(s[i])) continue;
      var linksMark = false, rechtsMark = false, j;
      for (j = i - 1; j >= 0; j--) { if (!/[\s\-_./]/.test(s[j])) { linksMark = mark[j]; break; } }
      for (j = i + 1; j < s.length; j++) { if (!/[\s\-_./]/.test(s[j])) { rechtsMark = mark[j]; break; } }
      if (linksMark && rechtsMark) mark[i] = true;
    }

    var teile = [], puffer = "", aktiv = mark[0];
    for (i = 0; i < s.length; i++) {
      if (mark[i] !== aktiv) { teile.push({ text: puffer, treffer: aktiv }); puffer = ""; aktiv = mark[i]; }
      puffer += s[i];
    }
    if (puffer) teile.push({ text: puffer, treffer: aktiv });
    return teile.length ? teile : [{ text: s, treffer: false }];
  }

  // rang sortiert: Modell-Anfang vor Modell-Vorkommen vor Marken-Treffer.
  // Wer "SG04" tippt, meint das Modell, nicht "irgendetwas von dieser Marke".
  function rang(modell, marke, terme) {
    var m = normText(modell), b = normText(marke);
    var erster = terme[0];
    if (m.indexOf(erster) === 0) return 0;
    if (m.indexOf(erster) !== -1) return 1;
    if (b.indexOf(erster) === 0) return 2;
    return 3;
  }

  // trifft: JEDER Begriff muss irgendwo vorkommen (Marke, Modell, Notiz, Id,
  // Familie) - so findet auch "hybrid 3" oder "solarman" sein Gerät.
  function trifft(eintrag, terme) {
    var heu = normText([
      eintrag.brandLabel, eintrag.brand, eintrag.model.label, eintrag.model.id,
      eintrag.model.note, eintrag.model.family, eintrag.familyLabel
    ].filter(Boolean).join(" "));
    for (var i = 0; i < terme.length; i++) {
      if (heu.indexOf(terme[i]) === -1) return false;
    }
    return true;
  }

  // eintraege plattet den Katalog zu einer Liste {brand, brandLabel, model,
  // familyLabel} - die Suche kennt keine Marken-Grenze.
  function eintraege(catalog) {
    var out = [];
    if (!catalog || !catalog.brands) return out;
    catalog.brands.forEach(function (b) {
      var famLabel = {};
      (b.families || []).forEach(function (f) { famLabel[f.id] = f.label; });
      (b.models || []).forEach(function (m) {
        out.push({
          brand: b.id,
          brandLabel: b.label || b.id,
          model: m,
          familyLabel: famLabel[m.family] || ""
        });
      });
    });
    return out;
  }

  // zusatz beantwortet „ist das meins?" ohne Klick: Nennleistung, Bauart und
  // die Anbindungsart. Was der Katalog nicht kennt, steht NICHT da - eine
  // erfundene 0 kW wäre schlimmer als eine fehlende Angabe.
  function zusatz(eintrag, commLabel) {
    var teile = [];
    var kw = eintrag.model.rated_kw;
    if (typeof kw === "number" && kw > 0) {
      teile.push((Math.round(kw * 10) / 10).toLocaleString("de-DE") + " kW");
    }
    if (eintrag.familyLabel) teile.push(eintrag.familyLabel);
    if (eintrag.model.note) teile.push(eintrag.model.note);
    if (commLabel) teile.push(commLabel);
    return teile.join(" · ");
  }

  // suche ist das Ergebnis für die Fläche. Eine LEERE Eingabe liefert nichts -
  // die Suche behauptet dann gar nichts, das Stufenmenü darunter führt.
  function suche(catalog, query, commLabelFn) {
    var terme = begriffe(query);
    if (!terme.length) return { treffer: [], gesamt: 0, leer: null, zaehler: null };

    var alle = eintraege(catalog).filter(function (e) { return trifft(e, terme); });
    alle.sort(function (a, b) {
      var ra = rang(a.model.label, a.brandLabel, terme);
      var rb = rang(b.model.label, b.brandLabel, terme);
      if (ra !== rb) return ra - rb;
      var la = a.model.label || "", lb = b.model.label || "";
      return la.localeCompare(lb, "de");
    });

    if (!alle.length) {
      return {
        treffer: [], gesamt: 0, zaehler: null,
        leer: "Kein Modell passt zu „" + String(query).trim() + "“. Oft reicht ein Teil des " +
          "Namens, zum Beispiel nur „30K“ - sonst hilft die Marken-Auswahl darüber."
      };
    }

    var gezeigt = alle.slice(0, MAX_TREFFER);
    return {
      gesamt: alle.length,
      leer: null,
      // Eine Kappung wird GESAGT, nie verschwiegen.
      zaehler: alle.length > MAX_TREFFER
        ? gezeigt.length + " von " + alle.length + " Treffern - bitte genauer eingeben."
        : alle.length + (alle.length === 1 ? " Treffer" : " Treffer"),
      treffer: gezeigt.map(function (e) {
        return {
          brand: e.brand,
          brandLabel: e.brandLabel,
          model: e.model,
          marke: hervorheben(e.brandLabel, terme),
          modell: hervorheben(e.model.label || e.model.id, terme),
          zusatz: zusatz(e, commLabelFn ? commLabelFn(e.brand) : "")
        };
      })
    };
  }

  global.VPModellSuche = {
    MAX_TREFFER: MAX_TREFFER,
    normalisiere: normText,
    begriffe: begriffe,
    hervorheben: hervorheben,
    eintraege: eintraege,
    zusatz: zusatz,
    suche: suche
  };
})(window);
