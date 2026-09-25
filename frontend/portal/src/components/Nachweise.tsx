import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type EnergiemanagementDokument, type EnergiemanagementNachweis } from '../api';
import { SAETZE } from '../energiemanagement';
import * as E from '../energiemanagementPortal';
import { UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import { dokumentRoute, hashForRoute } from '../nav';
import { useRollen } from '../rollen';
import { DokumentAnlegenDialog, FassungDialog, FreigabeDialog } from './DokumentDialoge';
import { EinsichtRecht } from './EinsichtRecht';
import '../pages/Energiemanagement.css';
import '../pages/Verbesserung.css';

/**
 * UEMS AP-19 IP-15 (§5.3, R7, R8): der Abschnitt „Nachweise“ an der Seite eines Energieeinsatzes (AP-16-Fläche) und an
 * der Seite einer Person — die Dokumente, deren Bezug dieser Einsatz bzw. diese Person (und ihre Aufgaben) ist, je mit
 * dem Ort der gültigen Fassung wörtlich von der Route („Geführt in Ihrem System: …“), der Überprüfung beim Abruf und den
 * Bekanntmachungen. Die Leser sind die von IP-14; hier wird nichts gerechnet.
 *
 * „Nachweis festhalten“ öffnet den Dokument-Dialog mit dem Bezug der Seite, danach die erste Fassung als Verweis (die
 * Prüfsumme bildet der Browser, die Datei bleibt auf dem Rechner) und — wer freigeben darf — die Freigabe. Jeder Schritt
 * ist ein eigener Dialog mit eigener Route; wer abbricht, findet den Entwurf im Abschnitt und führt ihn auf der
 * Dokument-Seite weiter.
 */
type Schritt = { art: 'anlegen' } | { art: 'fassung'; d: EnergiemanagementDokument } | { art: 'freigabe'; d: EnergiemanagementDokument } | null;

function NachweisZeile({ n }: { n: EnergiemanagementNachweis }) {
  const pruefsumme = E.nachweisPruefsumme(n);
  const ueberpruefung = E.nachweisUeberpruefung(n);
  const aufgabe = n.bezug.aufgabe;
  return (
    <li className="vp-nw-zeile" data-testid={`nachweis-${n.kennzeichen}`}>
      <a className="vp-nw-titel" href={hashForRoute(dokumentRoute(n.id))}>
        <span className="vp-nw-kz">{n.kennzeichen}</span> {n.titel}
      </a>
      <span className="vp-ez-leise">
        {n.art_wort}
        {aufgabe ? ` · zur Aufgabe „${aufgabe.wort ?? aufgabe.aufgabe}“` : ''}
      </span>
      <span data-testid="nachweis-ort">{E.nachweisOrt(n)}</span>
      {n.ort?.adresse_als_verweis && n.ort.adresse && (
        <span className="vp-ez-leise vp-nw-adresse" data-testid="nachweis-adresse">
          {n.ort.adresse}
        </span>
      )}
      {pruefsumme && (
        <span className="vp-ez-leise" title={n.ort?.sha256 ?? undefined} data-testid="nachweis-pruefsumme">
          {pruefsumme}
        </span>
      )}
      {ueberpruefung && (
        <span className="vp-ez-leise" data-testid="nachweis-ueberpruefung">
          {ueberpruefung}
        </span>
      )}
      {n.bekanntmachungen.map((b) => (
        <span key={`${b.am}-${b.kreis}`} className="vp-ez-leise" data-testid="nachweis-bekanntmachung">
          {b.satz}
        </span>
      ))}
    </li>
  );
}

function NachweiseAbschnitt({
  testid,
  laden,
  fest,
  karte,
  verantwortung = false,
  saetze = false,
}: {
  testid: string;
  laden: () => Promise<{ nachweise: EnergiemanagementNachweis[] }>;
  fest: E.NachweisBezug;
  karte: string;
  /** Nur der Verantwortungs-Satz — auf einer fremden Fläche (Einsatz-Seite), die den Grenz-Satz schon am Fuß trägt. */
  verantwortung?: boolean;
  /** Grenz- und Verantwortungs-Satz, wo der Abschnitt allein steht (auf der Personen-Seite stehen sie am Fuß). */
  saetze?: boolean;
}) {
  const rollen = useRollen();
  const [liste, setListe] = useState<EnergiemanagementNachweis[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [schritt, setSchritt] = useState<Schritt>(null);

  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    laden().then(
      (r) => aktiv && setListe(r.nachweise),
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    return () => {
      aktiv = false;
    };
    // `laden` hängt nur an der Kennung des Bezugs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fest.id, versuch]);

  const fertig = () => {
    setSchritt(null);
    setVersuch((v) => v + 1);
  };
  const darfFreigeben = (d: EnergiemanagementDokument) => rollen.darf(E.RECHT_FREIGEBEN, d.bezug.standort?.id ?? null);

  return (
    <section className={`${karte} vp-nw`} aria-labelledby={`${testid}-titel`} data-testid={testid}>
      <div className="vp-em-kopf">
        <h2 id={`${testid}-titel`}>{E.NACHWEISE}</h2>
        {/* Das Recht entscheidet die Route am Standort des Einsatzes; hier genügt das Unternehmen (wie „Maßnahme anlegen“). */}
        <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
          <Button size="sm" variant="outline" iconLeft={<Icon name="plus" size={16} />} onClick={() => setSchritt({ art: 'anlegen' })} data-testid="nachweis-festhalten">
            {E.KNOPF_NACHWEIS}
          </Button>
        </EinsichtRecht>
      </div>
      {fehler ? (
        <p className="vp-ez-fehler" role="alert">
          {fehler}
        </p>
      ) : liste === null ? (
        <p className="vp-ez-leise">Wird geladen …</p>
      ) : liste.length === 0 ? (
        <p className="vp-ez-leise" data-testid="nachweise-leer">
          {SAETZE.verzeichnis_leer}
        </p>
      ) : (
        <ul className="vp-nw-liste">
          {liste.map((n) => (
            <NachweisZeile key={n.id} n={n} />
          ))}
        </ul>
      )}
      {(verantwortung || saetze) && (
        <div className="vp-em-saetze">
          <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
          {saetze && <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>}
        </div>
      )}

      {schritt?.art === 'anlegen' && (
        <DokumentAnlegenDialog fest={fest} onClose={fertig} onAngelegt={(d) => setSchritt({ art: 'fassung', d })} />
      )}
      {schritt?.art === 'fassung' && (
        <FassungDialog
          dokument={schritt.d}
          form="verweis"
          onClose={fertig}
          onGespeichert={(d) => (darfFreigeben(d) && E.offeneFassung(d) ? setSchritt({ art: 'freigabe', d }) : fertig())}
        />
      )}
      {schritt?.art === 'freigabe' && E.offeneFassung(schritt.d) && (
        <FreigabeDialog dokument={schritt.d} fassung={E.offeneFassung(schritt.d)!} onClose={fertig} onGespeichert={fertig} />
      )}
    </section>
  );
}

/** Der Abschnitt „Nachweise“ an der Seite eines Energieeinsatzes (R7) — nur mit `energiemanagement.ansehen`. */
export function NachweiseAmEinsatz({ einsatz }: { einsatz: { id: string; kennzeichen: string; name: string } }) {
  const { selbst } = useRollen();
  if (!E.darfAnsehen(selbst)) return null;
  return (
    <NachweiseAbschnitt
      testid="einsatz-nachweise"
      laden={() => api.energiemanagementNachweiseAmEinsatz(einsatz.id)}
      fest={{ art: 'energieeinsatz', id: einsatz.id, wort: `${einsatz.kennzeichen} ${einsatz.name}` }}
      karte="vp-bw-karte"
      verantwortung
    />
  );
}

/** Die Nachweise an einer Person und an ihren Aufgaben (R8) — die Seite trägt beide Sätze selbst. */
export function NachweiseDerPerson({ person }: { person: { id: string; name: string } }) {
  return (
    <NachweiseAbschnitt
      testid="person-nachweise"
      laden={() => api.energiemanagementNachweiseDerPerson(person.id)}
      fest={{ art: 'person', id: person.id, wort: person.name }}
      karte="vp-ez-karte"
    />
  );
}
