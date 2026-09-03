import { useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type ForecastAccuracyPoint,
  type ForecastModelId,
  type ForecastModelState,
  type ForecastQuality,
  type HistoryRange,
  type Site,
} from '../api';
import { NBSP } from '../format';
import { SitePicker } from '../components/SitePicker';
import { Aufklapper } from '../components/Aufklapper';
import { VerlaufKarte } from '../components/VerlaufKarte';
import { VerlaufLedger, type VerlaufLedgerZeile } from '../components/VerlaufLedger';
import { VerlaufFehler, VerlaufKarteSkeleton, VerlaufLeer } from '../components/States';
import { ChartHeadline } from '../components/ChartExplain';
import { ForecastQualityChart } from '../ForecastQualityChart';
import {
  BEWERTUNG_METRIK,
  KANDIDAT_EHRLICHKEIT,
  KIND_LABELS,
  MERKMALE_EINLEITUNG,
  RAHMUNG,
  SCHATTEN_ERKLAERUNG,
  SCHATTEN_PRINZIP,
  bewerteteTage,
  bewertungsBilanzSatz,
  bewertungsListe,
  historieZeilen,
  istRuecktausch,
  kandidatKern,
  kandidatenZeilen,
  mittlereMae,
  plattformVorgabeZeile,
  rolleZeile,
  ruecktauschDialog,
  skillBilanz,
  uebernahmeDialog,
  uebernahmeKnopf,
  verdikt,
  verdiktSekundaer,
  wahlFuer,
  type BewertungsZeile,
  type ModellWahlZustand,
} from '../prognose';
import { showTechnicalLayer } from '../rollen';
import { Button } from '../../designsystem/components/core/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useIsPhone } from '../useIsPhone';
import {
  VerlaufFuss,
  VerlaufKopf,
  ZeitLeisteRahmen,
  ZeitSegment,
} from '../components/HistorieWelt';
import { historieHash } from '../historieWelten';
import { parseVerlaufParams } from '../verlauf';
import { replaceCurrentNavigation } from '../navigationBlocker';
import './Prognose.css';

/**
 * Prognosequalität: the transparency page of shadow-mode forecasting
 * (Nachvollziehbarkeit). Plain German, no data-science vocabulary: which
 * model is LIVE for Verbrauch/PV, how accurate it was, what the learning
 * candidates are doing (honest "sammelt Daten" while gated), and the proof
 * that a candidate influences NOTHING until it is deliberately promoted.
 */

const MODEL_LABELS: Record<ForecastModelId, string> = {
  'load-persistence': 'Vergleichsmodell (Vortageswert)',
  'pv-physical': 'Physikalisches PV-Modell (Sonnenstand & Wetter)',
  'load-xgb': 'Lernendes Verbrauchsmodell',
  'pv-residual-xgb': 'Lernende PV-Korrektur',
};

/*
 * `KIND_LABELS` (die beiden Prognosearten), `mittlereMae` und `skillBilanz`
 * leben seit dem Mobil-Umbau in `src/prognose.ts` — die Mobil-Fassung leitet
 * ihr Verdikt aus GENAU denselben Zahlen ab, also darf es sie nicht zweimal
 * geben.
 */

function modelLabel(model: ForecastModelId): string {
  return MODEL_LABELS[model] ?? model;
}

function kw(v: number | null | undefined, digits = 2): string {
  return v == null
    ? '-'
    : `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: digits })}${NBSP}kW`;
}

/**
 * Die drei Bewertungsfenster (§4.5). Sie reisen im `z=`-Parameter der Adresse,
 * damit es EIN Vokabular für alle sechs Verlauf-Reiter gibt — die Wörter
 * bedeuten hier nur etwas anderes als auf Messwerten (dort Kalenderzeiträume,
 * hier die Zahl der bewerteten Tage).
 */
const PROGNOSE_FENSTER = [
  { id: '7', label: '7 Tage' },
  { id: '14', label: '14 Tage' },
  { id: '30', label: '30 Tage' },
] as const;

const FENSTER_WORT: Record<number, HistoryRange> = { 7: 'day', 14: 'week', 30: 'month' };

/** `z=`-Wort → Fenster. Alles Unbekannte fällt auf 7 zurück (die alte Vorgabe). */
function fensterAusWort(range: HistoryRange): number {
  const treffer = Object.entries(FENSTER_WORT).find(([, w]) => w === range);
  return treffer ? Number(treffer[0]) : 7;
}

/** Der Lead-Satz des früheren Seitenkopfs (`SUB_PAGES.prognose`, bis P1). */
const PROGNOSE_LEAD = 'Welches Prognosemodell Ihre Anlage plant und wie genau es ist.';

export function PrognosePage(props: {
  sites: Site[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
  /**
   * Als REITER des Verlaufs gerendert (Navigations-Runde „zwei Ebenen", E3):
   * die Anlage steht im Pfad der Kopfzeile, den Titel trägt der Seitenkopf der
   * Unterseite — Überschrift und Anlagen-Wähler wären eine zweite Kopie davon.
   */
  embedded?: boolean;
}) {
  const site = props.sites.find((s) => s.id === props.selectedSite) ?? null;
  const [quality, setQuality] = useState<ForecastQuality | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  /**
   * Das BEWERTUNGSFENSTER (V3, Paket P1) — der Zeitraum dieses Reiters.
   *
   * ⚠ Er steht in der ADRESSE wie jeder andere Verlauf-Zeitraum, aber mit
   * eigenem Vokabular: `z=tag|woche|monat` heißt hier 7 · 14 · 30 Tage. Ein
   * Lesezeichen ohne Parameter landet auf 7 Tagen — der Wert, den `verdikt`
   * schon vorher als Vorgabe rechnete, also ändert sich für einen Bestands-Link
   * kein Zeichen.
   */
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [tage, setTage] = useState<number>(() => fensterAusWort(init.range));

  useEffect(() => {
    if (!site) {
      setQuality(null);
      return;
    }
    let active = true;
    setLoading(true);
    setErr(null);
    api
      // Das Fenster des Segments ist AUCH das Fenster des Abrufs — sonst zeigte
      // die Leiste „30 Tage" über Zahlen aus einem anderen Zeitraum.
      .forecastQuality(site.id, tage)
      .then((q) => active && setQuality(q))
      .catch((e) => active && setErr(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [site?.id, tage, reloadKey]);

  /**
   * Das Fenster in die ADRESSE (`replaceState`, wie auf den anderen Reitern).
   * Nur als Reiter einer Anlage — als eigenständige Seite mit Anlagen-Wähler
   * gehört die Adresse nicht dieser Anlage.
   */
  useEffect(() => {
    if (!props.embedded || !site) return;
    replaceCurrentNavigation(historieHash(site.id, 'prognose', FENSTER_WORT[tage] ?? 'day'));
  }, [props.embedded, site?.id, tage]);

  /*
   * Der Prognose-Schalter (Captain-Auftrag 19.08.2026). Er gilt JE ANLAGE und
   * gehört dem, dem die Anlage gehört - es gibt hier deshalb KEIN Rollen-Gate
   * mehr; die Route ist mandantenbezogen wie jede `/sites/**`-Route (eine
   * fremde Anlage ist 404). Der Technik-Schalter des Hauses steuert nur noch,
   * ob die Plattform-Vorgabe als Betreiber-Hinweis danebensteht.
   */
  const istBetreiber = showTechnicalLayer();
  const [wahl, setWahl] = useState<ModellWahlZustand | null>(null);
  const [schalten, setSchalten] = useState<{ kind: 'load' | 'pv'; model: ForecastModelId } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [schaltFehler, setSchaltFehler] = useState<string | null>(null);

  useEffect(() => {
    if (!site) {
      setWahl(null);
      return;
    }
    let active = true;
    // Fail-soft: ohne den Schalter-Zustand bleibt die Seite vollständig
    // benutzbar, sie zeigt dann nur Rolle/Historie nicht.
    api
      .siteForecastModels(site.id)
      .then((w) => active && setWahl(w))
      .catch(() => active && setWahl(null));
    return () => {
      active = false;
    };
  }, [site?.id, reloadKey]);

  const challengers = useMemo(
    () => (quality?.models ?? []).filter((m) => !m.active),
    [quality],
  );
  const dialog = useMemo(() => {
    if (!schalten) return null;
    const kandidatLabel = modelLabel(schalten.model);
    const aktivLabel = modelLabel(
      schalten.kind === 'load'
        ? (quality?.activeLoadModel ?? 'load-persistence')
        : (quality?.activePvModel ?? 'pv-physical'),
    );
    const art = KIND_LABELS[schalten.kind];
    return istRuecktausch(wahl, schalten.kind, schalten.model)
      ? ruecktauschDialog(kandidatLabel, aktivLabel, art, site?.name)
      : uebernahmeDialog(kandidatLabel, aktivLabel, art, site?.name);
  }, [schalten, wahl, quality, site?.name]);

  async function uebernehmen() {
    if (!schalten || !site) return;
    setBusy(true);
    setSchaltFehler(null);
    try {
      setWahl(await api.promoteSiteForecastModel(site.id, schalten.kind, schalten.model));
      setSchalten(null);
      // Die Kunden-Sicht („live") folgt derselben Auflösung - also neu holen,
      // statt sie hier zu erraten.
      setReloadKey((k) => k + 1);
    } catch (e) {
      setSchaltFehler(e instanceof ApiError ? e.message : 'Die Umstellung ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  const activeByKind = useMemo(() => {
    if (!quality) return {} as Record<'load' | 'pv', ForecastModelId>;
    return { load: quality.activeLoadModel, pv: quality.activePvModel };
  }, [quality]);

  /*
   * **Seit P7 ist die REIHENFOLGE an jeder Breite dieselbe** (Konzept
   * `vp-verlauf-sprache-konzept-v5` §4.5): Verdikt → aktive Modelle → die zwei
   * Kurven → Kandidaten → Fuß-Karte. Der frühere Telefon/Rechner-Zwilling ist
   * ersatzlos entfallen — er hielt denselben Essay zweimal im Baum (einmal
   * offen, einmal im Aufklapper), und zwei Fassungen desselben Satzes sind
   * genau die zweite Wahrheit, die der Bereich abschafft.
   *
   * `isPhone` trägt nur noch, was wirklich von der Breite abhängt: den
   * Lead-Satz des eigenständigen Seitenkopfs und die zweizeilige Zeit-Leiste.
   */
  const isPhone = useIsPhone();

  return (
    <>
      {/* V1 · Als Reiter des Verlaufs ist der Seitenkopf unsichtbar (Paket P1):
          sein Titel + Lead standen im `SUB_PAGES`-Kopf ÜBER den Bereichs-Reitern
          und schoben sie von 140 auf 287 px. Als eigenständige Seite (mit
          Anlagen-Wähler) behält er seinen sichtbaren Kopf. */}
      {props.embedded && <VerlaufKopf titel="Prognosequalität" />}
      {/* V3 · Das Bewertungs-FENSTER als Segment — dieselbe Leiste wie auf den
          fünf anderen Reitern. Es ist ein ECHTER Schalter: er setzt das Fenster
          des Abrufs (`forecastQuality(…, tage)`) UND die Zahl der Bewertungen,
          über die das Verdikt mittelt. */}
      {props.embedded && (
        <ZeitLeisteRahmen
          mobil={isPhone}
          zeile1={
            <ZeitSegment
              label="Bewertungszeitraum"
              optionen={PROGNOSE_FENSTER}
              wert={String(tage)}
              onWert={(w) => setTage(Number(w))}
            />
          }
        />
      )}
      {!props.embedded && (
        <div className="vp-page-head">
          <div className="titles">
            <h1>Prognosequalität</h1>
            <p>
              {/* Am Telefon EIN Satz - der lange Untertitel schob das Verdikt nach
                  unten, und die Anlage steht bereits in der Kopfzeile der Schale. */}
              {isPhone
                ? 'Wie treffsicher Ihre Anlage vorhersagt.'
                : `Welches Prognosemodell Ihre Anlage plant, wie genau es ist - und was die lernenden Kandidaten leisten${site ? ` (${site.name})` : ''}.`}
            </p>
          </div>
          <div className="actions">
            <SitePicker sites={props.sites} value={props.selectedSite} onChange={props.onSelectSite} />
          </div>
        </div>
      )}

      {props.sites.length === 0 ? (
        <VerlaufKarte label="Prognosequalität">
          <VerlaufLeer
            label="Noch keine Anlage"
            satz="Legen Sie zuerst unter „Meine Anlage“ eine Anlage an — die Bewertung braucht deren Messwerte."
          />
        </VerlaufKarte>
      ) : (
        <>
          {/* V10 · Lade. Der Platz des späteren Inhalts bleibt reserviert, damit
              die Fläche beim Eintreffen nicht springt. */}
          {loading && (
            <VerlaufKarte label="Wie gut Ihre Anlage vorhersagt">
              <VerlaufKarteSkeleton chart={false} legende={false} />
            </VerlaufKarte>
          )}
          {err && (
            <VerlaufKarte label="Wie gut Ihre Anlage vorhersagt">
              <VerlaufFehler
                satz={`Die Prognosequalität konnte nicht geladen werden (${err}).`}
                onRetry={() => setReloadKey((k) => k + 1)}
              />
            </VerlaufKarte>
          )}

          {!loading && !err && quality && (
            <>
              {/* ------------------------------------------------------------
                  Karte 1 (§4.5) · WIE GUT — zwei V5-Zeilen statt der zwei
                  1,15-rem-Verdikt-Zeilen. E8 = a: dieser Reiter führt mit einem
                  KERNSATZ und einer Ledger-Zeile je Prognoseart, NICHT mit einer
                  Hero-Zahl — er hat zwei Arten, eine erzwungene Hero-Zahl wäre
                  eine von beiden willkürlich bevorzugt.
                  ------------------------------------------------------------ */}
              <VerlaufKarte label="Wie gut Ihre Anlage vorhersagt" provenienz="gemessen">
                <VerlaufLedger
                  label="Mittlere Abweichung je Prognoseart"
                  zeilen={verdikt(quality.accuracy, activeByKind, tage).map<VerlaufLedgerZeile>(
                    (z) => ({
                      id: z.kind,
                      name: z.art,
                      wert: z.wert,
                      // Die 24-px-Zahl der Sektion (V5) — sie IST die Antwort.
                      gross: true,
                      sekundaer: verdiktSekundaer(z),
                    }),
                  )}
                />
                <p className="vp-c-note">
                  Je Viertelstunde verglichen mit dem, was wirklich gemessen wurde. Diese
                  zwei Prognosen planen Ihren Batterie-Fahrplan.
                </p>
              </VerlaufKarte>

              {/* ------------------------------------------------------------
                  „Aktive Modelle" · die PROVENIENZ.
                  ⚠ Bewusste Ergänzung zur Karten-Liste des Konzepts (§4.5): die
                  Tabelle dort beschreibt die Telefon-Fassung, auf der diese Karte
                  fehlte. Sie beantwortet aber eine ANDERE Frage als Karte 1 —
                  nicht „wie genau", sondern „welches Modell plant, seit wann, auf
                  wessen Entscheidung". Sie zu streichen hätte eine kundensichtbare
                  Tatsache gelöscht; sie wechselt deshalb nur die Form: Aufklapper
                  statt zweispaltiger Karten-Grid. Der lange Modellname steht in der
                  ruhigen Beistellung (`sub`), nicht im Ledger-Wert — der bricht
                  nicht um (`white-space: nowrap`).
                  ------------------------------------------------------------ */}
              <VerlaufKarte label="Aktive Modelle">
                {(['load', 'pv'] as const).map((kind) => {
                  const model = activeByKind[kind];
                  const recent = mittlereMae(quality.accuracy, model, tage);
                  const historie = wahl ? historieZeilen(wahl, kind, MODEL_LABELS) : [];
                  const vorgabe =
                    wahl && istBetreiber
                      ? plattformVorgabeZeile(wahlFuer(wahl, kind), MODEL_LABELS)
                      : null;
                  return (
                    <Aufklapper
                      key={kind}
                      titel={KIND_LABELS[kind]}
                      sub={modelLabel(model)}
                    >
                      <p className="vp-c-note" style={{ marginTop: 0 }}>
                        {recent
                          ? `Ø Abweichung ${kw(recent.mae)}, letzte ${recent.tage} ${
                              recent.tage === 1 ? 'Tag' : 'Tage'
                            }.`
                          : 'Noch keine Bewertung — sie beginnt nach dem ersten vollen Tag mit Daten.'}
                      </p>
                      {/* Rolle + Herkunft: „seit wann, umgestellt von wem" —
                          nach einer Umstellung ist genau das die Frage. Sie
                          gehört dem KUNDEN: es ist seine Anlage und seine
                          Entscheidung. Nur die Plattform-Vorgabe daneben ist
                          eine Betreiber-Auskunft. */}
                      {wahl && <p className="vp-c-note">{rolleZeile(wahlFuer(wahl, kind))}</p>}
                      {vorgabe && <p className="vp-c-note">{vorgabe}</p>}
                      {historie.length > 0 && (
                        <ul className="vp-pq-historie">
                          {historie.map((z) => (
                            <li key={z}>{z}</li>
                          ))}
                        </ul>
                      )}
                    </Aufklapper>
                  );
                })}
                <p className="vp-c-note">
                  Genau diese zwei Modelle plant Ihre Anlage — keine Doppelung, sondern
                  zwei verschiedene Prognosearten.
                </p>
              </VerlaufKarte>

              {/* ------------------------------------------------------------
                  Karten 2+3 (§4.5) · TREFFSICHERHEIT je Prognoseart, im
                  V6-Rahmen: Label → Kernsatz → BILD → Legende → Erklärung im
                  Aufklapper. Die zwei Notes standen vorher VOR und NACH dem Bild;
                  sie erklären es, also stehen sie jetzt darunter.
                  ------------------------------------------------------------ */}
              {(['load', 'pv'] as const).map((kind) => {
                const points = quality.accuracy.filter((a) => a.kind === kind);
                if (points.length === 0) return null;
                // K1: der Satz kommt aus DERSELBEN `skillBilanz`, die auch die
                // Kandidaten-Zeile nennt - er rueckt nur nach oben. Ohne
                // Kandidat/ohne Bewertung steht dort der ehrliche Grund.
                const kandidat =
                  [...new Set(points.map((p) => p.model))].find(
                    (m) => m !== activeByKind[kind],
                  ) ?? null;
                return (
                  <VerlaufKarte key={kind} label={`Treffsicherheit ${KIND_LABELS[kind]}`}>
                    <ChartHeadline kern={kandidatKern(points, kandidat)} />
                    <ForecastQualityChart
                      points={points}
                      modelLabels={MODEL_LABELS}
                      activeModel={activeByKind[kind]}
                    />
                    <Aufklapper titel="Was zeigt diese Kurve?">
                      <p className="vp-c-note" style={{ marginTop: 0 }}>
                        Jeder Punkt ist die mittlere Abweichung eines Modells an einem Tag
                        in kW (Prognose gegen Messwert) — je niedriger die Linie, desto
                        genauer die Prognose.
                      </p>
                      <p className="vp-c-note">
                        Durchgezogen: das aktive Modell, das Ihren Fahrplan plant.
                        Gestrichelt: der lernende Kandidat — er rechnet mit, ohne etwas zu
                        steuern.
                      </p>
                    </Aufklapper>
                  </VerlaufKarte>
                );
              })}

              {/* ------------------------------------------------------------
                  Karte 4 (§4.5) · LERNENDE KANDIDATEN. `Badge variant="tint"`
                  („Schattenbetrieb", gemessen 3,05 : 1) ist der `.vp-chip` des
                  Bereichs geworden; die drei Kandidaten-Karten mit
                  Fortschrittsbalken, Trainingsdatum und Merkmalsliste sind je eine
                  V5-Zeile plus ihr Aufklapper.
                  ------------------------------------------------------------ */}
              <VerlaufKarte
                label="Lernende Kandidaten"
                chip={<span className="vp-chip">Schattenbetrieb</span>}
              >
                {/* Der Erklär-Kopf: WAS Schattenbetrieb ist, in zwei Sätzen -
                    der Captain konnte sich unter „Lernende Kandidaten"
                    zunächst nichts vorstellen. */}
                {SCHATTEN_ERKLAERUNG.map((satz) => (
                  <p key={satz} className="vp-c-note">
                    {satz}
                  </p>
                ))}

                {challengers.length === 0 ? (
                  <VerlaufLeer
                    label="Noch keine Kandidaten"
                    satz="Sobald Messdaten eintreffen, beginnt je Prognoseart ein lernendes Modell im Hintergrund mitzurechnen. Die Bewertung startet nach dem ersten vollen Tag mit Daten."
                  />
                ) : (
                  challengers.map((m) => (
                    <KandidatZeileKarte
                      key={m.model}
                      state={m}
                      accuracy={quality.accuracy}
                      activeModel={activeByKind[m.kind]}
                      stand={
                        kandidatenZeilen(challengers, quality.accuracy).find(
                          (z) => z.model === m.model,
                        )?.stand ?? ''
                      }
                      onPromote={() => setSchalten({ kind: m.kind, model: m.model })}
                    />
                  ))
                )}

                {/* V10 · Fehler. Die Ablehnung des Servers steht dort, wo geklickt
                    wurde — als `role="alert"`, nie als Stille. */}
                {schaltFehler && <VerlaufFehler satz={schaltFehler} />}

                <p className="vp-c-note">{KANDIDAT_EHRLICHKEIT}</p>
              </VerlaufKarte>

              {/* V10 · Leer: noch kein bewerteter Tag (§4.5). */}
              {quality.accuracy.length === 0 && (
                <VerlaufKarte label="Bewertung">
                  <VerlaufLeer
                    label="Noch keine Bewertung"
                    satz="Die erste Bewertung entsteht nach dem ersten vollständigen Tag — sie vergleicht die Prognosen mit den tatsächlichen Messwerten Ihrer Anlage."
                  />
                </VerlaufKarte>
              )}

              {/* ------------------------------------------------------------
                  Karte 5 (§4.5) · die Fuß-Karte. Der INHALT der zwei Essays ist
                  unverändert — sie wechseln nur die Form (V8) und stehen nicht
                  mehr VOR der Antwort, die man bei jedem Besuch sucht. Die
                  Rahmung bleibt dabei SICHTBAR: sie ist die Antwort auf die
                  dokumentierte Verwirrung „zwei aktive Prognosen".
                  ------------------------------------------------------------ */}
              <VerlaufKarte label="Hintergrund">
                <p className="vp-c-note" style={{ marginTop: 0 }}>
                  {RAHMUNG}
                </p>
                <Aufklapper titel="Was sehe ich hier?">
                  <p className="vp-c-note" style={{ marginTop: 0 }}>
                    Diese Seite zeigt, wie treffsicher die Prognosen sind, mit denen Ihre
                    Anlage ihren Batterie-Fahrplan plant. Ihre Anlage nutzt dafür{' '}
                    <strong>zwei getrennte Prognosen</strong>: eine für den{' '}
                    <strong>Verbrauch (Last)</strong> und eine für die{' '}
                    <strong>PV-Erzeugung</strong>. Aus beiden berechnet die Optimierung,
                    wann sich Laden und Entladen lohnt - je genauer die Prognose, desto
                    besser der Plan.
                  </p>
                  <p className="vp-c-note">
                    Jede der beiden Prognosen hat genau <strong>ein aktives Modell</strong>,
                    das den Fahrplan steuert - und optional einen{' '}
                    <strong>lernenden Kandidaten</strong>, der im Hintergrund mitrechnet,
                    ohne etwas zu steuern.
                  </p>
                </Aufklapper>
                <Aufklapper titel="So funktioniert der Schattenbetrieb">
                  {SCHATTEN_PRINZIP.map((satz, i) => (
                    <p key={satz} className="vp-c-note" style={i === 0 ? { marginTop: 0 } : undefined}>
                      {satz}
                    </p>
                  ))}
                </Aufklapper>
              </VerlaufKarte>
            </>
          )}
          {/* V1 · Der Lead-Satz des früheren Seitenkopfs — wörtlich, am Fuß. */}
          {props.embedded && <VerlaufFuss text={PROGNOSE_LEAD} />}
        </>
      )}

      {/* Die Rückfrage im Haus-Muster: eine FOLGENLISTE, die auch nennt, was
          GLEICH bleibt und dass der Rückweg offen ist. */}
      {dialog && (
        <ConfirmDialog
          open
          title={dialog.titel}
          intro={dialog.intro}
          consequences={dialog.folgen}
          confirmLabel={dialog.bestaetigen}
          busy={busy}
          onConfirm={uebernehmen}
          onCancel={() => setSchalten(null)}
        />
      )}
    </>
  );
}

/**
 * **Ein lernender Kandidat als V5-ZEILE** (Konzept §4.5, Karte 4).
 *
 * Name 16/600 links, rechts der Fortschritt in Tabellenziffern („14 / 21" beim
 * Sammeln, „1 / 2" beim Rechnen), darunter die eine Aussage („sammelt Daten",
 * „in 1 von 2 Bewertungen genauer"). Alles Weitere — Trainingsstand,
 * Merkmalsgewichte und der BELEG der Bewertungen — liegt im Aufklapper.
 *
 * ⚠ **Der Schalter bleibt in BEIDEN Zuständen sichtbar**, auch gesperrt.
 *   Das Konzept notiert „Knopf ‚Übernehmen‘ nur wenn möglich"; die geprüfte
 *   Zusage dieses Schreibpfads ist aber „ein gesperrter Knopf MIT Grund ist die
 *   ehrliche Antwort auf ‚warum kann ich nicht?‘" (`PrognoseSchalter.test.tsx`).
 *   Der Knopf wechselt deshalb nur die Größe (44 px), nicht sein Verhalten.
 */
function KandidatZeileKarte({
  state,
  accuracy,
  activeModel,
  stand,
  onPromote,
}: {
  state: ForecastModelState;
  accuracy: ForecastAccuracyPoint[];
  activeModel: ForecastModelId;
  /** Die eine Aussage aus `kandidatenZeilen` — die Fläche formuliert sie nicht neu. */
  stand: string;
  onPromote: () => void;
}) {
  const collecting = state.status === 'collecting';
  const record = skillBilanz(accuracy, state.model);
  const zeilen = bewertungsListe(accuracy, state.model, activeModel);
  const gesammelt = state.daysCollected ?? 0;
  const noetig = state.daysRequired ?? 21;
  const progress = collecting ? Math.min(100, Math.round((gesammelt / noetig) * 100)) : null;
  // Der WERT rechts ist der Fortschritt — beim Sammeln gegen die nötigen Tage,
  // beim Rechnen die Bilanz. Ohne Bewertung steht dort „—" statt einer 0.
  const wert = collecting
    ? `${gesammelt}${NBSP}/${NBSP}${noetig}`
    : record
      ? `${record.besser}${NBSP}/${NBSP}${record.gesamt}`
      : null;

  return (
    <div className="vp-pq-kandidat-block">
      <VerlaufLedger
        label={`Kandidat ${KIND_LABELS[state.kind]}`}
        zeilen={[
          {
            id: state.model,
            name: modelLabel(state.model),
            wert,
            // ⚠ Art und Stand stehen in EIGENEN Elementen: „in 1 von 1
            //   Bewertung genauer" ist der Satz, den `kandidatenZeilen`
            //   formuliert — in einer zusammengesetzten Zeichenkette wäre er
            //   für Leser und Test nicht mehr als GANZES auffindbar.
            sekundaer: (
              <>
                <span>{KIND_LABELS[state.kind]}</span>
                {' · '}
                <span>{stand}</span>
              </>
            ),
          },
        ]}
      />
      {progress != null && (
        <div
          className="vp-pq-fortschritt"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Datensammlung ${progress} %`}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      )}

      <Aufklapper titel={collecting ? 'Warum sammelt er noch?' : 'Wie gut rechnet er mit?'}>
        {collecting ? (
          <p className="vp-c-note" style={{ marginTop: 0 }}>
            Das ist normal: Ein lernendes Modell trainiert erst nach {noetig} vollständigen
            Messtagen. Bis dahin sammelt es nur Daten und gibt bewusst keine Prognose ab.
            Danach erstellt es automatisch eigene Vorhersagen und wird täglich gegen das
            aktive Modell bewertet.
          </p>
        ) : (
          <>
            <p className="vp-c-note" style={{ marginTop: 0 }}>
              {record
                ? `In ${record.besser} der letzten ${record.gesamt} ${
                    record.gesamt === 1 ? 'Bewertung' : 'Bewertungen'
                  } genauer als das aktive Modell.`
                : 'Rechnet mit - die erste Tagesbewertung folgt nach dem nächsten vollen Tag.'}
            </p>
            <p className="vp-c-note">
              {state.trainedAt
                ? `Zuletzt trainiert am ${new Date(state.trainedAt).toLocaleDateString('de-DE', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                  })}` +
                  (state.trainRows
                    ? ` mit ${state.trainRows.toLocaleString('de-DE')} Messwerten.`
                    : '.')
                : 'Noch nicht trainiert.'}
            </p>
            {state.featureImportance.length > 0 && (
              <>
                <p className="vp-c-note">{MERKMALE_EINLEITUNG}</p>
                <ul className="vp-pq-merkmale">
                  {state.featureImportance.slice(0, 5).map((fi) => (
                    <li key={fi.feature}>
                      {fi.label} ({Math.round(fi.weight * 100).toLocaleString('de-DE')}
                      {NBSP}%)
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Aufklapper>

      {/* Der BELEG zu genau dieser Zahl - dieselben Tage, aufklappbar. */}
      <BewertungsBeleg zeilen={zeilen} />

      {/* Der Schalter - in BEIDEN Zuständen, denn ein gesperrter Knopf MIT
          Grund ist die ehrliche Antwort auf „warum kann ich nicht?". */}
      <UebernahmeAktion
        state={state}
        bewertet={bewerteteTage(accuracy, state.model)}
        onClick={onPromote}
      />
    </div>
  );
}

/**
 * Der BELEG unter „X von Y genauer": die letzten zehn Tagesbewertungen mit
 * beiden Fehlerwerten und der Gewinner-Markierung.
 *
 * Es sind GENAU die Tage, die der Zähler zählt (`bewertungsListe` filtert auf
 * dieselbe Bedingung wie `skillBilanz`), und der Gewinner kommt aus dem
 * gespeicherten Vergleich - die Fläche belegt, sie rechnet nicht nach. Die
 * Metrik steht ausgeschrieben darüber: „Ø Abweichung je Tag (kW)", nie eine
 * erfundene „Genauigkeit in %".
 *
 * ⚠ **Seit P7 eine LISTE, keine Tabelle** (V7): vier Spalten aus Datum und drei
 *   Werten standen bei 375 px nebeneinander; die Liste trägt dieselben Zahlen
 *   in der Ledger-Form, die der ganze Bereich spricht.
 */
function BewertungsBeleg({ zeilen }: { zeilen: BewertungsZeile[] }) {
  if (zeilen.length === 0) return null;
  return (
    <Aufklapper titel={`Die letzten ${zeilen.length} Bewertungen ansehen`}>
      {/* Der Zähler und die Liste stammen aus DENSELBEN Zeilen - hier stehen
          sie nebeneinander, damit man das sehen kann. */}
      <p className="vp-c-note" style={{ marginTop: 0 }}>
        {bewertungsBilanzSatz(zeilen)}
      </p>
      <p className="vp-c-note">{BEWERTUNG_METRIK}</p>
      <ul className="vp-pq-beleg-liste">
        {zeilen.map((z) => (
          <li key={z.day}>
            <span className="vp-pq-beleg-tag">{z.datum}</span>
            <span className="vp-pq-beleg-werte">
              Kandidat {kw(z.kandidatMae)} · aktiv{' '}
              {z.aktivMae == null ? '—' : kw(z.aktivMae)}
            </span>
            <span className="vp-pq-beleg-sieger">
              Näher dran:{' '}
              {z.gewinner === 'kandidat' ? (
                <span className="vp-pq-sieg">Kandidat</span>
              ) : z.gewinner === 'aktiv' ? (
                'aktives Modell'
              ) : (
                'gleichauf'
              )}
            </span>
          </li>
        ))}
      </ul>
    </Aufklapper>
  );
}

/**
 * Der Schalter selbst: er steht JEDEM offen, der die Anlage erreicht (die Wahl
 * gilt nur für sie), und nennt seinen Einwand VOR dem Klick (die
 * `applyView`-Disziplin). Der Dialog dahinter gehört der Seite, damit es genau
 * einen gibt.
 *
 * ⚠ **Beschriftung, Einwand und Rückfrage sind unverändert** (P7 fasst diesen
 *   Kunden-Schreibpfad nur in der FORM an): 44 px hoch, Outline, Grund daneben.
 */
function UebernahmeAktion({
  state,
  bewertet,
  onClick,
}: {
  state: ForecastModelState;
  bewertet: number;
  onClick: () => void;
}) {
  const knopf = uebernahmeKnopf(state, bewertet);
  return (
    <div className="vp-pq-aktion">
      <Button variant="outline" size="sm" onClick={onClick} disabled={knopf.grund != null}>
        {knopf.label}
      </Button>
      {knopf.grund && <span className="vp-c-note">{knopf.grund}</span>}
    </div>
  );
}
