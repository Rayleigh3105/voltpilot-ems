import { useEffect, useState } from 'react';
import { Icon } from '../../../designsystem/components/core/Icon';
import { api, type EnergiemanagementDokumentKurz } from '../../api';
import * as E from '../../energiemanagementPortal';
import * as N from '../../nachweisDokumente';
import { GrenzHinweis } from '../GrenzSatz';
import { RowMenu } from '../RowMenu';
import { ErrorState, Skeleton } from '../States';
import { DokumentFesthaltenBlatt } from './DokumentFesthaltenBlatt';
import { NwKopf } from './NwKopf';
import { StatusZeile } from './NwStatus';
import { NwZeichen } from './NwZeichen';
import { Fakt, NwFristZeile, NwFristZeilen, NwZeile, NwZeilen, Unterkopf } from './NwZeilen';
import './NwZeilen.css';
import './NwDokumente.css';

/**
 * Der Reiter „Dokumente“ (Konzept Nachweisen n1, Runde 2, §6.5): Kopf mit i-Knopf („Vorgabe oder Nachweis?“) und der
 * Status-Zeile „● 5 gelten“; „Vorgaben“ nach der nächsten Prüfung mit Datumsblock, „Nachweise“ mit Zeichen; die Fassung
 * nur ab Fassung 2, das Kennzeichen nur am Rechner (Entscheid 25). Anlegen steht im Menü „…“ - ein großer Knopf nur mit
 * Anlass (§3.3). Am Fuß „Was VoltPilot leistet“ mit Grenz- und Verantwortungs-Satz (SP4).
 */
export function DokumenteListe({ onOeffnen }: { onOeffnen: (id: string) => void }) {
  const [liste, setListe] = useState<EnergiemanagementDokumentKurz[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [festhalten, setFesthalten] = useState(false);
  const [aufgehobenOffen, setAufgehobenOffen] = useState(false);
  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    api.energiemanagementDokumente().then(
      (r) => aktiv && setListe(r.dokumente),
      () => aktiv && setFehler(N.DOKUMENTE_LADEFEHLER),
    );
    return () => {
      aktiv = false;
    };
  }, [versuch]);

  const bild = liste ? N.dokumenteBild(liste) : null;
  const status = bild ? N.listenStatus(bild) : null;
  const zeile = (z: N.DokumentZeile) => (
    <NwFristZeile
      key={z.id}
      datum={z.datum}
      symbol={z.zeichen === 'nachweis' ? <Icon name="check" size={18} /> : z.zeichen ? <NwZeichen art={z.zeichen} /> : null}
      titel={
        <>
          {z.titel}
          <span className="vp-nw-kz-leise">{z.kennzeichen}</span>
        </>
      }
      unter={z.unter}
      verb={z.verb ?? undefined}
      onClick={() => onOeffnen(z.id)}
      testId={`dokument-zeile-${z.kennzeichen}`}
    />
  );

  return (
    <div className="vp-nw-seite" data-testid="dokumente-register">
      <NwKopf
        titel={N.DOKUMENTE_TITEL}
        erklaerung={N.dokumenteErklaerung(liste ?? [])}
        status={status && <StatusZeile zeichen={<NwZeichen art={status.zeichen} />} text={status.text} sub={status.sub} warn={status.warn} testId="dokumente-status" />}
        menue={<RowMenu label="Weitere Aktionen" items={[{ label: 'Dokument festhalten', recht: E.RECHT_VERWALTEN, standort: null, icon: 'plus', onClick: () => setFesthalten(true) }]} />}
        testId="dokumente-kopf"
      />
      {fehler ? (
        <ErrorState message={fehler} onRetry={() => setVersuch((v) => v + 1)} />
      ) : !bild ? (
        <div aria-busy="true" aria-label="Dokumente werden geladen">
          <Skeleton height={56} />
          <Skeleton height={56} />
          <Skeleton height={56} />
        </div>
      ) : (
        <>
          {bild.vorgaben.length > 0 && (
            <section className="vp-nw-abschnitt" aria-label={N.VORGABEN}>
              <Unterkopf>{N.VORGABEN}</Unterkopf>
              <NwFristZeilen label={N.VORGABEN} testId="dokumente-vorgaben">
                {bild.vorgaben.map(zeile)}
              </NwFristZeilen>
            </section>
          )}
          {bild.nachweise.length > 0 && (
            <section className="vp-nw-abschnitt" aria-label={N.NACHWEISE}>
              <Unterkopf>{N.NACHWEISE}</Unterkopf>
              <NwFristZeilen label={N.NACHWEISE} testId="dokumente-nachweise">
                {bild.nachweise.map(zeile)}
              </NwFristZeilen>
            </section>
          )}
          {bild.aufgehoben.length > 0 && (
            <section className="vp-nw-abschnitt" aria-label={N.AUFGEHOBEN}>
              <NwZeilen>
                <NwZeile titel={N.AUFGEHOBEN} rechts={<Fakt>{bild.aufgehoben.length}</Fakt>} leise onClick={() => setAufgehobenOffen((o) => !o)} testId="dokumente-aufgehoben" />
              </NwZeilen>
              {aufgehobenOffen && <NwFristZeilen label={N.AUFGEHOBEN}>{bild.aufgehoben.map(zeile)}</NwFristZeilen>}
            </section>
          )}
        </>
      )}
      <GrenzHinweis />
      {festhalten && (
        <DokumentFesthaltenBlatt
          onClose={() => setFesthalten(false)}
          onFertig={(d) => {
            setFesthalten(false);
            onOeffnen(d.id);
          }}
        />
      )}
    </div>
  );
}
