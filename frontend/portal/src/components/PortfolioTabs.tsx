import type { KostenstelleEnergiePeriode } from '../api';
import { ebenenAktiv, type EbenenBereichId, type EbenenKachel, type EbenenLeistenKachel } from '../ebenenNav';
import { REITER as ENERGIEMANAGEMENT_REITER } from '../energiemanagementPortal';
import { REITER as ZIELE_REITER } from '../energieziele';
import { UEMS_WIEDERVORLAGE } from '../glossar';
import { REITER_WORT, reiterAus, reiterHash, type MessstellenReiter } from '../kostenstellenUebersicht';
import { organisationReiter, useMessstellenFlaeche, useOrganisation } from '../messstellenOrganisation';
import { useReiterRand } from '../reiterRand';
import {
  energiemanagementRoute,
  isPortfolioPage,
  PORTFOLIO_WELT_PAGES,
  verbesserungRoute,
  type EnergiemanagementReiter,
  type PageId,
  type Route,
  type VerbesserungReiter,
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
 * Die REITER über einer Seite der Unternehmens-, Standort- oder Flotten-Ebene — seit dem Konzept „Navigation aus einem
 * Guss“ (N1–N6) HÖCHSTENS EINE Reihe (R3), am Rechner und am Telefon gleich:
 *
 * - Die EINTRÄGE der Ebene (Gruppen, Standort-Bereiche, die Seiten der Flotte) stehen in der Seitenleiste und in der
 *   Telefon-Leiste (`ebenenNav.ebenenLeiste`); was sie tragen (`leiste`, `leisteSeiten`), steht hier kein zweites Mal.
 * - Am Unternehmen mit Gruppen stehen hier nur die Reiter der offenen Gruppe: „Messen“ mit Messstellen · Kostenstellen ·
 *   Prozesse · Bezugsgrößen (N5), „Verbessern“ mit Energieziele · Maßnahmen · Abweichungen, „Nachweisen“ mit dem
 *   Verzeichnis, den Berichten und den übrigen Reitern des Energiemanagements (D2). Die Gruppenreihe und die Fragezeile
 *   (K1) sind entfallen — die Frage steht unter dem offenen Eintrag der Seitenleiste (N4).
 * - Eine DETAILSEITE (eine Kennzahl, ein Bericht, …) zeigt ihren Rückweg statt dieser Reihe (R4, `detail`).
 *
 * ⚠ **Die Erlöse-Welt erscheint nur mit einem Geld-Modus** (`showErloese` = `geldWelt.hatGeldWelt`) — eine rein
 * private Flotte bekommt gar keinen Reiter statt eines, der nichts erklärt. Wird die Welt trotzdem per Lesezeichen
 * geöffnet, steht ihr Reiter da: eine offene Seite ohne Reiter wäre eine Sackgasse.
 *
 * ⚠ **Sie wohnen ÜBER dem Seitenkopf**, nicht darunter: sie navigieren zwischen Seiten derselben Ebene (der Kopf
 * gehört schon der geöffneten).
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
  leisteSeiten = [],
  telefonReiter = null,
  fleetLabel,
  onNavigate,
  standortBereiche = [],
  standortAktiv = null,
  onOpenBereich,
  gruppen = [],
  energiemanagementReiter = null,
  verbesserungReiter = null,
  detail = false,
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
  /** Die Bereiche, die Seitenleiste und Telefon-Leiste dieser Ebene tragen (leer = keine Leiste). */
  leiste?: readonly EbenenBereichId[];
  /** N3: die SEITEN, die die Einträge der Flotte tragen (Übersicht, Standorte, Energie, Erlöse). */
  leisteSeiten?: readonly PageId[];
  /** Tragen die Einträge GRUPPEN (Unternehmen, `ebenenNav.UNTERNEHMEN_GRUPPEN`): die Bereiche der offenen Gruppe. */
  telefonReiter?: readonly EbenenBereichId[] | null;
  /** „Portfolio" beim Betreiber, „Meine Anlagen" beim Endkunden. */
  fleetLabel: string;
  onNavigate: (page: PageId) => void;
  /**
   * UEMS AP-13 IP-2: ist der Standort die OBERSTE Ebene, trägt diese Reihe auch seine Bereiche Aufbau · Gebäude ·
   * Netzanschlüsse (aus `ebenenNav.ebenenReiter`) — gleich hinter „Übersicht“; was die Leiste trägt, entfällt.
   */
  standortBereiche?: readonly EbenenKachel[];
  /** Der offene Bereich (`ebenenAktiv`) — ist es einer der `standortBereiche`, ist „Übersicht“ nicht gewählt. */
  standortAktiv?: EbenenBereichId | null;
  onOpenBereich?: (ziel: Route) => void;
  /** N1: die GRUPPEN des Unternehmens (`ebenenNav.unternehmensGruppen`) — hier stehen nur die Reiter der offenen. */
  gruppen?: readonly EbenenLeistenKachel[];
  /** K1 (D2): der offene Reiter des Energiemanagements — seine Reiter stehen in „Nachweisen“, die Wiedervorlage in der Übersicht. */
  energiemanagementReiter?: EnergiemanagementReiter | null;
  /** Der offene Reiter von „Ziele und Maßnahmen“ — seine Reiter stehen in „Verbessern“. */
  verbesserungReiter?: VerbesserungReiter | null;
  /** R4: eine Detailseite zeigt ihren Rückweg statt dieser Reihe. */
  detail?: boolean;
}) {
  const reiterRand = useReiterRand<HTMLDivElement>();
  // K1/N1: mit Gruppen (am Unternehmen) stehen hier nur die Reiter der offenen Gruppe.
  const offeneGruppe =
    telefonReiter !== null && gruppen.length > 0 ? (gruppen.find((g) => g.bereiche.some((b) => telefonReiter.includes(b))) ?? null) : null;
  // N5: „Kostenstellen“ und „Prozesse“ gehören in die Reihe von „Messen“ — dieselben Kataloge wie die Seite.
  const messenOffen = offeneGruppe?.bereiche.includes('messstellen') === true && showMessstellen;
  const organisation = organisationReiter(useOrganisation(messenOffen && !detail));
  const flaeche = useMessstellenFlaeche();
  if (!isPortfolioPage(page) || detail) return null;
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
  const open = (target: PageId) => {
    const hash = portfolioTabHash(target, page, window.location.hash);
    if (hash) {
      window.location.hash = hash;
      window.scrollTo({ top: 0 });
      return;
    }
    onNavigate(target);
  };
  if (offeneGruppe) {
    const inGruppe = (bereich: EbenenBereichId | null) => bereich !== null && offeneGruppe.bereiche.includes(bereich);
    const emOffen = page === 'portfolio-energiemanagement';
    // Die Detailseiten tragen ihren Reiter in der Route; „Wer ist wofür verantwortlich“ gehört zu den Aufgaben.
    // Das Verzeichnis und die Zuschnitt-Hilfe liegen eine Ebene unter dem Überblick (Konzept Nachweisen n1, Entscheid 2).
    const emReiter: EnergiemanagementReiter =
      energiemanagementReiter === 'verantwortung'
        ? 'aufgaben'
        : energiemanagementReiter === 'zuschnitt' || energiemanagementReiter === 'verzeichnis'
          ? 'ueberblick'
          : (energiemanagementReiter ?? 'ueberblick');
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
    // N5: die Reiter der Welt Messstellen — „Messstellen“ ist die Liste. Auf der Fläche zeigt die Reihe ihren offenen
    // Reiter und wählt über sie (mit ihrem Zeitraum, die Adresse ersetzt); von einer anderen Seite führt sie hin.
    const msFlaeche = page === 'portfolio-messstellen' ? flaeche : null;
    const msReiter = page === 'portfolio-messstellen' ? (msFlaeche?.offen ?? reiterAus(window.location.hash)) : null;
    const msEintrag = (r: MessstellenReiter): GruppenEintrag => ({
      key: `messstellen-${r}`,
      label: r === 'liste' ? 'Messstellen' : REITER_WORT[r],
      aktiv: msReiter === r,
      testId: `messstellen-reiter-${r}`,
      onOpen: () => {
        if (msFlaeche) msFlaeche.waehlen(r);
        else window.location.hash = reiterHash(r, page === 'portfolio-messstellen' ? zeitraumDerAdresse(window.location.hash) : null);
      },
    });
    const vbReiter: VerbesserungReiter = verbesserungReiter ?? 'energieziele';
    const eintraege: GruppenEintrag[] = [];
    if (inGruppe('uebersicht')) {
      eintraege.push({ key: 'portfolio', label: 'Übersicht', aktiv: page === 'portfolio', testId: null, onOpen: () => open('portfolio') });
    }
    for (const p of welten) {
      if (p.id === 'portfolio-energiemanagement') {
        // „Nachweisen“: die Reiter des Energiemanagements statt eines Reiters „Energiemanagement“ - der Überblick zuerst.
        if (inGruppe('energiemanagement')) {
          for (const r of ENERGIEMANAGEMENT_REITER) if (r.key !== 'wiedervorlage') eintraege.push(emReiterEintrag(r));
        }
        continue;
      }
      if (p.id === 'portfolio-messstellen' && inGruppe('messstellen') && organisation && organisation.length > 0) {
        for (const r of organisation) eintraege.push(msEintrag(r));
        continue;
      }
      if (p.id === 'portfolio-verbesserung' && inGruppe('verbesserung')) {
        // „Verbessern“: die Reiter von „Ziele und Maßnahmen“ statt eines einzelnen Reiters.
        for (const r of ZIELE_REITER) {
          eintraege.push({
            key: `verbesserung-${r.key}`,
            label: r.label,
            aktiv: page === 'portfolio-verbesserung' && vbReiter === r.key,
            testId: `verbesserung-reiter-${r.key}`,
            onOpen: () => onOpenBereich?.(verbesserungRoute(r.key)),
          });
        }
        continue;
      }
      if (inGruppe(ebenenAktiv(p.id))) eintraege.push(weltEintrag(p));
    }
    // Die Berichte stehen in „Nachweisen“ gleich hinter dem Überblick (Konzept Nachweisen n1, §6.2).
    const bericht = eintraege.findIndex((e) => e.key === 'portfolio-berichte');
    if (bericht >= 0 && eintraege.some((e) => e.key === 'energiemanagement-ueberblick')) {
      const [b] = eintraege.splice(bericht, 1);
      eintraege.splice(eintraege.findIndex((e) => e.key === 'energiemanagement-ueberblick') + 1, 0, b);
    }
    // Die Wiedervorlage beantwortet „Was steht an?“ — sie steht in der Übersicht, ihre Adresse bleibt.
    if (inGruppe('uebersicht') && (emDa || (emOffen && emReiter === 'wiedervorlage'))) {
      eintraege.push(emReiterEintrag({ key: 'wiedervorlage', label: UEMS_WIEDERVORLAGE }));
    }
    return <GruppenReiter offen={offeneGruppe} eintraege={eintraege} />;
  }
  // Ohne Gruppen: eine Reihe der Seiten, ohne was Seitenleiste und Telefon-Leiste schon tragen (N1/N3).
  const getragen = (id: PageId) => {
    if (leisteSeiten.includes(id)) return true;
    const bereich = ebenenAktiv(id);
    return bereich !== null && bereich !== 'uebersicht' && leiste.includes(bereich);
  };
  const bereichOffen = standortBereiche.some((b) => b.key === standortAktiv);
  const uebersichtOffen = page === 'portfolio' && !bereichOffen;
  // Ist die offene Seite selbst ein Eintrag der Leiste, gehört diese Reihe nicht zu ihr.
  const offenGetragen = bereichOffen ? standortAktiv !== null && leiste.includes(standortAktiv) : getragen(page);
  const bereiche = standortBereiche.filter((b) => !leiste.includes(b.key));
  const seiten = welten.filter((p) => !getragen(p.id));
  const mitUebersicht = !getragen('portfolio');
  const zahl = (mitUebersicht ? 1 : 0) + bereiche.length + seiten.length;
  if (offenGetragen || zahl < 2) return null;
  return (
    <div ref={reiterRand}
      // Vier Reiter passen am Telefon nur mit schmalerem Polster (BereichTabs.css).
      className={zahl >= 4 ? 'vp-bereich-tabs vp-bereich-tabs-dicht' : 'vp-bereich-tabs'}
      role="tablist"
      aria-label={`Reiter der Ebene ${fleetLabel}`}
    >
      {mitUebersicht && (
        <button
          type="button"
          role="tab"
          aria-selected={uebersichtOffen}
          className={`vp-bereich-tab${uebersichtOffen ? ' active' : ''}`}
          onClick={() => open('portfolio')}
        >
          Übersicht
          {/* siehe `BereichTabs.tsx`: ein eigenes Element, damit der Unterstrich
              gleiten kann (P5). Eigener Name, weil zwei gleichnamige Elemente in
              EINEM Bild den ganzen Übergang abbrechen würden. */}
          {uebersichtOffen && <span className="vp-welt-strich" aria-hidden="true" />}
        </button>
      )}
      {bereiche.map((b) => (
        <button
          key={b.key}
          type="button"
          role="tab"
          aria-selected={standortAktiv === b.key}
          className={`vp-bereich-tab${standortAktiv === b.key ? ' active' : ''}`}
          onClick={() => onOpenBereich?.(b.ziel)}
        >
          {b.label}
          {standortAktiv === b.key && <span className="vp-welt-strich" aria-hidden="true" />}
        </button>
      ))}
      {seiten.map((p) => (
        <button
          key={p.id}
          type="button"
          role="tab"
          aria-selected={page === p.id}
          className={`vp-bereich-tab${page === p.id ? ' active' : ''}`}
          onClick={() => open(p.id)}
        >
          {p.label}
          {page === p.id && <span className="vp-welt-strich" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

/** Der Zeitraum der Adresse (`periode`, `am`), den ein Reiterwechsel der Messstellen mitnimmt. */
function zeitraumDerAdresse(hash: string): { periode: KostenstelleEnergiePeriode; am: string } | null {
  const q = new URLSearchParams(hash.split('?').slice(1).join('?'));
  const periode = q.get('periode');
  const am = q.get('am');
  return periode && am ? { periode: periode as KostenstelleEnergiePeriode, am } : null;
}

interface GruppenEintrag {
  key: string;
  label: string;
  aktiv: boolean;
  testId: string | null;
  onOpen: () => void;
}

/**
 * N1: die Reiter der offenen Gruppe des Unternehmens — ab zwei; ein einzelner Reiter behauptete eine Wahl, die es
 * nicht gibt. Die Gruppen selbst stehen in der Seitenleiste und in der Telefon-Leiste, ihre Frage unter dem offenen
 * Eintrag der Seitenleiste.
 */
function GruppenReiter({ offen, eintraege }: { offen: EbenenLeistenKachel; eintraege: readonly GruppenEintrag[] }) {
  const reiterRand = useReiterRand<HTMLDivElement>();
  if (eintraege.length < 2) return null;
  return (
    <div
      ref={reiterRand}
      className="vp-bereich-tabs vp-bereich-tabs-dicht vp-gruppen-reiter"
      role="tablist"
      aria-label={`Reiter der Gruppe ${offen.label}`}
      data-testid="gruppen-reiter"
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
  );
}
