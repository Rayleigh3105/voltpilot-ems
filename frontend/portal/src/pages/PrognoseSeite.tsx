import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  ApiError,
  type ForecastResponse,
  type History,
  type RueckblickResponse,
  type ScheduleSlot,
  type Site,
  type WeatherForecast,
} from '../api';
import { VerlaufKopf } from '../components/HistorieWelt';
import {
  PrognoseAntwort,
  PrognoseLegende,
  PrognoseTagesBild,
  PrognoseTippPhone,
  SonneReichtStreifen,
  SpeicherStreifen,
  Teppich,
  vorabendPunkte,
} from '../components/PrognoseTeppich';
import { VerlaufFehler, VerlaufKarteSkeleton, VerlaufLeer } from '../components/States';
import { isoDate } from '../periodNav';
import { KIND_LABELS } from '../prognose';
import { gesternSatz, prognoseModell, rueckblickSatz, rueckblickZeilen } from '../prognoseSeite';
import { pvLage } from '../pvLage';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { useIsDesktop, useIsPhone } from '../useIsPhone';

/**
 * **Der Sonnen-Teppich** - die Kundenseite der Prognose (Konzept
 * `vp-prognosen-konzept`, E1 = C vom 11.11.2026). Ersetzt die frühere
 * Wetter-Seite: ein Teppich aus 7 Tagen × Stunden zeigt Sonne (mit PV) oder
 * Verbrauch (ohne PV) auf einen Blick, darunter das Bild des gewählten
 * Tages, Stunde für Stunde.
 *
 * Woher die Zahlen kommen (`prognoseSeite.ts`): die Prognose aus `/forecast`
 * (heute/morgen viertelstündlich, danach - mit Wochen-Ausblick - stündlich),
 * das Wetter aus `/weather` nur für Himmel-Symbol und Temperatur, gemessener
 * Sonnenstrom/Verbrauch aus `/history?range=day`, der Speicher-Streifen aus
 * `/schedule` (nur mit Fahrplan). Ohne S3 zeigt diese Seite keine
 * Rückblick-Zeile - wie gut die Prognose lag, kommt in der nächsten Scheibe.
 */

const STUNDE_MS = 3600_000;
const PROGNOSE_TAKT_MS = 15 * 60_000;
const MESS_TAKT_MS = 5 * 60_000;

type Blatt = 'erklaerung' | 'rueckblick' | null;

export function PrognoseSeite({ site, hatFahrplan }: { site: Site; hatFahrplan: boolean }) {
  const isPhone = useIsPhone();
  const isDesktop = useIsDesktop();
  const [now, setNow] = useState(() => new Date());
  useFreshnessPoll(() => setNow(new Date()), 60_000);

  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [weather, setWeather] = useState<WeatherForecast | null>(null);
  const [messung, setMessung] = useState<History | null>(null);
  const [schedule, setSchedule] = useState<ScheduleSlot[]>([]);
  const [rueckblick, setRueckblick] = useState<RueckblickResponse | null>(null);
  const [anlagenleistungKwp, setAnlagenleistungKwp] = useState<number | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  const [neuVersuch, setNeuVersuch] = useState(0);

  const [tagIndex, setTagIndex] = useState(0);
  const [blatt, setBlatt] = useState<Blatt>(null);

  const takt = Math.floor(now.getTime() / PROGNOSE_TAKT_MS);
  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    api
      .forecast(site.id)
      .then((f) => aktiv && setForecast(f))
      .catch((e) => aktiv && setFehler(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => aktiv && setLaedt(false));
    // Fail-soft: ohne Wetter fehlen nur Himmel-Symbol und Temperatur, nicht die Prognose selbst.
    api
      .weather(site.id)
      .then((w) => aktiv && setWeather(w))
      .catch(() => aktiv && setWeather(null));
    // Der Speicher-Streifen ist nur mit Fahrplan möglich - ohne ihn kein Abruf.
    if (hatFahrplan) {
      api
        .schedule(site.id)
        .then((p) => aktiv && setSchedule(p.slots))
        .catch(() => aktiv && setSchedule([]));
    }
    return () => {
      aktiv = false;
    };
  }, [site.id, hatFahrplan, takt, neuVersuch]);

  const heute = isoDate(now);
  const messTakt = Math.floor(now.getTime() / MESS_TAKT_MS);
  useEffect(() => {
    let aktiv = true;
    api
      .history(site.id, 'day', heute)
      .then((h) => aktiv && setMessung(h))
      .catch(() => aktiv && setMessung(null));
    return () => {
      aktiv = false;
    };
  }, [site.id, heute, messTakt]);

  // Der Maßstab des Teppichs misst sich an der Anlage, nicht an der eigenen
  // Spitze der Woche (Captain-Entscheid auf dem Board, Bericht 6.1) - sie
  // ändert sich praktisch nie, ein einmaliger Abruf reicht.
  useEffect(() => {
    let aktiv = true;
    api
      .siteAssets(site.id)
      .then((assets) => {
        if (!aktiv) return;
        const lage = pvLage(assets, []);
        setAnlagenleistungKwp(lage.art === 'bekannt' ? lage.kwp : null);
      })
      .catch(() => aktiv && setAnlagenleistungKwp(null));
    return () => {
      aktiv = false;
    };
  }, [site.id]);

  // Der Rückblick (S3) ändert sich nur einmal am Tag (der Abend-Lauf von
  // 17:45) - kein Viertelstunden-Takt nötig; fail-soft wie das Wetter, das
  // Blatt zeigt dann ehrlich "noch keine Bewertung" statt eines Fehlers.
  useEffect(() => {
    let aktiv = true;
    api
      .rueckblick(site.id)
      .then((r) => aktiv && setRueckblick(r))
      .catch(() => aktiv && setRueckblick(null));
    return () => {
      aktiv = false;
    };
  }, [site.id, heute]);

  const m = useMemo(
    () =>
      forecast
        ? prognoseModell({
            forecast,
            weather: weather?.points ?? [],
            messung: messung ? { buckets: messung.buckets, bucketMinutes: messung.bucketMinutes } : null,
            jetzt: now,
            anlagenleistungKwp,
          })
        : null,
    [forecast, weather, messung, now, anlagenleistungKwp],
  );

  const tag = m && m.tage.length > 0 ? m.tage[Math.min(tagIndex, m.tage.length - 1)] : null;

  let inhalt;
  if (laedt && !forecast) {
    inhalt = (
      <div className="vp-c-card">
        <VerlaufKarteSkeleton />
      </div>
    );
  } else if (fehler && !forecast) {
    inhalt = (
      <div className="vp-c-card">
        <VerlaufFehler
          satz={`Die Prognose konnte nicht geladen werden (${fehler}).`}
          onRetry={() => setNeuVersuch((k) => k + 1)}
        />
      </div>
    );
  } else if (!m || !tag) {
    inhalt = (
      <div className="vp-c-card">
        <VerlaufLeer label="Prognose" satz="Noch keine Prognose. Sie erscheint hier, sobald der erste Lauf vorliegt." />
      </div>
    );
  } else {
    const istHeute = tag === m.tage[0];
    const titel = `${m.mitPv ? 'Sonne und Verbrauch' : 'Verbrauch'} ${tag.wort === 'Heute' ? 'heute' : tag.wort === 'Morgen' ? 'morgen' : tag.wort}`;
    const rechts = m.mitPv
      ? tag.sonneKwh != null
        ? `≈ ${Math.round(tag.sonneKwh)} kWh Sonne`
        : null
      : tag.verbrauchKwh != null
        ? `≈ ${Math.round(tag.verbrauchKwh)} kWh Verbrauch`
        : null;
    const stundenDesTages = tag.stunden.map((s) => new Date(s.start).getHours());
    const tagVon = tag.beginn + Math.min(...stundenDesTages) * STUNDE_MS;
    const tagBis = tag.beginn + (Math.max(...stundenDesTages) + 1) * STUNDE_MS;
    // Datenfehler 3: die Legende "am Vorabend erwartet" darf nur stehen, wenn
    // wirklich eine Linie gezeichnet wird - nicht schon, weil wir am Rechner
    // auf "Heute" stehen. Dieselbe Regel wie `PrognoseTagesBild` (mindestens
    // zwei Punkte), sonst behauptet die Legende eine Linie, die am ersten Tag
    // nach S1 (noch kein Abendlauf von gestern) gar nicht existiert.
    const yesterdayExpected = forecast?.yesterdayExpected;
    const zeigeVorabend =
      isDesktop &&
      istHeute &&
      yesterdayExpected != null &&
      ((m.mitPv && vorabendPunkte(yesterdayExpected.pvKw, tag.beginn, m.jetztMs).length > 1) ||
        vorabendPunkte(yesterdayExpected.loadKw, tag.beginn, m.jetztMs).length > 1);
    const bild = (
      <div className="vp-c-card vp-pz-karte">
        <div className="vp-pt-karte-kopf">
          <h2>{titel}</h2>
          {rechts && <span>{rechts}</span>}
        </div>
        {!isDesktop && istHeute && <PrognoseTippPhone m={m} heute={tag} />}
        <PrognoseTagesBild m={m} tag={tag} breit={!isPhone} vorabend={forecast?.yesterdayExpected} weather={weather?.points} />
        <PrognoseLegende tag={tag} mitPv={m.mitPv} zeigeVorabend={zeigeVorabend} />
        {m.mitPv && <SonneReichtStreifen tag={tag} von={tagVon} bis={tagBis} />}
        {m.mitPv && hatFahrplan && <SpeicherStreifen slots={schedule} von={tagVon} bis={tagBis} />}
      </div>
    );
    inhalt = (
      <>
        <section className="vp-pz-antwort" aria-live="polite" aria-label="Prognose am Standort">
          <PrognoseAntwort m={m} heute={m.tage[0]} morgen={m.tage[1]} zeigeTipp={isDesktop} onInfo={() => setBlatt('erklaerung')} />
        </section>
        <div className="vp-pt-reihe">
          <div className="vp-c-card vp-pz-karte">
            <Teppich m={m} gewaehlt={Math.min(tagIndex, m.tage.length - 1)} onWahl={setTagIndex} schmal={isPhone} />
          </div>
          {bild}
        </div>
        <div className="vp-pz-zeilen">
          {hatFahrplan && (
            <a className="vp-pz-zeile" href={`#/anlage/${site.id}/fahrplan`}>
              <span className="vp-pz-zeile-ico" aria-hidden="true">
                <Icon name="calendar" size={18} />
              </span>
              <span className="vp-pz-zeile-text">
                <b>Ihr Fahrplan</b>
                <small>nutzt diese Prognose</small>
              </span>
              <span className="vp-pz-zeile-pfeil" aria-hidden="true">
                <Icon name="chevron-right" size={18} />
              </span>
            </a>
          )}
          <button type="button" className="vp-pz-zeile" onClick={() => setBlatt('rueckblick')}>
            <span className="vp-pz-zeile-ico" aria-hidden="true">
              <Icon name="history" size={18} />
            </span>
            <span className="vp-pz-zeile-text">
              <b>Rückblick</b>
              <small>{gesternSatz(rueckblick, m.mitPv) ?? 'wie gut die Prognose lag'}</small>
            </span>
            <span className="vp-pz-zeile-pfeil" aria-hidden="true">
              <Icon name="chevron-right" size={18} />
            </span>
          </button>
          {isDesktop && (
            <button type="button" className="vp-pz-zeile" onClick={() => setBlatt('erklaerung')}>
              <span className="vp-pz-zeile-ico" aria-hidden="true">
                <Icon name="info" size={18} />
              </span>
              <span className="vp-pz-zeile-text">
                <b>Woher die Werte kommen</b>
                <small>Prognose, Wetterdienst, Messung</small>
              </span>
              <span className="vp-pz-zeile-pfeil" aria-hidden="true">
                <Icon name="chevron-right" size={18} />
              </span>
            </button>
          )}
        </div>
      </>
    );
  }

  const modellWort = modellSatz(forecast?.activeLoadModel);

  return (
    <div className="vp-pz">
      <VerlaufKopf titel="Prognose" />
      {inhalt}
      <Modal open={blatt === 'erklaerung'} onClose={() => setBlatt(null)} title="Woher die Werte kommen" blatt>
        <div className="vp-pz-erklaerung">
          <p>
            <b>Sonne:</b> Wetter am Standort mal Ihre Anlage
            {forecast?.pvRunAt ? `, Stand ${uhrDatum(forecast.pvRunAt)}` : ''}.
          </p>
          <p>
            <b>Verbrauch:</b> {modellWort}
            {forecast?.loadRunAt ? `, Stand ${uhrDatum(forecast.loadRunAt)}` : ''}.
          </p>
          <p>
            <b>Die nächsten zwei Stunden</b> folgen der Messung, nicht mehr dem Lauf von eben.
          </p>
          <p>
            <b>Ab übermorgen: Ein Ausblick:</b> Wetter für sieben Tage, Verbrauch wie an den gleichen Wochentagen.
          </p>
          <p>
            <b>Gemessen:</b> was Ihre Anlage heute bis jetzt erzeugt und verbraucht hat.
          </p>
          <p>Stand: alle 15 Minuten neu.</p>
        </div>
      </Modal>
      <Modal open={blatt === 'rueckblick'} onClose={() => setBlatt(null)} title="Rückblick" blatt>
        <div className="vp-pz-rblk">
          {!rueckblick && <p>Der Rückblick konnte nicht geladen werden.</p>}
          {rueckblick?.kinds
            .filter((k) => k.kind !== 'pv' || (m?.mitPv ?? false))
            .map((k) => {
              const zeilen = rueckblickZeilen(k);
              return (
                <section key={k.kind} className="vp-pz-rblk-art">
                  <h3>{KIND_LABELS[k.kind]}</h3>
                  {zeilen.length === 0 ? (
                    <p>Noch keine Tage - der erste Rückblick folgt morgen.</p>
                  ) : (
                    <table className="vp-pz-rblk-tabelle">
                      <thead>
                        <tr>
                          <th scope="col">Tag</th>
                          <th scope="col">am Vortag erwartet</th>
                          <th scope="col">gemessen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {zeilen.map((z) => (
                          <tr key={z.tagWort}>
                            <td>{z.tagWort}</td>
                            <td>{kwhTabelle(z.erwartetKwh)}</td>
                            <td>{kwhTabelle(z.gemessenKwh)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <p className="vp-pz-rblk-satz">{rueckblickSatz(k)}</p>
                </section>
              );
            })}
        </div>
      </Modal>
    </div>
  );
}

function uhrDatum(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' Uhr';
}

/** Tagessumme kWh fürs Rückblick-Blatt - 0 Nachkommastellen (UEMS-Zahlenformat, AP-08 E11). */
function kwhTabelle(v: number): string {
  return `${Math.round(v).toLocaleString('de-DE')} kWh`;
}

/** Die Kurzform je aktivem Lastmodell (Bericht 6.1 Baustein 5). */
function modellSatz(modell: string | undefined): string {
  switch (modell) {
    case 'load-xgb':
      return 'gelernt aus Ihren letzten Wochen';
    case 'load-persistence':
      return 'wie gestern zur gleichen Uhrzeit';
    default:
      return 'wie an den letzten gleichen Wochentagen';
  }
}
