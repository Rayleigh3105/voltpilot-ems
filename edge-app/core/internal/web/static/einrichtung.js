// Einrichtungsseite der Box (Bildschirme 2W' bis 6W'' des WLAN-Konzepts):
// Kennung, Kabel oder WLAN, Netzliste, Passwort, Empfangspruefung. Spricht
// NUR /api/einrichtung/* (einrichtung.go); waehrend "verbinden" wechselt das
// Funkmodul der Box zum Kunden-WLAN, das Handy verliert das
// Einrichtungs-WLAN kurz - das Abfragen vertraegt deshalb Netzfehler und
// fragt einfach weiter.
(function (global) {
  "use strict";

  // ---- Reine Helfer (jstest/ui.test.js prueft sie) -------------------------

  // zahl: wie Number(), aber ein leerer Wert ist KEINE Null - Number("") = 0
  // saehe sonst wie ein sehr starkes Signal aus.
  function zahl(x) {
    if (x === null || x === undefined || String(x).trim() === "") return NaN;
    return Number(x);
  }

  // balkenstufe: Signal in dBm -> 1..4 Balken fuer die Netzliste.
  function balkenstufe(signal) {
    var s = zahl(signal);
    if (!isFinite(s)) return 1;
    if (s >= -50) return 4;
    if (s >= -60) return 3;
    if (s >= -70) return 2;
    return 1;
  }

  // skala: Signal in dBm -> Fuellstand der Skala (-90..-30) und ob er unter
  // der Schwelle -70 liegt (Konzept 4.2: -70 oder besser reicht).
  function skala(signal, schwelle) {
    var s = zahl(signal);
    var g = zahl(schwelle);
    if (!isFinite(g)) g = -70;
    if (!isFinite(s)) return { prozent: 0, schwach: true };
    var p = Math.round(((Math.min(Math.max(s, -90), -30) + 90) / 60) * 100);
    return { prozent: p, schwach: s < g };
  }

  // ergebnisZiel: wohin nach einem beendeten verbinden-Lauf? (Rueckgaben des
  // Netz-Skripts: 0 verbunden, 4 Netz nicht gefunden, 5 Passwort.)
  function ergebnisZiel(rc, felder) {
    felder = felder || {};
    if (rc === 0) return felder.urteil === "reicht" ? "reicht" : "schwach";
    if (rc === 5) return "passwort";
    return "weg";
  }

  var VPEinrichtung = { balkenstufe: balkenstufe, skala: skala, ergebnisZiel: ergebnisZiel };
  global.VPEinrichtung = VPEinrichtung;
  if (!global.document || !global.document.getElementById("sAnmeldung")) return;

  // ---- Seite ----------------------------------------------------------------

  var $ = function (id) { return global.document.getElementById(id); };
  var doc = global.document;

  var netzGewaehlt = "";
  var sperrUhr = null;
  var pollUhr = null;

  function zeige(schritt) {
    ["sAnmeldung", "sWeg", "sPasswort", "sPruefen", "sErgebnis", "sFertig"].forEach(function (id) {
      $(id).hidden = id !== schritt;
    });
  }

  function api(pfad, methode, body) {
    var opt = { method: methode || "GET", headers: {} };
    if (body !== undefined) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    return global.fetch(pfad, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && j && j.anmeldung_erforderlich) {
          zeige("sAnmeldung");
          throw new Error("anmeldung");
        }
        return { status: r.status, body: j };
      });
    });
  }

  // ---- 2W': Kennung ----------------------------------------------------------

  function sperreZeigen(sekunden) {
    var ende = Date.now() + sekunden * 1000;
    var el = $("anmeldungSperre");
    el.hidden = false;
    $("anmeldungWeiter").disabled = true;
    if (sperrUhr) clearInterval(sperrUhr);
    function tick() {
      var rest = Math.max(0, Math.ceil((ende - Date.now()) / 1000));
      if (rest <= 0) {
        clearInterval(sperrUhr);
        el.hidden = true;
        $("anmeldungWeiter").disabled = false;
        return;
      }
      var m = Math.floor(rest / 60);
      el.textContent = "Zu viele Versuche. Bitte warten: noch " +
        (m > 0 ? m + " min " : "") + (rest % 60) + " s.";
    }
    tick();
    sperrUhr = setInterval(tick, 1000);
  }

  $("fAnmeldung").addEventListener("submit", function (ev) {
    ev.preventDefault();
    $("anmeldungFehler").hidden = true;
    api("/api/einrichtung/anmeldung", "POST", { kennung: $("kennung").value })
      .then(function (r) {
        if (r.status === 200 && r.body.angemeldet) {
          wegLaden();
          return;
        }
        if (r.status === 429) {
          sperreZeigen(r.body.gesperrt_s || 300);
          return;
        }
        var f = $("anmeldungFehler");
        f.textContent = (r.body && r.body.error) || "Das hat nicht geklappt.";
        if (r.body && typeof r.body.versuche_frei === "number" && r.body.versuche_frei > 0) {
          f.textContent += " Noch " + r.body.versuche_frei + " Versuche.";
        }
        f.hidden = false;
      })
      .catch(function () {});
  });

  // ---- 3W: Kabel oder WLAN ----------------------------------------------------

  function wegLaden() {
    zeige("sWeg");
    netzeSuchen();
    kabelStand();
  }

  function wahl(wlan) {
    $("wahlWlan").setAttribute("aria-selected", wlan ? "true" : "false");
    $("wahlKabel").setAttribute("aria-selected", wlan ? "false" : "true");
    $("wegWlan").hidden = !wlan;
    $("wegKabel").hidden = wlan;
    if (!wlan) kabelStand();
  }
  $("wahlWlan").addEventListener("click", function () { wahl(true); });
  $("wahlKabel").addEventListener("click", function () { wahl(false); });

  function netzeSuchen() {
    var liste = $("netzListe");
    liste.setAttribute("aria-busy", "true");
    $("netzSuchen").disabled = true;
    $("netzLeer").hidden = true;
    api("/api/einrichtung/netze")
      .then(function (r) {
        liste.setAttribute("aria-busy", "false");
        $("netzSuchen").disabled = false;
        liste.textContent = "";
        var netze = (r.body && r.body.netze) || [];
        if (r.body && r.body.fehler) {
          $("wegFehler").textContent = r.body.fehler;
          $("wegFehler").hidden = false;
        }
        $("netzLeer").hidden = netze.length > 0;
        netze.forEach(function (n) {
          var li = doc.createElement("li");
          var b = doc.createElement("button");
          b.type = "button";
          b.className = "er-netz";
          b.disabled = !n.geeignet;
          var balken = doc.createElement("span");
          balken.className = "er-balken";
          balken.dataset.stufe = String(balkenstufe(n.signal));
          for (var i = 0; i < 4; i++) balken.appendChild(doc.createElement("i"));
          var name = doc.createElement("span");
          name.className = "er-netz-name";
          name.textContent = n.ssid;
          if (n.hinweis) {
            var h = doc.createElement("span");
            h.className = "er-netz-hinweis";
            h.textContent = n.hinweis;
            name.appendChild(h);
          }
          b.appendChild(balken);
          b.appendChild(name);
          b.addEventListener("click", function () {
            netzGewaehlt = n.ssid;
            $("pwNetz").textContent = n.ssid;
            $("passwort").value = "";
            $("pwFehler").hidden = true;
            if (n.offen) { verbinden(""); return; }
            zeige("sPasswort");
          });
          li.appendChild(b);
          liste.appendChild(li);
        });
      })
      .catch(function () {
        liste.setAttribute("aria-busy", "false");
        $("netzSuchen").disabled = false;
      });
  }
  $("netzSuchen").addEventListener("click", netzeSuchen);

  function kabelStand() {
    api("/api/einrichtung/status")
      .then(function (r) {
        var st = (r.body && r.body.status) || {};
        var el = $("kabelStand");
        if (st.kabel === "ja" && st.modus === "kabel") {
          el.textContent = "Das Kabel steckt, die Box nutzt es bereits.";
          $("kabelUmstellen").hidden = true;
        } else if (st.kabel === "ja") {
          el.textContent = "Das Kabel steckt. Sie können die Box ganz auf das Kabel umstellen; die Geräte bekommen dann neue Adressen von der Box.";
          $("kabelUmstellen").hidden = false;
        } else {
          el.textContent = "Noch kommt an der Buchse „WAN“ keine Verbindung an.";
          $("kabelUmstellen").hidden = true;
        }
      })
      .catch(function () {});
  }
  $("kabelUmstellen").addEventListener("click", function () {
    $("kabelFehler").hidden = true;
    $("kabelUmstellen").disabled = true;
    api("/api/einrichtung/kabel", "POST", {})
      .then(function (r) {
        $("kabelUmstellen").disabled = false;
        var f = (r.body && r.body.felder) || {};
        if (r.body && r.body.rc === 0) {
          $("fertigText").textContent = "Die Box ist über das Netzwerkkabel verbunden. Weiter geht es im VoltPilot-Portal.";
          zeige("sFertig");
          return;
        }
        $("kabelFehler").textContent = f.meldung || "Das hat nicht geklappt.";
        $("kabelFehler").hidden = false;
      })
      .catch(function () { $("kabelUmstellen").disabled = false; });
  });

  // ---- 4W/5W: Passwort und Pruefung -------------------------------------------

  $("pwZeigen").addEventListener("click", function () {
    var p = $("passwort");
    var zeigen = p.type === "password";
    p.type = zeigen ? "text" : "password";
    this.setAttribute("aria-pressed", zeigen ? "true" : "false");
  });
  $("pwZurueck").addEventListener("click", function () { zeige("sWeg"); });

  $("fPasswort").addEventListener("submit", function (ev) {
    ev.preventDefault();
    verbinden($("passwort").value);
  });

  function verbinden(passwort) {
    api("/api/einrichtung/verbinden", "POST", { ssid: netzGewaehlt, passwort: passwort })
      .then(function (r) {
        if (r.status === 409) {
          // Ein Lauf ist schon unterwegs - einfach sein Ergebnis abholen.
          pruefungZeigen();
          return;
        }
        if (r.status !== 202) {
          $("pwFehler").textContent = (r.body && r.body.error) || "Das hat nicht geklappt.";
          $("pwFehler").hidden = false;
          return;
        }
        pruefungZeigen();
      })
      .catch(function () {
        $("pwFehler").textContent = "Keine Verbindung zur Box. Ist Ihr Handy noch im WLAN „VoltPilot-Einrichtung“?";
        $("pwFehler").hidden = false;
      });
  }

  function station(n) {
    ["st1", "st2", "st3"].forEach(function (id, i) {
      $(id).className = i < n ? "fertig" : i === n ? "aktiv" : "";
    });
  }

  function pruefungZeigen() {
    zeige("sPruefen");
    station(0);
    $("pruefenStand").textContent = "";
    var beginn = Date.now();
    if (pollUhr) clearInterval(pollUhr);
    pollUhr = setInterval(function () {
      var s = Math.round((Date.now() - beginn) / 1000);
      station(s < 10 ? 0 : s < 25 ? 1 : 2);
      api("/api/einrichtung/verbinden")
        .then(function (r) {
          $("pruefenStand").textContent = "";
          if (!r.body || r.body.laeuft !== false) return;
          clearInterval(pollUhr);
          ergebnisZeigen(r.body.rc, r.body.felder || {});
        })
        .catch(function (e) {
          if (e && e.message === "anmeldung") { clearInterval(pollUhr); return; }
          // Erwartet: das Handy haengt gerade zwischen den WLANs.
          $("pruefenStand").textContent = "Ihr Handy verbindet sich gerade neu …";
        });
    }, 2000);
  }

  function ergebnisZeigen(rc, felder) {
    var ziel = ergebnisZiel(rc, felder);
    if (ziel === "passwort") {
      zeige("sPasswort");
      $("pwFehler").textContent = "„" + netzGewaehlt + "“ hat das Passwort abgelehnt. Nochmal eingeben.";
      $("pwFehler").hidden = false;
      return;
    }
    if (ziel === "weg") {
      zeige("sWeg");
      $("wegFehler").textContent = felder.meldung || "Das hat nicht geklappt. Bitte erneut versuchen.";
      $("wegFehler").hidden = false;
      netzeSuchen();
      return;
    }
    skalaZeigen(felder.signal, felder.schwelle);
    if (ziel === "reicht") {
      $("ergTitel").textContent = "Empfang reicht";
      $("ergText").innerHTML = "Die Box ist mit Ihrem WLAN verbunden" +
        (felder.internet === "ja" ? " und erreicht das Internet." : ".") +
        " Die Geräte kommen per Netzwerkkabel in die Buchse <strong>„LAN“</strong>.";
      $("ergFertig").hidden = false;
      $("ergNeu").hidden = true;
      $("ergKabel").hidden = true;
    } else {
      $("ergTitel").textContent = "Empfang reicht nicht";
      $("ergText").textContent = "Die Box ist verbunden, aber der Empfang ist zu schwach für den Dauerbetrieb. " +
        "Hängen Sie die Box um - näher zum Router, höher, nicht in einen Metallschrank - und prüfen Sie neu.";
      $("ergFertig").hidden = true;
      $("ergNeu").hidden = false;
      $("ergKabel").hidden = false;
    }
    $("ergFehler").hidden = true;
    zeige("sErgebnis");
  }

  function skalaZeigen(signal, schwelle) {
    var s = skala(signal, schwelle);
    $("skalaWert").style.width = s.prozent + "%";
    $("skalaWert").className = "er-skala-wert" + (s.schwach ? " schwach" : "");
    $("skalaZahl").textContent = isFinite(zahl(signal)) ? signal + " dBm" : "";
  }

  $("ergFertig").addEventListener("click", function () { zeige("sFertig"); });
  $("ergNeu").addEventListener("click", function () {
    $("ergFehler").hidden = true;
    api("/api/einrichtung/status")
      .then(function (r) {
        var st = (r.body && r.body.status) || {};
        if (st.wlan_zustand !== "COMPLETED" || !st.wlan_signal) {
          $("ergFehler").textContent = "Die Box ist gerade nicht mit dem WLAN verbunden. Einen Moment, oder neu verbinden.";
          $("ergFehler").hidden = false;
          return;
        }
        var felder = { urteil: Number(st.wlan_signal) >= Number(st.schwelle || -70) ? "reicht" : "reicht_nicht",
          signal: st.wlan_signal, schwelle: st.schwelle, internet: "" };
        ergebnisZeigen(0, felder);
      })
      .catch(function () {});
  });
  $("ergKabel").addEventListener("click", function () {
    zeige("sWeg");
    wahl(false);
  });

  // ---- Start ------------------------------------------------------------------

  api("/api/einrichtung/anmeldung")
    .then(function (r) {
      if (r.body && r.body.verfuegbar === false) {
        $("nichtVerfuegbar").hidden = false;
        $("fAnmeldung").hidden = true;
        zeige("sAnmeldung");
        return;
      }
      if (r.body && r.body.angemeldet) {
        // Sitzung besteht (etwa nach dem kurzen WLAN-Wechsel der Pruefung):
        // erst nachsehen, ob noch ein Lauf unterwegs ist.
        api("/api/einrichtung/verbinden")
          .then(function (v) {
            if (v.body && v.body.laeuft) { pruefungZeigen(); return; }
            if (v.body && v.body.laeuft === false && typeof v.body.rc === "number") {
              ergebnisZeigen(v.body.rc, v.body.felder || {});
              return;
            }
            wegLaden();
          })
          .catch(function () { wegLaden(); });
        return;
      }
      zeige("sAnmeldung");
      if (r.body && r.body.gesperrt_s > 0) sperreZeigen(r.body.gesperrt_s);
    })
    .catch(function () { zeige("sAnmeldung"); });
})(window);
