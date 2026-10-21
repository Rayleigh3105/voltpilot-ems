import { useMemo, useState, type CSSProperties } from 'react';
import type { ErzeugerVorgabeDetail, HistoryRange } from '../../api';
import {
  EREIGNIS_ARTEN,
  SPUR_HINWEIS_KURZ,
  ereignisArten,
  vorgabenTeile,
  type ChronikGruppe,
  type ChronikZeile,
  type EreignisArt,
  type EreignisSpurView,
  type EreignisZelle,
  type VorgabenTeil,
} from '../../historieEreignisse';
import { useIsPhone } from '../../useIsPhone';
import { VrKarte, VrUmschalter } from '../VerlaufRahmen';
import type { EreignisFokus } from './EreignisSpurRahmen';
import { EreignisSymbol } from './EreignisSymbol';
import { VorgabeDetail } from './VorgabeDetail';

/**
 * **Die Ereignisse des Zeitraums** (Konzept `data/vp-verlauf-ereignisse-k1`)
 * — direkt unter dem Energie-Diagramm, render-only über `historieEreignisse.ts`.
 *
 * Zwei Ansichten aus denselben Ereignissen, umschaltbar wie Diagramm/Tabelle:
 *
 * - **Chronik** (Standard): je Tag (im Jahr je Monat, am Tag je Ereignis) ein
 *   Datumsblock, je Art darin eine Zeile mit EINEM Wort und EINER Zahl. Die
 *   Chips darüber zählen je Art und filtern Chronik und Spur.
 * - **Nach Art**: je Art die Anzahl, die eine Zahl und ein Streifen über den
 *   Zeitraum. Eine Kachel antippen springt in die Chronik dieser Art.
 *
 * Ab der Woche öffnet eine Zeile ihren Tag (im Jahr ihren Monat). Am Tag gibt
 * es nichts Feineres zu öffnen; dort klappt der Abendverkauf seine Fakten auf.
 *
 * **Vorgaben einer Erzeugeranlage** (UEMS EZ-9, EW-12 A): Netzbetreiber,
 * Direktvermarkter und „nicht bereit“ sind Arten wie die anderen. Am Tag klappt
 * eine Vorgabe ihr Detail mit Rohsignalen und Zählerständen auf; „Nach Art“
 * zählt sie über den Zeitraum (je Einheit aufklappbar, im Jahr je Monat), und
 * „Vorgaben als CSV“ lädt die Chronik der Vorgaben des Zeitraums.
 */

type Ansicht = 'liste' | 'art';

const ERSTE_ANSICHT: Record<HistoryRange, string> = {
  day: 'Nach Zeit',
  week: 'Nach Tag',
  month: 'Nach Tag',
  year: 'Nach Monat',
};

function Symbol({ art }: { art: EreignisArt }) {
  return (
    <span className={`vp-vr-ereignis-symbol is-${EREIGNIS_ARTEN[art].farbe}`}>
      <EreignisSymbol art={art} />
    </span>
  );
}

function Pfeil() {
  return (
    <svg className="vp-vr-zeile-pfeil" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function Plan() {
  return <span className="vp-vr-plan">geplant</span>;
}

export function EreignisKarte({
  spur,
  gruppen,
  range,
  streifenZellen,
  filter,
  onFilter,
  fokus,
  onFokus,
  onOeffnen,
  ladeVorgabe,
  onVorgabenCsv,
}: {
  spur: EreignisSpurView;
  /** `ereignisChronik(spur, range)` — dieselben Gruppen wie die Spur. */
  gruppen: readonly ChronikGruppe[];
  range: HistoryRange;
  /** Die Zellen des Streifens von „Nach Art": Tage, Monate bzw. Stunden. */
  streifenZellen: readonly EreignisZelle[];
  filter: EreignisArt | null;
  onFilter: (art: EreignisArt | null) => void;
  fokus: EreignisFokus | null;
  onFokus: (f: EreignisFokus | null) => void;
  /** Der Sprung in den Tag bzw. Monat — fehlt er, sind die Zeilen ruhige Information. */
  onOeffnen?: (sprung: NonNullable<ChronikGruppe['sprung']>) => void;
  /** Das Detail einer Vorgabe (EZ-7) — fehlt es, bleibt die Zeile ruhige Information. */
  ladeVorgabe?: (id: string) => Promise<ErzeugerVorgabeDetail>;
  /** „Vorgaben als CSV“ für den Zeitraum der Ansicht — nur bei einer Anlage mit Anlagensteuerung. */
  onVorgabenCsv?: () => Promise<void>;
}) {
  const [ansicht, setAnsicht] = useState<Ansicht>('liste');
  const [alle, setAlle] = useState(false);
  const [offen, setOffen] = useState<string | null>(null);
  const [jeEinheit, setJeEinheit] = useState(false);
  const [csv, setCsv] = useState<'bereit' | 'laedt' | 'fehler'>('bereit');
  const phone = useIsPhone();
  const arten = useMemo(() => ereignisArten(spur, range, streifenZellen), [spur, range, streifenZellen]);
  const teile = useMemo(() => vorgabenTeile(spur), [spur]);
  const leer = spur.chips.length === 0;

  const erklaerung = {
    titel: 'Was die Ereignisse bedeuten',
    text: (
      <span className="vp-vr-ereignis-erklaerung">
        {(arten.length ? arten.map((a) => a.art) : (['negativpreis', 'netzladen', 'datenluecke'] as EreignisArt[])).map(
          (a) => (
            <span key={a}>
              <b>{EREIGNIS_ARTEN[a].label}:</b> {EREIGNIS_ARTEN[a].erklaerung}
            </span>
          ),
        )}
        {spur.hinweis && <span>{spur.hinweis}</span>}
      </span>
    ),
  };

  const hinweisChip = spur.hinweis ? (
    <span className="vp-vr-ereignis-hinweis" title={spur.hinweis}>
      {SPUR_HINWEIS_KURZ}
    </span>
  ) : null;

  const sichtbareGruppen = filter
    ? gruppen
        .map((g) => ({ ...g, zeilen: g.zeilen.filter((z) => z.art === filter) }))
        .filter((g) => g.zeilen.length > 0)
    : gruppen;
  const grenze = phone ? 4 : 6;
  // Eine einzelne verborgene Gruppe lohnt keinen eigenen Knopf.
  const gekuerzt = !alle && sichtbareGruppen.length > grenze + 1;
  const gezeigt = gekuerzt ? sichtbareGruppen.slice(0, grenze) : sichtbareGruppen;
  const mehrWort = range === 'year' ? 'Monate' : range === 'day' ? 'Ereignisse' : 'Tage';

  const zeile = (g: ChronikGruppe, z: ChronikZeile) => {
    const vorgabeId = !g.sprung && ladeVorgabe ? (z.vorgabe?.id ?? null) : null;
    const aufklappbar = !g.sprung && (z.fakten.length > 0 || vorgabeId != null);
    const istOffen = offen === z.key;
    const an = !!fokus && fokus.key === g.key && (!fokus.art || fokus.art === z.art);
    const inhalt = (
      <>
        <Symbol art={z.art} />
        <span className="vp-vr-zeile-mitte">
          <span className="vp-vr-zeile-titel">{z.titel ?? z.info.label}</span>
          {/* „geplant" steht vor der Meta-Zeile: am Telefon bleibt der Titel einzeilig. */}
          <span className="vp-vr-zeile-meta">
            {z.geplant && <Plan />}
            {z.meta}
          </span>
        </span>
        <span className="vp-vr-zeile-zahl">
          {z.zahl}
          {z.zahlUnter && <small>{z.zahlUnter}</small>}
        </span>
      </>
    );
    const hover = {
      onMouseEnter: () => onFokus({ key: g.key, art: z.art }),
      onMouseLeave: () => onFokus(null),
      onFocus: () => onFokus({ key: g.key, art: z.art }),
      onBlur: () => onFokus(null),
    };
    const sprung = g.sprung;
    return (
      <li key={z.key}>
        {sprung && onOeffnen ? (
          <button
            type="button"
            className={`vp-vr-zeile${an ? ' is-fokus' : ''}`}
            title={z.satz}
            aria-label={`${g.label}: ${z.info.label}, ${z.meta}, ${z.zahl}${z.geplant ? ', geplant' : ''} — ${sprung.range === 'month' ? 'Monat' : 'Tag'} öffnen`}
            onClick={() => onOeffnen(sprung)}
            {...hover}
          >
            {inhalt}
            <Pfeil />
          </button>
        ) : aufklappbar ? (
          <button
            type="button"
            className={`vp-vr-zeile${an ? ' is-fokus' : ''}`}
            title={z.satz}
            aria-expanded={istOffen}
            aria-label={vorgabeId ? `${z.titel ?? z.info.label}, ${z.meta}, ${z.zahl} — Rohsignale und Zählerstände` : undefined}
            onClick={() => setOffen(istOffen ? null : z.key)}
            {...hover}
          >
            {inhalt}
            <Pfeil />
          </button>
        ) : (
          <div className={`vp-vr-zeile ohne-pfeil${an ? ' is-fokus' : ''}`} title={z.satz} {...hover}>
            {inhalt}
          </div>
        )}
        {aufklappbar && istOffen && vorgabeId && ladeVorgabe && <VorgabeDetail id={vorgabeId} laden={ladeVorgabe} />}
        {aufklappbar && istOffen && !vorgabeId && (
          <dl className="vp-vr-fakten">
            {z.fakten.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </li>
    );
  };

  return (
    <VrKarte
      titel="Ereignisse"
      className="vp-vr-ereignisse"
      info={erklaerung}
      aktionen={
        leer ? null : (
          <VrUmschalter
            label="Ansicht der Ereignisse"
            optionen={[
              { id: 'liste', label: ERSTE_ANSICHT[range] },
              { id: 'art', label: 'Nach Art' },
            ]}
            wert={ansicht}
            onWert={(w: Ansicht) => {
              setAnsicht(w);
              onFilter(null);
            }}
          />
        )
      }
    >
      {leer ? (
        <>
          <p className="vp-vr-ereignis-leer">
            <span className="vp-vr-ereignis-ok" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" focusable="false">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            {spur.leerText}
          </p>
          {hinweisChip && <div className="vp-vr-ereignis-chips">{hinweisChip}</div>}
        </>
      ) : ansicht === 'art' ? (
        <>
          <div className="vp-vr-arten">
            {arten.map((a) => (
              <button
                key={a.art}
                type="button"
                className={`vp-vr-art is-${a.info.farbe}`}
                aria-label={`${a.info.label}: ${a.anzahl}, ${a.zahl}${a.geplant ? ', geplant' : ''} — in der Chronik zeigen`}
                onClick={() => {
                  setAnsicht('liste');
                  onFilter(a.art);
                }}
                onMouseEnter={() => onFilter(a.art)}
                onMouseLeave={() => onFilter(null)}
              >
                <Symbol art={a.art} />
                <span className="vp-vr-art-titel">
                  {a.info.label}
                  {a.geplant && <Plan />}
                </span>
                <span className="vp-vr-art-anzahl">{a.anzahl}</span>
                <span className="vp-vr-art-zahl">
                  {a.zahl}
                  {a.zusatz && <small>{a.zusatz}</small>}
                </span>
                <span
                  className="vp-vr-streifen"
                  style={{ '--n': a.streifen.length } as CSSProperties}
                  aria-hidden="true"
                >
                  {a.streifen.map((z, i) => (
                    <i key={i} className={z.an ? 'an' : z.zukunft ? 'zk' : undefined} />
                  ))}
                </span>
              </button>
            ))}
          </div>
          {teile.monate.length > 0 && (
            <VorgabenTeile titel="Vorgaben je Monat" teile={teile.monate} />
          )}
          {teile.einheiten.length > 0 && (
            <div className="vp-vr-vorgaben-teile">
              <button
                type="button"
                className="vp-vr-textbtn"
                aria-expanded={jeEinheit}
                onClick={() => setJeEinheit((x) => !x)}
              >
                {jeEinheit ? 'Je Einheit ausblenden' : `Je Einheit (${teile.einheiten.length})`}
              </button>
              {jeEinheit && <VorgabenTeile titel="Vorgaben je Einheit" teile={teile.einheiten} />}
            </div>
          )}
          {hinweisChip && <div className="vp-vr-ereignis-chips">{hinweisChip}</div>}
        </>
      ) : (
        <>
          <div className="vp-vr-ereignis-chips" role="group" aria-label="Nach Art filtern">
            {arten.map((a) => (
              <button
                key={a.art}
                type="button"
                className={`vp-vr-ereignis-chip is-${a.info.farbe}`}
                aria-pressed={filter === a.art}
                title={a.info.erklaerung}
                onClick={() => onFilter(filter === a.art ? null : a.art)}
              >
                <EreignisSymbol art={a.art} className="vp-vr-ereignis-chip-symbol" />
                {a.info.label}
                <b>{a.n}</b>
              </button>
            ))}
            {hinweisChip}
          </div>
          {spur.vorgabenHinweis && <p className="vp-vr-vorgabe-hinweis">{spur.vorgabenHinweis}.</p>}
          <ul className="vp-vr-chronik">
            {gezeigt.map((g) => (
              <li key={g.key} className={`vp-vr-chronik-gruppe${range === 'day' ? ' is-zeit' : ''}`}>
                <span className="vp-vr-chronik-datum" aria-hidden="true">
                  <b>{g.gross}</b>
                  {g.klein && <span>{g.klein}</span>}
                </span>
                <ul className="vp-vr-chronik-zeilen" aria-label={g.label}>
                  {g.zeilen.map((z) => zeile(g, z))}
                </ul>
              </li>
            ))}
          </ul>
          {(gekuerzt || alle) && sichtbareGruppen.length > grenze + 1 && (
            <button type="button" className="vp-vr-textbtn" onClick={() => setAlle((x) => !x)}>
              {alle ? 'Weniger zeigen' : `Alle ${sichtbareGruppen.length} ${mehrWort} zeigen`}
            </button>
          )}
        </>
      )}
      {onVorgabenCsv && (
        <div className="vp-vr-vorgaben-csv">
          <button
            type="button"
            className="vp-vr-textbtn"
            disabled={csv === 'laedt'}
            onClick={() => {
              setCsv('laedt');
              onVorgabenCsv().then(
                () => setCsv('bereit'),
                () => setCsv('fehler'),
              );
            }}
          >
            {csv === 'laedt' ? 'Vorgaben werden geladen …' : 'Vorgaben als CSV'}
          </button>
          {csv === 'fehler' && (
            <span className="vp-vr-vorgabe-hinweis" role="status">
              Die Vorgaben konnten nicht geladen werden.
            </span>
          )}
        </div>
      )}
    </VrKarte>
  );
}

/** „Vorgaben je Monat“ bzw. „je Einheit“: je Teil eine Zeile, darin Anzahl und Dauer je Urheber. */
function VorgabenTeile({ titel, teile }: { titel: string; teile: readonly VorgabenTeil[] }) {
  return (
    <ul className="vp-vr-vorgaben-liste" aria-label={titel}>
      {teile.map((t) => (
        <li key={t.key}>
          <b>{t.label}</b>
          <span>
            {t.zeilen.map((z) => (
              <span key={z.art} className={`is-${EREIGNIS_ARTEN[z.art].farbe}`}>
                {z.text}
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}
