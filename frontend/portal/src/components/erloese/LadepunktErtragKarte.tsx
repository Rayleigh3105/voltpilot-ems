import { VrKarte } from '../VerlaufRahmen';
import { betragText, euroText, kwhText, monatName, tagText } from '../../mispelMengen';
import {
  POSTEN_TITEL,
  menge,
  postenOffenText,
  type LadepunktErtraege,
  type LadepunktErtragTeil,
  type LadepunktPosten,
} from '../../ladepunktErtraege';
import './MispelKarte.css';
import './LadepunktErtragKarte.css';

/**
 * **Ladepunkt · Erträge im Monat** — die Karte unter „MiSpeL · Mengen nach Anlage 1“ in Verlauf › Erlöse (MP-41a,
 * Bedienkonzept BK-41 „in allen Varianten gleich“, Captain 04.10.2026): geladen (5), ins Haus (6) − (11), ins Netz (11),
 * Fremdtankstrom (12), was davon zählt (31)/(16) und was es gebracht hat — gegen dasselbe Haus, in dem das Auto nur lädt.
 *
 * ⚠ Keine eigene Rechnung — alle Zahlen kommen fertig aus der Route (`ladepunktErtraege.ts`).
 * ⚠ Ein Minus steht nie allein: ohne den Vergleich (Messlatte „nur laden“) keine Summe und kein Minus-Posten. Die
 *   Messlatte liest die Route seit MP-33e aus der Ablage je Viertelstunde (`ladepunkt_messlatte`); die Summe steht nur,
 *   wenn alle sechs Posten außer der Marktprämie bestimmt sind, sonst „offen“ mit Grund.
 */
export function LadepunktErtragKarte({ daten }: { daten: LadepunktErtraege }) {
  if (daten.teile.length === 0) return null;
  const name = monatName(daten.monat);
  const lp = daten.ladepunkte;
  const titel =
    lp.length > 1 ? `Ladepunkte · ${lp.map((l) => l.name).join(' und ')} · ${name}` : `Ladepunkt · ${lp[0]?.name ?? 'Wallbox'} · ${name}`;
  const stand = standChip(daten.teile);
  const vergleichDa = daten.vergleich.stand === 'bestimmt' && daten.vergleich.summe_eur != null;
  const vorbehalt = daten.posten.some((p) => p.vorbehalt);
  return (
    <VrKarte titel={titel} label="Erträge am Ladepunkt" className="vp-mi vp-lpe">
      <div className="vp-mi-kopf">
        <span className={`vp-mi-stand is-${stand.ton}`}>{stand.text}</span>
      </div>
      <div className="vp-mi-grid">
        <div>
          {daten.teile.map((t) => (
            <TeilMengen key={t.schluessel} teil={t} monat={daten.monat} mehrere={daten.teile.length > 1} />
          ))}
        </div>
        <div>
          <h3 className="vp-mi-label">Was es gebracht hat · Vergleich: dasselbe Haus, das Auto lädt nur</h3>
          <dl className="vp-mi-ledger vp-lpe-ledger">
            {daten.posten.map((p) => (
              <Posten key={p.schluessel} p={p} vergleichDa={vergleichDa} ust={daten.ust_pct ?? null} />
            ))}
            <dt className="vp-mi-sum">Gegenüber nur laden</dt>
            <dd className={`vp-mi-sum${vergleichDa ? '' : ' is-offen'}`} data-betrag="summe">
              {vergleichDa ? euroText(daten.vergleich.summe_eur) : 'offen'}
            </dd>
          </dl>
          {!vergleichDa && daten.vergleich.grund === 'messlatte_fehlt' && (
            <p className="vp-lpe-notiz" data-hinweis="ohne-vergleich">
              Eine Summe steht hier, sobald VoltPilot den Vergleich mit dem Haus rechnet, in dem das Auto nur lädt. Bis
              dahin zeigt die Karte die Mengen und die Posten, die schon feststehen.
            </p>
          )}
          {!vergleichDa && daten.vergleich.grund !== 'messlatte_fehlt' && (
            // MP-33e: der Vergleich ist da, aber ein anderer Posten ist offen — die Summe nennt dessen Grund.
            <p className="vp-lpe-notiz" data-hinweis="summe-offen">
              Keine Summe: {postenOffenText(daten.vergleich.grund)}.
            </p>
          )}
          {vorbehalt && (
            <p className="vp-lpe-notiz">
              <span className="vp-lpe-vorbehalt">Vorbehalt</span> Netzentgelt auf Rückspeisung aus Ladepunkten:
              Gesetzesfassung wird geprüft.
            </p>
          )}
        </div>
      </div>
      <p className="vp-lpe-fuss">
        Monatliche Mengenbestimmung nach Anlage 1 ·{' '}
        {[...new Set(daten.teile.map((t) => `Formelsatz ${t.formelsatz}`))].join(', ')} ·{' '}
        {daten.teile.every((t) => t.nur_ladepunkt) ? 'Z2 am Ladepunkt' : 'Z2 an Stromspeicher und Ladepunkt'}
      </p>
    </VrKarte>
  );
}

function standChip(teile: LadepunktErtragTeil[]): { text: string; ton: 'ok' | 'gelb' } {
  if (teile.every((t) => t.stand === 'endgueltig')) return { text: 'endgültig · Messstellenbetreiber', ton: 'ok' };
  return { text: teile.some((t) => t.wertequelle === 'geraet') ? 'vorläufig · Gerätewerte' : 'vorläufig', ton: 'gelb' };
}

function TeilMengen({ teil, monat, mehrere }: { teil: LadepunktErtragTeil; monat: string; mehrere: boolean }) {
  const rumpf = mehrere || !teil.erster_tag.endsWith('-01') || teil.schluessel !== monat;
  const m5 = menge(teil, '(5)');
  const m9 = menge(teil, '(9)');
  const m10 = menge(teil, '(10)');
  const m11 = menge(teil, '(11)');
  const m12 = menge(teil, '(12)');
  const m13 = menge(teil, '(13)');
  const m16 = menge(teil, '(16)');
  const m31 = menge(teil, '(31)');
  const allein = teil.nur_ladepunkt;
  return (
    <div className="vp-mi-teil" data-teil={teil.schluessel}>
      {rumpf && (
        <p className="vp-mi-rumpf">
          Rumpfmonat {tagText(teil.erster_tag)}–{tagText(teil.letzter_tag)} · Formelsatz {teil.formelsatz}
        </p>
      )}
      <p className="vp-lpe-satz">
        Erst ins Haus, dann ins Netz: <b>{kwhText(teil.ins_haus.kwh)}</b>{' '}
        {allein ? 'hat das Auto dem Haus gegeben' : 'haben Stromspeicher und Auto zusammen dem Haus gegeben'},{' '}
        <b>{kwhText(m11?.kwh)}</b> dem Netz.
      </p>
      <h3 className="vp-mi-label">
        {allein ? 'Mengen am Ladepunkt' : 'Stromspeicher und Ladepunkt zusammen (ein Zähler Z2, A1 S. 30–32)'}
      </h3>
      <ul className="vp-mi-leg" aria-label={allein ? 'Mengen am Ladepunkt' : 'Stromspeicher und Ladepunkt zusammen'}>
        <Zeile
          art="geladen"
          wort="Geladen"
          formel={`(5) ${m5?.begriff ?? ''} · davon aus dem Netz (9) ${kwhText(m9?.kwh)}, Sonnenstrom (10) ${kwhText(m10?.kwh)}`}
          kwh={m5?.kwh}
        />
        <Zeile art="haus" wort="Ins Haus" formel={`${teil.ins_haus.nr}: zurückgegeben und im Haus verbraucht`} kwh={teil.ins_haus.kwh} />
        <Zeile art="netz" wort="Ins Netz" formel={`(11) ${m11?.begriff ?? ''}`} kwh={m11?.kwh} />
        <Zeile
          art="fremd"
          wort="Fremdtankstrom"
          formel="(12) mehr zurückgegeben als hier geladen: Strom von anderswo — zählt nicht"
          kwh={m12?.kwh}
        />
      </ul>
      <h3 className="vp-mi-label vp-lpe-zaehlt">Davon zählt bei der Einspeisung</h3>
      <ul className="vp-mi-leg" aria-label="Davon zählt bei der Einspeisung">
        <Zeile art="gelb" wort="förderfähig" formel={`(31) ${m31?.begriff ?? ''}`} kwh={m31?.kwh} genau />
        <Zeile art="rot" wort="saldierungsfähig" formel={`(16) ${m16?.begriff ?? ''} · senkt Umlagen auf (20)`} kwh={m16?.kwh} genau />
      </ul>
      <p className="vp-lpe-formel">
        Wirkungsgrad pauschal 0,85 (14) · {kwhText(m13?.kwh)} berücksichtigungsfähig (13) = (11) − (12) Fremdtankstrom. Der
        Strom, mit dem Sie fahren, bleibt voll mit Umlagen und Netzentgelt belastet.
      </p>
    </div>
  );
}

function Zeile({
  art,
  wort,
  formel,
  kwh,
  genau = false,
}: {
  art: string;
  wort: string;
  formel: string;
  kwh: number | null | undefined;
  genau?: boolean;
}) {
  return (
    <li data-menge={art}>
      <span className={`vp-mi-q vp-lpe-q is-${art}`} aria-hidden="true" />
      <span>
        {wort}
        <span className="vp-mi-f">{formel}</span>
      </span>
      <span className="vp-mi-z">{genau ? kwhGenau(kwh) : kwhText(kwh)}</span>
    </li>
  );
}

/** Kleine Mengen mit einer Nachkommastelle wie im Bedienkonzept (BK-41: „10,2 kWh“), große ganz; „offen“ bleibt offen. */
function kwhGenau(kwh: number | null | undefined): string {
  if (kwh == null || Math.abs(kwh) >= 100) return kwhText(kwh);
  return `${kwh.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}\u00a0kWh`;
}

function ct(v: number): string {
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 3 })} ct`;
}

/** Die Unterzeile eines Postens: Menge, Formel und Satz — oder warum er offen ist. */
function unterzeile(p: LadepunktPosten, ust: number | null): string {
  if (p.schluessel === 'marktpraemie') {
    const auf = `auf ${kwhGenau(p.menge_kwh)} ${p.formel ?? '(31)'}`;
    return p.stand === 'bestimmt' && p.satz_ct != null
      ? `${auf} × ${ct(p.satz_ct)} (AW − Jahresmarktwert)`
      : `${auf} · ${postenOffenText(p.grund)}`;
  }
  if (p.stand !== 'bestimmt') return postenOffenText(p.grund);
  const satz = p.satz_ct != null ? ` · ${ct(p.satz_ct)}` : '';
  const brutto = ust != null ? ` · inkl. ${ust.toLocaleString('de-DE')} % USt` : '';
  switch (p.schluessel) {
    case 'weniger_gekauft':
      return `${kwhText(p.menge_kwh)} ins Haus statt aus dem Netz${satz}`;
    case 'mehr_geladen':
      return `${kwhText(p.menge_kwh)} zusätzlich geladen, um sie zurückzugeben${satz}`;
    case 'ins_netz_verkauft':
      return `${kwhText(p.menge_kwh)} ${p.formel ?? '(11)'} über Ihren Direktvermarkter${satz}`;
    case 'vermiedene_umlagen':
      return `${kwhGenau(p.menge_kwh)} umlagereduzierende Strommenge ${p.formel ?? '(20)'}${satz}${brutto}`;
    case 'vermiedenes_netzentgelt':
      return `${kwhGenau(p.menge_kwh)} ${p.formel ?? '(20)'} × Arbeitspreis${satz}${brutto}`;
    case 'akku_verschleiss':
      return `Schätzung je zurückgegebener kWh · ${kwhText(p.menge_kwh)}${satz}`;
    default:
      return '';
  }
}

function Posten({ p, vergleichDa, ust }: { p: LadepunktPosten; vergleichDa: boolean; ust: number | null }) {
  // Ein Minus steht nie allein: ohne die Summe des Vergleichs bleibt ein negativer Posten offen.
  const minusAllein = !vergleichDa && p.eur != null && p.eur < 0;
  const text = minusAllein ? 'offen' : betragText(p);
  return (
    <>
      <dt>
        {POSTEN_TITEL[p.schluessel]}
        {p.vorbehalt && <span className="vp-lpe-vorbehalt">Vorbehalt</span>}
        <span className="vp-mi-f">{unterzeile(p, ust)}</span>
      </dt>
      <dd data-betrag={p.schluessel} className={text === 'offen' ? 'is-offen' : undefined}>
        {text}
      </dd>
    </>
  );
}
