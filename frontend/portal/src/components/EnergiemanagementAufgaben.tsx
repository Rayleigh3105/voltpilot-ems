import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type EnergiemanagementAufgaben, type EnergiemanagementPerson, type EnergiemanagementZuordnung } from '../api';
import { heute } from '../bewertung';
import * as E from '../energiemanagementPortal';
import { UEMS_AUFGABEN_IM_ENERGIEMANAGEMENT, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import { useRollen } from '../rollen';
import { AufgabeZuordnenDialog, ZuordnungBeendenDialog } from './EnergiemanagementAufgabeDialoge';
import { EinsichtGruppe } from './EinsichtRecht';
import { PersonAnlegenDialog } from './DokumentDialoge';
import { Recht } from './Recht';
import { VpDatePicker } from './VpDatePicker';

/** Eine Zuordnung: der Name öffnet die Personen-Seite, dahinter seit/ab, Vertretung, „entschieden von“, Beleg, Beschluss. */
function Zuordnung({ z, tag, onPerson, onBeenden }: { z: EnergiemanagementZuordnung; tag: string; onPerson: (id: string) => void; onBeenden: (() => void) | null }) {
  return (
    <div className="vp-em-zuordnung" data-testid={`zuordnung-${z.aufgabe}-${z.person.kuerzel ?? z.person.id}`}>
      <p className="vp-ez-satz">
        <button type="button" className="vp-ez-zeile-knopf" onClick={() => onPerson(z.person.id)}>
          {z.person.name}
        </button>
        {E.zuordnungRest(z, tag)}
      </p>
      {(z.beleg?.ablage || z.beschluss_kennung) && (
        <p className="vp-ez-leise">
          {[z.beleg?.ablage ? `Beleg: ${[z.beleg.bezeichnung, z.beleg.ablage].filter(Boolean).join(' · ')}` : null, z.beschluss_kennung ? `Beschluss ${z.beschluss_kennung}` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {onBeenden && (
        <Button variant="ghost" size="sm" onClick={onBeenden} data-testid="zuordnung-beenden">
          {E.KNOPF_BEENDEN}
        </Button>
      )}
    </div>
  );
}

/**
 * Reiter „Aufgaben“ (UEMS AP-19 IP-13, PA1–PA3, §5.2, R5): die Aufgaben des Vokabulars mit ihren laufenden Zuordnungen
 * am gewählten Tag — Person, Vertretung, seit, „entschieden von“, Beleg — und jede Aufgabe ohne Person mit dem Satz der
 * Route („… — keine Person festgelegt.“, ein Satz, keine Warnung); darunter die Personen im Energiemanagement, auch ohne
 * Konto. Zuordnen und Beenden nur mit `energiemanagement.verwalten`; mit „Einsicht“ steht dort der Leer-Satz.
 * `saetze` zeigt Grenz- und Verantwortungs-Satz, wo der Reiter allein steht (im Bereich stehen sie am Fuß).
 */
export function EnergiemanagementAufgaben({
  onPerson,
  onVerantwortung,
  saetze = false,
}: {
  onPerson: (id: string) => void;
  onVerantwortung: () => void;
  saetze?: boolean;
}) {
  const rollen = useRollen();
  const darf = rollen.darf(E.RECHT_VERWALTEN, null);
  const [tag, setTag] = useState(() => heute());
  const [stand, setStand] = useState<EnergiemanagementAufgaben | null>(null);
  const [personen, setPersonen] = useState<EnergiemanagementPerson[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [neu, setNeu] = useState(0);
  const [zuordnen, setZuordnen] = useState<{ aufgabe: string | null } | null>(null);
  const [beenden, setBeenden] = useState<EnergiemanagementZuordnung | null>(null);
  const [personDialog, setPersonDialog] = useState(false);
  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    Promise.all([api.energiemanagementAufgaben(tag), api.energiemanagementPersonen()]).then(
      ([a, p]) => {
        if (!aktiv) return;
        setStand(a);
        setPersonen(p.personen);
      },
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [tag, neu]);
  const gespeichert = () => {
    setZuordnen(null);
    setBeenden(null);
    setPersonDialog(false);
    setNeu((n) => n + 1);
  };

  return (
    <>
      <section className="vp-ez-karte" aria-label={UEMS_AUFGABEN_IM_ENERGIEMANAGEMENT} data-testid="aufgaben-reiter">
        <div className="vp-em-kopf">
          <h2>{UEMS_AUFGABEN_IM_ENERGIEMANAGEMENT}</h2>
          <button type="button" className="vp-em-hilfe" onClick={onVerantwortung} data-testid="verantwortung-link">
            {E.KNOPF_VERANTWORTUNG}
          </button>
        </div>
        <div className="vp-em-aufgaben-kopf">
          <VpDatePicker label="Stand am" value={tag} onChange={(t) => t && setTag(t)} />
          <div className="vp-ez-aktionen">
            <EinsichtGruppe aktion={[E.RECHT_VERWALTEN]} standort={null}>
              <Recht aktion={E.RECHT_VERWALTEN} standort={null}>
                <Button onClick={() => setZuordnen({ aufgabe: null })} data-testid="aufgabe-zuordnen">
                  {E.KNOPF_ZUORDNEN}
                </Button>
                <Button variant="ghost" onClick={() => setPersonDialog(true)} data-testid="aufgaben-person-anlegen">
                  {E.KNOPF_PERSON}
                </Button>
              </Recht>
            </EinsichtGruppe>
          </div>
        </div>
        {fehler ? (
          <p className="vp-ez-fehler" role="alert">{fehler}</p>
        ) : stand === null ? (
          <p className="vp-ez-leise">Wird geladen …</p>
        ) : (
          <ul className="vp-em-aufgaben" data-testid="aufgaben-liste">
            {stand.aufgaben
              .filter((a) => a.aufgabe !== 'weitere' || a.laufend.length > 0 || E.kuenftige(stand.zuordnungen, a.aufgabe, stand.tag).length > 0)
              .map((a) => {
                const spaeter = E.kuenftige(stand.zuordnungen, a.aufgabe, stand.tag);
                return (
                  <li key={a.aufgabe} className="vp-em-aufgabe" data-testid={`aufgabe-${a.aufgabe}`}>
                    <h3>{a.wort}</h3>
                    {a.satz && (
                      <p className="vp-ez-satz" data-testid="aufgabe-ohne-person">
                        {a.satz}
                      </p>
                    )}
                    {a.laufend.map((z) => (
                      <Zuordnung key={z.id} z={z} tag={stand.tag} onPerson={onPerson} onBeenden={darf ? () => setBeenden(z) : null} />
                    ))}
                    {spaeter.map((z) => (
                      <Zuordnung key={z.id} z={z} tag={stand.tag} onPerson={onPerson} onBeenden={null} />
                    ))}
                    {a.satz && darf && (
                      <Button variant="ghost" size="sm" onClick={() => setZuordnen({ aufgabe: a.aufgabe })} data-testid="aufgabe-zeile-zuordnen">
                        {E.KNOPF_ZUORDNEN}
                      </Button>
                    )}
                  </li>
                );
              })}
          </ul>
        )}
      </section>
      <section className="vp-ez-karte" aria-label="Personen im Energiemanagement" data-testid="personen-liste">
        <h2>Personen im Energiemanagement</h2>
        <p className="vp-ez-leise">Wer im System handelt, hat ein Konto; wer außerhalb entscheidet, prüft oder teilnimmt, ist eine Person — auch ohne Konto.</p>
        {personen && personen.length > 0 && (
          <table className="vp-ez-tafel">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Funktion</th>
                <th scope="col">Konto</th>
                <th scope="col">Seit</th>
              </tr>
            </thead>
            <tbody>
              {personen.map((p) => (
                <tr key={p.id} data-testid={`person-zeile-${p.kuerzel ?? p.id}`}>
                  <td>
                    <button type="button" className="vp-ez-zeile-knopf" onClick={() => onPerson(p.id)}>
                      {p.name}
                    </button>
                    {p.organisation && <span className="vp-ez-unter">{p.organisation}</span>}
                  </td>
                  <td data-label="Funktion">{p.funktion}</td>
                  <td data-label="Konto">{p.konto ? 'mit Konto' : 'ohne Konto'}</td>
                  <td data-label="Seit">
                    {E.tagText(p.seit) || '—'}
                    {p.zustand === 'beendet' ? ` · beendet${p.bis ? ` am ${E.tagText(p.bis)}` : ''}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {saetze && (
        <div className="vp-em-saetze">
          <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
          <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
        </div>
      )}
      {zuordnen && <AufgabeZuordnenDialog aufgabe={zuordnen.aufgabe} ab={tag} onClose={() => setZuordnen(null)} onZugeordnet={gespeichert} />}
      {beenden && <ZuordnungBeendenDialog zuordnung={beenden} ab={tag} onClose={() => setBeenden(null)} onBeendet={gespeichert} />}
      {personDialog && <PersonAnlegenDialog leitung={false} ab={tag} onClose={() => setPersonDialog(false)} onAngelegt={gespeichert} />}
    </>
  );
}
