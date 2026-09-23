import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type Bericht, type BerichtDetail, type BerichtEntwurf, type Selbstauskunft } from '../api';
import { BEWERTUNG_VORLAGE, rechteAus } from '../berichtDialoge';
import { gueltigerStand } from '../berichtSeite';
import {
  ANLEGEN_KNOPF,
  bewertungWaehlen,
  DATEI_FEHLER,
  darfBewertung,
  ENTWURF_LADEFEHLER,
  entwurfZeile,
  KEIN_STAND,
  KEINE_BEWERTUNG,
  LADEFEHLER,
  revisionVermerk,
  STAENDE_TITEL,
  STAND_TITEL,
  standSatz,
  standZeilen,
} from '../bewertungStand';
import { UEMS_NORMGRENZE } from '../glossar';
import { BerichtAnlegenDialog } from './BerichtAnlegenDialog';
import { BerichtFreigebenDialog } from './BerichtFreigebenDialog';
import { ErrorState, Skeleton } from './States';

/**
 * „Bewertung › Bewertungsstand“ (UEMS AP-16 IP-25, §5.5, R7/R10): Entwurf mit Datenstand, die Stände (Nr., Freigabe,
 * Freigeber, Prüfsumme gekürzt, ersetzt durch), der Vermerk „Revision nötig — <Anlass>“, der Freigabe-Dialog der
 * Bericht-Maschine und PDF/CSV je Stand. Nichts ist nachgebaut: die Bewertung ist ein Bericht der Vorlage
 * `energetische_bewertung` (E5 = A), Anlegen und Freigeben sind die Dialoge aus AP-12. Alle Sätze kommen aus
 * `bewertungStand.ts`/`glossar.ts`; ohne `bewertung.abrufen` (aus `/me`) gibt es die Fläche nicht.
 */
export function BewertungStand({
  selbst,
  berichte,
  onGeaendert,
}: {
  selbst: Selbstauskunft | null;
  berichte: Bericht[] | null;
  /** Ein Stand oder eine Bewertung ist neu — die Seite liest die Berichte neu (Frist, Kriterien-Satz). */
  onGeaendert: () => void;
}) {
  const bewertung = bewertungWaehlen(berichte);
  const kennung = bewertung?.kennung ?? null;
  const [detail, setDetail] = useState<BerichtDetail | null>(null);
  const [entwurf, setEntwurf] = useState<BerichtEntwurf | null>(null);
  const [entwurfFehler, setEntwurfFehler] = useState(false);
  const [fehler, setFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);
  const [dialog, setDialog] = useState<'anlegen' | 'freigeben' | null>(null);
  const [abruf, setAbruf] = useState<{ satz: string; fehler: boolean } | null>(null);
  const [laeuft, setLaeuft] = useState<string | null>(null);

  useEffect(() => {
    if (!kennung) return;
    let aktiv = true;
    setFehler(false);
    setEntwurfFehler(false);
    api.bericht(kennung).then(
      (d) => {
        if (!aktiv) return;
        setDetail(d);
        if (d.bericht.archiviert_am !== null) return;
        api.berichtEntwurf(kennung).then(
          (e) => aktiv && setEntwurf(e),
          () => aktiv && setEntwurfFehler(true),
        );
      },
      () => aktiv && setFehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [kennung, versuch]);

  if (!darfBewertung(selbst)) return null;

  async function abrufen(nr: number, format: 'pdf' | 'csv', datei: string) {
    if (!kennung) return;
    setLaeuft(`${nr}-${format}`);
    setAbruf(null);
    try {
      const blob = await api.berichtDatei(kennung, nr, format);
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = datei;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
      setAbruf({ satz: `${format.toUpperCase()} von Stand Nr. ${nr} abgerufen — der Abruf ist protokolliert.`, fehler: false });
    } catch {
      setAbruf({ satz: DATEI_FEHLER, fehler: true });
    } finally {
      setLaeuft(null);
    }
  }

  const gueltig = detail ? gueltigerStand(detail.staende) : null;
  const vermerk = detail ? revisionVermerk(detail) : null;
  const satz = detail ? standSatz(detail) : null;
  const zeilen = detail ? standZeilen(detail, true) : [];
  const offen = detail !== null && detail.bericht.archiviert_am === null;

  return (
    <section className="vp-bw-karte vp-bw-stand" aria-labelledby="bw-stand" data-testid="bewertung-stand">
      <div className="vp-bw-karte-kopf">
        <h2 id="bw-stand">{STAND_TITEL}</h2>
        {!bewertung && berichte && (
          <Button size="sm" variant="outline" iconLeft={<Icon name="plus" size={16} />} onClick={() => setDialog('anlegen')} data-testid="bewertung-anlegen-knopf">
            {ANLEGEN_KNOPF}
          </Button>
        )}
      </div>

      {!bewertung ? (
        <p className="vp-bw-leise" data-testid="bewertung-keine">
          {KEINE_BEWERTUNG}
        </p>
      ) : fehler ? (
        <ErrorState message={LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />
      ) : !detail ? (
        <div aria-busy="true">
          <Skeleton height={96} />
        </div>
      ) : (
        <>
          <p className="vp-bw-stand-satz" data-testid="bewertung-stand-satz">
            {satz ?? KEIN_STAND}
          </p>
          {vermerk && (
            <div className="vp-alert vp-alert-warn vp-bw-revision" role="status" data-testid="bewertung-revision">
              <strong>{vermerk.titel}</strong>
              {vermerk.anstoesse.map((a) => (
                <span key={a.id}>{a.zeile}</span>
              ))}
              <span>{vermerk.satz} Der Entwurf ist neu gebildet; freigegeben wird er als Stand Nr. {vermerk.nr + 1}.</span>
            </div>
          )}

          {offen && (
            <div className="vp-bw-entwurf" data-testid="bewertung-entwurf">
              {entwurf ? (
                <>
                  <p>{entwurfZeile(detail.bericht, entwurf)}</p>
                  <Button size="sm" onClick={() => setDialog('freigeben')} data-testid="bewertung-freigeben-knopf">
                    {gueltig ? `Als Stand Nr. ${gueltig.nr + 1} freigeben` : `Als Stand Nr. 1 freigeben`}
                  </Button>
                </>
              ) : entwurfFehler ? (
                <p className="vp-bw-hinweis" role="status">
                  {ENTWURF_LADEFEHLER}
                </p>
              ) : (
                <Skeleton height={40} />
              )}
            </div>
          )}

          {zeilen.length > 0 && (
            <>
              <h3 className="vp-bw-stand-titel">{STAENDE_TITEL}</h3>
              <ul className="vp-bw-staende" data-testid="bewertung-staende">
                {zeilen.map((z) => (
                  <li key={z.nr} className={z.gueltig ? 'is-gueltig' : undefined} data-testid={`bewertung-stand-${z.nr}`}>
                    <div className="vp-bw-stand-kopf">
                      <strong>{z.titel}</strong>
                      <Badge variant={z.gueltig ? 'ok' : 'off'}>{z.zustand}</Badge>
                    </div>
                    <span className="vp-bw-leise">{z.freigabe}</span>
                    <span className="vp-bw-leise" title={z.pruefsummeVoll}>
                      {z.pruefsumme}
                    </span>
                    {z.anlass && <span className="vp-bw-leise">{z.anlass}</span>}
                    <span className="vp-bw-stand-dateien">
                      {z.dateien.map((d) => (
                        <Button
                          key={d.format}
                          size="sm"
                          variant="outline"
                          iconLeft={<Icon name="file-text" size={16} />}
                          disabled={laeuft !== null}
                          onClick={() => void abrufen(z.nr, d.format, d.datei)}
                          aria-label={`${d.text} von Stand Nr. ${z.nr}`}
                          data-testid={`bewertung-${d.format}-${z.nr}`}
                        >
                          {d.text}
                        </Button>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {abruf && (
            <p className={`vp-alert ${abruf.fehler ? 'vp-alert-err' : 'vp-alert-ok'}`} role="status" data-testid="bewertung-abruf">
              {abruf.satz}
            </p>
          )}
        </>
      )}
      <p className="vp-bw-leise">{UEMS_NORMGRENZE}</p>

      {dialog === 'anlegen' && (
        <BerichtAnlegenDialog
          open
          onClose={() => setDialog(null)}
          rechte={selbst ? rechteAus(selbst) : null}
          nurVorlage={BEWERTUNG_VORLAGE}
          onAngelegt={() => {
            setDialog(null);
            onGeaendert();
          }}
          onOeffnen={() => {
            setDialog(null);
            onGeaendert();
          }}
        />
      )}
      {dialog === 'freigeben' && detail && entwurf && (
        <BerichtFreigebenDialog
          open
          onClose={() => setDialog(null)}
          detail={detail}
          entwurf={entwurf}
          onEntwurf={setEntwurf}
          onFreigegeben={() => {
            setDialog(null);
            setEntwurf(null);
            setVersuch((v) => v + 1);
            onGeaendert();
          }}
        />
      )}
    </section>
  );
}
