/* ================= Die Konzeptseite um das Telefon herum ================= */

/* Rechner-Vorschau: dieselbe Seite, 1200 px breit, verkleinert, nicht bedienbar */
function renderDesk() {
  const host = document.getElementById('desk-app');
  if (!host) return;
  const zuvor = S.sel; S.sel = null;
  const reo = S.reo; S.reo = null;
  host.innerHTML = appHtml();
  S.sel = zuvor; S.reo = reo;
  zeichneCharts(host);
  deskSkala();
}
function deskSkala() {
  const outer = document.getElementById('desk-outer');
  const desk = document.getElementById('desk');
  if (!outer || !desk) return;
  const s = Math.min(1, outer.clientWidth / 1200);
  desk.style.transform = 'scale(' + s + ')';
  outer.style.height = Math.ceil(desk.scrollHeight * s) + 'px';
}

/* Katalog aller Gerätearten, zum Filtern */
const STATUS_WORT = { da: ['da', 'geht heute'], teil: ['teil', 'teilweise neu'], neu: ['neu', 'braucht Neues'] };
function renderKatalog(filter) {
  const grid = document.getElementById('kat-grid');
  if (!grid) return;
  const liste = KATALOG.filter((k) => !filter || filter === 'alle' || k.gruppe === filter);
  grid.innerHTML = liste.map((k) => '<article class="kk" id="kat-' + k.id + '"><div class="kk-h"><span class="ico">' + ic(k.icon, 22) + '</span><span><b>' + esc(k.name) + '</b><small>' + esc(k.gruppe) + ' · Typ <code>' + esc(k.typ) + '</code></small></span></div>'
    + '<p>' + esc(k.text) + '</p><div class="caps">' + k.kann.map((x) => '<span>' + esc(x) + '</span>').join('') + (k.nicht || []).map((x) => '<span class="x">' + esc(x) + '</span>').join('') + '</div>'
    + '<div class="satz">Smart: ' + esc(k.smart) + '</div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="st ' + STATUS_WORT[k.status][0] + '"><i></i>' + STATUS_WORT[k.status][1] + '</span><span class="quelle">' + esc(k.weg) + '</span></div></article>').join('');
  const zahl = document.getElementById('kat-zahl');
  if (zahl) zahl.textContent = liste.length + ' von ' + KATALOG.length + ' Vorlagen';
}

/* Offene Entscheidungen: in Lavish als Rückmeldung, sonst zum Einfügen kopieren */
function entscheidungen() {
  const form = document.getElementById('ent-form');
  const status = document.getElementById('ent-status');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const items = [...form.querySelectorAll('fieldset')].map((fs) => {
      const wahl = fs.querySelector('input:checked');
      return { id: fs.dataset.id, frage: fs.querySelector('legend').textContent.replace(/^E\d+/, '').trim(), antwort: wahl ? wahl.value : 'offen' };
    });
    const text = 'Entscheidungen zum Konzept „Steuerung“:\n' + items.map((i) => i.id + ': ' + i.antwort).join('\n');
    form.querySelector('.ent-manual')?.remove();
    if (window.lavish && typeof window.lavish.queuePrompt === 'function') {
      window.lavish.queuePrompt('Setze diese Entscheidungen im Konzept „Steuerung“ um und bestätige jede ID einzeln.', {
        tag: 'tracked-batch', text: items.length + ' Entscheidungen', element: form, data: { items },
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
      ta.className = 'ent-manual'; ta.readOnly = true; ta.rows = items.length + 1; ta.value = text;
      ta.setAttribute('aria-label', 'Antworten zum Kopieren');
      form.querySelector('.ent-send').after(ta);
      ta.focus(); ta.select();
      status.textContent = 'Kopieren ging nicht. Der Text ist markiert und kann von Hand kopiert werden.';
    }
  });
}

function zumTelefon() {
  const ph = document.getElementById('phone');
  if (!ph) return;
  const r = ph.getBoundingClientRect();
  if (r.top < -40 || r.top > window.innerHeight * 0.6) ph.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
function geheZu(ziel) {
  if (S.sheet) blattZu();
  if (ziel !== 'io') zumTelefon();
  setTimeout(() => {
    if (ziel === 'tagesbild') { S.tab = 'geraete'; S.reo = null; renderApp(); const el = document.getElementById('tl-host'); if (el) el.scrollIntoView({ block: 'center' }); }
    else if (ziel === 'reo') { S.tab = 'geraete'; S.reo = S.cfg.reihenfolge.filter((x) => SIM.sonnig(S.cfg, x)); renderApp(); zuListe(); }
    else if (ziel === 'regel') { S.tab = 'regeln'; S.reo = null; renderApp(); blattAuf({ art: 'regel', d: neuerEntwurf('v-billig'), edit: null, schritt: 'bau', fokus: 'w0w' }); }
    else if (ziel === 'laden') { S.tab = 'laden'; S.reo = null; renderApp(); scrollOben(); }
    else if (ziel === 'heizstab') { S.tab = 'geraete'; renderApp(); blattAuf({ art: 'geraet', id: 'hs', d: kopie(S.cfg.geraete.hs) }); }
    else if (ziel === 'io') { const el = document.getElementById('io-modul'); if (el) el.scrollIntoView({ block: 'start' }); }
    else if (ziel === 'neu') { S.tab = 'geraete'; S.reo = null; renderApp(); const k = document.getElementById('neu-spuel') || document.getElementById('devs'); if (k) k.scrollIntoView({ block: 'center' }); }
    else if (ziel === 'szene') { S.tab = 'regeln'; renderApp(); blattAuf({ art: 'szene', id: 'urlaub' }); }
  }, 60);
}

function setzeFall(k) {
  const f = JETZT_FAELLE[k];
  S.fall = k; S.now = f.slot; S.nowMin = f.min; S.sel = null; S.tag = 0; S.reo = null;
  S.cfg.eingriffe = []; S.cfg.pause = null;
  rechneAlles();
  if (S.sheet) blattZu();
  renderApp();
  document.querySelectorAll('#fall button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === k)));
}

/* Ein I/O-Modul, viele Geräte: Ausgänge in der Anlage zuordnen, Wirkung in der Steuerung sehen */
const IO_GERAETE = {
  hs: { name: 'Heizstab Warmwasser', kurz: 'Heizstab', icon: 'flame', farbe: '#e65100', typ: 'heating-rod', stufen: true, smart: 'Mit Sonnenstrom in Stufen, bis 60 °C; Negativpreise mitnehmen' },
  zirk: { name: 'Zirkulationspumpe', kurz: 'Zirkulation', icon: 'history', farbe: '#0e7490', typ: 'pump', smart: 'Feste Zeiten 6–8 und 18–21 Uhr' },
  heizkreis: { name: 'Heizkreispumpe Werkstatt', kurz: 'Heizkreis', icon: 'thermo', farbe: '#b45309', typ: 'pump', smart: 'Werktags 6–17 Uhr, nur unter 15 °C draußen' },
  brunnen: { name: 'Brunnenpumpe', kurz: 'Brunnen', icon: 'sprout', farbe: '#15803d', typ: 'pump', smart: 'Jeden Morgen 5:30–6:00, nicht nach Regen' },
  zisterne: { name: 'Zisternenpumpe', kurz: 'Zisterne', icon: 'droplet', farbe: '#2563eb', typ: 'pump', smart: 'Mit Sonnenstrom, höchstens 2 Std am Tag' },
  teich: { name: 'Teichfilter', kurz: 'Teichfilter', icon: 'waves', farbe: '#6d28d9', typ: 'pump', smart: '8 Std am Tag zwischen 8 und 20 Uhr, Sonne zuerst' },
};
const IO = {
  sel: 4, ueberschuss: 2.4,
  belegung: { 1: { g: 'hs', kw: 1 }, 2: { g: 'hs', kw: 1 }, 3: { g: 'hs', kw: 1 }, 4: { g: 'zirk' }, 5: { g: 'heizkreis' }, 6: { g: 'brunnen' }, 7: { g: 'zisterne' }, 8: { g: 'teich' } },
};
function ioStufen() {
  const aus = Object.keys(IO.belegung).map(Number).filter((k) => IO.belegung[k].g === 'hs').sort((a, b) => a - b);
  let sum = 0;
  return aus.map((k) => { sum += IO.belegung[k].kw || 1; return { k, kw: IO.belegung[k].kw || 1, stufe: Math.round(sum * 10) / 10 }; });
}
function renderIo() {
  const host = document.getElementById('io-demo');
  if (!host) return;
  const stufen = ioStufen();
  const n = stufen.filter((x) => x.stufe <= IO.ueberschuss + 1e-9).length;
  const an = new Set(stufen.slice(0, n).map((x) => x.k));
  const kacheln = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => {
    const b = IO.belegung[k]; const g = b && IO_GERAETE[b.g];
    const st = b && b.g === 'hs' ? stufen.findIndex((x) => x.k === k) + 1 : 0;
    return '<button type="button" class="io-do' + (g ? '' : ' frei') + '" data-io="' + k + '" aria-pressed="' + (IO.sel === k) + '" style="--farbe:' + (g ? g.farbe : '#cbd5e1') + '"><span class="nr">DO' + k + '</span><span class="lampe' + (an.has(k) ? ' an' : '') + '" aria-hidden="true"></span><b>' + (g ? esc(g.kurz) : 'frei') + '</b><small>' + (st ? 'Stufe ' + st + ' · +' + NF1.format(b.kw) + ' kW' : g ? 'potenzialfrei' : 'nicht belegt') + '</small></button>';
  }).join('');
  const b = IO.belegung[IO.sel];
  const wahl = ['frei', ...Object.keys(IO_GERAETE)].map((id) => '<button type="button" data-io-g="' + id + '" aria-pressed="' + ((b ? b.g : 'frei') === id) + '">' + (id === 'frei' ? 'frei lassen' : esc(IO_GERAETE[id].name)) + '</button>').join('');
  let detail = '';
  if (b && b.g === 'hs') {
    detail = '<p>Dieser Ausgang ist eine Stufe des Heizstabs. Die Stufen addieren sich, je Ausgang ein Heizelement über ein Schütz.</p><ul class="io-stufen">' + stufen.map((x, i) => '<li><span>DO' + x.k + ' · Stufe ' + (i + 1) + '</span>' + (x.k === IO.sel ? '<span class="stp"><button type="button" data-io-kw="-1" aria-label="weniger">' + ic('minus', 18) + '</button><output>+' + NF1.format(x.kw) + ' kW</output><button type="button" data-io-kw="1" aria-label="mehr">' + ic('plus', 18) + '</button></span>' : '<span>+' + NF1.format(x.kw) + ' kW → ' + NF1.format(x.stufe) + ' kW</span>') + '</li>').join('') + '</ul>';
  } else if (b) {
    detail = '<p>Der Kontakt schaltet die Pumpe über ein Koppelrelais oder Schütz. Ohne eigenen Zähler ist die Energie angenommen (Nennleistung × Zeit). Ein Eingang (DI) kann melden, dass die Pumpe wirklich läuft.</p>';
  } else detail = '<p>Frei. Von Hand schaltbar, aber keinem Gerät zugeordnet und deshalb in der Steuerung unsichtbar.</p>';
  const geraete = Object.keys(IO_GERAETE).map((id) => {
    const aus = Object.keys(IO.belegung).map(Number).filter((k) => IO.belegung[k].g === id).sort((x, y) => x - y);
    if (!aus.length) return '';
    const g = IO_GERAETE[id];
    const technik = id === 'hs' ? 'Ausgänge ' + aus.map((k) => 'DO' + k).join(', ') + ' · in Stufen ' + stufen.map((x) => NF1.format(x.stufe)).join(' / ') + ' kW' : 'Ausgang DO' + aus[0] + (aus.length > 1 ? ' und weitere' : '') + ' · ein/aus';
    return '<div class="io-g"><span class="ico">' + ic(g.icon, 21) + '</span><span><b>' + esc(g.name) + '</b><small>' + technik + '</small><span class="smart">Smart: ' + esc(g.smart) + '</span></span></div>';
  }).join('');
  const frei = [1, 2, 3, 4, 5, 6, 7, 8].filter((k) => !IO.belegung[k]).length;
  const probe = stufen.length ? '<div class="io-probe"><b>Wie die Box den Heizstab schaltet</b><label style="display:grid;gap:4px;font:600 13.5px var(--font)">Sonnen-Überschuss: ' + NF1.format(IO.ueberschuss) + ' kW<input type="range" id="io-ueb" min="0" max="' + Math.max(4, stufen[stufen.length - 1].stufe + 1) + '" step="0.1" value="' + IO.ueberschuss + '"></label>'
    + '<div class="io-lampen">' + stufen.map((x) => '<span class="' + (an.has(x.k) ? 'an' : '') + '"><i></i>DO' + x.k + '</span>').join('') + '</div>'
    + '<p>' + (n ? 'Stufe ' + n + ' (' + NF1.format(stufen[n - 1].stufe) + ' kW): ' + stufen.slice(0, n).map((x) => 'DO' + x.k).join(' und ') + ' geschlossen' + (n < stufen.length ? ', ' + stufen.slice(n).map((x) => 'DO' + x.k).join(' und ') + ' offen' : '') + '.' : 'Zu wenig für Stufe 1: alle Stufen offen.') + ' Die Box schaltet Stufen einzeln mit Abstand zu und sofort ab; fällt die Verbindung weg, öffnet der Watchdog nach 60 Sekunden alle Ausgänge.</p></div>' : '';
  host.innerHTML = '<div class="io-karte"><p class="io-pfad">Anlage › Aufbau › I/O-Modul Technikraum</p><div class="io-kopf"><span class="ico">' + ic('cpu', 23) + '</span><span><b>I/O-Modul Technikraum</b><small>Ebyte M31 · 8 Eingänge, 8 Relais-Ausgänge · Watchdog eingerichtet</small></span></div>'
    + '<div class="io-leiste" role="group" aria-label="Relais-Ausgänge DO1 bis DO8">' + kacheln + '</div>'
    + '<div class="io-panel"><h3>Ausgang DO' + IO.sel + ': was hängt daran?</h3><div class="chips" role="group" aria-label="Gerät am Ausgang">' + wahl + '</div>' + detail
    + '<p style="color:var(--c-fg);font-weight:600">Neu zugeordnete Ausgänge gehen mit einem Schalttest von 30 Sekunden in Betrieb.</p></div></div>'
    + '<div class="io-karte" style="background:var(--c-bg)"><p class="io-pfad">So erscheint es in der Steuerung</p><div class="io-liste">' + geraete + '</div>'
    + (frei ? '<p class="leise">' + frei + (frei === 1 ? ' Ausgang ist' : ' Ausgänge sind') + ' frei und erscheinen nicht.</p>' : '') + probe + '</div>';
}
function ioStart() {
  const host = document.getElementById('io-demo');
  if (!host) return;
  host.addEventListener('click', (e) => {
    const t = e.target.closest('[data-io]');
    if (t) { IO.sel = Number(t.dataset.io); renderIo(); host.querySelector('[data-io="' + IO.sel + '"]').focus({ preventScroll: true }); return; }
    const g = e.target.closest('[data-io-g]');
    if (g) {
      const id = g.dataset.ioG;
      if (id === 'frei') delete IO.belegung[IO.sel];
      else IO.belegung[IO.sel] = id === 'hs' ? { g: 'hs', kw: (IO.belegung[IO.sel] && IO.belegung[IO.sel].kw) || 1 } : { g: id };
      renderIo(); return;
    }
    const kw = e.target.closest('[data-io-kw]');
    if (kw) { const b = IO.belegung[IO.sel]; b.kw = Math.max(0.5, Math.min(6, (b.kw || 1) + 0.5 * Number(kw.dataset.ioKw))); renderIo(); }
  });
  host.addEventListener('input', (e) => {
    if (e.target.id !== 'io-ueb') return;
    IO.ueberschuss = Number(e.target.value);
    clearTimeout(ioStart.t);
    ioStart.t = setTimeout(() => { renderIo(); const r = document.getElementById('io-ueb'); if (r) r.focus({ preventScroll: true }); }, 30);
  });
  renderIo();
}

function konzeptStart() {
  ioStart();
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => geheZu(b.dataset.go)));
  const fall = document.getElementById('fall');
  if (fall) fall.addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) setzeFall(b.dataset.k); });
  const reset = document.getElementById('zuruecksetzen');
  if (reset) reset.addEventListener('click', () => { S.cfg = SIM.startKonfig(); setzeFall(S.fall); toast('Beispielanlage zurückgesetzt.'); });
  const kf = document.getElementById('kat-filter');
  if (kf) {
    const gruppen = ['alle', ...new Set(KATALOG.map((k) => k.gruppe))];
    kf.innerHTML = gruppen.map((g) => '<button type="button" data-g="' + esc(g) + '" aria-pressed="' + (g === 'alle') + '">' + esc(g === 'alle' ? 'Alle' : g) + '</button>').join('');
    kf.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-g]'); if (!b) return;
      kf.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderKatalog(b.dataset.g);
    });
  }
  renderKatalog('alle');
  entscheidungen();
  if (location.hash === '#nur-telefon') document.body.classList.add('nur-telefon');
  deskSkala();
}
