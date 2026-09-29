/* Die Rechnung hinter dem Prototyp: je Viertelstunde, welches Gerät läuft, mit welcher
   Leistung, woher der Strom kommt und warum. Vereinfacht, aber nach den Vorrang-Regeln
   des Konzepts: Schutz › Ihr Eingriff › Regel › Pflicht (feste Zeit, Frist, günstig) ›
   Reihenfolge für Sonnenstrom. Gemessenes (vor „jetzt“) ändert sich nie: neue Einstellungen
   rechnen ab jetzt, die Vergangenheit bleibt, wie sie war. */
const SIM = (() => {
  const D = DATEN;
  const N = 192;
  const tag = (t) => D.tage[t < 96 ? 0 : 1];
  const preis = (t) => tag(t).preis[t % 96];
  const pv = (t) => tag(t).pv[t % 96];
  const last = (t) => tag(t).last[t % 96];
  const temp = (t) => tag(t).temp[t % 96];
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const r2 = (v) => Math.round(v * 100) / 100;

  function startKonfig() {
    return {
      geraete: Object.fromEntries(GERAETE.map((g) => [g.id, clone(g)])),
      reihenfolge: [...REIHENFOLGE],
      regeln: clone(REGELN),
      speicher: clone(SPEICHER),
      eingriffe: [],
      szene: null,
      pause: null,
      anschlussKw: D.netzanschlussKw,
      abstandPct: 10,
      verteilung: 'reihenfolge',
      speicherBis: null,
      offen: clone(OFFEN),
    };
  }

  /* Der wirksame Auftrag eines Geräts: Auftrag der Konfiguration, verändert durch eine Szene. */
  function wirk(cfg, id) {
    const g = cfg.geraete[id];
    const a = { ...g.auftrag };
    let ziel = g.ziel ? { ...g.ziel } : null;
    let aus = false;
    const sz = cfg.szene && SZENEN.find((s) => s.id === cfg.szene);
    if (sz && sz.wirkung[id]) {
      const w = sz.wirkung[id];
      if (w === 'aus') aus = true;
      else {
        if (w.ziel && ziel) ziel.grad = w.ziel;
        if (w.quelle) a.quelle = w.quelle;
        if (w.modus) a.modus = w.modus;
      }
    }
    return { g, a, ziel, aus };
  }

  /* Nimmt ein Gerät am Sonnenstrom nach Reihenfolge teil? */
  function sonnig(cfg, id) {
    if (id === 'sp') return true;
    const { a, g } = wirk(cfg, id);
    if (a.art === 'sonne') return true;
    if (a.art === 'frist' && a.quelle === 'sonne' && !a.amStueck && g.form !== 'programm') return true;
    return false;
  }

  function plugged(g, t) {
    if (!g.fahrzeug) return true;
    return g.fahrzeug.da.some(([a, b]) => t >= a && t < b);
  }

  /* Leistung, die ein Gerät bei „frei“ kW Überschuss nimmt (0 = läuft nicht). */
  function passend(g, frei, lief, modus) {
    if (g.form === 'stufenlos') {
      if (g.fahrzeug && g.fahrzeug.maxKw) frei = Math.min(frei, g.fahrzeug.maxKw);
      const [lo] = g.bereiche[0];
      if (frei < lo) {
        if (modus === 'min') return lo;
        if (lief && frei >= lo * 0.75) return lo;
        return 0;
      }
      let best = 0;
      for (const [a, b] of g.bereiche) {
        if (frei >= a) best = Math.min(frei, b);
      }
      return r2(best);
    }
    if (g.form === 'stufig') {
      let best = 0;
      for (const s of g.stufen) if (frei + (lief ? 0.25 * s : 0) >= s) best = s;
      return best;
    }
    return 0;
  }
  const nenn = (g) => g.form === 'stufenlos' ? Math.min(g.bereiche[g.bereiche.length - 1][1], (g.fahrzeug && g.fahrzeug.maxKw) || 99)
    : g.form === 'stufig' ? g.stufen[g.stufen.length - 1]
    : g.form === 'programm' ? g.profil[0]
    : g.form === 'freigabe' ? g.mehrKw : g.kw;

  /* ---------- Bedingungen von Regeln ---------- */
  const GUENSTIGSTE = {};
  function rangSlots(t, stunden) {
    const d = t < 96 ? 0 : 1;
    const key = d + ':' + stunden;
    if (!GUENSTIGSTE[key]) {
      const idx = [...Array(96).keys()].sort((a, b) => D.tage[d].preis[a] - D.tage[d].preis[b]);
      GUENSTIGSTE[key] = new Set(idx.slice(0, Math.round(stunden * 4)).map((i) => i + d * 96));
    }
    return GUENSTIGSTE[key].has(t);
  }
  function bedingung(c, t, st, ctx) {
    const cmp = (x) => (c.op === 'unter' ? x < c.w : c.op === 'ueber' ? x > c.w : c.op === 'ist' ? x === c.w : false);
    switch (c.v) {
      case 'preis': { if (t >= 96 && !ctx.morgenBekannt) return null; return cmp(preis(t)); }
      case 'rang': { if (t >= 96 && !ctx.morgenBekannt) return null; return rangSlots(t, c.w); }
      case 'sonne': return cmp(Math.max(0, pv(t) - last(t)));
      case 'pv': return cmp(pv(t));
      case 'soc': return cmp(st.soc * 100);
      case 'temp': return cmp(temp(t));
      case 'zeit': {
        const m = t % 96; const [a, b] = c.w;
        return a <= b ? (m >= a && m < b) : (m >= a || m < b);
      }
      case 'geraet': return c.op === 'laeuft' ? !!st.on[c.w] : !st.on[c.w];
      case 'auto': return plugged(GERAETE.find((g) => g.id === c.w) || GERAETE[1], t);
      case 'szene': return ctx.szene === c.w;
      default: return null;
    }
  }
  function regelGilt(r, t, st, ctx) {
    const vals = r.wenn.map((c) => bedingung(c, t, st, ctx));
    if (r.oder) return vals.some((v) => v === true);
    if (vals.some((v) => v === null)) return false; /* unbekannt startet nie */
    return vals.every(Boolean);
  }

  /* ---------- Fristen planen ---------- */
  function fristFenster(g, a, from) {
    const out = [];
    if (g.fahrzeug) {
      for (const [x, y] of g.fahrzeug.da) {
        const ende = Math.min(y, a.bis);
        if (a.bis > x && a.bis <= y + 1 && ende > from) out.push([Math.max(x, from), ende, x]);
      }
      return out;
    }
    const tage = a.taeglich ? [0, 96] : [0];
    for (const d of tage) {
      const x = d + (a.von || 0); const y = d + a.bis;
      if (y > from) out.push([Math.max(x, from), y, x]);
    }
    return out;
  }

  function planeFristen(cfg, A, from, st0, ctx) {
    const plan = {};
    const blockEnde = {};
    const ids = Object.keys(cfg.geraete);
    const hatDanach = (id) => (cfg.geraete[id].bedingungen || []).some((b) => b.art === 'danach');
    const reihe = [...ids.filter((id) => !hatDanach(id)), ...ids.filter(hatDanach)];
    for (const id of reihe) {
      const { g, a, aus } = wirk(cfg, id);
      if (aus || a.art !== 'frist') continue;
      const p = { slots: new Set(), vorlaeufig: false, fenster: [] };
      for (const [ws0, we, start] of fristFenster(g, a, from)) {
        let ws = ws0;
        const danach = (g.bedingungen || []).find((b) => b.art === 'danach');
        if (danach) {
          if (blockEnde[danach.geraet] == null) continue;
          ws = Math.max(ws, blockEnde[danach.geraet]);
        }
        p.fenster.push([ws, we]);
        const gekostet = (t) => {
          if (t >= 96 && !ctx.morgenBekannt) { p.vorlaeufig = true; return 10.5; }
          return preis(t);
        };
        if (g.form === 'programm' || a.amStueck) {
          const L = g.form === 'programm' ? g.profil.length : a.stunden * 4;
          const lief = st0.prog[id];
          if (lief && lief.start < from && lief.k < L) {
            for (let t = lief.start; t < lief.start + L; t++) p.slots.add(t);
            blockEnde[id] = lief.start + L;
            continue;
          }
          if (st0.fertig[id + ':' + start]) { blockEnde[id] = st0.fertig[id + ':' + start]; continue; }
          let best = null; let bestK = Infinity;
          for (let s = ws; s + L <= we; s++) {
            let k = 0;
            for (let j = 0; j < L; j++) {
              const t = s + j; const kw = g.form === 'programm' ? g.profil[j] : g.kw;
              const frei = a.quelle === 'sonne' ? (A.frei[t] || 0) : 0;
              const netzAnteil = Math.max(0, kw - frei);
              k += netzAnteil * 0.25 * gekostet(t) + j * 0.0001;
            }
            if (k < bestK - 1e-9) { bestK = k; best = s; }
          }
          if (best != null) {
            for (let t = best; t < best + L; t++) p.slots.add(t);
            blockEnde[id] = best + L;
          }
          continue;
        }
        /* nicht am Stück: Sonne zuerst (aus Lauf A), Rest in den günstigsten Viertelstunden */
        const kw = nenn(g);
        const bedarf = g.fahrzeug ? a.kwh : a.stunden * kw;
        const schon = (st0.menge[id + ':' + start] || 0);
        let rest = bedarf - schon;
        if (a.quelle === 'sonne') {
          for (let t = ws; t < we; t++) if ((A.kw[id] || [])[t] > 0) rest -= A.kw[id][t] * 0.25;
        }
        if (rest <= 0.01) continue;
        const kandidaten = [];
        for (let t = ws; t < we; t++) {
          if (g.fahrzeug && !plugged(g, t)) continue;
          if (a.quelle === 'sonne' && (A.kw[id] || [])[t] > 0) continue;
          kandidaten.push(t);
        }
        kandidaten.sort((x, y) => gekostet(x) - gekostet(y) || x - y);
        for (const t of kandidaten) {
          if (rest <= 0.01) break;
          p.slots.add(t);
          rest -= kw * 0.25;
        }
      }
      plan[id] = p;
    }
    return plan;
  }

  /* ---------- Zustand ---------- */
  function startZustand(cfg) {
    return {
      soc: cfg.speicher.soc0, hsT: 49, on: {}, seit: {}, aus: {}, prog: {}, fertig: {}, menge: {},
      voll: {}, regelAn: {}, events: [],
    };
  }

  /* ---------- Ein Lauf über die Viertelstunden ---------- */
  function lauf(cfg, from, st, plan, ctx, rec) {
    const A = rec || { kw: {}, frei: [], avail: {}, why: {}, src: {}, flag: {} };
    const ids = Object.keys(cfg.geraete);
    for (const id of ids) {
      A.kw[id] = A.kw[id] || new Array(N).fill(0);
      A.why[id] = A.why[id] || new Array(N).fill(null);
      A.src[id] = A.src[id] || new Array(N).fill(null);
      A.avail[id] = A.avail[id] || new Array(N).fill(0);
    }
    A.sp = A.sp || { soc: new Array(N).fill(0), kw: new Array(N).fill(0) };
    A.netz = A.netz || new Array(N).fill(0);
    A.haus = A.haus || new Array(N).fill(0);
    A.zustand = A.zustand || new Array(N + 1).fill(null);
    A.hsT = A.hsT || new Array(N).fill(0);
    A.abgeregelt = A.abgeregelt || new Array(N).fill(0);
    A.regel = A.regel || {};
    const sp = cfg.speicher;
    const budget = cfg.anschlussKw * (1 - cfg.abstandPct / 100);
    const rang0 = cfg.reihenfolge.filter((id) => sonnig(cfg, id));

    for (let t = from; t < N; t++) {
      /* Speicher hat Vorrang nur bis zu einem Ladestand, danach kommen die Autos zuerst */
      let rang = rang0;
      if (cfg.speicherBis != null && st.soc * 100 >= cfg.speicherBis) {
        const autos = rang0.filter((id) => cfg.geraete[id] && cfg.geraete[id].fahrzeug);
        const ohne = rang0.filter((id) => id !== 'sp');
        const letztesAuto = autos.length ? ohne.indexOf(autos[autos.length - 1]) : -1;
        if (letztesAuto >= 0 && rang0.indexOf('sp') < rang0.indexOf(autos[autos.length - 1])) {
          rang = [...ohne.slice(0, letztesAuto + 1), 'sp', ...ohne.slice(letztesAuto + 1)];
        }
      }
      if (rec) A.zustand[t] = clone(st);
      const PV = pv(t); const HAUS = last(t);
      const soll = {}; /* id -> {kw, why, pflicht} */
      const sperre = {};
      const pause = cfg.pause && t >= cfg.pause.von && t < cfg.pause.bis;

      /* Aufgaben, Bedingungen, Ziele */
      for (const id of ids) {
        const { g, a, ziel, aus } = wirk(cfg, id);
        if (pause) { sperre[id] = { why: { k: 'pause' } }; continue; }
        if (aus) { sperre[id] = { why: { k: 'szene', name: SZENEN.find((s) => s.id === cfg.szene).name } }; continue; }
        if (!plugged(g, t)) { sperre[id] = { why: { k: 'kein-auto' } }; continue; }
        if (g.fahrzeug && st.voll[id]) { sperre[id] = { why: { k: 'auto-voll' } }; continue; }
        if (ziel && ziel.art === 'temp' && st.hsT >= ziel.grad) { sperre[id] = { why: { k: 'ziel', grad: ziel.grad, ist: st.hsT } }; continue; }
        for (const b of g.bedingungen || []) {
          if (b.art === 'nurwenn') {
            let ok = true;
            if (b.temp != null) ok = temp(t) > b.temp;
            if (b.tempUnter != null) ok = temp(t) < b.tempUnter;
            if (b.geraet) ok = !!st.on[b.geraet];
            if (!ok) { sperre[id] = { why: { k: 'bedingung', text: b.text } }; break; }
          }
          if (b.art === 'danach' && !st.fertigAm?.[b.geraet]) {
            const p = plan && plan[id];
            if (!(p && p.slots.has(t))) { sperre[id] = { why: { k: 'danach', text: b.text } }; break; }
          }
        }
        if (sperre[id]) continue;
        if (a.art === 'zeiten') {
          const m = t % 96;
          const im = a.von <= a.bis ? m >= a.von && m < a.bis : m >= a.von || m < a.bis;
          if (im) soll[id] = { kw: nenn(g), why: { k: 'zeiten', von: a.von, bis: a.bis }, pflicht: true };
          else sperre[id] = { why: { k: 'zeiten-aus', von: a.von, bis: a.bis }, weich: true };
        } else if (a.art === 'guenstig') {
          const bekannt = t < 96 || ctx.morgenBekannt;
          if (bekannt && preis(t) < a.grenze) soll[id] = { kw: nenn(g), why: { k: 'guenstig', preis: preis(t), grenze: a.grenze }, pflicht: true };
          else sperre[id] = { why: { k: bekannt ? 'teuer' : 'preis-unbekannt', preis: bekannt ? preis(t) : null, grenze: a.grenze }, weich: true };
        } else if (a.art === 'sofort') {
          /* Ohne Steuerung: ein Programmgerät läuft, wann es selbst will; das kennt der Plan nicht */
          if (g.form === 'programm') sperre[id] = { why: { k: 'selbst' }, weich: true };
          else soll[id] = { kw: nenn(g), why: { k: 'selbst' }, pflicht: true, selbst: true };
        } else if (a.art === 'frist' && plan) {
          const p = plan[id];
          if (p && p.slots.has(t)) {
            const k0 = st.prog[id] ? st.prog[id].k : 0;
            const kw = g.form === 'programm' ? g.profil[Math.min(k0, g.profil.length - 1)] : nenn(g);
            soll[id] = { kw, why: { k: 'frist', bis: a.bis, quelle: a.quelle, vorlaeufig: p.vorlaeufig }, pflicht: true };
          } else if (!sonnig(cfg, id)) {
            let naechst = null;
            if (p) for (const x of p.slots) if (x > t && (naechst == null || x < naechst)) naechst = x;
            const fertig = st.fertigAm && st.fertigAm[id] && st.fertigAm[id] <= t;
            sperre[id] = { why: fertig ? { k: 'fertig' } : { k: 'frist-wartet', start: naechst, bis: a.bis, quelle: a.quelle, vorlaeufig: p && p.vorlaeufig }, weich: true };
          }
        }
      }

      /* Regeln: Ausnahmen gehen vor Pflichten und Reihenfolge */
      for (const r of cfg.regeln) {
        if (!r.an) continue;
        const gilt = regelGilt(r, t, st, ctx);
        const id = r.dann.g;
        if (!cfg.geraete[id]) continue;
        const war = st.regelAn[r.id];
        const halten = war && r.minLaufzeit && (t - war) < r.minLaufzeit;
        if (gilt || halten) {
          if (!st.regelAn[r.id]) { st.regelAn[r.id] = t; st.events.push({ t, r: r.id, k: 'an' }); }
          A.regel[r.id] = A.regel[r.id] || new Array(N).fill(0);
          A.regel[r.id][t] = 1;
          const g = cfg.geraete[id];
          if (sperre[id] && ['kein-auto', 'ziel', 'auto-voll', 'pause'].includes(sperre[id].why.k)) continue;
          if (r.dann.a === 'sperren') { delete soll[id]; sperre[id] = { why: { k: 'regel-aus', regel: r.name } }; }
          else if (!(sperre[id] && sperre[id].why.k === 'regel-aus')) {
            const kw = r.dann.a === 'voll' ? nenn(g) : r.dann.a === 'leistung' ? r.dann.w : (g.form === 'stufig' ? g.stufen[1] || g.stufen[0] : nenn(g));
            delete sperre[id];
            soll[id] = { kw, why: { k: 'regel-an', regel: r.name }, pflicht: true };
          }
        } else if (st.regelAn[r.id]) {
          st.events.push({ t, r: r.id, k: 'aus' });
          delete st.regelAn[r.id];
        }
      }

      /* Ihr Eingriff geht vor allem außer Schutz */
      for (const e of cfg.eingriffe) {
        if (t < e.von || t >= e.bis || e.g === 'sp') continue;
        const g = cfg.geraete[e.g];
        if (e.art === 'aus') { delete soll[e.g]; sperre[e.g] = { why: { k: 'eingriff-aus', bis: e.bis } }; }
        else if (plugged(g, t)) { delete sperre[e.g]; soll[e.g] = { kw: nenn(g), why: { k: 'eingriff-an', bis: e.bis }, pflicht: true }; }
      }

      /* Schutz: Mindestpause (Sperrzeit) und Mindestlaufzeit */
      for (const id of ids) {
        const g = cfg.geraete[id];
        const minAus = g.form === 'freigabe' ? 2 : 1;
        if (soll[id] && !st.on[id] && st.aus[id] != null && t - st.aus[id] < minAus && !soll[id].why.k.startsWith('eingriff')) {
          sperre[id] = { why: { k: 'schutz-pause' } }; delete soll[id];
        }
      }

      const spE = cfg.eingriffe.find((e) => e.g === 'sp' && t >= e.von && t < e.bis);
      /* Verteilung: Grundlast, Pflichten, dann Sonnenstrom nach Reihenfolge */
      let pvRest = PV;
      const baseVonPv = Math.min(HAUS, pvRest); pvRest -= baseVonPv;
      const defizit = []; /* [id|'haus', kw, speicherDarf] */
      if (HAUS - baseVonPv > 0) defizit.push(['haus', HAUS - baseVonPv, true]);
      const kw = {}; const src = {}; const why = {};
      const pflichtIds = ids.filter((id) => soll[id]);
      for (const id of pflichtIds) {
        const s = soll[id]; const g = cfg.geraete[id];
        const aus = Math.min(s.kw, pvRest); pvRest -= aus;
        kw[id] = s.kw; src[id] = { pv: aus, sp: 0, netz: 0 }; why[id] = s.why;
        if (s.kw - aus > 0) defizit.push([id, s.kw - aus, g.speicherHilft != null ? g.speicherHilft : (!g.fahrzeug && g.gruppe !== 'waerme')]);
      }
      let frei = pvRest;
      for (const id of rang) {
        if (id === 'sp') {
          A.avail.sp = A.avail.sp || new Array(N).fill(0);
          A.avail.sp[t] = frei;
          if (sp.modell === 'markt' && preis(t) > 12) continue;
          if (spE && spE.art === 'aus') continue;
          const platz = (1 - st.soc) * sp.kwh * 4 / 0.95;
          const lade = Math.max(0, Math.min(sp.kw, frei, platz));
          if (lade > 0.01) { kw.sp = lade; frei -= lade; }
          continue;
        }
        A.avail[id][t] = frei;
        if (soll[id] || sperre[id]) continue;
        const { g, a } = wirk(cfg, id);
        const lief = !!st.on[id];
        let nimmt = 0;
        if (g.form === 'stufenlos' || g.form === 'stufig') nimmt = passend(g, frei, lief, a.modus);
        else {
          const schwelle = a.ab || nenn(g);
          if (frei >= schwelle || (lief && frei >= 0.75 * schwelle) || (lief && g.form === 'freigabe' && t - st.seit[id] < 2)) nimmt = nenn(g);
        }
        if (nimmt > 0) {
          const ausPv = Math.min(nimmt, frei);
          kw[id] = nimmt; src[id] = { pv: ausPv, sp: 0, netz: 0 };
          why[id] = { k: g.form === 'freigabe' ? 'freigabe' : 'sonne', platz: rang.indexOf(id) + 1, frei };
          if (nimmt - ausPv > 0.001) { why[id].k = 'sonne-min'; defizit.push([id, nimmt - ausPv, false]); }
          frei -= ausPv;
        } else {
          const vor = rang.slice(0, rang.indexOf(id)).filter((x) => kw[x] > 0);
          why[id] = { k: 'wartet-sonne', platz: rang.indexOf(id) + 1, frei, braucht: g.form === 'stufenlos' ? g.bereiche[0][0] : g.form === 'stufig' ? g.stufen[0] : (a.ab || nenn(g)), vor };
        }
      }
      /* Ladepark-Rahmen: Bezug über dem Budget kürzt die Ladepunkte von hinten */
      let bedarfNetz = defizit.reduce((s, d) => s + d[1], 0);
      if (bedarfNetz > budget) {
        const lader = cfg.reihenfolge.filter((id) => cfg.geraete[id] && cfg.geraete[id].fahrzeug && kw[id] > 0).reverse();
        for (const id of lader) {
          const zuviel = bedarfNetz - budget; if (zuviel <= 0) break;
          const d = defizit.find((x) => x[0] === id); if (!d) continue;
          const g = cfg.geraete[id]; const min = g.bereiche[0][0];
          const neu = Math.max(0, kw[id] - zuviel);
          const kwNeu = neu < min ? 0 : neu;
          const weg = kw[id] - kwNeu;
          kw[id] = kwNeu; d[1] = Math.max(0, d[1] - weg); bedarfNetz -= weg;
          why[id] = { k: 'budget', budget, vorher: why[id] };
          if (!kwNeu) { delete src[id]; }
        }
      }
      /* Speicher deckt Grundlast und kleine Geräte, dann Netz */
      let sKw = kw.sp || 0; /* + laden */
      let entl = 0;
      const verfuegbar = Math.max(0, (st.soc - sp.reserve) * sp.kwh * 4 * 0.95);
      const darfEntladen = (sp.modell !== 'markt' || preis(t) > 12) && !spE;
      let netz = 0;
      for (const [id, need, speicherDarf] of defizit) {
        let rest = need;
        if (speicherDarf && darfEntladen && !sKw) {
          const d = Math.min(rest, sp.kw - entl, verfuegbar - entl);
          if (d > 0.01) { entl += d; rest -= d; if (id !== 'haus' && src[id]) src[id].sp += d; }
        }
        netz += rest;
        if (id !== 'haus' && src[id]) src[id].netz += rest;
      }
      if (sp.modell === 'markt' && preis(t) < 9.2 && t % 96 < 24 && st.soc < 0.8 && !sKw) {
        const extra = Math.min(sp.kw * 0.6, (0.8 - st.soc) * sp.kwh * 4 / 0.95);
        if (extra > 0.05) { sKw = extra; netz += extra; kw.sp = extra; }
      }
      if (spE && spE.art === 'an' && st.soc < 0.98) {
        const extra = Math.max(0, Math.min(sp.kw, (1 - st.soc) * sp.kwh * 4 / 0.95) - sKw);
        if (extra > 0.05) { sKw += extra; netz += extra; kw.sp = sKw; }
      }
      let export_ = Math.max(0, frei);
      /* Negativpreis-Abregelung läuft immer mit: bei Preisen unter null wird nicht eingespeist */
      let abgeregelt = 0;
      if (export_ > 0 && (t < 96 || ctx.morgenBekannt) && preis(t) < 0) { abgeregelt = export_; export_ = 0; }
      netz -= export_;
      /* Zustand fortschreiben */
      st.soc = Math.min(1, Math.max(0, st.soc + (sKw * 0.95 - entl / 0.95) * 0.25 / sp.kwh));
      const hsKw = kw.hs || 0;
      const m = t % 96;
      const zapf = (m >= 28 && m < 31 ? 2.6 : 0) + (m >= 78 && m < 81 ? 2.4 : 0) + (m === 50 ? 1.2 : 0);
      st.hsT = Math.min(70, st.hsT + hsKw * 0.25 / 0.35 - 0.05 - zapf);
      for (const id of ids) {
        const g = cfg.geraete[id];
        const on = (kw[id] || 0) > 0;
        if (on && !st.on[id]) { st.seit[id] = t; }
        if (!on && st.on[id]) { st.aus[id] = t; }
        st.on[id] = on;
        if (on && g.fahrzeug) {
          const k = g.fahrzeug.da.findIndex(([a, b]) => t >= a && t < b);
          const key = id + ':' + g.fahrzeug.da[k][0];
          st.menge[key] = (st.menge[key] || 0) + kw[id] * 0.25;
          if (id === 'wb' && st.menge[key] >= g.fahrzeug.bedarfKwh) st.voll[id] = true;
          if (id === 'lp' && st.menge[key] >= (cfg.geraete.lp.auftrag.kwh || 30) + 4) st.voll[id] = true;
        }
        if (g.fahrzeug && !plugged(g, t + 1)) st.voll[id] = false;
        if (g.form === 'programm' || (g.auftrag.art === 'frist' && g.auftrag.amStueck)) {
          if (on) {
            st.prog[id] = st.prog[id] && st.prog[id].k < g.profil.length ? st.prog[id] : { start: t, k: 0 };
            st.prog[id].k += 1;
            if (st.prog[id].k >= g.profil.length) { st.fertigAm = st.fertigAm || {}; st.fertigAm[id] = t + 1; st.fertig[id + ':0'] = t + 1; }
          }
        }
        if (g.auftrag.art === 'frist' && !g.fahrzeug && on) {
          const key = id + ':' + (t < 96 ? 0 : 96);
          st.menge[key] = (st.menge[key] || 0) + kw[id] * 0.25;
        }
      }
      if (rec) {
        for (const id of ids) {
          A.kw[id][t] = r2(kw[id] || 0);
          A.src[id][t] = src[id] ? { pv: r2(src[id].pv), sp: r2(src[id].sp), netz: r2(src[id].netz) } : null;
          A.why[id][t] = kw[id] > 0 ? why[id] : (sperre[id] ? sperre[id].why : why[id] || { k: 'aus' });
        }
        A.sp.soc[t] = r2(st.soc * 100);
        A.sp.kw[t] = r2(sKw - entl);
        A.netz[t] = r2(netz);
        A.frei[t] = r2(export_);
        A.abgeregelt[t] = r2(abgeregelt);
        A.haus[t] = HAUS;
        A.hsT[t] = Math.round(st.hsT * 10) / 10;
      } else {
        for (const id of ids) A.kw[id][t] = kw[id] || 0;
        A.frei[t] = Math.max(0, frei);
        for (const id of ids) A.avail[id][t] = A.avail[id][t] || 0;
      }
    }
    if (rec) { A.zustand[N] = clone(st); A.events = st.events; }
    return A;
  }

  /* Rechnet die zwei Tage. Mit basis und from bleibt alles vor from, wie es war. */
  function rechne(cfg, opts) {
    const from = opts.from || 0;
    const ctx = { morgenBekannt: opts.morgenBekannt !== false, szene: cfg.szene };
    let st;
    let rec = null;
    if (opts.basis && from > 0) {
      rec = clone({ kw: opts.basis.kw, why: opts.basis.why, src: opts.basis.src, avail: opts.basis.avail, sp: opts.basis.sp,
        netz: opts.basis.netz, frei: opts.basis.frei, haus: opts.basis.haus, hsT: opts.basis.hsT, abgeregelt: opts.basis.abgeregelt, regel: opts.basis.regel || {} });
      rec.zustand = opts.basis.zustand.slice();
      for (const id of Object.keys(cfg.geraete)) {
        if (!rec.kw[id]) { rec.kw[id] = new Array(N).fill(0); rec.why[id] = new Array(N).fill(null); rec.src[id] = new Array(N).fill(null); rec.avail[id] = new Array(N).fill(0); }
      }
      st = clone(opts.basis.zustand[from]);
      st.events = (opts.basis.events || []).filter((e) => e.t < from);
    } else {
      st = startZustand(cfg);
    }
    const A = lauf(cfg, from, clone(st), null, ctx, null);
    const plan = planeFristen(cfg, A, from, st, ctx);
    for (let runde = 0; runde < 3; runde++) {
      const B = lauf(cfg, from, clone(st), plan, ctx, null);
      let nachgelegt = false;
      for (const [id, p] of Object.entries(plan)) {
        const { g, a } = wirk(cfg, id);
        if (g.form === 'programm' || a.amStueck || g.fahrzeug) continue;
        for (const [ws, we] of p.fenster) {
          let lief = 0;
          for (let t = ws; t < we; t++) if (B.kw[id][t] > 0) lief++;
          const soll = a.stunden * 4 - Math.round((st.menge[id + ':' + (ws < 96 ? 0 : 96)] || 0) / (0.25 * nenn(g)));
          let fehlt = soll - lief;
          if (fehlt <= 0) continue;
          const frei = [];
          for (let t = ws; t < we; t++) if (!(B.kw[id][t] > 0) && !p.slots.has(t)) frei.push(t);
          frei.sort((x, y) => preis(x) - preis(y) || x - y);
          for (const t of frei) { if (fehlt <= 0) break; p.slots.add(t); fehlt--; nachgelegt = true; }
        }
      }
      if (!nachgelegt) break;
    }
    const R = lauf(cfg, from, st, plan, ctx, rec || { kw: {}, frei: [], avail: {}, why: {}, src: {} });
    R.plan = plan;
    R.from = from;
    return R;
  }

  /* ---------- Auswertung ---------- */
  function summe(R, id, a, b) {
    let kwh = 0; let pvKwh = 0; let spKwh = 0; let netzKwh = 0; let eur = 0; let slots = 0; let bekannt = true;
    for (let t = a; t < b; t++) {
      const k = R.kw[id][t];
      if (k > 0) {
        slots++; kwh += k * 0.25;
        const s = R.src[id][t];
        if (s) { pvKwh += s.pv * 0.25; spKwh += s.sp * 0.25; netzKwh += s.netz * 0.25; eur += s.netz * 0.25 * preis(t) / 100; }
      }
    }
    return { kwh, pvKwh, spKwh, netzKwh, eur, stunden: slots / 4, bekannt };
  }
  function laeufe(R, id, a, b) {
    const out = []; let s = null;
    for (let t = a; t < b; t++) {
      const on = R.kw[id][t] > 0;
      if (on && s == null) s = t;
      if (!on && s != null) { out.push([s, t]); s = null; }
    }
    if (s != null) out.push([s, b]);
    return out;
  }

  return { N, preis, pv, last, temp, startKonfig, rechne, wirk, sonnig, nenn, plugged, summe, laeufe, regelGilt, bedingung, rangSlots };
})();
