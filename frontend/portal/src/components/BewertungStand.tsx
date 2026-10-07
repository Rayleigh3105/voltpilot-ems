import { useEffect, useState } from 'react';
import { GrenzSatz } from './GrenzSatz';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type Bericht, type BerichtDetail, type BerichtEntwurf, type BerichtStandKurz, type Selbstauskunft } from '../api';
import { BEWERTUNG_VORLAGE, rechteAus } from '../berichtDialoge';
import { gueltigerStand } from '../berichtSeite';
import {
  ANLEGEN_KNOPF,
  bewertungWaehlen,
  DATEI_FEHLER,
  darfBewertung,
  ENTWURF_LADEFEHLER,
  LADEFEHLER,
  revisionVermerk,
  STAND_TITEL,
} from '../bewertungStand';
import {
  entwurfBild,
  FRUEHERE_AUSBLENDEN,
  FRUEHERE_BEWERTUNGEN,
  FRUEHERE_BEWERTUNGEN_KURZ,
  FRUEHERE_STAENDE,
  KEINE_BEWERTUNG_SATZ,
  standBild,
} from '../bewertungErgebnis';
import { hashForRoute, pageRoute } from '../nav';
import { BerichtAnlegenDialog } from './BerichtAnlegenDialog';
import { BerichtFreigebenDialog } from './BerichtFreigebenDialog';
import { BerichtVergleichDialog } from './BerichtVergleichDialog';
import { Fehlergrenze } from './Fehlergrenze';
import { FristDatum } from './FristDatum';
import { ErrorState, Skeleton } from './States';
import './BewertungErgebnis.css';

/**
 * „Bewertung › Bewertungsstand“ (UEMS AP-16 IP-25, §5.5, R7/R10; Gestalt nach Konzept Auswerten a1 §6.7): der gültige
 * Stand und der Entwurf als Datumsblöcke — „Stand 1 · 30.04.2029 · gilt · freigegeben von …“ mit PDF und CSV, darunter
 * „Entwurf · Neuer Stand mit den Zahlen bis März 2029“ mit „Als Stand Nr. 2 freigeben“ und „Unterschiede ansehen“. Ersetzte
 * Stände klappen unter „Frühere Stände“ auf (mit PDF und CSV), frühere Bewertungen stehen in den Nachweisen. Nichts ist
 * nachgebaut: die Bewertung
 * ist ein Bericht der Vorlage `energetische_bewertung` (E5 = A), Anlegen, Vergleichen und Freigeben sind die Dialoge aus
 * AP-12. Ohne `bewertung.abrufen` (aus `/me`) gibt es die Fläche nicht. Die Marke `bewertung_ueberpruefung` bleibt das
 * Ziel des Wiedervorlage-Schritts „Neuen Stand freigeben“.
 */
export function BewertungStand({
  selbst,
  berichte,
  onGeaendert,
}: {
  selbst: Selbstauskunft | null;
  berichte: Bericht[] | null;
  /** Ein Stand oder eine Bewertung ist neu — die Seite liest die Berichte neu (Statuszeile, Datengrundlage, Kriterien-Satz). */
  onGeaendert: () => void;
}) {
  const bewertung = bewertungWaehlen(berichte);
  const kennung = bewertung?.kennung ?? null;
  const [detail, setDetail] = useState<BerichtDetail | null>(null);
  const [entwurf, setEntwurf] = useState<BerichtEntwurf | null>(null);
  const [entwurfFehler, setEntwurfFehler] = useState(false);
  const [fehler, setFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);
  const [dialog, setDialog] = useState<'anlegen' | 'freigeben' | 'vergleich' | null>(null);
  const [abruf, setAbruf] = useState<{ satz: string; fehler: boolean } | null>(null);
  const [laeuft, setLaeuft] = useState<string | null>(null);
  const [fruehereOffen, setFruehereOffen] = useState(false);

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
      setAbruf({ satz: `${format.toUpperCase()} von Stand Nr. ${nr} abgerufen - der Abruf ist protokolliert.`, fehler: false });
    } catch {
      setAbruf({ satz: DATEI_FEHLER, fehler: true });
    } finally {
      setLaeuft(null);
    }
  }

  const gueltig = detail ? gueltigerStand(detail.staende) : null;
  const vermerk = detail ? revisionVermerk(detail) : null;
  const offen = detail !== null && detail.bericht.archiviert_am === null;
  const neu = detail && entwurf ? entwurfBild(detail.bericht, entwurf, gueltig !== null) : null;
  // „Frühere Stände“: die ersetzten Stände dieser Bewertung klappen hier auf (mit PDF und CSV - die Berichte-Seite
  // ruft noch keine Dateien ab); frühere Bewertungen stehen in den Nachweisen.
  const ersetzte = detail ? [...detail.staende].filter((x) => x.ersetzt_durch_nr !== null).sort((a, b) => b.nr - a.nr) : [];
  const fruehereBewertungen = (berichte ?? []).some((b) => b.vorlage === BEWERTUNG_VORLAGE && b.kennung !== kennung)
    ? hashForRoute(pageRoute('portfolio-berichte'))
    : null;

  const standZeile = (s: BerichtStandKurz, ton: 'erledigt' | 'bald') => {
    if (!detail) return null;
    const bild = standBild(detail, s);
    return (
      <li key={s.nr} className="vp-be-stand" data-testid={`bewertung-stand-${s.nr}`}>
        <FristDatum wort={bild.wort} tag={bild.tag} jahr={bild.jahr} satz={bild.satz} ton={ton} />
        <span className="vp-be-stand-text">
          <span className="vp-be-stand-titel">{bild.titel}</span>
          {bild.anlass && <span className="vp-be-stand-grund">{bild.anlass}</span>}
          <span className="vp-be-stand-dateien">
            {bild.dateien.map((d) => (
              <button
                key={d.format}
                type="button"
                className="vp-be-link"
                disabled={laeuft !== null}
                onClick={() => void abrufen(s.nr, d.format, d.datei)}
                aria-label={`${d.text} von Stand Nr. ${s.nr}`}
                data-testid={`bewertung-${d.format}-${s.nr}`}
              >
                {d.text}
              </button>
            ))}
          </span>
        </span>
      </li>
    );
  };

  return (
    <section
      id="bewertung-stand"
      className="vp-be-karte"
      aria-labelledby="bw-stand"
      data-testid="bewertung-stand"
      data-entscheid="bewertung_ueberpruefung"
    >
      <div className="vp-be-blockkopf">
        <h2 id="bw-stand">{STAND_TITEL}</h2>
        {ersetzte.length > 0 ? (
          <button
            type="button"
            className="vp-be-link"
            aria-expanded={fruehereOffen}
            onClick={() => setFruehereOffen((o) => !o)}
            data-testid="bewertung-fruehere"
          >
            {fruehereOffen ? FRUEHERE_AUSBLENDEN : FRUEHERE_STAENDE}
          </button>
        ) : (
          fruehereBewertungen && (
            <a className="vp-be-link" href={fruehereBewertungen} data-testid="bewertung-fruehere">
              {FRUEHERE_BEWERTUNGEN_KURZ}
            </a>
          )
        )}
      </div>

      {!bewertung ? (
        <div className="vp-be-leer">
          <p className="vp-be-leise" data-testid="bewertung-keine">
            {KEINE_BEWERTUNG_SATZ}
          </p>
          {berichte && (
            <Button size="sm" variant="outline" iconLeft={<Icon name="plus" size={16} />} onClick={() => setDialog('anlegen')} data-testid="bewertung-anlegen-knopf">
              {ANLEGEN_KNOPF}
            </Button>
          )}
        </div>
      ) : fehler ? (
        <ErrorState message={LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />
      ) : !detail ? (
        <div aria-busy="true">
          <Skeleton height={96} />
        </div>
      ) : (
        <>
          {vermerk && (
            <div className="vp-be-hinweis is-warn" role="status" data-testid="bewertung-revision">
              <span className="vp-be-hinweis-icon" aria-hidden="true">
                <Icon name="alert-triangle" size={18} />
              </span>
              <span className="vp-be-hinweis-text">
                <b>{vermerk.titel}</b>
                {vermerk.anstoesse.map((a) => (
                  <span key={a.id}>{a.zeile}</span>
                ))}
                <span>
                  {vermerk.satz} Der Entwurf ist neu gebildet; freigegeben wird er als Stand Nr. {vermerk.nr + 1}.
                </span>
              </span>
            </div>
          )}

          <ul className="vp-be-staende" data-testid="bewertung-staende">
            {gueltig && standZeile(gueltig, 'erledigt')}
            {fruehereOffen && ersetzte.map((x) => standZeile(x, 'bald'))}
            {offen && (
              <li className="vp-be-stand" data-testid="bewertung-entwurf">
                {neu ? (
                  <>
                    <FristDatum wort="Entwurf" tag={neu.tag} jahr={neu.jahr} satz={neu.satz} ton="plan" />
                    <span className="vp-be-stand-text">
                      <span className="vp-be-stand-titel">{neu.titel}</span>
                      <span className="vp-be-stand-grund">{neu.warum}</span>
                    </span>
                  </>
                ) : entwurfFehler ? (
                  <p className="vp-be-leise" role="status">
                    {ENTWURF_LADEFEHLER}
                  </p>
                ) : (
                  <Skeleton height={52} />
                )}
              </li>
            )}
          </ul>
          {fruehereOffen && fruehereBewertungen && (
            <a className="vp-be-link" href={fruehereBewertungen}>
              {FRUEHERE_BEWERTUNGEN}
            </a>
          )}

          {offen && entwurf && (
            <div className="vp-be-knoepfe">
              <Button size="sm" onClick={() => setDialog('freigeben')} data-testid="bewertung-freigeben-knopf" data-entscheid-schritt>
                {gueltig ? `Als Stand Nr. ${gueltig.nr + 1} freigeben` : 'Als Stand Nr. 1 freigeben'}
              </Button>
              {gueltig && (
                <Button size="sm" variant="ghost" onClick={() => setDialog('vergleich')} data-testid="bewertung-unterschiede-knopf">
                  Unterschiede ansehen
                </Button>
              )}
            </div>
          )}
          {abruf && (
            <p className={`vp-alert ${abruf.fehler ? 'vp-alert-err' : 'vp-alert-ok'}`} role="status" data-testid="bewertung-abruf">
              {abruf.satz}
            </p>
          )}
        </>
      )}
      <GrenzSatz className="vp-be-leise" />

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
      {dialog === 'vergleich' && detail && gueltig && (
        // Der Vergleich ist der Dialog der Bericht-Maschine; scheitert er beim Zeichnen, bleibt die Bewertung stehen.
        <Fehlergrenze>
          <BerichtVergleichDialog
            open
            onClose={() => setDialog(null)}
            detail={detail}
            gegen={gueltig.nr}
            rechte={selbst ? rechteAus(selbst) : null}
            onFreigeben={(e) => {
              setEntwurf(e);
              setDialog('freigeben');
            }}
          />
        </Fehlergrenze>
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
