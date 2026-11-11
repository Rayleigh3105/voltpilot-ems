import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type HistoryRange, type PriceHistory, type ScheduleSlot, type Site } from '../api';
import { Aufklapper } from '../components/Aufklapper';
import { VerlaufKopf, ZeitBlaetterer, ZeitSegment } from '../components/HistorieWelt';
import { PreisZeilen, ProfiZahlen } from '../components/MarktpreiseMobil';
import {
  PreisAntwort,
  PreisKachel,
  PreisLegende,
  PreisZeitstrahlBild,
  type FensterWahl,
} from '../components/PreisZeitstrahl';
import { VerlaufFehler, VerlaufKarteSkeleton, VerlaufLeer } from '../components/States';
import { historieHash } from '../historieWelten';
import { ankerAusWert } from '../historieZeit';
import { preisZeilen, profiZeilen } from '../marktpreise';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { isoDate, PERIOD_RANGES, periodLabel, shiftAnchor } from '../periodNav';
import { PriceHistoryChart } from '../PriceHistoryChart';
import { ct1, hatFolgetag, speicherPlan, zeitstrahl, type Zeitstrahl } from '../preisZeitstrahl';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { useIsPhone } from '../useIsPhone';
import { parseVerlaufParams } from '../verlauf';

/**
 * **Die Preis-Seite** (Konzept „Preise und Wetter", Fassung 3; Entscheide
 * E1–E8 = A vom 20.10.2026, `data/vp-preise-wetter-konzept-f3`).
 *
 * Drei Regeln für die Reiter Preise und Wetter:
 *
 *  1. **Antwort zuerst.** Oben steht, was jetzt gilt: der Preis, ein Wort im
 *     Vergleich zu den kommenden Stunden, wie lange. Keine Bedienung davor —
 *     die frühere Zeitleiste (Tag/Woche/Monat/Jahr, Datum, „Heute") und der
 *     zweite Schalter „Heute | Morgen" unter dem Bild sind weg.
 *  2. **Jetzt steht fest.** Das Bild hat eine Jetzt-Linie mit Marke und
 *     beginnt am Telefon 2 Stunden vor jetzt (E1); Vergangenes ist blass.
 *  3. **Ein Weg nach unten.** Rückblick (E3) und Erklärung sind Zeilen und
 *     öffnen ein Blatt. Eine Adresse mit `z=`/`at=` (Woche, Monat, Jahr oder
 *     ein vergangener Tag) öffnet den Rückblick direkt — alte Lesezeichen
 *     bleiben gültig.
 *
 * Es zählt nur der Börsenpreis (Entscheid vom 29.09.2026): kein Endpreis,
 * kein Bezugspreis neben der Zahl; dass der Endpreis höher ist, sagt das
 * Erklär-Blatt.
 */

/** Der frühere Lead-Satz des Reiters — er lebt im Erklär-Blatt weiter. */
const MARKTPREISE_LEAD = 'Was Strom an der Börse kostet - heute, morgen und im Rückblick.';

/** Wie oft der Speicher-Plan neu geholt wird (der Optimierer rechnet alle 15 Minuten). */
const PLAN_TAKT_MS = 15 * 60_000;

type Blatt = 'rueckblick' | 'erklaerung' | null;

/** Liest `z`/`at` aus der Adresse: öffnet sie den Rückblick? */
function rueckblickAusAdresse(heute: string): { range: HistoryRange; at: string } | null {
  const query = window.location.hash.split('?')[1] ?? '';
  const roh = new URLSearchParams(query);
  if (!roh.has('z')) return null;
  const p = parseVerlaufParams(window.location.hash);
  const at = p.at ?? heute;
  // Der Tag von HEUTE ist die Hauptansicht (so schrieb die alte Seite jede Adresse).
  if (p.range === 'day' && at === heute) return null;
  return { range: p.range, at };
}

export function PreisSeite({ site, embedded }: { site: Site; embedded: boolean }) {
  const isPhone = useIsPhone();
  const [now, setNow] = useState(() => new Date());
  useFreshnessPoll(() => setNow(new Date()), 60_000);

  const heute = isoDate(now);
  const [startAdresse] = useState(() => rueckblickAusAdresse(isoDate(new Date())));
  const [blatt, setBlatt] = useState<Blatt>(startAdresse ? 'rueckblick' : null);
  const [rbRange, setRbRange] = useState<HistoryRange>(startAdresse?.range ?? 'week');
  const [rbAnker, setRbAnker] = useState<Date>(
    () => (startAdresse ? ankerAusWert(startAdresse.at, startAdresse.range) : null) ?? new Date(),
  );

  const [history, setHistory] = useState<PriceHistory | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  const [neuVersuch, setNeuVersuch] = useState(0);
  const [planSlots, setPlanSlots] = useState<{ slots: ScheduleSlot[]; slotMinutes: number } | null>(null);

  const [auswahl, setAuswahl] = useState<number | null>(null);
  const [fenster, setFenster] = useState<FensterWahl | null>(null);

  const z: Zeitstrahl | null = useMemo(
    () => (history ? zeitstrahl(history.buckets, now) : null),
    [history, now],
  );

  /**
   * Neu laden, wenn ein neuer Tag beginnt — und nachmittags alle 15 Minuten,
   * solange der Folgetag noch fehlt (die Börse veröffentlicht ihn gegen 13 Uhr).
   */
  const folgetagFehlt = z != null && !hatFolgetag(z);
  const ladeTakt = `${heute}|${folgetagFehlt && now.getHours() >= 13 ? Math.floor(now.getTime() / PLAN_TAKT_MS) : 0}`;
  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    api
      .priceHistory(site.id, 'day', heute)
      .then((h) => aktiv && setHistory(h))
      .catch((e) => aktiv && setFehler(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => aktiv && setLaedt(false));
    return () => {
      aktiv = false;
    };
    // `heute` steckt in `ladeTakt`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id, ladeTakt, neuVersuch]);

  // E4 = A: was der Speicher laut Plan tut. Fail-soft — ohne Plan kein Streifen.
  const planTakt = Math.floor(now.getTime() / PLAN_TAKT_MS);
  useEffect(() => {
    let aktiv = true;
    api
      .schedule(site.id)
      .then((p) => aktiv && setPlanSlots({ slots: p.slots, slotMinutes: p.slotMinutes }))
      .catch(() => aktiv && setPlanSlots(null));
    return () => {
      aktiv = false;
    };
  }, [site.id, planTakt]);

  const plan = useMemo(
    () => (z && planSlots ? speicherPlan(z, planSlots.slots, planSlots.slotMinutes) : null),
    [z, planSlots],
  );

  // Die Adresse spricht den Rückblick nur, solange er offen ist.
  useEffect(() => {
    if (!embedded) return;
    replaceCurrentNavigation(
      blatt === 'rueckblick'
        ? historieHash(site.id, 'marktpreise', rbRange, isoDate(rbAnker))
        : `#/anlage/${site.id}/marktpreise`,
    );
  }, [embedded, site.id, blatt, rbRange, rbAnker]);

  const zurJetzt = () => {
    setAuswahl(null);
    setFenster(null);
  };
  const schritt = (d: -1 | 1) => {
    if (!z) return;
    const von = auswahl ?? (z.jetzt >= 0 ? z.jetzt : z.ab);
    setFenster(null);
    setAuswahl(Math.max(0, Math.min(z.viertel.length - 1, von + d)));
  };

  const zeilen = (
    <div className="vp-pz-zeilen">
      <button type="button" className="vp-pz-zeile" onClick={() => setBlatt('rueckblick')}>
        <span className="vp-pz-zeile-ico" aria-hidden="true">
          <Icon name="history" size={18} />
        </span>
        <span className="vp-pz-zeile-text">
          <b>Rückblick</b>
          <small>Woche, Monat, Jahr</small>
        </span>
        <span className="vp-pz-zeile-pfeil" aria-hidden="true">
          <Icon name="chevron-right" size={18} />
        </span>
      </button>
      <a className="vp-pz-zeile" href={`#/anlage/${site.id}/fahrplan`}>
        <span className="vp-pz-zeile-ico" aria-hidden="true">
          <Icon name="calendar" size={18} />
        </span>
        <span className="vp-pz-zeile-text">
          <b>Ihr Fahrplan</b>
          <small>nutzt genau diese Preise</small>
        </span>
        <span className="vp-pz-zeile-pfeil" aria-hidden="true">
          <Icon name="chevron-right" size={18} />
        </span>
      </a>
      {!isPhone && (
        <button type="button" className="vp-pz-zeile" onClick={() => setBlatt('erklaerung')}>
          <span className="vp-pz-zeile-ico" aria-hidden="true">
            <Icon name="info" size={18} />
          </span>
          <span className="vp-pz-zeile-text">
            <b>Der Börsenpreis</b>
            <small>was er ist, Werte in EUR/MWh</small>
          </span>
          <span className="vp-pz-zeile-pfeil" aria-hidden="true">
            <Icon name="chevron-right" size={18} />
          </span>
        </button>
      )}
    </div>
  );

  let inhalt;
  if (laedt && !history) {
    inhalt = (
      <div className="vp-c-card">
        <VerlaufKarteSkeleton legende={false} />
      </div>
    );
  } else if (fehler && !history) {
    inhalt = (
      <div className="vp-c-card">
        <VerlaufFehler
          satz={`Die Börsenpreise konnten nicht geladen werden (${fehler}).`}
          onRetry={() => setNeuVersuch((k) => k + 1)}
        />
      </div>
    );
  } else if (!z) {
    inhalt = (
      <>
        <div className="vp-c-card">
          <VerlaufLeer
            label="Noch keine Börsenpreise"
            satz="Die Börsenpreise werden automatisch geladen, sobald die Strombörse sie veröffentlicht (täglich am frühen Nachmittag für den Folgetag)."
          />
        </div>
        {zeilen}
      </>
    );
  } else {
    inhalt = (
      <>
        <div className="vp-pz-oben">
          <section className="vp-pz-antwort" aria-live="polite" aria-label="Börsenpreis">
            <PreisAntwort
              z={z}
              auswahl={auswahl}
              fenster={fenster}
              onInfo={() => setBlatt('erklaerung')}
              onSchritt={schritt}
              onJetzt={zurJetzt}
            />
          </section>
          {z.guenstigste && z.teuerste && (
            <div className="vp-pz-kacheln">
              <PreisKachel
                z={z}
                art="guenstigste"
                block={z.guenstigste}
                aktiv={fenster === 'guenstigste'}
                onWahl={() => {
                  setAuswahl(null);
                  setFenster((f) => (f === 'guenstigste' ? null : 'guenstigste'));
                }}
              />
              <PreisKachel
                z={z}
                art="teuerste"
                block={z.teuerste}
                aktiv={fenster === 'teuerste'}
                onWahl={() => {
                  setAuswahl(null);
                  setFenster((f) => (f === 'teuerste' ? null : 'teuerste'));
                }}
              />
            </div>
          )}
        </div>
        <div className="vp-c-card vp-pz-karte">
          <PreisZeitstrahlBild
            z={z}
            plan={plan}
            auswahl={auswahl}
            fenster={fenster}
            breit={!isPhone}
            onWahl={(i) => {
              setFenster(null);
              setAuswahl(i === z.jetzt ? null : i);
            }}
            onJetzt={zurJetzt}
          />
          <PreisLegende z={z} plan={plan != null} />
        </div>
        {zeilen}
      </>
    );
  }

  return (
    <div className="vp-pz">
      <VerlaufKopf titel="Marktpreise" />
      {inhalt}
      <Modal open={blatt === 'rueckblick'} onClose={() => setBlatt(null)} title="Rückblick" blatt breit>
        {blatt === 'rueckblick' && (
          <PreisRueckblick
            site={site}
            range={rbRange}
            anker={rbAnker}
            onRange={(r) => {
              setRbRange(r);
              setRbAnker(new Date());
            }}
            onAnker={setRbAnker}
          />
        )}
      </Modal>
      <Modal open={blatt === 'erklaerung'} onClose={() => setBlatt(null)} title="Der Börsenpreis" blatt>
        <PreisErklaerung z={z} zone={site.biddingZone} />
      </Modal>
    </div>
  );
}

/**
 * Das Erklär-Blatt: was der Börsenpreis ist, warum der Endpreis höher liegt,
 * was die drei Stufen heißen — und die Profi-Zahlen in EUR/MWh.
 */
function PreisErklaerung({ z, zone }: { z: Zeitstrahl | null; zone: string }) {
  const eur = (ct: number | null) =>
    ct == null
      ? null
      : `${(ct * 10).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} EUR/MWh`;
  const jetzt = z && z.jetzt >= 0 ? z.viertel[z.jetzt].ct : null;
  const bis = z && hatFolgetag(z) ? 'bis morgen' : 'bis Mitternacht';
  const zeilen = [
    { id: 'jetzt', name: 'Jetzt', wert: eur(jetzt) },
    { id: 'tief', name: `Tief ${bis}`, wert: eur(z?.tief ?? null) },
    { id: 'hoch', name: `Hoch ${bis}`, wert: eur(z?.hoch ?? null) },
    { id: 'zone', name: 'Gebotszone', wert: zone || null },
    { id: 'quelle', name: 'Quelle', wert: 'energy-charts.info (Fraunhofer ISE)' },
  ].filter((r): r is { id: string; name: string; wert: string } => r.wert != null);
  return (
    <div className="vp-pz-erklaerung">
      <p>{MARKTPREISE_LEAD}</p>
      <p>
        Der Börsenpreis ist der Preis, zu dem Strom für jede Viertelstunde an der Strombörse gehandelt
        wird. Er steht am Vortag gegen 13 Uhr fest.
      </p>
      <p>
        <b>Ihr Endpreis ist höher:</b> dazu kommen Aufschlag, Netzentgelt, Abgaben und Steuern.
      </p>
      <p>
        <b>Günstig, mittel, teuer</b> vergleicht mit den kommenden Stunden bis zum letzten bekannten
        Preis. Jede Stufe ist ein Drittel davon.
      </p>
      {z && z.jetzt >= 0 && jetzt != null && (
        <p>
          Jetzt: <b>{ct1(jetzt)}&nbsp;ct/kWh</b>.
        </p>
      )}
      <ProfiZahlen zeilen={zeilen} />
    </div>
  );
}

/** Kurzes Datum für den Abdeckungs-Hinweis. */
function kurzesDatum(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Der Rückblick (E3 = A) — Tag, Woche, Monat, Jahr im Blatt. Es ist die
 * frühere Zeitraum-Ansicht des Reiters, unverändert in ihren Zahlen: dieselbe
 * Kurve (`PriceHistoryChart`), dieselben Kennzahl-Zeilen, dasselbe
 * Profi-Detail in EUR/MWh.
 */
function PreisRueckblick({
  site,
  range,
  anker,
  onRange,
  onAnker,
}: {
  site: Site;
  range: HistoryRange;
  anker: Date;
  onRange: (r: HistoryRange) => void;
  onAnker: (d: Date) => void;
}) {
  const [history, setHistory] = useState<PriceHistory | null>(null);
  const [laedt, setLaedt] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [neuVersuch, setNeuVersuch] = useState(0);
  const [profiOffen, setProfiOffen] = useState(false);
  const at = isoDate(anker);

  useEffect(() => {
    let aktiv = true;
    setLaedt(true);
    setFehler(null);
    api
      .priceHistory(site.id, range, at)
      .then((h) => aktiv && setHistory(h))
      .catch((e) => aktiv && setFehler(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => aktiv && setLaedt(false));
    return () => {
      aktiv = false;
    };
  }, [site.id, range, at, neuVersuch]);

  const summary = history?.summary ?? null;
  const hatDaten = (history?.buckets.length ?? 0) > 0 && (summary?.count ?? 0) > 0;
  const teilweise =
    range !== 'day' && hatDaten && summary?.coverageStart && history
      ? new Date(summary.coverageStart).getTime() - new Date(history.from).getTime() > 36 * 3600 * 1000
      : false;
  const naechsterGesperrt = shiftAnchor(anker, range, 1) > new Date();

  return (
    <div className="vp-pz-rueckblick">
      <ZeitSegment label="Zeitraum" optionen={PERIOD_RANGES} wert={range} onWert={onRange} />
      <ZeitBlaetterer
        label={periodLabel(anker, range)}
        onZurueck={() => onAnker(shiftAnchor(anker, range, -1))}
        onVor={() => onAnker(shiftAnchor(anker, range, 1))}
        vorDisabled={naechsterGesperrt}
        onJetzt={() => onAnker(new Date())}
      />
      {laedt && <VerlaufKarteSkeleton legende={false} />}
      {!laedt && fehler && (
        <VerlaufFehler
          satz={`Die Börsenpreise konnten nicht geladen werden (${fehler}).`}
          onRetry={() => setNeuVersuch((k) => k + 1)}
        />
      )}
      {!laedt && !fehler && !hatDaten && (
        <VerlaufLeer
          label="Keine Börsenpreise in diesem Zeitraum"
          satz={
            summary?.coverageStart
              ? `Preise liegen erst ab dem ${kurzesDatum(summary.coverageStart)} vor - der Rückblick füllt sich Tag für Tag.`
              : 'Für diesen Zeitraum liegen noch keine gespeicherten Preise vor. Der Rückblick füllt sich Tag für Tag.'
          }
        />
      )}
      {!laedt && !fehler && hatDaten && history && summary && (
        <>
          <PriceHistoryChart history={history} />
          <PreisZeilen
            zeilen={preisZeilen(summary, range, history.bucket)}
            label={range === 'day' ? 'Tief, Hoch und Durchschnitt des Tages' : 'Tief, Hoch und Durchschnitt im Zeitraum'}
          />
          {teilweise && summary.coverageStart && (
            <p className="vp-mp-note">
              Für diesen Zeitraum liegen erst Preise ab dem {kurzesDatum(summary.coverageStart)} vor -
              ältere Börsenpreise wurden noch nicht erfasst.
            </p>
          )}
          <Aufklapper titel="Profi-Detail (EUR/MWh)" open={profiOffen} onToggle={() => setProfiOffen((o) => !o)}>
            <ProfiZahlen zeilen={profiZeilen(summary)} />
            <p className="vp-mp-note">
              Quelle: energy-charts.info (Fraunhofer ISE). Preise sind marktweit je Gebotszone{' '}
              {site.biddingZone}, nicht pro Anlage.
            </p>
          </Aufklapper>
        </>
      )}
    </div>
  );
}
