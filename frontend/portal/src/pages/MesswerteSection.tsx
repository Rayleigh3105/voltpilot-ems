import { useCallback, useEffect, useMemo, useState } from 'react';
import { ladeCsv } from '../ladeCsv';
import type { HistoryRange, Site } from '../api';
import { isoDate, periodLabel } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';
import {
  keineVergleichsDatenText,
  normalisiereModus,
  ueberlagerungAktiv,
  vergleichsAnkerFor,
  wirksamerModus,
  type VergleichsModus,
} from '../historieVergleich';
import { abdeckungView, ankerAusWert, mitVergleich, parseVergleichModus } from '../historieZeit';
import { isCurrentPeriod } from '../energieBilanz';
import { ereignisSpur } from '../historieEreignisse';
import { historieHash, WELTEN, type WeltId } from '../historieWelten';
import { useHistoryPeriod, useVergleichsPeriode } from '../useHistoryPeriod';
import type { AnlageSurface } from '../surface';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { standTime } from '../datenAlter';
import { csvDateiname } from '../erloeseSeite';
import {
  aufloesungText,
  ENERGIE_SPALTEN,
  energieBilanzView,
  energieCsv,
  energieKennzahlen,
  energieQuoten,
  energieSpitzen,
  energieTabelle,
  energieTabellenZellen,
  energieTag,
} from '../energieSeite';
import { chartTheme } from '../chartTheme';
import { VerlaufFehler, VerlaufKarteSkeleton, VerlaufLeer } from '../components/States';
import { PeriodeFehlgeschlagen, ZeitLeiste } from '../components/HistorieWelt';
import {
  Kennzahl,
  Kennzahlen,
  VerlaufStatus,
  VrKarte,
  VrLegende,
  VrTabelle,
  VrUmschalter,
  type LegendenEintrag,
} from '../components/VerlaufRahmen';
import {
  EnergieBilanzChart,
  EnergieTagChart,
  type BilanzReihe,
  type TagReihe,
} from '../components/energie/EnergieCharts';
import { EreignisseKarte, QuotenKarte, rollenFarbe, SpitzenKarte } from '../components/energie/EnergieKarten';

/**
 * **Verlauf › Energie** (`#/anlage/{id}/messwerte`) — Konzept „Verlauf-Rework",
 * Paket P3, Entscheide E2/E4/E5 = A.
 *
 * 1. **Kennzahlen** — die sechs Energiemengen des Zeitraums, jede mit
 *    ehrlichem Vergleich.
 * 2. **Verlauf** — am Tag drei Felder über einer Zeitachse (Erzeugung und
 *    Verbrauch, Netz, Ladestand; Börsenpreis zuschaltbar), ab der Woche die
 *    gespiegelte Bilanz: oben woher die Energie kam, unten wohin sie ging.
 *    Umschaltbar auf die Tabelle (mit CSV).
 * 3. **Seitenspalte** — Autarkie und Eigenverbrauch als Balken, die Spitzen
 *    des Zeitraums.
 * 4. **Ereignisse** — das Auffällige als Liste.
 *
 * Die Route heißt aus Gründen der Lesezeichen weiter `messwerte`; die
 * einzelnen Messwerte wohnen im eigenen Reiter „Messwerte" (`einzelwerte`).
 */

const ANSICHTEN = [
  { id: 'diagramm', label: 'Diagramm' },
  { id: 'tabelle', label: 'Tabelle' },
] as const;
type Ansicht = (typeof ANSICHTEN)[number]['id'];

const TITEL: Record<HistoryRange, string> = {
  day: 'Leistung im Tagesverlauf',
  week: 'Energiebilanz je Tag',
  month: 'Energiebilanz je Tag',
  year: 'Energiebilanz je Monat',
};

const TAG_REIHEN: { id: TagReihe; label: string; rolle: 'pv' | 'load' | 'grid' | 'soc' }[] = [
  { id: 'pv', label: 'Erzeugung', rolle: 'pv' },
  { id: 'load', label: 'Verbrauch', rolle: 'load' },
  { id: 'netz', label: 'Netz', rolle: 'grid' },
  { id: 'soc', label: 'Ladestand', rolle: 'soc' },
];

const BILANZ_REIHEN: { id: BilanzReihe; label: string }[] = [
  { id: 'pv', label: 'Erzeugung' },
  { id: 'load', label: 'Verbrauch' },
  { id: 'netz', label: 'Netz' },
  { id: 'speicher', label: 'Speicher' },
];


export function MesswerteSection({
  site,
}: {
  site: Site;
  /** ⚠ Reserviert: die Seite leitet daraus nichts ab (die Reiter entscheidet `anlageNav`). */
  surface?: AnlageSurface | null;
  /** ⚠ Reserviert und ohne Wirkung — der Reiter-Wechsel wohnt in `BereichTabs`. */
  onOpenWelt?: (welt: WeltId) => void;
}) {
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [range, setRange] = useState<HistoryRange>(init.range);
  const [anchor, setAnchor] = useState<Date>(() =>
    init.at ? new Date(`${init.at}T12:00:00`) : new Date(),
  );
  const [modusWahl, setModusWahl] = useState<VergleichsModus>(() =>
    parseVergleichModus(window.location.hash),
  );
  const [ansicht, setAnsicht] = useState<Ansicht>('diagramm');
  const [tagAus, setTagAus] = useState<ReadonlySet<TagReihe>>(() => new Set(['preis']));
  const [bilanzAus, setBilanzAus] = useState<ReadonlySet<BilanzReihe>>(() => new Set());

  const at = isoDate(anchor);
  const { history, loading, stale, err, retry } = useHistoryPeriod(site.id, range, at);
  const modus = normalisiereModus(modusWahl, anchor, range, history?.coverage);
  const vorher = useVergleichsPeriode(
    site.id,
    range,
    anchor,
    !stale && (history?.buckets.length ?? 0) > 0,
    wirksamerModus(modus),
  );
  const vergleichHinweis =
    ueberlagerungAktiv(modus) && vorher != null && vorher.buckets.length === 0
      ? keineVergleichsDatenText(anchor, range, modus)
      : null;

  const schreibeAdresse = useCallback(
    (r: HistoryRange, a: Date, m: VergleichsModus) => {
      replaceCurrentNavigation(mitVergleich(historieHash(site.id, 'messwerte', r, isoDate(a)), m));
    },
    [site.id],
  );
  const zeigeZeitraum = useCallback(
    (r: HistoryRange, a: Date) => {
      setRange(r);
      setAnchor(a);
      schreibeAdresse(r, a, modusWahl);
    },
    [modusWahl, schreibeAdresse],
  );
  const aendereModus = useCallback(
    (m: VergleichsModus) => {
      setModusWahl(m);
      schreibeAdresse(range, anchor, m);
    },
    [range, anchor, schreibeAdresse],
  );

  useEffect(() => {
    const onHash = () => {
      const p = parseVerlaufParams(window.location.hash);
      setModusWahl(parseVergleichModus(window.location.hash));
      setRange(p.range);
      setAnchor(p.at ? new Date(`${p.at}T12:00:00`) : new Date());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const now = useMemo(() => new Date(), [history, range, at]);
  const laeuft = isCurrentPeriod(anchor, range, now);
  const label = periodLabel(anchor, range);

  const kennzahlen = useMemo(
    () => energieKennzahlen({ history, vorher, anchor, range, now, modus: wirksamerModus(modus) }),
    [history, vorher, anchor, range, now, modus],
  );
  const tag = useMemo(
    () => (history && range === 'day' ? energieTag(history, anchor, now) : null),
    [history, range, anchor, now],
  );
  const bilanz = useMemo(
    () => (history && range !== 'day' ? energieBilanzView(history, anchor, range, now) : null),
    [history, range, anchor, now],
  );
  const tabellenZellen = useMemo(
    () => (history ? energieTabellenZellen(history, anchor, range, now) : []),
    [history, anchor, range, now],
  );
  const tabelle = useMemo(
    () => (history ? energieTabelle(tabellenZellen, history, range) : null),
    [tabellenZellen, history, range],
  );
  // F8: der gewählte Vergleich liegt blass hinter dem Bild — nach Position im
  // Zeitraum (1. Juni neben 1. Juli), benannt mit seinem Zeitraum.
  const ueberlagern = ueberlagerungAktiv(modus) && vorher != null && vorher.buckets.length > 0;
  const vorherAnker = useMemo(() => vergleichsAnkerFor(anchor, range, wirksamerModus(modus)), [anchor, range, modus]);
  const vergleichName = ueberlagern ? periodLabel(vorherAnker, range) : null;
  const tagVergleich = useMemo(
    () =>
      ueberlagern && vorher && range === 'day' && vergleichName
        ? { name: vergleichName, tag: energieTag(vorher, vorherAnker, now) }
        : null,
    [ueberlagern, vorher, range, vergleichName, vorherAnker, now],
  );
  const bilanzVergleich = useMemo(
    () =>
      ueberlagern && vorher && range !== 'day' && vergleichName
        ? { name: vergleichName, bilanz: energieBilanzView(vorher, vorherAnker, range, now) }
        : null,
    [ueberlagern, vorher, range, vergleichName, vorherAnker, now],
  );
  const quoten = useMemo(() => (history ? energieQuoten(history) : []), [history]);
  const spitzen = useMemo(() => (history ? energieSpitzen(history, range) : null), [history, range]);
  const spur = useMemo(() => (history ? ereignisSpur(history) : null), [history]);

  const tagSichtbar = useMemo(
    () => new Set<TagReihe>((['pv', 'load', 'netz', 'soc', 'preis'] as TagReihe[]).filter((r) => !tagAus.has(r))),
    [tagAus],
  );
  const bilanzSichtbar = useMemo(
    () => new Set<BilanzReihe>((['pv', 'load', 'netz', 'speicher'] as BilanzReihe[]).filter((r) => !bilanzAus.has(r))),
    [bilanzAus],
  );
  const umschalten = <T,>(set: ReadonlySet<T>, id: T, alle: number): Set<T> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else if (next.size < alle - 1) next.add(id);
    return next;
  };

  const oeffneTag = useCallback(
    (wert: string) => {
      const ziel = ankerAusWert(wert, 'day');
      if (ziel) zeigeZeitraum('day', ziel);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [zeigeZeitraum],
  );
  const oeffneZelle = useCallback(
    (i: number) => {
      const z = bilanz?.zellen[i];
      if (!z || !bilanz) return;
      const a = new Date(z.start.getFullYear(), z.start.getMonth(), z.start.getDate(), 12);
      zeigeZeitraum(bilanz.drill === 'monat' ? 'month' : 'day', a);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [bilanz, zeigeZeitraum],
  );

  const t = chartTheme();
  const abdeckung = abdeckungView(history && !stale ? history.coverage : null);
  const stand = laeuft ? standTime(history?.coverage?.lastDataAt ?? null, now) : null;
  const letzterTag = history?.coverage?.lastDataAt?.slice(0, 10) ?? null;
  const leer = !!history && (history.buckets.length === 0 || kennzahlen.every((k) => k.ton === 'leer'));

  const legende: LegendenEintrag[] = tag
    ? [
        ...TAG_REIHEN.filter((r) => r.id !== 'soc' || tag.hatSoc).map((r) => ({
          id: r.id,
          label: r.label,
          farbe: r.rolle === 'soc' ? t.cSoc : rollenFarbe(r.rolle),
          form: 'linie' as const,
          aktiv: !tagAus.has(r.id),
          onToggle: () => setTagAus((s) => umschalten(s, r.id, 5)),
        })),
        ...(tag.hatPreis
          ? [
              {
                id: 'preis',
                label: tagAus.has('preis') ? '+ Börsenpreis' : 'Börsenpreis',
                farbe: t.cPrice,
                form: 'linie' as const,
                aktiv: !tagAus.has('preis'),
                zuschalten: true,
                onToggle: () =>
                  setTagAus((s) => {
                    const next = new Set(s);
                    if (next.has('preis')) next.delete('preis');
                    else next.add('preis');
                    return next;
                  }),
              },
            ]
          : []),
      ]
    : BILANZ_REIHEN.map((r) => ({
        id: r.id,
        label: r.label,
        farbe: r.id === 'pv' ? t.cPv : r.id === 'load' ? t.cLoad : r.id === 'netz' ? t.cGrid : t.cBatt,
        form: 'flaeche' as const,
        aktiv: !bilanzAus.has(r.id),
        onToggle: () => setBilanzAus((s) => umschalten(s, r.id, 4)),
      }));
  if (vergleichName) {
    legende.push({ id: 'vgl', label: `Vergleich: ${vergleichName}`, farbe: t.cPrice2, form: 'linie' });
  }

  return (
    <div className="vp-vr">
      <h1 className="vp-sr-only">Energie — Gemessen</h1>
      <ZeitLeiste
        range={range}
        anchor={anchor}
        onRange={(r) => zeigeZeitraum(r, anchor)}
        onAnchor={(a) => zeigeZeitraum(range, a)}
        coverage={history?.coverage}
        stale={stale}
        vergleich={modus}
        onVergleich={aendereModus}
        vergleichHinweis={vergleichHinweis}
        abdeckungInStatus
      />
      <VerlaufStatus
        art="gemessen"
        aufloesung={aufloesungText(history)}
        laeuft={laeuft ? (stand ? `Stand ${stand}` : 'Zwischenstand') : null}
        abdeckung={abdeckung ? [abdeckung.satz, abdeckung.luecken].filter(Boolean).join(' · ') : null}
        alt={stale}
        info={{ titel: 'So entstehen die Werte', text: [WELTEN.messwerte.fussText, abdeckung?.abText ? `${abdeckung.abText}.` : null].filter(Boolean).join(' ') }}
      />

      <div className={`vp-vr-body${stale ? ' alt' : ''}`} aria-busy={loading || undefined}>
        {err && !history ? (
          <VrKarte titel="Energie" label="Energie konnte nicht geladen werden">
            <VerlaufFehler satz={`Die Historie konnte nicht geladen werden (${err}).`} onRetry={retry} />
          </VrKarte>
        ) : !history ? (
          loading ? (
            <VrKarte titel={TITEL[range]}>
              <VerlaufKarteSkeleton />
            </VrKarte>
          ) : null
        ) : leer ? (
          <VrKarte titel={TITEL[range]}>
            <VerlaufLeer
              label="Keine Messwerte in diesem Zeitraum"
              satz={`Für ${label} liegen keine Messwerte vor.`}
              weg={letzterTag ? 'Zum letzten Tag mit Daten ›' : undefined}
              onWeg={letzterTag ? () => oeffneTag(letzterTag) : undefined}
            />
          </VrKarte>
        ) : (
          <>
            {err && stale && <PeriodeFehlgeschlagen periode={label} onRetry={retry} />}

            <Kennzahlen label={`Energie · ${label}`} gleich anzahl={kennzahlen.length}>
              {kennzahlen.map((k) => (
                <Kennzahl
                  key={k.key}
                  label={k.label}
                  wert={k.wert}
                  ton={k.ton}
                  farbe={rollenFarbe(k.rolle)}
                  info={k.info}
                  unter={
                    k.unter ? (
                      <>
                        {k.pfeil && <span className="vp-vr-dlt" aria-hidden="true">{k.pfeil} </span>}
                        {k.unter}
                      </>
                    ) : null
                  }
                />
              ))}
            </Kennzahlen>

            <div className="vp-vr-row">
              <VrKarte
                titel={TITEL[range]}
                info={
                  range === 'day'
                    ? null
                    : {
                        titel: 'Energiebilanz',
                        text: 'Oben steht, woher die Energie kam (Erzeugung, Netzbezug, Speicher), unten, wohin sie ging (Verbrauch, Einspeisung, Speicher). Beide Seiten sind gleich groß.',
                      }
                }
                aktionen={<VrUmschalter label="Ansicht" optionen={ANSICHTEN} wert={ansicht} onWert={setAnsicht} />}
              >
                {ansicht === 'diagramm' ? (
                  <>
                    <VrLegende eintraege={legende} label="Reihen ein- und ausblenden" />
                    {tag && (
                      <EnergieTagChart
                        tag={tag}
                        vergleich={tagVergleich}
                        sichtbar={tagSichtbar}
                        label={`${TITEL.day} · ${label}`}
                      />
                    )}
                    {bilanz && (
                      <EnergieBilanzChart
                        bilanz={bilanz}
                        vergleich={bilanzVergleich}
                        sichtbar={bilanzSichtbar}
                        onZelle={oeffneZelle}
                        label={`${TITEL[range]} · ${label}`}
                      />
                    )}
                  </>
                ) : (
                  tabelle && (
                    <VrTabelle
                      titel={`Energie · ${label}`}
                      spalten={ENERGIE_SPALTEN}
                      zeilen={tabelle.zeilen}
                      summe={tabelle.summe}
                      onZeile={
                        range === 'day'
                          ? undefined
                          : (id) => {
                              const i = tabellenZellen.findIndex((z) => z.schluessel === id);
                              const z = tabellenZellen[i];
                              if (!z) return;
                              const a = new Date(z.start.getFullYear(), z.start.getMonth(), z.start.getDate(), 12);
                              zeigeZeitraum(range === 'year' ? 'month' : 'day', a);
                            }
                      }
                      zeileTitel={range === 'year' ? 'Monat öffnen' : 'Tag öffnen'}
                      fuss={
                        <button
                          type="button"
                          className="vp-vr-textbtn"
                          onClick={() =>
                            ladeCsv(energieCsv(tabellenZellen, history, range), csvDateiname('energie', site.name, range, at))
                          }
                        >
                          Als CSV herunterladen
                        </button>
                      }
                    />
                  )
                )}
              </VrKarte>
              <div className="vp-vr-col">
                <QuotenKarte quoten={quoten} />
                {spitzen && <SpitzenKarte titel={spitzen.titel} zeilen={spitzen.zeilen} />}
              </div>
            </div>

            {spur && <EreignisseKarte spur={spur} onTag={range === 'day' ? undefined : oeffneTag} />}
          </>
        )}
      </div>
    </div>
  );
}
