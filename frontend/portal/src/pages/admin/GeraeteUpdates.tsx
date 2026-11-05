import { Fragment, type ReactNode } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import type { BoxArt, EdgeUpdatesRelease } from '../../adminEdgeUpdates';
import {
  filterBoxen, filterZahlen, gruppen, type Aufgabe, type BadgeTon, type BoxFilter, type BoxZeile, type Lage,
  type LageZiel, type LinieKarte, type Satz, type TrackerSchritt,
} from '../../geraeteUpdates';
import './GeraeteUpdates.css';

/**
 * Die Bausteine der Seite „Geräte & Updates" (Geräte & Updates G5): Lage-Satz,
 * Linien-Karten, „Braucht dich" und die Boxen. Sie rendern, was die reine
 * Schicht `geraeteUpdates.ts` ableitet - entschieden wird hier nichts.
 */

export function SatzText({ satz }: { satz: Satz }) {
  return (
    <>
      {satz.map((t, i) => (typeof t === 'string'
        ? <Fragment key={i}>{t}</Fragment>
        : <span key={i} className="vp-gu-mono">{t.mono}</span>))}
    </>
  );
}

function GuBadge({ ton, children, punkt = true }: { ton: BadgeTon; children: ReactNode; punkt?: boolean }) {
  return (
    <span className={`vp-gu-badge ${ton}`}>
      {punkt && <i className="p" aria-hidden="true" />}
      {children}
    </span>
  );
}

// ── Lage ────────────────────────────────────────────────────────────────────

export function UpdatesLage({ lage, onZiel }: { lage: Lage; onZiel: (ziel: LageZiel) => void }) {
  return (
    <div className={`vp-gu-lage ${lage.ton}`} data-testid="lage" role="status">
      <Icon name={lage.icon} size={18} />
      <span><SatzText satz={lage.text} /></span>
      {lage.link && (
        <button type="button" className="vp-gu-lage-link" onClick={() => onZiel(lage.link!.ziel)}>
          {lage.link.label}
        </button>
      )}
    </div>
  );
}

// ── Linien-Karten ───────────────────────────────────────────────────────────

const SEGMENT_KLASSE = 's-';

function Balken({ karte }: { karte: LinieKarte }) {
  const beschreibung = karte.segmente.length
    ? `Boxen dieser Linie: ${karte.segmente.map((s) => `${s.n} ${s.wort}`).join(', ')}`
    : 'Diese Linie hat noch keine Box';
  return (
    <>
      <div className="vp-gu-balken" role="img" aria-label={beschreibung}>
        {karte.segmente.map((s) => <i key={s.art} className={SEGMENT_KLASSE + s.art} style={{ flex: s.n }} />)}
      </div>
      {karte.segmente.length > 0 && (
        <div className="vp-gu-legende" aria-hidden="true">
          {karte.segmente.map((s) => (
            <span key={s.art}><i className={SEGMENT_KLASSE + s.art} />{s.n} {s.wort}</span>
          ))}
        </div>
      )}
    </>
  );
}

export interface LinienAktionen {
  busy: boolean;
  onVerteilen: (release: EdgeUpdatesRelease) => void;
  onReleases: (art: BoxArt) => void;
  onFortschritt: (art: BoxArt) => void;
  onNachruesten: (deviceId: string) => void;
  /** E1 A: dasselbe Release an die übrigen Boxen - ein neuer Ein-Schritt-Lauf. */
  onWeiter: (art: BoxArt, releaseSeq: number, uebrige: string[]) => void;
}

function LinienKnopf({ karte, a }: { karte: LinieKarte; a: LinienAktionen }) {
  const neu = karte.neu?.release ?? null;
  switch (karte.aktion) {
    case 'verteilen':
      return (
        <Button variant="primary" size="sm" iconLeft={<Icon name="refresh-cw" size={16} />}
          disabled={a.busy || !neu} onClick={() => neu && a.onVerteilen(neu)}>
          Verteilen …
        </Button>
      );
    case 'fortschritt':
      return <Button variant="outline" size="sm" onClick={() => a.onFortschritt(karte.boxArt)}>Fortschritt</Button>;
    case 'nachruesten':
      return (
        <button type="button" className="vp-gu-knopf-warnen" onClick={() => a.onNachruesten(karte.stufe1[0])}>
          <Icon name="hand" size={16} />Nachrüsten: so geht’s
        </button>
      );
    case 'aktuell':
      return <Button variant="primary" size="sm" disabled title="Jede Box dieser Linie läuft auf ihrem neuesten Release.">Alle aktuell</Button>;
    case 'weiter':
      // Den Knopf trägt der Lauf selbst („An die übrigen …").
      return null;
    case 'nichts':
      return (
        <>
          <Button variant="primary" size="sm" disabled aria-describedby={`vp-gu-sperre-${karte.boxArt}`}>Verteilen …</Button>
          <span id={`vp-gu-sperre-${karte.boxArt}`} className="vp-gu-leise vp-gu-klein" data-testid="linie-sperre">{karte.sperre}</span>
        </>
      );
    default:
      return null;
  }
}

/** Der Lauf in der Karte (G6): drei Zahlen statt eines gemischten Zustands, danach ggf. „An die übrigen". */
function Lauf({ karte, a }: { karte: LinieKarte; a: LinienAktionen }) {
  const l = karte.lauf!;
  const kopf = [l.seit ? `seit ${l.seit}` : null, l.von ? `von ${l.von}` : null].filter(Boolean).join(' · ');
  return (
    <div className="vp-gu-lauf" data-testid="linie-lauf">
      <div className="vp-gu-lauf-kopf">
        <Icon name="refresh-cw" size={16} />
        <span>
          <span className="vp-gu-mono">{l.release}</span> an {l.angefragt} {l.angefragt === 1 ? 'Box' : 'Boxen'}
          {kopf ? ` · ${kopf}` : ''}
        </span>
      </div>
      <div className="vp-gu-drei">
        <div><b>{l.angefragt}</b><small>angefragt (Portal)</small></div>
        <div><b>{l.angenommen}</b><small>angenommen (Box)</small></div>
        <div><b>{l.bestaetigt}</b><small>bestätigt (Box)</small></div>
      </div>
      {l.gescheitert > 0 && (
        <p className="vp-gu-lauf-fehler">
          {l.gescheitert} {l.gescheitert === 1 ? 'Box hat' : 'Boxen haben'} abgelehnt oder zurückgenommen – siehe „Braucht dich“.
        </p>
      )}
      {l.weiter && (
        <div className="vp-gu-weiter" data-testid="linie-weiter">
          <span><SatzText satz={l.weiter.text} /></span>
          <Button variant="primary" size="sm" iconLeft={<Icon name="refresh-cw" size={16} />} disabled={a.busy}
            onClick={() => a.onWeiter(karte.boxArt, l.releaseSeq, l.weiter!.uebrige)}>
            {`An die übrigen ${l.weiter.uebrige.length}`}
          </Button>
        </div>
      )}
    </div>
  );
}

function LinienKartenKarte({ karte, a }: { karte: LinieKarte; a: LinienAktionen }) {
  const titelId = `vp-gu-linie-${karte.boxArt}`;
  return (
    <section className="vp-gu-linie" data-testid={`linie-${karte.boxArt}`} aria-labelledby={titelId}>
      <div className="vp-gu-linie-kopf">
        <div className="vp-gu-kreis" aria-hidden="true"><Icon name={karte.icon} size={18} /></div>
        <div>
          <h2 id={titelId}>{karte.name}</h2>
          <small><SatzText satz={karte.muster} /></small>
        </div>
        <div className="vp-gu-zahl">{karte.gesamt} {karte.gesamt === 1 ? 'Box' : 'Boxen'}</div>
      </div>
      {karte.neu ? (
        <div className="vp-gu-neu">
          <span className="vp-gu-etikett">Neuestes Release dieser Linie</span>
          <span className="vp-gu-version" data-testid="linie-neuestes">{karte.neu.release.version}</span>
          {karte.neu.release.signed
            ? <GuBadge ton="ok">signiert</GuBadge>
            : <GuBadge ton="warn">nicht signiert – nicht verteilbar</GuBadge>}
          {karte.neu.wann && <span className="vp-gu-leise vp-gu-klein">{karte.neu.wann}</span>}
        </div>
      ) : (
        <p className="vp-gu-leise vp-gu-klein" style={{ margin: 0 }}>
          Für diese Linie ist noch kein Release registriert. Ein Release trägt sich beim Bau selbst ein.
        </p>
      )}
      {karte.plattformen && karte.plattformen.length > 0 && (
        <div className="vp-gu-plattformen" data-testid="linie-plattformen">
          {karte.plattformen.map((p) => (
            <span key={p.text} className={`vp-gu-chip hw ${p.ton === 'fehlt' ? 'fehlt' : ''}`}>
              <Icon name="cpu" size={13} />{p.text}
            </span>
          ))}
        </div>
      )}
      <Balken karte={karte} />
      {karte.lauf && <Lauf karte={karte} a={a} />}
      {karte.leiter.length > 0 && (
        <div className="vp-gu-leiter" data-testid="linie-leiter">
          {karte.leiter.map((s) => (
            <div key={s.version} className="vp-gu-leiter-zeile">
              <span>
                <span className="vp-gu-mono">{s.version}</span>{' '}
                {s.neuestes && <GuBadge ton="ok" punkt={false}>neuestes</GuBadge>}
              </span>
              <span className="wer">{s.wer}</span>
            </div>
          ))}
          {karte.leiterRest > 0 && (
            <div className="vp-gu-leiter-zeile">
              <span className="vp-gu-leise">und {karte.leiterRest} weitere {karte.leiterRest === 1 ? 'Stand' : 'Stände'}</span>
            </div>
          )}
        </div>
      )}
      <div className="vp-gu-aktionen">
        <LinienKnopf karte={karte} a={a} />
        <Button variant="ghost" size="sm" iconLeft={<Icon name="list" size={16} />} onClick={() => a.onReleases(karte.boxArt)}>
          Releases ({karte.releases})
        </Button>
      </div>
    </section>
  );
}

export function LinienKarten({ karten, ...a }: { karten: LinieKarte[] } & LinienAktionen) {
  if (karten.length === 0) return null;
  return (
    <div className="vp-gu-linien" data-testid="box-linien">
      {karten.map((k) => <LinienKartenKarte key={k.boxArt} karte={k} a={a} />)}
    </div>
  );
}

// ── Braucht dich ────────────────────────────────────────────────────────────

export function BrauchtDich({ aufgaben, busy, onBox, onFernwartung, onNachruesten, onNochmal, onZurueckziehen }: {
  aufgaben: Aufgabe[];
  busy: boolean;
  onBox: (deviceId: string) => void;
  onFernwartung?: () => void;
  onNachruesten: (deviceId: string) => void;
  /** Dieselbe Anfrage noch einmal: ein neuer `assigned_at`, die Box versucht es wieder. */
  onNochmal: (deviceId: string, releaseSeq: number) => void;
  /** Die Anfrage zurückziehen (Zeile und retained Nachricht). */
  onZurueckziehen: (deviceIds: string[]) => void;
}) {
  if (aufgaben.length === 0) return null;
  return (
    <section id="vp-gu-braucht" className="vp-gu-block" aria-labelledby="vp-gu-braucht-titel" data-testid="braucht-dich">
      <div className="vp-gu-block-titel">
        <h2 id="vp-gu-braucht-titel">Braucht dich</h2>
        {aufgaben.length > 1 && <span className="vp-gu-leise vp-gu-klein">nach Dringlichkeit</span>}
      </div>
      <div className="vp-gu-aufgaben">
        {aufgaben.map((a) => (
          <div key={a.id} className={`vp-gu-aufgabe ton-${a.ton}`} data-testid="aufgabe">
            <div className="vp-gu-kreis" aria-hidden="true"><Icon name={a.icon} size={18} /></div>
            <div>
              <h3>{a.titel}</h3>
              <p><SatzText satz={a.text} /></p>
            </div>
            <div className="vp-gu-aktionen">
              {a.knoepfe.map((k) => {
                const id = a.deviceIds[0];
                if (k === 'nachruesten') {
                  return (
                    <Button key={k} variant="outline" size="sm" iconLeft={<Icon name="hand" size={16} />}
                      onClick={() => onNachruesten(id)}>
                      Nachrüsten: so geht’s
                    </Button>
                  );
                }
                if (k === 'nochmal') {
                  return a.nochmal ? (
                    <Button key={k} variant="ghost" size="sm" disabled={busy}
                      onClick={() => onNochmal(a.nochmal!.deviceId, a.nochmal!.releaseSeq)}>
                      Noch einmal anfragen
                    </Button>
                  ) : null;
                }
                if (k === 'zurueckziehen') {
                  return (
                    <Button key={k} variant="ghost" size="sm" disabled={busy || a.anfragen.length === 0}
                      onClick={() => onZurueckziehen(a.anfragen)}>
                      {a.anfragen.length > 1 ? `${a.anfragen.length} Anfragen zurückziehen` : 'Anfrage zurückziehen'}
                    </Button>
                  );
                }
                if (k === 'fernwartung') {
                  return onFernwartung ? (
                    <Button key={k} variant="outline" size="sm" iconLeft={<Icon name="shield" size={16} />}
                      onClick={onFernwartung}>
                      Fernwartung
                    </Button>
                  ) : null;
                }
                return (
                  <Button key={k} variant={a.knoepfe.length > 1 ? 'ghost' : 'outline'} size="sm" onClick={() => onBox(id)}>
                    Box ansehen
                  </Button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Boxen ───────────────────────────────────────────────────────────────────

function Tracker({ schritte }: { schritte: TrackerSchritt[] }) {
  return (
    <ol className="vp-gu-tracker" aria-label="Anfrage: angefragt (Portal), angenommen und bestätigt (Box)">
      {schritte.map((s) => (
        <li key={s.schritt} className={s.zustand} data-zustand={s.zustand}>
          <i aria-hidden="true" />{s.wort}
        </li>
      ))}
    </ol>
  );
}

function Zeile({ z, onOpen }: { z: BoxZeile; onOpen: (deviceId: string) => void }) {
  const v = z.verbindung;
  return (
    <tr className={z.brauchtDich ? 'hervor' : undefined} data-testid="box-zeile" onClick={() => onOpen(z.deviceId)}>
      <td className="vp-gu-name">
        <b>{z.name}</b>
        <small>{z.ort}</small>
        <small className="vp-gu-mono">{z.ref}</small>
      </td>
      <td>
        <div className="vp-gu-linie-zelle">
          <span className={`vp-gu-chip ${z.linie ?? 'unbekannt'}`} data-testid="box-art">{z.linieText}</span>
          <span className="vp-gu-chip hw" data-testid="box-geraet">{z.geraet}</span>
        </div>
      </td>
      <td>
        <div className={`vp-gu-verb ${v.zustand}`} data-testid="box-verbindung">
          <b><i aria-hidden="true" />{v.text}</b>
          {v.gesehen && <small>{v.gesehen}</small>}
        </div>
      </td>
      <td>
        <div className="vp-gu-laeuft">
          {z.laeuft
            ? <span><span className="vp-gu-zeile-label">Läuft</span><span className="vp-gu-mono" data-testid="box-laeuft">{z.laeuft}</span></span>
            : <span className="vp-gu-leise">Keine Versionsmeldung</span>}
          {z.urteil && <GuBadge ton={z.urteil.ton}>{z.urteil.text}</GuBadge>}
        </div>
      </td>
      <td>
        <div className="vp-gu-status" data-testid="box-update">
          {z.updateBadge && <span><GuBadge ton={z.updateBadge.ton}>{z.updateBadge.text}</GuBadge></span>}
          {z.ziel && (
            <span className="vp-gu-ziel" data-testid="box-ziel">Anfrage <span className="vp-gu-mono">{z.ziel}</span></span>
          )}
          {z.tracker && <Tracker schritte={z.tracker} />}
          {z.satz && <span className="vp-gu-satz"><SatzText satz={z.satz} /></span>}
        </div>
      </td>
      <td className="vp-gu-pfeil-zelle">
        <button type="button" className="vp-gu-pfeil" aria-label={`Update verwalten für ${z.name} · ${z.row.externalRef}`}
          onClick={(e) => { e.stopPropagation(); onOpen(z.deviceId); }}>
          <Icon name="chevron-right" size={18} />
        </button>
      </td>
    </tr>
  );
}

export function BoxenListe({ zeilen, filter, onFilter, onOpen }: {
  zeilen: BoxZeile[];
  filter: BoxFilter;
  onFilter: (f: BoxFilter) => void;
  onOpen: (deviceId: string) => void;
}) {
  const zahlen = filterZahlen(zeilen, filter.linie);
  const sichtbar = filterBoxen(zeilen, filter);
  const teile = gruppen(sichtbar);
  return (
    <section id="vp-gu-boxen" className="vp-gu-block" aria-labelledby="vp-gu-boxen-titel">
      <div className="vp-gu-block-titel">
        <h2 id="vp-gu-boxen-titel">Boxen</h2>
        <span className="vp-gu-leise vp-gu-klein">Was jede Box meldet und was das Portal angefragt hat</span>
      </div>
      <div className="vp-gu-karte">
        <div className="vp-gu-filter">
          <div className="vp-gu-seg" role="group" aria-label="Boxen nach Linie filtern">
            {zahlen.linien.map((l) => (
              <button key={l.wert} type="button" aria-pressed={filter.linie === l.wert}
                className={filter.linie === l.wert ? 'an' : undefined}
                onClick={() => onFilter({ ...filter, linie: l.wert })}>
                {l.label} {l.n}
              </button>
            ))}
          </div>
          <div className="vp-gu-seg" role="group" aria-label="Boxen nach Zustand filtern">
            {zahlen.status.map((s) => (
              <button key={s.wert} type="button" aria-pressed={filter.status === s.wert}
                className={filter.status === s.wert ? 'an' : undefined}
                onClick={() => onFilter({ ...filter, status: filter.status === s.wert ? null : s.wert })}>
                {s.label} {s.n}
              </button>
            ))}
          </div>
          <label className="vp-gu-such">
            <Icon name="search" size={15} />
            <span className="vp-sr-only">Boxen durchsuchen</span>
            <input type="search" value={filter.suche} placeholder="Box, Anlage, Kunde, Version"
              onChange={(e) => onFilter({ ...filter, suche: e.target.value })} />
          </label>
        </div>
        {sichtbar.length === 0 ? (
          <div className="vp-gu-leer">
            <span>{zeilen.length === 0 ? 'Noch keine Box registriert.' : 'Keine Box passt zu diesem Filter.'}</span>
            {zeilen.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => onFilter({ linie: 'alle', status: null, suche: '' })}>
                Filter zurücksetzen
              </Button>
            )}
          </div>
        ) : (
          <table className="vp-gu-tabelle" data-testid="box-versions">
            <thead>
              <tr>
                <th scope="col">Box / Anlage</th>
                <th scope="col">Linie · Gerät</th>
                <th scope="col">Verbindung</th>
                <th scope="col">Läuft (meldet die Box)</th>
                <th scope="col">Update</th>
                <th scope="col"><span className="vp-sr-only">Öffnen</span></th>
              </tr>
            </thead>
            {teile.map((g) => (
              <tbody key={g.titel} data-testid={`gruppe-${g.linie ?? 'unbekannt'}`}>
                <tr className="vp-gu-gruppe">
                  <th scope="colgroup" colSpan={6}>
                    <Icon name={g.linie === 'light' ? 'cpu' : g.linie === 'docker' ? 'layers' : 'help-circle'} size={13} />{g.titel} · {g.zeilen.length}
                  </th>
                </tr>
                {g.zeilen.map((z) => <Zeile key={z.deviceId} z={z} onOpen={onOpen} />)}
              </tbody>
            ))}
          </table>
        )}
      </div>
    </section>
  );
}
