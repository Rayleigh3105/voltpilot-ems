/* Prototyp „Preise und Wetter", Fassung 2: Die große Zahl folgt dem Finger, ein Rechner „Wann?“
   sucht das passende Zeitfenster, das Wetter hat wischbare Tageskarten. Die Ableitungen sind rein
   und folgen den Regeln des Portals (preisFenster.ts, weather.ts, wetterLeistung.ts); wo sie neu
   sind, steht es dabei. */
(() => {
  const { TAGE, PREIS_FAELLE, WETTER_FAELLE, plan: planAus, rueckblick } = DATEN;
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
  const dauerWort = (min) => {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return `${m}${NBSP}Min`;
    return m ? `${h}${NBSP}Std ${m}${NBSP}Min` : `${h}${NBSP}Std`;
  };
  let UID = 0;
  let animieren = false;

  /* Feste Farben für SVG (Safari-sicher ohne var() in Attributen); dieselben Werte wie style.css. */
  const F = {
    preis: '#2563eb', vergangen: '#8494a7', gitter: '#e2e8f0', achse: '#475569', tinte: '#1e293b',
    guenstig: '#15803d', mittel: '#a8b4c3', teuer: '#ef4444', negativ: '#0e7490',
    laden: '#16a34a', abgeben: '#8b1e3f', planGrund: '#eef2f7',
    pv: '#e65100', pvFill: '#f59e0b', pvSoft: '#fef3e2', sonne: '#d97706', sonneSoft: '#fde9c7',
    fund: '#fff6e8', fundTinte: '#9a4a07', weiss: '#ffffff',
  };

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
    reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    timer: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
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

  // NEU: das Urteil im Vergleich zum Tag (E2). Negativ ist immer „unter null";
  // unter 5 ct Tagesspanne gibt es kein Urteil (dieselbe Schwelle wie die Fenster).
  const URTEIL = { negativ: 'unter null', guenstig: 'günstig', mittel: 'mittel', teuer: 'teuer', ruhig: 'gleichmäßig' };
  function stufen(cts) {
    const s = [...cts].sort((a, b) => a - b);
    const ruhig = s[s.length - 1] - s[0] < MIN_SPANNE_CT;
    const t1 = s[Math.floor(s.length / 3)];
    const t2 = s[Math.floor((2 * s.length) / 3)];
    return (v) => (v < 0 ? 'negativ' : ruhig ? 'ruhig' : v <= t1 ? 'guenstig' : v >= t2 ? 'teuer' : 'mittel');
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
    let s1;
    let um = null;
    if (drin(g)) {
      s1 = g.art === 'negativ'
        ? `Börsenpreis unter null, noch bis <b>${uhr(g.bis + 1)}${NBSP}Uhr</b>.`
        : `Die günstigste Zeit des Tages, noch bis <b>${uhr(g.bis + 1)}${NBSP}Uhr</b>.`;
      um = 'g';
    } else if (drin(t)) {
      s1 = `Die teuerste Zeit des Tages, noch bis <b>${uhr(t.bis + 1)}${NBSP}Uhr</b>.`;
      um = 't';
    } else if (kommt(g) && (!kommt(t) || g.von < t.von)) {
      s1 = `Am günstigsten wird es heute <b>${spanne(g)}</b>.`;
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

  // NEU: „Wann starten?". Günstigster zusammenhängender Block der gewählten Dauer unter den
  // bekannten kommenden Viertelstunden (heute ab jetzt, morgen, sobald veröffentlicht).
  // Nur Rechnung auf bekannten Preisen; kein Plan, schaltet nichts.
  function startfenster(fall, jetzt, stunden, wert) {
    const len = stunden * 4;
    const folge = [];
    for (let i = jetzt; i < 96; i++) folge.push({ tag: 0, i, v: wert(fall.heute[i]) });
    if (fall.morgen) for (let i = 0; i < 96; i++) folge.push({ tag: 1, i, v: wert(fall.morgen[i]) });
    if (folge.length < len) return null;
    let best = null;
    for (let k = 0; k + len <= folge.length; k++) {
      const m = summe(folge.slice(k, k + len).map((x) => x.v)) / len;
      if (!best || m < best.m - 1e-9) best = { k, m };
    }
    const jetztM = summe(folge.slice(0, len).map((x) => x.v)) / len;
    return { start: folge[best.k], ende: folge[best.k + len - 1], m: best.m, jetztM };
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
  const verbinde = (gem, erw) => Array.from({ length: 96 }, (_, i) => gem?.[i] ?? erw?.[i] ?? null);
  const ghi96 = (stunden) =>
    Array.from({ length: 96 }, (_, i) => {
      const h = (i + 0.5) / 4 - 0.5;
      const a = stunden[Math.max(0, Math.min(23, Math.floor(h)))];
      const b = stunden[Math.max(0, Math.min(23, Math.floor(h) + 1))];
      const f = h - Math.floor(h);
      return Math.round(a.ghi * (1 - f) + b.ghi * f);
    });
  // Der stärkste Block einer Reihe ab einem Index (nur lückenlose Blöcke).
  function staerkster(werte, len, ab = 0) {
    let best = null;
    for (let i = ab; i + len <= werte.length; i++) {
      const teil = werte.slice(i, i + len);
      if (teil.some((v) => v == null)) continue;
      const m = summe(teil) / len;
      if (!best || m > best.m + 1e-9) best = { von: i, bis: i + len - 1, m };
    }
    return best && best.m > 0.05 ? best : null;
  }
  // NEU: „Wann ist am meisten Sonne?" über heute (ab jetzt) und morgen. Erwartete Erzeugung,
  // kein Überschuss: Haus und Speicher brauchen einen Teil davon.
  function sonnenfenster(fall, stunden) {
    const len = stunden * 4;
    const ohne = !!fall.ohnePrognose;
    const jetzt = Math.floor(fall.minute / 15);
    const r0 = ohne ? ghi96(fall.tage[0].stunden) : fall.pv[0].erwartet;
    const r1 = ohne ? ghi96(fall.tage[1].stunden) : fall.pv[1].erwartet;
    const folge = [];
    for (let i = jetzt; i < 96; i++) folge.push({ tag: 0, i, v: r0[i] });
    for (let i = 0; i < 96; i++) folge.push({ tag: 1, i, v: r1[i] });
    let best = null;
    for (let k = 0; k + len <= folge.length; k++) {
      const teil = folge.slice(k, k + len);
      if (teil.some((x) => x.v == null)) continue;
      const m = summe(teil.map((x) => x.v)) / len;
      if (!best || m > best.m + 1e-9) best = { k, m };
    }
    if (!best) return null;
    return { start: folge[best.k], ende: folge[best.k + len - 1], m: best.m, ohne };
  }

  /* ---------- Zustand ---------- */
  const S = {
    seite: 'preise', blatt: false, rb: 'woche',
    preisFall: 'vormittag', preisTag: 0, preisSel: null, preisDauer: null,
    wetterFall: 'sonnig', wetterTag: 0, wetterSel: null, wetterDauer: null,
  };

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

  /* ---------- Preise: Kontext, Moment, Seite ---------- */
  function preisKontext() {
    const fall = PREIS_FAELLE[S.preisFall];
    if (!fall.morgen) S.preisTag = 0;
    const jetzt = Math.floor(fall.minute / 15);
    const roh = S.preisTag === 1 ? fall.morgen : fall.heute;
    const wert = (v) => v;
    return {
      fall, jetzt, roh, wert,
      werte: roh.map(wert),
      stufe: stufen(roh),
      plan: planAus(roh, S.preisTag === 0 ? jetzt : 0),
      finder: S.preisDauer ? startfenster(fall, jetzt, S.preisDauer, wert) : null,
    };
  }
  const reiheWort = () => 'Börsenpreis';

  // Der Moment oben: jetzt, oder die Viertelstunde, auf der der Finger liegt.
  function momentPreis(root, sel) {
    const q = (n) => root.querySelector(`[data-m="${n}"]`);
    if (!q('num')) return;
    const k = preisKontext();
    const heute = S.preisTag === 0;
    const i = sel ?? (heute ? k.jetzt : null);
    q('jetzt').hidden = heute && (sel == null || sel === k.jetzt);
    const chip = q('chip');
    if (i == null) {
      const fs = fenster(k.roh);
      const g = guenstigstes(fs);
      const t = fs.find((f) => f.art === 'teuer');
      q('eye').textContent = `${reiheWort()} · morgen · ${TAGE[1].kurz}`;
      q('num').innerHTML = `<span class="pre">Ø</span>${zahl(summe(k.werte) / k.werte.length)}<small>ct/kWh</small>`;
      chip.hidden = true;
      q('say').innerHTML = g && t
        ? `Morgen am günstigsten <b>${spanne(g)}</b>.<span class="leise">Am teuersten ${spanne(t)}. Wischen zeigt jede Viertelstunde.</span>`
        : 'Morgen bleibt der Preis den ganzen Tag ähnlich.';
      q('own').innerHTML = '';
      return;
    }
    const roh = k.roh[i];
    const u = k.stufe(roh);
    let eye;
    if (heute && i === k.jetzt) eye = `${reiheWort()} · jetzt ${uhr(i)}–${uhr(i + 1)}`;
    else if (heute && i < k.jetzt) eye = `${uhr(i)}–${uhr(i + 1)} · vorbei`;
    else if (heute) eye = `${uhr(i)}–${uhr(i + 1)} · in ${dauerWort(i * 15 - k.fall.minute)}`;
    else eye = `Morgen ${uhr(i)}–${uhr(i + 1)}`;
    q('eye').textContent = eye;
    q('num').innerHTML = `${zahl(k.wert(roh))}<small>ct/kWh</small>`;
    chip.hidden = false;
    chip.className = `verdict v-${u}`;
    chip.innerHTML = `<i></i>${URTEIL[u]}`;
    let say;
    if (heute && i === k.jetzt) {
      const { s1, s2 } = preisSaetze(k.fall, k.jetzt);
      say = `${s1}${s2 ? `<span class="leise">${s2}</span>` : ''}`;
    } else if (heute && i < k.jetzt) say = 'Diese Viertelstunde ist vorbei.';
    else {
      const p = k.plan[i];
      say = p === 1 ? 'Laut Plan lädt Ihr Speicher in dieser Viertelstunde.'
        : p === -1 ? 'Laut Plan gibt Ihr Speicher in dieser Viertelstunde ab.'
          : 'Laut Plan ruht Ihr Speicher in dieser Viertelstunde.';
    }
    q('say').innerHTML = say;
    q('own').textContent = 'Dazu kommen bei Ihnen Aufschlag, Netzentgelt, Abgaben und Steuern.';
  }

  function finderPreisHtml(k) {
    if (!S.preisDauer) return '<p class="f-leer">Dauer antippen. Die günstigste Startzeit erscheint hier und in den Balken.</p>';
    const f = k.finder;
    if (!f) return `<p class="f-leer">Für ${S.preisDauer}${NBSP}Stunden reichen die bekannten Preise nicht mehr. Die Preise für morgen kommen gegen 13 Uhr.</p>`;
    const tagWort = (x) => (x.tag === 0 ? 'heute' : 'morgen');
    const sofort = f.start.tag === 0 && f.start.i === k.jetzt;
    const kopf = sofort ? 'Jetzt starten' : `Start ${tagWort(f.start)} ${uhr(f.start.i)}${NBSP}Uhr`;
    const ende = `fertig ${f.ende.tag !== f.start.tag ? 'morgen ' : ''}${uhr(f.ende.i + 1)}${NBSP}Uhr`;
    const diff = f.jetztM - f.m;
    const spar = !sofort && diff >= 0.05
      ? `<p class="f-spar">${zahl(diff)}${NBSP}ct/kWh weniger als bei Start jetzt</p>`
      : sofort ? '<p class="f-spar">Später wird es für diese Dauer nicht günstiger.</p>' : '';
    const bis = k.fall.morgen ? 'Gesucht bis morgen 24 Uhr.' : 'Gesucht bis heute 24 Uhr. Die Preise für morgen kommen gegen 13 Uhr.';
    return `<div class="f-box">
        <p class="f-kopf">${kopf}</p>
        <p class="f-zeile">${ende} · Ø ${ctW(f.m)}</p>
        ${spar}
        <button type="button" class="f-zeig" data-act="pzeig">In den Balken zeigen ${ico('right')}</button>
      </div>
      <p class="f-note">${bis} </p>`;
  }

  function preisSeite() {
    const k = preisKontext();
    const fall = k.fall;
    const chips = [1, 2, 3, 4].map((n) => `<button type="button" aria-pressed="${S.preisDauer === n}" data-act="pdauer" data-n="${n}">${n}${NBSP}Std</button>`).join('');
    const hatNeg = k.roh.some((v) => v < 0);
    const tagName = S.preisTag === 1 ? TAGE[1] : TAGE[0];
    const profi = [
      ['Minimum', Math.min(...k.roh) * 10], ['Durchschnitt', (summe(k.roh) / k.roh.length) * 10],
      ['Maximum', Math.max(...k.roh) * 10], ['Spanne', (Math.max(...k.roh) - Math.min(...k.roh)) * 10],
    ].map(([n, w]) => `<tr><th scope="row">${n}</th><td>${zahl(w, 2)}${NBSP}EUR/MWh</td></tr>`).join('');
    return `<div class="pv"><div class="pv-grid">
      <div class="pv-col">
        <section class="ans" aria-label="Preis der gewählten Viertelstunde">
          <div class="m-top"><p class="ans-eye" data-m="eye"></p><button type="button" class="m-jetzt" data-act="pjetzt" data-m="jetzt" hidden>${ico('reset')}Jetzt</button></div>
          <div class="ans-line"><p class="ans-num" data-m="num"></p><span class="verdict" data-m="chip"></span></div>
          <p class="ans-say" data-m="say"></p>
          <p class="ans-own" data-m="own"></p>
        </section>
        <section class="card" aria-label="Tagesverlauf">
          <div class="card-h"><h2>Tagesverlauf</h2>
          </div>
          <div class="daysw" role="tablist" aria-label="Tag">
            <button type="button" role="tab" aria-selected="${S.preisTag === 0}" data-act="ptag" data-tag="0">Heute<small>${TAGE[0].kurz}</small></button>
            <button type="button" role="tab" aria-selected="${S.preisTag === 1}" data-act="ptag" data-tag="1" ${fall.morgen ? '' : 'disabled'}>Morgen<small>${fall.morgen ? TAGE[1].kurz : 'ab ca. 13 Uhr'}</small></button>
          </div>
          <p class="hint">${ico('wisch')}Über die Balken wischen</p>
          <div class="chart" data-chart="preis" tabindex="0" role="slider" aria-label="${reiheWort()} ${tagName.wort.toLowerCase()} je Viertelstunde" aria-valuemin="0" aria-valuemax="95"></div>
          <div class="legend">
            <span><i style="background:var(--lvl-guenstig)"></i>günstig</span>
            <span><i style="background:var(--lvl-mittel)"></i>mittel</span>
            <span><i style="background:var(--lvl-teuer)"></i>teuer</span>
            ${hatNeg ? `<span><i style="background:var(--neg)"></i>unter null</span>` : ''}
            <span class="leg-note">im Vergleich zum Tag</span>
          </div>
          <div class="legend">
            <span><i class="flach" style="background:var(--batt)"></i>Speicher lädt</span>
            <span><i class="flach" style="background:var(--battdis)"></i>gibt ab</span>
            <span class="leg-note">laut Plan</span>
          </div>
          <p class="stat">Ø ${zahl(summe(k.werte) / 96)} · günstigste ${zahl(Math.min(...k.werte))} · teuerste ${zahl(Math.max(...k.werte))}${NBSP}ct/kWh</p>
        </section>
      </div>
      <div class="pv-col">
        <section class="card finder" aria-label="Startzeit finden">
          <div class="card-h"><h2>${ico('timer')}Wann starten?</h2></div>
          <p class="f-frage">Wie lange läuft Ihr Gerät?</p>
          <div class="chips" role="group" aria-label="Dauer">${chips}</div>
          <div class="fund">${finderPreisHtml(k)}</div>
        </section>
        <nav class="links" aria-label="Weiter">
          <a class="linkrow" href="#" data-act="nicht"><span class="li">${ico('calendar')}</span><span class="lt">So nutzt Ihr Speicher diese Preise<small>Zum Fahrplan</small></span>${ico('right')}</a>
          <button type="button" class="linkrow" data-act="blatt"><span class="li">${ico('history')}</span><span class="lt">Rückblick<small>Woche, Monat und Jahr</small></span>${ico('right')}</button>
        </nav>
        <details class="explain">
          <summary><span>Was ist der Börsenstrompreis?</span>${ico('right')}</summary>
          <div class="ex">
            <p>Er entsteht jeden Tag in der Day-Ahead-Auktion für die Gebotszone Deutschland-Luxemburg (DE-LU) und gilt je Viertelstunde. Die Preise für morgen stehen gegen 13 Uhr fest.</p>
            <p><b>Was Sie zahlen</b> ist höher: Zum Börsenpreis kommen der Aufschlag Ihres Anbieters, Netzentgelte, Abgaben und Steuern. Sie steigen und fallen aber mit dem Börsenpreis; günstige Zeiten bleiben günstig.</p>
            <p><b>Günstig, mittel, teuer</b> gelten im Vergleich zum Tag: unteres, mittleres und oberes Drittel der Viertelstunden. Unter null ist immer „unter null“.</p>
            <p><b>Wann starten?</b> rechnet nur mit Preisen, die schon feststehen, und nur nach vorn. Es plant und schaltet nichts.</p>
            <table class="profi"><caption class="sr">Werte für Fachleute, ${tagName.wort}</caption>${profi}</table>
            <p style="margin-top:10px">Quelle: energy-charts.info (Fraunhofer ISE).</p>
          </div>
        </details>
      </div>
    </div></div>`;
  }

  /* ---------- Wetter: Kontext, Moment, Seite ---------- */
  function wetterKontext() {
    const fall = WETTER_FAELLE[S.wetterFall];
    const t = S.wetterTag;
    const tag = fall.tage[t];
    const ohne = !!fall.ohnePrognose;
    const ghiModus = ohne || !fall.pv[t];
    const gem = t === 0 ? fall.pv[0].gemessen : null;
    const erw = ghiModus ? null : fall.pv[t].erwartet;
    return {
      fall, t, tag, ohne, ghiModus, gem, erw,
      reihe: ghiModus ? ghi96(tag.stunden) : verbinde(gem, erw),
      jetzt: t === 0 ? Math.floor(fall.minute / 15) : null,
      finder: S.wetterDauer ? sonnenfenster(fall, S.wetterDauer) : null,
    };
  }

  function momentWetter(root, sel) {
    const q = (n) => root.querySelector(`[data-w="${n}"]`);
    if (!q('main')) return;
    const k = wetterKontext();
    const heute = k.t === 0;
    const i = sel ?? (heute ? k.jetzt : null);
    q('jetzt').hidden = heute && (sel == null || sel === k.jetzt);
    if (i == null) {
      const a = tagHimmel(k.tag.stunden);
      const tp = tempSpanne(k.tag.stunden);
      q('ico').className = `wm-ico w-${a}`;
      q('ico').innerHTML = ico(HIMMEL_ICO[a]);
      q('eye').textContent = `${TAGE[k.t].wort} · ${TAGE[k.t].kurz} · ganzer Tag`;
      q('main').textContent = `${HIMMEL_GROSS[a]} · ${tp.tief} bis ${tp.hoch}${NBSP}°C`;
      q('pv').textContent = k.ghiModus ? 'Leistungsprognose reicht noch nicht so weit' : `≈${NBSP}${zahl(kwhAus(k.erw), 0)}${NBSP}kWh Sonnenstrom erwartet`;
      return;
    }
    const h = Math.floor(i / 4);
    const st = k.tag.stunden[h];
    const a = himmel(st.cloud);
    const nacht = h < 7 || h >= 19;
    q('ico').className = `wm-ico w-${nacht && a !== 'bewoelkt' ? 'nacht' : a}`;
    q('ico').innerHTML = ico(nacht && a !== 'bewoelkt' ? 'moon' : HIMMEL_ICO[a]);
    let zeit;
    if (heute && i === k.jetzt) zeit = `Jetzt · ${minUhr(k.fall.minute)}`;
    else if (heute && i < k.jetzt) zeit = `${uhr(i)}–${uhr(i + 1)} · vorbei`;
    else if (heute) zeit = `${uhr(i)}–${uhr(i + 1)} · in ${dauerWort(i * 15 - k.fall.minute)}`;
    else zeit = `${TAGE[k.t].wort} ${uhr(i)}–${uhr(i + 1)}`;
    q('eye').textContent = zeit;
    q('main').textContent = `${zahl(st.temp, 0)}${NBSP}°C · ${HIMMEL[a]}`;
    const v = k.reihe[i];
    if (k.ghiModus) q('pv').textContent = `Sonne ${v}${NBSP}W/m²`;
    else if (v == null) q('pv').textContent = 'Sonnenstrom: keine Angabe';
    else q('pv').textContent = `${kwW(v)} Sonnenstrom · ${k.gem && k.gem[i] != null ? 'gemessen' : 'erwartet'}`;
  }

  function tagKarte(fall, t) {
    const tg = fall.tage[t];
    const a = tagHimmel(tg.stunden);
    const tp = tempSpanne(tg.stunden);
    const ohne = !!fall.ohnePrognose;
    const gem = kwhAus(fall.pv[0].gemessen);
    let pv;
    if (ohne) pv = t === 0 ? `${zahl(gem, 1)}${NBSP}kWh<small>bisher gemessen</small>` : '—<small>keine Prognose</small>';
    else if (t === 0) pv = `≈${NBSP}${zahl(gem + kwhAus(fall.pv[0].erwartet), 0)}${NBSP}kWh<small>${zahl(gem, 1)} schon erzeugt</small>`;
    else if (fall.pv[t]) pv = `≈${NBSP}${zahl(kwhAus(fall.pv[t].erwartet), 0)}${NBSP}kWh<small>erwartet</small>`;
    else pv = '—<small>Prognose folgt</small>';
    return `<button type="button" role="tab" aria-selected="${S.wetterTag === t}" class="tagk" data-act="wtag" data-tag="${t}">
      <span class="tk-kopf"><b>${TAGE[t].wort}</b><small>${TAGE[t].kurz}</small></span>
      <span class="tk-mitte"><span class="tk-ico w-${a}">${ico(HIMMEL_ICO[a])}</span><span class="tk-txt"><span class="tk-wort">${HIMMEL_GROSS[a]}</span><span class="tk-temp">${tp.tief} bis ${tp.hoch}${NBSP}°C</span></span></span>
      <span class="tk-pv">${pv}</span>
    </button>`;
  }

  function wetterSatz(k) {
    const wort = k.t === 0 ? 'heute' : k.t === 1 ? 'morgen' : `am ${TAGE[k.t].name}`;
    const ab = k.t === 0 ? k.jetzt : 0;
    let spitze = null;
    k.reihe.forEach((v, i) => { if (i >= ab && v != null && v > (k.ghiModus ? 4 : 0.05) && (!spitze || v > spitze.v)) spitze = { i, v }; });
    const gegen = (i) => `gegen <b>${Math.round((i * 15 + 7) / 60)}${NBSP}Uhr</b>`;
    if (!spitze) return `Die Sonne ist für ${wort} durch.`;
    if (k.ghiModus) {
      const grund = k.ohne ? 'Eine Leistungsprognose für Ihre Anlage gibt es noch nicht.' : `Die Leistungsprognose reicht noch nicht bis ${TAGE[k.t].name}.`;
      return `Die Sonne ist ${wort} ${gegen(spitze.i)} am stärksten.<span class="leise">${grund}</span>`;
    }
    if (k.t === 0 && spitze.i <= ab + 1) {
      return `Die stärkste Sonne ist für heute vorbei.<span class="leise">Noch ≈${NBSP}${zahl(kwhAus(k.erw), 0)}${NBSP}kWh bis zum Abend.</span>`;
    }
    return `Am meisten Sonnenstrom ${wort} ${gegen(spitze.i)}, bis ${kwW(spitze.v)}.`;
  }

  function finderWetterHtml(k) {
    if (!S.wetterDauer) return '<p class="f-leer">Dauer antippen. Das sonnigste Zeitfenster erscheint hier und in der Kurve.</p>';
    const f = k.finder;
    if (!f) return '<p class="f-leer">In den bekannten Stunden gibt es kein Zeitfenster mit Sonne.</p>';
    const tagWort = f.start.tag === 0 ? 'Heute' : 'Morgen';
    const ende = `${f.ende.tag !== f.start.tag ? 'morgen ' : ''}${uhr(f.ende.i + 1)}`;
    const wert = f.ohne ? `Ø ${Math.round(f.m)}${NBSP}W/m² Sonneneinstrahlung` : `Ø ${kwW(f.m)} erwartet`;
    return `<div class="f-box">
        <p class="f-kopf">${tagWort} ${uhr(f.start.i)}–${ende}${NBSP}Uhr</p>
        <p class="f-zeile">${wert}</p>
        <button type="button" class="f-zeig" data-act="wzeig">In der Kurve zeigen ${ico('right')}</button>
      </div>
      <p class="f-note">${f.ohne ? 'Ohne Leistungsprognose zählt die Sonneneinstrahlung am Standort.' : 'Erwartete Erzeugung der Anlage. Haus und Speicher brauchen einen Teil davon.'}</p>`;
  }

  function wetterSeite() {
    const k = wetterKontext();
    const fall = k.fall;
    const chips = [1, 2, 3, 4].map((n) => `<button type="button" aria-pressed="${S.wetterDauer === n}" data-act="wdauer" data-n="${n}">${n}${NBSP}Std</button>`).join('');
    const von = k.t === 0 ? Math.floor(fall.minute / 60) : 6;
    const bis = k.t === 0 ? Math.min(24, von + 12) : 21;
    const stunden = [];
    for (let h = von; h < bis; h++) {
      const st = k.tag.stunden[h];
      const a = himmel(st.cloud);
      const nacht = h < 7 || h >= 19;
      const jetztStunde = k.t === 0 && h === von;
      const teil = k.reihe.slice(h * 4, h * 4 + 4).filter((v) => v != null);
      const mittel = teil.length ? summe(teil) / teil.length : null;
      const unten = k.ghiModus ? `${st.cloud}${NBSP}%` : mittel != null && mittel > 0.05 ? kwW(mittel) : NBSP;
      const slot = jetztStunde ? '' : String(h * 4);
      const gewaehlt = jetztStunde ? S.wetterSel == null : S.wetterSel != null && Math.floor(S.wetterSel / 4) === h;
      stunden.push(`<button type="button" class="hour${gewaehlt ? ' sel' : ''}" data-act="stunde" data-slot="${slot}" aria-pressed="${gewaehlt}" aria-label="${h} Uhr, ${HIMMEL[a]}, ${zahl(st.temp, 0)} Grad">
        <span class="h">${jetztStunde ? 'Jetzt' : `${h} Uhr`}</span>${ico(nacht && a !== 'bewoelkt' ? 'moon' : HIMMEL_ICO[a])}<span class="t">${zahl(st.temp, 0)}°</span>
        <span class="k${k.ghiModus ? ' leer' : ''}">${unten}</span></button>`);
    }
    return `<div class="pv"><div class="pv-grid">
      <div class="pv-col">
        <section class="tagwahl" aria-label="Die nächsten Tage">
          <p class="ans-eye">Wetter am Standort · Stand ${minUhr(fall.minute)}</p>
          <div class="tage" role="tablist" aria-label="Tag" data-tage>${fall.tage.map((_, t) => tagKarte(fall, t)).join('')}</div>
          <p class="ans-say tag-satz">${wetterSatz(k)}</p>
        </section>
        <section class="card" aria-label="Tagesverlauf">
          <div class="wm">
            <span class="wm-ico" data-w="ico"></span>
            <div class="wm-txt"><p class="wm-eye" data-w="eye"></p><p class="wm-main" data-w="main"></p><p class="wm-pv" data-w="pv"></p></div>
          </div>
          <div class="hint-zeile"><p class="hint">${ico('wisch')}Über die Kurve wischen</p><button type="button" class="m-jetzt" data-act="wjetzt" data-w="jetzt" hidden>${ico('reset')}Jetzt</button></div>
          <div class="chart" data-chart="wetter" tabindex="0" role="slider" aria-label="${k.ghiModus ? 'Sonneneinstrahlung' : 'Sonnenstrom'} je Viertelstunde" aria-valuemin="0" aria-valuemax="95"></div>
          <div class="legend" data-wlegende></div>
          ${k.ghiModus ? `<p class="note" style="margin:6px 0 10px">${k.ohne ? 'Für Ihre Anlage liegt noch keine Leistungsprognose vor. Bis dahin zeigt die Kurve die Sonneneinstrahlung am Standort.' : `Die Leistungsprognose reicht 48 Stunden. Für ${TAGE[k.t].name} zeigt die Kurve die Sonneneinstrahlung am Standort.`}</p>` : ''}
        </section>
      </div>
      <div class="pv-col">
        <section class="card finder" aria-label="Sonniges Zeitfenster finden">
          <div class="card-h"><h2>${ico('timer')}Wann ist am meisten Sonne?</h2></div>
          <p class="f-frage">Wie lange läuft Ihr Gerät?</p>
          <div class="chips" role="group" aria-label="Dauer">${chips}</div>
          <div class="fund">${finderWetterHtml(k)}</div>
        </section>
        <section class="card" aria-label="Stunde für Stunde">
          <div class="card-h"><h2>Stunde für Stunde</h2><span>${TAGE[k.t].wort}</span></div>
          <div class="hours">${stunden.join('')}</div>
        </section>
        <details class="explain">
          <summary><span>Woher kommen diese Werte?</span>${ico('right')}</summary>
          <div class="ex">
            <p><b>Wetter:</b> Open-Meteo für den Standort Ihrer Anlage, stündlich aktualisiert, drei Tage voraus.</p>
            <p><b>Sonnenstrom erwartet:</b> die PV-Prognose Ihrer Anlage, bis 48 Stunden voraus. Mit ihr rechnet auch Ihr Fahrplan. <b>Gemessen:</b> die Messwerte Ihrer Anlage bis jetzt.</p>
            <p><b>Himmel:</b> sonnig bis 40 % Bewölkung, bewölkt ab 65 %, dazwischen wechselnd. Für den ganzen Tag zählt das Mittel von 6 bis 21 Uhr.</p>
            <p><b>Wann ist am meisten Sonne?</b> sucht das Zeitfenster mit der höchsten erwarteten Erzeugung, heute ab jetzt und morgen. Es sagt nicht, wie viel davon für Ihr Gerät übrig bleibt.</p>
          </div>
        </details>
      </div>
    </div></div>`;
  }

  /* ---------- Zeichnen: gemeinsame Teile ---------- */
  const lbl = (x, y, text, o = {}) =>
    `<text x="${x}" y="${y}" font-size="${o.size ?? 11}" font-weight="${o.weight ?? 600}" fill="${o.fill ?? F.achse}" text-anchor="${o.anchor ?? 'middle'}"${o.halo ? ` stroke="${F.weiss}" stroke-width="4" stroke-linejoin="round" paint-order="stroke"` : ''}>${text}</text>`;
  const breite = (text, size = 11) => text.length * size * 0.56;
  const klemm = (mitte, text, links, rechts, size) => {
    const b = breite(text, size) / 2;
    return Math.max(links + b, Math.min(rechts - b, mitte));
  };
  // Klammer über einem Zeitfenster mit Beschriftung (der Fund des Rechners „Wann?").
  function klammer(x0, x1, y, text, links, rechts, farbe) {
    const mitte = klemm((x0 + x1) / 2, text, links, rechts, 11.5);
    return `<path d="M${x0 + 1},${y + 6}V${y}H${x1 - 1}V${y + 6}" fill="none" stroke="${farbe}" stroke-width="1.6" stroke-linejoin="round"/>`
      + lbl(mitte, y - 5, text, { size: 11.5, weight: 800, fill: farbe, halo: true });
  }

  /* Wischen, Zeigen, Tasten. Die Auswahl bleibt nach dem Loslassen stehen; mit der Maus zeigt
     Überfahren eine Vorschau, Klicken setzt sie. „Jetzt" setzt zurück. */
  function interaktiv(host, n, x0, x1, geo, bei, start) {
    const svg = host.querySelector('svg');
    const cur = svg.querySelector('[data-cur]');
    const zeige = (i) => {
      if (i == null) {
        cur.setAttribute('visibility', 'hidden');
        host.removeAttribute('aria-valuenow');
        host.removeAttribute('aria-valuetext');
        return;
      }
      const g = geo(i);
      for (const [name, attrs] of Object.entries(g)) {
        if (name === 'text') continue;
        const el = cur.querySelector(`[data-c="${name}"]`);
        if (el) for (const [a, v] of Object.entries(attrs)) el.setAttribute(a, v);
      }
      cur.setAttribute('visibility', 'visible');
      host.setAttribute('aria-valuenow', String(i));
      host.setAttribute('aria-valuetext', g.text);
    };
    let fest = start;
    let stunde = null;
    const tick = (i) => {
      const h = Math.floor(i / 4);
      if (h === stunde) return;
      stunde = h;
      try { navigator.vibrate?.(4); } catch { /* Haptik ist optional */ }
    };
    const ausZeiger = (e) => {
      const r = svg.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * svg.viewBox.baseVal.width;
      if (x < x0 - 10 || x > x1 + 10) return null;
      return Math.max(0, Math.min(n - 1, Math.floor(((x - x0) / (x1 - x0)) * n)));
    };
    const setze = (i) => { fest = i; zeige(i); bei(i, true); };
    host.onpointerdown = (e) => {
      const i = ausZeiger(e);
      if (i == null) return;
      tick(i);
      setze(i);
    };
    host.onpointermove = (e) => {
      const i = ausZeiger(e);
      if (i == null) return;
      if (e.pointerType === 'mouse' && !e.buttons) { zeige(i); bei(i, false); return; }
      if (e.buttons && i !== fest) { tick(i); setze(i); }
    };
    host.onpointerleave = (e) => {
      if (e.pointerType === 'mouse') { zeige(fest); bei(fest, false); }
    };
    host.onkeydown = (e) => {
      const schritt = e.shiftKey ? 4 : 1;
      let i = fest;
      if (e.key === 'ArrowRight') i = Math.min(n - 1, (fest ?? -1) + schritt);
      else if (e.key === 'ArrowLeft') i = Math.max(0, (fest ?? n) - schritt);
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = n - 1;
      else if (e.key === 'Escape') i = null;
      else return;
      e.preventDefault();
      setze(i);
    };
    host._waehle = setze;
    zeige(fest);
    bei(fest, false);
  }

  /* ---------- Zeichnen: Preis als Balken je Viertelstunde ---------- */
  function zeichnePreis(host, root) {
    const k = preisKontext();
    const W = Math.max(280, Math.round(host.clientWidth));
    const breit = W > 560;
    const hatPlan = k.plan.some((p) => p != null);
    const m = { l: 30, r: 8, t: 30, b: hatPlan ? 42 : 26 };
    const H = (breit ? 270 : 224) + (hatPlan ? 16 : 0);
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const n = k.werte.length;
    const lo = Math.min(0, ...k.werte);
    const hi = Math.max(...k.werte);
    const step = hi - lo > 26 ? 10 : 5;
    const y0 = Math.floor(lo / step) * step;
    const y1 = Math.max(step, Math.ceil((hi + 0.4) / step) * step);
    const X = (i) => m.l + (i / n) * pw;
    const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * ph;
    const jetzt = S.preisTag === 0 ? k.jetzt : -1;
    const f = k.finder;
    const fw = f
      ? { von: f.start.tag === S.preisTag ? f.start.i : f.start.tag < S.preisTag ? 0 : null, bis: f.ende.tag === S.preisTag ? f.ende.i : f.ende.tag > S.preisTag ? n - 1 : null }
      : null;
    const fund = fw && fw.von != null && fw.bis != null ? fw : null;

    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" class="${animieren ? 'wachse' : ''}">`;
    for (let v = y0; v <= y1 + 1e-9; v += step) {
      s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 && lo < 0 ? '#64748b' : F.gitter}" stroke-width="1"/>`;
      s += lbl(m.l - 6, Y(v) + 4, zahl(v, 0), { anchor: 'end', weight: 500 });
    }
    s += lbl(0, 11, 'ct/kWh', { anchor: 'start', weight: 600 });
    if (fund) s += `<rect x="${X(fund.von)}" y="${m.t}" width="${X(fund.bis + 1) - X(fund.von)}" height="${ph}" fill="${F.fund}" opacity=".8"/>`;
    const farbe = { guenstig: F.guenstig, mittel: F.mittel, teuer: F.teuer, negativ: F.negativ, ruhig: F.mittel };
    s += '<g class="bars">';
    for (let i = 0; i < n; i++) {
      const v = k.werte[i];
      const x = X(i) + 0.55;
      const w = Math.max(1.2, X(i + 1) - X(i) - 1.1);
      const y = v >= 0 ? Y(v) : Y(0);
      const h = Math.max(1, Math.abs(Y(v) - Y(0)));
      const vorbei = i < jetzt;
      const aussen = fund && (i < fund.von || i > fund.bis);
      const op = vorbei ? 0.3 : aussen ? 0.72 : 1;
      s += `<rect class="b${v < 0 ? ' neg' : ''}" style="--d:${i * 3}ms" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="1" fill="${farbe[k.stufe(k.roh[i])]}" opacity="${op}"/>`;
    }
    s += '</g>';
    if (jetzt >= 0) {
      const xNow = m.l + (k.fall.minute / 1440) * pw;
      const oben = Y(k.werte[jetzt]) > m.t + ph * 0.45;
      s += `<line x1="${xNow}" x2="${xNow}" y1="${m.t}" y2="${m.t + ph}" stroke="${F.tinte}" stroke-width="1.5" stroke-dasharray="3 3"/>`;
      const rechtsFrei = xNow < W - 60;
      s += lbl(rechtsFrei ? xNow + 6 : xNow - 6, oben ? m.t + 13 : m.t + ph - 7, 'jetzt', { anchor: rechtsFrei ? 'start' : 'end', weight: 700, fill: F.tinte, halo: true, size: 11.5 });
    }
    if (fund) s += klammer(X(fund.von), X(fund.bis + 1), m.t - 9, `${S.preisDauer}${NBSP}Std · Ø ${zahl(f.m)}`, m.l + 46, W - m.r, F.fundTinte);
    if (hatPlan) {
      const yP = m.t + ph + 7;
      const erster = k.plan.findIndex((p) => p != null);
      s += `<rect x="${X(erster)}" y="${yP}" width="${X(n) - X(erster)}" height="8" rx="2" fill="${F.planGrund}"/>`;
      let i = 0;
      while (i < n) {
        const p = k.plan[i];
        if (p !== 1 && p !== -1) { i++; continue; }
        let j = i;
        while (j + 1 < n && k.plan[j + 1] === p) j++;
        s += `<rect x="${X(i)}" y="${yP}" width="${X(j + 1) - X(i)}" height="8" rx="2" fill="${p === 1 ? F.laden : F.abgeben}"/>`;
        i = j + 1;
      }
    }
    [0, 6, 12, 18, 24].forEach((h) => {
      s += lbl(X(h * 4), H - 8, h === 24 ? '24 Uhr' : String(h), { anchor: h === 0 ? 'start' : h === 24 ? 'end' : 'middle', weight: 500 });
    });
    s += `<g data-cur visibility="hidden" pointer-events="none">
      <line data-c="line" y1="${m.t - 4}" y2="${m.t + ph + (hatPlan ? 17 : 2)}" stroke="${F.tinte}" stroke-width="1"/>
      <rect data-c="bar" fill="none" stroke="${F.tinte}" stroke-width="1.8" rx="2"/></g>`;
    s += '</svg>';
    host.innerHTML = s;
    host.setAttribute('aria-label', `${reiheWort()} ${S.preisTag === 0 ? 'heute' : 'morgen'} je Viertelstunde, von ${ctW(Math.min(...k.werte))} bis ${ctW(Math.max(...k.werte))}. Pfeiltasten wählen eine Viertelstunde, Escape springt zu jetzt.`);
    interaktiv(host, n, m.l, W - m.r, (i) => {
      const v = k.werte[i];
      const y = v >= 0 ? Y(v) : Y(0);
      const h = Math.max(1, Math.abs(Y(v) - Y(0)));
      const x = X(i);
      const w = X(i + 1) - X(i);
      return {
        line: { x1: x + w / 2, x2: x + w / 2 },
        bar: { x: x - 1, y: y - 2, width: w + 2, height: h + 4 },
        text: `${uhr(i)}–${uhr(i + 1)} Uhr, ${ctW(v, 2)}, ${URTEIL[k.stufe(k.roh[i])]}`,
      };
    }, (i, gesetzt) => {
      if (gesetzt) S.preisSel = i;
      momentPreis(root, i);
    }, S.preisSel);
  }

  /* ---------- Zeichnen: Wetter ---------- */
  function zeichneWetter(host, root) {
    const k = wetterKontext();
    const W = Math.max(280, Math.round(host.clientWidth));
    const breit = W > 560;
    const reihe = k.reihe;
    const hatWert = reihe.map((v) => v != null && v > (k.ghiModus ? 4 : 0.02));
    const erster = hatWert.indexOf(true);
    const letzter = hatWert.lastIndexOf(true);
    const hVon = Math.max(0, Math.floor(erster / 4) - 1);
    const hBis = Math.min(24, Math.ceil((letzter + 1) / 4) + 1);
    const a = hVon * 4;
    const z = hBis * 4;
    const m = { l: 30, r: 10, t: 52, b: 24 };
    const H = breit ? 280 : 240;
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const X = (i) => m.l + ((i - a) / (z - a)) * pw;
    const top = Math.max(...reihe.filter((v) => v != null));
    const step = k.ghiModus ? 200 : top > 8 ? 4 : 2;
    const y1 = Math.max(step, Math.ceil((top * 1.12) / step) * step);
    const Y = (v) => m.t + (1 - v / y1) * ph;
    const id = `w${++UID}`;
    const f = k.finder;
    const fund = f && f.start.tag === k.t ? { von: f.start.i, bis: f.ende.tag === k.t ? f.ende.i : 95 } : null;

    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><defs>
      <pattern id="${id}h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${F.pvSoft}"/><line x1="0" y1="0" x2="0" y2="6" stroke="${F.pvFill}" stroke-width="2.4" stroke-opacity=".6"/></pattern></defs>`;
    const farben = { sonnig: ['#fef3e2', '#9a4a07'], wechselnd: ['#fdf3e1', '#92400e'], bewoelkt: ['#eef1f5', '#334155'] };
    for (const b of himmelBloecke(k.tag.stunden, hVon, hBis)) {
      const x = X(b.von * 4) + 1;
      const w = X((b.bis + 1) * 4) - X(b.von * 4) - 2;
      s += `<rect x="${x}" y="2" width="${w}" height="24" rx="7" fill="${farben[b.art][0]}"/>`;
      const wort = HIMMEL[b.art];
      if (w > breite(wort, 11.5) + 12) s += lbl(x + w / 2, 18, wort, { size: 11.5, weight: 700, fill: farben[b.art][1] });
      else if (w >= 18) s += `<g transform="translate(${x + w / 2 - 8},6) scale(${16 / 24})" fill="none" stroke="${farben[b.art][1]}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[HIMMEL_ICO[b.art]]}</g>`;
    }
    for (let v = 0; v <= y1 + 1e-9; v += step) {
      s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${F.gitter}" stroke-width="1"/>`;
      s += lbl(m.l - 6, Y(v) + 4, k.ghiModus ? String(v) : zahl(v, 0), { anchor: 'end', weight: 500 });
    }
    s += lbl(W - m.r, m.t - 26, k.ghiModus ? 'W/m²' : 'kW', { anchor: 'end', weight: 600 });
    if (fund) s += `<rect x="${X(fund.von)}" y="${m.t}" width="${X(fund.bis + 1) - X(fund.von)}" height="${ph}" fill="${F.fund}"/>`;
    const pfad = (arr, von, bis) => {
      let p = '';
      for (let i = von; i <= bis; i++) p += `${p ? 'L' : 'M'}${X(i + 0.5).toFixed(2)},${Y(arr[i]).toFixed(2)}`;
      return p;
    };
    const lauf = (arr) => {
      const idx = arr.map((v, i) => (v != null ? i : -1)).filter((i) => i >= a && i < z);
      return idx.length ? [idx[0], idx[idx.length - 1]] : null;
    };
    let peak = null;
    if (k.ghiModus) {
      const l = lauf(reihe);
      const p = pfad(reihe, l[0], l[1]);
      s += `<path d="${p}L${X(l[1] + 0.5)},${Y(0)}L${X(l[0] + 0.5)},${Y(0)}Z" fill="${F.sonneSoft}" fill-opacity=".85"/>`;
      s += `<path d="${p}" fill="none" stroke="${F.sonne}" stroke-width="2.2" stroke-linejoin="round"/>`;
    } else {
      const lg = k.gem ? lauf(k.gem) : null;
      if (lg) {
        const p = pfad(k.gem, lg[0], lg[1]);
        s += `<path d="${p}L${X(lg[1] + 0.5)},${Y(0)}L${X(lg[0] + 0.5)},${Y(0)}Z" fill="${F.pvFill}" fill-opacity=".55"/>`;
        s += `<path d="${p}" fill="none" stroke="${F.pv}" stroke-width="2.2" stroke-linejoin="round"/>`;
      }
      const le = k.erw ? lauf(k.erw) : null;
      if (le) {
        // Die Prognose schließt an den letzten Messpunkt an, damit keine Lücke entsteht.
        const beginn = lg ? lg[1] : le[0];
        const arr = k.erw.map((v, i) => (i === beginn && lg ? k.gem[i] : v));
        const p = pfad(arr, beginn, le[1]);
        s += `<path d="${p}L${X(le[1] + 0.5)},${Y(0)}L${X(beginn + 0.5)},${Y(0)}Z" fill="url(#${id}h)"/>`;
        s += `<path d="${p}" fill="none" stroke="${F.pv}" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>`;
      }
      reihe.forEach((v, i) => { if (v != null && (!peak || v > peak.v)) peak = { i, v }; });
    }
    if (peak) {
      s += `<circle cx="${X(peak.i + 0.5)}" cy="${Y(peak.v)}" r="4.5" fill="${F.weiss}" stroke="${F.pv}" stroke-width="2.5"/>`;
      s += lbl(klemm(X(peak.i + 0.5), kwW(peak.v), m.l, W - m.r, 11.5), Y(peak.v) - 10, kwW(peak.v), { size: 11.5, weight: 800, fill: F.tinte, halo: true });
    }
    if (k.jetzt != null) {
      const xNow = X(k.fall.minute / 15);
      if (xNow > m.l && xNow < W - m.r) {
        s += `<line x1="${xNow}" x2="${xNow}" y1="${m.t - 2}" y2="${m.t + ph}" stroke="${F.tinte}" stroke-width="1.5" stroke-dasharray="3 3"/>`;
        s += lbl(xNow - 6, m.t + ph - 7, 'jetzt', { anchor: 'end', weight: 700, fill: F.tinte, halo: true, size: 11.5 });
      }
    }
    if (fund) s += klammer(X(fund.von), X(fund.bis + 1), m.t - 8, `${S.wetterDauer}${NBSP}Std · Ø ${f.ohne ? `${Math.round(f.m)} W/m²` : kwW(f.m)}`, m.l, W - m.r - 30, F.fundTinte);
    for (let h = Math.ceil(hVon / 3) * 3; h <= hBis; h += 3) {
      const x = X(h * 4);
      if (x < m.l - 1 || x > W - m.r + 1) continue;
      s += lbl(x, H - 7, h + 3 > hBis ? `${h} Uhr` : String(h), { anchor: x > W - m.r - 20 ? 'end' : 'middle', weight: 500 });
    }
    s += `<g data-cur visibility="hidden" pointer-events="none">
      <line data-c="line" y1="${m.t - 2}" y2="${m.t + ph}" stroke="${F.fundTinte}" stroke-width="1.5"/>
      <circle data-c="dot" r="5.5" fill="${F.pv}" stroke="${F.weiss}" stroke-width="2"/></g>`;
    s += '</svg>';
    host.innerHTML = s;

    const leg = host.closest('.card').querySelector('[data-wlegende]');
    if (k.ghiModus) {
      const gem = kwhAus(k.fall.pv[0].gemessen);
      leg.innerHTML = `<span><i style="background:${F.sonneSoft};border:1px solid ${F.sonne}"></i>Sonneneinstrahlung</span>${k.t === 0 ? `<span class="tot">bisher erzeugt ${zahl(gem, 1)}${NBSP}kWh</span>` : ''}`;
    } else {
      const gem = kwhAus(k.gem);
      const erw = kwhAus(k.erw);
      leg.innerHTML = `${k.gem ? '<span><i style="background:var(--pv-fill);opacity:.7"></i>gemessen</span>' : ''}<span><i style="background:repeating-linear-gradient(45deg,#fef3e2 0 2px,#f5b54a 2px 4px)"></i>erwartet</span>`
        + `<span class="tot">${k.gem ? `${zahl(gem, 1)} + ≈${NBSP}${zahl(erw, 0)}${NBSP}kWh` : `≈${NBSP}${zahl(erw, 0)}${NBSP}kWh`}</span>`;
    }
    host.setAttribute('aria-label', `${k.ghiModus ? 'Sonneneinstrahlung' : 'Sonnenstrom'} ${TAGE[k.t].wort.toLowerCase()} je Viertelstunde. Pfeiltasten wählen eine Viertelstunde, Escape springt zu jetzt.`);
    interaktiv(host, z - a, m.l, W - m.r, (kk) => {
      const i = a + kk;
      const v = reihe[i];
      const st = k.tag.stunden[Math.floor(i / 4)];
      const x = X(i + 0.5);
      return {
        line: { x1: x, x2: x },
        dot: v == null ? { visibility: 'hidden' } : { cx: x, cy: Y(v), visibility: 'visible' },
        text: `${uhr(i)}–${uhr(i + 1)} Uhr, ${v == null ? 'keine Angabe' : k.ghiModus ? `${v} Watt je Quadratmeter` : kwW(v)}, ${HIMMEL[himmel(st.cloud)]}, ${zahl(st.temp, 0)} Grad`,
      };
    }, (kk, gesetzt) => {
      const i = kk == null ? null : a + kk;
      if (gesetzt) {
        S.wetterSel = i;
        root.querySelectorAll('.hour').forEach((b) => {
          const slot = b.dataset.slot;
          const an = slot === '' ? i == null : i != null && Math.floor(Number(slot) / 4) === Math.floor(i / 4);
          b.classList.toggle('sel', an);
          b.setAttribute('aria-pressed', String(an));
        });
      }
      momentWetter(root, i);
    }, S.wetterSel == null ? null : Math.max(0, Math.min(z - a - 1, S.wetterSel - a)));
    host._slotZuIndex = (slot) => (slot == null ? null : Math.max(0, Math.min(z - a - 1, slot - a)));
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
      s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}" stroke="${F.gitter}"/>` + lbl(m.l - 5, y + 4, String(v), { anchor: 'end', weight: 500, size: 10.5 });
    }
    werte.forEach((v, i) => {
      const h = (v / y1) * ph;
      const x = m.l + i * bw + bw * 0.18;
      s += `<rect x="${x}" y="${m.t + ph - h}" width="${bw * 0.64}" height="${h}" rx="${Math.min(3, bw * 0.2)}" fill="${F.preis}" fill-opacity="${i === werte.length - 1 && S.rb !== 'jahr' ? 1 : 0.7}"/>`;
      if (namen[i]) s += lbl(m.l + i * bw + bw / 2, H - 6, namen[i], { weight: 500, size: 10.5 });
      if (werte.length <= 12) s += lbl(m.l + i * bw + bw / 2, m.t + ph - h - 5, zahl(v, 1), { weight: 700, size: 10, fill: F.tinte });
    });
    s += '</svg>';
    const iMin = werte.indexOf(Math.min(...werte));
    const iMax = werte.indexOf(Math.max(...werte));
    const wann = (t) => (t.datum ? t.datum.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) : `${t.label} ${t.jahr}`);
    const einheit = S.rb === 'jahr' ? 'Monat' : 'Tag';
    const seg = [['woche', 'Woche'], ['monat', 'Monat'], ['jahr', 'Jahr']]
      .map(([k2, l]) => `<button type="button" aria-pressed="${S.rb === k2}" data-act="rb" data-rb="${k2}">${l}</button>`).join('');
    return `<div class="sheet-scrim" data-act="blatt-zu"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="rb-titel">
        <div class="grip" aria-hidden="true"></div>
        <div class="sheet-h"><h2 id="rb-titel">Rückblick</h2><button type="button" class="ibtn" aria-label="Schließen" data-act="blatt-zu">${ico('x')}</button></div>
        <div class="seg" role="group" aria-label="Zeitraum">${seg}</div>
        <p class="hint" style="margin-top:14px">Durchschnitt je ${einheit}, in ct/kWh</p>
        ${s}
        <ul class="rows">
          <li><span class="rn">Durchschnitt</span><span class="rv">${ctW(summe(werte) / werte.length)}</span></li>
          <li><span class="rn"><i style="background:var(--lvl-guenstig)"></i>Günstigster ${einheit}</span><span class="rv">${ctW(werte[iMin])}</span><span class="rs">${wann(reihe[iMin])}</span></li>
          <li><span class="rn"><i style="background:var(--lvl-teuer)"></i>Teuerster ${einheit}</span><span class="rv">${ctW(werte[iMax])}</span><span class="rs">${wann(reihe[iMax])}</span></li>
        </ul>
        <p class="leise">Mittel aller Viertelstunden. Preise liegen ab dem Tag vor, an dem VoltPilot sie zum ersten Mal geladen hat; der Rückblick füllt sich Tag für Tag.</p>
      </div>`;
  }

  /* ---------- Einbau ---------- */
  const beobachter = new Map();
  function zeichneIn(root) {
    root.querySelectorAll('[data-chart]').forEach((host) => {
      const male = () => (host.dataset.chart === 'preis' ? zeichnePreis(host, root) : zeichneWetter(host, root));
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
    tageWischen(root);
  }
  function render(root, mitRahmen) {
    (beobachter.get(root) ?? []).forEach((ro) => ro.disconnect());
    beobachter.set(root, []);
    const seite = S.seite === 'preise' ? preisSeite() : wetterSeite();
    root.innerHTML = mitRahmen ? rahmen(seite) : `<div class="app" style="min-height:0">${reiter()}<div class="app-main">${seite}</div></div>`;
    zeichneIn(root);
  }

  // Tageskarten: Wischen wählt die Karte, die danach am meisten zu sehen ist.
  function tageWischen(root) {
    const el = root.querySelector('[data-tage]');
    if (!el || el.scrollWidth <= el.clientWidth + 4) return;
    let uhrzeit = null;
    el.addEventListener('scroll', () => {
      clearTimeout(uhrzeit);
      uhrzeit = setTimeout(() => {
        const box = el.getBoundingClientRect();
        let best = S.wetterTag;
        let anteil = -1;
        el.querySelectorAll('.tagk').forEach((c, i) => {
          const r = c.getBoundingClientRect();
          const sicht = Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left)) / r.width;
          if (sicht > anteil + 0.01) { anteil = sicht; best = i; }
        });
        if (best !== S.wetterTag) { S.wetterTag = best; S.wetterSel = null; alles(false, 'tage'); }
      }, 140);
    }, { passive: true });
  }
  function zeigeTagKarte(root, sanft) {
    const el = root.querySelector('[data-tage]');
    const c = el?.querySelectorAll('.tagk')[S.wetterTag];
    if (!el || !c || el.scrollWidth <= el.clientWidth + 4) return;
    const ziel = Math.min(el.scrollWidth - el.clientWidth, c.offsetLeft - el.firstElementChild.offsetLeft);
    el.scrollTo({ left: ziel, behavior: sanft && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
  }

  let toastUhr = null;
  function toast(text) {
    const host = document.getElementById('sheet-host');
    if (!host) return;
    host.hidden = false;
    host.classList.remove('open');
    host.innerHTML = `<div role="status" class="toast">${text}</div>`;
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
    const root = e.currentTarget;
    const act = el.dataset.act;
    if (act === 'nicht') { e.preventDefault(); toast('Nicht Teil dieses Konzepts.'); return; }
    if (act === 'seite') { S.seite = el.dataset.seite; animieren = true; alles(true); return; }
    if (act === 'blatt') { blattOeffnen(el); return; }
    if (act === 'blatt-zu') { blattSchliessen(); return; }
    if (act === 'rb') { S.rb = el.dataset.rb; blattOeffnen(); return; }
    // Preise
    if (act === 'ptag') { S.preisTag = Number(el.dataset.tag); S.preisSel = null; animieren = true; alles(false); return; }
    if (act === 'pjetzt') {
      if (S.preisTag !== 0) { S.preisTag = 0; S.preisSel = null; animieren = true; alles(false); return; }
      root.querySelector('[data-chart="preis"]')?._waehle(null);
      return;
    }
    if (act === 'pdauer') {
      const n = Number(el.dataset.n);
      S.preisDauer = S.preisDauer === n ? null : n;
      const k = preisKontext();
      if (k.finder && k.finder.start.tag !== S.preisTag) { S.preisTag = k.finder.start.tag; S.preisSel = null; animieren = true; }
      alles(false);
      return;
    }
    if (act === 'pzeig') {
      const f = preisKontext().finder;
      if (!f) return;
      animieren = f.start.tag !== S.preisTag;
      S.preisTag = f.start.tag;
      S.preisSel = f.start.i;
      alles(false);
      root.querySelector('[data-chart="preis"]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    // Wetter
    if (act === 'wtag') { S.wetterTag = Number(el.dataset.tag); S.wetterSel = null; alles(false, 'tage'); return; }
    if (act === 'wjetzt') {
      if (S.wetterTag !== 0) { S.wetterTag = 0; S.wetterSel = null; alles(false, 'tage'); return; }
      root.querySelector('[data-chart="wetter"]')?._waehle(null);
      return;
    }
    if (act === 'wdauer') {
      const n = Number(el.dataset.n);
      S.wetterDauer = S.wetterDauer === n ? null : n;
      const f = wetterKontext().finder;
      if (f && f.start.tag !== S.wetterTag) { S.wetterTag = f.start.tag; S.wetterSel = null; alles(false, 'tage'); return; }
      alles(false);
      return;
    }
    if (act === 'wzeig') {
      const f = wetterKontext().finder;
      if (!f) return;
      const tagWechsel = f.start.tag !== S.wetterTag;
      S.wetterTag = f.start.tag;
      S.wetterSel = f.start.i;
      alles(false, tagWechsel ? 'tage' : undefined);
      root.querySelector('[data-chart="wetter"]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    if (act === 'stunde') {
      const host = root.querySelector('[data-chart="wetter"]');
      const slot = el.dataset.slot === '' ? null : Number(el.dataset.slot);
      host?._waehle(host._slotZuIndex(slot));
      return;
    }
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

  function alles(nachOben, wegen) {
    const screen = document.getElementById('screen');
    if (screen) {
      const y = screen.scrollTop;
      const tageLinks = screen.querySelector('[data-tage]')?.scrollLeft ?? 0;
      render(screen, true);
      screen.scrollTop = nachOben ? 0 : y;
      const tage = screen.querySelector('[data-tage]');
      if (tage) {
        tage.scrollLeft = tageLinks;
        zeigeTagKarte(screen, wegen === 'tage');
      }
    }
    steuerung();
    desktop();
    animieren = false;
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
      animieren = true;
      alles(true);
    });
    document.getElementById('seg-fall').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-k]');
      if (!b) return;
      if (S.blatt) blattSchliessen();
      if (S.seite === 'preise') { S.preisFall = b.dataset.k; S.preisTag = 0; S.preisSel = null; }
      else { S.wetterFall = b.dataset.k; S.wetterTag = 0; S.wetterSel = null; }
      animieren = true;
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
