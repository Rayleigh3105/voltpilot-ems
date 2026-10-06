import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, ApiError, type FeststellungMitVerlauf, type InternesAudit, type Massnahme } from '../api';
import * as B from '../auditBild';
import * as A from '../auditFeststellung';
import { EinsichtGruppe, EinsichtRecht } from '../components/EinsichtRecht';
import { WirksamkeitBlatt } from '../components/FeststellungBlaetter';
import { AntragAblehnenDialog, EintragDialog, StandDialog, type StandArt } from '../components/FeststellungDialoge';
import { GrenzHinweis, GrenzSatz, GrenzSatzBereich } from '../components/GrenzSatz';
import { ablehnung } from '../components/InternesAuditDialoge';
import { MassnahmeAnlegen } from '../components/MassnahmeDialoge';
import { ErklaerKnopf } from '../components/nachweisen/ErklaerKnopf';
import { NwBlatt } from '../components/nachweisen/NwBlatt';
import { NwKopf } from '../components/nachweisen/NwKopf';
import { HinweisZeile, PruefZeilen } from '../components/nachweisen/NwSchritte';
import { StatusZeile, ZustandsZeichen } from '../components/nachweisen/NwStatus';
import { Fakt, Kuerzel, NwFristZeile, NwFristZeilen, NwKarte, NwZeile, NwZeilen } from '../components/nachweisen/NwZeilen';
import { Stufen } from '../components/nachweisen/Stufen';
import { RowMenu } from '../components/RowMenu';
import * as E from '../energiemanagementPortal';
import { WOERTER } from '../energiemanagement';
import { UEMS_MASSNAHME_ZUSTAENDE } from '../glossar';
import { hashForRoute, massnahmeRoute } from '../nav';
import { useRollen } from '../rollen';
import '../components/nachweisen/NwZeilen.css';
import './Energiemanagement.css';

type Dialog = null | 'eintrag' | StandArt | 'ablehnen';
type Blatt = null | 'vorgabe' | 'verlauf' | { eintrag: number } | { stand: number };

/**
 * Die Seite einer Feststellung (Konzept Nachweisen n1 Runde 2, §6.6; vorher IP-20, FS1–FS7): der Wortlaut ist der Titel,
 * die Herkunft die Kurzzeile („Feststellung · Audit 2029“), die Antwort die Status-Zeile („✓ behoben und wirksam“), die
 * Stufen „Festgestellt · Maßnahme · Umgesetzt · Wirksam“ mit Tag. Die Einträge stehen als Datumsblöcke mit Kürzel, ihre
 * Aussagen auf Antippen; „Wogegen es ging“ als Zeile. Wirksamkeit prüfen ist der Knopf, sobald sie sich prüfen lässt
 * (FS4 von der Route); Vier-Augen beantragt, eine zweite Person bestätigt (FS6, Satz der Route wörtlich). Kennzeichen,
 * Verlauf, „Ohne Maßnahme abschließen“ und „Zurücknehmen“ stehen im Menü „…“. `id` darf das Kennzeichen sein.
 */
export function FeststellungSeite({ id, onListe, onAudit }: { id: string; onListe: () => void; onAudit: (id: string) => void }) {
  const rollen = useRollen();
  const [daten, setDaten] = useState<FeststellungMitVerlauf | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [audit, setAudit] = useState<InternesAudit | null>(null);
  const [massnahmen, setMassnahmen] = useState<Massnahme[] | null>(null);
  const [dokumentTitel, setDokumentTitel] = useState<string | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [blatt, setBlatt] = useState<Blatt>(null);
  const [versuch, setVersuch] = useState(0);
  const [kopiert, setKopiert] = useState(false);
  const sub = rollen.selbst?.kennung ?? null;

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
      (d) => {
        if (!aktiv) return;
        setDaten(d);
        const f = d.feststellung;
        // Woher sie kommt (Name des Audits) und wogegen sie ging (Titel des Dokuments): je ein Abruf, beides wahlfrei.
        if (f.quelle.audit_id) api.energiemanagementAudit(f.quelle.audit_id).then((x) => aktiv && setAudit(x.audit), () => undefined);
        if (f.vorgabe.dokument_id) {
          api.energiemanagementDokumente().then(
            (r) => aktiv && setDokumentTitel(r.dokumente.find((x) => x.id === f.vorgabe.dokument_id)?.titel ?? null),
            () => undefined,
          );
        }
      },
      (e) => aktiv && setFehler(ablehnung(e)),
    );
    // Der Tag, an dem eine Maßnahme angelegt wurde (Stufe „Maßnahme“), steht an der Maßnahme in Verbessern.
    api.massnahmen().then(
      (r) => aktiv && setMassnahmen(r.massnahmen),
      () => aktiv && setMassnahmen(null),
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
  const zurueck = audit
    ? { label: B.auditName(audit), onClick: () => onAudit(audit.id) }
    : { label: B.ALLE_AUDITS, onClick: onListe };

  if (!daten) {
    return (
      <GrenzSatzBereich>
        <div className="vp-nw-seite" data-testid="feststellung-seite">
          <NwKopf titel={fehler ? 'Feststellung' : 'Wird geladen …'} zurueck={{ label: B.ALLE_AUDITS, onClick: onListe }} />
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

  const { feststellung: f, eintraege, massnahmen: fm, wirksamkeit, vieraugen, verlauf } = daten;
  const offen = f.zustand === 'offen';
  const antrag = wirksamkeit.find((s) => s.status === 'beantragt') ?? null;
  const pruefbar = A.wirksamkeitPruefbar(fm);
  const status = B.feststellungStatus(f, wirksamkeit);
  const angelegt = fm.map((m) => massnahmen?.find((x) => x.id === m.id)?.angelegt_am ?? null);
  const darfFreigeben = rollen.darf(E.RECHT_FREIGEBEN, null);
  const darfVerwalten = rollen.darf(E.RECHT_VERWALTEN, null);
  const eintragBlatt = typeof blatt === 'object' && blatt && 'eintrag' in blatt ? (eintraege.find((e) => e.id === blatt.eintrag) ?? null) : null;
  const standBlatt = typeof blatt === 'object' && blatt && 'stand' in blatt ? (wirksamkeit.find((s) => s.nr === blatt.stand) ?? null) : null;

  async function bestaetigen() {
    setSatz(null);
    try {
      fertig(await api.energiemanagementFeststellungFreigeben(f.id));
    } catch (err) {
      setSatz(ablehnung(err));
    }
  }

  const menue = (
    <RowMenu
      label="Weitere Aktionen"
      items={[
        {
          label: kopiert ? `${f.kennzeichen} kopiert` : `Kennzeichen ${f.kennzeichen}`,
          onClick: () => {
            void navigator.clipboard?.writeText(f.kennzeichen).then(() => setKopiert(true), () => undefined);
          },
        },
        // Die Stände der Wirksamkeit (Begründung, Prüfsumme) einen Tipp tiefer: Status-Zeile und Stufe sagen das Ergebnis.
        ...wirksamkeit.map((s) => ({ label: B.standMenue(s), onClick: () => setBlatt({ stand: s.nr }) })),
        { label: B.VERLAUF, onClick: () => setBlatt('verlauf') },
        ...(offen && darfVerwalten ? [{ label: A.KNOPF_EINTRAG, recht: E.RECHT_VERWALTEN, standort: null, onClick: () => setDialog('eintrag') }] : []),
        ...(offen && !antrag && darfFreigeben && fm.length === 0
          ? [{ label: A.KNOPF_OHNE_MASSNAHME, recht: E.RECHT_FREIGEBEN, standort: null, onClick: () => setDialog('ohne_massnahme') }]
          : []),
        ...(offen && !antrag && darfFreigeben
          ? [{ label: A.KNOPF_ZURUECKNEHMEN, recht: E.RECHT_FREIGEBEN, standort: null, danger: true, onClick: () => setDialog('zurueckgenommen') }]
          : []),
      ]}
    />
  );

  /** Der eine nächste Schritt: Antrag entscheiden, sonst Wirksamkeit prüfen, sobald sie sich prüfen lässt. */
  const schritt = !offen ? null : antrag ? (
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
  ) : pruefbar ? (
    <EinsichtRecht aktion={E.RECHT_FREIGEBEN} standort={null}>
      <Button onClick={() => setDialog('wirksamkeit')} data-testid="feststellung-wirksamkeit-pruefen" data-entscheid-schritt>
        {A.KNOPF_WIRKSAMKEIT}
      </Button>
    </EinsichtRecht>
  ) : null;

  return (
    <GrenzSatzBereich>
      <div className="vp-nw-seite" data-testid="feststellung-seite">
        <div className="vp-nw-lang">
          <NwKopf
            titel={f.wortlaut.trim()}
            zurueck={zurueck}
            erklaerung={B.erklaerungFeststellung(f)}
            kurzzeile={B.feststellungHerkunft(f, audit)}
            status={<StatusZeile zeichen={<ZustandsZeichen art={status.zeichen} />} text={status.text} sub={status.sub} warn={status.warn} testId="feststellung-status" />}
            menue={menue}
            testId="feststellung-kopf"
          />
        </div>
        <div className="vp-nw-zwei">
          <div className="vp-nw-spalte-seite" data-entscheid="feststellung">
            <Stufen stufen={B.feststellungStufen(f, fm, angelegt, wirksamkeit)} testId="feststellung-stufen" />
            {offen && !pruefbar && !antrag && (
              <HinweisZeile
                icon="info"
                titel={B.PRUEFEN_NACH_UMSETZUNG}
                knopf={<ErklaerKnopf erklaerung={B.ERKLAERUNG_WIRKSAMKEIT} klein testId="wirksamkeit-erklaeren" />}
                testid="feststellung-noch-nicht"
              />
            )}
            {offen && vieraugen.an && vieraugen.satz && (
              <p className="vp-ez-satz" data-testid="feststellung-vieraugen">
                {vieraugen.satz}
              </p>
            )}
            {schritt && (
              <EinsichtGruppe aktion={[E.RECHT_FREIGEBEN]} standort={null}>
                <div className="vp-nw-aktionen">{schritt}</div>
              </EinsichtGruppe>
            )}
            {satz && (
              <p className="vp-ez-fehler" role="alert">
                {satz}
              </p>
            )}
          </div>
          <div className="vp-nw-spalte-haupt">
            <NwKarte
              titel={B.EINTRAEGE}
              zahl={eintraege.length || null}
              rechts={
                offen && darfVerwalten ? (
                  <button type="button" className="vp-nw-kk-verb" onClick={() => setDialog('eintrag')} data-testid="feststellung-eintrag">
                    {B.KNOPF_FESTHALTEN}
                  </button>
                ) : undefined
              }
              testId="feststellung-eintraege"
            >
              {eintraege.length === 0 ? (
                <p className="vp-ez-leise">{B.NOCH_KEIN_EINTRAG}</p>
              ) : (
                <NwFristZeilen>
                  {eintraege.map((e) => (
                    <NwFristZeile
                      key={e.id}
                      datum={{ wort: '', tag: e.am }}
                      titel={B.EINTRAG_KURZ[e.art]}
                      rechts={<Kuerzel personen={[{ name: e.person.name, kuerzel: e.person.kuerzel }]} />}
                      onClick={() => setBlatt({ eintrag: e.id })}
                      testId={`feststellung-eintrag-${e.art}`}
                    />
                  ))}
                </NwFristZeilen>
              )}
            </NwKarte>
          </div>
          <div className="vp-nw-spalte-mehr">
            <NwZeilen testId="feststellung-angaben">
              {fm.map((m, i) => (
                <NwZeile
                  key={m.id}
                  titel={fm.length > 1 ? `Maßnahme ${i + 1}` : 'Maßnahme'}
                  rechts={<Fakt>{UEMS_MASSNAHME_ZUSTAENDE[m.zustand]}</Fakt>}
                  href={hashForRoute(massnahmeRoute(m.id))}
                  testId={`feststellung-massnahme-${m.kennzeichen}`}
                />
              ))}
              {B.vorgabeKurz(f.vorgabe, dokumentTitel) && (
                <NwZeile titel="Wogegen es ging" rechts={<Fakt>{B.vorgabeKurz(f.vorgabe, dokumentTitel)}</Fakt>} onClick={() => setBlatt('vorgabe')} testId="feststellung-vorgabe" />
              )}
            </NwZeilen>
            {offen && fm.length === 0 && (
              <MassnahmeAnlegen
                vorbelegung={{ herkunft: 'nichtkonformitaet', herkunftKennung: f.kennzeichen }}
                standort={null}
                onAngelegt={() => setVersuch((v) => v + 1)}
              />
            )}
          </div>
        </div>
        <GrenzSatz verantwortung />
        <GrenzHinweis />

        <NwBlatt open={!!eintragBlatt} titel={eintragBlatt ? B.EINTRAG_KURZ[eintragBlatt.art] : ''} onClose={() => setBlatt(null)} testId="feststellung-blatt-eintrag">
          {eintragBlatt && (
            <>
              <blockquote className="vp-nw-zitat">{eintragBlatt.wortlaut}</blockquote>
              <PruefZeilen
                zeilen={[
                  { etikett: 'Aussage von', wert: `${eintragBlatt.person.name} · ${E.tagText(eintragBlatt.am)}` },
                  { etikett: 'Eingetragen', wert: eintragBlatt.eingetragen.akteur.name },
                ]}
              />
            </>
          )}
        </NwBlatt>
        <NwBlatt open={!!standBlatt} titel={standBlatt ? `Stand ${standBlatt.nr}` : ''} onClose={() => setBlatt(null)} testId="feststellung-blatt-stand">
          {standBlatt && (
            <>
              <blockquote className="vp-nw-zitat">{standBlatt.begruendung}</blockquote>
              <PruefZeilen
                zeilen={[
                  { etikett: 'Ergebnis', wert: A.ERGEBNIS_WORT[standBlatt.ergebnis] },
                  { etikett: 'Geprüft von', wert: `${standBlatt.entschieden_von.name} · ${E.tagText(standBlatt.am)}` },
                  { etikett: 'Eingetragen', wert: standBlatt.eingetragen.akteur.name },
                  ...(standBlatt.zweite_person ? [{ etikett: 'Bestätigt', wert: standBlatt.zweite_person.akteur.name }] : []),
                  ...(standBlatt.ablehnung_begruendung ? [{ etikett: 'Abgelehnt', wert: standBlatt.ablehnung_begruendung }] : []),
                  { etikett: 'Prüfsumme', wert: <span title={standBlatt.pruefsumme}>{E.kurz(standBlatt.pruefsumme)}</span> },
                ]}
              />
            </>
          )}
        </NwBlatt>
        <NwBlatt open={blatt === 'vorgabe'} titel="Wogegen es ging" onClose={() => setBlatt(null)} testId="feststellung-blatt-vorgabe">
          {f.vorgabe.wortlaut && <blockquote className="vp-nw-zitat">{f.vorgabe.wortlaut}</blockquote>}
          <PruefZeilen
            zeilen={[
              ...(f.vorgabe.dokument ? [{ etikett: 'Dokument', wert: `${dokumentTitel ?? f.vorgabe.dokument}${f.vorgabe.fassung ? `, Fassung ${f.vorgabe.fassung}` : ''}` }] : []),
              { etikett: 'Bezug', wert: A.bezugWort(f.bezug, (x) => WOERTER.aufgabe[x] ?? x) },
              { etikett: 'Festgestellt', wert: `${f.festgestellt_von.name} · ${E.tagText(f.festgestellt_am)}` },
              { etikett: 'Verantwortlich', wert: f.verantwortlich.name },
            ]}
          />
        </NwBlatt>
        <NwBlatt open={blatt === 'verlauf'} titel={B.VERLAUF} onClose={() => setBlatt(null)} testId="feststellung-blatt-verlauf">
          <ul className="vp-nw-verlauf" data-testid="feststellung-verlauf">
            {verlauf.map((v) => (
              <li key={v.id}>
                <b>{E.tagText(v.zeit.slice(0, 10))}</b>
                {`${A.FESTSTELLUNG_VERLAUF_WORT[v.art] ?? v.art} · ${v.akteur.name}${v.begruendung ? ` · ${v.begruendung}` : ''}`}
              </li>
            ))}
          </ul>
        </NwBlatt>

        {dialog === 'eintrag' && <EintragDialog id={f.id} onClose={() => setDialog(null)} onFertig={fertig} />}
        {dialog === 'wirksamkeit' && (
          <WirksamkeitBlatt id={f.id} vieraugen={vieraugen.an} heute={f.lage.abruf} onClose={() => setDialog(null)} onFertig={fertig} />
        )}
        {(dialog === 'ohne_massnahme' || dialog === 'zurueckgenommen') && (
          <StandDialog id={f.id} art={dialog} vieraugen={vieraugen.an} onClose={() => setDialog(null)} onFertig={fertig} />
        )}
        {dialog === 'ablehnen' && <AntragAblehnenDialog id={f.id} onClose={() => setDialog(null)} onFertig={fertig} />}
      </div>
    </GrenzSatzBereich>
  );
}
