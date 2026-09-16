import { Recht } from './Recht';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Switch } from '../../designsystem/components/forms/Switch';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type GeraetRolle, type Messstelle, type RollenZuordnungAntwort } from '../api';
import { fmtNum } from '../format';
import {
  GESAMTWERT,
  alsAnfrage,
  frischeVon,
  hakenAnwendbar,
  leererEntwurf,
  punkt,
  richtungsEntscheidungSatz,
  richtungsloseOhneEntscheidung,
  schluessel,
  schritt1Fertig,
  termAus,
  unvollstaendigSatz,
  vorschau,
  wertText,
  type Entwurf,
  type Quellwert,
} from '../gesamtwert';
import {
  ankerAus,
  anhakbar,
  gruppen,
  sperrArt,
  sperrGrund,
  sperrKurz,
  suchePasst,
  unterzeile,
  vorauswahl,
  zeileAus,
  zuQuellwert,
  type RegisterZeile,
} from '../summenwertQuellen';
import { ConfirmDialog } from './ConfirmDialog';
import './SummenwertAssistent.css';

/** Das Kundenwort der Rolle PV-Produktion und die „folgt"-Vorschau der weiteren Rollen. */
const ROLLE_PV = 'PV-Produktion';
const WEITERE_ROLLEN = ['Netz', 'Speicher', 'Verbrauch'] as const;

/**
 * Der Summenwert-Assistent der Geräteseite (Konzept vp-agg-konzept3-r8): aus ALLEN
 * Registern des Geräts einen „Gesamtwert" bauen (Schritt 1) und ihn der Rolle
 * PV-Produktion zuordnen (Schritt 2 - „verwenden als"). Zentriertes `Modal`, am
 * Handy Vollbild - dasselbe Muster wie der `GesamtwertDialog`, aber geräteseitig
 * und aus dem vollen Register-Inventar (`measurementCatalog` + `summenwertQuellen`).
 *
 * Render-only: die Regeln liegen rein in `gesamtwert.ts` und `summenwertQuellen.ts`.
 */
export function SummenwertAssistent({
  open,
  siteId,
  deviceId,
  entityId,
  geraetName,
  bestehend,
  onClose,
  onGespeichert,
}: {
  open: boolean;
  siteId: string;
  /** Die lesende Box (Bindung von Katalog/Selektion/Beobachtung). */
  deviceId: string;
  /** Die Komponente, an die Terme und die Rollen-Zuordnung binden. */
  entityId: string;
  geraetName: string;
  /** Die bestehende PV-Zuordnung dieses Geräts (für den Ersetzen-Dialog), oder null. */
  bestehend: GeraetRolle | null;
  onClose: () => void;
  /** Der Summenwert ist angelegt und zugeordnet - der Wirt lädt die Anzeige neu. */
  onGespeichert?: (messstelle: Messstelle, antwort: RollenZuordnungAntwort) => void;
}) {
  const [entwurf, setEntwurf] = useState<Entwurf>(() => ({ ...leererEntwurf(), name: 'PV gesamt' }));
  const [nameBeruehrt, setNameBeruehrt] = useState(false);
  const [query, setQuery] = useState('');
  const [beobachtet, setBeobachtet] = useState<RegisterZeile[] | null>(null);
  const [alle, setAlle] = useState<RegisterZeile[]>([]);
  const [alleGesamt, setAlleGesamt] = useState(0);
  const [revision, setRevision] = useState(0);
  const [beobachteBusy, setBeobachteBusy] = useState<string | null>(null);
  const [ersetzenOffen, setErsetzenOffen] = useState(false);
  const [speichern, setSpeichern] = useState(false);
  const [serverFehler, setServerFehler] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<{ messstelle: Messstelle; antwort: RollenZuordnungAntwort } | null>(null);

  const jetzt = Date.now();
  const geladen = useRef(false);

  // Beim Öffnen: frischer Zustand + das Register-Inventar laden.
  useEffect(() => {
    if (!open) {
      geladen.current = false;
      return;
    }
    if (geladen.current) return;
    geladen.current = true;
    setEntwurf({ ...leererEntwurf(), name: 'PV gesamt' });
    setNameBeruehrt(false);
    setQuery('');
    setServerFehler(null);
    setErgebnis(null);
    void ladeBeobachtet(true);
    void ladeAlle('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Die „Alle Register"-Liste folgt der Suche (Server-seitig, weil 600+).
  useEffect(() => {
    if (!open || !geladen.current) return;
    const t = setTimeout(() => void ladeAlle(query), 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);

  const params = (extra: Record<string, string>) =>
    new URLSearchParams({ entityId, limit: '60', ...extra });

  /** Die durchsuchbare „Alle Register"-Seite (beobachtete stehen schon oben). */
  async function ladeAlle(q: string) {
    try {
      const res = await api.measurementCatalog(deviceId, params(q ? { q, limit: '80' } : {}));
      const selektiert = res.points.filter((p) => p.selected).length;
      setAlle(res.points.filter((p) => !p.selected).map((p) => zeileAus(p, entityId)));
      setAlleGesamt(Math.max(0, res.total - selektiert));
    } catch {
      setAlle([]);
    }
  }

  /**
   * Die beobachteten „Messwerte" + die Revision (für „+ Beobachten"). `precheck`
   * hakt EINMAL nur die Katalog-Erzeugungs-Stränge (PV 1/2/3, `richtung === 'Erzeugung'`)
   * vorab an. Richtungslose Register (der Gen-Port UND generische `direction:null`-Kanäle
   * wie `load-consumption-power` oder `work-mode.pv-power`) werden NIE still mitgezählt -
   * sie kommen ausschließlich über die ausdrückliche Kunden-Entscheidung (Schalter) in die
   * Summe. Eine spätere Neuladung (nach dem Beobachten) lässt die Auswahl des Kunden stehen.
   */
  async function ladeBeobachtet(precheck: boolean): Promise<RegisterZeile[]> {
    try {
      const [obsRes, sel] = await Promise.all([
        api.measurementCatalog(deviceId, params({ selectedOnly: 'true', limit: '250' })),
        api.measurementSelection(deviceId, entityId).catch(() => null),
      ]);
      const obs = obsRes.points.map((p) => zeileAus(p, entityId));
      setBeobachtet(obs);
      if (sel) setRevision(sel.desiredRevision);
      if (precheck) {
        const vorab = vorauswahl(obs);
        setEntwurf((e) => ({
          ...e,
          terme: vorab.map((z) => termAus(zuQuellwert(z, geraetName))),
        }));
      }
      return obs;
    } catch {
      setBeobachtet((b) => b ?? []);
      return [];
    }
  }

  const gewaehlteQuellen = entwurf.terme.map((t) => t.quelle);
  const anker = ankerAus(gewaehlteQuellen);
  const gewaehlteKeys = new Set(entwurf.terme.map((t) => schluessel(t.quelle)));
  const vorschauWert = vorschau(entwurf.terme);

  // Der Name-Vorschlag „PV gesamt" bleibt, bis der Kunde ihn selbst anfasst.
  const name = entwurf.name;

  const beobachteteGefiltert = useMemo(
    () => (beobachtet ?? []).filter((z) => suchePasst(z, query)),
    [beobachtet, query],
  );
  // Gerichtete Messwerte als Zeilen; JEDES richtungslose Register (nicht nur das erste) als
  // ausdrückliche Erzeugungs-Entscheidung - kein unsichtbarer Term, keine stille Zählung.
  const messwerte = beobachteteGefiltert.filter((z) => !z.richtungslos);
  const entscheidungen = beobachteteGefiltert.filter((z) => z.richtungslos);
  const alleGruppe = gruppen(alle, query).alle;
  // Client-seitiger Hart-Riegel (B1): ein richtungsloser Term ohne Erzeugungs-Entscheidung
  // ist nicht speicherbar (der Server lehnt ihn mit 400 ab). Statt den 400 zu provozieren,
  // sperrt der Assistent das Speichern und nennt den Grund.
  const offeneRichtung = richtungsloseOhneEntscheidung(entwurf.terme);

  function toggle(zeile: RegisterZeile, giltAlsErzeugung = false) {
    const key = schluessel({ entityId: zeile.entityId, channel: zeile.pointKey });
    setEntwurf((e) => {
      if (e.terme.some((t) => schluessel(t.quelle) === key)) {
        return { ...e, terme: e.terme.filter((t) => schluessel(t.quelle) !== key) };
      }
      const q: Quellwert = zuQuellwert(zeile, geraetName);
      const t = termAus(q);
      return { ...e, terme: [...e.terme, giltAlsErzeugung && hakenAnwendbar(q) ? { ...t, giltAlsErzeugung: true } : t] };
    });
  }

  async function beobachten(zeile: RegisterZeile) {
    if (beobachteBusy) return;
    setBeobachteBusy(zeile.pointKey);
    setServerFehler(null);
    try {
      const st = await api.changeMeasurementSelection(
        deviceId,
        zeile.pointKey,
        {
          expectedRevision: revision,
          idempotencyKey: `${entityId}:${zeile.pointKey}:${revision}`,
          enabled: true,
          cadenceS: zeile.standardKadenzS ?? undefined,
        },
        entityId,
      );
      setRevision(st.desiredRevision);
      // Das Register ist jetzt beobachtet: die Listen neu laden (OHNE den Schnellpfad neu zu
      // setzen). Ein gerichtetes Register (PV-Strang) wandert direkt in die Summe; ein
      // RICHTUNGSLOSES (Gen-Port & Co.) NICHT - es erscheint jetzt als ausdrückliche
      // Entscheidung (Schalter) in den Messwerten. So entsteht nie ein richtungsloser Term
      // ohne Entscheidung (den der Server mit 400 ablehnen würde).
      const obs = await ladeBeobachtet(false);
      void ladeAlle(query);
      const frisch = obs.find((z) => z.pointKey === zeile.pointKey) ?? zeile;
      if (!frisch.richtungslos) toggle(frisch);
    } catch (e) {
      setServerFehler(fehlerText(e, 'Das Beobachten ist gerade nicht gelungen.'));
    } finally {
      setBeobachteBusy(null);
    }
  }

  async function verwenden() {
    if (bestehend?.zugeordnet) {
      setErsetzenOffen(true);
      return;
    }
    await wirklichVerwenden();
  }

  async function wirklichVerwenden() {
    setErsetzenOffen(false);
    if (speichern) return;
    setSpeichern(true);
    setServerFehler(null);
    try {
      const messstelle = await api.berechneteMessstelleAnlegen(alsAnfrage({ ...entwurf, name: name.trim() }));
      const antwort = await api.rolleZuordnen(siteId, entityId, 'pv', {
        art: 'gesamtwert',
        quell_messstelle_id: messstelle.id,
      });
      setErgebnis({ messstelle, antwort });
      onGespeichert?.(messstelle, antwort);
    } catch (e) {
      setServerFehler(fehlerText(e, 'Das Speichern ist gerade nicht gelungen. Bitte noch einmal versuchen.'));
    } finally {
      setSpeichern(false);
    }
  }

  const kannSpeichern =
    schritt1Fertig(entwurf.terme)
    && offeneRichtung.length === 0
    && name.trim().length > 0
    && !vorschauWert.unvollstaendig;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={ergebnis ? 'Fertig' : `${GESAMTWERT} · ${geraetName}`}
      footer={Fuss()}
    >
      <div className="vp-sw">
        {ergebnis ? Fertig() : (
          <>
            {Schritt1()}
            {Schritt2()}
          </>
        )}
      </div>

      <ConfirmDialog
        open={ersetzenOffen}
        title="Zuordnung ersetzen?"
        intro={`„${bestehend?.zugeordnet?.name ?? 'Ein Wert'}" ist derzeit die PV-Produktion dieses Geräts. Stattdessen „${name.trim()}" verwenden?`}
        consequences={[
          'Der bisherige Wert bleibt bestehen - er ist nur nicht mehr die PV-Produktion.',
          'Es wird nie doppelt gezählt: genau ein Wert je Rolle je Gerät.',
        ]}
        confirmLabel="Ersetzen"
        onConfirm={() => void wirklichVerwenden()}
        onCancel={() => setErsetzenOffen(false)}
      />
    </Modal>
  );

  // ------------------------------------------------------------- Schritt 1
  function Schritt1() {
    return (
      <section className="vp-sw-step">
        <p className="vp-sw-steptag a">Schritt 1</p>
        <h3 className="vp-sw-h">Summenwert bauen - aus allen Registern</h3>
        <p className="vp-sw-sub">
          Die Messwerte oben sind vorbereitet. Jedes weitere Register des Geräts ist durchsuchbar -
          auch beobachtete und noch nicht aufgezeichnete.
        </p>

        <div className="vp-sw-name">
          <span className="vp-sw-name-lbl">Name</span>
          <input
            className="vp-sw-name-in"
            type="text"
            value={name}
            maxLength={80}
            aria-label="Name des Gesamtwerts"
            onChange={(e) => {
              setNameBeruehrt(true);
              setEntwurf((s) => ({ ...s, name: e.target.value }));
            }}
          />
          <Icon name="pencil" size={14} />
          {!nameBeruehrt && <span className="vp-sw-name-hint">Vorschlag - frei änderbar</span>}
        </div>

        <div className="vp-sw-search">
          <Icon name="search" size={16} />
          <input
            className="vp-sw-search-in"
            type="search"
            value={query}
            placeholder="Register durchsuchen … (Name, Gruppe, Einheit)"
            aria-label="Register durchsuchen"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {/* Gruppe „Messwerte" - die beobachteten Kanäle, prominent. */}
        <div className="vp-sw-group prom">
          <div className="vp-sw-group-h">
            <Icon name="activity" size={15} />
            <span className="vp-sw-group-t">Messwerte</span>
            <span className="vp-sw-group-c">
              beobachtet · {beobachtet == null ? '…' : beobachteteGefiltert.length}
            </span>
          </div>
          {beobachtet == null ? (
            <p className="vp-sw-hint">Register werden geladen …</p>
          ) : (
            <>
              {messwerte.map((z) => Zeile(z))}
              {entscheidungen.map((z) => Entscheidung(z))}
              {messwerte.length === 0 && entscheidungen.length === 0 && (
                <p className="vp-sw-hint">Noch keine beobachteten Messwerte an diesem Gerät.</p>
              )}
            </>
          )}
        </div>

        {/* Gruppe „Alle Register des Geräts" - der volle Katalog, durchsuchbar. */}
        <div className="vp-sw-group">
          <div className="vp-sw-group-h">
            <Icon name="layers" size={15} />
            <span className="vp-sw-group-t">Alle Register des Geräts</span>
            <span className="vp-sw-group-c">{alleGesamt} weitere</span>
          </div>
          {alleGruppe.map((z) => Zeile(z))}
          {alleGruppe.length === 0 && (
            <p className="vp-sw-hint">
              {query ? 'Kein Register passt zu Ihrer Suche.' : 'Keine weiteren Register.'}
            </p>
          )}
        </div>

        <div className="vp-sw-sumline">
          <span className="vp-sw-sum-k">
            {GESAMTWERT} „{name.trim() || 'PV gesamt'}"
          </span>
          <span className="vp-sw-sum-v">
            {vorschauWert.unvollstaendig ? 'unvollständig' : wertText(vorschauWert.wert, vorschauWert.einheit)}
          </span>
        </div>
        {vorschauWert.unvollstaendig && entwurf.terme.length > 0 && (
          <p className="vp-sw-warn">{unvollstaendigSatz(vorschauWert.fehlende)}</p>
        )}
        {offeneRichtung.length > 0 && (
          <p className="vp-sw-warn" role="alert">
            {richtungsEntscheidungSatz(offeneRichtung.map((t) => t.quelle.name))}
          </p>
        )}
      </section>
    );
  }

  /** Eine Register-Zeile: Häkchen (oder Sperre/Beobachten) · Name+Kategorie · Wert. */
  function Zeile(zeile: RegisterZeile) {
    const art = sperrArt(zeile, anker);
    const key = schluessel({ entityId: zeile.entityId, channel: zeile.pointKey });
    const gewaehlt = gewaehlteKeys.has(key);
    const kann = anhakbar(zeile, anker);
    const gesperrt = art !== 'summierbar';
    const rohSummierbar = art === 'summierbar' && !zeile.beobachtet;
    return (
      <div key={zeile.pointKey} className={`vp-sw-row${gesperrt ? ' locked' : ''}`}>
        {rohSummierbar ? (
          <span className="vp-sw-chk off" aria-hidden="true" />
        ) : (
          <button
            type="button"
            className={`vp-sw-chk${gewaehlt ? ' on' : gesperrt ? ' lock' : ' off'}`}
            aria-pressed={gewaehlt}
            aria-label={`${zeile.name} ${gewaehlt ? 'entfernen' : 'mitzählen'}`}
            disabled={!kann}
            title={gesperrt ? sperrGrund(art) ?? undefined : undefined}
            onClick={() => kann && toggle(zeile)}
          >
            {gewaehlt && <Icon name="check" size={12} strokeWidth={3.4} />}
          </button>
        )}
        <div className="vp-sw-mid">
          <div className="vp-sw-nm">
            {zeile.beobachtet && <span className={`vp-sw-dot ${punkt(frischeVon(zeile.stand, zeile.wert, jetzt))}`} />}
            {zeile.name}
          </div>
          <div className="vp-sw-subrow">{unterzeile(zeile, anker)}</div>
        </div>
        {zeile.beobachtet && zeile.wert != null && (
          <span className="vp-sw-rv">{wertText(zeile.wert, zeile.einheit ?? '')}</span>
        )}
        {rohSummierbar && (
          <Recht aktion="mess_selektion.bearbeiten"><button
            type="button"
            className="vp-sw-obs"
            disabled={beobachteBusy != null}
            onClick={() => void beobachten(zeile)}
          >
            <Icon name="plus" size={12} strokeWidth={2.6} />
            {beobachteBusy === zeile.pointKey ? 'Beobachten …' : 'Beobachten'}
            <span className="vp-sw-obs-cost">· ≈ {fmtNum(zeile.jahresBytes / 1e9, '', 1)} GB/Jahr</span>
          </button></Recht>
        )}
        {gesperrt && <span className="vp-sw-lockr">{sperrKurz(art)}</span>}
      </div>
    );
  }

  /**
   * Eine richtungslose Register-Entscheidung mit Schalter (der AP-08-Haken „gilt als Erzeugung").
   * NUR der wirklich ambivalente Gen-Port (`zeile.genPort`) trägt die erklärte Gen-Port-Frage
   * („Mikrowechselrichter?"); jedes andere richtungslose Register bekommt die NEUTRALE
   * Erzeugungs-Frage - kein irreführendes Gen-Port-Wording. Der Schalter setzt die Entscheidung;
   * erst dann zählt das Register mit (nie still, nie ohne Entscheidung).
   */
  function Entscheidung(zeile: RegisterZeile) {
    const key = schluessel({ entityId: zeile.entityId, channel: zeile.pointKey });
    const an = gewaehlteKeys.has(key);
    const wert = zeile.wert != null ? <b>{wertText(zeile.wert, zeile.einheit ?? '')}</b> : null;
    return (
      <div className="vp-sw-suggest">
        <div className="vp-sw-suggest-body">
          {zeile.genPort ? (
            <>
              <p className="vp-sw-suggest-q">Am Gen-Port hängt ein Mikrowechselrichter?</p>
              <p className="vp-sw-suggest-why">
                Dann zählt seine Erzeugung mit.{wert && <> Er misst gerade {wert}.</>}
              </p>
              <span className="vp-sw-ap">löst die Richtung dieses Anschlusses auf</span>
            </>
          ) : (
            <>
              <p className="vp-sw-suggest-q">Zählt „{zeile.name}" als Erzeugung?</p>
              <p className="vp-sw-suggest-why">
                Dieses Register trägt keine Richtung - Sie entscheiden, ob seine Leistung als
                Erzeugung mitzählt.{wert && <> Es misst gerade {wert}.</>}
              </p>
              <span className="vp-sw-ap">löst die Richtung dieses Registers auf</span>
            </>
          )}
        </div>
        <Switch checked={an} onChange={() => toggle(zeile, true)} label={an ? 'Zählt mit' : 'Aus'} />
      </div>
    );
  }

  // ------------------------------------------------------------- Schritt 2
  function Schritt2() {
    return (
      <section className="vp-sw-step">
        <p className="vp-sw-steptag b">Schritt 2</p>
        <h3 className="vp-sw-h">Diesen Wert verwenden als …</h3>
        <div className="vp-sw-assign">
          <div className="vp-sw-assign-top">
            <span className="vp-sw-assign-lead">„{name.trim() || 'PV gesamt'}" verwenden als</span>
            <span className="vp-sw-rolesel">
              <Icon name="sun" size={15} />
              {ROLLE_PV}
            </span>
          </div>
          <p className="vp-sw-assign-hint">
            <Icon name="info" size={15} />
            Genau ein Wert je Rolle je Gerät. Wählen Sie später einen anderen, ersetzt er diese
            Zuordnung - nie doppelt gezählt.
          </p>
          <div className="vp-sw-rolechips">
            <span className="vp-sw-rolechip">
              <span className="vp-sw-dot pv" /> {ROLLE_PV} · zugeordnet
            </span>
            {WEITERE_ROLLEN.map((r) => (
              <span key={r} className="vp-sw-rolechip soon">{r} · folgt</span>
            ))}
          </div>
        </div>
        <p className="vp-sw-flows">
          <Icon name="chevron-right" size={15} />
          Fließt automatisch in die Gesamt-PV Ihrer Anlage ein - und in den Optimizer.
        </p>
        {serverFehler && <p className="vp-sw-error" role="alert">{serverFehler}</p>}
      </section>
    );
  }

  // ------------------------------------------------------------- Fertig
  function Fertig() {
    const abgeloest = ergebnis?.antwort.abgeloest;
    return (
      <section className="vp-sw-done">
        <div className="vp-sw-done-circle">
          <Icon name="check" size={30} strokeWidth={3} />
        </div>
        <h3>„{ergebnis?.messstelle.name ?? name.trim()}" ist die PV-Produktion dieses Geräts</h3>
        {abgeloest && (
          <p className="vp-sw-done-note">„{abgeloest.name}" ist damit nicht mehr die PV-Produktion.</p>
        )}
        <p>Fließt ab jetzt automatisch in die Gesamt-PV Ihrer Anlage - und in den Optimizer.</p>
      </section>
    );
  }

  // -------------------------------------------------------------- Fuß
  function Fuss() {
    if (ergebnis) {
      return (
        <div className="vp-sw-foot">
          <Button onClick={onClose}>Fertig</Button>
        </div>
      );
    }
    return (
      <div className="vp-sw-foot">
        <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
        <Recht aktion="geraet.einrichten"><Button onClick={() => void verwenden()} disabled={!kannSpeichern || speichern}>
          {speichern ? 'Speichern …' : `Verwenden als ${ROLLE_PV}`}
        </Button></Recht>
      </div>
    );
  }
}

function fehlerText(e: unknown, standard: string): string {
  return e instanceof Error && e.message ? e.message : standard;
}
