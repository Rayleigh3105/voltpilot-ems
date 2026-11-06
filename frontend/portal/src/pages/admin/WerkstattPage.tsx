/**
 * Die Werkstatt (Entscheid WI-8 A, nur platform-admin nach WI-10 B): Die
 * Arbeit an der Box macht der Werkstatt-Dienst. Diese Seite zeigt, was er
 * tut: an der Werkbank die geführten Bildschirme (`WerkstattBank`,
 * `#/werkstatt?werkbank=1`), am Rechner die Übersicht (D1) mit der Freigabe
 * („Werkstatt freigeben“, „Freigabe beenden“), der Werkbank-Brücke, den Boxen
 * und den Belegen der gewählten Box (`?box=<referenz>`, auch das Ziel des
 * Direktlinks). Handschritte, Passwort-Generator und Probe-Knöpfe gibt es
 * nicht mehr: Das macht der Dienst, jeden Schritt mit Beleg.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { ApiError } from '../../api';
import { adminApi } from '../../admin/adminApi';
import { ErrorState, TableSkeleton } from '../../components/States';
import { istWerkstattWerkbank, parseFernwartungBox, werkstattHash, werkstattWerkbankHash } from '../../nav';
import { replaceCurrentNavigation } from '../../navigationBlocker';
import { useFreshnessPoll } from '../../useFreshnessPoll';
import { VERSAND_SATZ, type WerkstattBox } from '../../werkstatt';
import {
  freigabeZeile,
  liesDienst,
  laufendeFreigabe,
  uebersicht,
  type UebersichtZeile,
  type WerkstattDienst,
  type WerkstattFreigabe,
  type ZurSeite,
} from '../../werkstattBank';
import { zeitpunkt } from '../../adminFernwartung';
import { AdminPageHead } from './AdminPageHead';
import { WerkstattBank } from './WerkstattBank';
import { neueresRelease, schrittTitel } from '../../werkstattLauf';
import type { EdgeUpdatesRelease } from '../../adminEdgeUpdates';
import { WerkstattFreigabeDialog } from './WerkstattFreigabeDialog';
import { STAND_BADGE } from './WerkstattTeile';
import { WerkstattBoxSeite } from './WerkstattBoxSeite';
import './Fernwartung.css';
import './Werkstatt.css';

/** So oft fragt die Seite den Stand des Dienstes nach (er meldet etwa alle 10 s). */
const TAKT_MS = 5_000;

function fehlerText(e: unknown, sonst: string): string {
  return e instanceof ApiError ? e.message : sonst;
}

export function WerkstattPage({ tabs }: { tabs?: ReactNode } = {}) {
  const [boxen, setBoxen] = useState<WerkstattBox[] | null>(null);
  const [dienst, setDienst] = useState<WerkstattDienst | null>(null);
  const [freigaben, setFreigaben] = useState<WerkstattFreigabe[] | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [aktionsFehler, setAktionsFehler] = useState<string | null>(null);
  const [werkbank, setWerkbank] = useState(() => istWerkstattWerkbank(window.location.hash));
  const [auswahl, setAuswahl] = useState<string | null>(() => parseFernwartungBox(window.location.hash));
  const [dialog, setDialog] = useState<'freigeben' | 'beenden' | null>(null);
  const [busy, setBusy] = useState(false);
  const [jetzt, setJetzt] = useState(() => new Date());

  async function laden() {
    const [b, d, f] = await Promise.allSettled([adminApi.werkstattBoxen(), adminApi.werkstattDienst(), adminApi.werkstattFreigaben()]);
    if (b.status === 'fulfilled') setBoxen(b.value);
    if (d.status === 'fulfilled') setDienst(liesDienst(d.value));
    if (f.status === 'fulfilled') setFreigaben(f.value);
    const erster = [b, d, f].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    setLadeFehler(erster ? fehlerText(erster.reason, 'Die Werkstatt ließ sich nicht laden. Bitte erneut versuchen.') : null);
    setJetzt(new Date());
  }

  useEffect(() => {
    void laden();
    const onHash = () => {
      setWerkbank(istWerkstattWerkbank(window.location.hash));
      setAuswahl(parseFernwartungBox(window.location.hash));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Der Dienst meldet sich im Takt; die Seite fragt still nach, an der Werkbank wie am Rechner.
  useFreshnessPoll(() => void laden(), TAKT_MS);

  const freigabe = useMemo(() => laufendeFreigabe(freigaben ?? []), [freigaben]);
  // Ein neueres signiertes Edge-Light-Release als die Freigabe: nur ein Hinweis an der Werkbank, einmal gefragt.
  const [releases, setReleases] = useState<EdgeUpdatesRelease[]>([]);
  useEffect(() => {
    if (!werkbank) return;
    let aus = false;
    (async () => {
      try {
        const u = await adminApi.edgeUpdates();
        if (!aus) setReleases(u.releases ?? []);
      } catch {
        // ohne Liste kein Hinweis
      }
    })();
    return () => { aus = true; };
  }, [werkbank]);
  const neuerEdgeLight = useMemo(() => {
    const f = dienst?.ansicht?.freigabe.freigabe;
    return f ? neueresRelease(f.edge_light.fassung, releases) : null;
  }, [dienst, releases]);
  const zeilen = useMemo(() => uebersicht(boxen ?? [], dienst?.laeufe ?? []), [boxen, dienst]);
  const gewaehlt = auswahl ? zeilen.find((z) => z.box === auswahl) ?? null : null;
  const geladen = boxen && dienst && freigaben;

  function waehle(ref: string | null) {
    setAuswahl(ref);
    replaceCurrentNavigation(werkstattHash(ref));
  }

  async function beenden() {
    if (!freigabe) return;
    setBusy(true);
    setAktionsFehler(null);
    try {
      await adminApi.werkstattFreigabeBeenden(freigabe.kennung);
      setDialog(null);
      await laden();
    } catch (e) {
      setAktionsFehler(fehlerText(e, 'Die Freigabe ließ sich nicht beenden.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-admin-page vp-fw vp-ws">
      {/* Die Reiter stehen auf allen Geräte-Seiten über dem Kopf - sonst springt die Leiste beim Wechsel. */}
      {tabs}
      <AdminPageHead
        icon="sliders"
        title="Werkstatt"
        description="Boxen vor dem Versand: Der Werkstatt-Dienst richtet sie ein und prüft sie, jeden Schritt mit Beleg. Hier siehst du, was er tut, und gibst die Werkstatt frei."
      />

      {ladeFehler && !geladen ? (
        <ErrorState message={ladeFehler} onRetry={() => void laden()} />
      ) : !geladen ? (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <TableSkeleton rows={4} cols={4} />
        </Card>
      ) : werkbank ? (
        <WerkstattBank
          dienst={dienst}
          freigabe={freigabe}
          neuerEdgeLight={neuerEdgeLight}
          onUebersicht={() => { window.location.hash = werkstattHash(null); }}
          onBox={(ref) => { window.location.hash = werkstattHash(ref); }}
          onNochmal={async (lauf) => {
            try {
              await adminApi.werkstattNochmal(lauf);
            } catch (e) {
              throw new Error(fehlerText(e, '„Nochmal versuchen“ ließ sich nicht senden.'));
            }
            await laden();
          }}
          onZurSeite={async (lauf) => {
            try {
              await adminApi.werkstattZurSeite(lauf);
            } catch (e) {
              throw new Error(fehlerText(e, 'Die Box ließ sich nicht als „zur Seite gelegt“ speichern.'));
            }
            await laden();
          }}
        />
      ) : (
        <>
          {auswahl == null && (
            <div className="vp-ws-kopfzeile">
              <Button onClick={() => { window.location.hash = werkstattWerkbankHash(); }} data-testid="ws-zur-werkbank">
                An der Werkbank
              </Button>
              <Badge variant="warn" data-testid="ws-versand-oben" title={VERSAND_SATZ}>
                Nicht versenden: Stufe 1
              </Badge>
            </div>
          )}
          <DienstZeile dienst={dienst} />
          {ladeFehler && <p className="vp-alert vp-alert-warn">{ladeFehler}</p>}
          {aktionsFehler && <p className="vp-alert vp-alert-err">{aktionsFehler}</p>}

          {auswahl == null ? (
            <div className="vp-ws-haupt">
              <FreigabeKarte
                freigabe={freigabe}
                freigaben={freigaben}
                eingerichtet={dienst?.ansicht?.freigabe.boxen ?? null}
                onFreigeben={() => setDialog('freigeben')}
                onBeenden={() => setDialog('beenden')}
              />
              <BrueckeKarte dienst={dienst} />
              <BoxTabelle zeilen={zeilen} auswahl={auswahl} onWaehle={waehle} />
              {dienst?.zurSeite && <ZurSeiteKarte liste={dienst.zurSeite} onWaehle={waehle} />}
            </div>
          ) : !gewaehlt ? (
            <div className="vp-ws-box" data-testid="ws-box">
              <p style={{ marginTop: 0 }}>{auswahl} steht nicht in der Werkstatt-Liste.</p>
              <Button variant="outline" size="sm" onClick={() => waehle(null)}>Alle Boxen</Button>
            </div>
          ) : (
            <WerkstattBoxSeite
              zeile={gewaehlt}
              boxen={boxen}
              freigaben={freigaben}
              jetzt={jetzt}
              onZurueck={() => waehle(null)}
              onGeloescht={(ref) => {
                setBoxen((alt) => (alt ? alt.filter((b) => b.edgeRef !== ref) : alt));
                waehle(null);
                void laden();
              }}
            />
          )}
        </>
      )}

      {dialog === 'freigeben' && (
        <WerkstattFreigabeDialog onClose={() => setDialog(null)} onErteilt={() => { setDialog(null); void laden(); }} />
      )}
      {dialog === 'beenden' && freigabe && (
        <Modal
          open
          title="Freigabe beenden"
          onClose={() => { if (!busy) setDialog(null); }}
          footer={
            <>
              <Button variant="outline" onClick={() => setDialog(null)} disabled={busy}>Abbrechen</Button>
              <Button onClick={() => void beenden()} disabled={busy} data-testid="ws-beenden-bestaetigen">
                {busy ? 'Wird beendet …' : 'Freigabe beenden'}
              </Button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            Ab jetzt richtet der Werkstatt-Dienst unter <strong>{freigabe.kennung}</strong> keine Box mehr ein. Ein Lauf, der
            gerade läuft, hält beim nächsten Schritt an. Eine neue Freigabe kannst du danach erteilen.
          </p>
        </Modal>
      )}
    </div>
  );
}

function DienstZeile({ dienst }: { dienst: WerkstattDienst | null }) {
  if (!dienst || !dienst.aktuell) {
    return (
      <p className="vp-alert vp-alert-warn" data-testid="ws-dienst-veraltet">
        Der Werkstatt-Dienst meldet sich nicht
        {dienst?.alterSekunden != null ? ` (letzte Meldung vor ${Math.round(dienst.alterSekunden / 60)} Minuten)` : ' (noch keine Meldung)'}.
        Was er zuletzt sah, steht hier nicht, denn es wäre veraltet.
      </p>
    );
  }
  return (
    <p className="vp-muted vp-ws-dienstzeile" data-testid="ws-dienst">
      Werkstatt-Dienst meldet sich · vor {dienst.alterSekunden ?? 0} s{dienst.ansicht?.anschluss ? ` · am Anschluss: ${dienst.ansicht.anschluss}` : ''}
    </p>
  );
}

function FreigabeKarte({
  freigabe,
  freigaben,
  eingerichtet,
  onFreigeben,
  onBeenden,
}: {
  freigabe: WerkstattFreigabe | null;
  freigaben: WerkstattFreigabe[];
  eingerichtet: number | null;
  onFreigeben: () => void;
  onBeenden: () => void;
}) {
  const letzte = freigaben.find((f) => f.zustand !== 'laufend') ?? null;
  return (
    <Card padding="md" radius="lg" className="vp-ws-karte" data-testid="ws-freigabe">
      <div className="vp-ws-karte-zeile">
        <div>
          <strong>{freigabe ? 'Werkstatt freigegeben · Mango' : 'Werkstatt nicht freigegeben'}</strong>
          <p className="vp-muted" style={{ margin: '2px 0 0' }}>
            {freigabe
              ? `${eingerichtet ?? 0} eingerichtet · ${freigabeZeile(freigabe)} · ${freigabe.kennung}`
              : letzte
                ? `Zuletzt ${letzte.kennung}: ${letzte.grund ?? letzte.zustand}`
                : 'Ohne Freigabe richtet der Dienst keine Box ein.'}
          </p>
        </div>
        {freigabe ? (
          <Button variant="outline" size="sm" onClick={onBeenden} data-testid="ws-freigabe-beenden">Freigabe beenden</Button>
        ) : (
          <Button size="sm" onClick={onFreigeben} data-testid="ws-freigeben">Werkstatt freigeben</Button>
        )}
      </div>
    </Card>
  );
}

function BrueckeKarte({ dienst }: { dienst: WerkstattDienst | null }) {
  const w = dienst?.aktuell ? dienst.ansicht?.werkbank ?? null : null;
  const kabel = w?.status?.werkstatt?.kabel ?? null;
  return (
    <Card padding="md" radius="lg" className="vp-ws-karte" data-testid="ws-bruecke">
      <div className="vp-ws-karte-zeile">
        <div>
          <strong>Werkbank-Brücke</strong>
          <p className="vp-muted" style={{ margin: '2px 0 0' }}>
            {w ? `${w.adresse} · Fassung ${w.status?.fassung ?? w.fassung_soll}` : 'kein aktueller Stand vom Dienst'}
          </p>
        </div>
        {w &&
          (w.bereit ? (
            <Badge variant="ok">{kabel ? 'bereit · Kabel am Werkstatt-Anschluss' : 'bereit · kein Kabel'}</Badge>
          ) : (
            <Badge variant="warn" title={w.grund}>nicht bereit</Badge>
          ))}
      </div>
      {w && !w.bereit && w.grund && <p className="vp-muted" style={{ margin: '8px 0 0' }}>{w.grund}</p>}
    </Card>
  );
}

function BoxTabelle({ zeilen, auswahl, onWaehle }: { zeilen: UebersichtZeile[]; auswahl: string | null; onWaehle: (ref: string) => void }) {
  if (zeilen.length === 0) {
    return <p className="vp-muted" data-testid="ws-leer">Noch keine Box in der Werkstatt. Steckt eine Mango am orangen Kabel, erscheint sie hier.</p>;
  }
  return (
    <div className="vp-ws-tabelle-rahmen vp-table-scroll">
      <table className="vp-table responsive vp-ws-tabelle" data-testid="ws-boxen">
        <thead>
          <tr>
            <th>Box</th>
            <th>Gerät</th>
            <th>Stand</th>
            <th>Seit</th>
          </tr>
        </thead>
        <tbody>
          {zeilen.map((z, i) => {
            const b = STAND_BADGE[z.stand];
            return (
              <tr key={z.box ?? `ohne-${i}`} className={z.box && z.box === auswahl ? 'vp-ws-gewaehlt' : undefined} data-stand={z.stand}>
                <td data-label="Box">
                  {z.box ? (
                    <button type="button" className="vp-ws-link" onClick={() => onWaehle(z.box as string)}>{z.box}</button>
                  ) : (
                    '–'
                  )}
                </td>
                <td data-label="Gerät">{z.geraet}</td>
                <td data-label="Stand">
                  <Badge variant={b.variant}>{b.text}</Badge> {z.text !== b.text && <span className="vp-muted">{z.text}</span>}
                </td>
                {/* Heute nur die Uhrzeit, sonst mit Tag: „05:06“ von gestern sähe sonst aus wie heute. */}
                <td data-label="Seit">{zeitpunkt(z.seit, new Date())}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Die zur Seite gelegten Boxen (E2 A): mit Fall, Lösung, Grund und Zeit, neueste zuerst. */
function ZurSeiteKarte({ liste, onWaehle }: { liste: ZurSeite[]; onWaehle: (ref: string) => void }) {
  return (
    <Card padding="md" radius="lg" className="vp-ws-karte vp-ws-zurseite" data-testid="ws-zur-seite">
      <strong>Zur Seite gelegt</strong>
      {liste.length === 0 ? (
        <p className="vp-muted" style={{ margin: '2px 0 0' }}>Noch keine Box zur Seite gelegt.</p>
      ) : (
        <ul>
          {liste.map((z) => (
            <li key={z.id} data-lauf={z.lauf}>
              <div className="vp-ws-zurseite-kopf">
                {z.box ? (
                  <button type="button" className="vp-wsb-leise" onClick={() => onWaehle(z.box!)}>{z.box}</button>
                ) : (
                  <span>Mango ohne Referenz</span>
                )}
                <span className="vp-muted">{new Date(z.gelegtAm).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <strong>{z.loesungTitel ?? 'Ohne Lösung des Dienstes'}</strong>
              {/* Klartext vorn (Schritt mit seinem Namen), die Rohwörter des Dienstes aufklappbar für die Technik. */}
              {z.schritt && <small>Beim Schritt „{schrittTitel(z.schritt)}“</small>}
              {(z.fall || z.grund) && (
                <details className="vp-ws-technik">
                  <summary>Für die Technik</summary>
                  <small>
                    {z.fall && <code>{z.fall}</code>}
                    {z.fall && z.grund && ' · '}
                    {z.grund}
                  </small>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
