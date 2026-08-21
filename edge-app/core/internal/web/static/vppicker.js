// VoltPilot Edge - DER Picker der Box (`window.VPPicker`).
//
// Die leichtgewichtige Zwillings-Fassung des Portal-VpPicker: dieselbe
// ANATOMIE (Auslöser in Feld-Optik + Panel; am Telefon ein Bottom-Sheet),
// dieselben REGELN (pickerregeln.js), dieselbe SUCH-TOLERANZ
// (modellsuche.js) - aber ohne React und ohne jede Abhängigkeit: die Box
// liefert `static/*` direkt aus `//go:embed` und hat keine Bau-Kette.
//
// WARUM ÜBERHAUPT. Ein natives `<select>` kann drei Dinge nicht, die diese
// Seite braucht: darin SUCHEN (der Deye-Katalog trägt 47 Modelle), je Zeile
// eine NEBENZEILE zeigen („30 kW · Hybrid 3-phasig") und am Telefon eine
// Fläche sein, die ein Daumen trifft. Es sieht ausserdem auf jedem
// Betriebssystem anders aus als der Rest der Seite - auf einem Tablet im
// Technikraum öffnet Android statt der Liste ein System-Rad.
//
// ⚠ A11Y IST GEGENSTAND, NICHT BEIWERK. Der Eigenbau darf dem nativen Select
// in NICHTS nachstehen: `combobox`/`listbox`-Rollen, `aria-activedescendant`
// statt Fokus-Wanderung, Pfeile/Bild-auf-ab/Pos1/Ende, Eingabe, Escape,
// Tippen-zum-Springen, Fokus-Falle im Panel und eine `aria-live`-Ansage.
//
// ⚠ KEIN VERSTECKTES NATIVES ELEMENT ALS KRÜCKE. Ein verborgenes `<select>`
// daneben wäre eine zweite Wahrheit über denselben Wert - und Vorlesesoftware
// fände beide. Der Wert wohnt im Griff (`.wert()`) und, für die
// Formular-Sammlung der Verbindungsfelder, in `root.dataset.value`.
//
// ⚠ DAS PANEL HÄNGT AN `document.body` mit FESTEN Koordinaten, nie `absolute`
// im Feld: die Wirte dieser Seite (`.card`, `.drawer-body`, die Gruppen)
// tragen Scroll- und Überlauf-Grenzen - ein absolut positioniertes Panel wäre
// dort abgeschnitten und seine unteren Zeilen unklickbar.
//
// ⚠ static/* ist //go:embed-t - nach einer Änderung das Core-Binär neu bauen.
(function (global) {
  "use strict";

  var doc = global.document;
  var R = null;                 // window.VPPickerRegeln, spät geholt
  var SHEET_AB = 640;           // dieselbe Schwelle wie die CSS-Medienabfrage
  var WISCH_ZU_PX = 90;         // ab hier schliesst ein Zug am Griff wirklich
  var MIN_PANEL_PX = 240;       // schmaler passt keine Nebenzeile mehr
  var lfd = 0;

  function regeln() {
    if (!R) R = global.VPPickerRegeln;
    return R;
  }

  function el(tag, attrs, text) {
    var e = doc.createElement(tag);
    if (attrs) { for (var k in attrs) { if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]); } }
    if (text != null) e.textContent = text;
    return e;
  }

  function svg(pfad, breite) {
    var wrap = doc.createElement("span");
    wrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
      (breite || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      pfad + '</svg>';
    return wrap.firstChild;
  }

  function amTelefon() {
    // `matchMedia` fehlt in keinem Browser, den diese Box je sieht - der
    // Rückfall auf die Fensterbreite ist reine Vorsicht.
    if (global.matchMedia) return global.matchMedia("(max-width: " + SHEET_AB + "px)").matches;
    return (global.innerWidth || 1024) <= SHEET_AB;
  }

  // platziere: KOLLISIONS-UMSCHLAG - unter dem Feld, sonst darüber, und immer
  // waagerecht in den sichtbaren Bereich geklemmt.
  function platziere(feld, panel, sicht) {
    var r = feld.getBoundingClientRect();
    var ph = panel.offsetHeight;
    var rand = 12, luft = 4;
    var vw = (sicht && sicht.w) || doc.documentElement.clientWidth;
    var vh = (sicht && sicht.h) || doc.documentElement.clientHeight;
    var width = Math.max(r.width, MIN_PANEL_PX);
    var left = Math.max(rand, Math.min(r.left, Math.max(rand, vw - width - rand)));
    var top = r.bottom + luft;
    var oben = false;
    if (top + ph > vh - rand && r.top - luft - ph > rand) {
      top = r.top - luft - ph;
      oben = true;
    }
    top = Math.max(rand, Math.min(top, Math.max(rand, vh - ph - rand)));
    return { top: top, left: left, width: width, oben: oben };
  }

  function fokussierbare(root) {
    if (!root) return [];
    return Array.prototype.slice.call(root.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
  }

  // montiere baut EINEN Picker in `host` (ein leeres Element im Formular).
  //
  // opts: {id, optionen, gruppen, wert, platzhalter, suche, suchPlatzhalter,
  //        ariaLabel, labelledBy, leerText, onChange, klasse}
  function montiere(host, opts) {
    opts = opts || {};
    lfd += 1;
    var basisId = opts.id || ("vpp-" + lfd);
    var listeId = basisId + "-liste";

    var optionen = opts.optionen || [];
    var gruppen = opts.gruppen || [];
    // ⚠ OHNE gesetzten Wert steht die ERSTE Zeile - genau das tut ein
    // `<select>`, sobald es seine Optionen bekommt, und die Formulare hier
    // rechnen damit (`onBrandChange` fände sonst gar keine Marke). Wer wirklich
    // eine leere Wahl will, sagt es mit `ohneVorwahl: true` - dann steht der
    // Platzhalter, und der Aufrufer muss mit `null` umgehen können.
    var wert = opts.wert != null ? opts.wert
      : (opts.ohneVorwahl || !optionen.length ? null : optionen[0].value);
    var platzhalter = opts.platzhalter || "Bitte wählen …";
    var suchModus = opts.suche || "auto";
    var offen = false, aktiv = -1, query = "";
    var tipp = { puffer: "", zeit: 0 };
    var saat = null;   // Anker, den ein Tastendruck auf dem GESCHLOSSENEN Feld setzte
    var wischStart = null;
    var letzteZeilen = [];

    host.classList.add("vpp");
    if (opts.klasse) host.classList.add(opts.klasse);
    host.innerHTML = "";

    /* ---------------- Auslöser ---------------- */
    var ausloeser = el("button", {
      type: "button", id: basisId, class: "vpp-ausloeser",
      role: "combobox", "aria-haspopup": "listbox", "aria-expanded": "false"
    });
    if (opts.ariaLabel) ausloeser.setAttribute("aria-label", opts.ariaLabel);
    if (opts.labelledBy) {
      ausloeser.setAttribute("aria-labelledby", opts.labelledBy);
      // ⚠ Die Beschriftung bekommt ihr `for` ERST HIER, nicht schon im Markup:
      // der Auslöser entsteht in diesem Augenblick, ein `for` im HTML zeigte
      // bis dahin ins Leere. Chrome meldet genau das als „Incorrect use of
      // <label for=…>", und ein Klick auf die Beschriftung fokussierte nichts
      // (dieselbe Falle wie im Portal-VpPanel). Ein `button` ist beschriftbar,
      // die Verknüpfung ist danach also echt.
      // ⚠ `labelEl` gibt es, weil die Beschriftung eines dynamisch gebauten
      // Feldes beim Montieren noch GAR NICHT im Dokument hängt - eine Suche
      // über die id fände sie dort nicht (im Browser-Beweis aufgefallen).
      var lbl = opts.labelEl || doc.getElementById(opts.labelledBy);
      if (lbl && lbl.tagName === "LABEL") lbl.htmlFor = basisId;
    }
    var wertSpan = el("span", { class: "vpp-wert" });
    ausloeser.appendChild(wertSpan);
    var caret = svg('<path d="m6 9 6 6 6-6"/>', 2.2);
    caret.setAttribute("class", "vpp-caret");
    ausloeser.appendChild(caret);
    host.appendChild(ausloeser);

    /* ---------------- Panel (an body, nie im Feld) ---------------- */
    var panel = el("div", { class: "vpp-panel", id: basisId + "-panel" });
    var griff = el("div", { class: "vpp-griff", role: "presentation" });
    griff.appendChild(el("span"));
    panel.appendChild(griff);

    var suchZeile = el("div", { class: "vpp-suche" });
    suchZeile.appendChild(svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>'));
    var suchFeld = el("input", {
      type: "text", inputmode: "search", autocomplete: "off", autocorrect: "off",
      spellcheck: "false", enterkeyhint: "go",
      "aria-label": (opts.ariaLabel || "Auswahl") + " durchsuchen",
      placeholder: opts.suchPlatzhalter || "Suchen …"
    });
    suchZeile.appendChild(suchFeld);
    panel.appendChild(suchZeile);

    var liste = el("div", { class: "vpp-liste", id: listeId, role: "listbox", tabindex: "-1" });
    if (opts.ariaLabel) liste.setAttribute("aria-label", opts.ariaLabel);
    if (opts.labelledBy) liste.setAttribute("aria-labelledby", opts.labelledBy);
    panel.appendChild(liste);

    var status = el("p", { class: "vpp-status" });
    panel.appendChild(status);

    var ansageEl = el("span", { class: "vpp-ansage", role: "status", "aria-live": "polite" });
    panel.appendChild(ansageEl);

    var backdrop = el("div", { class: "vpp-backdrop", role: "presentation" });

    /* ---------------- Zeichnen ---------------- */

    function malText(node, teile) {
      node.textContent = "";
      (teile || []).forEach(function (t) {
        if (!t.text) return;
        if (t.treffer) node.appendChild(el("mark", null, t.text));
        else node.appendChild(doc.createTextNode(t.text));
      });
    }

    function optId(i) { return basisId + "-o" + i; }

    function zeichneAusloeser() {
      wertSpan.textContent = regeln().ausloeserText(optionen, wert, platzhalter);
      var kennt = false;
      optionen.forEach(function (o) { if (o.value === wert) kennt = true; });
      ausloeser.classList.toggle("is-leer", !kennt);
      // Der Wert für die Formular-Sammlung - siehe Kopf: kein verstecktes
      // natives Element, aber ein benannter Ort für den Wert.
      if (wert == null) delete host.dataset.value;
      else host.dataset.value = wert;
    }

    function zeichneListe() {
      var s = regeln().suche(optionen, query, gruppen, opts.leerText);
      letzteZeilen = s.zeilen;
      liste.innerHTML = "";
      status.hidden = !s.leer;
      if (s.leer) status.textContent = s.leer;

      s.zeilen.forEach(function (z, i) {
        if (z.art === "gruppe") {
          liste.appendChild(el("div", { class: "vpp-gruppe", role: "presentation" }, z.label));
          return;
        }
        var o = z.option;
        var row = el("div", {
          id: optId(i), class: "vpp-zeile", role: "option",
          "aria-selected": o.value === wert ? "true" : "false"
        });
        row.dataset.idx = String(i);
        if (o.disabled) {
          row.classList.add("is-gesperrt");
          row.setAttribute("aria-disabled", "true");
        }
        if (o.value === wert) row.classList.add("is-gewaehlt");

        if (o.dot) row.appendChild(el("span", { class: "vpp-dot state-" + o.dot, "aria-hidden": "true" }));
        var text = el("span", { class: "vpp-text" });
        var haupt = el("span", { class: "vpp-haupt" });
        malText(haupt, z.label);
        text.appendChild(haupt);
        if (z.sub) {
          var neben = el("span", { class: "vpp-neben" });
          malText(neben, z.sub);
          text.appendChild(neben);
        }
        // ⚠ Der Grund einer Sperre steht IN der Zeile - eine Sperre ohne Grund
        // ist ein Rätsel (Haus-Regel).
        if (o.disabled && o.disabledHint) {
          text.appendChild(el("span", { class: "vpp-sperrgrund" }, o.disabledHint));
        }
        row.appendChild(text);
        if (o.value === wert) {
          var haken = svg('<path d="M20 6 9 17l-5-5"/>', 3);
          haken.setAttribute("class", "vpp-haken");
          row.appendChild(haken);
        }
        row.addEventListener("mousedown", function (e) { e.preventDefault(); });
        row.addEventListener("click", function () { waehle(i); });
        liste.appendChild(row);
      });

      var text = regeln().ansage(s, query);
      if (ansageEl.textContent !== text) ansageEl.textContent = text;
    }

    function setzeAktiv(idx, scrollen) {
      var vorher = liste.querySelector(".vpp-zeile.is-aktiv");
      if (vorher) vorher.classList.remove("is-aktiv");
      aktiv = idx;
      var ziel = idx >= 0 ? liste.querySelector('[data-idx="' + idx + '"]') : null;
      if (!ziel) {
        liste.removeAttribute("aria-activedescendant");
        return;
      }
      ziel.classList.add("is-aktiv");
      liste.setAttribute("aria-activedescendant", ziel.id);
      if (scrollen && ziel.scrollIntoView) ziel.scrollIntoView({ block: "nearest" });
    }

    function waehle(idx) {
      var z = letzteZeilen[idx];
      if (!z || z.art !== "option" || z.option.disabled) return;
      var neu = z.option.value;
      var geaendert = neu !== wert;
      wert = neu;
      zeichneAusloeser();
      schliessen(true);
      if (geaendert && opts.onChange) opts.onChange(neu);
    }

    /* ---------------- Öffnen / Schliessen ---------------- */

    function anhaengen() {
      if (amTelefon()) {
        panel.classList.add("is-sheet");
        panel.style.top = ""; panel.style.left = ""; panel.style.width = "";
        panel.style.opacity = ""; panel.style.pointerEvents = "";
        return;
      }
      panel.classList.remove("is-sheet");
      var p = platziere(ausloeser, panel);
      panel.style.top = p.top + "px";
      panel.style.left = p.left + "px";
      panel.style.width = p.width + "px";
      panel.style.opacity = "";
      panel.style.pointerEvents = "";
      panel.classList.toggle("is-oben", p.oben);
    }

    function oeffnen() {
      if (offen || ausloeser.disabled) return;
      offen = true;
      query = "";
      suchFeld.value = "";
      var mitSuche = regeln().sucheSichtbar(optionen.length, suchModus);
      suchZeile.hidden = !mitSuche;
      griff.hidden = !amTelefon();
      zeichneListe();
      if (amTelefon()) doc.body.appendChild(backdrop);
      // Vor der ersten Messung durchsichtig, damit das Panel nicht für einen
      // Frame links oben aufblitzt. ⚠ NICHT `visibility: hidden`: darin ist
      // `focus()` ein No-op, und das Panel muss den Fokus sofort annehmen.
      panel.style.opacity = "0";
      panel.style.pointerEvents = "none";
      doc.body.appendChild(panel);
      ausloeser.setAttribute("aria-expanded", "true");
      ausloeser.setAttribute("aria-controls", listeId);
      anhaengen();
      setzeAktiv(saat != null && saat >= 0 ? saat : regeln().ersteAktive(letzteZeilen, wert), true);
      saat = null;
      (mitSuche ? suchFeld : liste).focus();
      doc.addEventListener("mousedown", aufKlickDaneben, true);
      global.addEventListener("resize", anhaengen);
      global.addEventListener("scroll", anhaengen, true);
    }

    function schliessen(fokusZurueck) {
      if (!offen) return;
      offen = false;
      query = "";
      aktiv = -1;
      panel.style.transform = "";
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      ausloeser.setAttribute("aria-expanded", "false");
      ausloeser.removeAttribute("aria-controls");
      doc.removeEventListener("mousedown", aufKlickDaneben, true);
      global.removeEventListener("resize", anhaengen);
      global.removeEventListener("scroll", anhaengen, true);
      if (fokusZurueck !== false) ausloeser.focus();
    }

    function aufKlickDaneben(e) {
      if (panel.contains(e.target) || host.contains(e.target)) return;
      schliessen(false);
    }

    /* ---------------- Tastatur ---------------- */

    // ⚠ Escape und die Fokus-Falle gelten für JEDEN Panel-Inhalt und stehen
    // deshalb genau EINMAL - am Panel, nicht am Suchfeld.
    panel.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); schliessen(true); return; }
      if (e.key !== "Tab") return;
      var f = fokussierbare(panel);
      if (!f.length) return;
      var i = f.indexOf(doc.activeElement);
      var ziel = e.shiftKey ? f[(i <= 0 ? f.length : i) - 1] : f[(i + 1) % f.length];
      e.preventDefault();
      if (ziel) ziel.focus();
    });

    function bewegung(e) {
      var Rg = regeln();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setzeAktiv(Rg.naechster(letzteZeilen, aktiv, e.key === "ArrowDown" ? 1 : -1), true);
        return true;
      }
      if (e.key === "PageDown" || e.key === "PageUp") {
        e.preventDefault();
        setzeAktiv(Rg.naechster(letzteZeilen, aktiv, e.key === "PageDown" ? 10 : -10), true);
        return true;
      }
      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        var ziele = Rg.waehlbare(letzteZeilen);
        if (ziele.length) setzeAktiv(e.key === "Home" ? ziele[0] : ziele[ziele.length - 1], true);
        return true;
      }
      if (e.key === "Enter") {
        // Eingabe wählt, sendet NIE das umgebende Formular ab.
        e.preventDefault();
        waehle(aktiv);
        return true;
      }
      return false;
    }

    suchFeld.addEventListener("keydown", function (e) { bewegung(e); });
    suchFeld.addEventListener("input", function () {
      query = suchFeld.value;
      zeichneListe();
      setzeAktiv(regeln().ersteAktive(letzteZeilen, null), true);
      if (!amTelefon()) anhaengen();
    });

    liste.addEventListener("keydown", function (e) {
      if (bewegung(e)) return;
      // TIPPEN-ZUM-SPRINGEN - ohne sichtbares Suchfeld genau wie nativ.
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      var jetzt = Date.now();
      var puffer = (jetzt - tipp.zeit > regeln().TIPP_PUFFER_MS) ? e.key : tipp.puffer + e.key;
      tipp = { puffer: puffer, zeit: jetzt };
      var i = regeln().tippSprung(letzteZeilen, puffer, aktiv);
      if (i >= 0) setzeAktiv(i, true);
    });

    ausloeser.addEventListener("click", function () { if (offen) schliessen(true); else oeffnen(); });
    ausloeser.addEventListener("keydown", function (e) {
      if (ausloeser.disabled) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        oeffnen();
        return;
      }
      // Tippen auf dem GESCHLOSSENEN Auslöser öffnet und nimmt das Zeichen mit.
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      if (regeln().sucheSichtbar(optionen.length, suchModus)) {
        oeffnen();
        suchFeld.value = e.key;
        query = e.key;
        zeichneListe();
        setzeAktiv(regeln().ersteAktive(letzteZeilen, null), true);
      } else {
        tipp = { puffer: e.key, zeit: Date.now() };
        var vorschau = regeln().suche(optionen, "", gruppen, opts.leerText);
        saat = regeln().tippSprung(vorschau.zeilen, e.key, -1);
        oeffnen();
      }
    });

    /* ---------------- Wisch-Schliessen (Telefon) ---------------- */
    griff.addEventListener("pointerdown", function (e) {
      wischStart = e.clientY;
      if (griff.setPointerCapture) griff.setPointerCapture(e.pointerId);
    });
    griff.addEventListener("pointermove", function (e) {
      if (wischStart == null) return;
      panel.style.transform = "translateY(" + Math.max(0, e.clientY - wischStart) + "px)";
    });
    griff.addEventListener("pointerup", function (e) {
      var weg = wischStart == null ? 0 : e.clientY - wischStart;
      wischStart = null;
      panel.style.transform = "";
      // Ein kurzer Zupfer schliesst NICHT - sonst fällt das Sheet bei jedem
      // Scroll-Versuch zu.
      if (weg > WISCH_ZU_PX) schliessen(true);
    });
    griff.addEventListener("pointercancel", function () {
      wischStart = null;
      panel.style.transform = "";
    });
    backdrop.addEventListener("click", function () { schliessen(true); });

    zeichneAusloeser();

    /* ---------------- Der Griff nach aussen ---------------- */
    return {
      root: host,
      ausloeser: ausloeser,
      // setOptionen ersetzt die Liste. Der bisherige Wert bleibt, wenn die
      // neue Liste ihn führt - sonst rückt die erste Zeile nach (genau das tut
      // ein `<select>`, dessen `<option>`s ausgetauscht werden).
      setOptionen: function (neu, neueGruppen) {
        optionen = neu || [];
        gruppen = neueGruppen || [];
        var kennt = false;
        optionen.forEach(function (o) { if (o.value === wert) kennt = true; });
        if (!kennt) wert = optionen.length ? optionen[0].value : null;
        if (offen) { zeichneListe(); setzeAktiv(regeln().ersteAktive(letzteZeilen, wert), true); }
        zeichneAusloeser();
      },
      setWert: function (v) { wert = v; if (offen) zeichneListe(); zeichneAusloeser(); },
      wert: function () { return wert; },
      anzahl: function () { return optionen.length; },
      setDisabled: function (b) {
        ausloeser.disabled = !!b;
        host.classList.toggle("is-gesperrt", !!b);
        if (b) schliessen(false);
      },
      setUngueltig: function (b) { host.classList.toggle("is-fehler", !!b); },
      focus: function () { ausloeser.focus(); },
      schliessen: function () { schliessen(false); }
    };
  }

  global.VPPicker = {
    montiere: montiere,
    // Nach aussen gelegt, damit ein Test die Verankerung ohne Browser prüfen kann.
    platziere: platziere,
    SHEET_AB: SHEET_AB,
    WISCH_ZU_PX: WISCH_ZU_PX,
    MIN_PANEL_PX: MIN_PANEL_PX
  };
})(window);
