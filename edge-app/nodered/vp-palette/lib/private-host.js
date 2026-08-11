/**
 * LAN-only: darf dieser Host-String überhaupt angesprochen werden?
 * (Einheitsmodell Stufe 3, Konzept `vp-modbus-baukasten-k6` §2.6.)
 *
 * ⚠ **Die Box glaubt der Cloud nichts.** Das Portal und die api prüfen dieselbe
 * Regel schon, BEVOR ein Gerät gespeichert wird - aber ein ausgerollter Flow
 * ist eine Anweisung von aussen, und die OTA-Sidecar-Disziplin gilt hier
 * genauso: wer eine Verbindung öffnet, prüft ihr Ziel selbst. Ohne diese
 * Prüfung wäre ein fehlerhaft erzeugter Flow ein Portscanner, den die Box
 * gehorsam aufs offene Internet richtet.
 *
 * Es ist eine WHITELIST der Formen, die sich aus der Zeichenkette BELEGEN
 * lassen - ein NACKTER Hostname ist deshalb abgelehnt: er wird über die
 * Suchdomänen der Box aufgelöst, ist also nicht nachweisbar privat, und eine
 * Regel, die ihr eigenes Versprechen nicht prüfen kann, ist keine. Eine
 * Blacklist wäre eine Adressklasse davon entfernt, falsch zu sein.
 *
 * ⚠ ZWILLING von `edge-app/core/internal/probe.IsPrivateHost` (Go, kanonisch),
 * `services/api .../components/SelfBuildDefinition.isPrivateHost` (Java) und
 * `frontend/portal/src/selbstbau.ts isPrivateHost` (TS). Alle vier lesen
 * dieselben Vektoren: `docs/contracts/lan-host-vectors.json`. Wer die Regel
 * ändert, ändert alle vier Seiten UND die Vektoren zusammen.
 */

'use strict';

var LAN_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.intern'];

function parseIpv4(h) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return null;
  var parts = h.split('.').map(Number);
  for (var i = 0; i < 4; i++) {
    if (!(parts[i] >= 0 && parts[i] <= 255)) return null;
  }
  return parts;
}

function isPrivateV4(p) {
  var a = p[0];
  var b = p[1];
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  // CGNAT 100.64.0.0/10 - nicht öffentlich routbar, und echte Kunden-Router
  // vergeben sie.
  return a === 100 && b >= 64 && b <= 127;
}

function isPrivateV6(raw) {
  var h = raw.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(h)) return false;
  var mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped) {
    var v4 = parseIpv4(mapped[1]);
    return v4 ? isPrivateV4(v4) : false;
  }
  if (h === '::1') return true;
  var head = h.split(':')[0];
  if (head === '') return false;
  var padded = ('0000' + head).slice(-4);
  var first = parseInt(padded.slice(0, 2), 16);
  var second = parseInt(padded.slice(2, 4), 16);
  if (isNaN(first) || isNaN(second)) return false;
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  return first === 0xfe && (second & 0xc0) === 0x80; // fe80::/10 link local
}

/** @param {string} host @returns {boolean} */
function isPrivateHost(host) {
  var h = String(host == null ? '' : host).trim();
  if (h === '') return false;
  if (h.charAt(0) === '[') h = h.slice(1);
  if (h.charAt(h.length - 1) === ']') h = h.slice(0, -1);
  if (h.charAt(h.length - 1) === '.') h = h.slice(0, -1);
  if (h === '') return false;

  var v4 = parseIpv4(h);
  if (v4) return isPrivateV4(v4);
  if (h.indexOf(':') >= 0) return isPrivateV6(h);

  var lower = h.toLowerCase();
  if (/[ /\\@:]/.test(lower)) return false;
  for (var i = 0; i < LAN_SUFFIXES.length; i++) {
    if (lower.length >= LAN_SUFFIXES[i].length
        && lower.slice(-LAN_SUFFIXES[i].length) === LAN_SUFFIXES[i]) {
      return true;
    }
  }
  return false;
}

/** Der deutsche Grund, den ein abgelehnter Knoten anzeigt. */
var REFUSAL = 'Ziel liegt nicht im Heimnetz - wird nicht gelesen';

module.exports = { isPrivateHost: isPrivateHost, REFUSAL: REFUSAL };
