import { useEffect, useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import { api, type Bericht } from '../../api';
import { BEWERTUNG_VORLAGE, darf } from '../../berichtDialoge';
import { amStandort, LADEN, LEER, LEER_STANDORT, listenFehler } from '../../berichtSeite';
import { STANDORT_BERICHTE } from '../../ebenenNav';
import { ausgabeFehler } from '../../leistungsvergleichBericht';
import * as N from '../../nachweisBerichte';
import { merkeAugenblick } from '../../routenUhr';
import { useBerichtRechte } from '../../useBerichtRechte';
import { GrenzHinweis } from '../GrenzSatz';
import { ErrorState, Skeleton } from '../States';
import { BerichtErstellenBlatt } from './BerichtBlaetter';
import { dateiSpeichern } from './datei';
import { NwBlatt } from './NwBlatt';
import { NwKopf } from './NwKopf';
import { ZaehlerChip } from './NwZeichen';
import { Fakt, NwFristZeile, NwFristZeilen, NwZeile, NwZeilen, Unterkopf } from './NwZeilen';
import './NwZeilen.css';
import './Nachweisen.css';
import './NwBerichte.css';

/**
 * Der Reiter „Berichte“ in Nachweisen (Konzept n1, Runde 2, §6.4): Kopf mit i-Knopf und „Erstellen“, zwei Zähler („4
 * gelten“, „1 wartet auf Sie“), zuerst die Entscheidung mit Datumsblock „seit“ und Verb, dann „Gelten“ als eine Zeile je
 * Bericht mit Datumsblock „frei“ und „PDF“; Abgelöstes und Archiviertes je als eine Zeile mit Zahl. Am Standort
 * („Berichte dieses Standorts“) dieselbe Liste, nur Berichte mit Geltung genau dieses Standorts.
 *
 * Bewertung und Managementbewertung öffnen ihre eigene Seite (Entscheid 15); „heute“ ist der `abruf` der Route.
 */
export function BerichteListe({
  standort,
  onOeffnen,
  onBewertung,
  onManagementbewertung,
}: {
  standort: { id: string; name: string } | null;
  onOeffnen: (kennung: string) => void;
  onBewertung?: () => void;
  onManagementbewertung?: (kennung: string) => void;
}) {
  const [liste, setListe] = useState<Bericht[] | null>(null);
  const [abruf, setAbruf] = useState<number | null>(null);
  const [fehler, setFehler] = useState<{ satz: string; erneut: boolean } | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [erstellen, setErstellen] = useState(false);
  const [blatt, setBlatt] = useState<'abgeloest' | 'archiviert' | null>(null);
  const [datei, setDatei] = useState<{ kennung: string; satz: string; fehler: boolean } | null>(null);
  const [laedt, setLaedt] = useState<string | null>(null);
  const standortId = standort?.id ?? null;
  const rechte = useBerichtRechte();
  // Der Knopf erst mit Antwort der Selbstauskunft; eine 403 der Liste (Unterstützung) hat keinen.
  const darfAnlegen =
    rechte !== undefined &&
    !(fehler && !fehler.erneut) &&
    (standortId ? darf(rechte, 'anlegen', 'standort', standortId) : darf(rechte, 'anlegen', 'standort', null) || darf(rechte, 'anlegen', 'unternehmen', null));

  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    // Mit den archivierten (Konzept Nachweisen n1, C8): sie stehen als eine Zeile „Archiviert · n“, nie gezählt.
    api.berichte({ archiviert: true }).then(
      ({ berichte, abruf: zeitpunkt }) => {
        merkeAugenblick(zeitpunkt);
        if (!aktiv) return;
        const ms = Date.parse(zeitpunkt ?? '');
        setAbruf(Number.isNaN(ms) ? null : ms);
        setListe(standortId ? amStandort(berichte, standortId) : berichte);
      },
      (e) => aktiv && setFehler(listenFehler(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [versuch, standortId]);

  const bild = liste ? N.berichteBild(liste) : null;
  const nachKennung = new Map((liste ?? []).map((b) => [b.kennung, b]));
  // „wartet auf Sie“ zählt nur, wo die Person entscheiden darf; die übrigen „warten“ (Review r1, P3-5).
  const aufSie = !bild
    ? 0
    : bild.wartet.filter((z) => {
        const b = nachKennung.get(z.kennung);
        return !!b && !!rechte && darf(rechte, 'freigeben', b.geltung_art, b.geltung_id, b.vorlage);
      }).length;
  const andere = bild ? bild.zaehler.wartet - aufSie : 0;

  const oeffne = (z: N.BerichtZeile) => {
    if (z.ziel === 'managementbewertung' && onManagementbewertung) onManagementbewertung(z.kennung);
    else if (z.ziel === 'bewertung' && onBewertung) onBewertung();
    else onOeffnen(z.kennung);
  };
  const pdf = async (z: N.BerichtZeile) => {
    if (z.pdfNr === null) return;
    setLaedt(z.kennung);
    setDatei(null);
    try {
      dateiSpeichern(await api.berichtDatei(z.kennung, z.pdfNr, 'pdf'), `bericht-${z.kennung}-nr${z.pdfNr}.pdf`);
    } catch (e) {
      setDatei({ kennung: z.kennung, satz: ausgabeFehler(e), fehler: true });
    } finally {
      setLaedt(null);
    }
  };

  const zeile = (z: N.BerichtZeile, mitPdf: boolean) => (
    <div key={z.kennung} className="vp-nw-br-zeile">
      <NwFristZeile
        datum={z.datum}
        titel={
          <>
            {z.titel}
            <span className="vp-nw-kz-leise">{z.kennung}</span>
          </>
        }
        unter={z.unter}
        verb={z.verb ?? undefined}
        rechts={!z.verb ? <span className="vp-nw-br-stand">{z.stand}</span> : undefined}
        // Neben „PDF“ kein Pfeil: die Zeile öffnet trotzdem (§6.4: „frei · Name · PDF“).
        pfeil={mitPdf && z.pdfNr !== null ? false : undefined}
        onClick={() => oeffne(z)}
        testId={`bericht-zeile-${z.kennung}`}
      />
      {mitPdf && z.pdfNr !== null && (
        <button
          type="button"
          className="vp-nw-br-pdf"
          onClick={() => void pdf(z)}
          disabled={laedt === z.kennung}
          aria-busy={laedt === z.kennung || undefined}
          aria-label={`${N.PDF} ${z.titel}`}
          data-testid={`bericht-pdf-${z.kennung}`}
        >
          {N.PDF}
        </button>
      )}
    </div>
  );

  return (
    <>
      <div className="vp-nw-seite vp-nw-berichte" data-testid="berichte">
        <NwKopf
          titel={standort ? STANDORT_BERICHTE : N.BERICHTE_TITEL}
          kurzzeile={standort?.name}
          erklaerung={N.berichteErklaerung(liste ?? [])}
          menue={
            darfAnlegen ? (
              <Button size="sm" variant="outline" iconLeft={<Icon name="plus" size={16} />} onClick={() => setErstellen(true)} data-testid="bericht-anlegen-knopf">
                {N.ERSTELLEN}
              </Button>
            ) : null
          }
          testId="berichte-kopf"
        />
        {fehler ? (
          fehler.erneut ? (
            <ErrorState message={fehler.satz} onRetry={() => setVersuch((v) => v + 1)} />
          ) : (
            <p className="vp-nw-leise" role="status" data-testid="berichte-verwehrt">
              {fehler.satz}
            </p>
          )
        ) : !bild ? (
          <div aria-busy="true" aria-label={LADEN}>
            <Skeleton height={56} />
            <Skeleton height={56} />
            <Skeleton height={56} />
          </div>
        ) : liste!.length === 0 ? (
          <p className="vp-nw-leise" data-testid="berichte-leer">
            {standort ? LEER_STANDORT : LEER}
          </p>
        ) : (
          <>
            {(bild.zaehler.gelten > 0 || bild.zaehler.wartet > 0) && (
              <div className="vp-nw-zchips" data-testid="berichte-zaehler">
                {bild.zaehler.gelten > 0 && <ZaehlerChip anzahl={bild.zaehler.gelten} wort={N.geltenWort(bild.zaehler.gelten)} zeichen="festgehalten" ton="still" testId="zaehler-gelten" />}
                {aufSie > 0 && <ZaehlerChip anzahl={aufSie} wort={N.wartetWort(aufSie, true)} zeichen="ueber" testId="zaehler-wartet" />}
                {andere > 0 && (
                  <ZaehlerChip anzahl={andere} wort={N.wartetWort(andere, false)} zeichen="ueber" testId={aufSie > 0 ? 'zaehler-wartet-andere' : 'zaehler-wartet'} />
                )}
              </div>
            )}
            {bild.wartet.length > 0 && (
              <section className="vp-nw-abschnitt" aria-label={N.WARTET}>
                <NwFristZeilen label={N.WARTET} testId="berichte-wartet">
                  {bild.wartet.map((z) => zeile(z, false))}
                </NwFristZeilen>
              </section>
            )}
            {bild.gelten.length > 0 && (
              <section className="vp-nw-abschnitt" aria-label={N.GELTEN}>
                <Unterkopf>{N.GELTEN}</Unterkopf>
                <NwFristZeilen label={N.GELTEN} testId="berichte-gelten">
                  {bild.gelten.map((z) => zeile(z, true))}
                </NwFristZeilen>
              </section>
            )}
            {(bild.abgeloest.length > 0 || bild.archiviert.length > 0) && (
              <NwZeilen>
                {bild.abgeloest.length > 0 && (
                  <NwZeile titel={N.ABGELOEST} rechts={<Fakt>{bild.abgeloest.length}</Fakt>} leise onClick={() => setBlatt('abgeloest')} testId="berichte-abgeloest" />
                )}
                {bild.archiviert.length > 0 && (
                  <NwZeile titel={N.ARCHIVIERT} rechts={<Fakt>{bild.archiviert.length}</Fakt>} leise onClick={() => setBlatt('archiviert')} testId="berichte-archiviert" />
                )}
              </NwZeilen>
            )}
            {datei?.fehler && (
              <p className="vp-nw-fehler" role="alert" data-testid="berichte-datei">
                {datei.satz}
              </p>
            )}
          </>
        )}
        <GrenzHinweis />
        {bild && blatt && (
          <NwBlatt open titel={blatt === 'abgeloest' ? N.ABGELOEST : N.ARCHIVIERT} onClose={() => setBlatt(null)} testId="berichte-blatt">
            <NwFristZeilen label={blatt === 'abgeloest' ? N.ABGELOEST : N.ARCHIVIERT}>
              {(blatt === 'abgeloest' ? bild.abgeloest : bild.archiviert).map((z) => zeile(z, true))}
            </NwFristZeilen>
          </NwBlatt>
        )}
        {erstellen && (
          <BerichtErstellenBlatt
            onClose={() => setErstellen(false)}
            rechte={rechte ?? null}
            standortId={standortId}
            jetzt={abruf === null ? undefined : () => abruf}
            onFertig={(b) => {
              setErstellen(false);
              if (b.vorlage === BEWERTUNG_VORLAGE && onBewertung) onBewertung();
              else onOeffnen(b.kennung);
            }}
            onOeffnen={(kennung) => {
              setErstellen(false);
              onOeffnen(kennung);
            }}
          />
        )}
      </div>
    </>
  );
}
