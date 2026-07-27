// VoltPilot Edge - Technikmodus.
//
// ONE global switch, same position in the header of EVERY page. It REVEALS,
// it does not AUTHORIZE: no gate, no permission and no capability anywhere in
// this app depends on it. The calibration mutations stay protected by their own
// admin token (server-side calGuard in web.go) and destructive actions stay
// red-bordered + confirmation-gated in BOTH modes. This file therefore talks to
// no endpoint at all - it only flips a class and remembers the choice.
//
// THE RULE THIS ENCODES: hidden content must never hide a CAUSE. Everything
// behind the switch is DETAIL on top of a plain-German statement that is
// already visible with the switch off - see VPStatus.derive (status.js) and
// VPControl.derive (control.js), which both put the reason in the normal-mode
// text and only the register/frame detail behind `.tech-only`.
//
// Persisted per browser in localStorage, so the installer flips it once and it
// survives a reload and a page change. Default OFF on a fresh browser.
(function (global) {
  "use strict";

  var KEY = "vp.edge.technik";

  // read/write take the store explicitly so they are pure enough to test
  // without a browser. A blocked/absent localStorage (private mode, file://)
  // degrades to "off", never to a thrown error.
  function read(store) {
    try {
      return !!store && store.getItem(KEY) === "1";
    } catch (e) {
      return false;
    }
  }
  function write(store, on) {
    try {
      if (store) store.setItem(KEY, on ? "1" : "0");
    } catch (e) { /* storage unavailable - the mode simply does not persist */ }
    return !!on;
  }

  var listeners = [];
  var state = false;

  function store() {
    try { return global.localStorage; } catch (e) { return null; }
  }

  function apply(on) {
    state = !!on;
    var root = global.document && global.document.documentElement;
    if (root) root.classList.toggle("tech-on", state);

    var btn = global.document && global.document.getElementById("techToggle");
    if (btn) {
      btn.setAttribute("aria-pressed", state ? "true" : "false");
      var lbl = btn.querySelector(".tech-toggle-state");
      if (lbl) lbl.textContent = state ? "an" : "aus";
    }
    var bar = global.document && global.document.getElementById("techBar");
    if (bar) bar.hidden = !state;

    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch (e) { /* one bad listener must not break the switch */ }
    }
  }

  function set(on) {
    write(store(), on);
    apply(on);
  }

  function init() {
    apply(read(store()));
    var btn = global.document && global.document.getElementById("techToggle");
    if (btn) btn.addEventListener("click", function () { set(!state); });
    var off = global.document && global.document.getElementById("techBarOff");
    if (off) off.addEventListener("click", function () { set(false); });
  }

  global.VPTechnik = {
    KEY: KEY,
    read: read,
    write: write,
    enabled: function () { return state; },
    set: set,
    init: init,
    onChange: function (fn) { if (typeof fn === "function") listeners.push(fn); }
  };

  if (global.document) {
    if (global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
})(window);
