import { useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { HELP_ARTICLES, findArticle } from './articles';
import { HELP_CATEGORIES, helpHref } from './model';
import { searchHelp } from './search';
import { HelpArticleView } from './HelpArticleView';
import './Help.css';

function hashParams() { return new URLSearchParams(window.location.hash.split('?')[1] ?? ''); }

export default function HelpPage({ articleId, returnHref = '#/uebersicht' }: { articleId?: string; returnHref?: string }) {
  const [query, setQuery] = useState(() => hashParams().get('q') ?? '');
  const [section, setSection] = useState(() => hashParams().get('abschnitt'));
  useEffect(() => { if (!articleId) window.scrollTo({ top: 0 }); }, [articleId]);
  useEffect(() => {
    const sync = () => { setQuery(hashParams().get('q') ?? ''); setSection(hashParams().get('abschnitt')); };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [articleId]);
  const article = articleId ? findArticle(articleId) : undefined;
  const searching = query.trim().length > 0;
  const hits = searching ? searchHelp(HELP_ARTICLES, query) : [];
  return <div className="vp-help" data-testid="help-center">
    <a className="vp-help-back" href={returnHref}><Icon name="chevron-left" size={17} />Zurück zum Portal</a>
    {articleId ? <>
      <a className="vp-help-back" href={helpHref()}><Icon name="chevron-left" size={17} />Hilfe &amp; Kontakt</a>
      {article ? <HelpArticleView key={article.id} article={article} section={section} /> : <div className="vp-help-empty" role="status">
        <h1>Artikel nicht gefunden</h1><p>Dieser Link führt zu keinem verfügbaren Artikel. Über die Suche oder die Themen finden Sie die passende Erklärung.</p><a href={helpHref()}>Zum Hilfe-Center</a>
      </div>}
    </> : <>
      <header className="vp-help-home-head">
        <div><span className="vp-help-eyebrow">Hilfe &amp; Kontakt</span><h1>Ihre Energie verstehen.<br />VoltPilot sicher bedienen.</h1><p>Das große Ganze und die nächsten Schritte – mit Erklärungen und Bildern aus dem Portal.</p></div>
        <a className="vp-help-start" href={helpHref('voltpilot')}><Icon name="sun" size={28} /><span>Neu bei VoltPilot?<strong>Hier beginnt der Überblick</strong></span><span aria-hidden="true">→</span></a>
      </header>
      <div className="vp-help-search">
        <label htmlFor="help-search">Wonach suchen Sie?</label>
        <div><Icon name="search" size={21} /><input id="help-search" type="search" value={query} placeholder="Zum Beispiel: Speicher lädt nicht, Fahrplan, Geräte-ID …" autoComplete="off" aria-controls="help-results" onChange={(event) => {
          const value = event.target.value;
          setQuery(value);
          replaceCurrentNavigation(`${helpHref()}${value ? `?q=${encodeURIComponent(value)}` : ''}`);
        }} /></div>
      </div>
      <div id="help-results">
        {searching ? <section className="vp-help-results" aria-label="Suchergebnisse">
          <p role="status">{hits.length ? `${hits.length} passende Artikel` : `Keine Treffer für „${query.trim()}“.`}</p>
          {hits.length ? hits.map((hit) => <a key={hit.id} href={helpHref(hit.id)}><strong>{hit.title}</strong><span>{hit.summary}</span></a>) : <p>Versuchen Sie einen kürzeren Begriff, etwa „Speicher“ oder „Verbindung“, oder <button type="button" className="vp-help-link" onClick={() => { setQuery(''); replaceCurrentNavigation(helpHref()); }}>zeigen Sie alle Themen an</button>.</p>}
        </section> : <div className="vp-help-categories">{HELP_CATEGORIES.map((category, index) => <section key={category.id} className="vp-help-category">
          <div className="vp-help-category-number" aria-hidden="true">0{index + 1}</div>
          <h2>{category.title}</h2><p>{category.description}</p>
          <ul>{HELP_ARTICLES.filter((a) => a.category === category.id).map((a) => <li key={a.id}><a href={helpHref(a.id)}>{a.title}<span aria-hidden="true">↗</span></a></li>)}</ul>
        </section>)}</div>}
      </div>
      <aside className="vp-help-fast"><div><span className="vp-help-eyebrow">Wenn etwas nicht wie erwartet läuft</span><h2>Den nächsten Schritt finden</h2></div>
        <a href={helpHref('probleme', 'keine-daten')}>Keine Messwerte →</a><a href={helpHref('probleme', 'kein-fahrplan')}>Kein Fahrplan →</a><a href={helpHref('kontakt')}>Persönliche Unterstützung →</a>
      </aside>
    </>}
    <footer className="vp-help-footer"><span>VoltPilot · Wissen für Ihre Anlage</span><a href={helpHref('glossar')}>Begriffe nachschlagen</a><a href={helpHref('kontakt')}>Kontakt</a></footer>
  </div>;
}
