(function () {
  'use strict';
  var S = SIM, V = S.build(), QH = S.QH;
  var RM = window.matchMedia('(prefers-reduced-motion: reduce)');
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };
  var DB = 0.05; // Totband in kW wie im Portal

  /* ---------- Formatierung (de-DE, Richtung als Wort, nie als Minus) ---------- */
  var NF0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
  var NF1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var NF2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var NB = ' ';
  function n1(x) { x = Math.abs(x); return x >= 100 ? NF0.format(x) : NF1.format(x); }
  function kw(x) { return x == null ? '—' : n1(x) + NB + 'kW'; }
  function kwh(x) { return x == null ? '—' : n1(x) + NB + 'kWh'; }
  function pct(x) { return x == null ? '—' : NF0.format(x) + NB + '%'; }
  function ct(x) { return NF1.format(x) + NB + 'ct/kWh'; }
  function eur(x) { var a = Math.abs(x); return (x < 0 ? '−' : '+') + NB + (a >= 1000 ? NF0.format(a) : NF2.format(a)) + NB + '€'; }
  var hhmm = S.hhmm;

  /* ---------- Farben aus den Tokens ---------- */
  var CS = getComputedStyle(document.documentElement);
  function tok(n) { return CS.getPropertyValue(n).trim(); }
  var C = {
    pv: tok('--pv'), pvFill: tok('--pv-fill'), batt: tok('--batt'), battFill: tok('--batt-fill'), battLite: tok('--batt-lite'),
    grid: tok('--grid'), gridLine: tok('--grid-line'), load: tok('--load'), base: tok('--flow-base'), ink: tok('--flow-ink'),
    fg: tok('--c-fg'), muted: tok('--c-muted-fg'), plan: tok('--plan'), cheap: tok('--cheap'), dear: tok('--dear'),
    price: tok('--price'), battdis: tok('--battdis'), idle: tok('--idle'), card: tok('--c-card'), border: tok('--c-border'),
    sky: tok('--primary-light'), navy: tok('--navy'), cMuted: tok('--c-muted'), gray: tok('--text-gray')
  };
  function rgb(h) { h = h.replace('#', ''); var n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mix(parts) {
    var t = 0, r = 0, g = 0, b = 0;
    parts.forEach(function (p) { if (p[1] > 1e-6) { var x = rgb(p[0]); r += x[0] * p[1]; g += x[1] * p[1]; b += x[2] * p[1]; t += p[1]; } });
    if (!t) return C.base;
    return 'rgb(' + Math.round(r / t) + ',' + Math.round(g / t) + ',' + Math.round(b / t) + ')';
  }
  var SRC_COL = { pv: C.pv, batt: C.batt, grid: C.grid };

  /* ---------- Symbole (Stil des vorhandenen Satzes: 24er Raster, Strich 2) ---------- */
  var I = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    panel: '<path d="M4 4h16l-2 11H6z"/><path d="M5 9.5h14M9.5 4l-1 11M14.5 4l1 11M12 15v5M8 20h8"/>',
    battery: '<rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2"/>',
    pole: '<path d="M12 2v20M2 5h20M3 3v2M7 3v2M17 3v2M21 3v2M19 5l-7 7-7-7"/>',
    house: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
    heatpump: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><circle cx="10" cy="12" r="4"/><path d="M10 8v8M6 12h8M17 9h2M17 12h2M17 15h2"/>',
    plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
    factory: '<path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M17 18h1M12 18h1M7 18h1"/>',
    wind: '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>',
    snow: '<path d="M12 2v20M3.5 7l17 10M3.5 17l17-10"/><path d="M9 3.5 12 6l3-2.5M9 20.5 12 18l3 2.5"/>',
    building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
    euro: '<path d="M4 10h12M4 14h9M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2"/>',
    sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>', chevD: '<path d="m6 9 6 6 6-6"/>', chevU: '<path d="m18 15-6-6-6 6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>', pause: '<path d="M8 5v14M16 5v14"/>',
    eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20M14.12 14.12a3 3 0 1 1-4.24-4.24"/>',
    star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
    plus: '<path d="M5 12h14M12 5v14"/>', check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    trend: '<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>', down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    thermo: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
    bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6M10 22h4"/>'
  };
  function ic(n, s, cls) {
    s = s || 20;
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + I[n] + '</svg>';
  }
  function icStar(s, on) { return '<svg class="ic" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="' + (on ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">' + I.star + '</svg>'; }

  var TAET = { warten: 'Warten', pv_speichern: 'Sonne speichern', guenstig_laden: 'Günstig aus dem Netz laden', eigenverbrauch: 'Verbrauch decken', verkaufen: 'Verkaufen', spitze_kappen: 'Lastspitze kappen', reserve_halten: 'Reserve halten' };
  var TAET_COL = { warten: C.idle, pv_speichern: C.pvFill, guenstig_laden: C.grid, eigenverbrauch: C.battFill, verkaufen: C.battdis, spitze_kappen: C.load, reserve_halten: C.battLite };

  /* ---------- Zusatzangaben je Beispielanlage (erfunden) ---------- */
  V.privat.money = { heute: { eur: 3.54, label: 'Heute, Zwischenstand 13:52' }, monat: { eur: 71.2, label: 'September' }, jahr: { eur: 812.4, label: '2026' }, hinweis: 'Wert des Eigenverbrauchs und Einspeise-Erlös, abzüglich Stromkosten.' };
  V.markt.money = { heute: { eur: 38.2, label: 'Heute, Zwischenstand 13:52' }, monat: { eur: 1184, label: 'September' }, jahr: { eur: 9870, label: '2026' }, hinweis: 'Einspeise-Erlös und Wert des Eigenverbrauchs, abzüglich Stromkosten.' };
  V.spitze.money = { heute: { eur: 64.1, label: 'Heute, Zwischenstand 13:52' }, monat: { eur: 2140, label: 'Abrechnungsmonat September' }, jahr: { eur: 21300, label: '2026' }, hinweis: 'Enthält die vermiedenen Leistungskosten der laufenden Abrechnungsperiode.' };
  V.privat.morgen = 36.4; V.markt.morgen = 590; V.spitze.morgen = 520;
  V.markt.morgenPreis = 'Morgen: Ø 10,4 ct/kWh, Tageshoch 23,1 ct/kWh um 19 Uhr.';
  V.spitze.monat = { spitze: 304, am: '17.09., 06:15', ohne: 431 };
  V.privat.temp = 17; V.markt.temp = 18; V.spitze.temp = 14;
  V.privat.steuer = { auftrag: 'Speicher laden', antwort: 'bestätigt 13:52' };
  V.markt.steuer = { auftrag: 'Laden', antwort: 'bestätigt 13:52', wirkungDelta: -1.2 };
  V.spitze.steuer = { auftrag: 'Entladen bis Ziel 300 kW', antwort: 'bestätigt 13:52' };

  /* ---------- Moment: eine Viertelstunde (Leistung) oder der Tag bis dahin (Energie) ---------- */
  function momentAt(v, q, mode) {
    var d = v.day, heute = mode === 'heute';
    var m = { v: v, q: q, heute: heute, fut: !heute && q > v.nowQ, live: q === v.nowQ };
    if (heute) {
      var c = v.cum;
      m.pv = c.pv[q]; m.pvSrc = c.pvSrc[q]; m.load = c.load[q]; m.cons = c.cons[q]; m.pairs = c.pairs[q];
      m.chg = c.chg[q]; m.dis = c.dis[q]; m.imp = c.imp[q]; m.exp = c.exp[q];
      m.time = 'bis ' + (q === v.nowQ ? v.nowTime : hhmm(q + 1));
    } else {
      m.pv = d.pv[q]; m.pvSrc = d.pvSrc[q]; m.load = d.load[q]; m.cons = d.cons[q];
      m.bkw = d.bkw[q]; m.grid = d.grid[q];
      m.pairs = S.attribute(m.pv, m.load, m.bkw, m.grid);
      m.chg = Math.max(m.bkw, 0); m.dis = Math.max(-m.bkw, 0); m.imp = Math.max(m.grid, 0); m.exp = Math.max(-m.grid, 0);
      m.time = m.live ? v.nowTime : hhmm(q);
    }
    m.soc = d.soc[q]; m.role = d.role[q]; m.price = d.price[q]; m.irr = d.irr[q]; m.cloud = d.cloudPct[q];
    m.hour = m.live ? 13 + 52 / 60 : q / 4 + 0.125;
    m.src = srcView(v, m); m.con = conView(v, m);
    return m;
  }
  function srcView(v, m) {
    if (m.fut) return [{ id: 'prog', name: 'PV-Prognose', kw: m.pv, icon: 'panel', ghost: true }];
    var producing = m.pvSrc.some(function (x) { return x > DB; });
    return v.pv.map(function (s, i) {
      return { id: s.id, name: s.name, kw: m.pvSrc[i], icon: 'panel', zero: producing && m.pvSrc[i] <= DB && !m.heute };
    });
  }
  function conView(v, m) {
    if (m.fut) return [{ id: 'prog', name: 'Verbrauch', full: 'Verbrauchsprognose', kw: m.load, icon: 'house', ghost: true }];
    var stale = null;
    v.cons.forEach(function (c) { if (c.staleFromQ != null && m.q >= c.staleFromQ) stale = c; });
    if (!stale) return v.cons.map(function (c, j) { return { id: c.id, name: c.short, full: c.name, kw: m.cons[j], icon: c.icon, rest: !!c.rest, gruppe: c.gruppe }; });
    var out = [], known = 0;
    v.cons.forEach(function (c, j) {
      if (c !== stale && !c.rest) { out.push({ id: c.id, name: c.short, full: c.name, kw: m.cons[j], icon: c.icon, gruppe: c.gruppe }); known += m.cons[j]; }
    });
    var sj = v.cons.indexOf(stale);
    out.push({ id: 'merged', name: stale.short + ' + übriger', full: stale.name + ' und übriger Verbrauch', kw: Math.max(0, m.load - known), icon: 'plug', merged: true, stale: stale, lastKw: v.day.cons[stale.staleFromQ - 1][sj] });
    return out;
  }
  function loadMix(P) { return [['pv', P['pv>load']], ['batt', P['batt>load']], ['grid', P['grid>load']]]; }
  function mixCol(list) { return mix(list.map(function (x) { return [SRC_COL[x[0]], x[1]]; })); }

  function satzOf(v, m) {
    var P = m.pairs, pre = m.fut ? 'Plan: ' : '';
    if (m.heute) {
      if (v.key === 'markt') return 'Bis ' + m.time.slice(4) + ' in den Speicher geladen: ' + kwh(m.chg) + ', abgegeben: ' + kwh(m.dis) + '. Erzeugt: ' + kwh(m.pv) + '.';
      if (v.key === 'spitze') {
        var mx = 0; for (var q = 0; q <= m.q; q++) mx = Math.max(mx, v.day.grid[q]);
        return 'Bis ' + m.time.slice(4) + ' aus dem Netz: ' + kwh(m.imp) + '. Höchste Viertelstunde: ' + kw(mx) + ', Ziel ' + kw(v.ziel) + '.';
      }
      return 'Bis ' + m.time.slice(4) + ' erzeugt: ' + kwh(m.pv) + ', verbraucht: ' + kwh(m.load) + ', davon aus dem Netz: ' + kwh(m.imp) + '.';
    }
    if (v.key === 'spitze') {
      var s = pre + 'Netzbezug ' + kw(m.imp) + ', Ziel ' + kw(v.ziel) + '.';
      if (m.dis > DB) return s + ' Der Speicher gibt ' + kw(m.dis) + ' ab.';
      if (m.chg > DB) return s + ' Der Speicher lädt mit ' + kw(m.chg) + ' nach.';
      return s + ' Der Speicher wartet.';
    }
    if (v.key === 'markt') {
      var pr = ' Börsenpreis ' + ct(m.price) + '.';
      if (m.chg > DB) return pre + 'Der Speicher lädt mit ' + kw(m.chg) + (P['grid>batt'] > DB ? (P['pv>batt'] > DB ? ' aus Netz und Sonne' : ' aus dem Netz') : ' mit Sonnenstrom') + '.' + pr;
      if (m.dis > DB) return pre + 'Der Speicher gibt ' + kw(m.dis) + ' ab, ' + kw(P['batt>grid']) + ' davon gehen ins Netz.' + pr;
      return pre + 'Der Speicher wartet.' + (m.exp > DB ? ' Sonnenstrom geht ins Netz.' : '') + pr;
    }
    var p2 = m.fut ? (m.chg > DB || m.dis > DB ? 'Plan: ' : 'Erwartet: ') : '';
    if (m.pv > DB && P['pv>load'] >= m.load - DB) {
      var dest = [];
      if (m.chg > DB) dest.push('in den Speicher');
      if (m.exp > DB) dest.push('ins Netz');
      return p2 + 'Die Sonne deckt den ganzen Verbrauch.' + (dest.length ? ' Der Überschuss geht ' + dest.join(' und ') + '.' : '');
    }
    if (m.pv > DB) {
      var own = m.load > 0 ? 100 * (P['pv>load'] + P['batt>load']) / m.load : 0;
      return p2 + 'Sonne' + (m.dis > DB ? ' und Speicher decken ' : ' deckt ') + pct(own) + ' des Verbrauchs' + (m.imp > DB ? ', der Rest kommt aus dem Netz.' : '.');
    }
    if (m.dis > DB) return p2 + 'Der Speicher deckt ' + (m.imp > DB ? 'einen Teil des Verbrauchs, der Rest kommt aus dem Netz.' : 'den Verbrauch.');
    return p2 + 'Das Netz deckt den Verbrauch.';
  }

  /* ---------- SVG-Helfer ---------- */
  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, parent) { var e = document.createElementNS(SVGNS, tag); for (var a in attrs) e.setAttribute(a, attrs[a]); if (parent) parent.appendChild(e); return e; }

  /* ================= Die Bühne: Energiebilanz + Tagesleiste =================
     Oben „Woher kommt der Strom?“, unten „Wohin fließt er?“, dazwischen ruhige Bänder
     in der Farbe der Herkunft. Beide Balken sind gleich lang: Was ankommt, fließt ab.
     Die Geräte stehen darunter als sortierte Liste, damit beliebig viele Platz haben. */
  var ROLES = {
    pv: { name: 'Sonne', icon: 'sun', col: 'var(--pv)', soft: 'var(--pv-soft)' },
    batt: { name: 'Speicher', icon: 'battery', col: 'var(--batt)', soft: 'var(--batt-soft)' },
    grid: { name: 'Netz', icon: 'pole', col: 'var(--grid)', soft: 'var(--grid-soft)' },
    load: { name: 'Verbrauch', icon: 'house', col: 'var(--load)', soft: 'var(--load-soft)' }
  };
  var SRC_ORDER = ['pv', 'batt', 'grid'], DST_ORDER = ['load', 'batt', 'grid'];
  var PAIRS = ['pv>load', 'pv>batt', 'pv>grid', 'batt>load', 'batt>grid', 'grid>load', 'grid>batt'];

  function Flow(root, v, opts) {
    this.root = root; this.v = v; this.opts = opts || {};
    this.el = $('.flow', root); this.det = $('.det', root); this.strip = $('.strip', root);
    this.mode = 'jetzt'; this.q = v.nowQ; this.playing = false; this.alive = true;
    this.cur = null; this.tgt = null;
    this.build();
    this.bind();
    this.buildStrip();
    this.setQ(v.nowQ);
    var self = this;
    this.ro = new ResizeObserver(function () { self.buildStrip(); self.updateStrip(); self.labels(); });
    this.ro.observe(this.el);
  }
  Flow.prototype.destroy = function () {
    this.alive = false; cancelAnimationFrame(this.raf); clearInterval(this.playT);
    if (this.ro) this.ro.disconnect();
  };
  Flow.prototype.build = function () {
    var self = this;
    var seg = function (side, r) {
      return '<button type="button" class="seg-b ' + side + '" data-role="' + r + '" style="--hue:' + ROLES[r].col + ';--soft:' + ROLES[r].soft + '"><span class="seg-in">' + ic(ROLES[r].icon, 16) + '<span class="seg-t"></span></span></button>';
    };
    this.el.innerHTML =
      '<div class="bal-h"><span>Woher kommt der Strom?</span><b data-tot="src"></b></div>' +
      '<p class="bal-more" data-more="src" hidden></p>' +
      '<div class="bal-bar src">' + SRC_ORDER.map(function (r) { return seg('src', r); }).join('') + '</div>' +
      '<svg class="bal-links" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><defs>' +
      SRC_ORDER.map(function (r) { return '<linearGradient id="lg-' + r + '-' + self.v.key + '" x1="0" y1="0" x2="0" y2="100" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="' + SRC_COL[r] + '" stop-opacity="1"/><stop offset="1" stop-color="' + SRC_COL[r] + '" stop-opacity=".45"/></linearGradient>'; }).join('') +
      '</defs>' + PAIRS.map(function (p) { return '<path data-pair="' + p + '"/>'; }).join('') + '</svg>' +
      '<div class="bal-bar dst">' + DST_ORDER.map(function (r) { return seg('dst', r); }).join('') + '</div>' +
      '<p class="bal-more" data-more="dst" hidden></p>' +
      '<div class="bal-h"><span>Wohin fließt er?</span><b data-tot="dst"></b></div>' +
      '<p class="bal-status"></p>';
    this.segs = { src: {}, dst: {} };
    $$('.seg-b', this.el).forEach(function (b) {
      self.segs[b.classList.contains('src') ? 'src' : 'dst'][b.getAttribute('data-role')] = b;
      b.addEventListener('click', function () { self.opts.onNode && self.opts.onNode(b.getAttribute('data-role'), 0, self.m, b); });
    });
    this.paths = {};
    $$('.bal-links path', this.el).forEach(function (p) {
      var k = p.getAttribute('data-pair');
      self.paths[k] = p; p.setAttribute('fill', 'url(#lg-' + k.split('>')[0] + '-' + self.v.key + ')'); p.setAttribute('stroke', SRC_COL[k.split('>')[0]]);
    });
    this.det.addEventListener('click', function (e) {
      var b = e.target.closest('[data-node]'); if (!b || !self.det.contains(b)) return;
      self.opts.onNode && self.opts.onNode(b.getAttribute('data-node'), +(b.getAttribute('data-i') || 0), self.m, b);
    });
  };
  Flow.prototype.setMode = function (mode) {
    this.mode = mode;
    if (mode === 'heute' && this.q > this.v.nowQ) this.q = this.v.nowQ;
    this.buildStrip();
    this.setQ(this.q);
  };
  Flow.prototype.setQ = function (q) {
    var v = this.v;
    q = clamp(Math.round(q), 0, this.mode === 'heute' ? v.nowQ : QH - 1);
    this.q = q;
    var m = momentAt(v, q, this.mode);
    this.m = m;
    this.el.classList.toggle('plan', m.fut);
    this.el.classList.toggle('heute', m.heute);
    this.animateTo(this.layout(m));
    this.labels();
    this.details();
    this.updateStrip();
    if (this.opts.onMoment) this.opts.onMoment(m, this);
  };

  /* Lage der Segmente und Bänder in einem Raster von 0 bis 1000 */
  Flow.prototype.layout = function (m) {
    var P = m.pairs, W = 1000;
    var sv = { pv: P['pv>load'] + P['pv>batt'] + P['pv>grid'], batt: P['batt>load'] + P['batt>grid'], grid: P['grid>load'] + P['grid>batt'] };
    var dv = { load: P['pv>load'] + P['batt>load'] + P['grid>load'], batt: P['pv>batt'] + P['grid>batt'], grid: P['pv>grid'] + P['batt>grid'] };
    var tot = sv.pv + sv.batt + sv.grid, L = { tot: tot, src: {}, dst: {}, links: {} };
    var sc = function (x) { return tot > 0 ? W * x / tot : 0; };
    var x = 0; SRC_ORDER.forEach(function (r) { L.src[r] = [x, sc(sv[r]), sv[r]]; x += sc(sv[r]); });
    x = 0; DST_ORDER.forEach(function (r) { L.dst[r] = [x, sc(dv[r]), dv[r]]; x += sc(dv[r]); });
    var so = {}, di = {};
    SRC_ORDER.forEach(function (r) { so[r] = L.src[r][0]; });
    DST_ORDER.forEach(function (r) { di[r] = L.dst[r][0]; });
    SRC_ORDER.forEach(function (s) { DST_ORDER.forEach(function (d) { var k = s + '>' + d; if (!(k in P)) return; var w = sc(P[k]); L.links[k] = { a0: so[s], a1: so[s] + w }; so[s] += w; }); });
    DST_ORDER.forEach(function (d) { SRC_ORDER.forEach(function (s) { var k = s + '>' + d; if (!(k in P)) return; var w = sc(P[k]); L.links[k].b0 = di[d]; L.links[k].b1 = di[d] + w; di[d] += w; }); });
    return L;
  };
  function lerpLayout(A, B, e) {
    var o = { tot: B.tot, src: {}, dst: {}, links: {} };
    ['src', 'dst'].forEach(function (s) { Object.keys(B[s]).forEach(function (r) { var a = A[s][r] || B[s][r], b = B[s][r]; o[s][r] = [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, b[2]]; }); });
    Object.keys(B.links).forEach(function (k) { var a = A.links[k] || B.links[k], b = B.links[k]; o.links[k] = { a0: a.a0 + (b.a0 - a.a0) * e, a1: a.a1 + (b.a1 - a.a1) * e, b0: a.b0 + (b.b0 - a.b0) * e, b1: a.b1 + (b.b1 - a.b1) * e }; });
    return o;
  }
  /* Werte gleiten nur beim Wechsel (200 ms), sonst steht das Bild still */
  Flow.prototype.animateTo = function (L) {
    var self = this, from = this.cur;
    this.tgt = L;
    cancelAnimationFrame(this.raf);
    if (!from || RM.matches) { this.cur = L; this.paint(L); return; }
    var t0 = performance.now(), D = 200;
    var step = function (t) {
      var k = Math.min(1, (t - t0) / D), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      self.cur = lerpLayout(from, L, e); self.paint(self.cur);
      if (k < 1 && self.alive) self.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  };
  Flow.prototype.paint = function (L) {
    var self = this;
    ['src', 'dst'].forEach(function (side) {
      Object.keys(L[side]).forEach(function (r) {
        var b = self.segs[side][r], s = L[side][r], vis = s[1] > 0.5;
        b.style.left = 'calc(' + (s[0] / 10).toFixed(3) + '% + 1px)';
        b.style.width = vis ? 'calc(' + (s[1] / 10).toFixed(3) + '% - 2px)' : '0px';
        b.style.visibility = vis ? 'visible' : 'hidden';
      });
    });
    Object.keys(this.paths).forEach(function (k) {
      var l = L.links[k], p = self.paths[k];
      if (!l || l.a1 - l.a0 < 0.4) { p.setAttribute('d', ''); return; }
      var f = function (x) { return x.toFixed(1); }, g = Math.min(3, (l.a1 - l.a0) / 4);
      l = { a0: l.a0 + g, a1: l.a1 - g, b0: l.b0 + g, b1: l.b1 - g };
      p.setAttribute('d', 'M' + f(l.a0) + ',0 C' + f(l.a0) + ',55 ' + f(l.b0) + ',45 ' + f(l.b0) + ',100 L' + f(l.b1) + ',100 C' + f(l.b1) + ',45 ' + f(l.a1) + ',55 ' + f(l.a1) + ',0 Z');
    });
  };
  function segName(r, side) { return r === 'grid' ? (side === 'src' ? 'Netz' : 'ins Netz') : r === 'batt' ? (side === 'src' ? 'Speicher' : 'in den Speicher') : ROLES[r].name; }
  Flow.prototype.labels = function () {
    var m = this.m, L = this.tgt, v = this.v, self = this; if (!m || !L) return;
    var f = m.heute ? kwh : kw, Wpx = this.el.clientWidth || 320, more = { src: [], dst: [] };
    var need = function (txt) { return 16 + 16 + 5 + txt.length * 7.3; };
    ['src', 'dst'].forEach(function (side) {
      Object.keys(L[side]).forEach(function (r) {
        var b = self.segs[side][r], s = L[side][r], px = s[1] / 1000 * Wpx - 2, name = segName(r, side), val = f(s[2]);
        var t = $('.seg-t', b);
        b.classList.remove('no-ico', 'tiny');
        b.setAttribute('aria-label', name + ' ' + val);
        if (s[1] <= 0.5) { t.textContent = ''; return; }
        if (px >= need(name + ' ' + val)) t.innerHTML = '<span class="seg-n">' + name + '</span> ' + val;
        else if (px >= need(val)) t.textContent = val;
        else if (px >= need(val) - 21) { t.textContent = val; b.classList.add('no-ico'); }
        else {
          t.textContent = ''; more[side].push([r, name, s[2]]);
          if (px < 30) b.classList.add('no-ico', 'tiny');
        }
      });
    });
    ['src', 'dst'].forEach(function (side) {
      var p = $('[data-more="' + side + '"]', self.el);
      p.innerHTML = more[side].map(function (x) { return '<span><i style="background:' + ROLES[x[0]].col + '"></i>' + x[1] + ' ' + f(x[2]) + '</span>'; }).join('');
      p.hidden = !more[side].length;
    });
    $('[data-tot="src"]', this.el).textContent = f(L.tot);
    $('[data-tot="dst"]', this.el).textContent = f(L.tot);
    var st = [];
    st.push(ic('battery', 15) + 'Speicher ' + pct(m.soc) + (m.heute ? '' : m.chg > DB ? ', lädt' : m.dis > DB ? ', entlädt' : ', ruht'));
    st.push(ic('pole', 15) + (m.heute ? 'Netzbezug ' + kwh(m.imp) + ', Einspeisung ' + kwh(m.exp) : m.imp > DB ? 'Netzbezug' : m.exp > DB ? 'Einspeisung ins Netz' : 'Netz ausgeglichen'));
    if (v.ziel && !m.heute) st.push(ic('gauge', 15) + 'Ziel ' + kw(v.ziel));
    if (m.price != null && !m.heute) st.push(ic('euro', 15) + 'Börsenpreis ' + ct(m.price));
    $('.bal-status', this.el).innerHTML = st.map(function (x) { return '<span>' + x + '</span>'; }).join('');
  };

  /* Geräte als sortierte Liste: am Telefon bis zu vier Zeilen, am Rechner bis zu sechs,
     der Rest als „n weitere“. Das volle Verzeichnis steht im Blatt. */
  Flow.prototype.details = function () {
    var m = this.m, v = this.v, f = m.heute ? kwh : kw, max = state.view === 'desktop' ? 6 : 4;
    function rows(items, total, kind, hue, noun) {
      items = items.slice().sort(function (a, b) { return b.val - a.val; });
      var shown = items.length <= max ? items : items.slice(0, max - 1), rest = items.slice(shown.length);
      var h = shown.map(function (it) {
        var share = total > 0 ? clamp(it.val / total, 0, 1) : 0;
        return '<li><button type="button" class="drow' + (it.cls ? ' ' + it.cls : '') + '" data-node="' + kind + '" data-i="' + it.i + '" style="--hue:' + hue + '"><span class="dico">' + ic(it.icon, 15) + '</span><span class="dnm">' + it.name + (it.sub ? ' <small>' + it.sub + '</small>' : '') + '</span><span class="dv">' + it.txt + '</span><span class="trk"><i style="width:' + (100 * share).toFixed(1) + '%"></i></span></button></li>';
      }).join('');
      if (rest.length) {
        var sum = rest.reduce(function (a, b) { return a + b.val; }, 0);
        h += '<li><button type="button" class="drow more" data-node="' + (kind === 'con' ? 'more' : 'pv') + '" style="--hue:' + hue + '"><span class="dico">' + ic('plus', 15) + '</span><span class="dnm">' + rest.length + ' weitere ' + noun + '</span><span class="dv">' + f(sum) + '</span></button></li>';
      }
      return h;
    }
    var cons = m.con.map(function (c, j) {
      var sub = '', cls = '';
      if (c.ghost) { sub = 'ohne Aufteilung je Gerät'; cls = 'plan'; }
      else if (c.merged) { sub = 'nicht aufgeteilt, Stand ' + c.stale.staleTime + ' Uhr'; cls = 'stale'; }
      else if (c.rest) { sub = 'berechnet'; cls = 'rest'; }
      else if (!m.heute && c.kw <= DB) { sub = 'aus'; cls = 'off'; }
      return { i: j, name: c.ghost ? 'Verbrauchsprognose' : c.merged ? c.name : (c.full || c.name), sub: sub, cls: cls, icon: c.icon, val: c.kw, txt: f(c.kw) };
    });
    var srcs = m.src.map(function (s, i) {
      return { i: i, name: s.name, sub: s.ghost ? 'für die ganze Anlage' : s.zero ? 'liefert gerade keine Erzeugung' : '', cls: s.ghost ? 'plan' : s.zero ? 'off' : '', icon: s.icon, val: s.kw, txt: s.zero ? '0 kW' : f(s.kw) };
    });
    var head = function (t, val) { return '<div class="dl-h"><span>' + t + '</span><b>' + f(val) + '</b></div>'; };
    var h = '<section class="dl" aria-label="Verbrauch im Detail">' + head('Verbrauch im Detail', m.load) + '<ul class="drows">' + rows(cons, m.load, 'con', 'var(--load)', 'Verbraucher') + '</ul></section>';
    if (m.src.length > 1 || m.fut) h += '<section class="dl" aria-label="Erzeugung im Detail">' + head('Erzeugung im Detail', m.pv) + '<ul class="drows">' + rows(srcs, m.pv, 'src', 'var(--pv)', 'Quellen') + '</ul></section>';
    this.det.innerHTML = h;
  };

  /* ---------- Tagesleiste ---------- */
  Flow.prototype.buildStrip = function () {
    var st = this.strip, v = this.v, d = v.day, self = this;
    var w = Math.max(240, st.clientWidth), h = 88, top = 4, base = 70;
    this.sw = w;
    var X = function (q) { return (q + 0.5) * w / QH; };
    var nowX = (v.nowQ + 1) * w / QH;
    var svg = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" aria-hidden="true">';
    // Bereich rechts von Jetzt = Plan
    if (this.mode !== 'heute') svg += '<rect x="' + nowX + '" y="0" width="' + (w - nowX) + '" height="' + (base + 2) + '" fill="' + C.cMuted + '" opacity=".55" rx="6"/>';
    var mainTop = top + 2, mainH = base - mainTop;
    function line(vals, y0, hh, max, col, q0, q1, dash, wdt) {
      var s = '';
      for (var q = q0; q <= q1; q++) s += (q === q0 ? 'M' : 'L') + X(q).toFixed(1) + ',' + (y0 + hh - hh * clamp(vals[q] / max, 0, 1)).toFixed(1) + ' ';
      return '<path d="' + s + '" fill="none" stroke="' + col + '" stroke-width="' + (wdt || 1.6) + '" stroke-linejoin="round" stroke-linecap="round"' + (dash ? ' stroke-dasharray="3 3"' : '') + '/>';
    }
    function area(vals, y0, hh, max, col, q0, q1, op) {
      var s = 'M' + X(q0).toFixed(1) + ',' + (y0 + hh) + ' ';
      for (var q = q0; q <= q1; q++) s += 'L' + X(q).toFixed(1) + ',' + (y0 + hh - hh * clamp(vals[q] / max, 0, 1)).toFixed(1) + ' ';
      s += 'L' + X(q1).toFixed(1) + ',' + (y0 + hh) + ' Z';
      return '<path d="' + s + '" fill="' + col + '" opacity="' + op + '"/>';
    }
    var nq = v.nowQ, endQ = this.mode === 'heute' ? nq : QH - 1;
    var lanes = '';
    if (v.key === 'markt') {
      // Spur 1: Börsenpreis (Balken), Fenster aus dem Plan gefärbt; Spur 2: Speicher laden/abgeben
      var pMax = Math.max.apply(null, d.price), pH = 20, bw = Math.max(1, w / QH - 1);
      for (var q = 0; q <= endQ; q++) {
        var r = d.role[q], col = r === 'guenstig_laden' ? C.cheap : r === 'verkaufen' ? C.dear : C.gray;
        var hh = Math.max(1.5, pH * clamp(d.price[q] / pMax, 0, 1));
        lanes += '<rect x="' + (X(q) - bw / 2).toFixed(1) + '" y="' + (top + pH - hh).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hh.toFixed(1) + '" fill="' + col + '" opacity="' + (q > nq ? 0.45 : 0.85) + '"/>';
      }
      lanes += '<text x="2" y="' + (top + pH + 11) + '" class="lane-lbl">Börsenpreis</text>';
      var mid = 52, sH = 16, bMax = v.batt.maxKw;
      lanes += '<line x1="0" x2="' + w + '" y1="' + mid + '" y2="' + mid + '" stroke="' + C.border + '"/>';
      for (q = 0; q <= endQ; q++) {
        var b = d.bkw[q]; if (Math.abs(b) < 0.5) continue;
        var hb = sH * clamp(Math.abs(b) / bMax, 0, 1);
        lanes += '<rect x="' + (X(q) - bw / 2).toFixed(1) + '" y="' + (b > 0 ? mid - hb : mid).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hb.toFixed(1) + '" fill="' + (b > 0 ? C.battFill : C.battdis) + '" opacity="' + (q > nq ? 0.45 : 0.9) + '"/>';
      }
      lanes += '<text x="2" y="' + (base - 1) + '" class="lane-lbl">Speicher</text>';
    } else if (v.key === 'spitze') {
      var gMax = v.fMax * 1.05, zy = mainTop + mainH - mainH * v.ziel / gMax;
      var baseL = d.grid.map(function (x, i) { return x + Math.max(-d.bkw[i], 0); });
      // gekappte Fläche zwischen „ohne Speicher“ und Netzbezug
      var shav = '';
      for (q = 0; q <= endQ; q++) {
        if (d.bkw[q] < -0.5) {
          var y1 = mainTop + mainH - mainH * clamp(baseL[q] / gMax, 0, 1), y2 = mainTop + mainH - mainH * clamp(d.grid[q] / gMax, 0, 1);
          shav += '<rect x="' + (X(q) - w / QH / 2).toFixed(1) + '" y="' + y1.toFixed(1) + '" width="' + (w / QH).toFixed(1) + '" height="' + Math.max(1, y2 - y1).toFixed(1) + '" fill="' + C.battFill + '" opacity="' + (q > nq ? 0.2 : 0.35) + '"/>';
        }
      }
      lanes += shav;
      lanes += line(baseL, mainTop, mainH, gMax, C.gray, 0, Math.min(nq, endQ), true, 1.2);
      lanes += line(d.grid, mainTop, mainH, gMax, C.gridLine, 0, Math.min(nq, endQ));
      if (endQ > nq) lanes += line(d.grid, mainTop, mainH, gMax, C.gridLine, nq, endQ, true);
      lanes += '<line x1="0" x2="' + w + '" y1="' + zy.toFixed(1) + '" y2="' + zy.toFixed(1) + '" stroke="' + C.plan + '" stroke-width="1.2" stroke-dasharray="5 3"/>';
      lanes += '<text x="' + (w - 2) + '" y="' + (zy - 3).toFixed(1) + '" text-anchor="end" class="lane-lbl">Ziel ' + NF0.format(v.ziel) + ' kW</text>';
      lanes += '<text x="2" y="' + (top + 9) + '" class="lane-lbl">Netzbezug</text>';
    } else {
      var mx = v.fMax * 1.05;
      lanes += area(d.pv, mainTop, mainH, mx, C.pvFill, 0, Math.min(nq, endQ), 0.28);
      lanes += line(d.pv, mainTop, mainH, mx, C.pv, 0, Math.min(nq, endQ));
      if (endQ > nq) { lanes += area(d.pv, mainTop, mainH, mx, C.pvFill, nq, endQ, 0.12); lanes += line(d.pv, mainTop, mainH, mx, C.pv, nq, endQ, true); }
      lanes += line(d.load, mainTop, mainH, mx, C.load, 0, Math.min(nq, endQ));
      if (endQ > nq) lanes += line(d.load, mainTop, mainH, mx, C.load, nq, endQ, true);
      lanes += '<text x="2" y="' + (top + 9) + '" class="lane-lbl">PV und Verbrauch</text>';
    }
    svg += lanes;
    // Achse
    [0, 6, 12, 18, 24].forEach(function (hr) {
      var x = hr * w / 24;
      svg += '<line x1="' + x + '" x2="' + x + '" y1="' + (base + 2) + '" y2="' + (base + 5) + '" stroke="' + C.border + '"/>';
      svg += '<text x="' + clamp(x, 6, w - 6) + '" y="' + (h - 2) + '" text-anchor="' + (hr === 0 ? 'start' : hr === 24 ? 'end' : 'middle') + '" class="ax">' + (hr === 24 ? '24 Uhr' : hr) + '</text>';
    });
    // Jetzt-Marke
    svg += '<path d="M' + (nowX - 4) + ',' + (base + 1) + ' L' + nowX + ',' + (base + 6) + ' L' + (nowX + 4) + ',' + (base + 1) + ' Z" fill="' + C.fg + '"/>';
    if (this.mode !== 'heute' && nowX + 60 < w) svg += '<text x="' + (w - 4) + '" y="' + (base - 3) + '" class="lane-lbl" text-anchor="end">Plan</text>';
    svg += '</svg>';
    st.innerHTML = svg + '<div class="head"><span class="knob"></span></div>';
    this.headEl = $('.head', st);
    this.updateStrip();
  };
  Flow.prototype.updateStrip = function () {
    if (!this.headEl || !this.m) return;
    var q = this.q, v = this.v, x = (q + (q === v.nowQ ? 0.95 : 0.5)) * this.sw / QH;
    if (this.mode === 'heute') x = (q + 1) * this.sw / QH;
    this.headEl.style.left = x + 'px';
    var m = this.m, txt = m.time + ', ' + (m.heute ? 'Energie bis dahin' : m.fut ? 'Plan und Prognose' : m.live ? 'jetzt' : 'gemessen');
    this.strip.setAttribute('aria-valuenow', q);
    this.strip.setAttribute('aria-valuetext', txt);
    this.strip.setAttribute('aria-valuemax', this.mode === 'heute' ? v.nowQ : QH - 1);
  };
  Flow.prototype.bind = function () {
    var self = this, st = this.strip, drag = false;
    function qFrom(e) { var r = st.getBoundingClientRect(); return Math.floor(clamp((e.clientX - r.left) / r.width, 0, 0.9999) * QH); }
    st.addEventListener('pointerdown', function (e) { drag = true; self.stop(); try { st.setPointerCapture(e.pointerId); } catch (x) { } self.setQ(qFrom(e)); self.touched(); });
    st.addEventListener('pointermove', function (e) { if (drag) self.setQ(qFrom(e)); });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) { st.addEventListener(ev, function () { drag = false; }); });
    st.addEventListener('keydown', function (e) {
      var q = self.q, k = e.key, step = e.shiftKey ? 4 : 1;
      if (k === 'ArrowLeft' || k === 'ArrowDown') q -= step;
      else if (k === 'ArrowRight' || k === 'ArrowUp') q += step;
      else if (k === 'Home') q = 0; else if (k === 'End') q = QH - 1;
      else if (k === 'PageUp') q += 8; else if (k === 'PageDown') q -= 8;
      else return;
      e.preventDefault(); self.stop(); self.setQ(q); self.touched();
    });
  };
  Flow.prototype.touched = function () { if (this.opts.onTouch) this.opts.onTouch(); };
  Flow.prototype.play = function () {
    var self = this, v = this.v, end = this.mode === 'heute' ? v.nowQ : QH - 1;
    if (this.playing) { this.stop(); return; }
    if (this.q >= end || this.q === v.nowQ) this.setQ(0);
    this.playing = true; this.opts.onPlay && this.opts.onPlay(true);
    this.playT = setInterval(function () {
      if (self.q >= end) { self.stop(); return; }
      self.setQ(self.q + 1);
    }, RM.matches ? 220 : 110);
  };
  Flow.prototype.stop = function () { if (!this.playing) return; this.playing = false; clearInterval(this.playT); this.opts.onPlay && this.opts.onPlay(false); };
  Flow.prototype.live = function () { this.stop(); this.setQ(this.v.nowQ); };

  /* ================= Kacheln ================= */
  var PER = { heute: 'Heute', monat: 'Monat', jahr: 'Jahr' };
  var state = { v: 'privat', view: 'phone', period: {}, layout: {}, lead: {} };

  function todayUntilNow(v) {
    var c = v.cum, n = v.nowQ;
    return { pv: c.pv[n], load: c.load[n], imp: c.imp[n], exp: c.exp[n], chg: c.chg[n], dis: c.dis[n], pairs: c.pairs[n], src: c.pvSrc[n], cons: c.cons[n] };
  }
  function forecastDay(v) { var s = 0; for (var q = 0; q < QH; q++) s += v.day.pv[q] * 0.25; return s; }
  function nextSteps(v, max) {
    var d = v.day, out = [], cur = d.role[v.nowQ];
    for (var q = v.nowQ + 1; q < QH && out.length < max; q++) if (d.role[q] !== cur) { cur = d.role[q]; out.push({ q: q, role: cur }); }
    return out;
  }
  function battTiming(v) {
    var d = v.day, n = v.nowQ, b = d.bkw[n], q;
    if (b > DB) {
      for (q = n + 1; q < QH; q++) if (d.bkw[q] <= DB) return d.soc[q - 1] >= 99 ? 'Voll gegen ' + hhmm(q) + ' (erwartet)' : 'Lädt laut Plan bis ' + hhmm(q) + ' auf ' + pct(d.soc[q - 1]);
      return 'Lädt laut Plan bis Mitternacht';
    }
    if (b < -DB) {
      for (q = n + 1; q < QH; q++) if (d.soc[q] <= v.batt.min + 0.5) return 'Reicht bis ca. ' + hhmm(q) + ' (Plan)';
      for (q = n + 1; q < QH; q++) if (d.bkw[q] >= -DB) return 'Gibt laut Plan bis ' + hhmm(q) + ' ab, dann ' + pct(d.soc[q - 1]);
      return 'Reicht über Mitternacht (Plan)';
    }
    var nx = nextSteps(v, 1)[0];
    return nx ? 'Ab ' + hhmm(nx.q) + ': ' + TAET[nx.role] + ' (Plan)' : 'Wartet laut Plan';
  }
  function head(t, lead) {
    return '<button type="button" class="t-head" data-go="' + t.target + '" style="--hue:' + t.hue + ';--soft:' + t.soft + '"><span class="t-ico">' + ic(t.icon, 16) + '</span><span class="t-name">' + t.name + '</span>' + (lead ? '<span class="star" title="Leitkachel">' + icStar(14, true) + '</span>' : '') + '<span class="chev">' + ic('chevR', 16) + '</span></button>';
  }
  function battSvg(soc, reserve, w, h, charging) {
    var ih = h - 10, fh = Math.max(2, ih * soc / 100);
    var s = '<svg class="ill" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" style="width:' + w + 'px" aria-hidden="true">';
    s += '<rect x="' + (w / 2 - 6) + '" y="0" width="12" height="5" rx="2" fill="' + C.batt + '"/>';
    s += '<rect x="1.5" y="5.5" width="' + (w - 3) + '" height="' + (h - 7) + '" rx="8" fill="' + C.card + '" stroke="' + C.batt + '" stroke-width="2"/>';
    s += '<rect x="5" y="' + (h - 5 - fh).toFixed(1) + '" width="' + (w - 10) + '" height="' + fh.toFixed(1) + '" rx="5" fill="' + C.battFill + '"/>';
    if (charging) s += '<path d="M' + (w / 2 - 5) + ',' + (h / 2 + 3) + ' l5,-6 l5,6" fill="none" stroke="' + C.card + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
    if (reserve) { var ry = h - 5 - ih * reserve / 100; s += '<line x1="-3" x2="' + (w + 3) + '" y1="' + ry + '" y2="' + ry + '" stroke="' + C.fg + '" stroke-width="2"/>'; }
    return s + '</svg>';
  }
  function sunArc(v, m, w, h) {
    var x0 = 8, x1 = w - 8, base = h - 10, apex = 6, cy = 2 * apex - base;
    var f = clamp((m.hour - v.rise) / (v.set - v.rise), 0, 1), u = 1 - f;
    var sx = x0 + (x1 - x0) * f, sy = u * u * base + 2 * u * f * cy + f * f * base;
    var s = '<svg class="ill" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" style="max-width:' + w + 'px" aria-hidden="true">';
    s += '<path d="M' + x0 + ',' + base + ' Q' + (w / 2) + ',' + cy + ' ' + x1 + ',' + base + '" fill="none" stroke="' + C.border + '" stroke-width="1.5"/>';
    s += '<path d="M' + x0 + ',' + base + ' Q' + (w / 2) + ',' + cy + ' ' + x1 + ',' + base + '" fill="none" stroke="' + C.pvFill + '" stroke-width="2.5" stroke-dasharray="' + (f * (x1 - x0) * 1.25).toFixed(0) + ' 999"/>';
    s += '<line x1="0" x2="' + w + '" y1="' + base + '" y2="' + base + '" stroke="' + C.border + '"/>';
    s += '<circle cx="' + sx.toFixed(1) + '" cy="' + sy.toFixed(1) + '" r="' + (8 + 8 * clamp(m.irr / 860, 0, 1)).toFixed(1) + '" fill="' + C.pvFill + '" opacity=".22"/>';
    s += '<circle cx="' + sx.toFixed(1) + '" cy="' + sy.toFixed(1) + '" r="6" fill="' + C.pvFill + '" stroke="' + C.card + '" stroke-width="2"/>';
    return s + '</svg>';
  }
  function miniBars(rows, max) {
    return '<div class="minis">' + rows.map(function (r) {
      return '<div class="mini" style="--hue:' + (r.col || 'var(--load)') + '"><span class="n">' + r.n + '</span><span class="v">' + r.v + '</span><span class="trk"><i style="width:' + (100 * clamp(r.x / max, 0, 1)).toFixed(1) + '%;' + (r.op ? 'opacity:' + r.op : '') + '"></i></span></div>';
    }).join('') + '</div>';
  }

  var TILES = {
    geld: {
      name: 'Unterm Strich', icon: 'euro', hue: 'var(--navy)', soft: 'var(--c-muted)', target: 'Erlöse', sizes: ['w2'], leadable: true,
      purpose: 'Ihr Ergebnis in Euro, netto, für Heute, Monat oder Jahr. Eine Geldzahl je Schirm.',
      avail: function () { return { ok: true }; },
      body: function (v) {
        var p = state.period[v.key] || 'heute', val = v.money[p];
        return '<div class="vrow"><div><div class="vbig xl">' + eur(val.eur) + '</div><div class="vsub">' + val.label + '</div></div>' +
          '<div class="segm" role="group" aria-label="Zeitraum">' + Object.keys(PER).map(function (k) { return '<button type="button" data-period="' + k + '" aria-pressed="' + (k === p) + '">' + PER[k] + '</button>'; }).join('') + '</div></div>' +
          '<div class="vsub">' + v.money.hinweis + '</div>' + (p === 'heute' ? '<span class="prov">Zwischenstand</span>' : '');
      }
    },
    autarkie: {
      name: 'Autarkie', icon: 'house', hue: 'var(--load)', soft: 'var(--load-soft)', target: 'Verlauf › Energie', sizes: ['w1'],
      purpose: 'Wie viel Ihres Verbrauchs heute aus Sonne und Speicher kam. Die Füllung zeigt die Herkunft.',
      avail: function () { return { ok: true }; },
      body: function (v) {
        var t = todayUntilNow(v), P = t.pairs, L = t.load || 1;
        var a = P['pv>load'] / L, b = P['batt>load'] / L, g = P['grid>load'] / L, own = 100 * (a + b);
        var hs = 'M6 26 L32 5 L58 26 V57 H6 Z', H0 = 57, span = 52;
        var ya = H0 - span * a, yb = ya - span * b;
        var s = '<svg class="ill" viewBox="0 0 64 60" style="width:64px;height:60px" aria-hidden="true"><defs><clipPath id="hc-' + v.key + '"><path d="' + hs + '"/></clipPath></defs>' +
          '<g clip-path="url(#hc-' + v.key + ')"><rect x="0" y="0" width="64" height="60" fill="' + C.grid + '" opacity=".28"/>' +
          '<rect x="0" y="' + ya.toFixed(1) + '" width="64" height="' + (H0 - ya).toFixed(1) + '" fill="' + C.pvFill + '"/>' +
          '<rect x="0" y="' + yb.toFixed(1) + '" width="64" height="' + (ya - yb).toFixed(1) + '" fill="' + C.battFill + '"/></g>' +
          '<path d="' + hs + '" fill="none" stroke="' + C.fg + '" stroke-width="2" stroke-linejoin="round"/></svg>';
        return '<div class="row2">' + s + '<div><div class="vbig">' + NF0.format(own) + '<span class="u">%</span></div><div class="vsub">heute selbst gedeckt</div></div></div>' +
          '<div class="legend"><span><i style="background:var(--pv-fill)"></i>Sonne ' + pct(100 * a) + '</span><span><i style="background:var(--batt-fill)"></i>Speicher ' + pct(100 * b) + '</span><span><i style="background:var(--grid);opacity:.5"></i>Netz ' + pct(100 * g) + '</span></div>';
      }
    },
    eigenverbrauch: {
      name: 'Eigen\u00adverbrauch', icon: 'sun', hue: 'var(--pv)', soft: 'var(--pv-soft)', target: 'Verlauf › Energie', sizes: ['w1'],
      purpose: 'Wohin Ihre Erzeugung heute ging: ins Haus, in den Speicher oder ins Netz.',
      avail: function () { return { ok: true }; },
      body: function (v) {
        var t = todayUntilNow(v), P = t.pairs, T = t.pv || 1;
        var parts = [[P['pv>load'] / T, C.load], [P['pv>batt'] / T, C.battFill], [P['pv>grid'] / T, C.grid]];
        var r = 24, cx = 30, cy = 30, circ = 2 * Math.PI * r, off = 0, s = '<svg class="ill" viewBox="0 0 60 60" style="width:60px;height:60px" aria-hidden="true"><circle cx="30" cy="30" r="' + r + '" fill="none" stroke="' + C.base + '" stroke-width="7"/>';
        parts.forEach(function (p) { var L = Math.max(0, p[0] * circ - 2); if (L > 0.5) s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + p[1] + '" stroke-width="7" stroke-dasharray="' + L.toFixed(2) + ' ' + circ.toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 30 30)"/>'; off += p[0] * circ; });
        s += '<g transform="translate(20 20) scale(.84)" stroke="' + C.pv + '" fill="none" stroke-width="2" stroke-linecap="round">' + I.sun + '</g></svg>';
        return '<div class="row2">' + s + '<div><div class="vbig">' + NF0.format(100 * (1 - t.exp / T)) + '<span class="u">%</span></div><div class="vsub">heute selbst genutzt</div></div></div>' +
          '<div class="legend"><span><i style="background:var(--load)"></i>Haus</span><span><i style="background:var(--batt-fill)"></i>Speicher</span><span><i style="background:var(--grid)"></i>Netz ' + kwh(t.exp) + '</span></div>';
      }
    },
    speicher: {
      name: 'Speicher', icon: 'battery', hue: 'var(--batt)', soft: 'var(--batt-soft)', target: 'Fahrplan', sizes: ['w1', 'w2'], leadable: true,
      purpose: 'Ladestand, was der Speicher gerade tut und was der Plan als Nächstes vorhat.',
      avail: function () { return { ok: true }; },
      body: function (v, size) {
        var d = v.day, n = v.nowQ, b = d.bkw[n], st = b > DB ? 'lädt ' + kw(b) : b < -DB ? 'entlädt ' + kw(-b) : 'ruht';
        var nx = nextSteps(v, 1)[0];
        return '<div class="row2">' + battSvg(d.soc[n], v.batt.reserve, 38, 60, b > DB) + '<div><div class="vbig">' + NF0.format(d.soc[n]) + '<span class="u">%</span></div><div class="vstate">' + st + '</div></div></div>' +
          '<div class="vsub">' + battTiming(v) + (size === 'w2' && nx ? ' · Ab ' + hhmm(nx.q) + ': ' + TAET[nx.role] : '') + '</div>' +
          '<span class="prov plan">Plan: ' + TAET[d.role[n]] + '</span>';
      }
    },
    sonne: {
      name: 'Sonne', icon: 'sun', hue: 'var(--pv)', soft: 'var(--pv-soft)', target: 'Fahrplan › Wetter', sizes: ['w1', 'w2'],
      purpose: 'Sonnenstärke am Standort und die Erzeugung heute: gemessen und erwartet.',
      avail: function () { return { ok: true }; },
      body: function (v, size) {
        var m = momentAt(v, v.nowQ, 'jetzt'), t = todayUntilNow(v), fc = forecastDay(v), share = clamp(t.pv / fc, 0, 1);
        var bar = '<div class="mini" style="--hue:var(--pv-fill)"><span class="n">PV heute gemessen</span><span class="v">' + kwh(t.pv) + '</span><span class="trk" style="background:repeating-linear-gradient(135deg,var(--pv-soft) 0 4px,var(--c-card) 4px 7px);box-shadow:inset 0 0 0 1px var(--pv-soft)"><i style="width:' + (100 * share).toFixed(1) + '%"></i></span></div>';
        var num = '<div><div class="vbig">' + NF0.format(m.irr) + '<span class="u">W/m²</span></div><div class="vsub">Sonnenstärke jetzt</div></div>';
        var top = size === 'w1' ? sunArc(v, m, 140, 50) + num : '<div class="row2" style="grid-template-columns:minmax(0,150px) minmax(0,1fr)">' + sunArc(v, m, 150, 58) + num + '</div>';
        return top + '<div class="minis">' + bar + '<div class="vsub">Erwartet heute: ' + kwh(fc) + (size === 'w1' ? '' : ' · morgen: ' + kwh(v.morgen)) + '</div></div>';
      }
    },
    preis: {
      name: 'Börsenpreis', icon: 'euro', hue: 'var(--price)', soft: 'var(--c-muted)', target: 'Fahrplan › Marktpreise', sizes: ['w2'], leadable: true,
      purpose: 'Preis jetzt mit Einordnung, der Tagesverlauf und wann der Plan lädt oder verkauft.',
      avail: function (v) { return v.price_h ? { ok: true } : { ok: false, need: 'Braucht einen dynamischen Tarif oder das Betriebsmodell Marktoptimierung.' }; },
      body: function (v) {
        var d = v.day, n = v.nowQ, p = d.price[n], sorted = d.price.slice().sort(function (a, b) { return a - b; });
        var lo = sorted[0], hi = sorted[QH - 1], q1 = sorted[24], q3 = sorted[72];
        var urteil = p < 0 ? 'Negativpreis' : p <= q1 ? 'gerade günstig' : p >= q3 ? 'gerade teuer' : 'im Mittelfeld';
        var w = 320, h = 76, top = 8, ch = 64, X = function (q) { return (q + 0.5) * w / QH; }, Y = function (x) { return top + ch - ch * (x - 0) / (hi * 1.05); };
        var s = '<div><svg class="ill" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">';
        // Planfenster
        var q = 0;
        while (q < QH) {
          var r = d.role[q], q0 = q; while (q < QH && d.role[q] === r) q++;
          if (r === 'guenstig_laden' || r === 'verkaufen') s += '<rect x="' + (q0 * w / QH).toFixed(1) + '" y="' + top + '" width="' + ((q - q0) * w / QH).toFixed(1) + '" height="' + ch + '" fill="' + (r === 'guenstig_laden' ? C.cheap : C.dear) + '" opacity=".1"/>';
        }
        s += '<line x1="0" x2="' + w + '" y1="' + (top + ch) + '" y2="' + (top + ch) + '" stroke="' + C.border + '"/>';
        var dd = '';
        for (q = 0; q < QH; q++) { var x0 = q * w / QH, x1 = (q + 1) * w / QH, y = Y(d.price[q]); dd += (q === 0 ? 'M' : 'L') + x0.toFixed(1) + ',' + y.toFixed(1) + ' L' + x1.toFixed(1) + ',' + y.toFixed(1) + ' '; }
        s += '<path d="' + dd + '" fill="none" stroke="' + C.price + '" stroke-width="2" stroke-linejoin="round"/>';
        var nx = (n + 1) * w / QH;
        s += '<line x1="' + nx + '" x2="' + nx + '" y1="' + (top - 4) + '" y2="' + (top + ch) + '" stroke="' + C.fg + '" stroke-width="1" stroke-dasharray="3 3" opacity=".55"/>';
        s += '<circle cx="' + X(n) + '" cy="' + Y(p) + '" r="4.5" fill="' + C.price + '" stroke="' + C.card + '" stroke-width="2"/>';
        s += '</svg><div class="axis" aria-hidden="true"><span>0</span><span>6</span><span>12</span><span>18</span><span>24 Uhr</span></div></div>';
        var sell = v.windows.filter(function (wd) { return wd.role === 'verkaufen' && wd.a * 4 > n; })[0];
        return '<div class="vrow"><div><div class="vbig">' + NF1.format(p) + '<span class="u">ct/kWh</span></div><div class="vsub">Börsenpreis jetzt</div></div><span class="prov ' + (urteil === 'gerade teuer' ? 'warn' : 'ok') + '">' + urteil + '</span></div>' + s +
          '<div class="legend"><span><i class="ln" style="background:var(--price)"></i>Börsenpreis</span><span><i style="background:var(--cheap);opacity:.35"></i>Laden (Plan)</span><span><i style="background:var(--dear);opacity:.35"></i>Verkaufen (Plan)</span></div>' +
          '<div class="vsub">Tagestief ' + ct(lo) + ' · Tageshoch ' + ct(hi) + '. ' + v.morgenPreis + '</div>' +
          (sell ? '<span class="prov plan">Plan: Verkaufen ' + hhmm(sell.a * 4) + '–' + hhmm(Math.round(sell.b * 4)) + '</span>' : '');
      }
    },
    handel: {
      name: 'Handel', icon: 'trend', hue: 'var(--grid-line)', soft: 'var(--grid-soft)', target: 'Fahrplan', sizes: ['w2'],
      purpose: 'Wann der Speicher heute günstig lädt und teuer verkauft, mit Durchschnittspreis.',
      avail: function (v) { return v.windows ? { ok: true } : { ok: false, need: 'Braucht das Betriebsmodell Marktoptimierung.' }; },
      body: function (v) {
        var d = v.day, n = v.nowQ, tot = 0;
        var rows = v.windows.map(function (wd) {
          var q0 = Math.round(wd.a * 4), q1 = Math.round(wd.b * 4), e = 0, pe = 0;
          for (var q = q0; q < q1; q++) { var x = Math.abs(d.bkw[q]) * 0.25; e += x; pe += x * d.price[q]; }
          tot += e;
          var st = q1 <= n ? 'erledigt' : q0 <= n ? 'läuft' : 'geplant';
          var up = wd.role === 'guenstig_laden';
          return '<div class="trade' + (st === 'geplant' ? ' plan' : '') + '"><span class="arrow" style="background:' + (up ? 'var(--batt-soft)' : 'color-mix(in srgb,var(--battdis) 12%,var(--c-card))') + ';color:' + (up ? 'var(--batt)' : 'var(--battdis)') + '">' + ic(up ? 'up' : 'down', 14) + '</span>' +
            '<span><span class="tm">' + hhmm(q0) + '–' + hhmm(q1) + '</span><span class="ac">' + TAET[wd.role] + ' · ' + kwh(e) + '</span></span>' +
            '<span class="pr">Ø ' + ct(e ? pe / e : 0) + '<small>' + (st === 'geplant' ? 'erwartet · geplant' : st) + '</small></span></div>';
        }).join('');
        var cyc = tot / 2 / v.batt.kwh;
        var sorted = d.price.slice().sort(function (a, b) { return a - b; });
        return '<div class="trades">' + rows + '</div><div class="vsub">Spanne heute: ' + ct(sorted[QH - 1] - sorted[0]) + ' · Vollzyklen heute: ' + NF1.format(cyc) + ' (mit Plan)</div>';
      }
    },
    lastspitze: {
      name: 'Lastspitze', icon: 'gauge', hue: 'var(--grid-line)', soft: 'var(--grid-soft)', target: 'Erlöse › Lastspitzen', sizes: ['g2'], leadable: true,
      purpose: 'Viertelstundenmittel gegen das Ziel, die Monatsspitze und was ohne Speicher gewesen wäre.',
      avail: function (v) { return v.ziel ? { ok: true } : { ok: false, need: 'Braucht einen hinterlegten Leistungspreis (Lastspitzenkappung).' }; },
      body: function (v) {
        var d = v.day, n = v.nowQ, now = d.grid[n], Z = v.ziel, max = 450;
        var W = 220, H = 128, cx = W / 2, cy = 112, r = 88;
        var ang = function (x) { return Math.PI * (1 - clamp(x / max, 0, 1)); };
        var P = function (x, rr) { var a = ang(x); return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)]; };
        var arc = function (a, b, col, wd) { var p0 = P(a, r), p1 = P(b, r); return '<path d="M' + p0[0].toFixed(1) + ',' + p0[1].toFixed(1) + ' A' + r + ',' + r + ' 0 0 1 ' + p1[0].toFixed(1) + ',' + p1[1].toFixed(1) + '" fill="none" stroke="' + col + '" stroke-width="' + wd + '" stroke-linecap="round"/>'; };
        var s = '<svg class="ill" viewBox="0 0 ' + W + ' ' + H + '" style="max-width:' + W + 'px;margin:0 auto" aria-hidden="true">';
        s += arc(0, max, C.base, 12) + arc(0, now, C.gridLine, 12);
        var z0 = P(Z, r - 12), z1 = P(Z, r + 12);
        s += '<line x1="' + z0[0].toFixed(1) + '" y1="' + z0[1].toFixed(1) + '" x2="' + z1[0].toFixed(1) + '" y2="' + z1[1].toFixed(1) + '" stroke="' + C.plan + '" stroke-width="2.5"/>';
        var zl = P(Z, r + 22);
        s += '<text x="' + zl[0].toFixed(1) + '" y="' + zl[1].toFixed(1) + '" text-anchor="middle" style="font:700 11px var(--font);fill:var(--plan)">Ziel</text>';
        var ms = P(v.monat.spitze, r - 16);
        s += '<circle cx="' + ms[0].toFixed(1) + '" cy="' + ms[1].toFixed(1) + '" r="3.5" fill="' + C.fg + '"/>';
        s += '<text x="' + cx + '" y="' + (cy - 26) + '" text-anchor="middle" style="font:800 26px var(--font);fill:var(--c-fg);letter-spacing:-.02em">' + NF0.format(now) + ' kW</text>';
        s += '<text x="' + cx + '" y="' + (cy - 8) + '" text-anchor="middle" style="font:500 12px var(--font);fill:var(--c-muted-fg)">Netzbezug, Viertelstunde</text>';
        s += '<text x="' + (cx - r) + '" y="' + (cy + 14) + '" text-anchor="middle" style="font:500 11px var(--font);fill:var(--c-muted-fg)">0</text><text x="' + (cx + r) + '" y="' + (cy + 14) + '" text-anchor="middle" style="font:500 11px var(--font);fill:var(--c-muted-fg)">' + max + '</text>';
        s += '</svg>';
        var baseMax = 0; for (var q = 0; q <= n; q++) baseMax = Math.max(baseMax, d.grid[q] + Math.max(-d.bkw[q], 0));
        // Tagesverlauf mit Ziel und gekappter Fläche
        var w = 320, h = 70, gm = v.fMax * 1.05, Y = function (x) { return 4 + (h - 8) - (h - 8) * clamp(x / gm, 0, 1); }, X = function (q) { return (q + 0.5) * w / QH; };
        var c = '<div><svg class="ill" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">';
        for (q = 0; q <= n; q++) if (d.bkw[q] < -0.5) c += '<rect x="' + (X(q) - w / QH / 2).toFixed(1) + '" y="' + Y(d.grid[q] - d.bkw[q]).toFixed(1) + '" width="' + (w / QH).toFixed(1) + '" height="' + (Y(d.grid[q]) - Y(d.grid[q] - d.bkw[q])).toFixed(1) + '" fill="' + C.battFill + '" opacity=".35"/>';
        var pth = ''; for (q = 0; q <= n; q++) pth += (q ? 'L' : 'M') + X(q).toFixed(1) + ',' + Y(d.grid[q]).toFixed(1) + ' ';
        c += '<path d="' + pth + '" fill="none" stroke="' + C.gridLine + '" stroke-width="1.8" stroke-linejoin="round"/>';
        c += '<line x1="0" x2="' + w + '" y1="' + Y(Z).toFixed(1) + '" y2="' + Y(Z).toFixed(1) + '" stroke="' + C.plan + '" stroke-dasharray="5 3" stroke-width="1.2"/>';
        c += '</svg><div class="axis" aria-hidden="true"><span>0</span><span>6</span><span>12</span><span>18</span><span>24 Uhr</span></div></div>';
        return s + '<div class="minis"><div class="mini"><span class="n">Monatsspitze bisher</span><span class="v">' + kw(v.monat.spitze) + ' · ' + v.monat.am + '</span></div>' +
          '<div class="mini"><span class="n">Ohne Speicher wären es heute</span><span class="v">' + kw(baseMax) + '</span></div>' +
          '<div class="mini"><span class="n">Ohne Speicher im Monat</span><span class="v">' + kw(v.monat.ohne) + '</span></div></div>' + c +
          '<div class="legend"><span><i class="ln" style="background:var(--grid-line)"></i>Netzbezug heute</span><span><i style="background:var(--batt-fill);opacity:.5"></i>vom Speicher gekappt</span><span><i class="ln" style="background:var(--plan)"></i>Ziel</span></div>';
      }
    },
    reserve: {
      name: 'Lastspitzen-\u200bReserve', icon: 'battery', hue: 'var(--batt)', soft: 'var(--batt-soft)', target: 'Steuerung', sizes: ['w1'],
      purpose: 'Ob der Speicher für die nächste Spitze bereit ist: Ladestand gegen die eingestellte Reserve.',
      avail: function (v) { return v.batt.reserve ? { ok: true } : { ok: false, need: 'Braucht einen hinterlegten Leistungspreis (Lastspitzenkappung).' }; },
      body: function (v) {
        var d = v.day, n = v.nowQ, soc = d.soc[n], ok = soc > v.batt.reserve + 5, b = d.bkw[n];
        return '<div class="row2">' + battSvg(soc, v.batt.reserve, 38, 60, b > DB) + '<div><div class="vbig">' + NF0.format(soc) + '<span class="u">%</span></div><div class="vsub">Reserve ' + v.batt.reserve + ' %</div></div></div>' +
          '<div class="vstate">' + (b < -DB ? 'gibt ' + kw(-b) + ' ab' : b > DB ? 'lädt ' + kw(b) + ' nach' : 'wartet') + '</div>' +
          '<span class="prov ' + (ok ? 'ok' : 'warn') + '">' + (ok ? 'bereit für die nächste Spitze' : 'unter der Reserve') + '</span>';
      }
    },
    laden: {
      name: 'Laden', icon: 'car', hue: 'var(--load)', soft: 'var(--load-soft)', target: 'Ladevorgänge', sizes: ['w1', 'w2'],
      purpose: 'Was an Ihren Ladepunkten passiert, mit Steuerart und Energie heute.',
      avail: function (v) { return v.cons.some(function (c) { return c.id === 'wb'; }) ? { ok: true } : { ok: false, need: 'Braucht einen Ladepunkt.' }; },
      body: function (v, size) {
        var d = v.day, n = v.nowQ, j = v.cons.map(function (c) { return c.id; }).indexOf('wb'), p = d.cons[n][j], t = todayUntilNow(v);
        var since = null; for (var q = n; q >= 0 && d.cons[q][j] > DB; q--) since = q;
        var st = p > DB ? 'lädt' + (since != null ? ' seit ' + hhmm(since) : '') : 'Eingesteckt · lädt gerade nicht';
        return '<div class="row2"><span class="t-ico" style="--hue:var(--load);--soft:var(--load-soft);width:40px;height:40px;border-radius:12px">' + ic('car', 22) + '</span><div><div class="vbig">' + NF1.format(p) + '<span class="u">kW</span></div><div class="vstate">Wallbox Garage ' + st + '</div></div></div>' +
          (size === 'w2' ? miniBars([{ n: 'Ladeleistung', v: kw(p) + ' von 11 kW', x: p }], 11) : '') +
          '<div class="vrow"><span class="prov">Steuerart: Solar-Überschuss</span><span class="vsub">heute ' + kwh(t.cons[j]) + '</span></div>';
      }
    },
    waermepumpe: {
      name: 'Wärme\u00adpumpe', icon: 'heatpump', hue: 'var(--load)', soft: 'var(--load-soft)', target: 'Steuerung › Verbraucher', sizes: ['w1'],
      purpose: 'Ob VoltPilot gerade die Anlaufempfehlung (SG-Ready) gibt, und die Leistung, wenn sie gemessen wird.',
      avail: function (v) { return v.cons.some(function (c) { return c.id === 'wp'; }) ? { ok: true } : { ok: false, need: 'Braucht eine angelegte Wärmepumpe.' }; },
      body: function (v) {
        var d = v.day, n = v.nowQ, j = v.cons.map(function (c) { return c.id; }).indexOf('wp'), p = d.cons[n][j], t = todayUntilNow(v);
        return '<div><div class="vbig">' + NF1.format(p) + '<span class="u">kW</span></div><div class="vstate">' + (p > 0.3 ? 'läuft' : 'aus') + '</div></div>' +
          '<span class="prov ok">Anlaufempfehlung aktiv</span><div class="vsub">SG-Ready · seit 11:30 · heute ' + kwh(t.cons[j]) + '</div>';
      }
    },
    fahrplan: {
      name: 'Fahrplan', icon: 'clock', hue: 'var(--plan)', soft: 'var(--c-muted)', target: 'Fahrplan', sizes: ['w2'],
      purpose: 'Die Tagesuhr: was der Speicher laut Plan in jeder Viertelstunde tut.',
      avail: function () { return { ok: true }; },
      body: function (v) {
        var d = v.day, n = v.nowQ, R = 40, cx = 50, cy = 50, s = '<svg class="ill" viewBox="-12 -12 124 124" style="width:112px;height:112px" aria-hidden="true">';
        var used = {};
        for (var q = 0; q < QH; q++) {
          var a0 = (q / QH) * 2 * Math.PI - Math.PI / 2 + 0.012, a1 = ((q + 1) / QH) * 2 * Math.PI - Math.PI / 2 - 0.012;
          var r = d.role[q]; used[r] = (used[r] || 0) + 1;
          s += '<path d="M' + (cx + R * Math.cos(a0)).toFixed(2) + ',' + (cy + R * Math.sin(a0)).toFixed(2) + ' A' + R + ',' + R + ' 0 0 1 ' + (cx + R * Math.cos(a1)).toFixed(2) + ',' + (cy + R * Math.sin(a1)).toFixed(2) + '" fill="none" stroke="' + TAET_COL[r] + '" stroke-width="12" opacity="' + (q > n ? 1 : 0.55) + '"/>';
        }
        var an = ((n + 0.8) / QH) * 2 * Math.PI - Math.PI / 2;
        s += '<line x1="' + cx + '" y1="' + cy + '" x2="' + (cx + (R + 8) * Math.cos(an)).toFixed(1) + '" y2="' + (cy + (R + 8) * Math.sin(an)).toFixed(1) + '" stroke="' + C.fg + '" stroke-width="2.4" stroke-linecap="round"/><circle cx="50" cy="50" r="4" fill="' + C.fg + '"/>';
        [['0', 50, -4], ['6', 106, 53], ['12', 50, 110], ['18', -6, 53]].forEach(function (x) { s += '<text x="' + x[1] + '" y="' + x[2] + '" text-anchor="middle" style="font:600 8px var(--font);fill:var(--c-muted-fg)">' + x[0] + '</text>'; });
        s += '</svg>';
        var steps = nextSteps(v, 3).map(function (x) { return '<div class="mini"><span class="n">ab ' + hhmm(x.q) + '</span><span class="v">' + TAET[x.role] + '</span></div>'; }).join('');
        var leg = Object.keys(used).filter(function (r) { return used[r] > 1; }).map(function (r) { return '<span><i style="background:' + TAET_COL[r] + '"></i>' + TAET[r] + '</span>'; }).join('');
        return '<div class="row2">' + s + '<div class="minis"><div class="mini"><span class="n">jetzt</span><span class="v">' + TAET[d.role[n]] + '</span></div>' + steps + '</div></div><div class="legend">' + leg + '</div><div class="vrow"><span class="prov plan">Plan · alle 15 Minuten neu</span><span class="vsub">' + battTiming(v) + '</span></div>';
      }
    },
    netz: {
      name: 'Netz heute', icon: 'pole', hue: 'var(--grid)', soft: 'var(--grid-soft)', target: 'Verlauf › Energie', sizes: ['w1'],
      purpose: 'Bezug und Einspeisung seit Mitternacht in kWh.',
      avail: function () { return { ok: true }; },
      body: function (v) {
        var t = todayUntilNow(v), mx = Math.max(t.imp, t.exp, 0.1);
        return miniBars([{ n: 'Bezug', v: kwh(t.imp), x: t.imp, col: 'var(--grid)' }, { n: 'Einspeisung', v: kwh(t.exp), x: t.exp, col: 'var(--grid)', op: 0.5 }], mx) + '<div class="vsub">seit 0 Uhr, gemessen am Netzanschluss</div>';
      }
    },
    wetter: {
      name: 'Wetter', icon: 'cloud', hue: 'var(--text-gray)', soft: 'var(--c-muted)', target: 'Fahrplan › Wetter', sizes: ['w1'],
      purpose: 'Temperatur und Bewölkung am Standort Ihrer Anlage.',
      avail: function () { return { ok: true }; },
      body: function (v) {
        var d = v.day, n = v.nowQ;
        return '<div class="vbig">' + v.temp + '<span class="u">°C</span></div><div class="vstate">Bewölkung ' + pct(d.cloudPct[n]) + '</div><div class="vsub">Vorhersage am Standort Ihrer Anlage</div>';
      }
    },
    eigene: {
      name: 'Eigene Kachel', icon: 'plus', hue: 'var(--c-fg)', soft: 'var(--c-muted)', target: 'Eigene Auswertung', sizes: ['w1', 'w2'], template: true,
      purpose: 'Eine Zahl aus einem Messwert Ihrer Anlage, mit Einheit und Zeitbezug.',
      avail: function () { return { ok: true }; }
    }
  };
  var DEFAULTS = {
    privat: [['geld', 'w2'], ['autarkie', 'w1'], ['eigenverbrauch', 'w1'], ['speicher', 'w1'], ['waermepumpe', 'w1'], ['sonne', 'w2'], ['laden', 'w2'], ['fahrplan', 'w2']],
    markt: [['preis', 'w2'], ['sonne', 'w1'], ['speicher', 'w1'], ['handel', 'w2'], ['geld', 'w2'], ['netz', 'w1'], ['wetter', 'w1']],
    spitze: [['lastspitze', 'g2'], ['reserve', 'w1'], ['sonne', 'w1'], ['geld', 'w2'], ['netz', 'w1']]
  };
  var LEAD0 = { privat: 'geld', markt: 'preis', spitze: 'lastspitze' };
  var WHY = {
    privat: { netz: 'Ihre Anlage misst Bezug und Einspeisung am <b>Netzanschluss</b>.', wetter: 'Für Ihren Standort liegt eine <b>Wettervorhersage</b> vor.' },
    markt: { fahrplan: 'Ihr Speicher folgt heute <b>vier Handelsfenstern</b>.', eigenverbrauch: 'Ihre <b>PV-Anlage</b> speist auch ohne Handel ein.' },
    spitze: { fahrplan: 'Der Plan hält <b>Reserve für die nächste Spitze</b>.', speicher: 'Ihr <b>Batteriespeicher</b> liefert Ladestand und Leistung.', wetter: 'Für Ihren Standort liegt eine <b>Wettervorhersage</b> vor.' }
  };
  function layoutOf(k) {
    if (!state.layout[k]) state.layout[k] = DEFAULTS[k].map(function (x) { return { id: x[0], size: x[1], hidden: false }; });
    return state.layout[k];
  }
  function leadOf(k) { return state.lead[k] || LEAD0[k]; }

  function tileHTML(v, it, lead) {
    var t = TILES[it.id]; if (!t || !t.body) return '';
    var cls = it.size === 'w2' ? ' w2' : it.size === 'g2' ? ' g2' : '';
    return '<article class="tile' + cls + (lead ? ' lead' : '') + '" data-tile="' + it.id + '">' + head(t, lead) + t.body(v, it.size) + '</article>';
  }

  /* ================= Cockpit-Gerüst ================= */
  var WORDMARK = 'data:image/png;base64,/*WORDMARK*/';
  function cockpitHTML(v) {
    var warn = v.key === 'spitze';
    var nav = [['dashboard', 'Cockpit', 1], ['calendar', 'Fahrplan'], ['history', 'Verlauf'], ['zap', 'Steuerung'], ['layers', 'Anlage']];
    return '<div class="ck" data-v="' + v.key + '"><div class="ck-shell">' +
      '<aside class="ck-side"><div class="brand"><img src="' + WORDMARK + '" alt="VoltPilot" width="110" height="26"></div><nav class="nav" aria-label="Bereiche"><span>' + ic('building', 20) + 'Portfolio</span><hr>' +
      nav.map(function (n) { return '<span' + (n[2] ? ' class="on"' : '') + '>' + ic(n[0], 20) + n[1] + '</span>'; }).join('') + '</nav><div class="sp"></div><nav class="nav"><span>' + ic('help', 20) + 'Hilfe &amp; Kontakt</span></nav></aside>' +
      '<div class="ck-col" style="min-width:0;display:flex;flex-direction:column">' +
      '<header class="ck-top"><button type="button" class="site-btn" data-go="Anlagenwechsel"><i class="dot' + (warn ? ' warn' : '') + '"></i><span>' + v.site + '</span>' + ic('chevD', 18) + '</button>' +
      '<div class="crumbs">Portfolio ' + ic('chevR', 14) + ' <b>' + v.crumb + '</b> ' + ic('chevD', 16) + ' <span class="pill ' + (warn ? 'warn' : 'live') + '" style="margin-left:6px"><i class="d"></i>' + (warn ? 'Hinweis · Kühlung meldet sich nicht' : 'Alles in Ordnung') + '</span></div>' +
      '<div class="sp"></div><button type="button" class="ibtn ghost" data-go="Hilfe" aria-label="Hilfe">' + ic('help', 20) + '</button><div class="user"><span class="uname">Alex Beispiel<small>alex@example.test</small></span><span class="avatar">AB</span></div></header>' +
      '<main class="ck-main"><div class="ck-head"><h1>' + v.site + '</h1><span class="pill live"><i class="d"></i>Stand vor 8 Sek.</span><span class="pill">' + v.tag + '</span><div class="sp"></div><button type="button" class="ibtn" data-act="anpassen" aria-label="Cockpit anpassen">' + ic('sliders', 18) + '</button></div>' +
      '<section class="hero" aria-label="Energiefluss"><div class="hero-main">' +
      '<div class="mom"><span class="mom-time"></span><span class="pill mom-badge"></span><span class="pill plan mom-plan"></span><span class="sp"></span><div class="mode" role="group" aria-label="Anzeige"><button type="button" data-mode="jetzt" aria-pressed="true">Jetzt · kW</button><button type="button" data-mode="heute" aria-pressed="false">Heute · kWh</button></div></div>' +
      '<p class="satz" aria-live="polite"></p><div class="flow"></div><div class="det"></div>' +
      '<div class="scrub"><div class="strip" role="slider" tabindex="0" aria-label="Tageszeit" aria-valuemin="0" aria-valuemax="95"></div>' +
      '<div class="scrub-ctl"><button type="button" class="pbtn solid" data-act="play">' + ic('play', 16) + '<span>Tag abspielen</span></button><span class="sp"></span><button type="button" class="pbtn" data-act="live" hidden>' + ic('clock', 16) + 'Zurück zu Jetzt</button></div>' +
      '<p class="hint">Ziehen Sie über die Tagesleiste. Links von „Jetzt“ sehen Sie Messwerte, rechts den Plan.</p></div>' +
      '<details class="liste"><summary>' + ic('list', 16) + 'Zahlen als Liste</summary><div class="tbl-wrap"><table class="tbl"></table></div></details>' +
      '</div><div class="hero-side"></div><div class="hero-foot"></div></section>' +
      '<section class="tiles" aria-label="Kacheln"></section><div class="ck-foot' + (warn ? ' warn' : '') + '"></div>' +
      '<div class="anp-row"><button type="button" class="anp-btn" data-act="anpassen">' + ic('sliders', 18) + 'Cockpit anpassen</button></div></main>' +
      '<nav class="tabbar" aria-label="Bereiche">' + nav.map(function (n) { return '<span' + (n[2] ? ' class="on"' : '') + '>' + ic(n[0], 22) + n[1] + '</span>'; }).join('') + '</nav>' +
      '</div></div></div>';
  }

  function footHTML(v) {
    if (v.key === 'spitze') {
      var c = v.cons.filter(function (x) { return x.staleFromQ != null; })[0];
      return '<span class="wr">' + ic('alert', 18) + '</span><span><b>' + c.name + ' meldet sich gerade nicht.</b> Stand: ' + c.staleTime + ' Uhr. Den übrigen Verbrauch zeigt das Cockpit deshalb nicht aufgeteilt.</span><span class="sp"></span><button type="button" class="lnk" data-go="Anlage › Aufbau">Aufbau' + ic('chevR', 14) + '</button>';
    }
    return '<span class="ok">' + ic('check', 18) + '</span><span><b>Alles in Ordnung.</b> ' + v.devices + ' Geräte liefern Daten.</span><span class="sp"></span><button type="button" class="lnk" data-go="Zustand">Details' + ic('chevR', 14) + '</button>';
  }
  function steuerHTML(v) {
    var d = v.day, n = v.nowQ, b = d.bkw[n], s = v.steuer, soll = Math.abs(b), ist = soll + (s.wirkungDelta || 0);
    var auftrag = v.key === 'spitze' ? s.auftrag : s.auftrag + ' ' + kw(soll);
    return '<div class="stz"><span class="lbl">Steuerung</span><div class="stz-grid"><div><i>Auftrag</i><b>' + auftrag + '</b></div><div><i>Gerät</i><b class="ok">' + s.antwort + '</b></div><div><i>Wirkung</i><b>' + kw(ist) + ' gemessen</b></div></div></div>';
  }

  /* ================= Montage ================= */
  var cur = { flow: null, host: null, v: null, touched: false };
  function mount() {
    var v = V[state.v], desk = state.view === 'desktop';
    if (cur.flow) { cur.flow.destroy(); cur.flow = null; }
    var host = desk ? $('#desk') : $('#screen');
    ($('#desk').innerHTML = ''); ($('#screen').innerHTML = '');
    host.innerHTML = cockpitHTML(v);
    cur.host = host; cur.v = v;
    $('#stagewrap').hidden = desk; $('#deskwrap').hidden = !desk;
    $('.hero-foot', host).innerHTML = steuerHTML(v);
    $('.ck-foot', host).innerHTML = footHTML(v);
    renderTiles();
    renderAside(v);
    if (desk) fitDesk();
    var root = $('.hero', host);
    cur.flow = new Flow(root, v, {
      onMoment: function (m) { onMoment(m); },
      onNode: function (kind, i, m, btn) { openNode(kind, i, m, btn); },
      onPlay: function (on) { var b = $('[data-act="play"]', host); b.innerHTML = ic(on ? 'pause' : 'play', 16) + '<span>' + (on ? 'Anhalten' : 'Tag abspielen') + '</span>'; },
      onTouch: function () { cur.touched = true; }
    });
    wire(host);
    if (desk) requestAnimationFrame(fitDesk);
  }
  function wire(host) {
    host.addEventListener('click', function (e) {
      var a = e.target.closest('[data-act],[data-mode],[data-period],[data-go]');
      if (!a || !host.contains(a)) return;
      if (a.hasAttribute('data-mode')) {
        $$('[data-mode]', host).forEach(function (b) { b.setAttribute('aria-pressed', String(b === a)); });
        cur.flow.stop(); cur.flow.setMode(a.getAttribute('data-mode'));
        return;
      }
      if (a.hasAttribute('data-period')) { state.period[cur.v.key] = a.getAttribute('data-period'); renderTiles(); return; }
      if (a.hasAttribute('data-go')) { toast('Öffnet „' + a.getAttribute('data-go') + '“. Im Prototyp nicht ausgebaut.'); return; }
      var act = a.getAttribute('data-act');
      if (act === 'play') cur.flow.play();
      if (act === 'live') cur.flow.live();
      if (act === 'anpassen') openAnpassen(a);
    });
  }
  function onMoment(m) {
    var host = cur.host, v = cur.v;
    $('.mom-time', host).textContent = m.time;
    var badge = $('.mom-badge', host);
    badge.className = 'pill mom-badge ' + (m.heute ? 'gem' : m.fut ? 'plan' : m.live ? 'live' : 'gem');
    badge.innerHTML = m.heute ? 'Energie · gemessen' : m.fut ? 'Plan und Prognose' : m.live ? '<i class="d"></i>Live' : 'gemessen';
    var pl = $('.mom-plan', host);
    pl.hidden = m.heute; pl.textContent = 'Plan: ' + TAET[m.role];
    $('.satz', host).textContent = satzOf(v, m);
    var lv = $('[data-act="live"]', host); if (lv) lv.hidden = m.live && !m.heute || (m.heute && m.q === v.nowQ);
    renderSide(v, m);
    renderTable(v, m);
  }
  function renderSide(v, m) {
    var side = $('.hero-side', cur.host); if (!side || state.view !== 'desktop') return;
    var f = m.heute ? kwh : kw;
    var bst = m.heute ? 'geladen ' + kwh(m.chg) : m.chg > DB ? 'lädt ' + kw(m.chg) : m.dis > DB ? 'entlädt ' + kw(m.dis) : 'ruht';
    var gst = m.heute ? 'Bezug, Einsp. ' + kwh(m.exp) : m.imp > DB ? 'Bezug' : m.exp > DB ? 'Einspeisung' : 'ausgeglichen';
    var k = function (hue, soft, icn, val, lbl) { return '<div class="skpi" style="--hue:' + hue + ';--soft:' + soft + '"><span class="ico">' + ic(icn, 16) + '</span><div><b>' + val + '</b><span>' + lbl + '</span></div></div>'; };
    var lead = leadOf(v.key), it = layoutOf(v.key).filter(function (x) { return x.id === lead && !x.hidden; })[0];
    var t = it && TILES[it.id];
    if (!side.firstChild) side.innerHTML = '<p class="side-h"></p><div class="side-kpis"></div><div class="side-lead"></div>';
    side.children[0].textContent = m.heute ? 'Heute ' + m.time : (m.fut ? 'Plan ' : m.live ? 'Jetzt ' : 'Gemessen ') + m.time;
    side.children[1].innerHTML = k('var(--pv)', 'var(--pv-soft)', 'sun', f(m.pv), m.heute ? 'erzeugt' : 'Erzeugung') + k('var(--load)', 'var(--load-soft)', 'house', f(m.load), m.heute ? 'verbraucht' : 'Verbrauch') +
      k('var(--batt)', 'var(--batt-soft)', 'battery', pct(m.soc), bst) + k('var(--grid)', 'var(--grid-soft)', 'pole', m.heute ? kwh(m.imp) : kw(m.imp > DB ? m.imp : m.exp), gst);
    var leadHost = side.children[2];
    if (t && leadHost.getAttribute('data-for') !== it.id + '|' + (state.period[v.key] || '')) {
      leadHost.setAttribute('data-for', it.id + '|' + (state.period[v.key] || ''));
      leadHost.innerHTML = head(t, true) + t.body(v, it.size === 'g2' ? 'g2' : 'w2');
    }
    if (!t) leadHost.innerHTML = '';
  }
  function renderTiles() {
    var v = cur.v, host = cur.host, desk = state.view === 'desktop';
    var lay = layoutOf(v.key).filter(function (x) { return !x.hidden && TILES[x.id].avail(v).ok; });
    var lead = leadOf(v.key);
    var ordered = lay.slice();
    if (!desk) { var li = ordered.map(function (x) { return x.id; }).indexOf(lead); if (li > 0) ordered.unshift(ordered.splice(li, 1)[0]); }
    else ordered = ordered.filter(function (x) { return x.id !== lead; });
    $('.tiles', host).innerHTML = ordered.map(function (it) { return tileHTML(v, it, it.id === lead && !desk); }).join('');
    var side = $('.hero-side .side-lead', host); if (side) side.removeAttribute('data-for');
    if (cur.flow && cur.flow.m) renderSide(v, cur.flow.m);
    if (desk) requestAnimationFrame(fitDesk);
  }
  function renderTable(v, m) {
    var tb = $('.tbl', cur.host); if (!tb) return;
    var t = todayUntilNow(v), f = m.heute ? kwh : kw;
    var rows = [['Erzeugung', m.pv, t.pv]];
    m.src.forEach(function (s, i) { rows.push(['  ' + s.name, s.kw, m.fut ? null : t.src[i]]); });
    rows.push(['Verbrauch', m.load, t.load]);
    m.con.forEach(function (c, j) { var jj = v.cons.map(function (x) { return x.id; }).indexOf(c.id); rows.push(['  ' + (c.full || c.name) + (c.merged ? ' (nicht aufgeteilt)' : c.rest ? ' (berechnet)' : ''), c.kw, jj >= 0 && !m.fut ? t.cons[jj] : null]); });
    rows.push(['Speicher laden', m.chg, t.chg], ['Speicher abgeben', m.dis, t.dis], ['Netzbezug', m.imp, t.imp], ['Einspeisung', m.exp, t.exp]);
    tb.innerHTML = '<caption class="sr">Werte für ' + m.time + '</caption><thead><tr><th scope="col"></th><th scope="col">' + (m.heute ? 'Heute ' + m.time : m.time + (m.fut ? ' (Plan)' : '')) + '</th><th scope="col">Heute bis ' + v.nowTime + '</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr><td>' + r[0].trim() + '</td><td>' + (r[1] == null ? '—' : f(r[1])) + '</td><td>' + (r[2] == null ? '—' : kwh(r[2])) + '</td></tr>'; }).join('') + '</tbody>';
  }

  /* ================= Blätter (Telefon) und Dialoge (Rechner) ================= */
  var ov = null, lastTrigger = null;
  function overlayHost() {
    if (state.view === 'phone' && window.innerWidth >= 760) return { el: $('#phone'), modal: false };
    return { el: document.body, modal: state.view === 'desktop' };
  }
  function openSheet(title, bodyHTML, footHTML, trigger, extraCls) {
    closeSheet(true);
    lastTrigger = trigger || document.activeElement;
    var h = overlayHost();
    ov = document.createElement('div');
    ov.className = 'ov' + (h.modal ? ' modal' : '') + (extraCls ? ' ' + extraCls : '');
    ov.innerHTML = '<div class="scrim"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t"><div class="grip" aria-hidden="true"></div><div class="sh-head"><h2 id="sh-t">' + title + '</h2><button type="button" class="ibtn ghost" data-close aria-label="Schließen">' + ic('x', 20) + '</button></div>' + bodyHTML + (footHTML || '') + '</div>';
    h.el.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target.classList.contains('scrim') || e.target.closest('[data-close]')) closeSheet(); });
    ov.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
      if (e.key === 'Tab') {
        var f = $$('button:not([disabled]),[href],[tabindex]:not([tabindex="-1"]),summary', ov).filter(function (x) { return x.offsetParent !== null; });
        if (!f.length) return;
        var a = f[0], z = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    });
    requestAnimationFrame(function () { requestAnimationFrame(function () { if (ov) { ov.classList.add('open'); var c = $('[data-close]', ov); c && c.focus({ preventScroll: true }); } }); });
    return ov;
  }
  function closeSheet(instant) {
    if (!ov) return;
    var o = ov; ov = null;
    o.classList.remove('open');
    setTimeout(function () { o.remove(); }, instant ? 0 : 320);
    if (!instant && lastTrigger && document.contains(lastTrigger)) lastTrigger.focus({ preventScroll: true });
  }
  function mixBar(list, tot) {
    return '<div class="mix">' + list.filter(function (x) { return x[1] > 1e-3; }).map(function (x) { return '<i style="flex:' + x[1].toFixed(3) + ';background:' + SRC_COL[x[0]] + '"></i>'; }).join('') + '</div>' +
      '<div class="legend">' + list.map(function (x) { return '<span><i style="background:' + SRC_COL[x[0]] + '"></i>' + { pv: 'Sonne', batt: 'Speicher', grid: 'Netz' }[x[0]] + ' ' + pct(tot ? 100 * x[1] / tot : 0) + '</span>'; }).join('') + '</div>';
  }
  function openNode(kind, i, m, btn) {
    var v = cur.v, t = todayUntilNow(v), f = m.heute ? kwh : kw, when = m.heute ? m.time : (m.fut ? 'Plan ' : m.live ? 'jetzt ' : 'gemessen ') + m.time;
    var kpi = function (l, val) { return '<div class="sh-kpi"><div class="l">' + l + '</div><div class="v">' + val + '</div></div>'; };
    var row = function (hue, icn, nm, sub, r1, r2, cls) { return '<div class="sh-row ' + (cls || '') + '"><span class="ico" style="--hue:' + hue + '">' + ic(icn, 15) + '</span><span class="nm">' + nm + (sub ? '<small>' + sub + '</small>' : '') + '</span><span class="nr">' + r1 + (r2 ? '<small>' + r2 + '</small>' : '') + '</span></div>'; };
    var body = '';
    if (kind === 'pv' || kind === 'src') {
      body = '<div class="sh-kpis">' + kpi('Erzeugung ' + when, f(m.pv)) + kpi('Heute bis ' + v.nowTime, kwh(t.pv)) + '</div><div class="sh-rows">' +
        (m.fut ? row('var(--pv)', 'panel', 'PV-Prognose', 'Die Prognose gilt für die ganze Anlage, nicht je Fläche.', f(m.pv), '') :
          v.pv.map(function (s, k) { var z = m.src[k] && m.src[k].zero; return row('var(--pv)', 'panel', s.name, z ? 'liefert gerade keine Erzeugung' : pct(m.pv ? 100 * m.pvSrc[k] / m.pv : 0) + ' der Erzeugung', f(m.pvSrc[k]), 'heute ' + kwh(t.src[k])); }).join('')) +
        '</div><p class="note">Die Summe oben ist die Summe der Flächen. Eine gemessene 0 neben erzeugenden Flächen heißt „liefert gerade keine Erzeugung“, fehlende Werte stehen als „—“ mit Grund.</p>';
      openSheet('Erzeugung', '<div class="sh-body">' + body + '</div>', '', btn);
      return;
    }
    if (kind === 'load' || kind === 'con' || kind === 'more') {
      var P = m.pairs, lm = loadMix(P), tot = m.load, groups = {}, gsum = {};
      m.con.forEach(function (c) {
        var g = c.merged ? 'Nicht aufgeteilt' : c.ghost ? 'Prognose' : (c.gruppe || 'Sonstiges');
        (groups[g] = groups[g] || []).push(c); gsum[g] = (gsum[g] || 0) + c.kw;
      });
      var gl = Object.keys(groups).sort(function (a, b) { return gsum[b] - gsum[a]; });
      var cRow = function (c) {
        var jj = v.cons.map(function (x) { return x.id; }).indexOf(c.id);
        if (c.merged) return row('var(--text-gray)', 'plug', c.full, c.stale.name + ' meldet sich nicht (Stand: ' + c.stale.staleTime + ' Uhr, zuletzt ' + kw(c.lastKw) + '). Deshalb lässt sich der Rest nicht aufteilen.', f(c.kw), 'zusammen', 'stale');
        if (c.ghost) return row('var(--load)', 'house', 'Verbrauchsprognose', 'Für den Plan gibt es keine Aufteilung je Gerät.', f(c.kw), '');
        return row('var(--load)', c.icon, c.full || c.name, c.rest ? 'berechnet: Hausverbrauch minus gemessene Geräte' : (m.heute ? '' : c.kw > DB ? 'läuft' : 'aus'), f(c.kw), !m.heute && jj >= 0 && !m.fut ? 'heute ' + kwh(t.cons[jj]) : '');
      };
      body = '<div class="sh-kpis">' + kpi('Verbrauch ' + when, f(m.load)) + kpi('Geräte', m.fut ? '—' : String(v.cons.length)) + '</div>' +
        '<p style="margin:0;font-weight:700">Herkunft ' + (m.heute ? 'heute' : when) + '</p>' + mixBar(lm, tot) + '<div style="height:6px"></div>' +
        gl.map(function (g) {
          var items = groups[g].slice().sort(function (a, b) { return b.kw - a.kw; });
          return '<p class="sh-grp"><span>' + g + '</span><b>' + f(gsum[g]) + '</b></p><div class="sh-rows">' + items.map(cRow).join('') + '</div>';
        }).join('') +
        '<p class="note">Sortiert nach ' + (m.heute ? 'Energie heute' : 'Leistung') + ', gruppiert nach Art. So bleibt die Liste auch mit sehr vielen Geräten übersichtlich. Die Herkunft ist eine bilanzielle Zuordnung: Sonnenstrom zählt zuerst für den Verbrauch, dann für den Speicher, dann für das Netz.</p>';
      openSheet('Verbrauch', '<div class="sh-body">' + body + '</div>', '', btn);
      return;
    }
    if (kind === 'batt') {
      var nx = nextSteps(v, 2);
      body = '<div class="sh-kpis">' + kpi('Ladestand ' + (m.heute ? 'jetzt' : when), pct(m.soc)) + kpi(m.heute ? 'Heute geladen' : 'Leistung', m.heute ? kwh(m.chg) : (m.chg > DB ? 'lädt ' + kw(m.chg) : m.dis > DB ? 'entlädt ' + kw(m.dis) : 'ruht')) + '</div><div class="sh-rows">' +
        row('var(--batt)', 'battery', 'Heute geladen', 'aus Sonne und Netz', kwh(t.chg), '') + row('var(--batt)', 'battery', 'Heute abgegeben', '', kwh(t.dis), '') +
        row('var(--plan)', 'clock', 'Plan jetzt', 'Tätigkeit laut Fahrplan', TAET[v.day.role[v.nowQ]], '') +
        nx.map(function (x) { return row('var(--plan)', 'clock', 'Plan ab ' + hhmm(x.q), '', TAET[x.role], ''); }).join('') +
        row('var(--batt)', 'battery', 'Größe', v.batt.reserve ? 'Lastspitzen-Reserve ' + v.batt.reserve + ' %' : '', kwh(v.batt.kwh), kw(v.batt.maxKw) + ' max.') + '</div>' +
        '<p class="note">Die Tätigkeit ist eine Aussage des Plans über eine Phase, keine Messung. Gemessen wird Ladestand und Leistung.</p>';
      openSheet(v.batt.name, '<div class="sh-body">' + body + '</div>', '', btn);
      return;
    }
    if (kind === 'grid') {
      body = '<div class="sh-kpis">' + kpi(m.heute ? 'Heute Bezug' : (m.imp > DB ? 'Bezug ' : 'Einspeisung ') + when, m.heute ? kwh(m.imp) : kw(m.imp > DB ? m.imp : m.exp)) + kpi(m.heute ? 'Heute Einspeisung' : 'Heute bis ' + v.nowTime, m.heute ? kwh(m.exp) : 'Bezug ' + kwh(t.imp)) + '</div><div class="sh-rows">' +
        row('var(--grid)', 'pole', 'Einspeisung heute', 'verlässt den Netzanschluss', kwh(t.exp), '') +
        (m.price != null ? row('var(--price)', 'euro', 'Börsenpreis', m.heute ? 'jetzt' : when, ct(m.price), '') : '') +
        (v.ziel ? row('var(--plan)', 'gauge', 'Ziel Netzbezug', 'Lastspitzenkappung', kw(v.ziel), 'Monatsspitze ' + kw(v.monat.spitze)) : '') + '</div>' +
        '<p class="note">Verkauft oder eingespeist ist, was den Netzanschluss verlässt, nicht was den Speicher verlässt.</p>';
      openSheet('Netz', '<div class="sh-body">' + body + '</div>', '', btn);
    }
  }

  /* ---------- Anpassen ---------- */
  function openAnpassen(trigger) {
    var v = cur.v, tab = 'ordnen';
    function catalogHTML() {
      var lay = layoutOf(v.key), have = {}; lay.forEach(function (x) { have[x.id] = 1; });
      var sug = [], more = [], no = [];
      Object.keys(TILES).forEach(function (id) {
        var t = TILES[id], a = t.avail(v);
        if (have[id]) return;
        if (!a.ok) no.push(id); else if (WHY[v.key][id]) sug.push(id); else more.push(id);
      });
      var card = function (id, why, dis) {
        var t = TILES[id];
        return '<div class="card-add' + (dis ? ' no' : '') + '"><span class="t-ico" style="--hue:' + t.hue + ';--soft:' + t.soft + ';width:40px;height:40px;border-radius:12px">' + ic(t.icon, 20) + '</span><span><b>' + t.name + '</b><span class="why">' + (why || t.purpose) + '</span></span>' +
          (dis ? '' : '<button type="button" class="btn' + (why ? ' pri' : '') + '" data-add="' + id + '">' + ic('plus', 16) + 'Hinzufügen</button>') + '</div>';
      };
      return '<p class="cat-h">Vorgeschlagen für Ihre Anlage</p>' + (sug.length ? sug.map(function (id) { return card(id, WHY[v.key][id]); }).join('') : '<p class="anp-hint">Alle passenden Kacheln sind schon auf Ihrem Cockpit.</p>') +
        '<p class="cat-h">Weitere Kacheln</p>' + more.map(function (id) { return card(id); }).join('') +
        (no.length ? '<p class="cat-h">Noch nicht möglich auf dieser Anlage</p>' + no.map(function (id) { return card(id, TILES[id].avail(v).need, true); }).join('') : '');
    }
    function ordnenHTML() {
      var lay = layoutOf(v.key), lead = leadOf(v.key), vis = lay.filter(function (x) { return TILES[x.id].avail(v).ok; });
      var rows = '<div class="arow"><span class="t-ico" style="--hue:var(--pv);--soft:var(--pv-soft)">' + ic('sun', 16) + '</span><span class="nm">Energiefluss<small>fest oben, mit Tagesleiste</small></span><span class="ctl"></span></div>';
      rows += vis.map(function (it, k) {
        var t = TILES[it.id], sizes = t.sizes;
        var sz = sizes.length > 1 ? '<span class="sz" role="group" aria-label="Größe von ' + t.name + '">' + sizes.map(function (s) { return '<button type="button" data-size="' + it.id + '|' + s + '" aria-pressed="' + (it.size === s) + '">' + (s === 'w1' ? 'klein' : s === 'w2' ? 'breit' : 'groß') + '</button>'; }).join('') + '</span>' : '';
        return '<div class="arow' + (it.hidden ? ' off' : '') + '"><span class="t-ico" style="--hue:' + t.hue + ';--soft:' + t.soft + '">' + ic(t.icon, 16) + '</span><span class="nm">' + t.name + '<small>' + (it.hidden ? 'ausgeblendet' : it.id === lead ? 'Leitkachel' : { w1: 'klein', w2: 'breit', g2: 'groß' }[it.size]) + '</small></span><span class="ctl">' + sz +
          '<button type="button" class="sbtn" data-mv="' + it.id + '|-1" aria-label="' + t.name + ' nach oben"' + (k === 0 ? ' disabled' : '') + '>' + ic('chevU', 16) + '</button>' +
          '<button type="button" class="sbtn" data-mv="' + it.id + '|1" aria-label="' + t.name + ' nach unten"' + (k === vis.length - 1 ? ' disabled' : '') + '>' + ic('chevD', 16) + '</button>' +
          '<button type="button" class="sbtn" data-hide="' + it.id + '" aria-pressed="' + (!it.hidden) + '" aria-label="' + t.name + (it.hidden ? ' einblenden' : ' ausblenden') + '">' + ic(it.hidden ? 'eyeOff' : 'eye', 16) + '</button>' +
          (t.leadable ? '<button type="button" class="sbtn" data-lead="' + it.id + '" aria-pressed="' + (it.id === lead) + '" aria-label="' + t.name + ' als Leitkachel">' + icStar(16, it.id === lead) + '</button>' : '') + '</span></div>';
      }).join('');
      rows += '<div class="arow"><span class="t-ico" style="--hue:var(--ok-ink);--soft:var(--batt-soft)">' + ic('check', 16) + '</span><span class="nm">Zustand<small>immer sichtbar, leise, wenn alles läuft</small></span><span class="ctl"></span></div>';
      return '<p class="anp-hint">Ordnen Sie die Kacheln mit ▲ ▼, blenden Sie mit dem Auge aus und heben Sie eine mit dem Stern hervor. Die Leitkachel steht am Telefon zuerst und am Rechner neben dem Fluss.</p>' + rows;
    }
    function render() {
      var sug = Object.keys(TILES).filter(function (id) { return !layoutOf(v.key).some(function (x) { return x.id === id; }) && TILES[id].avail(v).ok && WHY[v.key][id]; }).length;
      var body = '<div class="anp-tabs" role="tablist"><button type="button" role="tab" data-tab="ordnen" aria-selected="' + (tab === 'ordnen') + '">Anordnen</button><button type="button" role="tab" data-tab="katalog" aria-selected="' + (tab === 'katalog') + '">Kacheln hinzufügen' + (sug ? ' (' + sug + ' Vorschläge)' : '') + '</button></div>' +
        '<div class="sh-body" role="tabpanel">' + (tab === 'ordnen' ? ordnenHTML() : catalogHTML()) + '</div>';
      var foot = '<div class="sh-foot"><button type="button" class="btn" data-reset>Zurücksetzen</button><span class="sp"></span><button type="button" class="btn pri" data-close>Fertig</button><small>„Zurücksetzen“: Danach gilt wieder der VoltPilot-Standard für Ihr Profil.</small></div>';
      return { body: body, foot: foot };
    }
    var r = render();
    var o = openSheet('Cockpit anpassen', r.body, r.foot, trigger);
    function rerender(focusSel) {
      var r2 = render(), sh = $('.sheet', o);
      $$('.anp-tabs, .sh-body, .sh-foot', sh).forEach(function (n) { n.remove(); });
      sh.insertAdjacentHTML('beforeend', r2.body + r2.foot);
      renderTiles();
      if (focusSel) { var f = $(focusSel, sh); if (f && !f.disabled) f.focus({ preventScroll: false }); else { var t = $('[data-tab][aria-selected="true"]', sh); t && t.focus(); } }
    }
    o.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || !o.contains(b)) return;
      var lay = layoutOf(v.key);
      var find = function (id) { return lay.map(function (x) { return x.id; }).indexOf(id); };
      if (b.hasAttribute('data-tab')) { tab = b.getAttribute('data-tab'); rerender('[data-tab="' + tab + '"]'); }
      else if (b.hasAttribute('data-mv')) {
        var p = b.getAttribute('data-mv').split('|'), vis = lay.filter(function (x) { return TILES[x.id].avail(v).ok; }), k = vis.map(function (x) { return x.id; }).indexOf(p[0]), other = vis[k + (+p[1])];
        if (other) { var a1 = find(p[0]), a2 = find(other.id), tmp = lay[a1]; lay[a1] = lay[a2]; lay[a2] = tmp; }
        rerender('[data-mv="' + b.getAttribute('data-mv') + '"]');
      }
      else if (b.hasAttribute('data-hide')) { var it = lay[find(b.getAttribute('data-hide'))]; it.hidden = !it.hidden; rerender('[data-hide="' + it.id + '"]'); }
      else if (b.hasAttribute('data-lead')) { var id = b.getAttribute('data-lead'); state.lead[v.key] = leadOf(v.key) === id ? (LEAD0[v.key] === id ? id : LEAD0[v.key]) : id; rerender('[data-lead="' + id + '"]'); }
      else if (b.hasAttribute('data-size')) { var ps = b.getAttribute('data-size').split('|'); lay[find(ps[0])].size = ps[1]; rerender('[data-size="' + ps[0] + '|' + ps[1] + '"]'); }
      else if (b.hasAttribute('data-add')) { var add = b.getAttribute('data-add'), T = TILES[add]; if (T.template) { toast('Öffnet den Dialog „Eigene Auswertung“. Im Prototyp nicht ausgebaut.'); return; } lay.push({ id: add, size: T.sizes[T.sizes.length - 1] === 'g2' ? 'g2' : T.sizes[0] === 'w1' && T.sizes.length === 1 ? 'w1' : T.sizes[T.sizes.length - 1], hidden: false }); toast('„' + T.name + '“ steht jetzt am Ende Ihres Cockpits.'); rerender('[data-tab="katalog"]'); }
      else if (b.hasAttribute('data-reset')) { delete state.layout[v.key]; delete state.lead[v.key]; rerender('[data-reset]'); toast('Zurückgesetzt auf den VoltPilot-Standard für Ihr Profil.'); }
    });
  }

  /* ---------- Hinweise ---------- */
  var toastT;
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 2600); }

  var ASIDE = {
    privat: { h: 'Privathaus mit Eigenverbrauchs-Fahrplan', p: 'Sonnenhof: PV auf Dach und Carport, 15-kWh-Speicher, Wallbox, Wärmepumpe (SG-Ready), Heizstab und eine Waschmaschine am Zwischenstecker.', li: [
      '<b>Oben woher, unten wohin.</b> Die Sonne liefert alles, der Strom fließt in den Verbrauch und in den Speicher. Beide Balken sind gleich lang: Was ankommt, fließt ab.',
      '<b>Verbrauch im Detail</b> zeigt die größten Geräte zuerst, darunter „2 weitere“. So bleibt es bei beliebig vielen Geräten ruhig. Antippen öffnet die ganze Liste, nach Art gruppiert.',
      '<b>Ziehen Sie die Tagesleiste auf 07:00.</b> Dann kommt alles aus dem Netz. Rechts von „Jetzt“ sind die Balken schraffiert, denn das ist der Plan.',
      '<b>„Heute · kWh“</b> zeigt die Tagesbilanz. Speicher und Netz stehen dann oben und unten, weil sie heute in beide Richtungen geflossen sind.'] },
    markt: { h: 'Gewerbe mit Marktoptimierung', p: 'Gewerbehof Lindenau: Speicher mit 250 kW und 500 kWh, PV auf Werkhalle und Carport, Börsenpreise für heute und morgen.', li: [
      '<b>Das petrolfarbene Band vom Netz in den Speicher</b> zeigt: Der Speicher lädt gerade günstig aus dem Netz, dazu mit Sonnenstrom.',
      '<b>Ziehen Sie auf 19:00.</b> Dann fließt der Speicher ins Netz, der Plan sagt „Verkaufen“. Oben in der Tagesleiste steht der Börsenpreis.',
      'Unter der Bilanz folgen <b>Börsenpreis, Sonne und Speicher</b>, genau in dieser Reihenfolge.'] },
    spitze: { h: 'Werk mit Lastspitzenkappung', p: 'Werk Ahrenberg, Halle 1: neun Verbraucher, PV auf zwei Hallen, Speicher mit 200 kW, Ziel 300 kW Netzbezug.', li: [
      '<b>Neun Verbraucher, drei Zeilen.</b> Die Liste zeigt die größten, der Rest steht unter „weitere“. Das funktioniert genauso mit 50 Geräten.',
      '<b>Die Kühlung meldet sich seit 13:31 Uhr nicht.</b> Ihr Anteil steht mit dem Rest als „nicht aufgeteilt“. Das Cockpit erfindet keine Aufteilung.',
      '<b>Ziehen Sie auf 06:15.</b> Beim Anlauf der Frühschicht gibt der Speicher ab, und das Netz bleibt beim Ziel.'] }
  };
  function renderAside(v) {
    var a = ASIDE[v.key];
    $('#aside').innerHTML = '<h2>' + a.h + '</h2><p>' + a.p + '</p><ol>' + a.li.map(function (x) { return '<li><span>' + x + '</span></li>'; }).join('') + '</ol>' +
      '<p class="try"><b>Alles ist bedienbar:</b> Tagesleiste, „Tag abspielen“, „Heute · kWh“, jeder Knoten, jede Kachel und „Cockpit anpassen“.</p>';
  }

  /* ---------- Rechner-Fassung skalieren ---------- */
  function fitDesk() {
    var outer = $('#deskOuter'), desk = $('#desk'); if (!outer || $('#deskwrap').hidden) return;
    var avail = outer.clientWidth || outer.parentElement.clientWidth, s = Math.min(1, avail / 1280);
    desk.style.transform = 'scale(' + s + ')';
    outer.style.height = Math.ceil(desk.offsetHeight * s) + 'px';
    $('#deskNote').textContent = s < 1 ? 'Die Rechner-Fassung in 1280 px Breite, hier auf ' + Math.round(s * 100) + ' % verkleinert. Sie ist voll bedienbar.' : 'Die Rechner-Fassung in 1280 px Breite.';
  }
  var deskRO = new ResizeObserver(function () { fitDesk(); });
  deskRO.observe($('#desk')); deskRO.observe($('#deskwrap'));
  window.addEventListener('resize', function () { fitDesk(); });

  /* ---------- Schalter der Konzeptseite ---------- */
  $$('#seg-v button').forEach(function (b) {
    b.addEventListener('click', function () {
      state.v = b.getAttribute('data-v');
      $$('#seg-v button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      closeSheet(true); mount();
    });
  });
  $$('#seg-d button').forEach(function (b) {
    b.addEventListener('click', function () {
      state.view = b.getAttribute('data-d');
      $$('#seg-d button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      closeSheet(true); mount();
    });
  });
  RM.addEventListener && RM.addEventListener('change', function () { if (cur.flow) cur.flow.setQ(cur.flow.q); });
  mount();
})();
