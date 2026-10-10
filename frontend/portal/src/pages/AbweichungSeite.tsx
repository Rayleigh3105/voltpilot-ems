import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import * as A from '../abweichungen';
import { api, ApiError, type Abweichung, type Massnahme } from '../api';
import { type BezugsbasisVergleich } from '../bezugsbasisVergleich';
import { AbschliessenDialog, FristDialog, KommentarDialog, UrsacheAussageDialog, VerantwortlicherDialog } from '../components/AbweichungDialoge';
import { FristDatum } from '../components/FristDatum';
import { GrenzHinweis, GrenzSatz, GrenzSatzBereich } from '../components/GrenzSatz';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { useRollen } from '../rollen';
import { merkeAbruf } from '../routenUhr';
import * as Z from '../energieziele';
import { UEMS_BEZUGSBASIS, UEMS_MASSNAHME, UEMS_MASSNAHME_ERGEBNISSE, UEMS_VERANTWORTLICH } from '../glossar';
import '../components/kacheln/Kacheln.css';
import '../components/Wiedervorlage.css';
import './Abweichungen.css';

type Lage = { art: 'laedt' } | { art: 'fehlt' } | { art: 'fehler' } | { art: 'da'; a: Abweichung };
type Dialog = null | 'aussage' | 'frist' | 'verantwortlich' | 'abschliessen' | 'kommentar' | 'kopie';

const LADEFEHLER = 'Die Abweichung ließ sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
const ERNEUT = 'Erneut versuchen';
const KEIN_EINTRAG = (tag: string) => `Noch kein Eintrag seit dem Eröffnen am ${tag}.`;
const OFFEN_DARAUS = `Noch offen. Schließen Sie die Abweichung mit einer ${UEMS_MASSNAHME} ab, steht sie hier.`;
/** Ohne das Recht zum Abschließen ohne Aufforderung (S-3.1). */
const OFFEN_DARAUS_LESEND = `Noch offen. Wird die Abweichung mit einer ${UEMS_MASSNAHME} abgeschlossen, steht sie hier.`;

/** Der Stand der Maßnahme, die aus der Abweichung wurde: „umgesetzt am 22.01.2028 · belegt“. */
function massnahmeZeile(m: Massnahme): string {
  const teile: string[] = [];
  if (m.zustand === 'geplant') teile.push(`geplant bis ${Z.tag(m.termin)}`);
  if (m.umgesetzt_am) teile.push(`umgesetzt am ${Z.tag(m.umgesetzt_am)}`);
  if (m.zustand === 'verworfen') teile.push('verworfen');
  if (m.bewertung?.status === 'bewertet') teile.push(UEMS_MASSNAHME_ERGEBNISSE[m.bewertung.ergebnis]);
  return teile.join(' · ');
}

/**
 * Die Seite einer Abweichung (Verbessern-Konzept v1 §6.8, PR3) als kurze Geschichte: Titel ist, was auffiel (V6, das
 * Kennzeichen leise daneben), darunter die Stufen mit Datum, oben das Ergebnis bzw. wer bis wann klärt - mit dem
 * nächsten Schritt „Abschließen“ und „Aussage festhalten“; dann „Was auffiel“ aus der festgehaltenen Kopie (liest der
 * Vergleich heute anders, steht der Unterschied als Satz da), „Was dazu bekannt ist“ als Datumsblöcke (eine Aussage immer
 * mit „Aussage von …“), „Daraus wurde“ und „Über diese Abweichung“. Am Rechner zwei Spalten. Die Marke
 * `data-entscheid="abweichung_frist"` trägt der Block mit dem nächsten Schritt - dort landet der Sprung der
 * Wiedervorlage. „Heute“ ist der Tag der Route (`frist.abruf`). Nichts an der Kennzahl ändert sich (A5).
 */
export function AbweichungSeite({
  id,
  onListe,
  onKennzahl,
  onMassnahme,
}: {
  id: string;
  onListe: () => void;
  onKennzahl?: (kennzahlId: string) => void;
  onMassnahme?: (massnahmeId: string) => void;
}) {
  const [lage, setLage] = useState<Lage>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);
  const rollen = useRollen();
  const [vergleich, setVergleich] = useState<BezugsbasisVergleich | null>(null);
  const [massnahme, setMassnahme] = useState<Massnahme | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    let aktiv = true;
    setLage((l) => (l.art === 'da' && l.a.id === id ? l : { art: 'laedt' }));
    api.abweichung(id).then(
      (a) => {
        merkeAbruf(a.frist.abruf);
        if (aktiv) setLage({ art: 'da', a });
      },
      (e) => aktiv && setLage({ art: e instanceof ApiError && e.status === 404 ? 'fehlt' : 'fehler' }),
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);

  // Der Vergleich der Kennzahl heute - nur, um zu sagen, ob er vom festgehaltenen Monat abweicht.
  const a = lage.art === 'da' ? lage.a : null;
  const einMonat = a && a.monate.length === 1 ? a.monate[0] : null;
  const kz = a?.kennzahl.id ?? null;
  const bb = a?.bezugsbasis.kennzeichen ?? null;
  useEffect(() => {
    setVergleich(null);
    if (!kz || !einMonat) return undefined;
    let aktiv = true;
    api.bezugsbasisVergleich(kz, { von: einMonat, bis: einMonat, ...(bb ? { basis: bb } : {}) }).then(
      (v) => aktiv && setVergleich(v),
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
  }, [kz, einMonat, bb]);

  const mId = a?.abschluss?.massnahme?.id ?? null;
  useEffect(() => {
    setMassnahme(null);
    if (!mId) return undefined;
    let aktiv = true;
    api.massnahme(mId).then(
      (m) => aktiv && setMassnahme(m),
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
  }, [mId]);

  const zurueck = (
    <button type="button" className="vp-abw-zurueck" onClick={onListe} data-testid="abweichung-zurueck">
      <Icon name="chevron-left" size={16} />
      {A.ZUR_LISTE}
    </button>
  );

  if (!a) {
    return (
      <div className="vp-abw" data-testid="abweichung-seite" aria-busy={lage.art === 'laedt'}>
        {zurueck}
        {lage.art === 'laedt' ? (
          <div className="vp-wv-skelett" aria-label="Wird geladen">
            <span className="vp-skeleton is-zeile" />
            <span className="vp-skeleton is-karte" />
            <span className="vp-skeleton is-karte" />
          </div>
        ) : lage.art === 'fehlt' ? (
          <p className="vp-abw-leer">{A.NICHT_GEFUNDEN}</p>
        ) : (
          <div className="vp-abw-leer is-fehler" role="alert">
            <span>{LADEFEHLER}</span>
            <button type="button" className="vp-abw-link" onClick={() => setVersuch((v) => v + 1)}>
              {ERNEUT}
            </button>
          </div>
        )}
        <GrenzSatz className="vp-abw-leise" />
      </div>
    );
  }

  const offen = A.offen(a);
  const darfAbschliessen = rollen.darf('verbesserung.abschliessen', a.standort_id);
  const darfVerwalten = rollen.darf('verbesserung.verwalten', a.standort_id);
  const neu = (x: Abweichung) => {
    setDialog(null);
    setLage({ art: 'da', a: x });
  };
  const antwort = A.antwortDerAbweichung(a);
  const stufen = A.stufenDerAbweichung(a);
  const zahlen = a.monate.length === 1 ? A.anlassZahlen(a.anlass_inhalt) : null;
  const saetze = zahlen ? [] : A.anlassSaetze(a.anlass_inhalt);
  const heute = vergleich?.monate.find((m) => m.periode === einMonat)?.bereinigt ?? null;
  const anders = A.heuteAnders(zahlen, heute);
  const verlauf = A.verlaufBild(a);
  const kennzahl = A.kennzahlName(a.kennzahl);
  const meta = [kennzahl, `${UEMS_VERANTWORTLICH.toLowerCase()} ${a.verantwortlich.name}`, `Frist ${offen ? '' : 'war '}${Z.tag(a.frist.termin)}`];
  const vermerktAm = [...(a.vermerke ?? [])].map((v) => v.vermerkt_am).sort()[0] ?? null;

  const menue: RowMenuItem[] = offen
    ? [
        { label: A.KNOPF_KOMMENTAR_SCHREIBEN, icon: 'pencil', recht: 'verbesserung.verwalten', standort: a.standort_id, onClick: () => setDialog('kommentar') },
        { label: A.KNOPF_FRIST, icon: 'calendar', recht: 'verbesserung.verwalten', standort: a.standort_id, onClick: () => setDialog('frist') },
        { label: A.KNOPF_VERANTWORTLICH, icon: 'users', recht: 'verbesserung.verwalten', standort: a.standort_id, onClick: () => setDialog('verantwortlich') },
      ]
    : [];

  return (
    <GrenzSatzBereich>
      <div className="vp-abw" data-testid="abweichung-seite">
        {zurueck}
        <header className="vp-abw-kopf">
          <div className="vp-abw-kopf-text">
            <h1 data-testid="abweichung-titel">
              {A.abweichungTitel(a)} <span className="vp-abw-kz">{a.kennzeichen}</span>
            </h1>
            <p className="vp-abw-meta" data-testid="abweichung-meta">
              {meta.join(' · ')}
            </p>
          </div>
          {menue.length > 0 && (
            <span className="vp-abw-menue" data-testid="abweichung-menue">
              <RowMenu label="Weitere Aktionen" buttonClassName="vp-abw-menue-knopf" items={menue} />
            </span>
          )}
        </header>

        <ol className="vp-abw-stufen" aria-label="Stand der Abweichung" data-testid="abweichung-stufen">
          {stufen.map((s) => (
            <li key={s.wort} className={`is-${s.zustand}`} aria-current={s.zustand === 'jetzt' ? 'step' : undefined}>
              <span className="vp-abw-punkt" aria-hidden="true">
                {s.zustand === 'erledigt' && <Icon name="check" size={13} />}
              </span>
              <b>{s.wort}</b>
              {s.tag && <small>{s.tag}</small>}
            </li>
          ))}
        </ol>

        <div className="vp-abw-antwort" data-entscheid="abweichung_frist" data-testid="abweichung-antwort">
          <p className={`vp-abw-satz${antwort.warn ? ' is-warn' : ''}`} data-testid="abweichung-satz">
            {antwort.satz}
          </p>
          <p className="vp-abw-formal">{antwort.formal}</p>
          {offen && (darfAbschliessen || darfVerwalten) && (
            <div className="vp-abw-aktionen">
              {darfAbschliessen && (
                <Button onClick={() => setDialog('abschliessen')} data-testid="abweichung-abschliessen-knopf" data-entscheid-schritt>
                  {A.KNOPF_ABSCHLIESSEN}
                </Button>
              )}
              {darfVerwalten && (
                <Button variant="outline" onClick={() => setDialog('aussage')} data-testid="abweichung-aussage-knopf">
                  {A.KNOPF_AUSSAGE}
                </Button>
              )}
            </div>
          )}
          {/* Ohne das Recht zum Abschließen sagt die Seite, wer abschließt - statt zweimal „Dafür fehlt Ihnen das Recht“. */}
          {offen && !darfAbschliessen && (
            <p className="vp-abw-formal" data-testid="abweichung-wer-schliesst">
              {A.WER_ABSCHLIESST}
            </p>
          )}
        </div>

        <div className="vp-abw-raster">
          <div className="vp-abw-spalte">
            <section className="vp-abw-karte" aria-labelledby="aw-auffiel" data-testid="abweichung-was-auffiel">
              <div className="vp-abw-blockkopf">
                <h2 id="aw-auffiel">{A.WAS_AUFFIEL}</h2>
                <span className="vp-abw-blockkopf-m">{A.monateDerAbweichung(a.monate)}</span>
              </div>
              {zahlen?.gemessen ? (
                <>
                  <div className="vp-abw-zahlen">
                    <div>
                      <span>gemessen</span>
                      <b className={zahlen.delta && Number(zahlen.delta) > 0 ? 'is-warn' : undefined}>
                        {A.zahlDe(zahlen.gemessen.wert)}{'\u00a0'}<small>{zahlen.gemessen.einheit}</small>
                      </b>
                    </div>
                    {zahlen.erwartet && (
                      <div>
                        <span>erwartet</span>
                        <b>
                          {A.zahlDe(zahlen.erwartet.wert)}{'\u00a0'}<small>{zahlen.erwartet.einheit}</small>
                        </b>
                      </div>
                    )}
                    {zahlen.bedingung && (
                      <div>
                        <span>{A.bedingungLabel(zahlen.bedingung)}</span>
                        <b>
                          {A.zahlDe(zahlen.bedingung.wert)}{'\u00a0'}<small>{zahlen.bedingung.einheit}</small>
                        </b>
                      </div>
                    )}
                  </div>
                  {zahlen.delta && (
                    <p className="vp-abw-zeile" data-testid="abweichung-delta">
                      {`${A.deltaWort(zahlen.delta)} als erwartet${zahlen.band ? `; im Rahmen wären ${A.bandText(zahlen.band)}` : ''}.`}
                    </p>
                  )}
                </>
              ) : saetze.length > 0 ? (
                saetze.map((s) => (
                  <p key={s} className="vp-abw-zeile" data-testid="anlass-satz">
                    {s}
                  </p>
                ))
              ) : (
                <p className="vp-abw-zeile">Die festgehaltene Kopie nennt keine Zahl für diesen Monat.</p>
              )}
              {a.vorbehalte.length > 0 && (
                <div className="vp-abw-marken" data-testid="abweichung-vorbehalte">
                  {a.vorbehalte.map((x) => (
                    <span key={x} className="vp-k-marke">
                      {x}
                    </span>
                  ))}
                </div>
              )}
              {anders && (
                <p className="vp-abw-leise" data-testid="abweichung-heute-anders">
                  {anders}
                </p>
              )}
            </section>

            <section className="vp-abw-karte" aria-labelledby="aw-bekannt" data-testid="abweichung-verlauf">
              <div className="vp-abw-blockkopf">
                <h2 id="aw-bekannt">{A.WAS_BEKANNT}</h2>
                {verlauf.length > 1 && <span className="vp-abw-blockkopf-m">{A.NEUESTE_ZUERST}</span>}
              </div>
              {verlauf.length === 0 ? (
                <p className="vp-abw-zeile">{KEIN_EINTRAG(Z.tag(a.eroeffnet_am))}</p>
              ) : (
                <ul className="vp-fzl vp-abw-verlauf">
                  {verlauf.map((e) => {
                    const t = A.tagBlock(e.am);
                    return (
                      <li key={e.key} data-testid="verlauf-eintrag">
                        <div className="vp-fz">
                          <FristDatum wort="" tag={t.tag} jahr={t.jahr} satz={`am ${t.tag}${t.jahr}`} ton="bald" />
                          <span className="vp-fz-text">
                            <span className="vp-fz-titel">{e.titel}</span>
                            {e.text && <span className="vp-fz-grund">{e.text}</span>}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {offen && verlauf.length <= 1 && (
                <p className="vp-abw-leise">{A.AUSSAGE_HINWEIS}</p>
              )}
            </section>
          </div>

          <div className="vp-abw-spalte">
            <section className="vp-abw-karte" aria-labelledby="aw-daraus" data-testid="abweichung-daraus">
              <div className="vp-abw-blockkopf">
                <h2 id="aw-daraus">{A.DARAUS_WURDE}</h2>
              </div>
              {a.abschluss?.massnahme ? (
                <button
                  type="button"
                  className="vp-abw-reihe"
                  onClick={() => onMassnahme?.(a.abschluss!.massnahme!.id)}
                  disabled={!onMassnahme}
                  data-testid="abschluss-sprung-massnahme"
                >
                  <span className="vp-abw-reihe-text">
                    <b>{a.abschluss.massnahme.name ?? a.abschluss.massnahme.kennzeichen}</b>
                    <span>{[`${UEMS_MASSNAHME} ${a.abschluss.massnahme.kennzeichen ?? ''}`.trim(), massnahme ? massnahmeZeile(massnahme) : null].filter(Boolean).join(' · ')}</span>
                  </span>
                  {onMassnahme && <Icon name="chevron-right" size={16} />}
                </button>
              ) : a.abschluss ? (
                <p className="vp-abw-zitat" data-testid="abschluss-satz">
                  {`Keine ${UEMS_MASSNAHME} - ${A.ERGEBNIS_WORT[a.abschluss.ergebnis]}: ‚${a.abschluss.begruendung}‘`}
                  <small>{`${a.abschluss.person} · ${Z.tag(a.abschluss.am)}`}</small>
                </p>
              ) : (
                <p className="vp-abw-zeile">{darfAbschliessen ? OFFEN_DARAUS : OFFEN_DARAUS_LESEND}</p>
              )}
            </section>

            <section className="vp-abw-karte" aria-labelledby="aw-ueber" data-testid="abweichung-ueber">
              <div className="vp-abw-blockkopf">
                <h2 id="aw-ueber">{A.UEBER_DIESE}</h2>
              </div>
              <dl className="vp-abw-zuo">
                <div className="vp-abw-zr">
                  <dt>Kennzahl</dt>
                  <dd>
                    <b>{kennzahl}</b>
                    <span>{`${UEMS_BEZUGSBASIS} ${a.bezugsbasis.kennzeichen ?? ''}, Fassung ${a.fassung}`}</span>
                  </dd>
                  {onKennzahl && (
                    <button type="button" className="vp-abw-link" onClick={() => onKennzahl(a.kennzahl.id)} data-testid="abweichung-sprung-kennzahl">
                      {A.KNOPF_ANSEHEN}
                    </button>
                  )}
                </div>
                <div className="vp-abw-zr">
                  <dt>Eröffnet</dt>
                  <dd>
                    <b>{`${Z.tag(a.eroeffnet_am)} von ${a.eroeffnet_von}`}</b>
                    <span data-testid="abweichung-herkunft">
                      {a.herkunft.art === 'von_hand'
                        ? `von Hand${a.herkunft.wortlaut ? `: ‚${a.herkunft.wortlaut}‘` : ''}`
                        : vermerktAm
                          ? `aus der Auffälligkeit vom ${Z.tag(vermerktAm)}`
                          : A.HERKUNFT_WORT.auffaelligkeit}
                    </span>
                  </dd>
                </div>
                <div className="vp-abw-zr">
                  <dt>Was auffiel, festgehalten</dt>
                  <dd>
                    <b>{`Kopie vom ${Z.tag(a.eroeffnet_am)}`}</b>
                    <span>mit Prüfsumme, unverändert</span>
                  </dd>
                  <button type="button" className="vp-abw-link" onClick={() => setDialog('kopie')} data-testid="abweichung-kopie-knopf">
                    {A.KNOPF_KOPIE}
                  </button>
                </div>
              </dl>
            </section>
          </div>
        </div>

        <GrenzHinweis />

        {dialog === 'aussage' && <UrsacheAussageDialog abweichung={a} tagHeute={a.frist.abruf} onClose={() => setDialog(null)} onFertig={neu} />}
        {dialog === 'frist' && <FristDialog abweichung={a} tagHeute={a.frist.abruf} onClose={() => setDialog(null)} onFertig={neu} />}
        {dialog === 'verantwortlich' && <VerantwortlicherDialog abweichung={a} onClose={() => setDialog(null)} onFertig={neu} />}
        {dialog === 'abschliessen' && <AbschliessenDialog abweichung={a} tagHeute={a.frist.abruf} onClose={() => setDialog(null)} onFertig={neu} />}
        {dialog === 'kommentar' && <KommentarDialog abweichung={a} onClose={() => setDialog(null)} onFertig={neu} />}
        {dialog === 'kopie' && (
          <Modal open onClose={() => setDialog(null)} title={`${A.WAS_AUFFIEL}, festgehalten`}>
            <div className="vp-abw-blatt" data-testid="abweichung-kopie">
              <p className="vp-abw-leise">{`So wurde der Monat beim Eröffnen am ${Z.tag(a.eroeffnet_am)} gelesen; die Prüfsumme zeigt, dass die Kopie unverändert ist.`}</p>
              <pre className="vp-abw-kopie">{a.anlass}</pre>
              <p className="vp-abw-leise" data-testid="abweichung-pruefsumme">{`${A.PRUEFSUMME} ${a.anlass_pruefsumme}`}</p>
            </div>
          </Modal>
        )}
      </div>
    </GrenzSatzBereich>
  );
}
