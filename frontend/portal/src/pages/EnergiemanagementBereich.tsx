import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type EnergiemanagementDokumentKurz } from '../api';
import { DokumentAnlegenDialog } from '../components/DokumentDialoge';
import { EinsichtRecht } from '../components/EinsichtRecht';
import { EnergiemanagementAufgaben } from '../components/EnergiemanagementAufgaben';
import { EnergiemanagementVerantwortung } from '../components/EnergiemanagementVerantwortung';
import { VerzeichnisTabelle } from '../components/VerzeichnisTabelle';
import { ZuschnittHilfe } from '../components/ZuschnittHilfe';
import '../components/BereichTabs.css';
import { SAETZE } from '../energiemanagement';
import * as E from '../energiemanagementPortal';
import { UEMS_DOKUMENTE, UEMS_ENERGIEMANAGEMENT, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import type { EnergiemanagementReiter } from '../nav';
import { useRollen } from '../rollen';
import { DokumentSeite } from './DokumentSeite';
import { EnergiemanagementPersonSeite } from './EnergiemanagementPersonSeite';
import './Energiemanagement.css';
import './Verbesserung.css';

/**
 * Der Bereich „Energiemanagement“ (UEMS AP-19 IP-9, §5.1, §6.3; `#/portfolio/energiemanagement`, nur mit
 * `energiemanagement.ansehen`) — die neunte Seite am Unternehmen. Heute drei Reiter, Verzeichnis · Dokumente · Aufgaben
 * (die übrigen vier kommen mit ihren Paketen, in der Reihenfolge von §6.3), die Seite eines Dokuments und die
 * Zuschnitt-Hilfe „Was VoltPilot führt — was bei Ihnen liegt.“ als eigene Seite, verlinkt aus dem Kopf.
 * ⚠ Reiter-Reihenfolge und Ort der Zuschnitt-Hilfe ließ das Konzept offen (§6.3, Anhang B.5 Z3); der PR von IP-9
 * zeigt je zwei Varianten mit echten Bildern. Gebaut ist die empfohlene: das Verzeichnis ist der erste Reiter (§5.1),
 * die Hilfe eine eigene Seite statt eines Abschnitts über dem Verzeichnis.
 * Jede Fläche trägt Grenz-Satz UND Verantwortungs-Satz (SP4, `copy.test.ts` Block „Energiemanagement“).
 * IP-13: Reiter „Aufgaben“ (mit „Wer ist wofür verantwortlich“ als eigener Ansicht darunter, `…/verantwortung`) und die
 * Seite einer Person; wer die Rolle „Einsicht“ hat, liest im Kopf den Rollen-Satz und an jedem Schreib-Knopf den Leer-Satz.
 */
export function EnergiemanagementBereich({
  reiter,
  dokumentId,
  personId = null,
  onReiter,
  onDokument,
  onPerson,
}: {
  reiter: EnergiemanagementReiter;
  dokumentId: string | null;
  personId?: string | null;
  onReiter: (r: EnergiemanagementReiter) => void;
  onDokument: (id: string) => void;
  onPerson: (id: string) => void;
}) {
  const rollen = useRollen();
  if (dokumentId) return <DokumentSeite id={dokumentId} onListe={() => onReiter('dokumente')} />;
  if (personId) return <EnergiemanagementPersonSeite id={personId} onListe={() => onReiter('aufgaben')} />;
  if (reiter === 'zuschnitt') return <ZuschnittHilfe onZurueck={() => onReiter('verzeichnis')} />;
  // „Wer ist wofür verantwortlich“ steht unter dem Reiter „Aufgaben“ (§6.3 nennt sieben Reiter, diese Ansicht ist keiner).
  const aktiv = reiter === 'verantwortung' ? 'aufgaben' : reiter;
  return (
    <div className="vp-ez" data-testid="energiemanagement-bereich">
      <div className="vp-em-kopf">
        <h1>{UEMS_ENERGIEMANAGEMENT}</h1>
        <button type="button" className="vp-em-hilfe" onClick={() => onReiter('zuschnitt')} data-testid="energiemanagement-zuschnitt-link">
          {SAETZE.zuschnitt_titel}
        </button>
      </div>
      {E.mitEinsicht(rollen.selbst) && (
        <p className="vp-ez-satz" data-testid="einsicht-rolle">
          {SAETZE.einsicht_rolle}
        </p>
      )}
      <div className="vp-bereich-tabs" role="tablist" aria-label={UEMS_ENERGIEMANAGEMENT}>
        {E.REITER.map((r) => (
          <button
            key={r.key}
            type="button"
            role="tab"
            aria-selected={aktiv === r.key}
            className={`vp-bereich-tab${aktiv === r.key ? ' active' : ''}`}
            data-testid={`energiemanagement-reiter-${r.key}`}
            onClick={() => onReiter(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>
      {reiter === 'dokumente' ? (
        <DokumenteRegister onOeffnen={onDokument} />
      ) : reiter === 'aufgaben' ? (
        <EnergiemanagementAufgaben onPerson={onPerson} onVerantwortung={() => onReiter('verantwortung')} />
      ) : reiter === 'verantwortung' ? (
        <EnergiemanagementVerantwortung onPerson={onPerson} onZurueck={() => onReiter('aufgaben')} />
      ) : (
        <VerzeichnisTabelle onDokument={onDokument} />
      )}
      <div className="vp-em-saetze" data-testid="energiemanagement-saetze">
        <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </div>
    </div>
  );
}

/** Reiter „Dokumente“ (DK1): je Dokument Kennzeichen, Art, Titel, Bezug, Zustand, gültige Fassung und Überprüfung. */
function DokumenteRegister({ onOeffnen }: { onOeffnen: (id: string) => void }) {
  const [liste, setListe] = useState<EnergiemanagementDokumentKurz[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [anlegen, setAnlegen] = useState(false);
  useEffect(() => {
    let aktiv = true;
    api.energiemanagementDokumente().then(
      (r) => aktiv && setListe(r.dokumente),
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    return () => {
      aktiv = false;
    };
  }, []);
  return (
    <section className="vp-ez-karte" aria-label={UEMS_DOKUMENTE} data-testid="dokumente-register">
      <div className="vp-em-kopf">
        <h2>{UEMS_DOKUMENTE}</h2>
        <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
          <Button onClick={() => setAnlegen(true)} data-testid="dokument-anlegen">
            {E.KNOPF_ANLEGEN}
          </Button>
        </EinsichtRecht>
      </div>
      {fehler ? (
        <p className="vp-ez-fehler" role="alert">{fehler}</p>
      ) : liste === null ? (
        <p className="vp-ez-leise">Wird geladen …</p>
      ) : liste.length === 0 ? (
        <p className="vp-ez-satz" data-testid="dokumente-leer">{SAETZE.verzeichnis_leer}</p>
      ) : (
        <table className="vp-ez-tafel">
          <thead>
            <tr>
              <th scope="col">Dokument</th>
              <th scope="col">Art</th>
              <th scope="col">Bezug</th>
              <th scope="col">Zustand</th>
              <th scope="col">Überprüfung</th>
            </tr>
          </thead>
          <tbody>
            {liste.map((d) => (
              <tr key={d.id} data-testid={`dokument-zeile-${d.kennzeichen}`}>
                <td>
                  <button type="button" className="vp-ez-zeile-knopf" onClick={() => onOeffnen(d.id)}>
                    {d.kennzeichen} {d.titel}
                  </button>
                </td>
                <td data-label="Art">{d.art_wort}</td>
                <td data-label="Bezug">{E.bezugWort(d.bezug)}</td>
                <td data-label="Zustand">
                  {E.ZUSTAND_WORT[d.zustand]}
                  {d.gueltige_fassung ? ` · Fassung ${d.gueltige_fassung}` : ''}
                </td>
                <td data-label="Überprüfung">
                  {d.ueberpruefung?.satz ?? (d.ueberpruefung?.faellig_am ? `fällig am ${E.tagText(d.ueberpruefung.faellig_am)}` : '—')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {anlegen && (
        <DokumentAnlegenDialog
          onClose={() => setAnlegen(false)}
          onAngelegt={(d) => {
            setAnlegen(false);
            onOeffnen(d.id);
          }}
        />
      )}
    </section>
  );
}
