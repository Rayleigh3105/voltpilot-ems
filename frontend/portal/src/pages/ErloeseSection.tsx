import { useCallback, useEffect, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import type { History, HistoryRange, PlantKind, ProtocolEvent, Site } from '../api';
import { isoDate, periodLabel } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';
import {
  keineVergleichsDatenText,
  normalisiereModus,
  ueberlagerungAktiv,
  ueberlagerungLegende,
  vergleichsKopf,
  wirksamerModus,
  type VergleichsModus,
} from '../historieVergleich';
import { mitVergleich, parseVergleichModus } from '../historieZeit';
import { erloesVergleich } from '../vergleichLaufend';
import { erloesAufklapper, erloesErgebnis, type ErgebnisZeile } from '../erloesKomposition';
import { ergebnisZeilen } from '../erloesZeilen';
import { ebene1, ebene2, speicherSchritte } from '../erloesEbenen';
import { isCurrentPeriod } from '../energieBilanz';
import { soVerdient } from '../soVerdient';
import {
  historieHash,
  WELTEN,
  type WeltId,
} from '../historieWelten';
import { useHistoryPeriod } from '../useHistoryPeriod';
import { useIsPhone } from '../useIsPhone';
import { useSiteEarnings, useVergleichsErloese } from '../useSiteEarnings';
import type { AnlageSurface } from '../surface';
import { replaceCurrentNavigation } from '../navigationBlocker';

import { ChartSubtitle } from '../components/ChartExplain';
import { InfoTip } from '../components/InfoTip';
import { ChartCardSkeleton, EmptyState, ErrorState } from '../components/States';
import { Tagesbild, type TagesbildGeldReihe } from '../components/Tagesbild';
import {
  KartenKopf,
  PeriodeFehlgeschlagen,
  ProvBadge,
  WeltDisclosure,
  WeltFuss,
  WeltKopf,
  ZeitLeiste,
} from '../components/HistorieWelt';
import { ErgebnisZeilen } from '../components/ErgebnisZeilen';
import { Ebene1Panel } from '../components/ErloesEbenen';
import { PreiseZeile } from '../components/erloese/PreiseZeile';
import { SpeicherKarte } from '../components/erloese/SpeicherKarte';
import { ErloeseVerlaufChart } from '../components/ErloeseVerlaufChart';
import { SoVerdientCard } from '../components/SoVerdient';
import { SpeicherSchritte, SteuerungFormel } from '../components/SteuerungFormel';
import { speicherAussage } from '../speicherAussage';

import '../components/Historie.css';
import '../components/Erloese.css';

/**
 * **Welt B · „Erlöse"** (`#/anlage/{id}/erloese`) — die Geld-Welt der Historie
 * (Konzept `data/vp-historie-konzept-t4`, Captain-Struktur H1, Feature **F1**).
 *
 * **Der behobene Fehler war, dass der Tab „Erlöse" keine Erlöse enthielt:** er
 * zeigte zwei Zahlen — Stromkosten (eine KOSTEN-Größe) und die GEPLANTE
 * Speicher-Ersparnis — und für Woche/Monat/Jahr sonst nichts. Der gemessene
 * Erlös derselben Anlage existierte längst, nur eine Fläche weiter. Jetzt führt
 * die Welt mit ihm:
 *
 * 1. **Ergebnis** — die eine große Zahl (Einspeise-Erlös + Wert des
 *    Eigenverbrauchs − Stromkosten), die Zurechnung „davon durch die Steuerung"
 *    als Unterzeile (nie ein weiterer Summand) und das Δ zur Vorperiode.
 * 2. **Geld im Verlauf** — dieselben drei Teile über die Zeit, für JEDEN
 *    Zeitraum (bisher hing das Diagramm an `isDay`).
 * 3. **Was den Preis gemacht hat** — Ø Bezugspreis, erzielter Marktwert gegen
 *    den Monatsdurchschnitt, Marktprämie, Netzladen-Anteil.
 * 4. **Geplante Speicher-Ersparnis** — bleibt, aber mit eigenem Abzeichen
 *    „Geplant": eine Vorher-Rechnung steht nie unbeschriftet neben einer
 *    gemessenen Zahl (report §7).
 * 5. **Der Tag im Detail** — das Tagesbild (Preis · Speicher · Ertrag über
 *    EINER Zeitachse) + Tagesprotokoll.
 *
 * Zwei Abrufe, beide über ihren Cache: die Geld-Zahlen aus dem anlagen-scharfen
 * `GET /sites/{id}/earnings` (P3) und — nur für die geplante Ersparnis und den
 * Tag — die bestehende Historie-Antwort.
 */

const EVENT_ICONS: Record<ProtocolEvent['type'], { icon: IconName; label: string }> = {
  'batterie-laden': { icon: 'arrow-up', label: 'Laden' },
  'batterie-entladen': { icon: 'arrow-down', label: 'Entladen' },
  'pv-spitze': { icon: 'sun', label: 'PV' },
  'preis-tief': { icon: 'trending-down', label: 'Preis-Tief' },
  'preis-hoch': { icon: 'trending-up', label: 'Preis-Hoch' },
};

/**
 * Eine Zeile der Ergebnis-Komposition (Punkt · Name · Operator · Betrag). Das
 * Perioden-Etikett steht NUR, wenn der Stapel wirklich mehrere Perioden mischt
 * — sonst sagt es die Überschrift der Karte schon.
 */
/**
 * **Die Lastspitzen-Zeile** — sie steht AUSSERHALB des Wasserfalls (Konzept
 * `vp-erloese-lesbar-konzept-u3` §3.2 „Lastspitzen-Zeile").
 *
 * Vermiedene Leistungskosten gehören einer EIGENEN Abrechnungsperiode und sind
 * nie ein Summand der einen Zahl. Sie trägt deshalb ihr Perioden-Etikett in der
 * Sekundärzeile; der frühere Nebensatz auf Ebene 0 („Verschiedene Zeiträume …
 * werden getrennt ausgewiesen") wandert in ihr ⓘ — er erklärt eine Methode und
 * kostete acht Wörter im Textbudget.
 *
 * ⚠ KEIN Balken: der Wasserfall hat eine gemeinsame Skala, und diese Zahl
 *   gehört nicht auf sie. Kein Punkt: die Farbe wäre eine Kennung ohne Reihe.
 */
function LastspitzenZeile({ row, note }: { row: ErgebnisZeile; note: string | null }) {
  return (
    <li className="vp-c-led-row">
      <div className="vp-c-led-sum">
        <span className="vp-c-led-name">{row.label}</span>
        <span className={`vp-c-led-val is-${row.eur == null ? 'null' : row.vorzeichen}`}>
          {row.eur == null ? '—' : `${row.vorzeichen === 'minus' ? '−' : '+'} ${row.valueText}`}
        </span>
        <span className="vp-c-led-sek">
          {row.periodLabel} · eigene Periode, nicht im Ergebnis
          {note && (
            <span className="vp-c-info">
              <InfoTip label="Warum steht das getrennt?">{note}</InfoTip>
            </span>
          )}
        </span>
      </div>
    </li>
  );
}

/**
 * „Was den Preis gemacht hat" — der KÖRPER, ohne Karte.
 *
 * Er ist herausgelöst, weil ihn beide Fassungen brauchen: am Schreibtisch in
 * seiner eigenen Karte, am Telefon im Aufklapper. **Ein zweiter Renderer wäre
 * eine zweite Wahrheit** — die Zeilen selbst kommen ohnehin aus dem einen
 * `preisTreiber()`.
 */
/**
 * Der Tagesnachweis — seit Stufe 3 das TAGESBILD: drei Flächen über EINER
 * Zeitachse statt eines Einzelbilds mit drei Y-Achsen (F8 verschärft).
 *
 * Das gemessene Geld reist mit, weil daraus die dritte Fläche („was dabei
 * herauskommt") und der Vergleichsanker im Kopf entstehen — es ist DASSELBE
 * `money`, mit dem die Ergebnis-Karte darüber rechnet, also kann das Bild ihr
 * nicht widersprechen. Fehlt es, entfällt die Fläche ehrlich.
 */
function TagesbildBody({ history, geld, plantKind }: TagesbildBodyProps) {
  return (
    <>
      <ChartSubtitle>
        Der ganze Tag in drei Flächen über einer Zeitachse: was Strom gekostet hat,
        was Ihre Anlage damit gemacht hat und was dabei herausgekommen ist.
      </ChartSubtitle>
      <Tagesbild history={history} geld={geld} plantKind={plantKind} />
    </>
  );
}

interface TagesbildBodyProps {
  history: History;
  geld: TagesbildGeldReihe | null;
  plantKind: PlantKind;
}

/** Das Tagesprotokoll — der Körper, ohne Karte. */
function TagesprotokollBody({ history }: { history: History }) {
  if (history.protocol.length === 0) {
    return (
      <p className="vp-muted">
        Keine besonderen Ereignisse an diesem Tag - keine nennenswerte
        Batterie-Aktivität, PV-Erzeugung oder Preisspreizung erkannt.
      </p>
    );
  }
  return (
    <>
      <ul className="vp-timeline">
        {history.protocol.map((e, i) => {
          const fmt = (iso: string) =>
            new Date(iso).toLocaleTimeString('de-DE', {
              hour: '2-digit',
              minute: '2-digit',
            });
          const oneSlot = new Date(e.end).getTime() - new Date(e.start).getTime() <= 15 * 60000;
          return (
            <li key={`${e.type}-${e.start}-${i}`}>
              <span className="t">
                {oneSlot ? fmt(e.start) : `${fmt(e.start)} - ${fmt(e.end)}`}
              </span>
              <span className="ico" aria-hidden="true">
                {EVENT_ICONS[e.type] ? <Icon name={EVENT_ICONS[e.type].icon} size={16} /> : null}
              </span>
              <span className="txt">{e.text}</span>
            </li>
          );
        })}
      </ul>
      <p className="vp-note" style={{ marginTop: 12 }}>
        Automatisch aus Messwerten und Börsenpreisen des Tages abgeleitet.
      </p>
    </>
  );
}

export function ErloeseSection({
  site,
}: {
  site: Site;
  /**
   * ⚠ Reserviert: seit E3 leitet die Seite daraus nichts mehr ab (die Welten
   * stehen als Bereichs-Reiter, `anlageNav` entscheidet über sie). Die Prop
   * bleibt in der Signatur, weil jeder Aufrufer sie führt.
   */
  surface?: AnlageSurface | null;
  /**
   * ⚠ Reserviert und derzeit ohne Wirkung: der Welt-Wechsel wohnt seit E3 in
   * den Bereichs-Reitern (`anlageNav` Verlauf › Messwerte · Erlöse). Die Prop
   * bleibt optional in der Signatur, damit ein Aufrufer, der sie noch übergibt,
   * nicht bricht.
   */
  onOpenWelt?: (welt: WeltId) => void;
}) {
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [range, setRange] = useState<HistoryRange>(init.range);
  const [anchor, setAnchor] = useState<Date>(() =>
    init.at ? new Date(`${init.at}T12:00:00`) : new Date(),
  );

  // F8: der Vergleichs-Zustand reist in der Adresse (`v=`) - derselbe Parameter
  // wie in der Messwerte-Welt, also nimmt der Welt-Wechsel ihn mit.
  const [modusWahl, setModusWahl] = useState<VergleichsModus>(() =>
    parseVergleichModus(window.location.hash),
  );

  const isPhone = useIsPhone();
  // Der Zustand der Aufklapper lebt in der Sitzung dieser Fläche (das
  // Technik-Muster) - wer eine Erklärung geöffnet hat, findet sie beim
  // Zeitraum-Wechsel offen wieder.
  const [offen, setOffen] = useState<ReadonlySet<string>>(() => new Set());
  const toggleAufklapper = useCallback((id: string) => {
    setOffen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const at = isoDate(anchor);
  // Das Geld dieser Anlage - ein Abruf, eine Anlage, ein Zeitraum (P3).
  const { money, loading, stale, err, retry } = useSiteEarnings(site.id, range, at);
  // Die Historie-Antwort trägt hier nur noch die GEPLANTE Ersparnis und den Tag
  // (Speicher & Preis, Tagesprotokoll) - und die Datenlage der Zeit-Leiste.
  const { history } = useHistoryPeriod(site.id, range, at);
  // F3: der zweite Abruf mit verschobenem Anker - erst, wenn der gezeigte
  // Zeitraum überhaupt Zahlen trägt.
  const modus = normalisiereModus(modusWahl, anchor, range, history?.coverage);
  const vorher = useVergleichsErloese(
    site.id,
    range,
    anchor,
    !stale && money?.nettoErgebnisEur != null,
    wirksamerModus(modus),
  );
  // Ehrlich statt leer: eine Vergleichsperiode ohne bewertete Viertelstunden
  // wird GESAGT, nicht als Null-Linie gezeichnet.
  const vergleichSerie =
    ueberlagerungAktiv(modus) && (vorher?.series.length ?? 0) > 0 ? vorher!.series : null;
  const vergleichHinweis =
    ueberlagerungAktiv(modus) && vorher != null && vorher.series.length === 0
      ? keineVergleichsDatenText(anchor, range, modus)
      : null;

  const setModus = useCallback(
    (m: VergleichsModus) => {
      setModusWahl(m);
      replaceCurrentNavigation(mitVergleich(historieHash(site.id, 'erloese', range, at), m));
    },
    [site.id, range, at],
  );

  // Zurück/Vorwärts oder ein Sprung mit Zeitraum: die Periode neu übernehmen.
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

  const welt = WELTEN.erloese;
  const label = periodLabel(anchor, range);
  const now = new Date();
  const isDay = range === 'day';

  const ergebnis = erloesErgebnis({ money, periodLabel: label, kurzerTitel: isPhone });
  // Ebene 0 der neuen Ergebnis-Karte (Konzept `vp-erloese-seite-konzept-e2`
  // §3.2). Sie ersetzt Hero-Satz und die drei `MiniShareBar`-Zeilen; der Rest
  // der Karte (Speicher, Einordnung) reist unverändert als Slot mit.
  const laeuft = isCurrentPeriod(anchor, range, now);
  const zeilenView = ergebnisZeilen({ money, periodLabel: label, laeuft, range });
  // Die vermiedenen Leistungskosten sind KEIN Summand des Zeitraum-Ergebnisses
  // (eigene Abrechnungsperiode) - sie bleiben deshalb ausserhalb des
  // Wasserfalls und behalten ihr Perioden-Etikett.
  const lastspitzen = ergebnis.rows.filter((r) => r.period === 'billing-period');
  // Das Kombinations-Bild — `null` auf einer nicht direkt vermarkteten Anlage
  // (S9): dort bleibt die Welt byte-gleich wie bisher.
  const verdient = soVerdient({ money, siteId: site.id });
  // Die dritte Fläche des Tagesbilds („was dabei herauskommt") und sein
  // Vergleichsanker im Kopf kommen aus DEMSELBEN `money`, mit dem die
  // Ergebnis-Karte darüber rechnet - es gibt keinen zweiten Geld-Rechner, also
  // kann das Bild der großen Zahl nicht widersprechen.
  const tagesGeld: TagesbildGeldReihe | null = money
    ? {
        savedEur: money.savedEur,
        baselineEur: money.baselineEur,
        actualEur: money.actualEur,
        // Das Bestandskonto reist mit, damit der Kopf des Tagesbilds und die
        // Ergebnis-Karte darüber DIESELBE Bestandszeile ableiten.
        speicherDeltaKwh: money.speicherDeltaKwh,
        speicherWertCtKwh: money.speicherWertCtKwh,
        speicherWertEur: money.speicherWertEur,
        speicherWertBasis: money.speicherWertBasis,
        to: money.to,
        range: money.range,
        series: money.series,
      }
    : null;
  // Am Telefon bleibt der Kartenkopf EINE Zeile (sonst rutscht der Titel auf
  // „Ergebni…"); WELCHER Zeitraum verglichen wird, sagen die Zeilen darunter
  // ohnehin („etwa wie am Vortag" bzw. „· gestern 67,57 €").
  const kopfVergleich =
    vorher && !isPhone ? (
      <span className="vp-karten-vergleich">{vergleichsKopf(anchor, range, modus)}</span>
    ) : undefined;
  // P2 (E3): ein LAUFENDER Tag wird gegen die GLEICHE Stunde des Vortags
  // gerechnet, nicht gegen den vollen Vortag (Befund B3) - die Ableitung liegt
  // rein in `vergleichLaufend.ts` und liefert Chip, Beträge und den Erklärsatz
  // fertig; ein abgeschlossener Zeitraum bekommt unverändert sein `delta()`.
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
  // Welche Aufklapper es am Telefon gibt - ein Aufklapper ohne Karte dahinter
  // wäre ein Versprechen ins Leere.
  const aufklapper = erloesAufklapper({
    hatSoVerdient: verdient != null,
    istTag: isDay,
    hatTagesdaten: history != null,
  });

  // Die Speicher-Erklaerung als SCHRITTE 1-5 mit den eingesetzten Zahlen
  // (Konzept §3.3, Revision 2). Inhaltlich ist es die vom Captain
  // freigegebene Erklaerung; nur die FORM wechselt von Prosa zu Schritten.
  // Ohne die Kassen-Zahlen liefert sie NICHTS, dann bleibt die Prosa-Fassung.
  //
  // ⚠ Die AUFTEILUNG (`savedSpeicherEur`/`savedSteuerungEur`, #591) reist mit —
  //   sonst blieben die Schritte 4 und 5 stumm, und der Aufklapper erklärte
  //   ausgerechnet die Zeile 2 des Blocks darüber („davon Steuerung") nicht.
  //   Ein ÄLTERES Backend liefert die Felder nicht; dann entfallen die zwei
  //   Schritte wortlos (§3.6), der Rest der Rechnung bleibt.
  const speicherSchritteInput = money
    ? {
        money,
        sturEur: money.savedSpeicherEur ?? null,
        steuerungEur: money.savedSteuerungEur ?? null,
        splitReason: money.steuerungSplitReason ?? null,
        geplantEur: history?.totals.batterySavingsPlannedEur ?? null,
      }
    : null;
  const hatSpeicherSchritte =
    speicherSchritteInput != null && speicherSchritte(speicherSchritteInput).length > 0;
  // ---------------------------------------------------------------------
  // DER SPEICHER-BLOCK (Erlöse-Konzept §3.5, Captain-Scoping 2)
  //
  // Er ersetzt die frühere Zurechnungs-Zeile („VoltPilots Steuerung: −2,67 €")
  // samt Bestandszeile: derselbe Wert heißt jetzt ehrlich „Ihr Speicher hat …
  // gebracht", und „Steuerung" ist erst `savedSteuerungEur` (§2.2). Die
  // Ableitung ist `speicherAussage()` — dieselbe, die Cockpit und
  // Steuerungs-Bereich in der Kurzform speisen, damit die drei Flächen über
  // dieselbe Stunde nie Verschiedenes behaupten (§3.6).
  //
  // ⚠ EINBAUSTELLE: die neue Ergebnis-Karte (P3/P4) hängt diesen Block an
  //   derselben Stelle ein — die Komponente nimmt nur das Ableitungs-Ergebnis,
  //   sie kennt die Karte nicht.
  //
  // ⚠ ZEILE 4 IST der Planwert (E6, P6): die Karte „Geplante Speicher-Ersparnis"
  //   und die Telefon-Fußnotiz sind ENTFALLEN — eine ganze Karte für eine Zahl,
  //   die nur im Vergleich zur gemessenen Zurechnung etwas sagt, stand
  //   gleichrangig neben dem gemessenen Ergebnis (die dokumentierte
  //   Verwechslungs-Falle dieser Seite). Sie steht jetzt GENAU EINMAL, direkt
  //   unter der Zahl, mit der sie sich vergleicht, und behält ihr Abzeichen
  //   „Geplant". Ohne Fahrplan bleibt die Zeile weg — nie eine erfundene Null.
  // ⚠ OHNE `geplantEur` (E6, in u3 §3.2 (6) wiederhergestellt): der Planwert
  //   verlässt Ebene 0 und wohnt in den SCHRITTEN des Aufklappers, direkt
  //   hinter der Rechnung, mit der er sich vergleicht. Eine Plan-Zahl neben
  //   lauter gemessenen hat sich mit ihnen verwechselt.
  const speicher = speicherAussage(money, { now });
  const speicherBlock =
    speicher && speicher.hatAussage ? (
      <SpeicherKarte aussage={speicher} nachtragHref={`#/anlage/${site.id}/technik`}>
        {/* Die Rechnung hinter der Zahl - dieselbe Erklaerung wie im Cockpit
            (Captain 01.09.2026), zugeklappt genau EINE ruhige Zeile.

            ⚠ EINE Erklaerung, zwei Formen: wo die Server-Summen reichen,
            stehen die SCHRITTE 1-5 mit den eingesetzten Zahlen (Konzept §3.3,
            Revision 2); sonst bleibt die Prosa-Fassung, die auch Cockpit und
            Portfolio benutzen. Nie beide - das waere dieselbe Rechnung
            zweimal untereinander. */}
        {hatSpeicherSchritte && speicherSchritteInput ? (
          <SpeicherSchritte input={speicherSchritteInput} />
        ) : ergebnis.steeringFormel ? (
          <SteuerungFormel input={ergebnis.steeringFormel} />
        ) : null}
      </SpeicherKarte>
    ) : null;
  // DIE EINORDNUNG — EINE Zeile im Statement (Konzept
  // `vp-erloese-lesbar-konzept-u3` §3.2 (7), §3.10 (1)).
  //
  // ⚠ W1 = (a): der Chip trägt KEINEN Farbton. „↓ 25 %" ist eine Beobachtung,
  //   kein Urteil — ein grüner Aufwärts-Chip behauptete, mehr sei immer besser,
  //   ein roter Abwärts-Chip, weniger Sonne sei ein Mangel. Das Wort „weniger"
  //   des geteilten `kurzerChip` wandert dafür in den Titel; sichtbar bleibt
  //   die Richtung als ZEICHEN (↑/↓), also nicht als Farbe allein.
  //
  // ⚠ W2 = (a): der Erklärsatz („Verglichen wird bis 11 Uhr — der Vortag
  //   ebenfalls …") ist eine METHODEN-Auskunft und kostete auf Ebene 0 zwanzig
  //   Wörter. Er steht jetzt im ⓘ des Statements.
  const einordnung = {
    betraege: vergleich?.betraege ?? null,
    chip: vergleich?.chip
      ? {
          text: `${vergleich.chip.pct} %`,
          richtung: vergleich.chip.richtung,
          // ⚠ Das WORT bleibt erreichbar (W1): sichtbar trägt der Chip nur
          //   Zeichen + Prozent, der Titel trägt „25 % weniger" samt beiden
          //   Beträgen — die Richtung hängt damit nie an Farbe ODER Zeichen
          //   allein.
          titel: `${vergleich.chip.text} — ${vergleich.chip.titel}`,
        }
      : null,
    satz: vergleich?.satz ?? null,
  };

  return (
    <>
      <WeltKopf welt={welt} />
      <ZeitLeiste
        range={range}
        anchor={anchor}
        onRange={setRange}
        onAnchor={setAnchor}
        coverage={history?.coverage}
        stale={stale}
        vergleich={modus}
        onVergleich={setModus}
        vergleichHinweis={vergleichHinweis}
      />

      <div className={stale ? 'vp-welt-body vp-welt-stale' : 'vp-welt-body'}>
        {err && !money ? (
          <ErrorState
            message={`Die Erlöse konnten nicht geladen werden (${err}).`}
            onRetry={retry}
          />
        ) : !money ? (
          loading ? (
            <Card padding="lg" radius="lg">
              <ChartCardSkeleton />
            </Card>
          ) : null
        ) : (
          <>
            {err && stale && (
              <PeriodeFehlgeschlagen periode={label} onRetry={retry} />
            )}

            {/* Karte 1 — „Wie viel?": das Ergebnis des Zeitraums samt seiner
                Herkunft. Sie ABSORBIERT seit P6 die zwei früheren Karten
                „Was den Preis gemacht hat" (→ Ebene 2 „Preise & Vergütung",
                E5) und „Geplante Speicher-Ersparnis" (→ die Schritte des
                Speicher-Aufklappers, E6) — dieselbe Wahrheit stand zweimal auf
                der Seite, und eine ganze Karte trug eine Zahl, die nur im
                Vergleich zur gemessenen Zurechnung etwas sagt.

                ⚠ SEIT VARIANTE C IST SIE KEINE KARTE MEHR, sondern eine
                FLÄCHE aus vier Bauteilen (Konzept
                `vp-erloese-lesbar-konzept-u3` §3.10, Captain-Entscheid E1 = c):
                das `Statement` steht ohne Rahmen auf dem Grund, `Kontoauszug`,
                `SpeicherKarte` und `PreiseZeile` sind je EINE eigene Karte.
                Der frühere `KartenKopf` (Icon-Kachel + Titel + Abzeichen) ist
                damit entfallen — sein Titel ist das Label des Statements, sein
                Abzeichen dessen Chip (E9: keine Icon-Kachel). */}
            <section className="vp-section">
              {ergebnis.nettoEur == null ? (
                <Card padding="lg" radius="lg">
                  <KartenKopf
                    icon="euro"
                    category="primary"
                    titel={ergebnis.titel}
                    art="bewertet"
                    extra={kopfVergleich}
                  />
                  <EmptyState
                    icon="euro"
                    category="dynamic"
                    title="Noch kein Ergebnis für diesen Zeitraum"
                    description={
                      ergebnis.leerText ??
                      'Sobald Messwerte und Preise vorliegen, steht hier, was Ihre Anlage eingebracht hat.'
                    }
                  />
                </Card>
              ) : (
                <ErgebnisZeilen
                  view={zeilenView}
                  label={`Ergebnis · ${label}`}
                  provenienz="bewertet"
                  // Ebene 1 je Zeile (Konzept §3.3): die Rechnung mit den
                  // EINGESETZTEN Zahlen. Eine Zeile ohne Rechnung bleibt
                  // ruhig - ein Aufklapper ins Leere waere ein Versprechen.
                  ebene1={(id) => {
                    const e1 = ebene1(money, zeilenView, id);
                    return e1 ? <Ebene1Panel ebene1={e1} /> : null;
                  }}
                  // Beide Wege der Sekundärzeile führen auf die Technik-Seite;
                  // ohne Auflösung bliebe der Weg ruhiger Text (§3.2 (4)).
                  hrefFor={() => `#/anlage/${site.id}/technik`}
                  einordnung={einordnung}
                  // Die Lastspitzen-Zeile gehoert einer EIGENEN
                  // Abrechnungsperiode und geht nie in die grosse Zahl ein -
                  // sie steht deshalb ausserhalb des Wasserfalls, mit ihrem
                  // Perioden-Etikett und dem Nebensatz im ⓘ (§3.2).
                  ausserhalb={
                    lastspitzen.length > 0 ? (
                      <ul
                        className="vp-c-led vp-c-led-extra"
                        aria-label="Ausserhalb des Zeitraum-Ergebnisses"
                      >
                        {lastspitzen.map((row) => (
                          <LastspitzenZeile
                            key={row.id}
                            row={row}
                            note={ergebnis.periodNote}
                          />
                        ))}
                      </ul>
                    ) : null
                  }
                  speicher={speicherBlock}
                  preise={
                    money ? (
                      <PreiseZeile
                        ebene2={ebene2({
                          money,
                          netzladenErlaubt: site.netzladenErlaubt ?? null,
                        })}
                      />
                    ) : null
                  }
                />
              )}
            </section>

            {/* Karte 2 — „Ist das gut?": die Antwort gehört direkt hinter die
                „Wie viel?"-Antwort. **Nur direkt vermarktete Anlagen** (E11 /
                Befund B9): eine Anlage mit fester Einspeisevergütung hat keine
                Markt-Frage, und der Verdikt-Satz „0,9 ct unter dem
                Monatsdurchschnitt" läse sich dort wie ein Minderertrag, den es
                nicht gibt. Ihre Vergütung steht in Ebene 2 der Karte 1. Am
                Telefon wird sie zum benannten Aufklapper (unten). */}
            {!isPhone && verdient && <SoVerdientCard view={verdient} />}

            {/* Karte 3 — „Wann kam das Geld?": dieselben Teile über die Zeit,
                für JEDEN Zeitraum. Das Bild belegt die Zahl, es erklärt sie
                nicht — deshalb steht es hinter der Markt-Einordnung. */}
            <section className="vp-section">
              <Card padding="lg" radius="lg">
                <KartenKopf
                  icon="trending-up"
                  category="dynamic"
                  titel={`Geld im Verlauf · ${label}`}
                  art="bewertet"
                />
                <ErloeseVerlaufChart
                  series={money.series}
                  range={range}
                  vergleich={vergleichSerie}
                  legende={ueberlagerungLegende(anchor, range, modus)}
                />
              </Card>
            </section>

            {isPhone ? (
              <>
                {/* **Alles Erklärende wird ein benannter Aufklapper** (Konzept
                    §6): der Falz gehört dem Ergebnis, und „Speicher & Preis"
                    samt drei Absätzen lag bisher täglich bei 4 867 px im
                    Scrollweg. Geöffnet steht der VOLLE Inhalt samt Abzeichen
                    darin — nichts wird gekürzt, nur einsortiert. */}
                {aufklapper.map((a) => (
                  <WeltDisclosure
                    key={a.id}
                    titel={a.titel}
                    sub={a.sub}
                    open={offen.has(a.id)}
                    onToggle={() => toggleAufklapper(a.id)}
                  >
                    {a.id === 'so-verdient' && verdient && <SoVerdientCard view={verdient} />}
                    {a.id === 'speicher-preis' && history && (
                      <>
                        <ProvBadge art="gemessen" />
                        <TagesbildBody history={history} geld={tagesGeld} plantKind={site.plantKind} />
                      </>
                    )}
                    {a.id === 'tagesprotokoll' && history && (
                      <>
                        <ProvBadge art="bewertet" />
                        <TagesprotokollBody history={history} />
                      </>
                    )}
                  </WeltDisclosure>
                ))}
              </>
            ) : (
              <>
                {/* Karte 4 — „Was ist physisch passiert?": der Nachweis. Ihr
                    Kopf nennt die Zurechnung seit P6 NICHT mehr (B10) — das
                    Geld steht einmal, im Speicher-Block der Karte 1. */}
                {isDay && history && (
                  <section className="vp-section">
                    <Card padding="lg" radius="lg">
                      <KartenKopf
                        icon="battery"
                        category="battery"
                        titel="Der Tag im Bild"
                        art="gemessen"
                        extra={
                          /* B7: `Badge variant="tint"` war #5A8DE8 auf #95B9FF
                             = 1,66:1 — auf einer Kunden-Karte unlesbar. Es ist
                             ein ZUSTANDS-Wort wie jedes andere, also die eine
                             Haus-Chip-Form (P0 `.vp-chip`, 4,8:1). */
                          <span className="vp-chip">
                            {history.plan.length > 0 ? 'Plan & Ist' : 'kein Plan'}
                          </span>
                        }
                      />
                      <TagesbildBody history={history} geld={tagesGeld} plantKind={site.plantKind} />
                    </Card>
                  </section>
                )}

                {/* Tagesprotokoll (nur Tag): der Tag in deutschen Sätzen. */}
                {isDay && history && (
                  <section className="vp-section">
                    <Card padding="lg" radius="lg">
                      <KartenKopf icon="list" category="home" titel="Tagesprotokoll" art="bewertet" />
                      <TagesprotokollBody history={history} />
                    </Card>
                  </section>
                )}
              </>
            )}
          </>
        )}
      </div>

      <WeltFuss welt={welt} />
    </>
  );
}
