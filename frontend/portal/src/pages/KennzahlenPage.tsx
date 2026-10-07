import { Recht } from '../components/Recht';
import { BegriffeZeile } from '../components/BegriffeZeile';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type Kennzahl } from '../api';
import { KennzahlAnlegenDialog, type KopieVon } from '../components/KennzahlAnlegenDialog';
import {
  KarteMitBasisHandy,
  ListenHinweis,
  ReiheOhneBasisHandy,
  TabelleMitBasis,
  TabelleOhneBasis,
} from '../components/KennzahlenAuswertung';
import { useListenWerte } from '../components/KennzahlListe';
import { RowMenu } from '../components/RowMenu';
import { ErrorState, Skeleton } from '../components/States';
import { KNOPF_ANLEGEN, LEER_SATZ } from '../kennzahlAnlegen';
import { amStandort, LADEN, LEER, LEER_STANDORT, listenKarte, TITEL, type ListenWerte } from '../kennzahlKarte';
import {
  archivTitel,
  GRUPPE_MIT,
  GRUPPE_OHNE,
  kennzahlenListe,
  LISTE_LADEFEHLER,
  UNTERZEILE,
  unterzeileStandort,
} from '../kennzahlListe';
import { STANDORT_KENNZAHLEN } from '../ebenenNav';
import { useRollen } from '../rollen';
import { TRENNER } from '../uemsErgebnis';
import { VORGABE_ZEITZONE } from '../uemsOrtsbaum';
import { useIsPhone } from '../useIsPhone';
import { KennzahlSeite } from './KennzahlSeite';
import './KennzahlenPage.css';

/**
 * „Unternehmen › Kennzahlen“ (UEMS AP-11 IP-13, `#/portfolio/kennzahlen`) und die Kennzahl-Seite
 * (`#/portfolio/kennzahlen/{id}`, §5.3) — eine Portfolio-Welt neben „Standorte“, bis AP-13 die Ebenen-Navigation
 * bringt.
 *
 * Die Liste liest `GET /api/v1/kennzahlen?mit=auswertung` (Konzept Auswerten a1 §6.4, PR1): je Kennzahl das Urteil des
 * letzten abgeschlossenen Monats, die zwölf Monate und das Energieziel - in zwei Gruppen „Mit Bezugsbasis“ und „Zum
 * Beobachten“, Archivierte zugeklappt. Jede Ableitung steht im reinen Modul `kennzahlListe.ts`; nur Archivierte (beim
 * Aufklappen) und Kennzahlen ohne Monatswerte lesen ihr Fenster wie bisher über `…/werte` (`kennzahlKarte.ts`).
 *
 * AP-11 IP-14: „Kennzahl anlegen“ im Kopf der Liste und „Kopieren“ im Kopf der Seite öffnen denselben Assistenten
 * (`KennzahlAnlegenDialog`) — er gehört der Welt, nicht der Karte; nach dem Anlegen lädt die Liste neu.
 * AP-11 IP-15: „Berechnung ändern ab …“ an der Seite öffnet denselben Assistenten im Modus „ändern“; nach dem Speichern
 * lädt die Seite neu.
 * ⚠ R-A7: antwortet `…/werte` für eine gelistete Kennzahl mit 404, trägt die Karte die Hinweiszeile ohne Wert.
 */
export function KennzahlenPage({
  kennzahlId = null,
  onOeffnen,
  onListe,
  zone = VORGABE_ZEITZONE,
  standort = null,
}: {
  kennzahlId?: string | null;
  onOeffnen: (id: string) => void;
  onListe: () => void;
  /** Die Zeitzone, in der „heute“ liegt. */
  zone?: string;
  /** AP-13 IP-2 (Ü8): „Kennzahlen dieses Standorts“ — die Liste nur mit Geltung im Standort; `null` = das Unternehmen. */
  standort?: { id: string; name: string } | null;
}) {
  const [assistent, setAssistent] = useState<{ quelle: KopieVon | null; aendern?: KopieVon } | null>(null);
  const [neu, setNeu] = useState(0);
  const dialog = assistent && (
    <KennzahlAnlegenDialog
      open
      quelle={assistent.quelle}
      aendern={assistent.aendern ?? null}
      zone={zone}
      onClose={() => setAssistent(null)}
      onAngelegt={() => setNeu((n) => n + 1)}
      onGeaendert={() => setNeu((n) => n + 1)}
      onZurKennzahl={(id) => {
        setAssistent(null);
        onOeffnen(id);
      }}
    />
  );
  if (kennzahlId) {
    return (
      <>
        {/* Nach „Berechnung ändern“ lädt die Seite neu (Schlüssel) — der Dialog daneben bleibt auf „Fertig“ stehen. */}
        <KennzahlSeite
          key={`${kennzahlId}|${neu}`}
          id={kennzahlId}
          zone={zone}
          onListe={onListe}
          zurListe={standort ? STANDORT_KENNZAHLEN : undefined}
          onKopieren={(quelle) => setAssistent({ quelle })}
          onBerechnungAendern={(quelle) => setAssistent({ quelle: null, aendern: quelle })}
        />
        {dialog}
      </>
    );
  }
  return (
    <>
      <KennzahlenListe
        key={neu}
        zone={zone}
        standort={standort}
        onOeffnen={onOeffnen}
        onAnlegen={() => setAssistent({ quelle: null })}
      />
      {dialog}
    </>
  );
}

function KennzahlenListe({
  zone,
  standort,
  onOeffnen,
  onAnlegen,
}: {
  zone: string;
  standort: { id: string; name: string } | null;
  onOeffnen: (id: string) => void;
  onAnlegen: () => void;
}) {
  const [versuch, setVersuch] = useState(0);
  const standortId = standort?.id ?? null;
  const telefon = useIsPhone();
  const rollen = useRollen();
  const recht = standortId ? 'kennzahl.standort_definieren' : 'kennzahl.unternehmen_definieren';
  // Konzept Auswerten a1 (PR1): EINE Anfrage mit Auswertung je Kennzahl statt einer Werte-Anfrage je Karte. Scheitert
  // sie, steht die Liste ohne Auswertung da (jede Karte liest dann ihr Fenster wie bisher über `…/werte`) - ein Fehler
  // der Auswertung leert nie die ganze Liste. Die Leitkennzahl nennt der Server (`leitkennzahl`), für das Unternehmen;
  // am Standort trägt sie den Stern nur, wenn sie dort steht.
  const [lage, setLage] = useState<{ liste: Kennzahl[]; ausserhalb: string | null; leit: string | null } | 'fehler' | null>(null);
  useEffect(() => {
    let aktiv = true;
    setLage(null);
    const zeigen = ({ kennzahlen, ausserhalb_zugriff, leitkennzahl }: Awaited<ReturnType<typeof api.kennzahlen>>) =>
      aktiv &&
      setLage({
        liste: standortId ? amStandort(kennzahlen, standortId) : kennzahlen,
        ausserhalb: ausserhalb_zugriff?.text ?? null,
        leit: leitkennzahl ?? null,
      });
    api
      .kennzahlen('auswertung')
      .catch(() => api.kennzahlen())
      .then(zeigen, () => aktiv && setLage('fehler'));
    return () => {
      aktiv = false;
    };
  }, [versuch, standortId]);
  const modell = useMemo(() => (lage && lage !== 'fehler' ? kennzahlenListe(lage.liste, lage.leit) : null), [lage]);
  const [archivOffen, setArchivOffen] = useState(false);
  // Archivierte lesen ihre Werte erst beim Aufklappen; Kennzahlen ohne Monatswerte (selten) wie bisher je Karte.
  const archivWerte = useListenWerte(archivOffen && modell ? modell.archiviert : null, zone);
  const ohneWerte = useListenWerte(modell ? modell.ohneAuswertung : null, zone);
  const darfBasis = rollen.darf('bezugsbasis.verwalten', standortId);

  const ansehen = () => {
    if (!modell || modell.hinweis?.art !== 'warn') return;
    const [erste, ...weitere] = modell.hinweis.ziele;
    if (weitere.length === 0) {
      onOeffnen(erste);
      return;
    }
    // Mehrere: zur ersten Karte über der Bezugsbasis springen, die anderen stehen gleich darunter.
    const karte = document.querySelector<HTMLElement>(`[data-testid="kennzahl-karte"][data-id="${erste}"]`);
    karte?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    karte?.focus({ preventScroll: true });
  };

  return (
    <div className="vp-kz" data-testid="kennzahlen">
      <header className="vp-kzl-kopf-zeile">
        <div className="vp-kzl-kopf-text">
          <h1>{standort ? STANDORT_KENNZAHLEN : TITEL}</h1>
          <p className="vp-kzl-unterzeile">{standort ? unterzeileStandort(standort.name) : UNTERZEILE}</p>
        </div>
        <div className="vp-kzl-aktionen">
          {telefon ? (
            <RowMenu
              label="Weitere Aktionen"
              items={[{ label: KNOPF_ANLEGEN, recht, standort: standortId, icon: 'plus', onClick: onAnlegen }]}
            />
          ) : (
            <Recht aktion={recht} standort={standortId}>
              <Button size="sm" variant="outline" iconLeft={<Icon name="plus" size={16} />} onClick={onAnlegen} data-testid="kennzahl-anlegen-knopf">
                {KNOPF_ANLEGEN}
              </Button>
            </Recht>
          )}
        </div>
      </header>
      <BegriffeZeile begriffe={['kennzahl', 'bezugsgroesse', 'bezugsbasis']} />
      {lage && lage !== 'fehler' && lage.ausserhalb && (
        <p className="vp-kz-hinweis" role="note">
          {lage.ausserhalb}
        </p>
      )}
      {lage === 'fehler' ? (
        <ErrorState message={LISTE_LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />
      ) : !modell ? (
        <div aria-busy="true" aria-label={LADEN} className="vp-kzl-laedt">
          <Skeleton height={20} />
          <Skeleton height={telefon ? 180 : 220} />
          <Skeleton height={telefon ? 180 : 160} />
        </div>
      ) : modell.mit.length + modell.ohne.length + modell.ohneAuswertung.length + modell.archiviert.length === 0 ? (
        <div className="vp-kzl-leer" data-testid="kennzahlen-leer">
          <p className="vp-kz-leer">
            {standort ? LEER_STANDORT : LEER} {LEER_SATZ}
          </p>
          {/* Der eine nächste Schritt steht sichtbar da - am Handy liegt der Knopf im Kopf sonst im Menü ⋯. */}
          <Recht aktion={recht} standort={standortId}>
            <Button size="sm" variant="primary" iconLeft={<Icon name="plus" size={16} />} onClick={onAnlegen} data-testid="kennzahl-anlegen-leer">
              {KNOPF_ANLEGEN}
            </Button>
          </Recht>
        </div>
      ) : (
        <>
          {modell.hinweis && <ListenHinweis hinweis={modell.hinweis} kurz={telefon} onAnsehen={ansehen} />}
          {modell.mit.length > 0 &&
            (telefon ? (
              <section aria-labelledby="kzl-mit" className="vp-kzl-gruppe" data-testid="kennzahlen-mit">
                <h2 id="kzl-mit" className="vp-kzl-untertitel">
                  {GRUPPE_MIT.titel}
                  {TRENNER}
                  {GRUPPE_MIT.leise}
                </h2>
                <ul className="vp-kzl-karten">
                  {modell.mit.map((k) => (
                    <li key={k.id}>
                      <KarteMitBasisHandy k={k} onOeffnen={() => onOeffnen(k.id)} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <TabelleMitBasis karten={modell.mit} onOeffnen={onOeffnen} />
            ))}
          {modell.ohne.length + modell.ohneAuswertung.length > 0 &&
            (telefon ? (
              <section aria-labelledby="kzl-ohne" className="vp-kzl-gruppe" data-testid="kennzahlen-ohne">
                <h2 id="kzl-ohne" className="vp-kzl-untertitel">
                  {GRUPPE_OHNE.titel}
                  {TRENNER}
                  {GRUPPE_OHNE.leise}
                </h2>
                <ul className="vp-kzl-reihen">
                  {modell.ohne.map((r) => (
                    <li key={r.id}>
                      <ReiheOhneBasisHandy r={r} onOeffnen={() => onOeffnen(r.id)} />
                    </li>
                  ))}
                  {modell.ohneAuswertung.map((k) => (
                    <li key={k.id}>
                      <ListenReihe k={k} werte={ohneWerte[k.id]} onOeffnen={() => onOeffnen(k.id)} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <TabelleOhneBasis
                reihen={modell.ohne}
                darfBasisFestlegen={darfBasis}
                onOeffnen={onOeffnen}
                anzahlWeitere={modell.ohneAuswertung.length}
                weitere={
                  modell.ohneAuswertung.length > 0 && (
                    <ul className="vp-kzl-zeilen vp-kzl-weitere" data-testid="kennzahlen-ohne-monat">
                      {modell.ohneAuswertung.map((k) => (
                        <li key={k.id}>
                          <ListenReihe k={k} werte={ohneWerte[k.id]} onOeffnen={() => onOeffnen(k.id)} />
                        </li>
                      ))}
                    </ul>
                  )
                }
              />
            ))}
          {modell.archiviert.length > 0 && (
            <details className="vp-kzl-archiv" data-testid="kennzahlen-archiv" onToggle={(e) => setArchivOffen(e.currentTarget.open)}>
              <summary>
                {archivTitel(modell.archiviert.length)}
                <Icon name="chevron-down" size={18} />
              </summary>
              <ul className="vp-kzl-reihen">
                {modell.archiviert.map((k) => (
                  <li key={k.id}>
                    <ListenReihe k={k} werte={archivWerte[k.id]} onOeffnen={() => onOeffnen(k.id)} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** Eine Reihe aus dem bisherigen Listen-Modell: Archivierte und Kennzahlen ohne Monatswerte. */
function ListenReihe({ k, werte, onOeffnen }: { k: Kennzahl; werte: ListenWerte | undefined; onOeffnen: () => void }) {
  const karte = listenKarte(k, werte ?? { art: 'laedt' });
  const unter = karte.hinweis ?? karte.fehler ?? ([karte.zustand, karte.periode].filter(Boolean).join(TRENNER) || null);
  return (
    <button type="button" className="vp-kzl-reihe" data-testid="kennzahl-reihe" data-kennzeichen={k.kennzeichen} onClick={onOeffnen}>
      <span className="vp-kzl-reihe-text">
        <span className="vp-kzl-name">
          {k.name} <span className="vp-kzl-kz">{k.kennzeichen}</span>
        </span>
        {unter && <span className="vp-kzl-reihe-unter">{unter}</span>}
      </span>
      <span className="vp-kzl-reihe-wert">
        {karte.zahl === null ? <span className="vp-kz-platzhalter" aria-hidden="true" /> : <b className="vp-kzl-reihe-zahl">{karte.zahl}</b>}
      </span>
      <span className="vp-kzl-pfeil" aria-hidden="true">
        <Icon name="chevron-right" size={18} />
      </span>
    </button>
  );
}
