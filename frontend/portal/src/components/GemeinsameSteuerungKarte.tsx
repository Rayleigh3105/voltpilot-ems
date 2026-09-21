import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, ApiError, type Device, type Funktionen, type UemsGemeinsameSteuerungEinrichten, type UemsGemeinsameSteuerungZustand } from '../api';
import { standortDerAnlage } from '../anlageEnergiebilanz';
import {
  anlageSteuert,
  ausfallSaetze,
  befundSaetze,
  boxNamen,
  boxZeilen,
  karteSichtbar,
  lage,
  VERLUST_VARIANTE,
  zustandsZeile,
  type VerlustVariante,
} from '../gemeinsameSteuerungFlaeche';
import { hashForRoute, standortBereichRoute } from '../nav';
import { FLAECHE, flaechenSatz, satz } from '../uemsGemeinsameSteuerung';
import { ConfirmDialog } from './ConfirmDialog';
import { Recht } from './Recht';
import './GemeinsameSteuerungKarte.css';

/** Die Einrichten-Folge lädt erst, wenn jemand sie öffnet (wie der Messen-Assistent in `App.tsx`). */
const GemeinsameSteuerungEinrichten = lazy(() =>
  import('./GemeinsameSteuerungEinrichten').then((m) => ({ default: m.GemeinsameSteuerungEinrichten })),
);

export interface GemeinsameSteuerungDaten {
  /** Die Karte erscheint: die Anlage steuert UND hat mehr als eine Box (§5.2). */
  sichtbar: boolean;
  zustand: UemsGemeinsameSteuerungZustand | null;
  einrichten: UemsGemeinsameSteuerungEinrichten | null;
  standortId: string | null;
  /** Die Zustandszeile — auch die Zusammenfassung der zugeklappten Telefon-Karte. */
  zeile: string | null;
  neuLaden: () => void;
}

/**
 * Lädt, was die Karte braucht: die Funktionen (steuert die Anlage?), den Zustand und — nur mit eingerichteter
 * Gemeinsamer Steuerung — die Auslegung für Namen, Grenzen und Anteile. Ein Fehler zeigt keine Karte: unbekannt ist
 * nie „steuert“.
 */
export function useGemeinsameSteuerung(siteId: string, siteDevices: readonly Device[]): GemeinsameSteuerungDaten {
  const [funktionen, setFunktionen] = useState<Funktionen | null>(null);
  const [zustand, setZustand] = useState<UemsGemeinsameSteuerungZustand | null>(null);
  const [einrichten, setEinrichten] = useState<UemsGemeinsameSteuerungEinrichten | null>(null);
  const [tick, setTick] = useState(0);
  const neuLaden = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let aus = false;
    api.funktionen().then((f) => { if (!aus) setFunktionen(f); }, () => { if (!aus) setFunktionen(null); });
    return () => { aus = true; };
  }, [siteId]);

  useEffect(() => {
    let aus = false;
    api.gemeinsameSteuerung(siteId).then(
      (z) => {
        if (aus) return;
        setZustand(z);
        if (lage(z) === 'nicht_eingerichtet') { setEinrichten(null); return; }
        api.gemeinsameSteuerungEinrichten(siteId).then((e) => { if (!aus) setEinrichten(e); }, () => { if (!aus) setEinrichten(null); });
      },
      () => { if (!aus) { setZustand(null); setEinrichten(null); } },
    );
    return () => { aus = true; };
  }, [siteId, tick]);

  const namen = useMemo(() => boxNamen(siteDevices, einrichten), [siteDevices, einrichten]);
  const sichtbar = zustand != null && karteSichtbar({
    steuert: anlageSteuert(funktionen, siteId),
    boxen: siteDevices.length,
    eingerichtet: lage(zustand) !== 'nicht_eingerichtet',
  });
  return {
    sichtbar,
    zustand,
    einrichten,
    standortId: standortDerAnlage(funktionen, siteId),
    zeile: zustandsZeile(zustand, einrichten, namen),
    neuLaden,
  };
}

/**
 * Die Karte „Gemeinsame Steuerung“ unter Anlage → Technik (UEMS AP-15 IP-23, §5.2/§5.5/§5.8): Zustandszeile, je Box
 * Rolle und Anteil, Ausfall-Sätze und Verlust-Zeile, was fehlt, Einrichten/Ändern, Anhalten/Fortsetzen. Kein
 * Scharfschalten — das ist Sache von VoltPilot (I5).
 */
export function GemeinsameSteuerungKarte({
  siteId,
  siteDevices,
  daten,
  jetzt,
  verlustVariante = VERLUST_VARIANTE,
}: {
  siteId: string;
  siteDevices: readonly Device[];
  daten: GemeinsameSteuerungDaten;
  /** Für Aufnahmen und Tests; sonst die Uhr. */
  jetzt?: Date;
  verlustVariante?: VerlustVariante;
}) {
  const { zustand, einrichten, standortId, neuLaden } = daten;
  const [offen, setOffen] = useState(false);
  const [anhalten, setAnhalten] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const l = lage(zustand);
  const namen = useMemo(() => boxNamen(siteDevices, einrichten), [siteDevices, einrichten]);
  const ausfall = ausfallSaetze(zustand, siteDevices, namen, jetzt ?? new Date());
  const zeilen = boxZeilen(zustand, einrichten, namen, ausfall, verlustVariante);
  const befunde = befundSaetze(zustand, namen);
  const beiBetreiber = l === 'angehalten' && zustand?.naechster_schritt === 'vom_betreiber_angehalten';
  const fuehrt = zustand?.mitglieder?.find((m) => m.rolle === 'fuehrt')?.box_id;
  const recht = standortId ?? undefined;

  async function schritt(was: 'anhalten' | 'fortsetzen') {
    if (busy) return;
    setBusy(true);
    setFehler(null);
    try {
      await api.gemeinsameSteuerungSchritt(siteId, was);
      setAnhalten(false);
      neuLaden();
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { code?: string } | undefined)?.code : undefined;
      setAnhalten(false);
      setFehler(code === 'vom_betreiber_angehalten'
        ? flaechenSatz('vom_betreiber_angehalten')
        : e instanceof ApiError && e.message ? e.message : 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.');
      neuLaden();
    } finally {
      setBusy(false);
    }
  }

  const weg = (w: 'netzanschluss' | 'datenquelle' | 'aendern' | null) => {
    if (w === 'netzanschluss' && standortId) {
      return <a className="vp-gs-weg" href={hashForRoute(standortBereichRoute(standortId, 'netzanschluesse'))}>Netzanschluss eintragen</a>;
    }
    if (w === 'datenquelle' && standortId) {
      return <a className="vp-gs-weg" href={hashForRoute(standortBereichRoute(standortId, 'boxen'))}>Datenquelle an einer Box anlegen</a>;
    }
    return null;
  };

  return (
    <div className="vp-gs" data-testid="gemeinsame-steuerung">
      {l === 'nicht_eingerichtet' ? (
        <p className="vp-gs-text">{flaechenSatz('nicht_eingerichtet', { boxen: String(siteDevices.length) })}</p>
      ) : (
        <p className="vp-gs-zeile" data-testid="gs-zustand" role="status">{daten.zeile}</p>
      )}

      {zeilen.length > 0 && (
        <ul className="vp-gs-boxen" aria-label="Boxen der Gemeinsamen Steuerung">
          {zeilen.map((z) => (
            <li key={z.boxId} data-testid="gs-box">
              <span className="vp-gs-box-text">{z.text}</span>
              {z.ausfall && <span className="vp-gs-ausfall" role="note" data-testid="gs-ausfall">{z.ausfall}</span>}
              {z.verlust && <span className="vp-gs-verlust" data-testid="gs-verlust">{z.verlust}</span>}
            </li>
          ))}
        </ul>
      )}
      {(l === 'aktiv' || l === 'angehalten') && <p className="vp-gs-erklaerung">{satz('erklaerung_anteile')}</p>}

      {befunde.length > 0 && (
        <ul className="vp-gs-befunde" aria-label="Was noch fehlt">
          {befunde.map((b) => (
            <li key={b.text} data-testid="gs-befund">
              {b.text} {weg(b.weg)}
            </li>
          ))}
        </ul>
      )}

      {fehler && <p className="vp-gs-fehler" role="alert">{fehler}</p>}

      <div className="vp-gs-aktionen">
        {(l === 'nicht_eingerichtet' || l === 'eingerichtet' || l === 'wird_geprueft' || (l === 'angehalten' && !beiBetreiber)) && (
          <Recht aktion="funktion.steuern_einrichten" standort={recht}>
            <Button variant={l === 'nicht_eingerichtet' ? 'primary' : 'outline'} onClick={() => setOffen(true)}>
              {l === 'nicht_eingerichtet' ? 'Gemeinsame Steuerung einrichten' : 'Gemeinsame Steuerung ändern'}
            </Button>
          </Recht>
        )}
        {l === 'aktiv' && (
          <Recht aktion="steuerung.starten_beenden" standort={recht}>
            <Button variant="outline" disabled={busy} onClick={() => setAnhalten(true)}>Anhalten</Button>
          </Recht>
        )}
        {l === 'angehalten' && !beiBetreiber && (
          <Recht aktion="steuerung.starten_beenden" standort={recht}>
            <Button variant="primary" disabled={busy} onClick={() => void schritt('fortsetzen')}>Fortsetzen</Button>
          </Recht>
        )}
      </div>
      {l === 'aktiv' && <p className="vp-gs-hinweis" data-testid="gs-erst-anhalten">{FLAECHE.erst_anhalten}</p>}
      {beiBetreiber && <p className="vp-gs-hinweis" role="note" data-testid="gs-betreiber">{FLAECHE.vom_betreiber_angehalten}</p>}

      <ConfirmDialog
        open={anhalten}
        title="Gemeinsame Steuerung anhalten"
        intro={FLAECHE.anhalten_intro}
        consequences={[
          satz('angehalten', { box: fuehrt ? (namen.get(fuehrt) ?? 'ohne Namen') : 'ohne Namen' }),
          FLAECHE.anhalten_fortsetzen,
        ]}
        confirmLabel={busy ? 'Wird angehalten …' : 'Anhalten'}
        busy={busy}
        onConfirm={() => void schritt('anhalten')}
        onCancel={() => setAnhalten(false)}
      />
      {offen && (
        <Suspense fallback={null}>
          <GemeinsameSteuerungEinrichten
            siteId={siteId}
            siteDevices={siteDevices}
            zustand={zustand}
            standortId={standortId}
            onClose={() => { setOffen(false); neuLaden(); }}
          />
        </Suspense>
      )}
    </div>
  );
}
