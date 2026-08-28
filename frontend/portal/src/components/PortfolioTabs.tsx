import { isPortfolioPage, PORTFOLIO_WELT_PAGES, type PageId } from '../nav';
import './BereichTabs.css';

const PORTFOLIO_TAB_HASH: Partial<Record<PageId, string>> = {
  'portfolio-messwerte': '#/portfolio/messwerte',
  'portfolio-erloese': '#/portfolio/erloese',
};

/**
 * Beim Wechsel zwischen den beiden Historie-Welten bleibt der gewählte
 * Zeitraum erhalten. Von der Übersicht startet eine Welt bewusst mit ihrem
 * Standardzeitraum; zurück zur Übersicht gibt es keine Historie-Parameter.
 */
export function portfolioTabHash(
  target: PageId,
  currentPage: PageId,
  currentHash: string,
): string | null {
  const base = PORTFOLIO_TAB_HASH[target];
  if (!base || !PORTFOLIO_TAB_HASH[currentPage]) return null;
  const queryAt = currentHash.indexOf('?');
  return queryAt < 0 ? base : `${base}${currentHash.slice(queryAt)}`;
}

/**
 * Die REITER der FLOTTEN-EBENE: Übersicht · Messwerte · Erlöse
 * (Navigations-Runde „zwei Ebenen", Konzept `data/vp-portfolio-konzept-r2`
 * §5.2 + §8 Stufe S4, Captain-Entscheid E3).
 *
 * Sie ersetzen die Seitenleisten-Gruppe „Alle Anlagen": die zwei
 * Historie-Welten des Portfolios verlassen das Menü und werden Reiter der
 * Seite, auf der sie gemeint sind — genau damit verschwindet die Dopplung
 * „Messwerte/Erlöse auf ZWEI Ebenen", die die Ist-Zählung als Befund N1
 * getragen hat.
 *
 * ⚠ **Die Erlöse-Welt erscheint nur mit einem Geld-Modus** (`showErloese` =
 * `portfolioHistorie.hatGeldWelt`) — eine rein private Flotte bekommt gar
 * keinen Reiter statt eines, der nichts erklärt. Wird die Welt trotzdem per
 * Lesezeichen geöffnet, steht ihr Reiter da: eine offene Seite ohne Reiter
 * wäre eine Sackgasse.
 *
 * ⚠ **Sie wohnen ÜBER dem Seitenkopf**, nicht darunter: sie navigieren
 * zwischen drei SEITEN derselben Ebene (der Kopf gehört schon der geöffneten),
 * und die Portfolio-Seite selbst wird parallel umgebaut — ein Reiter-Slot in
 * ihrem Kopf wäre eine Naht zwischen zwei laufenden Arbeiten.
 */
export function PortfolioTabs({
  page,
  showErloese,
  fleetLabel,
  onNavigate,
}: {
  page: PageId;
  showErloese: boolean;
  /** „Portfolio" beim Betreiber, „Meine Anlagen" beim Endkunden. */
  fleetLabel: string;
  onNavigate: (page: PageId) => void;
}) {
  if (!isPortfolioPage(page)) return null;
  const welten = PORTFOLIO_WELT_PAGES.filter(
    (p) => p.id !== 'portfolio-erloese' || showErloese || page === p.id,
  );
  const open = (target: PageId) => {
    const hash = portfolioTabHash(target, page, window.location.hash);
    if (hash) {
      window.location.hash = hash;
      window.scrollTo({ top: 0 });
      return;
    }
    onNavigate(target);
  };
  return (
    <div className="vp-bereich-tabs" role="tablist" aria-label={`Reiter der Ebene ${fleetLabel}`}>
      <button
        type="button"
        role="tab"
        aria-selected={page === 'portfolio'}
        className={`vp-bereich-tab${page === 'portfolio' ? ' active' : ''}`}
        onClick={() => open('portfolio')}
      >
        Übersicht
      </button>
      {welten.map((p) => (
        <button
          key={p.id}
          type="button"
          role="tab"
          aria-selected={page === p.id}
          className={`vp-bereich-tab${page === p.id ? ' active' : ''}`}
          onClick={() => open(p.id)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
