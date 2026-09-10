import { useEffect, useRef } from 'react';
import { ARTICLE_BY_ID } from './articles';
import { HELP_CATEGORIES, helpHref, type HelpArticle, type HelpArticleId } from './model';
import { HelpScreenshot } from './HelpFigure';
import { HelpDiagram } from './HelpDiagram';

export function HelpArticleView({ article, onArticle, section }: { article: HelpArticle; onArticle?: (id: HelpArticleId) => void; section?: string | null }) {
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = Boolean(onArticle);
  useEffect(() => {
    // Let the enclosing modal record the opening control before moving to the
    // article heading. That keeps focus restoration valid for cached readers.
    const frame = requestAnimationFrame(() => {
      const target = (section ? [...(root.current?.querySelectorAll<HTMLElement>('[data-section]') ?? [])].find((el) => el.dataset.section === section) : null) ?? heading.current;
      // Scope the lookup to this article: the page and help modal may coexist.
      if (target) {
        target.focus({ preventScroll: true });
        if (section) target.scrollIntoView({ block: 'start' });
        else if (!panel) window.scrollTo({ top: 0 });
      }
      if (panel) {
        const body = root.current?.closest('.dbody');
        if (body) body.scrollTop = 0;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [article.id, section, panel]);
  const category = HELP_CATEGORIES.find((c) => c.id === article.category)!;
  const jump = (id: string) => {
    const target = root.current?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start', behavior: 'auto' });
  };
  return <div className={`vp-help-article ${onArticle ? 'vp-help-article-panel' : ''}`} ref={root}>
    <header className="vp-help-article-head">
      <span className="vp-help-eyebrow">{category.title}</span>
      <h1 ref={heading} tabIndex={-1}>{article.title}</h1>
      <p className="vp-help-lead">{article.summary}</p>
      {article.prerequisite && <p className="vp-help-prerequisite"><strong>Gilt für:</strong> {article.prerequisite}</p>}
    </header>
    <div className="vp-help-reading-layout">
      <nav aria-label="In diesem Artikel" className="vp-help-toc"><strong>In diesem Artikel</strong>
        {article.sections.map((s) => onArticle
          ? <button key={s.id} type="button" onClick={() => jump(s.id)}>{s.title}</button>
          : <a key={s.id} href={helpHref(article.id, s.id)}>{s.title}</a>)}
      </nav>
      <div className="vp-help-prose">
        {article.sections.map((s) => <section key={s.id}>
          <h2 data-section={s.id} tabIndex={-1}>{s.title}</h2>
          {s.paragraphs.map((p) => <p key={p}>{p}</p>)}
          {s.steps && <ol className="vp-help-steps">{s.steps.map((step) => <li key={step}>{step}</li>)}</ol>}
          {s.note && <aside className="vp-help-note">{s.note}</aside>}
          {s.diagram && <HelpDiagram kind={s.diagram} />}
          {s.figure && <HelpScreenshot id={s.figure} />}
        </section>)}
        <nav className="vp-help-related" aria-label="Passende Artikel"><h2>Hier weiterlesen</h2>
          {article.related.map((id) => <a key={id} href={helpHref(id)} onClick={(event) => {
            if (!onArticle || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); onArticle(id);
          }}>{ARTICLE_BY_ID[id].title}<span aria-hidden="true">→</span></a>)}
        </nav>
      </div>
    </div>
  </div>;
}
