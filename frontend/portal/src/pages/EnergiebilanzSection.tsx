import { EnergiebilanzFuss } from '../components/EnergiebilanzFuss';
import { Recht } from '../components/Recht';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Bilanz, type Funktionen, type Site } from '../api';
import {
  ENERGIEBILANZ_UNTERZEILE,
  HERKUNFT_EINGAENGE,
  KARTE_WORT,
  RECHT_REST_ANLEGEN,
  RECHT_STELLUNG,
  REST_ANLEGEN,
  REST_NICHT_ANGELEGT,
  REST_OHNE_HAUPTZAEHLER_SATZ,
  REST_OHNE_RECHT,
  UNTERZAEHLER_TITEL,
  WORAUS,
  ZAEHLER_ZUORDNEN,
  darf,
  energiebilanzBild,
  kennzeichenTeile,
  energiebilanzHash,
  restAngelegtSatz,
  standortDerAnlage,
  zeitraumAus,
  type AbschnittBild,
  type AusserhalbBild,
  type HauptzaehlerBild,
  type KartenZeile,
  type MessstellenArt,
  type TagBild,
  type TeilBild,
  type Ton,
  type VorschlagBild,
  type ZeileBild,
} from '../anlageEnergiebilanz';
import { GeteiltesRegisterHinweis } from '../components/GeteiltesRegisterHinweis';
import { HerkunftsZeile } from '../components/HerkunftsZeile';
import { ZeitSegment } from '../components/HistorieWelt';
import { UEMS_ENERGIEBILANZ } from '../glossar';
import { heuteIn } from '../kennzahlKarte';
import { hashForRoute, standortMessstellenRoute } from '../nav';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { BILANZ_PERIODEN, NICHT_ABRUFBAR, blaettere, laeuftNoch, letzterGebildeter, zeitraumText, type BilanzPeriode } from '../uebersichtBausteine';
import { VORGABE_ZEITZONE } from '../uemsOrtsbaum';
import { useBerichtRechte } from '../useBerichtRechte';
import './EnergiebilanzSection.css';

/**
 * Anlage › Verlauf › **Energiebilanz** (UEMS AP-13 IP-8 = AP-10 IP-14; Konzept Auswerten a1 §6.9): erfassen die Zähler den
 * ganzen Bezug dieser Anlage? Kopf mit Unterzeile und Menü ⋯, Zeitwahl, Antwortsatz, Zwei-Teile-Balken mit drei Zeilen,
 * die Unterzähler nach Menge, die Abzweige benannt, „Woraus gerechnet“ zugeklappt, Netzanschluss und Zeitzone am Fuß.
 * Geldfrei.
 *
 * Die Ableitung ist `anlageEnergiebilanz.ts` - hier wird nur gerendert und geladen: die Bilanz-Route je Zeitraum, das
 * Register der Anlage (gemessen/berechnet und Name je Messstelle), die Funktionen (Standort der Anlage) und die
 * Selbstauskunft (Rechte).
 */
export function EnergiebilanzSection({ site }: { site: Pick<Site, 'id' | 'name'> }) {
  const [zone, setZone] = useState(VORGABE_ZEITZONE);
  const heute = heuteIn(zone, Date.now());
  const [wahl, setWahl] = useState(() => zeitraumAus(window.location.hash, heuteIn(VORGABE_ZEITZONE, Date.now())));
  const [bilanz, setBilanz] = useState<Bilanz | 'fehler' | null>(null);
  const [neuLaden, setNeuLaden] = useState(0);
  const [arten, setArten] = useState<ReadonlyMap<string, MessstellenArt>>(() => new Map());
  const [namen, setNamen] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [funktionen, setFunktionen] = useState<Funktionen | null>(null);
  const [rueckmeldung, setRueckmeldung] = useState<{ text: string; ton: Ton } | null>(null);
  const [legtAn, setLegtAn] = useState(false);
  const rechte = useBerichtRechte();

  useEffect(() => {
    let aktiv = true;
    api.messstellenRegister({ anlage: site.id }).then(
      (r) => {
        if (!aktiv) return;
        setArten(new Map(r.register.map((z) => [z.kennzeichen, z.art])));
        setNamen(new Map(r.register.filter((z) => z.name).map((z) => [z.kennzeichen, z.name as string])));
      },
      () => undefined,
    );
    api.funktionen().then(
      (f) => aktiv && setFunktionen(f),
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
  }, [site.id]);

  useEffect(() => {
    let aktiv = true;
    setBilanz(null);
    api.anlageBilanz(site.id, wahl.periode, wahl.am).then(
      (b) => {
        if (!aktiv) return;
        setZone(b.zeitzone);
        setBilanz(b);
      },
      () => aktiv && setBilanz('fehler'),
    );
    return () => {
      aktiv = false;
    };
  }, [site.id, wahl.periode, wahl.am, neuLaden]);

  const bild = useMemo(
    () => (bilanz && bilanz !== 'fehler' ? energiebilanzBild(bilanz, { heute: heuteIn(bilanz.zeitzone, Date.now()), arten, namen }) : null),
    [bilanz, arten, namen],
  );
  const standortId = standortDerAnlage(funktionen, site.id);
  const zuordnen = standortId && darf(rechte, standortId, RECHT_STELLUNG) ? hashForRoute(standortMessstellenRoute(standortId)) : null;
  const menue: RowMenuItem[] = zuordnen
    ? [{ label: ZAEHLER_ZUORDNEN, icon: 'link', onClick: () => window.location.assign(zuordnen) }]
    : [];

  const waehle = (periode: BilanzPeriode, am: string) => {
    setWahl({ periode, am });
    setRueckmeldung(null);
    replaceCurrentNavigation(energiebilanzHash(site.id, periode, am));
  };

  const restAnlegen = async (v: VorschlagBild) => {
    setLegtAn(true);
    try {
      const r = await api.anlageRestAnlegen(site.id, { hauptzaehler_id: v.hauptzaehlerId, name: v.name });
      setRueckmeldung({ text: restAngelegtSatz(r.neu, r.messstelle.kennzeichen, r.messstelle.name), ton: 'ok' });
      setNeuLaden((n) => n + 1);
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { code?: string } | undefined)?.code : undefined;
      const text =
        code === 'rest_ohne_hauptzaehler' ? REST_OHNE_HAUPTZAEHLER_SATZ : e instanceof ApiError && e.status === 403 ? REST_OHNE_RECHT : REST_NICHT_ANGELEGT;
      setRueckmeldung({ text, ton: 'warn' });
    } finally {
      setLegtAn(false);
    }
  };

  return (
    <section className="vp-bil" aria-labelledby="vp-eb-titel" data-testid="energiebilanz">
      <div className="vp-bil-kopf">
        <div className="vp-bil-kopf-text">
          <h2 id="vp-eb-titel" className="vp-bil-titel">
            {UEMS_ENERGIEBILANZ}
          </h2>
          <p className="vp-bil-meta">{ENERGIEBILANZ_UNTERZEILE}</p>
        </div>
        {menue.length > 0 && (
          <span className="vp-bil-menue" data-testid="energiebilanz-menue">
            <RowMenu label="Weitere Aktionen" buttonClassName="vp-bil-menue-knopf" items={menue} />
          </span>
        )}
      </div>

      <div className="vp-bil-zeitleiste" role="group" aria-label="Zeitraum">
        <ZeitSegment label="Zeitraum" optionen={BILANZ_PERIODEN} wert={wahl.periode} onWert={(p) => waehle(p, letzterGebildeter(p, heute))} />
        <div className="vp-bil-zeitnav">
          <button type="button" className="vp-eb-schritt" aria-label="Vorheriger Zeitraum" onClick={() => waehle(wahl.periode, blaettere(wahl.periode, wahl.am, -1))}>
            <Icon name="chevron-left" size={18} />
          </button>
          <span className="vp-bil-zeitraum" aria-live="polite" data-testid="energiebilanz-zeitraum">
            {zeitraumText(wahl.periode, wahl.am)}
          </span>
          <button
            type="button"
            className="vp-eb-schritt"
            aria-label="Nächster Zeitraum"
            disabled={laeuftNoch(wahl.periode, wahl.am, heute)}
            onClick={() => waehle(wahl.periode, blaettere(wahl.periode, wahl.am, 1))}
          >
            <Icon name="chevron-right" size={18} />
          </button>
        </div>
      </div>

      {rueckmeldung && (
        <p className={`vp-bil-rueckmeldung is-${rueckmeldung.ton}`} role="status" data-testid="energiebilanz-rueckmeldung">
          {rueckmeldung.text}
        </p>
      )}

      {bilanz === null ? (
        <div className="vp-bil-laedt" role="status" aria-busy="true">
          <span className="vp-sr-only">Wird geladen …</span>
          <span className="vp-bil-skelett is-satz" aria-hidden="true" />
          <span className="vp-bil-skelett is-karte" aria-hidden="true" />
          <span className="vp-bil-skelett is-liste" aria-hidden="true" />
        </div>
      ) : bilanz === 'fehler' || !bild ? (
        <div className="vp-bil-karte" role="alert">
          <p className="vp-bil-leise">{NICHT_ABRUFBAR}</p>
          <button type="button" className="vp-eb-knopf" onClick={() => setNeuLaden((n) => n + 1)}>
            Erneut versuchen
          </button>
        </div>
      ) : bild.leer ? (
        <div className="vp-bil-karte vp-bil-leer" data-testid="energiebilanz-leer">
          <p className="vp-bil-leer-titel">{bild.leer.titel}</p>
          <p className="vp-bil-leise">{bild.leer.satz}</p>
          {bild.leer.schritt && standortId && darf(rechte, standortId, RECHT_STELLUNG) && (
            <a className="vp-bil-knopf" href={hashForRoute(standortMessstellenRoute(standortId))}>
              {bild.leer.schritt}
            </a>
          )}
        </div>
      ) : (
        bild.hauptzaehler.map((hz) => (
          <Hauptzaehler
            key={hz.key}
            hz={hz}
            zeitraum={bild.zeitraum}
            laeuft={bild.laeuft}
            darfAnlegen={darf(rechte, standortId, RECHT_REST_ANLEGEN)}
            legtAn={legtAn}
            onAnlegen={restAnlegen}
          />
        ))
      )}

      {bilanz && bilanz !== 'fehler' && bild && <EnergiebilanzFuss anlage={site.id} am={bilanz.am} zone={bild.zone} />}
    </section>
  );
}

function Hauptzaehler({
  hz,
  zeitraum,
  laeuft,
  darfAnlegen,
  legtAn,
  onAnlegen,
}: {
  hz: HauptzaehlerBild;
  zeitraum: string;
  laeuft: string | null;
  darfAnlegen: boolean;
  legtAn: boolean;
  onAnlegen: (v: VorschlagBild) => void;
}) {
  const formal = `${hz.titel} · ${zeitraum}`;
  // Ein Zeitraum ohne Stellungswechsel hat genau einen Abschnitt mit genau einem Tag: er trägt die ganze Antwort.
  const einzeln = !hz.hinweis && hz.abschnitte.length === 1 && hz.abschnitte[0].tage.length === 1 ? hz.abschnitte[0] : null;
  const tag = einzeln?.tage[0] ?? null;
  return (
    <article className="vp-bil-hz" data-testid="energiebilanz-hauptzaehler" aria-label={hz.titel}>
      {laeuft ? (
        <>
          {/* Der laufende Zeitraum hat noch keine Zahlen - der Weg des Teils ohne eigenen Zähler (mit der Live-Zeile)
              und die Abzweige der heutigen Stellung gelten trotzdem. */}
          <Antwort satz={laeuft} ton="off" formal={formal} testid="energiebilanz-laeuft" kennzeichen={[hz.kennzeichen]} />
          <RestWegKarte hz={hz} darfAnlegen={darfAnlegen} legtAn={legtAn} onAnlegen={onAnlegen} />
          <Ausserhalb ab={hz.abschnitte[hz.abschnitte.length - 1]?.ausserhalb ?? null} />
        </>
      ) : tag && einzeln ? (
        <>
          <Antwort satz={tag.antwort.satz} ton={tag.antwort.ton} formal={formal} testid="energiebilanz-antwort" kennzeichen={tag.kennzeichen} />
          <GeteiltesRegisterHinweis saetze={einzeln.geteilt} />
          <div className="vp-bil-raster">
            <BilanzKarte tag={tag} hz={hz} darfAnlegen={darfAnlegen} legtAn={legtAn} onAnlegen={onAnlegen} />
            <Unterzaehler teile={tag.unterzaehler} zeitraum={zeitraum} />
          </div>
          <Ausserhalb ab={einzeln.ausserhalb} />
          <Woraus zeilen={tag.zeilen} />
        </>
      ) : (
        <>
          <Antwort satz={hz.hinweis ?? zeitraum} ton="off" formal={formal} testid="energiebilanz-antwort" kennzeichen={[hz.kennzeichen]} />
          {hz.abschnitte.map((ab) => (
            <Abschnitt key={ab.key} ab={ab} />
          ))}
          <RestWegKarte hz={hz} darfAnlegen={darfAnlegen} legtAn={legtAn} onAnlegen={onAnlegen} />
        </>
      )}
    </article>
  );
}

function Antwort({ satz, ton, formal, testid, kennzeichen }: { satz: string; ton: Ton; formal: string; testid: string; kennzeichen: string[] }) {
  return (
    <div className="vp-bil-antwort">
      <p className={`vp-bil-satz is-${ton}`} data-testid={testid}>
        <MitKennzeichen teile={kennzeichenTeile(satz, kennzeichen)} />
      </p>
      <p className="vp-bil-formal">
        <MitKennzeichen teile={kennzeichenTeile(formal, kennzeichen)} />
      </p>
    </div>
  );
}

/** Der Zwei-Teile-Balken mit den drei Zeilen (Konzept a1 §6.9). */
function BilanzKarte({
  tag,
  hz,
  darfAnlegen,
  legtAn,
  onAnlegen,
}: {
  tag: TagBild;
  hz: HauptzaehlerBild;
  darfAnlegen: boolean;
  legtAn: boolean;
  onAnlegen: (v: VorschlagBild) => void;
}) {
  return (
    <div className="vp-bil-karte vp-bil-bilanz" data-testid="energiebilanz-karte">
      {tag.balken && (
        <div className="vp-bil-stack" role="img" aria-label={tag.antwort.satz} data-testid="energiebilanz-balken">
          {tag.balken.erfasst !== '0.0' && <i className="is-erfasst" style={{ flex: `${tag.balken.erfasst} 1 0` }} />}
          {tag.balken.ohne !== '0.0' && <i className="is-ohne" style={{ flex: `${tag.balken.ohne} 1 0` }} />}
        </div>
      )}
      <div className="vp-bil-zeilen">
        {tag.karte.map((z) => (
          <KartenZeileView key={z.art} z={z} kennzeichen={tag.kennzeichen}>
            {z.art === 'ohne' && <RestWeg hz={hz} darfAnlegen={darfAnlegen} legtAn={legtAn} onAnlegen={onAnlegen} />}
          </KartenZeileView>
        ))}
      </div>
    </div>
  );
}

function KartenZeileView({ z, kennzeichen, children }: { z: KartenZeile; kennzeichen: string[]; children?: ReactNode }) {
  return (
    <div className={`vp-bil-zeile is-${z.art} ton-${z.ton}`} data-testid={`zeile-${z.art}`}>
      <span className="vp-bil-swatch" aria-hidden="true" />
      <span className="vp-bil-wort">{z.wort}</span>
      <b className="vp-bil-zahl" data-testid={`zahl-${z.art}`}>
        {z.zahl}
      </b>
      {(z.unter.length > 0 || children) && (
        <span className="vp-bil-unter">
          {z.unter.length > 0 && (
            <span className="vp-bil-unter-text">
              <MitKennzeichen teile={kennzeichenTeile(z.unter.join(' · '), kennzeichen)} />
            </span>
          )}
          {children}
        </span>
      )}
    </div>
  );
}

/**
 * Der Weg des Teils ohne eigenen Zähler: schon als Messstelle geführt (Sprung), sonst „Als eigene Messstelle führen“ mit
 * dem Satz, was das bedeutet (E18) - nur mit Recht; dazu die Live-Zeile, wenn sie eine Zahl hat.
 */
function RestWeg({ hz, darfAnlegen, legtAn, onAnlegen }: { hz: HauptzaehlerBild; darfAnlegen: boolean; legtAn: boolean; onAnlegen: (v: VorschlagBild) => void }) {
  if (!hz.restMessstelle && !hz.vorschlag && !hz.live) return null;
  return (
    <span className="vp-bil-restweg">
      {hz.restMessstelle &&
        (hz.restMessstelle.sprung ? (
          <a className="vp-bil-link" href={hz.restMessstelle.sprung.hash} data-testid="energiebilanz-rest-messstelle">
            <MitKennzeichen teile={hz.restMessstelle.teile} />
          </a>
        ) : (
          <span data-testid="energiebilanz-rest-messstelle">
            <MitKennzeichen teile={hz.restMessstelle.teile} />
          </span>
        ))}
      {hz.vorschlag && (
        <span className="vp-bil-vorschlag" data-testid="rest-vorschlag">
          {darfAnlegen ? (
            <Recht aktion="messstelle.formel"><button type="button" className="vp-eb-knopf" disabled={legtAn} onClick={() => hz.vorschlag && onAnlegen(hz.vorschlag)}>
              {REST_ANLEGEN}
            </button></Recht>
          ) : null}
          <span className="vp-bil-unter-text">{darfAnlegen ? hz.vorschlag.satz : REST_OHNE_RECHT}</span>
        </span>
      )}
      {hz.live && (
        <span className="vp-bil-unter-text vp-bil-live" data-testid="energiebilanz-live">
          {hz.live.text}
        </span>
      )}
    </span>
  );
}

/**
 * Der Weg des Teils ohne eigenen Zähler, wo keine Bilanz-Karte steht (laufender Zeitraum, Abschnitte nach einem
 * Stellungswechsel): als Zeile „ohne eigenen Zähler“ wie in der Karte, nur ohne Zahl.
 */
function RestWegKarte(props: { hz: HauptzaehlerBild; darfAnlegen: boolean; legtAn: boolean; onAnlegen: (v: VorschlagBild) => void }) {
  const { hz } = props;
  if (!hz.restMessstelle && !hz.vorschlag && !hz.live) return null;
  return (
    <div className="vp-bil-karte vp-bil-bilanz" data-testid="energiebilanz-restweg">
      <div className="vp-bil-zeilen">
        <div className="vp-bil-zeile is-ohne ton-off">
          <span className="vp-bil-swatch" aria-hidden="true" />
          <span className="vp-bil-wort">{KARTE_WORT.ohne}</span>
          <span className="vp-bil-unter">
            <RestWeg {...props} />
          </span>
        </div>
      </div>
    </div>
  );
}

/** Die Unterzähler nach Menge, mit ihrem Anteil am Ganzen; jede Reihe führt auf ihre Messstelle (AP-13 IP-11). */
function Unterzaehler({ teile, zeitraum }: { teile: TeilBild[]; zeitraum: string }) {
  if (teile.length === 0) return null;
  const titel = teile.length === 1 ? UNTERZAEHLER_TITEL.singular : UNTERZAEHLER_TITEL.plural.replace('{n}', String(teile.length));
  return (
    <section className="vp-bil-karte vp-bil-unterzaehler" aria-label={titel} data-testid="energiebilanz-unterzaehler">
      <div className="vp-bil-blockkopf">
        <h3>{titel}</h3>
        <span className="vp-bil-blockkopf-m">{zeitraum}</span>
      </div>
      <ul className="vp-bil-reihen">
        {teile.map((t) => (
          <li key={t.key} className={t.keineWerte ? 'is-ohne-wert' : undefined} data-testid={`teil-${t.kennzeichen}`}>
            {t.sprung ? (
              <a className="vp-bil-reihe" href={t.sprung.hash}>
                <ReiheInhalt t={t} />
                <span className="vp-bil-chev" aria-hidden="true">
                  <Icon name="chevron-right" size={18} />
                </span>
              </a>
            ) : (
              <span className="vp-bil-reihe">
                <ReiheInhalt t={t} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReiheInhalt({ t }: { t: TeilBild }) {
  const unter = [t.anteil, ...t.woerter].filter((x): x is string => !!x);
  return (
    <>
      <span className="vp-bil-reihe-text">
        <span className="vp-bil-reihe-name">
          {t.nurName}
          {t.nurName !== t.kennzeichen && <span className="vp-bil-kz"> {t.kennzeichen}</span>}
        </span>
        {unter.length > 0 && <span className="vp-bil-reihe-unter">{unter.join(' · ')}</span>}
      </span>
      <span className="vp-bil-reihe-wert">{t.zahl}</span>
    </>
  );
}

/** Ein Satz in Stücken: jedes Kennzeichen („AZ-8“) steht am Stück und bricht nie am Bindestrich um. */
function MitKennzeichen({ teile }: { teile: AusserhalbBild['teile'] }) {
  return (
    <>
      {teile.map((t, i) =>
        t.kennzeichen ? (
          <span key={i} className="vp-bil-kz">
            {t.text}
          </span>
        ) : (
          t.text
        ),
      )}
    </>
  );
}

/** Konzept a1, Befund 3: die Abzweige neben dem Hauptzähler, benannt - ein Kennzeichen bricht nie am Bindestrich um. */
function Ausserhalb({ ab }: { ab: AusserhalbBild | null }) {
  if (!ab) return null;
  return (
    <p className="vp-bil-karte vp-bil-hinweis" data-testid="energiebilanz-ausserhalb">
      {/* Ein Satz ist EIN Rasterelement der Karte - sonst stünde jedes Kennzeichen-Stück in einer eigenen Zeile. */}
      <span>
        <MitKennzeichen teile={ab.teile} />
      </span>
    </p>
  );
}

/** Stellungswechsel: jeder Abschnitt mit seinen Tagen, jeder Tag für sich - nie zusammengerechnet. */
function Abschnitt({ ab }: { ab: AbschnittBild }) {
  return (
    <section className="vp-bil-karte vp-bil-abschnitt" aria-label={ab.titel ?? undefined}>
      {ab.titel && (
        <div className="vp-bil-blockkopf">
          <h3>{ab.titel}</h3>
        </div>
      )}
      <GeteiltesRegisterHinweis saetze={ab.geteilt} />
      <ul className="vp-bil-tage">
        {ab.tage.map((tag) => (
          <li key={tag.key}>
            <details className="vp-bil-tag">
              <summary>
                <span className="vp-bil-tag-titel">{tag.titel}</span>
                <span className="vp-bil-tag-zahlen">
                  {tag.karte.map((z) => (
                    <span key={z.art} className={`vp-bil-tag-zahl is-${z.art}`} data-testid={`zahl-${z.art}`}>
                      {z.wort} {z.zahl}
                    </span>
                  ))}
                </span>
              </summary>
              <WorausInhalt zeilen={tag.zeilen} />
            </details>
          </li>
        ))}
      </ul>
      <Ausserhalb ab={ab.ausserhalb} />
    </section>
  );
}

/** „Woraus gerechnet“: die vier Zeilen der Route mit ihren Eingängen und der Herkunft - zugeklappt (AP-10 §5.6). */
function Woraus({ zeilen }: { zeilen: ZeileBild[] }) {
  return (
    <details className="vp-bil-karte vp-bil-woraus" data-testid="energiebilanz-woraus">
      <summary>{WORAUS}</summary>
      <WorausInhalt zeilen={zeilen} />
    </details>
  );
}

function WorausInhalt({ zeilen }: { zeilen: ZeileBild[] }) {
  return (
    <ul className="vp-bil-woraus-zeilen">
      {zeilen.map((z) => {
        // Was die Herkunft schon sagt („berechnet (Differenz)“), steht nicht noch einmal darüber; die Eingänge stehen
        // einmal, mit Version und Kennzeichen, unter „Eingänge“.
        const woerter = [...z.woerter, z.zusatz].filter((w): w is string => !!w && !z.herkunft.zeilen.some((l) => l.startsWith(w)));
        return (
          <li key={z.art} className={`ton-${z.ton}`} data-testid={`herkunft-${z.art}`}>
            <p className="vp-bil-woraus-kopf">
              <span>{z.wort}</span>
              <b>{z.zahl}</b>
            </p>
            {woerter.length > 0 && <p className="vp-bil-woraus-text">{woerter.join(' · ')}</p>}
            {z.saetze.map((s) => (
              <p key={s} className="vp-bil-woraus-text">
                {s}
              </p>
            ))}
            {z.herkunft.zeilen.map((l, i) => (
              <p key={l} className="vp-bil-woraus-text">
                <HerkunftsZeile stuecke={z.herkunft.zeilenStuecke[i] ?? [{ text: l, sprung: null }]} />
              </p>
            ))}
            {z.herkunft.eingaenge.length > 0 && (
              <>
                <p className="vp-bil-woraus-titel">{HERKUNFT_EINGAENGE}</p>
                <ul className="vp-bil-woraus-eingaenge">
                  {/* AP-13 IP-11 (D2): jeder Eingang mit SEINER Version - nicht mit der der Zeile. */}
                  {z.herkunft.eingaenge.map((e, i) => (
                    <li key={e}>
                      <HerkunftsZeile stuecke={z.herkunft.eingaengeStuecke[i] ?? [{ text: e, sprung: null }]} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
