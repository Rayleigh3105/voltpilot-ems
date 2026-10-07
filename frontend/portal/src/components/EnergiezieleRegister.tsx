import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type Energieziel, type EnergiezielStand, type Massnahme } from '../api';
import * as B from '../energiezielBild';
import { useRollen } from '../rollen';
import { merkeAbruf } from '../routenUhr';
import { useIsPhone } from '../useIsPhone';
import { AuffaelligkeitHinweis } from './AuffaelligkeitHinweis';
import { BegriffAufklapper } from './BegriffAufklapper';
import { EnergiezielSetzenFuehrung } from './EnergiezielSetzenFuehrung';
import { GrenzHinweis } from './GrenzSatz';
import { MassnahmeAnlegenDialog } from './MassnahmeDialoge';
import { RowMenu } from './RowMenu';
import { StandSkala } from './StandSkala';
import './kacheln/Kacheln.css';
import '../pages/Energieziele.css';

type Laufend = {
  ez: Energieziel;
  stand: EnergiezielStand | null;
  massnahmen: B.MassnahmenAmZiel | null;
};
type Lage =
  | { art: 'laedt' }
  | { art: 'fehler' }
  | { art: 'da'; laufend: Laufend[]; abgeschlossen: Energieziel[]; abruf: string | null };

const VERWALTEN = 'verbesserung.verwalten';

/** Ein laufendes Energieziel: offen und nicht schon zur Bewertung fällig, die zuerst - sonst nach Beginn. */
const laufendZuerst = (a: Energieziel, b: Energieziel) => a.zielperiode.localeCompare(b.zielperiode);

/**
 * Der Reiter „Energieziele“ (Konzept Verbessern §6.3, PR 1): die Antwort zuerst - ob die laufenden Energieziele auf
 * Kurs sind -, darunter ein Hinweis auf offene Auffälligkeiten an ihren Kennzahlen, je laufendes Energieziel eine Karte
 * mit der Skala aus Auswerten und dem nächsten Schritt („Maßnahme planen“), Abgeschlossenes als ruhige Reihe. Die Lage,
 * die Lücke in kWh und die Monate kommen von der Route (Operation `kurs`), die Maßnahmen über `?energieziel=`.
 */
export function EnergiezieleRegister({
  onOeffnen,
  onMassnahme,
}: {
  onOeffnen: (id: string) => void;
  onMassnahme?: (id: string) => void;
}) {
  const [lage, setLage] = useState<Lage>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);
  const [setzen, setSetzen] = useState(false);
  const [planen, setPlanen] = useState<Energieziel | null>(null);
  const istTelefon = useIsPhone();
  const rollen = useRollen();
  const darfSetzen =
    rollen.darf(VERWALTEN, null) || (rollen.selbst?.standorte ?? []).some((s) => rollen.darf(VERWALTEN, s.id));

  useEffect(() => {
    let aktiv = true;
    setLage({ art: 'laedt' });
    api
      .energieziele()
      .then(async ({ energieziele }) => {
        const offen = energieziele.filter((ez) => ez.zustand === 'offen').sort(laufendZuerst);
        const abgeschlossen = energieziele
          .filter((ez) => ez.zustand !== 'offen')
          .sort((a, b) => b.zielperiode.localeCompare(a.zielperiode));
        const laufend = await Promise.all(
          offen.map(async (ez): Promise<Laufend> => {
            const [stand, liste] = await Promise.all([
              api.energiezielStand(ez.id).catch(() => null),
              api.massnahmenZumEnergieziel(ez.id).catch(() => null),
            ]);
            return { ez, stand, massnahmen: liste ? B.massnahmenAmZiel(liste) : null };
          }),
        );
        const abruf = laufend.find((l) => l.stand)?.stand?.abruf ?? null;
        merkeAbruf(abruf);
        if (aktiv) setLage({ art: 'da', laufend, abgeschlossen, abruf });
      })
      .catch(() => aktiv && setLage({ art: 'fehler' }));
    return () => {
      aktiv = false;
    };
  }, [versuch]);

  const neu = () => setVersuch((v) => v + 1);
  const setzenKnopf = darfSetzen && !istTelefon && (
    <Button variant="outline" size="sm" iconLeft={<Icon name="plus" size={15} />} onClick={() => setSetzen(true)} data-testid="energieziel-setzen-knopf">
      {B.KNOPF_SETZEN}
    </Button>
  );

  return (
    <section className="vp-ezl vp-k-farben" data-testid="energieziele-register">
      <header className="vp-ezl-kopf">
        <div className="vp-ezl-kopf-text">
          <h1>{B.TITEL}</h1>
          <p className="vp-ezl-meta">{B.UNTERTITEL}</p>
        </div>
        {setzenKnopf}
        {darfSetzen && istTelefon && (
          <span className="vp-ezl-menue" data-testid="energieziele-menue">
            <RowMenu
              label="Weitere Aktionen"
              buttonClassName="vp-ezl-menue-knopf"
              items={[{ label: B.KNOPF_SETZEN, icon: 'plus', onClick: () => setSetzen(true) }]}
            />
          </span>
        )}
      </header>

      {lage.art === 'laedt' ? (
        <div className="vp-ezl-skelett" aria-busy="true" aria-label="Wird geladen" data-testid="energieziele-laedt">
          <span className="vp-skeleton is-zeile" />
          <span className="vp-skeleton is-satz" />
          <span className="vp-skeleton is-karte" />
        </div>
      ) : lage.art === 'fehler' ? (
        <section className="vp-ezl-karte is-fehler" role="alert" data-testid="energieziele-fehler">
          <p className="vp-ezl-leer">{B.LADEFEHLER}</p>
          <button type="button" className="vp-ezl-link" onClick={neu}>
            {B.ERNEUT}
          </button>
        </section>
      ) : lage.laufend.length === 0 && lage.abgeschlossen.length === 0 ? (
        <section className="vp-ezl-karte" data-testid="energieziele-leer">
          <p className="vp-ezl-leer">{B.LEER}</p>
          {darfSetzen && (
            <Button variant="outline" size="sm" iconLeft={<Icon name="plus" size={15} />} onClick={() => setSetzen(true)} data-testid="energieziel-setzen-leer">
              {B.KNOPF_SETZEN}
            </Button>
          )}
          <BegriffAufklapper begriff="energieziel" />
        </section>
      ) : (
        <Inhalt
          lage={lage}
          onOeffnen={onOeffnen}
          onPlanen={setPlanen}
          darfSetzen={darfSetzen}
          onSetzen={() => setSetzen(true)}
        />
      )}

      <footer className="vp-ezl-fuss">
        <GrenzHinweis />
      </footer>

      {setzen && (
        <EnergiezielSetzenFuehrung
          onClose={() => setSetzen(false)}
          onGesetzt={(ez) => {
            setSetzen(false);
            onOeffnen(ez.id);
          }}
        />
      )}
      {planen && (
        <MassnahmeAnlegenDialog
          vorbelegung={{ herkunft: 'energieziel', energieziel: planen.id, kennzahl: planen.kennzahl.id }}
          onClose={() => setPlanen(null)}
          onAngelegt={(m: Massnahme) => {
            setPlanen(null);
            if (onMassnahme) onMassnahme(m.id);
            else neu();
          }}
        />
      )}
    </section>
  );
}

function Inhalt({
  lage,
  onOeffnen,
  onPlanen,
  darfSetzen,
  onSetzen,
}: {
  lage: Extract<Lage, { art: 'da' }>;
  onOeffnen: (id: string) => void;
  onPlanen: (ez: Energieziel) => void;
  darfSetzen: boolean;
  onSetzen: () => void;
}) {
  const satz = B.registerSatz(lage.laufend, lage.abgeschlossen);
  const n = lage.laufend.length;
  const formal = [
    n === 0 ? 'kein laufendes Energieziel' : `${n} laufende${n === 1 ? 's' : ''} Energieziel${n === 1 ? '' : 'e'}`,
    lage.abruf ? `Stand ${B.tag(lage.abruf)}` : null,
    'gemessen gegen die Bezugsbasis',
  ].filter(Boolean);
  const soEntsteht = (
    <section className="vp-ezl-karte" data-testid="energieziele-so-entsteht">
      <h2 className="vp-ezl-h2">{B.SO_ENTSTEHT}</h2>
      <p className="vp-ezl-text">{B.SO_ENTSTEHT_SATZ}</p>
      {darfSetzen && (
        <Button variant="outline" size="sm" iconLeft={<Icon name="plus" size={15} />} onClick={onSetzen} data-testid="energieziel-setzen-karte">
          {B.KNOPF_SETZEN}
        </Button>
      )}
    </section>
  );

  return (
    <>
      {satz && (
        <div className="vp-ezl-antwort" data-testid="energieziele-antwort">
          <p className="vp-ezl-satz">{satz}</p>
          <p className="vp-ezl-formal">{formal.join(' · ')}</p>
        </div>
      )}
      {/* „Was ist ein Energieziel?“ wie jeder Begriff (Konzept Verbessern v1 §7; Review r2 S-r2-2). */}
      <BegriffAufklapper begriff="energieziel" />
      <div className="vp-ezl-raster">
        <div className="vp-ezl-haupt">
          {lage.laufend.map((l) => (
            <ZielKarte key={l.ez.id} l={l} onOeffnen={onOeffnen} onPlanen={onPlanen} />
          ))}
          {lage.abgeschlossen.length > 0 && (
            <section className="vp-ezl-abschnitt" data-testid="energieziele-abgeschlossen">
              <h2 className="vp-ezl-label">
                {B.ABGESCHLOSSEN} · {lage.abgeschlossen.length}
              </h2>
              <div className="vp-ezl-karte is-liste">
                {lage.abgeschlossen.map((ez) => (
                  <AbgeschlossenReihe key={ez.id} ez={ez} onOeffnen={onOeffnen} />
                ))}
              </div>
            </section>
          )}
        </div>
        <div className="vp-ezl-seite">
          {/* Verbessern-Konzept v1 (Entscheid 4): offene Auffälligkeiten an Kennzahlen laufender Energieziele zuerst -
              über die Sammelroute, „Beantworten“ öffnet das Blatt an Ort und Stelle. */}
          <AuffaelligkeitHinweis
            ziele={lage.laufend.map((l) => ({ kennzahl: l.ez.kennzahl.id, zielperiode: l.ez.zielperiode }))}
            art="reiter"
          />
          <div className="vp-ezl-o-entsteht">{soEntsteht}</div>
        </div>
      </div>
    </>
  );
}

const ZIELSCHEIBE = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </svg>
);

/** Eine Energieziel-Karte (§6.3, `.zk`): Name, Kennzahl und Vorgenommenes, die Skala, Marken, der nächste Schritt. */
function ZielKarte({ l, onOeffnen, onPlanen }: { l: Laufend; onOeffnen: (id: string) => void; onPlanen: (ez: Energieziel) => void }) {
  const { ez, stand } = l;
  const rollen = useRollen();
  const lageWort: B.Lage = stand?.kurs?.lage ?? 'noch_keine_aussage';
  const faellig = ez.frist.faellig === 'bewertung_faellig' && ez.frist.seit_tagen !== null;
  const luecke = stand ? B.lueckeMarke(stand) : null;
  const bild = B.skalaBild({
    delta: stand?.summe.delta_prozent ?? null,
    urteil: stand?.summe.urteil ?? null,
    zielwert: ez.zielwert_prozent,
    punktWort: 'bisher',
  });
  const fuer = l.massnahmen?.fuer ?? null;
  const fussWarn = fuer !== null && fuer.length === 0 && (lageWort === 'nicht_auf_kurs' || lageWort === 'knapp_dahinter');
  const darfPlanen = rollen.darf(VERWALTEN, ez.standort_id);
  return (
    <article className="vp-ezl-zk" data-testid={`energieziel-karte-${ez.kennzeichen}`}>
      <div className="vp-ezl-zk-kopf">
        <span className="vp-ezl-zk-zeichen">{ZIELSCHEIBE}</span>
        <button type="button" className="vp-ezl-zk-titel" onClick={() => onOeffnen(ez.id)}>
          <span className="nm">{B.energiezielName(ez)}</span>
          <span className="kz">{ez.kennzeichen}</span>
        </button>
        <Icon name="chevron-right" size={16} />
      </div>
      <p className="vp-ezl-zz">
        {ez.kennzahl.name} · <b>{B.zielText(ez.zielwert_prozent)}</b> · {B.zielperiodeText(ez.zielperiode)}
        <span className="vp-ezl-nur-breit"> · verantwortlich {ez.verantwortlich.name}</span>
      </p>
      {stand ? (
        <StandSkala bild={bild} label={`${B.energiezielName(ez)} auf einer Skala: ${stand.kurs ? B.LAGE_WORT[lageWort] : ''}`} />
      ) : (
        <p className="vp-ezl-leise">{B.STAND_LADEFEHLER}</p>
      )}
      {stand && (
        <div className="vp-ezl-marken">
          {faellig ? (
            <span className="vp-k-marke is-warn">{`Bewertung fällig seit ${ez.frist.seit_tagen} ${ez.frist.seit_tagen === 1 ? 'Tag' : 'Tagen'}`}</span>
          ) : (
            <span className={`vp-k-marke is-${B.LAGE_TON[lageWort]}`} data-testid="energieziel-lage">
              {B.LAGE_WORT[lageWort]}
            </span>
          )}
          <span className="vp-k-marke">{stand.monate_text} Monaten</span>
          {luecke && <span className="vp-k-marke">{luecke}</span>}
        </div>
      )}
      <div className="vp-ezl-zk-fuss">
        <span className={fussWarn ? 'is-warn' : ''} data-testid="energieziel-massnahmen">
          {fuer === null ? 'Maßnahmen laden gerade nicht' : B.massnahmenFuss(fuer)}
        </span>
        {faellig ? (
          <button type="button" className="vp-ezl-link" onClick={() => onOeffnen(ez.id)}>
            Bewerten
          </button>
        ) : (
          darfPlanen && (
            <button type="button" className="vp-ezl-link" onClick={() => onPlanen(ez)} data-testid="energieziel-planen">
              {B.KNOPF_PLANEN}
            </button>
          )
        )}
      </div>
    </article>
  );
}

/** Ein abgeschlossenes Energieziel als ruhige Reihe (§6.3): Ergebnis mit Wort, ohne Warnfarbe - es ist Geschichte. */
function AbgeschlossenReihe({ ez, onOeffnen }: { ez: Energieziel; onOeffnen: (id: string) => void }) {
  const s = ez.bewertung?.status === 'bewertet' ? ez.bewertung.stand : undefined;
  const wie =
    ez.zustand === 'beendet'
      ? `vorzeitig beendet${ez.beendet_zum ? ` zum ${B.tag(ez.beendet_zum)}` : ''}`
      : ez.bewertung?.am
        ? `bewertet am ${B.tag(ez.bewertung.am)}`
        : 'bewertet';
  return (
    <button type="button" className="vp-ezl-reihe" onClick={() => onOeffnen(ez.id)} data-testid={`energieziel-zeile-${ez.kennzeichen}`}>
      <span className="lead">
        <span className="nm">
          {B.energiezielName(ez)} <span className="kz">{ez.kennzeichen}</span>
        </span>
        <span className="st">
          {ez.kennzahl.name} · {B.zielText(ez.zielwert_prozent)} vorgenommen · {wie}
        </span>
      </span>
      <span className="rt">
        {s?.delta_prozent != null && (
          <>
            <span className="v">{B.prozent(s.delta_prozent)}</span>
            <span className="k2">{s.richtung === 'gleich' ? 'wie erwartet' : s.richtung}</span>
          </>
        )}
        <span className="vp-k-marke" data-testid="zustand">
          {ez.ergebnis ? B.ERGEBNIS_WORT[ez.ergebnis] : ez.zustand === 'beendet' ? 'beendet' : 'bewertet'}
        </span>
      </span>
      <Icon name="chevron-right" size={16} />
    </button>
  );
}
