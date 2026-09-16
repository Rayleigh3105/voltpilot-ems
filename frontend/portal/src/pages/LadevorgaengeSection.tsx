import { Recht } from '../components/Recht';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { api, ApiError, type Device, type Site } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LadeBudgetBand } from '../components/LadeBudgetBand';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { fmtNum } from '../format';
import { useStaffel } from '../staffel';
import {
  ANBINDEN_ALLOWLIST,
  ANBINDEN_EINSTIEG,
  ausfallSchutz,
  BOOST_INTRO,
  boostFolgen,
  ladepunktAktionen,
  budgetBand,
  chargerName,
  chargerView,
  connectorName,
  idleLine,
  kombinationsStreifen,
  ladevorgangRows,
  sonnenDeckung,
  surplusLine,
  type ChargePoint,
  type LadevorgangRow,
  type SiteCharging,
} from '../ladepunkte';
import { LadesaeuleAnbindenDrawer } from '../components/LadesaeuleAnbinden';
import { FahrzeugDialog } from '../components/FahrzeugDialog';
import { verlaufFahrzeug, type FahrzeugWunsch, type SiteFahrzeuge } from '../fahrzeugProfile';
import { fuehrendeBoxOf, boxRefOf, chargerGeraetId } from '../geraetSeite';
import { anlageRoute, geraetSeiteHash, hashForRoute } from '../nav';
import { Icon } from '../../designsystem/components/core/Icon';
import './Ladevorgaenge.css';
import { useFreshnessPoll } from '../useFreshnessPoll';
// LIVE: ein Ladevorgang bewegt sich im Sekundentakt.
import { LIVE_POLL_MS } from '../pollCadence';

/**
 * Die Ladevorgänge einer Anlage (`#/anlage/{id}/ladevorgaenge`) - die Fläche 1
 * der abgenommenen Mockups als Seite: die Budget-Bühne, die Ladevorgangs-Zeilen,
 * die Säulen mit ihrem Zustand, der Ausfall-Schutz mit seiner RECHNUNG und der
 * Weg, eine weitere Säule anzubinden.
 *
 * ⚠ Jede Zahl und jeder Grund kommt aus der BOX und wird nur weitergereicht
 * (`ladepunkte.ts`); diese Seite rendert, sie entscheidet nichts. Es gibt hier
 * bewusst keinen Knopf, der eine Ladegrenze setzt - Grenzen entstehen allein im
 * Lastmanagement der Box.
 */
export function LadevorgaengeSection({
  site,
  devices,
}: {
  site: Site;
  /**
   * Für den Weg auf die Geräteseite der Säule (`cp-…`, Zentrale Stufe 3, PR 3c).
   * Ohne EINE eindeutige Box gibt es keinen Schlüssel - dann wird der Weg gar
   * nicht angeboten, statt einen zu raten (`boxRefOf`).
   */
  devices?: Device[];
}) {
  // Bewegung P6: die Ladevorgänge staffeln beim ersten Blick (`src/staffel.ts`).
  const ladeStaffel = useStaffel('ladevorgaenge');
  const boxRef = boxRefOf(devices, site.id);
  // Die Box kennt ihre eigene Adresse (D5) - der Assistent baut daraus den
  // `ws://`-Endpunkt. Ohne EINE eindeutige Box nennt er ehrlich den Weg.
  const box = fuehrendeBoxOf(devices, site.id);
  const [charging, setCharging] = useState<SiteCharging | null>(null);
  const [error, setError] = useState<string | null>(null);
  // „Jetzt voll laden": die EINE Aktion dieser Seite. Sie setzt keine Grenze -
  // sie nimmt EINEN Ladevorgang von der Quellen-Politik aus.
  const [dialog, setDialog] = useState<LadevorgangRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [anbinden, setAnbinden] = useState(false);
  // Die Fahrzeuge dieser Anlage (P7) - fail-soft: ein älteres Backend kennt die
  // Route nicht, dann bleibt die Zeile ohne Fahrzeug-Weg und alles Übrige
  // rendert zeichengleich wie vorher.
  const [fahrzeuge, setFahrzeuge] = useState<SiteFahrzeuge | null>(null);
  const [benennen, setBenennen] = useState<string | null>(null);

  // Eine späte Antwort der ZUVOR gewählten Anlage darf die neue nie
  // überschreiben - der Ersatz für den `active`-Wächter des alten Intervalls.
  const siteIdRef = useRef(site.id);
  siteIdRef.current = site.id;
  const loadRef = useRef<() => void>(() => {});
  loadRef.current = () => {
    const id = site.id;
    api.siteChargers(id).then(
      (c) => id === siteIdRef.current && setCharging(c),
      (e) => id === siteIdRef.current && setError(e instanceof ApiError ? e.message : 'Fehler'),
    );
    api.siteFahrzeuge(id).then(
      (v) => id === siteIdRef.current && setFahrzeuge(v),
      () => {},
    );
  };
  useEffect(() => {
    setCharging(null);
    setError(null);
    setFahrzeuge(null);
    loadRef.current();
  }, [site.id]);
  // `useFreshnessPoll` statt eines nackten Intervalls: ein verdeckter Tab wird
  // gedrosselt, sonst stünde beim Zurückkommen erst der Stand von vorhin.
  useFreshnessPoll(() => loadRef.current(), LIVE_POLL_MS);

  async function boost(row: LadevorgangRow, cancel: boolean) {
    setBusy(true);
    setActionError(null);
    try {
      await api.chargingBoost(site.id, {
        chargePointId: row.chargePointId,
        connectorId: row.connectorId,
        cancel,
        // ⚠ Die RICHTUNG folgt dem, was WIRKLICH läuft: die Papier-Spur des
        // Kommando-Verlaufs hängt daran, und „Jetzt voll laden beendet" über
        // einer Pause wäre dort eine Falschaussage. Pausieren selbst bietet
        // diese Seite nicht an - das ist die Jetzt-Zone (P3b).
        action: cancel && row.handeingriff ? 'pause' : 'voll',
      });
      setCharging(await api.siteChargers(site.id));
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Das hat gerade nicht geklappt.');
    } finally {
      setBusy(false);
      setDialog(null);
    }
  }

  async function speichereFahrzeug(tagRef: string, wunsch: FahrzeugWunsch) {
    setFahrzeuge(await api.setzeFahrzeug(site.id, tagRef, wunsch));
  }

  async function entferneFahrzeug(tagRef: string) {
    setFahrzeuge(await api.entferneFahrzeugProfil(site.id, tagRef));
  }

  if (error) return <ErrorState message={error} />;
  if (!charging) return <Skeleton height={160} />;

  const band = budgetBand(charging.budget);
  const rows = ladevorgangRows(charging.chargers);
  const idle = idleLine(charging);
  const steps = ausfallSchutz(charging.budget);
  const quelle = surplusLine(charging.budget);
  const kombi = kombinationsStreifen(charging.budget);
  const sonne = sonnenDeckung(charging.budget);

  return (
    <div className="vp-lade-page">
      {band && (
        <Card>
          <h2 className="vp-lade-h2">Ladeleistung</h2>
          <LadeBudgetBand band={band} />
          {/* BEIDE Wahrheiten: was die Sonne erlaubt und was der Anschluss
              erlaubt. Ohne beide läse eine Drosselung an einem freien Anschluss
              wie ein Defekt (Mockups §1a). */}
          {sonne && <p className="vp-lade-note">Laden · {sonne}.</p>}
          {quelle && <p className="vp-lade-note">{quelle}</p>}
          {kombi && <p className="vp-lade-note">{kombi}</p>}
          {charging.budget && !charging.budget.controlEnabled && charging.budget.controlNote && (
            <p className="vp-lade-note">{charging.budget.controlNote}</p>
          )}
        </Card>
      )}

      <Card>
        <h2 className="vp-lade-h2">Ladevorgänge</h2>
        {idle && <p className="vp-lade-idle">{idle}</p>}
        {actionError && <p className="vp-lade-note">{actionError}</p>}
        {rows.length > 0 && (
          <ul className={ladeStaffel ? `vp-lade-rows ${ladeStaffel}` : 'vp-lade-rows'}>
            {rows.map((r) => (
              <li key={r.key} className={`vp-lade-row tone-${r.tone}`}>
                <span className="vp-lade-dot" aria-hidden="true" />
                <span className="vp-lade-row-title">
                  {r.title}
                  {r.priority && <Badge variant="tint">Vorrang</Badge>}
                </span>
                <span className="vp-lade-row-word">{r.word}</span>
                <span className="vp-lade-row-values">
                  {r.powerKw != null ? fmtNum(r.powerKw, 'kW') : '-'}
                  {r.allocatedKw != null && (
                    <span className="vp-lade-row-alloc">
                      zugeteilt {fmtNum(r.allocatedKw, 'kW')}
                    </span>
                  )}
                  {r.socPct != null && (
                    <span className="vp-lade-row-soc">Fahrzeug {fmtNum(r.socPct, '%', 0)}</span>
                  )}
                  {r.since && <span className="vp-lade-row-since">{r.since}</span>}
                </span>
                {(r.reason || r.nextTurn) && (
                  <span className="vp-lade-row-reason">
                    {[r.reason, r.nextTurn].filter(Boolean).join(' · ')}
                  </span>
                )}
                {/* ⚠ Der Weg vom Ladevorgang zum Fahrzeug-Profil (P7). Er
                    erscheint NUR, wo die Box ein Karten-Pseudonym gemeldet hat -
                    eine Säule, die keines nennt, sagt nichts über ein Auto, und
                    ein Knopf, der nichts benennen kann, ist Lärm. */}
                {(() => {
                  const v = verlaufFahrzeug(r.tagRef, fahrzeuge);
                  if (!v) return null;
                  return (
                    <span className="vp-lade-row-fahrzeug">
                      <span className="vp-lade-row-fahrzeug-text">{v.text}</span>
                      <Recht aktion="ladepunkt.betrieb"><Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setBenennen(v.zeile.tagRef)}
                      >
                        {v.aktion}
                      </Button></Recht>
                    </span>
                  );
                })()}
                {/* ⚠ Der Knopf wird nur angeboten, wo er etwas ändern KANN. Ein
                    Knopf, der strukturell nichts bewirkt, ist Lärm. */}
                {/* ⚠ EINE Regel für beide Flächen: welche Handlung ein
                    Ladepunkt anbietet, entscheidet seit P3a
                    `ladepunktAktionen` - hier und in der Jetzt-Zone. Es gibt
                    keine Kopie, die auseinanderlaufen könnte. */}
                {ladepunktAktionen(charging.budget, r).includes('voll_laden') && (
                  <Recht aktion="handeingriff.setzen"><Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setDialog(r)}
                  >
                    Jetzt voll laden
                  </Button></Recht>
                )}
                {ladepunktAktionen(charging.budget, r).includes('resume') && (
                  <Recht aktion="handeingriff.setzen"><Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void boost(r, true)}
                  >
                    {r.handeingriff ? 'Automatik fortsetzen' : 'Wieder Ihre Priorität'}
                  </Button></Recht>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="vp-lade-h2">Ladesäulen</h2>
        {charging.chargers.length === 0 ? (
          <EmptyState
            title="Noch keine Ladesäule verbunden"
            description={ANBINDEN_EINSTIEG}
          />
        ) : (
          <ul className="vp-lade-stations">
            {charging.chargers.map((c) => (
              <StationCard
                key={c.chargePointId}
                charger={c}
                href={
                  boxRef
                    ? geraetSeiteHash(site.id, boxRef, chargerGeraetId(c.chargePointId))
                    : null
                }
              />
            ))}
          </ul>
        )}
      </Card>

      {steps.length > 0 && (
        <Card>
          <h2 className="vp-lade-h2">Ausfall-Schutz</h2>
          <ol className="vp-lade-steps">
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <p className="vp-lade-always">Immer aktiv - unabhängig davon, was VoltPilot gerade tut.</p>
        </Card>
      )}

      {/* Geräteseiten Stufe 3 (E1): aus den drei Sätzen ist ein ASSISTENT
          geworden - er trägt die konkrete Adresse zum Kopieren und wartet mit,
          bis die Säule sich wirklich gemeldet hat. Die Tür im Anlagen-Modell
          öffnet denselben Körper. */}
      <Card>
        <h2 className="vp-lade-h2">Weitere Säule anbinden</h2>
        <p className="vp-lade-note">{ANBINDEN_EINSTIEG}</p>
        <p className="vp-lade-note">{ANBINDEN_ALLOWLIST}</p>
        <div className="vp-lade-anbinden-actions">
          <Recht aktion="ladepunkt.anbinden"><Button size="sm" onClick={() => setAnbinden(true)}>
            Ladesäule anbinden
          </Button></Recht>
          <a className="vp-lade-note" href={hashForRoute(anlageRoute(site.id, 'modell'))}>
            Alle Geräte dieser Anlage ansehen →
          </a>
        </div>
      </Card>

      <LadesaeuleAnbindenDrawer
        open={anbinden}
        siteId={site.id}
        device={box ?? undefined}
        devices={(devices ?? []).filter((device) => device.siteId === site.id)}
        onClose={() => setAnbinden(false)}
      />

      {/* Benennen aus dem Verlauf heraus (P7, Konzept §4.5): derselbe Dialog wie
          in der Fahrzeuge-Karte - zwei Dialoge über dieselbe Sache wären zwei
          Wahrheiten. */}
      {benennen && (() => {
        const v = verlaufFahrzeug(benennen, fahrzeuge);
        return v ? (
          <FahrzeugDialog
            zeile={v.zeile}
            fahrzeug={v.fahrzeug}
            onClose={() => setBenennen(null)}
            onSpeichern={speichereFahrzeug}
            onEntfernen={v.fahrzeug ? entferneFahrzeug : undefined}
          />
        ) : null;
      })()}

      {/* Der Haus-Dialog mit der Folgenliste - sie sagt auch, was GLEICH bleibt. */}
      <ConfirmDialog
        open={dialog != null}
        title="Jetzt voll laden"
        intro={BOOST_INTRO}
        consequences={boostFolgen()}
        confirmLabel="Jetzt voll laden"
        busy={busy}
        onConfirm={() => dialog && void boost(dialog, false)}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}

/**
 * Eine Säule mit ihrem Zustand, ihrer Selbstauskunft und ihren Steckern.
 *
 * ⚠ Anlagen-Zentrale Stufe 3 (PR 3c, §13.4): der frühere Aufklapper
 * „Technische Angaben" ist die GERÄTESEITE der Säule (`cp-…`) geworden - ein
 * Ladepunkt hat damit denselben EINEN Ort wie jedes andere Gerät, statt eines
 * vierten Einzelorts. Diese Seite bleibt die VORGANGS-Sicht (wie die
 * Befehle-Seite); sie zeigt weiterhin, was man ohne Klick wissen muss, und
 * führt für den Rest dorthin. Ohne eindeutige Box (`href == null`) bleibt der
 * Aufklapper - ein Weg, der nirgends hinführt, wird nie angeboten.
 */
function StationCard({ charger, href }: { charger: ChargePoint; href: string | null }) {
  const view = chargerView(charger);
  const self = [charger.vendor, charger.model].filter(Boolean).join(' ');
  const angaben = (
    <>
      <dl className="vp-lade-dl">
        <dt>Kennung</dt>
        <dd>{charger.chargePointId}</dd>
        <dt>Verbindung</dt>
        <dd>OCPP 1.6J - die Säule wählt VoltPilot an</dd>
        {self && (
          <>
            <dt>Angabe der Säule</dt>
            <dd>{self}</dd>
          </>
        )}
        {charger.firmware && (
          <>
            <dt>Firmware</dt>
            <dd>{charger.firmware}</dd>
          </>
        )}
      </dl>
      <ul className="vp-lade-plugs">
        {(charger.connectors ?? []).map((con) => (
          <li key={con.connectorId}>
            {connectorName(con.connectorId)}
            {con.status ? ` · ${con.status}` : ''}
            {con.readback === 'abweichend' && ' · Grenze nicht bestätigt'}
          </li>
        ))}
      </ul>
    </>
  );
  return (
    <li className={`vp-lade-station tone-${view.tone}`}>
      <div className="vp-lade-station-head">
        <span className="vp-lade-dot" aria-hidden="true" />
        <strong>{chargerName(charger)}</strong>
        <span className="vp-lade-station-word">{view.word}</span>
        {charger.priority && <Badge variant="tint">Vorrang</Badge>}
        {href && (
          <a className="vp-lade-station-go" href={href}>
            Geräteseite <Icon name="chevron-right" size={14} />
          </a>
        )}
      </div>
      <p className="vp-lade-note">{view.detail}</p>
      {href ? (
        <p className="vp-lade-note">
          Kennung <span className="vp-mono">{charger.chargePointId}</span>
          {self && <> · {self}</>}
        </p>
      ) : (
        <details className="vp-lade-details">
          <summary>Technische Angaben</summary>
          {angaben}
        </details>
      )}
    </li>
  );
}
