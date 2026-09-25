import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type EnergiemanagementDokument, type EnergiemanagementDokumentEintrag } from '../api';
import { AnwendungsbereichVergleich } from '../components/AnwendungsbereichVergleich';
import { FassungDialog, FreigabeDialog } from '../components/DokumentDialoge';
import { Recht } from '../components/Recht';
import * as E from '../energiemanagementPortal';
import { UEMS_DOKUMENTE, UEMS_EINGETRAGEN_VON, UEMS_ENTSCHIEDEN_VON, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG, UEMS_WORTLAUT } from '../glossar';
import './Energiemanagement.css';
import './Verbesserung.css';

/** Ein Eintrag in Kundenworten: „geprüft, bleibt“ trägt den Satz der Route, eine Bekanntmachung den Satz aus §5.8. */
function eintragSatz(e: EnergiemanagementDokumentEintrag): string {
  if (e.satz) return e.satz;
  if (e.art === 'bekannt_gemacht') {
    const weg = e.weg === 'weiterer' ? (e.weg_wortlaut ?? '') : (E.WEG_WORT[e.weg ?? ''] ?? e.weg ?? '');
    return E.satzText('bekanntmachung', { am: E.tagText(e.am), kreis: e.kreis ?? '', weg, person: e.person?.name ?? e.eingetragen.akteur.name });
  }
  if (e.art === 'aufgehoben') return `Aufgehoben am ${E.tagText(e.am)} — ${UEMS_ENTSCHIEDEN_VON} ${e.entschieden_von?.name ?? ''}: ${e.begruendung ?? ''}`;
  return e.kommentar ?? '';
}

/**
 * Die Seite eines Dokuments (UEMS AP-19 IP-9, §5.1, DK1–DK8, R1, R2): Kopf-Satz, Überprüfung und — bei einer
 * Leitungs-Art ohne Leitung — der Sperr-Satz wörtlich von der Route; der Ort („Wortlaut in VoltPilot, Original bei
 * Ihnen: …“ bzw. „Geführt in Ihrem System: …“), die gezeigte Fassung, beim Anwendungsbereich Standorte, Träger und der
 * Vergleich mit dem Betrachtungsumfang, alle Fassungen mit „entschieden von“, „eingetragen von“ und Prüfsumme, die
 * Einträge. „Neue Fassung“ und „Freigeben“ öffnen die Dialoge; eine Datei gibt es nirgends (G3).
 */
export function DokumentSeite({ id, onListe }: { id: string; onListe: () => void }) {
  const [d, setD] = useState<EnergiemanagementDokument | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'fassung' | 'freigabe' | null>(null);
  useEffect(() => {
    let aktiv = true;
    api.energiemanagementDokument(id).then(
      (r) => aktiv && setD(r),
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [id]);

  const zurueck = (
    <button type="button" className="vp-ez-zurueck" onClick={onListe} data-testid="dokument-zurueck">
      <Icon name="chevron-left" size={16} />
      {UEMS_DOKUMENTE}
    </button>
  );
  if (!d) {
    return (
      <div className="vp-ez" data-testid="dokument-seite">
        {zurueck}
        {fehler ? <p className="vp-ez-fehler" role="alert">{fehler}</p> : <p className="vp-ez-leise">Wird geladen …</p>}
      </div>
    );
  }
  const gezeigt = E.gezeigteFassung(d);
  const offen = E.offeneFassung(d);
  const ort = E.ortSatz(d, gezeigt);
  const standort = d.bezug.standort?.id ?? null;
  const aufgehoben = d.zustand === 'aufgehoben';
  const gespeichert = (neu: EnergiemanagementDokument) => {
    setDialog(null);
    setD(neu);
  };
  return (
    <div className="vp-ez" data-testid="dokument-seite">
      {zurueck}
      <div className="vp-ez-kopf">
        <h1>
          {d.art_wort} {d.kennzeichen}
        </h1>
        {d.titel !== d.art_wort && <p className="vp-ez-leise">{d.titel}</p>}
        <p className="vp-ez-satz" data-testid="dokument-kopf">
          {d.saetze.kopf ?? `${E.ZUSTAND_WORT[d.zustand]} — noch keine Fassung freigegeben.`}
        </p>
        {d.saetze.ueberpruefung && (
          <p className="vp-ez-satz" data-testid="dokument-ueberpruefung">
            {d.saetze.ueberpruefung}
          </p>
        )}
        {!d.saetze.ueberpruefung && d.ueberpruefung?.faellig_am && (
          <p className="vp-ez-leise" data-testid="dokument-ueberpruefung">
            Überprüfung fällig am {E.tagText(d.ueberpruefung.faellig_am)}.
          </p>
        )}
        {d.saetze.freigabe_gesperrt && (
          <p className="vp-ez-satz" data-testid="dokument-gesperrt">
            {d.saetze.freigabe_gesperrt}
          </p>
        )}
        {ort && (
          <p className="vp-ez-leise" data-testid="dokument-ort">
            {ort}
          </p>
        )}
      </div>
      {!aufgehoben && (
        <div className="vp-ez-aktionen">
          <Recht aktion={E.RECHT_VERWALTEN} standort={standort}>
            <Button variant={offen ? 'ghost' : 'primary'} onClick={() => setDialog('fassung')} disabled={offen?.status === 'beantragt'} data-testid="dokument-fassung">
              {offen?.status === 'entwurf' ? E.KNOPF_ENTWURF : E.KNOPF_FASSUNG}
            </Button>
          </Recht>
          {offen && (
            <Recht aktion={E.RECHT_FREIGEBEN} standort={standort}>
              <Button onClick={() => setDialog('freigabe')} data-testid="dokument-freigeben">
                {offen.status === 'beantragt' ? E.KNOPF_BESTAETIGEN : E.KNOPF_FREIGEBEN}
              </Button>
            </Recht>
          )}
        </div>
      )}
      {gezeigt && (
        <section className="vp-ez-karte" aria-label={`Fassung ${gezeigt.nr}`} data-testid="dokument-fassung-inhalt">
          <h2>
            Fassung {gezeigt.nr} · {E.FASSUNG_STATUS_WORT[gezeigt.status]}
          </h2>
          {gezeigt.form === 'wortlaut' ? (
            <blockquote className="vp-em-wortlaut" aria-label={UEMS_WORTLAUT}>
              {gezeigt.wortlaut}
            </blockquote>
          ) : (
            <dl className="vp-em-dl">
              <dt>Bezeichnung</dt>
              <dd>{gezeigt.verweis?.bezeichnung || '—'}</dd>
              <dt>Ablage bei Ihnen</dt>
              <dd>{gezeigt.verweis?.ablage}</dd>
              {gezeigt.verweis?.adresse && (
                <>
                  <dt>Adresse</dt>
                  <dd>{gezeigt.verweis.adresse}</dd>
                </>
              )}
              <dt>Prüfsumme der Datei</dt>
              <dd className="vp-ez-pruefsumme" title={gezeigt.verweis?.sha256 ?? undefined}>
                {gezeigt.verweis?.sha256 ? E.kurz(gezeigt.verweis.sha256) : '—'}
              </dd>
            </dl>
          )}
          {gezeigt.anwendungsbereich && (
            <dl className="vp-em-dl" data-testid="dokument-anwendungsbereich">
              <dt>Standorte</dt>
              <dd>{gezeigt.anwendungsbereich.standorte.map((s) => s.name ?? s.kurzzeichen).join(', ')}</dd>
              <dt>Energieträger</dt>
              <dd>{gezeigt.anwendungsbereich.traeger.join(', ')}</dd>
              <dt>Ausschlüsse</dt>
              <dd>{gezeigt.anwendungsbereich.ausschluesse.length ? gezeigt.anwendungsbereich.ausschluesse.map((a) => a.begruendung).join(' · ') : 'keine'}</dd>
            </dl>
          )}
        </section>
      )}
      {d.art === 'anwendungsbereich' && d.gueltige_fassung && <AnwendungsbereichVergleich dokumentId={d.id} stand={d.gueltige_fassung} />}
      {d.beleg?.ablage && (
        <p className="vp-ez-leise" data-testid="dokument-original">
          Original bei Ihnen: {[d.beleg.bezeichnung, d.beleg.ablage, d.beleg.kennung].filter(Boolean).join(' · ')}
          {d.beleg.sha256 ? ` · Prüfsumme ${E.kurz(d.beleg.sha256)}` : ''}
        </p>
      )}
      {d.fassungen.length > 0 && (
        <section className="vp-ez-karte" aria-label="Fassungen">
          <h2>Fassungen</h2>
          <table className="vp-ez-tafel" data-testid="dokument-fassungen">
            <thead>
              <tr>
                <th scope="col">Fassung</th>
                <th scope="col">Stand</th>
                <th scope="col">{UEMS_ENTSCHIEDEN_VON}</th>
                <th scope="col">{UEMS_EINGETRAGEN_VON}</th>
                <th scope="col">entschieden am</th>
                <th scope="col">Prüfsumme</th>
              </tr>
            </thead>
            <tbody>
              {[...d.fassungen].reverse().map((f) => (
                <tr key={f.nr} data-testid={`dokument-fassung-${f.nr}`}>
                  <td>
                    {f.nr} · {E.FORM_WORT[f.form]}
                  </td>
                  <td data-label="Stand">{E.FASSUNG_STATUS_WORT[f.status]}</td>
                  <td data-label={UEMS_ENTSCHIEDEN_VON}>{f.entschieden_von ? E.personWort(f.entschieden_von) : '—'}</td>
                  <td data-label={UEMS_EINGETRAGEN_VON}>{f.freigabe?.akteur.name ?? f.eingetragen.akteur.name}</td>
                  <td data-label="entschieden am" className="vp-em-tag">{f.entschieden_am ? E.tagText(f.entschieden_am) : '—'}</td>
                  <td data-label="Prüfsumme" className="vp-ez-pruefsumme" title={f.pruefsumme ?? undefined}>
                    {f.pruefsumme ? E.kurz(f.pruefsumme) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {d.eintraege.length > 0 && (
        <section className="vp-ez-karte" aria-label="Einträge">
          <h2>Einträge</h2>
          <ul className="vp-ez-verlauf">
            {d.eintraege.map((e) => (
              <li key={e.id}>
                <p>{eintragSatz(e)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="vp-em-saetze">
        <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </div>
      {dialog === 'fassung' && <FassungDialog dokument={d} onClose={() => setDialog(null)} onGespeichert={gespeichert} />}
      {dialog === 'freigabe' && offen && <FreigabeDialog dokument={d} fassung={offen} onClose={() => setDialog(null)} onGespeichert={gespeichert} />}
    </div>
  );
}
