import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type InternesAuditprogramm } from '../api';
import * as A from '../auditFeststellung';
import { SAETZE } from '../energiemanagement';
import * as E from '../energiemanagementPortal';
import { UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import { EinsichtRecht } from './EinsichtRecht';
import { AuditPlanenDialog, ablehnung } from './InternesAuditDialoge';

/**
 * Reiter „Audits“ (UEMS AP-19 IP-20, §5.4, IA4): das Auditprogramm — geplante, durchgeführte, abgeschlossene und
 * abgesagte interne Audits und „nächstes internes Audit fällig am …“, gerechnet an der Route beim Abruf (ohne
 * durchgeführtes Audit keine Frist). „Audit planen“ nur mit `energiemanagement.verwalten`; „Einsicht“ liest den Leer-Satz.
 * `saetze` zeigt Grenz- und Verantwortungs-Satz, wo der Reiter allein steht (im Bereich stehen sie am Fuß).
 */
export function EnergiemanagementAudits({ onAudit, saetze = false }: { onAudit: (id: string) => void; saetze?: boolean }) {
  const [programm, setProgramm] = useState<InternesAuditprogramm | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [planen, setPlanen] = useState(false);
  useEffect(() => {
    let aktiv = true;
    api.energiemanagementAudits().then(
      (p) => aktiv && setProgramm(p),
      (e) => aktiv && setFehler(ablehnung(e)),
    );
    return () => {
      aktiv = false;
    };
  }, []);
  const n = programm?.naechstes ?? null;
  return (
    <section className="vp-ez-karte" aria-label={A.AUDITPROGRAMM} data-testid="audits-register">
      <div className="vp-em-kopf">
        <h2>{A.AUDITPROGRAMM}</h2>
        <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
          <Button onClick={() => setPlanen(true)} data-testid="audit-planen">
            {A.KNOPF_AUDIT_PLANEN}
          </Button>
        </EinsichtRecht>
      </div>
      {n && (
        <p className="vp-ez-satz" data-testid="audit-naechstes">
          {n.faellig_am
            ? `Nächstes internes Audit fällig am ${E.tagText(n.faellig_am)}${n.satz ? ` — ${n.satz}` : ''} (Rhythmus ${n.rhythmus_monate} Monate).`
            : 'Noch kein internes Audit durchgeführt — ohne Durchführung nennt VoltPilot keine Frist.'}
        </p>
      )}
      {fehler ? (
        <p className="vp-ez-fehler" role="alert">{fehler}</p>
      ) : programm === null ? (
        <p className="vp-ez-leise">Wird geladen …</p>
      ) : programm.audits.length === 0 ? (
        <p className="vp-ez-satz" data-testid="audits-leer">{SAETZE.verzeichnis_leer}</p>
      ) : (
        <table className="vp-ez-tafel">
          <thead>
            <tr>
              <th scope="col">Internes Audit</th>
              <th scope="col">Termin</th>
              <th scope="col">Wer prüft</th>
              <th scope="col">Zustand</th>
              <th scope="col">Ergebnisse</th>
            </tr>
          </thead>
          <tbody>
            {programm.audits.map((a) => (
              <tr key={a.id} data-testid={`audit-zeile-${a.kennzeichen}`}>
                <td>
                  <button type="button" className="vp-ez-zeile-knopf" onClick={() => onAudit(a.id)}>
                    {a.kennzeichen} {a.titel}
                  </button>
                </td>
                <td data-label="Termin" className="vp-em-tag">
                  {E.tagText(a.durchgefuehrt_am ?? a.termin)}
                </td>
                <td data-label="Wer prüft">{a.auditoren.map((p) => p.name).join(', ')}</td>
                <td data-label="Zustand">{A.AUDIT_ZUSTAND_WORT[a.zustand]}</td>
                <td data-label="Ergebnisse">
                  {a.zustand === 'geplant' || a.zustand === 'abgesagt'
                    ? '—'
                    : `${a.hinweise === 1 ? '1 Hinweis' : `${a.hinweise} Hinweise`} · ${a.feststellungen.length ? a.feststellungen.join(', ') : 'keine Feststellung'}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {planen && (
        <AuditPlanenDialog
          onClose={() => setPlanen(false)}
          onGeplant={(a) => {
            setPlanen(false);
            onAudit(a.audit.id);
          }}
        />
      )}
      {saetze && (
        <div className="vp-em-saetze">
          <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
          <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
        </div>
      )}
    </section>
  );
}
