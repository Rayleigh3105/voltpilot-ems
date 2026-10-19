import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import {
  MISPEL_KNOTEN, MISPEL_TAG, MISPEL_VORHER_NACHHER, MISPEL_WEGE, MISPEL_WEGE_UNTERSCHRIFT,
  type MispelKnoten, type MispelWeg,
} from './content/mispel';
import './HelpMispel.css';

/**
 * Die Bilder der Themenseite „MiSpeL verstehen“ (MP-50, Attrappe BK-50 Abschnitt 3.1): von Hand gesetzte SVG für
 * Symbole, Pfeile und das Tagesband; die Sätze daneben bleiben Text, damit sie umbrechen, vorgelesen und gefunden
 * werden. Farben aus `HelpMispel.css` - dieselben Werte wie die MiSpeL-Karte (`help.test.ts` vergleicht sie).
 */

const SYMBOL: Record<MispelKnoten, IconName> = { sonne: 'sun', speicher: 'battery', netz: 'pole', haus: 'home' };

function kettenText(kette: readonly MispelKnoten[]) {
  return kette.map((k) => MISPEL_KNOTEN[k]).join(' → ');
}

/** Eine lange Beschriftung unter einem Symbol in zwei Zeilen, am Leerzeichen nahe der Mitte. */
function zeilen(text: string): [string, string | null] {
  const luecken = [...text].flatMap((zeichen, i) => zeichen === ' ' ? [i] : []);
  if (text.length <= 12 || !luecken.length) return [text, null];
  const teil = luecken.reduce((best, i) => Math.abs(i - text.length / 2) < Math.abs(best - text.length / 2) ? i : best, luecken[0]);
  return [text.slice(0, teil), text.slice(teil + 1)];
}

/** Eine Kette von Symbolen mit farbigen Pfeilen, Beschriftung unter jedem Symbol. */
function Kette({ kette, farbe }: { kette: readonly MispelKnoten[]; farbe: MispelWeg['farbe'] }) {
  const breite = 300;
  const rand = 43;
  const abstand = (breite - 2 * rand) / (kette.length - 1);
  const mitte = kette.map((_, i) => rand + i * abstand);
  return <svg className={`vp-help-mispel-kette f-${farbe}`} viewBox={`0 0 ${breite} 80`} role="img" aria-label={kettenText(kette)}>
    {mitte.slice(1).map((bis, i) => {
      const von = mitte[i] + 30;
      const spitze = bis - 28;
      return <g key={i} className="pfeil">
        <line x1={von} y1={22} x2={spitze - 8} y2={22} />
        <path d={`M${spitze - 10} 14 L${spitze} 22 L${spitze - 10} 30 Z`} />
      </g>;
    })}
    {kette.map((knoten, i) => {
      const [erste, zweite] = zeilen(MISPEL_KNOTEN[knoten]);
      return <g key={i} className="knoten">
        <rect x={mitte[i] - 22} y={0} width={44} height={44} rx={12} />
        <Icon name={SYMBOL[knoten]} size={22} x={mitte[i] - 11} y={11} />
        <text x={mitte[i]} y={60}>{erste}</text>
        {zweite && <text x={mitte[i]} y={74}>{zweite}</text>}
      </g>;
    })}
  </svg>;
}

function Wege() {
  return <figure className="vp-help-diagram vp-help-mispel">
    <ul className="vp-help-mispel-wege" aria-label="Die Wege des Stroms">
      {MISPEL_WEGE.map((weg) => <li key={weg.farbe} className={`f-${weg.farbe}`}>
        <span className="name"><i aria-hidden="true" />{weg.name}</span>
        <Kette kette={weg.kette} farbe={weg.farbe} />
        <span className="folge"><strong>{weg.folge}</strong><small>{weg.satz}</small></span>
      </li>)}
    </ul>
    <figcaption>{MISPEL_WEGE_UNTERSCHRIFT.join(' ')}</figcaption>
  </figure>;
}

/** Zwei Symbole mit „›“ dazwischen - die kleine Kette der Vorher-nachher-Karten. */
function KleineKette({ kette }: { kette: readonly MispelKnoten[] }) {
  return <svg className="vp-help-mispel-klein" viewBox="0 0 84 32" role="img" aria-label={kettenText(kette)}>
    {kette.map((knoten, i) => <g key={i}>
      <rect x={i * 52} y={0} width={32} height={32} rx={9} />
      <Icon name={SYMBOL[knoten]} size={18} x={i * 52 + 7} y={7} />
    </g>)}
    <path className="zwischen" d="M38 11 L45 16 L38 21" />
  </svg>;
}

function Zeichen({ erlaubt }: { erlaubt: boolean }) {
  return <svg className={`vp-help-mispel-zeichen ${erlaubt ? 'ja' : 'nein'}`} viewBox="0 0 22 22" role="img" aria-label={erlaubt ? 'ja' : 'nein'}>
    <circle cx={11} cy={11} r={11} />
    <path d={erlaubt ? 'M6.5 11.5 L9.5 14.5 L15.5 8' : 'M7.5 7.5 L14.5 14.5 M14.5 7.5 L7.5 14.5'} />
  </svg>;
}

function VorherNachher() {
  return <figure className="vp-help-diagram vp-help-mispel">
    <div className="vp-help-mispel-paar">
      {MISPEL_VORHER_NACHHER.map((karte, k) => <div key={karte.titel} className={k === 0 ? 'alt' : 'neu'}>
        <strong>{karte.titel}</strong>
        <ul>
          {karte.zeilen.map((zeile) => <li key={zeile.satz}>
            <KleineKette kette={zeile.kette} /><Zeichen erlaubt={zeile.erlaubt} /><span>{zeile.satz}</span>
          </li>)}
        </ul>
        <p>{karte.fazit}</p>
      </div>)}
    </div>
  </figure>;
}

const prozent = (stunde: number) => `${(stunde / 24 * 100).toFixed(3)}%`;
const uhrzeit = (stunde: number) => `${Math.floor(stunde)}${stunde % 1 ? `:${String(Math.round(stunde % 1 * 60)).padStart(2, '0')}` : ''} Uhr`;

function Tag() {
  const genutzt = MISPEL_TAG.abschnitte.filter((a) => a.art !== 'ruhe');
  const beschreibung = genutzt.map((a) => `${uhrzeit(a.von)} bis ${uhrzeit(a.bis)}: ${a.text}`).join('; ');
  return <figure className="vp-help-diagram vp-help-mispel vp-help-mispel-tag">
    <div className="kopf"><strong>{MISPEL_TAG.titel}</strong><span>Schema</span></div>
    <div className="band">
      <svg width="100%" height="44" role="img" aria-label={`Schema eines Tages: ${beschreibung}`}>
        {MISPEL_TAG.abschnitte.map((a) => <rect key={a.von} className={a.art} x={prozent(a.von)} y={0} width={prozent(a.bis - a.von)} height={44} />)}
        {genutzt.map((a) => <text key={a.von} className={`text ${a.art}`} x={prozent((a.von + a.bis) / 2)} y={22}>{a.text}</text>)}
      </svg>
    </div>
    <svg className="achse" width="100%" height="16" aria-hidden="true">
      {[0, 6, 12, 18, 24].map((h) => <text key={h} x={prozent(h)} y={12} textAnchor={h === 0 ? 'start' : h === 24 ? 'end' : 'middle'}>{h}</text>)}
    </svg>
    <ul className="legende">
      {MISPEL_TAG.legende.map((l) => <li key={l.art}><i className={l.art} aria-hidden="true" />{l.text}</li>)}
    </ul>
    <figcaption>{MISPEL_TAG.unterschrift}</figcaption>
  </figure>;
}

export type MispelBildArt = 'mispel-vorher-nachher' | 'mispel-wege' | 'mispel-tag';

export function MispelBild({ art }: { art: MispelBildArt }) {
  if (art === 'mispel-vorher-nachher') return <VorherNachher />;
  if (art === 'mispel-wege') return <Wege />;
  return <Tag />;
}
