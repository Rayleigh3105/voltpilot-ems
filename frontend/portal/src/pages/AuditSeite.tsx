import { merkeAbruf, tagDesAugenblicks } from '../routenUhr';
import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, ApiError, type Feststellung, type InternesAuditMitVerlauf, type Massnahme } from '../api';
import * as B from '../auditBild';
import * as A from '../auditFeststellung';
import { EinsichtGruppe, EinsichtRecht } from '../components/EinsichtRecht';
import { FeststellungErfassenDialog } from '../components/FeststellungDialoge';
import { GrenzHinweis, GrenzSatz, GrenzSatzBereich } from '../components/GrenzSatz';
import {
  AuditAbsagenDialog,
  AuditAbschliessenDialog,
  AuditDurchgefuehrtDialog,
  HinweisDialog,
  ablehnung,
} from '../components/InternesAuditDialoge';
import { MassnahmeAnlegen } from '../components/MassnahmeDialoge';
import { NwBlatt } from '../components/nachweisen/NwBlatt';
import { NwKopf } from '../components/nachweisen/NwKopf';
import { PruefZeilen } from '../components/nachweisen/NwSchritte';
import { StatusZeile, ZustandsZeichen } from '../components/nachweisen/NwStatus';
import { Fakt, NwKarte, NwZeile, NwZeilen, ZeilenZustand } from '../components/nachweisen/NwZeilen';
import { Stufen } from '../components/nachweisen/Stufen';
import { RowMenu } from '../components/RowMenu';
import * as E from '../energiemanagementPortal';
import { feststellungRoute, hashForRoute, massnahmeRoute } from '../nav';
import { useRollen } from '../rollen';
import '../components/nachweisen/NwZeilen.css';
import './Energiemanagement.css';

type Dialog = null | 'durchgefuehrt' | 'hinweis' | 'feststellung' | 'abschliessen' | 'absagen';
type Blatt = null | 'umfang' | 'pruefer' | 'original' | 'verlauf' | { hinweis: number };

/**
 * Die Seite eines internen Audits (Konzept Nachweisen n1 Runde 2, §6.6; vorher IP-20, IA1–IA5): Name mit i-Knopf, wer
 * prüft als Kurzzeile, der Zustand als Status-Zeile, die Stufen „Geplant · Durchgeführt · Abgeschlossen“ mit Tag, genau
 * der nächste Schritt als Knopf, „Was daraus wurde“ als Zeilen (Hinweis mit dem Zustand seiner Maßnahme, Feststellung mit
 * ihrem) und drei Zeilen „Geprüft“, „Wer prüfte“, „Original“, deren Wortlaut erst im Blatt steht. Kennzeichen und Verlauf
 * stehen im Menü „…“. `id` darf das Kennzeichen sein (Sprung von der Maßnahmen-Seite).
 */
export function AuditSeite({ id, onListe, onFeststellung }: { id: string; onListe: () => void; onFeststellung: (id: string) => void }) {
  const rollen = useRollen();
  const [daten, setDaten] = useState<InternesAuditMitVerlauf | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [massnahmen, setMassnahmen] = useState<Massnahme[] | null>(null);
  const [feststellungen, setFeststellungen] = useState<Feststellung[] | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [blatt, setBlatt] = useState<Blatt>(null);
  const [versuch, setVersuch] = useState(0);
  const [kopiert, setKopiert] = useState(false);

  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    const laden = A.istKennzeichen(id)
      ? api.energiemanagementAudits().then((p) => {
          merkeAbruf(p.tag); // Befund 3: die Dialoge des Audits rechnen mit dem Tag der Route
          const a = p.audits.find((x) => x.kennzeichen === id);
          if (!a) throw new ApiError(404, 'nicht gefunden', { code: 'audit_unbekannt' });
          return api.energiemanagementAudit(a.id);
        })
      : api.energiemanagementAudit(id);
    laden.then(
      (d) => aktiv && setDaten(d),
      (e) => aktiv && setFehler(ablehnung(e)),
    );
    // Was daraus wurde: die Maßnahmen aus Verbessern (Herkunft dieses Audits) und die Feststellungen mit ihrem Zustand.
    api.massnahmen().then(
      (r) => aktiv && setMassnahmen(r.massnahmen),
      () => aktiv && setMassnahmen(null),
    );
    api.energiemanagementFeststellungen().then(
      (r) => aktiv && setFeststellungen(r.feststellungen),
      () => aktiv && setFeststellungen(null),
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);

  const fertig = (d: InternesAuditMitVerlauf) => {
    setDialog(null);
    setDaten(d);
    setVersuch((v) => v + 1);
  };

  if (!daten) {
    return (
      <GrenzSatzBereich>
        <div className="vp-nw-seite" data-testid="audit-seite">
          <NwKopf titel={fehler ? 'Internes Audit' : 'Wird geladen …'} zurueck={{ label: B.ALLE_AUDITS, onClick: onListe }} />
          {fehler && (
            <p className="vp-ez-fehler" role="alert">
              {fehler}
            </p>
          )}
          <GrenzSatz verantwortung />
          <GrenzHinweis />
        </div>
      </GrenzSatzBereich>
    );
  }

  const { audit: a, hinweise, verlauf } = daten;
  const status = B.auditStatus(a);
  const ausAudit = massnahmen?.filter((m) => m.herkunft.art === 'audit' && m.herkunft.kennung === a.kennzeichen) ?? null;
  const daraus = B.wasDarausWurde(a, ausAudit, feststellungen);
  const abschluss = a.abschluss;
  const bericht = abschluss?.bericht ?? null;
  const verwalten = rollen.darf(E.RECHT_VERWALTEN, null);
  const offenesBlatt = typeof blatt === 'object' && blatt ? hinweise.find((h) => h.nr === blatt.hinweis) ?? null : null;
  const hinweisMassnahme = (nr: number) => {
    const z = (abschluss?.kopie?.hinweise ?? []) as { nr?: number; massnahme?: string | null }[];
    const kz = z.find((h) => h.nr === nr)?.massnahme ?? (a.hinweise === 1 && ausAudit?.length === 1 ? ausAudit[0].kennzeichen : null);
    return kz ? (ausAudit?.find((m) => m.kennzeichen === kz) ?? null) : null;
  };
  const offeneMassnahme = offenesBlatt ? hinweisMassnahme(offenesBlatt.nr) : null;

  const aktionen =
    a.zustand === 'geplant' ? (
      <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
        <Button onClick={() => setDialog('durchgefuehrt')} data-testid="audit-durchgefuehrt">
          {A.KNOPF_DURCHGEFUEHRT}
        </Button>
      </EinsichtRecht>
    ) : a.zustand === 'durchgefuehrt' ? (
      <EinsichtGruppe aktion={[E.RECHT_VERWALTEN, E.RECHT_FREIGEBEN]} standort={null}>
        <EinsichtRecht aktion={E.RECHT_FREIGEBEN} standort={null}>
          <Button onClick={() => setDialog('abschliessen')} data-testid="audit-abschliessen">
            {A.KNOPF_AUDIT_ABSCHLIESSEN}
          </Button>
        </EinsichtRecht>
        <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
          <Button variant="outline" onClick={() => setDialog('hinweis')} data-testid="audit-hinweis">
            {A.KNOPF_HINWEIS}
          </Button>
          <Button variant="outline" onClick={() => setDialog('feststellung')} data-testid="audit-feststellung">
            {A.KNOPF_FESTSTELLUNG}
          </Button>
        </EinsichtRecht>
      </EinsichtGruppe>
    ) : null;

  const menue = (
    <RowMenu
      label="Weitere Aktionen"
      items={[
        {
          label: kopiert ? `${a.kennzeichen} kopiert` : `Kennzeichen ${a.kennzeichen}`,
          onClick: () => {
            void navigator.clipboard?.writeText(a.kennzeichen).then(() => setKopiert(true), () => undefined);
          },
        },
        { label: B.VERLAUF, onClick: () => setBlatt('verlauf') },
        ...(a.zustand === 'geplant' && verwalten
          ? [{ label: A.KNOPF_AUDIT_ABSAGEN, recht: E.RECHT_VERWALTEN, standort: null, danger: true, onClick: () => setDialog('absagen') }]
          : []),
      ]}
    />
  );

  return (
    <GrenzSatzBereich>
      <div className="vp-nw-seite" data-testid="audit-seite">
        <NwKopf
          titel={B.auditName(a)}
          zurueck={{ label: B.ALLE_AUDITS, onClick: onListe }}
          erklaerung={B.erklaerungAudit([a])}
          kurzzeile={B.auditorenZeile(a)}
          status={<StatusZeile zeichen={<ZustandsZeichen art={status.zeichen} />} text={status.text} sub={status.sub} warn={status.warn} testId="audit-status" />}
          menue={menue}
          testId="audit-kopf"
        />
        <div className={`vp-nw-zwei${daraus.length ? '' : ' is-ohne-haupt'}`}>
          <div className="vp-nw-spalte-seite">
            <Stufen stufen={B.auditStufen(a, verlauf)} testId="audit-stufen" />
            {aktionen && <div className="vp-nw-aktionen">{aktionen}</div>}
          </div>
          {daraus.length > 0 && (
            <div className="vp-nw-spalte-haupt">
              <NwKarte titel={B.WAS_DARAUS_WURDE} zahl={daraus.length} testId="audit-daraus">
                <NwZeilen>
                  {daraus.map((z, i) => (
                    <NwZeile
                      key={`${z.art}-${i}`}
                      vorn={<ZustandsZeichen art={z.zeichen} stumm />}
                      titel={z.titel}
                      rechts={z.zustand ? <ZeilenZustand ton={z.warn ? 'warn' : undefined}>{z.zustand}</ZeilenZustand> : undefined}
                      {...(z.art === 'hinweis'
                        ? { onClick: () => setBlatt({ hinweis: hinweise[i]?.nr ?? i + 1 }) }
                        : z.ziel
                          ? { href: hashForRoute(feststellungRoute(z.ziel)), onClick: () => onFeststellung(z.ziel!) }
                          : {})}
                      testId={`audit-daraus-${z.art}-${i}`}
                    />
                  ))}
                </NwZeilen>
              </NwKarte>
            </div>
          )}
          <div className="vp-nw-spalte-mehr">
            <NwZeilen testId="audit-angaben">
              <NwZeile titel="Geprüft" rechts={<Fakt>{`${B.themenZahl(a.was)} Themen`}</Fakt>} onClick={() => setBlatt('umfang')} testId="audit-umfang" />
              <NwZeile titel="Wer prüfte" rechts={<Fakt>unabhängig</Fakt>} onClick={() => setBlatt('pruefer')} testId="audit-pruefer" />
              {(bericht || abschluss?.zusammenfassung) && (
                <NwZeile
                  titel="Original"
                  rechts={<Fakt>{bericht ? B.ortKurz(bericht.ablage) : 'Zusammenfassung'}</Fakt>}
                  onClick={() => setBlatt('original')}
                  testId="audit-original"
                />
              )}
            </NwZeilen>
          </div>
        </div>
        <GrenzSatz verantwortung />
        <GrenzHinweis />

        <NwBlatt open={blatt === 'umfang'} titel="Geprüft" onClose={() => setBlatt(null)} testId="audit-blatt-umfang">
          <PruefZeilen
            zeilen={[
              { etikett: 'Audit', wert: a.titel },
              { etikett: 'Was', wert: a.was },
              { etikett: 'Woran', wert: a.woran },
              { etikett: 'Termin', wert: E.tagText(a.termin) },
            ]}
          />
        </NwBlatt>
        <NwBlatt open={blatt === 'pruefer'} titel="Wer prüfte" onClose={() => setBlatt(null)} testId="audit-blatt-pruefer">
          <PruefZeilen
            zeilen={[
              { etikett: 'Wer prüft', wert: a.auditoren.map((p) => [p.name, p.funktion].filter(Boolean).join(', ')).join(' · ') },
              { etikett: 'Warum unabhängig', wert: a.unabhaengigkeit },
              { etikett: 'Verantwortlich', wert: a.verantwortlich.name },
            ]}
          />
        </NwBlatt>
        <NwBlatt open={blatt === 'original'} titel="Original" onClose={() => setBlatt(null)} testId="audit-blatt-original">
          {abschluss && (
            <PruefZeilen
              zeilen={[
                ...(bericht
                  ? [
                      { etikett: 'Bericht', wert: bericht.bezeichnung ?? '' },
                      { etikett: 'Wo', wert: `${bericht.ablage}${E.verweisAngaben(bericht) ? ` (${E.verweisAngaben(bericht)})` : ''}` },
                    ]
                  : []),
                ...(abschluss.zusammenfassung ? [{ etikett: 'Zusammenfassung', wert: abschluss.zusammenfassung }] : []),
                { etikett: 'Abgeschlossen', wert: `${abschluss.entschieden_von.name} · ${E.tagText(abschluss.am)}` },
                { etikett: 'Eingetragen', wert: abschluss.eingetragen.akteur.name },
                { etikett: 'Prüfsumme', wert: <span title={abschluss.pruefsumme}>{E.kurz(abschluss.pruefsumme)}</span> },
              ]}
            />
          )}
        </NwBlatt>
        <NwBlatt open={!!offenesBlatt} titel="Hinweis" onClose={() => setBlatt(null)} testId="audit-blatt-hinweis">
          {offenesBlatt && (
            <>
              <blockquote className="vp-nw-zitat" data-testid={`audit-hinweis-${offenesBlatt.nr}`}>
                {offenesBlatt.wortlaut}
              </blockquote>
              <PruefZeilen
                zeilen={[
                  { etikett: 'Festgestellt', wert: `${offenesBlatt.festgestellt_von.name} · ${E.tagText(offenesBlatt.am)}` },
                  // Die Maßnahme mit ihrem Zustand als Weg zu ihrer Seite; Name und Kennzeichen stehen dort (Entscheid 25),
                  // wer eingetragen hat, im Verlauf - das Blatt bleibt unter 35 Wörtern.
                  ...(offeneMassnahme
                    ? [
                        {
                          etikett: 'Maßnahme',
                          wert: (
                            <a href={hashForRoute(massnahmeRoute(offeneMassnahme.id))} data-testid="hinweis-massnahme">
                              {B.massnahmeZustand(offeneMassnahme).wort.replace('Maßnahme ', '')}
                            </a>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
              {!offeneMassnahme && a.zustand !== 'abgesagt' && (
                <div className="vp-nw-blatt-zeile">
                  <MassnahmeAnlegen
                    vorbelegung={{ herkunft: 'audit', herkunftKennung: a.kennzeichen, titel: offenesBlatt.wortlaut.slice(0, 120) }}
                    standort={null}
                    onAngelegt={() => {
                      setBlatt(null);
                      setVersuch((v) => v + 1);
                    }}
                  />
                </div>
              )}
            </>
          )}
        </NwBlatt>
        <NwBlatt open={blatt === 'verlauf'} titel={B.VERLAUF} onClose={() => setBlatt(null)} testId="audit-blatt-verlauf">
          <ul className="vp-nw-verlauf" data-testid="audit-verlauf">
            {verlauf.map((v) => (
              <li key={v.id}>
                <b>{E.tagText(tagDesAugenblicks(v.zeit) ?? v.zeit.slice(0, 10))}</b>
                {`${A.AUDIT_VERLAUF_WORT[v.art] ?? v.art} · ${v.akteur.name}${v.begruendung ? ` · ${v.begruendung}` : ''}`}
              </li>
            ))}
          </ul>
        </NwBlatt>

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
    </GrenzSatzBereich>
  );
}
