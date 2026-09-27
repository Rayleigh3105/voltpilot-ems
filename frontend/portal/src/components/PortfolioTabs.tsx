import { ebenenAktiv, type EbenenBereichId, type EbenenKachel, type EbenenLeistenKachel } from '../ebenenNav';
import { REITER as ENERGIEMANAGEMENT_REITER } from '../energiemanagementPortal';
import { UEMS_WIEDERVORLAGE } from '../glossar';
import { useReiterRand } from '../reiterRand';
import {
  energiemanagementRoute,
  isPortfolioPage,
  PORTFOLIO_WELT_PAGES,
  type EnergiemanagementReiter,
  type PageId,
  type Route,
} from '../nav';
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
  showBezugsgroessen = false,
  showKennzahlen = false,
  showBerichte = false,
  showBewertung = false,
  showVerbesserung = false,
  showEnergiemanagement = false,
  leiste = [],
  telefonReiter = null,
  fleetLabel,
  onNavigate,
  standortBereiche = [],
  standortAktiv = null,
  onOpenBereich,
  gruppen = [],
  energiemanagementReiter = null,
}: {
  page: PageId;
  showErloese: boolean;
  /** Ein Standort misst — die Ebene hat den Bereich „Messstellen“. */
  showMessstellen?: boolean;
  /** AP-09 IP-9: ein Standort misst; die Unternehmenswelt bleibt auch leer erreichbar. */
  showBezugsgroessen?: boolean;
  /** Ein Standort misst UND es gibt eine Kennzahl — die Ebene hat den Bereich „Kennzahlen“ (AP-11 IP-13). */
  showKennzahlen?: boolean;
  /** Ein Standort misst — die Ebene hat den Bereich „Berichte“ (AP-12 IP-13). */
  showBerichte?: boolean;
  /** Ein Standort misst UND die Person darf Energieeinsätze sehen — der Bereich „Bewertung“ (AP-16 IP-6). */
  showBewertung?: boolean;
  /** Ein Standort misst UND die Person darf `verbesserung.ansehen` — der Bereich „Ziele und Maßnahmen“ (AP-18 IP-8). */
  showVerbesserung?: boolean;
  /** Ein Standort misst UND die Person darf `energiemanagement.ansehen` — der Bereich „Energiemanagement“ (AP-19 IP-9). */
  showEnergiemanagement?: boolean;
  /** Die Bereiche, die die Telefon-Leiste dieser Ebene gerade trägt (leer = keine Leiste). */
  leiste?: readonly EbenenBereichId[];
  /**
   * Trägt die Leiste GRUPPEN (Unternehmen, `ebenenNav.UNTERNEHMEN_GRUPPEN`): die Bereiche der Gruppe, in der die
   * offene Seite wohnt. Am Telefon stehen dann nur deren Reiter über der Seite — die Leiste wechselt die Gruppe.
   */
  telefonReiter?: readonly EbenenBereichId[] | null;
  /** „Portfolio" beim Betreiber, „Meine Anlagen" beim Endkunden. */
  fleetLabel: string;
  onNavigate: (page: PageId) => void;
  /**
   * UEMS AP-13 IP-2: ist der Standort die OBERSTE Ebene, trägt diese Reihe auch
   * seine Bereiche Gebäude · Anlagen (aus `ebenenNav.ebenenReiter`) — gleich
   * hinter „Übersicht“, wie in der Tabelle AP-01 §4.6. Am Rechner sind sie der
   * einzige Weg dorthin; unter einem Unternehmen trägt sie `EbenenTabs`.
   */
  standortBereiche?: readonly EbenenKachel[];
  /** Der offene Bereich (`ebenenAktiv`) — ist es einer der `standortBereiche`, ist „Übersicht“ nicht gewählt. */
  standortAktiv?: EbenenBereichId | null;
  onOpenBereich?: (ziel: Route) => void;
  /**
   * K1 (Konzept „Energiemanagement ohne Fachsprache“, D1): die GRUPPEN des Unternehmens (`ebenenNav.ebenenLeiste`).
   * Mit ihnen steht am Rechner eine Reihe der Gruppen über der Seite, darunter die Frage der offenen Gruppe und nur
   * deren Reiter — am Telefon trägt die Leiste die Gruppen. Ohne sie bleibt die flache Reihe von vorher.
   */
  gruppen?: readonly EbenenLeistenKachel[];
  /** K1 (D2): der offene Reiter des Energiemanagements — seine Reiter stehen in „Nachweisen“, die Wiedervorlage in der Übersicht. */
  energiemanagementReiter?: EnergiemanagementReiter | null;
}) {
  const reiterRand = useReiterRand<HTMLDivElement>();
  if (!isPortfolioPage(page)) return null;
  const welten = PORTFOLIO_WELT_PAGES.filter(
    (p) =>
      (p.id !== 'portfolio-erloese' || showErloese || page === p.id) &&
      (p.id !== 'portfolio-messstellen' || showMessstellen || page === p.id) &&
      (p.id !== 'portfolio-bezugsgroessen' || showBezugsgroessen) &&
      (p.id !== 'portfolio-kennzahlen' || showKennzahlen || page === p.id) &&
      (p.id !== 'portfolio-berichte' || showBerichte || page === p.id) &&
      (p.id !== 'portfolio-bewertung' || showBewertung || page === p.id) &&
      (p.id !== 'portfolio-verbesserung' || showVerbesserung || page === p.id) &&
      (p.id !== 'portfolio-energiemanagement' || showEnergiemanagement || page === p.id),
  );
  const bereichOffen = standortBereiche.some((b) => b.key === standortAktiv);
  const uebersichtOffen = page === 'portfolio' && !bereichOffen;
  // Mit Gruppen-Leiste: am Telefon nur die Reiter der offenen Gruppe (und was die Leiste nicht trägt).
  const gruppeNurRechner = (bereich: EbenenBereichId | null) =>
    telefonReiter !== null && bereich !== null && leiste.includes(bereich) && !telefonReiter.includes(bereich);
  // Ein Bereich außer der Übersicht, den die Leiste trägt: am Telefon kein Reiter.
  const kachel = (id: PageId) => {
    const bereich = ebenenAktiv(id);
    if (telefonReiter !== null) return gruppeNurRechner(bereich);
    return bereich !== null && bereich !== 'uebersicht' && leiste.includes(bereich);
  };
  const telefonSichtbar =
    telefonReiter !== null
      ? ['portfolio' as PageId, ...welten.map((p) => p.id)].filter((id) => !kachel(id)).length
      : null;
  const offenIstKachel =
    telefonSichtbar !== null
      ? telefonSichtbar < 2
      : bereichOffen ? standortAktiv !== null && leiste.includes(standortAktiv) : kachel(page);
  const open = (target: PageId) => {
    const hash = portfolioTabHash(target, page, window.location.hash);
    if (hash) {
      window.location.hash = hash;
      window.scrollTo({ top: 0 });
      return;
    }
    onNavigate(target);
  };
  // K1: mit Gruppen (am Unternehmen) die Reihe der Gruppen und darunter nur die Reiter der offenen Gruppe.
  const offeneGruppe =
    telefonReiter !== null && gruppen.length > 0 ? (gruppen.find((g) => g.bereiche.some((b) => telefonReiter.includes(b))) ?? null) : null;
  if (offeneGruppe) {
    const inGruppe = (bereich: EbenenBereichId | null) => bereich !== null && offeneGruppe.bereiche.includes(bereich);
    const emOffen = page === 'portfolio-energiemanagement';
    // Die Detailseiten tragen ihren Reiter in der Route; „Wer ist wofür verantwortlich“ gehört zu den Aufgaben.
    const emReiter: EnergiemanagementReiter =
      energiemanagementReiter === 'verantwortung' ? 'aufgaben' : energiemanagementReiter === 'zuschnitt' ? 'verzeichnis' : (energiemanagementReiter ?? 'verzeichnis');
    const emDa = welten.some((p) => p.id === 'portfolio-energiemanagement');
    const emReiterEintrag = (r: { key: EnergiemanagementReiter; label: string }): GruppenEintrag => ({
      key: `energiemanagement-${r.key}`,
      label: r.label,
      aktiv: emOffen && emReiter === r.key,
      testId: `energiemanagement-reiter-${r.key}`,
      onOpen: () => onOpenBereich?.(energiemanagementRoute(r.key)),
    });
    const weltEintrag = (p: { id: PageId; label: string }): GruppenEintrag => ({
      key: p.id,
      label: p.label,
      aktiv: page === p.id,
      testId: null,
      onOpen: () => open(p.id),
    });
    const eintraege: GruppenEintrag[] = [];
    if (inGruppe('uebersicht')) {
      eintraege.push({ key: 'portfolio', label: 'Übersicht', aktiv: page === 'portfolio', testId: null, onOpen: () => open('portfolio') });
    }
    for (const p of welten) {
      if (p.id === 'portfolio-energiemanagement') {
        // „Nachweisen“: die Reiter des Energiemanagements statt eines Reiters „Energiemanagement“ — das Verzeichnis zuerst.
        if (inGruppe('energiemanagement')) {
          for (const r of ENERGIEMANAGEMENT_REITER) if (r.key !== 'wiedervorlage') eintraege.push(emReiterEintrag(r));
        }
        continue;
      }
      if (inGruppe(ebenenAktiv(p.id))) eintraege.push(weltEintrag(p));
    }
    // Die Berichte stehen in „Nachweisen“ gleich hinter dem Verzeichnis.
    const bericht = eintraege.findIndex((e) => e.key === 'portfolio-berichte');
    if (bericht >= 0 && eintraege.some((e) => e.key === 'energiemanagement-verzeichnis')) {
      const [b] = eintraege.splice(bericht, 1);
      eintraege.splice(eintraege.findIndex((e) => e.key === 'energiemanagement-verzeichnis') + 1, 0, b);
    }
    // Die Wiedervorlage beantwortet „Was steht an?“ — sie steht in der Übersicht, ihre Adresse bleibt.
    if (inGruppe('uebersicht') && (emDa || (emOffen && emReiter === 'wiedervorlage'))) {
      eintraege.push(emReiterEintrag({ key: 'wiedervorlage', label: UEMS_WIEDERVORLAGE }));
    }
    return (
      <GruppenReiter
        gruppen={gruppen}
        offen={offeneGruppe}
        eintraege={eintraege}
        fleetLabel={fleetLabel}
        onOpenBereich={onOpenBereich}
      />
    );
  }
  return (
    <div ref={reiterRand}
      // Vier Reiter passen am Telefon nur mit schmalerem Polster (BereichTabs.css).
      className={`${welten.length + standortBereiche.length >= 3 ? 'vp-bereich-tabs vp-bereich-tabs-dicht' : 'vp-bereich-tabs'}${
        offenIstKachel ? ' vp-nur-rechner' : ''
      }`}
      role="tablist"
      aria-label={`Reiter der Ebene ${fleetLabel}`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={uebersichtOffen}
        className={`vp-bereich-tab${uebersichtOffen ? ' active' : ''}${kachel('portfolio') ? ' vp-nur-rechner' : ''}`}
        onClick={() => open('portfolio')}
      >
        Übersicht
        {/* siehe `BereichTabs.tsx`: ein eigenes Element, damit der Unterstrich
            gleiten kann (P5). Eigener Name, weil zwei gleichnamige Elemente in
            EINEM Bild den ganzen Übergang abbrechen würden. */}
        {uebersichtOffen && <span className="vp-welt-strich" aria-hidden="true" />}
      </button>
      {standortBereiche.map((b) => (
        <button
          key={b.key}
          type="button"
          role="tab"
          aria-selected={standortAktiv === b.key}
          className={`vp-bereich-tab${standortAktiv === b.key ? ' active' : ''}${leiste.includes(b.key) ? ' vp-nur-rechner' : ''}`}
          onClick={() => onOpenBereich?.(b.ziel)}
        >
          {b.label}
          {standortAktiv === b.key && <span className="vp-welt-strich" aria-hidden="true" />}
        </button>
      ))}
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

interface GruppenEintrag {
  key: string;
  label: string;
  aktiv: boolean;
  testId: string | null;
  onOpen: () => void;
}

/**
 * K1: die Gruppen des Unternehmens am Rechner als obere Reihe (am Telefon trägt sie die Leiste), darunter die Frage
 * der offenen Gruppe und ihre Reiter — ab zwei; ein einzelner Reiter behauptete eine Wahl, die es nicht gibt.
 */
function GruppenReiter({
  gruppen,
  offen,
  eintraege,
  fleetLabel,
  onOpenBereich,
}: {
  gruppen: readonly EbenenLeistenKachel[];
  offen: EbenenLeistenKachel;
  eintraege: readonly GruppenEintrag[];
  fleetLabel: string;
  onOpenBereich?: (ziel: Route) => void;
}) {
  const reiterRand = useReiterRand<HTMLDivElement>();
  return (
    <div className="vp-gruppen" data-testid="gruppen-navigation">
      <div className="vp-bereich-tabs vp-gruppen-reihe vp-nur-rechner" role="tablist" aria-label={`Gruppen der Ebene ${fleetLabel}`}>
        {gruppen.map((g) => {
          const an = g.key === offen.key;
          return (
            <button
              key={g.key}
              type="button"
              role="tab"
              aria-selected={an}
              className={`vp-bereich-tab${an ? ' active' : ''}`}
              data-testid={`gruppe-${g.key}`}
              onClick={() => onOpenBereich?.(g.ziel)}
            >
              {g.label}
              {an && <span className="vp-gruppe-strich" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      {offen.frage && (
        <p className="vp-gruppen-frage vp-nur-rechner" data-testid="gruppen-frage">
          {offen.frage}
        </p>
      )}
      {eintraege.length >= 2 && (
        <div
          ref={reiterRand}
          className="vp-bereich-tabs vp-bereich-tabs-dicht vp-gruppen-reiter"
          role="tablist"
          aria-label={`Reiter der Gruppe ${offen.label}`}
        >
          {eintraege.map((e) => (
            <button
              key={e.key}
              type="button"
              role="tab"
              aria-selected={e.aktiv}
              className={`vp-bereich-tab${e.aktiv ? ' active' : ''}`}
              {...(e.testId ? { 'data-testid': e.testId } : {})}
              onClick={e.onOpen}
            >
              {e.label}
              {e.aktiv && <span className="vp-welt-strich" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
