import { useEffect, useState } from 'react';
import { GrenzHinweis, GrenzSatzBereich } from '../components/GrenzSatz';
import { useReiterRand } from '../reiterRand';
import { Button } from '../../designsystem/components/core/Button';
import { api, type EnergiemanagementDokumentKurz } from '../api';
import { DokumentAnlegenDialog } from '../components/DokumentDialoge';
import { EinsichtRecht } from '../components/EinsichtRecht';
import { EnergiemanagementAudits } from '../components/EnergiemanagementAudits';
import { EnergiemanagementAufgaben } from '../components/EnergiemanagementAufgaben';
import { EnergiemanagementManagementbewertung } from '../components/EnergiemanagementManagementbewertung';
import { EnergiemanagementVerantwortung } from '../components/EnergiemanagementVerantwortung';
import { EnergiemanagementWiedervorlage } from '../components/EnergiemanagementWiedervorlage';
import { Ueberblick } from '../components/nachweisen/Ueberblick';
import { VerzeichnisMonate } from '../components/nachweisen/VerzeichnisMonate';
import { ZuschnittHilfe } from '../components/ZuschnittHilfe';
import '../components/BereichTabs.css';
import { SAETZE } from '../energiemanagement';
import * as E from '../energiemanagementPortal';
import { UEMS_DOKUMENTE, UEMS_ENERGIEMANAGEMENT } from '../glossar';
import type { EnergiemanagementReiter, Route } from '../nav';
import { useRollen } from '../rollen';
import { AuditSeite } from './AuditSeite';
import { DokumentSeite } from './DokumentSeite';
import { EnergiemanagementPersonSeite } from './EnergiemanagementPersonSeite';
import { FeststellungSeite } from './FeststellungSeite';
import { ManagementbewertungSeite } from './ManagementbewertungSeite';
import './Energiemanagement.css';
import './Verbesserung.css';

/**
 * Konzept Nachweisen n1 (Runde 2): die Reiter, die ihren Seitenkopf (`NwKopf`) selbst mitbringen. Für die übrigen
 * steht der Name des Reiters übergangsweise nur als Überschrift für Vorleser da, bis ihr PR den Kopf liefert (Dokumente
 * und Berichte PR 2/3, Audits, Feststellungen, Managementbewertung und Aufgaben PR 4/5) - je Reiter eine Zeile hier.
 */
const EIGENER_KOPF: ReadonlySet<EnergiemanagementReiter> = new Set<EnergiemanagementReiter>([
  'ueberblick',
  'verzeichnis',
  // PR 4: der Reiter „Audits“, auch über `…/feststellungen` geöffnet (Entscheid 17).
  'audits',
  'feststellungen',
  // PR 5: Managementbewertung und Aufgaben.
  'managementbewertung',
  'aufgaben',
]);

/**
 * Der Bereich „Energiemanagement“ (UEMS AP-19 IP-9, §5.1, §6.3; `#/portfolio/energiemanagement`, nur mit
 * `energiemanagement.ansehen`) - in der Navigation die Gruppe „Nachweisen“. Seit Konzept Nachweisen n1 (Runde 2,
 * Entscheide 2, 21, 24, 26) öffnet die Adresse den Überblick (`components/nachweisen/Ueberblick.tsx`); das Verzeichnis
 * liegt eine Ebene tiefer (`…/verzeichnis`, nach Monaten), die Zuschnitt-Hilfe „Was VoltPilot führt“ im Menü des
 * Überblicks. Reiter: Überblick · Dokumente · Audits · Feststellungen · Managementbewertung · Aufgaben (die Berichte
 * reiht die Gruppe hinter den Überblick, die Wiedervorlage steht in der Übersicht).
 * Jeder Reiter trägt seinen eigenen Kopf (`NwKopf`, Titel mit i-Knopf statt Klartext-Satz, Entscheid 24); Grenz-Satz
 * UND Verantwortungs-Satz stehen einmal am Fuß im Hinweis „Was VoltPilot leistet“ (SP4, K7).
 * IP-13: Reiter „Aufgaben“ (mit „Wer ist wofür verantwortlich“ als eigener Ansicht darunter, `…/verantwortung`) und die
 * Seite einer Person; wer die Rolle „Einsicht“ hat, liest den Rollen-Satz und an jedem Schreib-Knopf den Leer-Satz.
 * IP-20: Reiter „Audits“ (Auditprogramm) und „Feststellungen“, die Seiten eines Audits und einer Feststellung.
 * IP-24: Reiter „Managementbewertung“ (je Jahr) mit der Seite einer Managementbewertung. Seit dem Konzept Wiedervorlage
 * w1 ist die Wiedervorlage eine Arbeitsliste mit eigenem Kopf (`EnergiemanagementWiedervorlage`).
 */
export function EnergiemanagementBereich({
  reiter,
  dokumentId,
  personId = null,
  auditId = null,
  feststellungId = null,
  managementbewertungKennung = null,
  onReiter,
  onDokument,
  onPerson,
  onAudit,
  onFeststellung,
  onManagementbewertung,
  onSprung,
  reiterOben = false,
}: {
  reiter: EnergiemanagementReiter;
  dokumentId: string | null;
  personId?: string | null;
  auditId?: string | null;
  feststellungId?: string | null;
  managementbewertungKennung?: string | null;
  onReiter: (r: EnergiemanagementReiter) => void;
  onDokument: (id: string) => void;
  onPerson: (id: string) => void;
  onAudit?: (id: string) => void;
  onFeststellung?: (id: string) => void;
  onManagementbewertung?: (kennung: string) => void;
  /** Der Sprung einer Verzeichnis-Zeile auf ihre Seite, auch außerhalb des Bereichs. */
  onSprung?: (ziel: Route) => void;
  /**
   * K1 (D2): die Reiter stehen schon über der Seite — in der Gruppe „Nachweisen“, die Wiedervorlage in der Übersicht
   * (`PortfolioTabs` mit Gruppen). Dann entfällt die zweite Reiterreihe hier.
   */
  reiterOben?: boolean;
}) {
  const reiterRand = useReiterRand<HTMLDivElement>();
  const rollen = useRollen();
  if (dokumentId) return <DokumentSeite id={dokumentId} onListe={() => onReiter('dokumente')} />;
  if (personId) return <EnergiemanagementPersonSeite id={personId} onListe={() => onReiter('aufgaben')} />;
  const zumAudit = onAudit ?? (() => onReiter('audits'));
  const zurFeststellung = onFeststellung ?? (() => onReiter('audits'));
  if (auditId) return <AuditSeite id={auditId} onListe={() => onReiter('audits')} onFeststellung={zurFeststellung} />;
  if (feststellungId) return <FeststellungSeite id={feststellungId} onListe={() => onReiter('audits')} onAudit={zumAudit} />;
  if (managementbewertungKennung) return <ManagementbewertungSeite kennung={managementbewertungKennung} onListe={() => onReiter('managementbewertung')} />;
  const zurManagementbewertung = onManagementbewertung ?? (() => onReiter('managementbewertung'));
  if (reiter === 'zuschnitt') return <ZuschnittHilfe onZurueck={() => onReiter('ueberblick')} />;
  // „Wer ist wofür verantwortlich“ steht unter dem Reiter „Aufgaben“ (§6.3 nennt sieben Reiter, diese Ansicht ist keiner).
  // Entscheid 17 (Konzept Nachweisen n1): die Feststellungen stehen unter „Audits“, ihre Adresse bleibt.
  const aktiv = reiter === 'verantwortung' ? 'aufgaben' : reiter === 'feststellungen' ? 'audits' : reiter;
  const reiterLeiste = !reiterOben && (
    <div ref={reiterRand} className="vp-bereich-tabs" role="tablist" aria-label={UEMS_ENERGIEMANAGEMENT}>
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
  );
  // Konzept Wiedervorlage w1: die Wiedervorlage ist eine eigene Seite unter ihrem eigenen Namen (wie Reiter und Link),
  // ohne den Kopf des Bereichs und ohne Begriffs-Chips; ihre Sätze stehen einmal am Fuß, deshalb außerhalb des Bereichs.
  if (reiter === 'wiedervorlage') return <EnergiemanagementWiedervorlage reiter={reiterLeiste || undefined} />;
  const springe = onSprung ?? (() => onReiter('ueberblick'));
  const titel = E.REITER.find((r) => r.key === aktiv)?.label ?? UEMS_ENERGIEMANAGEMENT;
  return (
    <GrenzSatzBereich>
      <div className="vp-ez vp-nw-bereich" data-testid="energiemanagement-bereich">
        {reiterLeiste}
        {/* Übergang: ein Reiter ohne eigenen Kopf behält seine Überschrift im Inhalt; der Titel steht für Vorleser da. */}
        {!EIGENER_KOPF.has(reiter) && <h1 className="vp-nw-unsichtbar">{titel}</h1>}
        {E.mitEinsicht(rollen.selbst) && (
          <p className="vp-ez-satz" data-testid="einsicht-rolle">
            {SAETZE.einsicht_rolle}
          </p>
        )}
        {reiter === 'dokumente' ? (
          <DokumenteRegister onOeffnen={onDokument} />
        ) : reiter === 'aufgaben' ? (
          <EnergiemanagementAufgaben onPerson={onPerson} onVerantwortung={() => onReiter('verantwortung')} />
        ) : reiter === 'verantwortung' ? (
          <EnergiemanagementVerantwortung onPerson={onPerson} onZurueck={() => onReiter('aufgaben')} />
        ) : reiter === 'audits' || reiter === 'feststellungen' ? (
          <EnergiemanagementAudits onAudit={zumAudit} onFeststellung={zurFeststellung} feststellungenZeigen={reiter === 'feststellungen'} />
        ) : reiter === 'managementbewertung' ? (
          <EnergiemanagementManagementbewertung onOeffnen={zurManagementbewertung} />
        ) : reiter === 'verzeichnis' ? (
          <VerzeichnisMonate onDokument={onDokument} onUeberblick={() => onReiter('ueberblick')} />
        ) : (
          <Ueberblick onNavigate={springe} />
        )}
        {/* Grenz- und Verantwortungs-Satz einmal je Bereich, am Fuß (Konzept n1 §8.4 N7, K7). */}
        <div className="vp-nw-fuss">
          <GrenzHinweis />
        </div>
      </div>
    </GrenzSatzBereich>
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
        <div className="vp-ez-tafel-rahmen">
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
        </div>
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
