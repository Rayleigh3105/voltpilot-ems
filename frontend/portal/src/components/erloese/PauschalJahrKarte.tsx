import { VrKarte } from '../VerlaufRahmen';
import {
  BEREICH_WORT,
  aktuellerZeitraum,
  bandGeometrie,
  jahresstand,
  kwh,
  naechsteKwh,
  standChip,
  tag,
  zahl,
  type Jahresstand,
  type PauschalJahr,
} from '../../mispelPauschal';
import './MispelKarte.css';
import './PauschalJahrKarte.css';

/**
 * „MiSpeL · Jahresstand nach Anlage 2“ in Verlauf › Erlöse (MP-27, Bedienkonzept BK-27 Variante A „Jahresband“,
 * abgestimmt am 04.10.2026): ein Band für das Kalenderjahr mit den drei Bereichen der Anlage 2 (A2 Abb. 1) —
 * förderfähig bis (P1), indifferent bis (P4), darüber saldierungsfähig —, der Satz „Sie stehen bei … von … kWh“ und
 * was die nächste kWh bekommt; jede Zahl mit Begriff und Formelnummer. Im Rumpfjahr die Grenzen (P1)R/(P4)R
 * (A2 S. 51–55). Eine Schätzung bis Silvester steht nur mit Jahresprofil da — heute nie (kein Hochrechnen).
 * Die Farben sind die der Festlegung und der MiSpeL-Karte von MP-18; die Fläche heißt nicht „Ampel“, weil Rot in der
 * Festlegung „saldierungsfähig“ bedeutet.
 */
export function PauschalJahrKarte({ daten, heute }: { daten: PauschalJahr; heute: string }) {
  const z = aktuellerZeitraum(daten.staende, heute);
  if (!z) return null;
  const j = jahresstand(z);
  const chip = standChip(z);
  const naechste = naechsteKwh(j);
  return (
    <VrKarte
      titel={`MiSpeL · Jahresstand nach Anlage 2 · ${daten.jahr}`}
      label="MiSpeL · Jahresstand nach Anlage 2"
      className="vp-mi vp-pj"
      aktionen={
        <span className={`vp-mi-stand is-${chip.ton}`} data-testid="pj-stand">
          {chip.text}
        </span>
      }
    >
      <div className="vp-pj-grid" data-bereich={j.bereich ?? 'offen'} data-testid="pauschal-jahr">
        <div>
          <p className="vp-pj-gross">{gross(j)}</p>
          <p className="vp-pj-satz">{satz(j)}</p>
          <Band j={j} />
          <div className="vp-pj-zonen" aria-hidden="true">
            <span className="is-f">
              <b>bis {zahlOffen(j.foerdergrenze)}</b>förderfähig · Marktprämie
            </span>
            <span className="is-n">
              <b>bis {zahlOffen(j.saldogrenze)}</b>indifferent · weder noch
            </span>
            <span className="is-s">
              <b>darüber</b>saldierungs{'­'}fähig
            </span>
          </div>
          {naechste && (
            <p className={`vp-pj-naechste is-${j.bereich}`} data-testid="pj-naechste">
              <b>{naechste.titel}</b> {naechste.satz}
            </p>
          )}
          {z.rumpfjahr && (
            <p className="vp-pj-rumpf" data-testid="pj-rumpfjahr">
              <b>Rumpfjahr {tag(z.tag_von)} bis {tag(z.tag_bis)}.</b> Die Grenzen gelten anteilig: {j.foerderName} nach den
              Tagen der Sommerperiode April bis September, {j.indifferenzName} nach allen Tagen (Anlage 2, S. 54–55).
            </p>
          )}
        </div>
        <div>
          <dl className="vp-pj-leg" aria-label="Mengen nach Anlage 2">
            <div>
              <dt>
                <i className="is-f" />
                förderfähig <small>(P15) Förderfähige Netzeinspeisung im {z.rumpfjahr ? 'Rumpfjahr' : 'Kalenderjahr'}</small>
              </dt>
              <dd>{kwh(j.p15)}</dd>
            </div>
            <div>
              <dt>
                <i className="is-n" />
                indifferent{' '}
                <small>
                  {j.indifferenzName} Indifferenzbereich — weder gefördert noch saldiert, bis {zahlOffen(j.saldogrenze)} kWh{' '}
                  {j.saldoName}
                </small>
              </dt>
              <dd>{kwh(j.indifferent ?? (j.bereich === 'foerderfaehig' ? 0 : null))}</dd>
            </div>
            <div>
              <dt>
                <i className="is-s" />
                saldierungsfähig <small>(P10) Saldierungsfähige Netzeinspeisung — höchstens der Netzbezug (P9)</small>
              </dt>
              <dd>{kwh(j.p10)}</dd>
            </div>
          </dl>
          <dl className="vp-pj-kv">
            <div>
              <dt>
                Netzbezug <small>(P9)</small>
              </dt>
              <dd>{kwh(j.p9)}</dd>
            </div>
            <div>
              <dt>
                davon umlagebelastet <small>(P11)</small>
              </dt>
              <dd>{kwh(j.p11)}</dd>
            </div>
          </dl>
          <p className="vp-pj-label">Was das wert ist</p>
          <dl className="vp-pj-kv">
            <div>
              <dt>
                Marktprämie auf {kwh(j.p15)}{' '}
                <small>
                  (P15) · anzulegender Wert minus Jahresmarktwert Solar {daten.jahr} — den veröffentlichen die
                  Übertragungsnetzbetreiber nach Jahresende
                </small>
              </dt>
              <dd className="is-offen">offen</dd>
            </div>
            <div>
              <dt>
                Saldierung{' '}
                <small>
                  {j.bereich === 'saldierungsfaehig'
                    ? `${kwh(j.p10)} senken die Umlagen auf Ihren Netzbezug; der Betrag folgt mit dem Jahresnachweis`
                    : `erst über ${zahlOffen(j.saldogrenze)} kWh ${j.saldoName}: dann sinken die Umlagen auf Ihren Netzbezug`}
                </small>
              </dt>
              <dd className="is-offen">{j.bereich === 'saldierungsfaehig' ? 'offen' : 'noch keine'}</dd>
            </div>
          </dl>
        </div>
      </div>
      <p className="vp-pj-fuss">
        Jährliche Mengenbestimmung nach Anlage 2 · Formelsatz {z.formelsatz}
        {z.basisfall && z.basisfall !== z.formelsatz ? ` (Basisfall ${z.basisfall})` : ''} · ein Zähler am Hausanschluss ·
        Stand {tag(z.gerechnet_am)}
      </p>
    </VrKarte>
  );
}

/** Im Monat eine Zeile mit Sprung ins Jahr (BK-27 A). */
export function PauschalJahrZeile({ daten, heute, onJahr }: { daten: PauschalJahr; heute: string; onJahr: () => void }) {
  const z = aktuellerZeitraum(daten.staende, heute);
  if (!z) return null;
  const j = jahresstand(z);
  return (
    <button type="button" className="vp-pj-zeile" onClick={onJahr} data-testid="pj-zeile">
      <span>
        <b>MiSpeL · Jahresstand {daten.jahr}:</b> {kurz(j)}
      </span>
      <span aria-hidden="true">›</span>
    </button>
  );
}

function zahlOffen(v: number): string {
  return Number.isFinite(v) ? zahl(Math.round(v)) : 'offen';
}

function kurz(j: Jahresstand): string {
  if (j.bereich === 'foerderfaehig' && j.marke != null) {
    return `${zahlOffen(j.marke)} von ${zahlOffen(j.foerdergrenze)} kWh förderfähig`;
  }
  if (j.bereich && j.marke != null) return `${zahlOffen(j.marke)} kWh · ${BEREICH_WORT[j.bereich]}`;
  return 'offen';
}

function gross(j: Jahresstand): string {
  if (j.bereich === 'foerderfaehig' && j.marke != null) {
    return `Noch ${kwh(j.foerdergrenze - j.marke)} mit Marktprämie`;
  }
  if (j.bereich === 'indifferent') return `Grenze erreicht: ${kwh(j.foerdergrenze)} mit Marktprämie`;
  if (j.bereich === 'saldierungsfaehig') return `Über der Saldierungsgrenze: ${kwh(j.p10)} saldierungsfähig`;
  return 'Jahresstand offen';
}

function satz(j: Jahresstand) {
  if (j.bereich === 'foerderfaehig' && j.marke != null) {
    return (
      <>
        Sie stehen bei{' '}
        <b>
          {zahlOffen(j.marke)} von {zahlOffen(j.foerdergrenze)} kWh
        </b>{' '}
        förderfähiger Einspeisung <small className="vp-pj-formel">(P14) von {j.foerderName}</small>.
      </>
    );
  }
  if (j.bereich === 'indifferent' && j.marke != null) {
    return (
      <>
        Sie stehen bei <b>{kwh(j.marke)}</b> — {kwh(j.indifferent)} im Indifferenzbereich{' '}
        <small className="vp-pj-formel">{j.indifferenzName}</small>.
      </>
    );
  }
  if (j.bereich === 'saldierungsfaehig' && j.marke != null) {
    return (
      <>
        Sie stehen bei <b>{kwh(j.marke)}</b> — über der Saldierungsgrenze {kwh(j.saldogrenze)}{' '}
        <small className="vp-pj-formel">{j.saldoName}</small>.
      </>
    );
  }
  return <>Für dieses Jahr fehlt noch ein Wert der Rechnung; sobald er da ist, steht hier der Stand.</>;
}

function Band({ j }: { j: Jahresstand }) {
  if (!Number.isFinite(j.foerdergrenze) || !Number.isFinite(j.saldogrenze)) return null;
  const g = bandGeometrie(j);
  const m = g.marke;
  const fill = (von: number, bis: number, cls: string) =>
    m != null && m > von ? (
      <i className={`vp-pj-fill ${cls}`} style={{ left: `${von}%`, width: `${Math.min(m, bis) - von}%` }} />
    ) : null;
  const label =
    `Band ${j.zeitraum.rumpfjahr ? 'Rumpfjahr' : 'Kalenderjahr'}: förderfähig bis ${zahlOffen(j.foerdergrenze)} kWh ${j.foerderName}, ` +
    `indifferent bis ${zahlOffen(j.saldogrenze)} kWh ${j.saldoName}, darüber saldierungsfähig` +
    (j.marke != null ? `; Stand ${zahlOffen(j.marke)} kWh` : '');
  return (
    <div className="vp-pj-band" role="img" aria-label={label} data-testid="pj-band">
      <div className="vp-pj-bar">
        <i className="vp-pj-zone is-f" style={{ left: 0, width: `${g.foerder}%` }} />
        <i className="vp-pj-zone is-n" style={{ left: `${g.foerder}%`, width: `${g.indifferent}%` }} />
        <i className="vp-pj-zone is-s" style={{ left: `${g.foerder + g.indifferent}%`, width: `${g.saldo}%` }} />
        {fill(0, g.foerder, 'is-f')}
        {fill(g.foerder, g.foerder + g.indifferent, 'is-n')}
        {fill(g.foerder + g.indifferent, 100, 'is-s')}
      </div>
      {m != null && (
        <b className="vp-pj-marke" style={{ left: `${m}%` }} data-rand={m > 70 ? 'rechts' : m < 30 ? 'links' : undefined}>
          <span>heute {zahlOffen(j.marke ?? NaN)}</span>
        </b>
      )}
      <span className="vp-pj-tick is-l" style={{ left: `${g.foerder}%` }}>
        {zahlOffen(j.foerdergrenze)} <small>{j.foerderName}</small>
      </span>
      <span className="vp-pj-tick is-r" style={{ left: `${g.foerder + g.indifferent}%` }}>
        {zahlOffen(j.saldogrenze)} <small>{j.saldoName}</small>
      </span>
    </div>
  );
}
