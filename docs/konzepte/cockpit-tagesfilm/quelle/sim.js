/* Beispieldaten: drei erfundene Anlagen, je 96 Viertelstunden. Vergangenheit = "gemessen"
   (mit Wolken-Rauschen), ab Jetzt = "Plan/Prognose" (glatt). Die Energiebilanz geht in jeder
   Viertelstunde auf: Netz = Verbrauch + Speicherladen - PV - Speicherentladen. */
var SIM = (function () {
  'use strict';
  var QH = 96;
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function noise(seed, k) {
    var r = mulberry(seed), raw = [], out = [], i, j, s;
    for (i = 0; i < QH + k; i++) raw.push(r());
    for (i = 0; i < QH; i++) { s = 0; for (j = 0; j < k; j++) s += raw[i + j]; out.push(s / k); }
    return out;
  }
  function bell(h, rise, set, p) {
    if (h <= rise || h >= set) return 0;
    return Math.pow(Math.sin(Math.PI * (h - rise) / (set - rise)), p);
  }
  function inR(h, a, b) { return h >= a && h < b; }
  function hhmm(q) {
    var m = ((q * 15) % 1440 + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  var VARIANTS = {
    privat: {
      key: 'privat', site: 'Sonnenhof', crumb: 'Sonnenhof', art: 'Privathaus', tag: 'Eigenverbrauchs-Fahrplan', ton: 'sparen',
      nowQ: 55, nowTime: '13:52', rise: 7.30, set: 19.13, seed: 11, cloud: 0.55, perf: 0.74,
      pv: [{ id: 'sued', name: 'Dach Süd', kwp: 6.4, shift: 0 }, { id: 'carport', name: 'Carport', kwp: 3.0, shift: 0.9 }],
      batt: { name: 'Batteriespeicher', kwh: 15, maxKw: 3.2, min: 8, start: 18 },
      cons: [
        { id: 'wp', name: 'Wärmepumpe', short: 'Wärme\u00adpumpe', icon: 'heatpump', gruppe: 'Wärme' },
        { id: 'wb', name: 'Wallbox Garage', short: 'Wallbox', icon: 'car', gruppe: 'Laden' },
        { id: 'hs', name: 'Heizstab Warmwasser', short: 'Heizstab', icon: 'thermo', gruppe: 'Wärme' },
        { id: 'wm', name: 'Waschmaschine', short: 'Waschmaschine', icon: 'plug', gruppe: 'Haushalt' },
        { id: 'rest', name: 'übriger Haushalt', short: 'übriger Haushalt', icon: 'house', rest: true, gruppe: 'Haushalt' }
      ],
      cons_fn: function (h, q, pv, n) {
        var wm = inR(h, 9.5, 10.5) ? 0.9 + 0.5 * n[2][q] : (inR(h, 10.5, 11) ? 0.35 : 0);
        var rest = 0.28 + (inR(h, 6.5, 8) ? 0.85 : 0) + (inR(h, 10.5, 11.25) ? 0.9 : 0) + (inR(h, 12, 12.75) ? 1.45 : 0) + (inR(h, 17.5, 22.5) ? 0.75 : 0) + (inR(h, 19, 20) ? 0.4 : 0) + 0.18 * n[0][q];
        var hs = inR(h, 12.75, 13.25) ? 1.2 : 0;
        var wp = 0.04;
        if (inR(h, 6, 7.75)) wp = 1.55 + 0.25 * n[1][q];
        else if (inR(h, 9, 10.5)) wp = 1.45 + 0.15 * n[1][q];
        else if (inR(h, 11.5, 15)) wp = 1.22 + 0.15 * n[1][q];
        else if (inR(h, 17.5, 21.5)) wp = (Math.floor(h * 3) % 3 === 0) ? 1.05 + 0.1 * n[1][q] : 0.04;
        var wb = 0;
        if (inR(h, 11.25, 15.25)) { var sur = pv - rest - wp - hs - wm - 1.9; wb = sur >= 1.4 ? Math.min(3.7, sur) : 0; }
        return [wp, wb, hs, wm, rest];
      },
      strat: 'eigen', devices: 5
    },
    markt: {
      key: 'markt', site: 'Gewerbehof Lindenau', crumb: 'Gewerbehof Lindenau', art: 'Gewerbe', tag: 'Marktoptimierung', ton: 'verdienen',
      nowQ: 55, nowTime: '13:52', rise: 7.30, set: 19.13, seed: 23, cloud: 0.35, perf: 0.80,
      pv: [{ id: 'halle', name: 'Dach Werkhalle', kwp: 92, shift: 0 }, { id: 'carport', name: 'Carport Parkplatz', kwp: 38, shift: -0.6 }],
      batt: { name: 'Batteriespeicher', kwh: 500, maxKw: 250, min: 5, start: 9 },
      cons: [
        { id: 'werk', name: 'Werkstatt', short: 'Werkstatt', icon: 'factory', gruppe: 'Betrieb' },
        { id: 'buero', name: 'Büro', short: 'Büro', icon: 'building', gruppe: 'Gebäude' },
        { id: 'kuehl', name: 'Kühlhaus', short: 'Kühlhaus', icon: 'snow', gruppe: 'Betrieb' },
        { id: 'rest', name: 'übriger Verbrauch', short: 'übriger Verbrauch', icon: 'plug', rest: true, gruppe: 'Sonstiges' }
      ],
      cons_fn: function (h, q, pv, n) {
        var werk = inR(h, 7, 17) ? 19 + 6 * n[0][q] : 1.6;
        var buero = inR(h, 7, 18) ? 6.5 + 2 * n[1][q] : 1.1;
        var kuehl = 7.5 + 3 * n[2][q] + (Math.floor(h * 2) % 2 ? 2.5 : 0);
        var rest = 3.2 + 1.2 * n[3][q];
        return [werk, buero, kuehl, rest];
      },
      price_h: [9.6, 9.1, 8.4, 8.1, 8.3, 9.0, 11.8, 16.4, 18.9, 15.2, 9.4, 4.8, 2.6, 1.4, 1.6, 3.9, 8.8, 14.2, 21.3, 24.6, 22.8, 17.5, 13.9, 11.2],
      windows: [
        { a: 2, b: 5, role: 'guenstig_laden', kw: 125, until: 78 },
        { a: 7, b: 9.25, role: 'verkaufen', kw: 160, until: 10 },
        { a: 11, b: 15.5, role: 'guenstig_laden', kw: 105, until: 96 },
        { a: 18, b: 21.25, role: 'verkaufen', kw: 150, until: 6 }
      ],
      strat: 'markt', devices: 7
    },
    spitze: {
      key: 'spitze', site: 'Halle 1', crumb: 'Werk Ahrenberg › Halle 1', art: 'Werk', tag: 'Lastspitzenkappung', ton: 'verdienen',
      nowQ: 55, nowTime: '13:52', rise: 7.30, set: 19.13, seed: 37, cloud: 0.45, perf: 0.80, overcast: 0.55,
      pv: [{ id: 'h1', name: 'Dach Halle 1', kwp: 110, shift: 0 }, { id: 'h2', name: 'Dach Halle 2', kwp: 60, shift: 0.4 }],
      batt: { name: 'Batteriespeicher', kwh: 400, maxKw: 200, min: 5, start: 74, reserve: 40 },
      ziel: 300,
      cons: [
        { id: 'sg1', name: 'Spritzguss Linie 1', short: 'Spritzguss 1', icon: 'factory', gruppe: 'Maschinen' },
        { id: 'sg2', name: 'Spritzguss Linie 2', short: 'Spritzguss 2', icon: 'factory', gruppe: 'Maschinen' },
        { id: 'luft', name: 'Druckluft', short: 'Druckluft', icon: 'wind', gruppe: 'Maschinen' },
        { id: 'kuehl', name: 'Kühlung', short: 'Kühlung', icon: 'snow', gruppe: 'Gebäude', staleFromQ: 54, staleTime: '13:31' },
        { id: 'lueft', name: 'Hallenlüftung', short: 'Lüftung', icon: 'wind', gruppe: 'Gebäude' },
        { id: 'licht', name: 'Beleuchtung', short: 'Beleuchtung', icon: 'bulb', gruppe: 'Gebäude' },
        { id: 'stapler', name: 'Ladepunkte Stapler', short: 'Stapler laden', icon: 'plug', gruppe: 'Laden' },
        { id: 'buero', name: 'Büro und Kantine', short: 'Büro', icon: 'building', gruppe: 'Gebäude' },
        { id: 'rest', name: 'übriger Verbrauch', short: 'übriger Verbrauch', icon: 'plug', rest: true, gruppe: 'Sonstiges' }
      ],
      cons_fn: function (h, q, pv, n) {
        var sh = inR(h, 6, 22);
        var spritz = sh ? 132 + 22 * n[0][q] + (inR(h, 6, 6.75) ? 64 : 0) + (inR(h, 13.5, 14.5) ? 58 : 0) : 18;
        var luft = sh ? 64 + (Math.floor(h * 3) % 2 ? 24 : 0) + 6 * n[1][q] : 11;
        var kuehl = 38 + 9 * n[2][q];
        var lueft = inR(h, 5.5, 22) ? 11 + 2 * n[3][q] : 4;
        var licht = inR(h, 6, 22) ? (inR(h, 9, 16) ? 6 : 10) : 1.5;
        var stapler = inR(h, 12, 13) ? 9 : (inR(h, 22, 24) || inR(h, 0, 5) ? 12 : 0);
        var buero = inR(h, 7, 17) ? 9 + 2 * n[0][(q + 7) % 96] : 1.8;
        var rest = (inR(h, 6, 18) ? 9 : 4) + 3 * n[3][(q + 11) % 96];
        return [spritz * 0.58, spritz * 0.42, luft, kuehl, lueft, licht, stapler, buero, rest];
      },
      strat: 'spitze', devices: 9
    }
  };

  function strategy(v, q, h, pv, load, soc) {
    var b = v.batt, dt = 0.25;
    var room = Math.max(0, (100 - soc) / 100 * b.kwh / dt);
    var avail = Math.max(0, (soc - b.min) / 100 * b.kwh / dt);
    if (v.strat === 'eigen') {
      var sur = pv - load;
      if (sur > 0.05) { var cap = h < 11 ? 1.6 : b.maxKw; var c = Math.min(sur, cap, room * 0.95); return { bkw: c, role: c > 0.05 ? 'pv_speichern' : 'warten' }; }
      var d = Math.min(-sur, b.maxKw, avail);
      return { bkw: -d, role: d > 0.05 ? 'eigenverbrauch' : 'warten' };
    }
    if (v.strat === 'markt') {
      for (var i = 0; i < v.windows.length; i++) {
        var w = v.windows[i];
        if (h >= w.a && h < w.b) {
          if (w.role === 'guenstig_laden' && soc < w.until) return { bkw: Math.min(w.kw, room), role: w.role };
          if (w.role === 'verkaufen' && soc > w.until) return { bkw: -Math.min(w.kw, avail), role: w.role };
        }
      }
      return { bkw: 0, role: 'warten' };
    }
    // Lastspitzenkappung
    var net = load - pv, Z = v.ziel;
    if (net > Z) { var dd = Math.min(net - Z, b.maxKw, avail); return { bkw: -dd, role: 'spitze_kappen' }; }
    if (soc < 90 && net < Z - 60) {
      var cc = Math.min(60, (Z - 40) - net, room);
      if (cc > 0.5) return { bkw: cc, role: 'reserve_halten' };
    }
    return { bkw: 0, role: 'warten' };
  }

  function simulate(v) {
    var n = [noise(v.seed, 4), noise(v.seed + 1, 4), noise(v.seed + 2, 4), noise(v.seed + 3, 4)];
    var cl = noise(v.seed + 7, 5), cl2 = noise(v.seed + 9, 3);
    var d = { pv: [], pvSrc: [], load: [], cons: [], bkw: [], soc: [], grid: [], price: [], role: [], irr: [], cloudPct: [] };
    var soc = v.batt.start;
    for (var q = 0; q < QH; q++) {
      var h = q / 4 + 0.125, fut = q > v.nowQ;
      var over = v.overcast || 1;
      var dip = Math.max(0, cl[q] - 0.42) * 1.9 + Math.max(0, cl2[q] - 0.6) * 0.8;
      var cf = fut ? over * (1 - v.cloud * 0.22) : over * Math.max(0.25, 1 - v.cloud * dip);
      var irr = 860 * bell(h, v.rise, v.set, 1.35) * cf;
      var pvSrc = v.pv.map(function (s) { return s.kwp * v.perf * bell(h - s.shift * 0.35, v.rise + Math.max(0, s.shift) * 0.2, v.set + Math.min(0, s.shift) * 0.2, 1.3) * cf; });
      var pv = pvSrc.reduce(function (a, b) { return a + b; }, 0);
      var cons = v.cons_fn(h, q, pv, n);
      if (fut) cons = cons.map(function (x) { return x; });
      var load = cons.reduce(function (a, b) { return a + b; }, 0);
      var st = strategy(v, q, h, pv, load, soc);
      var bkw = st.bkw;
      soc = Math.max(0, Math.min(100, soc + (bkw > 0 ? bkw * 0.95 : bkw / 0.95) * 0.25 / v.batt.kwh * 100));
      var grid = load + bkw - pv;
      var price = null;
      if (v.price_h) {
        var hi = Math.floor(h), f = h - hi, a = v.price_h[hi], b2 = v.price_h[(hi + 1) % 24];
        price = a + (b2 - a) * f + (n[2][q] - 0.5) * 0.5;
        price = Math.round(price * 10) / 10;
      }
      d.pv.push(pv); d.pvSrc.push(pvSrc); d.load.push(load); d.cons.push(cons); d.bkw.push(bkw);
      d.soc.push(soc); d.grid.push(grid); d.price.push(price); d.role.push(st.role); d.irr.push(irr);
      d.cloudPct.push(Math.round(Math.min(95, (1 - cf / over) * 120 + (v.overcast ? 55 : 12))));
    }
    return d;
  }

  /* Herkunft bilanziell, mit Vorrang: Sonne zuerst ins Haus, dann in den Speicher, dann ins Netz;
     Speicherentladung zuerst ins Haus; Netzbezug zuerst ins Haus, dann in den Speicher. */
  function attribute(pv, load, bkw, grid) {
    var dis = Math.max(-bkw, 0), chg = Math.max(bkw, 0), imp = Math.max(grid, 0), exp = Math.max(-grid, 0);
    var P = { 'pv>load': 0, 'pv>batt': 0, 'pv>grid': 0, 'batt>load': 0, 'batt>grid': 0, 'grid>load': 0, 'grid>batt': 0 };
    var a = pv, L = load, C = chg, E = exp, D = dis, I = imp, v;
    v = Math.min(a, L); P['pv>load'] = v; a -= v; L -= v;
    v = Math.min(a, C); P['pv>batt'] = v; a -= v; C -= v;
    v = Math.min(a, E); P['pv>grid'] = v; a -= v; E -= v;
    v = Math.min(D, L); P['batt>load'] = v; D -= v; L -= v;
    v = Math.min(D, E); P['batt>grid'] = v; D -= v; E -= v;
    v = Math.min(I, L); P['grid>load'] = v; I -= v; L -= v;
    v = Math.min(I, C); P['grid>batt'] = v; I -= v; C -= v;
    return P;
  }

  function cumulate(v, d) {
    var c = { pv: [], pvSrc: [], load: [], cons: [], pairs: [], chg: [], dis: [], imp: [], exp: [] };
    var pv = 0, load = 0, chg = 0, dis = 0, imp = 0, exp = 0;
    var src = v.pv.map(function () { return 0; }), cons = v.cons.map(function () { return 0; });
    var pairs = { 'pv>load': 0, 'pv>batt': 0, 'pv>grid': 0, 'batt>load': 0, 'batt>grid': 0, 'grid>load': 0, 'grid>batt': 0 };
    for (var q = 0; q < QH; q++) {
      var e = 0.25;
      pv += d.pv[q] * e; load += d.load[q] * e;
      chg += Math.max(d.bkw[q], 0) * e; dis += Math.max(-d.bkw[q], 0) * e;
      imp += Math.max(d.grid[q], 0) * e; exp += Math.max(-d.grid[q], 0) * e;
      d.pvSrc[q].forEach(function (x, i) { src[i] += x * e; });
      d.cons[q].forEach(function (x, j) { cons[j] += x * e; });
      var P = attribute(d.pv[q], d.load[q], d.bkw[q], d.grid[q]);
      Object.keys(P).forEach(function (k) { pairs[k] += P[k] * e; });
      c.pv.push(pv); c.load.push(load); c.chg.push(chg); c.dis.push(dis); c.imp.push(imp); c.exp.push(exp);
      c.pvSrc.push(src.slice()); c.cons.push(cons.slice()); c.pairs.push(Object.assign({}, pairs));
    }
    return c;
  }

  function build() {
    Object.keys(VARIANTS).forEach(function (k) {
      var v = VARIANTS[k];
      v.day = simulate(v);
      v.cum = cumulate(v, v.day);
      var d = v.day, f = 0;
      for (var q = 0; q < QH; q++) {
        f = Math.max(f, d.pv[q], d.load[q], Math.abs(d.bkw[q]), Math.abs(d.grid[q]));
      }
      v.fMax = f;
      var c = v.cum, last = QH - 1;
      v.kMax = Math.max(c.pv[last], c.load[last], c.chg[last] + c.dis[last], c.imp[last] + c.exp[last]);
    });
    return VARIANTS;
  }

  return { QH: QH, VARIANTS: VARIANTS, build: build, attribute: attribute, hhmm: hhmm };
})();
if (typeof module !== 'undefined') module.exports = SIM;
