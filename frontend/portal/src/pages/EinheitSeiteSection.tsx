import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  type AnlagensteuerungListe,
  type AnlagensteuerungVerlauf,
  type Device,
  type ErzeugerVorgabe,
  type Erzeugungseinheit,
  type NetzVermarktung,
  type Site,
} from '../api';
import { GeraetBrotkrume } from '../components/GeraetBrotkrume';
import { GeraetBuehne } from '../components/GeraetBuehne';
import { GeraetRahmen, type BausteinInhalt, type MenueEintrag } from '../components/GeraetRahmen';
import { MiniBarSpark, type MiniMark } from '../components/MiniChart';
import { EinheitForm } from '../components/NetzVermarktungFormen';
import { Recht } from '../components/Recht';
import { EmptyState, TextSkeleton } from '../components/States';
import '../components/GeraetHeute.css';
import {
  alarmZeilen,
  einheitAblesung,
  einheitHeute,
  einheitSeite,
  energieText,
  vorgabenZeilen,
  type AktivitaetZeile,
  type SeitenZeile,
} from '../einheitSeite';
import { erzeugerVorgabenApi } from '../erzeugerVorgabenApi';
import { findeEinheit } from '../erzeugungseinheit';
import { anlagensteuerungGeraetId } from '../geraetAdresse';
import { meldungenApi, type Meldung } from '../meldungenApi';
import { anlageRoute, geraetSeiteHash, hashForRoute } from '../nav';
import { LIST_POLL_MS } from '../pollCadence';
import { useAnlagensteuerungWerte } from '../useAnlagensteuerung';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { verlaufHash } from '../verlauf';
import { einheitPunkt } from '../anlagensteuerung';
import './GeraetSeite.css';

/**
 * Die SEITE EINER ERZEUGUNGSEINHEIT hinter einer Anlagensteuerung (`…/geraet/{ref}/as-<Entität>~te-<n>`, Konzept
 * „Ein Gerät, ein Eintrag“, GE-3, Variante d1): ein Wechselrichter oder Motor mit eigener Seite im Geräteseiten-
 * Rahmen — Kopf (Name, Typ, Nennleistung, Zustand), Jetzt (Ist, Soll, folgt, Begrenzung), Heute (Ist je
 * Viertelstunde mit Soll in der Ablesung, Energie aus dem Zählerstand `t_e`), Aktivität (Vorgaben dieser Einheit und
 * der ganzen Anlage, Alarme je Einheit) und Gerät &amp; Verbindung (Typ, Nennleistung, MaStR, Block im Bild,
 * „Gelesen über Anlagensteuerung ›“).
 *
 * Alle Werte kommen über die Routen der STEUERUNG — die Einheit hat keine eigene Komponente, keine Register und keine
 * Steuerung; darum fehlen die Bausteine „Steuerung“ und „Technik &amp; Diagnose“ still (S5). Bearbeiten ist das
 * vorhandene `PUT …/anlagensteuerung/einheiten/{teNr}` (Bezeichnung, MaStR-Nummer). Jeder Nebenabruf ist fail-soft:
 * fällt er aus, fällt sein Baustein weg. Die Regeln stehen in `einheitSeite.ts`.
 */
export function EinheitSeiteSection({
  site,
  boxRef,
  entityId,
  teNr,
  devices,
}: {
  site: Site;
  boxRef: string;
  entityId: string;
  teNr: number;
  devices?: Device[];
}) {
  const [liste, setListe] = useState<AnlagensteuerungListe | null | 'fehler'>(null);
  const [nv, setNv] = useState<NetzVermarktung | null>(null);
  const [verlauf, setVerlauf] = useState<AnlagensteuerungVerlauf | null | 'fehler'>(null);
  const [vorgaben, setVorgaben] = useState<ErzeugerVorgabe[] | null>(null);
  const [meldungen, setMeldungen] = useState<Meldung[] | null>(null);
  const [bearbeiten, setBearbeiten] = useState(false);
  const [notiz, setNotiz] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let aktiv = true;
    setListe(null);
    setNv(null);
    setBearbeiten(false);
    setNotiz(null);
    api.anlagensteuerungen(site.id).then(
      (l) => aktiv && setListe(l ?? 'fehler'),
      () => aktiv && setListe('fehler'),
    );
    api.netzVermarktung(site.id).then(
      (v) => aktiv && setNv(v),
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
  }, [site.id, entityId, teNr]);

  const treffer = liste && liste !== 'fehler' ? findeEinheit(liste, entityId, teNr) : null;
  const geraetId = treffer?.steuerung.geraet_id ?? null;
  const werte = useAnlagensteuerungWerte(geraetId ? site.id : null, geraetId);
  useEffect(() => setNow(Date.now()), [werte]);

  // Heute, Vorgaben und Meldungen im Listen-Takt: Viertelstunden und Vorgaben ändern sich nicht sekündlich.
  const ladeNeben = useCallback(() => {
    if (!geraetId) return;
    api.anlagensteuerungVerlauf(site.id, geraetId, 'day').then(
      (v) => setVerlauf(v),
      () => setVerlauf((alt) => (alt && alt !== 'fehler' ? alt : 'fehler')),
    );
    erzeugerVorgabenApi.chronik(site.id).then(
      (c) => setVorgaben(c.vorgaben),
      () => undefined,
    );
    Promise.all([meldungenApi.jetzt(), meldungenApi.verlauf().catch(() => [] as Meldung[])]).then(
      ([offen, alt]) => setMeldungen([...offen, ...alt]),
      () => undefined,
    );
  }, [site.id, geraetId]);
  useEffect(() => {
    setVerlauf(null);
    setVorgaben(null);
    setMeldungen(null);
    ladeNeben();
  }, [ladeNeben]);
  useFreshnessPoll(ladeNeben, LIST_POLL_MS, geraetId != null);

  const anlageHref = hashForRoute(anlageRoute(site.id));
  const komponentenHref = hashForRoute(anlageRoute(site.id, 'modell'));
  const lesendeBox = treffer?.steuerung.datenquelle?.box_id
    ? (devices ?? []).find((d) => d.id === treffer.steuerung.datenquelle?.box_id) ?? null
    : (devices ?? []).find((d) => d.externalRef === boxRef) ?? null;
  const boxName = lesendeBox ? lesendeBox.name?.trim() || lesendeBox.externalRef : null;

  const view = useMemo(
    () =>
      treffer
        ? einheitSeite({
            siteId: site.id,
            ref: boxRef,
            steuerung: treffer.steuerung,
            einheit: treffer.einheit,
            werte,
            nv,
            boxName,
            now: new Date(now),
          })
        : null,
    [treffer, site.id, boxRef, werte, nv, boxName, now],
  );

  if (liste === null) {
    return (
      <div className="vp-geraet">
        <GeraetBrotkrume anlageHref={anlageHref} komponentenHref={komponentenHref} titel="Erzeugungseinheit" />
        <Card padding="lg" radius="lg">
          <TextSkeleton lines={6} />
        </Card>
      </div>
    );
  }
  if (!treffer || !view) {
    return (
      <div className="vp-geraet">
        <GeraetBrotkrume anlageHref={anlageHref} komponentenHref={komponentenHref} titel="Erzeugungseinheit" />
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="cpu"
            category="primary"
            title="Diese Einheit ist hier nicht (mehr) zu finden"
            description={
              liste === 'fehler'
                ? 'Die Anlagensteuerung dieser Anlage konnte nicht geladen werden.'
                : `An dieser Anlagensteuerung ist keine Einheit ${teNr} eingetragen.`
            }
          />
        </Card>
      </div>
    );
  }

  const { steuerung, einheit } = treffer;
  const steuerungHref = geraetSeiteHash(site.id, boxRef, anlagensteuerungGeraetId(steuerung.entity_id));
  const steuerungName = steuerung.bezeichnung ?? 'Anlagensteuerung';
  const ersetzeEinheit = (e: Erzeugungseinheit) =>
    setListe((alt) =>
      alt && alt !== 'fehler'
        ? {
            ...alt,
            steuerungen: alt.steuerungen.map((s) =>
              s.geraet_id === steuerung.geraet_id
                ? { ...s, einheiten: s.einheiten.map((x) => (x.te_nr === e.te_nr ? { ...x, ...e } : x)) }
                : s,
            ),
          }
        : alt,
    );
  const oeffneBearbeiten = () => {
    setNotiz(null);
    setBearbeiten(true);
  };
  const menue: MenueEintrag[] = [
    { key: 'bearbeiten', label: 'Bearbeiten', icon: 'pencil', onClick: oeffneBearbeiten, recht: 'geraet.einrichten' },
  ];

  const buehne: BausteinInhalt = {
    inhalt: (
      <GeraetBuehne
        zahl={view.ist ? { zahl: view.ist, einheit: 'kW', wort: 'Ist', ton: null, key: 'ist' } : null}
        satz={view.satz}
        satzTon={view.satzTon}
        zeilen={view.zeilen}
      />
    ),
  };

  const ist = einheitPunkt(einheit.te_nr, 't_p_ist_w');
  const soll = einheitPunkt(einheit.te_nr, 't_p_soll_w');
  const heute: BausteinInhalt | null =
    verlauf && verlauf !== 'fehler'
      ? {
          titel: 'Heute · Ist-Leistung',
          kopfRechts: (
            <a
              href={verlaufHash(
                site.id,
                [
                  { entityId: `erzeuger-${steuerung.geraet_id}`, channel: ist },
                  { entityId: `erzeuger-${steuerung.geraet_id}`, channel: soll },
                ],
                'day',
              )}
            >
              Verlauf <Icon name="chevron-right" size={14} />
            </a>
          ),
          inhalt: <EinheitHeuteStreifen verlauf={verlauf} geraetId={steuerung.geraet_id} teNr={einheit.te_nr} now={now} />,
        }
      : null;

  const aktivitaetZeilen: AktivitaetZeile[] = [
    ...alarmZeilen(meldungen ?? [], steuerung.geraet_id, einheit.te_nr, new Date(now)),
    ...vorgabenZeilen(vorgaben ?? [], steuerung.geraet_id, einheit.te_nr, new Date(now)),
  ];
  const aktivitaet: BausteinInhalt | null =
    vorgaben == null && meldungen == null
      ? null
      : {
          inhalt:
            aktivitaetZeilen.length === 0 ? (
              <p className="vp-note" data-testid="einheit-aktivitaet-leer">
                In den letzten sieben Tagen keine Vorgabe und keine Meldung für {view.stand.name}.
              </p>
            ) : (
              <dl className="vp-geraet-kv" data-testid="einheit-aktivitaet">
                {aktivitaetZeilen.map((z) => (
                  <div key={z.key} className={z.art === 'alarm' && z.laeuft ? 'is-warn' : undefined}>
                    <dt>{z.wann}</dt>
                    <dd>
                      <span>{z.titel}</span>
                      {z.sub && <small>{z.sub}</small>}
                    </dd>
                  </div>
                ))}
              </dl>
            ),
        };

  return (
    <div className="vp-geraet">
      <GeraetRahmen
        testId="geraet-rahmen"
        geraetKey={`${site.id}:${steuerung.entity_id}:te-${einheit.te_nr}`}
        brotkrume={{ anlageHref, komponentenHref }}
        kopf={{
          titel: view.kopf.titel,
          typ: view.kopf.typ,
          modell: view.kopf.modell,
          symbol: { icon: view.stand.symbol, farbe: 'pv' },
          zustand: view.kopf.zustand,
          frische: view.stand.gelesenAm,
          abzeichen: (
            <>
              <a className="vp-kern-abzeichen" href={steuerungHref} data-testid="einheit-ueber-steuerung">
                <Icon name="cpu" size={13} /> über {steuerungName}
              </a>
              <span className="vp-kern-abzeichen">
                <Icon name="activity" size={13} /> nur Messung
              </span>
            </>
          ),
        }}
        menue={menue}
        kopfAktion={
          <Recht aktion="geraet.einrichten">
            <button type="button" className="vp-btn vp-btn--outline vp-btn--md" onClick={oeffneBearbeiten}>
              <Icon name="pencil" size={15} /> Bearbeiten
            </button>
          </Recht>
        }
        unterKopf={
          <>
            {notiz && (
              <div className="vp-alert vp-alert-ok" role="status">
                <Icon name="check" size={16} /> {notiz}
              </div>
            )}
            {bearbeiten && (
              <Card padding="lg" radius="lg">
                <EinheitForm
                  geraetId={steuerung.geraet_id}
                  einheit={einheit}
                  onCancel={() => setBearbeiten(false)}
                  onSaved={(e) => {
                    ersetzeEinheit(e);
                    setBearbeiten(false);
                    setNotiz('Gespeichert. Nummer und Messreihe der Einheit bleiben dieselben.');
                  }}
                />
              </Card>
            )}
          </>
        }
        veraltet={view.kopf.zustand.ton === 'warn'}
        bausteine={{ buehne, heute, aktivitaet }}
        details={{
          kurz: [view.stand.unter, `über ${steuerungName}`].join(' · '),
          inhalt: <SeitenZeilen zeilen={view.details} />,
        }}
      />
    </div>
  );
}

function SeitenZeilen({ zeilen }: { zeilen: SeitenZeile[] }) {
  return (
    <dl className="vp-geraet-kv" data-testid="einheit-details">
      {zeilen.map((z) => (
        <div key={z.label}>
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
  );
}

/**
 * „Heute“ einer Einheit: der Streifen der Ist-Leistung je Viertelstunde im Mini-Chart-System (wie `GeraetHeute`),
 * der Sollwert in der Ablesung und darunter die Energie heute aus dem Zählerstand `t_e`.
 */
function EinheitHeuteStreifen({
  verlauf,
  geraetId,
  teNr,
  now,
}: {
  verlauf: AnlagensteuerungVerlauf;
  geraetId: string;
  teNr: number;
  now: number;
}) {
  const h = useMemo(() => einheitHeute(verlauf, geraetId, teNr, now), [verlauf, geraetId, teNr, now]);
  const energie = (
    <p className="vp-heute-legende" data-testid="einheit-energie-heute">
      Energie heute <b>{energieText(h.energie)}</b>
      {h.energie.grund ? ` · ${h.energie.grund}` : ''}
    </p>
  );
  if (h.view.leer) {
    return (
      <>
        <p className="vp-heute-leer">Heute noch keine Messwerte.</p>
        {energie}
      </>
    );
  }
  const marken: MiniMark[] = h.view.jetztKey ? [{ key: h.view.jetztKey, label: 'jetzt' }] : [];
  return (
    <div className="vp-heute is-pv" data-testid="geraet-heute">
      <MiniBarSpark
        points={h.view.punkte}
        size="streifen"
        ariaLabel={`Tagesverlauf Ist-Leistung${h.view.satz ? `: ${h.view.satz}` : ''}`}
        readout={(p) => einheitAblesung(p, h.soll)}
        caption={h.view.satz}
        marks={marken}
      />
      <div className="vp-heute-achse" aria-hidden="true">
        {h.view.achse.map((t) => (
          <span
            key={t.label}
            className={t.anteil === 0 ? 'is-anfang' : t.anteil === 1 ? 'is-ende' : undefined}
            style={{ left: `${(t.anteil * 100).toFixed(2)}%` }}
          >
            {t.label}
          </span>
        ))}
      </div>
      {energie}
    </div>
  );
}
