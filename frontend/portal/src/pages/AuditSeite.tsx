import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type InternesAuditMitVerlauf } from '../api';
import * as A from '../auditFeststellung';
import { EinsichtGruppe, EinsichtRecht } from '../components/EinsichtRecht';
import { FeststellungErfassenDialog } from '../components/FeststellungDialoge';
import {
  AuditAbsagenDialog,
  AuditAbschliessenDialog,
  AuditDurchgefuehrtDialog,
  HinweisDialog,
  ablehnung,
} from '../components/InternesAuditDialoge';
import { MassnahmeAnlegen } from '../components/MassnahmeDialoge';
import * as E from '../energiemanagementPortal';
import { UEMS_EINGETRAGEN_VON, UEMS_ENTSCHIEDEN_VON, UEMS_FESTSTELLUNGEN, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import { feststellungRoute, hashForRoute } from '../nav';
import './Energiemanagement.css';

type Dialog = null | 'durchgefuehrt' | 'hinweis' | 'feststellung' | 'abschliessen' | 'absagen';

/**
 * Die Seite eines internen Audits (UEMS AP-19 IP-20, §5.4, IA1–IA5): Kopf „Internes Audit AU-… · durchgeführt am … von
 * …“, Unabhängigkeit als Wortlaut, was und woran geprüft wird, die Hinweise (festgestellt von der Person, die prüft,
 * eingetragen von einem Konto) mit „Maßnahme anlegen“ (Herkunft internes Audit vorbelegt), die Feststellungen mit
 * Quelle dieses Audits, der Abschluss mit Bericht als Verweis und Prüfsumme, der Verlauf. `id` darf das Kennzeichen sein.
 */
export function AuditSeite({ id, onListe, onFeststellung }: { id: string; onListe: () => void; onFeststellung: (id: string) => void }) {
  const [daten, setDaten] = useState<InternesAuditMitVerlauf | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  useEffect(() => {
    let aktiv = true;
    setDaten(null);
    setFehler(null);
    const laden = A.istKennzeichen(id)
      ? api.energiemanagementAudits().then((p) => {
          const a = p.audits.find((x) => x.kennzeichen === id);
          if (!a) throw new ApiError(404, 'nicht gefunden', { code: 'audit_unbekannt' });
          return api.energiemanagementAudit(a.id);
        })
      : api.energiemanagementAudit(id);
    laden.then(
      (d) => aktiv && setDaten(d),
      (e) => aktiv && setFehler(ablehnung(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [id]);
  const fertig = (d: InternesAuditMitVerlauf) => {
    setDialog(null);
    setDaten(d);
  };
  const zurueck = (
    <button type="button" className="vp-ez-zurueck" onClick={onListe} data-testid="audit-zurueck">
      <Icon name="chevron-left" size={18} />
      Zum Auditprogramm
    </button>
  );
  if (!daten) {
    return (
      <div className="vp-ez" data-testid="audit-seite">
        {zurueck}
        {fehler ? <p className="vp-ez-fehler" role="alert">{fehler}</p> : <p className="vp-ez-leise">Wird geladen …</p>}
        <div className="vp-em-saetze">
          <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
          <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
        </div>
      </div>
    );
  }
  const { audit: a, hinweise, verlauf } = daten;
  const durchgefuehrt = a.zustand === 'durchgefuehrt';
  const abschluss = a.abschluss;
  return (
    <div className="vp-ez" data-testid="audit-seite">
      {zurueck}
      <div className="vp-ez-kopf">
        <h1>{`${a.kennzeichen} ${a.titel}`}</h1>
        <p className="vp-ez-satz" data-testid="audit-kopf">
          {A.auditKopf(a)}
        </p>
        <p className="vp-ez-leise" data-testid="audit-zustand">
          {`${A.AUDIT_ZUSTAND_WORT[a.zustand]} · Verantwortlich ${a.verantwortlich.name}`}
          {a.abgesagt_begruendung ? ` · ${a.abgesagt_begruendung}` : ''}
        </p>
        <EinsichtGruppe aktion={[E.RECHT_VERWALTEN, E.RECHT_FREIGEBEN]} standort={null}>
          <div className="vp-ez-aktionen">
            {a.zustand === 'geplant' && (
              <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
                <Button onClick={() => setDialog('durchgefuehrt')} data-testid="audit-durchgefuehrt">
                  {A.KNOPF_DURCHGEFUEHRT}
                </Button>
                <Button variant="ghost" onClick={() => setDialog('absagen')} data-testid="audit-absagen">
                  {A.KNOPF_AUDIT_ABSAGEN}
                </Button>
              </EinsichtRecht>
            )}
            {durchgefuehrt && (
              <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
                <Button variant="outline" onClick={() => setDialog('hinweis')} data-testid="audit-hinweis">
                  {A.KNOPF_HINWEIS}
                </Button>
                <Button variant="outline" onClick={() => setDialog('feststellung')} data-testid="audit-feststellung">
                  {A.KNOPF_FESTSTELLUNG}
                </Button>
              </EinsichtRecht>
            )}
            {durchgefuehrt && (
              <EinsichtRecht aktion={E.RECHT_FREIGEBEN} standort={null}>
                <Button onClick={() => setDialog('abschliessen')} data-testid="audit-abschliessen">
                  {A.KNOPF_AUDIT_ABSCHLIESSEN}
                </Button>
              </EinsichtRecht>
            )}
          </div>
        </EinsichtGruppe>
      </div>

      <section className="vp-ez-karte" aria-label="Umfang" data-testid="audit-umfang">
        <dl className="vp-em-dl">
          <dt>Wer prüft</dt>
          <dd>{a.auditoren.map((p) => `${p.name} (${p.funktion})`).join(', ')}</dd>
          <dt>Unabhängigkeit</dt>
          <dd data-testid="audit-unabhaengigkeit">{a.unabhaengigkeit}</dd>
          <dt>Was geprüft wird</dt>
          <dd>{a.was}</dd>
          <dt>Woran geprüft wird</dt>
          <dd>{a.woran}</dd>
          <dt>Termin</dt>
          <dd className="vp-em-tag">{E.tagText(a.termin)}</dd>
        </dl>
      </section>

      <section className="vp-ez-karte" aria-label="Hinweise" data-testid="audit-hinweise">
        <h2>Hinweise</h2>
        {hinweise.length === 0 ? (
          <p className="vp-ez-leise">{a.zustand === 'geplant' ? 'Hinweise halten Sie fest, sobald das Audit durchgeführt ist.' : 'Kein Hinweis festgehalten.'}</p>
        ) : (
          <ol className="vp-ez-verlauf">
            {hinweise.map((h) => (
              <li key={h.nr} data-testid={`audit-hinweis-${h.nr}`}>
                <blockquote className="vp-em-wortlaut">{h.wortlaut}</blockquote>
                <p className="vp-ez-leise">{A.hinweisSatz(h)}</p>
                {a.zustand !== 'abgesagt' && (
                  <MassnahmeAnlegen vorbelegung={{ herkunft: 'audit', herkunftKennung: a.kennzeichen, titel: h.wortlaut.slice(0, 120) }} standort={null} />
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="vp-ez-karte" aria-label={UEMS_FESTSTELLUNGEN} data-testid="audit-feststellungen">
        <h2>{UEMS_FESTSTELLUNGEN}</h2>
        {a.feststellungen.length === 0 ? (
          <p className="vp-ez-leise">Keine Feststellung aus diesem Audit.</p>
        ) : (
          <ul className="vp-em-liste">
            {a.feststellungen.map((k) => (
              <li key={k}>
                <a href={hashForRoute(feststellungRoute(k))} onClick={(ev) => (ev.preventDefault(), onFeststellung(k))} data-testid={`audit-sprung-${k}`}>
                  {`Feststellung ${k}`}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {abschluss && (
        <section className="vp-ez-karte" aria-label="Abschluss" data-testid="audit-abschluss">
          <h2>Abschluss</h2>
          <dl className="vp-em-dl">
            <dt>{UEMS_ENTSCHIEDEN_VON}</dt>
            <dd>{`${abschluss.entschieden_von.name} am ${E.tagText(abschluss.am)}`}</dd>
            <dt>{UEMS_EINGETRAGEN_VON}</dt>
            <dd>{abschluss.eingetragen.akteur.name}</dd>
            {abschluss.bericht?.ablage && (
              <>
                <dt>Bericht</dt>
                <dd data-testid="audit-bericht">{`Geführt in Ihrem System: ${abschluss.bericht.ablage}${E.verweisAngaben(abschluss.bericht) ? ` (${E.verweisAngaben(abschluss.bericht)})` : ''}.`}</dd>
              </>
            )}
            {abschluss.zusammenfassung && (
              <>
                <dt>Zusammenfassung</dt>
                <dd>{abschluss.zusammenfassung}</dd>
              </>
            )}
            <dt>Prüfsumme</dt>
            <dd className="vp-ez-pruefsumme" title={abschluss.pruefsumme} data-testid="audit-pruefsumme">
              {E.kurz(abschluss.pruefsumme)}
            </dd>
          </dl>
        </section>
      )}

      <section className="vp-ez-karte" aria-label="Verlauf">
        <h2>Verlauf</h2>
        <ul className="vp-ez-verlauf" data-testid="audit-verlauf">
          {verlauf.map((v) => (
            <li key={v.id}>
              {`${A.AUDIT_VERLAUF_WORT[v.art] ?? v.art} — ${v.akteur.name}, ${E.tagText(v.zeit.slice(0, 10))}${v.begruendung ? `: ${v.begruendung}` : ''}`}
            </li>
          ))}
        </ul>
      </section>

      <div className="vp-em-saetze">
        <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </div>

      {dialog === 'durchgefuehrt' && <AuditDurchgefuehrtDialog id={a.id} termin={a.termin} onClose={() => setDialog(null)} onFertig={fertig} />}
      {dialog === 'absagen' && <AuditAbsagenDialog id={a.id} onClose={() => setDialog(null)} onFertig={fertig} />}
      {dialog === 'hinweis' && (
        <HinweisDialog id={a.id} am={a.durchgefuehrt_am ?? a.termin} vorbelegt={a.auditoren[0]?.id ?? null} onClose={() => setDialog(null)} onFertig={fertig} />
      )}
      {dialog === 'abschliessen' && (
        <AuditAbschliessenDialog id={a.id} kennzeichen={a.kennzeichen} hinweise={hinweise} onClose={() => setDialog(null)} onFertig={fertig} />
      )}
      {dialog === 'feststellung' && (
        <FeststellungErfassenDialog
          audit={a}
          onClose={() => setDialog(null)}
          onErfasst={(f) => {
            setDialog(null);
            onFeststellung(f.feststellung.id);
          }}
        />
      )}
    </div>
  );
}
