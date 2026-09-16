import { Recht } from './Recht';
/**
 * Die GERÄTESEITE ergänzt (UEMS AP-04 IP-12): Karte „Gerät“, Karte
 * „Einstellungen“ mit „Ändern ab <Zeitpunkt>“ und die Messkanäle mit
 * „speist MS-06 (führend)“ — die Herkunftskette von der Technik-Seite aus
 * (Mockup K1). Sie steht in der Sektion „Komponenten — Was misst und steuert
 * es?“, direkt über dem Änderungsprotokoll desselben Geräts.
 *
 * Seit AP-04 IP-14 trägt jeder Messwert, den noch keine Messstelle FÜHREND liest,
 * den Einstieg „Als Messstelle verwenden“ (§5.2): er öffnet denselben Dialog wie
 * die Messstellen-Seite — nur andersherum, mit vorbelegtem Messwert. Gewählt wird
 * dann die Messstellen-Größe, die ihn lesen soll; was ihn nicht lesen kann, steht
 * grau in der Liste und sagt warum.
 *
 * Die Geräteseite kennt ihre KOMPONENTEN; Gerät, Einstellungen und Protokoll
 * hängen am GERÄT — der Weg dazwischen ist derselbe wie beim Protokoll
 * (`geraetZuKomponenten`). Gleichzeitige gleiche Abrufe teilt `request`.
 *
 * ⚠ Ohne auflösbares Gerät rendert sie GAR NICHTS — dieselbe Regel wie das
 * Protokoll und der BMS-Block: lieber kein Kasten als einer, der erklärt, dass
 * er nichts weiß.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  type EinstellungEingetragen,
  type GeraetEinstellungen,
  type Messkanal,
  type UemsGeraet,
} from '../api';
import {
  einstellungGruppen,
  eingetragenText,
  geraetKarte,
  kanalZeile,
  SPEIST_KEINE,
  type EinstellungGruppe,
  type Zeile,
} from '../geraetEinstellungen';
import { ALS_MESSSTELLE_VERWENDEN } from '../quelleBinden';
import { geraetZuKomponenten } from '../uemsProtokoll';
import { EinstellungAendernDialog, type AenderungZiel } from './EinstellungAendernDialog';
import { ZaehlerwechselVerlauf } from './ZaehlerwechselVerlauf';
import { ZaehlerwechselDialog } from './ZaehlerwechselDialog';
import { ControllerwechselDialog } from './ControllerwechselDialog';
import { QuelleBindenDialog, type QuelleBindenZiel } from './QuelleBindenDialog';
import './GeraetHerkunft.css';

export interface HerkunftKomponente {
  entityId: string;
  label: string;
}

interface KanalListe {
  entityId: string;
  label: string;
  kanaele: Messkanal[];
}

export function GeraetHerkunft({
  siteId,
  komponenten,
  jetzt,
}: {
  siteId: string;
  /** Die Komponenten dieser Geräteseite — über sie wird das Gerät gefunden. */
  komponenten: readonly HerkunftKomponente[];
  /** Die Uhr der Seite (Tests); ohne sie „jetzt“. */
  jetzt?: string;
}) {
  const [geraete, setGeraete] = useState<UemsGeraet[] | null>(null);
  const [kanaele, setKanaele] = useState<KanalListe[]>([]);
  const [einstellungen, setEinstellungen] = useState<GeraetEinstellungen | 'fehler' | null>(null);
  const [stand, setStand] = useState(0);
  const [ziel, setZiel] = useState<AenderungZiel | null>(null);
  const [notiz, setNotiz] = useState<string | null>(null);
  // UEMS AP-04 IP-14: „Als Messstelle verwenden“ öffnet denselben Dialog mit vorbelegtem Messwert.
  const [wechsel, setWechsel] = useState<UemsGeraet | null>(null);
  const [verwenden, setVerwenden] = useState<QuelleBindenZiel | null>(null);
  const schluessel = komponenten.map((k) => k.entityId).join(',');

  useEffect(() => {
    let aktiv = true;
    setGeraete(null);
    setKanaele([]);
    if (!siteId || !schluessel) return () => undefined;
    api
      .uemsGeraete(siteId)
      .then((a) => aktiv && setGeraete(a.geraete))
      .catch(() => aktiv && setGeraete([]));
    void Promise.all(
      komponenten.map((k) =>
        api
          .komponenteMesskanaele(siteId, k.entityId)
          .then((l): KanalListe => ({ entityId: k.entityId, label: k.label, kanaele: l.messkanaele }))
          .catch(() => null),
      ),
    ).then((listen) => aktiv && setKanaele(listen.filter((l): l is KanalListe => l !== null)));
    return () => {
      aktiv = false;
    };
    // `komponenten` wechselt mit `schluessel`; die Namen allein laden nicht neu. `stand` steigt
    // nach einem Eintrag — dann sagt „speist …“ wieder, was der Server weiß (AP-04 IP-14).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, schluessel, stand]);

  const geraet = geraetZuKomponenten(geraete, komponenten.map((k) => k.entityId)) ?? wechsel;
  const geraetId = geraet?.id ?? null;

  useEffect(() => {
    let aktiv = true;
    setEinstellungen(null);
    if (!geraetId) return () => undefined;
    api
      .geraetEinstellungen(geraetId)
      .then((e) => aktiv && setEinstellungen(e))
      .catch(() => aktiv && setEinstellungen('fehler'));
    return () => {
      aktiv = false;
    };
  }, [geraetId, stand]);

  const uhr = jetzt ?? new Date().toISOString();
  const komponentenNamen = useMemo(() => new Map(komponenten.map((k) => [k.entityId, k.label])), [komponenten]);
  const kanalNamen = useMemo(
    () =>
      new Map(
        kanaele.flatMap((l) => l.kanaele.map((k): [string, string] => [`${l.entityId}|${k.kanal}`, kanalZeile(k).name])),
      ),
    [kanaele],
  );

  if (!geraet) return null;

  const karte = geraetKarte(geraet, {
    komponenten: komponentenNamen,
    messstellen: kanaele.flatMap((l) => l.kanaele.flatMap((k) => (k.speist ?? []).map((s) => s.messstelle))),
  });
  const gruppen =
    einstellungen && einstellungen !== 'fehler'
      ? einstellungGruppen(einstellungen, uhr, { komponenten: komponentenNamen, kanaele: kanalNamen })
      : [];
  const historie = einstellungen && einstellungen !== 'fehler' ? einstellungen.historie : [];
  const mitKanaelen = kanaele.filter((l) => l.kanaele.length > 0);

  const eingetragen = (e: EinstellungEingetragen) => {
    setZiel(null);
    setNotiz(eingetragenText(e));
    setStand((n) => n + 1);
  };

  return (
    <>
      <section className="vp-rahmen-block vp-gh" data-testid="geraet-karte" aria-labelledby="vp-gh-geraet">
        <h3 id="vp-gh-geraet">
          <Icon name="cpu" size={14} />
          Gerät
        </h3>
        <p className="vp-gh-titel">
          <b>{karte.titel}</b>
          {karte.kennzeichen && <span className="vp-pill vp-pill-info">{karte.kennzeichen}</span>}
        </p>
        <Zeilen zeilen={karte.zeilen} />
        {geraet.geraeteart === 'zaehler' && !geraet.teile?.length && (
          <Recht aktion="geraet.einrichten"><Recht aktion="messstelle.quelle"><Button variant="ghost" size="sm" onClick={event => { event.currentTarget.focus(); setWechsel(geraet); }}>Zähler wechseln</Button></Recht></Recht>
        )}
        {geraet.geraeteart === 'controller' && !geraet.ausgebaut_am && (
          <Recht aktion="geraet.einrichten"><Recht aktion="messstelle.quelle"><Button variant="ghost" size="sm" onClick={event => { event.currentTarget.focus(); setWechsel(geraet); }}>Controller austauschen</Button></Recht></Recht>
        )}
        {karte.karten.length > 0 && (
          <>
            <h4 className="vp-gh-unter">Energiekarten</h4>
            <Zeilen zeilen={karte.karten} />
          </>
        )}
        {geraet.geraeteart === 'zaehler' && <ZaehlerwechselVerlauf anlageId={siteId} komponenten={komponenten.map(k => k.entityId)} stand={stand} />}
        {karte.vorgaenger.length > 0 && (
          <>
            <h4 className="vp-gh-unter">Vorgänger</h4>
            <Zeilen zeilen={karte.vorgaenger} testId="geraet-vorgaenger" />
          </>
        )}
      </section>

      <section className="vp-rahmen-block vp-gh" data-testid="geraet-einstellungen" aria-labelledby="vp-gh-einst">
        <h3 id="vp-gh-einst">
          <Icon name="sliders" size={14} />
          Einstellungen
        </h3>
        {einstellungen === null ? (
          <p role="status" className="vp-note">
            Einstellungen werden geladen …
          </p>
        ) : einstellungen === 'fehler' ? (
          <p className="vp-note">Die Einstellungen dieses Geräts konnten gerade nicht geladen werden.</p>
        ) : gruppen.length === 0 ? (
          <p className="vp-note">Für dieses Gerät ist keine Einstellung erfasst — etwa ein Wandlerverhältnis.</p>
        ) : (
          <ul className="vp-gh-liste">
            {gruppen.map((g) => (
              <EinstellungZeile
                key={g.schluessel}
                gruppe={g}
                onAendern={() =>
                  setZiel({
                    art: g.art,
                    entityId: g.entityId,
                    kanal: g.kanal,
                    bezug: g.quelle ? `${g.titel} · ${g.quelle}` : g.titel,
                  })
                }
              />
            ))}
          </ul>
        )}
        {einstellungen !== null && einstellungen !== 'fehler' && (
          <div className="vp-gh-fuss">
            <Recht aktion="messstelle.quelle"><Button
              variant="ghost"
              size="sm"
              iconLeft={<Icon name="plus" size={14} />}
              onClick={() => setZiel({ art: null, entityId: null, kanal: null, bezug: `Für ${karte.titel}` })}
            >
              {gruppen.length === 0 ? 'Einstellung eintragen' : 'Weitere Einstellung eintragen'}
            </Button></Recht>
          </div>
        )}
        {notiz && (
          <p className="vp-gh-notiz" role="status">
            {notiz}
          </p>
        )}
      </section>

      {mitKanaelen.length > 0 && (
        <section className="vp-rahmen-block vp-gh" data-testid="geraet-messkanaele" aria-labelledby="vp-gh-kanaele">
          <h3 id="vp-gh-kanaele">
            <Icon name="activity" size={14} />
            Messkanäle
          </h3>
          {mitKanaelen.map((l) => (
            <div key={l.entityId}>
              {mitKanaelen.length > 1 && <h4 className="vp-gh-unter">{l.label}</h4>}
              <ul className="vp-gh-liste">
                {l.kanaele.map((k) => {
                  const z = kanalZeile(k, l.entityId);
                  return (
                    <li key={z.schluessel} className="vp-gh-kanal" data-testid="geraet-kanal">
                      <div className="vp-gh-zeile">
                        <div className="tx">
                          <span className="nm">{z.name}</span>
                          {(z.detail || z.abgewaehlt) && (
                            <span className="s">
                              {[z.detail, z.abgewaehlt ? 'wird gerade nicht aufgezeichnet' : null]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="vp-gh-speist">
                        {z.speist.length === 0 ? (
                          <span className="vp-gh-speist-keine">{SPEIST_KEINE}</span>
                        ) : (
                          z.speist.map((s) => (
                            <span key={s.text} className={s.fuehrend ? 'vp-gh-marke is-fuehrend' : 'vp-gh-marke'}>
                              {s.text}
                            </span>
                          ))
                        )}
                      </p>
                      {/* §5.2: „dieselbe Bindung kann von der Komponente aus angestoßen werden“ —
                          angeboten nur, wo noch keine Messstelle FÜHREND liest; ein zweiter
                          führender Griff wäre ein Zählerwechsel (IP-18), kein Binden. */}
                      {!k.speist?.some((sp) => sp.rolle === 'fuehrend') && (
                        <Recht aktion="messstelle.bearbeiten"><button
                          type="button"
                          className="vp-gh-verwenden"
                          data-testid="als-messstelle-verwenden"
                          onClick={() => setVerwenden({ art: 'messwert', anlageId: siteId, entityId: l.entityId, kanal: k })}
                        >
                          {ALS_MESSSTELLE_VERWENDEN}
                        </button></Recht>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      )}

      {wechsel?.geraeteart === 'controller' && <ControllerwechselDialog geraet={wechsel} anlageId={siteId} jetzt={jetzt}
        onClose={() => setWechsel(null)} onGewechselt={() => setStand(n => n + 1)} />}
      {wechsel && wechsel.geraeteart !== 'controller' && <ZaehlerwechselDialog ziel={{ art: 'geraet', geraet: wechsel, anlageId: siteId }} jetzt={jetzt}
        onClose={() => setWechsel(null)} onGewechselt={() => setStand(n => n + 1)} />}
      {verwenden && (
        <QuelleBindenDialog
          open
          rolle="fuehrend"
          ziel={verwenden}
          jetzt={jetzt}
          onClose={() => setVerwenden(null)}
          onGebunden={() => setStand((n) => n + 1)}
        />
      )}
      <EinstellungAendernDialog
        geraetId={geraet.id}
        ziel={ziel}
        historie={historie}
        beginn={geraet.eingebaut_am ?? geraet.komponenten[0]?.gueltig_ab ?? uhr}
        jetzt={uhr}
        onClose={() => setZiel(null)}
        onEingetragen={eingetragen}
      />
    </>
  );
}

function Zeilen({ zeilen, testId }: { zeilen: Zeile[]; testId?: string }) {
  return (
    <dl className="vp-geraet-kv" data-testid={testId}>
      {zeilen.map((z) => (
        <div key={`${z.label}|${z.wert}`}>
          <dt>{z.label}</dt>
          <dd>
            <span>{z.wert}</span>
            {z.detail && <small>{z.detail}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function EinstellungZeile({ gruppe: g, onAendern }: { gruppe: EinstellungGruppe; onAendern: () => void }) {
  return (
    <li className="vp-gh-einst" data-testid="geraet-einstellung">
      <div className="vp-gh-zeile">
        <div className="tx">
          <span className="nm">
            {g.titel}
            {g.quelle && <span className="vp-gh-quelle"> · {g.quelle}</span>}
          </span>
          <span className="s">{g.detail}</span>
          {g.geplant && <span className="s vp-gh-geplant">{g.geplant}</span>}
        </div>
        <span className="val">{g.wert}</span>
      </div>
      <div className="vp-gh-akt">
        <Recht aktion="messstelle.quelle"><Button variant="outline" size="sm" onClick={onAendern}>
          Ändern ab …
        </Button></Recht>
      </div>
      <details className="vp-gh-historie">
        <summary>
          Historie ({g.historie.length} {g.historie.length === 1 ? 'Fassung' : 'Fassungen'})
        </summary>
        <ol>
          {g.historie.map((h) => (
            <li key={h.id} className={`is-${h.status}`}>
              <span className="vp-gh-h-kopf">
                <b>{h.wert}</b>
                <span>{h.zeitraum}</span>
                {h.marken.map((m) => (
                  <span key={m} className="vp-gh-h-marke">
                    {m}
                  </span>
                ))}
              </span>
              {h.zeilen.map((z) => (
                <small key={z}>{z}</small>
              ))}
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}
