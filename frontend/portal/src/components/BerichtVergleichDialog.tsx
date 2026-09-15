import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type BerichtDetail, type BerichtEntwurf, type BerichtVergleich } from '../api';
import {
  abweichungenAnzahl,
  ERNEUT,
  keineAbweichung,
  LAEDT,
  SCHLIESSEN,
  seitenHebel,
  unveraendert,
  VERGLEICH_ANLASS,
  VERGLEICH_ENTWURF,
  VERGLEICH_LADEFEHLER,
  VERGLEICH_VERSION,
  vergleichTitel,
  vergleichZeilen,
  type BerichtRechte,
} from '../berichtDialoge';
import { abzugAus } from '../berichtSeite';
import './BerichtDialoge.css';

/**
 * Vergleich Entwurf gegen Berichtsstand (UEMS AP-12 IP-14, §5.3 Punkt 2, R1): je Abweichung Quelle, die Zahl des Stands,
 * die des Entwurfs, Version und Anlass — mit „wer, wann: warum“ aus dem Beleg —, darüber „3 Abweichungen · 15 Werte
 * unverändert“. Mit Freigabe-Recht führt „Als Berichtsstand Nr. n freigeben“ in den Freigabe-Dialog (mit „ersetzt …“).
 *
 * Der Dialog liest erst den Entwurf (die D4-Prüfung kann ihn neu bilden), dann den Vergleich — so gehören Liste und Knopf
 * zu DEMSELBEN Entwurf, und die Freigabe übernimmt ihn.
 *
 * ⚠ 375 px: je Abweichung eine Karte mit Wortpaaren statt einer Tabelle mit fünf Spalten — nichts läuft quer.
 */
export function BerichtVergleichDialog({
  open,
  onClose,
  detail,
  gegen,
  rechte,
  jetzt = () => Date.now(),
  onFreigeben,
}: {
  open: boolean;
  onClose: () => void;
  detail: BerichtDetail;
  gegen: number;
  rechte: BerichtRechte | null;
  jetzt?: () => number;
  onFreigeben: (entwurf: BerichtEntwurf) => void;
}) {
  const kennung = detail.bericht.kennung;
  const [daten, setDaten] = useState<{ entwurf: BerichtEntwurf; vergleich: BerichtVergleich } | null>(null);
  const [fehler, setFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);

  useEffect(() => {
    if (!open) return;
    let aktiv = true;
    setFehler(false);
    api
      .berichtEntwurf(kennung)
      .then((entwurf) => api.berichtVergleich(kennung, gegen).then((vergleich) => ({ entwurf, vergleich })))
      .then(
        (d) => aktiv && setDaten(d),
        () => aktiv && setFehler(true),
      );
    return () => {
      aktiv = false;
    };
  }, [open, kennung, gegen, versuch]);

  const abzug = daten ? abzugAus(daten.entwurf.abzug) : null;
  const zeilen = daten && abzug ? vergleichZeilen(daten.vergleich.abweichungen, abzug) : [];
  const hebel = daten ? seitenHebel(detail, daten.entwurf, rechte, jetzt()).freigeben : null;

  const fuss = (
    <>
      <Button variant="ghost" onClick={onClose}>
        {SCHLIESSEN}
      </Button>
      {daten && hebel && (
        <Button onClick={() => onFreigeben(daten.entwurf)} disabled={!hebel.vorschau.erlaubt}>
          {hebel.knopf}
        </Button>
      )}
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title={vergleichTitel(gegen)} footer={fuss}>
      <div className="vp-bd" data-testid="bericht-vergleich">
        {fehler ? (
          <div className="vp-alert vp-alert-err vp-bd-fehler" role="alert">
            <span>{VERGLEICH_LADEFEHLER}</span>
            <Button variant="outline" size="sm" onClick={() => setVersuch((v) => v + 1)}>
              {ERNEUT}
            </Button>
          </div>
        ) : !daten || !abzug ? (
          <p className="vp-bd-vorspann" aria-busy="true">
            {LAEDT}
          </p>
        ) : zeilen.length === 0 ? (
          <p className="vp-bd-satz">{keineAbweichung(gegen)}</p>
        ) : (
          <>
            <p className="vp-bd-vorspann" data-testid="bericht-vergleich-anzahl">
              {abweichungenAnzahl(zeilen.length)} · {unveraendert(abzug, zeilen.length)}
            </p>
            <ul className="vp-bd-abweichungen">
              {zeilen.map((z) => (
                <li key={`${z.quelle}-${z.name ?? ''}`} data-testid="bericht-abweichung">
                  <p className="vp-bd-abw-kopf">
                    <span className="vp-bd-kz">{z.quelle}</span>
                    {z.name && <b>{z.name}</b>}
                  </p>
                  <dl className="vp-bd-abw-zahlen">
                    <div>
                      <dt>Nr. {gegen}</dt>
                      <dd>{z.vorher}</dd>
                    </div>
                    <div>
                      <dt>{VERGLEICH_ENTWURF}</dt>
                      <dd className="vp-bd-abw-neu">{z.nachher}</dd>
                    </div>
                    <div>
                      <dt>{VERGLEICH_VERSION}</dt>
                      <dd>{z.version}</dd>
                    </div>
                    {z.anlass && (
                      <div>
                        <dt>{VERGLEICH_ANLASS}</dt>
                        <dd>
                          {z.anlass}
                          {z.beleg && <span className="vp-bd-beleg">{z.beleg}</span>}
                        </dd>
                      </div>
                    )}
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
        {hebel && !hebel.vorschau.erlaubt && hebel.vorschau.satz && <p className="vp-bd-satz">{hebel.vorschau.satz}</p>}
      </div>
    </Modal>
  );
}
