/*
 * Box-Band auf der Anmeldeseite (Konzept vp-qr-einstieg, M4; entschieden 04.11.2026, QE-1 A).
 *
 * Wer den QR-Code unten auf einer VoltPilot-Box scannt, landet ohne Sitzung zuerst auf der
 * Empfangsseite des Portals; von dort ("Ich habe schon ein Konto") kommt er hierher. Das Portal
 * hat die Kennung der Box im Speicher dieses Browsers abgelegt (frontend/portal/src/koppelLink.ts):
 *   - sessionStorage "vp.koppel.ref"     = "edge-…"            (dieser Tab)
 *   - localStorage   "vp.koppel.vormerk" = {"ref":"edge-…","bis":<ms>}  (24 Stunden, QE-3 B)
 * Keycloak liegt unter derselben Herkunft (/auth/), darum kann dieses Skript beides lesen. Es zeigt
 * ueber dem Titel eine Zeile "Ihre Box EDGE-… wartet." - nur, was im Code stand, keine Serverabfrage.
 * Liegt Keycloak unter einer anderen Herkunft (lokal :8081), bleibt der Speicher leer und das Band weg.
 *
 * Die Kennung ist Eingabe: nur die Form "edge-" + sieben Zeichen aus dem Alphabet der Kennung wird
 * gezeigt, als Text (nie als HTML). Das Pruefzeichen hat das Portal vor dem Speichern geprueft; eine
 * dritte Kopie des Algorithmus gehoert nicht hierher (Vektoren: docs/contracts/edge-ref-vectors.json).
 * Schluessel und Wortlaut gemeinsam mit koppelLink.ts und koppelTexte.ts (bandText 'anmeldung') aendern.
 */
(function () {
  'use strict';

  var TAB = 'vp.koppel.ref';
  var VORMERKER = 'vp.koppel.vormerk';
  var FORM = /^edge-[abcdefghjkmnpqrstuvwxyz23456789]{7}$/;

  function gemerkteKennung() {
    try {
      var imTab = window.sessionStorage.getItem(TAB);
      if (imTab && FORM.test(imTab)) return imTab;
    } catch (e) {
      /* privater Modus: weiter mit dem Vormerker */
    }
    try {
      var roh = window.localStorage.getItem(VORMERKER);
      if (!roh) return null;
      var v = JSON.parse(roh);
      if (v && typeof v.ref === 'string' && typeof v.bis === 'number' && v.bis > Date.now() && FORM.test(v.ref)) {
        return v.ref;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  function init() {
    // Nur auf der eigentlichen Login-Seite (Benutzername/Passwort-Formular).
    var form = document.getElementById('kc-form-login');
    if (!form || document.getElementById('vp-box-band')) return;
    var kennung = gemerkteKennung();
    if (!kennung) return;

    var lang = (document.documentElement.getAttribute('lang') || 'de').slice(0, 2);
    var gedruckt = kennung.toUpperCase();
    var text =
      lang === 'en'
        ? 'Your box ' + gedruckt + ' is waiting. After signing in, you connect it to your system.'
        : 'Ihre Box ' + gedruckt + ' wartet. Nach der Anmeldung verbinden Sie sie mit Ihrer Anlage.';

    var band = document.createElement('div');
    band.id = 'vp-box-band';
    band.className = 'vpl-alert is-info';
    band.setAttribute('role', 'status');
    band.textContent = text;

    var titel = document.getElementById('kc-page-title');
    if (titel && titel.parentNode) titel.parentNode.insertBefore(band, titel);
    else form.parentNode.insertBefore(band, form);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
