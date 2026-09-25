import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { GeraetBrotkrume } from './GeraetBrotkrume';
import { InfoTip } from './InfoTip';
import { RowMenu, type RowMenuItem } from './RowMenu';
import { runPageTransition } from '../pageTransition';
import { mitStaffel, useStaffel } from '../staffel';
import { useIsPhone } from '../useIsPhone';
import {
  ankerId,
  BAUSTEIN_TITEL,
  ohneTechnikHash,
  sprungZiel,
  technikHash,
  TECHNIK_ANSICHT_TITEL,
  TECHNIK_TITEL,
  zielTitel,
  type BausteinId,
  type KopfHinweis,
  type TechnikId,
  type Ziel,
} from '../geraetRahmen';
import type { GeraetTon } from '../geraetSeite';
import './GeraetRahmen.css';

/**
 * DER KERN einer Geräteseite (Konzept „Geräteseiten: Ein Blick, eine
 * Antwort") - Kopf, fünf Bausteine und die Unteransicht „Technik & Diagnose".
 *
 * <p>Diese Datei RENDERT nur. Welche Bausteine es gibt und in welcher
 * Reihenfolge sie stehen, entscheidet die reine `src/geraetRahmen.ts`; was IN
 * einem Baustein steht, bringt der Gerätetyp mit (die Seiten).
 *
 * <p><b>Drei Regeln</b>:
 * <ol>
 *   <li>Am Telefon stehen die Bausteine in der kanonischen Reihenfolge
 *       untereinander, am Rechner in zwei Spalten: links, was das Gerät TUT
 *       (Jetzt, Heute), rechts, was man TUN kann (Steuerung, Aktivität) -
 *       „Gerät &amp; Verbindung" und „Technik &amp; Diagnose" darunter über die
 *       volle Breite. Entschieden wird an der Breite des KERNS
 *       (Container-Abfrage), nicht des Fensters - die Seitenleiste des Portals
 *       frisst Platz.</li>
 *   <li>„Technik &amp; Diagnose" ist eine eigene Ansicht mit eigener Adresse
 *       (`?ansicht=technik`, E1 a): am Telefon schiebt sie wie eine App-Seite,
 *       am Rechner blendet sie - der Seitenwechsel des Portals
 *       (`pageTransition.runPageTransition`), keine zweite Mechanik.</li>
 *   <li>⚠ Gesprungen wird über <code>id</code> + <code>scrollIntoView</code> -
 *       <b>NIE über einen <code>#anker</code></b>: die App ist hash-geroutet,
 *       ein zweites <code>#</code> läse der Router als Route.</li>
 * </ol>
 */

/** Das Symbol im Kopf - Zeichen und Farbe aus der Energiefluss-Familie. */
export interface KernSymbol {
  icon: IconName;
  farbe: 'batt' | 'pv' | 'grid' | 'load' | 'ev' | 'box' | 'io' | 'neutral';
}

/** Der Kopf einer Geräteseite - für jedes Gerät gleich gebaut. */
export interface RahmenKopf {
  /** Der Name, wie der Kunde ihn kennt. */
  titel: string;
  /** Der Typ in Kundenworten („Hybrid-Wechselrichter"). */
  typ: string;
  /**
   * Hersteller und Modell - null, wenn der Titel schon genau das ist. Am
   * Ausgang eines Moduls steht hier, WO das Gerät hängt (K4).
   */
  modell?: string | null;
  symbol: KernSymbol;
  /**
   * Die Kennung - NUR an der Box (V1): sie steht auf ihrem Aufkleber. Jedes
   * andere Gerät führt seine Kennung in Technik › Rohdaten.
   */
  kennung?: string | null;
  /** Der Live-Punkt: Zustand und Datenalter aus dem Frische-Anker DIESES Geräts. */
  zustand?: { wort: string; ton: GeraetTon; detail: string | null } | null;
  /**
   * Die Bezugszeit des jüngsten Werts. Wechselt sie, pulsiert der Live-Punkt
   * EINMAL - man sieht ohne Uhrzeit-Lesen, dass die Seite lebt.
   */
  frische?: string | null;
  /** Ruhige Abzeichen neben dem Live-Punkt („VoltPilot steuert", „nur Messung"). */
  abzeichen?: ReactNode;
  /** Höchstens EIN Befund - nichts, wenn nichts ansteht. */
  hinweis?: KopfHinweis | null;
}

/** Ein Eintrag im Menü „⋯". */
export interface MenueEintrag {
  key: string;
  label: string;
  icon?: IconName;
  onClick: () => void;
  /** Destruktiv - steht abgesetzt am Ende. */
  danger?: boolean;
}

/** Was ein Baustein mitbringt. */
export interface BausteinInhalt {
  /** Abweichender Titel („Einspeise-Begrenzung", „Geräte an dieser Box"). */
  titel?: string | null;
  /** Rechts im Kartenkopf: ein Weg („Verlauf ›") oder ein ruhiger Zustand. */
  kopfRechts?: ReactNode;
  /** Das ⓘ neben dem Titel - die Fußnoten, die früher unter der Liste standen (V8). */
  info?: ReactNode;
  inhalt: ReactNode;
}

/** Ein Teil der Technik-Ansicht. */
export interface TechnikTeil {
  id: TechnikId;
  /** Abweichender Titel („Messwerte" an einem Gerät ohne Register). */
  titel?: string | null;
  /**
   * Ein BELEGTER Befund dieses Teils („1 Lücke"), der schon an der
   * geschlossenen Zeile stehen muss - eine Tür, die nicht sagt, was hinter ihr
   * liegt, wäre die Wand, die der Kern beenden soll.
   */
  hinweis?: string | null;
  inhalt: ReactNode;
}

type KernBausteine = Partial<Record<Exclude<BausteinId, 'details'> | 'modul', BausteinInhalt | null>>;

export function GeraetRahmen({
  testId,
  geraetKey,
  brotkrume,
  kopf,
  menue = [],
  kopfAktion,
  unterKopf,
  bausteine,
  modulSpalte = 'rechts',
  details,
  technik = [],
  veraltet = false,
}: {
  testId?: string;
  /**
   * Der Schlüssel DIESES Geräts - die Karten erscheinen nur beim ersten Besuch
   * je Sitzung gestaffelt (`useStaffel`), nie bei jeder Rückkehr.
   */
  geraetKey: string;
  brotkrume: { anlageHref: string; komponentenHref: string };
  kopf: RahmenKopf;
  /** Das Menü „⋯" - „Technik & Diagnose" ergänzt der Kern selbst. */
  menue?: MenueEintrag[];
  /** Eine sichtbare Handlung neben „⋯" - nur am Rechner (V9: „Name ändern"). */
  kopfAktion?: ReactNode;
  /** Meldungen direkt unter dem Kopf (gespeichert, Fehler). */
  unterKopf?: ReactNode;
  /** Die Bausteine der Hauptansicht - `null`/fehlend fällt still weg. */
  bausteine: KernBausteine;
  /** Wo das Zusatz-Modul am Rechner steht (die Box: links unter der Bühne). */
  modulSpalte?: 'links' | 'rechts';
  /** „Gerät & Verbindung": zugeklappt am Telefon, offen am Rechner. */
  details?: { kurz: string | null; inhalt: ReactNode } | null;
  /** Die Teile der Technik-Ansicht; leer = die Seite hat keine. */
  technik?: TechnikTeil[];
  /** Veraltete Daten: die Bühne steht still und grau (nie „live" behaupten). */
  veraltet?: boolean;
}) {
  const hatTechnik = technik.length > 0;
  const [inTechnik, setInTechnik] = useState<boolean>(
    () => hatTechnik && typeof window !== 'undefined' && sprungZiel(window.location.hash)?.ansicht === 'technik',
  );
  const [detailsOffen, setDetailsOffen] = useState<boolean | null>(null);
  const isPhone = useIsPhone();
  const staffel = useStaffel(`geraet:${geraetKey}`);
  const scrollVorTechnik = useRef<number | null>(null);
  const geoeffnetVonHier = useRef(false);
  const gesprungen = useRef<string | null>(null);
  const ansichtGewechselt = useRef(false);
  const inTechnikRef = useRef(inTechnik);

  const springeZu = useCallback((id: BausteinId | TechnikId) => {
    if (id === 'details') setDetailsOffen(true);
    // Das Ziel steht erst nach dem Seitenwechsel im Baum - ein paar Bilder
    // lang nachsehen, nie endlos.
    let versuche = 0;
    const ziel = () => {
      const el = document.getElementById(ankerId(id));
      if (!el) {
        versuche += 1;
        if (versuche < 20 && typeof window !== 'undefined' && window.requestAnimationFrame) {
          window.requestAnimationFrame(ziel);
        }
        return;
      }
      el.focus({ preventScroll: true });
      el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    };
    if (typeof window !== 'undefined' && window.requestAnimationFrame) {
      window.requestAnimationFrame(ziel);
    } else {
      ziel();
    }
  }, []);

  // Die Adresse ist die EINE Wahrheit über die Ansicht: beim Aufbau und bei
  // jedem Hash-Wechsel (Zurück-Taste, Deep-Link aus einer offenen Seite).
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const pruefen = () => {
      const ziel = sprungZiel(window.location.hash);
      const technikJetzt = hatTechnik && ziel?.ansicht === 'technik';
      if (technikJetzt !== inTechnikRef.current) {
        inTechnikRef.current = technikJetzt;
        ansichtGewechselt.current = true;
        // Telefon schiebt, Rechner blendet - der Seitenwechsel des Portals.
        runPageTransition(technikJetzt ? 'push' : 'pop', () => setInTechnik(technikJetzt));
      }
      // Je Adresse GENAU EINMAL springen - sonst risse der Sprung dem Kunden
      // bei jedem Zustands-Takt die Ansicht weg.
      const marke = window.location.hash;
      if (!ziel || gesprungen.current === marke) return;
      gesprungen.current = marke;
      if (ziel.ansicht === 'geraet') springeZu(ziel.baustein);
      else if (ziel.teil) springeZu(ziel.teil);
    };
    pruefen();
    window.addEventListener('hashchange', pruefen);
    return () => window.removeEventListener('hashchange', pruefen);
  }, [hatTechnik, springeZu]);

  // Ein Wechsel der Ansicht beginnt oben - und der Rückweg kehrt dorthin
  // zurück, wo der Kunde war. Im Layout-Effekt, damit das neue Bild des
  // Seitenwechsels schon an der richtigen Stelle steht.
  useLayoutEffect(() => {
    if (!ansichtGewechselt.current) return;
    ansichtGewechselt.current = false;
    if (typeof window === 'undefined' || typeof window.scrollTo !== 'function') return;
    const ziel = sprungZiel(window.location.hash);
    if (inTechnik && !(ziel?.ansicht === 'technik' && ziel.teil)) {
      try { window.scrollTo({ top: 0 }); } catch { /* jsdom */ }
    } else if (!inTechnik && scrollVorTechnik.current != null && !(ziel?.ansicht === 'geraet')) {
      const y = scrollVorTechnik.current;
      scrollVorTechnik.current = null;
      try { window.scrollTo({ top: y }); } catch { /* jsdom */ }
    }
  }, [inTechnik]);

  const technikOeffnen = useCallback((teil: TechnikId | null = null) => {
    if (typeof window === 'undefined') return;
    scrollVorTechnik.current = window.scrollY;
    geoeffnetVonHier.current = true;
    window.location.hash = technikHash(window.location.hash, teil);
  }, []);

  const technikSchliessen = useCallback(() => {
    if (typeof window === 'undefined') return;
    // Wer die Ansicht von hier geöffnet hat, geht einen Schritt zurück - die
    // Zurück-Taste des Telefons und dieser Knopf tun dann dasselbe.
    if (geoeffnetVonHier.current) {
      geoeffnetVonHier.current = false;
      window.history.back();
      return;
    }
    window.location.hash = ohneTechnikHash(window.location.hash);
  }, []);

  const zuZiel = useCallback((ziel: Ziel) => {
    if (ziel.ansicht === 'technik') {
      technikOeffnen(ziel.teil);
      return;
    }
    springeZu(ziel.baustein);
  }, [springeZu, technikOeffnen]);

  const menueEintraege: RowMenuItem[] = [
    ...menue.filter((m) => !m.danger).map((m) => ({ label: m.label, icon: m.icon, onClick: m.onClick })),
    ...(hatTechnik
      ? [{ label: TECHNIK_ANSICHT_TITEL, icon: 'sliders' as IconName, onClick: () => technikOeffnen() }]
      : []),
    ...menue.filter((m) => m.danger).map((m) => ({
      label: m.label, icon: m.icon, onClick: m.onClick, danger: true,
    })),
  ];

  const kopfBlock = (
    <header className="vp-kern-kopf" data-testid="geraet-kopf">
      <span className={`vp-kern-symbol is-${kopf.symbol.farbe}`} aria-hidden="true">
        <Icon name={kopf.symbol.icon} size={22} />
      </span>
      <div className="vp-kern-name">
        <h1>{kopf.titel}</h1>
        <p className="vp-kern-typ" data-testid="geraet-typ">
          {[kopf.typ, kopf.modell].filter(Boolean).join(' · ')}
          {kopf.kennung && (
            <>
              {' · '}
              <span className="vp-mono">{kopf.kennung}</span>
            </>
          )}
        </p>
      </div>
      {(kopfAktion || menueEintraege.length > 0) && (
        <div className="vp-kern-kopfaktion">
          {kopfAktion && <span className="vp-kern-kopfaktion-rechner">{kopfAktion}</span>}
          {menueEintraege.length > 0 && (
            <RowMenu items={menueEintraege} label="Weitere Aktionen" />
          )}
        </div>
      )}
      {(kopf.zustand || kopf.abzeichen) && (
        <div className="vp-kern-meta">
          {kopf.zustand && <LivePunkt zustand={kopf.zustand} frische={kopf.frische ?? null} />}
          {kopf.abzeichen}
        </div>
      )}
      {kopf.hinweis && (
        <p className={`vp-kern-hinweis is-${kopf.hinweis.ton}`} data-testid="geraet-kopfhinweis">
          <Icon name="alert-triangle" size={15} />
          <span>{kopf.hinweis.satz}</span>
          {kopf.hinweis.ziel && (
            <button
              type="button"
              className="vp-linkbtn"
              onClick={() => zuZiel(kopf.hinweis!.ziel as Ziel)}
            >
              {zielTitel(kopf.hinweis.ziel)} ansehen
            </button>
          )}
        </p>
      )}
    </header>
  );

  if (inTechnik && hatTechnik) {
    return (
      <div className="vp-geraet vp-kern vp-kern-technik" data-testid={testId}>
        <GeraetBrotkrume
          anlageHref={brotkrume.anlageHref}
          komponentenHref={brotkrume.komponentenHref}
          titel={kopf.titel}
        />
        <div className="vp-kern-technik-kopf">
          <button type="button" className="vp-kern-zurueck" onClick={technikSchliessen}>
            <Icon name="chevron-left" size={16} /> {kopf.titel}
          </button>
          <h1>{TECHNIK_ANSICHT_TITEL}</h1>
          <p className="vp-kern-typ">{[kopf.typ, kopf.modell].filter(Boolean).join(' · ')}</p>
        </div>
        {unterKopf}
        <div className="vp-kern-technik-teile" data-testid="geraet-technik">
          {technik.map((t) => (
            <section
              key={t.id}
              id={ankerId(t.id)}
              tabIndex={-1}
              className="vp-kern-karte vp-kern-technikteil"
              data-technik={t.id}
              aria-labelledby={`${ankerId(t.id)}-titel`}
            >
              <h2 id={`${ankerId(t.id)}-titel`}>{t.titel?.trim() || TECHNIK_TITEL[t.id]}</h2>
              {t.inhalt}
            </section>
          ))}
        </div>
      </div>
    );
  }

  const karte = (id: Exclude<BausteinId, 'details'> | 'modul', b: BausteinInhalt | null | undefined) => {
    if (!b) return null;
    const titel = b.titel?.trim() || (id === 'modul' ? '' : BAUSTEIN_TITEL[id]);
    const titelId = `geraet-baustein-${id}-titel`;
    return (
      <section
        key={id}
        id={id === 'modul' ? undefined : ankerId(id)}
        tabIndex={-1}
        className={`vp-kern-karte is-${id}`}
        data-baustein={id}
        data-testid={`baustein-${id}`}
        aria-labelledby={titel ? titelId : undefined}
        aria-label={titel ? undefined : BAUSTEIN_TITEL.buehne}
      >
        {titel && (
          <div className={`vp-kern-karte-kopf${id === 'buehne' ? ' vp-sr-only' : ''}`}>
            <h2 id={titelId}>
              {titel}
              {b.info && (
                <InfoTip label={`Hinweise zu „${titel}"`}>{b.info}</InfoTip>
              )}
            </h2>
            {b.kopfRechts && <span className="vp-kern-karte-rechts">{b.kopfRechts}</span>}
          </div>
        )}
        {b.inhalt}
      </section>
    );
  };

  const offen = detailsOffen ?? !isPhone;
  const technikKurz = technik.map((t) => t.titel?.trim() || TECHNIK_TITEL[t.id]).join(' · ');
  const technikHinweis = technik.map((t) => t.hinweis?.trim()).filter(Boolean).join(' · ');

  return (
    <div className={`vp-geraet vp-kern${veraltet ? ' is-veraltet' : ''}`} data-testid={testId}>
      <GeraetBrotkrume
        anlageHref={brotkrume.anlageHref}
        komponentenHref={brotkrume.komponentenHref}
        titel={kopf.titel}
      />
      {kopfBlock}
      {unterKopf}
      <div className="vp-kern-raster">
        <div className={mitStaffel('vp-kern-spalte is-links', staffel)}>
          {karte('buehne', bausteine.buehne)}
          {modulSpalte === 'links' && karte('modul', bausteine.modul)}
          {karte('heute', bausteine.heute)}
        </div>
        <div className={mitStaffel('vp-kern-spalte is-rechts', staffel)}>
          {karte('steuerung', bausteine.steuerung)}
          {modulSpalte === 'rechts' && karte('modul', bausteine.modul)}
          {karte('aktivitaet', bausteine.aktivitaet)}
        </div>
        {/* Die zwei ruhigen Zeilen stehen am Rechner UNTER beiden Spalten, über
            die volle Breite - in der rechten Spalte machten sie sie doppelt so
            lang wie die linke. */}
        <div className={mitStaffel('vp-kern-unten', staffel)}>
          {details && (
            <details
              id={ankerId('details')}
              tabIndex={-1}
              className="vp-kern-zeile is-details"
              data-baustein="details"
              data-testid="baustein-details"
              open={offen}
              onToggle={(e) => setDetailsOffen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>
                <Icon name="cpu" size={18} />
                <span>
                  <span className="t">{BAUSTEIN_TITEL.details}</span>
                  {details.kurz && <span className="k">{details.kurz}</span>}
                </span>
                <Icon name="chevron-right" size={16} />
              </summary>
              <div className="vp-kern-zeile-inhalt">{details.inhalt}</div>
            </details>
          )}
          {hatTechnik && (
            <button
              type="button"
              className="vp-kern-zeile is-knopf"
              data-testid="geraet-technik-oeffnen"
              onClick={() => technikOeffnen()}
            >
              <Icon name="sliders" size={18} />
              <span>
                <span className="t">{TECHNIK_ANSICHT_TITEL}</span>
                <span className="k">
                  {technikKurz}
                  {technikHinweis && <b className="h">{` · ${technikHinweis}`}</b>}
                </span>
              </span>
              <Icon name="chevron-right" size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Der Live-Punkt im Kopf: Zustand und Datenalter in EINEM Element (S6 - er
 * ersetzt „Stand 12:00:00", „Letzte Messung" und „Zustand").
 *
 * ⚠ Er pulsiert EINMAL, wenn ein neuer Wert ankommt - und nur, solange die
 * Daten frisch sind. Veraltete Daten stehen still: eine Bewegung darf nie
 * „live" behaupten, wenn es nicht stimmt.
 */
function LivePunkt({
  zustand,
  frische,
}: {
  zustand: { wort: string; ton: GeraetTon; detail: string | null };
  frische: string | null;
}) {
  const [puls, setPuls] = useState(0);
  const vorher = useRef(frische);
  useEffect(() => {
    if (frische && vorher.current && frische !== vorher.current && zustand.ton === 'ok') {
      setPuls((n) => n + 1);
    }
    vorher.current = frische;
  }, [frische, zustand.ton]);
  return (
    <span className={`vp-kern-live is-${zustand.ton}`} data-testid="geraet-zustand">
      <i key={puls} className={puls > 0 ? 'is-puls' : undefined} aria-hidden="true" />
      {zustand.wort}
      {zustand.detail && <small> · {zustand.detail}</small>}
    </span>
  );
}
