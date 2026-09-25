import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type FeststellungMitVerlauf } from '../api';
import * as A from '../auditFeststellung';
import { EinsichtGruppe, EinsichtRecht } from '../components/EinsichtRecht';
import { AntragAblehnenDialog, EintragDialog, StandDialog, type StandArt } from '../components/FeststellungDialoge';
import { ablehnung } from '../components/InternesAuditDialoge';
import { MassnahmeAnlegen } from '../components/MassnahmeDialoge';
import { SAETZE, WOERTER } from '../energiemanagement';
import * as E from '../energiemanagementPortal';
import { UEMS_EINGETRAGEN_VON, UEMS_MASSNAHMEN, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG, UEMS_WIRKSAMKEIT } from '../glossar';
import { ZUSTAND_WORT as MASSNAHME_ZUSTAND_WORT } from '../massnahmen';
import { auditRoute, hashForRoute, massnahmeRoute } from '../nav';
import { useRollen } from '../rollen';
import './Energiemanagement.css';

type Dialog = null | 'eintrag' | StandArt | 'ablehnen';

/**
 * Die Seite einer Feststellung (UEMS AP-19 IP-20, §5.4, FS1–FS7): Kopf mit Quelle, Frist und Zustand; Vorgabe, Bezug;
 * die Einträge (sofortige Behebung, Ursache als Aussage einer Person, ähnliche Fälle); die Maßnahmen mit Zustand und
 * „Maßnahme anlegen“ (Herkunft Feststellung vorbelegt, nur solange offen); die Wirksamkeit als Stände Nr. n mit Prüfsumme
 * — „Wirksamkeit prüfen“, „Ohne Maßnahme abschließen“, „Zurücknehmen“, mit Vier-Augen der Antrag und seine Bestätigung,
 * und „Vier-Augen nicht erfüllbar: …“ wörtlich von der Route; der Verlauf. `id` darf das Kennzeichen sein (Sprung von
 * der Maßnahmen-Seite).
 */
export function FeststellungSeite({ id, onListe, onAudit }: { id: string; onListe: () => void; onAudit: (id: string) => void }) {
  const [daten, setDaten] = useState<FeststellungMitVerlauf | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [versuch, setVersuch] = useState(0);
  const sub = useRollen().selbst?.kennung ?? null;
  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    const laden = A.istKennzeichen(id)
      ? api.energiemanagementFeststellungen().then((l) => {
          const f = l.feststellungen.find((x) => x.kennzeichen === id);
          if (!f) throw new ApiError(404, 'nicht gefunden', { code: 'nicht_gefunden' });
          return api.energiemanagementFeststellung(f.id);
        })
      : api.energiemanagementFeststellung(id);
    laden.then(
      (d) => aktiv && setDaten(d),
      (e) => aktiv && setFehler(ablehnung(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);
  const fertig = (d: FeststellungMitVerlauf) => {
    setDialog(null);
    setSatz(null);
    setDaten(d);
  };
  const zurueck = (
    <button type="button" className="vp-ez-zurueck" onClick={onListe} data-testid="feststellung-zurueck">
      <Icon name="chevron-left" size={18} />
      Zu den Feststellungen
    </button>
  );
  if (!daten) {
    return (
      <div className="vp-ez" data-testid="feststellung-seite">
        {zurueck}
        {fehler ? <p className="vp-ez-fehler" role="alert">{fehler}</p> : <p className="vp-ez-leise">Wird geladen …</p>}
        <div className="vp-em-saetze">
          <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
          <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
        </div>
      </div>
    );
  }
  const { feststellung: f, eintraege, massnahmen, wirksamkeit, vieraugen, verlauf } = daten;
  const offen = f.zustand === 'offen';
  const antrag = wirksamkeit.find((s) => s.status === 'beantragt') ?? null;
  const pruefbar = A.wirksamkeitPruefbar(massnahmen);
  const mitVierAugen = vieraugen.an;
  async function bestaetigen() {
    setSatz(null);
    try {
      fertig(await api.energiemanagementFeststellungFreigeben(f.id));
    } catch (err) {
      setSatz(ablehnung(err));
    }
  }
  return (
    <div className="vp-ez" data-testid="feststellung-seite">
      {zurueck}
      <div className="vp-ez-kopf">
        <h1>{`Feststellung ${f.kennzeichen}`}</h1>
        <p className="vp-ez-satz" data-testid="feststellung-kopf">
          {A.feststellungKopf(f)}
        </p>
        {offen && f.lage.satz && (
          <p className="vp-ez-frist" data-testid="feststellung-frist">
            {`Frist ${E.tagText(f.frist)}: ${f.lage.satz}`}
          </p>
        )}
        {f.quelle.art === 'internes_audit' && f.quelle.audit_id && (
          <p className="vp-ez-herkunft">
            <a href={hashForRoute(auditRoute(f.quelle.audit_id))} onClick={(ev) => (ev.preventDefault(), onAudit(f.quelle.audit_id!))} data-testid="feststellung-sprung-audit">
              {`Internes Audit ${f.quelle.kennung ?? ''}`.trim()}
            </a>
          </p>
        )}
      </div>

      <section className="vp-ez-karte" aria-label="Was nicht erfüllt ist" data-testid="feststellung-inhalt">
        <blockquote className="vp-em-wortlaut">{f.wortlaut}</blockquote>
        <dl className="vp-em-dl">
          <dt>Vorgabe</dt>
          <dd data-testid="feststellung-vorgabe">{A.vorgabeWort(f.vorgabe)}</dd>
          <dt>Bezug</dt>
          <dd data-testid="feststellung-bezug">{A.bezugWort(f.bezug, (a) => WOERTER.aufgabe[a] ?? a)}</dd>
          <dt>{UEMS_EINGETRAGEN_VON}</dt>
          <dd>{`${f.eingetragen.akteur.name} am ${E.tagText(f.eingetragen.am.slice(0, 10))}`}</dd>
        </dl>
      </section>

      <section className="vp-ez-karte" aria-label="Einträge" data-testid="feststellung-eintraege">
        <div className="vp-em-kopf">
          <h2>Einträge</h2>
          {offen && (
            <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
              <Button variant="outline" size="sm" onClick={() => setDialog('eintrag')} data-testid="feststellung-eintrag">
                {A.KNOPF_EINTRAG}
              </Button>
            </EinsichtRecht>
          )}
        </div>
        {eintraege.length === 0 ? (
          <p className="vp-ez-leise">Noch kein Eintrag — etwa die sofortige Behebung oder die Ursache als Aussage einer Person.</p>
        ) : (
          <ul className="vp-ez-verlauf">
            {eintraege.map((e) => (
              <li key={e.id} data-testid={`feststellung-eintrag-${e.art}`}>
                {A.eintragSatz(e)}
                <span className="vp-ez-leise">{` — ${UEMS_EINGETRAGEN_VON} ${e.eingetragen.akteur.name}`}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="vp-ez-karte" aria-label={UEMS_MASSNAHMEN} data-testid="feststellung-massnahmen">
        <h2>{UEMS_MASSNAHMEN}</h2>
        {massnahmen.length === 0 ? (
          <p className="vp-ez-leise">Noch keine Maßnahme zu dieser Feststellung.</p>
        ) : (
          <table className="vp-ez-tafel">
            <thead>
              <tr>
                <th scope="col">Maßnahme</th>
                <th scope="col">Verantwortlich</th>
                <th scope="col">Termin</th>
                <th scope="col">Zustand</th>
              </tr>
            </thead>
            <tbody>
              {massnahmen.map((m) => (
                <tr key={m.id} data-testid={`feststellung-massnahme-${m.kennzeichen}`}>
                  <td>
                    <a href={hashForRoute(massnahmeRoute(m.id))}>{`${m.kennzeichen} ${m.titel}`}</a>
                  </td>
                  <td data-label="Verantwortlich">{m.verantwortlich.name}</td>
                  <td data-label="Termin" className="vp-em-tag">{E.tagText(m.termin)}</td>
                  <td data-label="Zustand">
                    {MASSNAHME_ZUSTAND_WORT[m.zustand]}
                    {m.umgesetzt_am ? ` am ${E.tagText(m.umgesetzt_am)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {offen && (
          <MassnahmeAnlegen
            vorbelegung={{ herkunft: 'nichtkonformitaet', herkunftKennung: f.kennzeichen }}
            standort={null}
            onAngelegt={() => setVersuch((v) => v + 1)}
          />
        )}
      </section>

      <section className="vp-ez-karte" aria-label={UEMS_WIRKSAMKEIT} data-testid="feststellung-wirksamkeit">
        <h2>{UEMS_WIRKSAMKEIT}</h2>
        {wirksamkeit.length > 0 && (
          <ul className="vp-ez-verlauf">
            {wirksamkeit.map((s) => (
              <li key={s.nr} data-testid={`feststellung-stand-${s.nr}`}>
                <p className="vp-ez-satz">{s.status === 'freigegeben' ? A.standSatz(s) : `Stand Nr. ${s.nr}: ${A.ERGEBNIS_WORT[s.ergebnis]} — ${A.STAND_STATUS_WORT[s.status]}`}</p>
                <p className="vp-ez-leise">{`„${s.begruendung}“ — ${UEMS_EINGETRAGEN_VON} ${s.eingetragen.akteur.name}${s.zweite_person ? `, bestätigt von ${s.zweite_person.akteur.name}` : ''}${s.ablehnung_begruendung ? ` · abgelehnt: ${s.ablehnung_begruendung}` : ''}`}</p>
                <p className="vp-ez-pruefsumme" title={s.pruefsumme}>{`Prüfsumme ${E.kurz(s.pruefsumme)}`}</p>
              </li>
            ))}
          </ul>
        )}
        {offen && !pruefbar && !antrag && (
          <p className="vp-ez-leise" data-testid="feststellung-noch-nicht">
            {SAETZE.wirksamkeit_noch_nicht}
          </p>
        )}
        {offen && mitVierAugen && vieraugen.satz && (
          <p className="vp-ez-satz" data-testid="feststellung-vieraugen">
            {vieraugen.satz}
          </p>
        )}
        {offen && (
          <EinsichtGruppe aktion={[E.RECHT_FREIGEBEN]} standort={null}>
            <div className="vp-ez-aktionen">
              {antrag ? (
                <EinsichtRecht aktion={E.RECHT_FREIGEBEN} standort={null}>
                  {antrag.eingetragen.akteur.sub !== sub && (
                    <Button onClick={() => void bestaetigen()} data-testid="feststellung-bestaetigen">
                      {A.KNOPF_ANTRAG_BESTAETIGEN}
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => setDialog('ablehnen')} data-testid="feststellung-ablehnen">
                    {A.KNOPF_ANTRAG_ABLEHNEN}
                  </Button>
                </EinsichtRecht>
              ) : (
                <EinsichtRecht aktion={E.RECHT_FREIGEBEN} standort={null}>
                  {pruefbar && (
                    <Button onClick={() => setDialog('wirksamkeit')} data-testid="feststellung-wirksamkeit-pruefen">
                      {A.KNOPF_WIRKSAMKEIT}
                    </Button>
                  )}
                  {massnahmen.length === 0 && (
                    <Button variant="outline" onClick={() => setDialog('ohne_massnahme')} data-testid="feststellung-ohne-massnahme">
                      {A.KNOPF_OHNE_MASSNAHME}
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => setDialog('zurueckgenommen')} data-testid="feststellung-zuruecknehmen">
                    {A.KNOPF_ZURUECKNEHMEN}
                  </Button>
                </EinsichtRecht>
              )}
            </div>
          </EinsichtGruppe>
        )}
        {satz && (
          <p className="vp-ez-fehler" role="alert">
            {satz}
          </p>
        )}
      </section>

      <section className="vp-ez-karte" aria-label="Verlauf">
        <h2>Verlauf</h2>
        <ul className="vp-ez-verlauf" data-testid="feststellung-verlauf">
          {verlauf.map((v) => (
            <li key={v.id}>
              {`${A.FESTSTELLUNG_VERLAUF_WORT[v.art] ?? v.art} — ${v.akteur.name}, ${E.tagText(v.zeit.slice(0, 10))}${v.begruendung ? `: ${v.begruendung}` : ''}`}
            </li>
          ))}
        </ul>
      </section>

      <div className="vp-em-saetze">
        <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </div>

      {dialog === 'eintrag' && <EintragDialog id={f.id} onClose={() => setDialog(null)} onFertig={fertig} />}
      {(dialog === 'wirksamkeit' || dialog === 'ohne_massnahme' || dialog === 'zurueckgenommen') && (
        <StandDialog id={f.id} art={dialog} vieraugen={mitVierAugen} onClose={() => setDialog(null)} onFertig={fertig} />
      )}
      {dialog === 'ablehnen' && <AntragAblehnenDialog id={f.id} onClose={() => setDialog(null)} onFertig={fertig} />}
    </div>
  );
}
