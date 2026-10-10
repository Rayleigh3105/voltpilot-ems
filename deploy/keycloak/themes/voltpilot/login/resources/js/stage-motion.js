/*
 * Der Knopf, der die Buehne des VoltPilot-Login-Themes anhaelt.
 *
 * Die Buehne sind die Kacheln des Portals mit einem wandernden Lichtpunkt
 * (alle 2 s) und Laufpunkten im Ruhetempo 1,8 s. Sie laeuft endlos neben dem
 * Formular - also braucht sie
 * einen Weg, sie anzuhalten (WCAG 2.2.2 "Pausieren, Stoppen, Ausblenden").
 * `prefers-reduced-motion` haelt sie ohne Knopf an; CSS blendet den Knopf
 * dann aus.
 *
 * Drei Dinge, die man wissen muss:
 *
 *  1. DIESES SKRIPT LAEUFT IM <head>, VOR DEM BODY. Deshalb setzt es die
 *     Klasse auf <html>, nicht auf `.vpl`: eine gemerkte Wahl greift, bevor
 *     das erste Bild steht - die Buehne laeuft nicht erst an und springt dann.
 *
 *  2. DIE ERINNERUNG IST NUR EINE BEQUEMLICHKEIT. localStorage kann fehlen
 *     oder werfen (privates Fenster, gesperrte Website-Daten); dann laeuft die
 *     Buehne eben, und der Knopf wirkt fuer diese Seite. Kein Fehler erreicht
 *     das Formular.
 *
 *  3. DER KNOPF STEHT MIT `hidden` IM MARKUP. Ohne dieses Skript tut er
 *     nichts - also wird er erst hier sichtbar gemacht. Er steht nur in der
 *     breiten Fassung; am Telefon bewegt sich nichts.
 *
 * Extern statt inline - dieselbe Disziplin wie die Portal-CSP.
 * Das Portal traegt denselben Schalter in frontend/portal/src/components/
 * AuthScreen.tsx unter demselben Schluessel.
 */
(function () {
  'use strict';

  var KEY = 'vp.login.bewegung';
  var STILL = 'vpl-still';
  var root = document.documentElement;

  function gemerktAus() {
    try {
      return window.localStorage.getItem(KEY) === 'aus';
    } catch (e) {
      return false;
    }
  }

  function merke(aus) {
    try {
      if (aus) window.localStorage.setItem(KEY, 'aus');
      else window.localStorage.removeItem(KEY);
    } catch (e) {
      /* ohne Speicher gilt die Wahl nur fuer diese Seite */
    }
  }

  if (gemerktAus()) root.classList.add(STILL);

  function beschrifte(buttons) {
    var aus = root.classList.contains(STILL);
    for (var i = 0; i < buttons.length; i++) {
      var label = buttons[i].querySelector('.vpl-motion-label');
      var text = buttons[i].getAttribute(aus ? 'data-vp-play' : 'data-vp-pause');
      if (label && text) label.textContent = text;
    }
  }

  function init() {
    var buttons = document.querySelectorAll('[data-vp-motion]');
    if (!buttons.length) return;
    beschrifte(buttons);
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].hidden = false;
      buttons[i].addEventListener('click', function () {
        var aus = !root.classList.contains(STILL);
        root.classList.toggle(STILL, aus);
        merke(aus);
        beschrifte(buttons);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
