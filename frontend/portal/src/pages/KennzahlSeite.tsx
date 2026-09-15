import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Kennzahl, type KennzahlFassung, type KennzahlPeriodeArt, type KennzahlWerte } from '../api';
import { ZeitSegment } from '../components/HistorieWelt';
import type { KopieVon } from '../components/KennzahlAnlegenDialog';
import { ErrorState, Skeleton } from '../components/States';
import { KNOPF_KOPIEREN } from '../kennzahlAnlegen';
import { VersionenEinstieg, VersionenModal } from '../components/WertVersionen';
import { WerteKarte } from '../components/WerteKarte';
import {
  ANZAHL_VERLAUF,
  anfrage,
  berechnung,
  eingaengeDer,
  FASSUNGEN_TITEL,
  heuteIn,
  herkunftAnzeige,
  KARTE_BERECHNUNG,
  KARTE_HERKUNFT,
  KARTE_STAMMDATEN,
  KARTE_VERLAUF,
  kennzahlHistorie,
  kopf,
  letzterSchritt,
  NICHT_GEFUNDEN,
  PERIODE_WAHL,
  periodenWahl,
  stammdaten,
  verlauf,
  versionenEinstieg,
  WERTE_FEHLER,
  wertKarte,
  ZUR_LISTE,
  type Balken,
} from '../kennzahlKarte';

const LADEFEHLER_SEITE = 'Die Kennzahl konnte nicht geladen werden.';

/**
 * Die Kennzahl-Seite (UEMS AP-11 IP-13, §5.3/§5.5): Kopf, Perioden-Umschalter (nur die bildbaren), die Werte-Karte
 * (`WerteKarte` wiederverwendet, mit dem Einstieg „Versionen“ ab zwei), der Verlauf als Balken, die Herkunft, die
 * Berechnung mit ihrem Fassungs-Verlauf und die Stammdaten.
 *
 * Sie LIEST nur: `GET /api/v1/kennzahlen/{id}`, `…/fassungen`, `…/werte` (die letzten Perioden bis heute) und —
 * erst im geöffneten Dialog — `…/werte/versionen`. „Berechnung ändern ab …“, Stammdaten ändern und Archivieren
 * kommen mit IP-15; vorher kein Knopf ohne Ziel.
 *
 * Ein Tipp auf einen Balken zeigt dessen Periode in der Karte; ohne Wahl steht dort der jüngste Schritt mit einer
 * Zeile (auch „keine Werte“ mit seinem Grund).
 */
export function KennzahlSeite({
  id,
  zone,
  onListe,
  onKopieren,
}: {
  id: string;
  zone: string;
  onListe: () => void;
  /** AP-11 IP-14 (§5.2): „Kopieren“ — Form, Name und Zweck gehen in den Assistenten, die Eingänge nicht. */
  onKopieren?: (quelle: KopieVon) => void;
}) {
  const [stamm, setStamm] = useState<{ kennzahl: Kennzahl; fassungen: KennzahlFassung[] } | null>(null);
  const [stammFehler, setStammFehler] = useState<'fehlt' | 'fehler' | null>(null);
  const [art, setArt] = useState<KennzahlPeriodeArt | null>(null);
  const [werte, setWerte] = useState<{ schluessel: string; antwort: KennzahlWerte } | null>(null);
  const [werteFehler, setWerteFehler] = useState(false);
  const [gewaehlt, setGewaehlt] = useState<string | null>(null);
  const [versionenOffen, setVersionenOffen] = useState(false);
  const [versuch, setVersuch] = useState(0);

  useEffect(() => {
    let aktiv = true;
    setStammFehler(null);
    Promise.all([api.kennzahl(id), api.kennzahlFassungen(id)]).then(
      ([kennzahl, f]) => {
        if (!aktiv) return;
        setStamm({ kennzahl, fassungen: f.fassungen });
        setArt((alt) => alt ?? periodenWahl(kennzahl).vorgabe);
      },
      (e) => aktiv && setStammFehler(e instanceof ApiError && e.status === 404 ? 'fehlt' : 'fehler'),
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);

  const schluessel = art ? `${id}|${art}|${versuch}` : null;
  useEffect(() => {
    if (!art || !schluessel) return;
    let aktiv = true;
    setWerteFehler(false);
    const { von, bis } = anfrage(art, heuteIn(zone, Date.now()), ANZAHL_VERLAUF[art]);
    api.kennzahlWerte(id, art, von, bis).then(
      (antwort) => aktiv && setWerte({ schluessel, antwort }),
      () => aktiv && setWerteFehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [id, art, zone, schluessel]);

  const zurueck = (
    <button type="button" className="vp-kz-zurueck" onClick={onListe}>
      <Icon name="chevron-left" size={18} />
      {ZUR_LISTE}
    </button>
  );

  if (stammFehler === 'fehlt') {
    return (
      <div className="vp-kz" data-testid="kennzahl-seite">
        {zurueck}
        <p className="vp-kz-leer">{NICHT_GEFUNDEN}</p>
      </div>
    );
  }
  if (stammFehler) {
    return (
      <div className="vp-kz" data-testid="kennzahl-seite">
        {zurueck}
        <ErrorState message={LADEFEHLER_SEITE} onRetry={() => setVersuch((v) => v + 1)} />
      </div>
    );
  }
  if (!stamm) {
    return (
      <div className="vp-kz" data-testid="kennzahl-seite" aria-busy="true">
        {zurueck}
        <Skeleton height={220} />
      </div>
    );
  }

  const k = stamm.kennzahl;
  const kp = kopf(k);
  const wahl = periodenWahl(k);
  const aktuell = werte !== null && werte.schluessel === schluessel ? werte.antwort : null;
  const schritt = aktuell ? (aktuell.werte.find((w) => w.schluessel === gewaehlt) ?? letzterSchritt(aktuell)) : null;
  const zoneDerWerte = aktuell?.zeitzone ?? zone;
  const wk = aktuell && schritt ? wertKarte(aktuell, schritt, eingaengeDer(stamm.fassungen, schritt)) : null;
  const einstieg = versionenEinstieg(schritt);
  const herkunft = aktuell && schritt ? herkunftAnzeige(aktuell, schritt) : null;
  const b = berechnung(k, stamm.fassungen, zoneDerWerte);

  return (
    <div className="vp-kz" data-testid="kennzahl-seite">
      {zurueck}
      <header className="vp-kz-kopf">
        <h1>{kp.titel}</h1>
        <p>
          <span>{kp.unter}</span>
          {kp.archiviert && <Badge variant="tint">{kp.archiviert}</Badge>}
        </p>
        {onKopieren && (
          <div className="vp-kz-aktionen">
            <Button variant="outline" size="sm" onClick={() => onKopieren({ kennzahl: k, fassungen: stamm.fassungen })}>
              {KNOPF_KOPIEREN}
            </Button>
          </div>
        )}
      </header>
      {wahl.optionen.length > 0 && art && (
        <div className="vp-kz-perioden">
          <ZeitSegment
            label={PERIODE_WAHL}
            optionen={wahl.optionen}
            wert={art}
            onWert={(a) => {
              setArt(a);
              setGewaehlt(null);
            }}
          />
        </div>
      )}
      <div className="vp-kz-raster">
        <div className="vp-kz-spalte">
          {werteFehler ? (
            <ErrorState message={WERTE_FEHLER} onRetry={() => setVersuch((v) => v + 1)} />
          ) : art && !aktuell ? (
            <div aria-busy="true">
              <Skeleton height={148} />
            </div>
          ) : (
            <>
              {wk && (
                <WerteKarte
                  karte={wk.karte}
                  grund={wk.grund}
                  versionen={einstieg && <VersionenEinstieg einstieg={einstieg} onOeffnen={() => setVersionenOffen(true)} />}
                />
              )}
              {aktuell && (
                <Verlauf
                  balken={verlauf(aktuell)}
                  dicht={aktuell.periode === 'tag' || aktuell.periode === 'woche'}
                  gewaehlt={schritt?.schluessel ?? null}
                  onWahl={setGewaehlt}
                />
              )}
            </>
          )}
        </div>
        <div className="vp-kz-spalte">
          {herkunft && (
            <section className="vp-kz-block" aria-label={KARTE_HERKUNFT} data-testid="kennzahl-herkunft">
              <h2>{KARTE_HERKUNFT}</h2>
              {herkunft.eingaenge && <p>{herkunft.eingaenge}</p>}
              {herkunft.paare.length > 0 && (
                <ul className="vp-kz-paare">
                  {herkunft.paare.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              {herkunft.gebildet && <p className="vp-kz-leise">{herkunft.gebildet}</p>}
              {herkunft.fehlt && <p className="vp-kz-ehrlich">{herkunft.fehlt}</p>}
            </section>
          )}
          {b && (
            <section className="vp-kz-block" aria-label={KARTE_BERECHNUNG} data-testid="kennzahl-berechnung">
              <h2>{KARTE_BERECHNUNG}</h2>
              <p>
                {b.satz}
                {b.abzeichen && (
                  <>
                    {' '}
                    <Badge variant="warn">{b.abzeichen}</Badge>
                  </>
                )}
              </p>
              <p className="vp-kz-leise">{b.wer}</p>
              {b.fassungen.length > 0 && (
                <>
                  <h3>{FASSUNGEN_TITEL}</h3>
                  <ol className="vp-kz-fassungen">
                    {b.fassungen.map((f) => (
                      <li key={f.schluessel} className={`vp-kz-fassung${f.gilt ? ' is-gilt' : ''}`}>
                        <p>
                          <strong>{f.titel}</strong> · {f.zeitraum}
                          {f.abzeichen && (
                            <>
                              {' '}
                              <Badge variant="warn">{f.abzeichen}</Badge>
                            </>
                          )}
                        </p>
                        <p>{f.berechnung}</p>
                        <p className="vp-kz-leise">{f.wer}</p>
                        {f.warum && <p>{f.warum}</p>}
                        {f.aufgehoben && <p className="vp-kz-ehrlich">{f.aufgehoben}</p>}
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </section>
          )}
          <section className="vp-kz-block" aria-label={KARTE_STAMMDATEN} data-testid="kennzahl-stammdaten">
            <h2>{KARTE_STAMMDATEN}</h2>
            <dl className="vp-kz-stamm">
              {stammdaten(k).map((s) => (
                <div key={s.name}>
                  <dt>{s.name}</dt>
                  <dd>{s.wert}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
      {/* Neben der Seite, nicht in der Karte: der Dialog ist ein eigenes Portal (wie an der Tageskarte). */}
      {art && schritt && einstieg && (
        <VersionenModal
          open={versionenOffen}
          objekt={kp.titel}
          periode={schritt.beschriftung}
          schluessel={`${id}|${art}|${schritt.von}`}
          laden={() => api.kennzahlWertVersionen(id, art, schritt.von).then(kennzahlHistorie)}
          onClose={() => setVersionenOffen(false)}
        />
      )}
    </div>
  );
}

function Verlauf({
  balken,
  dicht,
  gewaehlt,
  onWahl,
}: {
  balken: Balken[];
  dicht: boolean;
  gewaehlt: string | null;
  onWahl: (schluessel: string) => void;
}) {
  return (
    <section className="vp-kz-block" aria-label={KARTE_VERLAUF} data-testid="kennzahl-verlauf">
      <h2>{KARTE_VERLAUF}</h2>
      <div className="vp-kz-balken-rahmen">
        <ol className={`vp-kz-balken${dicht ? ' is-dicht' : ''}`}>
          {balken.map((b) => (
            <li key={b.schluessel}>
              <button
                type="button"
                className={`vp-kz-balken-knopf is-${b.ton}${b.schluessel === gewaehlt ? ' is-gewaehlt' : ''}`}
                aria-pressed={b.schluessel === gewaehlt}
                aria-label={[b.titel, b.zahl, b.zustand].filter(Boolean).join(' · ')}
                data-testid="verlauf-balken"
                onClick={() => onWahl(b.schluessel)}
              >
                <span className="vp-kz-saeule" aria-hidden="true">
                  {b.anteil === null ? (
                    <span className="vp-kz-strich">—</span>
                  ) : (
                    <span className="vp-kz-fuellung" style={{ height: `${Math.max(4, Math.round(b.anteil * 100))}%` }} />
                  )}
                </span>
                <span className="vp-kz-kurz" aria-hidden="true">
                  {b.kurz}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
