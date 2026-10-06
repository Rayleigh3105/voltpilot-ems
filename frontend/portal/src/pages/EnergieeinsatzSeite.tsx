import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  ApiError,
  type BewertungMessabdeckung,
  type BewertungRangliste,
  type BewertungRanglisteEinsatz,
  type Energieeinsatz,
  type EnergieeinsatzAenderung,
  type EnergieeinsatzEinstufungFassung,
} from '../api';
import {
  ablehnung,
  BEENDEN_KNOPF,
  darfEinstufen,
  darfVerwalten,
  einflussText,
  KEINE_EINFLUSSGROESSEN,
  KEINE_MESSSTELLEN,
  KEINE_WERTE_SATZ,
  laeuft,
  messstelleOrt,
  protokollZeile,
  prozessText,
  verantwortlichText,
} from '../bewertung';
import {
  einsatzAntwort,
  einsatzStatus,
  einsatzVerbrauch,
  einstufungVon,
  geltendeEinstufung,
  kriterienInWorten,
  monatKurzJahr,
  zaehlerZeilen,
  type EinsatzVerbrauch,
} from '../einsatzSeite';
import { EinstufungDialog, EinstufungHistorie } from '../components/BewertungEntscheidungen';
import { EnergieeinsatzBearbeitenDialog, EnergieeinsatzBeendenDialog } from '../components/EnergieeinsatzDialoge';
import { EinsatzMessmittel, istWesentlich } from '../components/EinsatzMessmittel';
import { GrenzHinweis, GrenzSatzBereich } from '../components/GrenzSatz';
import { Gross, Kachel, Marke } from '../components/kacheln/Kachel';
import { MassnahmeAnlegen } from '../components/MassnahmeDialoge';
import { MessbedarfKarte } from '../components/Messplanung';
import { NachweiseAmEinsatz } from '../components/Nachweise';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { ErrorState, Skeleton } from '../components/States';
import { messstelleRoute, type Route } from '../nav';
import { useRollen } from '../rollen';
import { useBewertungZeitraum } from '../useBewertungZeitraum';
import { grenzen, letzterVollerMonat, monatWort, VERBRAUCH_TITEL, vorjahrVon } from '../verbrauch';
// Die Karten der Bewertung (Messplanung, Einstufungs-Historie, Dialoge) tragen ihre Klassen aus `BewertungPage.css`.
import './BewertungPage.css';
import './VerbrauchPage.css';
import './EnergieeinsatzSeite.css';

/**
 * Die Seite eines Energieeinsatzes (UEMS AP-16 IP-6; Konzept Auswerten a1 §6.8, Entscheid 10.1: unter „Verbrauch“,
 * `#/portfolio/verbrauch/{id}`). Was braucht der Bereich, und warum ist er wesentlich? Zuerst der Antwortsatz mit dem
 * Verbrauch des letzten vollen Monats, dann die Kachel mit zwölf Monaten Verlauf, die Zähler mit ihrer Monatsmenge
 * (`letzter_monat`), die Gründe der Einstufung in Worten und darunter, was den Verbrauch treibt, Messbedarf, Messmittel,
 * Nachweise und „Verbessern“. Werkzeuge — Bearbeiten, Änderungsprotokoll, Beenden — liegen im Menü ⋯.
 *
 * „Keine Werte“ ist die Aussage der Route, nie eine Null. Die Kriterien der Einstufung gelten für die Datengrundlage
 * der Bewertung (Konzept a1, Befund 2), der Verbrauch für den letzten vollen Monat.
 */
const freigegebeneFassung = (fassungen: readonly EnergieeinsatzEinstufungFassung[]) =>
  fassungen.filter((f) => f.freigabe_status === 'freigegeben').reduce<number | undefined>((n, f) => (n === undefined || f.fassung > n ? f.fassung : n), undefined);

const oderNull = <T,>(p: Promise<T>): Promise<T | null> => p.then((x) => x, () => null);

interface Verbrauchsdaten {
  imMonat: BewertungRangliste | null;
  vorjahr: BewertungRangliste | null;
  zwoelf: BewertungRangliste | null;
  abdeckung: BewertungMessabdeckung | null;
}

export function EnergieeinsatzSeite({ id, onListe, onNavigate }: { id: string; onListe: () => void; onNavigate?: (ziel: Route) => void }) {
  const { selbst } = useRollen();
  const verwalten = darfVerwalten(selbst);
  const einstufen = darfEinstufen(selbst);
  // Konzept Auswerten a1, Befund 2: dieselbe Datengrundlage wie die Bewertung, nie ein einzelner Monat.
  const { bereit, zeitraum } = useBewertungZeitraum();
  const monat = useMemo(() => letzterVollerMonat(), []);
  const [einsatz, setEinsatz] = useState<Energieeinsatz | null>(null);
  const [protokoll, setProtokoll] = useState<EnergieeinsatzAenderung[] | null>(null);
  const [grundlage, setGrundlage] = useState<BewertungRangliste | null>(null);
  const [einstufungen, setEinstufungen] = useState<EnergieeinsatzEinstufungFassung[]>([]);
  const [verbrauch, setVerbrauch] = useState<Verbrauchsdaten | null>(null);
  const [fehler, setFehler] = useState<{ satz: string; erneut: boolean } | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [dialog, setDialog] = useState<'bearbeiten' | 'beenden' | 'einstufen' | 'protokoll' | null>(null);

  useEffect(() => {
    if (!bereit) return;
    let aktiv = true;
    setFehler(null);
    Promise.all([
      api.energieeinsatz(id),
      oderNull(api.energieeinsatzProtokoll(id)),
      oderNull(api.bewertungRangliste(zeitraum.von, zeitraum.bis)),
      api.energieeinsatzEinstufungen(id),
    ]).then(
      ([e, p, r, h]) => {
        if (!aktiv) return;
        setEinsatz(e);
        setProtokoll(p?.aenderungen ?? null);
        setGrundlage(r);
        setEinstufungen(h.fassungen);
      },
      (e) => aktiv && setFehler({ satz: ablehnung(e), erneut: !(e instanceof ApiError && (e.status === 404 || e.status === 403)) }),
    );
    return () => {
      aktiv = false;
    };
  }, [bereit, id, versuch, zeitraum.bis, zeitraum.von]);

  // Der Verbrauch: der letzte volle Monat, derselbe Monat ein Jahr früher und die zwölf Monate bis zu ihm.
  useEffect(() => {
    let aktiv = true;
    const m = grenzen({ art: 'monat', bis: monat });
    const vj = grenzen(vorjahrVon({ art: 'monat', bis: monat }));
    const z = grenzen({ art: 'zwoelf', bis: monat });
    Promise.all([
      oderNull(api.bewertungRangliste(m.von, m.bis)),
      oderNull(api.bewertungRangliste(vj.von, vj.bis)),
      oderNull(api.bewertungRangliste(z.von, z.bis)),
      oderNull(api.bewertungMessabdeckung(m.von, m.bis)),
    ]).then(([imMonat, vorjahr, zwoelf, abdeckung]) => aktiv && setVerbrauch({ imMonat, vorjahr, zwoelf, abdeckung }));
    return () => {
      aktiv = false;
    };
  }, [monat, versuch]);

  const neu = (e: Energieeinsatz) => {
    setEinsatz(e);
    setDialog(null);
    setVersuch((v) => v + 1);
  };

  const rang: BewertungRanglisteEinsatz | null = grundlage ? [...grundlage.einsaetze, ...grundlage.weitere_traeger].find((x) => x.id === id) ?? null : null;
  const gilt = geltendeEinstufung(einstufungen);
  const offen = einstufungen.some((f) => f.freigabe_status === 'beantragt');
  const v: EinsatzVerbrauch | null = verbrauch ? einsatzVerbrauch(id, monat, verbrauch.imMonat, verbrauch.vorjahr, verbrauch.zwoelf) : null;
  const orte = new Map(
    (verbrauch?.abdeckung?.je_einsatz.find((x) => x.id === id)?.gemessen ?? []).map((m) => [m.id, m.ort?.replace(/^[A-ZÄÖÜ]{1,4}-\d+\s+/, '') ?? null]),
  );

  const menue: RowMenuItem[] = einsatz
    ? [
        ...(verwalten && laeuft(einsatz) ? [{ label: 'Bearbeiten', icon: 'pencil' as const, onClick: () => setDialog('bearbeiten') }] : []),
        { label: 'Änderungsprotokoll', icon: 'history' as const, onClick: () => setDialog('protokoll') },
        ...(verwalten && laeuft(einsatz) ? [{ label: BEENDEN_KNOPF, icon: 'x' as const, danger: true, onClick: () => setDialog('beenden') }] : []),
      ]
    : [];

  return (
    <GrenzSatzBereich>
      <div className="vp-vb vp-bw vp-ee" data-testid="einsatz-seite">
        <button type="button" className="vp-ee-zurueck" onClick={onListe}>
          <Icon name="chevron-left" size={16} />
          {VERBRAUCH_TITEL}
        </button>
        {fehler ? (
          fehler.erneut ? (
            <ErrorState message={fehler.satz} onRetry={() => setVersuch((x) => x + 1)} />
          ) : (
            <p className="vp-vb-hinweis-satz" role="status">
              {fehler.satz}
            </p>
          )
        ) : !einsatz ? (
          <div className="vp-vb-laden" aria-busy="true">
            <Skeleton height={64} />
            <Skeleton height={160} />
          </div>
        ) : (
          <>
            <header className="vp-vb-kopf vp-ee-kopf">
              <div className="vp-vb-kopf-text">
                <div className="vp-ee-titel">
                  <h1>{einsatz.name}</h1>
                  <span className="vp-ee-kz">{einsatz.kennzeichen}</span>
                </div>
                <p className="vp-vb-meta" data-testid="einsatz-unterzeile">
                  {einsatz.traeger} · <span data-testid="einsatz-prozess">Prozess {einsatz.prozess.name}</span>
                  {einsatz.verantwortlich?.name && (
                    <>
                      {' '}· verantwortlich <span data-testid="einsatz-verantwortlich">{einsatz.verantwortlich.name}</span>
                    </>
                  )}
                </p>
              </div>
              <span className="vp-vb-menue" data-testid="einsatz-menue">
                <RowMenu items={menue} label="Weitere Aktionen" buttonClassName="vp-vb-menue-knopf" />
              </span>
            </header>
            <Status einsatz={einsatz} gilt={gilt} />

            {v && (
              <div className="vp-vb-antwort" data-testid="einsatz-antwort">
                <p className="vp-vb-satz">{einsatzAntwort(einsatz, v)}</p>
                <p className="vp-vb-formal">{gemessenVon(einsatz)}</p>
              </div>
            )}

            <div className="vp-ee-raster">
              <div className="vp-ee-spalte">
                {v ? <VerbrauchKachel v={v} /> : <Skeleton height={190} />}
                <section className="vp-vb-karte" aria-labelledby="ee-gemessen" data-testid="einsatz-messstellen">
                  <div className="vp-vb-blockkopf">
                    <h2 id="ee-gemessen">Gemessen von</h2>
                  </div>
                  {einsatz.keine_werte && <p className="vp-vb-sub">{KEINE_WERTE_SATZ}</p>}
                  {einsatz.messstellen.length === 0 ? (
                    <p className="vp-vb-sub">{KEINE_MESSSTELLEN}</p>
                  ) : (
                    <ul className="vp-ee-zaehler">
                      {zaehlerZeilen(einsatz, (m) => orte.get(m.id) ?? messstelleOrt(m)).map((z) => (
                        <li key={z.id}>
                          <button
                            type="button"
                            className="vp-ee-zaehler-ziel"
                            onClick={() => onNavigate?.(messstelleRoute(z.id))}
                            disabled={!onNavigate}
                          >
                            <span className="vp-ee-zaehler-nm">
                              <i className={`vp-ee-punkt is-${z.ton}`} aria-hidden="true" />
                              <b>{z.name}</b>
                              <span className="vp-ee-kz">{z.kennzeichen}</span>
                            </span>
                            <span className="vp-ee-zaehler-w">
                              {z.wert ? (
                                <>
                                  <b>{z.wert}</b>
                                  <small>{z.monat}</small>
                                </>
                              ) : (
                                <small>keine Werte</small>
                              )}
                            </span>
                            <span className="vp-vb-chev" aria-hidden="true">
                              <Icon name="chevron-right" size={16} />
                            </span>
                            <span className="vp-ee-zaehler-sub">
                              {[z.ort, z.zustand].filter(Boolean).join(' · ')}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
              <div className="vp-ee-spalte">
                <Warum
                  einsatz={einsatz}
                  gilt={gilt}
                  grundlage={grundlage}
                  rang={rang}
                  zeitraumText={zeitraum.label}
                  onEinstufen={einstufen && rang && laeuft(einsatz) ? () => setDialog('einstufen') : undefined}
                />
                {offen && (
                  <EinstufungHistorie
                    einsatzId={id}
                    fassungen={einstufungen}
                    darfBestaetigen={einstufen}
                    onBestaetigt={(f) => setEinstufungen((alt) => alt.map((x) => (x.fassung === f.fassung ? f : x)))}
                  />
                )}
                <section className="vp-vb-karte" aria-labelledby="ee-treibt">
                  <div className="vp-vb-blockkopf">
                    <h2 id="ee-treibt">Was den Verbrauch treibt</h2>
                  </div>
                  {einsatz.einflussgroessen.length === 0 ? (
                    <p className="vp-vb-sub">{KEINE_EINFLUSSGROESSEN}</p>
                  ) : (
                    <ul className="vp-ee-liste" data-testid="einsatz-einfluesse-liste">
                      {einsatz.einflussgroessen.map((e, i) => (
                        <li key={i}>{einflussText(e)}</li>
                      ))}
                    </ul>
                  )}
                  {einsatz.verbraucher_wortlaut && <p className="vp-vb-sub">Verbraucher: {einsatz.verbraucher_wortlaut}</p>}
                </section>
              </div>
            </div>

            {/* AP-16 IP-20 (§5.3, R5): Messbedarf erfassen, einlösen (Sprung in den Messstellen-Dialog), verwerfen. */}
            <MessbedarfKarte einsatz={einsatz} verwalten={verwalten} />

            <EinsatzMessmittel einsatz={`${einsatz.kennzeichen} ${einsatz.name}`} messstellen={einsatz.messstellen} wesentlich={istWesentlich(einstufungen)} />

            {/* AP-19 IP-15 (§5.3, R7): die Dokumente am Einsatz — Betrieb und Instandhaltung, Auslegung, Beschaffung — mit Ort
                und Überprüfung; „Nachweis festhalten“ mit vorbelegtem Bezug. Nur mit `energiemanagement.ansehen`. */}
            <NachweiseAmEinsatz einsatz={einsatz} />

            {/* UEMS AP-18 IP-13 (§5.4): „Maßnahme anlegen“ am Energieeinsatz — Herkunft `einsatz` mit der freigegebenen
                Einstufungs-Fassung; ohne Kennzahl öffnet der Dialog auf „ohne Messgrundlage“ (E2 = A). */}
            {laeuft(einsatz) && (
              <section className="vp-vb-karte" aria-labelledby="ee-verbessern">
                <div className="vp-vb-blockkopf">
                  <h2 id="ee-verbessern">Verbessern</h2>
                </div>
                <MassnahmeAnlegen
                  vorbelegung={{ herkunft: 'einsatz', einsatz: einsatz.id, einstufungFassung: freigegebeneFassung(einstufungen) }}
                  standort={null}
                />
              </section>
            )}

            {/* Grenz- und Verantwortungs-Satz einmal je Bereich (K7), hier am Fuß (Konzept a1 §6.11). */}
            <div className="vp-vb-grenze">
              <GrenzHinweis />
            </div>
          </>
        )}

        {dialog === 'bearbeiten' && einsatz && (
          <EnergieeinsatzBearbeitenDialog einsatz={einsatz} onClose={() => setDialog(null)} onGespeichert={neu} />
        )}
        {dialog === 'beenden' && einsatz && (
          <EnergieeinsatzBeendenDialog einsatz={einsatz} onClose={() => setDialog(null)} onBeendet={neu} />
        )}
        {dialog === 'einstufen' && rang && (
          <EinstufungDialog
            einsatz={rang}
            onClose={() => setDialog(null)}
            onGespeichert={(f) => {
              setEinstufungen((alt) => [f, ...alt]);
              setDialog(null);
            }}
          />
        )}
        {dialog === 'protokoll' && einsatz && (
          <Modal open onClose={() => setDialog(null)} title={`Änderungsprotokoll · ${einsatz.name}`}>
            <div className="vp-ee-protokoll">
              <p className="vp-vb-sub">
                {prozessText(einsatz.prozess)} · verantwortlich {verantwortlichText(einsatz.verantwortlich)}
              </p>
              {protokoll === null ? (
                <p className="vp-vb-sub">Das Protokoll ließ sich gerade nicht laden.</p>
              ) : protokoll.length === 0 ? (
                <p className="vp-vb-sub">Noch keine Änderung seit dem Anlegen.</p>
              ) : (
                <ol className="vp-ee-liste" data-testid="einsatz-protokoll">
                  {[...protokoll].reverse().map((a) => (
                    <li key={a.id}>{protokollZeile(a)}</li>
                  ))}
                </ol>
              )}
              {einstufungen.length > 0 && (
                <EinstufungHistorie einsatzId={id} fassungen={einstufungen} darfBestaetigen={false} />
              )}
            </div>
          </Modal>
        )}
      </div>
    </GrenzSatzBereich>
  );
}

/** „gemessen vom Zähler Spritzguss (MS-20)“ — Namen zuerst, Kennzeichen dahinter. */
function gemessenVon(e: Energieeinsatz): string {
  if (e.messstellen.length === 0) return 'noch ohne Zähler';
  if (e.messstellen.length === 1) return `gemessen vom Zähler ${e.messstellen[0].name} (${e.messstellen[0].kennzeichen})`;
  return `gemessen von ${e.messstellen.length} Zählern`;
}

function Status({ einsatz, gilt }: { einsatz: Energieeinsatz; gilt: EnergieeinsatzEinstufungFassung | null }) {
  const s = einsatzStatus(einsatz, gilt);
  return (
    <p className={`vp-ee-status is-${s.ton}`} data-testid="einsatz-zustand">
      <i aria-hidden="true" />
      <b>{s.text}</b>
      {s.seit && <span>{s.seit}</span>}
    </p>
  );
}

function VerbrauchKachel({ v }: { v: EinsatzVerbrauch }) {
  const werte = (v.verlauf ?? []).map((x) => x.wert).filter((x): x is number => x !== null);
  const max = Math.max(0, ...werte);
  const min = Math.min(...werte);
  const spanne = max - min || 1;
  const n = v.verlauf?.length ?? 0;
  const punkte =
    v.verlauf && werte.length > 1
      ? v.verlauf
          .map((x, i) => (x.wert === null ? null : `${((i / Math.max(1, n - 1)) * 100).toFixed(2)},${(36 - ((x.wert - min) / spanne) * 30).toFixed(2)}`))
          .filter(Boolean)
          .join(' ')
      : null;
  const letzter = v.verlauf ? (v.verlauf[v.verlauf.length - 1]?.wert ?? null) : null;
  return (
    <div className="vp-vb-kachel">
      <Kachel id="einsatz-verbrauch" name={`Verbrauch · ${monatWort(v.monat)}`} icon="pole" ton="load" className="is-lead">
        {v.menge === null ? <Gross wert="–" /> : <Gross wert={v.menge.toLocaleString('de-DE', { maximumFractionDigits: 0 })} einheit="kWh" xl />}
        {(v.vorjahr || v.anteil !== null) && (
          <span className="vp-ee-marken">
            {v.vorjahr && <Marke>{v.vorjahr.text}</Marke>}
            {v.anteil !== null && <Marke>{`${Math.round(v.anteil).toLocaleString('de-DE')}\u00a0% des Stroms`}</Marke>}
          </span>
        )}
        {punkte && v.verlauf && (
          <div className="vp-ee-spark" role="img" aria-label={`Verbrauch je Monat, ${monatWort(v.verlauf[0].monat)} bis ${monatWort(v.monat)}`}>
            <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
              <polyline points={punkte} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
            {letzter !== null && <i className="vp-ee-spark-ende" style={{ bottom: `${(((letzter - min) / spanne) * 30 + 4) / 40 * 100}%` }} />}
            <span className="vp-ee-spark-achse">
              <span>{monatKurzJahr(v.verlauf[0].monat)}</span>
              <span>{monatKurzJahr(v.monat)}</span>
            </span>
          </div>
        )}
      </Kachel>
    </div>
  );
}

function Warum({
  einsatz,
  gilt,
  grundlage,
  rang,
  zeitraumText,
  onEinstufen,
}: {
  einsatz: Energieeinsatz;
  gilt: EnergieeinsatzEinstufungFassung | null;
  grundlage: BewertungRangliste | null;
  rang: BewertungRanglisteEinsatz | null;
  zeitraumText: string;
  onEinstufen?: () => void;
}) {
  const kriterien = kriterienInWorten(grundlage, rang);
  const titel = !gilt ? 'Einstufung' : gilt.einstufung === 'wesentlich' ? 'Warum wesentlich' : 'Warum nicht wesentlich';
  return (
    <section className="vp-vb-karte" aria-labelledby="ee-warum" data-testid="einsatz-warum">
      <div className="vp-vb-blockkopf">
        <h2 id="ee-warum">{titel}</h2>
        {onEinstufen && (
          <button type="button" className="vp-vb-weg" onClick={onEinstufen} data-testid="einsatz-einstufen-knopf">
            {gilt ? 'Einstufung ändern' : 'Einstufen'}
          </button>
        )}
      </div>
      {einsatz.traeger === 'Strom' &&
        (kriterien ? (
          <ul className="vp-ee-krit">
            {kriterien.map((k) => (
              <li key={k.text} className={k.erfuellt ? undefined : 'is-nein'}>
                <span className="vp-ee-ki" aria-hidden="true">
                  <Icon name={k.erfuellt ? 'check' : 'x'} size={15} />
                </span>
                <span>
                  {k.text}
                  <span className="vp-ee-nurvorleser">{k.erfuellt ? ' (erfüllt)' : ' (nicht erfüllt)'}</span>
                  {k.schwelle && <small>{k.schwelle}</small>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="vp-vb-sub">
            Für die Datengrundlage der Bewertung ({zeitraumText}) liegen für diesen Bereich noch keine Werte vor – die Gründe lassen sich erst mit
            Werten prüfen.
          </p>
        ))}
      <p className="vp-vb-sub">VoltPilot schlägt vor, entscheiden tut eine Person.</p>
      {gilt ? (
        <blockquote className="vp-ee-zitat">
          „{gilt.begruendung}“
          <small>{einstufungVon(gilt)}</small>
        </blockquote>
      ) : (
        <p className="vp-vb-sub">Noch nicht eingestuft.</p>
      )}
    </section>
  );
}

