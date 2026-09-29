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
  zumTelefon();
  setTimeout(() => {
    if (ziel === 'tagesbild') { S.tab = 'geraete'; S.reo = null; renderApp(); const el = document.getElementById('tl-host'); if (el) el.scrollIntoView({ block: 'center' }); }
    else if (ziel === 'reo') { S.tab = 'geraete'; S.reo = S.cfg.reihenfolge.filter((x) => SIM.sonnig(S.cfg, x)); renderApp(); zuListe(); }
    else if (ziel === 'regel') { S.tab = 'regeln'; S.reo = null; renderApp(); blattAuf({ art: 'regel', d: neuerEntwurf('v-billig'), edit: null, schritt: 'bau', fokus: 'w0w' }); }
    else if (ziel === 'laden') { S.tab = 'laden'; S.reo = null; renderApp(); scrollOben(); }
    else if (ziel === 'heizstab') { S.tab = 'geraete'; renderApp(); blattAuf({ art: 'geraet', id: 'hs', d: kopie(S.cfg.geraete.hs) }); }
    else if (ziel === 'katalog') { blattAuf({ art: 'katalog', wahl: null }); }
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

function konzeptStart() {
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
