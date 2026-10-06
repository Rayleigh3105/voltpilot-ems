import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import { GrenzHinweis, GrenzSatzBereich } from '../components/GrenzSatz';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  type BewertungRangliste,
  type BewertungUmfang,
  type Energieeinsatz,
  type EnergieeinsatzEinstufungFassung,
  type Messbedarf,
} from '../api';
import { ANLEGEN_KNOPF, darfKriterienAendern, darfVerwalten, ladeFehler, LADEN, NUR_LESEN, UMFANG_TITEL } from '../bewertung';
import {
  bewertungBeispiel,
  bewertungErgebnis,
  statusZeile,
  umfangZeilen,
  type BereichGruppe,
  type BereichReihe,
  type KachelBild,
} from '../bewertungErgebnis';
import { kriterienAnstoss } from '../bewertungStand';
import { BegriffAufklapper } from '../components/BegriffAufklapper';
import { KriterienKarte } from '../components/BewertungEntscheidungen';
import { BewertungStand } from '../components/BewertungStand';
import { EnergieeinsatzAnlegenDialog } from '../components/EnergieeinsatzDialoge';
import { RowMenu } from '../components/RowMenu';
import { ErrorState, Skeleton } from '../components/States';
import { UmfangDialog } from '../components/UmfangDialog';
import { UEMS_ENERGETISCHE_BEWERTUNG, UEMS_KEINEM_BEREICH_ZUGEORDNET, UEMS_WEICHT_VOM_VORSCHLAG_AB } from '../glossar';
import { energieeinsatzRoute, hashForRoute } from '../nav';
import { useRollen } from '../rollen';
import { useBewertungZeitraum } from '../useBewertungZeitraum';
import { zumEntscheid } from '../useEntscheidFokus';
import { EnergieeinsatzSeite } from './EnergieeinsatzSeite';
import '../components/kacheln/Kacheln.css';
import '../components/BewertungErgebnis.css';
import './BewertungPage.css';

/**
 * „Unternehmen › Bewertung“ (UEMS AP-16 IP-6, `#/portfolio/bewertung`) und die Seite eines Energieeinsatzes
 * (`#/portfolio/bewertung/{id}`). Seit dem Konzept Auswerten a1 (§6.7) zeigt die Bewertung ihr Ergebnis statt ihrer
 * Rohdaten: welche Bereiche wesentlich sind (Anteil, Menge, Verantwortliche), welche nicht, wo eine Einstufung begründet
 * vom Vorschlag abweicht — dazu Bewertungsstand, Kriterien in Worten und Umfang. Die Rangliste mit Kürzelspalten, die
 * Messabdeckung je Einsatz und je Ort und die zweite Liste der Energieeinsätze sind weg; die Messabdeckung steht als
 * Kachel „Keinem Bereich zugeordnet“, die Messplanung zieht nach Messen. Die Welt erscheint nach der Berichte-Regel (ein
 * Standort misst) und nur mit `energieeinsatz.ansehen` (`ebenenNav.ts`).
 *
 * Jede Ableitung steht im reinen Modul `bewertungErgebnis.ts`; der Grenz-Satz steht einmal am Fuß („Was VoltPilot
 * leistet“, SP3, `copy.test.ts`).
 */
export function BewertungPage({
  einsatzId = null,
  onOeffnen,
  onListe,
}: {
  einsatzId?: string | null;
  onOeffnen: (id: string) => void;
  onListe: () => void;
}) {
  if (einsatzId) return <EnergieeinsatzSeite key={einsatzId} id={einsatzId} onListe={onListe} />;
  return <BewertungUebersicht onOeffnen={onOeffnen} />;
}

const UNTERZEILE = 'Welche Bereiche Ihren Energieverbrauch wesentlich bestimmen - einmal im Jahr festgestellt.';
const LEER_SATZ = 'Noch keine Bereiche festgelegt. Legen Sie fest, wofür Ihr Betrieb Energie einsetzt - dann zeigt VoltPilot hier die Verteilung.';

function BewertungUebersicht({ onOeffnen }: { onOeffnen: (id: string) => void }) {
  const { selbst } = useRollen();
  const verwalten = darfVerwalten(selbst);
  const kriterienAendern = darfKriterienAendern(selbst);
  const [liste, setListe] = useState<Energieeinsatz[] | null>(null);
  const [umfang, setUmfang] = useState<BewertungUmfang | null>(null);
  const [rangliste, setRangliste] = useState<BewertungRangliste | null>(null);
  const [historien, setHistorien] = useState<Record<string, EnergieeinsatzEinstufungFassung[]> | null>(null);
  // Die Messbedarfe tragen nur Kachel und Marke „Messbedarf offen“; scheitern sie, fehlt nur das, nie die Seite.
  const [bedarfe, setBedarfe] = useState<Messbedarf[] | null>(null);
  const [fehler, setFehler] = useState<{ satz: string; erneut: boolean } | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [dialog, setDialog] = useState<'umfang' | 'anlegen' | null>(null);
  // AP-16 IP-25: die Bewertung ist ein Bericht — Stand, Frist und Anstoß-Satz lesen `GET /api/v1/berichte` (nur mit
  // `bewertung.abrufen`). Konzept Auswerten a1, Befund 2: Rangliste und Anteile gelten für die Datengrundlage.
  const [berichteVersion, setBerichteVersion] = useState(0);
  const { abrufen, berichte, bereit, zeitraum } = useBewertungZeitraum(berichteVersion);

  useEffect(() => {
    if (!bereit) return;
    let aktiv = true;
    setFehler(null);
    Promise.all([api.energieeinsaetze(), api.bewertungUmfang(), api.bewertungRangliste(zeitraum.von, zeitraum.bis)]).then(
      async ([l, u, r]) => {
        const h = await Promise.all(l.energieeinsaetze.map(async (e) => [e.id, (await api.energieeinsatzEinstufungen(e.id)).fassungen] as const));
        if (!aktiv) return;
        setListe(l.energieeinsaetze);
        setUmfang(u);
        setRangliste(r);
        setHistorien(Object.fromEntries(h));
      },
    ).catch((e) => aktiv && setFehler(ladeFehler(e)));
    api.messbedarfeAlle().then(
      (b) => aktiv && setBedarfe(b.messbedarfe),
      () => aktiv && setBedarfe(null),
    );
    return () => {
      aktiv = false;
    };
  }, [bereit, versuch, zeitraum.bis, zeitraum.von]);

  const ergebnis = useMemo(
    () =>
      liste && historien && umfang
        ? bewertungErgebnis({ einsaetze: liste, rangliste, einstufungen: historien, umfang, zeitraum: zeitraum.label, messbedarfe: bedarfe })
        : null,
    [bedarfe, historien, liste, rangliste, umfang, zeitraum.label],
  );
  const status = abrufen && berichte ? statusZeile(berichte) : null;
  const beispiel = abrufen ? bewertungBeispiel(berichte) : null;
  const anlegen = () => setDialog('anlegen');

  return (
    <GrenzSatzBereich>
      <div className="vp-be" data-testid="bewertung" lang="de">
        <header className="vp-be-kopf">
          <div className="vp-be-kopf-text">
            <h1>{UEMS_ENERGETISCHE_BEWERTUNG}</h1>
            <p className="vp-be-meta">{UNTERZEILE}</p>
          </div>
          {verwalten && (
            <div className="vp-be-aktionen">
              <Button size="sm" variant="outline" className="vp-be-anlegen" iconLeft={<Icon name="plus" size={16} />} onClick={anlegen} data-testid="einsatz-anlegen-knopf">
                {ANLEGEN_KNOPF}
              </Button>
              <span className="vp-be-menue" data-testid="bewertung-menue">
                <RowMenu label="Weitere Aktionen" buttonClassName="vp-be-menue-knopf" items={[{ label: ANLEGEN_KNOPF, icon: 'plus', onClick: anlegen }]} />
              </span>
            </div>
          )}
        </header>

        <div className="vp-be-lage">
          <BegriffAufklapper begriff="energetische_bewertung" beispiel={beispiel ?? undefined} />
          {status && !status.faellig && (
            <p className={`vp-be-status is-${status.ton}`} data-testid="bewertung-status">
              <span className="vp-be-status-punkt" aria-hidden="true" />
              <span>{status.satz}</span>
              {status.sub && <span className="vp-be-status-sub">{status.sub}</span>}
            </p>
          )}
        </div>
        {status?.faellig && (
          <div className="vp-be-hinweis is-warn" role="status" data-testid="bewertung-faellig">
            <span className="vp-be-hinweis-icon" aria-hidden="true">
              <Icon name="alert-triangle" size={18} />
            </span>
            <span className="vp-be-hinweis-text">
              <b>{status.satz}</b>
              {status.sub && <span>{status.sub}</span>}
              {status.hinweis && <span>{status.hinweis}</span>}
              <span>
                <button
                  type="button"
                  className="vp-be-link"
                  onClick={() => {
                    const el = document.getElementById('bewertung-stand');
                    if (el) zumEntscheid(el);
                  }}
                  data-testid="bewertung-faellig-schritt"
                >
                  Neuen Stand freigeben
                  <Icon name="chevron-right" size={15} />
                </button>
              </span>
            </span>
          </div>
        )}

        {fehler ? (
          fehler.erneut ? (
            <ErrorState message={fehler.satz} onRetry={() => setVersuch((v) => v + 1)} />
          ) : (
            <p className="vp-be-leise" role="status">
              {fehler.satz}
            </p>
          )
        ) : !ergebnis || !umfang || !liste ? (
          <div className="vp-be-spalte" aria-busy="true" aria-label={LADEN}>
            <Skeleton height={56} />
            <Skeleton height={112} />
            <Skeleton height={220} />
          </div>
        ) : ergebnis.leer ? (
          <div className="vp-be-spalte">
            <section className="vp-be-karte vp-be-leer" data-testid="bewertung-leer">
              <p>{LEER_SATZ}</p>
              {verwalten && (
                <Button variant="primary" size="sm" iconLeft={<Icon name="plus" size={16} />} onClick={anlegen} data-testid="einsatz-anlegen-leer">
                  {ANLEGEN_KNOPF}
                </Button>
              )}
            </section>
            <UmfangKarte umfang={umfang} verwalten={verwalten} onAendern={() => setDialog('umfang')} />
            <KriterienKarte darfAendern={kriterienAendern} ich={selbst?.kennung ?? null} anstoss={kriterienAnstoss(berichte)} onGeaendert={() => setVersuch((v) => v + 1)} />
            {abrufen && berichte && berichte.some((b) => b.vorlage === 'energetische_bewertung') && (
              <BewertungStand selbst={selbst ?? null} berichte={berichte} onGeaendert={() => setBerichteVersion((v) => v + 1)} />
            )}
          </div>
        ) : (
          <>
            <div className="vp-be-antwort" data-testid="bewertung-antwort">
              <p className="vp-be-satz">
                {ergebnis.antwort}
                {ergebnis.zusatz && <span className="vp-be-breit"> {ergebnis.zusatz}</span>}
              </p>
              <p className="vp-be-formal">{ergebnis.formal}</p>
            </div>
            {ergebnis.vertrauen && (
              <p className="vp-be-vertrauen" data-testid="bewertung-vertrauen">
                <Icon name="info" size={16} />
                <span>{ergebnis.vertrauen}</span>
              </p>
            )}
            <Kacheln kacheln={ergebnis.kacheln} />
            <div className="vp-be-raster">
              <div className="vp-be-spalte">
                {ergebnis.gruppen.map((g) => (
                  <BereichKarte key={g.key} gruppe={g} onOeffnen={onOeffnen} />
                ))}
              </div>
              <div className="vp-be-spalte">
                {abrufen && <BewertungStand selbst={selbst ?? null} berichte={berichte} onGeaendert={() => setBerichteVersion((v) => v + 1)} />}
                <KriterienKarte darfAendern={kriterienAendern} ich={selbst?.kennung ?? null} anstoss={kriterienAnstoss(berichte)} onGeaendert={() => setVersuch((v) => v + 1)} />
                <UmfangKarte umfang={umfang} verwalten={verwalten} onAendern={() => setDialog('umfang')} />
              </div>
            </div>
          </>
        )}

        <footer className="vp-be-fuss">
          {selbst && !verwalten && (
            <p className="vp-be-leise" role="note" data-testid="bewertung-nur-lesen">
              {NUR_LESEN}
            </p>
          )}
          <GrenzHinweis />
        </footer>

        {dialog === 'umfang' && umfang && (
          <UmfangDialog
            umfang={umfang}
            onClose={() => setDialog(null)}
            onGespeichert={(u) => {
              setUmfang(u);
              setDialog(null);
            }}
          />
        )}
        {dialog === 'anlegen' && liste && (
          <EnergieeinsatzAnlegenDialog
            einsaetze={liste}
            onClose={() => setDialog(null)}
            onAngelegt={(e) => {
              setDialog(null);
              setListe((l) => [...(l ?? []), e]);
              onOeffnen(e.id);
            }}
          />
        )}
      </div>
    </GrenzSatzBereich>
  );
}

/** Eine Kachel der Familie (`Kacheln.css`) ohne Zeichen: Name, große Zahl, Marke, leise Zeile. */
function Kachel({ name, bild, einheitBreit, ton, nurBreit = false, testId }: {
  name: string;
  bild: KachelBild;
  /** Am Rechner ist Platz für das ganze Wort („von 8 Bereichen“). */
  einheitBreit?: string;
  ton?: 'load';
  nurBreit?: boolean;
  testId: string;
}) {
  return (
    <article className={`vp-k${ton ? ` ton-${ton}` : ''}${nurBreit ? ' vp-be-kachel-breit' : ''}`} aria-label={name} data-testid={testId}>
      <div className="vp-k-kopf">
        <span className="vp-k-name">{name}</span>
      </div>
      <div>
        <span className="vp-k-gross">{bild.wert ?? '–'}</span>
        {bild.einheit && (
          <span className="vp-k-einheit">
            {einheitBreit ? (
              <>
                <span className="vp-be-schmal">{bild.einheit}</span>
                <span className="vp-be-breit">{einheitBreit}</span>
              </>
            ) : (
              bild.einheit
            )}
          </span>
        )}
      </div>
      {bild.marke && <span className={`vp-k-marke is-${bild.marke.ton}`}>{bild.marke.text}</span>}
      {bild.sub && <p className={`vp-k-sub${bild.subBreit !== null ? ' vp-be-schmal' : ''}`}>{bild.sub}</p>}
      {bild.subBreit && <p className="vp-k-sub vp-be-breit">{bild.subBreit}</p>}
    </article>
  );
}

function Kacheln({ kacheln: k }: { kacheln: ReturnType<typeof bewertungErgebnis>['kacheln'] }) {
  // Am Rechner so viele Spalten wie Kacheln: ohne lesbare Messbedarfe drei.
  const stil = { '--vp-be-kacheln': k.bedarfe ? 4 : 3 } as CSSProperties;
  return (
    <div className="vp-be-kacheln" style={stil} data-testid="bewertung-kacheln">
      <Kachel name="Wesentlich" bild={k.wesentlich} einheitBreit={`${k.wesentlich.einheit} Bereichen`} testId="kachel-wesentlich" />
      <Kachel name="Ihr Anteil am Strom" bild={k.anteil} ton="load" nurBreit testId="kachel-anteil" />
      <Kachel name={UEMS_KEINEM_BEREICH_ZUGEORDNET} bild={k.rest} testId="kachel-rest" />
      {k.bedarfe && <Kachel name="Offene Messbedarfe" bild={k.bedarfe} nurBreit testId="kachel-bedarfe" />}
    </div>
  );
}

function BereichKarte({ gruppe, onOeffnen }: { gruppe: BereichGruppe; onOeffnen: (id: string) => void }) {
  return (
    <section className="vp-be-karte" aria-labelledby={`be-gruppe-${gruppe.key}`} data-testid={`bereiche-${gruppe.key}`}>
      <div className="vp-be-blockkopf">
        <h2 id={`be-gruppe-${gruppe.key}`}>{gruppe.titel}</h2>
        <span className="vp-be-anzahl">{gruppe.reihen.length}</span>
      </div>
      <ul className="vp-be-reihen">
        {gruppe.reihen.map((r) => (
          <li key={r.id}>
            <BereichZeile reihe={r} ohne={gruppe.key === 'ohne_werte'} onOeffnen={onOeffnen} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Eine Reihe ist der Verweis auf ihren Bereich; mit gedrückter Taste öffnet der Browser sie wie jeden Verweis. */
function BereichZeile({ reihe: r, ohne, onOeffnen }: { reihe: BereichReihe; ohne: boolean; onOeffnen: (id: string) => void }) {
  const oeffnen = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOeffnen(r.id);
  };
  return (
    <a className={`vp-be-reihe${ohne ? ' is-ohne' : ''}`} href={hashForRoute(energieeinsatzRoute(r.id))} onClick={oeffnen} data-testid={`bereich-${r.kennzeichen}`}>
      <span className="vp-be-name">
        <span>{r.name}</span>
        <span className="vp-be-kz">{r.kennzeichen}</span>
        {r.abweichung && <span className="vp-be-abweichung">{UEMS_WEICHT_VOM_VORSCHLAG_AB}</span>}
      </span>
      <span className="vp-be-wert">
        {r.wert}
        <span className="vp-be-chev" aria-hidden="true">
          <Icon name="chevron-right" size={16} />
        </span>
      </span>
      {r.balken !== null && (
        <span className="vp-be-spur">
          <span className="vp-be-spur-t" aria-hidden="true">
            <i style={{ width: `${Math.max(1, Math.min(100, r.balken))}%` }} />
          </span>
          <span className="vp-be-menge">{r.menge}</span>
        </span>
      )}
      <span className={`vp-be-sub${r.abweichung ? ' is-zitat' : ''}`}>
        {r.teile.map((t, i) => (
          <span key={i} className={t.breit ? 'vp-be-breit' : undefined}>
            {i > 0 ? ' · ' : ''}
            {t.text}
          </span>
        ))}
      </span>
      {r.hinweise.map((h) => (
        <span key={h} className="vp-be-sub vp-be-hinweis-satz" role="note">
          {h}
        </span>
      ))}
    </a>
  );
}

function UmfangKarte({ umfang, verwalten, onAendern }: { umfang: BewertungUmfang; verwalten: boolean; onAendern: () => void }) {
  const z = useMemo(() => {
    const namen = new Map<string, string>();
    for (const s of umfang.standorte) {
      namen.set(s.id, s.name);
      for (const a of s.anlagen_im_umfang) namen.set(a.id, a.name);
    }
    return umfangZeilen(umfang, namen);
  }, [umfang]);
  return (
    <section className="vp-be-karte" aria-labelledby="be-umfang" data-testid="bewertung-umfang">
      <div className="vp-be-blockkopf">
        <h2 id="be-umfang">{UMFANG_TITEL}</h2>
        {verwalten && (
          <button type="button" className="vp-be-link" onClick={onAendern} data-testid="umfang-knopf">
            {z.gespeichert ? 'Ändern' : 'Festlegen'}
          </button>
        )}
      </div>
      <dl className="vp-be-zuo">
        <div className="vp-be-zr">
          <dt>Standorte</dt>
          <dd data-testid="umfang-standorte">{z.standorte}</dd>
        </div>
        <div className="vp-be-zr">
          <dt>Energieträger</dt>
          <dd data-testid="umfang-traeger">{z.traeger}</dd>
          {z.traegerNotiz && <dd className="vp-be-zr-notiz">{z.traegerNotiz}</dd>}
        </div>
        {z.ausschluesse.length > 0 && (
          <div className="vp-be-zr" data-testid="umfang-ausschluesse">
            <dt>Ausgeschlossen</dt>
            {z.ausschluesse.map((a) => (
              <dd key={a} className="vp-be-zr-notiz">
                {a}
              </dd>
            ))}
          </div>
        )}
        <div className="vp-be-zr">
          <dt>Gilt</dt>
          <dd data-testid="umfang-fassung">{z.gilt}</dd>
        </div>
      </dl>
      {umfang.teilansicht && <p className="vp-be-leise">Sie sehen den Umfang an Ihren Standorten.</p>}
    </section>
  );
}
