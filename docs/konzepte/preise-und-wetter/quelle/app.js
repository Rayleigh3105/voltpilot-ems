/* Prototyp „Preise und Wetter": Ableitungen (rein) und Darstellung. Die Ableitungen folgen den
   Regeln des Portals (preisFenster.ts, weather.ts, wetterLeistung.ts) und nennen, wo sie neu sind. */
(() => {
  const { TAGE, PREIS_FAELLE, WETTER_FAELLE, ihrPreis, plan: planAus, rueckblick } = DATEN;
  const NBSP = ' ';

  /* ---------- Format ---------- */
  const zahl = (v, d = 1) =>
    v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−');
  const ctW = (v, d = 1) => `${zahl(v, d)}${NBSP}ct/kWh`;
  const kwW = (v) => `${zahl(v, 1)}${NBSP}kW`;
  const uhr = (slot) => {
    const m = slot * 15;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };
  const minUhr = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const spanne = (f) => `${uhr(f.von)}–${uhr(f.bis + 1)}${NBSP}Uhr`;
  const summe = (arr) => arr.reduce((s, v) => s + (v ?? 0), 0);
  const kwhAus = (arr) => (arr ? summe(arr) * 0.25 : 0);
  let UID = 0;

  /* ---------- Symbole (Lucide, ISC; dieselben Pfade wie designsystem/components/core/Icon.jsx) ---------- */
  const ICON = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    'cloud-sun': '<path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m6.08 10.37-3.5 1.59a1 1 0 0 0 0 1.83l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.6"/><path d="m6.08 15.87-3.5 1.59a1 1 0 0 0 0 1.83l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.6"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    wisch: '<path d="m18 8 4 4-4 4"/><path d="M2 12h20"/><path d="m6 8-4 4 4 4"/>',
  };
  const ico = (name) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

  /* ---------- Ableitungen: Preis ---------- */
  // Dieselbe Grammatik wie src/preisFenster.ts: zusammenhängende 2½-Stunden-Fenster, keine
  // Fenster unter 5 ct Tagesspanne, der Negativlauf ersetzt das günstige Fenster.
  const FENSTER_SLOTS = 10;
  const MIN_SPANNE_CT = 5;
  function fenster(cts) {
    if (cts.length < FENSTER_SLOTS * 2) return [];
    if (Math.max(...cts) - Math.min(...cts) < MIN_SPANNE_CT) return [];
    const block = (richtung) => {
      let best = null;
      for (let i = 0; i + FENSTER_SLOTS <= cts.length; i++) {
        let s = 0;
        for (let j = i; j < i + FENSTER_SLOTS; j++) s += cts[j];
        const m = s / FENSTER_SLOTS;
        if (!best || (richtung === 'min' ? m < best.ct : m > best.ct)) best = { von: i, bis: i + FENSTER_SLOTS - 1, ct: m };
      }
      return best;
    };
    const guenstig = block('min');
    const teuer = block('max');
    let neg = null;
    let start = -1;
    for (let i = 0; i <= cts.length; i++) {
      const n = i < cts.length && cts[i] < 0;
      if (n && start < 0) start = i;
      if (!n && start >= 0) {
        if (!neg || i - 1 - start > neg.bis - neg.von) neg = { von: start, bis: i - 1 };
        start = -1;
      }
    }
    const out = [];
    if (neg) {
      const werte = cts.slice(neg.von, neg.bis + 1);
      out.push({ art: 'negativ', ...neg, ct: summe(werte) / werte.length, tief: Math.min(...werte) });
    }
    const ersetzt = neg && neg.von <= guenstig.bis && guenstig.von <= neg.bis;
    if (!ersetzt) out.push({ art: 'guenstig', ...guenstig });
    if (!out.some((f) => teuer.von <= f.bis && f.von <= teuer.bis)) out.push({ art: 'teuer', ...teuer });
    return out;
  }
  const guenstigstes = (fs) => fs.find((f) => f.art === 'negativ') ?? fs.find((f) => f.art === 'guenstig') ?? null;

  // NEU: das Urteil im Vergleich zum Tag (Entscheidung E2 = A). Negativ ist immer „unter null";
  // unter 5 ct Tagesspanne gibt es kein Urteil (dieselbe Schwelle wie die Fenster).
  const URTEIL = { negativ: 'unter null', guenstig: 'günstig', mittel: 'mittel', teuer: 'teuer', ruhig: 'gleichmäßig' };
  function urteil(v, cts) {
    if (v < 0) return 'negativ';
    const s = [...cts].sort((a, b) => a - b);
    if (s[s.length - 1] - s[0] < MIN_SPANNE_CT) return 'ruhig';
    if (v <= s[Math.floor(s.length / 3)]) return 'guenstig';
    if (v >= s[Math.floor((2 * s.length) / 3)]) return 'teuer';
    return 'mittel';
  }

  // NEU: der Satz nach vorn. Er nennt nie ein vergangenes Fenster.
  function preisSaetze(fall, jetzt) {
    const fh = fenster(fall.heute);
    const g = guenstigstes(fh);
    const t = fh.find((f) => f.art === 'teuer') ?? null;
    const gm = fall.morgen ? guenstigstes(fenster(fall.morgen)) : null;
    const drin = (f) => f && jetzt >= f.von && jetzt <= f.bis;
    const kommt = (f) => f && f.von > jetzt;
    if (!g && !t) return { s1: 'Heute bleibt der Preis den ganzen Tag ähnlich.', s2: null };
    let s1 = null;
    let um = null;
    if (drin(g)) {
      s1 = g.art === 'negativ'
        ? `Der Börsenpreis liegt unter null, noch bis <b>${uhr(g.bis + 1)}${NBSP}Uhr</b>.`
        : `Jetzt ist die günstigste Zeit des Tages, noch bis <b>${uhr(g.bis + 1)}${NBSP}Uhr</b>.`;
      um = 'g';
    } else if (drin(t)) {
      s1 = `Jetzt ist die teuerste Zeit des Tages, noch bis <b>${uhr(t.bis + 1)}${NBSP}Uhr</b>.`;
      um = 't';
    } else if (kommt(g) && (!kommt(t) || g.von < t.von)) {
      s1 = g.art === 'negativ'
        ? `Unter null fällt der Preis heute <b>${spanne(g)}</b>.`
        : `Am günstigsten wird es heute <b>${spanne(g)}</b>.`;
      um = 'g';
    } else if (kommt(t)) {
      s1 = `Teuer wird es heute <b>${spanne(t)}</b>.`;
      um = 't';
    } else {
      s1 = 'Die günstigste und die teuerste Zeit sind für heute vorbei.';
    }
    let s2 = null;
    if (um === 'g' && kommt(t)) s2 = `Teuer wird es ${spanne(t)}.`;
    else if (um !== 'g' && kommt(g)) s2 = `Günstig wird es wieder ${spanne(g)}.`;
    else if (um !== 'g' && gm) s2 = `Morgen am günstigsten: ${spanne(gm)}.`;
    else if (um !== 'g' && !fall.morgen) s2 = 'Die Preise für morgen kommen gegen 13 Uhr.';
    return { s1, s2 };
  }

  /* ---------- Ableitungen: Wetter ---------- */
  // Schwellen aus src/weather.ts (SUNNY_MAX_CLOUD, CLOUDY_MIN_CLOUD); der Tag zählt von 6 bis 21 Uhr.
  const SONNIG_MAX = 40;
  const BEWOELKT_MIN = 65;
  const himmel = (c) => (c <= SONNIG_MAX ? 'sonnig' : c >= BEWOELKT_MIN ? 'bewoelkt' : 'wechselnd');
  const HIMMEL = { sonnig: 'sonnig', wechselnd: 'wechselnd', bewoelkt: 'bewölkt' };
  const HIMMEL_GROSS = { sonnig: 'Sonnig', wechselnd: 'Wechselnd', bewoelkt: 'Bewölkt' };
  const HIMMEL_ICO = { sonnig: 'sun', wechselnd: 'cloud-sun', bewoelkt: 'cloud' };
  function tagHimmel(stunden) {
    const tag = stunden.filter((s) => s.h >= 6 && s.h < 21);
    return himmel(summe(tag.map((s) => s.cloud)) / tag.length);
  }
  const tempSpanne = (stunden) => {
    const t = stunden.map((s) => s.temp);
    return { tief: Math.round(Math.min(...t)), hoch: Math.round(Math.max(...t)) };
  };
  // Benannte Himmelsblöcke wie wetterLeistung.ts: Blöcke unter 2 Stunden gehen im Nachbarn auf.
  function himmelBloecke(stunden, von, bis) {
    const b = [];
    for (let h = von; h < bis; h++) {
      const art = himmel(stunden[h].cloud);
      if (b.length && b[b.length - 1].art === art) b[b.length - 1].bis = h;
      else b.push({ art, von: h, bis: h });
    }
    for (let runde = 0; runde < 24 && b.length > 1; runde++) {
      const i = b.findIndex((x) => x.bis - x.von + 1 < 2);
      if (i < 0) break;
      const l = b[i - 1];
      const r = b[i + 1];
      const ziel = !l ? r : !r ? l : l.bis - l.von >= r.bis - r.von ? l : r;
      if (ziel === l) l.bis = b[i].bis;
      else r.von = b[i].von;
      b.splice(i, 1);
      for (let k = b.length - 1; k > 0; k--) if (b[k].art === b[k - 1].art) { b[k - 1].bis = b[k].bis; b.splice(k, 1); }
    }
    return b;
  }
  function staerksteFenster(werte) {
    let best = null;
    for (let i = 0; i + FENSTER_SLOTS <= werte.length; i++) {
      const teil = werte.slice(i, i + FENSTER_SLOTS);
      if (teil.some((v) => v == null)) continue;
      const m = summe(teil) / FENSTER_SLOTS;
      if (!best || m > best.m) best = { von: i, bis: i + FENSTER_SLOTS - 1, m };
    }
    return best && best.m > 0.05 ? best : null;
  }
  const verbinde = (gem, erw) => Array.from({ length: 96 }, (_, i) => gem?.[i] ?? erw?.[i] ?? null);
  const ghi96 = (stunden) =>
    Array.from({ length: 96 }, (_, i) => {
      const h = (i + 0.5) / 4 - 0.5;
      const a = stunden[Math.max(0, Math.min(23, Math.floor(h)))];
      const b = stunden[Math.max(0, Math.min(23, Math.floor(h) + 1))];
      const f = h - Math.floor(h);
      return Math.round(a.ghi * (1 - f) + b.ghi * f);
    });

  /* ---------- Zustand ---------- */
  const S = { seite: 'preise', preisFall: 'vormittag', wetterFall: 'sonnig', preisTag: 0, wetterTag: 0, blatt: false, rb: 'woche' };

  /* ---------- Rahmen des Portals ---------- */
  function reiter() {
    const t = (id, label) =>
      id === 'fahrplan'
        ? `<button type="button" role="tab" aria-selected="false" aria-disabled="true" data-act="nicht">${label}</button>`
        : `<button type="button" role="tab" aria-selected="${S.seite === id}" data-act="seite" data-seite="${id}">${label}</button>`;
    return `<nav class="app-tabs" role="tablist" aria-label="Fahrplan">${t('fahrplan', 'Fahrplan')}${t('preise', 'Preise')}${t('wetter', 'Wetter')}</nav>`;
  }
  function rahmen(inhalt) {
    const dock = [['dashboard', 'Cockpit'], ['calendar', 'Fahrplan'], ['history', 'Verlauf'], ['zap', 'Steuerung'], ['layers', 'Anlage']]
      .map(([i, l]) => `<span class="${l === 'Fahrplan' ? 'on' : ''}">${ico(i)}${l}</span>`).join('');
    return `<div class="app">
      <header class="app-top">
        <div class="site"><span class="site-name">Sonnenhof ${ico('down')}</span><span class="site-state"><i></i>Alles in Ordnung</span></div>
        <span class="sp"></span>
        <button type="button" class="ibtn" aria-label="Hilfe" data-act="nicht">${ico('help')}</button>
        <span class="avatar" aria-hidden="true">AB</span>
      </header>
      ${reiter()}
      <main class="app-main">${inhalt}</main>
      <nav class="app-dock" aria-label="Bereiche">${dock}</nav>
    </div>`;
  }

  /* ---------- Seite: Preise ---------- */
  function preisSeite() {
    const fall = PREIS_FAELLE[S.preisFall];
    if (!fall.morgen) S.preisTag = 0;
    const jetzt = Math.floor(fall.minute / 15);
    const v = fall.heute[jetzt];
    const u = urteil(v, fall.heute);
    const lo = Math.min(...fall.heute);
    const hi = Math.max(...fall.heute);
    const pos = Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
    const { s1, s2 } = preisSaetze(fall, jetzt);
    const tag = S.preisTag === 1 ? fall.morgen : fall.heute;
    const fs = fenster(tag);
    const vorbei = (f) => S.preisTag === 0 && f.bis < jetzt;
    const laeuft = (f) => S.preisTag === 0 && jetzt >= f.von && jetzt <= f.bis;
    const zustand = (f) => (vorbei(f) ? ' · vorbei' : laeuft(f) ? ' · jetzt' : '');
    const zeilen = [];
    const g = guenstigstes(fs);
    const t = fs.find((f) => f.art === 'teuer');
    if (g && g.art === 'negativ') zeilen.push({ cls: vorbei(g) ? 'vorbei' : '', farbe: 'var(--neg)', name: 'Unter null', wert: spanne(g), sek: `tiefster Wert ${ctW(g.tief)}${zustand(g)}` });
    else if (g) zeilen.push({ cls: vorbei(g) ? 'vorbei' : '', farbe: 'var(--cheap)', name: 'Am günstigsten', wert: spanne(g), sek: `im Schnitt ${ctW(g.ct)}${zustand(g)}` });
    if (t) zeilen.push({ cls: vorbei(t) ? 'vorbei' : '', farbe: 'var(--dear)', name: 'Am teuersten', wert: spanne(t), sek: `im Schnitt ${ctW(t.ct)}${zustand(t)}` });
    if (!g && !t) {
      zeilen.push({ name: 'Tiefster Preis', wert: ctW(Math.min(...tag)) });
      zeilen.push({ name: 'Höchster Preis', wert: ctW(Math.max(...tag)) });
    }
    zeilen.push({ name: 'Durchschnitt', wert: ctW(summe(tag) / tag.length), sek: 'über alle Viertelstunden des Tages' });
    const tagName = S.preisTag === 1 ? TAGE[1] : TAGE[0];
    const zeilenHtml = zeilen.map((z) => `<li class="${z.cls ?? ''}"><span class="rn">${z.farbe ? `<i style="background:${z.farbe}"></i>` : ''}${z.name}</span><span class="rv">${z.wert}</span>${z.sek ? `<span class="rs">${z.sek}</span>` : ''}</li>`).join('');
    const profi = [
      ['Minimum', Math.min(...tag) * 10], ['Durchschnitt', (summe(tag) / tag.length) * 10],
      ['Maximum', Math.max(...tag) * 10], ['Spanne', (Math.max(...tag) - Math.min(...tag)) * 10],
    ].map(([n, w]) => `<tr><th scope="row">${n}</th><td>${zahl(w, 2)}${NBSP}EUR/MWh</td></tr>`).join('');

    return `<div class="pv"><div class="pv-grid">
      <div class="pv-col">
        <section class="ans" aria-label="Börsenpreis jetzt">
          <p class="ans-eye">Börsenstrompreis · jetzt ${uhr(jetzt)}–${uhr(jetzt + 1)}</p>
          <div class="ans-line">
            <p class="ans-num">${zahl(v)}<small>ct/kWh</small></p>
            <span class="verdict v-${u}"><i></i>${URTEIL[u]}</span>
          </div>
          <div class="ladder" role="img" aria-label="Heute zwischen ${ctW(lo)} und ${ctW(hi)}; jetzt ${ctW(v)}">
            <div class="ladder-bar"><span></span><span></span><span></span><b style="left:${pos}%"></b></div>
            <div class="ladder-lbl"><span>günstigste ${zahl(lo)} ct</span><span>teuerste ${zahl(hi)} ct</span></div>
          </div>
          <p class="ans-say">${s1}${s2 ? `<span class="leise">${s2}</span>` : ''}</p>
          <p class="ans-own">Ihr Preis jetzt: <b>${ctW(ihrPreis(v))}</b> mit Netzentgelt, Abgaben und Steuern</p>
        </section>
        <section class="card" aria-label="Börsenpreis im Tagesverlauf">
          <div class="daysw" role="tablist" aria-label="Tag">
            <button type="button" role="tab" aria-selected="${S.preisTag === 0}" data-act="ptag" data-tag="0">Heute<small>${TAGE[0].kurz}</small></button>
            <button type="button" role="tab" aria-selected="${S.preisTag === 1}" data-act="ptag" data-tag="1" ${fall.morgen ? '' : 'disabled'}>Morgen<small>${fall.morgen ? TAGE[1].kurz : 'ab ca. 13 Uhr'}</small></button>
          </div>
          <p class="readout" data-readout data-leer="Wischen zeigt jede Viertelstunde">${ico('wisch')}<span>Wischen zeigt jede Viertelstunde</span></p>
          <div class="chart" data-chart="preis" tabindex="0" role="slider" aria-label="Börsenpreis ${tagName.wort.toLowerCase()} je Viertelstunde" aria-valuemin="0" aria-valuemax="95"></div>
          <div class="legend">
            <span><i style="background:var(--batt)"></i>Speicher lädt</span>
            <span><i style="background:var(--battdis)"></i>gibt ab</span>
            <span>laut Plan</span>
          </div>
          <ul class="rows nur-schmal">${zeilenHtml}</ul>
        </section>
      </div>
      <div class="pv-col">
        <section class="card nur-breit" aria-label="Kennzahlen">
          <div class="card-h"><h2>${S.preisTag === 1 ? 'Morgen' : 'Heute'} in Zahlen</h2><span>${tagName.kurz}</span></div>
          <ul class="rows">${zeilenHtml}</ul>
        </section>
        <nav class="links" aria-label="Weiter">
          <a class="linkrow" href="#" data-act="nicht"><span class="li">${ico('calendar')}</span><span class="lt">So nutzt Ihr Speicher diese Preise<small>Zum Fahrplan</small></span>${ico('right')}</a>
          <button type="button" class="linkrow" data-act="blatt"><span class="li">${ico('history')}</span><span class="lt">Rückblick<small>Woche, Monat und Jahr</small></span>${ico('right')}</button>
        </nav>
        <details class="explain">
          <summary><span>Was ist der Börsenstrompreis?</span>${ico('right')}</summary>
          <div class="ex">
            <p>Er entsteht jeden Tag in der Day-Ahead-Auktion für die Gebotszone Deutschland-Luxemburg (DE-LU) und gilt je Viertelstunde. Die Preise für morgen stehen gegen 13 Uhr fest.</p>
            <p><b>Ihr Preis</b> enthält zusätzlich den Aufschlag Ihres Anbieters, Netzentgelte, Abgaben und Steuern. VoltPilot liest ihn aus Ihrem Fahrplan.</p>
            <p><b>Günstig und teuer</b> gelten im Vergleich zum Tag: das untere und das obere Drittel der Viertelstunden. Die Fenster sind die günstigsten und die teuersten 2½ Stunden am Stück.</p>
            <table class="profi"><caption class="sr">Werte für Fachleute</caption>${profi}</table>
            <p style="margin-top:10px">Quelle: energy-charts.info (Fraunhofer ISE).</p>
          </div>
        </details>
      </div>
    </div></div>`;
  }

  function preisDaten() {
    const fall = PREIS_FAELLE[S.preisFall];
    const heute = S.preisTag === 0;
    const cts = heute ? fall.heute : fall.morgen;
    const jetztSlot = Math.floor(fall.minute / 15);
    return {
      cts,
      jetzt: heute ? fall.minute : null,
      fenster: fenster(cts),
      // Der Plan beginnt bei der laufenden Viertelstunde; morgen nur, wenn die Preise feststehen.
      plan: planAus(cts, heute ? jetztSlot : 0),
    };
  }

  /* ---------- Seite: Wetter ---------- */
  function wetterSeite() {
    const fall = WETTER_FAELLE[S.wetterFall];
    const ohne = !!fall.ohnePrognose;
    const t0 = fall.tage[0];
    const art = tagHimmel(t0.stunden);
    const temp = tempSpanne(t0.stunden);
    const jetzt = Math.floor(fall.minute / 15);
    const heuteReihe = verbinde(fall.pv[0].gemessen, ohne ? null : fall.pv[0].erwartet);
    const gemKwh = kwhAus(fall.pv[0].gemessen);
    const erwKwh = ohne ? 0 : kwhAus(fall.pv[0].erwartet);
    const stark = ohne ? staerksteFenster(ghi96(t0.stunden).map((v) => v / 1000)) : staerksteFenster(heuteReihe);
    const art1 = tagHimmel(fall.tage[1].stunden);
    const morgenKwh = ohne ? null : kwhAus(fall.pv[1].erwartet);

    const satz = ohne
      ? `Die Sonne ist heute am stärksten <b>${spanne(stark)}</b>.`
      : `Sonnenstrom heute: <b>≈${NBSP}${zahl(gemKwh + erwKwh, 0)}${NBSP}kWh</b>, am meisten <b>${spanne(stark)}</b>.`;
    const leise = ohne
      ? 'Eine Leistungsprognose für Ihre Anlage gibt es noch nicht.'
      : `Morgen ${HIMMEL[art1]}, ≈${NBSP}${zahl(morgenKwh, 0)}${NBSP}kWh.`;

    const tagZeilen = fall.tage.map((tg, i) => {
      const a = tagHimmel(tg.stunden);
      const tp = tempSpanne(tg.stunden);
      let wert;
      if (ohne) wert = i === 0 ? `${zahl(gemKwh, 1)}${NBSP}kWh<small>bisher gemessen</small>` : `—<small>keine Prognose</small>`;
      else if (i === 0) wert = `≈${NBSP}${zahl(gemKwh + erwKwh, 0)}${NBSP}kWh<small>${zahl(gemKwh, 1)} schon erzeugt</small>`;
      else if (fall.pv[i]) wert = `≈${NBSP}${zahl(kwhAus(fall.pv[i].erwartet), 0)}${NBSP}kWh<small>erwartet</small>`;
      else wert = `—<small>Prognose folgt</small>`;
      const waehlbar = i < 2;
      return `<li><button type="button" class="dayrow${S.wetterTag === i ? ' sel' : ''}" ${waehlbar ? `data-act="wtag" data-tag="${i}"` : 'aria-disabled="true"'}>
        <span class="di w-${a}">${ico(HIMMEL_ICO[a])}</span>
        <span class="dn">${TAGE[i].wort}<small>${TAGE[i].kurz}</small></span>
        <span class="dw">${HIMMEL[a]} · ${tp.tief} bis ${tp.hoch}${NBSP}°C</span>
        <span class="dv">${wert}</span>
      </button></li>`;
    }).join('');

    const vonStunde = Math.floor(fall.minute / 60);
    const stunden = [];
    for (let h = vonStunde; h < Math.min(24, vonStunde + 12); h++) {
      const st = t0.stunden[h];
      const nacht = h < 7 || h >= 19;
      const a = himmel(st.cloud);
      const name = nacht && a !== 'bewoelkt' ? 'moon' : HIMMEL_ICO[a];
      const teil = heuteReihe.slice(h * 4, h * 4 + 4).filter((v) => v != null);
      const kwStunde = !ohne && teil.length ? summe(teil) / teil.length : null;
      stunden.push(`<div class="hour${h === vonStunde ? ' now' : ''}" role="listitem" aria-label="${h} Uhr, ${HIMMEL[a]}, ${zahl(st.temp, 0)} Grad, Bewölkung ${st.cloud} Prozent">
        <span class="h">${h === vonStunde ? 'Jetzt' : `${h} Uhr`}</span>${ico(name)}<span class="t">${zahl(st.temp, 0)}°</span>
        <span class="k${kwStunde != null && kwStunde > 0.05 ? '' : ' leer'}">${kwStunde != null && kwStunde > 0.05 ? kwW(kwStunde) : NBSP}</span></div>`);
    }

    const tagWahl = S.wetterTag;
    return `<div class="pv"><div class="pv-grid">
      <div class="pv-col">
        <section class="ans" aria-label="Wetter heute">
          <p class="ans-eye">Wetter heute · ${TAGE[0].kurz}</p>
          <div class="wx">
            <span class="wx-ico w-${art}">${ico(HIMMEL_ICO[art])}</span>
            <div><p class="wx-word">${HIMMEL_GROSS[art]}</p><p class="wx-temp">${temp.tief} bis ${temp.hoch}${NBSP}°C</p></div>
          </div>
          <p class="ans-say">${satz}<span class="leise">${leise}</span></p>
        </section>
        <section class="card" aria-label="${ohne ? 'Sonne' : 'Sonnenstrom'} im Tagesverlauf">
          <div class="card-h"><h2>${ohne ? 'Sonne' : 'Sonnenstrom'} im Tagesverlauf</h2></div>
          <div class="daysw" role="tablist" aria-label="Tag">
            <button type="button" role="tab" aria-selected="${tagWahl === 0}" data-act="wtag" data-tag="0">Heute<small>${TAGE[0].kurz}</small></button>
            <button type="button" role="tab" aria-selected="${tagWahl === 1}" data-act="wtag" data-tag="1">Morgen<small>${TAGE[1].kurz}</small></button>
          </div>
          <p class="readout" data-readout data-leer="Wischen zeigt jede Viertelstunde">${ico('wisch')}<span>Wischen zeigt jede Viertelstunde</span></p>
          <div class="chart" data-chart="wetter" tabindex="0" role="slider" aria-label="${ohne ? 'Sonneneinstrahlung' : 'Sonnenstrom'} je Viertelstunde" aria-valuemin="0" aria-valuemax="95"></div>
          <div class="legend" data-wlegende></div>
          ${ohne ? '<p class="note" style="margin:6px 0 10px">Für Ihre Anlage liegt noch keine Leistungsprognose vor. Bis dahin zeigt die Kurve die Sonneneinstrahlung am Standort.</p>' : ''}
        </section>
      </div>
      <div class="pv-col">
        <section class="card" aria-label="Die nächsten Tage">
          <div class="card-h"><h2>Die nächsten Tage</h2><span>${ohne ? 'Sonnenstrom' : 'Sonnenstrom'}</span></div>
          <ul class="days">${tagZeilen}</ul>
        </section>
        <section class="card" aria-label="Stunde für Stunde">
          <div class="card-h"><h2>Stunde für Stunde</h2><span>heute</span></div>
          <div class="hours" role="list">${stunden.join('')}</div>
        </section>
        <details class="explain">
          <summary><span>Woher kommen diese Werte?</span>${ico('right')}</summary>
          <div class="ex">
            <p><b>Wetter:</b> Open-Meteo für den Standort Ihrer Anlage, stündlich aktualisiert, drei Tage voraus.</p>
            <p><b>Sonnenstrom erwartet:</b> die PV-Prognose Ihrer Anlage, bis 48 Stunden voraus. Mit ihr rechnet auch Ihr Fahrplan. <b>Gemessen:</b> die Messwerte Ihrer Anlage bis jetzt.</p>
            <p><b>Himmel:</b> sonnig bis 40 % Bewölkung, bewölkt ab 65 %, dazwischen wechselnd. Für den ganzen Tag zählt das Mittel von 6 bis 21 Uhr.</p>
          </div>
        </details>
      </div>
    </div></div>`;
  }

  function wetterDaten() {
    const fall = WETTER_FAELLE[S.wetterFall];
    const i = S.wetterTag;
    const tag = fall.tage[i];
    const ohne = !!fall.ohnePrognose;
    return {
      ohne,
      stunden: tag.stunden,
      jetzt: i === 0 ? fall.minute : null,
      gem: i === 0 ? fall.pv[0].gemessen : null,
      erw: ohne ? null : fall.pv[i]?.erwartet ?? null,
      ghi: ohne ? ghi96(tag.stunden) : null,
    };
  }

  /* ---------- Zeichnen: gemeinsame Teile ---------- */
  const lbl = (x, y, text, o = {}) =>
    `<text x="${x}" y="${y}" font-size="${o.size ?? 11}" font-weight="${o.weight ?? 600}" fill="${o.fill ?? '#475569'}" text-anchor="${o.anchor ?? 'middle'}"${o.halo ? ' stroke="#ffffff" stroke-width="4" stroke-linejoin="round" paint-order="stroke"' : ''}>${text}</text>`;
  const breite = (text, size = 11) => text.length * size * 0.56;
  function klemm(mitte, text, links, rechts, size) {
    const b = breite(text, size) / 2;
    return Math.max(links + b, Math.min(rechts - b, mitte));
  }
  // Schiebt Beschriftungen auseinander, bis sie sich nicht mehr berühren, und hält sie im Bild.
  function platziere(marken, links, rechts, size) {
    marken.sort((p, q) => p.x - q.x);
    for (let runde = 0; runde < 4; runde++) {
      for (let i = 1; i < marken.length; i++) {
        const p = marken[i - 1];
        const q = marken[i];
        const noetig = (breite(p.text, size) + breite(q.text, size)) / 2 + 8;
        if (q.x - p.x < noetig) { const d = (noetig - (q.x - p.x)) / 2; p.x -= d; q.x += d; }
      }
      marken.forEach((mk) => { mk.x = klemm(mk.x, mk.text, links, rechts, size); });
    }
    return marken;
  }

  function scrubben(host, n, anzeige, x0, x1) {
    const svg = host.querySelector('svg');
    const cur = svg.querySelector('[data-cur]');
    const dot = svg.querySelector('[data-dot]');
    const readout = host.closest('.card').querySelector('[data-readout]');
    const leer = readout.dataset.leer;
    const zeige = (i) => {
      if (i == null) {
        cur.setAttribute('visibility', 'hidden');
        dot.setAttribute('visibility', 'hidden');
        readout.classList.remove('on');
        readout.querySelector('span').textContent = leer;
        host.removeAttribute('aria-valuenow');
        host.removeAttribute('aria-valuetext');
        return;
      }
      const a = anzeige(i);
      cur.setAttribute('x1', a.x); cur.setAttribute('x2', a.x); cur.setAttribute('visibility', 'visible');
      if (a.y != null) { dot.setAttribute('cx', a.x); dot.setAttribute('cy', a.y); dot.setAttribute('visibility', 'visible'); }
      else dot.setAttribute('visibility', 'hidden');
      readout.classList.add('on');
      readout.querySelector('span').textContent = a.text;
      host.setAttribute('aria-valuenow', String(i));
      host.setAttribute('aria-valuetext', a.text);
    };
    let aktuell = null;
    const ausZeiger = (e) => {
      const r = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const x = ((e.clientX - r.left) / r.width) * vb.width;
      if (x < x0 - 6 || x > x1 + 6) return null;
      return Math.max(0, Math.min(n - 1, Math.floor(((x - x0) / (x1 - x0)) * n)));
    };
    host.onpointerdown = host.onpointermove = (e) => {
      if (e.pointerType === 'mouse' || e.buttons || e.type === 'pointerdown') {
        aktuell = ausZeiger(e);
        zeige(aktuell);
      }
    };
    host.onpointerleave = (e) => { if (e.pointerType === 'mouse') { aktuell = null; zeige(null); } };
    host.onkeydown = (e) => {
      const schritt = e.shiftKey ? 4 : 1;
      if (e.key === 'ArrowRight') aktuell = Math.min(n - 1, (aktuell ?? -1) + schritt);
      else if (e.key === 'ArrowLeft') aktuell = Math.max(0, (aktuell ?? n) - schritt);
      else if (e.key === 'Home') aktuell = 0;
      else if (e.key === 'End') aktuell = n - 1;
      else if (e.key === 'Escape') aktuell = null;
      else return;
      e.preventDefault();
      zeige(aktuell);
    };
  }

  /* ---------- Zeichnen: Preis ---------- */
  function zeichnePreis(host) {
    const d = preisDaten();
    const W = Math.max(280, Math.round(host.clientWidth));
    const breit = W > 560;
    const hatPlan = d.plan.some((p) => p != null);
    const m = { l: 30, r: 10, t: 24, b: hatPlan ? 42 : 26 };
    const H = (breit ? 250 : 206) + (hatPlan ? 16 : 0);
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const n = d.cts.length;
    const lo = Math.min(0, ...d.cts);
    const hi = Math.max(...d.cts);
    const step = hi - lo > 26 ? 10 : 5;
    const y0 = Math.floor(lo / step) * step;
    const y1 = Math.max(step, Math.ceil((hi + 0.4) / step) * step);
    const X = (i) => m.l + (i / n) * pw;
    const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * ph;
    const id = `p${++UID}`;
    const xNow = d.jetzt != null ? m.l + (d.jetzt / 1440) * pw : null;

    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><defs>
      <clipPath id="${id}v"><rect x="0" y="0" width="${xNow ?? 0}" height="${H}"/></clipPath>
      <clipPath id="${id}k"><rect x="${xNow ?? 0}" y="0" width="${W}" height="${H}"/></clipPath>
      <clipPath id="${id}n"><rect x="0" y="${Y(0)}" width="${W}" height="${H}"/></clipPath></defs>`;
    for (let v = y0; v <= y1 + 1e-9; v += step) {
      const null0 = v === 0 && lo < 0;
      s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${null0 ? '#64748b' : '#e2e8f0'}" stroke-width="1"/>`;
      s += lbl(m.l - 6, Y(v) + 4, zahl(v, 0), { anchor: 'end', weight: 500 });
    }
    s += lbl(0, 11, 'ct/kWh', { anchor: 'start', weight: 600 });
    const namen = { guenstig: 'günstig', teuer: 'teuer', negativ: 'unter null' };
    const flaeche = { guenstig: 'var(--cheap-soft)', teuer: 'var(--dear-soft)', negativ: 'var(--neg-soft)' };
    const tinte = { guenstig: 'var(--cheap-ink)', teuer: 'var(--dear-ink)', negativ: 'var(--neg-ink)' };
    const jetztSlot = d.jetzt != null ? Math.floor(d.jetzt / 15) : -1;
    const marken = [];
    for (const f of d.fenster) {
      const vorbei = f.bis < jetztSlot;
      s += `<rect x="${X(f.von)}" y="${m.t}" width="${X(f.bis + 1) - X(f.von)}" height="${ph}" fill="${flaeche[f.art]}"${vorbei ? ' fill-opacity=".5"' : ''}/>`;
      marken.push({ x: (X(f.von) + X(f.bis + 1)) / 2, text: namen[f.art], fill: vorbei ? '#64748b' : tinte[f.art] });
    }
    for (const mk of platziere(marken, m.l + 44, W - m.r, 11.5)) s += lbl(mk.x, m.t - 8, mk.text, { size: 11.5, weight: 700, fill: mk.fill });
    let linie = `M${X(0)},${Y(d.cts[0])}`;
    for (let i = 0; i < n; i++) {
      linie += `H${X(i + 1)}`;
      if (i + 1 < n) linie += `V${Y(d.cts[i + 1])}`;
    }
    const area = `${linie}V${Y(0)}H${X(0)}Z`;
    if (xNow != null) {
      s += `<path d="${area}" fill="var(--past-soft)" clip-path="url(#${id}v)"/>`;
      s += `<path d="${area}" fill="var(--price-soft)" fill-opacity=".75" clip-path="url(#${id}k)"/>`;
    } else s += `<path d="${area}" fill="var(--price-soft)" fill-opacity=".75"/>`;
    if (lo < 0) s += `<path d="${area}" fill="var(--neg)" fill-opacity=".28" clip-path="url(#${id}n)"/>`;
    if (xNow != null) {
      s += `<path d="${linie}" fill="none" stroke="var(--past)" stroke-width="2" stroke-linejoin="round" clip-path="url(#${id}v)"/>`;
      s += `<path d="${linie}" fill="none" stroke="var(--price)" stroke-width="2.2" stroke-linejoin="round" clip-path="url(#${id}k)"/>`;
      const jv = d.cts[Math.floor(d.jetzt / 15)];
      s += `<line x1="${xNow}" x2="${xNow}" y1="${m.t - 2}" y2="${m.t + ph}" stroke="#1e293b" stroke-width="1.5" stroke-dasharray="3 3"/>`;
      s += `<circle cx="${xNow}" cy="${Y(jv)}" r="5.5" fill="#ffffff" stroke="#1e293b" stroke-width="2.5"/>`;
      const rechtsFrei = xNow < W - 60;
      const oben = Y(jv) > m.t + ph * 0.45;
      s += lbl(rechtsFrei ? xNow + 6 : xNow - 6, oben ? m.t + 14 : m.t + ph - 7, 'jetzt', { anchor: rechtsFrei ? 'start' : 'end', weight: 700, fill: '#1e293b', halo: true, size: 11.5 });
    } else s += `<path d="${linie}" fill="none" stroke="var(--price)" stroke-width="2.2" stroke-linejoin="round"/>`;
    if (hatPlan) {
      const yP = m.t + ph + 7;
      const erster = d.plan.findIndex((p) => p != null);
      s += `<rect x="${X(erster)}" y="${yP}" width="${X(n) - X(erster)}" height="8" rx="2" fill="#eef2f7"/>`;
      let i = 0;
      while (i < n) {
        const p = d.plan[i];
        if (p !== 1 && p !== -1) { i++; continue; }
        let j = i;
        while (j + 1 < n && d.plan[j + 1] === p) j++;
        s += `<rect x="${X(i)}" y="${yP}" width="${X(j + 1) - X(i)}" height="8" rx="2" fill="${p === 1 ? 'var(--batt)' : 'var(--battdis)'}"/>`;
        i = j + 1;
      }
    }
    const yX = H - 8;
    [0, 6, 12, 18, 24].forEach((h) => {
      s += lbl(X(h * 4), yX, h === 24 ? '24 Uhr' : String(h), { anchor: h === 0 ? 'start' : h === 24 ? 'end' : 'middle', weight: 500 });
    });
    s += `<line data-cur x1="0" x2="0" y1="${m.t - 2}" y2="${m.t + ph}" stroke="var(--price)" stroke-width="1.5" visibility="hidden"/>`;
    s += `<circle data-dot r="5" fill="var(--price)" stroke="#ffffff" stroke-width="2" visibility="hidden"/>`;
    s += '</svg>';
    host.innerHTML = s;
    const tagWort = d.jetzt != null ? 'heute' : 'morgen';
    host.setAttribute('aria-label', `Börsenpreis ${tagWort} je Viertelstunde, von ${ctW(Math.min(...d.cts))} bis ${ctW(Math.max(...d.cts))}. Pfeiltasten wählen eine Viertelstunde.`);
    scrubben(host, n, (i) => {
      const v = d.cts[i];
      const p = d.plan[i];
      const plan = p === 1 ? ' · Speicher lädt' : p === -1 ? ' · Speicher gibt ab' : '';
      return { x: (X(i) + X(i + 1)) / 2, y: Y(v), text: `${uhr(i)}–${uhr(i + 1)} Uhr · ${ctW(v, 2)}${plan}` };
    }, m.l, W - m.r);
  }

  /* ---------- Zeichnen: Wetter ---------- */
  function zeichneWetter(host) {
    const d = wetterDaten();
    const W = Math.max(280, Math.round(host.clientWidth));
    const breit = W > 560;
    const reihe = d.ohne ? d.ghi : verbinde(d.gem, d.erw);
    const hatWert = reihe.map((v) => v != null && v > (d.ohne ? 4 : 0.02));
    const erster = hatWert.indexOf(true);
    const letzter = hatWert.lastIndexOf(true);
    const hVon = Math.max(0, Math.floor(erster / 4) - 1);
    const hBis = Math.min(24, Math.ceil((letzter + 1) / 4) + 1);
    const a = hVon * 4;
    const z = hBis * 4;
    const m = { l: 30, r: 10, t: 46, b: 24 };
    const H = breit ? 272 : 232;
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const X = (i) => m.l + ((i - a) / (z - a)) * pw;
    const werte = reihe.filter((v) => v != null);
    const top = Math.max(...werte);
    const step = d.ohne ? 200 : top > 8 ? 4 : 2;
    const y1 = Math.max(step, Math.ceil((top * 1.12) / step) * step);
    const Y = (v) => m.t + (1 - v / y1) * ph;
    const id = `w${++UID}`;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><defs>
      <pattern id="${id}h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#fef3e2"/><line x1="0" y1="0" x2="0" y2="6" stroke="#f59e0b" stroke-width="2.4" stroke-opacity=".6"/></pattern></defs>`;
    // Himmel als benannte Blöcke über dem Bild
    const farben = { sonnig: ['#fef3e2', '#9a4a07'], wechselnd: ['#fdf3e1', '#92400e'], bewoelkt: ['#eef1f5', '#334155'] };
    for (const b of himmelBloecke(d.stunden, hVon, hBis)) {
      const x = X(b.von * 4) + 1;
      const w = X((b.bis + 1) * 4) - X(b.von * 4) - 2;
      s += `<rect x="${x}" y="2" width="${w}" height="24" rx="7" fill="${farben[b.art][0]}"/>`;
      const wort = HIMMEL[b.art];
      if (w > breite(wort, 11.5) + 12) s += lbl(x + w / 2, 18, wort, { size: 11.5, weight: 700, fill: farben[b.art][1] });
      else if (w >= 18) s += `<g transform="translate(${x + w / 2 - 8},6) scale(${16 / 24})" fill="none" stroke="${farben[b.art][1]}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[HIMMEL_ICO[b.art]]}</g>`;
    }
    for (let v = 0; v <= y1 + 1e-9; v += step) {
      s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e2e8f0" stroke-width="1"/>`;
      s += lbl(m.l - 6, Y(v) + 4, d.ohne ? String(v) : zahl(v, 0), { anchor: 'end', weight: 500 });
    }
    s += lbl(W - m.r, m.t - 8, d.ohne ? 'W/m²' : 'kW', { anchor: 'end', weight: 600 });
    // Die stärksten 2½ Stunden, dieselbe Fensterlänge wie bei den Preisen
    const stark = staerksteFenster(d.ohne ? reihe.map((v) => v / 1000) : reihe);
    if (stark) {
      s += `<rect x="${X(stark.von)}" y="${m.t}" width="${X(stark.bis + 1) - X(stark.von)}" height="${ph}" fill="#fff6e8"/>`;
      s += lbl((X(stark.von) + X(stark.bis + 1)) / 2, m.t - 8, 'am stärksten', { size: 11.5, weight: 700, fill: '#9a4a07' });
    }
    const pfad = (arr, von, bis) => {
      let p = '';
      for (let i = von; i <= bis; i++) p += `${p ? 'L' : 'M'}${X(i + 0.5)},${Y(arr[i])}`;
      return p;
    };
    const lauf = (arr) => {
      const idx = arr.map((v, i) => (v != null ? i : -1)).filter((i) => i >= a && i < z);
      return idx.length ? [idx[0], idx[idx.length - 1]] : null;
    };
    let peak = null;
    if (d.ohne) {
      const l = lauf(reihe);
      const p = pfad(reihe, l[0], l[1]);
      s += `<path d="${p}L${X(l[1] + 0.5)},${Y(0)}L${X(l[0] + 0.5)},${Y(0)}Z" fill="#fde9c7" fill-opacity=".8"/>`;
      s += `<path d="${p}" fill="none" stroke="var(--sun)" stroke-width="2.2" stroke-linejoin="round"/>`;
    } else {
      const lg = d.gem ? lauf(d.gem) : null;
      if (lg) {
        const p = pfad(d.gem, lg[0], lg[1]);
        s += `<path d="${p}L${X(lg[1] + 0.5)},${Y(0)}L${X(lg[0] + 0.5)},${Y(0)}Z" fill="var(--pv-fill)" fill-opacity=".55"/>`;
        s += `<path d="${p}" fill="none" stroke="var(--pv)" stroke-width="2.2" stroke-linejoin="round"/>`;
      }
      const le = d.erw ? lauf(d.erw) : null;
      if (le) {
        // Die Prognose schließt an den letzten Messpunkt an, damit keine Lücke entsteht.
        const start = lg ? lg[1] : le[0];
        const arr = d.erw.map((v, i) => (i === start && lg ? d.gem[i] : v));
        const p = pfad(arr, start, le[1]);
        s += `<path d="${p}L${X(le[1] + 0.5)},${Y(0)}L${X(start + 0.5)},${Y(0)}Z" fill="url(#${id}h)"/>`;
        s += `<path d="${p}" fill="none" stroke="var(--pv)" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>`;
      }
      reihe.forEach((v, i) => { if (v != null && (!peak || v > peak.v)) peak = { i, v }; });
    }
    if (peak) {
      s += `<circle cx="${X(peak.i + 0.5)}" cy="${Y(peak.v)}" r="4.5" fill="#ffffff" stroke="var(--pv)" stroke-width="2.5"/>`;
      s += lbl(klemm(X(peak.i + 0.5), kwW(peak.v), m.l, W - m.r, 11.5), Y(peak.v) - 10, kwW(peak.v), { size: 11.5, weight: 800, fill: '#1e293b', halo: true });
    }
    if (d.jetzt != null) {
      const xNow = X(d.jetzt / 15);
      if (xNow > m.l && xNow < W - m.r) {
        s += `<line x1="${xNow}" x2="${xNow}" y1="${m.t - 2}" y2="${m.t + ph}" stroke="#1e293b" stroke-width="1.5" stroke-dasharray="3 3"/>`;
        s += lbl(xNow - 6, m.t + ph - 7, 'jetzt', { anchor: 'end', weight: 700, fill: '#1e293b', halo: true, size: 11.5 });
      }
    }
    for (let h = Math.ceil(hVon / 3) * 3; h <= hBis; h += 3) {
      const x = X(h * 4);
      if (x < m.l - 1 || x > W - m.r + 1) continue;
      s += lbl(x, H - 7, h === 18 || (h + 3 > hBis) ? `${h} Uhr` : String(h), { anchor: x > W - m.r - 20 ? 'end' : 'middle', weight: 500 });
    }
    s += `<line data-cur x1="0" x2="0" y1="${m.t - 2}" y2="${m.t + ph}" stroke="#9a4a07" stroke-width="1.5" visibility="hidden"/>`;
    s += `<circle data-dot r="5" fill="var(--pv)" stroke="#ffffff" stroke-width="2" visibility="hidden"/>`;
    s += '</svg>';
    host.innerHTML = s;

    const leg = host.closest('.card').querySelector('[data-wlegende]');
    if (d.ohne) {
      const gem = kwhAus(WETTER_FAELLE[S.wetterFall].pv[0].gemessen);
      leg.innerHTML = `<span><i style="background:#fde9c7;border:1px solid var(--sun)"></i>Sonneneinstrahlung</span>${S.wetterTag === 0 ? `<span class="tot">bisher erzeugt ${zahl(gem, 1)}${NBSP}kWh</span>` : ''}`;
    } else {
      const gem = kwhAus(d.gem);
      const erw = kwhAus(d.erw);
      leg.innerHTML = `${d.gem ? '<span><i style="background:var(--pv-fill);opacity:.7"></i>gemessen</span>' : ''}<span><i style="background:repeating-linear-gradient(45deg,#fef3e2 0 2px,#f5b54a 2px 4px)"></i>erwartet</span>`
        + `<span class="tot">${d.gem ? `${zahl(gem, 1)} + ≈${NBSP}${zahl(erw, 0)}${NBSP}kWh` : `≈${NBSP}${zahl(erw, 0)}${NBSP}kWh`}</span>`;
    }
    host.setAttribute('aria-label', `${d.ohne ? 'Sonneneinstrahlung' : 'Sonnenstrom'} ${S.wetterTag === 0 ? 'heute' : 'morgen'} je Viertelstunde. Pfeiltasten wählen eine Viertelstunde.`);
    scrubben(host, z - a, (k) => {
      const i = a + k;
      const v = reihe[i];
      const st = d.stunden[Math.floor(i / 4)];
      const art = ` · ${HIMMEL[himmel(st.cloud)]} · ${zahl(st.temp, 0)}${NBSP}°C`;
      if (v == null) return { x: X(i + 0.5), y: null, text: `${uhr(i)}–${uhr(i + 1)} Uhr · keine Angabe${art}` };
      const was = d.ohne ? `${v}${NBSP}W/m²` : `${kwW(v)} ${d.gem && d.gem[i] != null ? 'gemessen' : 'erwartet'}`;
      return { x: X(i + 0.5), y: Y(v), text: `${uhr(i)}–${uhr(i + 1)} Uhr · ${was}${art}` };
    }, m.l, W - m.r);
  }

  /* ---------- Rückblick (Blatt) ---------- */
  function blattHtml() {
    const rb = rueckblick;
    let reihe;
    let namen;
    if (S.rb === 'woche') { reihe = rb.tage.slice(-7); namen = reihe.map((t) => t.datum.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')); }
    else if (S.rb === 'monat') { reihe = rb.tage; namen = reihe.map((t, i) => (i % 7 === 0 ? t.datum.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '')); }
    else { reihe = rb.monate; namen = reihe.map((t) => t.label); }
    const werte = reihe.map((t) => t.ct);
    const W = 340;
    const H = 170;
    const m = { l: 26, r: 4, t: 18, b: 22 };
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const y1 = Math.ceil(Math.max(...werte) / 5) * 5;
    const bw = pw / werte.length;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Durchschnittspreis je ${S.rb === 'jahr' ? 'Monat' : 'Tag'}">`;
    for (let v = 0; v <= y1; v += 5) {
      const y = m.t + (1 - v / y1) * ph;
      s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}" stroke="#e2e8f0"/>` + lbl(m.l - 5, y + 4, String(v), { anchor: 'end', weight: 500, size: 10.5 });
    }
    werte.forEach((v, i) => {
      const h = (v / y1) * ph;
      const x = m.l + i * bw + bw * 0.18;
      s += `<rect x="${x}" y="${m.t + ph - h}" width="${bw * 0.64}" height="${h}" rx="${Math.min(3, bw * 0.2)}" fill="var(--price)" fill-opacity="${i === werte.length - 1 && S.rb !== 'jahr' ? 1 : 0.7}"/>`;
      if (namen[i]) s += lbl(m.l + i * bw + bw / 2, H - 6, namen[i], { weight: 500, size: 10.5 });
      if (werte.length <= 12) s += lbl(m.l + i * bw + bw / 2, m.t + ph - h - 5, zahl(v, 1), { weight: 700, size: 10, fill: '#1e293b' });
    });
    s += '</svg>';
    const iMin = werte.indexOf(Math.min(...werte));
    const iMax = werte.indexOf(Math.max(...werte));
    const wann = (t) => (t.datum ? t.datum.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) : `${t.label} ${t.jahr}`);
    const einheit = S.rb === 'jahr' ? 'Monat' : 'Tag';
    const seg = [['woche', 'Woche'], ['monat', 'Monat'], ['jahr', 'Jahr']]
      .map(([k, l]) => `<button type="button" aria-pressed="${S.rb === k}" data-act="rb" data-rb="${k}">${l}</button>`).join('');
    return `<div class="sheet-scrim" data-act="blatt-zu"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="rb-titel">
        <div class="grip" aria-hidden="true"></div>
        <div class="sheet-h"><h2 id="rb-titel">Rückblick</h2><button type="button" class="ibtn" aria-label="Schließen" data-act="blatt-zu">${ico('x')}</button></div>
        <div class="seg" role="group" aria-label="Zeitraum">${seg}</div>
        <p class="readout on" style="margin-top:14px">Durchschnitt je ${einheit}, in ct/kWh</p>
        ${s}
        <ul class="rows">
          <li><span class="rn">Durchschnitt</span><span class="rv">${ctW(summe(werte) / werte.length)}</span></li>
          <li><span class="rn"><i style="background:var(--cheap)"></i>Günstigster ${einheit}</span><span class="rv">${ctW(werte[iMin])}</span><span class="rs">${wann(reihe[iMin])}</span></li>
          <li><span class="rn"><i style="background:var(--dear)"></i>Teuerster ${einheit}</span><span class="rv">${ctW(werte[iMax])}</span><span class="rs">${wann(reihe[iMax])}</span></li>
        </ul>
        <p class="leise">Mittel aller Viertelstunden. Preise liegen ab dem Tag vor, an dem VoltPilot sie zum ersten Mal geladen hat; der Rückblick füllt sich Tag für Tag.</p>
      </div>`;
  }

  /* ---------- Einbau ---------- */
  const beobachter = new Map();
  function zeichneIn(root) {
    root.querySelectorAll('[data-chart]').forEach((host) => {
      const male = () => (host.dataset.chart === 'preis' ? zeichnePreis(host) : zeichneWetter(host));
      male();
      if ('ResizeObserver' in window) {
        let letzte = host.clientWidth;
        const ro = new ResizeObserver(() => {
          if (Math.abs(host.clientWidth - letzte) > 1) { letzte = host.clientWidth; male(); }
        });
        ro.observe(host);
        (beobachter.get(root) ?? beobachter.set(root, []).get(root)).push(ro);
      }
    });
  }
  function seiteHtml() {
    return S.seite === 'preise' ? preisSeite() : wetterSeite();
  }
  function render(root, mitRahmen) {
    (beobachter.get(root) ?? []).forEach((ro) => ro.disconnect());
    beobachter.set(root, []);
    root.innerHTML = mitRahmen ? rahmen(seiteHtml()) : `<div class="app" style="min-height:0">${reiter()}<div class="app-main">${seiteHtml()}</div></div>`;
    zeichneIn(root);
  }

  let toastUhr = null;
  function toast(text) {
    const host = document.getElementById('sheet-host');
    if (!host) return;
    host.hidden = false;
    host.classList.remove('open');
    host.innerHTML = `<div role="status" style="position:absolute;left:16px;right:16px;bottom:96px;padding:12px 14px;border-radius:14px;background:#1e293b;color:#fff;font:600 14px var(--font);text-align:center">${text}</div>`;
    clearTimeout(toastUhr);
    toastUhr = setTimeout(() => { if (!S.blatt) { host.innerHTML = ''; host.hidden = true; } }, 2200);
  }

  let ausloeser = null;
  function blattOeffnen(von) {
    const host = document.getElementById('sheet-host');
    if (!host) return;
    S.blatt = true;
    ausloeser = von ?? ausloeser;
    host.hidden = false;
    host.innerHTML = blattHtml();
    requestAnimationFrame(() => {
      host.classList.add('open');
      host.querySelector('.sheet [aria-pressed="true"]')?.focus({ preventScroll: true });
    });
  }
  function blattSchliessen() {
    const host = document.getElementById('sheet-host');
    S.blatt = false;
    host.classList.remove('open');
    setTimeout(() => { if (!S.blatt) { host.innerHTML = ''; host.hidden = true; } }, 220);
    ausloeser?.focus?.({ preventScroll: true });
  }

  function handle(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'nicht') { e.preventDefault(); toast('Nicht Teil dieses Konzepts.'); return; }
    if (act === 'seite') { S.seite = el.dataset.seite; alles(true); return; }
    if (act === 'ptag') { S.preisTag = Number(el.dataset.tag); alles(false); return; }
    if (act === 'wtag') { S.wetterTag = Number(el.dataset.tag); alles(false); return; }
    if (act === 'blatt') { blattOeffnen(el); return; }
    if (act === 'blatt-zu') { blattSchliessen(); return; }
    if (act === 'rb') { S.rb = el.dataset.rb; blattOeffnen(); return; }
  }

  /* ---------- Konzept-Hülle ---------- */
  const FAELLE = {
    preise: Object.entries(PREIS_FAELLE).map(([k, f]) => [k, f.label]),
    wetter: Object.entries(WETTER_FAELLE).map(([k, f]) => [k, f.label]),
  };
  function steuerung() {
    const seg1 = document.getElementById('seg-seite');
    const seg2 = document.getElementById('seg-fall');
    if (!seg1) return;
    seg1.innerHTML = [['preise', 'Preise'], ['wetter', 'Wetter']]
      .map(([k, l]) => `<button type="button" aria-pressed="${S.seite === k}" data-k="${k}">${l}</button>`).join('');
    const aktiv = S.seite === 'preise' ? S.preisFall : S.wetterFall;
    seg2.innerHTML = FAELLE[S.seite].map(([k, l]) => `<button type="button" aria-pressed="${aktiv === k}" data-k="${k}">${l}</button>`).join('');
    document.querySelectorAll('#aside [data-fuer]').forEach((b) => { b.hidden = b.dataset.fuer !== S.seite; });
  }

  function desktop() {
    const outer = document.getElementById('desk-outer');
    const desk = document.getElementById('desk');
    if (!outer || !desk) return;
    const skaliere = () => {
      const k = Math.min(1, outer.clientWidth / 1180);
      desk.style.transform = `scale(${k})`;
      outer.style.height = `${Math.ceil(desk.offsetHeight * k)}px`;
    };
    render(desk, false);
    skaliere();
    if (!desktop.ro && 'ResizeObserver' in window) {
      desktop.ro = new ResizeObserver(skaliere);
      desktop.ro.observe(outer);
      desktop.ro.observe(desk);
    }
  }

  function alles(nachOben) {
    const screen = document.getElementById('screen');
    if (screen) {
      const y = screen.scrollTop;
      render(screen, true);
      if (nachOben) screen.scrollTop = 0;
      else screen.scrollTop = y;
    }
    steuerung();
    desktop();
  }

  function start() {
    const nur = /^#nur-(preise|wetter)$/.exec(location.hash);
    if (nur) {
      // Aufnahme-Modus für die Vergleichsbilder: nur die Seite, in voller Breite.
      S.seite = nur[1];
      document.getElementById('konzept').hidden = true;
      const host = document.createElement('div');
      host.id = 'screen';
      document.body.prepend(host);
      const sh = document.createElement('div');
      sh.id = 'sheet-host';
      sh.className = 'sheet-host';
      sh.style.position = 'fixed';
      sh.hidden = true;
      document.body.append(sh);
      render(host, true);
      host.addEventListener('click', handle);
      return;
    }
    document.getElementById('screen').addEventListener('click', handle);
    document.getElementById('desk').addEventListener('click', handle);
    document.getElementById('sheet-host').addEventListener('click', handle);
    document.getElementById('sheet-host').addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.blatt) blattSchliessen(); });
    document.getElementById('seg-seite').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-k]');
      if (!b) return;
      if (S.blatt) blattSchliessen();
      S.seite = b.dataset.k;
      alles(true);
    });
    document.getElementById('seg-fall').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-k]');
      if (!b) return;
      if (S.blatt) blattSchliessen();
      if (S.seite === 'preise') { S.preisFall = b.dataset.k; S.preisTag = 0; }
      else { S.wetterFall = b.dataset.k; S.wetterTag = 0; }
      alles(true);
    });
    entscheidungen();
    alles(true);
  }

  /* ---------- Offene Entscheidungen: in Lavish als Rückmeldung, sonst zum Einfügen kopieren ---------- */
  function entscheidungen() {
    const form = document.getElementById('ent-form');
    const status = document.getElementById('ent-status');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const items = [...form.querySelectorAll('fieldset')].map((fs) => {
        const wahl = fs.querySelector('input:checked');
        return { id: fs.querySelector('input').name, frage: fs.querySelector('legend').textContent.replace(/^E\d/, '').trim(), antwort: wahl ? wahl.value : 'offen' };
      });
      const text = `Entscheidungen zum Konzept „Preise und Wetter“:\n${items.map((i) => `${i.id}: ${i.antwort}`).join('\n')}`;
      form.querySelector('.ent-manual')?.remove();
      if (window.lavish && typeof window.lavish.queuePrompt === 'function') {
        window.lavish.queuePrompt('Setze diese Entscheidungen im Konzept „Preise und Wetter“ um und bestätige jede ID einzeln.', {
          tag: 'tracked-batch', text: `${items.length} Entscheidungen`, element: form, data: { items },
        });
        status.textContent = 'In Lavish vorgemerkt. Mit „Send to Agent“ absenden.';
        return;
      }
      try {
        if (!navigator.clipboard?.writeText) throw new Error('keine Zwischenablage');
        await navigator.clipboard.writeText(text);
        status.textContent = 'Kopiert. Bitte in den Chat einfügen.';
      } catch {
        const ta = document.createElement('textarea');
        ta.className = 'ent-manual';
        ta.readOnly = true;
        ta.rows = items.length + 1;
        ta.value = text;
        ta.setAttribute('aria-label', 'Antworten zum Kopieren');
        form.querySelector('.ent-send').after(ta);
        ta.focus();
        ta.select();
        status.textContent = 'Kopieren ging nicht. Der Text ist markiert und kann von Hand kopiert werden.';
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
