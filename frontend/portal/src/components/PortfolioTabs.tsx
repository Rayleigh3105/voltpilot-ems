import { ebenenAktiv, type EbenenBereichId } from '../ebenenNav';
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
 * §5.2 + §8 Stufe S4, Captain-Entscheid E3) — seit UEMS AP-02 IP-6 mit
 * „Standorte“ nach der Übersicht (bis die Ebenen-Navigation aus AP-01 steht).
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
 *
 * ⚠ **„Messstellen“ (AP-04 IP-5) ist ein BEREICH, kein Reiter der Übersicht** —
 * er steht nur, wenn ein Standort misst (`showMessstellen` aus
 * `ebenenNav.ebenenBereiche`). Und am Telefon trägt die Leiste der Ebene (ab drei
 * Kacheln) die Bereiche: was dort Kachel ist, ist hier kein zweites Mal Reiter
 * (`leiste`). Die Reiter zeigen dann nur, was zum offenen Bereich gehört —
 * Übersicht · Messwerte · Erlöse; auf „Standorte“/„Messstellen“ gar keine.
 * Am Rechner (die Leiste blendet CSS dort aus) bleiben alle Reiter der Weg.
 */
export function PortfolioTabs({
  page,
  showErloese,
  showMessstellen = false,
  showKennzahlen = false,
  leiste = [],
  fleetLabel,
  onNavigate,
}: {
  page: PageId;
  showErloese: boolean;
  /** Ein Standort misst — die Ebene hat den Bereich „Messstellen“. */
  showMessstellen?: boolean;
  /** Ein Standort misst UND es gibt eine Kennzahl — die Ebene hat den Bereich „Kennzahlen“ (AP-11 IP-13). */
  showKennzahlen?: boolean;
  /** Die Bereiche, die die Telefon-Leiste dieser Ebene gerade trägt (leer = keine Leiste). */
  leiste?: readonly EbenenBereichId[];
  /** „Portfolio" beim Betreiber, „Meine Anlagen" beim Endkunden. */
  fleetLabel: string;
  onNavigate: (page: PageId) => void;
}) {
  if (!isPortfolioPage(page)) return null;
  const welten = PORTFOLIO_WELT_PAGES.filter(
    (p) =>
      (p.id !== 'portfolio-erloese' || showErloese || page === p.id) &&
      (p.id !== 'portfolio-messstellen' || showMessstellen || page === p.id) &&
      (p.id !== 'portfolio-kennzahlen' || showKennzahlen || page === p.id),
  );
  // Ein Bereich außer der Übersicht, den die Leiste trägt: am Telefon kein Reiter.
  const kachel = (id: PageId) => {
    const bereich = ebenenAktiv(id);
    return bereich !== null && bereich !== 'uebersicht' && leiste.includes(bereich);
  };
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
    <div
      // Vier Reiter passen am Telefon nur mit schmalerem Polster (BereichTabs.css).
      className={`${welten.length >= 3 ? 'vp-bereich-tabs vp-bereich-tabs-dicht' : 'vp-bereich-tabs'}${
        kachel(page) ? ' vp-nur-rechner' : ''
      }`}
      role="tablist"
      aria-label={`Reiter der Ebene ${fleetLabel}`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={page === 'portfolio'}
        className={`vp-bereich-tab${page === 'portfolio' ? ' active' : ''}`}
        onClick={() => open('portfolio')}
      >
        Übersicht
        {/* siehe `BereichTabs.tsx`: ein eigenes Element, damit der Unterstrich
            gleiten kann (P5). Eigener Name, weil zwei gleichnamige Elemente in
            EINEM Bild den ganzen Übergang abbrechen würden. */}
        {page === 'portfolio' && <span className="vp-welt-strich" aria-hidden="true" />}
      </button>
      {welten.map((p) => (
        <button
          key={p.id}
          type="button"
          role="tab"
          aria-selected={page === p.id}
          className={`vp-bereich-tab${page === p.id ? ' active' : ''}${kachel(p.id) ? ' vp-nur-rechner' : ''}`}
          onClick={() => open(p.id)}
        >
          {p.label}
          {page === p.id && <span className="vp-welt-strich" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}
