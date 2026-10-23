/**
 * Der Abschnitt „ANBINDUNG" und sein Verlauf auf der Geräteseite (Konzept „Ein Gerät, ein Eintrag", GE-2).
 *
 * Diese Datei RENDERT nur: was eine Zeile sagt und wohin sie führt, legt `geraetAnbindung.ts` fest. Der Box-Wechsel
 * öffnet den vorhandenen `DatenquelleWechselDialog` beim Wirt — es gibt keinen zweiten.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import type { Device, UemsDatenquelle } from '../api';
import { anbindungApi, verlaufZeilen, type Anbindung, type VerlaufZeile } from '../geraetAnbindung';
import { Recht } from './Recht';
import './GeraetAnbindung.css';

export function AnbindungAbschnitt({ anbindung, onWechseln }: { anbindung: Anbindung; onWechseln: () => void }) {
  const w = anbindung.wechsel;
  return (
    <section className="vp-rahmen-block vp-anbindung" data-testid="geraet-anbindung">
      <h3>
        <Icon name="link" size={14} />
        {anbindung.titel}
      </h3>
      <dl className="vp-geraet-kv">
        {anbindung.zeilen.map((z) => (
          <div key={z.label} className={z.ton && z.ton !== 'ok' ? `is-${z.ton}` : undefined}>
            <dt>{z.label}</dt>
            <dd>
              {z.href ? (
                <a href={z.href}>
                  {z.wert} <Icon name="chevron-right" size={13} />
                </a>
              ) : (
                <span>{z.wert}</span>
              )}
              {z.detail && <small>{z.detail}</small>}
            </dd>
          </div>
        ))}
      </dl>
      {anbindung.hinweis && <p className="vp-note">{anbindung.hinweis}</p>}
      <div className="vp-anbindung-fuss">
        {w?.art === 'dialog' && (
          <Recht aktion="datenquelle.zustaendigkeit">
            <button type="button" className="vp-btn vp-btn--outline vp-btn--sm" onClick={onWechseln}>
              Zuständige Box wechseln
            </button>
          </Recht>
        )}
        {w?.art === 'gemeinsam' && (
          <small data-testid="anbindung-steuerquelle">
            <a href={w.href}>{w.text}</a>
          </small>
        )}
        {w?.art === 'satz' && <small data-testid="anbindung-steuerquelle">{w.text}</small>}
        <small className="vp-anbindung-kennung">{anbindung.kennung}</small>
      </div>
    </section>
  );
}

/**
 * Technik & Diagnose › „Verlauf der Anbindung": das Protokoll der Wege dieses Geräts
 * (`GET …/data-sources/{id}/history`), jüngster Eintrag zuerst. Fällt der Abruf aus, sagt der Teil das —
 * eine leere Liste hieße „nie etwas geändert".
 */
export function AnbindungVerlauf({ siteId, quellen, devices }: {
  siteId: string;
  quellen: readonly UemsDatenquelle[];
  devices: readonly Device[];
}) {
  // Neu gelesen wird, wenn ein Weg dazukommt oder seine Zuständigkeit sich ändert (etwa nach „Box wechseln").
  const schluessel = quellen.map((q) => [q.id, q.zustaendige_box?.id ?? '', q.zeitraeume.length].join(':')).join(',');
  const [stand, setStand] = useState<{ schluessel: string; je: Map<string, VerlaufZeile[] | null> } | null>(null);

  useEffect(() => {
    let aktiv = true;
    const ids = schluessel ? schluessel.split(',').map((s) => s.split(':')[0]) : [];
    void Promise.all(ids.map((id) => anbindungApi.verlauf(siteId, id).then((a) => a.eintraege, () => null)))
      .then((alle) => {
        if (!aktiv) return;
        setStand({
          schluessel,
          je: new Map(ids.map((id, i) => [id, alle[i] ? verlaufZeilen(alle[i]!, devices) : null])),
        });
      });
    return () => {
      aktiv = false;
    };
    // `devices` nennt nur Boxnamen - ein neuer Abruf je Geräteliste wäre Lärm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, schluessel]);

  if (!stand || stand.schluessel !== schluessel) return <p className="vp-note">Der Verlauf wird geladen …</p>;
  const mehrere = quellen.length > 1;
  return (
    <div className="vp-anbindung-verlauf" data-testid="anbindung-verlauf">
      {quellen.map((q) => {
        const zeilen = stand.je.get(q.id);
        return (
          <section key={q.id}>
            {mehrere && <h4>Kennung {q.kennzeichen}</h4>}
            {zeilen == null ? (
              <p className="vp-note">Der Verlauf dieser Anbindung ließ sich gerade nicht laden.</p>
            ) : zeilen.length === 0 ? (
              <p className="vp-note">An dieser Anbindung wurde noch nichts geändert.</p>
            ) : (
              <ol>
                {zeilen.map((z) => (
                  <li key={z.id}>
                    <time>{z.zeit}</time>
                    <span>{z.text}</span>
                    {z.detail && <small>{z.detail}</small>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        );
      })}
    </div>
  );
}
