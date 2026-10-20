import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type History, type ScheduleSlot, type Site, type WeatherForecast } from '../api';
import { VerlaufKopf } from '../components/HistorieWelt';
import { VerlaufFehler, VerlaufKarteSkeleton, VerlaufLeer } from '../components/States';
import {
  StundenTabelle,
  TagesKarten,
  WetterAntwort,
  WetterLegende,
  WetterTagesBild,
} from '../components/WetterTag';
import { isoDate } from '../periodNav';
import { einstellungenHash } from '../settingsNav';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { useIsDesktop, useIsPhone } from '../useIsPhone';
import { wetterModell } from '../wetterTag';

/**
 * **Die Wetter-Seite** (Konzept „Preise und Wetter", Fassung 3; E5 = A
 * „Wetter zuerst" vom 20.10.2026, `data/vp-preise-wetter-konzept-f3`).
 *
 * Wie in jeder Wetter-App: oben das Wetter jetzt (Symbol, Temperatur, ein
 * Wort) und zwei Zahlen für die Anlage, darunter drei Tage als Karten, ein
 * Bild für den gewählten Tag — Sonnenstrom in kW, gemessen gefüllt und
 * erwartet schraffiert, mit derselben Jetzt-Linie wie bei den Preisen.
 *
 * Woher die Zahlen kommen (keine zweite Erzeugungsprognose, `wetterTag.ts`):
 * das Wetter aus `/weather` (Open-Meteo), gemessener Sonnenstrom aus
 * `/history?range=day`, erwarteter aus der PV-Prognose des Fahrplans
 * (`/schedule`, `pvKw`). Fehlt sie, zeigt die Seite Sonnenstärke und
 * Sonnenstunden und sagt warum.
 */

/** Der frühere Lead-Satz des Reiters — er lebt im Erklär-Blatt weiter. */
const WETTER_LEAD = 'Die Vorhersage am Standort Ihrer Anlage - Grundlage der PV-Prognose.';

/** Wetter und Prognose ändern sich höchstens viertelstündlich; die Messung alle paar Minuten. */
const WETTER_TAKT_MS = 15 * 60_000;
const MESS_TAKT_MS = 5 * 60_000;

type Blatt = 'stunden' | 'erklaerung' | null;

export function WetterSeite({ site }: { site: Site }) {
  const isPhone = useIsPhone();
  const isDesktop = useIsDesktop();
  const [now, setNow] = useState(() => new Date());
  useFreshnessPoll(() => setNow(new Date()), 60_000);

  const [forecast, setForecast] = useState<WeatherForecast | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  const [neuVersuch, setNeuVersuch] = useState(0);
  const [prognose, setPrognose] = useState<ScheduleSlot[]>([]);
  const [messung, setMessung] = useState<History | null>(null);

  const [tagIndex, setTagIndex] = useState(0);
  const [auswahl, setAuswahl] = useState<number | null>(null);
  const [blatt, setBlatt] = useState<Blatt>(null);

  const wetterTakt = Math.floor(now.getTime() / WETTER_TAKT_MS);
  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    api
      .weather(site.id)
      .then((w) => aktiv && setForecast(w))
      .catch((e) => aktiv && setFehler(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => aktiv && setLaedt(false));
    // Fail-soft: ohne Fahrplan gibt es keine erwartete Leistung, die Seite sagt dann warum.
    api
      .schedule(site.id)
      .then((p) => aktiv && setPrognose(p.slots))
      .catch(() => aktiv && setPrognose([]));
    return () => {
      aktiv = false;
    };
  }, [site.id, wetterTakt, neuVersuch]);

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

  const m = useMemo(
    () =>
      forecast
        ? wetterModell({
            punkte: forecast.points,
            prognose: prognose.map((s) => ({ start: s.start, pvKw: s.pvKw })),
            messung: messung ? { buckets: messung.buckets, bucketMinutes: messung.bucketMinutes } : null,
            jetzt: now,
          })
        : null,
    [forecast, prognose, messung, now],
  );

  const tag = m && m.tage.length > 0 ? m.tage[Math.min(tagIndex, m.tage.length - 1)] : null;
  const zurJetzt = () => setAuswahl(null);
  const schritt = (d: -1 | 1) => {
    if (!tag) return;
    const von = auswahl ?? Math.floor(now.getTime() / (15 * 60_000)) * 15 * 60_000;
    const naechster = von + d * 15 * 60_000;
    if (naechster < tag.beginn || naechster >= tag.beginn + 24 * 3600_000) return;
    setAuswahl(naechster);
  };

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
          satz={`Die Wettervorhersage konnte nicht geladen werden (${fehler}).`}
          onRetry={() => setNeuVersuch((k) => k + 1)}
        />
      </div>
    );
  } else if (!m || !tag) {
    inhalt = (
      <div className="vp-c-card">
        <VerlaufLeer
          label="Vorhersage"
          satz="Noch keine Vorhersage. Sie wird automatisch geladen - Ihre Anlage braucht dafür einen Standort auf der Karte."
          weg="Standort in den Einstellungen ergänzen ›"
          onWeg={() => {
            window.location.hash = einstellungenHash(site.id);
          }}
        />
      </div>
    );
  } else {
    const titel = `${tag.mitStrom ? 'Sonnenstrom' : 'Sonnenstärke'} ${tag.wort === 'Heute' ? 'heute' : tag.wort === 'Morgen' ? 'morgen' : tag.wort}`;
    const rechts =
      tag.kwh != null
        ? `≈ ${Math.round(tag.kwh)} kWh`
        : tag.sonnenStunden != null
          ? tag.sonnenStunden < 1
            ? 'kaum Sonne'
            : `${tag.sonnenStunden} Std Sonne`
          : null;
    // Ehrlich, wo die Erwartung fehlt: ohne Prognose kein erfundener Rest des Tages.
    const mitPrognose = prognose.some((s) => s.pvKw != null);
    const offen = tag !== m.tage[0] || (tag.hell != null && m.jetztMs < tag.hell.bis);
    const hinweis = !tag.mitStrom
      ? mitPrognose
        ? 'Die Sonnenstrom-Prognose reicht noch nicht bis zu diesem Tag. Das Bild zeigt die Sonnenstärke laut Wetterdienst.'
        : 'Für diese Anlage liegt keine Sonnenstrom-Prognose vor. Das Bild zeigt die Sonnenstärke laut Wetterdienst.'
      : offen && !tag.pv.some((p) => p.herkunft === 'erwartet')
        ? 'Für den Rest des Tages liegt keine Sonnenstrom-Prognose vor - das Bild zeigt, was bis jetzt gemessen ist.'
        : null;
    const bild = (
      <div className="vp-c-card vp-pz-karte">
        <div className="vp-wt-kopfzeile">
          <h2>{titel}</h2>
          {rechts && <span>{rechts}</span>}
        </div>
        <WetterTagesBild
          m={m}
          tag={tag}
          auswahl={auswahl}
          breit={!isPhone}
          onWahl={setAuswahl}
          onJetzt={zurJetzt}
        />
        {hinweis && <p className="vp-wt-hinweis">{hinweis}</p>}
        <WetterLegende tag={tag} />
      </div>
    );
    inhalt = (
      <>
        <div className="vp-wt-oben">
          <section className="vp-pz-antwort" aria-live="polite" aria-label="Wetter am Standort">
            <WetterAntwort
              m={m}
              tag={tag}
              auswahl={auswahl}
              onInfo={() => setBlatt('erklaerung')}
              onSchritt={schritt}
              onJetzt={zurJetzt}
            />
          </section>
          <TagesKarten
            m={m}
            gewaehlt={tagIndex}
            onWahl={(i) => {
              setTagIndex(i);
              setAuswahl(null);
            }}
          />
        </div>
        {isDesktop ? (
          <div className="vp-wt-mitte">
            {bild}
            <div className="vp-c-card vp-pz-karte">
              <div className="vp-wt-kopfzeile">
                <h2>Stunde für Stunde</h2>
                <span>{tag.wort}</span>
              </div>
              <StundenTabelle m={m} tag={tag} />
            </div>
          </div>
        ) : (
          bild
        )}
        <div className="vp-pz-zeilen">
          {!isDesktop && (
            <button type="button" className="vp-pz-zeile" onClick={() => setBlatt('stunden')}>
              <span className="vp-pz-zeile-ico" aria-hidden="true">
                <Icon name="list" size={18} />
              </span>
              <span className="vp-pz-zeile-text">
                <b>Stunde für Stunde</b>
                <small>Himmel, Temperatur, Sonnenstrom</small>
              </span>
              <span className="vp-pz-zeile-pfeil" aria-hidden="true">
                <Icon name="chevron-right" size={18} />
              </span>
            </button>
          )}
          <a className="vp-pz-zeile" href={`#/anlage/${site.id}/fahrplan`}>
            <span className="vp-pz-zeile-ico" aria-hidden="true">
              <Icon name="calendar" size={18} />
            </span>
            <span className="vp-pz-zeile-text">
              <b>Ihr Fahrplan</b>
              <small>nutzt diese Vorhersage</small>
            </span>
            <span className="vp-pz-zeile-pfeil" aria-hidden="true">
              <Icon name="chevron-right" size={18} />
            </span>
          </a>
          {isDesktop && (
            <button type="button" className="vp-pz-zeile" onClick={() => setBlatt('erklaerung')}>
              <span className="vp-pz-zeile-ico" aria-hidden="true">
                <Icon name="info" size={18} />
              </span>
              <span className="vp-pz-zeile-text">
                <b>Woher die Werte kommen</b>
                <small>Wetterdienst, Messung, Prognose</small>
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

  return (
    <div className="vp-pz">
      <VerlaufKopf titel="Wetter" />
      {inhalt}
      <Modal
        open={blatt === 'stunden' && m != null && tag != null}
        onClose={() => setBlatt(null)}
        title={`Stunde für Stunde · ${tag?.wort ?? ''}`}
        blatt
      >
        {m && tag && <StundenTabelle m={m} tag={tag} />}
      </Modal>
      <Modal open={blatt === 'erklaerung'} onClose={() => setBlatt(null)} title="Woher die Werte kommen" blatt>
        <div className="vp-pz-erklaerung">
          <p>{WETTER_LEAD}</p>
          <p>
            <b>Wetter:</b> Open-Meteo, stündlich für die nächsten Tage, am Standort Ihrer Anlage
            {forecast?.runAt ? `, Stand ${new Date(forecast.runAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} Uhr` : ''}.
          </p>
          <p>
            <b>Sonnenstrom gemessen:</b> was Ihre Anlage heute bis jetzt erzeugt hat, je Viertelstunde.
          </p>
          <p>
            <b>Sonnenstrom erwartet:</b> die Prognose, mit der Ihr Fahrplan rechnet. Sie reicht so weit
            wie der Fahrplan.
          </p>
          <p>
            <b>Sonnenstunden:</b> Stunden mit direkter Sonne über 120 W/m².
          </p>
        </div>
      </Modal>
    </div>
  );
}
