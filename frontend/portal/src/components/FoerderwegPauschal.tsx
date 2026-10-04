import { Input } from '../../designsystem/components/forms/Input';
import { zahl as zahlEingabe } from '../zahl';
import {
  FALL_BEGRIFF,
  GRENZE_KWP,
  pauschalgrenzen,
  rumpfjahrGrenzen,
  zahl,
  type Fallkonstellation,
  type Pauschalgrenzen,
} from '../mispelPauschal';

/**
 * Die Schritte der Pauschaloption im Dialog „Förderweg ändern“ (MP-27, Bedienkonzept BK-27, in allen Varianten
 * gleich): „Voraussetzungen“ (Anlage 2 Abschn. 3.1.1, S. 18–19), „Pauschalgrenzen“ (A2 S. 28–30) und der Wartestand
 * „vorgemerkt, Termin offen“ mit dem ersten Jahr als Rumpfjahr (A2 S. 51–55). Nur Darstellung; den Zustand hält der
 * Dialog.
 */

/** Was der Aufbau zur Pauschaloption sagt: Solarleistung (Summe der PV-Assets), Speicherkapazität, Arten. */
export interface PauschalAufbau {
  pvKwp: number | null;
  speicherKwh: number | null;
  arten: string[];
}

/** Die Angaben des Kunden in „Voraussetzungen“. */
export interface PauschalAngaben {
  steckersolar: 'nein' | 'ja' | null;
  steckersolarKwp: string;
  einBetreiber: boolean;
  steckersolarDv: boolean;
}

/**
 * Erzeuger außer Solar schließen die Pauschaloption aus (Voraussetzung 1, A2 S. 18); Speicher, Ladepunkte und
 * Verbraucher nicht. Der Aufbau kennt kein geschlossenes Vokabular — darum zählen nur bekannte fremde Erzeuger.
 */
const FREMDE_ERZEUGER = new Set(['chp', 'bhkw', 'wind', 'wind_turbine', 'generator', 'fuel_cell', 'brennstoffzelle']);

export function steckersolarKwp(a: PauschalAngaben): number | null {
  if (a.steckersolar === 'nein') return 0;
  if (a.steckersolar !== 'ja') return null;
  const v = zahlEingabe(a.steckersolarKwp);
  return v != null && v > 0 && v <= GRENZE_KWP ? Math.round(v * 1000) / 1000 : null;
}

/** Die Fallkonstellation aus dem Aufbau: mit Stromspeicher P1 (A2 Abschn. 4.1.1); ohne ihn offen. */
export function fallAusAufbau(aufbau: PauschalAufbau): Fallkonstellation | null {
  return aufbau.speicherKwh != null && aufbau.speicherKwh > 0 ? 'P1' : null;
}

export interface VoraussetzungUrteil {
  /** Weiter nur, wenn nichts fehlt und nichts dagegen spricht. */
  weiter: boolean;
  ueber30: boolean;
  unbekannt: boolean;
}

export function voraussetzungUrteil(aufbau: PauschalAufbau, a: PauschalAngaben): VoraussetzungUrteil {
  const unbekannt = aufbau.pvKwp == null;
  const ueber30 = aufbau.pvKwp != null && aufbau.pvKwp > GRENZE_KWP;
  const stecker = steckersolarKwp(a);
  const fremd = aufbau.arten.some((x) => FREMDE_ERZEUGER.has(x));
  const weiter =
    !unbekannt && !ueber30 && !fremd && stecker != null && a.einBetreiber && (stecker === 0 || a.steckersolarDv);
  return { weiter, ueber30, unbekannt };
}

type Ton = 'ok' | 'nein' | 'frage' | 'warn' | 'info';

function Punkt({ ton, titel, satz, fundstelle }: { ton: Ton; titel: string; satz: string; fundstelle: string }) {
  return (
    <li className={`vp-fw-punkt is-${ton}`} data-ton={ton}>
      <b>{titel}</b>
      <span>{satz}</span>
      <small>{fundstelle}</small>
    </li>
  );
}

export function VoraussetzungenSchritt({
  aufbau,
  angaben,
  onAngaben,
  basis,
}: {
  aufbau: PauschalAufbau;
  angaben: PauschalAngaben;
  onAngaben: (a: PauschalAngaben) => void;
  basis: string;
}) {
  const u = voraussetzungUrteil(aufbau, angaben);
  const kwp = aufbau.pvKwp;
  const fremd = aufbau.arten.filter((x) => FREMDE_ERZEUGER.has(x));
  const speicher = aufbau.speicherKwh != null ? `Speicher ${zahl(aufbau.speicherKwh, 1)} kWh` : 'kein Speicher';
  const set = (teil: Partial<PauschalAngaben>) => onAngaben({ ...angaben, ...teil });
  return (
    <>
      <p className="vp-fw-frage">
        Die Pauschaloption hat feste Voraussetzungen (Anlage 2, Abschnitt 3.1). Zwei prüfen wir aus Ihrem Aufbau, den Rest
        bestätigen Sie:
      </p>
      <ul className="vp-fw-pruefliste" data-testid="fw-voraussetzungen">
        {u.unbekannt ? (
          <Punkt
            ton="frage"
            titel="Solarleistung fehlt im Aufbau"
            satz="Ohne die installierte Solarleistung lässt sich die Grenze von 30 kWp nicht prüfen. Bitte tragen Sie sie unter Anlage › Aufbau nach."
            fundstelle="Voraussetzung 3 · Anlage 2 S. 19"
          />
        ) : (
          <Punkt
            ton={u.ueber30 ? 'nein' : 'ok'}
            titel={`Solarleistung ${zahl(kwp ?? 0, 1)} kWp — ${u.ueber30 ? 'mehr als' : 'höchstens'} 30 kWp`}
            satz={
              u.ueber30
                ? 'Die Pauschaloption gilt nur bis 30 kWp; Steckersolargeräte zählen dabei nicht mit. Für Ihre Anlage passt die Abgrenzungsoption (Anlage 1) — sie braucht einen zweiten Zähler am Speicher.'
                : `Aus Ihrem Aufbau: ${zahl(kwp ?? 0, 1)} kWp. Steckersolargeräte zählen für diese Grenze nicht mit.`
            }
            fundstelle="Voraussetzung 3 · Anlage 2 S. 19, Fn. 14 · § 19 Abs. 3c S. 2 Nr. 3 EEG"
          />
        )}
        <Punkt
          ton={fremd.length > 0 ? 'nein' : 'ok'}
          titel="Nur Solar, Speicher und Ladepunkte"
          satz={
            fremd.length > 0
              ? `In Ihrem Aufbau steht noch ein anderer Erzeuger (${fremd.join(', ')}). Dann gilt die Pauschaloption nicht.`
              : `Aus Ihrem Aufbau: Solar, ${speicher}. Kein Blockheizkraftwerk, kein Windrad.`
          }
          fundstelle="Voraussetzung 1 · Anlage 2 S. 18 · § 19 Abs. 3c S. 2 Nr. 1 EEG"
        />
      </ul>

      <fieldset className="vp-fw-stecker" aria-labelledby={`${basis}-stecker`}>
        <legend id={`${basis}-stecker`}>Steckersolargeräte (Balkonkraftwerke) hinter Ihrem Zähler</legend>
        <p className="vp-fw-klein">
          Für die 30-kWp-Grenze zählen sie nicht, für die Förder-Grenze (P1) zählen sie mit (Anlage 2 S. 19, Fn. 14; S. 27).
          Hier nur Geräte, die nicht schon im Aufbau stehen.
        </p>
        <div className="vp-fw-wahlen is-reihe" role="radiogroup" aria-labelledby={`${basis}-stecker`}>
          {(['nein', 'ja'] as const).map((w) => (
            <label key={w} className={`vp-fw-wahl is-kurz${angaben.steckersolar === w ? ' is-gewaehlt' : ''}`}>
              <input
                type="radio"
                name={`${basis}-stecker`}
                value={w}
                checked={angaben.steckersolar === w}
                onChange={() => set({ steckersolar: w })}
              />
              <span className="vp-fw-wahl-text">
                <b>{w === 'nein' ? 'Keine' : 'Ja, zusätzlich'}</b>
              </span>
            </label>
          ))}
        </div>
        {angaben.steckersolar === 'ja' && (
          <Input
            label="Installierte Leistung der Steckersolargeräte (kWp)"
            inputMode="decimal"
            placeholder="z. B. 0,8"
            value={angaben.steckersolarKwp}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ steckersolarKwp: e.target.value })}
          />
        )}
      </fieldset>

      <ul className="vp-fw-pruefliste">
        <Punkt
          ton="frage"
          titel="Alles gehört derselben Person"
          satz="Alle Solaranlagen, Speicher und Ladepunkte hinter Ihrem Zähler betreibt dieselbe Person. Das können wir nicht sehen — bitte bestätigen."
          fundstelle="Voraussetzung 2 · Anlage 2 S. 18 · § 19 Abs. 3c S. 2 Nr. 2 EEG"
        />
      </ul>
      <label className="vp-fw-haken">
        <input type="checkbox" checked={angaben.einBetreiber} onChange={(e) => set({ einBetreiber: e.target.checked })} />
        <span>
          <b>Ja, ich betreibe alle Anlagen hinter meinem Zähler selbst.</b>
        </span>
      </label>
      {angaben.steckersolar === 'ja' && (
        <>
          <ul className="vp-fw-pruefliste">
            <Punkt
              ton="warn"
              titel="Auch das Steckersolargerät in die Direktvermarktung"
              satz="Es darf nicht mehr unentgeltlich einspeisen: Ihr Direktvermarkter nimmt es mit auf, ungefördert."
              fundstelle="Voraussetzung 4 · Anlage 2 S. 19, Fn. 15"
            />
          </ul>
          <label className="vp-fw-haken">
            <input
              type="checkbox"
              checked={angaben.steckersolarDv}
              onChange={(e) => set({ steckersolarDv: e.target.checked })}
            />
            <span>
              <b>Mein Direktvermarkter nimmt das Steckersolargerät mit auf.</b>
              <small>ungefördert, nach den allgemeinen Regeln für Solaranlagen</small>
            </span>
          </label>
        </>
      )}
      <ul className="vp-fw-pruefliste">
        <Punkt
          ton="info"
          titel="Ein Zähler genügt — mit Viertelstundenwerten"
          satz="Zweirichtungszähler am Hausanschluss mit Viertelstundenwerten. Steht am Speicher ein zweiter geeichter Zähler, gilt die genauere Abgrenzungsoption."
          fundstelle="Anlage 2 S. 22, Abschn. 3.2.3 · S. 27"
        />
        <Punkt
          ton="info"
          titel="Keine Einspeisevergütung, kein Mieterstrom mehr"
          satz="Die Einspeisevergütung endet mit dem Wechsel; der Netzbetreiber nimmt keinen Strom mehr ab."
          fundstelle="Voraussetzung 4 · Anlage 2 S. 19"
        />
      </ul>
      {u.ueber30 && (
        <p className="vp-fw-fehler" role="alert" data-testid="fw-ueber-30">
          Mit dieser Anlage geht es hier nicht weiter. Zurück zu Schritt 1 und einen anderen Förderweg wählen.
        </p>
      )}
    </>
  );
}

export function PauschalgrenzenSchritt({ aufbau, steckersolar }: { aufbau: PauschalAufbau; steckersolar: number }) {
  const fall = fallAusAufbau(aufbau);
  const pinst = aufbau.pvKwp == null ? null : aufbau.pvKwp + steckersolar;
  const g = fall ? pauschalgrenzen(fall, pinst, aufbau.speicherKwh) : null;
  if (!fall || !g) {
    return (
      <p className="vp-fw-satz" data-testid="fw-grenzen-offen">
        Die Pauschalgrenzen lassen sich noch nicht rechnen: Für die Fallkonstellation P1 „Stromspeicher“ braucht es die
        Solarleistung und die Speicherkapazität aus dem Aufbau (Anlage 2 Abschn. 4.1.1, S. 25).
      </p>
    );
  }
  const p3 = pauschalgrenzen('P3', pinst, aufbau.speicherKwh);
  return (
    <>
      <p className="vp-fw-frage">
        <b>
          Fallkonstellation {fall} · {FALL_BEGRIFF[fall]}
        </b>{' '}
        — aus Ihrem Aufbau. Damit gelten für jedes Kalenderjahr:
      </p>
      <GrenzenTabelle g={g} />
      {steckersolar > 0 && (
        <p className="vp-fw-klein">
          {zahl(g.pinst, 1)} kWp: Hier zählt das Steckersolargerät mit (Anlage 2 S. 27, Fn. 14).
        </p>
      )}
      <p className="vp-fw-hinweis">
        Bis {zahl(Math.round(g.p1))} kWh Einspeisung gibt es die Marktprämie, die nächsten {zahl(Math.round(g.p3))} kWh
        weder Prämie noch Saldierung, darüber senkt jede kWh die Umlagen auf Ihren Netzbezug.
        {p3 && (
          <>
            {' '}
            Kommt ein bidirektionaler Ladepunkt dazu, gilt P3: (P2)P3 = MIN [ {zahl(g.p2, 3)} ; 0,2 ] = {zahl(p3.p2, 3)}
            {p3.p2 === g.p2 ? ' — Ihre Grenzen bleiben gleich.' : '.'}
          </>
        )}
      </p>
    </>
  );
}

function GrenzenTabelle({ g }: { g: Pauschalgrenzen }) {
  const zeilen: [string, string, string, string][] = [
    ['Förderfähigkeit', '(P1)', `${zahl(g.pinst, 1)} kWp × 500`, zahl(Math.round(g.p1))],
    [
      'Rechengröße',
      g.p2Name,
      g.p2Name === '(P2)P2' ? 'fest' : `0,1 × ${zahl(g.pinst, 1)} / ${zahl(g.skinst ?? 0, 1)}`,
      zahl(g.p2, 3),
    ],
    ['Indifferenzbereich', '(P3)', `${zahl(g.p2, 3)} × ${zahl(Math.round(g.p1))}`, zahl(Math.round(g.p3))],
    ['Saldierungsfähigkeit', '(P4)', `${zahl(Math.round(g.p1))} + ${zahl(Math.round(g.p3))}`, zahl(Math.round(g.p4))],
  ];
  return (
    <table className="vp-fw-grenzen" data-testid="fw-grenzen">
      <thead>
        <tr>
          <th scope="col">Pauschalgrenze</th>
          <th scope="col">Rechenweg</th>
          <th scope="col" className="is-n">
            kWh/Jahr
          </th>
        </tr>
      </thead>
      <tbody>
        {zeilen.map(([begriff, nr, weg, wert]) => (
          <tr key={nr}>
            <th scope="row">
              {begriff} <small>{nr}</small>
            </th>
            <td className="vp-fw-formel">{weg}</td>
            <td className="is-n">{wert}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** „Prüfen“ der Pauschaloption mit offenem Termin: Wartestand, Rumpfjahr-Beispiel, Folgen. */
export function PauschalPruefen({
  heuteBegriff,
  aufbau,
  steckersolar,
  heute,
  dv,
  bilanzkreis,
}: {
  heuteBegriff: string;
  aufbau: PauschalAufbau;
  steckersolar: number;
  heute: string;
  dv: string;
  bilanzkreis: boolean;
}) {
  const fall = fallAusAufbau(aufbau);
  const pinst = aufbau.pvKwp == null ? null : aufbau.pvKwp + steckersolar;
  const g = fall ? pauschalgrenzen(fall, pinst, aufbau.speicherKwh) : null;
  const jahr = Number(heute.slice(0, 4)) + 1;
  const beispiele: [string, string][] = [
    ['Februar', `${jahr}-03-01`],
    ['Juni', `${jahr}-07-01`],
    ['Oktober', `${jahr}-11-01`],
  ];
  return (
    <>
      <div className="vp-fw-ab">
        <span>Gilt ab</span>
        <b data-testid="fw-gilt-ab">Termin offen</b>
      </div>
      <dl className="vp-fw-kv">
        <div>
          <dt>Der Tag</dt>
          <dd>der Monatserste nach der Genehmigung der EU-Kommission (Tenor Ziff. 9b) — er steht noch nicht fest</dd>
        </div>
        <div>
          <dt>Bis dahin</dt>
          <dd>bleibt alles, wie es ist: {heuteBegriff}</dd>
        </div>
        <div>
          <dt>Dann ändert sich</dt>
          <dd>Direktvermarktung, Marktprämie mit Jahresmarktwert, Netzladen nach Ihrer Einstellung</dd>
        </div>
        <div>
          <dt>Direktvermarkter</dt>
          <dd>{dv.trim() || 'nicht angegeben'}</dd>
        </div>
        <div>
          <dt>Gesonderter Bilanzkreis</dt>
          <dd>{bilanzkreis ? 'ja' : 'nicht bestätigt'}</dd>
        </div>
      </dl>
      {g && (
        <>
          <p className="vp-fw-hinweis is-warn" data-testid="fw-rumpfjahr">
            <b>Ihr erstes Jahr ist ein Rumpfjahr.</b> Die Förder-Grenze verteilt sich nur auf April bis September (Anlage 2
            S. 54). Beginnt die Pauschaloption spät im Jahr, ist bis Silvester wenig oder nichts förderfähig:
          </p>
          <table className="vp-fw-grenzen">
            <thead>
              <tr>
                <th scope="col">Beispiel {jahr}</th>
                <th scope="col" className="is-n">
                  förderfähig bis (P1)R
                </th>
                <th scope="col" className="is-n">
                  saldiert ab (P4)R
                </th>
              </tr>
            </thead>
            <tbody>
              {beispiele.map(([monat, von]) => {
                const r = rumpfjahrGrenzen(von, `${jahr}-12-31`, g);
                return (
                  <tr key={von}>
                    <th scope="row">
                      Genehmigung im {monat} → ab {von.slice(8, 10)}.{von.slice(5, 7)}.
                      <small>
                        {r.tage} Tage, davon {r.sommer} im Sommer
                      </small>
                    </th>
                    <td className="is-n">{zahl(Math.round(r.p1r))}</td>
                    <td className="is-n">{zahl(Math.round(r.p4r))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="vp-fw-klein">
            kWh im Rumpfjahr; ab dem 1. Januar danach gilt wieder das ganze Jahr: {zahl(Math.round(g.p1))} /{' '}
            {zahl(Math.round(g.p4))}.
          </p>
        </>
      )}
      <p className="vp-fw-satz">
        Sobald der Termin feststeht, steht er hier und in Ihren Einstellungen. Erst dann wechselt Ihr Förderweg; bis
        dahin können Sie die Vormerkung jederzeit zurücknehmen.
      </p>
    </>
  );
}
