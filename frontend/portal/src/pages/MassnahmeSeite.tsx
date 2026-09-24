import { useEffect, useId, useState, type FormEvent } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Massnahme } from '../api';
import { MassnahmeAendernDialog, MassnahmeUmgesetztDialog, MassnahmeVerwerfenDialog } from '../components/MassnahmeDialoge';
import { Recht } from '../components/Recht';
import { ErrorState, Skeleton } from '../components/States';
import * as Z from '../energieziele';
import { UEMS_BEWERTUNGSMETHODE, UEMS_BEZUGSBASIS, UEMS_ENERGIEZIEL, UEMS_MESSGRUNDLAGE, UEMS_NORMGRENZE, UEMS_VERANTWORTLICH } from '../glossar';
import * as M from '../massnahmen';
import './Verbesserung.css';

type Lage = { art: 'laedt' } | { art: 'fehlt' } | { art: 'fehler' } | { art: 'da'; m: Massnahme };

/** Ein Kommentar im Verlauf (M7): 1–2 000 Zeichen, an geplant und umgesetzt; nichts wird geändert oder gelöscht. */
function Kommentar({ m, onNeu }: { m: Massnahme; onNeu: (m: Massnahme) => void }) {
  const id = `mk-${useId().replace(/:/g, '')}`;
  const [text, setText] = useState('');
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const t = text.trim();
    if (!t || t.length > M.KOMMENTAR_MAX) {
      setSatz(M.ABLEHNUNG.text_ungueltig);
      document.getElementById(id)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onNeu(await api.massnahmeKommentar(m.id, { text: t }));
      setText('');
    } catch (x) {
      setSatz(M.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Recht aktion="verbesserung.verwalten" standort={m.standort_id}>
      <form className="vp-ez-form" noValidate onSubmit={(x) => void senden(x)} data-testid="massnahme-kommentar">
        <div className="vp-ez-feld">
          <label className="vp-ez-label" htmlFor={id}>
            {M.KNOPF_KOMMENTAR}
          </label>
          <textarea id={id} rows={2} value={text} onChange={(x) => setText(x.target.value)} aria-invalid={!!satz} />
          {satz && <p className="vp-ez-fehler">{satz}</p>}
        </div>
        <div className="vp-ez-aktionen">
          <Button type="submit" size="sm" variant="outline" disabled={busy} data-testid="massnahme-kommentar-senden">
            {M.KNOPF_KOMMENTAR}
          </Button>
        </div>
      </form>
    </Recht>
  );
}

/**
 * Die Maßnahmen-Seite (AP-18 IP-13, §5.4, M1–M4, M6, M7): Kopf mit Herkunft als Sprung (Kennzahl, Energieziel;
 * Einsatz und Abweichung als Kennung), die Messgrundlage mit Ausgangslage — die Kopie der Route mit Prüfsumme — oder
 * der Satz „ohne Messgrundlage“, die erwartete Wirkung, der Verlauf mit Kommentaren und je Zustand „umgesetzt melden“,
 * „verwerfen“, „ändern“. Wirkung und Bewertung kommen mit IP-20. Das Portal rechnet nichts.
 */
export function MassnahmeSeite({
  id,
  onListe,
  onKennzahl,
  onEnergieziel,
}: {
  id: string;
  onListe: () => void;
  onKennzahl?: (kennzahlId: string) => void;
  onEnergieziel?: (energiezielId: string) => void;
}) {
  const [lage, setLage] = useState<Lage>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);
  const [dialog, setDialog] = useState<null | 'umgesetzt' | 'verwerfen' | 'aendern'>(null);

  useEffect(() => {
    let aktiv = true;
    setLage({ art: 'laedt' });
    api.massnahme(id).then(
      (m) => aktiv && setLage({ art: 'da', m }),
      (e) => aktiv && setLage({ art: e instanceof ApiError && e.status === 404 ? 'fehlt' : 'fehler' }),
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);

  const zurueck = (
    <button type="button" className="vp-ez-zurueck" onClick={onListe}>
      <Icon name="chevron-left" size={18} />
      {M.ZUR_LISTE}
    </button>
  );

  if (lage.art === 'laedt') {
    return (
      <div className="vp-ez" data-testid="massnahme-seite" aria-busy="true">
        {zurueck}
        <Skeleton height={260} />
      </div>
    );
  }
  if (lage.art !== 'da') {
    return (
      <div className="vp-ez" data-testid="massnahme-seite">
        {zurueck}
        {lage.art === 'fehlt' ? (
          <p className="vp-ez-satz">{M.NICHT_GEFUNDEN}</p>
        ) : (
          <ErrorState message={M.LADEFEHLER_SEITE} onRetry={() => setVersuch((v) => v + 1)} />
        )}
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </div>
    );
  }

  const { m } = lage;
  const mg = m.messgrundlage;
  const ueberfaellig = M.ueberfaelligText(m);
  const neu = (x: Massnahme) => {
    setDialog(null);
    setLage({ art: 'da', m: x });
  };

  return (
    <div className="vp-ez" data-testid="massnahme-seite">
      {zurueck}
      <header className="vp-ez-kopf">
        <div className="vp-ez-kopf-zeile">
          <h1>{`${M.SPALTEN.kennzeichen} ${m.kennzeichen}`}</h1>
          <Badge variant="tint">{M.ZUSTAND_WORT[m.zustand]}</Badge>
        </div>
        <p className="vp-ez-satz" data-testid="massnahme-kopf">
          {M.kopfZeile(m, Z.tag)}
        </p>
        <p className="vp-ez-herkunft" data-testid="massnahme-herkunft">
          <span>{`${M.HERKUNFT_WORT[m.herkunft.art]}${m.herkunft.kennung && m.herkunft.art !== 'energieziel' ? ` ${m.herkunft.kennung}` : ''}`}</span>
          {m.energieziel &&
            (onEnergieziel ? (
              <button type="button" className="vp-ez-sprung" onClick={() => onEnergieziel(m.energieziel!.id)} data-testid="massnahme-sprung-energieziel">
                {`${UEMS_ENERGIEZIEL} ${m.energieziel.kennzeichen}`}
              </button>
            ) : (
              <span>{`${UEMS_ENERGIEZIEL} ${m.energieziel.kennzeichen}`}</span>
            ))}
          {m.einsatz && <span>{`${m.einsatz.kennzeichen}${m.einsatz.name ? ` ${m.einsatz.name}` : ''}${m.einstufung_fassung ? ` (Einstufung, Fassung ${m.einstufung_fassung})` : ''}`}</span>}
          <span>{`${UEMS_VERANTWORTLICH} ${m.verantwortlich.name}`}</span>
          {m.umgesetzt_am && <span data-testid="massnahme-umgesetzt-am">{M.umgesetztZeile(m.umgesetzt_am, Z.tag)}</span>}
        </p>
        {ueberfaellig && (
          <p className="vp-ez-frist" data-testid="massnahme-frist">
            {m.frist.satz ?? ueberfaellig}
          </p>
        )}
      </header>

      <section className="vp-ez-karte" aria-labelledby="ma-messgrundlage" data-testid="massnahme-messgrundlage">
        <h2 id="ma-messgrundlage">{UEMS_MESSGRUNDLAGE}</h2>
        {mg ? (
          <>
            <p className="vp-ez-herkunft">
              {onKennzahl ? (
                <button type="button" className="vp-ez-sprung" onClick={() => onKennzahl(mg.kennzahl.id)} data-testid="massnahme-sprung-kennzahl">
                  {`${mg.kennzahl.kennzeichen} ${mg.kennzahl.name ?? ''}`.trim()}
                </button>
              ) : (
                <span>{`${mg.kennzahl.kennzeichen} ${mg.kennzahl.name ?? ''}`.trim()}</span>
              )}
              <span>{`${UEMS_BEZUGSBASIS} ${mg.bezugsbasis.kennzeichen}, Fassung ${mg.fassung}`}</span>
            </p>
            <p className="vp-ez-leise" data-testid="massnahme-methode">
              {`${UEMS_BEWERTUNGSMETHODE}: ${mg.bewertungsmethode}`}
            </p>
            {mg.satz && (
              <p className="vp-ez-satz" data-testid="massnahme-messgrundlage-satz">
                {mg.satz}
              </p>
            )}
            <details className="vp-ez-kopie" data-testid="massnahme-ausgangslage">
              <summary>{M.AUSGANGSLAGE_KOPIE}</summary>
              <pre>{mg.ausgangslage}</pre>
            </details>
            <p className="vp-ez-pruefsumme" data-testid="massnahme-pruefsumme">
              {`${M.PRUEFSUMME} ${mg.pruefsumme}`}
            </p>
          </>
        ) : (
          <p className="vp-ez-satz vp-ez-ohne-satz" data-testid="massnahme-ohne-messgrundlage">
            {m.ohne_messgrundlage?.satz}
          </p>
        )}
        {/* Der Messgrundlage-Satz der Route (§5.9) nennt die erwartete Wirkung schon — sonst steht sie hier. */}
        {!mg?.satz && (
          <p className="vp-ez-satz" data-testid="massnahme-erwartete-wirkung">
            {M.erwarteteWirkungText(m)}
          </p>
        )}
      </section>

      <section className="vp-ez-karte" aria-labelledby="ma-zustand" data-testid="massnahme-zustand">
        <h2 id="ma-zustand">{M.SPALTEN.zustand}</h2>
        {m.zustand === 'geplant' ? (
          <div className="vp-ez-aktionen">
            <Recht aktion="verbesserung.verwalten" standort={m.standort_id}>
              <Button size="sm" onClick={() => setDialog('umgesetzt')} data-testid="massnahme-umgesetzt-knopf">
                {M.KNOPF_UMGESETZT}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDialog('aendern')} data-testid="massnahme-aendern-knopf">
                {M.KNOPF_AENDERN}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDialog('verwerfen')} data-testid="massnahme-verwerfen-knopf">
                {M.KNOPF_VERWERFEN}
              </Button>
            </Recht>
          </div>
        ) : m.zustand === 'verworfen' ? (
          <p className="vp-ez-satz" data-testid="massnahme-verworfen">
            {`verworfen am ${Z.tag(m.verworfen_am)}${m.verworfen_grund ? `: ‚${m.verworfen_grund}‘` : '.'}`}
          </p>
        ) : (
          <p className="vp-ez-satz" data-testid="massnahme-umgesetzt">
            {`${M.umgesetztZeile(m.umgesetzt_am ?? '', Z.tag)}${m.umgesetzt_begruendung ? `: ‚${m.umgesetzt_begruendung}‘` : '.'}`}
          </p>
        )}
      </section>

      <section className="vp-ez-karte" aria-labelledby="ma-verlauf" data-testid="massnahme-verlauf">
        <h2 id="ma-verlauf">{M.VERLAUF}</h2>
        {m.verlauf && m.verlauf.length > 0 && (
          <ol className="vp-ez-verlauf">
            {m.verlauf.map((e) => (
              <li key={e.nr} data-testid={`verlauf-${e.art}`}>
                <p>
                  <strong>{M.VERLAUF_WORT[e.art]}</strong> · {e.person} · {Z.tag(e.am)}
                </p>
                {e.kommentar && <p>{e.kommentar}</p>}
                {e.begruendung && <p className="vp-ez-leise">‚{e.begruendung}‘</p>}
              </li>
            ))}
          </ol>
        )}
        {M.kommentierbar(m) && <Kommentar m={m} onNeu={(x) => setLage({ art: 'da', m: x })} />}
      </section>

      <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>

      {dialog === 'umgesetzt' && <MassnahmeUmgesetztDialog massnahme={m} onClose={() => setDialog(null)} onFertig={neu} />}
      {dialog === 'verwerfen' && <MassnahmeVerwerfenDialog massnahme={m} onClose={() => setDialog(null)} onFertig={neu} />}
      {dialog === 'aendern' && <MassnahmeAendernDialog massnahme={m} onClose={() => setDialog(null)} onFertig={neu} />}
    </div>
  );
}
