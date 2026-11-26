/**
 * Die Karte „Direktvermarkter" auf Geräteakte › Verbindung (Konzept vp-direktvermarktung-konzept d2
 * §7.7) - NUR in der Plattform-Schicht, nie für den Kunden. Sie zeigt den Anschluss dieser Anlage an
 * einen Direktvermarkter (z. B. luox): Tunnel, Herzschlag, die fünf Register, die der Partner liest,
 * den Zugang (nie Chiffrat/Nonce/Passwort - „Nie sichtbar", §7.7) und die Ereignisse.
 *
 * Bleibt UNSICHTBAR, solange die Anlage nie einen Anschluss hatte (404) - eine leere Karte auf jeder
 * Geräteakte wäre Lärm für die große Mehrheit, die Direktvermarktung nie eingerichtet hat.
 *
 * Die drei Werkzeuge aus dem Konzept ("Zugang neu senden", "Tunnel neu starten", "Zugang sperren")
 * fehlen hier bewusst: "Zugang neu senden"/"sperren" brauchen die Zustellung (eigener,
 * sicherheitskritischer Auftrag, noch nicht gelandet - msg 017), "Tunnel neu starten" den Vertrag des
 * Tunnel-Dienstes, den dieser Auftrag nicht liest. Nachtragen, sobald beide stehen.
 */
import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { ApiError } from '../api';
import { adminApi, type AdminDirektvermarktungDetail, type AdminDirektvermarktungProtokollZeile } from '../admin/adminApi';
import { zeitpunkt } from '../adminFernwartung';

const EREIGNIS_LABEL: Record<string, string> = {
  gewaehlt: 'Partner gewählt',
  zugestimmt: 'Zugestimmt',
  zugang_hochgeladen: 'Zugangsdatei hochgeladen',
  zugang_abgelehnt: 'Zugangsdatei abgelehnt',
  zugang_zugestellt: 'Zugang auf der Box',
  zugang_zurueckgezogen: 'Zugang zurückgezogen',
  zustand: 'Zustand geändert',
  startdatum_gesetzt: 'Startdatum gesetzt',
  wechsel_geplant: 'Wechsel geplant',
  beendet: 'Beendet',
};

function kv(k: string, v: string | null | undefined) {
  if (v == null) return null;
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

export function DirektvermarkterKarte({ siteId }: { siteId: string | null }) {
  // `undefined` = lädt, `null` = diese Anlage hatte nie einen Anschluss (404).
  const [akte, setAkte] = useState<AdminDirektvermarktungDetail | null | undefined>(undefined);
  const [protokoll, setProtokoll] = useState<AdminDirektvermarktungProtokollZeile[]>([]);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    if (!siteId) {
      setAkte(null);
      return;
    }
    let aktiv = true;
    setFehler(null);
    adminApi.direktvermarktungAkte(siteId).then(
      (a) => { if (aktiv) setAkte(a); },
      (e) => {
        if (!aktiv) return;
        if (e instanceof ApiError && e.status === 404) setAkte(null);
        else setFehler('Der Direktvermarktung-Anschluss dieser Anlage ließ sich nicht laden.');
      },
    );
    adminApi.direktvermarktungProtokoll(siteId).then((p) => { if (aktiv) setProtokoll(p); }, () => { /* ohne Protokoll keine Behauptung */ });
    return () => { aktiv = false; };
  }, [siteId]);

  if (akte === undefined || akte === null) {
    return fehler ? (
      <Card padding="lg" radius="lg" className="vp-geraet-sek vp-geraet-breit">
        <p className="vp-alert vp-alert-err">{fehler}</p>
      </Card>
    ) : null;
  }

  const jetzt = new Date();
  const getrennt = akte.zustand === 'gestoert';

  return (
    <Card padding="lg" radius="lg" className="vp-geraet-sek vp-geraet-breit" data-testid="akte-direktvermarkter"
      aria-labelledby="dv-karte-titel">
      <h3 id="dv-karte-titel">
        Direktvermarkter{' '}
        <Badge variant={getrennt ? 'warn' : 'ok'} dot>
          {akte.partner} · {akte.zustand}
        </Badge>
      </h3>
      <dl className="vp-kv">
        {kv('Tunnel seit', akte.tunnelObenSeit && zeitpunkt(akte.tunnelObenSeit, jetzt))}
        {kv('Handshake', akte.handshakeAm && zeitpunkt(akte.handshakeAm, jetzt))}
        {kv('Adresse im Tunnel', akte.gegenstelle)}
        {kv('Abfragen je Minute', akte.abfragenJeMinute != null ? String(akte.abfragenJeMinute) : null)}
        {kv('Letzte Schreibung', akte.letzteSchreibungAm && zeitpunkt(akte.letzteSchreibungAm, jetzt))}
        {kv('Lebenszeichen', akte.lebenszeichenAm ? `${zeitpunkt(akte.lebenszeichenAm, jetzt)} · Frist 15 Min.` : 'unbekannt')}
      </dl>
      <h4>Register wie luox sie liest</h4>
      <dl className="vp-kv">
        {kv('Vorgabe', akte.vorgabePct != null ? `${akte.vorgabePct} %` : null)}
        {kv('Einspeisung', akte.einspeisungW != null ? `${akte.einspeisungW} W` : null)}
        {kv('Erzeugung', akte.erzeugungW != null ? `${akte.erzeugungW} W` : null)}
        {kv('Netzbetreiber-Vorgabe', akte.netzbetreiberPct != null ? `${akte.netzbetreiberPct} %` : null)}
        {kv('Referenzleistung', akte.referenzW != null ? `${akte.referenzW} W` : null)}
      </dl>
      {akte.zugangGueltigBis || akte.zugangFingerabdruck ? (
        <>
          <h4>Zugang</h4>
          <dl className="vp-kv">
            {kv('Hochgeladen von', akte.zugangHochgeladenVon)}
            {kv('Gültig bis', akte.zugangGueltigBis && new Date(akte.zugangGueltigBis).toLocaleDateString('de-DE'))}
            {kv('Fingerabdruck', akte.zugangFingerabdruck)}
            {kv('Zurückgezogen', akte.zugangZurueckgezogenAm && zeitpunkt(akte.zugangZurueckgezogenAm, jetzt))}
          </dl>
        </>
      ) : null}
      {protokoll.length > 0 && (
        <>
          <h4>Ereignisse</h4>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="dv-karte-protokoll">
            {protokoll.map((e) => (
              <li key={e.id} style={{ padding: '4px 0' }}>
                <span className="vp-cell-sub">{zeitpunkt(e.am, jetzt)}</span>{' '}
                {EREIGNIS_LABEL[e.ereignis] ?? e.ereignis}
                {e.von && <span className="vp-cell-sub"> · {e.von}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
