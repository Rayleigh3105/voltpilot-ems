// mirror.js - the "Datenfreigabe im Hausnetz" card on the Meine-Anlage page:
// enable/disable the read-only Modbus-TCP mirror (Modbus-Datenspiegel) and
// show the endpoint the building automation (z. B. Loxone) connects to.
//
// DELIBERATELY SELF-CONTAINED (own file, own #mirrorCard hooks, no coupling
// to inverter.js/sources.js state) so PR #257's page rewrite can move the
// whole card as one unit. Server surface: GET/POST /api/mirror.
//
// THIS FILE IS THE ONE SOURCE of the mirror state on the page: it polls
// /api/mirror, keeps the last answer in `last` and publishes it BOTH as
// `window.VPMirror.state()` and as the `vp:mirror-state` event. The
// Datenfreigabe accordion head (einrichten.js) reads exactly that - so head
// and card can never disagree, and a head that has not seen a state yet says
// so instead of claiming "Aus".
(function (global) {
  'use strict';

  // --- the pure part (testable without a DOM) --------------------------------

  function age(seconds, unknown) {
    return typeof seconds === 'number' ? 'vor ' + seconds + ' s' : unknown;
  }

  // detailLine composes the Technik line of the card.
  //
  // HONESTY RULE (Backlog vp-mirror-blocks-anzeige, Befund 1): the learned
  // register blocks are the EXTRA blocks the mirror had to add to the poll
  // because the primary poll does not cover them - on a healthy plant they
  // are 0 while the mirror delivers, so a permanent "0 gelernte
  // Registerbereiche" reads as "nothing is being served" and is the wrong
  // headline. The belastbare "is it delivering?" facts are the two ages, so
  // those are always named (incl. their honest "noch keine Daten"), and the
  // learned blocks appear ONLY when there really are some.
  function detailLine(m) {
    m = m || {};
    const parts = [
      'Gerät ' + (m.native_unit || 1) + ' = Original-Register des Wechselrichters · ' +
        age(m.raw_age_s, 'noch keine Daten'),
      'Gerät ' + (m.vp_unit || 100) + ' = VoltPilot-Standardwerte · ' +
        age(m.telemetry_age_s, 'noch keine Daten'),
      'Frische-Schwelle ' + (m.stale_after_s || 90) + ' s',
    ];
    const learned = (m.learned_blocks || []).length;
    if (learned > 0) {
      parts.push(learned + ' zusätzlich gelernte Registerbereiche');
    }
    return parts.join(' · ');
  }

  // last holds the newest /api/mirror answer (null until the first one
  // arrives) - the single source the accordion head reads on boot.
  let last = null;

  global.VPMirror = {
    detailLine: detailLine,
    state: function () { return last; }
  };

  // --- the surface -----------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const card = $('mirrorCard');
  if (!card) return;

  const toggle = $('mirrorToggle');
  const pill = $('mirrorPill');
  const detail = $('mirrorDetail');
  const endpointRow = $('mirrorEndpointRow');
  const endpoint = $('mirrorEndpoint');
  const copyBtn = $('mirrorCopy');
  const errBox = $('mirrorError');

  let busy = false;

  function renderPill(m) {
    pill.hidden = false;
    if (!m.enabled) {
      pill.className = 'pill off';
      pill.innerHTML = '<span class="dot"></span>Aus';
    } else if (m.error) {
      pill.className = 'pill warn';
      pill.innerHTML = '<span class="dot"></span>Fehler';
    } else if (m.running) {
      pill.className = 'pill ok';
      pill.innerHTML = '<span class="dot live"></span>Bereit';
    } else {
      pill.className = 'pill warn';
      pill.innerHTML = '<span class="dot"></span>Startet …';
    }
  }

  function render(m) {
    toggle.checked = !!m.enabled;
    toggle.disabled = false;
    renderPill(m);
    endpointRow.hidden = !m.enabled;
    if (m.enabled) {
      endpoint.textContent = location.hostname + ':' + (m.advertise_port || 502);
    }
    // Technik-only detail (the customer view stays at toggle + address).
    detail.textContent = detailLine(m);
    if (m.error) {
      errBox.hidden = false;
      errBox.textContent = 'Der Modbus-Dienst konnte nicht gestartet werden (' + m.error + ').';
    } else {
      errBox.hidden = true;
    }
    // The Datenfreigabe accordion row (einrichten.js) derives its summary
    // ("Aus" / "An · ip:port · nur Lesen") from the same object. `last` is set
    // FIRST so a listener that registers late (or a render whose dispatch is
    // swallowed) can still read the current state instead of falling back to a
    // claimed "Aus".
    last = m;
    try {
      window.dispatchEvent(new CustomEvent('vp:mirror-state', { detail: m }));
    } catch (e) { /* older browsers: the row keeps its last summary */ }
  }

  async function load() {
    try {
      const res = await fetch('/api/mirror', { cache: 'no-store' });
      const body = await res.json();
      if (body && body.mirror) render(body.mirror);
    } catch (e) {
      /* transient - the next poll retries */
    }
  }

  async function apply(enabled) {
    if (busy) return;
    busy = true;
    toggle.disabled = true;
    try {
      const res = await fetch('/api/mirror', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabled }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        errBox.hidden = false;
        errBox.textContent = (body && body.error) || 'Einstellung konnte nicht gespeichert werden.';
        toggle.checked = !enabled; // revert the visual state
        toggle.disabled = false;
        return;
      }
      if (body && body.mirror) render(body.mirror);
    } catch (e) {
      errBox.hidden = false;
      errBox.textContent = 'Einstellung konnte nicht gespeichert werden. Bitte erneut versuchen.';
      toggle.checked = !enabled;
      toggle.disabled = false;
    } finally {
      busy = false;
    }
  }

  toggle.addEventListener('change', () => apply(toggle.checked));

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(endpoint.textContent);
        copyBtn.textContent = 'Kopiert ✓';
      } catch (e) {
        copyBtn.textContent = 'Kopieren fehlgeschlagen';
      }
      setTimeout(() => { copyBtn.textContent = 'Kopieren'; }, 1800);
    });
  }

  load();
  setInterval(load, 15000); // keep the status pill honest (listener state)
})(window);
