/**
 * Plattform → Geräte → **Fernwartung** (Entscheid E5 des Kapitäns, 07.10.2026).
 *
 * Der Wartungstunnel der Boxen: welche Box welchen Tunnel hat, welche
 * Techniker-Zugänge es gibt, welche Fenster offen sind - und das Protokoll.
 * Das Portal führt den Soll-Zustand; der Tunnel-Dienst auf der Wartungs-VM
 * setzt ihn um und meldet nichts zurück. Die Seite sagt deshalb getrennt, was
 * im Portal steht, wann der Dienst zuletzt abgeholt hat und was niemand weiß.
 *
 * Nur Plattform-Admins (O3: der Kunde sieht die Fenster nicht). Alle
 * Ableitungen stehen im reinen `adminFernwartung.ts`.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { ApiError } from '../../api';
import { adminApi } from '../../admin/adminApi';
import {
  abrufLage,
  aktionLabel,
  boxOrt,
  fensterTeile,
  fensterTon,
  loeschbar,
  loeschenRueckfrage,
  oeffnenSperre,
  protokollDetail,
  serverLage,
  UNBEKANNT_SATZ,
  ZUSTIMMUNG_SATZ,
  zeitpunkt,
  type FernwartungBox,
  type FernwartungFenster,
  type FernwartungProtokollEintrag,
  type FernwartungTechniker,
  type FernwartungUebersicht,
} from '../../adminFernwartung';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  FensterDialog,
  LageZeile,
  SchluesselDialog,
  TechnikerDialog,
  TechnikerKonfigAnzeige,
} from '../../components/FernwartungDialoge';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { fernwartungHash, parseFernwartungBox } from '../../nav';
import { replaceCurrentNavigation } from '../../navigationBlocker';
import { AdminPageHead } from './AdminPageHead';
import './Fernwartung.css';

type Sperrziel =
  | { art: 'box'; box: FernwartungBox }
  | { art: 'techniker'; techniker: FernwartungTechniker };

export function FernwartungPage({ tabs }: { tabs?: ReactNode } = {}) {
  const [uebersicht, setUebersicht] = useState<FernwartungUebersicht | null>(null);
  const [boxen, setBoxen] = useState<FernwartungBox[] | null>(null);
  const [techniker, setTechniker] = useState<FernwartungTechniker[] | null>(null);
  const [protokoll, setProtokoll] = useState<FernwartungProtokollEintrag[] | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [aktionsFehler, setAktionsFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [boxFilter, setBoxFilter] = useState<string | null>(() =>
    parseFernwartungBox(window.location.hash),
  );
  const [fensterFuer, setFensterFuer] = useState<FernwartungBox | null>(null);
  const [schluesselOffen, setSchluesselOffen] = useState(false);
  const [technikerOffen, setTechnikerOffen] = useState(false);
  const [konfigFuer, setKonfigFuer] = useState<FernwartungTechniker | null>(null);
  const [sperrziel, setSperrziel] = useState<Sperrziel | null>(null);
  const [loeschziel, setLoeschziel] = useState<FernwartungTechniker | null>(null);
  const [schliessen, setSchliessen] = useState<FernwartungFenster | null>(null);
  const [jetzt, setJetzt] = useState(() => new Date());

  async function laden(filter: string | null = boxFilter) {
    setLadeFehler(null);
    const [u, b, t, p] = await Promise.allSettled([
      adminApi.fernwartung(),
      adminApi.fernwartungBoxen(),
      adminApi.fernwartungTechniker(),
      adminApi.fernwartungProtokoll({ box: filter, limit: 100 }),
    ]);
    if (u.status === 'fulfilled') setUebersicht(u.value);
    if (b.status === 'fulfilled') setBoxen(b.value);
    if (t.status === 'fulfilled') setTechniker(t.value);
    if (p.status === 'fulfilled') setProtokoll(p.value);
    const erster = [u, b, t, p].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (erster) {
      setLadeFehler(
        erster.reason instanceof ApiError
          ? erster.reason.message
          : 'Die Fernwartung ließ sich nicht laden. Bitte erneut versuchen.',
      );
    }
    setJetzt(new Date());
  }

  useEffect(() => {
    void laden();
    const onHash = () => {
      const f = parseFernwartungBox(window.location.hash);
      setBoxFilter(f);
      void laden(f);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function filtern(ref: string | null) {
    setBoxFilter(ref);
    replaceCurrentNavigation(fernwartungHash(ref));
    void laden(ref);
  }

  async function aktion(was: () => Promise<unknown>, sonst: string) {
    setBusy(true);
    setAktionsFehler(null);
    try {
      await was();
      await laden();
    } catch (e) {
      setAktionsFehler(e instanceof ApiError ? e.message : sonst);
    } finally {
      setBusy(false);
    }
  }

  const sortierteBoxen = useMemo(
    () =>
      boxen
        ? [...boxen].sort((a, b) =>
            a.edgeRef === boxFilter ? -1 : b.edgeRef === boxFilter ? 1 : a.adresse.localeCompare(b.adresse),
          )
        : null,
    [boxen, boxFilter],
  );

  const geladen = uebersicht && sortierteBoxen && techniker;

  return (
    <div className="vp-admin-page vp-fw">
      <AdminPageHead icon="lock" title="Fernwartung" description={ZUSTIMMUNG_SATZ} />
      {tabs}

      {ladeFehler && !geladen ? (
        <ErrorState message={ladeFehler} onRetry={() => void laden()} />
      ) : !geladen ? (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <TableSkeleton rows={4} cols={5} />
        </Card>
      ) : (
        <>
          <Card padding="md" radius="lg" className="vp-fw-lagen" data-testid="fw-lagen">
            <LageZeile lage={serverLage(uebersicht.server)} testId="fw-server" />
            <LageZeile lage={abrufLage(uebersicht, jetzt)} testId="fw-dienst" />
            <p className="vp-note" style={{ margin: 0 }}>
              {UNBEKANNT_SATZ}
            </p>
          </Card>
          {ladeFehler && <p className="vp-alert vp-alert-warn">{ladeFehler}</p>}
          {aktionsFehler && <p className="vp-alert vp-alert-err">{aktionsFehler}</p>}

          {/* ── Boxen ─────────────────────────────────────────────── */}
          <section className="vp-fw-sektion" aria-labelledby="fw-sektion-boxen">
            <div className="vp-fw-sektion-kopf">
              <h2 id="fw-sektion-boxen">Boxen mit Tunnel</h2>
              <Button
                variant="outline"
                size="sm"
                iconLeft={<Icon name="plus" size={16} />}
                onClick={() => setSchluesselOffen(true)}
              >
                Tunnel-Schlüssel hinterlegen
              </Button>
            </div>
            {sortierteBoxen.length === 0 ? (
              <Card padding="lg" radius="lg">
                <EmptyState
                  icon="lock"
                  title="Noch keine Box mit Tunnel-Schlüssel"
                  description="Die Box erzeugt ihren Schlüssel selbst (service-tunnel.sh <box> key). Den öffentlichen Teil hier hinterlegen; die Box bekommt dann ihre Tunnel-Adresse."
                />
              </Card>
            ) : (
              <Card style={{ padding: 0, overflow: 'hidden' }}>
                <div className="vp-table-scroll">
                  <table className="vp-table responsive" data-testid="fw-boxen">
                    <thead>
                      <tr>
                        <th>Box</th>
                        <th>Tunnel</th>
                        <th>Fernwartung</th>
                        <th aria-label="Aktionen" />
                      </tr>
                    </thead>
                    <tbody>
                      {sortierteBoxen.map((b) => {
                        const sperre = oeffnenSperre(b, techniker);
                        return (
                          <tr key={b.id} className={b.edgeRef === boxFilter ? 'vp-fw-gewaehlt' : undefined}>
                            <td data-label="Box">
                              <span className="vp-cell-main">
                                <span>
                                  {b.edgeRef}{' '}
                                  {b.status === 'gesperrt' && <Badge variant="off">gesperrt</Badge>}
                                </span>
                                <span className="vp-cell-sub">{boxOrt(b)}</span>
                              </span>
                            </td>
                            <td data-label="Tunnel">
                              <span className="vp-cell-main">
                                <span>{b.adresse}</span>
                                <span className="vp-cell-sub" title={b.publicKey}>
                                  {b.publicKeyKurz}
                                </span>
                              </span>
                            </td>
                            <td data-label="Fernwartung">
                              {b.laufendeFenster.length === 0 ? (
                                <span className="vp-muted">kein Fenster</span>
                              ) : (
                                <ul className="vp-fw-fenster">
                                  {b.laufendeFenster.map((f) => (
                                    <li key={f.id}>
                                      <Badge variant={fensterTon(f.zustand)} dot>
                                        {fensterTeile(f, jetzt).zustand}
                                      </Badge>
                                      <span>{fensterTeile(f, jetzt).text}</span>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => setSchliessen(f)}
                                      >
                                        {f.zustand === 'geplant' ? 'Absagen' : 'Schließen'}
                                      </Button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </td>
                            <td data-label="Aktionen">
                              <div className="vp-fw-aktionen">
                                <Button
                                  variant="primary"
                                  size="sm"
                                  disabled={busy || sperre != null}
                                  title={sperre ?? undefined}
                                  onClick={() => setFensterFuer(b)}
                                >
                                  Fenster öffnen
                                </Button>
                                {sperre && <span className="vp-cell-sub vp-fw-sperre">{sperre}</span>}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    b.status === 'gesperrt'
                                      ? void aktion(
                                          () => adminApi.fernwartungBoxEntsperren(b.edgeRef),
                                          'Entsperren fehlgeschlagen.',
                                        )
                                      : setSperrziel({ art: 'box', box: b })
                                  }
                                >
                                  {b.status === 'gesperrt' ? 'Entsperren' : 'Sperren'}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => filtern(b.edgeRef === boxFilter ? null : b.edgeRef)}
                                >
                                  {b.edgeRef === boxFilter ? 'Alle Einträge' : 'Protokoll'}
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </section>

          {/* ── Techniker ─────────────────────────────────────────── */}
          <section className="vp-fw-sektion" aria-labelledby="fw-sektion-techniker">
            <div className="vp-fw-sektion-kopf">
              <h2 id="fw-sektion-techniker">Techniker-Zugänge</h2>
              <Button
                variant="outline"
                size="sm"
                iconLeft={<Icon name="plus" size={16} />}
                onClick={() => setTechnikerOffen(true)}
              >
                Zugang anlegen
              </Button>
            </div>
            {techniker.length === 0 ? (
              <Card padding="lg" radius="lg">
                <EmptyState
                  icon="users"
                  title="Noch kein Techniker-Zugang"
                  description="Jedes Techniker-Gerät bekommt einen eigenen Zugang auf dem Wartungsserver. Ohne Zugang lässt sich kein Fenster öffnen."
                />
              </Card>
            ) : (
              <Card style={{ padding: 0, overflow: 'hidden' }}>
                <div className="vp-table-scroll">
                  <table className="vp-table responsive" data-testid="fw-techniker">
                    <thead>
                      <tr>
                        <th>Zugang</th>
                        <th>Tunnel</th>
                        <th>Status</th>
                        <th aria-label="Aktionen" />
                      </tr>
                    </thead>
                    <tbody>
                      {[...techniker]
                        .sort((a, b) => a.name.localeCompare(b.name, 'de'))
                        .map((t) => (
                          <tr key={t.id}>
                            <td data-label="Zugang">
                              <span className="vp-cell-main">
                                <span>{t.name}</span>
                                {t.notiz && <span className="vp-cell-sub">{t.notiz}</span>}
                              </span>
                            </td>
                            <td data-label="Tunnel">
                              <span className="vp-cell-main">
                                <span>{t.adresse}</span>
                                <span className="vp-cell-sub" title={t.publicKey}>
                                  {t.publicKeyKurz}
                                </span>
                              </span>
                            </td>
                            <td data-label="Status">
                              <Badge variant={t.status === 'aktiv' ? 'ok' : 'off'} dot>
                                {t.status}
                              </Badge>
                            </td>
                            <td data-label="Aktionen">
                              <div className="vp-fw-aktionen">
                                <Button variant="ghost" size="sm" onClick={() => setKonfigFuer(t)}>
                                  Konfiguration
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    t.status === 'gesperrt'
                                      ? void aktion(
                                          () => adminApi.fernwartungTechnikerEntsperren(t.id),
                                          'Entsperren fehlgeschlagen.',
                                        )
                                      : setSperrziel({ art: 'techniker', techniker: t })
                                  }
                                >
                                  {t.status === 'gesperrt' ? 'Entsperren' : 'Sperren'}
                                </Button>
                                {loeschbar(t) && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => setLoeschziel(t)}
                                  >
                                    Löschen
                                  </Button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </section>

          {/* ── Protokoll ─────────────────────────────────────────── */}
          <section className="vp-fw-sektion" aria-labelledby="fw-sektion-protokoll">
            <div className="vp-fw-sektion-kopf">
              <h2 id="fw-sektion-protokoll">
                Protokoll{boxFilter ? ` · ${boxFilter}` : ''}
              </h2>
              {boxFilter && (
                <Button variant="ghost" size="sm" onClick={() => filtern(null)}>
                  Alle Boxen zeigen
                </Button>
              )}
            </div>
            <ProtokollListe eintraege={protokoll ?? []} jetzt={jetzt} />
          </section>
        </>
      )}

      <FensterDialog
        box={fensterFuer}
        techniker={techniker ?? []}
        maxMinuten={uebersicht?.maxFensterMinuten ?? 60}
        onClose={() => setFensterFuer(null)}
        onGeoeffnet={() => {
          setFensterFuer(null);
          void laden();
        }}
      />
      <SchluesselDialog
        offen={schluesselOffen}
        onClose={() => setSchluesselOffen(false)}
        onFertig={() => void laden()}
      />
      <TechnikerDialog
        offen={technikerOffen}
        onClose={() => setTechnikerOffen(false)}
        onFertig={() => void laden()}
      />
      {konfigFuer && uebersicht && (
        <Modal open onClose={() => setKonfigFuer(null)} title={`Konfiguration · ${konfigFuer.name}`}>
          <TechnikerKonfigAnzeige techniker={konfigFuer} server={uebersicht.server} />
        </Modal>
      )}
      <ConfirmDialog
        open={sperrziel != null}
        title={
          sperrziel?.art === 'box'
            ? `Box ${sperrziel.box.edgeRef} für die Fernwartung sperren?`
            : `Zugang „${sperrziel?.art === 'techniker' ? sperrziel.techniker.name : ''}“ sperren?`
        }
        intro="Die Sperre gilt, bis sie aufgehoben wird. Die Tunnel-Adresse bleibt reserviert."
        consequences={[
          'Der Tunnel-Dienst entfernt den Zugang beim nächsten Abruf vom Wartungsserver.',
          'Offene und geplante Fenster werden sofort geschlossen und protokolliert.',
          sperrziel?.art === 'box'
            ? 'Der Betrieb der Box hängt nicht am Tunnel und läuft weiter.'
            : 'Ein verlorenes Gerät bleibt damit ohne Weg zu den Boxen.',
        ]}
        confirmLabel="Sperren"
        tone="danger"
        busy={busy}
        onCancel={() => setSperrziel(null)}
        onConfirm={() => {
          const ziel = sperrziel;
          setSperrziel(null);
          if (!ziel) return;
          void aktion(
            () =>
              ziel.art === 'box'
                ? adminApi.fernwartungBoxSperren(ziel.box.edgeRef)
                : adminApi.fernwartungTechnikerSperren(ziel.techniker.id),
            'Sperren fehlgeschlagen.',
          );
        }}
      />
      <ConfirmDialog
        open={loeschziel != null}
        title={loeschziel ? loeschenRueckfrage(loeschziel).titel : ''}
        intro={loeschziel ? loeschenRueckfrage(loeschziel).satz : ''}
        consequences={loeschziel ? loeschenRueckfrage(loeschziel).folgen : []}
        confirmLabel="Endgültig löschen"
        tone="danger"
        busy={busy}
        onCancel={() => setLoeschziel(null)}
        onConfirm={() => {
          const ziel = loeschziel;
          setLoeschziel(null);
          if (!ziel) return;
          void aktion(() => adminApi.fernwartungTechnikerLoeschen(ziel.id), 'Löschen fehlgeschlagen.');
        }}
      />
      <ConfirmDialog
        open={schliessen != null}
        title={schliessen?.zustand === 'geplant' ? 'Geplantes Fenster absagen?' : 'Fenster jetzt schließen?'}
        intro={schliessen ? `${schliessen.edgeRef} · ${schliessen.technikerName} · ${schliessen.grund}` : ''}
        consequences={[
          'Der Tunnel-Dienst schließt den Weg beim nächsten Abruf, auch eine laufende Sitzung.',
          'Das Schließen steht im Protokoll.',
        ]}
        confirmLabel={schliessen?.zustand === 'geplant' ? 'Absagen' : 'Schließen'}
        busy={busy}
        onCancel={() => setSchliessen(null)}
        onConfirm={() => {
          const f = schliessen;
          setSchliessen(null);
          if (!f) return;
          void aktion(() => adminApi.fernwartungFensterSchliessen(f.id), 'Schließen fehlgeschlagen.');
        }}
      />
    </div>
  );
}

export function ProtokollListe({
  eintraege,
  jetzt,
}: {
  eintraege: FernwartungProtokollEintrag[];
  jetzt: Date;
}) {
  if (eintraege.length === 0) {
    return <p className="vp-muted">Noch keine Einträge.</p>;
  }
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div className="vp-table-scroll">
        <table className="vp-table responsive" data-testid="fw-protokoll">
          <thead>
            <tr>
              <th>Zeit</th>
              <th>Wer</th>
              <th>Was</th>
              <th>Box · Techniker</th>
              <th>Einzelheiten</th>
            </tr>
          </thead>
          <tbody>
            {eintraege.map((e) => (
              <tr key={e.id}>
                <td data-label="Zeit">{zeitpunkt(e.zeit, jetzt)}</td>
                <td data-label="Wer">{e.akteur}</td>
                <td data-label="Was">{aktionLabel(e.aktion)}</td>
                <td data-label="Box · Techniker">
                  {[e.edgeRef, e.technikerName].filter(Boolean).join(' · ') || '—'}
                </td>
                <td data-label="Einzelheiten">{protokollDetail(e, jetzt) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
