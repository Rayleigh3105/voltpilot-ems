import { useIsPhone } from '../useIsPhone';
import { fmtNum } from '../format';
import type { AnlagenZeile, Dichte, SpaltenId } from '../portfolioCockpit';
import { SPALTEN_KOPF, signiertesGeld } from '../portfolioCockpit';
import { VORSCHAU_ABSPRUNG, type VorschauZeile } from '../portfolioVorschau';
import { Icon } from '../../designsystem/components/core/Icon';
import './AnlagenTabelle.css';
import { useStaffel } from '../staffel';

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
}

export function AnlagenTabelle(props: AnlagenTabelleProps) {
  const phone = useIsPhone();
  if (props.zeilen.length === 0) return null;
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
  // Älter als ein Tag: datiert und ohne Balken — nie als aktuelle Zahl.
  if (z.ladestandStand) {
    return (
      <span className="dim">
        {fmtNum(z.ladestandPct, '', 0)} % {z.ladestandStand}
      </span>
    );
  }
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

function GeldZelle({ wert, grund }: { wert: number | null; grund?: string | null }) {
  if (wert == null) return <Strich />;
  return (
    <>
      {signiertesGeld(wert)} <span className="u">€</span>
      {grund && <span className="vp-at-grund">{grund}</span>}
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
      return <GeldZelle wert={z.heuteEur} grund={z.heuteGrund} />;
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

function Tabelle({ zeilen, spalten, dichte, offen, onToggle, onOeffnen, vorschau }: AnlagenTabelleProps) {
  // Bewegung P6: die Zeilen staffeln beim ERSTEN Blick auf das Portfolio, nie
  // beim zweiten (`src/staffel.ts`). Beide Formen teilen den Schlüssel — es
  // ist dieselbe Liste, nur einmal als Tabelle und einmal als Karten.
  const staffel = useStaffel('portfolio-anlagen');
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
        <tbody className={staffel}>
          {zeilen.map((z) => {
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
                        {z.unterzeile && <span className="vp-at-sub">{z.unterzeile}</span>}
                        <Warnzeile z={z} />
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
          })}
        </tbody>
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
function Karten({ zeilen, spalten, offen, onToggle, onOeffnen, vorschau }: AnlagenTabelleProps) {
  const zeigt = new Set(spalten);
  const staffel = useStaffel('portfolio-anlagen');
  return (
    <div className={staffel ? `vp-at-karten ${staffel}` : 'vp-at-karten'}>
      {zeilen.map((z) => {
        const auf = offen === z.id;
        const nums: { id: SpaltenId; label: string }[] = [];
        if (zeigt.has('pv-jetzt') && z.pvJetztKw != null) nums.push({ id: 'pv-jetzt', label: 'PV jetzt' });
        // Die Kachel zeigt „jetzt" — ein Ladestand von vor Wochen gehört nicht hinein.
        if (zeigt.has('speicher') && z.ladestandPct != null && !z.ladestandStand)
          nums.push({ id: 'speicher', label: 'Speicher' });
        if (zeigt.has('netz-heute') && z.netz) nums.push({ id: 'netz-heute', label: 'Netz jetzt' });
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
                  {z.heuteGrund && <span className="vp-at-grund">{z.heuteGrund}</span>}
                </span>
              ) : (
                <span />
              )}
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
            </div>
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
      })}
    </div>
  );
}
