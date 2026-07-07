/*
 * "Konto erstellen"-Link auf der Keycloak-Anmeldeseite.
 *
 * Die Selbstregistrierung ist ein PORTAL-Formular (eigene Route "#register",
 * mit nahtloser Auto-Anmeldung danach) - nicht die Keycloak-Registrierung.
 * Seit das Portal unangemeldete Besucher DIREKT zur Keycloak-Anmeldung
 * weiterleitet, ist diese Seite der erste Kontaktpunkt; ohne den Link waere
 * die Registrierung nicht mehr auffindbar.
 *
 * Die Portal-URL wird aus dem redirect_uri-Query-Parameter der Auth-Anfrage
 * abgeleitet (der von Keycloak gegen die Client-Konfiguration validiert wird),
 * damit das Theme ohne Umgebungs-Konfiguration in Dev UND Prod stimmt. Nach
 * einem fehlgeschlagenen Login-Versuch fehlt der Parameter in der Formular-URL,
 * deshalb wird der zuletzt gesehene Origin in sessionStorage aufgehoben.
 */
(function () {
  'use strict';

  var STORE_KEY = 'vp.portal.origin';

  function portalOrigin() {
    try {
      var redirect = new URLSearchParams(window.location.search).get('redirect_uri');
      if (redirect) {
        var u = new URL(redirect);
        if (u.protocol === 'https:' || u.protocol === 'http:') {
          sessionStorage.setItem(STORE_KEY, u.origin);
          return u.origin;
        }
      }
      return sessionStorage.getItem(STORE_KEY);
    } catch (e) {
      return null;
    }
  }

  function init() {
    // Nur auf der eigentlichen Login-Seite (Benutzername/Passwort-Formular),
    // nicht auf Fehler-/Info-/Passwort-Seiten.
    var form = document.getElementById('kc-form-login');
    if (!form || document.getElementById('vp-register-link')) return;
    var origin = portalOrigin();
    if (!origin) return;

    var lang = (document.documentElement.getAttribute('lang') || 'de').slice(0, 2);
    var texts =
      lang === 'en'
        ? { lead: 'New to VoltPilot? ', link: 'Create account' }
        : { lead: 'Neu bei VoltPilot? ', link: 'Konto erstellen' };

    var p = document.createElement('p');
    p.id = 'vp-register-link';
    p.appendChild(document.createTextNode(texts.lead));
    var a = document.createElement('a');
    a.href = origin + '/#register';
    a.textContent = texts.link;
    p.appendChild(a);
    form.insertAdjacentElement('afterend', p);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
