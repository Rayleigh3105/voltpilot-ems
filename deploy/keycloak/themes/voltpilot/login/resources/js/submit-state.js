/*
 * Lade-Zustand + Passwort-Umschalter des VoltPilot-Login-Themes.
 *
 * Externe Datei, kein Inline-Skript: dieselbe Disziplin wie die Portal-CSP
 * (`script-src 'self'` OHNE 'unsafe-inline' - ein Inline-Skript wird dort
 * STILL blockiert, das war der Login-Ausfall vom 17.07.2026).
 *
 * Zwei Aufgaben, beide rein visuell - ohne dieses Skript funktioniert jedes
 * Formular unveraendert:
 *
 *  1. Absenden: Knopf sperren, Spinner zeigen, Beschriftung auf den
 *     Lade-Text wechseln. Das ist zugleich der Doppelsubmit-Schutz.
 *     ⚠ Der Knopf wird NICHT `disabled` gesetzt, solange er `name`/`value`
 *     traegt - ein deaktivierter Knopf wird nicht mitgeschickt, und Keycloak
 *     liest `name="login"`. Gesperrt wird ueber ein eigenes Flag.
 *
 *  2. Passwort anzeigen/verbergen als WORT (nicht als Auge-Icon): derselbe
 *     Umschalter wie im Portal-Registrierungsformular.
 */
(function () {
  'use strict';

  function wireToggles() {
    var toggles = document.querySelectorAll('[data-vp-toggle]');
    for (var i = 0; i < toggles.length; i++) {
      (function (btn) {
        var input = document.getElementById(btn.getAttribute('data-vp-toggle'));
        if (!input) return;
        btn.addEventListener('click', function () {
          var show = input.type === 'password';
          input.type = show ? 'text' : 'password';
          btn.textContent = show
            ? btn.getAttribute('data-vp-hide')
            : btn.getAttribute('data-vp-show');
          btn.setAttribute('aria-pressed', show ? 'true' : 'false');
          // Der Fokus bleibt beim Feld, sonst verliert der Kunde die
          // Schreibmarke mitten in der Eingabe.
          try {
            var at = input.value.length;
            input.focus();
            input.setSelectionRange(at, at);
          } catch (e) {
            /* setSelectionRange gibt es nicht auf jedem Feldtyp */
          }
        });
      })(toggles[i]);
    }
  }

  function wireSubmit() {
    var forms = document.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) {
      (function (form) {
        var busy = false;
        form.addEventListener('submit', function (event) {
          if (busy) {
            event.preventDefault();
            return;
          }
          busy = true;
          var btn = form.querySelector('.vpl-submit');
          if (!btn) return;
          btn.classList.add('is-busy');
          btn.setAttribute('aria-busy', 'true');
          var spin = btn.querySelector('.vpl-spin');
          if (spin) spin.hidden = false;
          var label = btn.querySelector('.vpl-submit-label');
          var text = btn.getAttribute('data-vp-busy');
          if (label && text) label.textContent = text;
        });
      })(forms[i]);
    }
  }

  function init() {
    wireToggles();
    wireSubmit();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
