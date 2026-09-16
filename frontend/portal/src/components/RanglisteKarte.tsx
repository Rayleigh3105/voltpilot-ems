import { Recht } from './Recht';
/**
 * **Die Rangliste** — „Reihenfolge bei knapper Leistung" (Verbrauchsmanagement
 * v1 §5, Paket P4).
 *
 * Jede Regel und jeder Satz liegt im reinen `src/verbraucherZone.ts`; hier wird
 * NUR gerendert und gezogen.
 *
 * **⚠ Der SERVER ist die Autorität.** Gespeichert wird die Liste flach
 * (`ranglisteRumpf`), und die Antwort — die Normalform — ersetzt die lokale
 * Anordnung. Eine Reihenfolge, die die Maschine nicht halten kann, springt
 * damit SOFORT sichtbar an ihren Platz, statt beim nächsten Laden.
 *
 * **⚠ Zwei Wege, dieselbe Handlung:** Ziehen am Rechner, ▲ ▼ überall (das
 * Cockpit-Anpassen-Muster). Am Telefon gibt es kein HTML5-Drag, also sind die
 * zwei Tasten dort der einzige Weg — sie sind deshalb keine Zugabe, sondern die
 * Bedienung.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  RANGLISTE_ABBRECHEN,
  RANGLISTE_AENDERN,
  RANGLISTE_FEHLER,
  RANGLISTE_FOLGEN_TITEL,
  RANGLISTE_GRUPPE_HINWEIS,
  RANGLISTE_HINWEIS,
  RANGLISTE_HOCH,
  RANGLISTE_RUNTER,
  RANGLISTE_SPEICHERN,
  RANGLISTE_SPEICHERT,
  type RanglisteEintrag,
  entwurfPositionen,
  ranglisteFolgen,
  ranglisteRumpf,
  verschiebe,
  zeilenKey,
  zeilenTag,
  zeilenTitel,
  ziehe,
} from '../verbraucherZone';

export interface RanglisteKarteProps {
  liste: RanglisteEintrag[];
  /** Speichert die Reihenfolge; `null` = die Anlage ist (noch) nicht bedienbar. */
  onSpeichern?: (rumpf: { art: string; entityId?: string }[]) => Promise<void>;
}

export function RanglisteKarte({ liste, onSpeichern }: RanglisteKarteProps) {
  const [bearbeiten, setBearbeiten] = useState(false);
  const [entwurf, setEntwurf] = useState<RanglisteEintrag[]>(liste);
  const [gezogen, setGezogen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState('');

  // Eine frisch geladene Liste gewinnt IMMER gegen einen Entwurf, der nicht
  // gespeichert wurde - sie ist, was wirklich gilt.
  useEffect(() => {
    if (!bearbeiten) setEntwurf(liste);
  }, [liste, bearbeiten]);

  const zeilen = bearbeiten ? entwurf : liste;
  // Beim Sortieren zaehlt die Flaeche selbst - die gespeicherten Positionen
  // meinen dann eine Reihenfolge, die es gerade nicht mehr gibt.
  const positionen = bearbeiten ? entwurfPositionen(entwurf) : zeilen.map((e) => e.position);
  const gruppen = zeilen.some((e) => (e.mitglieder?.length ?? 0) > 1);

  const beenden = () => {
    setBearbeiten(false);
    setEntwurf(liste);
    setFehler('');
  };

  const speichern = async () => {
    if (!onSpeichern) return;
    setBusy(true);
    setFehler('');
    try {
      await onSpeichern(ranglisteRumpf(entwurf));
      setBearbeiten(false);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : RANGLISTE_FEHLER);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vp-vz-rankbox">
      {onSpeichern && (
        <div className="vp-vz-rankhead">
          <Recht aktion="betriebsweise.aendern"><button
            type="button"
            className="vp-vz-linkbtn"
            onClick={() => (bearbeiten ? beenden() : setBearbeiten(true))}
          >
            {bearbeiten ? RANGLISTE_ABBRECHEN : RANGLISTE_AENDERN}
          </button></Recht>
        </div>
      )}
      {bearbeiten && <p className="vp-vz-quiet">{RANGLISTE_HINWEIS}</p>}
      <ol className={`vp-vz-rank${bearbeiten ? ' is-edit' : ''}`}>
        {zeilen.map((e, i) => (
          <li
            key={zeilenKey(e)}
            draggable={bearbeiten}
            onDragStart={() => setGezogen(i)}
            onDragOver={(ev) => {
              if (gezogen === null) return;
              ev.preventDefault();
            }}
            onDrop={(ev) => {
              if (gezogen === null) return;
              ev.preventDefault();
              setEntwurf((l) => ziehe(l, gezogen, i));
              setGezogen(null);
            }}
            onDragEnd={() => setGezogen(null)}
          >
            {bearbeiten && <span className="vp-vz-grip" aria-hidden="true">⋮⋮</span>}
            <span className="vp-vz-pos">{positionen[i]}</span>
            <span className="vp-vz-rankname">{zeilenTitel(e)}</span>
            {zeilenTag(e) && <span className="vp-vz-sub">{zeilenTag(e)}</span>}
            {bearbeiten && (
              <span className="vp-vz-move">
                <Recht aktion="betriebsweise.aendern"><button
                  type="button"
                  aria-label={`${RANGLISTE_HOCH}: ${zeilenTitel(e)}`}
                  disabled={i === 0}
                  onClick={() => setEntwurf((l) => verschiebe(l, i, -1))}
                >
                  <Icon name="arrow-up" size={14} />
                </button></Recht>
                <Recht aktion="betriebsweise.aendern"><button
                  type="button"
                  aria-label={`${RANGLISTE_RUNTER}: ${zeilenTitel(e)}`}
                  disabled={i === zeilen.length - 1}
                  onClick={() => setEntwurf((l) => verschiebe(l, i, 1))}
                >
                  <Icon name="arrow-down" size={14} />
                </button></Recht>
              </span>
            )}
          </li>
        ))}
      </ol>
      {gruppen && <p className="vp-vz-quiet">{RANGLISTE_GRUPPE_HINWEIS}</p>}
      {bearbeiten && (
        <>
          <div className="vp-vz-folgen">
            <b>{RANGLISTE_FOLGEN_TITEL}</b>
            <ul>
              {ranglisteFolgen(entwurf).map((satz) => (
                <li key={satz}>{satz}</li>
              ))}
            </ul>
          </div>
          {fehler && <p className="vp-vz-fehler" role="alert">{fehler}</p>}
          {/* ⚠ Nur EIN Knopf: „Abbrechen" steht oben am Kopf. Zwei Wege aus
              demselben Zustand, die verschieden heissen, sind eine Frage mehr,
              als die Fläche stellen muss. */}
          <div className="vp-vz-rankact">
            <Recht aktion="betriebsweise.aendern"><button type="button" className="vp-vz-primary" disabled={busy} onClick={speichern}>
              {busy ? RANGLISTE_SPEICHERT : RANGLISTE_SPEICHERN}
            </button></Recht>
          </div>
        </>
      )}
    </div>
  );
}
