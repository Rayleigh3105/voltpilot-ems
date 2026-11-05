/**
 * Die Einrichtungs-Detailseite einer Box in der Werkstatt (`#/werkstatt?box=<referenz>`,
 * auch das Ziel des Direktlinks vom Gehäuse): alles, was die Einrichtung für
 * diese Box festhält, an einem Ort. Anzeige und Download; am Ablauf
 * der Einrichtung ändert sie nichts. Einzige Aktion: eine Box löschen, die
 * weder abgenommen noch gekoppelt ist (etwa einen Fehlversuch), samt dem, was
 * nur ihr gehört (Tunnel-Schlüssel, Codes), mit Rückfrage auf der Seite, die
 * Referenz und Mitgehendes nennt. Nur für VoltPilot-Admins (wie die ganze
 * Werkstatt); das Root-Passwort steht, wie an der Abnahme, nur verschlüsselt da.
 */
import { Fragment, useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { adminApi } from '../../admin/adminApi';
import { boxVerbindung, zeitpunkt, type FernwartungBox, type FernwartungUebersicht } from '../../adminFernwartung';
import { ApiError } from '../../api';
import { Befehl } from '../../components/FernwartungSsh';
import { fernwartungHash } from '../../nav';
import { loeschbar, loeschtTunnelSchluessel, VERSAND_SATZ, type WerkstattBox } from '../../werkstatt';
import type { UebersichtZeile, WerkstattFreigabe } from '../../werkstattBank';
import {
  bindung,
  einrichtung,
  freigabeDerBox,
  fruehereAbnahmen,
  GEHAEUSE_DATEIEN,
  GEHAEUSE_OHNE_KENNUNG,
  kundenStand,
  type EinrichtungZeile,
} from '../../werkstattEinrichtung';
import { PhasenListe } from './WerkstattBank';
import { schrittTitel } from '../../werkstattLauf';
import { AbnahmeAnzeige, BeschriftungKarte, DirektlinkQr, STAND_BADGE } from './WerkstattTeile';

type Bindung = { art: 'laedt' } | { art: 'keine' } | { art: 'fehler'; text: string } | { art: 'da'; box: FernwartungBox; uebersicht: FernwartungUebersicht | null };

function Zeilen({ zeilen, leer = '–' }: { zeilen: EinrichtungZeile[]; leer?: string }) {
  return (
    <dl className="vp-ws-protokoll">
      {zeilen.map((z) => (
        <Fragment key={z.id}>
          <dt>{z.titel}</dt>
          <dd className={z.id === 'host' ? 'vp-fw-fingerabdruck' : undefined} data-testid={`ws-zeile-${z.id}`}>{z.wert ?? leer}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function WerkstattBoxSeite({
  zeile,
  boxen,
  freigaben,
  jetzt,
  onZurueck,
  onGeloescht,
}: {
  zeile: UebersichtZeile;
  boxen: readonly WerkstattBox[];
  freigaben: readonly WerkstattFreigabe[];
  jetzt: Date;
  onZurueck: () => void;
  /** Nach dem Löschen: zurück zur Liste ohne diese Box. */
  onGeloescht?: (ref: string) => void;
}) {
  const ref = zeile.box as string;
  const box = boxen.find((b) => b.edgeRef === ref) ?? null;
  const mango = zeile.geraet === 'Mango';
  const [verb, setVerb] = useState<Bindung>({ art: 'laedt' });
  const [loeschen, setLoeschen] = useState<'aus' | 'fragen' | 'laeuft'>('aus');
  const [loeschFehler, setLoeschFehler] = useState<string | null>(null);

  async function wirklichLoeschen() {
    setLoeschen('laeuft');
    setLoeschFehler(null);
    try {
      await adminApi.werkstattBoxLoeschen(ref);
      onGeloescht?.(ref);
    } catch (e) {
      setLoeschen('fragen');
      setLoeschFehler(e instanceof ApiError ? e.message : 'Die Box ließ sich nicht löschen.');
    }
  }

  useEffect(() => {
    let aktuell = true;
    setVerb({ art: 'laedt' });
    (async () => {
      try {
        const [fw, u] = await Promise.allSettled([adminApi.fernwartungBox(ref), adminApi.fernwartung()]);
        if (!aktuell) return;
        if (fw.status === 'fulfilled') {
          setVerb({ art: 'da', box: fw.value, uebersicht: u.status === 'fulfilled' ? u.value : null });
        } else if (fw.reason instanceof ApiError && fw.reason.status === 404) {
          setVerb({ art: 'keine' });
        } else {
          setVerb({ art: 'fehler', text: fw.reason instanceof ApiError ? fw.reason.message : 'Die Fernwartung dieser Box ließ sich nicht laden.' });
        }
      } catch {
        if (aktuell) setVerb({ art: 'fehler', text: 'Die Fernwartung dieser Box ließ sich nicht laden.' });
      }
    })();
    return () => {
      aktuell = false;
    };
  }, [ref]);

  const stand = STAND_BADGE[zeile.stand];
  const abnahme = zeile.abnahme;
  const freigabe = box ? freigabeDerBox(abnahme, zeile.lauf?.freigabe, freigaben) : null;
  const verbindung = verb.art === 'da' ? boxVerbindung(verb.box, verb.uebersicht, jetzt) : null;
  const kunde = kundenStand(box, ref);

  return (
    <div className="vp-ws-detail vp-ws-seite" data-testid="ws-detail">
      <div className="vp-ws-seitenkopf">
        <Button variant="outline" size="sm" onClick={onZurueck} data-testid="ws-zurueck">
          ‹ Alle Boxen
        </Button>
        <div className="vp-ws-seitentitel">
          <h2 style={{ margin: 0 }}>{ref}</h2>
          <p className="vp-muted" style={{ margin: '2px 0 0' }}>
            {zeile.geraet}
            {zeile.lauf?.freigabe ? ` · Freigabe ${zeile.lauf.freigabe}` : ''}
          </p>
        </div>
        <div className="vp-ws-seitenstand">
          <Badge variant={stand.variant} data-testid="ws-stand">{stand.text}</Badge>
          <Badge variant="warn" title={VERSAND_SATZ}>Nicht versenden: Stufe 1</Badge>
        </div>
      </div>

      {zeile.geraet === 'Docker-Box' && (
        <p className="vp-alert vp-alert-warn">Für die Docker-Box gibt es noch keinen Ablauf im Dienst und keine Abnahme (kommt mit der nächsten Stufe).</p>
      )}
      {zeile.lauf?.grund && zeile.stand === 'problem' && (
        <div className="vp-alert vp-alert-warn" data-testid="ws-grund">
          {/* Erst der Schritt in Worten, dann der Grund des Dienstes als Beleg für die Technik. */}
          <strong>{zeile.lauf.schritt ? `Stehen geblieben bei „${schrittTitel(zeile.lauf.schritt)}“` : 'Der Lauf ist stehen geblieben'}</strong>
          <div className="vp-ws-technik-grund">Grund des Dienstes: <code>{zeile.lauf.grund}</code></div>
        </div>
      )}

      {kunde.art === 'eingerichtet' && (
        <p className="vp-alert vp-alert-ok" style={{ margin: 0 }} data-testid="ws-kunde">
          Vom Kunden eingerichtet: {kunde.mandant}
          {kunde.anlage ? `, Anlage ${kunde.anlage}` : ', ohne Anlage'} · seit {zeitpunkt(kunde.seit, jetzt)}
        </p>
      )}
      {kunde.art === 'offen' && (
        <div className="vp-alert vp-alert-warn vp-ws-kunde-offen" data-testid="ws-kunde">
          <DirektlinkQr edgeRef={ref} testId="ws-kunde-qr" />
          <div className="vp-ws-spalte">
            <strong>Noch nicht vom Kunden eingerichtet.</strong>
            <span>
              Der Kunde richtet die Box über diesen Link ein (derselbe wie der QR-Code auf dem Gehäuse); als Admin
              öffnest du ihn in einem privaten Fenster.
            </span>
            <div data-testid="ws-kunde-link">
              <Befehl text={kunde.link} was="Link" knopf="Link kopieren" />
            </div>
          </div>
        </div>
      )}
      {kunde.art === 'unbekannt' && (
        <p className="vp-muted" style={{ margin: 0 }} data-testid="ws-kunde">
          Ob ein Kunde die Box schon eingerichtet hat, ist nicht bekannt.
        </p>
      )}

      <div className="vp-ws-seitenraster">
        {mango && (
          <Card padding="md" radius="lg" className="vp-ws-karte vp-ws-breit" data-testid="ws-gehaeuse">
            <h3 className="vp-ws-kartenkopf">Gehäuse-Druckdatei (3MF)</h3>
            <ul className="vp-ws-dateien">
              {GEHAEUSE_DATEIEN.map((d) => (
                <li key={d.name} className="vp-ws-datei" data-testid={`ws-gehaeuse-${d.name}`}>
                  <a className="vp-btn vp-btn--outline vp-btn--sm" href={d.url} download={d.name} type="model/3mf">
                    {d.name} laden
                  </a>
                </li>
              ))}
            </ul>
            <p className="vp-muted vp-ws-fuss" data-testid="ws-gehaeuse-hinweis">{GEHAEUSE_OHNE_KENNUNG}</p>
          </Card>
        )}

        <Card padding="md" radius="lg" className="vp-ws-karte" data-testid="ws-einrichtung">
          <h3 className="vp-ws-kartenkopf">Einrichtung</h3>
          {box ? (
            <>
              <Zeilen zeilen={einrichtung(box, freigabe)} />
              <p className="vp-muted vp-ws-fuss">
                Im Register seit {zeitpunkt(box.angelegtAm, jetzt)} ({box.angelegtVon}), zuletzt geändert {zeitpunkt(box.geaendertAm, jetzt)}.
                {!abnahme && ' Ohne Abnahme gibt es keinen geprüften Stand: Fassung, Tunnel-Adresse und Host-Schlüssel fehlen.'}
              </p>
              {box.notiz && <p style={{ margin: 0 }}>Notiz: {box.notiz}</p>}
            </>
          ) : (
            <p className="vp-muted" style={{ margin: 0 }}>Diese Box steht nicht im Register der Werkstatt, nur ein Lauf des Dienstes kennt sie.</p>
          )}
        </Card>

        <div className="vp-ws-stapel">
          <Card padding="md" radius="lg" className="vp-ws-karte" data-testid="ws-bindung">
            <h3 className="vp-ws-kartenkopf">Bindung und Fernwartung</h3>
            {verb.art === 'laedt' && <p className="vp-muted" style={{ margin: 0 }}>Lädt …</p>}
            {verb.art === 'fehler' && <p className="vp-alert vp-alert-warn" style={{ margin: 0 }}>{verb.text}</p>}
            {verb.art === 'keine' && (
              <>
                <Zeilen zeilen={bindung(null)} />
                <p className="vp-muted vp-ws-fuss">Für diese Box ist noch kein Tunnel-Schlüssel hinterlegt; sie ist keinem Kunden gekoppelt.</p>
              </>
            )}
            {verb.art === 'da' && (
              <>
                <Zeilen zeilen={bindung(verb.box)} />
                {verbindung && (
                  <p className="vp-ws-fuss" data-testid="ws-verbindung">
                    <Badge variant={verbindung.ton === 'ok' ? 'ok' : verbindung.ton === 'warn' ? 'warn' : 'off'}>{verbindung.titel}</Badge>{' '}
                    <span className="vp-muted">{verbindung.text}</span>
                  </p>
                )}
              </>
            )}
            <p style={{ margin: 0 }}>
              <a href={fernwartungHash(ref)}>Fernwartung dieser Box</a>
            </p>
          </Card>

          <Card padding="md" radius="lg" className="vp-ws-karte" data-testid="ws-ablauf">
            <h3 className="vp-ws-kartenkopf">Ablauf der Einrichtung</h3>
            {zeile.lauf ? (
              <PhasenListe lauf={zeile.lauf.stand} />
            ) : (
              <p className="vp-muted" style={{ margin: 0 }}>Kein Lauf des Werkstatt-Dienstes bekannt (die Ansicht hält nur die letzten Läufe).</p>
            )}
          </Card>
        </div>

        <Card padding="md" radius="lg" className="vp-ws-karte vp-ws-breit" data-testid="ws-abnahme">
          <h3 className="vp-ws-kartenkopf">Abnahme und Belege</h3>
          {abnahme ? (
            <>
              <AbnahmeAnzeige a={abnahme} jetzt={jetzt} />
              {box && fruehereAbnahmen(box).length > 0 && (
                <details className="vp-ws-aufklapp" data-testid="ws-fruehere">
                  <summary>Frühere Abnahmen ({fruehereAbnahmen(box).length})</summary>
                  <ul className="vp-ws-belege">
                    {fruehereAbnahmen(box).map((a) => (
                      <li key={a.id}>
                        <span className="vp-ws-pruefung">{zeitpunkt(a.erfasstAm, jetzt)} · {a.quelle === 'dienst' ? 'vom Dienst' : `von ${a.erfasstVon} (von Hand)`}</span>
                        <span>{a.fassung}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          ) : (
            <p className="vp-muted" style={{ margin: 0 }}>Noch keine Abnahme.</p>
          )}
        </Card>

        {mango && (
          <Card padding="md" radius="lg" className="vp-ws-karte" data-testid="ws-karte-beschriftung">
            <h3 className="vp-ws-kartenkopf">Beschriftung des Gehäuses</h3>
            <BeschriftungKarte edgeRef={ref} />
          </Card>
        )}
      </div>

      {onGeloescht && box && loeschbar(box) && (
        <Card padding="md" radius="lg" className="vp-ws-karte" data-testid="ws-loeschen">
          <h3 className="vp-ws-kartenkopf">Löschen</h3>
          {loeschen === 'aus' ? (
            <>
              <p className="vp-muted" style={{ margin: 0 }}>
                Diese Box ist weder abgenommen noch gekoppelt, etwa ein Fehlversuch. Sie lässt sich löschen.
              </p>
              <p style={{ margin: 0 }}>
                <Button variant="outline" size="sm" onClick={() => setLoeschen('fragen')} data-testid="ws-loeschen-start">
                  Löschen
                </Button>
              </p>
            </>
          ) : (
            <div role="group" aria-label={`${ref} löschen`} data-testid="ws-loeschen-frage">
              <p style={{ marginTop: 0 }}>
                <strong>{ref}</strong> wirklich löschen?
              </p>
              {(box.loeschtMit ?? []).length > 0 ? (
                <>
                  <p style={{ margin: 0 }}>Mit ihr geht:</p>
                  <ul data-testid="ws-loeschen-mit" style={{ marginTop: 4 }}>
                    {(box.loeschtMit ?? []).map((w) => <li key={w}>{w}</li>)}
                  </ul>
                </>
              ) : (
                <p style={{ margin: 0 }} data-testid="ws-loeschen-mit">Mit ihr geht nur der Eintrag im Register.</p>
              )}
              <p className="vp-muted">
                Läufe und Einlösungen bleiben als Verlauf; die Werkstatt hält fest, wer die Box wann gelöscht hat.
                {zeile.stand === 'laeuft' && ' Der Werkstatt-Dienst arbeitet gerade mit ihr; sein Lauf hält dann mit einem Fall an.'}
                {loeschtTunnelSchluessel(box) && ' Ihr Tunnel-Schlüssel wird nie wieder vergeben: Soll dieselbe Box noch einmal eingerichtet werden, erst zurücksetzen.'}
              </p>
              {loeschFehler && <p className="vp-alert vp-alert-err" data-testid="ws-loeschen-fehler">{loeschFehler}</p>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button variant="primary" size="sm" disabled={loeschen === 'laeuft'} onClick={() => void wirklichLoeschen()} data-testid="ws-loeschen-ja">
                  {loeschen === 'laeuft' ? 'Löscht …' : `${ref} löschen`}
                </Button>
                <Button variant="outline" size="sm" disabled={loeschen === 'laeuft'} onClick={() => { setLoeschen('aus'); setLoeschFehler(null); }} data-testid="ws-loeschen-nein">
                  Abbrechen
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <p className="vp-muted" style={{ margin: 0 }}>{VERSAND_SATZ}</p>
    </div>
  );
}
