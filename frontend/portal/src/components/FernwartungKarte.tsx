/**
 * Die Karte „Fernwartung" auf der Box-Seite - NUR in der Plattform-Schicht
 * („Technik & Diagnose › plattform"), nie für den Kunden (O3).
 *
 * Sie zeigt den Tunnel dieser Box, laufende Fenster und ob der Tunnel-Dienst
 * abholt; sie öffnet und schließt Fenster. Zugänge und das volle Protokoll
 * wohnen auf „Geräte › Fernwartung" (Link).
 */
import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { ApiError } from '../api';
import { adminApi } from '../admin/adminApi';
import {
  abrufLage,
  fensterTeile,
  fensterTon,
  oeffnenSperre,
  UNBEKANNT_SATZ,
  type FernwartungBox,
  type FernwartungTechniker,
  type FernwartungUebersicht,
} from '../adminFernwartung';
import { fernwartungHash } from '../nav';
import { FensterDialog, LageZeile, SchluesselDialog } from './FernwartungDialoge';
import '../pages/admin/Fernwartung.css';

export function FernwartungKarte({ edgeRef }: { edgeRef: string }) {
  // `undefined` = lädt, `null` = kein Tunnel-Schlüssel hinterlegt (404).
  const [box, setBox] = useState<FernwartungBox | null | undefined>(undefined);
  const [uebersicht, setUebersicht] = useState<FernwartungUebersicht | null>(null);
  const [techniker, setTechniker] = useState<FernwartungTechniker[]>([]);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fensterOffen, setFensterOffen] = useState(false);
  const [schluesselOffen, setSchluesselOffen] = useState(false);
  const [jetzt, setJetzt] = useState(() => new Date());

  async function laden() {
    setFehler(null);
    const [b, u, t] = await Promise.allSettled([
      adminApi.fernwartungBox(edgeRef),
      adminApi.fernwartung(),
      adminApi.fernwartungTechniker(),
    ]);
    if (b.status === 'fulfilled') setBox(b.value);
    else if (b.reason instanceof ApiError && b.reason.status === 404) setBox(null);
    else setFehler('Die Fernwartung dieser Box ließ sich nicht laden.');
    if (u.status === 'fulfilled') setUebersicht(u.value);
    if (t.status === 'fulfilled') setTechniker(t.value);
    setJetzt(new Date());
  }

  useEffect(() => {
    void laden();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeRef]);

  async function schliessen(id: string) {
    setBusy(true);
    setFehler(null);
    try {
      await adminApi.fernwartungFensterSchliessen(id);
      await laden();
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Schließen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  const sperre = box ? oeffnenSperre(box, techniker) : null;

  return (
    <section className="vp-fw-karte" data-testid="fw-karte" aria-labelledby="fw-karte-titel">
      <h3 id="fw-karte-titel">
        Fernwartung{' '}
        {box && (
          <Badge variant={box.status === 'aktiv' ? 'ok' : 'off'} dot>
            {box.status === 'aktiv' ? `Tunnel ${box.adresse}` : 'gesperrt'}
          </Badge>
        )}
      </h3>
      {box === undefined && !fehler && <p className="vp-muted">Lädt…</p>}
      {box === null && (
        <>
          <p className="vp-muted" style={{ margin: 0 }}>
            Für diese Box ist kein Tunnel-Schlüssel hinterlegt. Ohne ihn hat sie keinen Wartungstunnel.
          </p>
          <div>
            <Button variant="outline" size="sm" onClick={() => setSchluesselOffen(true)}>
              Tunnel-Schlüssel hinterlegen
            </Button>
          </div>
        </>
      )}
      {box && (
        <>
          {box.laufendeFenster.length === 0 ? (
            <p className="vp-muted" style={{ margin: 0 }}>
              Kein Fenster offen - Techniker erreichen die Box nicht.
            </p>
          ) : (
            <ul className="vp-fw-fenster">
              {box.laufendeFenster.map((f) => (
                <li key={f.id}>
                  <Badge variant={fensterTon(f.zustand)} dot>
                    {fensterTeile(f, jetzt).zustand}
                  </Badge>
                  <span>{fensterTeile(f, jetzt).text}</span>
                  <span className="vp-cell-sub">{f.grund}</span>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void schliessen(f.id)}>
                    {f.zustand === 'geplant' ? 'Absagen' : 'Schließen'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="vp-fw-aktionen" style={{ justifyContent: 'flex-start' }}>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || sperre != null}
              title={sperre ?? undefined}
              onClick={() => setFensterOffen(true)}
            >
              Fenster öffnen
            </Button>
            {sperre && <span className="vp-cell-sub">{sperre}</span>}
          </div>
        </>
      )}
      {uebersicht && box !== undefined && <LageZeile lage={abrufLage(uebersicht, jetzt)} testId="fw-karte-dienst" />}
      {box && <p className="vp-note" style={{ margin: 0 }}>{UNBEKANNT_SATZ}</p>}
      {fehler && <p className="vp-alert vp-alert-err">{fehler}</p>}
      <p style={{ margin: 0 }}>
        <a href={fernwartungHash(edgeRef)} className="vp-box-oberflaeche">
          Zugänge und Protokoll <Icon name="chevron-right" size={14} />
        </a>
      </p>

      <FensterDialog
        box={fensterOffen ? (box ?? null) : null}
        techniker={techniker}
        maxMinuten={uebersicht?.maxFensterMinuten ?? 60}
        onClose={() => setFensterOffen(false)}
        onGeoeffnet={() => {
          setFensterOffen(false);
          void laden();
        }}
      />
      <SchluesselDialog
        offen={schluesselOffen}
        vorbelegt={edgeRef}
        onClose={() => setSchluesselOffen(false)}
        onFertig={() => void laden()}
      />
    </section>
  );
}
