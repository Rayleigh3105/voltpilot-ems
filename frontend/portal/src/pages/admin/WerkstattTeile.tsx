/**
 * Teile der Werkstatt-Seite, die nach den Handschritten bleiben: Beschriftung
 * des Gehäuses (Referenz und QR-Code mit dem Direktlink) und das
 * Abnahmeprotokoll mit den Belegen des Werkstatt-Dienstes. Die Ableitungen
 * stehen in `werkstatt.ts`; hier wird nur gerendert.
 */
import { useMemo } from 'react';
import { zeitpunkt } from '../../adminFernwartung';
import { Befehl } from '../../components/FernwartungSsh';
import { qrCode, qrPfad } from '../../qrCode';
import { beschriftung, PRUEFUNGEN, type WerkstattAbnahme } from '../../werkstatt';
import type { UebersichtZeile } from '../../werkstattBank';

/** Ein Modul des Codes auf dem Gehäuse, in Millimetern; dazu vier Module Ruhezone. */
const MODUL_MM = 0.84;
const RUHE = 4;

export function beschriftungSvg(ref: string): string {
  const b = beschriftung(ref);
  const q = qrCode(b.link);
  const seite = q.groesse + 2 * RUHE;
  const hoehe = seite + 6;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${(seite * MODUL_MM).toFixed(2)}mm" height="${(hoehe * MODUL_MM).toFixed(2)}mm" viewBox="0 0 ${seite} ${hoehe}">`,
    `<rect width="${seite}" height="${hoehe}" fill="#fff"/>`,
    `<path d="${qrPfad(q, RUHE)}" fill="#000"/>`,
    `<text x="${seite / 2}" y="${seite + 3.6}" font-family="monospace" font-size="4.5" text-anchor="middle">${b.klartext}</text>`,
    '</svg>',
  ].join('');
}

/** Der QR-Code mit dem Direktlink, wie auf dem Gehäuse. */
export function DirektlinkQr({ edgeRef, testId = 'ws-qr' }: { edgeRef: string; testId?: string }) {
  const b = beschriftung(edgeRef);
  const q = useMemo(() => qrCode(b.link), [b.link]);
  const seite = q.groesse + 2 * RUHE;
  return (
    <svg className="vp-ws-qr" viewBox={`0 0 ${seite} ${seite}`} role="img" aria-label={`QR-Code: ${b.link}`} data-testid={testId}>
      <rect width={seite} height={seite} fill="#fff" />
      <path d={qrPfad(q, RUHE)} fill="#000" />
    </svg>
  );
}

export function BeschriftungKarte({ edgeRef }: { edgeRef: string }) {
  const b = beschriftung(edgeRef);
  const q = useMemo(() => qrCode(b.link), [b.link]);
  const datei = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(beschriftungSvg(edgeRef))}`;
  return (
    <div className="vp-ws-beschriftung" data-testid="ws-beschriftung">
      <figure className="vp-ws-etikett">
        <DirektlinkQr edgeRef={edgeRef} />
        <figcaption className="vp-ws-klartext">{b.klartext}</figcaption>
      </figure>
      <div className="vp-ws-spalte">
        <p style={{ margin: 0 }}>
          Auf das Gehäuse kommen die Referenz in Klarschrift und ein QR-Code mit dem Direktlink ins Portal. Wer ihn mit
          dem Telefon öffnet, landet nach der Anmeldung dort, wo er eine Box verbindet, mit dieser Referenz im Feld.
        </p>
        <Befehl text={b.link} was="Direktlink" />
        {/* QR-Daten und Bau-Befehl braucht nur, wer das Gehäuse selbst baut: aufklappbar statt im Fließtext. */}
        <details className="vp-ws-technik">
          <summary>Technische Angaben</summary>
          <p className="vp-muted" style={{ margin: '4px 0 0' }}>
            QR-Code Fassung {q.fassung}, {q.groesse} × {q.groesse} Module, Fehlerkorrektur {q.korrektur}. Die Druckdatei für
            das Gehäuse baut im Repository <code>edge-light/gehaeuse/glinet-gl-mt300n-v2/bauen.sh --referenz {edgeRef}</code>.
          </p>
        </details>
        <div className="vp-ws-werkzeug">
          <a className="vp-btn vp-btn--outline vp-btn--sm" href={datei} download={`beschriftung-${edgeRef}.svg`}>
            Vorlage als SVG (echte Größe)
          </a>
        </div>
      </div>
    </div>
  );
}

/** Das Abnahmeprotokoll; bei der Abnahme des Dienstes je Prüfung sein Beleg. */
export function AbnahmeAnzeige({ a, jetzt }: { a: WerkstattAbnahme; jetzt: Date }) {
  const belege = a.quelle === 'dienst' && a.belege ? a.belege : null;
  return (
    <dl className="vp-ws-protokoll" data-testid="ws-abnahme-protokoll">
      <dt>Abgenommen</dt>
      <dd>
        {zeitpunkt(a.erfasstAm, jetzt)} {a.quelle === 'dienst' ? 'vom Werkstatt-Dienst' : `von ${a.erfasstVon} (von Hand)`}
      </dd>
      <dt>Host-Schlüssel</dt>
      <dd className="vp-fw-fingerabdruck">{a.hostSchluessel}</dd>
      <dt>Fassung</dt>
      <dd>{a.fassung}</dd>
      <dt>Tunnel · LAN</dt>
      <dd>
        {a.tunnelAdresse} · {a.lanNetz}
      </dd>
      <dt>Werkstatt-Probe</dt>
      <dd>
        {a.probe.technikerName}, {zeitpunkt(a.probe.beginn, jetzt)} bis {zeitpunkt(a.probe.ende, jetzt)}
      </dd>
      <dt>Prüfungen</dt>
      <dd>
        {belege ? (
          <details className="vp-ws-aufklapp" data-testid="ws-belege-aufklapp">
            <summary>{PRUEFUNGEN.length} Prüfungen mit Beleg</summary>
            <ul className="vp-ws-belege" data-testid="ws-belege">
              {PRUEFUNGEN.map((p) => (
                <li key={p.id}>
                  <span className="vp-ws-pruefung">{p.text}</span>
                  <span>{belege[p.id] ?? 'kein Beleg'}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : (
          `${a.pruefungen.length} von ${PRUEFUNGEN.length} abgehakt`
        )}
      </dd>
      {a.passwortAge && (
        <>
          <dt>Root-Passwort</dt>
          <dd>
            <details className="vp-ws-age" data-testid="ws-passwort-age">
              <summary>verschlüsselt abgelegt, nur mit dem age-Schlüssel „Box-Passwörter“ lesbar</summary>
              <Befehl text={a.passwortAge} was="Passwort (verschlüsselt)" />
            </details>
          </dd>
        </>
      )}
      {a.notiz && (
        <>
          <dt>Notiz</dt>
          <dd>{a.notiz}</dd>
        </>
      )}
    </dl>
  );
}

/** Wie der Stand einer Box als Abzeichen heißt (Übersicht und Detailseite). */
export const STAND_BADGE: Record<UebersichtZeile['stand'], { variant: 'ok' | 'warn' | 'tint' | 'off'; text: string }> = {
  abgenommen: { variant: 'ok', text: 'abgenommen' },
  problem: { variant: 'warn', text: 'Problem' },
  laeuft: { variant: 'tint', text: 'läuft' },
  'fertig-ohne-abnahme': { variant: 'warn', text: 'ohne Abnahme' },
  register: { variant: 'off', text: 'im Register' },
};
