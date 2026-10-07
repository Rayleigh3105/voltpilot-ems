import { useEffect, useState } from 'react';
import { api, type Bericht, type Managementbewertung } from '../api';
import * as E from '../energiemanagementPortal';
import * as M from '../managementbewertung';
import * as B from '../managementbewertungBild';
import { hashForRoute, managementbewertungRoute } from '../nav';
import { merkeAugenblick, routenHeute, tagDesAugenblicks } from '../routenUhr';
import { useRollen } from '../rollen';
import type { Wiedervorlage } from '../wiedervorlage';
import { GrenzSatz } from './GrenzSatz';
import { ManagementbewertungAnlegenDialog } from './ManagementbewertungDialoge';
import { AlsNaechstes } from './nachweisen/AlsNaechstes';
import { FolgenBalken } from './nachweisen/FolgenBalken';
import { datumsblock } from './nachweisen/nwBild';
import { NwKopf } from './nachweisen/NwKopf';
import { NwFristZeile, NwFristZeilen, Unterkopf } from './nachweisen/NwZeilen';
import { RowMenu } from './RowMenu';

/** Eine Managementbewertung der Liste mit dem, was die Karte braucht: Freigabetag und Beschlüsse mit Folgen. */
type Karte = { bericht: Bericht; freigegebenAm: string | null; mb: Managementbewertung | null };

/**
 * Reiter „Managementbewertung“ (Konzept Nachweisen n1 Runde 2, §6.7, Mock r2-M1; vorher UEMS AP-19 IP-24, MG1, MG7):
 * Kopf mit i-Knopf und „Jahresrückblick der Leitung“, darunter genau ein nächster Schritt - „Kann noch nicht beginnen“
 * für das laufende Jahr (gestrichelt, Frist aus der Wiedervorlage, „ab Januar …“, ohne Knopf), ein Entwurf zum Öffnen
 * oder die fehlende des Vorjahrs zum Anlegen -, dann die freigegebenen je Jahr als Karte mit Datumsblock „frei“ und
 * Folgen-Balken. Die Liste kommt aus den Berichten (Vorlage `managementbewertung`), die nächste Frist rechnet die
 * Wiedervorlage (MG7) - hier wird nur gelesen. „Managementbewertung anlegen“ nur mit `energiemanagement.verwalten`.
 */
export function EnergiemanagementManagementbewertung({
  onOeffnen,
  heute = routenHeute,
}: {
  onOeffnen: (kennung: string) => void;
  /** Nur für Tests; sonst der Tag der Route (Befund 3: das Jahr einer neuen Managementbewertung nie aus dem Browser). */
  heute?: () => string;
}) {
  const rollen = useRollen();
  const verwalten = rollen.darf(E.RECHT_VERWALTEN, null);
  const [liste, setListe] = useState<Bericht[] | null>(null);
  const [karten, setKarten] = useState<Record<string, Karte>>({});
  const [fehler, setFehler] = useState<string | null>(null);
  const [anlegen, setAnlegen] = useState(false);
  const [wv, setWv] = useState<Wiedervorlage | null | 'fehlt'>(null);
  useEffect(() => {
    let aktiv = true;
    api.berichte().then(
      (r) => {
        merkeAugenblick(r.abruf);
        if (!aktiv) return;
        const l = M.managementbewertungen(r.berichte);
        setListe(l);
        // Je freigegebene: Freigabetag aus den Ständen, Beschlüsse und Folgen aus ihrer Route (MG6) - je Jahr eine.
        for (const b of l.filter((x) => x.neueste_nr)) {
          Promise.all([api.bericht(b.kennung), api.managementbewertung(b.kennung).catch(() => null)]).then(
            ([d, mb]) => {
              const g = M.gueltigerStand(d.staende);
              if (aktiv) setKarten((k) => ({ ...k, [b.kennung]: { bericht: b, freigegebenAm: g ? tagDesAugenblicks(g.freigegeben_am, b.zeitzone) : null, mb } }));
            },
            () => undefined,
          );
        }
      },
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    api.energiemanagementWiedervorlage().then(
      (w) => aktiv && setWv(w),
      () => aktiv && setWv('fehlt'),
    );
    return () => {
      aktiv = false;
    };
  }, []);

  const tag = heute();
  const naechstes = liste && wv !== null ? B.mbNaechstes(liste, wv === 'fehlt' ? null : (wv.naechste_managementbewertung ?? null), tag) : null;
  const freigegeben = (liste ?? []).filter((b) => b.neueste_nr);
  const entwuerfe = (liste ?? []).filter((b) => !b.neueste_nr && b.kennung !== naechstes?.kennung);

  const menue = (
    <RowMenu label="Weitere Aktionen" items={[{ label: M.KNOPF_MB_ANLEGEN, recht: E.RECHT_VERWALTEN, standort: null, onClick: () => setAnlegen(true) }]} />
  );

  return (
    <div className="vp-nw-seite is-reiter" data-testid="managementbewertung-register" data-entscheid="managementbewertung">
      <NwKopf
        titel="Managementbewertung"
        erklaerung={B.erklaerungManagementbewertung(freigegeben[0] ? (karten[freigegeben[0].kennung]?.mb ?? null) : null)}
        kurzzeile={B.KURZZEILE}
        menue={verwalten ? menue : undefined}
        testId="managementbewertung-kopf"
      />
      {fehler ? (
        <p className="vp-ez-fehler" role="alert">
          {fehler}
        </p>
      ) : liste === null ? (
        <p className="vp-ez-leise">Wird geladen …</p>
      ) : (
        <>
          {naechstes && (
            <AlsNaechstes
              testId="mb-naechstes"
              kannNochNicht={naechstes.art === 'kann_nicht'}
              frist={naechstes.frist ? { ...datumsblock(naechstes.frist.wort, naechstes.frist.tag)!, ton: naechstes.frist.ton } : null}
              titel={naechstes.titel}
              warum={naechstes.warum}
              knopf={
                naechstes.knopf === 'oeffnen'
                  ? { label: M.KNOPF_MB_OEFFNEN, onClick: () => onOeffnen(naechstes.kennung!) }
                  : naechstes.knopf === 'anlegen' && verwalten
                    ? { label: M.KNOPF_MB_ANLEGEN, onClick: () => setAnlegen(true) }
                    : null
              }
            />
          )}
          {entwuerfe.length > 0 && (
            <section className="vp-nw-abschnitt" aria-label={B.IN_ARBEIT}>
              <Unterkopf>{B.IN_ARBEIT}</Unterkopf>
              <NwFristZeilen>
                {entwuerfe.map((b) => (
                  <NwFristZeile
                    key={b.kennung}
                    titel={`Managementbewertung ${b.zeitraum}`}
                    unter={M.ENTWURF}
                    href={hashForRoute(managementbewertungRoute(b.kennung))}
                    onClick={() => onOeffnen(b.kennung)}
                    testId={`mb-zeile-${b.kennung}`}
                  />
                ))}
              </NwFristZeilen>
            </section>
          )}
          {freigegeben.length > 0 && (
            <section className="vp-nw-abschnitt" aria-label={B.FREIGEGEBEN}>
              <Unterkopf>{B.FREIGEGEBEN}</Unterkopf>
              <div className="vp-nw-mb-karten">
                {freigegeben.map((b) => {
                  const k = karten[b.kennung];
                  return (
                    <NwFristZeilen key={b.kennung}>
                      <NwFristZeile
                        datum={k?.freigegebenAm ? { wort: 'frei', tag: k.freigegebenAm, ton: 'erledigt' } : null}
                        titel={`Managementbewertung ${b.zeitraum}`}
                        unter={k?.mb ? <FolgenBalken zustaende={B.folgenZustaende(k.mb)} testId={`mb-folgen-${b.kennung}`} /> : undefined}
                        href={hashForRoute(managementbewertungRoute(b.kennung))}
                        onClick={() => onOeffnen(b.kennung)}
                        testId={`mb-zeile-${b.kennung}`}
                      />
                    </NwFristZeilen>
                  );
                })}
              </div>
            </section>
          )}
          {liste.length === 0 && !naechstes && (
            <p className="vp-ez-leise" data-testid="managementbewertung-leer">
              {B.NOCH_KEINE}
            </p>
          )}
        </>
      )}
      {anlegen && (
        <ManagementbewertungAnlegenDialog
          heute={tag}
          onClose={() => setAnlegen(false)}
          onAngelegt={(kennung) => {
            setAnlegen(false);
            onOeffnen(kennung);
          }}
        />
      )}
      {/* Grenz- und Verantwortungs-Satz stehen einmal am Fuß des Bereichs („Was VoltPilot leistet“, K7/D5). */}
      <GrenzSatz verantwortung />
    </div>
  );
}
