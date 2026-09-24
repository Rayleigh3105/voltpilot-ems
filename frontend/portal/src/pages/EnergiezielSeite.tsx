import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Energieziel, type EnergiezielStand } from '../api';
import { EnergiezielBeendenDialog, EnergiezielBewertenDialog } from '../components/EnergiezielDialoge';
import { MassnahmeAnlegen } from '../components/MassnahmeDialoge';
import { Recht } from '../components/Recht';
import { ErrorState, Skeleton } from '../components/States';
import * as Z from '../energieziele';
import { UEMS_BEZUGSBASIS, UEMS_NORMGRENZE, UEMS_ZIELPERIODE, UEMS_ZIELWERT } from '../glossar';
import { useRollen } from '../rollen';
import './Verbesserung.css';

type Lage = { art: 'laedt' } | { art: 'fehlt' } | { art: 'fehler' } | { art: 'da'; ez: Energieziel; stand: EnergiezielStand | null };

/**
 * Die Energieziel-Seite (AP-18 IP-8, §5.1, Z3–Z5): Kopf mit Herkunft (Kennzahl, Bezugsbasis-Fassung), der Satz des
 * Lesers, die Tabelle je Monat (gemessen, erwartet, Δ, Urteil; nicht gezählte Monate mit dem Satz des Lesers als
 * Grund) mit Summenzeile Σ ÷ Σ und „x von y“, der Vorschlag nur bei vollständiger Periode, „bewerten“ (mit Vier-Augen
 * als Antrag), „beenden“ und der Verlauf. Das Portal rechnet nichts — jede Zahl und jeder Satz kommt von der Route.
 */
export function EnergiezielSeite({
  id,
  onListe,
  onKennzahl,
  onMassnahme,
}: {
  id: string;
  onListe: () => void;
  onKennzahl?: (kennzahlId: string) => void;
  /** AP-18 IP-13 (§5.4): nach „Maßnahme anlegen“ die Seite der neuen Maßnahme. */
  onMassnahme?: (massnahmeId: string) => void;
}) {
  const [lage, setLage] = useState<Lage>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);
  const [dialog, setDialog] = useState<null | 'bewerten' | 'freigeben' | 'ablehnen' | 'beenden'>(null);
  const sub = useRollen().selbst?.kennung ?? null;

  useEffect(() => {
    let aktiv = true;
    setLage({ art: 'laedt' });
    Promise.all([api.energieziel(id), api.energiezielStand(id).catch(() => null)])
      .then(([ez, stand]) => aktiv && setLage({ art: 'da', ez, stand }))
      .catch((e) => aktiv && setLage({ art: e instanceof ApiError && e.status === 404 ? 'fehlt' : 'fehler' }));
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);

  const zurueck = (
    <button type="button" className="vp-ez-zurueck" onClick={onListe}>
      <Icon name="chevron-left" size={18} />
      {Z.ZUR_LISTE}
    </button>
  );

  if (lage.art === 'laedt') {
    return (
      <div className="vp-ez" data-testid="energieziel-seite" aria-busy="true">
        {zurueck}
        <Skeleton height={260} />
      </div>
    );
  }
  if (lage.art !== 'da') {
    return (
      <div className="vp-ez" data-testid="energieziel-seite">
        {zurueck}
        {lage.art === 'fehlt' ? (
          <p className="vp-ez-satz">{Z.NICHT_GEFUNDEN}</p>
        ) : (
          <ErrorState message={Z.LADEFEHLER_SEITE} onRetry={() => setVersuch((v) => v + 1)} />
        )}
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </div>
    );
  }

  const { ez, stand } = lage;
  const zeilen = stand ? Z.monatZeilen(stand) : [];
  const summe = stand ? Z.summenZeile(stand) : null;
  const vorschlag = stand ? Z.vorschlagSatz(stand) : null;
  const frist = Z.fristText(ez);
  const bewertung = Z.bewertungLage(ez, sub);
  const offen = ez.zustand === 'offen';
  // „bewerten“ nach dem Ende der Zielperiode — wenn der letzte Monat endgültig ist (F1); beides sagt die Route.
  const bewertbar = offen && bewertung.art === 'keine' && (frist !== null || (stand !== null && stand.monate_endgueltig === stand.monate_soll));
  const neu = (x: Energieziel) => {
    setDialog(null);
    setLage({ art: 'da', ez: x, stand });
    setVersuch((v) => v + 1);
  };

  return (
    <div className="vp-ez" data-testid="energieziel-seite">
      {zurueck}
      <header className="vp-ez-kopf">
        <div className="vp-ez-kopf-zeile">
          <h1>{`${Z.SPALTEN.kennzeichen} ${ez.kennzeichen}`}</h1>
          <Badge variant="tint">{Z.ZUSTAND_WORT[ez.zustand]}</Badge>
        </div>
        <p className="vp-ez-satz" data-testid="energieziel-wortlaut">
          {ez.wortlaut}
        </p>
        <p className="vp-ez-herkunft" data-testid="energieziel-herkunft">
          {onKennzahl ? (
            <button type="button" className="vp-ez-sprung" onClick={() => onKennzahl(ez.kennzahl.id)}>
              {ez.kennzahl.kennzeichen} {ez.kennzahl.name}
            </button>
          ) : (
            <span>
              {ez.kennzahl.kennzeichen} {ez.kennzahl.name}
            </span>
          )}
          <span>{`${UEMS_BEZUGSBASIS} ${ez.bezugsbasis.kennzeichen}, Fassung ${ez.bezugsbasis.fassung}`}</span>
          <span>{`${UEMS_ZIELWERT} ${Z.zielwertText(ez.zielwert_prozent)}`}</span>
          <span>{`${UEMS_ZIELPERIODE} ${Z.zielperiodeText(ez.zielperiode)}`}</span>
          <span>{`${Z.SPALTEN.verantwortlich} ${ez.verantwortlich.name}`}</span>
        </p>
        {frist && (
          <p className="vp-ez-frist" data-testid="energieziel-frist">
            {frist}
          </p>
        )}
        {/* AP-18 IP-13 (§5.4): „Maßnahme anlegen“ am Energieziel — Herkunft `energieziel`, Kennzahl vorbelegt. */}
        {offen && (
          <MassnahmeAnlegen
            vorbelegung={{ herkunft: 'energieziel', energieziel: ez.id, kennzahl: ez.kennzahl.id }}
            standort={ez.standort_id}
            onAngelegt={onMassnahme ? (m) => onMassnahme(m.id) : undefined}
          />
        )}
      </header>

      <section className="vp-ez-karte" aria-labelledby="ez-stand">
        <h2 id="ez-stand">{Z.SPALTEN.stand}</h2>
        {stand === null ? (
          <p className="vp-ez-leise">{Z.LADEFEHLER_SEITE}</p>
        ) : (
          <>
            <p className="vp-ez-satz" data-testid="energieziel-stand-satz">
              {stand.satz ?? `${Z.STAND_OHNE_MONAT} (${stand.monate_text}).`}
            </p>
            <table className="vp-ez-tafel" data-testid="energieziel-monate">
              <thead>
                <tr>
                  <th scope="col">{Z.MONAT_SPALTEN.monat}</th>
                  <th scope="col" className="vp-ez-zahl">
                    {Z.MONAT_SPALTEN.gemessen}
                  </th>
                  <th scope="col" className="vp-ez-zahl">
                    {Z.MONAT_SPALTEN.erwartet}
                  </th>
                  <th scope="col" className="vp-ez-zahl">
                    {Z.MONAT_SPALTEN.delta}
                  </th>
                  <th scope="col">{Z.MONAT_SPALTEN.urteil}</th>
                </tr>
              </thead>
              <tbody>
                {zeilen.map((m) =>
                  m.art === 'gezaehlt' ? (
                    <tr key={m.periode} data-testid={`monat-${m.periode}`}>
                      <th scope="row">{m.beschriftung}</th>
                      <td className="vp-ez-zahl" data-label={Z.MONAT_SPALTEN.gemessen}>
                        {m.gemessen}
                      </td>
                      <td className="vp-ez-zahl" data-label={Z.MONAT_SPALTEN.erwartet}>
                        {m.erwartet}
                      </td>
                      <td className="vp-ez-zahl" data-label={Z.MONAT_SPALTEN.delta}>
                        {m.delta ?? '—'}
                      </td>
                      <td data-label={Z.MONAT_SPALTEN.urteil} data-testid="urteil">
                        {m.urteil}
                        {m.band && ` (${m.band})`}
                      </td>
                    </tr>
                  ) : m.art === 'ausgeschlossen' ? (
                    <tr key={m.periode} className="vp-ez-aus" data-testid={`monat-${m.periode}`}>
                      <th scope="row">{m.beschriftung}</th>
                      <td className="vp-ez-zahl" data-label={Z.MONAT_SPALTEN.gemessen}>
                        {m.gemessen}
                      </td>
                      <td colSpan={3} data-label={Z.MONAT_SPALTEN.grund} data-testid="grund">
                        {m.satz}
                      </td>
                    </tr>
                  ) : (
                    <tr key={m.periode} className="vp-ez-offen" data-testid={`monat-${m.periode}`}>
                      <th scope="row">{m.beschriftung}</th>
                      <td colSpan={4}>{Z.NOCH_NICHT_ENDGUELTIG}</td>
                    </tr>
                  ),
                )}
                {summe && (
                  <tr className="vp-ez-summe" data-testid="energieziel-summe">
                    <th scope="row">
                      {Z.SUMME}
                      <span className="vp-ez-unter">{summe.monate}</span>
                    </th>
                    <td className="vp-ez-zahl" data-label={Z.MONAT_SPALTEN.gemessen}>
                      {summe.gemessen}
                    </td>
                    <td className="vp-ez-zahl" data-label={Z.MONAT_SPALTEN.erwartet}>
                      {summe.erwartet}
                    </td>
                    <td className="vp-ez-zahl" data-label={Z.MONAT_SPALTEN.delta}>
                      {summe.delta ?? '—'}
                    </td>
                    <td data-label={Z.MONAT_SPALTEN.urteil}>
                      {summe.urteil}
                      {summe.band && ` (${summe.band})`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {vorschlag && (
              <p className="vp-ez-vorschlag" data-testid="energieziel-vorschlag">
                <strong>{Z.VORSCHLAG}: </strong>
                {vorschlag}
              </p>
            )}
            {stand.summe.kennzeichen.length > 0 && (
              <ul className="vp-ez-leise">
                {stand.summe.kennzeichen.map((k) => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="vp-ez-karte" aria-labelledby="ez-bewertung" data-testid="energieziel-bewertung">
        <h2 id="ez-bewertung">Bewertung</h2>
        {bewertung.art === 'bewertet' ? (
          <>
            <p className="vp-ez-satz" data-testid="energieziel-bewertet">
              {bewertung.bewertung
                ? Z.bewertetSatz(bewertung.bewertung.person.name, bewertung.bewertung.am, bewertung.bewertung.ergebnis)
                : `${Z.ZUSTAND_WORT.bewertet}: ${ez.ergebnis ? Z.ERGEBNIS_WORT[ez.ergebnis] : '—'}`}
            </p>
            {bewertung.bewertung && <p>‚{bewertung.bewertung.begruendung}‘</p>}
            {bewertung.bewertung?.entscheidung && (
              <p className="vp-ez-leise" data-testid="energieziel-bestaetigt">
                {Z.bestaetigtSatz(bewertung.bewertung.entscheidung.name, bewertung.bewertung.entschieden_am)}
              </p>
            )}
            {bewertung.bewertung && Z.weichtAb(bewertung.bewertung.vorschlag, bewertung.bewertung.ergebnis) && (
              <p className="vp-ez-abweichung" data-testid="energieziel-abweichung">
                {Z.ABWEICHUNG_VOM_VORSCHLAG}
              </p>
            )}
            {bewertung.bewertung?.pruefsumme && <p className="vp-ez-pruefsumme">Prüfsumme {bewertung.bewertung.pruefsumme}</p>}
          </>
        ) : bewertung.art === 'beantragt' ? (
          <>
            <p className="vp-ez-satz" data-testid="energieziel-beantragt">
              {Z.beantragtSatz(bewertung.bewertung.person.name, bewertung.bewertung.am, bewertung.bewertung.ergebnis)}
            </p>
            <p>‚{bewertung.bewertung.begruendung}‘</p>
            {bewertung.eigener ? (
              <p className="vp-ez-leise">{Z.EIGENER_ANTRAG}</p>
            ) : (
              <Recht aktion="verbesserung.abschliessen" standort={ez.standort_id}>
                <div className="vp-ez-aktionen">
                  <Button size="sm" onClick={() => setDialog('freigeben')} data-testid="energieziel-freigeben">
                    {Z.KNOPF_FREIGEBEN}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setDialog('ablehnen')} data-testid="energieziel-ablehnen">
                    {Z.KNOPF_ABLEHNEN}
                  </Button>
                </div>
              </Recht>
            )}
          </>
        ) : ez.zustand === 'beendet' ? (
          <p className="vp-ez-satz" data-testid="energieziel-beendet">
            {ez.beendet_zum ? Z.beendetSatz(ez.beendet_zum, ez.beendet_grund) : Z.ZUSTAND_WORT.beendet}
          </p>
        ) : (
          <>
            <p className="vp-ez-leise">
              {bewertbar
                ? 'Die Zielperiode ist zu Ende. Das Ergebnis setzt eine Person mit Begründung.'
                : 'Bewertet wird nach dem Ende der Zielperiode, wenn ihr letzter Monat endgültig ist.'}
            </p>
            {bewertung.abgelehnt && (
              <p className="vp-ez-leise" data-testid="energieziel-abgelehnt">
                {Z.abgelehntSatz(bewertung.abgelehnt.entscheidung?.name ?? null)}
                {bewertung.abgelehnt.entscheidungs_begruendung && ` ‚${bewertung.abgelehnt.entscheidungs_begruendung}‘`}
              </p>
            )}
          </>
        )}
        {offen && bewertung.art === 'keine' && (
          <div className="vp-ez-aktionen">
            {bewertbar && (
              <Recht aktion="verbesserung.abschliessen" standort={ez.standort_id}>
                <Button size="sm" onClick={() => setDialog('bewerten')} data-testid="energieziel-bewerten">
                  {Z.KNOPF_BEWERTEN}
                </Button>
              </Recht>
            )}
            <Recht aktion="verbesserung.verwalten" standort={ez.standort_id}>
              <Button size="sm" variant="outline" onClick={() => setDialog('beenden')} data-testid="energieziel-beenden">
                {Z.KNOPF_BEENDEN}
              </Button>
            </Recht>
          </div>
        )}
      </section>

      {ez.anstoesse && ez.anstoesse.length > 0 && (
        <section className="vp-ez-karte" aria-labelledby="ez-anstoesse" data-testid="energieziel-anstoesse">
          <h2 id="ez-anstoesse">{Z.ANSTOESSE}</h2>
          <ul className="vp-ez-verlauf">
            {ez.anstoesse.map((a) => (
              <li key={a.id}>
                <p>
                  <strong>{Z.ANSTOSS_WORT[a.art]}</strong> · {a.anlass_kennung} · {Z.tag(a.angestossen_am)} ·{' '}
                  {a.zustand === 'offen' ? 'offen' : `beantwortet: ${a.antwort ? Z.ANSTOSS_ANTWORT[a.antwort] : '—'}`}
                </p>
                {a.antwort_begruendung && <p className="vp-ez-leise">‚{a.antwort_begruendung}‘</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {ez.verlauf && ez.verlauf.length > 0 && (
        <section className="vp-ez-karte" aria-labelledby="ez-verlauf" data-testid="energieziel-verlauf">
          <h2 id="ez-verlauf">{Z.VERLAUF}</h2>
          <ol className="vp-ez-verlauf">
            {ez.verlauf.map((e, i) => (
              <li key={`${e.am}-${i}`}>
                <p>
                  <strong>{Z.VERLAUF_WORT[e.art]}</strong> · {e.person} · {Z.tag(e.am)}
                </p>
                {e.begruendung && <p className="vp-ez-leise">‚{e.begruendung}‘</p>}
              </li>
            ))}
          </ol>
        </section>
      )}

      <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>

      {(dialog === 'bewerten' || dialog === 'freigeben' || dialog === 'ablehnen') && (
        <EnergiezielBewertenDialog ez={ez} stand={stand} schritt={dialog} onClose={() => setDialog(null)} onFertig={neu} />
      )}
      {dialog === 'beenden' && <EnergiezielBeendenDialog ez={ez} onClose={() => setDialog(null)} onBeendet={neu} />}
    </div>
  );
}
