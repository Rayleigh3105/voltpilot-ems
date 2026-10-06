import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  ApiError,
  type BewertungMessabdeckung,
  type BewertungMessabdeckungOrt,
  type BewertungRangliste,
  type Energieeinsatz,
  type Messbedarf,
} from '../api';
import { darfVerwalten, laeuft } from '../bewertung';
import { BegriffAufklapper } from '../components/BegriffAufklapper';
import { EnergieeinsatzAnlegenDialog } from '../components/EnergieeinsatzDialoge';
import { GrenzHinweis } from '../components/GrenzSatz';
import { Gross, Kachel, Marke } from '../components/kacheln/Kachel';
import { ZeitSegment } from '../components/HistorieWelt';
import { MessbedarfErfassenDialog } from '../components/Messplanung';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { ErrorState, Skeleton } from '../components/States';
import { VerbrauchVerlauf } from '../components/VerbrauchVerlauf';
import { ladeCsv } from '../ladeCsv';
import { anlageRoute, messstelleRoute, pageRoute, type Route } from '../nav';
import { useRollen } from '../rollen';
import { useIsPhone } from '../useIsPhone';
import {
  bereicheZahl,
  blaettern,
  grenzen,
  kannVor,
  letzterVollerMonat,
  REST_NAME,
  VERBRAUCH_ARTEN,
  VERBRAUCH_FEHLER,
  VERBRAUCH_GESPERRT,
  VERBRAUCH_LEER,
  VERBRAUCH_LISTE_TITEL,
  VERBRAUCH_TITEL,
  VERBRAUCH_UNTERZEILE,
  verbrauchBild,
  verbrauchCsv,
  verlaufBild,
  vorjahrVon,
  WESENTLICH,
  ZAEHLER_PLANEN,
  zeitraumAdresse,
  zeitraumAusAdresse,
  zeitraumKurz,
  zeitraumLang,
  type BereichZeile,
  type Hinweis,
  type Teil,
  type VerbrauchBild,
  type VerbrauchZeitraum,
  type VerlaufBild,
} from '../verbrauch';
import { EnergieeinsatzSeite } from './EnergieeinsatzSeite';
// Die Dialoge der Bewertung (Energieeinsatz anlegen, Messbedarf erfassen) tragen ihre Klassen aus `BewertungPage.css`.
import './BewertungPage.css';
import './VerbrauchPage.css';

/**
 * „Unternehmen › Auswerten › Verbrauch“ (Konzept Auswerten a1, Richtungsfrage 1 = A, §6.3, Entscheid 10.1,
 * `#/portfolio/verbrauch`) und — mitgezogen — die Seite eines Energieeinsatzes (`#/portfolio/verbrauch/{id}`).
 *
 * Wo geht die Energie hin? Zuerst der Antwortsatz, dann die Kachel mit dem Strom des Monats (am Telefon in „12 Monate“
 * statt ihr der Monatsverlauf), dann die Bereiche als sortierte Balken einer Farbe mit dem Rest am Ende und die
 * übrigen Energieträger. Gelesen wird nur, was es schon gibt: Rangliste und Messabdeckung des gewählten Zeitraums,
 * das Vorjahr als zweiter Abruf; jede Ableitung steht im reinen Modul `verbrauch.ts`.
 */
export function VerbrauchPage({
  einsatzId = null,
  onOeffnen,
  onListe,
  onNavigate,
}: {
  einsatzId?: string | null;
  onOeffnen: (id: string) => void;
  onListe: () => void;
  onNavigate: (ziel: Route) => void;
}) {
  if (einsatzId) return <EnergieeinsatzSeite key={einsatzId} id={einsatzId} onListe={onListe} onNavigate={onNavigate} />;
  return <VerbrauchUebersicht onOeffnen={onOeffnen} onNavigate={onNavigate} />;
}

const BASIS = '#/portfolio/verbrauch';

interface Geladen {
  schluessel: string;
  zeitraum: VerbrauchZeitraum;
  rangliste: BewertungRangliste;
  vorjahr: BewertungRangliste | null;
  abdeckung: BewertungMessabdeckung | null;
}

interface VerlaufGeladen {
  schluessel: string;
  bild: VerlaufBild;
}

const schluesselVon = (z: VerbrauchZeitraum) => `${z.art}:${z.bis}`;

/** Ein Abruf, dessen Scheitern nur einen Teil kostet (Vorjahr, Messabdeckung): `null` statt Fehler. */
const oderNull = <T,>(p: Promise<T>): Promise<T | null> => p.then((x) => x, () => null);

function ladeFehler(e: unknown): { satz: string; erneut: boolean } {
  if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return { satz: VERBRAUCH_GESPERRT, erneut: false };
  return { satz: VERBRAUCH_FEHLER, erneut: true };
}

function VerbrauchUebersicht({ onOeffnen, onNavigate }: { onOeffnen: (id: string) => void; onNavigate: (ziel: Route) => void }) {
  const { selbst } = useRollen();
  const verwalten = darfVerwalten(selbst);
  const phone = useIsPhone();
  const letzter = useMemo(() => letzterVollerMonat(), []);
  const [zeitraum, setZeitraumState] = useState<VerbrauchZeitraum>(() => zeitraumAusAdresse(window.location.hash, letzter));
  const [daten, setDaten] = useState<Geladen | null>(null);
  const [verlauf, setVerlauf] = useState<VerlaufGeladen | null>(null);
  const [fehler, setFehler] = useState<{ satz: string; erneut: boolean } | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [einstufungen, setEinstufungen] = useState<Map<string, boolean | null> | null>(null);
  const [messbedarfe, setMessbedarfe] = useState<Messbedarf[] | null>(null);
  const [liste, setListe] = useState<Energieeinsatz[] | null>(null);
  const [dialog, setDialog] = useState<'anlegen' | null>(null);
  const [rest, setRest] = useState<BewertungMessabdeckungOrt | null>(null);
  const schluessel = schluesselVon(zeitraum);

  const setZeitraum = (z: VerbrauchZeitraum) => {
    setZeitraumState(z);
    // Die Wahl steht in der Adresse (Lesezeichen, Zurück aus einem Bereich); kein neuer Verlaufseintrag je Klick.
    window.history.replaceState(window.history.state, '', zeitraumAdresse(BASIS, z, letzter));
  };

  // Rangliste, Vorjahr und Messabdeckung des gewählten Zeitraums.
  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    const g = grenzen(zeitraum);
    const vj = grenzen(vorjahrVon(zeitraum));
    Promise.all([
      api.bewertungRangliste(g.von, g.bis),
      oderNull(api.bewertungRangliste(vj.von, vj.bis)),
      oderNull(api.bewertungMessabdeckung(g.von, g.bis)),
    ]).then(
      ([rangliste, vorjahr, abdeckung]) => {
        if (aktiv) setDaten({ schluessel: schluesselVon(zeitraum), zeitraum, rangliste, vorjahr, abdeckung });
      },
      (e) => aktiv && setFehler(ladeFehler(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [zeitraum, versuch]);

  // Der Monatsverlauf: bei „12 Monate“ aus denselben Abrufen; beim Monat am Rechner die zwölf Monate bis zu ihm.
  const verlaufNoetig = zeitraum.art === 'zwoelf' || !phone;
  useEffect(() => {
    if (!verlaufNoetig || zeitraum.art === 'zwoelf') return;
    let aktiv = true;
    const zwoelf: VerbrauchZeitraum = { art: 'zwoelf', bis: zeitraum.bis };
    const g = grenzen(zwoelf);
    const vj = grenzen(vorjahrVon(zwoelf));
    Promise.all([api.bewertungRangliste(g.von, g.bis), oderNull(api.bewertungRangliste(vj.von, vj.bis))]).then(
      ([r, v]) => aktiv && setVerlauf({ schluessel: schluesselVon(zeitraum), bild: verlaufBild(r, v, zeitraum.bis) }),
      () => aktiv && setVerlauf(null),
    );
    return () => {
      aktiv = false;
    };
  }, [verlaufNoetig, zeitraum, versuch]);

  // Einstufungen (für die Marke „wesentlich“), offene Messbedarfe und die Einsätze für die Dialoge — einmal je Seite.
  const ids = useMemo(() => (daten ? [...daten.rangliste.einsaetze].map((e) => e.id).sort().join(',') : ''), [daten]);
  useEffect(() => {
    if (!ids) return;
    let aktiv = true;
    Promise.all(
      ids.split(',').map((id) =>
        api.energieeinsatzEinstufungen(id).then(
          (h) => {
            const gilt = h.fassungen.find((f) => f.freigabe_status === 'freigegeben' && !f.gueltig_bis);
            return [id, gilt ? gilt.einstufung === 'wesentlich' : null] as const;
          },
          () => [id, null] as const,
        ),
      ),
    ).then((paare) => aktiv && setEinstufungen(new Map(paare)));
    return () => {
      aktiv = false;
    };
  }, [ids]);
  useEffect(() => {
    let aktiv = true;
    oderNull(api.messbedarfeAlle()).then((r) => aktiv && setMessbedarfe(r?.messbedarfe ?? null));
    oderNull(api.energieeinsaetze()).then((r) => aktiv && setListe(r?.energieeinsaetze ?? null));
    return () => {
      aktiv = false;
    };
  }, [versuch]);

  // Beim Blättern bleibt der bisherige Stand gedimmt stehen, bis der neue da ist — nichts springt auf Skelette zurück.
  // Gezeigt wird immer ein in sich stimmiger Stand: Zahlen und Wörter aus demselben Abruf und seinem Zeitraum.
  const aktuell = daten;
  const laedt = daten !== null && daten.schluessel !== schluessel;
  const z = aktuell?.zeitraum ?? zeitraum;
  const verlaufBildHier: VerlaufBild | null = useMemo(() => {
    if (!aktuell) return null;
    if (aktuell.zeitraum.art === 'zwoelf') return verlaufBild(aktuell.rangliste, aktuell.vorjahr, aktuell.zeitraum.bis);
    return verlauf && verlauf.schluessel === aktuell.schluessel ? verlauf.bild : null;
  }, [aktuell, verlauf]);
  const bild: VerbrauchBild | null = useMemo(
    () =>
      aktuell
        ? verbrauchBild({
            zeitraum: aktuell.zeitraum,
            rangliste: aktuell.rangliste,
            vorjahr: aktuell.vorjahr,
            abdeckung: aktuell.abdeckung,
            einstufungen,
            messbedarfe,
            verlauf: aktuell.zeitraum.art === 'zwoelf' ? verlaufBildHier : null,
          })
        : null,
    [aktuell, einstufungen, messbedarfe, verlaufBildHier],
  );

  const stromEinsaetze = (liste ?? []).filter((e) => laeuft(e) && e.traeger === 'Strom');
  const menue: RowMenuItem[] = [
    ...(verwalten && liste ? [{ label: 'Energieeinsatz anlegen', icon: 'plus' as const, onClick: () => setDialog('anlegen') }] : []),
    ...(aktuell
      ? [{
          label: 'Als CSV',
          icon: 'file-text' as const,
          onClick: () => ladeCsv(verbrauchCsv(aktuell.rangliste), `verbrauch-${aktuell.rangliste.von}-${aktuell.rangliste.bis}.csv`),
        }]
      : []),
  ];

  const zeitleiste = (
    <div className="vp-vb-zeitleiste" role="group" aria-label="Zeitraum">
      <ZeitSegment label="Zeitraum" optionen={VERBRAUCH_ARTEN} wert={zeitraum.art} onWert={(art) => setZeitraum({ art, bis: zeitraum.bis })} />
      <div className="vp-vb-blaetterer">
        <button type="button" className="vp-vb-schritt" aria-label={zeitraum.art === 'monat' ? 'Vormonat' : 'Die zwölf Monate davor'} onClick={() => setZeitraum(blaettern(zeitraum, -1, letzter))}>
          <Icon name="chevron-left" size={18} />
        </button>
        <span className="vp-vb-zeitraum" aria-live="polite" data-testid="verbrauch-zeitraum">
          {zeitraumKurz(zeitraum)}
        </span>
        <button
          type="button"
          className="vp-vb-schritt"
          aria-label={zeitraum.art === 'monat' ? 'Nächster Monat' : 'Die zwölf Monate danach'}
          disabled={!kannVor(zeitraum, letzter)}
          onClick={() => setZeitraum(blaettern(zeitraum, 1, letzter))}
        >
          <Icon name="chevron-right" size={18} />
        </button>
      </div>
    </div>
  );

  const beispiel = bild && bild.bereiche.length > 0 ? (
    <>
      Bei Ihnen zum Beispiel{' '}
      {bild.bereiche.slice(0, 3).map((b, i, a) => (
        <Fragment key={b.id}>
          {i > 0 && (i === a.length - 1 ? ' und ' : ', ')}
          <b>{b.name}</b>
        </Fragment>
      ))}
      .
    </>
  ) : undefined;
  const aufklapper = <BegriffAufklapper begriff="energieeinsatz" beispiel={beispiel} mehr="Im Portal heißt ein Energieeinsatz kurz „Bereich“." />;

  return (
    <div className="vp-vb" data-testid="verbrauch">
      <header className="vp-vb-kopf">
        <div className="vp-vb-kopf-text">
          <h1>{VERBRAUCH_TITEL}</h1>
          <p className="vp-vb-meta">{VERBRAUCH_UNTERZEILE}</p>
        </div>
        {!phone && zeitleiste}
        {menue.length > 0 && (
          <span className="vp-vb-menue" data-testid="verbrauch-menue">
            <RowMenu items={menue} label="Weitere Aktionen" buttonClassName="vp-vb-menue-knopf" />
          </span>
        )}
      </header>
      {phone && aufklapper}
      {phone && zeitleiste}

      {fehler ? (
        fehler.erneut ? (
          <ErrorState message={fehler.satz} onRetry={() => setVersuch((v) => v + 1)} />
        ) : (
          <p className="vp-vb-hinweis-satz" role="status">
            {fehler.satz}
          </p>
        )
      ) : !bild ? (
        <div className="vp-vb-laden" aria-busy="true" data-testid="verbrauch-laden">
          <Skeleton height={48} />
          <Skeleton height={150} />
          <Skeleton height={320} />
        </div>
      ) : bild.leer ? (
        <section className="vp-vb-karte vp-vb-leer" data-testid="verbrauch-leer">
          <p>{VERBRAUCH_LEER}</p>
          {verwalten && liste && (
            <Button iconLeft={<Icon name="plus" size={16} />} onClick={() => setDialog('anlegen')}>
              Energieeinsatz anlegen
            </Button>
          )}
          {!phone && aufklapper}
        </section>
      ) : (
        <div className={`vp-vb-inhalt${laedt ? ' is-laedt' : ''}`} aria-busy={laedt} data-testid="verbrauch-inhalt">
          <div className="vp-vb-antwort" data-testid="verbrauch-antwort">
            {bild.antwort && <p className="vp-vb-satz">{phone ? bild.antwort : (bild.antwortBreit ?? bild.antwort)}</p>}
            <div className="vp-vb-formal-zeile">
              <p className="vp-vb-formal">{bild.untertitel}</p>
              {!phone && aufklapper}
            </div>
          </div>

          {bild.hinweise.map((h) => (
            <HinweisZeile key={h.satz} hinweis={h} onNavigate={onNavigate} />
          ))}

          <div className="vp-vb-raster">
            {(!phone || z.art === 'monat') && <StromKachel bild={bild} />}
            {(!phone || z.art === 'zwoelf') &&
              (verlaufBildHier ? (
                <VerbrauchVerlauf
                  key={`${schluesselVon(z)}-${phone}`}
                  bild={verlaufBildHier}
                  antwort={`Strom je Monat, ${zeitraumLang({ art: 'zwoelf', bis: z.bis })}`}
                  rechts={phone ? 'kWh' : zeitraumLang({ art: 'zwoelf', bis: z.bis })}
                  gewaehlt={z.bis}
                  tippHinweis={phone}
                />
              ) : (
                <div className="vp-vb-f-verlauf-platz" aria-busy="true">
                  <Skeleton height={260} />
                </div>
              ))}
            <BereicheKarte
              bild={bild}
              phone={phone}
              onOeffnen={onOeffnen}
              onRest={verwalten && stromEinsaetze.length > 0 ? setRest : undefined}
              onEnergiebilanz={(id) => onNavigate(anlageRoute(id, 'energiebilanz'))}
            />
            {bild.weitere.length > 0 && (
              <div className="vp-vb-weitere">
                {bild.weitere.map((k) => (
                  <section key={k.traeger} className="vp-vb-karte" aria-label={k.traeger} data-testid={`verbrauch-traeger-${k.traeger}`}>
                    <div className="vp-vb-blockkopf">
                      <h2>{k.traeger}</h2>
                      <span className="vp-vb-m">{bereicheZahl(k.zeilen.length)}</span>
                    </div>
                    <div className="vp-vb-weitere-liste">
                      {k.zeilen.map((z) => (
                        <div key={z.id} className="vp-vb-weiter">
                          <button type="button" className="vp-vb-weiter-ziel" onClick={() => onOeffnen(z.id)}>
                            <span className="vp-vb-nm">{z.name}</span>
                            <span className="vp-vb-v">
                              {z.wert ?? '–'}
                              <span className="vp-vb-chev" aria-hidden="true">
                                <Icon name="chevron-right" size={16} />
                              </span>
                            </span>
                          </button>
                          {z.satz && <p className="vp-vb-sub">{z.satz}</p>}
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
          <Fuss rangliste={aktuell!.rangliste} />
        </div>
      )}
      {/* Der Grenz-Satz einmal am Fuß der Fläche (Konzept a1 §6.11), aufklappbar wie in jedem Bereich (K7). */}
      <div className="vp-vb-grenze">
        <GrenzHinweis />
      </div>

      {dialog === 'anlegen' && liste && (
        <EnergieeinsatzAnlegenDialog
          einsaetze={liste}
          onClose={() => setDialog(null)}
          onAngelegt={(e) => {
            setDialog(null);
            setListe((l) => [...(l ?? []), e]);
            onOeffnen(e.id);
          }}
        />
      )}
      {rest && (
        <MessbedarfErfassenDialog
          einsaetze={stromEinsaetze}
          rest={rest}
          onClose={() => setRest(null)}
          onErfasst={(b) => {
            setRest(null);
            setMessbedarfe((alt) => [...(alt ?? []), b]);
          }}
        />
      )}
    </div>
  );
}

/** Kennzeichen (AZ-3, MS-20) brechen nie am Bindestrich. */
function MitKennzeichen({ text }: { text: string }): ReactNode {
  const teile = text.split(/([A-ZÄÖÜ]{1,4}-\d+)/);
  return teile.map((t, i) => (i % 2 === 1 ? <span key={i} className="vp-vb-kz">{t}</span> : t));
}

function Unterzeile({ teile }: { teile: readonly Teil[] }) {
  return (
    <>
      {teile.map((t, i) => (
        <Fragment key={t.text}>
          {i > 0 && ' · '}
          {t.fest ? <span className="vp-vb-fest">{t.text}</span> : <MitKennzeichen text={t.text} />}
        </Fragment>
      ))}
    </>
  );
}

function StromKachel({ bild }: { bild: VerbrauchBild }) {
  const k = bild.kachel;
  return (
    <div className="vp-vb-kachel">
      <Kachel id="verbrauch-strom" name={k.titel} icon="pole" ton="load" className="is-lead">
        {k.wert === null ? <Gross wert="–" /> : <Gross wert={k.wert} einheit="kWh" xl />}
        {(k.vorjahr || k.zugeordnet) && (
          <span className="vp-vb-marken">
            {k.vorjahr && <Marke>{k.vorjahr.text}</Marke>}
            {k.zugeordnet && <Marke art={k.zugeordnet.ton}>{k.zugeordnet.text}</Marke>}
          </span>
        )}
        <p className="vp-k-sub">
          <MitKennzeichen text={k.unterzeile} />
        </p>
      </Kachel>
    </div>
  );
}

function BereicheKarte({
  bild,
  phone,
  onOeffnen,
  onRest,
  onEnergiebilanz,
}: {
  bild: VerbrauchBild;
  phone: boolean;
  onOeffnen: (id: string) => void;
  onRest?: (ort: BewertungMessabdeckungOrt) => void;
  onEnergiebilanz: (anlageId: string) => void;
}) {
  const z = bild.zeitraum;
  const m = phone
    ? z.art === 'monat'
      ? bereicheZahl(bild.bereiche.length)
      : '12 Monate'
    : `${bereicheZahl(bild.bereiche.length)} · ${z.art === 'monat' ? zeitraumKurz(z) : '12 Monate'}`;
  const r = bild.rest;
  return (
    <section className="vp-vb-karte vp-vb-liste" aria-labelledby="vp-vb-liste-titel" data-testid="verbrauch-bereiche">
      <div className="vp-vb-blockkopf">
        <h2 id="vp-vb-liste-titel">{VERBRAUCH_LISTE_TITEL}</h2>
        <span className="vp-vb-m">{m}</span>
      </div>
      <div className="vp-vb-reihen">
        {bild.bereiche.map((b) => (
          <BereichReihe key={b.id} b={b} onOeffnen={onOeffnen} />
        ))}
        {r && (
          <div className="vp-vb-reihe is-rest" data-testid="verbrauch-rest">
            {r.ort?.id ? (
              <button type="button" className="vp-vb-reihe-ziel" onClick={() => onEnergiebilanz(r.ort!.id!)}>
                <RestKopf menge={r.mengeText} anteil={r.anteil} balken={r.balken} chevron />
              </button>
            ) : (
              <div className="vp-vb-reihe-ziel">
                <RestKopf menge={r.mengeText} anteil={r.anteil} balken={r.balken} chevron={false} />
              </div>
            )}
            <p className="vp-vb-sub">
              <MitKennzeichen text={r.satz} />
              {onRest && r.ort && (
                <>
                  {' · '}
                  <button type="button" className="vp-vb-weg" onClick={() => onRest(r.ort!)} data-testid="verbrauch-zaehler-planen">
                    {ZAEHLER_PLANEN}
                  </button>
                </>
              )}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function RestKopf({ menge, anteil, balken, chevron }: { menge: string; anteil: string | null; balken: number; chevron: boolean }) {
  return (
    <>
      <span className="vp-vb-nm">{REST_NAME}</span>
      <span className="vp-vb-v">
        {menge}
        <small>kWh</small>
        {chevron && (
          <span className="vp-vb-chev" aria-hidden="true">
            <Icon name="chevron-right" size={16} />
          </span>
        )}
        {chevron && <span className="vp-vb-nurvorleser"> – Energiebilanz der Anlage öffnen</span>}
      </span>
      <span className="vp-vb-spur">
        <span className="vp-vb-t">
          <i style={{ width: `${balken}%` }} />
        </span>
        <span className="vp-vb-p">{anteil ?? ''}</span>
      </span>
    </>
  );
}

function BereichReihe({ b, onOeffnen }: { b: BereichZeile; onOeffnen: (id: string) => void }) {
  return (
    <div className="vp-vb-reihe" data-testid={`verbrauch-reihe-${b.kennzeichen}`}>
      {/* Kein eigener Name: Vorleser lesen die Reihe selbst — Bereich, Menge und Anteil. */}
      <button type="button" className="vp-vb-reihe-ziel" onClick={() => onOeffnen(b.id)}>
        <span className="vp-vb-nm">
          <span className="vp-vb-name">{b.name}</span>
          {b.wesentlich === true && <span className="vp-vb-wesentlich">{WESENTLICH}</span>}
          {b.marke && <span className="vp-k-marke is-warn">{b.marke}</span>}
        </span>
        <span className="vp-vb-v">
          {b.mengeText ?? '–'}
          {b.mengeText !== null && <small>{b.einheit}</small>}
          <span className="vp-vb-chev" aria-hidden="true">
            <Icon name="chevron-right" size={16} />
          </span>
        </span>
        {b.balken !== null && (
          <span className="vp-vb-spur">
            <span className="vp-vb-t">
              <i style={{ width: `${b.balken}%` }} />
            </span>
            <span className="vp-vb-p">{b.anteil ?? ''}</span>
          </span>
        )}
      </button>
      {b.unterzeile.length > 0 && (
        <p className="vp-vb-sub">
          <Unterzeile teile={b.unterzeile} />
        </p>
      )}
    </div>
  );
}

function HinweisZeile({ hinweis, onNavigate }: { hinweis: Hinweis; onNavigate: (ziel: Route) => void }) {
  const weg = hinweis.weg;
  return (
    <p className={`vp-vb-vertrauen is-${hinweis.ton}`} role="status" data-testid="verbrauch-hinweis">
      <span className="vp-vb-vi" aria-hidden="true">
        <Icon name={hinweis.ton === 'warn' ? 'alert-triangle' : 'info'} size={16} />
      </span>
      <span className="vp-vb-vt">
        <MitKennzeichen text={hinweis.satz} />
        {weg && (
          <>
            {' '}
            <button
              type="button"
              className="vp-vb-weg"
              onClick={() => onNavigate(weg.messstelle ? messstelleRoute(weg.messstelle) : pageRoute('portfolio-messstellen'))}
            >
              {weg.text}
            </button>
          </>
        )}
      </span>
    </p>
  );
}

/** Der Fuß: wann gelesen, und die Zeitzone einmal — nicht als Kopfzeile (Messen m1, Entscheid 6). */
function Fuss({ rangliste }: { rangliste: BewertungRangliste }) {
  const zone = [...rangliste.einsaetze, ...rangliste.weitere_traeger]
    .flatMap((e) => e.messstellen)
    .map((m) => m.monatswerte?.zeitzone)
    .find((z): z is string => !!z);
  const heute = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return (
    <p className="vp-vb-fuss" data-testid="verbrauch-fuss">
      Stand {heute}
      {zone && ` · Zeiten: ${zone}`}
    </p>
  );
}
