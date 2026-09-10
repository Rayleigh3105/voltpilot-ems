import { Component, createContext, lazy, Suspense, useContext, useState, type ReactNode } from 'react';
import { Modal } from '../../designsystem/components/shell/Modal';
import { Icon } from '../../designsystem/components/core/Icon';
import { PageLoading } from '../components/Lazy';
import { helpHref, type HelpArticleId } from './model';
import './HelpLink.css';

const HelpReader = lazy(() => import('./HelpReader'));
const HelpContext = createContext<((id: HelpArticleId, trigger: HTMLElement) => void) | null>(null);

/** Also handles a failed lazy chunk without taking the working page down. */
class HelpLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <p role="alert">Die Hilfe konnte nicht geladen werden. Öffnen Sie das Hilfe-Center über den Link unten in einem neuen Tab. Ihre Eingaben bleiben hier erhalten.</p>
      : this.props.children;
  }
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const [trail, setTrail] = useState<HelpArticleId[]>([]);
  const [isOpen, setOpen] = useState(false);
  const article = trail[trail.length - 1];
  // Explicit focus also makes pointer clicks in Safari a reliable return target.
  return <HelpContext.Provider value={(id, trigger) => { trigger.focus(); setTrail([id]); setOpen(true); }}>
    {children}
      <Modal open={isOpen} title="Hilfe zur Ansicht" onClose={() => setOpen(false)} footer={<>
        {trail.length > 1 && <button type="button" className="vp-help-link" onClick={() => setTrail((t) => t.slice(0, -1))}><span aria-hidden="true">‹</span> Vorheriger Artikel</button>}
        <a className="vp-help-link" href={helpHref(article)} target="_blank" rel="noopener noreferrer">Im Hilfe-Center öffnen <span className="vp-visually-hidden">(neuer Tab)</span><span aria-hidden="true">↗</span></a>
      </>}>
        <div className="vp-help-panel"><HelpLoadBoundary><Suspense fallback={<PageLoading />}>
          {article && <HelpReader key={article} articleId={article} onArticle={(id) => setTrail((t) => [...t, id])} />}
        </Suspense></HelpLoadBoundary></div>
      </Modal>
  </HelpContext.Provider>;
}

export function HelpLink({ article, children = 'Diese Ansicht verstehen' }: { article: HelpArticleId; children?: ReactNode }) {
  const open = useContext(HelpContext);
  return <a className="vp-help-link" href={helpHref(article)} target="_blank" rel="noopener noreferrer"
    onClick={(event) => {
      if (!open || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      open(article, event.currentTarget);
    }}><Icon name="help-circle" size={17} /><span>{children}</span></a>;
}
