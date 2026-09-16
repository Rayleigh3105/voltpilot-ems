import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Bilanz, type Funktionen, type Site } from '../api';
import {
  HERKUNFT,
  HERKUNFT_EINGAENGE,
  RECHT_REST_ANLEGEN,
  RECHT_STELLUNG,
  REST_ANLEGEN,
  REST_NICHT_ANGELEGT,
  REST_OHNE_HAUPTZAEHLER_SATZ,
  REST_OHNE_RECHT,
  darf,
  energiebilanzBild,
  energiebilanzHash,
  restAngelegtSatz,
  standortDerAnlage,
  zeitraumAus,
  type HauptzaehlerBild,
  type MessstellenArt,
  type Ton,
  type VorschlagBild,
  type ZeileBild,
} from '../anlageEnergiebilanz';
import { HerkunftsZeile } from '../components/HerkunftsZeile';
import { MiniShareBar } from '../components/MiniChart';
import { ZeitSegment } from '../components/HistorieWelt';
import { UEMS_ENERGIEBILANZ } from '../glossar';
import { heuteIn } from '../kennzahlKarte';
import { hashForRoute, standortMessstellenRoute } from '../nav';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { BILANZ_PERIODEN, NICHT_ABRUFBAR, blaettere, laeuftNoch, letzterGebildeter, zeitraumText, type BilanzPeriode } from '../uebersichtBausteine';
import { KEINE_WERTE } from '../uemsBilanz';
import { VORGABE_ZEITZONE } from '../uemsOrtsbaum';
import { useBerichtRechte } from '../useBerichtRechte';
import './EnergiebilanzSection.css';

/**
 * Anlage › Verlauf › **Energiebilanz** (UEMS AP-13 IP-8 = AP-10 IP-14, E7 = A, B1/B2): je Hauptzähler die Zeilen
 * Zufluss · Abfluss · zugeordnet · nicht zugeordnet mit ihrer Herkunft, Anteils-Balken je Unterzähler in kWh (keine
 * Prozentzahl), die Live-Zeile mit Stand und Grund, der Vorschlag „Rest anlegen“ nur mit Recht. Geldfrei.
 *
 * Die Ableitung ist `anlageEnergiebilanz.ts` — hier wird nur gerendert und geladen: die Bilanz-Route je Zeitraum, das
 * Register der Anlage (gemessen/berechnet je Messstelle), die Funktionen (Standort der Anlage) und die Selbstauskunft
 * (Rechte). Die Herkunft je Zeile ist zugeklappt (Variante A der Vorschau): die Zeilen bleiben am Telefon lesbar.
 */
export function EnergiebilanzSection({ site }: { site: Pick<Site, 'id' | 'name'> }) {
  const [zone, setZone] = useState(VORGABE_ZEITZONE);
  const heute = heuteIn(zone, Date.now());
  const [wahl, setWahl] = useState(() => zeitraumAus(window.location.hash, heuteIn(VORGABE_ZEITZONE, Date.now())));
  const [bilanz, setBilanz] = useState<Bilanz | 'fehler' | null>(null);
  const [neuLaden, setNeuLaden] = useState(0);
  const [arten, setArten] = useState<ReadonlyMap<string, MessstellenArt>>(() => new Map());
  const [funktionen, setFunktionen] = useState<Funktionen | null>(null);
  const [rueckmeldung, setRueckmeldung] = useState<{ text: string; ton: Ton } | null>(null);
  const [legtAn, setLegtAn] = useState(false);
  const rechte = useBerichtRechte();

  useEffect(() => {
    let aktiv = true;
    api.messstellenRegister({ anlage: site.id }).then(
      (r) => aktiv && setArten(new Map(r.register.map((z) => [z.kennzeichen, z.art]))),
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
    () => (bilanz && bilanz !== 'fehler' ? energiebilanzBild(bilanz, { heute: heuteIn(bilanz.zeitzone, Date.now()), arten }) : null),
    [bilanz, arten],
  );
  const standortId = standortDerAnlage(funktionen, site.id);

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
    <section className="vp-eb" aria-labelledby="vp-eb-titel" data-testid="energiebilanz">
      <div className="vp-eb-kopf">
        <div className="vp-eb-kopf-text">
          <h2 id="vp-eb-titel" className="vp-eb-titel">
            {UEMS_ENERGIEBILANZ}
          </h2>
          {bild && (
            <p className="vp-eb-zone" data-testid="energiebilanz-zone">
              {bild.zone}
            </p>
          )}
        </div>
        <div className="vp-eb-zeitwahl" role="group" aria-label="Zeitraum">
          <ZeitSegment label="Zeitraum" optionen={BILANZ_PERIODEN} wert={wahl.periode} onWert={(p) => waehle(p, letzterGebildeter(p, heute))} />
          <div className="vp-eb-datumzeile">
            <button type="button" className="vp-eb-schritt" aria-label="Vorheriger Zeitraum" onClick={() => waehle(wahl.periode, blaettere(wahl.periode, wahl.am, -1))}>
              <Icon name="chevron-left" size={18} />
            </button>
            <span className="vp-eb-zeitraum" aria-live="polite" data-testid="energiebilanz-zeitraum">
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
      </div>

      {rueckmeldung && (
        <p className={`vp-eb-rueckmeldung is-${rueckmeldung.ton}`} role="status" data-testid="energiebilanz-rueckmeldung">
          {rueckmeldung.text}
        </p>
      )}

      {bilanz === null ? (
        <p className="vp-eb-hinweis">Wird geladen …</p>
      ) : bilanz === 'fehler' || !bild ? (
        <div className="vp-eb-karte" role="alert">
          <p className="vp-eb-hinweis">{NICHT_ABRUFBAR}</p>
          <button type="button" className="vp-eb-knopf" onClick={() => setNeuLaden((n) => n + 1)}>
            Erneut versuchen
          </button>
        </div>
      ) : bild.leer ? (
        <div className="vp-eb-karte vp-eb-leer" data-testid="energiebilanz-leer">
          <p className="vp-eb-leer-titel">{bild.leer.titel}</p>
          <p className="vp-eb-satz">{bild.leer.satz}</p>
          {bild.leer.schritt && standortId && darf(rechte, standortId, RECHT_STELLUNG) && (
            <a className="vp-eb-knopf" href={hashForRoute(standortMessstellenRoute(standortId))}>
              {bild.leer.schritt}
            </a>
          )}
        </div>
      ) : (
        bild.hauptzaehler.map((hz) => (
          <Hauptzaehler
            key={hz.key}
            hz={hz}
            laeuft={bild.laeuft}
            darfAnlegen={darf(rechte, standortId, RECHT_REST_ANLEGEN)}
            legtAn={legtAn}
            onAnlegen={restAnlegen}
          />
        ))
      )}
    </section>
  );
}

function Hauptzaehler({
  hz,
  laeuft,
  darfAnlegen,
  legtAn,
  onAnlegen,
}: {
  hz: HauptzaehlerBild;
  laeuft: string | null;
  darfAnlegen: boolean;
  legtAn: boolean;
  onAnlegen: (v: VorschlagBild) => void;
}) {
  return (
    <article className="vp-eb-karte vp-eb-hz" data-testid="energiebilanz-hauptzaehler" aria-label={hz.titel}>
      <h3 className="vp-eb-hz-titel">{hz.titel}</h3>
      <p className={`vp-eb-live is-${hz.live.ton}`} data-testid="energiebilanz-live">
        <span className="vp-eb-punkt" aria-hidden="true" />
        {hz.live.text}
      </p>
      {hz.vorschlag && (
        <div className="vp-eb-vorschlag" data-testid="rest-vorschlag">
          <p className="vp-eb-satz">{hz.vorschlag.satz}</p>
          {darfAnlegen ? (
            <button type="button" className="vp-eb-knopf" disabled={legtAn} onClick={() => hz.vorschlag && onAnlegen(hz.vorschlag)}>
              {REST_ANLEGEN}
            </button>
          ) : (
            <p className="vp-eb-hinweis">{REST_OHNE_RECHT}</p>
          )}
        </div>
      )}
      {hz.hinweis && <p className="vp-eb-hinweis vp-eb-stellung">{hz.hinweis}</p>}
      {laeuft ? (
        <p className="vp-eb-hinweis" data-testid="energiebilanz-laeuft">
          {laeuft}
        </p>
      ) : (
        hz.abschnitte.map((ab) => (
          <div key={ab.key} className="vp-eb-abschnitt">
            {ab.titel && <h4 className="vp-eb-abschnitt-titel">{ab.titel}</h4>}
            {ab.tage.map((tag) => (
              <div key={tag.key} className="vp-eb-tag">
                {tag.titel && tag.titel !== ab.titel && <h5 className="vp-eb-tag-titel">{tag.titel}</h5>}
                <ul className="vp-eb-zeilen">
                  {tag.zeilen.map((z) => (
                    <Zeile key={z.art} z={z} kompakt={tag.kompakt} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))
      )}
    </article>
  );
}

function Zeile({ z, kompakt }: { z: ZeileBild; kompakt: boolean }) {
  const woerter = [...z.woerter, z.zusatz].filter((w): w is string => !!w);
  // Unter „Zugeordnet“ steht jeder Unterzähler mit Balken (B2); unter Zufluss/Abfluss die Teile erst ab zweien —
  // einer allein steht schon als Name in der Zeile.
  const teile = kompakt ? [] : z.art === 'zugeordnet' ? z.teile : z.teile.length > 1 ? z.teile : [];
  return (
    <li className={`vp-eb-zeile is-${z.ton}`} data-testid={`zeile-${z.art}`}>
      <div className="vp-eb-zeile-kopf">
        <span className="vp-eb-wort">
          <span className="vp-eb-punkt" aria-hidden="true" />
          {z.wort}
        </span>
        <span className="vp-eb-zahl" data-testid={`zahl-${z.art}`}>
          {z.zahl}
        </span>
      </div>
      {woerter.length > 0 && <p className="vp-eb-woerter">{woerter.join(' · ')}</p>}
      {z.saetze.map((s) => (
        <p key={s} className="vp-eb-satz">
          {s}
        </p>
      ))}
      {teile.length > 0 && (
        <ul className="vp-eb-teile">
          {teile.map((t) => {
            const eigene = t.woerter.filter((w) => !z.woerter.includes(w) && !(z.art === 'zugeordnet' && w === KEINE_WERTE));
            return (
              <li key={t.key} className={`vp-eb-teil${t.keineWerte ? ' is-off' : ''}`} data-testid={`teil-${t.kennzeichen}`}>
                {/* AP-13 IP-11 (D1/D2): der Unterzähler führt auf seine Seite, mit der Periode der Bilanz. */}
                {t.sprung ? (
                  <a className="vp-eb-teil-name vp-eb-teil-sprung" href={t.sprung.hash}>
                    {t.name}
                  </a>
                ) : (
                  <span className="vp-eb-teil-name">{t.name}</span>
                )}
                {z.art === 'zugeordnet' &&
                  (t.balken !== null ? (
                    <MiniShareBar fraction={t.balken} className="vp-eb-balken" />
                  ) : (
                    <span className="vp-eb-balken-wort">{t.keineWerte ? KEINE_WERTE : ''}</span>
                  ))}
                <span className="vp-eb-teil-zahl">{t.zahl}</span>
                {eigene.length > 0 && <span className="vp-eb-teil-woerter">{eigene.join(' · ')}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {(z.herkunft.zeilen.length > 0 || z.herkunft.eingaenge.length > 0) && (
        <details className="vp-eb-herkunft" data-testid={`herkunft-${z.art}`}>
          <summary>{HERKUNFT}</summary>
          {/* AP-13 IP-11 (D1): die Kostenstelle einer Verteilung führt auf ihre Karte. */}
          {z.herkunft.zeilen.map((l, i) => (
            <p key={l} className="vp-eb-herkunft-zeile">
              <HerkunftsZeile stuecke={z.herkunft.zeilenStuecke[i] ?? [{ text: l, sprung: null }]} />
            </p>
          ))}
          {z.herkunft.eingaenge.length > 0 && (
            <>
              <p className="vp-eb-herkunft-titel">{HERKUNFT_EINGAENGE}</p>
              <ul className="vp-eb-herkunft-eingaenge">
                {/* AP-13 IP-11 (D2): jeder Eingang mit SEINER Version — nicht mit der der Zeile. */}
                {z.herkunft.eingaenge.map((e, i) => (
                  <li key={e}>
                    <HerkunftsZeile stuecke={z.herkunft.eingaengeStuecke[i] ?? [{ text: e, sprung: null }]} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      )}
    </li>
  );
}
