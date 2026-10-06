import { useEffect, useState } from 'react';
import { api, type Feststellung, type InternesAuditprogramm } from '../api';
import * as B from '../auditBild';
import * as A from '../auditFeststellung';
import * as E from '../energiemanagementPortal';
import { auditRoute, feststellungRoute, hashForRoute } from '../nav';
import { useRollen } from '../rollen';
import { GrenzSatz } from './GrenzSatz';
import { FeststellungErfassenDialog } from './FeststellungDialoge';
import { AuditPlanenBlatt } from './AuditBlaetter';
import { AlsNaechstes } from './nachweisen/AlsNaechstes';
import { datumsblock } from './nachweisen/nwBild';
import { NwKopf } from './nachweisen/NwKopf';
import { StatusZeile, ZustandsZeichen } from './nachweisen/NwStatus';
import { NwSymbol } from './nachweisen/NwSymbol';
import { NwFristZeile, NwFristZeilen, Unterkopf } from './nachweisen/NwZeilen';
import { RowMenu } from './RowMenu';

/** Wo der Reiter die Feststellungen zeigt; `…/feststellungen` springt dorthin (Entscheid 17). */
export const FESTSTELLUNGEN_ANKER = 'audits-feststellungen';

/**
 * Reiter „Audits“ (Konzept Nachweisen n1 Runde 2, §6.6, Entscheid 17; vorher IP-20 „Auditprogramm“ und der eigene Reiter
 * „Feststellungen“): oben die Antwort als Status-Zeile („✓ keine Feststellung offen“), dann genau ein nächster Schritt
 * („Als Nächstes“: das nächste interne Audit mit Frist und der Person der Aufgabe, Knopf „Planen“), darunter die Audits
 * und die Feststellungen je als Zeile mit Datumsblock und einem Fakt. Erklärt wird nur auf Antippen (i-Knopf).
 * Frist, Reihenfolge und „überfällig“ kommen von der Route (IA4, FS1); gezählt wird nur Offenes (G4).
 * „Audit planen“ und „Feststellung erfassen“ nur mit `energiemanagement.verwalten` (im Menü und als Knopf).
 */
export function EnergiemanagementAudits({
  onAudit,
  onFeststellung,
  feststellungenZeigen = false,
}: {
  onAudit: (id: string) => void;
  onFeststellung: (id: string) => void;
  /** Über die Adresse `…/feststellungen` geöffnet: der Reiter rollt zu den Feststellungen. */
  feststellungenZeigen?: boolean;
}) {
  const rollen = useRollen();
  const verwalten = rollen.darf(E.RECHT_VERWALTEN, null);
  const [programm, setProgramm] = useState<InternesAuditprogramm | null>(null);
  const [feststellungen, setFeststellungen] = useState<Feststellung[] | null>(null);
  const [zustaendig, setZustaendig] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [planen, setPlanen] = useState(false);
  const [erfassen, setErfassen] = useState(false);

  useEffect(() => {
    let aktiv = true;
    api.energiemanagementAudits().then(
      (p) => {
        if (!aktiv) return;
        setProgramm(p);
        // Wer das nächste Audit plant: die Person der Aufgabe „Interne Audits“ am Tag der Route.
        api.energiemanagementAufgaben(p.tag).then(
          (r) => aktiv && setZustaendig(r.aufgaben.find((x) => x.aufgabe === 'interne_audits')?.laufend[0]?.person.name ?? null),
          () => undefined,
        );
      },
      (e) => aktiv && setFehler(A.ABLEHNUNG[E.ablehnungCode(e) ?? ''] ?? E.ablehnungSatz(e)),
    );
    api.energiemanagementFeststellungen().then(
      (r) => aktiv && setFeststellungen(r.feststellungen),
      () => aktiv && setFeststellungen([]),
    );
    return () => {
      aktiv = false;
    };
  }, []);

  useEffect(() => {
    if (!feststellungenZeigen || !programm || !feststellungen) return;
    document.getElementById(FESTSTELLUNGEN_ANKER)?.scrollIntoView({ block: 'start' });
  }, [feststellungenZeigen, programm, feststellungen]);

  const status = feststellungen ? B.auditsStatus(feststellungen) : null;
  const naechstes = programm ? B.auditNaechstes(programm, zustaendig) : null;
  const menue = (
    <RowMenu
      label="Weitere Aktionen"
      items={[
        { label: A.KNOPF_AUDIT_PLANEN, recht: E.RECHT_VERWALTEN, standort: null, onClick: () => setPlanen(true) },
        { label: A.KNOPF_FESTSTELLUNG, recht: E.RECHT_VERWALTEN, standort: null, onClick: () => setErfassen(true) },
      ]}
    />
  );

  return (
    <div className="vp-nw-seite" data-testid="audits-register">
      <NwKopf
        titel={B.AUDITS}
        erklaerung={B.erklaerungAudit(programm?.audits ?? [])}
        kurzzeile={programm ? B.auditsKurzzeile(programm.naechstes.rhythmus_monate) : undefined}
        status={status && <StatusZeile zeichen={<ZustandsZeichen art={status.zeichen} />} text={status.text} sub={status.sub} warn={status.warn} testId="audits-status" />}
        menue={verwalten ? menue : undefined}
        testId="audits-kopf"
      />
      {fehler ? (
        <p className="vp-ez-fehler" role="alert">
          {fehler}
        </p>
      ) : !programm ? (
        <p className="vp-ez-leise">Wird geladen …</p>
      ) : (
        <>
          {naechstes && (
            <AlsNaechstes
              testId="audit-naechstes"
              frist={naechstes.frist ? { ...datumsblock(naechstes.frist.wort, naechstes.frist.tag)!, ton: naechstes.frist.ton } : null}
              titel={naechstes.titel}
              warum={naechstes.warum}
              knopf={
                naechstes.knopf === 'planen'
                  ? verwalten
                    ? { label: B.KNOPF_PLANEN, onClick: () => setPlanen(true) }
                    : null
                  : { label: B.KNOPF_OEFFNEN, onClick: () => onAudit(naechstes.auditId!) }
              }
            />
          )}
          <section className="vp-nw-abschnitt" aria-label={B.AUDITS}>
            <Unterkopf>{B.AUDITS}</Unterkopf>
            {programm.audits.length === 0 ? (
              <p className="vp-ez-leise" data-testid="audits-leer">
                {B.NOCH_KEIN_AUDIT}
              </p>
            ) : (
              <NwFristZeilen>
                {programm.audits.map((a) => {
                  const z = B.auditZeile(a);
                  return (
                    <NwFristZeile
                      key={a.id}
                      datum={z.datum}
                      titel={z.titel}
                      unter={z.unter}
                      href={hashForRoute(auditRoute(a.id))}
                      onClick={() => onAudit(a.id)}
                      testId={`audit-zeile-${a.kennzeichen}`}
                    />
                  );
                })}
              </NwFristZeilen>
            )}
          </section>
          <section className="vp-nw-abschnitt" id={FESTSTELLUNGEN_ANKER} aria-label={B.FESTSTELLUNGEN} data-testid="feststellungen-register">
            <Unterkopf>{B.FESTSTELLUNGEN}</Unterkopf>
            {feststellungen === null ? (
              <p className="vp-ez-leise">Wird geladen …</p>
            ) : feststellungen.length === 0 ? (
              <p className="vp-ez-leise" data-testid="feststellungen-leer">
                {B.NOCH_KEINE_FESTSTELLUNG}
              </p>
            ) : (
              <NwFristZeilen>
                {feststellungen.map((f) => {
                  const z = B.feststellungZeile(f);
                  return (
                    <NwFristZeile
                      key={f.id}
                      datum={z.datum}
                      symbol={z.erledigt ? <NwSymbol name="check" size={18} /> : undefined}
                      titel={z.titel}
                      kurz
                      unter={z.unter}
                      href={hashForRoute(feststellungRoute(f.id))}
                      onClick={() => onFeststellung(f.id)}
                      testId={`feststellung-zeile-${f.kennzeichen}`}
                    />
                  );
                })}
              </NwFristZeilen>
            )}
          </section>
        </>
      )}
      {planen && programm && (
        <AuditPlanenBlatt
          programm={programm}
          onClose={() => setPlanen(false)}
          onGeplant={(a) => {
            setPlanen(false);
            onAudit(a.audit.id);
          }}
        />
      )}
      {erfassen && (
        <FeststellungErfassenDialog
          audit={null}
          onClose={() => setErfassen(false)}
          onErfasst={(f) => {
            setErfassen(false);
            onFeststellung(f.feststellung.id);
          }}
        />
      )}
      {/* Grenz- und Verantwortungs-Satz stehen einmal am Fuß des Bereichs („Was VoltPilot leistet“, K7/D5). */}
      <GrenzSatz verantwortung />
    </div>
  );
}
