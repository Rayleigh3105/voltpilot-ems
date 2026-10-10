import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  ApiError,
  type Auffaelligkeit,
  type Bezugsbasis,
  type BezugsbasisFassung,
  type Energieziel,
  type Kennzahl,
  type KennzahlFassung,
  type KennzahlPeriodeArt,
  type KennzahlWerte,
} from '../api';
import { basisZeile, kannBezugsbasis, zeilenFassung } from '../bezugsbasisAnlegen';
import type { BezugsbasisVergleich } from '../bezugsbasisVergleich';
import { AbweichungsGrafik, Infozeile, Legende, SpaltenGrafik, ZielSkala, ZusammenGrafik } from '../components/AuswertenGrafik';
import { VermerkZeile } from '../components/AuffaelligkeitZeile';
import { BegriffeZeile } from '../components/BegriffeZeile';
import { useBezugsbasis } from '../components/BezugsbasisReiter';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DangerZone } from '../components/DangerZone';
import { EnergiezielSetzenDialog } from '../components/EnergiezielDialoge';
import { Fehlergrenze } from '../components/Fehlergrenze';
import { GeteiltesRegisterHinweis } from '../components/GeteiltesRegisterHinweis';
import { GrenzHinweis, GrenzSatzBereich } from '../components/GrenzSatz';
import { HerkunftsZeile } from '../components/HerkunftsZeile';
import { Marke } from '../components/kacheln/Kachel';
import { ZeitSegment } from '../components/HistorieWelt';
import type { KopieVon } from '../components/KennzahlAnlegenDialog';
import { KennzahlStammdatenDialog } from '../components/KennzahlStammdatenDialog';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { ErrorState, Skeleton } from '../components/States';
import { VersionenEinstieg, VersionenModal } from '../components/WertVersionen';
import { WerteKarte } from '../components/WerteKarte';
import * as Z from '../energieziele';
import { UEMS_ENERGIEZIEL, UEMS_FASSUNG_SATZ, UEMS_VERSION_SATZ, uemsGeteiltSatz } from '../glossar';
import * as E from '../kennzahlAendern';
import { ablehnungSatz, KNOPF_KOPIEREN } from '../kennzahlAnlegen';
import {
  anfrage,
  ANZAHL_VERLAUF,
  berechnung,
  eingaengeDer,
  eingangsNamen,
  FASSUNGEN_TITEL,
  heuteIn,
  herkunftAnzeige,
  kennzahlHistorie,
  kopf,
  KARTE_VERLAUF,
  letzterSchritt,
  listenPerioden,
  NICHT_GEFUNDEN,
  ohneWert,
  PERIODE_WAHL,
  periodenWahl,
  verlauf,
  versionenEinstieg,
  WERTE_FEHLER,
  wertKarte,
  ZUR_LISTE,
  type Balken,
} from '../kennzahlKarte';
import { kennzahlMitAuswertung } from '../kennzahlMitAuswertung';
import * as S from '../kennzahlSeite';
import { merkeAbruf, useRoutenHeute } from '../routenUhr';
import { TRENNER } from '../uemsErgebnis';
import { energiezielRoute, hashForRoute } from '../nav';
import { useRollen } from '../rollen';
import { LEITKENNZAHL, vorjahrText } from '../kennzahlListe';
import { useIsPhone } from '../useIsPhone';
import './KennzahlSeite.css';

/**
 * Die Seite einer Kennzahl (Konzept Auswerten a1 §6.5, §6.12-§6.14; PR2) - ohne Reiter, die Antwort zuerst: ein Satz
 * für den letzten abgeschlossenen Monat, die Verlässlichkeit, die Kachel mit gemessen und erwartet, das Energieziel auf
 * einer Skala, die Abweichung je Monat (am Rechner dazu „Zusammengezählt“), die Werte je Monat, die offene
 * Auffälligkeit, der Rechenweg, die Bezugsbasis in Klartext und „Über diese Kennzahl“. Werkzeuge liegen im Menü ⋯;
 * Fassungen, Freigaben und Prüfsummen der Bezugsbasis eine Ebene tiefer (`…/kennzahlen/{id}/bezugsbasis`, §6.6).
 *
 * Gelesen wird `GET /api/v1/kennzahlen/{id}?mit=auswertung` (dieselbe Ableitung wie Liste und Leitkachel, §10.8), mit
 * Bezugsbasis die zwölf Zeilen von `…/vergleich`, die Monatswerte (Rechenweg, Versionen, Vorjahr), das offene
 * Energieziel und - mit `verbesserung.ansehen` - die Auffälligkeiten. Gerechnet wird nichts (`kennzahlSeite.ts`).
 *
 * Ohne Auswertung (archiviert, ohne Monatswerte, ohne Monat als Periode) bleibt die bisherige Werte-Karte mit Perioden,
 * Verlauf und Versionen - fehlend ist keine Null.
 */
export function KennzahlSeite({
  id,
  zone,
  onListe,
  zurListe = ZUR_LISTE,
  onKopieren,
  onBerechnungAendern,
  onBezugsbasis,
}: {
  id: string;
  zone: string;
  onListe: () => void;
  /** Das Wort des Rückwegs — am Standort „Kennzahlen dieses Standorts“ (AP-13 IP-2), sonst „Alle Kennzahlen“. */
  zurListe?: string;
  /** AP-11 IP-14 (§5.2): „Kopieren“ — Form, Name und Zweck gehen in den Assistenten, die Eingänge nicht. */
  onKopieren?: (quelle: KopieVon) => void;
  /** AP-11 IP-15 (§5.4): „Berechnung ändern ab …“ — derselbe Assistent im Modus „ändern“, er gehört der Welt. */
  onBerechnungAendern?: (quelle: KopieVon) => void;
  /** §6.6: die Bezugsbasis eine Ebene tiefer (`…/kennzahlen/{id}/bezugsbasis`). */
  onBezugsbasis?: () => void;
}) {
  const telefon = useIsPhone();
  const rollen = useRollen();
  const [stamm, setStamm] = useState<{ kennzahl: Kennzahl; fassungen: KennzahlFassung[] } | null>(null);
  const [stammFehler, setStammFehler] = useState<'fehlt' | 'fehler' | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [umfeld, setUmfeld] = useState<{ liste: Kennzahl[]; fassungen: Record<string, KennzahlFassung[]> } | null>(null);
  const [dialog, setDialog] = useState<'stammdaten' | 'archivieren' | 'loeschen' | 'ziel' | null>(null);
  const [archiv, setArchiv] = useState<{ laeuft: boolean; fehler: string | null }>({ laeuft: false, fehler: null });
  const [loeschen, setLoeschen] = useState<{ laeuft: boolean; fehler: string | null }>({ laeuft: false, fehler: null });
  const [gesetzt, setGesetzt] = useState<Energieziel | null>(null);

  useEffect(() => {
    let aktiv = true;
    setStammFehler(null);
    Promise.all([kennzahlMitAuswertung(id), api.kennzahlFassungen(id)]).then(
      ([kennzahl, f]) => aktiv && setStamm({ kennzahl, fassungen: f.fassungen }),
      (e) => aktiv && setStammFehler(e instanceof ApiError && e.status === 404 ? 'fehlt' : 'fehler'),
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);

  // Nur eine Zusammenfassung liest Kennzahlen — ihre Fassungen sagen, wer diese liest. Scheitert das, fehlt nur die
  // Vorab-Sperre; die Route entscheidet trotzdem und ihr Satz steht nach dem Versuch.
  useEffect(() => {
    let aktiv = true;
    setUmfeld(null);
    api
      .kennzahlen()
      .then(async ({ kennzahlen }) => {
        const selbst = kennzahlen.find((x) => x.id === id);
        const kandidaten = selbst ? E.moeglicheLeser(selbst, kennzahlen) : [];
        const je = await Promise.all(kandidaten.map((x) => api.kennzahlFassungen(x.id).then((f) => [x.id, f.fassungen] as const)));
        if (aktiv) setUmfeld({ liste: kennzahlen, fassungen: Object.fromEntries(je) });
      })
      .catch(() => undefined);
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);

  const bbAn = stamm !== null && kannBezugsbasis(stamm.kennzahl);
  // Die Fassung am Stichtag der Auswertung - dieselbe, die die Ebene der Bezugsbasis zeigt - und die am Tag des Urteils
  // (P4), die neben dem Urteil steht; nach einer Überprüfung sind das zwei (Review r3).
  const monatDerAuswertung = stamm?.kennzahl.auswertung?.monat;
  const bbLage = useBezugsbasis(
    id,
    bbAn,
    versuch,
    stamm ? S.stichtag(monatDerAuswertung, heuteIn(zone, Date.now())) : undefined,
    stamm ? S.urteilsTag(monatDerAuswertung, heuteIn(zone, Date.now())) : undefined,
  );

  const zurueck = (
    <button type="button" className="vp-kz-zurueck" onClick={onListe}>
      <Icon name="chevron-left" size={18} />
      {zurListe}
    </button>
  );
  if (stammFehler === 'fehlt') {
    return (
      <div className="vp-kz vp-kzs" data-testid="kennzahl-seite">
        {zurueck}
        <p className="vp-kz-leer">{NICHT_GEFUNDEN}</p>
      </div>
    );
  }
  if (stammFehler) {
    return (
      <div className="vp-kz vp-kzs" data-testid="kennzahl-seite">
        {zurueck}
        <ErrorState message={S.SEITE_LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />
      </div>
    );
  }
  if (!stamm) {
    return (
      <div className="vp-kz vp-kzs" data-testid="kennzahl-seite" aria-busy="true">
        {zurueck}
        {/* Skelette in der Höhe von Satz, Kachel und Grafik: nichts springt, wenn die Zahlen kommen (§6.13). */}
        <Skeleton height={64} />
        <Skeleton height={148} />
        <Skeleton height={232} />
      </div>
    );
  }

  const k = stamm.kennzahl;
  const kp = kopf(k);
  const aenderbar = k.archiviert_am === null;
  const recht = k.standort_id ? 'kennzahl.standort_definieren' : 'kennzahl.unternehmen_definieren';
  const archiviertSatz = E.archiviertSatz(k);
  const sperre = E.loeschenSperre(k, umfeld ? E.leserVon(k, umfeld.liste, umfeld.fassungen) : null);
  // IP-15: ein archivierter Eingang steht sichtbar am Rechenweg - die Kennzahl rechnet ab dort nicht mehr weiter.
  const archivierteEingaenge = umfeld ? E.archivierteEingaenge(E.aktuelleFassung(k, stamm.fassungen), umfeld.liste) : [];
  // Wie weit der Server ist (Monat der Auswertung) - danach heißt eine Fassung „seit“ oder erst „ab“ einem Tag.
  const tag = S.stichtag(k.auswertung?.monat, heuteIn(zone, Date.now()));
  const basisDa = bbLage.art === 'da' ? bbLage : null;
  // Neben dem Urteil (Antwort, Verlässlichkeit, Karte „Bezugsbasis“) steht die Fassung, die es gerechnet hat.
  const basisUrteil = basisDa ? { basis: basisDa.basis, fassung: basisDa.urteilsFassung ?? basisDa.fassung } : null;
  const zielMoeglich =
    bbAn && aenderbar && !k.auswertung?.energieziel && basisDa !== null && basisDa.fassung !== null &&
    basisDa.basis.beendet_zum === null && zeilenFassung(basisDa.basis)?.freigabe_status === 'freigegeben';

  const menue: RowMenuItem[] = [
    ...(zielMoeglich ? [{ label: Z.KNOPF_SETZEN, recht: 'verbesserung.verwalten', standort: k.standort_id, onClick: () => setDialog('ziel') }] : []),
    ...(onKopieren ? [{ label: KNOPF_KOPIEREN, recht, standort: k.standort_id, onClick: () => onKopieren({ kennzahl: k, fassungen: stamm.fassungen }) }] : []),
    ...(onBerechnungAendern && aenderbar
      ? [{ label: E.KNOPF_BERECHNUNG_AENDERN, recht, standort: k.standort_id, onClick: () => onBerechnungAendern({ kennzahl: k, fassungen: stamm.fassungen }) }]
      : []),
    ...(aenderbar ? [{ label: E.KNOPF_STAMMDATEN, recht, standort: k.standort_id, onClick: () => setDialog('stammdaten') }] : []),
    ...(aenderbar
      ? [{ label: E.KNOPF_ARCHIVIEREN, recht, standort: k.standort_id, onClick: () => { setArchiv({ laeuft: false, fehler: null }); setDialog('archivieren'); } }]
      : []),
    // Löschen nur ohne Werte (V5) - sonst ist Archivieren der Weg.
    ...(!k.hat_werte ? [{ label: E.KNOPF_LOESCHEN, recht, standort: k.standort_id, danger: true, onClick: () => setDialog('loeschen') }] : []),
  ];

  const archivieren = async () => {
    setArchiv({ laeuft: true, fehler: null });
    try {
      const neu = await api.kennzahlArchivieren(id);
      setStamm((s) => (s ? { ...s, kennzahl: neu } : s));
      setDialog(null);
      setArchiv({ laeuft: false, fehler: null });
    } catch (e) {
      setArchiv({ laeuft: false, fehler: ablehnungSatz(e, E.AKTION_FEHLER) });
    }
  };
  const endgueltigLoeschen = async () => {
    setLoeschen({ laeuft: true, fehler: null });
    try {
      await api.kennzahlLoeschen(id);
      onListe();
    } catch (e) {
      setLoeschen({ laeuft: false, fehler: ablehnungSatz(e, E.AKTION_FEHLER) });
    }
  };

  return (
    <GrenzSatzBereich>
      <div className="vp-kz vp-kzs" data-testid="kennzahl-seite">
        {zurueck}
        <header className="vp-kzs-kopf">
          <div className="vp-kzs-kopf-text">
            {/* K5: der Name zuerst, das Kennzeichen leise dahinter. */}
            <h1>
              {kp.name} <span className="vp-kz-kennzeichen">{kp.kennzeichen}</span>
            </h1>
            <p className="vp-kzs-meta">
              <span>{kp.unter}</span>
              {kp.archiviert && <Badge variant="tint">{kp.archiviert}</Badge>}
            </p>
          </div>
          {menue.length > 0 && <RowMenu items={menue} label="Weitere Aktionen" />}
        </header>
        {gesetzt && (
          <p className="vp-ez-leise" role="status" data-testid="energieziel-gesetzt">
            {`${UEMS_ENERGIEZIEL} ${gesetzt.kennzeichen} gesetzt - `}
            <a href={hashForRoute(energiezielRoute(gesetzt.id))}>{`${UEMS_ENERGIEZIEL} ${gesetzt.kennzeichen} öffnen`}</a>
          </p>
        )}
        {archiviertSatz && (
          <p className="vp-kz-leise" data-testid="kennzahl-archiviert">
            {archiviertSatz}
          </p>
        )}
        {/* Bis „Was ist eine Kennzahl?“ als Aufklapper kommt (Messen-Bau #1411), bleibt die Begriffe-Zeile. */}
        <BegriffeZeile begriffe={k.auswertung?.vergleich ? ['kennzahl', 'bezugsbasis', 'bereinigt'] : bbAn ? ['kennzahl', 'bezugsbasis'] : ['kennzahl']} />
        {k.auswertung ? (
          <Fehlergrenze key="auswertung">
            <Auswertung
              k={k}
              fassungen={stamm.fassungen}
              zone={zone}
              telefon={telefon}
              lage={basisUrteil}
              darfFestlegen={bbAn && aenderbar && rollen.darf('bezugsbasis.verwalten', k.standort_id)}
              darfVerbesserung={rollen.darf('verbesserung.ansehen', k.standort_id)}
              archivierteEingaenge={archivierteEingaenge}
              stichtag={tag}
              onBezugsbasis={onBezugsbasis}
            />
          </Fehlergrenze>
        ) : (
          <Fehlergrenze key="werte">
            <WerteOhneAuswertung
              k={k}
              fassungen={stamm.fassungen}
              zone={zone}
              versuch={versuch}
              archivierteEingaenge={archivierteEingaenge}
              onNeu={() => setVersuch((v) => v + 1)}
            />
            {bbAn && basisDa && (
              <BasisKarte
                k={k}
                lage={basisDa}
                stichtag={tag}
                darfFestlegen={aenderbar && rollen.darf('bezugsbasis.verwalten', k.standort_id)}
                onBezugsbasis={onBezugsbasis}
              />
            )}
            {bbAn && bbLage.art === 'keine' && onBezugsbasis && (
              <section className="vp-kz-block vp-kzs-karte" aria-label={S.TITEL_BEZUGSBASIS} data-testid="kennzahl-bezugsbasis">
                <div className="vp-kzs-blockkopf">
                  <h2>{S.TITEL_BEZUGSBASIS}</h2>
                  <button type="button" className="vp-kzs-link" onClick={onBezugsbasis} data-testid="alle-fassungen">
                    {S.BEZUGSBASIS_ANSEHEN}
                  </button>
                </div>
                <p className="vp-kzs-text">{S.OHNE_BEZUGSBASIS_SATZ}</p>
              </section>
            )}
          </Fehlergrenze>
        )}
        <section className="vp-kz-block vp-kzs-karte" aria-label={S.TITEL_UEBER} data-testid="kennzahl-stammdaten">
          <h2>{S.TITEL_UEBER}</h2>
          {k.zweck && <p className="vp-kzs-text">{k.zweck}</p>}
          <p className="vp-kzs-fuss">{S.ueberKennzahl(k).geltung}</p>
        </section>
        {bbAn && <GrenzHinweis />}

        {dialog === 'ziel' && basisDa?.fassung && (
          <EnergiezielSetzenAmTagDerRoute
            kennzahl={k}
            basisZeile={basisZeile(basisDa.basis, basisDa.fassung, k.einheit_anzeige)}
            onClose={() => setDialog(null)}
            onGesetzt={(ez) => {
              setDialog(null);
              setGesetzt(ez);
              setVersuch((v) => v + 1);
            }}
          />
        )}
        <KennzahlStammdatenDialog
          open={dialog === 'stammdaten'}
          kennzahl={k}
          onClose={() => setDialog(null)}
          onGespeichert={(neu) => {
            setStamm((s) => (s ? { ...s, kennzahl: { ...neu, auswertung: s.kennzahl.auswertung } } : s));
            setDialog(null);
          }}
        />
        <ConfirmDialog
          open={dialog === 'archivieren'}
          title={E.ARCHIVIEREN_TITEL}
          intro={E.archivierenIntro(k)}
          consequences={E.archivierenFolgen(k, umfeld ? E.heutigeLeser(k, umfeld.liste, umfeld.fassungen) : [])}
          confirmLabel={E.KNOPF_ARCHIVIEREN}
          busy={archiv.laeuft}
          onConfirm={archivieren}
          onCancel={() => setDialog(null)}
          extra={
            archiv.fehler ? (
              <p className="vp-gw-error" role="alert">
                {archiv.fehler}
              </p>
            ) : undefined
          }
        />
        {dialog === 'loeschen' && (
          <Modal open onClose={() => setDialog(null)} title={E.KNOPF_LOESCHEN}>
            <div className="vp-kzs-loeschen" data-testid="kennzahl-lebenszyklus">
              <DangerZone
                recht={recht}
                standort={k.standort_id}
                actionLabel={E.KNOPF_LOESCHEN}
                description={E.LOESCHEN_SATZ}
                consequences={E.loeschenFolgen(k)}
                confirmLabel={E.LOESCHEN_BESTAETIGEN}
                disabledReason={sperre}
                busy={loeschen.laeuft}
                error={loeschen.fehler}
                onConfirm={endgueltigLoeschen}
              />
            </div>
          </Modal>
        )}
      </div>
    </GrenzSatzBereich>
  );
}

/**
 * „Energieziel setzen“ mit dem Tag der Route (Konzept Verbessern v1, Befund 2): Vorgabe und Grenzen der Zielperiode
 * rechnen vom Tag, an dem die Route prüft - nie von der Uhr des Browsers. Meist hat ihn die Auffälligkeiten-Route der
 * Seite schon gemerkt; sonst holt `useRoutenHeute` ihn einmal, und der Dialog öffnet, sobald er da ist.
 */
function EnergiezielSetzenAmTagDerRoute(props: Omit<Parameters<typeof EnergiezielSetzenDialog>[0], 'tagHeute'>) {
  const tagHeute = useRoutenHeute();
  return tagHeute ? <EnergiezielSetzenDialog {...props} tagHeute={tagHeute} /> : null;
}

// ================================================================================== die Auswertung (Antwort zuerst)

/** `JJJJ-MM` plus `n` Monate (n darf negativ sein) - Kalender, keine Menge. */
function monatPlus(periode: string, n: number): string {
  const i = Number(periode.slice(0, 4)) * 12 + Number(periode.slice(5, 7)) - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}


function Auswertung({
  k,
  fassungen,
  zone,
  telefon,
  lage,
  darfFestlegen,
  darfVerbesserung,
  archivierteEingaenge,
  stichtag,
  onBezugsbasis,
}: {
  k: Kennzahl;
  fassungen: KennzahlFassung[];
  zone: string;
  telefon: boolean;
  archivierteEingaenge: string[];
  stichtag: string;
  lage: { basis: Bezugsbasis; fassung: BezugsbasisFassung | null } | null;
  darfFestlegen: boolean;
  darfVerbesserung: boolean;
  onBezugsbasis?: () => void;
}) {
  const a = k.auswertung!;
  const mitBasis = a.vergleich !== null;
  const [vergleich, setVergleich] = useState<BezugsbasisVergleich | null>(null);
  const [vergleichFehler, setVergleichFehler] = useState(false);
  const [werte, setWerte] = useState<KennzahlWerte | null>(null);
  const [ziele, setZiele] = useState<Energieziel[] | null>(null);
  const [vermerke, setVermerke] = useState<Auffaelligkeit[] | null>(null);
  // Der Tag der Route aus derselben Antwort - „heute“ für die Frist im Antwort-Dialog (eine Uhr, Befund 2).
  const [vermerkAbruf, setVermerkAbruf] = useState<string | undefined>(undefined);
  const [vermerkStand, setVermerkStand] = useState(0);
  const [versuch, setVersuch] = useState(0);
  const [gewaehlt, setGewaehlt] = useState<string>(a.monat);
  const [alle, setAlle] = useState(false);
  const [antworten, setAntworten] = useState(false);
  const [versionenOffen, setVersionenOffen] = useState(false);

  useEffect(() => {
    if (!mitBasis) return;
    let aktiv = true;
    setVergleichFehler(false);
    api.bezugsbasisVergleich(k.id, { von: monatPlus(a.monat, -11), bis: a.monat }).then(
      (v) => aktiv && setVergleich(v),
      () => aktiv && setVergleichFehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [k.id, a.monat, mitBasis, versuch]);

  // Die Monatswerte der zwölf Monate: Rechenweg, Versionen und geteilte Register (das Vorjahr trägt die Auswertung).
  useEffect(() => {
    let aktiv = true;
    api.kennzahlWerte(k.id, 'monat', `${monatPlus(a.monat, -11)}-01`, S.urteilsTag(a.monat, a.monat)).then(
      (w) => aktiv && setWerte(w),
      () => aktiv && setWerte(null),
    );
    return () => {
      aktiv = false;
    };
  }, [k.id, a.monat, versuch]);

  // Die offenen Energieziele: wer für das Ziel dieser Kennzahl verantwortlich ist. Antwortet die Route nicht, fehlt nur
  // der Name. Neu gelesen, sobald ein anderes Ziel an der Kennzahl steht (nach „Energieziel setzen“).
  const zielId = a.energieziel?.id ?? null;
  useEffect(() => {
    let aktiv = true;
    api.energieziele({ zustand: 'offen' }).then(
      (l) => aktiv && setZiele(l.energieziele),
      () => aktiv && setZiele(null),
    );
    return () => {
      aktiv = false;
    };
  }, [k.id, zielId]);
  const ziel = ziele?.find((z) => z.id === zielId) ?? null;
  // Der Stern: die Leitkennzahl der Übersicht, wie der Server sie nennt (§10.8) - nie hier abgeleitet.
  const leit = k.leitkennzahl === true;

  useEffect(() => {
    if (!mitBasis || !darfVerbesserung) return;
    let aktiv = true;
    // Ohne Antwort der Route (kein Recht, kein Vermerk-Weg) fehlt nur die Karte der Auffälligkeit.
    api.auffaelligkeiten(k.id).then(
      (l) => {
        merkeAbruf(l.abruf);
        if (!aktiv) return;
        setVermerkAbruf(l.abruf);
        setVermerke(l.vermerke);
      },
      () => aktiv && setVermerke(null),
    );
    return () => {
      aktiv = false;
    };
  }, [k.id, mitBasis, darfVerbesserung, vermerkStand]);

  const monate = useMemo(() => S.seitenMonate(k, vergleich), [k, vergleich]);
  const antwort = S.antwort(k, monate);
  const vertrauen = S.vertrauen(k, lage, darfFestlegen);
  const kacheln = S.kacheln(k, monate);
  const zielKarte = S.zielKarte(a, ziel);
  const index = Math.max(0, monate.findIndex((m) => m.periode === gewaehlt));
  const m = monate[index] ?? null;
  const fazit = S.fazit(a.zeitraum, monate);
  const auffaelligkeit = vermerke ? S.offeneAuffaelligkeit(vermerke, a.monat) : null;
  const einheit = k.einheit_anzeige ?? '';
  // Ohne einen einzigen Monat mit Vergleich (vor der ersten Fassung) keine zwölf leeren Säulen (§6.13): die Werte mit
  // Vorjahr, der Satz mit dem Datum steht darüber.
  const mitVergleich = mitBasis && monate.some((x) => x.delta !== null);
  // Das Vorjahr je Monat bringt die Auswertung mit (Operation `roh`, kein Urteil) - kein zweiter Abruf, kein Flackern.
  const vorjahrVon = (periode: string) => {
    const v = a.monate.find((y) => y.periode === periode)?.vorjahr ?? null;
    return { roh: v, wert: v ? S.zahlKurz(v.wert, k.einheit) : null, text: vorjahrText(v) };
  };
  // Am Handy steht das Vorjahr mit seiner Veränderung unter dem Monat - wie die Spalten „Vorjahr“ und „Veränderung“.
  const vorjahrSpalte = (periode: string) => {
    const vj = vorjahrVon(periode);
    return vj.roh ? `Vorjahr ${vj.wert}${TRENNER}${S.deltaMitZeichen(vj.roh.delta_prozent)}` : 'ohne Vorjahreswert';
  };
  const info = m ? S.infozeile(m, mitVergleich ? null : vorjahrVon(m.periode)) : null;
  const schritt = werte?.werte.find((w) => w.schluessel === gewaehlt) ?? null;
  const herkunft = werte && schritt ? herkunftAnzeige(werte, schritt, eingangsNamen(fassungen)) : null;
  const einstieg = versionenEinstieg(schritt);
  const b = berechnung(k, fassungen, werte?.zeitzone ?? zone);
  const nenner = schritt?.nenner && schritt.einheit?.includes('/') ? { wert: schritt.nenner, einheit: schritt.einheit.split('/')[1] } : null;
  const erwartetSatz = m ? S.erwartetSatz(m, a.monate[index]?.erwartet_wert ?? null, k.einheit, nenner) : null;
  const zusammenEnde = m ? S.zusammenEnde(monate, m.mengeEinheit) : null;
  const zusammenTon = zusammenEnde?.ton ?? 'warn';
  const zuBasis = onBezugsbasis ? () => onBezugsbasis() : undefined;
  const wahlText = info ? [info.monat, info.wert, info.statt, info.urteil?.text].filter(Boolean).join(', ') : '';

  // Bis die Zeilen des Vergleichs da sind, Skelette in der Höhe von Satz und Kachel - der Satz springt nicht um (§6.13).
  const vergleichLaedt = mitBasis && !vergleich && !vergleichFehler;
  const antwortBlock = vergleichLaedt ? (
    <div aria-busy="true">
      <Skeleton height={64} />
    </div>
  ) : antwort && (
    <div className="vp-kzs-antwort" data-testid="kennzahl-antwort">
      <p className="vp-kzs-satz">{antwort.satz}</p>
      <p className="vp-kzs-formal">
        {antwort.formal.vor}
        {antwort.formal.basis && (
          <>
            {' '}
            {zuBasis ? (
              <button type="button" className="vp-kzs-begriff" onClick={zuBasis} data-testid="antwort-bezugsbasis">
                {antwort.formal.basis}
              </button>
            ) : (
              antwort.formal.basis
            )}
          </>
        )}
      </p>
      {antwort.marke && !mitBasis && (
        <div className="vp-kzs-marken">
          <Marke art={antwort.marke.art}>{antwort.marke.text}</Marke>
        </div>
      )}
    </div>
  );

  const vertrauenBlock = vertrauen && (
    <Hinweis art={vertrauen.art} testid="kennzahl-vertrauen">
      {vertrauen.fett && <b>{vertrauen.fett}</b>} {vertrauen.satz}{' '}
      {vertrauen.weg && zuBasis && (
        <button type="button" className="vp-kzs-weg" onClick={zuBasis}>
          {vertrauen.weg.wort}
        </button>
      )}
    </Hinweis>
  );

  const kachelBlock = vergleichLaedt ? (
    <div aria-busy="true">
      <Skeleton height={148} />
    </div>
  ) : kacheln && mitBasis && (
    <div className="vp-kzs-kacheln" data-testid="kennzahl-kacheln">
      <article className="vp-k ton-load is-lead vp-kzs-lead" aria-label={kacheln.monat}>
        <div className="vp-k-kopf">
          <span className="vp-k-ico" aria-hidden="true">
            <Icon name="chart" size={16} />
          </span>
          <span className="vp-k-name">{kacheln.monat}</span>
          {leit && (
            <span className="vp-k-stern" title={LEITKENNZAHL} aria-label={LEITKENNZAHL}>
              <Icon name="star" size={14} />
            </span>
          )}
        </div>
        {kacheln.zahl ? (
          <span className="vp-k-gross is-xl">
            {kacheln.zahl}
            {kacheln.einheit && <span className="vp-k-einheit">{kacheln.einheit}</span>}
          </span>
        ) : (
          <span className="vp-kzs-ohnewert">{`${kacheln.monat}: noch kein Wert`}</span>
        )}
        {kacheln.marken.length > 0 && (
          <div className="vp-kzs-marken">
            {kacheln.marken.map((x) => (
              <Marke key={x.text} art={x.art}>
                {x.text}
              </Marke>
            ))}
          </div>
        )}
        {kacheln.erwartetWert && (
          <p className="vp-k-sub">
            erwartet <b>{kacheln.erwartetWert.wert}</b>
            {kacheln.erwartetWert.bei && ` bei ${kacheln.erwartetWert.bei}`}
            {!telefon && kacheln.gemessen && kacheln.erwartet &&
              ` · gemessen ${kacheln.gemessen.zahl}\u00a0${kacheln.gemessen.einheit}, erwartet ${kacheln.erwartet.zahl}\u00a0${kacheln.erwartet.einheit}`}
          </p>
        )}
      </article>
      {telefon && kacheln.gemessen && (
        <article className="vp-k" aria-label={S.KACHEL_GEMESSEN} data-testid="kachel-gemessen">
          <div className="vp-k-kopf">
            <span className="vp-k-name">{S.KACHEL_GEMESSEN}</span>
          </div>
          <span className="vp-k-gross">
            {kacheln.gemessen.zahl}
            <span className="vp-k-einheit">{kacheln.gemessen.einheit}</span>
          </span>
          <p className="vp-k-sub">
            <b>{kacheln.gemessen.fett}</b>
            {kacheln.gemessen.rest}
          </p>
        </article>
      )}
      {telefon && kacheln.erwartet && (
        <article className="vp-k" aria-label={S.KACHEL_ERWARTET} data-testid="kachel-erwartet">
          <div className="vp-k-kopf">
            <span className="vp-k-name">{S.KACHEL_ERWARTET}</span>
          </div>
          <span className="vp-k-gross">
            {kacheln.erwartet.zahl}
            <span className="vp-k-einheit">{kacheln.erwartet.einheit}</span>
          </span>
          <p className="vp-k-sub">{kacheln.erwartet.unter}</p>
        </article>
      )}
    </div>
  );

  const zielBlock = zielKarte && (
    <section className="vp-kz-block vp-kzs-karte" aria-label={zielKarte.titel} data-testid="kennzahl-energieziel">
      <div className="vp-kzs-blockkopf">
        <h2>{zielKarte.titel}</h2>
        <a className="vp-kzs-link" href={hashForRoute(energiezielRoute(zielKarte.id))}>
          {S.ZUM_ZIEL}
        </a>
      </div>
      <p className="vp-kzs-text">{zielKarte.satz}</p>
      <ZielSkala
        jetzt={zielKarte.jetzt}
        jetztText={zielKarte.jetztLabel}
        ziel={zielKarte.ziel}
        zielText={zielKarte.zielLabel}
        mitte={S.SKALA_MITTE}
        links={S.SKALA_MEHR}
        rechts={S.SKALA_WENIGER}
        ton={zielKarte.ton}
      />
      <p className="vp-kzs-fuss">{zielKarte.fuss}</p>
    </section>
  );

  // Ohne einen einzigen Wert in den zwölf Monaten keine Grafik aus leeren Säulen - ein Satz sagt es (fehlend ist keine Null).
  const ohneJedenWert = !vergleichLaedt && monate.length > 0 && monate.every((x) => x.wert === null && x.delta === null);
  const grafikBlock = ohneJedenWert ? (
    <section className="vp-kz-block vp-kzs-karte" aria-label={S.TITEL_JE_MONAT_OHNE} data-testid="kennzahl-grafik">
      <h2>{S.TITEL_JE_MONAT_OHNE}</h2>
      <p className="vp-kzs-text" data-testid="kennzahl-ohne-werte">
        {S.ohneWerteSatz(monate[0].periode, a.monat)}
      </p>
    </section>
  ) : (
    <section className="vp-kz-block vp-kzs-karte" aria-label={mitVergleich ? S.TITEL_JE_MONAT : S.TITEL_JE_MONAT_OHNE} data-testid="kennzahl-grafik">
      <div className="vp-kzs-blockkopf">
        <h2>{mitVergleich ? S.TITEL_JE_MONAT : S.TITEL_JE_MONAT_OHNE}</h2>
        <span className="vp-kzs-m">{mitVergleich ? (telefon || !a.zeitraum ? S.ZWOELF_MONATE : `${S.monatLang(monate[0]?.periode ?? a.monat)} bis ${S.monatLang(a.monat)}`) : einheit}</span>
      </div>
      {mitBasis && vergleichFehler ? (
        <ErrorState message={S.VERGLEICH_LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />
      ) : mitBasis && !vergleich ? (
        <div aria-busy="true">
          <Skeleton height={232} />
        </div>
      ) : (
        <>
          {info && <Infozeile monat={info.monat} wert={info.wert} statt={info.statt} urteil={info.urteil} />}
          {mitVergleich ? (
            <>
              <AbweichungsGrafik
                titel={antwort?.satz ?? S.TITEL_JE_MONAT}
                monate={monate}
                bandProzent={a.vergleich?.band_prozent ?? null}
                dicht={!telefon}
                gewaehlt={index}
                onWahl={(i) => setGewaehlt(monate[i].periode)}
                wahlText={wahlText}
              />
              <Legende
                eintraege={[
                  { text: S.LEGENDE_MEHR, art: 'mehr' },
                  { text: S.legendeRahmen((a.vergleich?.band_prozent ?? '2').replace(/\.0+$/, '').replace('.', ',')), art: 'rahmen' },
                  { text: S.LEGENDE_WENIGER, art: 'weniger' },
                ]}
              />
              {fazit && (
                <p className="vp-kzs-fazit" data-testid="kennzahl-fazit">
                  <b>{fazit.fett}</b>
                  {fazit.rest}
                </p>
              )}
            </>
          ) : (
            <>
              <SpaltenGrafik
                titel={antwort?.satz ?? S.TITEL_JE_MONAT_OHNE}
                monate={monate.map((x) => ({ ...x, wert: a.monate.find((y) => y.periode === x.periode)?.wert ?? null, vorjahr: vorjahrVon(x.periode).roh?.wert ?? null }))}
                gewaehlt={index}
                onWahl={(i) => setGewaehlt(monate[i].periode)}
                wahlText={wahlText}
              />
              <Legende
                eintraege={[
                  { text: S.LEGENDE_JAHR, art: 'jahr' },
                  { text: S.LEGENDE_VORJAHR, art: 'vorjahr' },
                ]}
              />
            </>
          )}
          <span className="vp-kzs-tipp">
            <Icon name="hand" size={13} />
            {telefon ? S.TIPP_HANDY : S.TIPP_RECHNER}
          </span>
        </>
      )}
    </section>
  );

  const zusammenBlock = !telefon && mitBasis && vergleich && zusammenEnde && (
    <section className="vp-kz-block vp-kzs-karte" aria-label={S.TITEL_ZUSAMMEN} data-testid="kennzahl-zusammen">
      <div className="vp-kzs-blockkopf">
        <h2>{S.TITEL_ZUSAMMEN}</h2>
        <span className="vp-kzs-m">{`seit ${zusammenEnde.seit}, in ${m?.mengeEinheit ?? ''}`}</span>
      </div>
      <ZusammenGrafik titel={`${S.TITEL_ZUSAMMEN}: ${zusammenEnde.text} seit ${zusammenEnde.seit}`} monate={monate} endText={zusammenEnde.text} ton={zusammenTon} />
      <p className="vp-kzs-fazit">
        {zusammenEnde.satz.vor}
        <b>{zusammenEnde.satz.fett}</b>
        {zusammenEnde.satz.nach}
      </p>
    </section>
  );

  // Ein Monat aus der Liste: die Grafik zeigt ihn in der Infozeile, der Rechenweg rechnet ihn vor.
  const zeigeMonat = (periode: string) => {
    setGewaehlt(periode);
    const ruhig = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.querySelector('[data-testid="kennzahl-grafik"]')?.scrollIntoView?.({ block: 'start', behavior: ruhig ? 'auto' : 'smooth' });
  };
  const werteListe = [...monate].reverse().filter((x) => x.wert !== null || x.delta !== null);
  const sichtbar = alle ? werteListe : werteListe.slice(0, 3);
  const werteBlock = werteListe.length > 0 && (
    <section className="vp-kz-block vp-kzs-karte" aria-label={S.TITEL_WERTE} data-testid="kennzahl-werte">
      <div className="vp-kzs-blockkopf">
        <h2>{S.TITEL_WERTE}</h2>
        <span className="vp-kzs-m">{S.NEUESTE_ZUERST}</span>
      </div>
      {telefon ? (
        <ol className="vp-kzs-monate">
          {sichtbar.map((x) => {
            const marke = S.urteilMarke(a.monate.find((y) => y.periode === x.periode)?.urteil ?? null, x.delta);
            return (
              <li key={x.periode}>
                <button type="button" className={`vp-kzs-monat${x.periode === gewaehlt ? ' is-wahl' : ''}`} onClick={() => zeigeMonat(x.periode)} aria-pressed={x.periode === gewaehlt}>
                  <span className="vp-kzs-mo">{x.lang}</span>
                  <span className="vp-kzs-mw">
                    {mitVergleich && x.gemessen && x.erwartet
                      ? `${x.gemessen}, erwartet ${x.erwartet}`
                      : vorjahrSpalte(x.periode)}
                  </span>
                  <span className="vp-kzs-md">
                    {mitVergleich ? x.deltaZeichen && <b>{x.deltaZeichen}</b> : <b>{x.wert ?? 'kein Wert'}</b>}
                    {marke && <Marke art={marke.art}>{marke.text}</Marke>}
                  </span>
                  <span className="vp-kzs-chev" aria-hidden="true">
                    <Icon name="chevron-right" size={16} />
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="vp-kzs-tabelle">
          <table>
            <thead>
              <tr>
                {(mitVergleich ? S.SPALTEN_WERTE : S.SPALTEN_WERTE_OHNE).map((s, i) => (
                  <th key={s} scope="col" className={i > 0 && i < 5 ? 'is-n' : undefined}>
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(alle ? werteListe : werteListe.slice(0, 12)).map((x) => {
                const am = a.monate.find((y) => y.periode === x.periode);
                const marke = S.urteilMarke(am?.urteil ?? null, x.delta);
                const vj = vorjahrVon(x.periode);
                return (
                  <tr key={x.periode} className={x.periode === gewaehlt ? 'is-wahl' : undefined} onClick={() => setGewaehlt(x.periode)}>
                    {/* Wählbar auch mit der Tastatur (Review r3): der Monat ist ein Knopf, die Zeile bleibt die Mausfläche. */}
                    <th scope="row">
                      <button
                        type="button"
                        className="vp-kzs-zeilenwahl"
                        aria-pressed={x.periode === gewaehlt}
                        onClick={(e) => {
                          e.stopPropagation();
                          setGewaehlt(x.periode);
                        }}
                      >
                        {x.lang}
                      </button>
                    </th>
                    {mitVergleich ? (
                      <>
                        <td className="is-n">{x.gemessen ?? '—'}</td>
                        <td className="is-n">{x.bedingungKurz ?? '—'}</td>
                        <td className="is-n">{x.erwartet ?? '—'}</td>
                        <td className="is-n">{x.deltaZeichen ? <b>{x.deltaZeichen}</b> : '—'}</td>
                        <td>{marke ? <Marke art={marke.art}>{marke.text}</Marke> : <span className="vp-kz-leise">{x.grundSatz ? 'nicht bewertbar' : '—'}</span>}</td>
                      </>
                    ) : (
                      <>
                        <td className="is-n">{x.wert ?? '—'}</td>
                        <td className="is-n">{vj.wert ?? '—'}</td>
                        <td className="is-n">{vj.roh ? S.deltaMitZeichen(vj.roh.delta_prozent) : '—'}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {telefon && werteListe.length > 3 && (
        <button type="button" className="vp-kzs-link" onClick={() => setAlle((x) => !x)} aria-expanded={alle}>
          {alle ? 'Weniger Monate' : S.alleMonate(werteListe.length)}
        </button>
      )}
    </section>
  );

  const auffaelligkeitBlock = auffaelligkeit && vermerke && (
    <Hinweis art="auffaellig" testid="kennzahl-auffaelligkeit">
      <b>{auffaelligkeit.titel}</b> {auffaelligkeit.satz}{' '}
      {!antworten && (
        <button type="button" className="vp-kzs-weg" onClick={() => setAntworten(true)} data-testid="auffaelligkeit-beantworten">
          {S.BEANTWORTEN}
        </button>
      )}
      {antworten && (
        <VermerkZeile
          vermerke={vermerke.filter((v) => v.id === auffaelligkeit.id)}
          alle={vermerke}
          tagHeute={vermerkAbruf}
          onNeu={() => {
            setAntworten(false);
            setVermerkStand((x) => x + 1);
          }}
        />
      )}
    </Hinweis>
  );

  const worausBlock = (
    <section className="vp-kz-block vp-kzs-karte" aria-label={S.TITEL_WORAUS} data-testid="kennzahl-herkunft">
      <div className="vp-kzs-blockkopf">
        <h2>{S.TITEL_WORAUS}</h2>
        {m && <span className="vp-kzs-m">{m.lang}</span>}
      </div>
      {herkunft?.klartext ? (
        <p className="vp-kzs-text" data-testid="kennzahl-klartext">
          <HerkunftsZeile stuecke={S.worausStuecke(herkunft.klartextStuecke, m?.lang ?? S.monatLang(a.monat), m?.wert ?? null)} />
        </p>
      ) : herkunft?.eingaenge ? (
        <p className="vp-kzs-text">
          <HerkunftsZeile stuecke={herkunft.eingaengeStuecke} />
        </p>
      ) : (
        <p className="vp-kz-leise">{m?.wert ? `${m.lang}: ${m.wert}.` : `Für ${m?.lang ?? S.monatLang(a.monat)} gibt es keinen Wert.`}</p>
      )}
      {herkunft && herkunft.paare.length > 0 && (
        <ul className="vp-kz-paare">
          {herkunft.paare.map((p, i) => (
            <li key={p}>
              <HerkunftsZeile stuecke={herkunft.paareStuecke[i] ?? [{ text: p, sprung: null }]} />
            </li>
          ))}
        </ul>
      )}
      <ArchivierteEingaenge liste={archivierteEingaenge} />
      {erwartetSatz && (
        <p className="vp-kzs-text" data-testid="kennzahl-erwartet">
          {erwartetSatz.vor}
          <b>{erwartetSatz.fett}</b>.
        </p>
      )}
      {herkunft?.fehlt && <p className="vp-kz-ehrlich">{herkunft.fehlt}</p>}
      {werte && (
        <GeteiltesRegisterHinweis saetze={(werte.geteilte_register ?? []).map((g) => uemsGeteiltSatz(g.messstellen))} />
      )}
      <details className="vp-kz-rechenweg" data-testid="kennzahl-rechenweg">
        <summary>{S.WIE_GERECHNET}</summary>
        {herkunft?.eingaenge && herkunft.klartext && <p>{herkunft.eingaenge}</p>}
        {herkunft?.gebildet && <p className="vp-kz-leise">{herkunft.gebildet}</p>}
        {einstieg && <VersionenEinstieg einstieg={einstieg} onOeffnen={() => setVersionenOffen(true)} />}
        <BerechnungBlock b={b} />
        <p className="vp-kz-leise">{UEMS_FASSUNG_SATZ}</p>
        <p className="vp-kz-leise">{UEMS_VERSION_SATZ}</p>
      </details>
      {schritt && einstieg && (
        <VersionenModal
          open={versionenOffen}
          objekt={kopf(k).titel}
          periode={schritt.beschriftung}
          schluessel={`${k.id}|monat|${schritt.von}`}
          laden={() => api.kennzahlWertVersionen(k.id, 'monat', schritt.von).then(kennzahlHistorie)}
          onClose={() => setVersionenOffen(false)}
        />
      )}
    </section>
  );

  const basisBlock = lage && <BasisKarte k={k} lage={lage} stichtag={stichtag} darfFestlegen={darfFestlegen} onBezugsbasis={zuBasis} />;

  if (telefon) {
    return (
      <div className="vp-kzs-spalte">
        {antwortBlock}
        {vertrauenBlock}
        {kachelBlock}
        {zielBlock}
        {grafikBlock}
        {werteBlock}
        {auffaelligkeitBlock}
        {worausBlock}
        {basisBlock}
      </div>
    );
  }
  return (
    <>
      <div className="vp-kzs-raster">
        <div className="vp-kzs-spalte">
          {antwortBlock}
          {vertrauenBlock}
          {grafikBlock}
          {zusammenBlock}
        </div>
        <div className="vp-kzs-spalte">
          {kachelBlock}
          {zielBlock}
          {worausBlock}
          {basisBlock}
          {auffaelligkeitBlock}
        </div>
      </div>
      {werteBlock}
    </>
  );
}

/** Die Berechnung mit ihren Fassungen (AP-11 IP-15) im Aufklapper „Wie wird gerechnet?“ - mit Abzeichen wie „rückwirkend“. */
function BerechnungBlock({ b }: { b: ReturnType<typeof berechnung> }) {
  if (!b) return null;
  return (
    <div data-testid="kennzahl-berechnung">
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
    </div>
  );
}

/** Die Bezugsbasis in Klartext (§6.5 Nr. 9): Vergleichszeitraum, Erwartung mit Band, Gilt - und der Weg eine Ebene tiefer. */
function BasisKarte({
  k,
  lage,
  stichtag,
  darfFestlegen,
  onBezugsbasis,
}: {
  k: Kennzahl;
  lage: { basis: Bezugsbasis; fassung: BezugsbasisFassung | null };
  stichtag: string;
  darfFestlegen: boolean;
  onBezugsbasis?: () => void;
}) {
  const zeilen = S.basisKlartext(lage.basis, lage.fassung, k.einheit_anzeige, stichtag);
  return (
    <section className="vp-kz-block vp-kzs-karte" aria-label={S.TITEL_BEZUGSBASIS} data-testid="kennzahl-bezugsbasis">
      <div className="vp-kzs-blockkopf">
        <h2>{S.TITEL_BEZUGSBASIS}</h2>
        {onBezugsbasis && (
          <button type="button" className="vp-kzs-link" onClick={onBezugsbasis} data-testid="alle-fassungen">
            {S.ALLE_FASSUNGEN}
          </button>
        )}
      </div>
      {zeilen.length > 0 ? (
        <dl className="vp-kzs-zuo">
          {zeilen.map((z) => (
            <div key={z.name}>
              <dt>{z.name}</dt>
              <dd>{z.wert}</dd>
              {z.leise && <dd className="vp-kzs-n">{z.leise}</dd>}
            </div>
          ))}
        </dl>
      ) : (
        <p className="vp-kzs-text">{S.OHNE_FASSUNG_SATZ}</p>
      )}
      {onBezugsbasis && darfFestlegen && k.archiviert_am === null && (
        <div className="vp-kz-aktionen">
          <Button variant="outline" size="sm" onClick={onBezugsbasis}>
            {S.NEUE_FASSUNG}
          </Button>
        </div>
      )}
    </section>
  );
}

/** „Eingang archiviert (KZ-0001)“ (IP-15) - als Warnmarke am Rechenweg, nie versteckt. */
function ArchivierteEingaenge({ liste }: { liste: string[] }) {
  if (liste.length === 0) return null;
  return (
    <p className="vp-kz-zeichen" data-testid="kennzahl-eingang-archiviert">
      {liste.map((t) => (
        <Badge key={t} variant="warn">
          {t}
        </Badge>
      ))}
    </p>
  );
}

/** Ein Satz mit Grund und Weg (§6.1 Regel 2) - Warnung mit Warnzeichen, Hinweis mit Info. */
function Hinweis({ art, testid, children }: { art: 'warn' | 'info' | 'auffaellig'; testid: string; children: ReactNode }) {
  return (
    <div className={`vp-kzs-hinweis is-${art}`} data-testid={testid}>
      <span className="vp-kzs-hinweis-icon" aria-hidden="true">
        <Icon name={art === 'warn' ? 'alert-triangle' : 'info'} size={16} />
      </span>
      <div className="vp-kzs-hinweis-text">{children}</div>
    </div>
  );
}

// ================================================================================== ohne Auswertung: die Werte-Karte

/**
 * Ohne Auswertung (archiviert, ohne Monatswerte, ohne Monat als Periode): der Perioden-Umschalter (nur die bildbaren),
 * die Werte-Karte mit „Versionen“, die Herkunft und der Verlauf als Balken - wie vor PR2.
 */
function WerteOhneAuswertung({
  k,
  fassungen,
  zone,
  versuch,
  archivierteEingaenge,
  onNeu,
}: {
  k: Kennzahl;
  fassungen: KennzahlFassung[];
  zone: string;
  versuch: number;
  archivierteEingaenge: string[];
  onNeu: () => void;
}) {
  const [art, setArt] = useState<KennzahlPeriodeArt | null>(() => periodenWahl(k).vorgabe);
  const [autoArt, setAutoArt] = useState(true);
  const [werte, setWerte] = useState<{ schluessel: string; antwort: KennzahlWerte } | null>(null);
  const [werteFehler, setWerteFehler] = useState(false);
  const [gewaehlt, setGewaehlt] = useState<string | null>(null);
  const [versionenOffen, setVersionenOffen] = useState(false);
  const schluessel = art ? `${k.id}|${art}|${versuch}` : null;

  useEffect(() => {
    if (!art || !schluessel) return;
    let aktiv = true;
    setWerteFehler(false);
    const { von, bis } = anfrage(art, heuteIn(zone, Date.now()), ANZAHL_VERLAUF[art]);
    api.kennzahlWerte(k.id, art, von, bis).then(
      (antwort) => aktiv && setWerte({ schluessel, antwort }),
      () => aktiv && setWerteFehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [k.id, art, zone, schluessel]);

  // Rückt die Vorgabe über leere Grundperioden hinweg zur nächstgröberen mit Werten - nur, solange automatisch gewählt.
  useEffect(() => {
    if (!autoArt || !art) return;
    const geladen = werte && werte.schluessel === schluessel ? werte.antwort : null;
    if (!geladen || !ohneWert(geladen)) return;
    const perioden = listenPerioden(k);
    const naechste = perioden[perioden.indexOf(art) + 1];
    if (naechste) setArt(naechste);
  }, [autoArt, art, k, werte, schluessel]);

  const wahl = periodenWahl(k);
  const aktuell = werte !== null && werte.schluessel === schluessel ? werte.antwort : null;
  const schritt = aktuell ? (aktuell.werte.find((w) => w.schluessel === gewaehlt) ?? letzterSchritt(aktuell)) : null;
  const wk = aktuell && schritt ? wertKarte(aktuell, schritt, eingaengeDer(fassungen, schritt)) : null;
  const einstieg = versionenEinstieg(schritt);
  const herkunft = aktuell && schritt ? herkunftAnzeige(aktuell, schritt, eingangsNamen(fassungen)) : null;
  const b = berechnung(k, fassungen, aktuell?.zeitzone ?? zone);

  return (
    <div className="vp-kzs-spalte">
      {wahl.optionen.length > 0 && art && (
        <div className="vp-kz-perioden">
          <ZeitSegment
            label={PERIODE_WAHL}
            optionen={wahl.optionen}
            wert={art}
            onWert={(x) => {
              setArt(x);
              setGewaehlt(null);
              setAutoArt(false);
            }}
          />
        </div>
      )}
      {werteFehler ? (
        <ErrorState message={WERTE_FEHLER} onRetry={onNeu} />
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
          {aktuell && <GeteiltesRegisterHinweis saetze={(aktuell.geteilte_register ?? []).map((g) => uemsGeteiltSatz(g.messstellen))} />}
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
      <ArchivierteEingaenge liste={archivierteEingaenge} />
      {herkunft ? (
        <section className="vp-kz-block vp-kzs-karte" aria-label={S.TITEL_WORAUS} data-testid="kennzahl-herkunft">
          <h2>{S.TITEL_WORAUS}</h2>
          {herkunft.klartext ? (
            <p className="vp-kzs-text" data-testid="kennzahl-klartext">
              <HerkunftsZeile stuecke={herkunft.klartextStuecke} />
            </p>
          ) : (
            herkunft.eingaenge && (
              <p className="vp-kzs-text">
                <HerkunftsZeile stuecke={herkunft.eingaengeStuecke} />
              </p>
            )
          )}
          {herkunft.paare.length > 0 && (
            <ul className="vp-kz-paare">
              {herkunft.paare.map((p, i) => (
                <li key={p}>
                  <HerkunftsZeile stuecke={herkunft.paareStuecke[i] ?? [{ text: p, sprung: null }]} />
                </li>
              ))}
            </ul>
          )}
          {herkunft.fehlt && <p className="vp-kz-ehrlich">{herkunft.fehlt}</p>}
          <details className="vp-kz-rechenweg" data-testid="kennzahl-rechenweg">
            <summary>{S.WIE_GERECHNET}</summary>
            {herkunft.eingaenge && herkunft.klartext && <p>{herkunft.eingaenge}</p>}
            {herkunft.gebildet && <p className="vp-kz-leise">{herkunft.gebildet}</p>}
            <BerechnungBlock b={b} />
            <p className="vp-kz-leise">{UEMS_FASSUNG_SATZ}</p>
            <p className="vp-kz-leise">{UEMS_VERSION_SATZ}</p>
          </details>
        </section>
      ) : (
        b && (
          // Ohne Herkunft des gewählten Schritts (noch kein Wert): die Berechnung bleibt erreichbar.
          <section className="vp-kz-block vp-kzs-karte" aria-label={S.WIE_GERECHNET} data-testid="kennzahl-rechenweg-karte">
            <details className="vp-kz-rechenweg" data-testid="kennzahl-rechenweg">
              <summary>{S.WIE_GERECHNET}</summary>
              <BerechnungBlock b={b} />
              <p className="vp-kz-leise">{UEMS_FASSUNG_SATZ}</p>
            </details>
          </section>
        )
      )}
      {art && schritt && einstieg && (
        <VersionenModal
          open={versionenOffen}
          objekt={kopf(k).titel}
          periode={schritt.beschriftung}
          schluessel={`${k.id}|${art}|${schritt.von}`}
          laden={() => api.kennzahlWertVersionen(k.id, art, schritt.von).then(kennzahlHistorie)}
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
