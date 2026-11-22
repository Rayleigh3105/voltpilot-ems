/**
 * Die Werkstatt (Entscheid WI-8 A, nur platform-admin nach WI-10 B): Die
 * Arbeit an der Box macht der Werkstatt-Dienst. Diese Seite zeigt, was er
 * tut: an der Werkbank die geführten Bildschirme (`WerkstattBank`,
 * `#/werkstatt?werkbank=1`), am Rechner die Übersicht (D1) mit dem Stand der
 * Werkstatt (sie nimmt immer die neueste Fassung; „Werkstatt anhalten“ und
 * „Werkstatt fortsetzen“, Details für Technik), der Werkbank-Brücke, den Boxen
 * und den Belegen der gewählten Box (`?box=<referenz>`, auch das Ziel des
 * Direktlinks). Handschritte, Passwort-Generator und Probe-Knöpfe gibt es
 * nicht mehr: Das macht der Dienst, jeden Schritt mit Beleg.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Input } from '../../../designsystem/components/forms/Input';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { ApiError } from '../../api';
import { adminApi } from '../../admin/adminApi';
import { ErrorState, TableSkeleton } from '../../components/States';
import { istWerkstattWerkbank, parseFernwartungBox, werkstattHash, werkstattWerkbankHash } from '../../nav';
import { replaceCurrentNavigation } from '../../navigationBlocker';
import { useFreshnessPoll } from '../../useFreshnessPoll';
import { VERSAND_SATZ, type WerkstattBox } from '../../werkstatt';
import {
  freigabeListenZeile,
  kurzSha,
  liesDienst,
  uebersicht,
  werkstattStand,
  type UebersichtZeile,
  type WerkstattDienst,
  type WerkstattFreigabe,
  type WerkstattFreigabePfc200,
  type WerkstattLauf,
  type WerkstattRegel,
  type WerkstattStand,
  type ZurSeite,
} from '../../werkstattBank';
import { EDGE_INDUSTRIE, istPfc200, pfc200Zeile, type WerkstattRegelPfc200 } from '../../werkstattPfc200';
import { zeitpunkt } from '../../adminFernwartung';
import { AdminPageHead } from './AdminPageHead';
import { WerkstattBank } from './WerkstattBank';
import { neueresRelease, schrittTitel } from '../../werkstattLauf';
import type { EdgeUpdatesRelease } from '../../adminEdgeUpdates';
import { STAND_BADGE } from './WerkstattTeile';
import { WerkstattBoxSeite } from './WerkstattBoxSeite';
import './Fernwartung.css';
import './Werkstatt.css';

/** So oft fragt die Seite den Stand des Dienstes nach (er meldet etwa alle 10 s). */
const TAKT_MS = 5_000;

function fehlerText(e: unknown, sonst: string): string {
  return e instanceof ApiError ? e.message : sonst;
}

/**
 * Hat diese Werkstatt mit dem PFC200 zu tun? Der Dienst richtet welche ein (er meldet eine Freigabe dafür), im
 * Register steht einer, oder ein Lauf lief an einem. Sonst fragt die Seite seinen Stand gar nicht erst ab, und eine
 * Werkstatt nur mit Mangos sieht nichts davon.
 */
function pfc200ImSpiel(dienst: WerkstattDienst | null, boxen: readonly WerkstattBox[] | null): boolean {
  return (
    dienst?.ansicht?.freigabe_pfc200 != null ||
    (boxen ?? []).some((b) => b.boxArt === 'edge-industrie') ||
    (dienst?.laeufe ?? []).some((l) => istPfc200(l.stand?.box_art ?? l.boxArt))
  );
}

export function WerkstattPage({ tabs }: { tabs?: ReactNode } = {}) {
  const [boxen, setBoxen] = useState<WerkstattBox[] | null>(null);
  const [dienst, setDienst] = useState<WerkstattDienst | null>(null);
  const [freigaben, setFreigaben] = useState<WerkstattFreigabe[] | null>(null);
  const [regel, setRegel] = useState<WerkstattRegel | null>(null);
  const [freigabenPfc, setFreigabenPfc] = useState<WerkstattFreigabePfc200[]>([]);
  const [regelPfc, setRegelPfc] = useState<WerkstattRegelPfc200 | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [aktionsFehler, setAktionsFehler] = useState<string | null>(null);
  const [werkbank, setWerkbank] = useState(() => istWerkstattWerkbank(window.location.hash));
  const [auswahl, setAuswahl] = useState<string | null>(() => parseFernwartungBox(window.location.hash));
  const [anhalten, setAnhalten] = useState(false);
  const [grund, setGrund] = useState('');
  const [busy, setBusy] = useState(false);
  const [jetzt, setJetzt] = useState(() => new Date());

  async function laden() {
    const [b, d, f, r] = await Promise.allSettled([
      adminApi.werkstattBoxen(),
      adminApi.werkstattDienst(),
      adminApi.werkstattFreigaben(),
      adminApi.werkstattRegel(),
    ]);
    if (b.status === 'fulfilled') setBoxen(b.value);
    if (d.status === 'fulfilled') setDienst(liesDienst(d.value));
    if (f.status === 'fulfilled') setFreigaben(f.value);
    if (r.status === 'fulfilled') setRegel(r.value);
    const erster = [b, d, f, r].find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined;
    setLadeFehler(erster ? fehlerText(erster.reason, 'Die Werkstatt ließ sich nicht laden. Bitte erneut versuchen.') : null);
    setJetzt(new Date());
    // Der PFC200 hat seine eigene Zeile der Regel und eigene Freigaben. Scheitert das, bleibt der letzte Stand:
    // Die Seite der Mango hängt nicht daran.
    if (pfc200ImSpiel(d.status === 'fulfilled' ? liesDienst(d.value) : dienst, b.status === 'fulfilled' ? b.value : boxen)) {
      const [pf, pr] = await Promise.allSettled([adminApi.werkstattFreigabenPfc200(), adminApi.werkstattRegelPfc200()]);
      if (pf.status === 'fulfilled') setFreigabenPfc(pf.value);
      if (pr.status === 'fulfilled') setRegelPfc(pr.value);
    }
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

  const stand = useMemo(() => (regel ? werkstattStand(regel, freigaben ?? [], jetzt) : null), [regel, freigaben, jetzt]);
  // Ein neueres signiertes Edge-Light-Release als die Freigabe des Laufs: nur ein Hinweis an der Werkbank, einmal gefragt.
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
    // Die Fassung des Laufs an der Werkbank: die seiner Freigabe, sonst die, die gerade gilt.
    const kennung = dienst?.ansicht?.lauf?.freigabe;
    const zeile = kennung ? freigaben?.find((x) => x.kennung === kennung) : undefined;
    const fassung = zeile?.edgeLight.fassung ?? dienst?.ansicht?.freigabe.freigabe?.edge_light.fassung;
    return fassung ? neueresRelease(fassung, releases) : null;
  }, [dienst, freigaben, releases]);
  const zeilen = useMemo(() => uebersicht(boxen ?? [], dienst?.laeufe ?? []), [boxen, dienst]);
  const gewaehlt = auswahl ? zeilen.find((z) => z.box === auswahl) ?? null : null;
  const geladen = boxen && dienst && freigaben && regel;

  function waehle(ref: string | null) {
    setAuswahl(ref);
    replaceCurrentNavigation(werkstattHash(ref));
  }

  async function schalten(art: 'anhalten' | 'fortsetzen') {
    setBusy(true);
    setAktionsFehler(null);
    try {
      setRegel(art === 'anhalten' ? await adminApi.werkstattAnhalten(grund.trim() || null) : await adminApi.werkstattFortsetzen());
      setAnhalten(false);
      setGrund('');
      await laden();
    } catch (e) {
      setAktionsFehler(fehlerText(e, art === 'anhalten' ? 'Die Werkstatt ließ sich nicht anhalten.' : 'Die Werkstatt ließ sich nicht fortsetzen.'));
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
        description="Boxen vor dem Versand: Der Werkstatt-Dienst richtet sie mit der neuesten Fassung ein und prüft sie, jeden Schritt mit Beleg. Hier siehst du, was er tut."
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
          stand={stand}
          freigaben={freigaben}
          freigabenPfc200={freigabenPfc}
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
              {stand && (
                <WerkstattStandKarte
                  stand={stand}
                  regel={regel}
                  freigaben={freigaben}
                  pfc200={regelPfc}
                  freigabenPfc200={freigabenPfc}
                  jetzt={jetzt}
                  busy={busy}
                  onAnhalten={() => setAnhalten(true)}
                  onFortsetzen={() => void schalten('fortsetzen')}
                />
              )}
              <BrueckeKarte dienst={dienst} />
              <BoxTabelle zeilen={zeilen} auswahl={auswahl} onWaehle={waehle} />
              {dienst?.zurSeite && <ZurSeiteKarte liste={dienst.zurSeite} laeufe={dienst.laeufe} onWaehle={waehle} />}
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
              freigabenPfc200={freigabenPfc}
              jetzt={jetzt}
              gehaeuseAuftraege={dienst?.ansicht?.gehaeuse}
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

      {anhalten && (
        <Modal
          open
          title="Werkstatt anhalten"
          onClose={() => { if (!busy) setAnhalten(false); }}
          footer={
            <>
              <Button variant="outline" onClick={() => setAnhalten(false)} disabled={busy}>Abbrechen</Button>
              <Button onClick={() => void schalten('anhalten')} disabled={busy} data-testid="ws-anhalten-bestaetigen">
                {busy ? 'Wird angehalten …' : 'Werkstatt anhalten'}
              </Button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            Ab jetzt beginnt der Werkstatt-Dienst keinen neuen Lauf, und keine Box wird angemeldet. Ein Lauf, der gerade
            läuft, hält beim Anmelden an. Fortsetzen kannst du jederzeit; beides steht mit deinem Namen im Protokoll.
          </p>
          <Input
            label="Grund (wenn du magst)"
            value={grund}
            maxLength={500}
            onChange={(e) => setGrund(e.target.value)}
            data-testid="ws-anhalten-grund"
          />
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

function WerkstattStandKarte({
  stand,
  regel,
  freigaben,
  pfc200,
  freigabenPfc200,
  jetzt,
  busy,
  onAnhalten,
  onFortsetzen,
}: {
  stand: WerkstattStand;
  regel: WerkstattRegel | null;
  freigaben: readonly WerkstattFreigabe[];
  /** Der Stand für den PFC200; null, solange die Werkstatt keinen einrichtet oder die API ihn nicht kennt. */
  pfc200: WerkstattRegelPfc200 | null;
  freigabenPfc200: readonly WerkstattFreigabePfc200[];
  jetzt: Date;
  busy: boolean;
  onAnhalten: () => void;
  onFortsetzen: () => void;
}) {
  const e = regel?.edgeLight ?? null;
  const pfcZeile = pfc200 ? pfc200Zeile(pfc200) : null;
  const pe = pfc200?.edgeLight ?? null;
  return (
    <Card padding="md" radius="lg" className="vp-ws-karte" data-testid="ws-werkstatt" data-zustand={stand.zustand}>
      <div className="vp-ws-karte-zeile">
        <div>
          <div className="vp-ws-stand-kopf">
            <strong>{stand.titel}</strong>
            <Badge variant={stand.badge.variant}>{stand.badge.text}</Badge>
          </div>
          <p className="vp-muted" style={{ margin: '2px 0 0' }} data-testid="ws-werkstatt-zeile">{stand.zeile}</p>
          {/* Der PFC200 hat seine eigene Fassung. Wartet die Werkstatt für ihn, steht hier, worauf; die Mango läuft daneben weiter. */}
          {pfcZeile && (
            <p className="vp-muted" style={{ margin: '2px 0 0' }} data-testid="ws-werkstatt-pfc200" data-ton={pfcZeile.ton}>
              {pfcZeile.ton === 'warn' && <Badge variant="warn">wartet</Badge>} {pfcZeile.text}
            </p>
          )}
        </div>
        {stand.knopf === 'fortsetzen' ? (
          <Button size="sm" onClick={onFortsetzen} disabled={busy} data-testid="ws-fortsetzen">
            {busy ? 'Wird fortgesetzt …' : 'Werkstatt fortsetzen'}
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onAnhalten} disabled={busy} data-testid="ws-anhalten">
            Werkstatt anhalten
          </Button>
        )}
      </div>
      {regel && (
        <details className="vp-ws-technik vp-ws-stand-technik" data-testid="ws-werkstatt-technik">
          <summary>Details für Technik</summary>
          <dl className="vp-ws-stand-liste">
            <dt>Edge Light</dt>
            <dd>
              {e ? (
                <>
                  {e.fassung} (Release {regel.releaseSeq}) · Programm <code>{kurzSha(e.programmSha256)}</code> · Skripte{' '}
                  <code>{kurzSha(e.skripteSha256)}</code>
                  <small>aus dem signierten Manifest; Quelle {e.quelle}</small>
                </>
              ) : (
                <>
                  {regel.neueste ? `neueste: ${regel.neueste} (passt nicht)` : 'keine signierte Fassung'}
                  {regel.grund && <small>{regel.grund}</small>}
                </>
              )}
            </dd>
            <dt>OpenWrt</dt>
            <dd>
              {regel.openwrt.fassung} · <code>{kurzSha(regel.openwrt.sha256)}</code>
              <small>fest im Code, <code>{regel.openwrt.datei}</code></small>
            </dd>
            <dt>Freigabe</dt>
            <dd>{regel.freigabe ? `${regel.freigabe}${regel.vonHand ? ' (von Hand, bis sie abläuft)' : ' (Regel)'}` : '–'}</dd>
            {pfc200 && (
              <>
                <dt>{EDGE_INDUSTRIE} (PFC200)</dt>
                <dd data-testid="ws-werkstatt-pfc200-technik">
                  {pe ? (
                    <>
                      {pe.fassung} (Release {pfc200.releaseSeq}) · Programm <code>{kurzSha(pe.programmSha256)}</code> · Skripte{' '}
                      <code>{kurzSha(pe.skripteSha256)}</code> · Tunnel-Programm <code>{kurzSha(pe.wartungSha256)}</code>
                      <small>
                        aus dem signierten Manifest; Quelle {pe.quelle}. Freigabe {pfc200.freigabe ?? '–'} (Regel). Die Firmware
                        des Geräts fasst die Werkstatt nicht an.
                      </small>
                    </>
                  ) : (
                    <>
                      {pfc200.neueste ? `neueste: ${pfc200.neueste} (passt nicht)` : 'keine signierte Fassung'}
                      {pfc200.grund && <small>{pfc200.grund}</small>}
                    </>
                  )}
                </dd>
              </>
            )}
            <dt>Heute</dt>
            <dd>{regel.heute} von {regel.tagesgrenze} Boxen (Tagesgrenze)</dd>
          </dl>
          {regel.verlauf.length > 0 && (
            <>
              <p className="vp-ws-stand-h">Angehalten und fortgesetzt</p>
              <ul className="vp-ws-stand-verlauf" data-testid="ws-werkstatt-verlauf">
                {regel.verlauf.map((b) => (
                  <li key={`${b.am}-${b.angehalten}`}>
                    {b.angehalten ? 'angehalten' : 'fortgesetzt'} · {zeitpunkt(b.am, jetzt)} · {b.von}
                    {b.grund ? ` · „${b.grund}“` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
          {freigaben.length > 0 && (
            <>
              <p className="vp-ws-stand-h">Freigaben (Beleg, neueste zuerst)</p>
              <ul className="vp-ws-stand-verlauf" data-testid="ws-freigaben">
                {freigaben.slice(0, 12).map((f) => (
                  <li key={f.id}>
                    <strong>{f.kennung}</strong> · {freigabeListenZeile(f)}
                    {f.zustand !== 'laufend' ? ` · ${f.zustand}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
          {freigabenPfc200.length > 0 && (
            <>
              <p className="vp-ws-stand-h">Freigaben für den PFC200 (Beleg, neueste zuerst)</p>
              <ul className="vp-ws-stand-verlauf" data-testid="ws-freigaben-pfc200">
                {freigabenPfc200.slice(0, 12).map((f) => (
                  <li key={f.id}>
                    <strong>{f.kennung}</strong> · Regel · {EDGE_INDUSTRIE} {f.edgeLight.fassung.replace(/^edge-industrie-/, '')}
                    {f.edgeReleaseSeq != null ? ` · Release ${f.edgeReleaseSeq}` : ''}
                    {f.zustand !== 'laufend' ? ` · ${f.zustand}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      )}
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
      {/* Am Telefon (`vp-zeilen`): Box und Zeit oben, darunter Gerät und Stand - statt vier Etikett-Zeilen je Box. */}
      <table className="vp-table responsive vp-zeilen vp-ws-tabelle" data-testid="ws-boxen">
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
                <td data-label="Box" data-zeile="haupt">
                  {z.box ? (
                    <button type="button" className="vp-ws-link" onClick={() => onWaehle(z.box as string)}>{z.box}</button>
                  ) : (
                    '–'
                  )}
                </td>
                <td data-label="Gerät" data-zeile="neben">{z.geraet}</td>
                <td data-label="Stand" data-zeile="neben">
                  <Badge variant={b.variant}>{b.text}</Badge> {z.text !== b.text && <span className="vp-muted">{z.text}</span>}
                </td>
                {/* Heute nur die Uhrzeit, sonst mit Tag: „05:06“ von gestern sähe sonst aus wie heute. */}
                <td data-label="Seit" data-zeile="marke">{zeitpunkt(z.seit, new Date())}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Die zur Seite gelegten Boxen (E2 A): mit Fall, Lösung, Grund und Zeit, neueste zuerst. */
function ZurSeiteKarte({ liste, laeufe, onWaehle }: { liste: ZurSeite[]; laeufe: readonly WerkstattLauf[]; onWaehle: (ref: string) => void }) {
  // Das Gerät sagt der Lauf, solange die Ansicht ihn noch hält; sonst gelten die Worte der Mango wie bisher.
  const geraet = (z: ZurSeite) => {
    const l = laeufe.find((x) => x.kennung === z.lauf);
    return l ? l.stand?.box_art ?? l.boxArt : null;
  };
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
                  <span>{istPfc200(geraet(z)) ? 'PFC200 ohne Referenz' : 'Mango ohne Referenz'}</span>
                )}
                <span className="vp-muted">{new Date(z.gelegtAm).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <strong>{z.loesungTitel ?? 'Ohne Lösung des Dienstes'}</strong>
              {/* Klartext vorn (Schritt mit seinem Namen), die Rohwörter des Dienstes aufklappbar für die Technik. */}
              {z.schritt && <small>Beim Schritt „{schrittTitel(z.schritt, geraet(z))}“</small>}
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
