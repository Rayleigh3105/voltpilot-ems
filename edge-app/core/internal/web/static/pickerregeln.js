// VoltPilot Edge - die REGELN des VpPicker (rein).
//
// Der Picker der Box ist die leichtgewichtige Zwillings-Fassung des
// Portal-VpPicker (Konzept `vp-picker-system`, Captain-genehmigt 21.08.2026:
// „alle Picker ... eigene Komponenten erstellen wo man drin suchen kann. Ich
// will nichts Browser-Standard-Zeug."). Auf der Box gibt es KEIN React und
// keine Bau-Kette - also pures Browser-JS; die ANATOMIE und die REGELN sind
// dieselben wie im Portal (`frontend/portal/src/picker/optionen.ts`).
//
// ⚠ WER DIE REGELN ÄNDERT, ÄNDERT BEIDE SEITEN. Sie teilen keinen Code
// (verschiedene Laufzeiten), aber derselbe Mensch bedient beide Flächen - und
// eine Liste, die im Portal anders auf Pfeiltaste und Tippen reagiert als auf
// der Box, ist genau der Bruch, den ein Picker-SYSTEM verhindern soll. Dieselbe
// Disziplin gilt schon für die Modell-Suche (modellsuche.js).
//
// Diese Datei rechnet und formuliert; sie rendert nichts und ruft nichts ab -
// damit ist jede Regel ohne DOM prüfbar (`jstest/ui.test.js`). Die TASTATUR ist
// hier ein Rechen-Gegenstand, kein Nebeneffekt: „der Eigenbau darf dem nativen
// Select in NICHTS nachstehen" ist nur prüfbar, wenn die Bewegung eine Funktion
// ist.
//
// Die TOLERANZ der Suche kommt aus modellsuche.js (window.VPModellSuche) -
// zwei Umsetzungen derselben Schreibweisen-Toleranz laufen auseinander, dann
// findet dieselbe Eingabe auf zwei Flächen Verschiedenes.
(function (global) {
  "use strict";

  // Ab wie vielen Zeilen die Suche von selbst erscheint. Darunter ist sie
  // Ballast: sieben Zeilen liest man schneller, als man tippt - und ein leeres
  // Suchfeld über drei Einträgen sieht aus, als fehlte etwas.
  var SUCHE_AB = 8;

  // Wie lange ein Tipp-Puffer gilt, bevor er neu beginnt (ms).
  var TIPP_PUFFER_MS = 900;

  function S() { return global.VPModellSuche; }

  function norm(text) { return S().normalisiere(text); }
  function begriffe(query) { return S().begriffe(query); }
  function hervorheben(text, terme) { return S().hervorheben(text, terme); }

  function sucheSichtbar(anzahl, modus) {
    if (modus === "immer") return true;
    if (modus === "nie") return false;
    return anzahl >= SUCHE_AB;
  }

  // Was durchsucht wird: Hauptzeile, Nebenzeile, Gruppe und die Stichwörter.
  // `keywords` ist zusätzlich durchsuchter, NICHT angezeigter Text (Modell-Id,
  // Familie) - er macht die Suche tolerant, ohne die Zeile zu füllen.
  function heuhaufen(o, gruppenLabel) {
    return norm([o.label, o.sub || "", gruppenLabel || o.group || "", o.keywords || ""].join(" "));
  }

  function passt(heu, terme) {
    for (var i = 0; i < terme.length; i++) {
      if (heu.indexOf(terme[i]) === -1) return false;
    }
    return true;
  }

  // Der Rang eines Treffers: was mit der Eingabe BEGINNT, steht oben - wer
  // tippt, meint fast immer den Namen und nicht eine Nebenangabe.
  function rang(o, terme) {
    var label = norm(o.label);
    var i;
    for (i = 0; i < terme.length; i++) { if (label.indexOf(terme[i]) === 0) return 0; }
    for (i = 0; i < terme.length; i++) { if (label.indexOf(terme[i]) !== -1) return 1; }
    var sub = norm(o.sub || "");
    if (sub !== "") {
      for (i = 0; i < terme.length; i++) { if (sub.indexOf(terme[i]) !== -1) return 2; }
    }
    return 3;
  }

  // suche: filtern + gruppieren in EINEM Durchgang.
  //
  // ⚠ Ohne Eingabe bleibt die REIHENFOLGE des Aufrufers unangetastet (nur die
  // Gruppen werden gebündelt). Eine Liste, die sich beim Öffnen umsortiert,
  // nimmt jedem seine Ortskenntnis.
  //
  // ⚠ Eine GESPERRTE Zeile wird mitgefiltert und mitgezeigt: sie ist die
  // Antwort auf „warum kann ich das nicht wählen?" und darf nicht verschwinden.
  function suche(optionen, query, gruppen, leerText) {
    optionen = optionen || [];
    gruppen = gruppen || [];
    var terme = begriffe(query);
    var labelVon = {};
    gruppen.forEach(function (g) { labelVon[g.key] = g.label; });

    var passend = terme.length === 0 ? optionen.slice() : optionen.filter(function (o) {
      return passt(heuhaufen(o, labelVon[o.group || ""] || null), terme);
    });

    if (!passend.length) {
      var q = String(query == null ? "" : query).trim();
      return {
        zeilen: [], anzahl: 0, gesamt: optionen.length,
        leer: (leerText ? leerText(q) : null)
          || (q === "" ? "Hier gibt es noch nichts zur Auswahl."
            : "Nichts passt zu „" + q + "“. Oft reicht ein Teil des Namens.")
      };
    }

    var sortiert = passend;
    if (terme.length > 0) {
      sortiert = passend.slice().sort(function (a, b) {
        var d = rang(a, terme) - rang(b, terme);
        return d !== 0 ? d : String(a.label).localeCompare(String(b.label), "de");
      });
    }

    var zeilen = [];
    function alsZeile(o) {
      return {
        art: "option", key: o.value,
        option: o,
        label: hervorheben(o.label, terme),
        sub: o.sub ? hervorheben(o.sub, terme) : null
      };
    }
    sortiert.filter(function (o) { return !o.group; }).forEach(function (o) { zeilen.push(alsZeile(o)); });

    var reihenfolge;
    if (gruppen.length > 0) {
      reihenfolge = gruppen.map(function (g) { return g.key; });
    } else {
      // Ohne erklärte Reihenfolge: die des ersten Vorkommens - nie alphabetisch
      // umsortiert, siehe oben.
      reihenfolge = [];
      sortiert.forEach(function (o) {
        if (o.group && reihenfolge.indexOf(o.group) === -1) reihenfolge.push(o.group);
      });
    }
    reihenfolge.forEach(function (key) {
      var drin = sortiert.filter(function (o) { return o.group === key; });
      if (!drin.length) return;
      zeilen.push({ art: "gruppe", key: key, label: labelVon[key] || key });
      drin.forEach(function (o) { zeilen.push(alsZeile(o)); });
    });

    return { zeilen: zeilen, anzahl: sortiert.length, gesamt: optionen.length, leer: null };
  }

  // Die Indizes der WÄHLBAREN Zeilen (ohne Überschriften, ohne Gesperrte).
  function waehlbare(zeilen) {
    var out = [];
    (zeilen || []).forEach(function (z, i) {
      if (z.art === "option" && !z.option.disabled) out.push(i);
    });
    return out;
  }

  // Die Bewegung mit Pfeiltasten.
  //
  // ⚠ Sie LÄUFT NICHT UM - wie das native Select. Ein Umlauf am Listenende
  // wirkt auf einer langen Liste wie ein Sprung ins Nichts, und Pos1/Ende sind
  // der ausdrückliche Weg an die Ränder.
  function naechster(zeilen, von, schritt) {
    var ziele = waehlbare(zeilen);
    if (!ziele.length) return -1;
    if (von < 0) return schritt > 0 ? ziele[0] : ziele[ziele.length - 1];
    var jetzt = ziele.indexOf(von);
    if (jetzt === -1) {
      // Der Anker steht auf einer Überschrift/Gesperrten: zur nächsten in der
      // Richtung, statt an den Anfang zu springen.
      var nach = null, vor = null, i;
      for (i = 0; i < ziele.length; i++) { if (ziele[i] > von) { nach = ziele[i]; break; } }
      for (i = ziele.length - 1; i >= 0; i--) { if (ziele[i] < von) { vor = ziele[i]; break; } }
      if (schritt > 0) return nach != null ? nach : ziele[ziele.length - 1];
      return vor != null ? vor : ziele[0];
    }
    var ziel = Math.min(Math.max(jetzt + schritt, 0), ziele.length - 1);
    return ziele[ziel];
  }

  // Die erste wählbare Zeile (oder die des Wertes, wenn er noch dabei ist).
  function ersteAktive(zeilen, wert) {
    if (wert != null) {
      for (var i = 0; i < zeilen.length; i++) {
        var z = zeilen[i];
        if (z.art === "option" && z.key === wert && !z.option.disabled) return i;
      }
    }
    var ziele = waehlbare(zeilen);
    return ziele.length ? ziele[0] : -1;
  }

  // Tippen-zum-Springen (ohne sichtbares Suchfeld, wie im nativen Select):
  // die nächste Zeile, deren Hauptzeile mit dem Puffer BEGINNT - ab der
  // aktuellen Position, danach von vorn.
  function tippSprung(zeilen, puffer, von) {
    var p = norm(puffer);
    if (p === "") return -1;
    var ziele = waehlbare(zeilen);
    if (!ziele.length) return -1;
    var startIdx = Math.max(0, ziele.indexOf(von));
    for (var k = 1; k <= ziele.length; k++) {
      var i = ziele[(startIdx + k) % ziele.length];
      var z = zeilen[i];
      if (z.art === "option" && norm(z.option.label).indexOf(p) === 0) return i;
    }
    // Wiederholt getippter gleicher Buchstabe („aaa") bleibt auf der aktuellen
    // Zeile stehen, statt zu wandern - das tut das native Select auch.
    var akt = zeilen[von];
    if (akt && akt.art === "option" && norm(akt.option.label).indexOf(p) === 0) return von;
    return -1;
  }

  // Die Beschriftung des Auslösers: der gewählte Wert oder der Platzhalter.
  //
  // ⚠ Der LEERE String ist eine gültige Wahl, wenn die Liste ihn führt (genau
  // wie im nativen `<option value="">`). Nur ein Wert, den die Liste NICHT
  // kennt, fällt auf den Platzhalter zurück.
  function ausloeserText(optionen, wert, platzhalter) {
    if (wert == null) return platzhalter;
    var gefunden = null;
    (optionen || []).forEach(function (o) { if (o.value === wert) gefunden = o; });
    return gefunden ? gefunden.label : platzhalter;
  }

  // Die Ansage für Vorlesesoftware - EIN Satz, nie eine Zahlenkolonne. Sie
  // behauptet nur, was gezählt wurde: ohne Suche wird die Trefferzahl gar nicht
  // genannt (die Liste steht ja vollständig da).
  function ansage(s, query) {
    if (s.leer) return s.leer;
    if (String(query == null ? "" : query).trim() === "") return "";
    return s.anzahl === 1 ? "1 Treffer" : s.anzahl + " Treffer";
  }

  global.VPPickerRegeln = {
    SUCHE_AB: SUCHE_AB,
    TIPP_PUFFER_MS: TIPP_PUFFER_MS,
    sucheSichtbar: sucheSichtbar,
    suche: suche,
    waehlbare: waehlbare,
    naechster: naechster,
    ersteAktive: ersteAktive,
    tippSprung: tippSprung,
    ausloeserText: ausloeserText,
    ansage: ansage
  };
})(window);
