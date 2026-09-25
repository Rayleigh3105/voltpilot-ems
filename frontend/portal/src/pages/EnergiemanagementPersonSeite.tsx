import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type EnergiemanagementPersonMitVerlauf, type EnergiemanagementZuordnung } from '../api';
import { heute } from '../bewertung';
import { EinsichtRecht } from '../components/EinsichtRecht';
import { PersonAendernDialog } from '../components/EnergiemanagementAufgabeDialoge';
import { NachweiseDerPerson } from '../components/Nachweise';
import * as E from '../energiemanagementPortal';
import { UEMS_AUFGABEN_IM_ENERGIEMANAGEMENT, UEMS_NORMGRENZE, UEMS_PERSON_IM_ENERGIEMANAGEMENT, UEMS_VERANTWORTUNG } from '../glossar';
import './Energiemanagement.css';
import './Verbesserung.css';

/**
 * Die Seite einer Person im Energiemanagement (UEMS AP-19 IP-13, PA1, PA5; `#/portfolio/energiemanagement/personen/{id}`):
 * Name, Funktion, Organisation, Konto — ohne Konto der Satz aus §5.8 („… erscheint als ‚entschieden von‘.“) —, seit/bis,
 * ihre Aufgaben (als Person und als Vertretung, auch beendete) und der Verlauf der Route mit jeder Konto-Verknüpfung.
 * Gelöscht wird eine Person nie; „bis“ beendet sie. Seit IP-15 die Nachweise an der Person und an ihren Aufgaben (R8)
 * mit „Nachweis festhalten“ (Bezug die Person, Art Kompetenz).
 */
export function EnergiemanagementPersonSeite({ id, onListe }: { id: string; onListe: () => void }) {
  const [p, setP] = useState<EnergiemanagementPersonMitVerlauf | null>(null);
  const [zuordnungen, setZuordnungen] = useState<EnergiemanagementZuordnung[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [aendern, setAendern] = useState(false);
  const tag = heute();
  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    api.energiemanagementPerson(id).then(
      (r) => aktiv && setP(r),
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    // Aufgaben liest nur, wer unternehmensweit liest — sonst bleibt der Abschnitt leer, ohne Satz (IP-6).
    api.energiemanagementAufgaben(tag).then(
      (r) => aktiv && setZuordnungen(E.zuordnungenVon(r.zuordnungen, id)),
      () => aktiv && setZuordnungen([]),
    );
    return () => {
      aktiv = false;
    };
  }, [id, tag]);

  const zurueck = (
    <button type="button" className="vp-em-hilfe" onClick={onListe} data-testid="person-zurueck">
      ← {UEMS_AUFGABEN_IM_ENERGIEMANAGEMENT}
    </button>
  );
  if (fehler) {
    return (
      <div className="vp-ez" data-testid="person-seite">
        {zurueck}
        <p className="vp-ez-fehler" role="alert">{fehler}</p>
      </div>
    );
  }
  if (!p) return <p className="vp-ez-leise">Wird geladen …</p>;
  const person = p.person;
  return (
    <div className="vp-ez" data-testid="person-seite">
      {zurueck}
      <div className="vp-ez-kopf">
        <p className="vp-ez-leise">{UEMS_PERSON_IM_ENERGIEMANAGEMENT}</p>
        <h1>{person.name}</h1>
        <p className="vp-ez-satz" data-testid="person-kopf">
          {[person.funktion, person.organisation, person.konto ? `mit Konto${person.konto.name ? ` (${person.konto.name})` : ''}` : null].filter(Boolean).join(' · ')}
        </p>
        {!person.konto && (
          <p className="vp-ez-leise" data-testid="person-ohne-konto">
            {E.personOhneKontoSatz(person)}
          </p>
        )}
        <p className="vp-ez-leise" data-testid="person-zeitraum">
          {person.seit ? `Seit ${E.tagText(person.seit)}` : 'Ohne Beginn'}
          {person.bis ? ` · bis ${E.tagText(person.bis)}` : ''}
          {person.zustand === 'beendet' ? ` · beendet${person.beendet_begruendung ? `: ${person.beendet_begruendung}` : ''}` : ''}
        </p>
      </div>
      {person.zustand === 'aktiv' && (
        <div className="vp-ez-aktionen">
          <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
            <Button variant="ghost" onClick={() => setAendern(true)} data-testid="person-aendern">
              {E.KNOPF_PERSON_AENDERN}
            </Button>
          </EinsichtRecht>
        </div>
      )}
      <section className="vp-ez-karte" aria-label={UEMS_AUFGABEN_IM_ENERGIEMANAGEMENT} data-testid="person-aufgaben">
        <h2>{UEMS_AUFGABEN_IM_ENERGIEMANAGEMENT}</h2>
        {zuordnungen === null ? (
          <p className="vp-ez-leise">Wird geladen …</p>
        ) : zuordnungen.length === 0 ? (
          <p className="vp-ez-leise">Keine Aufgabe zugeordnet.</p>
        ) : (
          <ul className="vp-em-kurzliste">
            {zuordnungen.map((z) => (
              <li key={z.id} data-testid={`person-aufgabe-${z.aufgabe}`}>
                <strong>{z.wort}</strong>
                {z.vertretung?.id === id ? ` — Vertretung von ${z.person.name}` : ''}
                {E.zuordnungRest(z.vertretung?.id === id ? { ...z, vertretung: null } : z, tag)}
                {z.zustand === 'beendet' && z.beendet_begruendung ? ` Beendet: ${z.beendet_begruendung}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
      <NachweiseDerPerson person={person} />
      <section className="vp-ez-karte" aria-label="Verlauf" data-testid="person-verlauf">
        <h2>Verlauf</h2>
        <ul className="vp-em-kurzliste">
          {p.verlauf.map((v) => (
            <li key={v.id}>
              {E.tagText(v.zeit)} · {E.VERLAUF_WORT[v.art] ?? v.art} — eingetragen von {v.akteur.name}
              {v.begruendung ? `: ${v.begruendung}` : ''}
            </li>
          ))}
        </ul>
      </section>
      <div className="vp-em-saetze">
        <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </div>
      {aendern && (
        <PersonAendernDialog
          person={person}
          onClose={() => setAendern(false)}
          onGeaendert={(neu) => {
            setAendern(false);
            setP(neu);
          }}
        />
      )}
    </div>
  );
}
