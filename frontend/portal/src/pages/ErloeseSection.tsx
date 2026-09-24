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
import { abdeckungView, mitVergleich, parseVergleichModus } from '../historieZeit';
import { erloesVergleich, vollerVergleichsName } from '../vergleichLaufend';
import { erloesErgebnis } from '../erloesKomposition';
import { ebene2, speicherSchritte, type SpeicherSchritteInput } from '../erloesEbenen';
import { isCurrentPeriod } from '../energieBilanz';
import { soVerdient } from '../soVerdient';
import { historieHash, WELTEN, type WeltId } from '../historieWelten';
import { useHistoryPeriod } from '../useHistoryPeriod';
import { useSiteEarnings, useVergleichsErloese } from '../useSiteEarnings';
import type { AnlageSurface } from '../surface';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { einstellungenHash } from '../settingsNav';
import { standTime } from '../datenAlter';
import { speicherAussage } from '../speicherAussage';
import type { SekundaerZiel } from '../erloesZeilen';
import {
  abrechnung,
  csvDateiname,
  erloesKennzahlen,
  mehrwertBand,
  GELD_SPALTEN,
  geldCsv,
  geldDiagramm,
  geldTabelle,
  lastspitzeKontext,
  stundenPreise,
  type GeldId,
} from '../erloeseSeite';
import { chartTheme } from '../chartTheme';
import { VerlaufFehler, VerlaufKarteSkeleton, VerlaufLeer } from '../components/States';
import { PeriodeFehlgeschlagen, WeltKopf, ZeitLeiste } from '../components/HistorieWelt';
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
import { ErloeseChart, type ErloeseModus } from '../components/erloese/ErloeseChart';
import {
  AbrechnungKarte,
  LastspitzeKarte,
  PreiseKarte,
  MehrwertErklaerung,
} from '../components/erloese/ErloeseKarten';
import { SoVerdientInhalt } from '../components/SoVerdient';
import { RechenZeilen, SteuerungFormel } from '../components/SteuerungFormel';

/**
 * **Verlauf › Erlöse** (`#/anlage/{id}/erloese`) — Konzept „Verlauf-Rework",
 * Paket P2, Entscheide E3/E5/E6 = A.
 *
 * Die Seite liest sich wie eine Abrechnung:
 *
 * 1. **Kennzahlen** — das Ergebnis des Zeitraums groß, daneben Eigenverbrauch,
 *    Einspeisung und Netzbezug; jede mit Menge bzw. Vergleich als Unterzeile.
 *    Als letzte Kachel, leicht hervorgehoben: **VoltPilot-Steuerung** — was
 *    die Steuerung gegenüber demselben Speicher ohne smarte Steuerung
 *    gebracht hat („+ 1,45 € · mehr als ohne smarte Steuerung"); Maßstab und
 *    Rechnung im ⓘ. Sie ist kein Anteil des Ergebnisses und steht deshalb
 *    nicht in der Abrechnung.
 * 2. **Verlauf** — Säulen mit Vorzeichen (Erlöse oben, Kosten unten, Ergebnis
 *    als Punkt), umschaltbar auf „Kumuliert" und auf die Tabelle. Am Tag
 *    steht darunter der Börsenpreis derselben Stunde.
 * 3. **Abrechnung** — Menge × Ø Preis = Betrag je Posten, darunter der Strich.
 * 4. **Kontext** — Preise im Zeitraum, Lastspitze; bei
 *    Direktvermarktung die Einordnung gegen den Markt.
 *
 * Erklärungen stehen auf Abruf (ⓘ am Begriff, Statuszeile, Hilfeartikel) —
 * nie als Absatz im Weg. Alle Zahlen kommen aus reinen Ableitungen
 * (`erloeseSeite.ts`, `speicherAussage.ts`, `erloesEbenen.ts`).
 */

const TITEL: Record<HistoryRange, string> = {
  day: 'Erlöse je Stunde',
  week: 'Erlöse je Tag',
  month: 'Erlöse je Tag',
  year: 'Erlöse je Monat',
};

/** EIN Umschalter für die drei Sichten auf denselben Verlauf. */
const ANSICHTEN = [
  { id: 'saeulen', label: 'Säulen' },
  { id: 'kumuliert', label: 'Kumuliert' },
  { id: 'tabelle', label: 'Tabelle' },
] as const;

type Ansicht = (typeof ANSICHTEN)[number]['id'];

/** Die Kennung einer Kennzahl — dieselbe Rollenfarbe wie im Diagramm. */
function kennzahlFarbe(id: GeldId): string | null {
  const t = chartTheme();
  if (id === 'eigenverbrauch') return t.cPv;
  if (id === 'einspeisung') return t.cGrid;
  if (id === 'netzbezug') return t.cGeldKosten;
  return null;
}


export function ErloeseSection({
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
  const [ansicht, setAnsicht] = useState<Ansicht>('saeulen');
  const darstellung: ErloeseModus = ansicht === 'kumuliert' ? 'kumuliert' : 'saeulen';

  const at = isoDate(anchor);
  const { money, loading, stale, err, retry } = useSiteEarnings(site.id, range, at);
  // Die Historie trägt hier die Datenlage, den geplanten Steuerungs-Wert und
  // am Tag den Börsenpreis je Viertelstunde.
  const { history, stale: historyStale } = useHistoryPeriod(site.id, range, at);
  const modus = normalisiereModus(modusWahl, anchor, range, history?.coverage);
  const vorher = useVergleichsErloese(
    site.id,
    range,
    anchor,
    !stale && money?.nettoErgebnisEur != null,
    wirksamerModus(modus),
  );

  // Zeitraum und Vergleich reisen in der Adresse: ein Neuladen, ein Lesezeichen
  // und der Reiterwechsel zur Energie behalten sie.
  const schreibeAdresse = useCallback(
    (r: HistoryRange, a: Date, m: VergleichsModus) => {
      replaceCurrentNavigation(mitVergleich(historieHash(site.id, 'erloese', r, isoDate(a)), m));
    },
    [site.id],
  );
  const aendereRange = useCallback(
    (r: HistoryRange) => {
      setRange(r);
      schreibeAdresse(r, anchor, modusWahl);
    },
    [anchor, modusWahl, schreibeAdresse],
  );
  const aendereAnker = useCallback(
    (a: Date) => {
      setAnchor(a);
      schreibeAdresse(range, a, modusWahl);
    },
    [range, modusWahl, schreibeAdresse],
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

  // „Jetzt" für diese Antwort — stabil, damit Diagramm und Kennzahlen dieselbe
  // Grenze zwischen Vergangenheit und Zukunft ziehen.
  const now = useMemo(() => new Date(), [money, range, at]);
  const label = periodLabel(anchor, range);
  const laeuft = isCurrentPeriod(anchor, range, now);
  const ueberlagern = ueberlagerungAktiv(modus);
  const vorherAnker = useMemo(
    () => vergleichsAnkerFor(anchor, range, wirksamerModus(modus)),
    [anchor, range, modus],
  );
  const vergleichLabel = ueberlagern ? periodLabel(vorherAnker, range) : null;

  const vergleich = erloesVergleich({
    range,
    anchor,
    now,
    modus,
    jetztEur: money?.nettoErgebnisEur,
    vorherEur: vorher?.nettoErgebnisEur,
    jetztSeries: money?.series,
    vorherSeries: vorher?.series,
  });
  const speicher = speicherAussage(money, {
    now,
    // Die Seite weiß, ob ihr Zeitraum läuft — auch wenn die Antwort kein `to` trägt.
    laeuft,
    steuerungGeplantEur: history && !historyStale ? history.totals.steuerungPlannedEur : null,
  });
  const kennzahlen = erloesKennzahlen({
    money,
    vergleich,
    vergleichVoll: vollerVergleichsName(anchor, range, wirksamerModus(modus)),
  });
  const band = mehrwertBand(speicher, range);

  const diagramm = useMemo(
    () =>
      geldDiagramm({
        money,
        anchor,
        range,
        now,
        vorher: ueberlagern ? vorher : null,
        vorherAnker,
      }),
    [money, vorher, ueberlagern, vorherAnker, anchor, range, now],
  );
  const preise = useMemo(
    () =>
      range === 'day' && history && !historyStale ? stundenPreise(history.buckets, diagramm.zellen) : null,
    [range, history, historyStale, diagramm],
  );
  const tabelle = useMemo(() => geldTabelle(diagramm, money), [diagramm, money]);

  const hrefFor = useCallback(
    (ziel: SekundaerZiel) => einstellungenHash(site.id, ziel === 'tarif' ? 'geld' : 'anlage'),
    [site.id],
  );

  // Ein Klick auf eine Säule (bzw. auf den Zeitraum einer Tabellenzeile)
  // öffnet die Zelle: Woche/Monat → Tag, Jahr → Monat.
  const oeffneZelle = useCallback(
    (i: number) => {
      const z = diagramm.zellen[i];
      if (!z || !diagramm.drill) return;
      const ziel = diagramm.drill === 'tag' ? 'day' : 'month';
      const a = new Date(z.start.getFullYear(), z.start.getMonth(), z.start.getDate(), 12);
      setRange(ziel);
      setAnchor(a);
      schreibeAdresse(ziel, a, modusWahl);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [diagramm, modusWahl, schreibeAdresse],
  );

  const abdeckung = abdeckungView(history && !historyStale ? history.coverage : null);
  const stand = laeuft ? standTime(history?.coverage?.lastDataAt ?? null, now) : null;
  const vergleichHinweis =
    ueberlagern && vorher != null && vorher.series.length === 0
      ? keineVergleichsDatenText(anchor, range, modus)
      : null;

  const t = chartTheme();
  const legende: LegendenEintrag[] =
    darstellung === 'kumuliert'
      ? [
          { id: 'kum', label: 'Ergebnis kumuliert', farbe: t.ink, form: 'linie' },
          ...(diagramm.vergleichKumuliert && vergleichLabel
            ? [{ id: 'vgl', label: vergleichLabel, farbe: t.cPrice2, form: 'linie' as const }]
            : []),
        ]
      : [
          { id: 'eigen', label: 'Eigenverbrauch', farbe: t.cPv, form: 'flaeche' },
          { id: 'einsp', label: 'Einspeisung', farbe: t.cGrid, form: 'flaeche' },
          { id: 'kosten', label: 'Netzbezug', farbe: t.cGeldKosten, form: 'flaeche' },
          { id: 'netto', label: 'Ergebnis', farbe: t.ink, form: 'punkt' },
          ...(diagramm.vergleichNetto && vergleichLabel
            ? [{ id: 'vgl', label: `Ergebnis ${vergleichLabel}`, farbe: t.cPrice2, form: 'linie' as const }]
            : []),
          ...(preise?.some((p) => p != null)
            ? [{ id: 'preis', label: 'Börsenpreis', farbe: t.cPrice, form: 'linie' as const }]
            : []),
        ];

  // Die Rechnung hinter der Steuerungs-Zahl — Schritte mit den eingesetzten
  // Zahlen, wo die Server-Summen reichen; sonst die Prosa-Fassung.
  const schritteInput: SpeicherSchritteInput | null = money
    ? {
        money,
        steuerungEur: money.savedSteuerungEur ?? null,
        splitReason: money.steuerungSplitReason ?? null,
        steuerungGeplantEur: history && !historyStale ? history.totals.steuerungPlannedEur ?? null : null,
      }
    : null;
  const hatSchritte = schritteInput != null && speicherSchritte(schritteInput).length > 0;
  const formel = hatSchritte ? null : erloesErgebnis({ money, periodLabel: label, now }).steeringFormel;

  const verdient = soVerdient({ money, siteId: site.id });
  const lastspitze = lastspitzeKontext(money);
  const hatErgebnis = money?.nettoErgebnisEur != null;

  return (
    <div className="vp-vr">
      <WeltKopf welt={WELTEN.erloese} />
      <ZeitLeiste
        range={range}
        anchor={anchor}
        onRange={aendereRange}
        onAnchor={aendereAnker}
        coverage={history?.coverage}
        stale={stale}
        vergleich={modus}
        onVergleich={aendereModus}
        vergleichHinweis={vergleichHinweis}
        abdeckungInStatus
      />
      <VerlaufStatus
        art="bewertet"
        laeuft={laeuft ? (stand ? `Stand ${stand}` : 'Zwischenstand') : null}
        abdeckung={abdeckung ? [abdeckung.satz, abdeckung.luecken].filter(Boolean).join(' · ') : null}
        alt={stale}
        info={{ titel: 'So entstehen die Beträge', text: [WELTEN.erloese.fussText, abdeckung?.abText ? `${abdeckung.abText}.` : null].filter(Boolean).join(' ') }}
      />

      <div className={`vp-vr-body${stale ? ' alt' : ''}`} aria-busy={loading || undefined}>
        {err && !money ? (
          <VrKarte titel="Erlöse" label="Erlöse konnten nicht geladen werden">
            <VerlaufFehler satz={`Die Erlöse konnten nicht geladen werden (${err}).`} onRetry={retry} />
          </VrKarte>
        ) : !money ? (
          loading ? (
            <VrKarte titel={TITEL[range]}>
              <VerlaufKarteSkeleton />
            </VrKarte>
          ) : null
        ) : (
          <>
            {err && stale && <PeriodeFehlgeschlagen periode={label} onRetry={retry} />}

            <Kennzahlen label={`Erlöse · ${label}`} anzahl={kennzahlen.length - 1 + (band ? 1 : 0)}>
              {kennzahlen.map((k) => (
                <Kennzahl
                  key={k.id}
                  haupt={k.id === 'ergebnis'}
                  label={k.label}
                  wert={k.wert}
                  ton={k.ton}
                  farbe={kennzahlFarbe(k.id)}
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
              {band && (
                <Kennzahl
                  hervor={`is-${band.ton}`}
                  label={band.label}
                  wert={band.wert}
                  ton={band.ton === 'leer' ? 'leer' : null}
                  farbe="var(--vp-c-primary)"
                  info={{
                    titel: band.titel,
                    text: (
                      <MehrwertErklaerung
                        band={band}
                        rechnung={
                          hatSchritte && schritteInput ? (
                            <RechenZeilen zeilen={speicherSchritte(schritteInput)} kopf="So wird gerechnet" />
                          ) : formel ? (
                            <SteuerungFormel input={formel} />
                          ) : null
                        }
                      />
                    ),
                  }}
                  unter={
                    band.nachtrag ? (
                      <>
                        {band.unter} ·{' '}
                        <a className="vp-vr-link" href={einstellungenHash(site.id, 'speicher')}>
                          nachtragen ›
                        </a>
                      </>
                    ) : (
                      band.unter
                    )
                  }
                />
              )}
            </Kennzahlen>

            {!hatErgebnis && diagramm.leer ? (
              <VrKarte titel={TITEL[range]}>
                <VerlaufLeer
                  label="Noch kein Ergebnis für diesen Zeitraum"
                  satz={
                    kennzahlen[0].unter ??
                    'Sobald Messwerte und Preise vorliegen, steht hier, was Ihre Anlage eingebracht hat.'
                  }
                />
              </VrKarte>
            ) : (
              <>
                <div className="vp-vr-row">
                  <VrKarte
                    titel={TITEL[range]}
                    aktionen={
                      <VrUmschalter label="Ansicht" optionen={ANSICHTEN} wert={ansicht} onWert={setAnsicht} />
                    }
                  >
                    {ansicht !== 'tabelle' ? (
                      diagramm.leer ? (
                        <p className="vp-vr-empty">Für diesen Zeitraum liegen noch keine bewerteten Werte vor.</p>
                      ) : (
                        <>
                          <VrLegende eintraege={legende} label="Legende" />
                          <ErloeseChart
                            d={diagramm}
                            modus={darstellung}
                            preise={preise}
                            vergleichName={vergleichLabel}
                            onZelle={oeffneZelle}
                            label={`${TITEL[range]} · ${label}`}
                          />
                        </>
                      )
                    ) : (
                      <VrTabelle
                        titel={`${TITEL[range]} · ${label}`}
                        spalten={GELD_SPALTEN}
                        zeilen={tabelle.zeilen}
                        summe={tabelle.summe}
                        hauptSpalte={3}
                        onZeile={
                          diagramm.drill
                            ? (id) => oeffneZelle(diagramm.zellen.findIndex((z) => z.schluessel === id))
                            : undefined
                        }
                        zeileTitel={diagramm.drill === 'monat' ? 'Monat öffnen' : 'Tag öffnen'}
                        fuss={
                          <button
                            type="button"
                            className="vp-vr-textbtn"
                            onClick={() =>
                              ladeCsv(geldCsv(diagramm, money), csvDateiname('erloese', site.name, range, at))
                            }
                          >
                            Als CSV herunterladen
                          </button>
                        }
                      />
                    )}
                  </VrKarte>
                  <AbrechnungKarte a={abrechnung(money)} periode={label} hrefFor={hrefFor} />
                </div>

                <div className="vp-vr-row3">
                  <PreiseKarte
                    ebene2={ebene2({ money, netzladenErlaubt: site.netzladenErlaubt ?? null })}
                    hrefFor={hrefFor}
                  />
                  {lastspitze && <LastspitzeKarte k={lastspitze} detailHref={`#/anlage/${site.id}/lastspitzen`} />}
                </div>

                {verdient && (
                  <VrKarte titel={verdient.titel}>
                    <SoVerdientInhalt view={verdient} />
                  </VrKarte>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
