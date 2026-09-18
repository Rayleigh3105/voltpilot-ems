import type { ReactNode } from 'react';
import { useIsPhone } from '../useIsPhone';
import { fmtNum } from '../format';
import type { AnlagenZeile, Dichte, SpaltenId } from '../portfolioCockpit';
import { SPALTEN_KOPF, signiertesGeld } from '../portfolioCockpit';
import { VORSCHAU_ABSPRUNG, type VorschauZeile } from '../portfolioVorschau';
import { Icon } from '../../designsystem/components/core/Icon';
import './AnlagenTabelle.css';
import { useStaffel } from '../staffel';
import { UEMS_ENERGIEBILANZ } from '../glossar';
import { Recht } from './Recht';

/**
 * DIE ANLAGEN-TABELLE — EINE Fläche in zwei Dichten (Scout
 * `vp-portfolio-konzept-r2` §5.2, Captain-Entscheid E1 „A · Tabelle mit
 * Vorschau-Zeile").
 *
 * Sie löst das frühere Nebeneinander von Betreiber-TABELLE und Endkunden-KARTEN
 * ab: es ist dieselbe Zeilen-Grammatik, `dichte` entscheidet nur über
 * Zeilenhöhe und Unterzeile. Am Telefon wird jede Zeile eine Karte — nicht als
 * zweite Fassung, sondern weil acht Spalten dort nie nebeneinander stehen
 * können; die Daten sind dieselben.
 *
 * **Render-only.** Jede Zahl, jedes Wort, jede Auslassung und die Sortierung
 * entstehen in `portfolioCockpit.anlagenZeilen`/`tabellenSpalten`, die
 * Vorschau in `portfolioVorschau.vorschauZeilen`.
 */
export interface AnlagenTabelleProps {
  zeilen: AnlagenZeile[];
  /** Die OPTIONALEN Spalten in Lese-Reihenfolge (Pflicht-Spalten stehen immer). */
  spalten: SpaltenId[];
  dichte: Dichte;
  /** Die aufgeklappte Anlage; null = keine. */
  offen: string | null;
  onToggle: (siteId: string) => void;
  onOeffnen: (siteId: string) => void;
  /** Die Vorschau der aufgeklappten Zeile; null = lädt noch. */
  vorschau: VorschauZeile[] | null;
  /**
   * UEMS AP-01 IP-6: die Zeilen nach Standorten gruppiert, je Gruppe ein Kopf
   * (die Standort-Karte). Fehlt es, rendert die Tabelle ungruppiert wie bisher.
   * Die Spalten gelten für ALLE Gruppen — eine Tabelle, damit sie untereinander
   * fluchten.
   */
  gruppen?: AnlagenGruppe[] | null;
  /**
   * UEMS AP-13 IP-8 („Standort › Anlagen“, Ü7): die Anlagen mit Hauptzähler in der Stellung — sie tragen den Weg
   * „Energiebilanz“. Fehlt es, rendert die Tabelle wie bisher (die Übersicht bleibt zeichengleich).
   */
  energiebilanz?: ReadonlySet<string> | null;
  onEnergiebilanz?: (siteId: string) => void;
  /** Nur „Standort › Anlagen“: geführter Einstieg in den bestehenden Zuordnungsdialog. */
  onZuordnungKorrigieren?: (siteId: string) => void;
  /** AP-02 IP-10: nur die offenen Bestandsanlagen tragen den zusätzlichen Chip. */
  nichtZugeordnet?: ReadonlySet<string>;
}

/** Eine Gruppe der Tabelle: ihr Kopf, ihre Zeilen, und der Satz, wenn sie keine hat. */
export interface AnlagenGruppe {
  key: string;
  kopf: ReactNode;
  zeilen: AnlagenZeile[];
  leer: string | null;
}

export function AnlagenTabelle(props: AnlagenTabelleProps) {
  const phone = useIsPhone();
  if (props.zeilen.length === 0 && !props.gruppen?.length) return null;
  return phone ? <Karten {...props} /> : <Tabelle {...props} />;
}

// ---------------------------------------------------------------------------
// Die Zellen — je Spalte GENAU EINE Darstellung, von Tabelle und Karte geteilt
// ---------------------------------------------------------------------------

/** „—" ist die Auslassung; sie steht nie für eine gemessene 0. */
function Strich() {
  return <span className="dim">—</span>;
}

function Zahl({ wert, einheit, digits = 1 }: { wert: number | null; einheit: string; digits?: number }) {
  if (wert == null) return <Strich />;
  return (
    <>
      {fmtNum(wert, '', digits)} <span className="u">{einheit}</span>
    </>
  );
}

function NetzZelle({ z }: { z: AnlagenZeile }) {
  if (!z.netz) return <Strich />;
  if (z.netz.richtung === 'ausgeglichen') return <span className="dim">ausgeglichen</span>;
  return (
    <>
      {z.netz.richtung === 'bezug' ? '↓' : '↑'} {fmtNum(z.netz.kw, '', 1)}{' '}
      <span className="u">kW</span>
    </>
  );
}

function SpeicherZelle({ z }: { z: AnlagenZeile }) {
  if (z.ladestandPct == null) return <Strich />;
  return (
    <>
      <span className="vp-at-bar" aria-hidden="true">
        <i style={{ width: `${Math.max(0, Math.min(100, z.ladestandPct))}%` }} />
      </span>
      {fmtNum(z.ladestandPct, '', 0)} <span className="u">%</span>
      {z.ladestandWort && <span className="u"> · {z.ladestandWort}</span>}
    </>
  );
}

function GeldZelle({ wert }: { wert: number | null }) {
  if (wert == null) return <Strich />;
  return (
    <>
      {signiertesGeld(wert)} <span className="u">€</span>
    </>
  );
}

function zelleFuer(s: SpaltenId, z: AnlagenZeile) {
  switch (s) {
    case 'pv-jetzt':
      return <Zahl wert={z.pvJetztKw} einheit="kW" />;
    case 'erzeugung-heute':
      return <Zahl wert={z.erzeugungKwh} einheit="kWh" digits={0} />;
    case 'verbrauch-heute':
      return <Zahl wert={z.verbrauchKwh} einheit="kWh" digits={0} />;
    case 'speicher':
      return <SpeicherZelle z={z} />;
    case 'netz-heute':
      return <NetzZelle z={z} />;
    case 'erloese':
      return <GeldZelle wert={z.heuteEur} />;
    default:
      return <Strich />;
  }
}

function Zustand({ z }: { z: AnlagenZeile }) {
  return (
    <>
      <span className="vp-at-state">
        <span className={`vp-at-dot is-${z.zustand.ton}`} aria-hidden="true" />
        {z.zustand.wort}
      </span>
      {z.zustand.alter && <span className="vp-at-alter">{z.zustand.alter}</span>}
    </>
  );
}

function Warnzeile({ z }: { z: AnlagenZeile }) {
  if (!z.speicherOhneGeraet) return null;
  return (
    <span className="vp-at-warnzeile">
      <Icon name="alert-triangle" size={12} />
      Speicher ohne Gerät
    </span>
  );
}

// ---------------------------------------------------------------------------
// Die Vorschau — EINE Ableitung, zwei Wirte (Tabellen-Zeile + Karte)
// ---------------------------------------------------------------------------

function VorschauBlock({
  zeilen,
  onOeffnen,
}: {
  zeilen: VorschauZeile[] | null;
  onOeffnen: () => void;
}) {
  if (zeilen == null) return <p className="vp-at-lade">Wird geladen …</p>;
  return (
    <div className="vp-at-vor">
      {zeilen.map((v) => (
        <div key={v.key}>
          <span className="vp-at-vor-l">{v.label}</span>
          <div className={`vp-at-vor-v${v.ton === 'warn' ? ' is-warn' : ''}`}>
            {v.text}
            {v.tag && <span className="vp-at-tag">{v.tag}</span>}
          </div>
        </div>
      ))}
      <button type="button" className="vp-at-open" onClick={onOeffnen}>
        {VORSCHAU_ABSPRUNG} <Icon name="chevron-right" size={14} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop
// ---------------------------------------------------------------------------

function Tabelle({ zeilen, spalten, dichte, offen, onToggle, onOeffnen, vorschau, gruppen, energiebilanz, onEnergiebilanz, onZuordnungKorrigieren, nichtZugeordnet }: AnlagenTabelleProps) {
  // Bewegung P6: die Zeilen staffeln beim ERSTEN Blick auf das Portfolio, nie
  // beim zweiten (`src/staffel.ts`). Beide Formen teilen den Schlüssel — es
  // ist dieselbe Liste, nur einmal als Tabelle und einmal als Karten.
  const staffel = useStaffel('portfolio-anlagen');
  const breite = spalten.length + 2;
  const reihe = (z: AnlagenZeile) => {
    const auf = offen === z.id;
    return [
      <tr
        key={z.id}
        className={`vp-at-zeile${auf ? ' is-offen' : ''}`}
        onClick={() => onOeffnen(z.id)}
      >
        <td>
          <div className="vp-at-name-cell">
            <button
              type="button"
              className="vp-at-name"
              aria-label={`Anlage ${z.name} öffnen`}
              onClick={(e) => {
                e.stopPropagation();
                onOeffnen(z.id);
              }}
            >
              <span className="vp-at-name-text">
                <b>{z.name}</b>
                {nichtZugeordnet?.has(z.id) && <span className="vp-at-unzugeordnet">noch nicht zugeordnet</span>}
                {z.unterzeile && <span className="vp-at-sub">{z.unterzeile}</span>}
                <Warnzeile z={z} />
              </span>
            </button>
            {onEnergiebilanz && energiebilanz?.has(z.id) && (
              <button
                type="button"
                className="vp-at-weg"
                onClick={(e) => {
                  e.stopPropagation();
                  onEnergiebilanz(z.id);
                }}
              >
                {UEMS_ENERGIEBILANZ}
              </button>
            )}
            {onZuordnungKorrigieren && (
              <Recht aktion="anlage.zuordnen"><button
                type="button"
                className="vp-at-weg"
                onClick={(e) => {
                  e.stopPropagation();
                  onZuordnungKorrigieren(z.id);
                }}
              >
                Zuordnung korrigieren
              </button></Recht>
            )}
            <button
              type="button"
              className="vp-at-details"
              aria-expanded={auf}
              aria-controls={`anlage-vorschau-${z.id}`}
              aria-label={`Details zu ${z.name} ${auf ? 'ausblenden' : 'anzeigen'}`}
              title={`Details ${auf ? 'ausblenden' : 'anzeigen'}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(z.id);
              }}
            >
              <span className="vp-at-chev" aria-hidden="true">
                <Icon name="chevron-right" size={16} />
              </span>
            </button>
          </div>
        </td>
        {spalten.map((s) => (
          <td key={s} className="num">
            {zelleFuer(s, z)}
          </td>
        ))}
        <td>
          <Zustand z={z} />
        </td>
      </tr>,
      auf ? (
        <tr
          key={`${z.id}-vor`}
          id={`anlage-vorschau-${z.id}`}
          className="vp-at-vorschau"
        >
          <td colSpan={spalten.length + 2}>
            <VorschauBlock zeilen={vorschau} onOeffnen={() => onOeffnen(z.id)} />
          </td>
        </tr>
      ) : null,
    ];
  };
  return (
    <div className="vp-at-wrap">
      <table className="vp-at" data-dichte={dichte}>
        <thead>
          <tr>
            <th scope="col">Anlage</th>
            {spalten.map((s) => (
              <th key={s} scope="col" className="num">
                {SPALTEN_KOPF[s].titel}
                {SPALTEN_KOPF[s].einheit && (
                  <span className="vp-at-einheit">{SPALTEN_KOPF[s].einheit}</span>
                )}
              </th>
            ))}
            <th scope="col">Zustand</th>
          </tr>
        </thead>
        {gruppen ? (
          gruppen.map((g) => (
            <tbody key={g.key} className={staffel}>
              <tr className="vp-at-gruppe">
                <th scope="rowgroup" colSpan={breite}>
                  {g.kopf}
                </th>
              </tr>
              {g.zeilen.length === 0 && g.leer && (
                <tr className="vp-at-leer">
                  <td colSpan={breite}>{g.leer}</td>
                </tr>
              )}
              {g.zeilen.map(reihe)}
            </tbody>
          ))
        ) : (
          <tbody className={staffel}>{zeilen.map(reihe)}</tbody>
        )}
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Telefon: EINE Karte je Zeile
// ---------------------------------------------------------------------------

/**
 * Am Telefon führen die DREI Jetzt-Werte (PV · Speicher · Netz) — sie
 * beantworten „was macht die Anlage gerade"; die Tages-Summen stehen in der
 * Vorschau bzw. auf der Anlagen-Seite. Eine Kachel ohne Wert erscheint gar
 * nicht.
 */
function Karten({ zeilen, spalten, offen, onToggle, onOeffnen, vorschau, gruppen, energiebilanz, onEnergiebilanz, onZuordnungKorrigieren, nichtZugeordnet }: AnlagenTabelleProps) {
  const zeigt = new Set(spalten);
  const staffel = useStaffel('portfolio-anlagen');
  const liste = staffel ? `vp-at-karten ${staffel}` : 'vp-at-karten';
  const karte = (z: AnlagenZeile) => {
    const auf = offen === z.id;
    const nums: { id: SpaltenId; label: string }[] = [];
    if (zeigt.has('pv-jetzt') && z.pvJetztKw != null) nums.push({ id: 'pv-jetzt', label: 'PV jetzt' });
    if (zeigt.has('speicher') && z.ladestandPct != null) nums.push({ id: 'speicher', label: 'Speicher' });
    if (zeigt.has('netz-heute') && z.netz) nums.push({ id: 'netz-heute', label: 'Netz jetzt' });
    const oeffnen = (
      <button
        type="button"
        className="vp-at-open"
        onClick={(e) => {
          e.stopPropagation();
          onOeffnen(z.id);
        }}
      >
        Öffnen <Icon name="chevron-right" size={14} />
      </button>
    );
    return (
      <article key={z.id} className="vp-at-karte" onClick={() => onOeffnen(z.id)}>
        <div className="vp-at-karte-kopf">
          <button
            type="button"
            className="vp-at-karte-open"
            aria-label={`${z.name} ${z.zustand.wort}${z.zustand.alter ? ` · ${z.zustand.alter}` : ''} – Anlage öffnen`}
            onClick={(e) => {
              e.stopPropagation();
              onOeffnen(z.id);
            }}
          >
            <span className={`vp-at-dot is-${z.zustand.ton}`} aria-hidden="true" />
            <span className="vp-at-karte-name">
              {z.name}
              {nichtZugeordnet?.has(z.id) && <span className="vp-at-unzugeordnet">noch nicht zugeordnet</span>}
              <span className="vp-at-sub">
                {z.zustand.wort}
                {z.zustand.alter ? ` · ${z.zustand.alter}` : ''}
              </span>
            </span>
          </button>
          <button
            type="button"
            className="vp-at-details"
            aria-expanded={auf}
            aria-controls={`anlage-vorschau-${z.id}`}
            aria-label={`Details zu ${z.name} ${auf ? 'ausblenden' : 'anzeigen'}`}
            title={`Details ${auf ? 'ausblenden' : 'anzeigen'}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(z.id);
            }}
          >
            <span className="vp-at-chev" aria-hidden="true">
              <Icon name="chevron-right" size={16} />
            </span>
          </button>
        </div>
        <Warnzeile z={z} />
        {nums.length > 0 && (
          <div className="vp-at-karte-nums" data-count={nums.length}>
            {nums.map((n) => (
              <div key={n.id}>
                <span className="l">{n.label}</span>
                <span className="v">{zelleFuer(n.id, z)}</span>
              </div>
            ))}
          </div>
        )}
        <div className="vp-at-karte-fuss">
          {zeigt.has('erloese') && z.heuteEur != null ? (
            <span className="vp-at-karte-heute">
              {SPALTEN_KOPF.erloese.titel} {signiertesGeld(z.heuteEur)}{' '}
              <span className="u">€</span>
            </span>
          ) : (
            <span />
          )}
          {onEnergiebilanz && energiebilanz?.has(z.id) ? (
            <span className="vp-at-karte-wege">
              <button
                type="button"
                className="vp-at-weg"
                onClick={(e) => {
                  e.stopPropagation();
                  onEnergiebilanz(z.id);
                }}
              >
                {UEMS_ENERGIEBILANZ}
              </button>
              {oeffnen}
            </span>
          ) : (
            oeffnen
          )}
        </div>
        {onZuordnungKorrigieren && (
          <Recht aktion="anlage.zuordnen"><button
            type="button"
            className="vp-at-weg vp-at-korrigieren"
            onClick={(e) => {
              e.stopPropagation();
              onZuordnungKorrigieren(z.id);
            }}
          >
            Zuordnung korrigieren
          </button></Recht>
        )}
        {auf && (
          <div
            id={`anlage-vorschau-${z.id}`}
            className="vp-at-karte-vor"
            onClick={(e) => e.stopPropagation()}
          >
            <VorschauBlock zeilen={vorschau} onOeffnen={() => onOeffnen(z.id)} />
          </div>
        )}
      </article>
    );
  };
  if (!gruppen) return <div className={liste}>{zeilen.map(karte)}</div>;
  return (
    <div className="vp-at-gruppen">
      {gruppen.map((g) => (
        <section key={g.key} className="vp-at-gruppe-karten">
          {g.kopf}
          {g.zeilen.length === 0 && g.leer ? (
            <p className="vp-at-leer">{g.leer}</p>
          ) : (
            <div className={liste}>{g.zeilen.map(karte)}</div>
          )}
        </section>
      ))}
    </div>
  );
}
