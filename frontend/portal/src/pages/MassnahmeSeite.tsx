import { useEffect, useState } from 'react';
import { GrenzHinweis, GrenzSatz, GrenzSatzBereich } from '../components/GrenzSatz';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Massnahme, type MassnahmeEintrag, type MassnahmeHerkunft, type VorgangAnstoss } from '../api';
import { herkunftSatz } from '../auditFeststellung';
import { FristDatum } from '../components/FristDatum';
import {
  MassnahmeAendernDialog,
  MassnahmeKommentarDialog,
  MassnahmeUmgesetztDialog,
  MassnahmeVerwerfenDialog,
} from '../components/MassnahmeDialoge';
import { MassnahmeBewertenDialog, UrteilKarte, useWirkung, WirkungKacheln, WirkungKarte, type BewertungSchritt } from '../components/MassnahmeWirkung';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { Skeleton } from '../components/States';
import { VerbesserungAnstoesse } from '../components/VerbesserungAnstoesse';
import * as Z from '../energieziele';
import { NBSP } from '../format';
import { UEMS_MASSNAHME } from '../glossar';
import * as M from '../massnahmen';
import * as B from '../massnahmenBild';
import { auditRoute, feststellungRoute, hashForRoute, managementbewertungRoute } from '../nav';
import { useRollen } from '../rollen';
import { merkeAbruf } from '../routenUhr';
import '../components/Wiedervorlage.css';
import './Verbesserung.css';
import './Massnahmen.css';

type Lage = { art: 'laedt' } | { art: 'fehlt' } | { art: 'fehler' } | { art: 'da'; m: Massnahme };
type Dialog = null | 'umgesetzt' | 'verwerfen' | 'aendern' | 'kommentar' | BewertungSchritt;

/** Der Sprung zur Herkunft aus dem Energiemanagement (SP5, W3): Feststellung, internes Audit, Managementbewertung. */
function herkunftZiel(art: MassnahmeHerkunft, kennung: string | null): string | null {
  if (!kennung) return null;
  const ziel =
    art === 'nichtkonformitaet'
      ? feststellungRoute(kennung)
      : art === 'audit'
        ? auditRoute(kennung)
        : art === 'managementbewertung'
          ? managementbewertungRoute(kennung.split('/')[0])
          : null;
  return ziel ? hashForRoute(ziel) : null;
}

/** Ein Eintrag des Verlaufs in einem Satz (neueste zuerst, Datumsblöcke neutral wie die Ablesungen in Messen m1). */
function verlaufTitel(e: MassnahmeEintrag): string {
  if (e.art === 'massnahme_bewertet') {
    const ergebnis = typeof e.neu?.ergebnis === 'string' ? (e.neu.ergebnis as string).replace('_', ' ') : null;
    return ergebnis ? `Wirkung geprüft: ${ergebnis}` : 'Wirkung geprüft';
  }
  if (e.art === 'massnahme_umgesetzt') return 'Umgesetzt';
  if (e.art === 'massnahme_angelegt') return 'Geplant';
  if (e.art === 'massnahme_verworfen') return 'Verworfen';
  return M.VERLAUF_WORT[e.art].charAt(0).toUpperCase() + M.VERLAUF_WORT[e.art].slice(1);
}

function Verlauf({ m }: { m: Massnahme }) {
  const eintraege = [...(m.verlauf ?? [])].reverse();
  return (
    <section className="vp-mn-karte is-verlauf" aria-labelledby="ma-verlauf" data-testid="massnahme-verlauf">
      <div className="vp-wv-blockkopf">
        <h2 id="ma-verlauf">{M.VERLAUF}</h2>
        <span className="vp-wv-abschnitt-m is-immer">neueste zuerst</span>
      </div>
      {eintraege.length === 0 ? (
        <p className="vp-mn-leise">Für diese Maßnahme ist noch kein Verlauf festgehalten.</p>
      ) : (
        eintraege.length === 1 &&
        eintraege[0].art === 'massnahme_angelegt' && <p className="vp-mn-leise">{`Noch kein Eintrag seit dem Planen am ${Z.tag(m.angelegt_am)}.`}</p>
      )}
      <ol className="vp-mn-verlauf">
        {eintraege.map((e) => {
          const [j, mo, t] = e.am.slice(0, 10).split('-');
          const text = e.kommentar ?? e.begruendung;
          return (
            <li key={e.nr} data-testid={`verlauf-${e.art}`}>
              <FristDatum wort="" tag={`${t}.${mo}.`} jahr={j} satz={`${verlaufTitel(e)} am ${t}.${mo}.${j}`} ton="bald" />
              <span className="vp-mn-verlauf-text">
                <b>{verlaufTitel(e)}</b>
                <span>{text ? `${e.person}: ‚${text}‘` : e.person}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** „Woher die Maßnahme kommt“ (§6.6): die Herkunft als Satz mit Sprung. */
function Woher({ m }: { m: Massnahme }) {
  const satz = herkunftSatz(m.herkunft.art, m.herkunft.kennung) ?? B.herkunftText(m);
  const ziel = herkunftZiel(m.herkunft.art, m.herkunft.kennung);
  if (!satz) return null;
  return (
    <section className="vp-mn-karte is-woher" aria-labelledby="ma-woher" data-testid="massnahme-herkunft">
      <div className="vp-wv-blockkopf">
        <h2 id="ma-woher">{`Woher die ${UEMS_MASSNAHME} kommt`}</h2>
      </div>
      <p className="vp-mn-text">{satz.endsWith('.') ? satz : `${satz.charAt(0).toUpperCase()}${satz.slice(1)}.`}</p>
      {ziel && (
        <a className="vp-mn-sprung" href={ziel} data-testid="massnahme-sprung-herkunft">
          Ansehen
        </a>
      )}
    </section>
  );
}

/** „Wofür und woran gemessen“ (§6.6): Energieziel, Kennzahl mit Bezugsbasis, Vorher - oder ehrlich „nicht gemessen“. */
function WofuerUndWoran({
  m,
  onKennzahl,
  onEnergieziel,
}: {
  m: Massnahme;
  onKennzahl?: (id: string) => void;
  onEnergieziel?: (id: string) => void;
}) {
  const mg = m.messgrundlage;
  const vorher = B.vorherBild(m);
  return (
    <section className="vp-mn-karte is-wofuer" aria-labelledby="ma-wofuer" data-testid="massnahme-messgrundlage">
      <div className="vp-wv-blockkopf">
        <h2 id="ma-wofuer">Wofür und woran gemessen</h2>
      </div>
      <dl className="vp-mn-zuo">
        {m.energieziel && (
          <div className="vp-mn-zr">
            <dt>Für</dt>
            <dd className="vp-mn-w">{B.energiezielName(m.energieziel.kennzeichen)}</dd>
            <dd className="vp-mn-n">{B.energiezielRest(m.energieziel.kennzeichen, m.energieziel.name) ?? m.energieziel.kennzeichen}</dd>
            {onEnergieziel && (
              <button type="button" className="vp-mn-sprung vp-mn-a" onClick={() => onEnergieziel(m.energieziel!.id)} data-testid="massnahme-sprung-energieziel">
                Ansehen
              </button>
            )}
          </div>
        )}
        {mg ? (
          <>
            <div className="vp-mn-zr">
              <dt>Gemessen an</dt>
              <dd className="vp-mn-w">{mg.kennzahl.name ?? mg.kennzahl.kennzeichen}</dd>
              <dd className="vp-mn-n" data-testid="massnahme-methode">{`Bezugsbasis ${mg.bezugsbasis.kennzeichen}, Fassung ${mg.fassung} · ${B.methodeKurz(mg.bewertungsmethode)}`}</dd>
              {onKennzahl && (
                <button type="button" className="vp-mn-sprung vp-mn-a" onClick={() => onKennzahl(mg.kennzahl.id)} data-testid="massnahme-sprung-kennzahl">
                  Ansehen
                </button>
              )}
            </div>
            <div className="vp-mn-zr">
              <dt>Vorher</dt>
              <dd className="vp-mn-w">{vorher ? vorher.satz : 'die Monate vor dem Planen'}</dd>
              <dd className="vp-mn-n">{`festgehalten am ${Z.tag(m.angelegt_am)}`}</dd>
              <dd>
                <details className="vp-mn-details" data-testid="massnahme-ausgangslage">
                  <summary>
                    Details
                    <Icon name="chevron-down" size={14} />
                  </summary>
                  {mg.satz && <p className="vp-mn-leise">{mg.satz}</p>}
                  <pre>{mg.ausgangslage}</pre>
                  <p className="vp-mn-leise" data-testid="massnahme-pruefsumme">{`${M.PRUEFSUMME} ${mg.pruefsumme}`}</p>
                </details>
              </dd>
            </div>
          </>
        ) : (
          <div className="vp-mn-zr">
            <dt>Gemessen an</dt>
            <dd className="vp-mn-w">{m.art === 'organisatorisch' ? 'nichts - organisatorisch' : 'nicht gemessen'}</dd>
            {m.art === 'nicht_gemessen' && m.ohne_messgrundlage && (
              <dd className="vp-mn-n" data-testid="massnahme-ohne-messgrundlage">{B.nichtGemessenSatz(m)}</dd>
            )}
          </div>
        )}
      </dl>
    </section>
  );
}

/** „Was es bringen soll“ (§6.6): die erwartete Wirkung als Zitat der Person, die Schätzung als solche gekennzeichnet. */
function WasEsBringenSoll({ m, kennzahlAnlegen }: { m: Massnahme; kennzahlAnlegen: boolean }) {
  const angelegt = m.verlauf?.find((e) => e.art === 'massnahme_angelegt');
  const e = m.erwartete_einsparung;
  const zahl =
    m.erwartete_wirkung_prozent !== null
      ? `${B.personProzent(m.erwartete_wirkung_prozent)} ${B.richtungWort(m.erwartete_wirkung_prozent)} als erwartet${e ? `, rund ${B.rund(e.kwh_jahr)}${NBSP}kWh im Jahr` : ''}`
      : e
        ? `rund ${B.rund(e.kwh_jahr)}${NBSP}kWh im Jahr, geschätzt`
        : null;
  return (
    <section className="vp-mn-karte is-wirkung" aria-labelledby="ma-soll" data-testid="massnahme-erwartete-wirkung">
      <div className="vp-wv-blockkopf">
        <h2 id="ma-soll">{m.art === 'organisatorisch' ? 'Was sich ändern soll' : 'Was es bringen soll'}</h2>
      </div>
      {zahl && <p className="vp-mn-w vp-mn-text"><b>{zahl}</b></p>}
      <blockquote className="vp-mn-zitat">
        ‚{m.erwartete_wirkung_wortlaut}‘
        <small>{`${angelegt ? `${angelegt.person} · ` : ''}beim Planen am ${Z.tag(m.angelegt_am)}`}</small>
      </blockquote>
      {e?.grundlage_kwh && e.grundlage_monate && (
        <p className="vp-mn-leise">{`Gerechnet mit ${B.ganz(e.grundlage_kwh)}${NBSP}kWh in ${Z.zielperiodeText(e.grundlage_monate)} - eine Schätzung, nie mit gemessenen Werten summiert.`}</p>
      )}
      {m.art === 'nicht_gemessen' && m.ohne_messgrundlage && (m.zustand === 'geplant' || m.zustand === 'umgesetzt') && (
        <div className="vp-mn-hinweis">
          <Icon name="info" size={16} />
          <span>
            <b>Nicht gemessen:</b> {B.nichtGemessenSatz(m)}
            {/* Der Sprung nur, wenn die Person eine Kennzahl anlegen darf - sonst führt er ins Leere. */}
            {kennzahlAnlegen && (
              <>
                {' '}
                <a className="vp-mn-sprung" href="#/portfolio/kennzahlen">
                  Kennzahl anlegen
                </a>
              </>
            )}
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * Die Seite einer Maßnahme (Verbessern-Konzept v1 §6.6): Rückweg, Titel mit Kennzeichen leise, Stufen mit Datum, die
 * Antwort zuerst, je Stufe ein großer Knopf (Umsetzung melden · Wirkung prüfen · Abschließen), die Wirkung als Kacheln
 * und Grafik, das Urteil einer Person, Herkunft, „Wofür und woran gemessen“ und der Verlauf. Seltenes im Menü ⋯
 * (Ändern, Kommentar schreiben, Verwerfen). Am Rechner zwei Spalten. Die Marke `data-entscheid="massnahme_termin"`
 * bleibt am Kopf, damit die Sprünge der Wiedervorlage treffen.
 */
export function MassnahmeSeite({
  id,
  onListe,
  onKennzahl,
  onEnergieziel,
}: {
  id: string;
  onListe: () => void;
  onKennzahl?: (kennzahlId: string) => void;
  onEnergieziel?: (energiezielId: string) => void;
}) {
  const [lage, setLage] = useState<Lage>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [anstoss, setAnstoss] = useState<VorgangAnstoss | null>(null);
  const rollen = useRollen();
  const sub = rollen.selbst?.kennung ?? null;

  useEffect(() => {
    let aktiv = true;
    setLage({ art: 'laedt' });
    api.massnahme(id).then(
      (m) => {
        merkeAbruf(m.frist.abruf);
        if (aktiv) setLage({ art: 'da', m });
      },
      (e) => aktiv && setLage({ art: e instanceof ApiError && e.status === 404 ? 'fehlt' : 'fehler' }),
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);

  const zurueck = (
    <button type="button" className="vp-ez-zurueck" onClick={onListe}>
      <Icon name="chevron-left" size={18} />
      {M.ZUR_LISTE}
    </button>
  );

  const m = lage.art === 'da' ? lage.m : null;
  const [wirkung, wirkungErneut] = useWirkung(m ?? { id, umgesetzt_am: null, zustand: 'geplant', art: 'nicht_gemessen' });

  if (lage.art === 'laedt') {
    return (
      <div className="vp-mn-seite vp-k-farben" data-testid="massnahme-seite" aria-busy="true">
        {zurueck}
        <Skeleton height={260} />
      </div>
    );
  }
  if (lage.art !== 'da' || !m) {
    return (
      <div className="vp-mn-seite vp-k-farben" data-testid="massnahme-seite">
        {zurueck}
        {lage.art === 'fehlt' ? (
          <p className="vp-ez-satz">{M.NICHT_GEFUNDEN}</p>
        ) : (
          <section className="vp-wv-karte is-fehler" role="alert">
            <div className="vp-wv-blockkopf">
              <h2>{B.LADEFEHLER_TITEL}</h2>
            </div>
            <p className="vp-wv-leise">{B.LADEFEHLER_SEITE}</p>
            <button type="button" className="vp-wv-link" onClick={() => setVersuch((v) => v + 1)}>
              {B.ERNEUT_VERSUCHEN}
            </button>
          </section>
        )}
        <GrenzSatz className="vp-ez-grenze" />
      </div>
    );
  }

  const w = wirkung?.art === 'da' ? wirkung.w : null;
  const darfMelden = rollen.darf('verbesserung.verwalten', m.standort_id);
  const darfAbschliessen = rollen.darf('verbesserung.abschliessen', m.standort_id);
  const antwort = B.antwortBild(m, w, darfAbschliessen);
  const stufen = B.stufenBild(m);
  const neu = (x: Massnahme) => {
    setDialog(null);
    setAnstoss(null);
    setLage({ art: 'da', m: x });
  };

  const gross =
    m.zustand === 'geplant' && darfMelden
      ? { wort: B.KNOPF_UMSETZUNG, dialog: 'umgesetzt' as const, icon: 'check' as const }
      : m.zustand === 'umgesetzt' && darfAbschliessen && !m.bewertung_antrag
        ? m.art === 'gemessen'
          ? { wort: B.KNOPF_WIRKUNG, dialog: 'bewerten' as const, icon: 'check' as const }
          : { wort: B.KNOPF_ABSCHLIESSEN, dialog: 'bewerten' as const, icon: 'check' as const }
        : null;

  const menue: RowMenuItem[] = [
    ...(M.aenderbar(m) ? [{ label: 'Ändern', icon: 'pencil' as const, recht: 'verbesserung.verwalten', standort: m.standort_id, onClick: () => setDialog('aendern') }] : []),
    ...(M.kommentierbar(m)
      ? [{ label: 'Kommentar schreiben', icon: 'file-text' as const, recht: 'verbesserung.verwalten', standort: m.standort_id, onClick: () => setDialog('kommentar') }]
      : []),
    ...(M.aenderbar(m)
      ? [{ label: 'Verwerfen', icon: 'x' as const, recht: 'verbesserung.verwalten', standort: m.standort_id, danger: true, onClick: () => setDialog('verwerfen') }]
      : []),
  ];
  const wer = [m.einsatz?.name ?? m.messgrundlage?.kennzahl.name ?? null, `verantwortlich ${m.verantwortlich.name}`].filter(Boolean).join(' · ');
  const zeigeWirkung = m.art === 'gemessen' && (m.zustand === 'umgesetzt' || m.zustand === 'bewertet') && wirkung;
  const zeigeUrteil = m.zustand === 'umgesetzt' || m.zustand === 'bewertet';

  return (
    <GrenzSatzBereich>
      <div className="vp-mn-seite vp-k-farben" data-testid="massnahme-seite">
        {zurueck}
        <header className="vp-mn-pkopf" data-entscheid="massnahme_termin" data-testid="massnahme-zustand">
          <div className="vp-mn-pkopf-text">
            <h1 data-testid="massnahme-titel">
              {m.titel}
              <span className="vp-mn-kz">{m.kennzeichen}</span>
            </h1>
            <p className="vp-mn-meta" data-testid="massnahme-kopf">
              {wer}
            </p>
          </div>
          {menue.length > 0 && (
            <span className="vp-wv-menue" data-testid="massnahme-menue">
              <RowMenu label="Weitere Aktionen" buttonClassName="vp-wv-menue-knopf" items={menue} />
            </span>
          )}
        </header>
        <ol className="vp-mn-stufen" style={{ ['--n' as string]: String(stufen.length) }} aria-label="Stand der Maßnahme" data-testid="massnahme-stufen">
          {stufen.map((s) => (
            <li key={s.wort} className={`is-${s.stand}`}>
              <span className="vp-mn-punkt" aria-hidden="true">
                {s.stand === 'done' && <Icon name="check" size={13} />}
              </span>
              <b>{s.wort}</b>
              <small>{s.klein}</small>
            </li>
          ))}
        </ol>
        <div className="vp-mn-spalten">
          <div className="vp-mn-spalte">
            <div className="vp-mn-antwort" data-testid="massnahme-antwort">
              <p className={`vp-mn-satz${m.frist.faellig === 'ueberfaellig' ? ' is-warn' : ''}`}>{antwort.satz}</p>
              {antwort.formal && <p className="vp-mn-formal">{antwort.formal}</p>}
            </div>
            {gross && (
              <Button
                className="vp-mn-gross"
                iconLeft={<Icon name={gross.icon} size={16} />}
                onClick={() => setDialog(gross.dialog)}
                data-testid={gross.dialog === 'umgesetzt' ? 'massnahme-umgesetzt-knopf' : 'massnahme-bewerten'}
              >
                {gross.wort}
              </Button>
            )}
            {zeigeWirkung && w && <WirkungKacheln m={m} w={w} />}
            {zeigeWirkung && wirkung && <WirkungKarte m={m} lage={wirkung} erneut={wirkungErneut} />}
            {(m.zustand === 'geplant' || m.art !== 'gemessen') && (
              <WasEsBringenSoll
                m={m}
                kennzahlAnlegen={rollen.darf('kennzahl.standort_definieren', m.standort_id) || rollen.darf('kennzahl.unternehmen_definieren', null)}
              />
            )}
            <VerbesserungAnstoesse
              vorgang="massnahme"
              anstoesse={m.anstoesse}
              standort={m.standort_id}
              onAntwort={async (a, antwortArt, begruendung) =>
                neu(await api.massnahmeAnstossAntwort(m.id, a.id, { antwort: antwortArt, ...(begruendung ? { begruendung } : {}) }))
              }
              onNeuBewerten={(a) => {
                setAnstoss(a);
                setDialog('bewerten');
              }}
            />
            <Verlauf m={m} />
          </div>
          <div className="vp-mn-spalte">
            {zeigeUrteil && <UrteilKarte m={m} w={w} sub={sub} onDialog={setDialog} darfAbschliessen={darfAbschliessen} />}
            <Woher m={m} />
            <WofuerUndWoran m={m} onKennzahl={onKennzahl} onEnergieziel={onEnergieziel} />
          </div>
        </div>
        <GrenzHinweis />

        {dialog === 'umgesetzt' && <MassnahmeUmgesetztDialog massnahme={m} onClose={() => setDialog(null)} onFertig={neu} />}
        {dialog === 'verwerfen' && <MassnahmeVerwerfenDialog massnahme={m} onClose={() => setDialog(null)} onFertig={neu} />}
        {dialog === 'aendern' && <MassnahmeAendernDialog massnahme={m} onClose={() => setDialog(null)} onFertig={neu} />}
        {dialog === 'kommentar' && <MassnahmeKommentarDialog massnahme={m} onClose={() => setDialog(null)} onFertig={neu} />}
        {(dialog === 'bewerten' || dialog === 'freigeben' || dialog === 'ablehnen') && (
          <MassnahmeBewertenDialog
            m={m}
            w={w}
            schritt={dialog}
            anstoss={anstoss}
            onClose={() => {
              setDialog(null);
              setAnstoss(null);
            }}
            onFertig={neu}
          />
        )}
      </div>
    </GrenzSatzBereich>
  );
}
