import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type BerichtDetail, type BerichtEntwurf, type BerichtStand } from '../api';
import { darf, freigabeAntrag, freigabeVorschau, freigebenErklaerung, freigebenWer, KEINE_RECHTE, vergleichZeilen } from '../berichtDialoge';
import {
  abschnitte,
  abzugAus,
  ausgabeKnoepfe,
  darfAusgabe,
  gueltigerStand,
  HEUTIGEN_WERT,
  HEUTIGER_WERT_LAEDT,
  heuteAnfrage,
  heutigerWert,
  LADEFEHLER_SEITE,
  LADEFEHLER_STAND,
  NACHWEIS,
  nrAus,
  NICHT_GEFUNDEN,
  PRUEFSUMME_GEPRUEFT,
  standId,
  standWahl,
  ZUR_LISTE,
  type Abschnitt,
  type Ansicht,
  type AusgabeKnopf,
  type HeutigerWert,
  type QuellenZahl,
} from '../berichtSeite';
import { ErklaerKnopf } from '../components/nachweisen/ErklaerKnopf';
import { BerichtAenderungenBlatt, BerichtBehaltenBlatt, BerichtFreigebenBlatt, BerichtGrundBlatt } from '../components/nachweisen/BerichtBlaetter';
import { dateiSpeichern } from '../components/nachweisen/datei';
import { NwBlatt } from '../components/nachweisen/NwBlatt';
import { NwKopf } from '../components/nachweisen/NwKopf';
import { StatusZeile } from '../components/nachweisen/NwStatus';
import { NwZeichen } from '../components/nachweisen/NwZeichen';
import { AntwortKarten, HinweisZeile, WerteAltNeu, type WertAltNeu } from '../components/nachweisen/NwSchritte';
import { Stufen } from '../components/nachweisen/Stufen';
import { seitenLink } from '../components/nachweisen/teilen';
import { Weitergeben } from '../components/nachweisen/Weitergeben';
import { Fakt, NwKarte, NwZeile, NwZeilen } from '../components/nachweisen/NwZeilen';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { GrenzHinweis } from '../components/GrenzSatz';
import { HerkunftsZeile } from '../components/HerkunftsZeile';
import { LeistungsvergleichBericht } from '../components/LeistungsvergleichBericht';
import { MiniBarSpark } from '../components/MiniChart';
import { ErrorState, Skeleton } from '../components/States';
import { WerteKarte } from '../components/WerteKarte';
import { ausgabeAbgerufen, ausgabeFehler, istLeistungsvergleich, lvAbzugAus } from '../leistungsvergleichBericht';
import * as N from '../nachweisBerichte';
import { berichtRoute, hashForRoute } from '../nav';
import { useRollen } from '../rollen';
import { merkeAugenblick } from '../routenUhr';
import { TRENNER } from '../uemsErgebnis';
import { useBerichtRechte } from '../useBerichtRechte';
import { useIsPhone } from '../useIsPhone';
import '../components/nachweisen/NwZeilen.css';
import '../components/nachweisen/NwDokumente.css';
import '../components/nachweisen/NwBerichte.css';

/**
 * Die Seite eines Berichts (UEMS AP-12 IP-13; seit Konzept Nachweisen n1, Runde 2, §6.4 in der Familie der Nachweisen-
 * Seiten): Kopf mit Name nach Vorlage und Ort, Status-Zeile („● Stand 2 gilt · Daten unverändert“), Stufen „Entwurf ·
 * Stand 1 · Stand 2“ mit Tag, Weitergeben (PDF, Teilen, CSV); die Karte „Geändert ggü. Stand 1“ mit Werten alt → neu und
 * dem Grund hinter dem i-Zeichen. Nach einer Korrektur fragt die Seite „Neuen Stand freigeben?“ mit den Werten und zwei
 * Antworten (Entscheid 16: alle offenen Anstöße gebündelt, nur Zahlen). Am Handy liegen „Alle Werte“ einen Tipp tiefer,
 * am Rechner stehen sie links; ältere Stände sind Zeilen.
 *
 * Die Abschnitte LIEST die Seite aus dem Abzug des Stands (der Abzug IST das Dokument): `GET …/staende/{nr}` bzw.
 * `…/entwurf`, für „heute: …“ (A5) das Messstellen-Register und die Kennzahlen, und erst auf „heutigen Wert zeigen“
 * `…/messstellen/{kennzeichen}/werte` (§5.6). Bewertung und Managementbewertung zeigen ihre Abschnitte auf ihrer eigenen
 * Seite (Entscheid 15). Eine Uhr: „heute“ ist der `abruf` der Route.
 */
export function BerichtSeite({
  kennung,
  onListe,
  zurListe = ZUR_LISTE,
  jetzt: jetztVorgabe,
  onBewertung,
  onManagementbewertung,
}: {
  kennung: string;
  onListe: () => void;
  /** Das Wort des Rückwegs — am Standort „Berichte dieses Standorts“ (AP-13 IP-2), sonst „Alle Berichte“. */
  zurListe?: string;
  /** Nur für Tests; sonst der Augenblick der Route (`abruf`). */
  jetzt?: () => number;
  onBewertung?: () => void;
  onManagementbewertung?: (kennung: string) => void;
}) {
  const [detail, setDetail] = useState<BerichtDetail | null>(null);
  const [detailFehler, setDetailFehler] = useState<'fehlt' | 'fehler' | null>(null);
  const [wahl, setWahl] = useState<string | null>(null);
  const [ansicht, setAnsicht] = useState<{ id: string; ansicht: Ansicht } | null>(null);
  const [ansichtFehler, setAnsichtFehler] = useState<{ id: string; satz: string } | null>(null);
  const [vorher, setVorher] = useState<{ id: string; stand: BerichtStand } | null>(null);
  const [entscheid, setEntscheid] = useState<{ entwurf: BerichtEntwurf; werte: WertAltNeu[] } | null>(null);
  const [namen, setNamen] = useState<ReadonlyMap<string, string>>(new Map());
  const [versuch, setVersuch] = useState(0);
  const [dateiAbruf, setDateiAbruf] = useState<{ wahl: string; satz: string; fehler: boolean } | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [antwort, setAntwort] = useState<'ja' | 'nein' | null>(null);
  const [blatt, setBlatt] = useState<'freigeben' | 'behalten' | 'grund' | 'aenderungen' | 'werte' | null>(null);
  const rechte = useBerichtRechte();
  const rollen = useRollen();
  const isPhone = useIsPhone();

  useEffect(() => {
    let aktiv = true;
    setDetailFehler(null);
    api.bericht(kennung).then(
      (d) => {
        if (!aktiv) return;
        merkeAugenblick(d.abruf, d.bericht.zeitzone);
        setDetail(d);
        setWahl((alt) => alt ?? standWahl(d).vorgabe);
      },
      (e) => aktiv && setDetailFehler(e instanceof ApiError && e.status === 404 ? 'fehlt' : 'fehler'),
    );
    return () => {
      aktiv = false;
    };
  }, [kennung, versuch]);

  // A5: die heutigen Namen — ein Hinweis; fehlt eine der beiden Quellen, fehlt nur der Hinweis.
  useEffect(() => {
    let aktiv = true;
    Promise.allSettled([api.messstellenRegister(), api.kennzahlen()]).then(([register, kennzahlen]) => {
      if (!aktiv) return;
      const m = new Map<string, string>();
      if (register.status === 'fulfilled') for (const r of register.value.register) if (r.name) m.set(r.kennzeichen, r.name);
      if (kennzahlen.status === 'fulfilled') for (const k of kennzahlen.value.kennzahlen) m.set(k.kennzeichen, k.name);
      setNamen(m);
    });
    return () => {
      aktiv = false;
    };
  }, []);

  // Der gewählte Stand (oder der Entwurf) mit seinem Abzug; am Stand mit Vorgänger auch dessen Abzug für „Geändert“.
  useEffect(() => {
    if (wahl === null || detail === null) return;
    let aktiv = true;
    setAnsichtFehler(null);
    const nr = nrAus(wahl);
    const laden: Promise<Ansicht> =
      nr === null ? api.berichtEntwurf(kennung).then((entwurf) => ({ art: 'entwurf', entwurf })) : api.berichtStand(kennung, nr).then((stand) => ({ art: 'stand', stand }));
    laden.then(
      (a) => aktiv && setAnsicht({ id: wahl, ansicht: a }),
      // 500 `abzug_beschaedigt` und 404 `stand_gibt_es_nicht` sprechen ihren Satz; alles andere ist ein Ladefehler.
      (e) => aktiv && setAnsichtFehler({ id: wahl, satz: e instanceof ApiError && (e.status === 500 || e.status === 404) && e.body ? e.message : LADEFEHLER_STAND }),
    );
    const voriger = nr === null ? null : N.vorigerStand(detail, nr);
    if (voriger) {
      api.berichtStand(kennung, voriger.nr).then(
        (stand) => aktiv && setVorher({ id: wahl, stand }),
        () => undefined,
      );
    }
    return () => {
      aktiv = false;
    };
  }, [kennung, wahl, versuch, detail]);

  // Nach einer Korrektur: der neu gebildete Entwurf gegen den gültigen Stand - die Werte der Entscheidung (R1).
  useEffect(() => {
    if (!detail) return;
    const g = gueltigerStand(detail.staende);
    if (!g || N.offeneAnstoesse(detail).length === 0) {
      setEntscheid(null);
      return;
    }
    let aktiv = true;
    Promise.all([api.berichtEntwurf(kennung), api.berichtVergleich(kennung, g.nr), api.berichtStand(kennung, g.nr)]).then(
      ([entwurf, vergleich, stand]) => {
        if (!aktiv) return;
        setEntscheid({ entwurf, werte: N.werteAltNeu(vergleichZeilen(vergleich.abweichungen, abzugAus(entwurf.abzug), abzugAus(stand.abzug))) });
      },
      () => aktiv && setEntscheid(null),
    );
    return () => {
      aktiv = false;
    };
  }, [kennung, detail]);

  const zurueck = { label: zurListe, onClick: onListe };

  if (detailFehler === 'fehlt' || detailFehler) {
    return (
      <div className="vp-nw-seite vp-br" data-testid="bericht-seite">
        <NwKopf titel={N.BERICHTE_TITEL} zurueck={zurueck} testId="bericht-kopf" />
        {detailFehler === 'fehlt' ? <p className="vp-nw-leise">{NICHT_GEFUNDEN}</p> : <ErrorState message={LADEFEHLER_SEITE} onRetry={() => setVersuch((v) => v + 1)} />}
      </div>
    );
  }
  if (!detail || wahl === null) {
    return (
      <div className="vp-nw-seite vp-br" data-testid="bericht-seite" aria-busy="true">
        <NwKopf titel={N.BERICHTE_TITEL} zurueck={zurueck} testId="bericht-kopf" />
        <Skeleton height={220} />
      </div>
    );
  }

  const b = detail.bericht;
  // Befund 3: die Uhr der Route; ohne `abruf` (ältere Antwort) die des Browsers.
  const routenJetzt = Date.parse(detail.abruf ?? '');
  const jetzt = jetztVorgabe ?? (() => (Number.isNaN(routenJetzt) ? Date.now() : routenJetzt));
  const name = N.berichtName(b);
  const g = gueltigerStand(detail.staende);
  const aktuell = ansicht !== null && ansicht.id === wahl ? ansicht.ansicht : null;
  const gezeigtNr = nrAus(wahl);
  const status = N.seitenStatus(detail, gezeigtNr);
  const stufen = N.stufen(detail);
  const offen = N.offeneAnstoesse(detail);
  const rechteJetzt = rechte === undefined ? KEINE_RECHTE : rechte;
  const archiviert = b.archiviert_am !== null;
  const darfFreigeben = !archiviert && darf(rechteJetzt, 'freigeben', b.geltung_art, b.geltung_id, b.vorlage);
  const darfBehalten = !archiviert && darf(rechteJetzt, 'verwerfen', b.geltung_art, b.geltung_id, b.vorlage);
  const eigene = N.eigeneSeite(b);
  // AP-17 IP-24: der Leistungsvergleich trägt seine eigenen acht Abschnitte (`LeistungsvergleichBericht`).
  const lv = istLeistungsvergleich(b);
  const inhalt = aktuell && !lv && eigene === 'bericht'
    ? abschnitte(abzugAus(aktuell.art === 'stand' ? aktuell.stand.abzug : aktuell.entwurf.abzug), (k) => namen.get(k) ?? null)
    : null;
  // Die Zahlen des Abzugs in der Reihenfolge der Abschnitte: Messstellen, dann Kennzahlen.
  const zahlen = inhalt ? inhalt.abschnitte.flatMap((a) => (a.art === 'messstellen' || a.art === 'kennzahlen' ? a.zeilen : [])) : [];
  const werteAnzahl = inhalt ? zahlen.length : aktuell ? (() => {
    const a = abzugAus(aktuell.art === 'stand' ? aktuell.stand.abzug : aktuell.entwurf.abzug);
    return (a.werte?.length ?? 0) + (a.kennzahlen?.length ?? 0);
  })() : null;
  const knoepfe = lv ? [] : ausgabeKnoepfe(b, aktuell, darfAusgabe(b, rechte ?? null));
  const nr = aktuell?.art === 'stand' ? aktuell.stand.nr : null;
  const abrufen = async (k: AusgabeKnopf) => {
    if (nr === null) return;
    setLaeuft(true);
    setDateiAbruf(null);
    try {
      dateiSpeichern(await api.berichtDatei(b.kennung, nr, k.handlung), k.datei);
      setDateiAbruf({ wahl, satz: ausgabeAbgerufen(k.handlung, nr), fehler: false });
    } catch (e) {
      setDateiAbruf({ wahl, satz: ausgabeFehler(e), fehler: true });
    } finally {
      setLaeuft(false);
    }
  };
  const kundenadministratoren = (rollen.selbst?.kundenadministratoren ?? []).map((p) => p.name);
  const heuteLaden =
    aktuell?.art === 'stand'
      ? async (kennzeichen: string): Promise<HeutigerWert> => {
          const q = heuteAnfrage(b);
          const stand = { nr: aktuell.stand.nr, freigegeben_am: aktuell.stand.freigegeben_am };
          try {
            return heutigerWert({ antwort: await api.messstelleWerte(kennzeichen, q.raster, q.von, q.bis) }, b, stand);
          } catch (fehler) {
            return heutigerWert({ fehler }, b, stand);
          }
        }
      : null;

  // „Geändert ggü. Stand n“: der gezeigte Stand gegen seinen Vorgänger - nur ohne offene Entscheidung (§6.4).
  const geaendert =
    aktuell?.art === 'stand' && vorher?.id === wahl && offen.length === 0
      ? { gegen: vorher.stand.nr, werte: N.werteAltNeu(N.standVergleich(vorher.stand.abzug as Record<string, unknown>, aktuell.stand.abzug as Record<string, unknown>)) }
      : null;
  const anlassDesStands = aktuell?.art === 'stand' ? detail.anstoesse.find((a) => a.id === detail.staende.find((s) => s.nr === aktuell.stand.nr)?.anlass_anstoss_id) ?? null : null;
  // Gebündelt (Entscheid 16): alle offenen Anstöße eine Entscheidung, also ein Grund „10 Korrekturen“ mit allen im Blatt.
  const grund = geaendert
    ? N.aenderungsGruende(anlassDesStands ? [anlassDesStands] : [], aktuell?.art === 'stand' ? (aktuell.stand.abzug as Record<string, unknown>) : null, b.zeitzone)
    : offen.length > 0
      ? N.aenderungsGruende(offen, entscheid ? (entscheid.entwurf.abzug as Record<string, unknown>) : null, b.zeitzone)
      : null;

  // Am Entwurf ohne Stand: „Freigeben“ mit Recht, wenn F1 schon jetzt ja sagt - sonst ihr Satz.
  const entwurfVorschau = aktuell?.art === 'entwurf' && !g ? freigabeVorschau(freigabeAntrag(b, aktuell.entwurf, detail.staende, jetzt()), null, abzugAus(aktuell.entwurf.abzug).kopf.darstellung.zahlenformat) : null;
  const ohneRecht = (
    <p className="vp-nw-leise vp-nw-ohne-recht" data-testid="bericht-freigeben-ohne-recht">
      <span>{freigebenWer(kundenadministratoren)}</span>
      <ErklaerKnopf klein erklaerung={freigebenErklaerung(kundenadministratoren)} testId="bericht-freigeben-warum-knopf" />
    </p>
  );

  const entscheidKarte =
    offen.length > 0 && g && !archiviert ? (
      <NwKarte titel={N.NEUER_STAND_FRAGE} zahl={entscheid && entscheid.werte.length > 0 ? entscheid.werte.length : null} className="vp-nw-br-entscheid" testId="bericht-entscheid">
        <div data-entscheid="bericht_anstoss" className="vp-nw-br-entscheid-innen">
          {!entscheid ? (
            <Skeleton height={72} />
          ) : entscheid.werte.length > 0 ? (
            <WerteAltNeu werte={entscheid.werte.slice(0, N.KARTE_HOECHSTENS)} testid="bericht-entscheid-werte" />
          ) : (
            // Die Korrektur ändert keine Zahl dieses Berichts (nur Versionen): das steht da, statt leerer Pfeile.
            <HinweisZeile icon="info" titel={N.KEINE_ZAHL_AENDERT_SICH} testid="bericht-entscheid-keine-zahl" />
          )}
          {entscheid && entscheid.werte.length > N.KARTE_HOECHSTENS && (
            <NwZeilen>
              <NwZeile titel={N.ALLE_AENDERUNGEN} rechts={<Fakt>{entscheid.werte.length}</Fakt>} onClick={() => setBlatt('aenderungen')} testId="bericht-alle-aenderungen" />
            </NwZeilen>
          )}
          {grund && (
            <button type="button" className="vp-nw-fussnote" onClick={() => setBlatt('grund')} data-testid="bericht-grund">
              <Icon name="info" size={14} />
              Grund: {grund.kurz}
            </button>
          )}
          {darfFreigeben || darfBehalten ? (
            <>
              <AntwortKarten
                label={N.NEUER_STAND_FRAGE}
                optionen={[
                  ...(darfFreigeben ? [{ wert: 'ja' as const, titel: N.jaAntwort(g.nr + 1) }] : []),
                  ...(darfBehalten ? [{ wert: 'nein' as const, titel: N.neinAntwort(g.nr) }] : []),
                ]}
                wert={antwort}
                onWahl={setAntwort}
                testid="bericht-antwort"
              />
              <div className="vp-nw-aktionen">
                <Button disabled={!antwort || (antwort === 'ja' && !entscheid)} onClick={() => setBlatt(antwort === 'ja' ? 'freigeben' : 'behalten')} data-testid="bericht-weiter">
                  {N.WEITER}
                </Button>
              </div>
            </>
          ) : (
            ohneRecht
          )}
        </div>
      </NwKarte>
    ) : null;

  const entwurfAktion =
    entwurfVorschau && !archiviert ? (
      darfFreigeben ? (
        <div className="vp-nw-aktionen" data-testid="bericht-hebel">
          <Button disabled={!entwurfVorschau.erlaubt} onClick={() => setBlatt('freigeben')} data-testid="bericht-freigeben">
            {N.FREIGEBEN}
          </Button>
          {!entwurfVorschau.erlaubt && entwurfVorschau.satz && (
            <p className="vp-nw-leise" data-testid="bericht-freigeben-warum">
              {entwurfVorschau.satz}
            </p>
          )}
        </div>
      ) : (
        rollen.selbst && ohneRecht
      )
    ) : null;

  const geaendertKarte =
    geaendert && geaendert.werte.length > 0 ? (
      <NwKarte titel={`Geändert ggü. Stand ${geaendert.gegen}`} zahl={geaendert.werte.length} testId="bericht-geaendert">
        <WerteAltNeu werte={geaendert.werte.slice(0, N.KARTE_HOECHSTENS)} testid="bericht-geaendert-werte" />
        {geaendert.werte.length > N.KARTE_HOECHSTENS && (
          <NwZeilen>
            <NwZeile titel={N.ALLE_AENDERUNGEN} rechts={<Fakt>{geaendert.werte.length}</Fakt>} onClick={() => setBlatt('aenderungen')} testId="bericht-alle-aenderungen" />
          </NwZeilen>
        )}
        {grund && (
          <button type="button" className="vp-nw-fussnote" onClick={() => setBlatt('grund')} data-testid="bericht-grund">
            <Icon name="info" size={14} />
            Grund: {grund.kurz}
          </button>
        )}
      </NwKarte>
    ) : null;

  // Die Werte selbst: der Abzug des gezeigten Stands, Abschnitt für Abschnitt (wie bisher, unverändert gelesen).
  const werte =
    ansichtFehler?.id === wahl ? (
      <ErrorState message={ansichtFehler.satz} onRetry={() => setVersuch((v) => v + 1)} />
    ) : !aktuell || (!lv && eigene === 'bericht' && !inhalt) ? (
      <div aria-busy="true">
        <Skeleton height={240} />
      </div>
    ) : lv ? (
      <LeistungsvergleichBericht
        key={wahl}
        abzug={lvAbzugAus(aktuell.art === 'stand' ? aktuell.stand.abzug : aktuell.entwurf.abzug)}
        detail={detail}
        stand={aktuell.art === 'stand' ? aktuell.stand : null}
        rechte={rechteJetzt}
      />
    ) : (
      <>
        {inhalt?.hinweis && (
          <p className="vp-note" data-testid="bericht-ohne-darstellung">
            {inhalt.hinweis}
          </p>
        )}
        {inhalt?.abschnitte.map((a) => (
          <AbschnittBlock key={`${wahl}-${a.schluessel}`} abschnitt={a} heuteLaden={a.art === 'messstellen' ? heuteLaden : null} />
        ))}
      </>
    );

  // Stände als Zeilen: am gültigen Stand die älteren („Stand 1 · überholt“), an einem älteren der gültige.
  const standZeilen = [...detail.staende]
    .sort((x, y) => y.nr - x.nr)
    .filter((s) => s.nr !== gezeigtNr)
    .map((s) => (
      <NwZeile
        key={s.nr}
        titel={`Stand ${s.nr}`}
        rechts={<Fakt>{s.ersetzt_durch_nr === null ? 'gilt' : 'überholt'}</Fakt>}
        leise={s.ersetzt_durch_nr !== null}
        onClick={() => setWahl(standId(s.nr))}
        testId={`bericht-stand-${s.nr}`}
      />
    ));
  const sv = aktuell?.art === 'stand' ? aktuell.stand : null;
  const eigeneZeile =
    eigene === 'managementbewertung' && onManagementbewertung ? (
      <NwZeile titel={N.ZUR_SEITE_MANAGEMENTBEWERTUNG} onClick={() => onManagementbewertung(b.kennung)} testId="bericht-eigene-seite" />
    ) : eigene === 'bewertung' && onBewertung ? (
      <NwZeile titel={N.ZUR_SEITE_BEWERTUNG} onClick={onBewertung} testId="bericht-eigene-seite" />
    ) : null;
  const menue: RowMenuItem[] = [{ label: `Kennung ${b.kennung} kopieren`, icon: 'link', onClick: () => void navigator.clipboard?.writeText(b.kennung) }];

  return (
    <>
      <div className={`vp-nw-seite vp-nw-dok vp-br${name.titel.length > 40 ? ' vp-nw-lang' : ''}`} data-testid="bericht-seite">
        <NwKopf
          zurueck={zurueck}
          titel={name.titel}
          kennzeichen={b.kennung}
          erklaerung={{
            frage: 'Was ist ein freigegebener Stand?',
            klartext: 'Ein Stand ist der Bericht, wie er bei der Freigabe war. Er ändert sich nie mehr.',
            beiIhnen: g ? `Stand ${g.nr} gilt seit ${N.tagText(g.freigegeben_am, b.zeitzone)}.` : null,
            nichtVerwechseln: 'Ändern sich danach Daten, fragt VoltPilot, ob ein neuer Stand nötig ist.',
          }}
          kurzzeile={name.unter}
          status={<StatusZeile zeichen={<NwZeichen art={status.zeichen} />} text={status.text} sub={status.sub} warn={status.warn} testId="bericht-status" />}
          menue={<RowMenu label="Weitere Aktionen" items={menue} />}
          testId="bericht-kopf"
        />
        <div className="vp-nw-dok-raster">
          <div className="vp-nw-dok-a">
            {stufen.length > 0 && <Stufen stufen={stufen} testId="bericht-stufen" />}
            {entscheidKarte}
            {entwurfAktion}
            <Weitergeben
              knoepfe={knoepfe.map((k) => ({ symbol: k.handlung === 'pdf' ? 'file-text' : 'speichern', text: k.text, onClick: () => void abrufen(k), laeuft, testId: `bericht-${k.handlung}` }))}
              teilenLink={{ titel: name.titel, url: seitenLink(hashForRoute(berichtRoute(b.kennung))) }}
              testId="bericht-dateien"
            />
            {dateiAbruf?.wahl === wahl && (
              <p className={dateiAbruf.fehler ? 'vp-nw-fehler' : 'vp-nw-leise'} role={dateiAbruf.fehler ? 'alert' : 'status'} data-testid="bericht-abruf">
                {dateiAbruf.satz}
              </p>
            )}
          </div>
          <div className="vp-nw-dok-b">
            {geaendertKarte}
            {eigeneZeile ? (
              <NwZeilen>{eigeneZeile}</NwZeilen>
            ) : isPhone || zahlen.length === 0 ? (
              // Am Handy liegen die Werte einen Tipp tiefer (§6.4: „Alle Werte · 19“); ebenso der Leistungsvergleich.
              <NwZeilen>
                <NwZeile
                  titel={N.ALLE_WERTE}
                  rechts={werteAnzahl !== null && werteAnzahl > 0 ? <Fakt>{werteAnzahl}</Fakt> : undefined}
                  onClick={() => setBlatt('werte')}
                  testId="bericht-alle-werte"
                />
              </NwZeilen>
            ) : (
              // Am Rechner links die Werte als Zeilen (§6.4, Desktop); der ganze Bericht mit Nachweis je Zahl einen Klick tiefer.
              <NwKarte titel="Werte" zahl={zahlen.length} testId="bericht-werte">
                <NwZeilen>
                  {zahlen.slice(0, N.WERTE_RECHNER).map((z) => (
                    <NwZeile key={z.schluessel} titel={z.name} rechts={<Fakt>{z.zahl}</Fakt>} onClick={() => setBlatt('werte')} pfeil={false} testId={`bericht-wert-${z.schluessel}`} />
                  ))}
                  <NwZeile titel={N.GANZER_BERICHT} onClick={() => setBlatt('werte')} testId="bericht-alle-werte" />
                </NwZeilen>
              </NwKarte>
            )}
          </div>
          <div className="vp-nw-dok-c">
            <NwKarte titel="Stand" className="vp-nw-br-stand-karte" testId="bericht-stand-karte">
              <NwZeilen>
                {sv?.freigegeben_von && <NwZeile titel="Freigegeben" rechts={<Fakt>{sv.freigegeben_von.name}</Fakt>} testId="bericht-zeile-freigegeben" />}
                {sv && <NwZeile titel="Datenstand" rechts={<Fakt>{N.zeitText(sv.datenstand, b.zeitzone)}</Fakt>} testId="bericht-zeile-datenstand" />}
                {sv?.pruefsumme_geprueft && <NwZeile titel={PRUEFSUMME_GEPRUEFT} rechts={<Badge variant="ok">✓</Badge>} testId="bericht-zeile-pruefsumme" />}
                {standZeilen}
              </NwZeilen>
            </NwKarte>
          </div>
        </div>
        <GrenzHinweis />
      </div>
      {blatt === 'werte' && (
        <NwBlatt open titel={isPhone ? N.ALLE_WERTE : N.GANZER_BERICHT} onClose={() => setBlatt(null)} breit testId="bericht-werte-blatt">
          <div className="vp-br vp-nw-br-werte-blatt">{werte}</div>
        </NwBlatt>
      )}
      {blatt === 'freigeben' && (entscheid?.entwurf ?? (aktuell?.art === 'entwurf' ? aktuell.entwurf : null)) && (
        <BerichtFreigebenBlatt
          detail={detail}
          entwurf={(entscheid?.entwurf ?? (aktuell?.art === 'entwurf' ? aktuell.entwurf : null))!}
          jetzt={jetzt}
          onClose={() => setBlatt(null)}
          onFertig={(stand) => {
            setBlatt(null);
            setAntwort(null);
            if (stand) setWahl(standId(stand.nr));
            setVersuch((v) => v + 1);
          }}
        />
      )}
      {blatt === 'behalten' && (
        <BerichtBehaltenBlatt
          detail={detail}
          anstoesse={offen}
          onClose={() => setBlatt(null)}
          onFertig={() => {
            setBlatt(null);
            setAntwort(null);
            setVersuch((v) => v + 1);
          }}
        />
      )}
      {blatt === 'grund' && grund && <BerichtGrundBlatt titel={grund.titel} zeilen={grund.zeilen} onClose={() => setBlatt(null)} />}
      {blatt === 'aenderungen' && (
        <BerichtAenderungenBlatt
          titel={offen.length > 0 ? N.NEUER_STAND_FRAGE : `Geändert ggü. Stand ${geaendert?.gegen ?? ''}`}
          werte={offen.length > 0 ? (entscheid?.werte ?? []) : (geaendert?.werte ?? [])}
          onClose={() => setBlatt(null)}
        />
      )}
    </>
  );
}

function AbschnittBlock({
  abschnitt: a,
  heuteLaden,
}: {
  abschnitt: Abschnitt;
  heuteLaden: ((kennzeichen: string) => Promise<HeutigerWert>) | null;
}) {
  return (
    <section className="vp-br-block" aria-label={a.titel} data-testid={`bericht-abschnitt-${a.schluessel}`}>
      <h2>{a.titel}</h2>
      {/* Variante B (empfohlen): der Kopf-Abschnitt klappt zu wie das Quellenverzeichnis — Datenstand, Stand,
          Freigabe und Prüfsumme stehen schon im Seitenkopf; Regelwerk und Darstellung bleiben einen Tipp entfernt. */}
      {a.art === 'kopf' && (
        <details className="vp-br-quellen" data-testid="bericht-angaben">
          <summary>{a.anzahl}</summary>
          <Angaben zeilen={a.zeilen} />
        </details>
      )}
      {a.art === 'qualitaet' && <Angaben zeilen={a.zeilen} />}
      {a.art === 'qualitaet' && a.korrekturen.length > 0 && (
        <ul className="vp-br-liste-text">
          {a.korrekturen.map((k) => (
            <li key={k}>{k}</li>
          ))}
        </ul>
      )}
      {a.art === 'zusammenfassung' && (
        <>
          <ul className="vp-br-kacheln">
            {a.kacheln.map((k) => (
              <li key={k.name}>
                <span className="vp-br-kachel-name">{k.name}</span>
                <span className="vp-br-kachel-zahl">{k.wert}</span>
              </li>
            ))}
          </ul>
          {a.zaehlung && <p className="vp-br-unter">{a.zaehlung}</p>}
        </>
      )}
      {a.art === 'messstellen' && a.vergleiche.length > 0 && (
        <ul className="vp-br-vergleiche">
          {a.vergleiche.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ul>
      )}
      {a.art === 'kennzahlen' && a.leer && <p className="vp-br-leer">{a.leer}</p>}
      {a.art === 'messstellen' && (
        <ul className="vp-br-zahlen">
          {a.gruppen.map((g) => (
            <li
              key={g.schluessel}
              className={g.richtungspaar ? 'vp-br-paar' : undefined}
              data-testid={g.richtungspaar ? 'bericht-richtungspaar' : undefined}
              data-quelle={g.richtungspaar ? g.schluessel : undefined}
            >
              {g.richtungspaar ? (
                <>
                  <p className="vp-br-paar-kopf">
                    <span className="vp-br-kz">{g.kennzeichen}</span> {g.name}
                  </p>
                  {g.fehlt && <p className="vp-br-paar-fehlt">{g.fehlt}</p>}
                  <ul>
                    {g.zeilen.map((z) => (
                      <li key={z.schluessel}>
                        <ZahlZeile zahl={z} heuteLaden={heuteLaden} />
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <ZahlZeile zahl={g.zeilen[0]} heuteLaden={heuteLaden} />
              )}
            </li>
          ))}
        </ul>
      )}
      {a.art === 'kennzahlen' && (
        <ul className="vp-br-zahlen">
          {a.zeilen.map((z) => (
            <li key={z.schluessel}>
              <ZahlZeile zahl={z} heuteLaden={heuteLaden} />
            </li>
          ))}
        </ul>
      )}
      {a.art === 'tagesverlauf' && (
        <>
          {a.leer && <p className="vp-br-leer">{a.leer}</p>}
          <ul className="vp-br-tagesverlauf">
            {a.zeilen.map((z) => (
              <li key={z.schluessel} data-testid="bericht-tagesverlauf" data-quelle={z.schluessel}>
                <p className="vp-br-tagesverlauf-kopf">
                  <span className="vp-br-kz">{z.kennzeichen}</span> {z.name}
                </p>
                {z.leer ? <p className="vp-br-tagesverlauf-leer">{z.leer}</p> : z.tage.every((t) => t.menge === null) ? (
                  <ul className="vp-br-tage-ohne-menge">
                    {z.tage.map((t) => (
                      <li key={t.tag}>
                        <span>{t.label}: {t.mengeText}</span>
                        <Badge variant="off">{t.zustand}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <MiniBarSpark
                    points={z.tage.map((t) => ({ key: t.tag, label: t.label, value: t.menge, tone: t.ton }))}
                    size="streifen"
                    ariaLabel={`Tagesverlauf ${z.name}`}
                    caption="Tag antippen, um Menge und Zustand abzulesen."
                    readout={(p) => {
                      const tag = z.tage.find((t) => t.tag === p.key)!;
                      return `${tag.label}: ${tag.mengeText} · ${tag.zustand}`;
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {a.art === 'quellen' && (
        <details className="vp-br-quellen" data-testid="bericht-quellen">
          <summary>{a.anzahl}</summary>
          <ul>
            {a.zeilen.map((q) => (
              <li key={q.kennzeichen}>
                {/* AP-13 IP-11: auch das Quellenverzeichnis führt zu seinen Objekten — im Zeitraum des Berichts. */}
                {q.sprung ? (
                  <a className="vp-br-kz vp-br-kz-sprung" href={q.sprung.hash}>
                    {q.kennzeichen}
                  </a>
                ) : (
                  <span className="vp-br-kz">{q.kennzeichen}</span>
                )}
                <span className="vp-br-quelle-text">
                  {[q.name, q.stand].filter((t): t is string => t !== null).join(TRENNER)}
                  {q.heute && <span className="vp-br-heute">{q.heute}</span>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Angaben({ zeilen }: { zeilen: Array<{ name: string; wert: string }> }) {
  return (
    <dl className="vp-br-dl">
      {zeilen.map((z) => (
        <div key={z.name}>
          <dt>{z.name}</dt>
          <dd>{z.wert}</dd>
        </div>
      ))}
    </dl>
  );
}

function ZahlZeile({ zahl: z, heuteLaden }: { zahl: QuellenZahl; heuteLaden: ((kennzeichen: string) => Promise<HeutigerWert>) | null }) {
  const [heute, setHeute] = useState<HeutigerWert | 'laedt' | null>(null);
  const zeigen = () => {
    if (!heuteLaden || !z.messstelle) return;
    setHeute('laedt');
    void heuteLaden(z.messstelle).then(setHeute);
  };
  return (
    <details className="vp-br-zeile" data-testid="bericht-zahl" data-quelle={z.schluessel}>
      <summary>
        <span className="vp-br-zeile-name">
          <span className="vp-br-kz">{z.kennzeichen}</span> {z.name}
          {z.heute && (
            <span className="vp-br-heute" data-testid="bericht-heute">
              {z.heute}
            </span>
          )}
        </span>
        <span className="vp-br-zeile-zahl">{z.zahl}</span>
        <span className="vp-br-zeile-info">
          <Badge variant={z.zustandTon}>{z.zustand}</Badge>
          {z.version && <span>{z.version}</span>}
          {z.kennzeichenSaetze.map((s) => (
            <span key={s} className="vp-br-kennzeichen">
              {s}
            </span>
          ))}
        </span>
      </summary>
      <div className="vp-br-nachweis" aria-label={`${NACHWEIS} ${z.kennzeichen}`} data-testid="bericht-nachweis">
        <WerteKarte karte={z.nachweis.karte} />
        <ul className="vp-br-herkunft">
          {/* AP-13 IP-11 (D1/D2): die Eingänge einer Kennzahl springen in ihre Messstelle — mit dem
              ZEITRAUM DES BERICHTS und der Version, die der Abzug festhält. */}
          {z.nachweis.herkunft.map((h, i) => (
            <li key={h}>
              <HerkunftsZeile stuecke={z.nachweis.herkunftStuecke[i] ?? [{ text: h, sprung: null }]} />
            </li>
          ))}
        </ul>
        {/* AP-13 IP-11 (K4, O10 Schritt 6): derselbe Weg wie von der Kennzahl — der Nachweis führt auf die
            Seite seines Objekts, im Zeitraum des Berichts. Er steht neben „heutigen Wert zeigen“, nicht
            statt dessen: die eine Angabe ist die des Stands, die andere die von heute. */}
        <div className="vp-br-aktionen">
          {heuteLaden && z.messstelle && heute === null && (
            <button type="button" className="vp-br-hebel" onClick={zeigen}>
              {HEUTIGEN_WERT}
            </button>
          )}
          {z.sprung && (
            <a className="vp-br-sprung" href={z.sprung.hash} data-testid="bericht-sprung">
              {z.sprungWort}
            </a>
          )}
        </div>
        {heute === 'laedt' && <p className="vp-br-unter">{HEUTIGER_WERT_LAEDT}</p>}
        {heute !== null && heute !== 'laedt' && (
          <p className={`vp-br-heutiger is-${heute.art}`} data-testid="bericht-heutiger-wert">
            {heute.text}
          </p>
        )}
      </div>
    </details>
  );
}
