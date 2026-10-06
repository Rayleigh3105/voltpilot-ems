import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  type Bezugsgroesse,
  type BezugsgroesseStammdatum,
  type BezugsgroesseWert,
  type BezugsKanalbindung as Kanalbindung,
} from '../api';
import { useRollen } from '../rollen';
import { UEMS_VERLAUF_PROZENT } from '../glossar';
import { kanalRegelText, wertKennzeichen } from '../bezugsKanal';
import { schluesselVon } from '../bezugsPeriode';
import { zahlText } from '../zahl';
import { zeitText } from '../werteEingabe';
import { datumText, lokalerTag } from '../uemsOrtsbaum';
import { BezugsKanalbindung } from '../components/BezugsKanalbindung';
import { BezugsWetter } from '../components/BezugsWetter';
import { BezugswertDialog } from '../components/BezugswertDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { VpDatePicker } from '../components/VpDatePicker';
import * as B from '../bezugsgroesseListe';
import * as U from '../bezugsgroessenUebersicht';
import { bezugsLaden, standortDer, zoneDer, type BezugsStand } from '../bezugsStand';
import { ohneUmbruchVorZahl } from '../kostenstellenUebersicht';
import './MessstellenPage.css';
import './BezugsgroessenPage.css';

/** Wie viele Werte die Seite zuerst zeigt (Konzept §6.8: „drei + Alle 24“). */
const ZUERST = 3;

/**
 * Die Seite EINER Bezugsgröße (`#/portfolio/bezugsgroessen/{id}`, Konzept Messen m1 §6.8, Entscheid 9): oben der eine
 * Schritt „Wert eintragen“, darunter die Kachel mit dem letzten Wert und dem Vorjahr, die Balken über zwölf Perioden,
 * die Werte neueste zuerst (drei, „Alle 24 ›“), woher die Werte kommen (Messkanal, Wetter) - Archivieren im Menü ⋯.
 * Ein Stammdatum (eigene Fläche) zeigt, was heute gilt, und trägt einen Wert ab einem Tag ein.
 *
 * Gerechnet wird nichts: jede Zahl ist der Dezimaltext des Servers mit Tausenderpunkt; die Balken skalieren nur zur
 * Anzeige. Ein fehlender Wert ist eine Lücke, nie 0.
 */
export function BezugsgroesseSeite({ id }: { id: string }) {
  const [stand, setStand] = useState<BezugsStand | null>(null);
  const [werte, setWerte] = useState<BezugsgroesseWert[] | null>(null);
  const [bindungen, setBindungen] = useState<Kanalbindung[]>([]);
  const [stamm, setStamm] = useState<BezugsgroesseStammdatum | null>(null);
  const [fehler, setFehler] = useState(false);
  const [neu, setNeu] = useState(0);
  const [kanalRevision, setKanalRevision] = useState(0);
  const [dialog, setDialog] = useState<{ alt: BezugsgroesseWert | null } | null>(null);
  const [stammDialog, setStammDialog] = useState(false);
  const [archiv, setArchiv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [archivFehler, setArchivFehler] = useState<string | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [alle, setAlle] = useState(false);
  const [offen, setOffen] = useState<string | null>(null);
  const ausloeser = useRef<HTMLElement | null>(null);
  const kopf = useRef<HTMLHeadingElement>(null);
  const { darf } = useRollen();

  useEffect(() => {
    let aktiv = true;
    setFehler(false);
    bezugsLaden().then(
      async (s) => {
        const b = s.liste.bezugsgroessen.find((x) => x.id === id || x.kennzeichen === id);
        if (!b) {
          if (aktiv) {
            setStand(s);
            setWerte([]);
          }
          return;
        }
        if (b.wertart === 'stammdatum') {
          const st = await api.bezugsgroesseStammdatum(b.id);
          if (aktiv) {
            setStand(s);
            setStamm(st);
            setWerte([]);
          }
          return;
        }
        const [w, k] = await Promise.all([api.bezugsgroesseWerte(b.id, { fassungen: 'alle' }), api.kanalbindungen(b.id).catch(() => [] as Kanalbindung[])]);
        if (aktiv) {
          setStand(s);
          setWerte(w.werte);
          setBindungen(k);
        }
      },
      () => aktiv && setFehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [id, neu, kanalRevision]);

  const zurueck = (
    <a className="vp-bzs-zurueck" href="#/portfolio/bezugsgroessen">
      <Icon name="chevron-left" size={16} />
      {U.ALLE_BEZUGSGROESSEN}
    </a>
  );
  if (fehler) {
    return (
      <div className="vp-ms vp-bzs">
        {zurueck}
        <section className="vp-ms-karte is-fehler" role="alert">
          <h2>Bezugsgröße nicht geladen</h2>
          <p className="vp-ms-leise">Die Bezugsgröße ließ sich gerade nicht laden. Ihre Daten sind nicht betroffen.</p>
          <button type="button" className="vp-ms-link" onClick={() => setNeu((n) => n + 1)}>
            Erneut versuchen
          </button>
        </section>
      </div>
    );
  }
  if (!stand || werte === null) {
    return (
      <div className="vp-ms vp-bzs" aria-busy="true">
        {zurueck}
        <div className="vp-ms-skelett" aria-label="Bezugsgröße wird geladen">
          <span className="vp-skeleton is-zeile" />
          <span className="vp-skeleton is-karte" />
          <span className="vp-skeleton is-karte" />
        </div>
      </div>
    );
  }
  const b = stand.liste.bezugsgroessen.find((x) => x.id === id || x.kennzeichen === id);
  if (!b) {
    return (
      <div className="vp-ms vp-bzs">
        {zurueck}
        <section className="vp-ms-karte" role="status">
          <p className="vp-ms-leer-satz">Diese Bezugsgröße gibt es nicht – oder sie gilt für einen Ort, den Sie nicht sehen.</p>
        </section>
      </div>
    );
  }
  const standort = standortDer(b, stand.orte);
  const zone = zoneDer(b, stand);
  const archiviert = b.archiviert_am !== null;
  // Eine Bezugsfläche aus dem Gebäude ist nicht schreibbar: sie wird am Gebäude gepflegt (der Weg steht statt des Knopfs).
  const ausGebaeude = b.wertart === 'stammdatum' && stamm !== null && !stamm.schreibbar;
  const erlaubt = standort !== undefined && darf('bezugsgroesse.eingeben', standort) && !archiviert && b.art !== 'betriebszeit_aus_leistung' && !ausGebaeude;
  const darfVerwalten = standort !== undefined && darf('bezugsgroesse.verwalten', standort) && !archiviert;
  const reihe = U.bzReihe(b, { bezugsgroesse_id: b.id, kennzeichen: b.kennzeichen, wertart: b.wertart, einheit: b.einheit, periode_art: b.periode_art, von: null, bis: null, fassungen: 'alle', werte }, stamm, stand.heute);
  const status = U.bzStatus([reihe]);
  const schliessen = () => {
    setDialog(null);
    setStammDialog(false);
    setArchiv(false);
    setArchivFehler(null);
    requestAnimationFrame(() => (ausloeser.current?.isConnected ? ausloeser.current : kopf.current)?.focus());
  };
  const archivieren = async () => {
    if (!darfVerwalten || busy) return;
    setBusy(true);
    setArchivFehler(null);
    try {
      const neuB = await api.bezugsgroesseArchivieren(b.id);
      setStand((s) => (s ? { ...s, liste: { ...s.liste, bezugsgroessen: s.liste.bezugsgroessen.map((x) => (x.id === neuB.id ? neuB : x)) } } : s));
      setMeldung(`${neuB.name} ist archiviert.`);
      schliessen();
    } catch (e) {
      setArchivFehler(B.fehlerSatz(e));
    } finally {
      setBusy(false);
    }
  };

  const menue: RowMenuItem[] = [];
  if (darfVerwalten) menue.push({ label: U.ARCHIVIEREN, icon: 'archive', danger: true, onClick: () => setArchiv(true) });

  return (
    <div className="vp-ms vp-bzs" data-testid="bezugsgroesse-seite" data-kennzeichen={b.kennzeichen}>
      {zurueck}
      <header className="vp-ms-kopf">
        <div className="vp-ms-kopf-text">
          <h1 tabIndex={-1} ref={kopf}>
            {ohneUmbruchVorZahl(b.name)} <span className="vp-bzs-kz">{b.kennzeichen}</span>
          </h1>
          <p className="vp-ms-meta">{U.unterzeile(b)}</p>
        </div>
        {menue.length > 0 && (
          <span
            className="vp-ms-menue"
            data-testid="bezugsgroesse-menue"
            onClickCapture={(e) => {
              // Der Auslöser ⋯ selbst (die Einträge stehen in einem Portal und verschwinden mit dem Menü).
              ausloeser.current = e.currentTarget.querySelector('button');
            }}
          >
            <RowMenu label="Weitere Aktionen" buttonClassName="vp-ms-menue-knopf" items={menue} />
          </span>
        )}
      </header>
      {meldung && (
        <p role="status" className="vp-ms-status is-ok">
          <span className="vp-ms-status-punkt" aria-hidden="true" />
          {meldung}
        </p>
      )}
      {archiviert ? (
        <p className="vp-ms-status" data-testid="bezugsgroesse-status">
          <span className="vp-ms-status-punkt" aria-hidden="true" />
          Archiviert – bisherige Werte bleiben lesbar, neue können nicht mehr eingetragen werden.
        </p>
      ) : (
        status && (
          <p className={`vp-ms-status ${status.ton === 'ok' ? 'is-ok' : 'is-warn'}`} data-testid="bezugsgroesse-status">
            <span className="vp-ms-status-punkt" aria-hidden="true" />
            {status.ton === 'ok' ? status.text : `Für ${U.periodeImSatz(reihe.faellig ?? '', b.periode_art ?? 'monat')} fehlt der Wert`}
          </p>
        )
      )}
      {erlaubt && (
        <Button
          className="vp-bzs-schritt"
          iconLeft={<Icon name="pencil" size={16} />}
          onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
            ausloeser.current = e.currentTarget;
            setMeldung(null);
            if (b.wertart === 'stammdatum') setStammDialog(true);
            else setDialog({ alt: null });
          }}
        >
          {U.WERT_EINTRAGEN}
        </Button>
      )}
      {ausGebaeude && standort && (
        <a className="vp-ks-verweis vp-bzs-gebaeude" href={`#/standort/${encodeURIComponent(standort)}/gebaeude`}>
          {U.FLAECHEN.aendern}
          <Icon name="chevron-right" size={14} />
        </a>
      )}
      {b.wertart === 'stammdatum' ? (
        <StammdatumKarte b={b} stamm={stamm} heute={stand.heute} />
      ) : (
        <>
          <WertKachel b={b} werte={werte} />
          {b.periode_art && <Balken b={b} werte={werte} heute={stand.heute} />}
          <section className="vp-ms-ort vp-bzs-werte" aria-labelledby="vp-bzs-werte" data-testid="bezugsgroesse-werte">
            <div className="vp-ms-ort-kopf">
              <h2 id="vp-bzs-werte">Werte</h2>
              {U.mitBetrag(werte).length > ZUERST && (
                <button type="button" className="vp-ms-link vp-ks-alle" aria-expanded={alle} onClick={() => setAlle((x) => !x)}>
                  {alle ? 'Weniger zeigen' : `Alle ${U.mitBetrag(werte).length}`}
                  {!alle && <Icon name="chevron-right" size={14} />}
                </button>
              )}
            </div>
            {werte.length === 0 ? (
              <p className="vp-ms-leise">Noch keine Werte. {erlaubt ? 'Tragen Sie den ersten Wert ein.' : ''}</p>
            ) : (
              <ul className="vp-bzs-liste">
                {[...werte]
                  .sort((x, y) => (y.periode_von ?? y.zeitpunkt ?? '').localeCompare(x.periode_von ?? x.zeitpunkt ?? ''))
                  .slice(0, alle ? undefined : ZUERST)
                  .map((w) => (
                    <WertZeile
                      key={w.periode_von ?? w.zeitpunkt}
                      b={b}
                      w={w}
                      zone={zone}
                      offen={offen === (w.periode_von ?? w.zeitpunkt)}
                      onFassungen={() => setOffen((o) => (o === (w.periode_von ?? w.zeitpunkt) ? null : (w.periode_von ?? w.zeitpunkt)))}
                      onBerichtigen={
                        erlaubt && !w.fassungen.some((f) => f.kanal) && !w.vorschlag && !w.stand_offen
                          ? (el) => {
                              ausloeser.current = el;
                              setDialog({ alt: w });
                            }
                          : null
                      }
                    />
                  ))}
              </ul>
            )}
          </section>
          {(b.wertart === 'periodenwert' || b.art === 'gradtagzahl') && (
            <section className="vp-ms-ort vp-bzs-woher" aria-labelledby="vp-bzs-woher">
              <div className="vp-ms-ort-kopf">
                <h2 id="vp-bzs-woher">Woher die Werte kommen</h2>
              </div>
              <p className="vp-bzs-woher-satz">{`Zuletzt ${reihe.woher}.`}</p>
              {b.wertart === 'periodenwert' && (
                <BezugsKanalbindung onChanged={() => setKanalRevision((n) => n + 1)} bezug={b} standort={standort} zone={zone} />
              )}
              {b.art === 'gradtagzahl' && <BezugsWetter onChanged={() => setKanalRevision((n) => n + 1)} bezug={b} standort={standort} zone={zone} />}
            </section>
          )}
        </>
      )}
      {dialog && standort !== undefined && erlaubt && (
        <BezugswertDialog
          bindungen={bindungen}
          key={dialog.alt?.periode_von ?? 'neu'}
          onBerichtigen={(alt) => setDialog({ alt })}
          bezug={b}
          werte={werte}
          alt={dialog.alt}
          standort={standort}
          zone={zone}
          onClose={schliessen}
          onSaved={(a) => {
            setMeldung([a.satz, ...a.hinweise.map((h) => h.satz)].join(' '));
            setWerte((ws) => [...(ws ?? []).filter((w) => w.periode_von !== a.wert.periode_von), a.wert]);
            setStand((s) => (s ? { ...s, liste: { ...s.liste, bezugsgroessen: s.liste.bezugsgroessen.map((x) => (x.id === b.id ? { ...x, hat_werte: true } : x)) } } : s));
            schliessen();
          }}
        />
      )}
      {stammDialog && erlaubt && (
        <StammdatumDialog
          b={b}
          heute={stand.heute}
          onClose={schliessen}
          onGespeichert={(st) => {
            setStamm(st);
            setMeldung(`${b.name}: der Wert ist eingetragen.`);
            schliessen();
          }}
        />
      )}
      {archiv && darfVerwalten && (
        <ConfirmDialog
          open
          title="Bezugsgröße archivieren?"
          intro={`„${b.name}“ wird archiviert.`}
          consequences={B.ARCHIV_FOLGEN}
          confirmLabel={U.ARCHIVIEREN}
          busy={busy}
          onConfirm={() => void archivieren()}
          onCancel={() => {
            if (!busy) schliessen();
          }}
          extra={archivFehler ? <p role="alert">{archivFehler}</p> : undefined}
        />
      )}
    </div>
  );
}

/** Die Kachel: der letzte Wert groß, darunter derselbe Zeitraum im Vorjahr - beide Zahlen des Servers, nichts verglichen. */
function WertKachel({ b, werte }: { b: Bezugsgroesse; werte: BezugsgroesseWert[] }) {
  const liste = U.mitBetrag(werte);
  const letzter = liste[0] ?? null;
  const art = b.periode_art;
  const schluessel = letzter?.periode_von && art ? schluesselVon(letzter.periode_von, art) : null;
  const vj = schluessel && art ? U.vorjahr(schluessel, art) : null;
  const vjWert = vj && art ? liste.find((w) => w.periode_von && schluesselVon(w.periode_von, art) === vj) : null;
  return (
    <section className="vp-bzs-kachel" aria-labelledby="vp-bzs-kachel" data-testid="bezugsgroesse-kachel">
      <h2 id="vp-bzs-kachel" className="vp-bzs-kachel-titel">
        <span className="vp-bzs-kachel-icon" aria-hidden="true">
          <Icon name="activity" size={15} />
        </span>
        {schluessel && art ? `Letzter Wert · ${U.periodeText(schluessel, art)}` : 'Letzter Wert'}
      </h2>
      {letzter?.wirksamer_betrag ? (
        <p className="vp-bzs-gross">
          <b>{U.zahlDe(letzter.wirksamer_betrag)}</b>
          <span>{b.einheit}</span>
        </p>
      ) : (
        <p className="vp-bzs-gross">
          <b className="is-leer">—</b>
          <span className="vp-ms-leise">noch kein Wert</span>
        </p>
      )}
      {vj && art && (
        <p className="vp-bzs-kachel-fuss">
          {vjWert?.wirksamer_betrag
            ? `${U.periodeText(vj, art)}: ${U.zahlDe(vjWert.wirksamer_betrag)} ${b.einheit}`
            : `${U.periodeText(vj, art)}: noch kein Wert`}
          {letzter && ` · ${U.woherDesWerts(letzter)}`}
        </p>
      )}
    </section>
  );
}

/** Zwölf Perioden als Balken auf EINER Skala (die Anzeige skaliert, gerechnet wird nichts); eine Lücke bleibt leer. */
function Balken({ b, werte, heute }: { b: Bezugsgroesse; werte: BezugsgroesseWert[]; heute: string }) {
  const art = b.periode_art!;
  const letzter = U.mitBetrag(werte)[0];
  const bis = letzter?.periode_von ? schluesselVon(letzter.periode_von, art) : U.faelligePeriode(art, heute);
  const reihe = U.zwoelfPerioden(werte, art, bis);
  const max = Math.max(0, ...reihe.map((r) => (r.betrag === null ? 0 : Number(r.betrag))));
  if (max <= 0) return null;
  const titel = { tag: 'Werte je Tag', woche: 'Werte je Woche', monat: 'Werte je Monat', jahr: 'Werte je Jahr' }[art];
  const zuletzt = reihe[reihe.length - 1];
  return (
    <section className="vp-ms-ort vp-bzs-balken" aria-labelledby="vp-bzs-balken" data-testid="bezugsgroesse-balken">
      <div className="vp-ms-ort-kopf">
        <h2 id="vp-bzs-balken">{titel}</h2>
        <span className="vp-ms-ort-zahl">{`${reihe.length} ${art === 'monat' ? 'Monate' : art === 'jahr' ? 'Jahre' : art === 'woche' ? 'Wochen' : 'Tage'}`}</span>
      </div>
      <div className="vp-bzs-saeulen" role="img" aria-label={reihe.map((r) => `${U.periodeText(r.schluessel, art)}: ${r.betrag === null ? 'kein Wert' : `${U.zahlDe(r.betrag)} ${b.einheit}`}`).join('; ')}>
        {reihe.map((r, i) => (
          <span key={r.schluessel} className={`vp-bzs-saeule${i === reihe.length - 1 ? ' is-letzte' : ''}${r.betrag === null ? ' is-luecke' : ''}`}>
            <span className="vp-bzs-saeule-feld">
              {r.betrag !== null && <span className="vp-bzs-saeule-wert" style={{ height: `${Math.max(2, (Number(r.betrag) / max) * 100)}%` }} />}
            </span>
            <span className="vp-bzs-saeule-marke">{U.balkenMarke(r.schluessel, art)}</span>
          </span>
        ))}
      </div>
      <p className="vp-bzs-balken-fuss">
        <b>{`${U.periodeText(zuletzt.schluessel, art)}: ${zuletzt.betrag === null ? 'noch kein Wert' : `${U.zahlDe(zuletzt.betrag)} ${b.einheit}`}`}</b>
      </p>
    </section>
  );
}

/** Eine Zeile der Werte: der Zeitraum als Block, der Wert, woher er kommt; ⋯ für Berichtigen und Fassungen. */
function WertZeile({
  b,
  w,
  zone,
  offen,
  onFassungen,
  onBerichtigen,
}: {
  b: Bezugsgroesse;
  w: BezugsgroesseWert;
  zone: string;
  offen: boolean;
  onFassungen: () => void;
  onBerichtigen: ((el: HTMLElement | null) => void) | null;
}) {
  const art = b.periode_art;
  const schluessel = w.periode_von && art ? schluesselVon(w.periode_von, art) : null;
  const wirksam = w.fassungen.find((f) => f.fassung === w.wirksame_fassung);
  const knopf = useRef<HTMLSpanElement>(null);
  const items: RowMenuItem[] = [];
  if (onBerichtigen) items.push({ label: 'Berichtigen', icon: 'pencil', onClick: () => onBerichtigen(knopf.current?.querySelector('button') ?? null) });
  items.push({ label: `${offen ? 'Fassungen ausblenden' : 'Fassungen ansehen'} (${w.fassungen.length})`, icon: 'history', onClick: onFassungen });
  const block = schluessel && art ? U.periodeText(schluessel, art, true).split(' ') : null;
  return (
    <li className="vp-bzs-zeile" data-testid="bezugswert-zeile">
      <span className={`vp-bzs-block${w.wirksamer_betrag === null ? ' is-leer' : ''}`} aria-hidden="true">
        {block ? (
          <>
            <b>{block.length > 1 ? block.slice(0, -1).join(' ') : block[0]}</b>
            {block.length > 1 && <span>{block[block.length - 1]}</span>}
          </>
        ) : (
          <b>{w.zeitpunkt ? zeitText(w.zeitpunkt, zone) : '—'}</b>
        )}
      </span>
      <span className="vp-bzs-zeile-text">
        <b>{w.wirksamer_betrag === null ? 'zurückgenommen' : `${U.zahlDe(w.wirksamer_betrag)} ${b.einheit}`}</b>
        <span>
          {[U.woherDesWerts(w), wirksam?.urheber.name, wirksam ? datumText(lokalerTag(wirksam.eingetragen_am, zone)) : null, w.wirksame_fassung && w.wirksame_fassung > 1 ? `Fassung ${w.wirksame_fassung}` : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {wertKennzeichen(wirksam?.kennzeichen ?? []).map((k) => (
          <small key={k}>{k}</small>
        ))}
        {w.vorschlag && (
          <small className="is-warn">{`Vorschlag von ${w.vorschlag.urheber.name}: ${U.zahlDe(w.vorschlag.betrag)} ${b.einheit}. Bis zur Freigabe gilt der bisherige Wert.`}</small>
        )}
      </span>
      <span className="vp-bzs-zeile-menue" ref={knopf}>
        <RowMenu label={`Aktionen zu ${schluessel && art ? U.periodeText(schluessel, art) : 'diesem Wert'}`} items={items} />
      </span>
      {offen && (
        <ul className="vp-bzs-fassungen" data-testid="bezugswert-fassungen">
          {w.fassungen.map((f) => (
            <li key={f.fassung}>
              <b>{`Fassung ${f.fassung} · ${f.betrag === null ? 'ohne Wert' : `${U.zahlDe(f.betrag)} ${b.einheit}`}`}</b>
              <span>
                {[f.fassung === w.wirksame_fassung ? 'wirksam' : 'frühere Fassung', f.herkunft.art === 'eingabe' ? 'eingetragen' : f.herkunft.art === 'import' ? 'importiert' : 'aus einem Messkanal', f.urheber.name, zeitText(f.eingetragen_am, zone)].join(' · ')}
              </span>
              {f.herkunft.import_kennung && <span>{`${f.herkunft.import_kennung} · Zeile ${f.herkunft.import_zeile} · ${f.herkunft.geliefert_text ?? ''} ${f.herkunft.geliefert_einheit ?? ''}`.trim()}</span>}
              {f.kanal && (
                <span>{`Aus Messkanal ${f.kanal.kanal} · ${kanalRegelText(f.kanal.regel)} · ${f.kanal.zustand} · ${UEMS_VERLAUF_PROZENT.replace('{prozent}', `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(f.kanal.abdeckung_prozent)} %`)}${f.kanal.vorlaeufig ? ' · vorläufig' : ''}`}</span>
              )}
              {f.kanal?.bindungen
                ?.filter((k) => k.regel && (k.regel !== f.kanal?.regel || k.kanal !== f.kanal?.kanal))
                .map((k, i) => <span key={i}>{`Aus Messkanal ${k.kanal} · ${kanalRegelText(k.regel ?? '')}`}</span>)}
              {f.kanal && f.kennzeichen.filter((k) => !k.startsWith('aus Messkanal ') && !k.startsWith('Gradtage G')).map((k) => <span key={k}>{k}</span>)}
              {f.begruendung && <span>{f.begruendung}</span>}
              {f.freigeber && <span>{`Freigegeben von ${f.freigeber.name}`}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Ein Stammdatum (eigene Fläche): was heute gilt und seit wann; frühere Angaben darunter. */
function StammdatumKarte({ b, stamm, heute }: { b: Bezugsgroesse; stamm: BezugsgroesseStammdatum | null; heute: string }) {
  const jetzt = stamm ? U.stammHeute(stamm, heute) : null;
  const frueher = (stamm?.intervalle ?? []).filter((i) => i !== jetzt).sort((x, y) => y.gueltig_ab.localeCompare(x.gueltig_ab));
  return (
    <section className="vp-bzs-kachel" aria-labelledby="vp-bzs-stamm" data-testid="bezugsgroesse-stammdatum">
      <h2 id="vp-bzs-stamm" className="vp-bzs-kachel-titel">
        <span className="vp-bzs-kachel-icon" aria-hidden="true">
          <Icon name="building" size={15} />
        </span>
        Gilt heute
      </h2>
      {jetzt ? (
        <>
          <p className="vp-bzs-gross">
            <b>{U.zahlDe(jetzt.wert)}</b>
            <span>{b.einheit}</span>
          </p>
          <p className="vp-bzs-kachel-fuss">{`seit ${U.periodeText(jetzt.gueltig_ab, 'tag')}${jetzt.gueltig_bis ? ` · bis ${U.periodeText(jetzt.gueltig_bis, 'tag')}` : ''} · ${stamm?.schreibbar === false ? U.WOHER.gebaeude : U.WOHER.eigen}`}</p>
        </>
      ) : (
        <p className="vp-bzs-gross">
          <b className="is-leer">—</b>
          <span className="vp-ms-leise">noch kein Wert</span>
        </p>
      )}
      {frueher.length > 0 && (
        <ul className="vp-bzs-frueher">
          {frueher.map((i) => (
            <li key={`${i.gueltig_ab}-${i.eingetragen_am}`}>
              {`${U.zahlDe(i.wert)} ${b.einheit} · ab ${U.periodeText(i.gueltig_ab, 'tag')}${i.gueltig_bis ? ` bis ${U.periodeText(i.gueltig_bis, 'tag')}` : ''}${i.aufgehoben_am ? ' · aufgehoben' : ''}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Ein Wert eines Stammdatums ab einem Tag (E15/S4) - die Ablehnung des Servers wörtlich. */
function StammdatumDialog({ b, heute, onClose, onGespeichert }: { b: Bezugsgroesse; heute: string; onClose: () => void; onGespeichert: (s: BezugsgroesseStammdatum) => void }) {
  const [wert, setWert] = useState('');
  const [ab, setAb] = useState(heute);
  const [fehler, setFehler] = useState<{ wert?: string; senden?: string }>({});
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const speichern = async () => {
    if (busy) return;
    const text = zahlText(wert);
    if (!text) {
      setFehler({ wert: `Bitte geben Sie die Fläche in ${b.einheit} ein, zum Beispiel 4.200.` });
      requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('#stamm-wert')?.focus());
      return;
    }
    setBusy(true);
    setFehler({});
    try {
      onGespeichert(await api.bezugsgroesseStammdatumEintragen(b.id, { wert: text, gueltig_ab: ab }));
    } catch (e) {
      setFehler({ senden: B.fehlerSatz(e) });
      requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[role="alert"]')?.focus());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={U.WERT_EINTRAGEN}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Abbrechen
          </Button>
          <Button type="submit" form="stammdatum-form" disabled={busy}>
            {busy ? 'Wird gespeichert …' : 'Speichern'}
          </Button>
        </>
      }
    >
      <form id="stammdatum-form" ref={form} className="vp-bz-form" noValidate onSubmit={(e) => { e.preventDefault(); void speichern(); }}>
        <p>{`${b.kennzeichen} · ${b.name} · ${b.geltung_name}`}</p>
        <Input id="stamm-wert" label={`Fläche (${b.einheit})`} inputMode="decimal" autoFocus value={wert} onChange={(e) => { setWert(e.target.value); setFehler({}); }} disabled={busy} error={fehler.wert} />
        <VpDatePicker id="stamm-ab" label="Gilt ab" value={ab} onChange={setAb} disabled={busy} />
        {fehler.senden && (
          <p role="alert" tabIndex={-1}>
            {fehler.senden}
          </p>
        )}
      </form>
    </Modal>
  );
}
