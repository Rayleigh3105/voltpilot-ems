/**
 * Die Einrichtungs-Detailseite einer Box in der Werkstatt (`#/werkstatt?box=<referenz>`,
 * auch das Ziel des Direktlinks vom Gehäuse): alles, was die Einrichtung für
 * diese Box festhält, an einem Ort. Anzeige und Download; am Ablauf
 * der Einrichtung ändert sie nichts. Einzige Aktion: einen unbenutzten
 * Eintrag (nur im Register, die API meldet ihn unbenutzt) wieder aus dem
 * Register entfernen, mit Rückfrage auf der Seite. Nur für VoltPilot-Admins (wie die ganze
 * Werkstatt); das Root-Passwort steht, wie an der Abnahme, nur verschlüsselt da.
 */
import { Fragment, useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { adminApi } from '../../admin/adminApi';
import { boxVerbindung, zeitpunkt, type FernwartungBox, type FernwartungUebersicht } from '../../adminFernwartung';
import { ApiError } from '../../api';
import { fernwartungHash } from '../../nav';
import { entfernbar, VERSAND_SATZ, type WerkstattBox } from '../../werkstatt';
import type { UebersichtZeile, WerkstattFreigabe } from '../../werkstattBank';
import {
  bindung,
  einrichtung,
  freigabeDerBox,
  fruehereAbnahmen,
  GEHAEUSE_DATEIEN,
  GEHAEUSE_OHNE_KENNUNG,
  type EinrichtungZeile,
} from '../../werkstattEinrichtung';
import { PhasenListe } from './WerkstattBank';
import { AbnahmeAnzeige, BeschriftungKarte, STAND_BADGE } from './WerkstattTeile';

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
  onEntfernt,
}: {
  zeile: UebersichtZeile;
  boxen: readonly WerkstattBox[];
  freigaben: readonly WerkstattFreigabe[];
  jetzt: Date;
  onZurueck: () => void;
  /** Nach dem Entfernen aus dem Register: zurück zur Liste ohne diese Box. */
  onEntfernt?: (ref: string) => void;
}) {
  const ref = zeile.box as string;
  const box = boxen.find((b) => b.edgeRef === ref) ?? null;
  const mango = zeile.geraet === 'Mango';
  const [verb, setVerb] = useState<Bindung>({ art: 'laedt' });
  const [entfernen, setEntfernen] = useState<'aus' | 'fragen' | 'laeuft'>('aus');
  const [entfernFehler, setEntfernFehler] = useState<string | null>(null);

  async function ausDemRegister() {
    setEntfernen('laeuft');
    setEntfernFehler(null);
    try {
      await adminApi.werkstattBoxEntfernen(ref);
      onEntfernt?.(ref);
    } catch (e) {
      setEntfernen('fragen');
      setEntfernFehler(e instanceof ApiError ? e.message : 'Der Eintrag ließ sich nicht entfernen.');
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
        <p className="vp-alert vp-alert-warn" data-testid="ws-grund">{zeile.lauf.grund}</p>
      )}

      <div className="vp-ws-seitenraster">
        {mango && (
          <Card padding="md" radius="lg" className="vp-ws-karte vp-ws-breit" data-testid="ws-gehaeuse">
            <h3 className="vp-ws-kartenkopf">Gehäuse-Druckdatei (3MF)</h3>
            <p className="vp-alert vp-alert-warn" style={{ margin: 0 }} data-testid="ws-gehaeuse-hinweis">{GEHAEUSE_OHNE_KENNUNG}</p>
            <ul className="vp-ws-dateien">
              {GEHAEUSE_DATEIEN.map((d) => (
                <li key={d.name} className="vp-ws-datei" data-testid={`ws-gehaeuse-${d.name}`}>
                  <div className="vp-ws-spalte">
                    <strong>{d.titel}</strong>
                    <span>{d.inhalt}</span>
                    <span className="vp-muted">{d.druckStand}</span>
                  </div>
                  <a className="vp-btn vp-btn--outline vp-btn--sm" href={d.url} download={d.name} type="model/3mf">
                    {d.name} laden
                  </a>
                </li>
              ))}
            </ul>
            <p className="vp-muted vp-ws-fuss">Drucken: Bambu Studio, Filament 1 weiß, 2 schwarz, 3 hellblau.</p>
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

      {onEntfernt && entfernbar(box, zeile.stand) && (
        <Card padding="md" radius="lg" className="vp-ws-karte" data-testid="ws-entfernen">
          <h3 className="vp-ws-kartenkopf">Aus dem Register entfernen</h3>
          {entfernen === 'aus' ? (
            <>
              <p className="vp-muted" style={{ margin: 0 }}>
                Diese Box wurde nie eingerichtet: kein Lauf, keine Abnahme, kein Tunnel-Schlüssel, keine Kopplung. Der Eintrag lässt sich wieder entfernen.
              </p>
              <p style={{ margin: 0 }}>
                <Button variant="outline" size="sm" onClick={() => setEntfernen('fragen')} data-testid="ws-entfernen-start">
                  Aus dem Register entfernen
                </Button>
              </p>
            </>
          ) : (
            <div role="group" aria-label={`${ref} aus dem Register entfernen`} data-testid="ws-entfernen-frage">
              <p style={{ marginTop: 0 }}>
                <strong>{ref}</strong> aus dem Register entfernen? Die Box verschwindet aus der Liste; die Werkstatt hält fest, wer sie wann entfernt hat. Später lässt sie sich wieder aufnehmen.
              </p>
              {entfernFehler && <p className="vp-alert vp-alert-err" data-testid="ws-entfernen-fehler">{entfernFehler}</p>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button variant="primary" size="sm" disabled={entfernen === 'laeuft'} onClick={() => void ausDemRegister()} data-testid="ws-entfernen-ja">
                  {entfernen === 'laeuft' ? 'Entfernt …' : `${ref} entfernen`}
                </Button>
                <Button variant="outline" size="sm" disabled={entfernen === 'laeuft'} onClick={() => { setEntfernen('aus'); setEntfernFehler(null); }} data-testid="ws-entfernen-nein">
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
