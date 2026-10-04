/* ================= Reiter „Laden“: alles rund um Ladepunkte an einem Ort ================= */

const LADER = () => Object.keys(S.cfg.geraete).filter((id) => S.cfg.geraete[id].fahrzeug);

function sitzung(id, t) {
  const g = S.cfg.geraete[id];
  const r = g.fahrzeug.da.find(([a, b]) => t >= a && t < b);
  return r ? { von: r[0], bis: r[1] } : null;
}
function naechsteSitzung(id, t) {
  const g = S.cfg.geraete[id];
  return g.fahrzeug.da.find(([a]) => a > t) || null;
}
/* Modus aus Sicht des Kunden: Aus · Smart · Schnell */
function ladeModus(id) {
  const e = eingriff(id);
  if (e) return e.art === 'aus' ? 'aus' : 'schnell';
  return S.cfg.geraete[id].auftrag.art === 'sofort' ? 'schnell' : 'smart';
}
function ladeQuelle(a) {
  if (a.art === 'frist') return a.quelle === 'sonne' ? 'sonne' : 'guenstig';
  if (a.art === 'sonne') return a.modus === 'min' ? 'min' : 'sonne';
  if (a.art === 'guenstig') return 'guenstig';
  return 'sonne';
}

function budgetKarte() {
  const t = S.now; const R = S.R;
  const anschluss = S.cfg.anschlussKw;
  const abstand = anschluss * S.cfg.abstandPct / 100;
  const lader = LADER().map((id) => [id, R.kw[id][t]]);
  const ladeSumme = lader.reduce((s, x) => s + x[1], 0);
  const bezug = Math.max(0, R.netz[t]);
  /* Was das Gebäude ohne die Ladepunkte vom Anschluss braucht (Bezug minus Laden aus dem Netz) */
  const ladeNetz = LADER().reduce((s, id) => s + ((R.src[id][t] || {}).netz || 0), 0);
  const haus = Math.max(0, bezug - ladeNetz);
  const frei = Math.max(0, anschluss - abstand - haus - ladeNetz);
  const teile = [['haus', haus, 'Haus'], ...lader.filter((x) => ((R.src[x[0]][t] || {}).netz || 0) > 0.05).map(([id]) => ['lp', (R.src[id][t] || {}).netz, kurz(id)]), ['frei', frei, 'frei'], ['res', abstand, 'Abstand']];
  const bar = teile.map(([k, v, l]) => '<span class="' + k + '" style="flex:0 0 ' + (v / anschluss * 100).toFixed(1) + '%" title="' + esc(l + ' ' + fKw(v)) + '">' + (v / anschluss > 0.14 ? esc(l) : '') + '</span>').join('');
  return '<section class="card" aria-label="Netzanschluss"><div class="card-h"><h2>' + ic('gauge', 18) + 'Netzanschluss ' + fKw(anschluss) + '</h2><button class="tbtn" data-act="blatt" data-art="lastmgmt">' + ic('sliders', 16) + 'Rahmen</button></div>'
    + '<div class="budget"><div class="b-bar" role="img" aria-label="Aufteilung des Netzanschlusses">' + bar + '</div>'
    + '<p class="leise">Aus dem Netz gerade: Haus ' + fKw(haus) + (ladeNetz > 0.05 ? ', Laden ' + fKw(ladeNetz) : '') + '. Für Autos frei: <b style="color:var(--c-fg)">' + fKw(frei) + '</b>. Laden mit Sonnenstrom belastet den Anschluss nicht. ' + (ladeSumme > 0.05 ? 'Es laden gerade ' + fKw(ladeSumme) + '.' : '') + '</p></div></section>';
}

function ladeKarte(id) {
  const t = S.now; const R = S.R;
  const g = S.cfg.geraete[id]; const a = g.auftrag;
  const L = lage(id, t);
  const si = sitzung(id, t);
  const modus = ladeModus(id);
  const q = ladeQuelle(a);
  let sub;
  if (si) sub = g.fahrzeug.name + ' · Karte ' + g.fahrzeug.karte + ' · angesteckt seit ' + uhrTag(si.von);
  else {
    const n = naechsteSitzung(id, t);
    sub = 'Kein Auto angesteckt' + (n ? ' · ' + g.fahrzeug.name + ' kommt meist ' + uhrTag(n[0]) : '');
  }
  const geladen = si ? SIM.summe(R, id, si.von, t + 1) : null;
  const ansage = (() => {
    if (modus === 'aus') return 'Pausiert bis ' + (L.e ? uhrTag(L.e.bis) : 'zum Abstecken') + '. Danach wieder Smart.';
    if (modus === 'schnell') return 'Lädt so schnell es geht, nur für diese Ladung. Netzstrom erlaubt.';
    return warum(id, t);
  })();
  const modi = [['aus', 'pause', 'Aus'], ['smart', 'sun', 'Smart'], ['schnell', 'rocket', 'Schnell']];
  let smart = '';
  if (modus === 'smart') {
    const quellen = [['sonne', 'Nur Sonne'], ['min', 'Sonne + Minimum'], ['guenstig', 'Günstig']];
    const zielAn = a.art === 'frist';
    const zielText = zielAn ? '+' + NF0.format(a.kwh) + ' kWh bis ' + uhrTag(a.bis) : 'Kein Ziel · lädt, wenn es passt';
    let zielSub = zielAn ? 'Sonne zuerst, Rest in den günstigsten Stunden' : 'Tippen, um eine Menge bis zu einer Uhrzeit festzulegen';
    if (zielAn) {
      if (a.quelle === 'guenstig') zielSub = 'In den günstigsten Stunden';
      const p = R.plan && R.plan[id];
      const fertig = (() => { let last = null; for (let x = S.now; x < a.bis; x++) if (R.kw[id][x] > 0) last = x; return last; })();
      if (fertig != null) zielSub += ' · fertig voraussichtlich ' + uhrTag(fertig + 1) + (p && p.vorlaeufig ? ' (vorläufig)' : '');
    }
    smart = '<div class="blk"><h3>Womit laden?</h3><div class="chips" role="group" aria-label="Womit laden">' + quellen.map(([k, l]) => '<button data-act="lquelle" data-id="' + id + '" data-q="' + k + '" aria-pressed="' + (q === k) + '">' + l + '</button>').join('') + '</div>'
      + (q === 'guenstig' && !zielAn ? '<p class="leise">Lädt, solange der Börsenpreis unter ' + fCt(a.grenze || 9) + ' liegt.</p>' : q === 'min' ? '<p class="leise">Lädt immer mit mindestens ' + fKw(g.bereiche[0][0]) + '; was die Sonne mehr liefert, kommt dazu.</p>' : '')
      + '</div><button class="lziel" data-act="blatt" data-art="ziel" data-id="' + id + '">' + ic('flag', 20) + '<span><b>' + zielText + '</b><small>' + zielSub + '</small></span>' + ic('chevR', 18) + '</button>'
      + '<div class="tl" data-chart="lade" data-id="' + id + '"></div>';
  }
  return '<section class="card lp-card" aria-label="' + esc(name(id)) + '"><div class="lp-h"><span class="ico ' + (L.an ? 'on' : '') + '">' + ic('car', 26) + '</span><span class="t"><b>' + esc(name(id)) + '</b><small>' + esc(sub) + '</small></span><span class="lp-kw">' + (L.an ? fKw(L.kw) : '—') + '<small>' + (L.an ? (R.src[id][t] && R.src[id][t].pv > 0.05 ? 'mit Sonne' : 'aus dem Netz') : L.pill[1]) + '</small></span></div>'
    + '<div class="lmodes" role="group" aria-label="Lademodus" style="grid-template-columns:repeat(3,minmax(0,1fr))">' + modi.map(([k, i, l]) => '<button data-act="lmodus" data-id="' + id + '" data-m="' + k + '" aria-pressed="' + (modus === k) + '"' + (!si && k !== 'smart' ? ' disabled' : '') + '>' + ic(i, 20) + l + '</button>').join('') + '</div>'
    + '<p class="leise" style="color:var(--c-fg);font-weight:600">' + ansage + '</p>'
    + (geladen && geladen.kwh > 0.05 ? '<div class="soc"><div class="soc-row"><span>Diese Ladung: ' + fKwh(geladen.kwh) + '</span><span>' + fPct(geladen.pvKwh / geladen.kwh * 100) + ' Sonne</span></div><div class="soc-bar"><span style="width:' + Math.min(100, geladen.kwh / (g.fahrzeug.bedarfKwh || 30) * 100).toFixed(0) + '%"></span></div></div>' : '')
    + smart + '</section>';
}

function vorrangKarte() {
  const bis = S.cfg.speicherBis;
  const opts = [[20, '20 %'], [50, '50 %'], [80, '80 %'], [null, 'immer']];
  const spPos = S.cfg.reihenfolge.indexOf('sp');
  const autoPos = Math.min(...LADER().map((id) => S.cfg.reihenfolge.indexOf(id)).filter((x) => x >= 0));
  const speicherZuerst = spPos < autoPos;
  const satz = speicherZuerst
    ? (bis == null ? 'Der Speicher hat immer Vorrang. Die Autos bekommen, was er nicht aufnimmt.' : 'Der Speicher hat Vorrang, solange er unter ' + bis + ' % ist. Dann bekommen die Autos den Überschuss zuerst.')
    : 'Die Autos haben Vorrang vor dem Speicher.';
  return '<section class="card" aria-label="Überschuss zuerst"><div class="card-h"><h2>' + ic('sun', 18) + 'Wohin geht der Überschuss zuerst?</h2></div>'
    + '<p style="margin:0 0 10px;font:600 15px/1.45 var(--font)">' + satz + '</p>'
    + (speicherZuerst ? '<div class="chips" role="group" aria-label="Speicher hat Vorrang bis">' + opts.map(([v, l]) => '<button data-act="spbis" data-v="' + (v == null ? '' : v) + '" aria-pressed="' + (bis === v) + '">' + (v == null ? 'Speicher immer zuerst' : 'bis ' + l) + '</button>').join('') + '</div>' : '')
    + '<button class="lnk" data-act="tab" data-tab="geraete" style="margin-top:6px">Ganze Reihenfolge ansehen ' + ic('chevR', 16) + '</button></section>';
}

function fahrzeugKarte() {
  const karten = [
    ['car', 'Familienauto', 'Karte …41', 'Smart · +30 kWh bis 07:00'],
    ['car', 'Kleinwagen', 'Karte …07', 'Smart · nur Sonne'],
    ['help', 'Unbekannte Karte', 'Gäste, Werkstattkunden', 'Smart · Sonne + Minimum'],
  ];
  return '<section class="card" aria-label="Fahrzeuge"><div class="card-h"><h2>' + ic('car', 18) + 'Fahrzeuge</h2><span class="meta">nach Ladekarte</span></div><div class="fz">'
    + karten.map(([i, n, k, s]) => '<button class="fz-r" data-act="blatt" data-art="fahrzeug" data-n="' + esc(n) + '" style="border:0;background:none;width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer"><span class="li">' + ic(i, 19) + '</span><span><b>' + n + '</b><small>' + k + ' · ' + s + '</small></span>' + ic('chevR', 18) + '</button>').join('')
    + '</div><p class="leise">Wer mit dieser Karte lädt, bekommt diese Einstellung. Den Ladestand des Autos kennt VoltPilot nicht; das Ziel ist deshalb eine Menge in kWh.</p></section>';
}

function tabLaden() {
  return budgetKarte() + LADER().map(ladeKarte).join('') + vorrangKarte() + fahrzeugKarte()
    + '<section class="card immer"><button class="immer-r" data-act="hinweis" data-text="Im Portal: Fahrplan › Ladevorgänge"><span class="li">' + ic('history', 18) + '</span><span class="lt">Ladevorgänge<small>Jede Ladung mit Menge, Herkunft und Karte</small></span>' + ic('chevR', 18) + '</button></section>';
}

/* Ladeplan eines Ladepunkts: die nächsten 24 Stunden */
function zeichneLadeplan(host, id, R) {
  const W = Math.max(260, Math.round(host.clientWidth));
  const t0 = S.now; const t1 = Math.min(SIM.N, t0 + 96);
  const ticks = [];
  for (let k = 0; k <= t1 - t0; k++) if ((t0 + k) % 24 === 0) ticks.push(k);
  const zb = zeitband(W, { id: 'lade-' + id, t0, t1, R, klick: false, padT: 22, tage: true, label: 'Ladeplan der nächsten 24 Stunden',
    bands: [{ art: 'pv', h: 20, gap: 4 }, { art: 'preis', h: 22, gap: 6 }], rows: [{ id, h: 18 }], ticks });
  host.innerHTML = zb.svg;
}
