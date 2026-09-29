/* ================= Zusammenbau, Rendern, Bedienung ================= */

function istPausiert(t) { const p = S.cfg.pause; return p && (t == null ? S.now : t) >= p.von && (t == null ? S.now : t) < p.bis; }

function appHtml() {
  const laufen = Object.keys(S.cfg.geraete).filter((id) => S.R.kw[id][S.now] > 0).length;
  const regelnAn = S.cfg.regeln.filter((r) => r.an).length;
  const autos = LADER().filter((id) => sitzung(id, S.now)).length;
  const tabs = [['geraete', 'Geräte', laufen], ['laden', 'Laden', autos], ['regeln', 'Regeln', regelnAn]];
  const pausiert = istPausiert();
  let main = '';
  if (pausiert) main += '<div class="konflikt links" style="background:var(--st-hand-soft);color:#4c1d95">' + ic('pause', 18) + '<span><b>Automatik pausiert bis ' + uhrTag(S.cfg.pause.bis) + '.</b> Geräte sind im sicheren Zustand; Schutzgrenzen gelten weiter. <button class="lnk" data-act="pause" style="min-height:28px">Fortsetzen</button></span></div>';
  if (S.cfg.szene) {
    const sz = SZENEN.find((s) => s.id === S.cfg.szene);
    main += '<div class="konflikt links" style="background:var(--st-hand-soft);color:#4c1d95">' + ic(sz.icon, 18) + '<span><b>Szene „' + esc(sz.name) + '“ ist an.</b> ' + esc(sz.kurz) + '. <button class="lnk" data-act="szene" data-id="' + sz.id + '" style="min-height:28px">Beenden</button></span></div>';
  }
  if (S.tab === 'geraete') main += tabGeraete();
  else if (S.tab === 'laden') main += tabLaden();
  else main += tabRegeln();
  return '<div class="app">'
    + '<header class="app-top"><div class="site"><span class="site-name">' + esc(DATEN.anlage) + ic('chevD', 18) + '</span><span class="site-state"><i></i>Box verbunden · Daten von eben</span></div><span class="sp"></span><button class="ibtn" data-act="hinweis" data-text="Hilfe: Artikel „So funktioniert die Steuerung“" aria-label="Hilfe">' + ic('help', 22) + '</button><span class="avatar" aria-hidden="true">AB</span></header>'
    + '<div class="app-head"><h1>Steuerung</h1><button class="auto' + (pausiert ? ' aus' : '') + '" data-act="pause"><i></i>' + (pausiert ? 'pausiert bis ' + uhr(S.cfg.pause.bis) : 'Automatik an') + '</button></div>'
    + '<nav class="app-tabs" role="tablist" aria-label="Reiter der Steuerung">' + tabs.map(([k, l, n]) => '<button role="tab" data-act="tab" data-tab="' + k + '" aria-selected="' + (S.tab === k) + '">' + l + (n ? '<span class="n">' + n + '</span>' : '') + '</button>').join('') + '</nav>'
    + '<main class="app-main ' + S.tab + '">' + main + '</main>'
    + '<nav class="app-dock" aria-label="Bereiche"><span>' + ic('dashboard', 23) + 'Cockpit</span><span>' + ic('calendar', 23) + 'Fahrplan</span><span>' + ic('history', 23) + 'Verlauf</span><span class="on" aria-current="page">' + ic('zap', 23) + 'Steuerung</span><span>' + ic('layers', 23) + 'Anlage</span></nav>'
    + '</div>';
}

function renderApp() {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = appHtml();
  zeichneCharts(root);
  renderDesk();
}

/* ---------- Standardaufträge beim Wechsel der Art ---------- */
function standardAuftrag(g, k, alt) {
  if (k === 'sonne') return { art: 'sonne', ab: alt && alt.ab != null ? alt.ab : SIM.nenn(g) };
  if (k === 'guenstig') return { art: 'guenstig', grenze: alt && alt.grenze != null ? alt.grenze : (g.form === 'freigabe' ? 15 : 8.5) };
  if (k === 'zeiten') return { art: 'zeiten', von: 52, bis: 56, tage: 'taeglich' };
  if (k === 'frist') return { art: 'frist', stunden: g.form === 'programm' ? g.profil.length / 4 : 2, amStueck: g.form === 'programm', bis: 72, quelle: 'sonne', taeglich: g.typ === 'pump' };
  return { art: 'sofort' };
}

/* ---------- Klicks ---------- */
function klick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act; const id = el.dataset.id;
  const sh = S.sheet;
  const d = sh && sh.d;
  const nachher = (text) => { rechneAbJetzt(); renderApp(); if (S.sheet) renderBlatt(); if (text) toast(text); };
  switch (act) {
    case 'tab': if (S.sheet) blattZu(); S.tab = el.dataset.tab; S.sel = null; S.reo = null; S.tag = 0; renderApp(); scrollOben(); break;
    case 'tag': S.tag = Number(el.dataset.tag); S.sel = S.tag === 1 ? S.now + 96 - (S.now >= 96 ? 96 : 0) : null; if (S.tag === 1 && S.sel >= SIM.N) S.sel = 96 + 52; renderApp(); break;
    case 'jetzt': S.sel = null; S.tag = 0; renderApp(); break;
    case 'geraet': if (!id) break; blattAuf({ art: 'geraet', id, d: id === 'sp' ? kopie(S.cfg.speicher) : kopie(S.cfg.geraete[id]) }); break;
    case 'reo': S.reo = S.cfg.reihenfolge.filter((x) => SIM.sonnig(S.cfg, x)); renderApp(); zuListe(); break;
    case 'reo-von': blattZu(); S.tab = 'geraete'; S.reo = S.cfg.reihenfolge.filter((x) => SIM.sonnig(S.cfg, x)); renderApp(); zuListe(id); break;
    case 'hoch': reoBewegen(id, -1); break;
    case 'runter': reoBewegen(id, 1); break;
    case 'reo-abbruch': S.reo = null; renderApp(); zuListe(); break;
    case 'reo-ok': S.cfg.reihenfolge = [...S.reo, ...S.cfg.reihenfolge.filter((x) => !S.reo.includes(x))]; S.reo = null; nachher('Reihenfolge gespeichert. Gilt ab jetzt.'); zuListe(); break;
    case 'immer': {
      const k = el.dataset.k;
      if (k === 'speicher') blattAuf({ art: 'geraet', id: 'sp', d: kopie(S.cfg.speicher) });
      else if (k === 'lastmgmt') blattAuf({ art: 'lastmgmt', d: { anschlussKw: S.cfg.anschlussKw, verteilung: S.cfg.verteilung } });
      else blattAuf({ art: 'immer', k });
      break;
    }
    /* Neu in der Anlage verbunden: übernehmen, anders einstellen oder nur messen */
    case 'neu-ok': {
      const o = S.cfg.offen.find((x) => x.id === id);
      uebernehmen(S.cfg, id, o.vorschlag);
      nachher(esc(o.name) + ' wird ab jetzt gesteuert: ' + esc(auftragKurz(id)) + '.');
      break;
    }
    case 'neu-anders': { const o = S.cfg.offen.find((x) => x.id === id); blattAuf({ art: 'neu', id, d: { ...kopie(o), auftrag: kopie(o.vorschlag) } }); break; }
    case 'neu-start': { const n = name0(id); uebernehmen(S.cfg, id, sh.d.auftrag); blattZu(); nachher(esc(n) + ' wird ab jetzt gesteuert: ' + esc(auftragKurz(id)) + '.'); break; }
    case 'neu-nicht': { const o = S.cfg.offen.find((x) => x.id === id); o.zustand = 'nur'; if (S.sheet) blattZu(); renderApp(); toast(esc(o.name) + ' wird nur gemessen. Unter „noch nicht gesteuert“ lässt sich das jederzeit ändern.'); break; }
    case 'neu-wieder': { const o = S.cfg.offen.find((x) => x.id === id); o.zustand = 'neu'; renderApp(); const k = document.getElementById('neu-' + id); if (k) k.scrollIntoView({ block: 'center' }); break; }
    case 'anlage': { const o = S.cfg.offen.find((x) => x.id === id); toast('Im Portal: ' + esc(o.weg)); break; }
    case 'blatt': {
      const art = el.dataset.art;
      if (art === 'lastmgmt') blattAuf({ art, d: { anschlussKw: S.cfg.anschlussKw, verteilung: S.cfg.verteilung } });
      else if (art === 'ziel') {
        const a = S.cfg.geraete[id].auftrag;
        blattAuf({ art, id, d: a.art === 'frist' ? { kwh: a.kwh, bis: a.bis, quelle: a.quelle } : { kwh: 20, bis: id === 'lp' ? 124 : 64, quelle: 'sonne' } });
      } else if (art === 'fahrzeug') blattAuf({ art, n: el.dataset.n });
      else if (art === 'anbinden') blattAuf({ art });
      break;
    }
    case 'hinweis': toast(esc(el.dataset.text)); break;
    case 'pause':
      if (istPausiert()) { S.cfg.pause = null; if (S.sheet) blattZu(); nachher('Automatik läuft wieder.'); }
      else blattAuf({ art: 'pause' });
      break;
    case 'pause-ok': S.cfg.pause = { von: S.now, bis: S.now + Number(el.dataset.v) }; blattZu(); nachher('Automatik pausiert bis ' + uhrTag(S.cfg.pause.bis) + '.'); break;
    case 'zu': blattZu(); break;

    /* Gerät: Aus · Smart · Ein */
    case 'modus3': {
      const m = el.dataset.m; const gid = sh.id;
      const hatte = eingriff(gid);
      if (m === 'smart') {
        sh.modus = null;
        if (hatte) { S.cfg.eingriffe = S.cfg.eingriffe.filter((x) => x.g !== gid); nachher(esc(name(gid)) + ' läuft wieder Smart.'); } else renderBlatt();
      } else { sh.modus = m; sh.dauer = sh.dauer || (geraet(gid) && geraet(gid).fahrzeug ? 'ab' : 4); renderBlatt(); }
      break;
    }
    case 'dauer': sh.dauer = el.dataset.v === 'ab' ? 'ab' : Number(el.dataset.v); renderBlatt(); break;
    case 'eingriff-ok': {
      const gid = sh.id;
      const bis = sh.dauer === 'ab' ? (sitzung(gid, S.now) || { bis: S.now + 16 }).bis : S.now + sh.dauer;
      S.cfg.eingriffe = S.cfg.eingriffe.filter((x) => x.g !== gid);
      S.cfg.eingriffe.push({ g: gid, art: sh.modus === 'aus' ? 'aus' : 'an', von: S.now, bis });
      const [a, , c] = drei(gid);
      sh.modus = null;
      nachher(esc(name(gid)) + ': ' + (S.cfg.eingriffe[S.cfg.eingriffe.length - 1].art === 'aus' ? a : c) + ' bis ' + uhrTag(bis) + '. Danach wieder Smart.');
      break;
    }
    case 'art': sh.d.auftrag = standardAuftrag(sh.d, el.dataset.k, sh.d.auftrag); renderBlatt(); break;
    case 'ab': d.auftrag.ab = Math.max(0.5, Math.min(8, (d.auftrag.ab != null ? d.auftrag.ab : SIM.nenn(d)) + 0.5 * Number(el.dataset.d))); renderBlatt(); break;
    case 'grenze': d.auftrag.grenze = Math.max(-2, Math.min(30, d.auftrag.grenze + 0.5 * Number(el.dataset.d))); renderBlatt(); break;
    case 'von': d.auftrag.von = (d.auftrag.von + 2 * Number(el.dataset.d) + 96) % 96; renderBlatt(); break;
    case 'bis': {
      const a = d.auftrag; const lo = a.art === 'frist' ? Math.max(S.now + 2, 28) : 0;
      a.bis = a.art === 'frist' ? Math.max(lo, Math.min(a.bis >= 96 ? 190 : 95, a.bis + 2 * Number(el.dataset.d))) : (a.bis + 2 * Number(el.dataset.d) + 96) % 96;
      renderBlatt(); break;
    }
    case 'std': d.auftrag.stunden = Math.max(0.5, Math.min(12, (d.auftrag.stunden || 1) + 0.5 * Number(el.dataset.d))); renderBlatt(); break;
    case 'tage': d.auftrag.tage = el.dataset.v; renderBlatt(); break;
    case 'fquelle': d.auftrag.quelle = el.dataset.v; renderBlatt(); break;
    case 'ziel-t': d.ziel = d.ziel || { art: 'temp', grad: 60 }; d.ziel.grad = Math.max(40, Math.min(70, d.ziel.grad + Number(el.dataset.d))); renderBlatt(); break;
    case 'bed-weg': d.bedingungen.splice(Number(el.dataset.i), 1); renderBlatt(); break;
    case 'bed-neu': {
      const r = neuerEntwurf(null, sh.id);
      r.dann.a = el.dataset.a;
      if (el.dataset.a === 'an') { r.wenn = [{ v: 'preis', op: 'unter', w: 5 }]; r.name = 'Auch wenn günstig'; }
      blattAuf({ art: 'regel', d: r, edit: null, schritt: 'bau', fokus: 'w0v', von: { art: 'geraet', id: sh.id } });
      break;
    }
    case 'sphilft': { const g = S.cfg.geraete[sh.id]; const cur = d.speicherHilft ?? (g.gruppe !== 'waerme'); d.speicherHilft = !cur; renderBlatt(); break; }
    case 'geraet-verwerfen': sh.d = kopie(S.cfg.geraete[sh.id]); renderBlatt(); break;
    case 'geraet-ok': S.cfg.geraete[sh.id] = kopie(d); sh.d = kopie(d); nachher('Übernommen. Gilt ab jetzt; Gemessenes bleibt.'); break;
    case 'bm': d.modell = el.dataset.k; renderBlatt(); break;
    case 'res': d.reserve = Number(el.dataset.v); renderBlatt(); break;
    case 'sp-verwerfen': sh.d = kopie(S.cfg.speicher); renderBlatt(); break;
    case 'sp-ok': S.cfg.speicher = kopie(d); sh.d = kopie(d); nachher('Speicher übernommen. Gilt ab der nächsten Viertelstunde.'); break;

    /* Laden */
    case 'lmodus': {
      const m = el.dataset.m;
      if (m === 'smart') { if (eingriff(id)) { S.cfg.eingriffe = S.cfg.eingriffe.filter((x) => x.g !== id); nachher(esc(name(id)) + ' lädt wieder Smart.'); } break; }
      blattAuf({ art: 'geraet', id, d: kopie(S.cfg.geraete[id]), modus: m === 'aus' ? 'aus' : 'an', dauer: 'ab' });
      break;
    }
    case 'lquelle': {
      const a = S.cfg.geraete[id].auftrag; const q = el.dataset.q;
      if (a.art === 'frist') { a.quelle = q === 'guenstig' ? 'guenstig' : 'sonne'; a.modus = q === 'min' ? 'min' : 'nur'; }
      else if (q === 'guenstig') S.cfg.geraete[id].auftrag = { art: 'guenstig', grenze: a.grenze || 9 };
      else S.cfg.geraete[id].auftrag = { art: 'sonne', modus: q === 'min' ? 'min' : 'nur' };
      rechneAbJetzt();
      const s = SIM.summe(S.R, id, S.now, 96);
      renderApp(); toast(esc(name(id)) + ': ' + ({ sonne: 'nur Sonne', min: 'Sonne + Minimum', guenstig: 'günstige Stunden' }[q]) + '. Heute ab jetzt ' + (s.stunden ? dauer(s.stunden * 4) + ' laden' : 'kein Laden mehr') + '.');
      break;
    }
    case 'spbis': S.cfg.speicherBis = el.dataset.v === '' ? null : Number(el.dataset.v); nachher(S.cfg.speicherBis == null ? 'Speicher hat immer Vorrang.' : 'Speicher zuerst bis ' + S.cfg.speicherBis + ' %, dann die Autos.'); break;
    case 'z-kwh': d.kwh = Number(el.dataset.v); renderBlatt(); break;
    case 'z-bis': d.bis = Number(el.dataset.v); renderBlatt(); break;
    case 'z-quelle': d.quelle = el.dataset.v; renderBlatt(); break;
    case 'z-ok': S.cfg.geraete[sh.id].auftrag = { art: 'frist', kwh: d.kwh, bis: d.bis, quelle: d.quelle, modus: 'nur' }; blattZu(); nachher('Ladeziel: +' + d.kwh + ' kWh bis ' + uhrTag(d.bis) + '.'); break;
    case 'z-weg': S.cfg.geraete[sh.id].auftrag = d.quelle === 'guenstig' ? { art: 'guenstig', grenze: 9 } : { art: 'sonne', modus: 'nur' }; blattZu(); nachher('Kein Ladeziel mehr. Lädt, wenn es passt.'); break;
    case 'r-kw': d.anschlussKw = Math.max(11, Math.min(63, d.anschlussKw + Number(el.dataset.d))); renderBlatt(); break;
    case 'r-vert': d.verteilung = el.dataset.v; renderBlatt(); break;
    case 'r-ok': S.cfg.anschlussKw = d.anschlussKw; S.cfg.verteilung = d.verteilung; blattZu(); nachher('Rahmen übernommen.'); break;

    /* Regeln */
    case 'neue-regel': blattAuf({ art: 'regel', d: neuerEntwurf(), edit: null, schritt: 'bau', fokus: null }); break;
    case 'vorlage': blattAuf({ art: 'regel', d: neuerEntwurf(id), edit: null, schritt: 'bau', fokus: null }); break;
    case 'szene':
      if (S.cfg.szene === id) { S.cfg.szene = null; nachher('Szene beendet. Alles wieder wie vorher.'); }
      else blattAuf({ art: 'szene', id });
      break;
    case 'szene-an': S.cfg.szene = id; blattZu(); nachher('Szene „' + esc(SZENEN.find((s) => s.id === id).name) + '“ ist an.'); break;
    case 'regel-offen': { const r = S.cfg.regeln.find((x) => x.id === id); if (r) blattAuf({ art: 'regel', d: kopie(r), edit: r.id, schritt: 'bau', fokus: null }); break; }
    case 'regel-schalter': {
      const r = S.cfg.regeln.find((x) => x.id === id);
      if (r.an) { r.an = false; nachher('Regel „' + esc(r.name) + '“ ist aus. Sie bleibt gespeichert.'); }
      else blattAuf({ art: 'regel', d: { ...kopie(r), an: true }, edit: r.id, schritt: 'folgen', fokus: null });
      break;
    }
    case 'tok': sh.fokus = sh.fokus === el.dataset.k ? null : el.dataset.k; renderBlatt(); break;
    case 'wahl-var': { const i = Number(el.dataset.i); const v = el.dataset.v; d.wenn[i] = { v, op: VARS[v].ops[0], w: kopie(VARS[v].def) }; sh.fokus = 'w' + i + 'w'; renderBlatt(); break; }
    case 'wahl-op': d.wenn[Number(el.dataset.i)].op = el.dataset.o; sh.fokus = 'w' + el.dataset.i + 'w'; renderBlatt(); break;
    case 'wahl-wert': d.wenn[Number(el.dataset.i)].w = el.dataset.w; sh.fokus = null; renderBlatt(); break;
    case 'schritt': { const c = d.wenn[Number(el.dataset.i)]; const V = VARS[c.v]; c.w = Math.max(V.min, Math.min(V.max, Math.round((c.w + V.schritt * Number(el.dataset.d)) * 100) / 100)); renderBlatt(); break; }
    case 'zeit': { const c = d.wenn[Number(el.dataset.i)]; const j = Number(el.dataset.j); c.w[j] = (c.w[j] + Number(el.dataset.d) + 96) % 96; renderBlatt(); break; }
    case 'wahl-dg': d.dann.g = el.dataset.g; if (!tatenFuer(d.dann.g).some((x) => x[0] === d.dann.a)) d.dann.a = 'an'; sh.fokus = 'da'; renderBlatt(); break;
    case 'wahl-da': d.dann.a = el.dataset.a; sh.fokus = null; renderBlatt(); break;
    case 'undoder': d.oder = !d.oder; renderBlatt(); break;
    case 'plus-bed': d.wenn.push({ v: 'sonne', op: 'ueber', w: 2 }); sh.fokus = 'w' + (d.wenn.length - 1) + 'v'; renderBlatt(); break;
    case 'weg-bed': d.wenn.splice(Number(el.dataset.i), 1); sh.fokus = null; renderBlatt(); break;
    case 'minlauf': d.minLaufzeit = Number(el.dataset.v); renderBlatt(); break;
    case 'regel-folgen': sh.schritt = 'folgen'; renderBlatt(); oben(); break;
    case 'regel-zurueck': sh.schritt = 'bau'; renderBlatt(); oben(); break;
    case 'regel-an': {
      const inp = document.getElementById('regel-name');
      if (inp && inp.value.trim()) d.name = inp.value.trim();
      d.an = true;
      S.cfg.regeln = S.cfg.regeln.filter((r) => r.id !== sh.edit && r.id !== d.id);
      S.cfg.regeln.push(kopie(d));
      const von = sh.von;
      rechneAbJetzt();
      const bits = regelZeiten(d, S.R, S.now, SIM.N);
      const naechst = bits.indexOf(true);
      if (von) { blattAuf({ art: 'geraet', id: von.id, d: kopie(S.cfg.geraete[von.id]) }); }
      else { blattZu(); S.tab = 'regeln'; }
      renderApp();
      toast('Regel „' + esc(d.name) + '“ ist aktiv. ' + (naechst === 0 ? 'Sie greift jetzt.' : naechst > 0 ? 'Greift als Nächstes ' + uhrTag(S.now + naechst) + '.' : 'Sie greift bis morgen Abend nicht.'));
      break;
    }
    case 'regel-weg':
      if (!sh.loeschen) { sh.loeschen = true; el.textContent = 'Endgültig löschen'; el.style.color = 'var(--c-destructive)'; el.style.boxShadow = 'inset 0 0 0 1.5px var(--c-destructive)'; break; }
      S.cfg.regeln = S.cfg.regeln.filter((r) => r.id !== sh.edit); blattZu(); nachher('Regel gelöscht.');
      break;
    default: break;
  }
}
function name0(id) { const o = S.cfg.offen.find((x) => x.id === id); return o ? o.name : name(id); }
function scrollOben() {
  const scr = document.querySelector('.phone>.screen');
  if (scr && getComputedStyle(scr).overflowY !== 'visible') scr.scrollTop = 0;
  else { const ph = document.getElementById('phone'); if (ph && ph.getBoundingClientRect().top < 0) ph.scrollIntoView({ block: 'start' }); }
}
function zuListe(id) {
  const el = document.getElementById(id ? 'reo-' + id : 'devs') || document.getElementById('devs');
  if (el) el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
function oben() { const b = document.querySelector('#sheet-host .sh-body'); if (b) b.scrollTop = 0; }

/* Schieberegler im Baukasten: Wert folgt dem Finger, der Probelauf rechnet mit */
function eingabe(e) {
  const el = e.target;
  if (el.dataset && el.dataset.act === 'rng' && S.sheet && S.sheet.d) {
    const c = S.sheet.d.wenn[Number(el.dataset.i)];
    c.w = Number(el.value);
    clearTimeout(eingabe.t);
    const out = document.getElementById('rng-out'); if (out) out.textContent = wertText(c);
    eingabe.t = setTimeout(renderBlatt, 60);
  }
}

/* Tastatur: Escape schließt das Blatt, Tab bleibt im Blatt */
function taste(e) {
  if (!S.sheet) return;
  if (e.key === 'Escape') { e.preventDefault(); blattZu(); return; }
  if (e.key !== 'Tab') return;
  const host = document.getElementById('sheet-host');
  const f = [...host.querySelectorAll('button:not([disabled]), input, [tabindex="0"], summary')].filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0]; const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function start() {
  S.cfg = SIM.startKonfig();
  rechneAlles();
  const phone = document.getElementById('phone');
  renderApp();
  phone.addEventListener('click', klick);
  phone.addEventListener('input', eingabe);
  document.addEventListener('keydown', taste);
  tagesbildBedienung(phone);
  reoZiehen(phone);
  konzeptStart();
  let breite = window.innerWidth;
  window.addEventListener('resize', () => {
    if (Math.abs(window.innerWidth - breite) < 8) return;
    breite = window.innerWidth;
    clearTimeout(start.rt); start.rt = setTimeout(() => { renderApp(); if (S.sheet) renderBlatt(); deskSkala(); }, 120);
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
