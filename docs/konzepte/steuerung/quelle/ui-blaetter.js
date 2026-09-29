/* ================= Blätter: Gerät, Ladeziel, Rahmen, Speicher, Vorrang, Katalog, Szene ================= */

function renderBlatt() {
  const host = document.getElementById('sheet-host');
  if (!S.sheet) { host.innerHTML = ''; return; }
  const alt = host.querySelector('.sh-body');
  const scroll = alt ? alt.scrollTop : 0;
  const f = document.activeElement;
  const fokusKey = f && host.contains(f) ? (f.id || (f.dataset && (f.dataset.act + '|' + (f.dataset.k || f.dataset.v || f.dataset.i || f.dataset.m || f.dataset.q || f.dataset.o || f.dataset.w || f.dataset.g || f.dataset.a || '')))) : null;
  const art = S.sheet.art;
  const fn = { geraet: blattGeraet, regel: blattRegel, ziel: blattZiel, lastmgmt: blattRahmen, speicher: blattSpeicher, immer: blattImmer, katalog: blattKatalog, szene: blattSzene, fahrzeug: blattFahrzeug, pause: blattPause }[art];
  const b = fn();
  host.innerHTML = '<div class="sheet-scrim" data-act="zu"></div><div class="sheet' + (b.voll ? ' voll' : '') + '" role="dialog" aria-modal="true" aria-labelledby="sh-titel"><div class="sh-head"><div class="grip"></div>' + b.head.replace('<h2>', '<h2 id="sh-titel">') + '</div><div class="sh-body">' + b.body + '</div>' + (b.foot ? '<div class="sh-foot">' + b.foot + '</div>' : '') + '</div>';
  const nb = host.querySelector('.sh-body');
  if (nb) nb.scrollTop = scroll;
  zeichneCharts(host);
  if (fokusKey) {
    let el = null;
    if (!fokusKey.includes('|')) el = document.getElementById(fokusKey);
    else {
      const [a, v] = fokusKey.split('|');
      el = [...host.querySelectorAll('[data-act="' + a + '"]')].find((x) => (x.dataset.k || x.dataset.v || x.dataset.i || x.dataset.m || x.dataset.q || x.dataset.o || x.dataset.w || x.dataset.g || x.dataset.a || '') === v);
    }
    if (el) el.focus({ preventScroll: true });
  }
}
const kopfZu = '<button class="ibtn" data-act="zu" aria-label="Schließen">' + ic('x', 22) + '</button>';
function kopf(iconName, titel, sub) {
  return '<div class="sh-t"><span class="ico">' + ic(iconName, 22) + '</span><h2>' + esc(titel) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</h2>' + kopfZu + '</div>';
}

/* ---------- Gerät ---------- */
const TYP_LABEL = { 'wallbox': 'Wallbox', 'ev-charger': 'Ladepunkt (OCPP)', 'heating-rod': 'Heizstab', 'heat-pump-sgready': 'Wärmepumpe (SG-Ready)', 'pump': 'Pumpe', 'generic-load': 'Steuerbare Last', 'modbus-load': 'Eigenes Schaltgerät (Modbus)' };
const FORM_LABEL = { stufenlos: 'stufenlos', stufig: 'in Stufen', schalten: 'ein/aus', programm: 'ein/aus mit Programm', freigabe: 'Freigabe-Kontakt' };
function artenFuer(g) {
  const A = {
    sonne: ['sun', g.form === 'freigabe' ? 'Anheben bei Sonne' : 'Mit Sonnenstrom', g.form === 'freigabe' ? 'SG-Ready-Freigabe bei Überschuss' : 'läuft bei Überschuss'],
    guenstig: ['euro', g.form === 'freigabe' ? 'Anheben, wenn günstig' : 'Günstige Stunden', 'unter einer Preisgrenze'],
    zeiten: ['clock', 'Feste Zeiten', 'täglich von … bis'],
    frist: ['flag', 'Fertig bis', 'Laufzeit bis zu einer Uhrzeit'],
    sofort: ['power', 'Ohne Steuerung', 'VoltPilot schaltet nicht'],
  };
  const je = {
    'heating-rod': ['sonne', 'guenstig', 'zeiten', 'frist', 'sofort'],
    'heat-pump-sgready': ['sonne', 'guenstig', 'sofort'],
    'pump': ['frist', 'zeiten', 'sonne', 'sofort'],
    'generic-load': ['sonne', 'guenstig', 'zeiten', 'frist', 'sofort'],
    'modbus-load': ['sonne', 'guenstig', 'zeiten', 'frist', 'sofort'],
  }[g.typ] || ['sonne', 'guenstig', 'zeiten', 'sofort'];
  /* was heute schon geht und was das Konzept neu braucht (SteuerartSatz.java) */
  const neu = { 'pump': ['sonne'], 'generic-load': ['frist'], 'modbus-load': ['frist'] }[g.typ] || [];
  return je.map((k) => ({ k, icon: A[k][0], t: A[k][1], s: A[k][2], neu: neu.includes(k) }));
}

function kette(id) {
  const t = S.now; const L = lage(id, t); const g = geraet(id);
  if (!L.an && !L.e) return '';
  const w = L.why || {};
  let wunsch = 'Smart: ' + auftragKurz(id);
  if (w.k === 'regel-an') wunsch = 'Regel „' + w.regel + '“';
  if (L.e) wunsch = 'Ihr Eingriff bis ' + uhrTag(L.e.bis);
  const soll = g && g.form === 'freigabe' ? 'Freigabe setzen' : g && g.fahrzeug ? 'Ladegrenze ' + fKw(L.kw) : g && g.form === 'stufig' ? 'Stufe ' + fKw(L.kw) : 'Einschalten';
  const antwort = !g ? 'Speicher meldet ' + fKw(Math.abs(L.kw)) : g.fahrzeug ? 'Ladepunkt meldet: lädt' : g.form === 'freigabe' ? 'Kontakt geschlossen (SG-Ready-Eingang 2)' : g.anschluss.includes('Shelly') ? 'Relais meldet: ein' : g.anschluss.includes('Modbus') ? 'Register gelesen: ein' : 'Ausgänge gesetzt';
  const gem = !g ? fKw(Math.abs(L.kw)) + ' gemessen' : g.gemessen ? fKw(L.kw) + ' gemessen' : g.form === 'freigabe' ? 'Leistung wird nicht gemessen' : 'nicht gemessen · angenommen ' + fKw(L.kw) + ' (Nennleistung)';
  const schritte = [
    ['check', 'Wunsch', wunsch + ' → ' + soll, ''],
    ['check', 'Box hat angenommen', pad(Math.floor(S.nowMin / 60)) + ':' + pad(S.nowMin % 60) + ' · keine Schutzgrenze aktiv', ''],
    ['check', 'Gerät hat bestätigt', antwort, ''],
    [g && !g.gemessen ? 'info' : 'check', 'Wirkung', gem, g && !g.gemessen ? 'leer' : ''],
  ];
  return '<ol class="kette" aria-label="Vom Wunsch zur Wirkung">' + schritte.map(([i, b, s, k]) => '<li><span class="k-dot ' + k + '">' + ic(i, 15) + '</span><span><b>' + b + '</b><span>' + esc(s) + '</span></span></li>').join('') + '</ol>';
}

function dreiSchalter(id) {
  const [a, b, c] = drei(id);
  const e = eingriff(id);
  const cur = e ? (e.art === 'aus' ? 'aus' : 'an') : 'smart';
  const sh = S.sheet;
  const sel = sh.modus || cur;
  const knopf = (k, l, i) => '<button data-act="modus3" data-m="' + k + '" aria-pressed="' + (sel === k) + '">' + ic(i, 20) + l + '</button>';
  let unter = '';
  if (sel !== 'smart' && sel !== cur) {
    const g = geraet(id);
    const dauern = [[2, '30 Min'], [4, '1 Std'], [8, '2 Std'], [16, '4 Std']];
    if (g && g.fahrzeug) dauern.push(['ab', 'bis Abstecken']);
    const dsel = sh.dauer || 4;
    const bis = dsel === 'ab' ? (sitzung(id, S.now) || { bis: S.now + 16 }).bis : S.now + dsel;
    const cfg = kopie(S.cfg); cfg.eingriffe = cfg.eingriffe.filter((x) => x.g !== id); cfg.eingriffe.push({ g: id, art: sel === 'aus' ? 'aus' : 'an', von: S.now, bis });
    const V = vorschau(cfg);
    const vor = id === 'sp' ? null : SIM.summe(S.R, id, S.now, bis); const nach = id === 'sp' ? null : SIM.summe(V, id, S.now, bis);
    const folge = id === 'sp' ? (sel === 'an' ? 'Der Speicher lädt aus dem Netz bis ' + uhrTag(bis) + ' (Ladestand danach ' + fPct(V.sp.soc[Math.min(bis, 191)]) + ').' : 'Der Speicher hält seinen Ladestand bis ' + uhrTag(bis) + '.')
      : (sel === 'an' ? 'Läuft bis ' + uhrTag(bis) + ': ' + fKwh(nach.kwh) + ', davon aus dem Netz ' + fKwh(nach.netzKwh) + ' (≈ ' + fEur(nach.eur) + ').' : 'Bleibt aus bis ' + uhrTag(bis) + (vor.kwh > 0.05 ? '; entfallen ' + fKwh(vor.kwh) + ' laut Plan.' : '.'));
    unter = '<div class="param"><div class="blk"><h3>Wie lange?</h3><div class="dauer" style="grid-template-columns:repeat(' + dauern.length + ',minmax(0,1fr))">' + dauern.map(([v, l]) => '<button data-act="dauer" data-v="' + v + '" aria-pressed="' + (dsel === v) + '">' + l + '</button>').join('') + '</div></div>'
      + '<p class="leise" style="color:var(--c-fg)"><b>Das passiert:</b> ' + folge + ' Danach wieder Smart. Schutzgrenzen gelten weiter.</p><button class="btn" data-act="eingriff-ok">' + ic('check', 18) + (sel === 'aus' ? a : c) + ' bis ' + uhrTag(bis) + '</button></div>';
  }
  return '<div class="lmodes" role="group" aria-label="Aus, Smart oder Ein" style="grid-template-columns:repeat(3,minmax(0,1fr))">' + knopf('aus', a, id === 'sp' ? 'lock' : 'pause') + knopf('smart', b, 'sun') + knopf('an', c, id === 'sp' ? 'down' : geraet(id) && geraet(id).fahrzeug ? 'rocket' : 'power') + '</div>' + unter;
}

function blattGeraet() {
  const sh = S.sheet; const id = sh.id;
  if (id === 'sp') return blattSpeicher();
  const g = S.cfg.geraete[id]; const d = sh.d;
  const L = lage(id, S.now);
  const heute = SIM.summe(S.R, id, 0, 96);
  const head = '<div class="sh-t"><span class="ico">' + ic(icon(id), 22) + '</span><h2>' + esc(name(id)) + '<small>' + esc(TYP_LABEL[g.typ]) + ' · ' + esc(g.anschluss) + '</small></h2>' + kopfZu + '</div>';
  let body = dreiSchalter(id);
  body += '<div class="blk"><h3>Jetzt <span class="pill ' + L.pill[0] + '"><i></i>' + L.pill[1] + (L.an && gemessen(id) ? ' · ' + fKw(L.kw) : '') + '</span></h3><div class="warum">' + warum(id, S.now, true) + (id === 'hs' ? '<small>Warmwasser gerade ' + fGrad(S.R.hsT[S.now]) + ' (Fühler)</small>' : '') + '</div>' + kette(id) + '</div>';
  body += '<div class="blk"><h3>Heute <span class="meta" style="text-transform:none;letter-spacing:0;font-weight:600">' + (heute.stunden ? dauer(heute.stunden * 4) + ' · ' + (g.gemessen ? fKwh(heute.kwh) : 'nicht gemessen') : 'lief nicht') + '</span></h3><div class="tl" data-chart="geraet" data-id="' + id + '"></div>'
    + (heute.kwh > 0.05 && g.gemessen ? '<p class="leise">Davon Sonne ' + fPct(heute.pvKwh / heute.kwh * 100) + ', Speicher ' + fPct(heute.spKwh / heute.kwh * 100) + ', Netz ' + fPct(heute.netzKwh / heute.kwh * 100) + ' (≈ ' + fEur(heute.eur) + ' zum Börsenpreis).</p>' : '') + '</div>';
  if (g.fahrzeug) {
    body += '<div class="blk"><h3>Smart heißt hier</h3><p>' + esc(auftragKurz(id)) + '. Ladeziel und Quelle stellen Sie im Reiter Laden ein.</p><button class="btn sek" data-act="tab" data-tab="laden">' + ic('car', 18) + 'Zum Reiter Laden</button></div>';
  } else {
    const a = d.auftrag;
    body += '<div class="blk"><h3>Smart heißt hier</h3><div class="arten" role="group" aria-label="Womit läuft das Gerät?">' + artenFuer(g).map((x) => '<button class="art" data-act="art" data-k="' + x.k + '" aria-pressed="' + (a.art === x.k) + '">' + ic(x.icon, 20) + '<b>' + x.t + '</b><small>' + x.s + '</small>' + (x.neu ? '<span class="gesp" style="color:#1d4ed8">neu für diesen Typ</span>' : '') + '</button>').join('') + '</div>' + paramPanel(g, d) + '</div>';
    if (g.ziel || id === 'hs') {
      body += '<div class="blk"><h3>Ziel</h3><div class="param"><div class="prow"><span>Warmwasser bis<small>misst: ' + esc(g.fuehler || 'kein Fühler') + '</small></span><span class="stp"><button data-act="ziel-t" data-d="-1" aria-label="kälter">' + ic('minus', 18) + '</button><output>' + fGrad(d.ziel.grad) + '</output><button data-act="ziel-t" data-d="1" aria-label="wärmer">' + ic('plus', 18) + '</button></span></div></div></div>';
    }
    const regeln = S.cfg.regeln.filter((r) => r.dann.g === id);
    const beds = (d.bedingungen || []);
    body += '<div class="blk"><h3>Bedingungen und Abhängigkeiten</h3><div class="bed">'
      + beds.map((b, i) => '<div class="bed-r"><span class="k ' + (b.art === 'danach' ? 'dann' : '') + '">' + (b.art === 'danach' ? 'danach' : 'nur wenn') + '</span><span>' + esc(b.text) + '</span><button class="x" data-act="bed-weg" data-i="' + i + '" aria-label="Bedingung entfernen">' + ic('x', 17) + '</button></div>').join('')
      + regeln.map((r) => '<div class="bed-r"><span class="k ' + (r.dann.a === 'sperren' ? 'nie' : '') + '">' + (r.dann.a === 'sperren' ? 'nie wenn' : 'auch wenn') + '</span><span>' + esc(r.wenn.map((c) => VARS[c.v].satz(c)).join(r.oder ? ' oder ' : ' und ')) + (r.an ? '' : ' (aus)') + '</span><button class="x" data-act="regel-offen" data-id="' + r.id + '" aria-label="Regel öffnen">' + ic('chevR', 17) + '</button></div>').join('')
      + (!beds.length && !regeln.length ? '<p class="leise">Keine. Das Gerät folgt nur seinem Smart-Auftrag.</p>' : '')
      + '</div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="tbtn" data-act="bed-neu" data-a="an">' + ic('plus', 16) + 'Auch wenn …</button><button class="tbtn" data-act="bed-neu" data-a="sperren">' + ic('plus', 16) + 'Nie wenn …</button></div></div>';
    body += '<div class="blk"><h3>Speicher</h3><div class="prow"><span>Speicher darf aushelfen<small>' + (d.speicherHilft ?? (g.gruppe !== 'waerme') ? 'Fehlt Sonne, deckt der Speicher den Rest.' : 'Fehlt Sonne, kommt der Rest aus dem Netz. Der Speicher bleibt fürs Haus.') + '</small></span><button class="sw" role="switch" data-act="sphilft" aria-checked="' + !!(d.speicherHilft ?? (g.gruppe !== 'waerme')) + '" aria-label="Speicher darf aushelfen"></button></div></div>';
  }
  const platz = S.cfg.reihenfolge.filter((x) => SIM.sonnig(S.cfg, x)).indexOf(id);
  body += '<div class="blk"><h3>Reihenfolge</h3><p>' + (platz >= 0 ? 'Platz ' + (platz + 1) + ' von ' + S.cfg.reihenfolge.filter((x) => SIM.sonnig(S.cfg, x)).length + ' für Sonnenstrom. Wer weiter oben steht, bekommt zuerst.' : 'Läuft nach Zeit, Frist oder Preis und steht deshalb nicht in der Reihenfolge. Pflichten gehen der Reihenfolge vor.') + '</p>' + (platz >= 0 ? '<button class="lnk" data-act="reo-von" data-id="' + id + '">Reihenfolge ändern ' + ic('chevR', 16) + '</button>' : '') + '</div>';
  body += '<details class="fein"><summary>' + ic('cpu', 18) + '<span>Technik<br><small>' + esc(TYP_LABEL[g.typ]) + ' · ' + FORM_LABEL[g.form] + '</small></span>' + ic('chevR', 18) + '</summary><div class="in"><p class="leise">Anbindung: ' + esc(g.anschluss) + '. Steuerform: ' + FORM_LABEL[g.form] + (g.stufen ? ' (' + g.stufen.map((x) => NF0.format(x)).join(' / ') + ' kW)' : g.bereiche ? ' (' + g.bereiche.map(([x, y]) => NF1.format(x) + '–' + NF1.format(y)).join(' und ') + ' kW)' : g.kw ? ' (' + fKw(g.kw) + ')' : '') + '. ' + (g.gemessen ? 'Leistung wird gemessen.' : 'Leistung wird nicht gemessen; Energie ist angenommen.') + ' Schalten ist für dieses Modell freigegeben. Bei Verbindungsverlust: ' + (g.typ === 'wallbox' ? 'Wallbox regelt selbst' : 'aus') + '. Mindestlaufzeit ' + (g.form === 'freigabe' ? '30 Min, Sperrzeit 20 Min' : '10 Min') + '.</p></div></details>';
  const geaendert = JSON.stringify(d) !== JSON.stringify(g);
  let foot = '';
  if (geaendert) {
    const cfg = kopie(S.cfg); cfg.geraete[id] = kopie(d);
    const V = vorschau(cfg);
    const neu = SIM.laeufe(V, id, S.now, 96); const alt = SIM.laeufe(S.R, id, S.now, 96);
    body += '<div class="ok-note" style="background:var(--c-bg);border:1px solid var(--c-border);color:var(--c-fg)">' + ic('info', 18) + '<span><b>Folgen ab jetzt:</b> läuft heute ' + (neu.length ? spannenText(neu, 3) : 'nicht mehr') + ' statt ' + (alt.length ? spannenText(alt, 3) : 'gar nicht') + '.</span></div>';
    foot = '<button class="btn sek" data-act="geraet-verwerfen">Verwerfen</button><button class="btn" data-act="geraet-ok">' + ic('check', 18) + 'Übernehmen</button>';
  }
  return { head, body, foot, voll: true };
}

function paramPanel(g, d) {
  const a = d.auftrag;
  const stp = (act, wert, minus, plus) => '<span class="stp"><button data-act="' + act + '" data-d="-1" aria-label="' + minus + '">' + ic('minus', 18) + '</button><output>' + wert + '</output><button data-act="' + act + '" data-d="1" aria-label="' + plus + '">' + ic('plus', 18) + '</button></span>';
  if (a.art === 'sonne') {
    const ab = a.ab != null ? a.ab : SIM.nenn(g);
    const txt = g.form === 'stufig' ? 'Nutzt ' + g.stufen.map((x) => NF0.format(x)).join(', ') + ' kW, je nach Überschuss.' : g.form === 'freigabe' ? 'Die Freigabe bleibt mindestens 30 Min; danach 20 Min Sperrzeit.' : 'Hört auf, wenn weniger als ' + fKw(ab * 0.75) + ' übrig sind.';
    return '<div class="param"><div class="prow"><span>Startet ab Überschuss<small>' + txt + '</small></span>' + stp('ab', fKw(ab), 'weniger', 'mehr') + '</div></div>';
  }
  if (a.art === 'guenstig') {
    let n = 0; for (let t = S.now; t < 96; t++) if (SIM.preis(t) < a.grenze) n++;
    return '<div class="param"><div class="prow"><span>Preisgrenze<small>heute ab jetzt ' + dauer(n) + ' darunter</small></span>' + stp('grenze', fCt(a.grenze), 'niedriger', 'höher') + '</div></div>';
  }
  if (a.art === 'zeiten') {
    return '<div class="param"><div class="prow"><span>von</span>' + stp('von', uhr(a.von), 'früher', 'später') + '</div><div class="prow"><span>bis</span>' + stp('bis', uhr(a.bis), 'früher', 'später') + '</div><div class="chips">' + [['taeglich', 'täglich'], ['werktags', 'werktags'], ['wochenende', 'Wochenende']].map(([k, l]) => '<button data-act="tage" data-v="' + k + '" aria-pressed="' + ((a.tage || 'taeglich') === k) + '">' + l + '</button>').join('') + '</div></div>';
  }
  if (a.art === 'frist') {
    const prog = g.form === 'programm';
    return '<div class="param">' + (prog ? '<p class="leise">Ein Programm läuft am Stück, etwa ' + dauer(g.profil.length) + '. VoltPilot wählt den besten Start.</p>' : '<div class="prow"><span>Laufzeit</span>' + stp('std', dauer((a.stunden || 1) * 4), 'kürzer', 'länger') + '</div>')
      + '<div class="prow"><span>fertig bis</span>' + stp('bis', uhr(a.bis), 'früher', 'später') + '</div>'
      + '<div class="chips">' + [['sonne', 'Sonne zuerst, dann günstig'], ['guenstig', 'nur günstig']].map(([k, l]) => '<button data-act="fquelle" data-v="' + k + '" aria-pressed="' + ((a.quelle || 'sonne') === k) + '">' + l + '</button>').join('') + '</div></div>';
  }
  return '<p class="leise">' + (g.form === 'freigabe' ? 'Die Wärmepumpe läuft nach ihrem eigenen Regler; VoltPilot hebt nicht an.' : 'Das Gerät läuft, wie es selbst will. VoltPilot misst nur.') + '</p>';
}

/* ---------- Ladeziel ---------- */
function blattZiel() {
  const sh = S.sheet; const id = sh.id; const g = S.cfg.geraete[id];
  const d = sh.d;
  const si = sitzung(id, S.now) || { von: (naechsteSitzung(id, S.now) || [S.now])[0], bis: (naechsteSitzung(id, S.now) || [0, S.now + 48])[1] };
  const zeiten = id === 'lp' ? [[120, '06:00'], [124, '07:00'], [128, '08:00']] : [[56, '14:00'], [64, '16:00'], [67, '16:45']];
  const cfg = kopie(S.cfg); cfg.geraete[id].auftrag = { art: 'frist', kwh: d.kwh, bis: d.bis, quelle: d.quelle };
  const V = vorschau(cfg);
  S.sheet.V = V;
  const sum = SIM.summe(V, id, S.now, d.bis);
  let fertig = null; for (let x = S.now; x < d.bis; x++) if (V.kw[id][x] > 0) fertig = x;
  const schafft = sum.kwh + 0.3 >= d.kwh;
  const head = kopf('flag', 'Ladeziel', name(id) + ' · ' + g.fahrzeug.name);
  const body = '<div class="blk"><h3>Wie viel?</h3><div class="chips">' + [10, 20, 30, 40].map((k) => '<button data-act="z-kwh" data-v="' + k + '" aria-pressed="' + (d.kwh === k) + '">+' + k + ' kWh</button>').join('') + '</div><p>Etwa ' + NF0.format(d.kwh * 6) + ' km. Den Ladestand des Autos kennt VoltPilot nicht; deshalb eine Menge.</p></div>'
    + '<div class="blk"><h3>Bis wann?</h3><div class="chips">' + zeiten.map(([t, l]) => '<button data-act="z-bis" data-v="' + t + '" aria-pressed="' + (d.bis === t) + '">' + (t >= 96 ? 'morgen ' : 'heute ') + l + '</button>').join('') + '</div></div>'
    + '<div class="blk"><h3>Womit?</h3><div class="chips">' + [['sonne', 'Sonne zuerst, dann günstig'], ['guenstig', 'nur günstige Stunden']].map(([k, l]) => '<button data-act="z-quelle" data-v="' + k + '" aria-pressed="' + (d.quelle === k) + '">' + l + '</button>').join('') + '</div></div>'
    + '<div class="blk"><h3>Plan</h3><div class="tl" data-chart="ziel" data-id="' + id + '"></div>'
    + '<div class="prev-sum"><div><b>' + (fertig != null ? uhrTag(fertig + 1) : '—') + '</b><small>voraussichtlich fertig</small></div><div><b>' + fKwh(sum.kwh) + '</b><small>' + (sum.kwh ? fPct(sum.pvKwh / sum.kwh * 100) + ' Sonne' : '') + '</small></div><div><b>' + (sum.netzKwh > 0.05 ? fCt(sum.eur * 100 / sum.netzKwh) : '—') + '</b><small>Ø Börse im Netzanteil</small></div></div>'
    + (!schafft ? '<div class="konflikt">' + ic('alert', 18) + '<span>Das reicht nicht ganz: bis ' + uhrTag(d.bis) + ' passen ' + fKwh(sum.kwh) + '. Früher anstecken oder später abfahren hilft.</span></div>' : '')
    + (V.plan && V.plan[id] && V.plan[id].vorlaeufig ? '<div class="konflikt">' + ic('info', 18) + '<span>Vorläufig: Die Börsenpreise für morgen kommen gegen 13 Uhr. Dann plant VoltPilot neu.</span></div>' : '')
    + '<p class="leise">Kommt das Auto später oder fährt früher, gilt das Ziel für die nächste Ladung. Eine Ladekarte kann eigene Ziele haben.</p></div>';
  const foot = (g.auftrag.art === 'frist' ? '<button class="btn sek" data-act="z-weg">Kein Ziel</button>' : '<button class="btn sek" data-act="zu">Abbrechen</button>') + '<button class="btn" data-act="z-ok">' + ic('check', 18) + 'Ziel übernehmen</button>';
  return { head, body, foot, voll: true };
}

/* ---------- Ladepark-Rahmen ---------- */
function blattRahmen() {
  const d = S.sheet.d;
  const head = kopf('gauge', 'Netzanschluss und Laden', 'Ladepark-Rahmen');
  const body = '<div class="blk"><h3>Anschlussgrenze</h3><div class="param"><div class="prow"><span>Ihr Netzanschluss<small>gehört Ihnen; VoltPilot hält ihn ein</small></span><span class="stp"><button data-act="r-kw" data-d="-1" aria-label="weniger">' + ic('minus', 18) + '</button><output>' + fKw(d.anschlussKw) + '</output><button data-act="r-kw" data-d="1" aria-label="mehr">' + ic('plus', 18) + '</button></span></div></div></div>'
    + '<div class="blk"><h3>Verteilung auf die Ladepunkte</h3><div class="chips">' + [['reihenfolge', 'nach Reihenfolge'], ['gleich', 'gleichmäßig, im Wechsel']].map(([k, l]) => '<button data-act="r-vert" data-v="' + k + '" aria-pressed="' + (d.verteilung === k) + '">' + l + '</button>').join('') + '</div><p>' + (d.verteilung === 'gleich' ? 'Reicht die Leistung nicht für alle, wechseln die Autos sich ab (Rotation). Keines lädt unter seiner Mindestleistung.' : 'Reicht die Leistung nicht, bekommt der obere Ladepunkt zuerst. Die Reihenfolge steht unter „Geräte“.') + '</p></div>'
    + '<div class="blk"><h3>Von der Box vorgegeben</h3><div class="tabwrap" style="border-radius:14px"><table class="doc" style="min-width:0;font-size:14px"><tbody>'
    + [['Sicherheitsabstand', fPct(S.cfg.abstandPct)], ['Mindestleistung je Auto', fKw(1.4)], ['Wechsel bei knapper Leistung', 'alle 15 Min'], ['Budget', 'gemessen am Netzanschluss'], ['§ 14a EnWG', 'kein Signal · Grenze gilt dann für alle']].map(([k, v]) => '<tr><th style="width:auto;font-size:14px">' + k + '</th><td style="text-align:right">' + v + '</td></tr>').join('')
    + '</tbody></table></div><p>Diese Werte stellt Ihr Installateur ein. Sie gelten auch, wenn die Cloud nicht erreichbar ist.</p></div>';
  const geaendert = d.anschlussKw !== S.cfg.anschlussKw || d.verteilung !== S.cfg.verteilung;
  const foot = geaendert ? '<button class="btn sek" data-act="zu">Abbrechen</button><button class="btn" data-act="r-ok">' + ic('check', 18) + 'Übernehmen</button>' : '';
  return { head, body, foot };
}

/* ---------- Speicher und Betriebsmodell ---------- */
function blattSpeicher() {
  const sh = S.sheet; const d = sh.d || (sh.d = kopie(S.cfg.speicher));
  const L = lage('sp', S.now);
  const head = kopf('battery', S.cfg.speicher.name, fKwh(S.cfg.speicher.kwh) + ' · ' + fKw(S.cfg.speicher.kw));
  const modelle = [
    ['eigenverbrauch', 'Eigenverbrauch', 'Möglichst viel eigener Strom im Haus. Grundform, ohne Betriebsmodell.', true],
    ['markt', 'Marktoptimierung', 'Lädt günstig aus dem Netz, gibt bei hohen Preisen ab. Braucht einen dynamischen Tarif.', true],
    ['spitze', 'Lastspitzenkappung', 'Nicht möglich: kein Leistungspreis hinterlegt.', false],
    ['atyp', 'Atypische Netznutzung', 'Noch nicht verfügbar.', false],
  ];
  let body = dreiSchalter('sp');
  body += '<div class="blk"><h3>Jetzt <span class="pill ' + L.pill[0] + '"><i></i>' + L.pill[1] + '</span></h3><div class="warum">' + warum('sp', S.now, true) + '</div></div>';
  body += '<div class="blk"><h3>Heute</h3><div class="tl" data-chart="soc"></div></div>';
  body += '<div class="blk"><h3>Betriebsmodell</h3><div class="arten" style="grid-template-columns:minmax(0,1fr)">' + modelle.map(([k, t, s, ok]) => '<button class="art" data-act="bm" data-k="' + k + '" aria-pressed="' + (d.modell === k) + '"' + (ok ? '' : ' disabled') + ' style="min-height:0"><b>' + t + '</b><small>' + s + '</small></button>').join('') + '</div></div>';
  body += '<div class="blk"><h3>Reserve</h3><div class="chips">' + [0.1, 0.2, 0.3].map((v) => '<button data-act="res" data-v="' + v + '" aria-pressed="' + (Math.abs(d.reserve - v) < 0.01) + '">' + fPct(v * 100) + '</button>').join('') + '</div><p>Darunter gibt der Speicher nichts ab. Für Stromausfall und Schonung.</p></div>';
  body += '<div class="blk"><h3>Reihenfolge</h3><p>Platz ' + (S.cfg.reihenfolge.filter((x) => SIM.sonnig(S.cfg, x)).indexOf('sp') + 1) + ' für Sonnenstrom.' + (S.cfg.speicherBis != null ? ' Ab ' + S.cfg.speicherBis + ' % bekommen die Autos zuerst.' : '') + '</p><button class="lnk" data-act="reo-von" data-id="sp">Reihenfolge ändern ' + ic('chevR', 16) + '</button></div>';
  const geaendert = JSON.stringify(d) !== JSON.stringify(S.cfg.speicher);
  let foot = '';
  if (geaendert) {
    const cfg = kopie(S.cfg); cfg.speicher = kopie(d);
    const V = vorschau(cfg);
    body += '<div class="ok-note" style="background:var(--c-bg);border:1px solid var(--c-border);color:var(--c-fg)">' + ic('info', 18) + '<span><b>Folgen:</b> Ladestand heute 20 Uhr ' + fPct(V.sp.soc[80]) + ' statt ' + fPct(S.R.sp.soc[80]) + ', morgen 7 Uhr ' + fPct(V.sp.soc[124]) + ' statt ' + fPct(S.R.sp.soc[124]) + '. Der Wechsel gilt ab der nächsten Viertelstunde.</span></div>';
    foot = '<button class="btn sek" data-act="sp-verwerfen">Verwerfen</button><button class="btn" data-act="sp-ok">' + ic('check', 18) + 'Übernehmen</button>';
  }
  return { head, body, foot, voll: true };
}

/* ---------- Was immer gilt ---------- */
function blattImmer() {
  const k = S.sheet.k;
  if (k === 'vorrang') {
    const stufen = [
      ['shield', 'Schutz und Pflichten des Netzes', 'Netzanschluss, § 14a, Geräteschutz (Mindestlaufzeit, Pause), Gerätegrenzen. Setzt die Box vor Ort durch, auch ohne Cloud.', '#b91c1c'],
      ['power', 'Ihr Eingriff', 'Aus oder Ein am Gerät, immer mit Ende: danach wieder Smart.', '#6d28d9'],
      ['zap', 'Ihre Regeln', 'Wenn … dann … Ausnahmen. „Bleibt aus“ gewinnt vor „einschalten“.', '#8b5cf6'],
      ['flag', 'Fristen und feste Zeiten', 'Was bis zu einer Uhrzeit fertig sein muss, läuft auch mit Netzstrom.', '#0e7490'],
      ['list', 'Reihenfolge für Sonnenstrom', 'Wer oben steht, bekommt den Überschuss zuerst. Reicht es nicht, darf ein kleineres Gerät weiter unten vor.', '#e65100'],
    ];
    const body = '<p class="leise" style="color:var(--c-fg)">Wenn zwei Dinge sich widersprechen, gewinnt das obere. So steht es auch in jedem „Warum?“ am Gerät.</p><ol class="kette">' + stufen.map(([i, t, s, c], n) => '<li><span class="k-dot" style="background:' + c + ';color:#fff">' + ic(i, 15) + '</span><span><b>' + (n + 1) + '. ' + t + '</b><span>' + s + '</span></span></li>').join('') + '</ol>'
      + '<div class="warum">Beispiel: Die Regel „Negativpreise mitnehmen“ schaltet den Heizstab ein. Erreicht das Warmwasser 60 °C, schaltet das Thermostat ab. Das Ziel ist Geräteschutz und gewinnt.</div>';
    return { head: kopf('shield', 'Wer gewinnt?', 'Vorrang in der Steuerung'), body };
  }
  if (k === 'p14a') return { head: kopf('pole', '§ 14a EnWG', 'Steuerbare Verbrauchseinrichtungen'), body: '<div class="warum">Heute kein Signal Ihres Netzbetreibers.</div><p class="leise">Dimmt der Netzbetreiber, gilt seine Grenze für Wallboxen, Wärmepumpe und Speicher zusammen (mindestens 4,2 kW bleiben). VoltPilot kürzt dann nach Ihrer Reihenfolge von unten und zeigt oben ein Band mit Ende. Jede Dimmung steht im Verlauf.</p><p class="leise">Heute beobachtet VoltPilot die Grenze nur. Ein eigener Empfänger für das Steuersignal ist Teil des Konzepts.</p>' };
  if (k === 'negativ') return { head: kopf('down', 'Negativpreis-Abregelung', 'läuft immer mit'), body: '<div class="warum">Kostet Strom an der Börse unter null, speist die Anlage nicht ein. Das schützt vor Kosten.</div><p class="leise">Besser als abregeln: den Strom selbst nutzen. Die Regel „Negativpreise mitnehmen“ schaltet dann Heizstab, Speicher oder Auto ein.</p><button class="btn sek" data-act="vorlage" data-id="v-neg">' + ic('plus', 18) + 'Regel aus Vorlage</button>' };
  if (k === 'lastmgmt') { S.sheet = { art: 'lastmgmt', d: { anschlussKw: S.cfg.anschlussKw, verteilung: S.cfg.verteilung } }; return blattRahmen(); }
  if (k === 'speicher') { S.sheet = { art: 'geraet', id: 'sp' }; return blattSpeicher(); }
  return { head: kopf('info', 'Hinweis'), body: '' };
}

/* ---------- Katalog aller Gerätearten ---------- */
function blattKatalog() {
  const w = S.sheet.wahl;
  const head = kopf('plus', 'Weiteres Gerät steuern', 'Was möchten Sie steuern?');
  if (w) {
    const v = KATALOG.find((x) => x.id === w);
    const body = '<div class="kk" style="border:0;padding:0"><div class="kk-h"><span class="ico">' + ic(v.icon, 22) + '</span><span><b>' + esc(v.name) + '</b><small>wird angelegt als: ' + esc(TYP_LABEL[v.typ] || v.typ) + '</small></span></div>'
      + '<p>' + esc(v.text) + '</p><div class="caps">' + v.kann.map((k) => '<span>' + esc(k) + '</span>').join('') + (v.nicht || []).map((k) => '<span class="x">' + esc(k) + '</span>').join('') + '</div>'
      + '<div class="blk"><h3>Vorschlag für Smart</h3><div class="satz" style="font-size:15px;font-weight:600">' + esc(v.smart) + '</div></div>'
      + '<div class="blk"><h3>So wird es angebunden</h3><p>' + esc(v.weg) + '</p></div></div>';
    return { head, body, foot: '<button class="btn sek" data-act="kat-zurueck">Zurück</button><button class="btn" data-act="hinweis" data-text="Im Portal: Anlage › Aufbau › Komponente anlegen, mit dieser Vorlage">' + ic('arrowR', 18) + 'Im Aufbau anlegen</button>', voll: true };
  }
  const gruppen = [...new Set(KATALOG.map((x) => x.gruppe))];
  const body = '<p class="leise" style="color:var(--c-fg)">Wählen Sie, was Sie kennen. VoltPilot legt den passenden Typ mit sinnvollen Vorgaben an.</p>'
    + gruppen.map((gr) => '<div class="blk"><h3>' + esc(gr) + '</h3><div class="cat-grid">' + KATALOG.filter((x) => x.gruppe === gr).map((x) => '<button class="cat" data-act="kat" data-id="' + x.id + '"><span class="ico">' + ic(x.icon, 20) + '</span><b>' + esc(x.name) + '</b><small>' + esc(x.kurz) + '</small></button>').join('') + '</div></div>').join('');
  return { head, body, voll: true };
}

/* ---------- Szene ---------- */
function blattSzene() {
  const sz = SZENEN.find((s) => s.id === S.sheet.id);
  const cfg = kopie(S.cfg); cfg.szene = sz.id;
  const V = vorschau(cfg);
  const zeilen = Object.entries(sz.wirkung).map(([id, w]) => {
    const alt = SIM.summe(S.R, id, S.now, SIM.N); const neu = SIM.summe(V, id, S.now, SIM.N);
    const was = w === 'aus' ? 'aus' : w.ziel ? 'Warmwasser nur bis ' + fGrad(w.ziel) : w.quelle ? 'nur günstige Stunden' : w.modus ? 'nur Sonnenstrom' : '';
    const d = neu.kwh - alt.kwh;
    return '<div class="bed-r"><span class="k" style="background:var(--c-muted);color:var(--navy)">' + ic(icon(id), 15) + '</span><span>' + esc(name(id)) + ': <b>' + esc(was) + '</b>' + (Math.abs(d) > 0.05 ? ' <span class="leise">(' + (d > 0 ? '+' : '−') + fKwh(Math.abs(d)) + ' bis morgen)</span>' : '') + '</span><span></span></div>';
  }).join('');
  const head = kopf(sz.icon, 'Szene ' + sz.name, sz.kurz);
  const body = '<div class="blk"><h3>Das passiert</h3><div class="bed">' + zeilen + '</div></div><div class="blk"><h3>Wie lange?</h3><div class="chips"><button aria-pressed="true">bis ich sie beende</button><button data-act="hinweis" data-text="Im Konzept: Ende als Datum (E6)">bis Datum …</button></div></div><div class="warum">Alles andere bleibt. Beenden wirkt sofort und fragt nicht nach.</div>';
  return { head, body, foot: '<button class="btn sek" data-act="zu">Abbrechen</button><button class="btn" data-act="szene-an" data-id="' + sz.id + '">' + ic('check', 18) + 'Szene einschalten</button>' };
}

/* ---------- Fahrzeug (Ladekarte) ---------- */
function blattFahrzeug() {
  const n = S.sheet.n;
  const head = kopf('car', n, 'Einstellung für diese Ladekarte');
  const body = '<div class="blk"><h3>Wenn diese Karte lädt</h3><div class="chips"><button aria-pressed="true">Smart</button><button aria-pressed="false">Schnell</button></div></div><div class="blk"><h3>Standard-Ziel</h3><div class="chips"><button aria-pressed="' + (n === 'Familienauto') + '">+30 kWh bis 07:00</button><button aria-pressed="' + (n !== 'Familienauto') + '">kein Ziel</button></div><p>Neu im Konzept: Heute kennt ein Fahrzeug nur „Sofort“ oder „Überschuss“, kein Ziel.</p></div>';
  return { head, body, foot: '<button class="btn" data-act="zu">Fertig</button>' };
}

/* ---------- Automatik pausieren ---------- */
function blattPause() {
  const head = kopf('pause', 'Automatik pausieren', 'für die ganze Anlage');
  const body = '<p class="leise" style="color:var(--c-fg)">Während der Pause schaltet VoltPilot nichts. Die Geräte fallen in ihren sicheren Zustand; Schutzgrenzen gelten weiter.</p><div class="dauer">' + [[2, '30 Min'], [4, '1 Std'], [8, '2 Std'], [16, '4 Std']].map(([v, l]) => '<button data-act="pause-ok" data-v="' + v + '">' + l + '</button>').join('') + '</div>';
  return { head, body };
}

/* ---------- Diagramme in Blättern und Karten ---------- */
function zeichneCharts(root) {
  root.querySelectorAll('[data-chart]').forEach((host) => {
    const art = host.dataset.chart; const id = host.dataset.id;
    if (art === 'tag') zeichneTagesbildIn(host);
    else if (art === 'lade') zeichneLadeplan(host, id, S.R);
    else if (art === 'probe') zeichneProbe(host);
    else if (art === 'regelstreifen') zeichneRegelstreifen(host, id);
    else if (art === 'geraet') {
      const W = Math.max(260, Math.round(host.clientWidth));
      host.innerHTML = zeitband(W, { id: 'g-' + id, t0: 0, t1: 96, klick: false, padT: 16, label: 'Heute: ' + name(id), bands: [{ art: 'pv', h: 18, gap: 4 }, { art: 'preis', h: 20, gap: 6 }], rows: [{ id, h: 20 }] }).svg;
    } else if (art === 'ziel') {
      const V = S.sheet && S.sheet.V; if (!V) return;
      const W = Math.max(260, Math.round(host.clientWidth));
      const t0 = S.now; const t1 = Math.min(SIM.N, Math.max(S.sheet.d.bis + 4, t0 + 24));
      const schritt = t1 - t0 <= 48 ? 8 : 16;
      const ticks = []; for (let k = 0; k <= t1 - t0; k++) if ((t0 + k) % schritt === 0) ticks.push(k);
      host.innerHTML = zeitband(W, { id: 'z-' + id, t0, t1, R: V, klick: false, padT: 22, tage: true, label: 'Ladeplan bis zum Ziel', bands: [{ art: 'pv', h: 18, gap: 4 }, { art: 'preis', h: 26, gap: 6 }], rows: [{ id, h: 20 }], ticks }).svg;
    } else if (art === 'soc') {
      const W = Math.max(260, Math.round(host.clientWidth));
      host.innerHTML = zeitband(W, { id: 'soc', t0: 0, t1: 96, klick: false, padT: 16, label: 'Ladestand heute', bands: [{ art: 'pv', h: 18, gap: 4 }, { art: 'soc', h: 30, gap: 6 }] }).svg;
    }
  });
}
