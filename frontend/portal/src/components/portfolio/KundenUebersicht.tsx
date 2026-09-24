import type { ReactNode } from 'react';
import { Icon } from '../../../designsystem/components/core/Icon';
import type {
  AnlagenKarte,
  HeuteKarte,
  JetztBlock,
  StatusZeile,
  TagesKurve,
  UebersichtBlock,
} from '../../kundenUebersicht';
import { Erklaert } from '../VerlaufRahmen';
import { RowMenu, type RowMenuItem } from '../RowMenu';
import './KundenUebersicht.css';

/**
 * **Meine Anlagen · Übersicht** für Endkundinnen und Endkunden (Konzept
 * „Meine Anlagen neu", Ü1–Ü5 = A). Vier Blöcke: Statuszeile mit ⋯-Menü,
 * „Heute" (Ergebnis, VoltPilot-Steuerung, Tageskurve), „Jetzt" (vier Werte in
 * Worten) und „Ihre Anlagen" (Karte je Anlage). Render-Schicht über
 * `kundenUebersicht.ts`; die Kurven sind schlankes SVG — die Übersicht lädt
 * keine Diagramm-Bibliothek.
 */
export function KundenUebersicht({
  titel,
  titelVersteckt,
  status,
  aktionen,
  bloecke,
  heute,
  kurve,
  jetzt,
  anlagen,
  hrefFor,
  anpassen,
}: {
  titel: string;
  titelVersteckt: boolean;
  status: StatusZeile | null;
  aktionen: RowMenuItem[];
  bloecke: readonly UebersichtBlock[];
  heute: HeuteKarte | null;
  kurve: TagesKurve | null;
  jetzt: JetztBlock | null;
  anlagen: readonly AnlagenKarte[];
  hrefFor: (id: string) => string;
  /** Der Anpassen-Modus, falls offen (Leiste + Liste). */
  anpassen?: ReactNode;
}) {
  const block = (b: UebersichtBlock) => {
    if (b === 'heute' && heute) return <HeuteBlock key="heute" heute={heute} kurve={kurve} />;
    if (b === 'jetzt' && jetzt && jetzt.werte.length > 0) return <JetztBlockView key="jetzt" jetzt={jetzt} />;
    if (b === 'anlagen' && anlagen.length > 0) return <AnlagenBlock key="anlagen" anlagen={anlagen} hrefFor={hrefFor} />;
    return null;
  };
  // „Heute" und „Jetzt" stehen am Rechner nebeneinander, wenn sie
  // aufeinander folgen; „Ihre Anlagen" nimmt immer die volle Breite.
  const inhalt = bloecke.map(block).filter(Boolean);
  return (
    <div className="vp-vr vp-ku">
      <div className="vp-ku-kopf">
        <h1 className={titelVersteckt ? 'vp-sr-only' : 'vp-ku-titel'}>{titel}</h1>
        {status && (
          <p className={`vp-ku-status is-${status.ton}`}>
            <span className="vp-ku-punkt" aria-hidden="true" />
            <span>{status.text}</span>
            {status.zielId && (
              <a className="vp-vr-link" href={hrefFor(status.zielId)}>
                Zur Anlage ›
              </a>
            )}
          </p>
        )}
        <RowMenu items={aktionen} label="Weitere Aktionen" />
      </div>
      {anpassen}
      <div className="vp-ku-bloecke">{inhalt}</div>
    </div>
  );
}

function HeuteBlock({ heute, kurve }: { heute: HeuteKarte; kurve: TagesKurve | null }) {
  const s = heute.steuerung;
  return (
    <section className="vp-vr-card vp-ku-heute" aria-label="Heute">
      <div className="vp-vr-kpi-l">
        <span>Ergebnis heute</span>
        <Erklaert
          info={{
            titel: 'Ergebnis heute',
            text: 'Eigenverbrauch und Einspeisung aller Anlagen, abzüglich Netzbezug — bewertet mit den hinterlegten Tarifen. Der Tag läuft noch; die Zahl ist ein Zwischenstand.',
          }}
        />
      </div>
      <div className="vp-ku-zahlzeile">
        <span className={`vp-ku-gross${heute.ton ? ` ${heute.ton}` : ''}`}>{heute.wert}</span>
        {heute.unter && (
          <span className="vp-vr-kpi-s">
            {heute.pfeil && <span className="vp-vr-dlt" aria-hidden="true">{heute.pfeil} </span>}
            {heute.unter}
          </span>
        )}
      </div>
      {s && (
        <div className={`vp-ku-steuer is-${s.ton}`}>
          <span className="vp-ku-steuer-t">
            <span className="vp-ku-steuer-n">
              <span className="vp-vr-key" style={{ background: 'var(--vp-c-primary)' }} aria-hidden="true" />
              {s.label}
              <Erklaert info={{ titel: s.titel, text: s.info.join(' ') }} />
            </span>
            <span className="vp-ku-steuer-u">{s.unter}</span>
          </span>
          <span className="vp-ku-steuer-w">{s.wert}</span>
        </div>
      )}
      {kurve && kurve.max > 0 && <TagesKurveSvg kurve={kurve} />}
      {(heute.erzeugt || heute.verbraucht) && (
        <div className="vp-ku-legende">
          {heute.erzeugt && (
            <span>
              <i style={{ background: 'var(--vp-c-chart-pv)' }} aria-hidden="true" />
              {heute.erzeugt}
            </span>
          )}
          {heute.verbraucht && (
            <span>
              <i style={{ background: 'var(--vp-c-chart-load)' }} aria-hidden="true" />
              {heute.verbraucht}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

const B = 960;
const H = 130;
const UNTEN = H;

/** Ein Pfad mit Lücken: jede `null`-Viertelstunde bricht die Linie. */
function pfad(werte: readonly (number | null)[], max: number, bis: number, hoehe = UNTEN, breite = B): string {
  let d = '';
  let offen = false;
  for (let i = 0; i <= Math.min(bis, 95); i++) {
    const v = werte[i];
    if (v == null) {
      offen = false;
      continue;
    }
    const x = ((i + 0.5) / 96) * breite;
    const y = hoehe - (Math.max(0, v) / max) * (hoehe - 8);
    d += `${offen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    offen = true;
  }
  return d;
}

/** Die Fläche unter einer Reihe — je zusammenhängendem Stück geschlossen. */
function flaeche(werte: readonly (number | null)[], max: number, bis: number, hoehe = UNTEN, breite = B): string {
  let d = '';
  let start: number | null = null;
  let letzte = 0;
  const schliessen = () => {
    if (start != null) d += `L${letzte.toFixed(1)},${hoehe}L${start.toFixed(1)},${hoehe}Z`;
    start = null;
  };
  for (let i = 0; i <= Math.min(bis, 95); i++) {
    const v = werte[i];
    if (v == null) {
      schliessen();
      continue;
    }
    const x = ((i + 0.5) / 96) * breite;
    const y = hoehe - (Math.max(0, v) / max) * (hoehe - 8);
    if (start == null) {
      start = x;
      d += `M${x.toFixed(1)},${hoehe}L${x.toFixed(1)},${y.toFixed(1)}`;
    } else d += `L${x.toFixed(1)},${y.toFixed(1)}`;
    letzte = x;
  }
  schliessen();
  return d;
}

function TagesKurveSvg({ kurve }: { kurve: TagesKurve }) {
  const jetztX = ((kurve.jetzt + 1) / 96) * B;
  const max = kurve.max * 1.08;
  // Die Stunden stehen als Text UNTER dem SVG: das Bild dehnt sich mit der
  // Breite (`preserveAspectRatio="none"`), Schrift darin würde mitgedehnt.
  return (
    <div className="vp-ku-kurve-rahmen">
      <Kurve kurve={kurve} jetztX={jetztX} max={max} />
      <div className="vp-ku-achse" aria-hidden="true">
        {['00', '06', '12', '18', '24'].map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
    </div>
  );
}

function Kurve({ kurve, jetztX, max }: { kurve: TagesKurve; jetztX: number; max: number }) {
  return (
    <svg
      className="vp-ku-kurve"
      viewBox={`0 0 ${B} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Erzeugung und Verbrauch aller Anlagen heute bis jetzt"
    >
      <rect className="offen" x={jetztX} y={0} width={Math.max(0, B - jetztX)} height={UNTEN} />
      <line className="achse" x1={0} x2={B} y1={UNTEN} y2={UNTEN} />
      <path className="pv-a" d={flaeche(kurve.pv, max, kurve.jetzt)} />
      <path className="pv-l" d={pfad(kurve.pv, max, kurve.jetzt)} />
      <path className="ld-l" d={pfad(kurve.load, max, kurve.jetzt)} />
      <line className="jetzt" x1={jetztX} x2={jetztX} y1={0} y2={UNTEN} />
    </svg>
  );
}

function JetztBlockView({ jetzt }: { jetzt: JetztBlock }) {
  const farbe: Record<string, string> = {
    pv: 'var(--vp-c-chart-pv)',
    load: 'var(--vp-c-chart-load)',
    batt: 'var(--vp-c-chart-batt)',
    grid: 'var(--vp-c-chart-grid)',
  };
  return (
    <section className="vp-vr-card vp-ku-jetzt" aria-label="Jetzt">
      <div className="vp-ku-blockkopf">
        <h2>Jetzt</h2>
        {jetzt.stand && <span>{jetzt.stand}</span>}
      </div>
      <dl className={`vp-ku-jetzt-g n${jetzt.werte.length}`}>
        {jetzt.werte.map((w) => (
          <div key={w.id}>
            <dt>
              <span className="vp-vr-key" style={{ background: farbe[w.rolle] }} aria-hidden="true" />
              {w.name}
            </dt>
            <dd>{w.wert}</dd>
            <dd className="u">{w.unter}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Spark({ kurve, jetzt }: { kurve: readonly (number | null)[]; jetzt: number }) {
  const max = Math.max(0, ...kurve.map((v) => v ?? 0));
  if (max <= 0) return <span className="vp-ku-spark leer" aria-hidden="true" />;
  return (
    <svg className="vp-ku-spark" viewBox="0 0 96 28" preserveAspectRatio="none" aria-hidden="true">
      <line className="achse" x1={0} x2={96} y1={27} y2={27} />
      <path className="pv-a" d={flaeche(kurve, max * 1.1, jetzt, 27, 96)} />
      <path className="pv-l" d={pfad(kurve, max * 1.1, jetzt, 27, 96)} />
    </svg>
  );
}

function AnlagenBlock({ anlagen, hrefFor }: { anlagen: readonly AnlagenKarte[]; hrefFor: (id: string) => string }) {
  return (
    <section className="vp-vr-card vp-ku-anlagen" aria-label="Ihre Anlagen">
      <div className="vp-ku-blockkopf">
        <h2>Ihre Anlagen</h2>
        <span>heute</span>
      </div>
      <ul className="vp-ku-liste">
        {anlagen.map((a) => (
          <li key={a.id}>
            <a className="vp-ku-anlage" href={hrefFor(a.id)}>
              <span className="vp-ku-anlage-kopf">
                <span className={`vp-ku-punkt is-${a.ton}`} aria-hidden="true" />
                <span className="vp-ku-anlage-name">{a.name}</span>
                <Icon name="chevron-right" size={16} />
              </span>
              <span className={`vp-ku-satz${a.ton !== 'ok' ? ' warn' : ''}`}>{a.satz}</span>
              <span className="vp-ku-anlage-fuss">
                <dl>
                  {a.zahlen.map((z) => (
                    <div key={z.name}>
                      <dt>{z.name}</dt>
                      <dd>{z.wert}</dd>
                    </div>
                  ))}
                </dl>
                {a.kurve && <Spark kurve={a.kurve} jetzt={a.jetzt} />}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
