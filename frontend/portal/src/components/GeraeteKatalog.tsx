import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type SiteComponentTemplate } from '../api';
import type { ComponentTemplate } from '../komponentenAssistent';
import {
  KATEGORIE_SYMBOL,
  katalogAnsicht,
  katalogChips,
  kategorieVon,
  wahlFuer,
  type KatalogChip,
  type KatalogEintrag,
  type KatalogFund,
  type KatalogWahl,
} from '../geraeteKatalog';
import { hervorheben, suchBegriffe } from '../picker/suche';
import { useIsPhone } from '../useIsPhone';
import { AufbauSymbol } from './AufbauTabelle';
import { EigeneVorlagenPanel } from './EigeneVorlagenPanel';
import { ErrorState, TextSkeleton } from './States';
import type { AufbauKategorie } from '../aufbauBaum';
import './GeraeteKatalog.css';

/**
 * Der GERÄTEKATALOG (Konzept „Aufbau und Gerätekatalog", Runde 2): „Gerät
 * hinzufügen" beginnt mit einer Suche nach Marke oder Modell, darunter die
 * Arten als Filter, und was die Box schon meldet, steht oben. Nur Darstellung -
 * was sichtbar ist, entscheidet `geraeteKatalog.ts`; was nach der Wahl
 * geschieht, entscheidet der Wirt (`onWahl`).
 */

function symbolFuer(e: KatalogEintrag, chip: KatalogChip): { kategorie: AufbauKategorie; icon: IconName } {
  switch (e.art) {
    case 'fund':
      return { kategorie: 'fund', icon: 'search' };
    case 'vorlage':
      return { kategorie: 'navy', icon: 'file-text' };
    case 'weg':
      return e.weg === 'ocpp'
        ? { kategorie: 'ev', icon: 'link' }
        : e.weg === 'bms'
          ? KATEGORIE_SYMBOL.batterie
          : KATEGORIE_SYMBOL.selbst;
    case 'modell':
      return KATEGORIE_SYMBOL[kategorieVon(e.template)];
    default:
      return chip === 'alle' || chip === 'zaehler' ? KATEGORIE_SYMBOL.wr : KATEGORIE_SYMBOL[chip];
  }
}

function Treffer({ text, begriffe }: { text: string; begriffe: string[] }) {
  return (
    <>
      {hervorheben(text, begriffe).map((t, i) =>
        t.treffer ? <mark key={i}>{t.text}</mark> : <span key={i}>{t.text}</span>,
      )}
    </>
  );
}

export function GeraeteKatalog({
  open,
  siteId,
  funde,
  onClose,
  onWahl,
}: {
  open: boolean;
  siteId: string;
  /** Was die Box meldet und noch niemand übernommen hat. */
  funde: KatalogFund[];
  onClose: () => void;
  onWahl: (wahl: KatalogWahl) => void;
}) {
  const isPhone = useIsPhone();
  const [templates, setTemplates] = useState<ComponentTemplate[] | null>(null);
  const [vorlagen, setVorlagen] = useState<SiteComponentTemplate[]>([]);
  const [fehler, setFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);
  const [q, setQ] = useState('');
  const [chip, setChip] = useState<KatalogChip>('alle');
  const [marke, setMarke] = useState<string | null>(null);
  const sucheRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let aktiv = true;
    setFehler(false);
    api.componentTemplates().then(
      (liste) => aktiv && setTemplates(liste),
      () => aktiv && setFehler(true),
    );
    // Eigene Vorlagen fail-soft: ohne sie fehlt genau ihre Gruppe, nie der Katalog.
    api.siteComponentTemplates(siteId).then(
      (liste) => aktiv && setVorlagen(liste ?? []),
      () => aktiv && setVorlagen([]),
    );
    return () => {
      aktiv = false;
    };
  }, [open, siteId, versuch]);

  // Jedes Öffnen beginnt vorn - und am Rechner im Suchfeld. Am Telefon nicht:
  // dort schöbe die Tastatur den Katalog sofort aus dem Bild.
  useEffect(() => {
    if (!open) return;
    setQ('');
    setChip('alle');
    setMarke(null);
    if (isPhone) return;
    const t = window.setTimeout(() => sucheRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [open, isPhone]);

  const chips = useMemo(() => katalogChips(templates ?? [], vorlagen), [templates, vorlagen]);
  const ansicht = useMemo(
    () => katalogAnsicht({ templates: templates ?? [], vorlagen, funde, q, chip, marke }),
    [templates, vorlagen, funde, q, chip, marke],
  );
  const begriffe = suchBegriffe(q);

  const waehle = (e: KatalogEintrag) => {
    if (e.art === 'marke') {
      setMarke(e.marke);
      return;
    }
    const wahl = wahlFuer(e, chip);
    if (wahl) onWahl(wahl);
  };

  return (
    <Modal open={open} onClose={onClose} title="Gerät hinzufügen">
      <div className="vp-kat">
        <div className="vp-kat-kopf">
          <label className="vp-kat-suche">
            <Icon name="search" size={17} aria-hidden="true" />
            <input
              ref={sucheRef}
              type="text"
              role="searchbox"
              aria-label="Katalog durchsuchen"
              placeholder="Marke oder Modell, z. B. Deye, 12K, go-e"
              value={q}
              autoComplete="off"
              onChange={(e) => {
                setQ(e.target.value);
                setMarke(null);
              }}
            />
            {q && (
              <button type="button" className="vp-kat-leeren" aria-label="Suche leeren" onClick={() => setQ('')}>
                <Icon name="x" size={15} />
              </button>
            )}
          </label>
          <div className="vp-kat-arten" role="group" aria-label="Art">
            {chips.map((c) => (
              <button
                key={c.id}
                type="button"
                className="vp-kat-art"
                aria-pressed={chip === c.id}
                onClick={() => {
                  setChip(c.id);
                  setMarke(null);
                }}
              >
                {c.label}
                {c.anzahl != null && <span className="n">{c.anzahl}</span>}
              </button>
            ))}
          </div>
        </div>

        {fehler && (
          <ErrorState message="Der Gerätekatalog konnte nicht geladen werden." onRetry={() => setVersuch((n) => n + 1)} />
        )}
        {!fehler && !templates && <TextSkeleton lines={5} />}

        {!fehler && templates && (
          <div className="vp-kat-inhalt" key={`${chip}:${marke ?? ''}`}>
            {ansicht.zurueck && (
              <button type="button" className="vp-kat-zurueck" onClick={() => setMarke(null)}>
                <Icon name="chevron-left" size={16} /> {ansicht.zurueck}
              </button>
            )}
            {ansicht.hinweis && (
              <p className="vp-kat-hinweis">
                <Icon name="info" size={15} />
                <span>{ansicht.hinweis}</span>
              </p>
            )}
            {ansicht.leer && (
              <p className="vp-kat-leer" role="status">
                {ansicht.leer}
              </p>
            )}
            {ansicht.gruppen.map((g) => (
              <section key={g.key} className="vp-kat-gruppe" aria-label={g.titel}>
                <h3>
                  <span>{g.titel}</span>
                  {g.rechts && <small>{g.rechts}</small>}
                </h3>
                <ul className="vp-kat-liste">
                  {g.eintraege.map((e) => {
                    const sym = symbolFuer(e, chip);
                    return (
                      <li key={e.key}>
                        <button type="button" className={`vp-kat-eintrag is-${e.art}`} onClick={() => waehle(e)}>
                          <AufbauSymbol kategorie={sym.kategorie} icon={sym.icon} />
                          <span className="vp-kat-text">
                            <b>
                              <Treffer text={e.titel} begriffe={begriffe} />
                            </b>
                            {e.zusatz && <small>{e.zusatz}</small>}
                          </span>
                          <span className="vp-kat-ende" aria-hidden="true">
                            {e.art === 'fund' && <span className="vp-kat-wort">Übernehmen</span>}
                            <Icon name="chevron-right" size={16} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {ansicht.zaehler && <p className="vp-kat-zaehler">{ansicht.zaehler}</p>}
            {ansicht.vorlagenVerwalten && (
              <EigeneVorlagenPanel siteId={siteId} onAnlegen={(vorlage) => onWahl({ art: 'vorlage', vorlage })} />
            )}
            {q.trim() && !ansicht.leer && (
              <p className="vp-kat-nicht">
                Nicht das Richtige?{' '}
                <button type="button" onClick={() => onWahl({ art: 'weg', weg: 'modbus' })}>
                  Modbus-Gerät selbst beschreiben
                </button>
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
