/* ================= Reiter „Geräte“: Jetzt, Tagesbild, Reihenfolge ================= */

/* ---------- Zeitband: ein SVG für Tagesbild, Geräte-Verlauf, Regel-Probelauf und Ladeplan ---------- */
function zeitband(W, o) {
  const t0 = o.t0; const t1 = o.t1; const n = t1 - t0;
  const padL = o.padL != null ? o.padL : 28; const padR = 6;
  const bw = (W - padL - padR) / n;
  const x = (t) => padL + (t - t0) * bw;
  let y = o.padT != null ? o.padT : 14;
  let svg = '';
  const defs = '<defs><pattern id="hatch-' + o.id + '" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2.2" height="5" fill="#fff" fill-opacity=".55"/></pattern></defs>';
  const rowIcon = (name, yy, id, label, h, kurzname) => {
    const s = Math.min(15, h - 1);
    const ix = o.namen ? 2 : padL - s - 8;
    const txt = o.namen && kurzname ? '<text x="' + (ix + s + 7) + '" y="' + (yy + h / 2 + 4) + '" font-size="12" font-weight="600" fill="#334155">' + esc(kurzname) + '</text>' : '';
    return '<g class="row-hit" data-act="' + (id ? 'geraet' : '') + '" data-id="' + (id || '') + '"><title>' + esc(label) + '</title><rect x="0" y="' + (yy - 1) + '" width="' + (padL - 4) + '" height="' + (h + 2) + '" fill="transparent"/><svg x="' + ix + '" y="' + (yy + (h - s) / 2) + '" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + I[name] + '</svg>' + txt + '</g>';
  };
  const bandTop = y;
  for (const b of o.bands || []) {
    const h = b.h;
    if (b.art === 'pv') {
      const max = b.max || 8.5;
      let d = 'M' + x(t0) + ',' + (y + h);
      for (let t = t0; t < t1; t++) d += 'L' + (x(t) + bw / 2).toFixed(1) + ',' + (y + h - (SIM.pv(t) / max) * h).toFixed(1);
      d += 'L' + x(t1) + ',' + (y + h) + 'Z';
      svg += rowIcon('sun', y, null, 'Sonne (PV-Leistung, gemessen bis jetzt, danach Prognose)', h, 'Sonne');
      svg += '<path d="' + d + '" fill="var(--pv-soft)" stroke="var(--pv)" stroke-width="1.2"/>';
      if (b.frei) {
        for (let t = t0; t < t1; t++) {
          if (b.frei(t)) svg += '<rect x="' + x(t).toFixed(1) + '" y="' + (y + h - 3) + '" width="' + (bw + 0.3).toFixed(1) + '" height="3" fill="var(--pv)"/>';
        }
      }
    }
    if (b.art === 'preis') {
      const bekannt = (t) => t < 96 || morgenBekannt();
      const max = 24; const min = -2;
      const zero = y + h * (max / (max - min));
      svg += rowIcon('euro', y, null, 'Börsenpreis je Viertelstunde (ct/kWh)', h, 'Börsenpreis');
      if (t0 >= 96 && !morgenBekannt()) {
        svg += '<rect x="' + padL + '" y="' + y + '" width="' + (W - padL - padR) + '" height="' + h + '" rx="6" fill="#f1f5f9"/><text x="' + (padL + 8) + '" y="' + (y + h / 2 + 4) + '" font-size="11.5" font-weight="600" fill="#475569">Börsenpreise für morgen kommen gegen 13 Uhr</text>';
      } else {
        for (let t = t0; t < t1; t++) {
          if (!bekannt(t)) continue;
          const p = SIM.preis(t);
          const hh = Math.max(0.8, Math.abs(p) / (max - min) * h);
          const yy = p >= 0 ? zero - hh : zero;
          const on = b.hl ? b.hl(t) : null;
          const fill = on === null ? (p < 0 ? 'var(--neg)' : 'var(--price)') : on ? (p < 0 ? 'var(--neg)' : 'var(--price)') : 'var(--price-off)';
          svg += '<rect x="' + (x(t) + 0.3).toFixed(1) + '" y="' + yy.toFixed(1) + '" width="' + Math.max(0.6, bw - 0.6).toFixed(1) + '" height="' + hh.toFixed(1) + '" fill="' + fill + '"' + (on === null && t < S.now ? ' fill-opacity=".55"' : '') + '/>';
        }
        svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + zero.toFixed(1) + '" y2="' + zero.toFixed(1) + '" stroke="#94a3b8" stroke-width=".8"/>';
        if (b.linie != null) {
          const ly = zero - (b.linie / (max - min)) * h;
          svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + ly.toFixed(1) + '" y2="' + ly.toFixed(1) + '" stroke="var(--c-fg)" stroke-width="1.2" stroke-dasharray="4 3"/><text x="' + (W - padR - 2) + '" y="' + (ly - 3).toFixed(1) + '" font-size="10.5" font-weight="700" text-anchor="end" fill="var(--c-fg)">' + NF1.format(b.linie) + ' ct</text>';
        }
      }
    }
    if (b.art === 'temp') {
      const lo = 0; const hi = 30;
      let d = '';
      for (let t = t0; t < t1; t++) d += (t === t0 ? 'M' : 'L') + (x(t) + bw / 2).toFixed(1) + ',' + (y + h - ((SIM.temp(t) - lo) / (hi - lo)) * h).toFixed(1);
      svg += rowIcon('thermo', y, null, 'Außentemperatur (Vorhersage)', h, 'Temperatur');
      if (b.hl) for (let t = t0; t < t1; t++) if (b.hl(t)) svg += '<rect x="' + x(t).toFixed(1) + '" y="' + y + '" width="' + (bw + 0.3).toFixed(1) + '" height="' + h + '" fill="var(--price-soft)"/>';
      svg += '<path d="' + d + '" fill="none" stroke="var(--pv)" stroke-width="1.6"/>';
      if (b.linie != null) {
        const ly = y + h - ((b.linie - lo) / (hi - lo)) * h;
        svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + ly.toFixed(1) + '" y2="' + ly.toFixed(1) + '" stroke="var(--c-fg)" stroke-width="1.2" stroke-dasharray="4 3"/><text x="' + (W - padR - 2) + '" y="' + (ly - 3).toFixed(1) + '" font-size="10.5" font-weight="700" text-anchor="end" fill="var(--c-fg)">' + NF0.format(b.linie) + ' °C</text>';
      }
    }
    if (b.art === 'soc' || b.art === 'hl') {
      svg += rowIcon(b.icon || 'battery', y, b.id || null, b.label || 'Ladestand des Speichers', h, b.art === 'soc' ? 'Speicher' : 'Bedingung');
      svg += '<rect x="' + padL + '" y="' + y + '" width="' + (W - padL - padR) + '" height="' + h + '" rx="4" fill="#eef2f6"/>';
      if (b.art === 'hl') {
        for (let t = t0; t < t1; t++) if (b.hl(t)) svg += '<rect x="' + x(t).toFixed(1) + '" y="' + y + '" width="' + (bw + 0.3).toFixed(1) + '" height="' + h + '" fill="var(--price)"/>';
      } else {
        let d = '';
        for (let t = t0; t < t1; t++) d += (t === t0 ? 'M' : 'L') + (x(t) + bw / 2).toFixed(1) + ',' + (y + h - 1 - (S.R.sp.soc[t] / 100) * (h - 2)).toFixed(1);
        svg += '<path d="' + d + '" fill="none" stroke="var(--batt)" stroke-width="1.6"/>';
      }
    }
    y += h + (b.gap != null ? b.gap : 6);
  }
  /* Gerätezeilen */
  const R = o.R || S.R;
  for (const row of o.rows || []) {
    const id = row.id; const h = row.h || 16;
    const g = S.cfg.geraete[id];
    svg += rowIcon(icon(id), y, o.klick === false ? null : id, name(id), h, kurz(id));
    svg += '<rect x="' + padL + '" y="' + y + '" width="' + (W - padL - padR) + '" height="' + h + '" rx="4" fill="#eef2f6"/>';
    const max = SIM.nenn(g) || 1;
    for (let t = t0; t < t1; t++) {
      const k = R.kw[id][t];
      if (!(k > 0)) continue;
      const xx = x(t); const ww = bw + 0.35;
      if (g.form === 'freigabe') {
        svg += '<rect x="' + xx.toFixed(1) + '" y="' + (y + 1.5) + '" width="' + ww.toFixed(1) + '" height="' + (h - 3) + '" fill="var(--load-soft)"/><rect x="' + xx.toFixed(1) + '" y="' + (y + 1.5) + '" width="' + ww.toFixed(1) + '" height="2" fill="var(--load)"/><rect x="' + xx.toFixed(1) + '" y="' + (y + h - 3.5) + '" width="' + ww.toFixed(1) + '" height="2" fill="var(--load)"/>';
        continue;
      }
      const s = R.src[id][t] || { pv: k, sp: 0, netz: 0 };
      const hh = Math.max(3, Math.min(1, k / max) * (h - 2));
      let yy = y + h - 1;
      for (const q of ['pv', 'sp', 'netz']) {
        if (!(s[q] > 0.01)) continue;
        const part = hh * (s[q] / k);
        yy -= part;
        svg += '<rect x="' + xx.toFixed(1) + '" y="' + yy.toFixed(1) + '" width="' + ww.toFixed(1) + '" height="' + part.toFixed(1) + '" fill="' + SRC_FARBE[q] + '"/>';
      }
      if (o.hlRow && o.hlRow(id, t)) svg += '<rect x="' + xx.toFixed(1) + '" y="' + (y - 2) + '" width="' + ww.toFixed(1) + '" height="2" fill="var(--load)"/>';
    }
    y += h + (row.gap != null ? row.gap : 5);
  }
  const bottom = y - 4;
  /* Vergangenheit ruhig, Zukunft schraffiert (laut Plan) */
  const nowX = S.now >= t0 && S.now <= t1 ? x(S.now) : (S.now < t0 ? padL : null);
  if (nowX != null) {
    svg += '<rect x="' + nowX.toFixed(1) + '" y="' + bandTop + '" width="' + (W - padR - nowX).toFixed(1) + '" height="' + (bottom - bandTop) + '" fill="url(#hatch-' + o.id + ')" pointer-events="none"/>';
  }
  if (S.now > t0 && S.now < t1) {
    svg += '<line x1="' + nowX.toFixed(1) + '" x2="' + nowX.toFixed(1) + '" y1="' + (bandTop - 6) + '" y2="' + (bottom + 2) + '" stroke="var(--navy)" stroke-width="1.6"/><text x="' + nowX.toFixed(1) + '" y="' + (bandTop - 8) + '" font-size="10.5" font-weight="800" text-anchor="middle" fill="var(--navy)">jetzt</text>';
  }
  /* Auswahl */
  if (o.sel != null && o.sel >= t0 && o.sel < t1) {
    const sx = x(o.sel) + bw / 2;
    svg += '<g id="' + o.id + '-sel"><line x1="' + sx.toFixed(1) + '" x2="' + sx.toFixed(1) + '" y1="' + (bandTop - 2) + '" y2="' + (bottom + 2) + '" stroke="var(--c-fg)" stroke-width="1.2" stroke-dasharray="2 2"/><circle cx="' + sx.toFixed(1) + '" cy="' + (bottom + 4) + '" r="3.5" fill="var(--c-fg)"/></g>';
  }
  /* Tagestrenner, wenn das Band über Mitternacht reicht */
  if (o.tage && t0 < 96 && t1 > 96) {
    const mx = x(96);
    svg += '<line x1="' + mx.toFixed(1) + '" x2="' + mx.toFixed(1) + '" y1="' + (bandTop - 12) + '" y2="' + (bottom + 2) + '" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 3"/>'
      + '<text x="' + (mx - 4).toFixed(1) + '" y="' + (bandTop - 4) + '" font-size="10.5" font-weight="700" text-anchor="end" fill="#475569">heute</text>'
      + '<text x="' + (mx + 4).toFixed(1) + '" y="' + (bandTop - 4) + '" font-size="10.5" font-weight="700" fill="#475569">morgen</text>';
  }
  /* Achse */
  const ticks = o.ticks || [0, 24, 48, 72, 96];
  let ax = '';
  for (const k of ticks) {
    const t = t0 + k; if (t > t1) continue;
    const xx = x(t);
    const lab = (k === n && t % 96 === 0) ? '24' : String(((t % 96) / 4) | 0);
    ax += '<text x="' + xx.toFixed(1) + '" y="' + (bottom + 16) + '" font-size="11" font-weight="600" fill="#475569" text-anchor="' + (k === 0 ? 'start' : k === n ? 'end' : 'middle') + '">' + lab + (k === n ? ' Uhr' : '') + '</text>';
  }
  const H = bottom + 22;
  return { svg: '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(o.label || 'Zeitband') + '">' + defs + svg + ax + '</svg>', x, bw, padL, t0, t1, H };
}

/* ---------- Jetzt: Wohin geht der Sonnenstrom? ---------- */
function momentT() { return S.sel != null ? S.sel : S.now; }
function laufendeIds(t) {
  const R = S.R;
  return Object.keys(S.cfg.geraete).filter((id) => R.kw[id][t] > 0);
}
function gemessen(id) { return id === 'sp' || S.cfg.geraete[id].gemessen; }

function satzMoment(t) {
  const R = S.R;
  const P = SIM.pv(t); const preis = SIM.preis(t);
  const laufen = laufendeIds(t).filter(gemessen);
  const namen = (ids) => ids.map(kurz).reduce((s, n, i, a) => s + (i === 0 ? '' : i === a.length - 1 ? ' und ' : ', ') + n, '');
  let kopf;
  if (P > 0.15) {
    const sonne = laufen.filter((id) => (R.src[id][t] || {}).pv > 0.05);
    kopf = 'Sonne <b class="pvw">' + fKw(P) + '</b>' + (sonne.length ? ': ' + namen(sonne) + (sonne.length > 1 ? ' laufen' : ' läuft') : '') + '.';
    if (R.sp.kw[t] > 0.05) kopf += ' Der Speicher lädt.';
    else if (R.sp.soc[t] >= 99.5) kopf += ' Der Speicher ist voll.';
    if (R.frei[t] > 0.1) kopf += ' ' + fKw(R.frei[t]) + ' gehen ins Netz.';
    if (R.abgeregelt[t] > 0.1) kopf += ' ' + fKw(R.abgeregelt[t]) + ' werden abgeregelt.';
  } else {
    const netz = Math.max(0, R.netz[t]); const sp = Math.max(0, -R.sp.kw[t]);
    kopf = 'Keine Sonne. ' + (laufen.length ? namen(laufen) + (laufen.length > 1 ? ' laufen. ' : ' läuft. ') : '')
      + (sp > 0.05 ? 'Der Speicher liefert ' + fKw(sp) + (netz > 0.05 ? ', das Netz ' + fKw(netz) + '.' : '.') : 'Aus dem Netz kommen ' + fKw(netz) + '.');
  }
  return kopf;
}
function zusatzMoment(t) {
  const R = S.R;
  const out = [];
  const bekannt = t < 96 || morgenBekannt();
  if (bekannt && SIM.preis(t) < 0) out.push(['down', 'Strom kostet an der Börse gerade unter null' + (R.abgeregelt[t] > 0.1 ? '; statt einzuspeisen wird abgeregelt.' : '.')]);
  for (const id of laufendeIds(t)) {
    const w = R.why[id][t];
    if (w && w.k === 'regel-an') out.push(['zap', 'Regel „' + esc(w.regel) + '“ schaltet ' + esc(kurz(id)) + '.']);
    if (w && w.k === 'eingriff-an') out.push(['power', 'Ihr Eingriff: ' + esc(kurz(id)) + ' an bis ' + uhrTag(w.bis) + '.']);
  }
  if (istPausiert(t)) out.push(['pause', 'Automatik pausiert.']);
  return out.length ? '<ul class="j-zusatz">' + out.map(([i, x]) => '<li>' + ic(i, 16) + '<span>' + x + '</span></li>').join('') + '</ul>' : '';
}
function leiste(t) {
  const R = S.R;
  const P = SIM.pv(t);
  const segs = [];
  let haus = Math.min(SIM.last(t), P);
  const ungemessen = [];
  const pflicht = []; const rang = [];
  for (const id of Object.keys(S.cfg.geraete)) {
    const s = R.src[id][t];
    if (!s || !(s.pv > 0.02)) continue;
    if (!gemessen(id)) { haus += s.pv; ungemessen.push(id); continue; }
    const k = (R.why[id][t] || {}).k;
    (['sonne', 'sonne-min'].includes(k) ? rang : pflicht).push([id, s.pv]);
  }
  rang.sort((a, b) => S.cfg.reihenfolge.indexOf(a[0]) - S.cfg.reihenfolge.indexOf(b[0]));
  segs.push({ art: 'haus', id: null, kw: haus, label: ungemessen.length ? 'Haus und ' + ungemessen.map(kurz).join(', ') : 'Haus', icon: 'house' });
  for (const [id, kw] of pflicht) segs.push({ art: 'dev', id, kw, label: kurz(id), icon: icon(id) });
  const spKw = R.sp.kw[t] > 0 ? R.sp.kw[t] : 0;
  const spPos = S.cfg.reihenfolge.indexOf('sp');
  const rangVor = rang.filter(([id]) => S.cfg.reihenfolge.indexOf(id) < spPos);
  const rangNach = rang.filter(([id]) => S.cfg.reihenfolge.indexOf(id) > spPos);
  for (const [id, kw] of rangVor) segs.push({ art: 'dev', id, kw, label: kurz(id), icon: icon(id) });
  if (spKw > 0.02) segs.push({ art: 'batt', id: 'sp', kw: spKw, label: 'Speicher', icon: 'battery' });
  for (const [id, kw] of rangNach) segs.push({ art: 'dev', id, kw, label: kurz(id), icon: icon(id) });
  if (R.frei[t] > 0.02) segs.push({ art: 'netz', id: null, kw: R.frei[t], label: 'Einspeisung', icon: 'pole' });
  if (R.abgeregelt[t] > 0.02) segs.push({ art: 'abgeregelt', id: null, kw: R.abgeregelt[t], label: 'abgeregelt', icon: 'down' });
  const sum = segs.reduce((s, x) => s + x.kw, 0) || 1;
  const bar = segs.map((s) => {
    const pct = (s.kw / Math.max(sum, P)) * 100;
    const inner = pct > 9 ? ic(s.icon, 17) : '';
    const attr = s.id ? ' data-act="geraet" data-id="' + s.id + '"' : '';
    return '<span class="l-seg ' + s.art + '" style="flex:0 0 ' + pct.toFixed(2) + '%" title="' + esc(s.label + ' ' + fKw(s.kw)) + '"' + attr + '>' + inner + '</span>';
  }).join('');
  const leg = segs.map((s) => '<span><i style="background:' + (s.art === 'haus' ? '#94a3b8' : s.art === 'batt' ? 'var(--batt-fill)' : s.art === 'netz' ? 'var(--grid)' : s.art === 'abgeregelt' ? '#cbd5e1' : 'var(--pv-fill)') + '"></i>' + esc(s.label) + ' <b>' + fKw(s.kw) + '</b></span>').join('');
  /* Wer wartet als Nächstes? */
  const wartet = S.cfg.reihenfolge.find((id) => id !== 'sp' && S.cfg.geraete[id] && SIM.sonnig(S.cfg, id) && (R.why[id][t] || {}).k === 'wartet-sonne');
  let wait = '';
  if (wartet) {
    const w = R.why[wartet][t];
    wait = '<button class="l-wait" data-act="geraet" data-id="' + wartet + '" style="width:100%;border:0;text-align:left;cursor:pointer">' + ic('clock', 17) + '<span><b>' + esc(name(wartet)) + '</b> wartet (Platz ' + w.platz + '): braucht ' + fKw(w.braucht) + ', frei sind ' + fKw(Math.max(0, w.frei)) + '.</span></button>';
  }
  return '<div class="ladder"><div class="l-top"><span>Wohin geht der Sonnenstrom?</span><b>' + fKw(P) + '</b></div><div class="l-bar" role="img" aria-label="Verteilung des Sonnenstroms">' + bar + '</div><div class="l-legend">' + leg + '</div>' + wait + '</div>';
}

function nachtblock(t) {
  const R = S.R;
  const sp = Math.max(0, -R.sp.kw[t]); const netz = Math.max(0, R.netz[t]);
  const sum = sp + netz || 1;
  const kommend = [];
  for (const id of Object.keys(S.cfg.geraete)) {
    const nx = naechstes(id, t);
    if (nx && nx.an && nx.t < t + 48) kommend.push([nx.t, id]);
  }
  kommend.sort((a, b) => a[0] - b[0]);
  const next = kommend[0];
  return '<div class="ladder"><div class="l-top"><span>Woher kommt der Strom?</span><b style="color:var(--c-fg)">' + fKw(sp + netz) + '</b></div><div class="l-bar" role="img" aria-label="Herkunft des Stroms">'
    + (sp > 0.02 ? '<span class="l-seg batt" style="flex:0 0 ' + (sp / sum * 100).toFixed(1) + '%" data-act="geraet" data-id="sp">' + (sp / sum > 0.12 ? ic('battery', 17) : '') + '</span>' : '')
    + (netz > 0.02 ? '<span class="l-seg netz" style="flex:0 0 ' + (netz / sum * 100).toFixed(1) + '%">' + (netz / sum > 0.12 ? ic('pole', 17) : '') + '</span>' : '')
    + '</div><div class="l-legend">' + (sp > 0.02 ? '<span><i style="background:var(--batt-fill)"></i>Speicher <b>' + fKw(sp) + '</b></span>' : '') + (netz > 0.02 ? '<span><i style="background:var(--grid)"></i>Netz <b>' + fKw(netz) + '</b></span>' : '') + '</div>'
    + (next ? '<div class="l-nacht">' + ic(icon(next[1]), 18) + '<span>Als Nächstes: <b style="color:var(--c-fg)">' + esc(name(next[1])) + '</b> ' + (next[0] <= S.now ? 'startet gleich' : 'um ' + uhrTag(next[0])) + ' · ' + esc(warum(next[1], next[0])) + '</span></div>' : '')
    + '</div>';
}

function jetztKarte() {
  const t = momentT();
  let eye;
  if (t === S.now) eye = 'Jetzt · ' + pad(Math.floor(S.nowMin / 60)) + ':' + pad(S.nowMin % 60);
  else if (t < S.now) eye = 'Gemessen · ' + uhrTag(t) + '–' + uhr(t + 1);
  else eye = 'Laut Plan · ' + uhrTag(t) + ' · ' + inZeit(t);
  const bekannt = t < 96 || morgenBekannt();
  const sub = [];
  if (bekannt) sub.push('Börsenpreis ' + fCt(SIM.preis(t)));
  sub.push(fGrad(SIM.temp(t)) + ' draußen');
  sub.push('Speicher ' + fPct(S.R.sp.soc[t]));
  return '<section class="card jetzt links" id="jetzt" aria-live="polite"><div class="j-eye"><p>' + eye + '</p>' + (S.sel != null ? '<button class="j-back" data-act="jetzt">' + ic('clock', 15) + 'Jetzt</button>' : '') + '</div>'
    + '<p class="j-say">' + satzMoment(t) + '</p>' + zusatzMoment(t) + '<p class="j-sub">' + sub.join(' · ') + '</p>'
    + (SIM.pv(t) > 0.15 ? leiste(t) : nachtblock(t)) + '</section>';
}

/* ---------- Tagesbild ---------- */
function reihenIds() {
  const ids = Object.keys(S.cfg.geraete);
  const rang = S.cfg.reihenfolge.filter((id) => id !== 'sp' && SIM.sonnig(S.cfg, id));
  return [...rang, ...ids.filter((id) => !rang.includes(id))];
}
function tagesbildKarte() {
  const heute = S.tag === 0;
  return '<section class="card plan links" aria-label="Tagesbild"><div class="card-h"><h2>' + ic('calendar', 18) + (heute ? 'Heute gesteuert' : 'Morgen geplant') + '</h2><div class="mini-seg" role="group" aria-label="Tag"><button data-act="tag" data-tag="0" aria-pressed="' + heute + '">Heute</button><button data-act="tag" data-tag="1" aria-pressed="' + !heute + '">Morgen</button></div></div>'
    + '<div class="tl" id="tl-host" data-chart="tag" tabindex="0" role="slider" aria-label="Viertelstunde wählen" aria-valuemin="0" aria-valuemax="95" aria-valuenow="' + (momentT() % 96) + '" aria-valuetext="' + uhrTag(momentT()) + '"></div>'
    + '<div class="tl-leg"><span><i style="background:var(--pv-fill)"></i>Sonne</span><span><i style="background:var(--batt-fill)"></i>Speicher</span><span><i style="background:var(--grid)"></i>Netz</span><span><i style="background:var(--load-soft);box-shadow:inset 0 2px 0 var(--load),inset 0 -2px 0 var(--load)"></i>Freigabe</span><span><i class="plan"></i>laut Plan</span></div>'
    + '<div class="tl-moment" id="tl-moment">' + momentZeile(momentT()) + '</div></section>';
}
function momentZeile(t) {
  const R = S.R;
  const laufen = laufendeIds(t);
  const bekannt = t < 96 || morgenBekannt();
  const kopf = '<b>' + uhrTag(t) + '–' + uhr(t + 1) + '</b> · Sonne ' + fKw(SIM.pv(t)) + (bekannt ? ' · ' + fCt(SIM.preis(t)) : '');
  if (!laufen.length) return kopf + '<br>Kein gesteuertes Gerät läuft.';
  return kopf + '<br>' + laufen.map((id) => esc(kurz(id)) + ' ' + (gemessen(id) ? fKw(R.kw[id][t]) : '(nicht gemessen)')).join(' · ');
}
function zeichneTagesbild() {
  const host = document.getElementById('tl-host');
  if (host) zeichneTagesbildIn(host);
}
function zeichneTagesbildIn(host) {
  const W = Math.max(280, Math.round(host.clientWidth));
  const t0 = S.tag * 96;
  const breit = W >= 520;
  const rows = reihenIds().map((id) => ({ id, h: breit ? 17 : 15, gap: 5 }));
  const zb = zeitband(W, { id: 'tl', t0, t1: t0 + 96, sel: S.sel, namen: breit, padL: breit ? 112 : 28, label: 'Tagesbild: wann welches Gerät läuft, gefärbt nach Herkunft des Stroms',
    bands: [{ art: 'pv', h: 24, gap: 4 }, { art: 'preis', h: 26, gap: 8 }, { art: 'soc', h: 12, gap: 6, label: 'Ladestand des Speichers' }], rows });
  host.innerHTML = zb.svg;
  host._zb = zb;
}
function waehleMoment(t) {
  t = Math.max(0, Math.min(SIM.N - 1, t));
  if (t === S.now) t = null;
  if (S.sel === t) return;
  S.sel = t;
  const j = document.getElementById('jetzt');
  if (j) j.outerHTML = jetztKarte();
  const m = document.getElementById('tl-moment');
  if (m) m.innerHTML = momentZeile(momentT());
  const host = document.getElementById('tl-host');
  if (host) { host.setAttribute('aria-valuenow', momentT() % 96); host.setAttribute('aria-valuetext', uhrTag(momentT())); }
  zeichneTagesbild();
  tick();
}
function tagesbildBedienung(root) {
  let aktiv = false;
  const slotAus = (e) => {
    const host = document.getElementById('tl-host');
    const zb = host && host._zb; if (!zb) return null;
    const r = host.getBoundingClientRect();
    const px = (e.clientX - r.left) * (zb.svg ? 1 : 1);
    const scale = r.width / (Number(host.querySelector('svg').getAttribute('width')) || r.width);
    const x = px / scale;
    if (x < zb.padL - 2) return null;
    return zb.t0 + Math.max(0, Math.min(95, Math.floor((x - zb.padL) / zb.bw)));
  };
  root.addEventListener('pointerdown', (e) => {
    const host = e.target.closest('#tl-host');
    if (!host || e.target.closest('.row-hit')) return;
    const t = slotAus(e); if (t == null) return;
    aktiv = true;
    waehleMoment(t);
  });
  root.addEventListener('pointermove', (e) => {
    if (!aktiv) return;
    const t = slotAus(e); if (t != null) waehleMoment(t);
  });
  window.addEventListener('pointerup', () => { aktiv = false; });
  root.addEventListener('keydown', (e) => {
    if (!e.target.closest || !e.target.closest('#tl-host')) return;
    const t = momentT();
    const schritt = e.shiftKey ? 4 : 1;
    if (e.key === 'ArrowRight') { e.preventDefault(); waehleMoment(t + schritt); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); waehleMoment(t - schritt); }
    if (e.key === 'Home') { e.preventDefault(); waehleMoment(S.tag * 96); }
    if (e.key === 'End') { e.preventDefault(); waehleMoment(S.tag * 96 + 95); }
    if (e.key === 'Escape') { e.preventDefault(); waehleMoment(S.now); }
  });
}

/* ---------- Geräteliste = Reihenfolge ---------- */
function geraetKarte(id, platz) {
  const t = S.now;
  const L = lage(id, t);
  const g = geraet(id);
  const icoKlasse = L.e ? 'hand' : L.an ? 'on ' + (id === 'sp' ? 'batt' : srcDominant(S.R.src[id] ? S.R.src[id][t] : null) === 'netz' ? 'netz' : srcDominant(S.R.src[id] ? S.R.src[id][t] : null) === 'sp' ? 'batt' : '') : '';
  const kwTxt = id === 'sp' ? (Math.abs(L.kw) > 0.05 ? fKw(Math.abs(L.kw)) : fPct(S.R.sp.soc[t]))
    : L.an ? (gemessen(id) ? fKw(L.kw) : '<small>nicht gemessen</small>') : '';
  let zweite = 'Smart: <em>' + esc(auftragKurz(id)) + '</em>';
  if (L.e) zweite = 'Eingriff bis ' + uhrTag(L.e.bis) + ' · dann wieder Smart';
  if (id === 'hs') zweite += ' · Warmwasser ' + fGrad(S.R.hsT[t]);
  const nx = naechstes(id, t);
  let erste = warum(id, t);
  if (nx && nx.t - t <= 16 && !L.e && !['frist-wartet'].includes((L.why || {}).k)) erste += ' · ' + (nx.an ? 'startet ' : 'endet ') + inZeit(nx.t);
  return '<button class="dev" data-act="geraet" data-id="' + id + '" id="dev-' + id + '">'
    + '<span class="ico ' + icoKlasse + '">' + ic(icon(id), 23) + (platz ? '<span class="rk">' + platz + '</span>' : '') + '</span>'
    + '<span class="d-mid"><span class="d-name"><b>' + esc(name(id)) + '</b></span><span class="d-satz">' + erste + '</span><span class="d-satz">' + zweite + '</span></span>'
    + '<span class="d-right"><span class="pill ' + L.pill[0] + '"><i></i>' + L.pill[1] + '</span><span class="d-kw">' + kwTxt + '</span></span>'
    + '</button>';
}
function listeKarte() {
  if (S.reo) return reoListe();
  const rang = S.cfg.reihenfolge.filter((id) => SIM.sonnig(S.cfg, id));
  const rest = Object.keys(S.cfg.geraete).filter((id) => !rang.includes(id));
  return '<section aria-label="Geräte und Reihenfolge" class="devs rechts" id="devs"><div class="card-h" style="margin:4px 2px 0"><h2>' + ic('list', 18) + 'Wer bekommt Sonnenstrom zuerst?</h2><button class="tbtn" data-act="reo">' + ic('sliders', 16) + 'Ändern</button></div>'
    + rang.map((id, i) => geraetKarte(id, i + 1)).join('')
    + '<div class="linie">nach Zeit, Frist oder Preis</div>'
    + rest.map((id) => geraetKarte(id, null)).join('')
    + '<button class="add-dev" data-act="katalog">' + ic('plus', 18) + 'Weiteres Gerät steuern</button></section>';
}

/* Reihenfolge ändern: Ziehen am Griff oder ▲ ▼ (44 px), Folgen vor dem Speichern */
function reoListe() {
  const ids = S.reo;
  const cfg = kopie(S.cfg); cfg.reihenfolge = [...ids, ...S.cfg.reihenfolge.filter((x) => !ids.includes(x))];
  const V = vorschau(cfg);
  const folgen = [];
  for (const id of ids) {
    if (id === 'sp') continue;
    const a = SIM.summe(S.R, id, S.now, 96); const b = SIM.summe(V, id, S.now, 96);
    const d = (b.stunden - a.stunden);
    if (Math.abs(d) >= 0.25) folgen.push((d > 0 ? '+' : '−') + dauer(Math.abs(d) * 4) + ' ' + kurz(id));
  }
  const socA = S.R.sp.soc[80]; const socB = V.sp.soc[80];
  if (Math.abs(socB - socA) >= 3) folgen.push('Speicher um 20 Uhr ' + fPct(socB) + ' statt ' + fPct(socA));
  const zeilen = ids.map((id, i) => {
    const L = lage(id, S.now);
    return '<div class="dev reo" data-id="' + id + '" id="reo-' + id + '"><span class="ico">' + ic(icon(id), 23) + '<span class="rk">' + (i + 1) + '</span></span>'
      + '<span class="d-mid"><span class="d-name"><b>' + esc(name(id)) + '</b></span><span class="d-satz">' + esc(auftragKurz(id)) + '</span></span>'
      + '<span class="reo-btns"><button type="button" data-act="hoch" data-id="' + id + '" aria-label="' + esc(name(id)) + ' nach oben"' + (i === 0 ? ' disabled' : '') + '>' + ic('chevU', 20) + '</button><button type="button" data-act="runter" data-id="' + id + '" aria-label="' + esc(name(id)) + ' nach unten"' + (i === ids.length - 1 ? ' disabled' : '') + '>' + ic('chevD', 20) + '</button><button type="button" class="handle" data-griff="' + id + '" aria-label="' + esc(name(id)) + ' ziehen">' + ic('grip', 20) + '</button></span></div>';
  }).join('');
  return '<section aria-label="Reihenfolge ändern" class="devs rechts" id="devs"><div class="reo-bar"><span>Oben bekommt zuerst. Ziehen am Griff oder mit den Pfeilen.</span></div>'
    + '<div id="reo-liste" class="devs">' + zeilen + '</div>'
    + '<div class="ok-note" style="background:var(--c-card);border:1px solid var(--c-border);color:var(--c-fg)">' + ic('info', 18) + '<span><b>Folgen ab jetzt:</b> ' + (folgen.length ? folgen.join(' · ') : 'heute keine spürbare Änderung') + '. Gemessenes bleibt, wie es war.</span></div>'
    + '<div style="display:flex;gap:8px"><button class="btn sek" style="flex:1" data-act="reo-abbruch">Abbrechen</button><button class="btn" style="flex:1" data-act="reo-ok">Reihenfolge speichern</button></div>'
    + '<p class="leise" id="reo-live" aria-live="polite"></p></section>';
}
function reoBewegen(id, d) {
  const i = S.reo.indexOf(id); const j = i + d;
  if (j < 0 || j >= S.reo.length) return;
  [S.reo[i], S.reo[j]] = [S.reo[j], S.reo[i]];
  renderApp();
  const b = document.querySelector('#reo-' + id + ' [data-act="' + (d < 0 ? 'hoch' : 'runter') + '"]:not([disabled])') || document.querySelector('#reo-' + id + ' .handle');
  if (b) b.focus({ preventScroll: true });
  const el = document.getElementById('reo-' + id); if (el) el.classList.add('moved');
  const live = document.getElementById('reo-live'); if (live) live.textContent = name(id) + ' jetzt auf Platz ' + (j + 1) + '.';
  tick();
}
function reoZiehen(root) {
  let drag = null;
  root.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('[data-griff]'); if (!h) return;
    const el = h.closest('.dev.reo'); if (!el) return;
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    drag = { el, id: h.dataset.griff, y0: e.clientY, dy: 0, h };
    el.classList.add('drag');
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const liste = document.getElementById('reo-liste');
    drag.dy = e.clientY - drag.y0;
    drag.el.style.transform = 'translateY(' + drag.dy + 'px)';
    const kinder = [...liste.children];
    const i = kinder.indexOf(drag.el);
    const r = drag.el.getBoundingClientRect(); const mitte = r.top + r.height / 2;
    const vor = kinder[i - 1]; const nach = kinder[i + 1];
    if (vor && mitte < vor.getBoundingClientRect().top + vor.getBoundingClientRect().height / 2) {
      liste.insertBefore(drag.el, vor); drag.y0 -= vor.getBoundingClientRect().height + 8; drag.dy = e.clientY - drag.y0; drag.el.style.transform = 'translateY(' + drag.dy + 'px)'; tick();
    } else if (nach && mitte > nach.getBoundingClientRect().top + nach.getBoundingClientRect().height / 2) {
      liste.insertBefore(nach, drag.el); drag.y0 += nach.getBoundingClientRect().height + 8; drag.dy = e.clientY - drag.y0; drag.el.style.transform = 'translateY(' + drag.dy + 'px)'; tick();
    }
  });
  const ende = () => {
    if (!drag) return;
    const liste = document.getElementById('reo-liste');
    S.reo = [...liste.children].map((c) => c.dataset.id);
    const id = drag.id;
    drag = null;
    renderApp();
    const el = document.getElementById('reo-' + id); if (el) el.classList.add('moved');
    const live = document.getElementById('reo-live'); if (live) live.textContent = name(id) + ' jetzt auf Platz ' + (S.reo.indexOf(id) + 1) + '.';
  };
  root.addEventListener('pointerup', ende);
  root.addEventListener('pointercancel', ende);
}

/* ---------- Was immer gilt ---------- */
function immerKarte() {
  const sp = S.cfg.speicher;
  const rows = [
    ['shield', 'Wer gewinnt?', 'Schutz › Ihr Eingriff › Regel › Frist › Reihenfolge', 'vorrang'],
    ['battery', 'Speicher: ' + (sp.modell === 'markt' ? 'Marktoptimierung' : 'Eigenverbrauch'), 'Betriebsmodell · Reserve ' + fPct(sp.reserve * 100), 'speicher'],
    ['gauge', 'Netzanschluss ' + fKw(S.cfg.anschlussKw), 'Laden wird gekürzt, bevor die Sicherung fällt', 'lastmgmt'],
    ['pole', '§ 14a EnWG', 'Heute kein Signal Ihres Netzbetreibers', 'p14a'],
    ['down', 'Negativpreis-Abregelung', 'Bei Preisen unter null speist die Anlage nicht ein', 'negativ'],
  ];
  return '<section class="card immer links" aria-label="Was immer gilt"><div class="card-h" style="margin:8px 0 2px"><h2>' + ic('shield', 18) + 'Was immer gilt</h2></div>'
    + rows.map(([i, t, s, k]) => '<button class="immer-r" data-act="immer" data-k="' + k + '"><span class="li">' + ic(i, 18) + '</span><span class="lt">' + t + '<small>' + s + '</small></span>' + ic('chevR', 18) + '</button>').join('') + '</section>';
}

function tabGeraete() {
  return jetztKarte() + tagesbildKarte() + listeKarte() + immerKarte();
}
