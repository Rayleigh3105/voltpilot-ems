import { useId, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { VpPicker } from './VpPicker';
import { RowMenu } from './RowMenu';
import { hervorheben, suchBegriffe } from '../picker/suche';
import {
  FILTER_LABEL,
  LEERER_FILTER,
  aktiveFilter,
  kurzfilter,
  mitFilter,
  type AufbauFilter,
  type AufbauZahlen,
  type FilterOption,
  type FilterSchluessel,
  type TabellenZeile,
} from '../aufbauTabelle';
import {
  WERT_WORT,
  komponentenText,
  type AufbauAnlage,
  type AufbauBox,
  type AufbauGeraet,
  type AufbauKategorie,
  type AufbauWurzel,
} from '../aufbauBaum';
import type { ComponentHealth, ComponentRole, PlantComponent } from '../komponenten';
import type { AdoptableSource } from '../rollen';
import { anlageRoute, hashForRoute } from '../nav';
import { mitStaffel, useStaffel } from '../staffel';

/**
 * Der Reiter „Aufbau" als TABELLE mit Gruppen (Konzept „Aufbau und
 * Gerätekatalog", Runde 2, K1–K6 = A). Nur Darstellung: was sichtbar ist,
 * entscheidet `aufbauTabelle.ts`; die Handlungen reicht `AufbauSection` herein.
 *
 * Ruhige Optik mit Absicht: einfarbige Symbole statt Verlaufs-Kacheln, dünne
 * Linien, Zahlen mit fester Breite. Farbe trägt nur Zustand und Handlung.
 * Am Telefon werden die Spalten zu zwei Zeilen (Container-Abfrage in `Aufbau.css`).
 */

const TON_PUNKT: Record<'ok' | 'warn' | 'off', string> = {
  ok: 'vp-health-ok',
  warn: 'vp-health-warn',
  off: 'vp-health-off',
};

const HEALTH_TON: Record<ComponentHealth, 'ok' | 'warn' | 'off'> = {
  ok: 'ok',
  stale: 'warn',
  never: 'off',
  unknown: 'off',
};

const HEALTH_WORT: Record<ComponentHealth, string | null> = {
  ok: null,
  stale: 'veraltet',
  never: 'noch keine Daten',
  unknown: 'unbekannt',
};

/** Was eine Komponente in der Anlage ist - die Spalte „Art" einer Unterzeile. */
const ROLLE_ART: Record<ComponentRole, string> = {
  storage: 'Speicher',
  pv: 'Erzeugung',
  grid: 'Netzanschluss',
  house: 'Hausverbrauch',
  consumer: 'Verbraucher',
};

/** Zustandswörter kommen aus verschiedenen Quellen („verbunden", „Liefert Daten") - in der Spalte einheitlich. */
const gross = (s: string) => (s ? s.charAt(0).toLocaleUpperCase('de-DE') + s.slice(1) : s);

type Ebene = CSSProperties & { '--ebene': number };
const ebene = (n: number): Ebene => ({ '--ebene': n });
/** Die Klasse der Ebene - an ihr hängen die Führungslinien (`Aufbau.css`). */
const ebeneKlasse = (n: number) => ` is-e${Math.min(n, 3)}`;

function Treffer({ text, begriffe }: { text: string; begriffe: string[] }) {
  return (
    <>
      {hervorheben(text, begriffe).map((t, i) =>
        t.treffer ? <mark key={i}>{t.text}</mark> : <span key={i}>{t.text}</span>,
      )}
    </>
  );
}

/** Das einfarbige Symbol einer Zeile - die Kategorie färbt nur das Zeichen. */
export function AufbauSymbol({ kategorie, icon }: { kategorie: AufbauKategorie | 'anlage'; icon: IconName }) {
  return (
    <span className={`vp-auf-sym is-${kategorie}`} aria-hidden="true">
      <Icon name={icon} size={15} />
    </span>
  );
}

function Auf({ offen, label, onClick }: { offen: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className="vp-auf-t-auf" aria-expanded={offen} aria-label={label} onClick={onClick}>
      <Icon name="chevron-down" size={15} />
    </button>
  );
}

export interface AufbauTabelleProps {
  wurzel: AufbauWurzel | null;
  anlagenZahl: number;
  boxZahl: number;
  zeilen: TabellenZeile[];
  filter: AufbauFilter;
  optionen: Record<FilterSchluessel, FilterOption[]>;
  zahlen: AufbauZahlen;
  onFilter: (f: AufbauFilter) => void;
  onAnlageUmschalten: (a: AufbauAnlage) => void;
  onBoxUmschalten: (b: AufbauBox) => void;
  onGeraetUmschalten: (id: string) => void;
  onKurzblick: (id: string) => void;
  onUebernehmen: (q: AdoptableSource) => void;
  onTechnischUebernehmen: ((q: AdoptableSource) => void) | null;
  /** Gerät hinzufügen (an einer Box oder allgemein); null = hier nicht möglich. */
  onGeraetHinzufuegen: ((box: AufbauBox | null) => void) | null;
  /** Warum „Gerät hinzufügen" gesperrt ist - nie ein stummer grauer Knopf. */
  geraetGesperrt: string | null;
  onBoxHinzufuegen: () => void;
  onAnlageHinzufuegen: () => void;
  onBoxVerwalten: (b: AufbauBox) => void;
  /** Eine Ausnahme an einer Komponente („ohne Ladestand") - sie steht in der Zeile. */
  hinweisFor: (g: AufbauGeraet) => string | null;
  /** Nur für VoltPilot: der technische Einstieg neben „Gerät hinzufügen". */
  technik?: ReactNode;
}

export function AufbauTabelle(p: AufbauTabelleProps) {
  const staffel = useStaffel('aufbau-tabelle');
  const begriffe = suchBegriffe(p.filter.q);
  const aktive = aktiveFilter(p.filter, p.optionen);
  const n = p.zahlen;
  // Am Telefon stehen die vier Filter hinter EINEM Knopf im Suchfeld - über der
  // Tabelle bleibt nur, was man zum Finden braucht. Am breiten Fenster stehen
  // sie immer da; der Knopf ist dort ausgeblendet (`Aufbau.css`).
  const [filterOffen, setFilterOffen] = useState(false);
  const filterId = useId();
  return (
    <>
      <Ort wurzel={p.wurzel} anlagenZahl={p.anlagenZahl} boxZahl={p.boxZahl} />

      <div className={`vp-auf-werkzeug${filterOffen ? ' is-filter-offen' : ''}`}>
        <label className="vp-auf-suche">
          <Icon name="search" size={16} aria-hidden="true" />
          <input
            type="text"
            role="searchbox"
            aria-label="Geräte suchen"
            placeholder="Name, Modell, Kennung …"
            value={p.filter.q}
            autoComplete="off"
            onChange={(e) => p.onFilter({ ...p.filter, q: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && p.filter.q) {
                e.stopPropagation();
                p.onFilter({ ...p.filter, q: '' });
              }
            }}
          />
          {p.filter.q && (
            <button
              type="button"
              className="vp-auf-suche-leeren"
              aria-label="Suche leeren"
              onClick={() => p.onFilter({ ...p.filter, q: '' })}
            >
              <Icon name="x" size={15} />
            </button>
          )}
          <button
            type="button"
            className={`vp-auf-filter-auf${aktive.length > 0 ? ' is-aktiv' : ''}`}
            aria-expanded={filterOffen}
            aria-controls={filterId}
            aria-label={aktive.length > 0 ? `Filter, ${aktive.length} aktiv` : 'Filter'}
            onClick={() => setFilterOffen((offen) => !offen)}
          >
            <Icon name="sliders" size={16} />
            {aktive.length > 0 && <span aria-hidden="true">{aktive.length}</span>}
          </button>
        </label>
        <div className="vp-auf-filter" id={filterId} role="group" aria-label="Filter">
          {(Object.keys(FILTER_LABEL) as FilterSchluessel[]).map((k) => (
            <VpPicker
              key={k}
              className="vp-auf-filterfeld"
              triggerClassName="vp-auf-filterknopf"
              ariaLabel={`Nach ${FILTER_LABEL[k]} filtern`}
              placeholder={FILTER_LABEL[k]}
              zaehler
              options={p.optionen[k].map((o) => ({
                value: o.wert,
                label: o.label,
                sub: `${o.anzahl} ${o.anzahl === 1 ? 'Eintrag' : 'Einträge'}`,
              }))}
              values={p.filter[k]}
              onChangeMany={(werte) => p.onFilter(mitFilter(p.filter, k, werte))}
            />
          ))}
        </div>
      </div>
      <div className="vp-auf-leiste">
        <div className="vp-auf-zahlen" aria-live="polite">
          {n.aktiv ? (
            <span>
              <b>{n.treffer}</b> von {n.geraete} {n.geraete === 1 ? 'Gerät' : 'Geräten'}
            </span>
          ) : (
            <span>
              <b>{n.geraete}</b> {n.geraete === 1 ? 'Gerät' : 'Geräte'}
              <span className="vp-auf-breit"> an dieser Anlage</span>
            </span>
          )}
          {n.achtung > 0 && (
            <button type="button" className="vp-auf-kurz is-warn" onClick={() => p.onFilter(kurzfilter('achtung'))}>
              <Icon name="alert-triangle" size={14} />
              {n.achtung}
              <span className="vp-auf-schmal-sr"> {n.achtung === 1 ? 'braucht' : 'brauchen'} Aufmerksamkeit</span>
            </button>
          )}
          {n.gemeldet > 0 && (
            <button type="button" className="vp-auf-kurz" onClick={() => p.onFilter(kurzfilter('gemeldet'))}>
              <Icon name="search" size={14} />
              {n.gemeldet}
              <span className="vp-auf-schmal-sr"> von der Box gemeldet</span>
            </button>
          )}
        </div>
        <div className="vp-auf-neu">
          <button
            type="button"
            className="vp-btn vp-btn--primary vp-btn--sm vp-auf-neu-haupt"
            onClick={() => p.onGeraetHinzufuegen?.(null)}
            disabled={!p.onGeraetHinzufuegen}
            title={p.onGeraetHinzufuegen ? undefined : p.geraetGesperrt ?? undefined}
          >
            <Icon name="plus" size={16} />
            <span className="vp-auf-neu-lang">Gerät hinzufügen</span>
            <span className="vp-auf-neu-kurz" aria-hidden="true">
              Gerät
            </span>
          </button>
          <RowMenu
            label="Box oder Anlage hinzufügen"
            icon="chevron-down"
            buttonClassName="vp-btn vp-btn--primary vp-btn--sm vp-auf-neu-mehr"
            items={[
              { label: 'VoltPilot-Box hinzufügen', icon: 'wifi', onClick: p.onBoxHinzufuegen },
              { label: 'Anlage hinzufügen', icon: 'layers', onClick: p.onAnlageHinzufuegen },
            ]}
          />
        </div>
        {p.technik}
      </div>

      {aktive.length > 0 && (
        <div className="vp-auf-aktiv">
          {aktive.map((a) => (
            <span key={`${a.schluessel}:${a.wert}`} className="vp-auf-aktiv-chip">
              {a.label}
              <button
                type="button"
                aria-label={`${a.label} entfernen`}
                onClick={() =>
                  p.onFilter(mitFilter(p.filter, a.schluessel, p.filter[a.schluessel].filter((w) => w !== a.wert)))
                }
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          <button type="button" className="vp-auf-linkbtn" onClick={() => p.onFilter(LEERER_FILTER)}>
            Alle zurücksetzen
          </button>
        </div>
      )}

      <div className="vp-auf-t" role="table" aria-label="Aufbau: Anlagen, Boxen und Geräte">
        <div className="vp-auf-t-kopf" role="row">
          <span role="columnheader">Gerät</span>
          <span role="columnheader">Art</span>
          <span role="columnheader">Zustand</span>
          <span role="columnheader" className="is-rechts">
            Wert
          </span>
          <span role="columnheader" aria-label="Aktion" />
        </div>
        <div className={mitStaffel('vp-auf-t-rumpf', staffel)} role="rowgroup">
          {p.zeilen.map((z) => (
            <Zeile key={`${z.typ}:${z.key}`} z={z} begriffe={begriffe} p={p} />
          ))}
          {p.zeilen.length === 0 && (
            <div className="vp-auf-t-nichts" role="row">
              <span role="cell">
                <Icon name="search" size={18} />
                {p.filter.q.trim()
                  ? `Kein Gerät passt zu „${p.filter.q.trim()}"${aktive.length > 0 ? ' mit diesen Filtern' : ''}.`
                  : 'Kein Gerät passt zu diesen Filtern.'}
                <button type="button" className="vp-auf-linkbtn" onClick={() => p.onFilter(LEERER_FILTER)}>
                  Suche und Filter zurücksetzen
                </button>
              </span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Ort({ wurzel, anlagenZahl, boxZahl }: { wurzel: AufbauWurzel | null; anlagenZahl: number; boxZahl: number }) {
  return (
    <p className="vp-auf-ort" aria-label={wurzel ? `Standort ${wurzel.name}` : 'Standort'}>
      <span>
        <Icon name="map-pin" size={15} />
        {wurzel ? (
          <>
            Standort <b>{wurzel.name}</b>
            {wurzel.kurzzeichen && <span className="vp-auf-mono">{wurzel.kurzzeichen}</span>}
            {wurzel.entwurf && <span className="vp-auf-tag">Entwurf</span>}
          </>
        ) : (
          <>Ihre Anlage</>
        )}
      </span>
      {wurzel?.art === 'standort' && <span>{wurzel.adresse ?? 'Adresse noch nicht hinterlegt'}</span>}
      <span>
        {anlagenZahl} {anlagenZahl === 1 ? 'Anlage' : 'Anlagen'} · {boxZahl} {boxZahl === 1 ? 'Box' : 'Boxen'}
      </span>
    </p>
  );
}

function Zeile({ z, begriffe, p }: { z: TabellenZeile; begriffe: string[]; p: AufbauTabelleProps }) {
  switch (z.typ) {
    case 'anlage':
      return <AnlageZeile z={z} p={p} />;
    case 'box':
      return <BoxZeile z={z} begriffe={begriffe} p={p} />;
    case 'geraet':
      return <GeraetZeile z={z} begriffe={begriffe} p={p} />;
    case 'teil':
      return <TeilZeile z={z} begriffe={begriffe} />;
    case 'fund':
      return <FundZeile z={z} begriffe={begriffe} p={p} />;
    default:
      return (
        <div className={`vp-auf-t-zeile is-leer${ebeneKlasse(z.ebene)}`} role="row" style={ebene(z.ebene)}>
          <span role="cell" className="vp-auf-t-name">
            {z.boxHinzufuegen ? (
              <button type="button" className="vp-auf-t-leer is-aktion" onClick={p.onBoxHinzufuegen}>
                <Icon name="plus" size={15} /> Noch keine VoltPilot-Box – jetzt hinzufügen
              </button>
            ) : (
              <span className="vp-auf-t-leer">{z.text}</span>
            )}
          </span>
        </div>
      );
  }
}

function AnlageZeile({ z, p }: { z: Extract<TabellenZeile, { typ: 'anlage' }>; p: AufbauTabelleProps }) {
  const a = z.anlage;
  return (
    <div
      className={`vp-auf-t-zeile is-anlage${a.aktuell ? ' is-aktuell' : ' hat-wechsel'}`}
      role="row"
      style={ebene(0)}
    >
      <span role="cell" className="vp-auf-t-name">
        <button
          type="button"
          className="vp-auf-t-gruppe"
          aria-expanded={z.offen}
          onClick={() => p.onAnlageUmschalten(a)}
        >
          <span className="vp-auf-t-auf" aria-hidden="true">
            <Icon name="chevron-down" size={15} />
          </span>
          <AufbauSymbol kategorie="anlage" icon="layers" />
          <span className="vp-auf-t-text">
            <b className="vp-auf-t-titel">
              <span className="vp-auf-t-kuerze">Anlage {a.name}</span>
              {a.aktuell && <span className="vp-auf-tag is-hier">Sie sind hier</span>}
            </b>
            <small>
              {a.boxen.length} {a.boxen.length === 1 ? 'Box' : 'Boxen'}
              {a.geraeteZahl != null && ` · ${a.geraeteZahl} ${a.geraeteZahl === 1 ? 'Gerät' : 'Geräte'}`}
              {!a.aktuell && ' · nur lesend'}
              {a.wertStand === 'veraltet' && <span className="is-warn"> · keine aktuellen Werte</span>}
            </small>
          </span>
        </button>
      </span>
      <span role="cell" className="vp-auf-t-summe">
        {a.werte.map((w) => (
          <span key={`${w.art}:${w.text}`}>
            {WERT_WORT[w.art]} <b>{w.text}</b>
          </span>
        ))}
      </span>
      <span role="cell" className="vp-auf-t-aktion">
        {!a.aktuell && (
          <a
            className="vp-auf-t-wechsel"
            href={hashForRoute(anlageRoute(a.id, 'modell'))}
            aria-label={`Zu Anlage ${a.name} wechseln`}
          >
            Wechseln <Icon name="chevron-right" size={14} />
          </a>
        )}
      </span>
    </div>
  );
}

function BoxZeile({
  z,
  begriffe,
  p,
}: {
  z: Extract<TabellenZeile, { typ: 'box' }>;
  begriffe: string[];
  p: AufbauTabelleProps;
}) {
  const b = z.box;
  const aktuell = z.anlage.aktuell;
  return (
    <div className={`vp-auf-t-zeile is-box${ebeneKlasse(1)}`} role="row" style={ebene(1)}>
      <span role="cell" className="vp-auf-t-name">
        <Auf offen={z.offen} label={`${b.name} ${z.offen ? 'zuklappen' : 'aufklappen'}`} onClick={() => p.onBoxUmschalten(b)} />
        <AufbauSymbol kategorie="navy" icon="wifi" />
        <span className="vp-auf-t-text">
          <span className="vp-auf-t-titel">
            <span className={`vp-health-dot vp-auf-nur-mobil ${TON_PUNKT[b.ton]}`} />
            <a className="vp-auf-t-kuerze" href={b.href}>
              <Treffer text={b.name} begriffe={begriffe} />
            </a>
            {b.fuehrend && <span className="vp-auf-tag is-fuehrend">führend</span>}
          </span>
          <small>
            <span className="vp-auf-mono">
              <Treffer text={b.ref} begriffe={begriffe} />
            </span>
            {' · '}
            {b.geraete.filter((g) => g.art !== 'neu').length}{' '}
            {b.geraete.filter((g) => g.art !== 'neu').length === 1 ? 'Gerät' : 'Geräte'}
          </small>
        </span>
      </span>
      <span role="cell" className="vp-auf-t-art">
        VoltPilot-Box
      </span>
      <span role="cell" className="vp-auf-t-zustand">
        <span className={`vp-health-dot ${TON_PUNKT[b.ton]}`} />
        <span className="w">{gross(b.zustandWort)}</span>
        {b.zustandZeit && <small>{b.zustandZeit}</small>}
      </span>
      <span role="cell" className="vp-auf-t-aktion is-breit">
        {aktuell && p.onGeraetHinzufuegen && (
          <button
            type="button"
            className="vp-auf-t-plus"
            onClick={() => p.onGeraetHinzufuegen?.(b)}
            aria-label={`Gerät an ${b.name} hinzufügen`}
          >
            <Icon name="plus" size={15} />
            <span className="lbl" aria-hidden="true">
              Gerät
            </span>
          </button>
        )}
        {aktuell && (
          <button
            type="button"
            className="vp-auf-t-mehr"
            onClick={() => p.onBoxVerwalten(b)}
            aria-label={`${b.name} verwalten`}
            aria-haspopup="dialog"
          >
            <Icon name="more-horizontal" size={16} />
          </button>
        )}
      </span>
    </div>
  );
}

function GeraetZeile({
  z,
  begriffe,
  p,
}: {
  z: Extract<TabellenZeile, { typ: 'geraet' }>;
  begriffe: string[];
  p: AufbauTabelleProps;
}) {
  const g = z.geraet;
  const nurLesend = !z.anlage.aktuell;
  const hinweis = nurLesend ? null : p.hinweisFor(g);
  const wert = g.werte[0] ?? null;
  // Die ganze Zeile ist ein Ziel für die Maus; Tastatur und Vorlesesoftware
  // nehmen den Namen-Knopf - eine Zeile, die selbst ein Knopf wäre, dürfte
  // keinen Aufklapp-Knopf enthalten.
  const zeilenKlick = (e: MouseEvent<HTMLDivElement>) => {
    if (nurLesend) return;
    if ((e.target as HTMLElement).closest('button, a, input')) return;
    p.onKurzblick(g.id);
  };
  const titel = <Treffer text={g.titel} begriffe={begriffe} />;
  return (
    <div
      className={`vp-auf-t-zeile is-geraet is-${g.ton}${nurLesend ? ' is-lesend' : ''}${ebeneKlasse(z.ebene)}`}
      role="row"
      style={ebene(z.ebene)}
      data-aufbau-geraet={g.id}
      onClick={zeilenKlick}
    >
      <span role="cell" className="vp-auf-t-name">
        {z.teilbar ? (
          <Auf
            offen={z.offen}
            label={`Messwerte von ${g.titel} ${z.offen ? 'zuklappen' : 'aufklappen'}`}
            onClick={() => p.onGeraetUmschalten(g.id)}
          />
        ) : (
          <span className="vp-auf-t-auf-platz" />
        )}
        <AufbauSymbol kategorie={g.kategorie} icon={g.icon} />
        <span className="vp-auf-t-text">
          {nurLesend ? (
            g.karte.href ? (
              <a className="vp-auf-t-titel" href={g.karte.href}>
                <span className="vp-auf-t-kuerze">{titel}</span>
              </a>
            ) : (
              <span className="vp-auf-t-titel">
                <span className="vp-auf-t-kuerze">{titel}</span>
              </span>
            )
          ) : (
            <button
              type="button"
              className="vp-auf-t-titel"
              aria-haspopup="dialog"
              onClick={() => p.onKurzblick(g.id)}
            >
              <span className="vp-auf-t-kuerze">{titel}</span>
            </button>
          )}
          <small>
            <span className="vp-auf-t-kuerze">
              <Treffer text={g.unterzeile} begriffe={begriffe} />
            </span>
            {hinweis && <span className="is-warn">{hinweis}</span>}
          </small>
        </span>
      </span>
      <span role="cell" className="vp-auf-t-art" title={g.artWort}>
        <Treffer text={g.artWort} begriffe={begriffe} />
      </span>
      <span role="cell" className="vp-auf-t-zustand">
        <span className={`vp-health-dot ${TON_PUNKT[g.ton]}`} />
        <span className="w">{gross(g.zustandWort)}</span>
        {g.zustandZeit && <small>{g.zustandZeit}</small>}
      </span>
      <span role="cell" className="vp-auf-t-wert">
        {wert ? (
          <span title={wert.label}>{wert.text}</span>
        ) : (
          <span className="is-leer" aria-label="kein Messwert">
            –
          </span>
        )}
      </span>
      <span role="cell" className="vp-auf-t-pfeil" aria-hidden="true">
        {!nurLesend && <Icon name="chevron-right" size={16} />}
      </span>
    </div>
  );
}

function TeilZeile({ z, begriffe }: { z: Extract<TabellenZeile, { typ: 'teil' }>; begriffe: string[] }) {
  const c: PlantComponent = z.komponente;
  const text = komponentenText(c);
  const wort = HEALTH_WORT[c.health];
  return (
    <div className={`vp-auf-t-zeile is-teil${ebeneKlasse(z.ebene)}`} role="row" style={ebene(z.ebene)} data-komponente-zeile={c.id}>
      <span role="cell" className="vp-auf-t-name">
        <span className="vp-auf-t-auf-platz" />
        <span className="vp-auf-t-text">
          <span className="vp-auf-t-titel is-ruhig">
            <span className="vp-auf-t-kuerze">
              <Treffer text={c.label} begriffe={begriffe} />
            </span>
          </span>
        </span>
      </span>
      <span role="cell" className="vp-auf-t-art">
        {ROLLE_ART[c.role]}
      </span>
      <span role="cell" className="vp-auf-t-zustand">
        {wort && (
          <>
            <span className={`vp-health-dot ${TON_PUNKT[HEALTH_TON[c.health]]}`} />
            <span className="w">{gross(wort)}</span>
          </>
        )}
      </span>
      <span role="cell" className="vp-auf-t-wert">
        {text ?? (
          <span className="is-leer" aria-label="kein Messwert">
            –
          </span>
        )}
      </span>
      <span role="cell" />
    </div>
  );
}

function FundZeile({
  z,
  begriffe,
  p,
}: {
  z: Extract<TabellenZeile, { typ: 'fund' }>;
  begriffe: string[];
  p: AufbauTabelleProps;
}) {
  const g = z.geraet;
  const quelle = g.karte.quelle;
  const nurLesend = !z.anlage.aktuell;
  return (
    <div className={`vp-auf-t-zeile is-fund${ebeneKlasse(z.ebene)}`} role="row" style={ebene(z.ebene)} data-aufbau-geraet={g.id}>
      <span role="cell" className="vp-auf-t-name">
        <span className="vp-auf-t-auf-platz" />
        <AufbauSymbol kategorie="fund" icon="search" />
        <span className="vp-auf-t-text">
          <b className="vp-auf-t-titel">
            <span className="vp-auf-t-kuerze">
              <Treffer text={g.titel} begriffe={begriffe} />
            </span>
          </b>
          <small>
            <span className="vp-auf-t-kuerze">
              <Treffer text={g.unterzeile} begriffe={begriffe} />
            </span>
            <span>noch nicht übernommen</span>
          </small>
        </span>
      </span>
      <span role="cell" className="vp-auf-t-art">
        {g.artWort}
      </span>
      <span role="cell" className="vp-auf-t-zustand">
        <span className="vp-health-dot vp-health-off" />
        <span className="w">Nicht übernommen</span>
      </span>
      <span role="cell" className="vp-auf-t-aktion is-breit">
        {!nurLesend && quelle && (
          <>
            <button type="button" className="vp-btn vp-btn--outline vp-btn--sm" onClick={() => p.onUebernehmen(quelle)}>
              Übernehmen
            </button>
            {/* Die TECHNISCHE Übernahme steht NEBEN der geführten - Typ,
                Nennleistung und MaStR von Hand (nur VoltPilot). */}
            {p.onTechnischUebernehmen && (
              <button type="button" className="vp-auf-technik-add" onClick={() => p.onTechnischUebernehmen?.(quelle)}>
                technisch
              </button>
            )}
          </>
        )}
      </span>
    </div>
  );
}
