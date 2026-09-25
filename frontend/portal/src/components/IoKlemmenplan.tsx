import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { consumersApi } from '../consumers/consumersApi';
import { ioZustandView, VERALTET_MS, type IoModulZustandDto } from '../consumers/ioZustand';
import './IoKlemmenplan.css';

/** Wie oft die Seite den Zustand eines I/O-Moduls nachliest. */
const IO_MODUL_TAKT_MS = 15_000;

/**
 * Der zuletzt GEMELDETE Zustand eines I/O-Moduls - geladen und im eigenen Takt
 * nachgelesen. Er lebt beim Wirt, weil Bühnen-Zahl und Klemmenplan aus
 * DERSELBEN Meldung entstehen müssen.
 */
export function useIoModulZustand(siteId: string, entityId: string | null) {
  const [dto, setDto] = useState<IoModulZustandDto | null>(null);
  const [fehler, setFehler] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!entityId) {
      setDto(null);
      return undefined;
    }
    let aktiv = true;
    const lesen = () => {
      consumersApi.ioModulZustand(siteId, entityId).then(
        (d) => { if (aktiv) { setDto(d); setFehler(false); } },
        () => { if (aktiv) setFehler(true); },
      );
    };
    lesen();
    const t = window.setInterval(lesen, IO_MODUL_TAKT_MS);
    return () => { aktiv = false; window.clearInterval(t); };
  }, [siteId, entityId, reload]);
  const neuLaden = useCallback(() => setReload((x) => x + 1), []);
  return { dto, fehler, neuLaden };
}

/**
 * Der KLEMMENPLAN eines I/O-Moduls (Ebyte M31) - die Bühne seiner Geräteseite:
 * je Ausgang und je Eingang eine Kachel mit Zustand und Belegung.
 *
 * <p>Die Ableitung ist `consumers/ioZustand` - hier wird nur gerendert.
 * Drei Regeln bleiben wörtlich:
 * <ul>
 *   <li>Ein nicht gemeldeter Kanal ist „—", nie „aus"; ein veralteter Zustand
 *       wird als solcher gezeigt, nie als aktuell.</li>
 *   <li>Ein Ausgang, der einem Verbraucher gehört, wird über dessen Seite
 *       geschaltet (mit Grenzen und Schonzeiten) - seine Kachel führt dorthin
 *       (K4), sie schaltet nicht selbst.</li>
 *   <li>Ein FREIER Ausgang lässt sich testweise schalten; bei unbekanntem
 *       Zustand werden beide Richtungen angeboten, statt einen zu raten.</li>
 * </ul>
 */
export function IoKlemmenplan({
  siteId,
  entityId,
  dto,
  fehler,
  now,
  onNeuLaden,
  verbraucherHref,
}: {
  siteId: string;
  entityId: string;
  dto: IoModulZustandDto | null;
  fehler: boolean;
  now: number;
  onNeuLaden: () => void;
  /** Die eigene Seite eines Verbrauchers am Ausgang (K4) - null, wenn es keine gibt. */
  verbraucherHref?: (consumerId: string) => string | null;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [meldung, setMeldung] = useState<{ text: string; ok: boolean } | null>(null);
  const v = ioZustandView(dto, now);

  const schalten = (channel: number, on: boolean) => {
    setBusy(channel);
    setMeldung(null);
    consumersApi.ioAusgangSchalten(siteId, entityId, channel, on).then(
      (r) => setMeldung({ text: r.message, ok: r.ok }),
      (e: unknown) => setMeldung({
        text: e instanceof Error && e.message ? e.message : 'Der Ausgang ließ sich nicht schalten.',
        ok: false,
      }),
    ).finally(() => {
      setBusy(null);
      // Die Box meldet den neuen Zustand binnen Sekunden - dann nachlesen.
      window.setTimeout(onNeuLaden, 1500);
    });
  };

  const at = dto?.receivedAt ? Date.parse(dto.receivedAt) : Number.NaN;
  const veraltet = Number.isFinite(at) && now - at > VERALTET_MS;

  return (
    <div className="vp-io" data-testid="io-klemmenplan">
      {fehler && !dto && (
        <p className="vp-io-satz">Der Zustand des I/O-Moduls ließ sich gerade nicht laden.</p>
      )}
      {v.leer && <p className="vp-io-satz">{v.leer}</p>}
      {v.ausgaenge.length > 0 && (
        <section aria-label="Ausgänge">
          <div className="vp-io-kopf">
            <span>Ausgänge</span>
            <span>{`${(dto?.outputs ?? []).filter((k) => k.consumerId).length} von ${v.ausgaenge.length} belegt`}</span>
          </div>
          <ul className="vp-io-raster">
            {(dto?.outputs ?? []).map((k, i) => {
              const z = v.ausgaenge[i];
              const an = z.wert.startsWith('ein');
              const href = k.consumerId ? verbraucherHref?.(k.consumerId) ?? null : null;
              const name = k.consumerId ? (k.consumerName?.trim() || 'Verbraucher') : 'frei';
              const inhalt = (
                <>
                  <span className="vp-io-nr">
                    DO{k.channel}
                    <i className={`vp-io-led${an ? ' is-an' : ''}${z.ton === 'warn' ? ' is-alt' : ''}`} aria-hidden="true" />
                  </span>
                  <span className="vp-io-name">{name}</span>
                  <span className="vp-io-unter">{z.wert}</span>
                </>
              );
              return (
                <li
                  key={k.channel}
                  className={`vp-io-kachel${k.consumerId ? ' is-belegt' : ' is-frei'}${an ? ' is-an' : ''}`}
                  data-kanal={`do${k.channel}`}
                >
                  {href ? (
                    <a className="vp-io-link" href={href} aria-label={`Ausgang DO${k.channel}: ${name}, ${z.wert}`}>
                      {inhalt}
                      <Icon name="chevron-right" size={14} />
                    </a>
                  ) : (
                    <div className="vp-io-link">{inhalt}</div>
                  )}
                  {z.schalten && (
                    <span className="vp-io-schalter">
                      {z.schalten.map((a) => (
                        <button
                          key={a.label}
                          type="button"
                          disabled={busy !== null}
                          onClick={() => schalten(k.channel, a.on)}
                          aria-label={`Ausgang DO${k.channel} ${a.on ? 'einschalten' : 'ausschalten'}`}
                        >
                          {busy === k.channel ? 'Schaltet …' : a.on ? 'Ein' : 'Aus'}
                        </button>
                      ))}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {v.eingaenge.length > 0 && (
        <section aria-label="Eingänge">
          <div className="vp-io-kopf">
            <span>Eingänge</span>
            <span>nur angezeigt</span>
          </div>
          <ul className="vp-io-raster is-ein">
            {(dto?.inputs ?? []).map((k, i) => {
              const z = v.eingaenge[i];
              const an = z.wert.startsWith('ein');
              return (
                <li key={k.channel} className={`vp-io-kachel is-eingang${an ? ' is-an' : ''}`} data-kanal={`di${k.channel}`}>
                  <div className="vp-io-link">
                    <span className="vp-io-nr">
                      DI{k.channel}
                      <i className={`vp-io-led${an ? ' is-an' : ''}${z.ton === 'warn' ? ' is-alt' : ''}`} aria-hidden="true" />
                    </span>
                    <span className="vp-io-unter">{z.wert}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {v.stand && (
        <p className={`vp-io-satz${veraltet ? ' is-warn' : ''}`}>
          {v.stand}{veraltet ? ' — der gezeigte Zustand ist nicht aktuell.' : ''}
        </p>
      )}
      {meldung && (
        <p className={`vp-io-satz${meldung.ok ? '' : ' is-warn'}`} role="status">{meldung.text}</p>
      )}
      {v.ausgaenge.length > 0 && (
        <p className="vp-io-satz">
          Ein freier Ausgang bleibt so, wie Sie ihn schalten. Ist die Box länger als eine Minute nicht
          erreichbar, schaltet das Modul alle Ausgänge zur Sicherheit aus.
        </p>
      )}
    </div>
  );
}
