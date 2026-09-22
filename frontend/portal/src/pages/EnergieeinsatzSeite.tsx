import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type Bezugsgroesse, type BewertungRanglisteEinsatz, type Energieeinsatz, type EnergieeinsatzAenderung, type EnergieeinsatzEinstufungFassung } from '../api';
import {
  ablehnung,
  bewertungZeitraum,
  BEENDEN_KNOPF,
  darfVerwalten,
  darfEinstufen,
  einflussText,
  EINFLUSSGROESSEN,
  KEINE_EINFLUSSGROESSEN,
  KEINE_MESSSTELLEN,
  KEINE_WERTE,
  KEINE_WERTE_SATZ,
  laeuft,
  messstelleOrt,
  messstelleZustand,
  MESSSTELLEN,
  PROTOKOLL,
  PROZESS,
  protokollZeile,
  prozessText,
  TRAEGER,
  VERANTWORTLICH,
  verantwortlichText,
  VERBRAUCHER,
  VERSUCHEN,
  ZURUECK,
  zustandText,
} from '../bewertung';
import { EnergieeinsatzBearbeitenDialog, EnergieeinsatzBeendenDialog } from '../components/EnergieeinsatzDialoge';
import { EinstufungDialog, EinstufungHistorie } from '../components/BewertungEntscheidungen';
import { ErrorState, Skeleton } from '../components/States';
import { UEMS_NORMGRENZE } from '../glossar';
import { useRollen } from '../rollen';

/**
 * Die Seite eines Energieeinsatzes (UEMS AP-16 IP-6, `#/portfolio/bewertung/{id}`): Prozess, Träger, Verbraucher,
 * Verantwortlicher, Einflussgrößen, die Messstellen des Prozesses mit Ort und Zustand und das Protokoll mit Akteur.
 * „Keine Werte“ ist die Aussage der Route, nie eine Null. IP-12 ergänzt die unverlierbare Einstufungshistorie.
 *
 * ⚠ Die Einflussgröße trägt nur die Kennung ihrer Bezugsgröße; den Namen liest die Seite aus dem Bezugsgrößen-Katalog
 * (Stammdaten, keine Werte) — erst, wenn eine Einflussgröße eine Bezugsgröße nennt.
 */
export function EnergieeinsatzSeite({ id, onListe }: { id: string; onListe: () => void }) {
  const { selbst } = useRollen();
  const verwalten = darfVerwalten(selbst);
  const einstufen = darfEinstufen(selbst);
  const zeitraum = bewertungZeitraum();
  const [einsatz, setEinsatz] = useState<Energieeinsatz | null>(null);
  const [protokoll, setProtokoll] = useState<EnergieeinsatzAenderung[] | null>(null);
  const [bezugsgroessen, setBezugsgroessen] = useState<Bezugsgroesse[]>([]);
  const [rang, setRang] = useState<BewertungRanglisteEinsatz | null>(null);
  const [einstufungen, setEinstufungen] = useState<EnergieeinsatzEinstufungFassung[]>([]);
  const [fehler, setFehler] = useState<{ satz: string; erneut: boolean } | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [dialog, setDialog] = useState<'bearbeiten' | 'beenden' | 'einstufen' | null>(null);

  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    Promise.all([api.energieeinsatz(id), api.energieeinsatzProtokoll(id), api.bewertungRangliste(zeitraum.von, zeitraum.bis), api.energieeinsatzEinstufungen(id)]).then(
      ([e, p, r, h]) => {
        if (!aktiv) return;
        setEinsatz(e);
        setProtokoll(p.aenderungen);
        setRang([...r.einsaetze, ...r.weitere_traeger].find((x) => x.id === id) ?? null);
        setEinstufungen(h.fassungen);
        if (e.einflussgroessen.some((x) => x.bezugsgroesse_id))
          api.bezugsgroessen().then((b) => aktiv && setBezugsgroessen(b.bezugsgroessen), () => undefined);
      },
      (e) => aktiv && setFehler({ satz: ablehnung(e), erneut: !(e && typeof e === 'object' && 'status' in e && (e.status === 404 || e.status === 403)) }),
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch, zeitraum.bis, zeitraum.von]);

  const neu = (e: Energieeinsatz) => {
    setEinsatz(e);
    setDialog(null);
    setVersuch((v) => v + 1);
  };

  return (
    <div className="vp-bw" data-testid="einsatz-seite">
      <button type="button" className="vp-bw-zurueck" onClick={onListe}>
        <Icon name="chevron-left" size={16} />
        {ZURUECK}
      </button>
      {fehler ? (
        fehler.erneut ? (
          <ErrorState message={fehler.satz} onRetry={() => setVersuch((v) => v + 1)} />
        ) : (
          <p className="vp-bw-hinweis" role="status">
            {fehler.satz}
          </p>
        )
      ) : !einsatz ? (
        <div aria-busy="true">
          <Skeleton height={160} />
        </div>
      ) : (
        <>
          <header className="vp-bw-kopf">
            <div>
              <p className="vp-bw-kz">{einsatz.kennzeichen}</p>
              <h1>{einsatz.name}</h1>
              <p className="vp-bw-abzeichen">
                <Badge variant="tint">{einsatz.traeger}</Badge>
                <Badge variant={laeuft(einsatz) ? 'ok' : 'off'} data-testid="einsatz-zustand">
                  {zustandText(einsatz)}
                </Badge>
                {einsatz.keine_werte && <Badge variant="off">{KEINE_WERTE}</Badge>}
              </p>
            </div>
            {verwalten && laeuft(einsatz) && (
              <div className="vp-bw-aktionen">
                <Button size="sm" variant="outline" iconLeft={<Icon name="pencil" size={16} />} onClick={() => setDialog('bearbeiten')} data-testid="einsatz-bearbeiten-knopf">
                  Bearbeiten
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDialog('beenden')} data-testid="einsatz-beenden-knopf">
                  {BEENDEN_KNOPF}
                </Button>
              </div>
            )}
          </header>

          <section className="vp-bw-karte" aria-label="Stammdaten">
            <dl className="vp-bw-felder">
              <dt>{PROZESS}</dt>
              <dd data-testid="einsatz-prozess">{prozessText(einsatz.prozess)}</dd>
              <dt>{TRAEGER}</dt>
              <dd>{einsatz.traeger === 'Strom' ? 'Strom' : `${einsatz.traeger} — im Umfang, ohne Anteil`}</dd>
              <dt>{VERBRAUCHER}</dt>
              <dd>{einsatz.verbraucher_wortlaut || 'nicht beschrieben'}</dd>
              <dt>{VERANTWORTLICH}</dt>
              <dd data-testid="einsatz-verantwortlich">{verantwortlichText(einsatz.verantwortlich)}</dd>
            </dl>
          </section>

          <div className="vp-bw-karte-kopf">
            <span className="vp-bw-leise">Vorschläge sind keine Einstufung.</span>
            {einstufen && rang && <Button size="sm" onClick={() => setDialog('einstufen')} data-testid="einsatz-einstufen-knopf">Einstufen</Button>}
          </div>
          <EinstufungHistorie
            einsatzId={id}
            fassungen={einstufungen}
            darfBestaetigen={einstufen}
            onBestaetigt={(f) => setEinstufungen((alt) => alt.map((x) => x.fassung === f.fassung ? f : x))}
          />

          <section className="vp-bw-karte" aria-labelledby="ee-einfluss">
            <h2 id="ee-einfluss">{EINFLUSSGROESSEN}</h2>
            {einsatz.einflussgroessen.length === 0 ? (
              <p className="vp-bw-leise">{KEINE_EINFLUSSGROESSEN}</p>
            ) : (
              <ul className="vp-bw-zeilen" data-testid="einsatz-einfluesse-liste">
                {einsatz.einflussgroessen.map((e, i) => (
                  <li key={i}>{einflussText(e, bezugsgroessen)}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="vp-bw-karte" aria-labelledby="ee-messstellen">
            <h2 id="ee-messstellen">{MESSSTELLEN}</h2>
            {einsatz.keine_werte && <p className="vp-bw-leise">{KEINE_WERTE_SATZ}</p>}
            {einsatz.messstellen.length === 0 ? (
              <p className="vp-bw-leise">{KEINE_MESSSTELLEN}</p>
            ) : (
              <ul className="vp-bw-zeilen" data-testid="einsatz-messstellen">
                {einsatz.messstellen.map((m) => (
                  <li key={m.id} className="vp-bw-ms">
                    <span className="vp-bw-kz">{m.kennzeichen}</span>
                    <span className="vp-bw-ms-name">{m.name}</span>
                    <span className="vp-bw-leise">
                      {messstelleOrt(m)} · {messstelleZustand(m)}
                      {m.art === 'berechnet' ? ' · berechnet' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="vp-bw-karte" aria-labelledby="ee-protokoll">
            <h2 id="ee-protokoll">{PROTOKOLL}</h2>
            {protokoll === null ? (
              <p className="vp-bw-leise">{VERSUCHEN}</p>
            ) : (
              <ol className="vp-bw-zeilen" data-testid="einsatz-protokoll">
                {[...protokoll].reverse().map((a) => (
                  <li key={a.id}>{protokollZeile(a)}</li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}

      <p className="vp-bw-grenze">{UEMS_NORMGRENZE}</p>

      {dialog === 'bearbeiten' && einsatz && (
        <EnergieeinsatzBearbeitenDialog einsatz={einsatz} onClose={() => setDialog(null)} onGespeichert={neu} />
      )}
      {dialog === 'beenden' && einsatz && (
        <EnergieeinsatzBeendenDialog einsatz={einsatz} onClose={() => setDialog(null)} onBeendet={neu} />
      )}
      {dialog === 'einstufen' && rang && (
        <EinstufungDialog einsatz={rang} onClose={() => setDialog(null)} onGespeichert={(f) => {
          setEinstufungen((alt) => [f, ...alt]);
          setDialog(null);
        }} />
      )}
    </div>
  );
}
