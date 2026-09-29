/* ================= Reiter „Regeln“ und der Satzbaukasten ================= */

/* Bausteine für „Wenn“: Kategorie, Einheit, Grenzen, Satz. status: da = heute vorhanden,
   teil = im Backend vorhanden, im Baukasten neu, neu = muss gebaut werden. */
const VARS = {
  preis: { kat: 'Preis', label: 'Börsenpreis', icon: 'euro', einheit: 'ct/kWh', ops: ['unter', 'ueber'], min: -2, max: 25, schritt: 0.5, def: 10, status: 'da',
    satz: (c) => 'der Börsenpreis ' + (c.op === 'unter' ? 'unter ' : 'über ') + fCt(c.w) + ' liegt' },
  rang: { kat: 'Preis', label: 'Günstigste Stunden', icon: 'trend', einheit: 'Std', ops: ['unter'], min: 1, max: 8, schritt: 1, def: 3, status: 'teil',
    satz: (c) => 'es eine der ' + c.w + ' günstigsten Stunden des Tages ist' },
  sonne: { kat: 'Sonne', label: 'Sonnen-Überschuss', icon: 'sun', einheit: 'kW', ops: ['ueber', 'unter'], min: 0, max: 8, schritt: 0.5, def: 2, status: 'da',
    satz: (c) => (c.op === 'ueber' ? 'mehr als ' : 'weniger als ') + fKw(c.w) + ' Sonnenstrom übrig sind' },
  soc: { kat: 'Speicher', label: 'Ladestand Speicher', icon: 'battery', einheit: '%', ops: ['unter', 'ueber'], min: 0, max: 100, schritt: 5, def: 20, status: 'da',
    satz: (c) => 'der Speicher ' + (c.op === 'unter' ? 'unter ' : 'über ') + fPct(c.w) + ' hat' },
  temp: { kat: 'Wetter', label: 'Außentemperatur', icon: 'thermo', einheit: '°C', ops: ['ueber', 'unter'], min: -10, max: 35, schritt: 1, def: 24, status: 'neu',
    satz: (c) => 'es draußen ' + (c.op === 'unter' ? 'unter ' : 'über ') + fGrad(c.w) + ' hat' },
  zeit: { kat: 'Zeit', label: 'Uhrzeit', icon: 'clock', ops: ['zwischen'], def: [88, 28], status: 'da',
    satz: (c) => 'es zwischen ' + uhr(c.w[0]) + ' und ' + uhr(c.w[1]) + ' Uhr ist' },
  geraet: { kat: 'Geräte', label: 'Anderes Gerät', icon: 'link', ops: ['laeuft', 'aus'], def: 'pool', status: 'neu',
    satz: (c) => kurz(c.w) + (c.op === 'laeuft' ? ' läuft' : ' aus ist') },
  auto: { kat: 'Geräte', label: 'Auto angesteckt', icon: 'car', ops: ['ist'], def: 'lp', status: 'teil',
    satz: (c) => 'am ' + kurz(c.w) + ' ein Auto angesteckt ist' },
  szene: { kat: 'Anlage', label: 'Szene', icon: 'plane', ops: ['ist'], def: 'urlaub', status: 'neu',
    satz: (c) => 'die Szene „' + (SZENEN.find((s) => s.id === c.w) || {}).name + '“ an ist' },
};
const OP_WORT = { unter: 'unter', ueber: 'über', zwischen: 'zwischen', laeuft: 'läuft', aus: 'ist aus', ist: 'ist' };

function tatenFuer(id) {
  const g = S.cfg.geraete[id];
  if (g.fahrzeug) return [['an', 'schnell laden'], ['sperren', 'nicht laden']];
  if (g.form === 'freigabe') return [['an', 'anheben'], ['sperren', 'nicht anheben']];
  const t = [['an', 'einschalten']];
  if (g.form === 'stufig' || g.form === 'stufenlos') t.push(['voll', 'voll einschalten']);
  t.push(['sperren', 'sperren']);
  return t;
}
function tatSatz(d) {
  if (!d.g || !S.cfg.geraete[d.g]) return 'schaltet VoltPilot …';
  const w = (tatenFuer(d.g).find((x) => x[0] === d.a) || [null, 'einschalten'])[1];
  const n = name(d.g);
  if (d.a === 'sperren') return n + ' bleibt aus';
  return n + ' ' + (w === 'einschalten' ? 'einschalten' : w);
}
function regelSatz(r, html) {
  const teile = r.wenn.map((c) => VARS[c.v] ? VARS[c.v].satz(c) : '…');
  const wenn = 'Wenn ' + teile.join(r.oder ? ' oder ' : ' und ');
  const dann = tatSatz(r.dann);
  if (!html) return wenn + ': ' + dann + '.';
  return '<span class="h">' + esc(wenn) + '</span>: <span class="d">' + esc(dann) + '</span>.';
}

/* Wann eine Regel greift (Bedingung erfüllt), für Probelauf und Karten */
function regelZeiten(r, R, a, b) {
  const out = [];
  for (let t = a; t < b; t++) {
    const st = { soc: R.sp.soc[t] / 100, on: Object.fromEntries(Object.keys(S.cfg.geraete).map((id) => [id, R.kw[id][Math.max(0, t - 1)] > 0])) };
    out.push(SIM.regelGilt(r, t, st, { morgenBekannt: morgenBekannt(), szene: S.cfg.szene }));
  }
  return out;
}
function spannen(bits, t0) {
  const out = []; let s = null;
  bits.forEach((v, i) => { if (v && s == null) s = i; if (!v && s != null) { out.push([t0 + s, t0 + i]); s = null; } });
  if (s != null) out.push([t0 + s, t0 + bits.length]);
  return out;
}
function spannenText(sp, max) {
  if (!sp.length) return '—';
  const txt = sp.slice(0, max || 3).map(([a, b]) => uhrTag(a) + '–' + uhr(b)).join(', ');
  return txt + (sp.length > (max || 3) ? ' und ' + (sp.length - (max || 3)) + ' weitere' : '');
}

function regelKarte(r) {
  const R = S.R;
  const heute = regelZeiten(r, R, S.now, 96);
  const greift = r.an && heute[0];
  const kommend = spannen(heute, S.now);
  const vorbei = R.regel && R.regel[r.id] ? spannen(R.regel[r.id].slice(0, S.now), 0) : [];
  let meta;
  if (!r.an) meta = '<span class="pill off"><i></i>aus</span>';
  else if (greift) meta = '<span class="pill on"><i></i>greift gerade</span>';
  else meta = '<span class="pill wait"><i></i>wartet</span>';
  const info = [];
  if (vorbei.length) info.push('heute schon ' + spannenText(vorbei, 2));
  if (r.an && kommend.length && !greift) info.push('als Nächstes ' + uhrTag(kommend[0][0]));
  if (r.an && !kommend.length) info.push('greift heute nicht mehr');
  return '<article class="rule' + (r.an ? '' : ' aus') + '" id="regel-' + r.id + '"><button class="r-satz" data-act="regel-offen" data-id="' + r.id + '">' + regelSatz(r, true) + '</button>'
    + '<button class="sw" role="switch" aria-checked="' + r.an + '" aria-label="Regel ' + esc(r.name) + ' ' + (r.an ? 'ausschalten' : 'einschalten') + '" data-act="regel-schalter" data-id="' + r.id + '"></button>'
    + '<div class="r-meta">' + meta + '<span>' + esc(r.name) + '</span>' + (info.length ? '<span>· ' + info.join(' · ') + '</span>' : '') + '</div>'
    + '<div class="r-strip" data-chart="regelstreifen" data-id="' + r.id + '"></div></article>';
}

function tabRegeln() {
  const events = (S.R.events || []).filter((e) => e.t <= S.now).slice(-6).reverse();
  const eingriffe = S.cfg.eingriffe.filter((e) => e.von <= S.now);
  const log = [
    ...eingriffe.map((e) => ({ t: e.von, txt: 'Ihr Eingriff: <b>' + esc(name(e.g)) + '</b> ' + (e.art === 'aus' ? 'aus' : 'an') + ' bis ' + uhrTag(e.bis) })),
    ...events.map((e) => { const r = S.cfg.regeln.find((x) => x.id === e.r); return r ? { t: e.t, txt: 'Regel „' + esc(r.name) + '“ ' + (e.k === 'an' ? 'greift: <b>' + esc(tatSatz(r.dann)) + '</b>' : 'endet') } : null; }).filter(Boolean),
  ].sort((a, b) => b.t - a.t).slice(0, 6);
  return '<button class="btn" data-act="neue-regel" style="width:100%;min-height:52px;font-size:16px">' + ic('plus', 20) + 'Neue Regel</button>'
    + '<section aria-label="Vorlagen"><div class="grp-h"><h3>Vorlagen</h3><span>antippen und anpassen</span></div><div class="vorl">'
    + VORLAGEN.map((v) => '<button class="vk" data-act="vorlage" data-id="' + v.id + '"><span class="ico" style="background:' + ({ price: 'var(--price-soft)', neg: 'var(--st-done-soft)', pv: 'var(--pv-soft)', batt: 'var(--batt-soft)', navy: 'var(--c-muted)' }[v.farbe]) + ';color:' + ({ price: '#1d4ed8', neg: 'var(--neg)', pv: 'var(--pv)', batt: 'var(--batt)', navy: 'var(--navy)' }[v.farbe]) + '">' + ic(v.icon, 19) + '</span><b>' + esc(v.titel) + '</b><small>' + esc(v.satz) + '</small></button>').join('')
    + '</div></section>'
    + '<section aria-label="Szenen"><div class="grp-h"><h3>Szenen</h3><span>ein Tipp, mehrere Geräte</span></div><div class="szenen">'
    + SZENEN.map((s) => '<button class="sz" data-act="szene" data-id="' + s.id + '" aria-pressed="' + (S.cfg.szene === s.id) + '">' + ic(s.icon, 20) + '<b>' + esc(s.name) + '</b><small>' + esc(S.cfg.szene === s.id ? 'an · tippen zum Beenden' : s.kurz) + '</small></button>').join('')
    + '</div></section>'
    + '<section aria-label="Ihre Regeln" style="display:grid;gap:8px"><div class="grp-h"><h3>Ihre Regeln</h3><span>' + S.cfg.regeln.filter((r) => r.an).length + ' von ' + S.cfg.regeln.length + ' an</span></div>'
    + S.cfg.regeln.map(regelKarte).join('')
    + '<p class="leise" style="padding:0 4px">Regeln sind Ausnahmen vom Smart-Auftrag der Geräte. Schutzgrenzen und Ihre Eingriffe gehen immer vor.</p></section>'
    + '<section class="card" aria-label="Verlauf"><div class="card-h"><h2>' + ic('history', 18) + 'Heute passiert</h2><span class="meta">bis ' + pad(Math.floor(S.nowMin / 60)) + ':' + pad(S.nowMin % 60) + '</span></div>'
    + (log.length ? '<ul class="log">' + log.map((l) => '<li><time>' + uhr(l.t) + '</time><span>' + l.txt + '</span></li>').join('') + '</ul>' : '<p class="leise">Heute hat noch keine Regel geschaltet.</p>')
    + '<button class="lnk" data-act="hinweis" data-text="Im Portal: Befehle an Ihre Geräte (Verlauf)">Befehle an Ihre Geräte ansehen ' + ic('chevR', 16) + '</button></section>';
}

/* ---------- Der Baukasten ---------- */
function neuerEntwurf(vorlage, geraetId) {
  const v = vorlage ? VORLAGEN.find((x) => x.id === vorlage) : null;
  const d = {
    id: 'r' + Date.now().toString(36), name: v ? v.titel : 'Neue Regel', an: true,
    wenn: v ? kopie(v.wenn) : [{ v: 'preis', op: 'unter', w: 10 }], oder: false,
    dann: v ? kopie(v.dann) : { g: 'hs', a: 'an' }, minLaufzeit: 0,
  };
  if (geraetId) { d.dann.g = geraetId; d.dann.a = 'sperren'; d.wenn = [{ v: 'soc', op: 'unter', w: 20 }]; d.name = 'Nie, wenn …'; }
  return d;
}
function entwurfCfg(d, ersetzt) {
  const cfg = kopie(S.cfg);
  cfg.regeln = cfg.regeln.filter((r) => r.id !== ersetzt && r.id !== d.id);
  cfg.regeln.push(kopie(d));
  return cfg;
}
function tokenHtml(key, cls, text, icn) {
  const f = S.sheet.fokus === key;
  return '<button class="tok ' + cls + '" data-act="tok" data-k="' + key + '" aria-expanded="' + f + '">' + (icn ? ic(icn, 17) : '') + esc(text) + '</button>';
}
function wertText(c) {
  const V = VARS[c.v];
  if (c.v === 'zeit') return uhr(c.w[0]) + '–' + uhr(c.w[1]);
  if (c.v === 'geraet' || c.v === 'auto') return kurz(c.w);
  if (c.v === 'szene') return (SZENEN.find((s) => s.id === c.w) || {}).name;
  if (c.v === 'preis') return fCt(c.w);
  if (c.v === 'rang') return c.w + ' Std';
  return NF1.format(c.w).replace(/,0$/, '') + ' ' + V.einheit;
}
function pickerHtml(d) {
  const f = S.sheet.fokus;
  if (!f) return '<p class="leise" style="padding:2px 4px">Tippen Sie auf einen Baustein, um ihn zu ändern.</p>';
  const m = /^w(\d)([vow])$/.exec(f);
  if (m) {
    const i = Number(m[1]); const c = d.wenn[i]; const V = VARS[c.v];
    if (m[2] === 'v') {
      const kats = [...new Set(Object.values(VARS).map((x) => x.kat))];
      return '<div class="pick"><b>Wenn …</b><div class="vgrid">' + kats.map((k) => '<span class="vkat">' + k + '</span>' + Object.entries(VARS).filter(([, x]) => x.kat === k).map(([key, x]) => '<button class="vopt" data-act="wahl-var" data-i="' + i + '" data-v="' + key + '" aria-pressed="' + (c.v === key) + '">' + ic(x.icon, 18) + '<span>' + x.label + (x.status === 'neu' ? '<small>neu im Konzept</small>' : x.status === 'teil' ? '<small>neu im Baukasten</small>' : '') + '</span></button>').join('')).join('') + '</div></div>';
    }
    if (m[2] === 'o') {
      return '<div class="pick"><b>Vergleich</b><div class="chips">' + V.ops.map((o) => '<button data-act="wahl-op" data-i="' + i + '" data-o="' + o + '" aria-pressed="' + (c.op === o) + '">' + OP_WORT[o] + '</button>').join('') + '</div></div>';
    }
    if (c.v === 'zeit') {
      return '<div class="pick"><b>Zeitraum</b><div class="prow"><span>von</span><span class="stp"><button data-act="zeit" data-i="' + i + '" data-j="0" data-d="-2" aria-label="früher">' + ic('minus', 18) + '</button><output>' + uhr(c.w[0]) + '</output><button data-act="zeit" data-i="' + i + '" data-j="0" data-d="2" aria-label="später">' + ic('plus', 18) + '</button></span></div><div class="prow"><span>bis</span><span class="stp"><button data-act="zeit" data-i="' + i + '" data-j="1" data-d="-2" aria-label="früher">' + ic('minus', 18) + '</button><output>' + uhr(c.w[1]) + '</output><button data-act="zeit" data-i="' + i + '" data-j="1" data-d="2" aria-label="später">' + ic('plus', 18) + '</button></span></div><p class="leise">Über Mitternacht geht: 22:00–07:00. Das Ende gehört nicht mehr dazu.</p></div>';
    }
    if (c.v === 'geraet' || c.v === 'auto') {
      const ids = c.v === 'auto' ? LADER() : Object.keys(S.cfg.geraete).filter((x) => x !== d.dann.g);
      return '<div class="pick"><b>Welches Gerät?</b><div class="vgrid">' + ids.map((x) => '<button class="vopt" data-act="wahl-wert" data-i="' + i + '" data-w="' + x + '" aria-pressed="' + (c.w === x) + '">' + ic(icon(x), 18) + '<span>' + esc(name(x)) + '</span></button>').join('') + '</div></div>';
    }
    if (c.v === 'szene') {
      return '<div class="pick"><b>Welche Szene?</b><div class="chips">' + SZENEN.map((s) => '<button data-act="wahl-wert" data-i="' + i + '" data-w="' + s.id + '" aria-pressed="' + (c.w === s.id) + '">' + esc(s.name) + '</button>').join('') + '</div></div>';
    }
    return '<div class="pick"><b>' + esc(V.label) + '</b><div class="rng"><div class="prow"><span>' + esc(OP_WORT[c.op] || '') + '</span><span class="stp"><button data-act="schritt" data-i="' + i + '" data-d="-1" aria-label="weniger">' + ic('minus', 18) + '</button><output id="rng-out">' + wertText(c) + '</output><button data-act="schritt" data-i="' + i + '" data-d="1" aria-label="mehr">' + ic('plus', 18) + '</button></span></div><input type="range" id="rng-' + i + '" data-act="rng" data-i="' + i + '" min="' + V.min + '" max="' + V.max + '" step="' + V.schritt + '" value="' + c.w + '" aria-label="' + esc(V.label) + '"><div class="skala"><span>' + NF1.format(V.min).replace(/,0$/, '') + '</span><span>' + NF1.format(V.max).replace(/,0$/, '') + ' ' + V.einheit + '</span></div></div></div>';
  }
  if (f === 'dg') {
    return '<div class="pick"><b>Welches Gerät?</b><div class="vgrid">' + Object.keys(S.cfg.geraete).map((x) => '<button class="vopt" data-act="wahl-dg" data-g="' + x + '" aria-pressed="' + (d.dann.g === x) + '">' + ic(icon(x), 18) + '<span>' + esc(name(x)) + '</span></button>').join('') + '</div></div>';
  }
  if (f === 'da') {
    return '<div class="pick"><b>Was soll passieren?</b><div class="chips">' + tatenFuer(d.dann.g).map(([k, l]) => '<button data-act="wahl-da" data-a="' + k + '" aria-pressed="' + (d.dann.a === k) + '">' + l + '</button>').join('') + '</div></div>';
  }
  return '';
}

function probelauf(d) {
  const cfg = entwurfCfg(d, S.sheet.edit);
  const V = vorschau(cfg);
  const ohne = kopie(S.cfg); ohne.regeln = ohne.regeln.filter((r) => r.id !== S.sheet.edit && r.id !== d.id);
  const O = vorschau(ohne);
  const bits = regelZeiten(d, V, S.now, SIM.N);
  const trifft = bits.filter(Boolean).length;
  const id = d.dann.g;
  const mit = SIM.summe(V, id, S.now, SIM.N); const vorher = SIM.summe(O, id, S.now, SIM.N);
  const mehrStd = mit.stunden - vorher.stunden;
  const mehrKwh = mit.kwh - vorher.kwh;
  const mehrEur = mit.eur - vorher.eur;
  const hinweise = [];
  const unbekannt = !morgenBekannt() && d.wenn.some((c) => c.v === 'preis' || c.v === 'rang');
  if (!trifft) {
    const c = d.wenn[0];
    let tipp = '';
    if (c.v === 'preis') {
      let lo = Infinity; for (let t = S.now; t < (morgenBekannt() ? SIM.N : 96); t++) lo = Math.min(lo, SIM.preis(t));
      tipp = ' Der niedrigste bekannte Preis ist ' + fCt(lo) + '.';
    }
    hinweise.push('<div class="konflikt">' + ic('alert', 18) + '<span>Trifft ab jetzt bis morgen Abend nie zu.' + tipp + '</span></div>');
  }
  if (unbekannt) hinweise.push('<div class="konflikt">' + ic('info', 18) + '<span>Für morgen fehlen noch die Börsenpreise (kommen gegen 13 Uhr). Bis dahin schaltet die Regel dort nicht: unbekannt ist keine Null.</span></div>');
  const andere = S.cfg.regeln.filter((r) => r.id !== S.sheet.edit && r.dann.g === id);
  if (andere.length) hinweise.push('<div class="konflikt">' + ic('link', 18) + '<span>Für ' + esc(name(id)) + ' gilt schon ' + andere.map((r) => '„' + esc(r.name) + '“').join(', ') + '. Beide gelten; „bleibt aus“ gewinnt vor „einschalten“.</span></div>');
  const g = S.cfg.geraete[id];
  if (g.ziel && g.ziel.art === 'temp' && d.dann.a !== 'sperren') hinweise.push('<div class="ok-note">' + ic('thermo', 18) + '<span>Der Heizstab hört trotzdem bei ' + fGrad(g.ziel.grad) + ' Warmwasser auf. Das Ziel bleibt.</span></div>');
  if (g.fahrzeug && d.dann.a !== 'sperren') hinweise.push('<div class="ok-note">' + ic('car', 18) + '<span>Lädt nur, wenn ein Auto angesteckt ist. Der Netzanschluss begrenzt weiter.</span></div>');
  if (!g.gemessen) hinweise.push('<div class="ok-note">' + ic('info', 18) + '<span>' + esc(name(id)) + ' wird nicht gemessen. Energie und Kosten sind angenommen (Nennleistung × Zeit).</span></div>');
  const erste = d.wenn[0];
  const bands = [];
  if (erste.v === 'preis') bands.push({ art: 'preis', h: 34, gap: 8, hl: (t) => bits[t - S.now] === true || (t < S.now ? null : false), linie: erste.w });
  else if (erste.v === 'sonne') bands.push({ art: 'pv', h: 30, gap: 8, frei: (t) => t >= S.now && bits[t - S.now] });
  else if (erste.v === 'temp') bands.push({ art: 'temp', h: 30, gap: 8, hl: (t) => t >= S.now && bits[t - S.now], linie: erste.w });
  else if (erste.v === 'soc') bands.push({ art: 'soc', h: 18, gap: 8, label: 'Ladestand des Speichers' });
  else bands.push({ art: 'hl', h: 14, gap: 8, icon: VARS[erste.v].icon, label: 'Bedingung erfüllt', hl: (t) => t >= S.now && bits[t - S.now] });
  if (erste.v !== 'preis') bands.push({ art: 'preis', h: 22, gap: 8 });
  S.sheet.probe = { V, bands, id, mehrStd, trifft };
  const kosten = mehrEur > 0.005 ? '≈ ' + fEur(mehrEur) : mehrEur < -0.005 ? '− ' + fEur(-mehrEur) : '0,00 €';
  return '<div class="prev"><div class="blk"><h3>Probelauf ab jetzt bis morgen Abend</h3></div><div class="tl" data-chart="probe"></div>'
    + '<div class="prev-sum"><div><b>' + dauer(trifft) + '</b><small>Bedingung erfüllt</small></div><div><b>' + (mehrStd >= 0 ? '+' : '−') + dauer(Math.abs(mehrStd) * 4) + '</b><small>' + esc(kurz(id)) + ' läuft</small></div><div><b>' + (mehrKwh >= 0 ? '+' : '−') + fKwh(Math.abs(mehrKwh)) + '</b><small>' + kosten + ' Netz</small></div></div>'
    + hinweise.join('') + '</div>';
}

function blattRegel() {
  const sh = S.sheet; const d = sh.d;
  if (sh.schritt === 'folgen') return blattRegelFolgen();
  const tokens = [];
  tokens.push('<span class="w">Wenn</span>');
  d.wenn.forEach((c, i) => {
    if (i > 0) tokens.push('<button class="tok link" data-act="undoder">' + (d.oder ? 'oder' : 'und') + '</button>');
    const V = VARS[c.v];
    tokens.push(tokenHtml('w' + i + 'v', 'var', V.label, V.icon));
    if (V.ops.length > 1 || !['zeit', 'rang'].includes(c.v)) tokens.push(tokenHtml('w' + i + 'o', 'op', OP_WORT[c.op] || c.op));
    tokens.push(tokenHtml('w' + i + 'w', 'val', wertText(c)));
    if (d.wenn.length > 1) tokens.push('<button class="tok add" data-act="weg-bed" data-i="' + i + '" aria-label="Bedingung entfernen">' + ic('x', 15) + '</button>');
  });
  if (d.wenn.length < 4) tokens.push('<button class="tok add" data-act="plus-bed">' + ic('plus', 15) + (d.oder ? 'oder' : 'und') + ' …</button>');
  tokens.push('<span class="w">dann</span>');
  tokens.push(tokenHtml('dg', 'dev', name(d.dann.g), icon(d.dann.g)));
  tokens.push(tokenHtml('da', 'act', (tatenFuer(d.dann.g).find((x) => x[0] === d.dann.a) || ['', 'einschalten'])[1]));
  const body = '<div class="satz" aria-label="Regel als Satz">' + tokens.join('') + '</div>'
    + '<p class="leise" style="padding:0 4px;color:var(--c-fg)"><b>' + esc(regelSatz(d)) + '</b></p>'
    + pickerHtml(d)
    + probelauf(d)
    + '<details class="fein"><summary>' + ic('sliders', 18) + '<span>Feinheiten<br><small>Mindestlaufzeit, Schaltabstand</small></span>' + ic('chevR', 18) + '</summary><div class="in">'
    + '<div class="prow"><span>Wenn an, dann mindestens<small>verhindert kurzes Takten</small></span></div><div class="chips">' + [[0, 'keine'], [2, '30 Min'], [4, '1 Std'], [8, '2 Std']].map(([v, l]) => '<button data-act="minlauf" data-v="' + v + '" aria-pressed="' + (d.minLaufzeit === v) + '">' + l + '</button>').join('') + '</div>'
    + '<p class="leise">Schaltabstand: Die Box schaltet erst wieder aus, wenn die Bedingung deutlich nicht mehr gilt (beim Preis 0,5 ct/kWh). Das wählt VoltPilot selbst.</p></div></details>'
    + '<div class="warum" style="display:flex;gap:10px;align-items:flex-start">' + ic('shield', 18) + '<span>Schutzgrenzen, Netzanschluss und Ihre Eingriffe gehen immer vor. Eine Regel äußert einen Wunsch; die Box entscheidet vor Ort.</span></div>';
  const head = '<div class="sh-t"><span class="ico">' + ic('zap', 22) + '</span><h2>' + (sh.edit ? 'Regel ändern' : 'Neue Regel') + '<small>' + esc(d.name) + '</small></h2><button class="ibtn" data-act="zu" aria-label="Schließen">' + ic('x', 22) + '</button></div>';
  const foot = (sh.edit ? '<button class="btn sek" data-act="regel-weg">Löschen</button>' : '<button class="btn sek" data-act="zu">Abbrechen</button>') + '<button class="btn" data-act="regel-folgen">Weiter: Folgen</button>';
  return { head, body, foot, voll: true };
}

function blattRegelFolgen() {
  const sh = S.sheet; const d = sh.d;
  const cfg = entwurfCfg(d, sh.edit);
  const V = vorschau(cfg);
  const ohne = kopie(S.cfg); ohne.regeln = ohne.regeln.filter((r) => r.id !== sh.edit);
  const O = vorschau(ohne);
  const id = d.dann.g;
  const neu = SIM.laeufe(V, id, S.now, SIM.N); const alt = SIM.laeufe(O, id, S.now, SIM.N);
  const mit = SIM.summe(V, id, S.now, SIM.N); const vorher = SIM.summe(O, id, S.now, SIM.N);
  const passiert = [];
  const stdNeu = SIM.summe(V, id, S.now, SIM.N).stunden; const stdAlt = SIM.summe(O, id, S.now, SIM.N).stunden;
  passiert.push(esc(name(id)) + ' läuft ab jetzt bis morgen Abend ' + (stdNeu ? dauer(stdNeu * 4) : 'gar nicht') + ' statt ' + (stdAlt ? dauer(stdAlt * 4) : 'gar nicht') + (neu.length ? ': ' + spannenText(neu, 3) : '') + '.');
  const dk = mit.kwh - vorher.kwh; const de = mit.eur - vorher.eur;
  if (Math.abs(dk) > 0.05) passiert.push((dk > 0 ? 'Mehr' : 'Weniger') + ' Energie: ' + fKwh(Math.abs(dk)) + ', davon aus dem Netz ' + fKwh(Math.abs(mit.netzKwh - vorher.netzKwh)) + ' (' + (de >= 0 ? '≈ ' : '− ') + fEur(Math.abs(de)) + ' zum Börsenpreis)');
  const nachbarn = Object.keys(S.cfg.geraete).filter((x) => x !== id).map((x) => [x, SIM.summe(V, x, S.now, 96).stunden - SIM.summe(O, x, S.now, 96).stunden]).filter(([, dd]) => Math.abs(dd) >= 0.25);
  for (const [x, dd] of nachbarn) passiert.push(esc(name(x)) + ' heute ' + (dd > 0 ? '+' : '−') + dauer(Math.abs(dd) * 4) + ', weil der Sonnenstrom anders verteilt wird.');
  const body = '<p class="satz-p">' + regelSatz(d, true) + '</p>'
    + '<div class="folgen"><div class="fb"><b>Das passiert</b><ul>' + passiert.map((p) => '<li>' + p + '</li>').join('') + '</ul></div>'
    + '<div class="fb"><b>Das bleibt</b><ul><li>Schutzgrenzen, Netzanschluss und § 14a gehen vor.</li><li>Ihr Eingriff am Gerät geht vor.</li><li>Gemessenes bis jetzt ändert sich nicht.</li></ul></div>'
    + '<div class="fb"><b>Zurücknehmen</b><ul><li>Ausschalten wirkt sofort und fragt nicht nach. Die Regel bleibt gespeichert.</li></ul></div></div>'
    + '<label class="prow" style="padding:0 2px"><span>Name der Regel</span></label><input id="regel-name" value="' + esc(d.name) + '" style="min-height:46px;border-radius:12px;border:1px solid var(--field);padding:0 12px;font:600 16px var(--font);width:100%">';
  const head = '<div class="sh-t"><button class="ibtn" data-act="regel-zurueck" aria-label="Zurück">' + ic('chevL', 22) + '</button><h2>Folgen prüfen<small>' + esc(d.name) + '</small></h2><button class="ibtn" data-act="zu" aria-label="Schließen">' + ic('x', 22) + '</button></div>';
  const foot = '<button class="btn sek" data-act="regel-zurueck">Zurück</button><button class="btn" data-act="regel-an">' + ic('check', 18) + 'Regel aktivieren</button>';
  return { head, body, foot, voll: true };
}

function zeichneProbe(host) {
  const p = S.sheet && S.sheet.probe; if (!p) return;
  const W = Math.max(260, Math.round(host.clientWidth));
  const ticks = [0, 48, 96, 144, 192];
  const zb = zeitband(W, { id: 'probe', t0: 0, t1: SIM.N, R: p.V, klick: false, padT: 22, tage: true, label: 'Probelauf der Regel heute und morgen', bands: p.bands, rows: [{ id: p.id, h: 20 }], ticks });
  host.innerHTML = zb.svg.replace(/>0<\/text>/, '>0</text>');
}
function zeichneRegelstreifen(host, id) {
  const r = S.cfg.regeln.find((x) => x.id === id); if (!r) return;
  const W = Math.max(200, Math.round(host.clientWidth));
  const bits = regelZeiten(r, S.R, 0, 96);
  const bw = W / 96;
  let s = '<svg viewBox="0 0 ' + W + ' 12" width="' + W + '" height="12" aria-hidden="true"><rect x="0" y="3" width="' + W + '" height="6" rx="3" fill="#eef2f6"/>';
  bits.forEach((b, t) => { if (b) s += '<rect x="' + (t * bw).toFixed(1) + '" y="3" width="' + (bw + 0.3).toFixed(1) + '" height="6" fill="' + (r.an ? 'var(--load)' : '#94a3b8') + '"' + (t >= S.now ? ' fill-opacity=".5"' : '') + '/>'; });
  s += '<rect x="' + (S.now * bw).toFixed(1) + '" y="0" width="1.6" height="12" fill="var(--navy)"/></svg>';
  host.innerHTML = s;
}
