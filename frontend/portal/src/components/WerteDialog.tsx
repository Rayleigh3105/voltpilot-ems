/**
 * Die Tages- und Monatswerte einer Messstelle in einem Dialog (UEMS AP-08
 * IP-11): oben die Karte der Periode, darunter ihre Liste — am Tag die
 * Stunden, im Monat die Tage.
 *
 * Kein eigenes Gestaltungssystem: der zentrierte `Modal` des Hauses (am Telefon
 * Vollbild), das Zeitraum-Segment der Historie (`ZeitSegment`) und `VpDatePicker`
 * — beide in EINEM Rahmen verschmolzen. Er LIEST nur — `GET /api/v1/messstellen/{kennzeichen}/werte`
 * (IP-9); was er zeigt, leitet `src/uemsWerteKarte.ts` ab.
 *
 * Hat die Zahl der Karte zwei oder mehr Versionen, öffnet ihr Einstieg die
 * Historie in einem gestapelten Dialog (`WertVersionen`, AP-08 IP-18).
 */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type MessstelleWerte } from '../api';
import { isoMonat, isoTag, verschiebe } from '../picker/datum';
import { einstieg } from '../uemsWertVersionen';
import { anfragen, karte, liste, type Anfrage, type KartenArt } from '../uemsWerteKarte';
import { ZeitSegment } from './HistorieWelt';
import { ErrorState, Skeleton } from './States';
import { VpDatePicker } from './VpDatePicker';
import { VersionenDialog, VersionenEinstieg } from './WertVersionen';
import { WerteKarte, WerteListe } from './WerteKarte';

/** Die EINE Beschriftung — im Menü und im Kopf des Dialogs. */
export const WERTE_LABEL = 'Tages- und Monatswerte';

const ARTEN = [
  { id: 'tag', label: 'Tag' },
  { id: 'monat', label: 'Monat' },
] as const;

interface Geladen {
  schluessel: string;
  karte: MessstelleWerte;
  liste: MessstelleWerte;
}

const hole = (kennzeichen: string, a: Anfrage) => api.messstelleWerte(kennzeichen, a.raster, a.von, a.bis);

export function WerteDialog({
  open,
  kennzeichen,
  titel,
  onClose,
  anfang,
  heute = isoTag(new Date()),
}: {
  open: boolean;
  /** Das Kennzeichen, das die Messstelle HEUTE trägt; null = nichts gewählt, nichts geladen. */
  kennzeichen: string | null;
  /** Die Messstelle („MS-10 · Netzbezug Halle 2“) — erste Zeile des Dialogs, sie bricht um statt abzuschneiden. */
  titel: string;
  onClose: () => void;
  /** Womit der Dialog öffnet; ohne Angabe der Vortag. */
  anfang?: { art: KartenArt; wert: string };
  /** Der heutige Tag (JJJJ-MM-TT) — die Grenze des Blätterns. */
  heute?: string;
}) {
  const [art, setArt] = useState<KartenArt>(anfang?.art ?? 'tag');
  const [tag, setTag] = useState(anfang?.art === 'tag' ? anfang.wert : verschiebe(heute, -1));
  const [monat, setMonat] = useState(anfang?.art === 'monat' ? anfang.wert : heute.slice(0, 7));
  const [geladen, setGeladen] = useState<Geladen | null>(null);
  const [fehler, setFehler] = useState(false);
  const [neu, setNeu] = useState(0);
  const [versionenOffen, setVersionenOffen] = useState(false);

  const wert = art === 'tag' ? tag : monat;
  const schluessel = `${kennzeichen}|${art}|${wert}|${neu}`;

  useEffect(() => {
    if (!open || !kennzeichen) return;
    let aktiv = true;
    setFehler(false);
    const a = anfragen(art, wert);
    Promise.all([hole(kennzeichen, a.karte), hole(kennzeichen, a.liste)])
      .then(([k, l]) => aktiv && setGeladen({ schluessel, karte: k, liste: l }))
      .catch(() => aktiv && setFehler(true));
    return () => {
      aktiv = false;
    };
  }, [open, kennzeichen, art, wert, schluessel]);

  const blaettern = useCallback(
    (schritt: number) => {
      if (art === 'tag') setTag((t) => verschiebe(t, schritt));
      else setMonat((m) => isoMonat(new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + schritt, 1, 12)));
    },
    [art],
  );

  // Umschalten behält den gewählten Zeitraum: vom Tag in SEINEN Monat, vom Monat auf einen Tag darin.
  const umschalten = (neu: KartenArt) => {
    if (neu === 'monat') setMonat(tag.slice(0, 7));
    else if (tag.slice(0, 7) !== monat) setTag(`${monat}-01`);
    setArt(neu);
  };

  if (!open) return null;
  const vorGesperrt = art === 'tag' ? tag >= heute : monat >= heute.slice(0, 7);
  const aktuell = geladen?.schluessel === schluessel ? geladen : null;
  const k = aktuell ? karte(aktuell.karte) : null;
  const e = aktuell ? einstieg(aktuell.karte) : null;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={WERTE_LABEL}
      >
        <div className="vp-wk">
          {/* Nicht im Kopf: dort schnitte die Kopfzeile den Namen bei 375 px ab. */}
          <p className="vp-wk-messstelle">{titel}</p>
          {/* EIN Bedienelement (Captain 14.09.2026, Variante B): ein Kasten, oben Tag|Monat, darunter ‹ Datum ›. */}
          <div className="vp-wk-zeitwahl" role="group" aria-label="Zeitraum">
            <ZeitSegment label="Tag oder Monat" optionen={ARTEN} wert={art} onWert={umschalten} />
            <div className="vp-wk-datumzeile">
              <button type="button" className="vp-wk-schritt" aria-label="Vorheriger Zeitraum" onClick={() => blaettern(-1)}>
                <Icon name="chevron-left" size={18} />
              </button>
              <VpDatePicker
                ariaLabel={art === 'tag' ? 'Tag wählen' : 'Monat wählen'}
                art={art}
                value={wert}
                max={art === 'tag' ? heute : heute.slice(0, 7)}
                onChange={(w) => (art === 'tag' ? setTag(w) : setMonat(w))}
                className="vp-wk-datum"
              />
              <button
                type="button"
                className="vp-wk-schritt"
                aria-label="Nächster Zeitraum"
                disabled={vorGesperrt}
                onClick={() => blaettern(1)}
              >
                <Icon name="chevron-right" size={18} />
              </button>
            </div>
          </div>

          {fehler ? (
            <ErrorState message="Die Werte konnten nicht geladen werden." onRetry={() => setNeu((n) => n + 1)} />
          ) : !aktuell ? (
            <div aria-busy="true">
              <Skeleton height={148} />
            </div>
          ) : (
            <>
              {k && (
                <WerteKarte
                  karte={k}
                  grund={k.grund}
                  versionen={e && <VersionenEinstieg einstieg={e} onOeffnen={() => setVersionenOffen(true)} />}
                />
              )}
              <WerteListe titel={art === 'tag' ? 'Stunden' : 'Tage'} zeilen={liste(aktuell.liste)} />
            </>
          )}
        </div>
      </Modal>
      {/* Neben dem Dialog, nicht darin: React-Ereignisse blubbern durch Portale — Escape und Klicks gehören dem oberen. */}
      {kennzeichen && k && (
        <VersionenDialog
          open={versionenOffen && e !== null}
          kennzeichen={kennzeichen}
          einstieg={e}
          messstelle={titel}
          periode={k.titel}
          onClose={() => setVersionenOffen(false)}
        />
      )}
    </>
  );
}
