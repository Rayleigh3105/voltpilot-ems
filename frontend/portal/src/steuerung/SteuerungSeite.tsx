/**
 * DIE STEUERUNG (Konzept `docs/konzepte/steuerung`, Entscheidungen E1–E9 = A).
 *
 * Eine Seite, drei Reiter - Geräte · Laden · Regeln - und über allen der
 * Kopf „Steuerung“ mit dem Automatik-Knopf. Jedes Gerät, das in der Anlage
 * verbunden ist, steht hier von selbst; die Steuerung legt nichts an und
 * entscheidet nur, was es tut: Aus · Smart · Ein.
 *
 * Die Seite rechnet nichts selbst: das Bild kommt aus `seite.ts`/`bild.ts`,
 * die Schreibwege sind die bestehenden (Steuerart, Handeingriff, Speicher,
 * Pause, Betriebsmodell, Reihenfolge, Ladepark, Regeln der Box).
 */
import { liste } from './liste';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Site } from '../api';
import type { BereichTab } from '../anlageNav';
import type { AnlagenSub } from '../nav';
import { consumersApi } from '../consumers/consumersApi';
import { customerFlowApi } from '../flows/flowsApi';
import { buildGuidedFlow } from '../flows/guidedBuilder';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { LIST_POLL_MS } from '../pollCadence';
import type { SteuerartWunsch } from '../steuerartDialog';
import { Blatt } from './Blatt';
import {
  AnbindenBlatt,
  GeraetBlatt,
  NegativBlatt,
  NeuBlatt,
  P14aBlatt,
  PauseBlatt,
  SpeicherBlatt,
  VorrangBlatt,
  dreiWorte,
  type Aktionen,
  type BlattKontext,
} from './Blaetter';
import { SPEICHER, reihenfolgeRumpf, type GeraetBild } from './bild';
import { GeraeteReiter } from './GeraeteReiter';
import { Ic } from './Ic';
import { FahrzeugBlatt, LadenReiter, RahmenBlatt, ZielBlatt } from './LadenReiter';
import type { LadeQuelle } from './laden';
import { nurMessenKey, vorschlag } from './neu';
import { RegelBlatt, RegelnReiter } from './RegelnReiter';
import { bezugAus, greift, neuerEntwurf, regelKarten, regelZiele, VORLAGEN, zuGuided, type RegelEntwurf, type RegelKarte } from './regeln';
import { seitenBild, type BlattZustand } from './seite';
import { useSteuerungDaten } from './useSteuerungDaten';
import { spannen, uhrTag, uhrVon } from './zeit';
import './steuerung.css';

export type SteuerungReiter = 'steuerung' | 'laden' | 'regeln';

export interface SteuerungSeiteProps {
  site: Site;
  reiter: SteuerungReiter;
  tabs: BereichTab[];
  onOpenSub: (sub: AnlagenSub) => void;
}

const fehlerText = (e: unknown, sonst: string) =>
  e instanceof ApiError || e instanceof Error ? e.message || sonst : sonst;

export function SteuerungSeite({ site, reiter, tabs, onOpenSub }: SteuerungSeiteProps) {
  const { daten, geladen, fehler, neuLaden, setze } = useSteuerungDaten(site);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), LIST_POLL_MS);
    return () => window.clearInterval(t);
  }, []);
  // Jede neue Antwort ist auch ein neues „jetzt“.
  useEffect(() => setNow(new Date()), [daten.live, daten.status]);
  const bild = useMemo(() => seitenBild(daten, now), [daten, now]);
  const [blatt, setBlatt] = useState<BlattZustand | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; warn?: boolean } | null>(null);
  const [reoStart, setReoStart] = useState<string | null>(null);
  const toastTimer = useRef<number>(0);
  const meldung = useCallback((text: string, warn = false) => {
    setToast({ text, warn });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const flowApi = useMemo(() => customerFlowApi(site.id), [site.id]);
  const bezug = useMemo(() => bezugAus(daten.editorEntities), [daten.editorEntities]);
  const namen = useMemo(() => {
    const out: Record<string, string> = {};
    for (const e of liste(daten.editorEntities)) out[e.id] = e.label;
    for (const g of bild.geraete) out[g.id] = g.name;
    return out;
  }, [daten.editorEntities, bild.geraete]);
  const ziele = useMemo(() => regelZiele(bild.geraete.filter((g) => !g.ohneAuftrag || g.schreibbar), daten.editorEntities), [bild.geraete, daten.editorEntities]);
  const karten = useMemo(() => regelKarten(daten.flows, bezug, namen), [daten.flows, bezug, namen]);

  // Alte Regel-Lesezeichen (`?verbraucher=`, `?komponente=`, `?vorlage=`) öffnen den Baukasten.
  useEffect(() => {
    if (reiter !== 'regeln' || !daten.verbraucher) return;
    const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const geraet = q.get('verbraucher') ?? q.get('komponente');
    const vorlage = q.get('vorlage');
    if (!geraet && !vorlage) return;
    setBlatt({ art: 'regel', geraet: geraet ?? undefined, vorlage: vorlage && VORLAGEN.some((v) => v.id === vorlage) ? vorlage : undefined });
    replaceCurrentNavigation(window.location.hash.split('?')[0]);
  }, [reiter, daten.verbraucher]);

  const lauf = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const eingriff: Aktionen['eingriff'] = async (g, art, minuten) => {
    let ok = false;
    await lauf(g.id, async () => {
      try {
        const [a, , c] = dreiWorte(g);
        const bis = minuten == null ? 'zum Abstecken' : uhrVon(bild.raster, Date.now() + minuten * 60_000);
        if (g.ladepunkt) {
          const lp = g.ladepunkt;
          if (art === 'smart') await api.chargingBoost(site.id, { chargePointId: lp.chargePointId, connectorId: lp.connectorId, cancel: true });
          else await api.chargingBoost(site.id, { chargePointId: lp.chargePointId, connectorId: lp.connectorId, action: art === 'aus' ? 'pause' : 'voll', ...(minuten != null ? { minutes: minuten } : {}) });
        } else if (art === 'smart') {
          await consumersApi.clearOverride(site.id, g.id);
        } else {
          await consumersApi.startOverride(site.id, g.id, { action: art === 'an' ? 'start' : 'stop', durationMinutes: minuten ?? 60 });
        }
        meldung(art === 'smart' ? `${g.name} läuft wieder Smart.` : `${g.name}: ${art === 'aus' ? a : c} bis ${bis}. Danach wieder Smart.`);
        ok = true;
        neuLaden();
      } catch (e) {
        meldung(fehlerText(e, 'Der Eingriff konnte nicht gesendet werden.'), true);
      }
    });
    return ok;
  };

  const speicherEingriff: Aktionen['speicherEingriff'] = async (art, minuten) => {
    let ok = false;
    await lauf(SPEICHER, async () => {
      try {
        if (art === 'smart') await api.clearBatteryOverride(site.id);
        else await api.startBatteryOverride(site.id, { kind: art === 'an' ? 'speicher_laden' : 'speicher_halten', durationMinutes: minuten ?? 60 });
        meldung(art === 'smart' ? 'Der Speicher läuft wieder Smart.' : `Speicher: ${art === 'an' ? 'Laden' : 'Halten'} bis ${uhrVon(bild.raster, Date.now() + (minuten ?? 60) * 60_000)}. Danach wieder Smart.`);
        ok = true;
        neuLaden();
      } catch (e) {
        meldung(fehlerText(e, 'Der Eingriff konnte nicht gesendet werden.'), true);
      }
    });
    return ok;
  };

  const steuerart: Aktionen['steuerart'] = async (g, w) => {
    let ok = false;
    await lauf(g.id, async () => {
      try {
        const res = await api.setzeSteuerart(site.id, g.id, w);
        if (res.aktiv === false && res.nachricht) meldung(res.nachricht, true);
        else meldung(`${g.name}: ${res.steuerart ? 'übernommen' : 'gespeichert'}. Gilt ab jetzt; Gemessenes bleibt.`);
        ok = true;
        const v = await api.siteVerbraucher(site.id).catch(() => null);
        if (v) setze('verbraucher', v);
      } catch (e) {
        meldung(fehlerText(e, 'Die Einstellung konnte nicht gespeichert werden.'), true);
      }
    });
    return ok;
  };

  const aktionen: Aktionen = {
    eingriff,
    speicherEingriff,
    steuerart,
    speicherHilft: async (g, an) => {
      if (!g.consumer) return;
      await lauf(g.id, async () => {
        try {
          await consumersApi.patch(site.id, g.id, { allowStorageDischarge: an, expectedVersion: g.consumer?.version });
          meldung(an ? 'Der Speicher darf aushelfen.' : 'Der Speicher bleibt fürs Haus.');
          const c = await consumersApi.list(site.id).catch(() => null);
          if (c) setze('consumers', c);
        } catch (e) {
          meldung(fehlerText(e, 'Die Einstellung konnte nicht gespeichert werden.'), true);
        }
      });
    },
    pause: async (minuten) => {
      await lauf('pause', async () => {
        try {
          await api.pauseAutomation(site.id, { durationMinutes: minuten });
          meldung(`Automatik pausiert bis ${uhrVon(bild.raster, Date.now() + minuten * 60_000)}.`);
          neuLaden();
        } catch (e) {
          meldung(fehlerText(e, 'Die Pause konnte nicht gesetzt werden.'), true);
        }
      });
    },
    betriebsmodell: async (neu) => {
      let ok = false;
      await lauf(SPEICHER, async () => {
        try {
          const laufend = liste(daten.profiles?.profiles).find((p) => p.exklusivGruppe === 'speicher' && p.active);
          const res = neu ? await api.setSiteProfile(site.id, neu, 'an') : laufend ? await api.setSiteProfile(site.id, laufend.id, 'aus') : null;
          if (res) setze('profiles', res);
          meldung('Betriebsmodell übernommen. Es gilt ab dem nächsten Fahrplan.');
          ok = true;
        } catch (e) {
          meldung(fehlerText(e, 'Das Betriebsmodell konnte nicht gewechselt werden.'), true);
        }
      });
      return ok;
    },
    nurMessen: async (g) => {
      await lauf(g.id, async () => {
        try {
          await api.setSuggestionState(site.id, nurMessenKey(g.id), 'abgelehnt');
          const s = await api.suggestionStates(site.id).catch(() => null);
          if (s) setze('vorschlaege', s);
          meldung(`${g.name} wird nur gemessen. Unter „noch nicht gesteuert“ lässt sich das jederzeit ändern.`);
        } catch (e) {
          meldung(fehlerText(e, 'Das ließ sich nicht speichern.'), true);
        }
      });
    },
    oeffne: (b) => setBlatt(b),
    zuReiter: (sub) => onOpenSub(sub),
    reihenfolgeAendern: (id) => {
      if (reiter !== 'steuerung') onOpenSub('steuerung');
      setReoStart(id);
    },
    anlage: () => onOpenSub('modell'),
    einstellungen: () => onOpenSub('technik'),
  };

  const reihenfolge = async (ids: string[]) => {
    await lauf('reihenfolge', async () => {
      try {
        const alle = [...ids, ...bild.reihenfolge.filter((x) => !ids.includes(x))];
        const res = await api.saveRangliste(site.id, reihenfolgeRumpf(alle, bild.geraete));
        setze('verbraucher', res);
        meldung('Reihenfolge gespeichert. Gilt ab jetzt.');
      } catch (e) {
        meldung(fehlerText(e, 'Die Reihenfolge konnte nicht gespeichert werden.'), true);
      }
    });
  };

  const uebernehmen = async (g: GeraetBild) => {
    const v = vorschlag(g);
    if (!v) return;
    await steuerart(g, v.wunsch);
  };

  const ladeQuelle = async (g: GeraetBild, q: LadeQuelle) => {
    const s = g.steuerart;
    const v = g.eintrag.optionen?.vorgaben;
    const ziel = s?.ziel === 'bis_uhrzeit'
      ? { ziel: 'bis_uhrzeit', zielEnergieKwh: s.zielEnergieKwh ?? null, zielFenster: s.zielFenster ?? null }
      : {};
    const w: SteuerartWunsch = q === 'guenstig'
      ? { quelle: 'guenstig', preisgrenzeCtKwh: s?.preisgrenzeCtKwh ?? v?.preisgrenzeCtKwh ?? null, ...ziel }
      : {
          quelle: 'ueberschuss',
          ueberschussModus: q === 'min' ? 'mindestleistung' : 'pausieren',
          ...(q === 'min' ? { mindestleistungKw: s?.mindestleistungKw ?? daten.verbraucher?.ladepunkte.rahmen?.mindestleistungKw ?? 1.4 } : {}),
          ...ziel,
        };
    await steuerart(g, w);
  };

  const regelAktivieren = async (e: RegelEntwurf): Promise<boolean> => {
    const g = bild.geraete.find((x) => x.id === e.dann.g) ?? null;
    const regel = zuGuided(e, bezug, g);
    if (!regel) {
      meldung('Diese Regel lässt sich so nicht speichern.', true);
      return false;
    }
    let ok = false;
    await lauf('regel', async () => {
      try {
        const doc = buildGuidedFlow(regel, e.name.trim(), site.id);
        const v = e.flowId && e.version != null
          ? await flowApi.save(e.flowId, e.version, e.name.trim(), doc)
          : await flowApi.create(e.name.trim(), doc);
        const res = await flowApi.activate(v.flowId, v.flowVersion);
        if (!res.activated) {
          meldung(res.message || 'Die Regel ist gespeichert, aber nicht aktiv.', true);
        } else {
          const r = bild.raster;
          const k = regelKarten([{ ...v, latestVersion: v.flowVersion, latestLifecycle: v.lifecycle, activeVersion: v.flowVersion, latestDocument: v.document, versions: [v.flowVersion], simulation: null }], bezug, namen)[0];
          const bits = k?.entwurf ? spannen(greift(k.entwurf, bild.reihen, r.jetzt), r.jetzt) : [];
          meldung(`Regel „${e.name.trim()}“ ist aktiv. ${bits.length ? (bits[0][0] === r.jetzt ? 'Sie greift jetzt.' : `Greift als Nächstes ${uhrTag(bits[0][0])}.`) : 'Sie greift bis morgen Abend nicht.'}`);
        }
        ok = true;
        const f = await flowApi.list().catch(() => null);
        if (f) setze('flows', f);
      } catch (err) {
        meldung(fehlerText(err, 'Die Regel konnte nicht gespeichert werden.'), true);
      }
    });
    return ok;
  };

  const regelLoeschen = async (flowId: string): Promise<boolean> => {
    let ok = false;
    await lauf('regel', async () => {
      try {
        await flowApi.remove(flowId);
        meldung('Regel gelöscht.');
        ok = true;
        const f = await flowApi.list().catch(() => null);
        if (f) setze('flows', f);
      } catch (e) {
        meldung(fehlerText(e, 'Die Regel konnte nicht gelöscht werden.'), true);
      }
    });
    return ok;
  };

  const regelSchalter = (k: RegelKarte) => {
    if (!k.an) {
      if (k.entwurf) setBlatt({ art: 'regel', flowId: k.flowId });
      else {
        void lauf(k.flowId, async () => {
          try {
            await flowApi.activate(k.flowId, k.version);
            meldung(`Regel „${k.name}“ ist an.`);
            const f = await flowApi.list().catch(() => null);
            if (f) setze('flows', f);
          } catch (e) {
            meldung(fehlerText(e, 'Die Regel konnte nicht eingeschaltet werden.'), true);
          }
        });
      }
      return;
    }
    void lauf(k.flowId, async () => {
      try {
        await flowApi.deactivate(k.flowId);
        meldung(`Regel „${k.name}“ ist aus. Sie bleibt gespeichert.`);
        const f = await flowApi.list().catch(() => null);
        if (f) setze('flows', f);
      } catch (e) {
        meldung(fehlerText(e, 'Die Regel konnte nicht ausgeschaltet werden.'), true);
      }
    });
  };

  const automatik = async () => {
    if (bild.pausiertBisMs == null) {
      setBlatt({ art: 'pause' });
      return;
    }
    await lauf('pause', async () => {
      try {
        await api.resumeAutomation(site.id);
        meldung('Automatik läuft wieder.');
        neuLaden();
      } catch (e) {
        meldung(fehlerText(e, 'Die Automatik konnte nicht fortgesetzt werden.'), true);
      }
    });
  };

  const zu = () => setBlatt(null);
  const k: BlattKontext = {
    bild,
    flows: daten.flows,
    profiles: daten.profiles?.profiles ?? null,
    editorNamen: namen,
    busy,
    a: aktionen,
    zu,
  };

  const rahmen = daten.verbraucher?.ladepunkte.rahmen ?? null;
  const zahlen: Record<string, number> = {
    steuerung: bild.geraete.filter((g) => g.an === true).length,
    laden: bild.ladepunkte.filter((g) => g.ladepunkt?.angesteckt).length,
    regeln: karten.filter((x) => x.an).length,
  };

  let inhalt: React.ReactNode;
  if (!geladen && !daten.verbraucher) {
    inhalt = <p className="leise" aria-busy="true">Lade die Steuerung …</p>;
  } else if (fehler && !daten.verbraucher) {
    inhalt = (
      <div className="stn-fehler voll">
        {fehler}{' '}
        <button type="button" className="lnk" onClick={neuLaden}>Erneut versuchen</button>
      </div>
    );
  } else if (reiter === 'laden') {
    inhalt = (
      <LadenReiter
        bild={bild}
        rahmen={rahmen}
        config={daten.chargingConfig}
        fahrzeuge={daten.fahrzeuge}
        busy={busy}
        oeffne={setBlatt}
        onSmart={(g) => void eingriff(g, 'smart', null)}
        onQuelle={(g, q) => void ladeQuelle(g, q)}
        onVorrang={(zuerst) => void lauf('vorrang', async () => {
          try {
            const c = await api.saveChargingConfig(site.id, { storagePriority: zuerst ? 'speicher_vor_auto' : 'auto_vor_speicher' });
            setze('chargingConfig', c);
            meldung(zuerst ? 'Der Speicher hat Vorrang.' : 'Die Autos haben Vorrang vor dem Speicher.');
          } catch (e) {
            meldung(fehlerText(e, 'Der Vorrang konnte nicht gespeichert werden.'), true);
          }
        })}
        onLadevorgaenge={() => onOpenSub('ladevorgaenge')}
        zuGeraete={() => onOpenSub('steuerung')}
      />
    );
  } else if (reiter === 'regeln') {
    inhalt = (
      <RegelnReiter
        bild={bild}
        karten={karten}
        ziele={ziele}
        bezug={bezug}
        ereignisse={daten.ruleEvents}
        busy={busy}
        oeffne={setBlatt}
        onSchalter={regelSchalter}
        onBefehle={() => onOpenSub('befehle')}
      />
    );
  } else {
    inhalt = (
      <GeraeteReiter
        bild={bild}
        oeffne={setBlatt}
        onUebernehmen={(g) => void uebernehmen(g)}
        onNurMessen={(g) => void aktionen.nurMessen(g)}
        onReihenfolge={reihenfolge}
        onAnlage={() => onOpenSub('modell')}
        netzanschlussKw={rahmen?.effektivGrenzeKw ?? rahmen?.netzanschlussKw ?? null}
        busy={busy}
        reoStart={reoStart}
        onReoGestartet={() => setReoStart(null)}
      />
    );
  }

  const pausiert = bild.pausiertBisMs != null;
  return (
    <div className="stn">
      <div className="stn-kopf">
        <h1>Steuerung</h1>
        <button type="button" className={`auto${pausiert ? ' aus' : ''}`} onClick={() => void automatik()} disabled={busy === 'pause'}>
          <i />
          {pausiert ? `pausiert bis ${uhrVon(bild.raster, bild.pausiertBisMs ?? 0)}` : 'Automatik an'}
        </button>
      </div>
      <div className="stn-reiter" role="tablist" aria-label="Reiter der Steuerung">
        {tabs.map((t) => (
          <button
            type="button"
            role="tab"
            key={t.key}
            aria-selected={t.sub === reiter}
            onClick={() => t.sub !== reiter && onOpenSub(t.sub)}
          >
            {t.label}
            {zahlen[t.sub] ? <span className="n">{zahlen[t.sub]}</span> : null}
          </button>
        ))}
      </div>
      <main className={`stn-main ${reiter}`}>
        {pausiert && (
          <div className="stn-band voll">
            <Ic n="pause" s={18} />
            <span>
              <b>Automatik pausiert bis {uhrVon(bild.raster, bild.pausiertBisMs ?? 0)}.</b> Geräte sind im sicheren Zustand; Schutzgrenzen gelten weiter.{' '}
              <button type="button" className="lnk" onClick={() => void automatik()}>Fortsetzen</button>
            </span>
          </div>
        )}
        {inhalt}
      </main>
      {blatt && <BlattWahl blatt={blatt} k={k} ziele={ziele} karten={karten} bezug={bezug} rahmen={rahmen} daten={daten} onRegel={regelAktivieren} onLoeschen={regelLoeschen} onSteuerart={steuerart} onGrenze={async (kw) => {
        let ok = false;
        await lauf('rahmen', async () => {
          try {
            const c = await api.saveChargingConfig(site.id, { gridLimitKw: kw });
            setze('chargingConfig', c);
            meldung('Rahmen übernommen.');
            ok = true;
            const v = await api.siteVerbraucher(site.id).catch(() => null);
            if (v) setze('verbraucher', v);
          } catch (e) {
            meldung(fehlerText(e, 'Der Rahmen konnte nicht gespeichert werden.'), true);
          }
        });
        return ok;
      }} onFahrzeug={async (tagRef, w) => {
        let ok = false;
        await lauf(`fz:${tagRef}`, async () => {
          try {
            const f = await api.setzeFahrzeug(site.id, tagRef, w);
            setze('fahrzeuge', f);
            meldung('Übernommen.');
            ok = true;
          } catch (e) {
            meldung(fehlerText(e, 'Das Fahrzeug konnte nicht gespeichert werden.'), true);
          }
        });
        return ok;
      }} />}
      {toast && (
        <div className="stn-toast" role="status">
          <Ic n={toast.warn ? 'info' : 'check'} s={18} />
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  );
}

function BlattWahl({ blatt, k, ziele, karten, bezug, rahmen, daten, onRegel, onLoeschen, onSteuerart, onGrenze, onFahrzeug }: {
  blatt: BlattZustand;
  k: BlattKontext;
  ziele: GeraetBild[];
  karten: RegelKarte[];
  bezug: ReturnType<typeof bezugAus>;
  rahmen: import('../verbraucherZone').LadeparkRahmen | null;
  daten: import('./useSteuerungDaten').SteuerungDaten;
  onRegel: (e: RegelEntwurf) => Promise<boolean>;
  onLoeschen: (flowId: string) => Promise<boolean>;
  onSteuerart: (g: GeraetBild, w: SteuerartWunsch) => Promise<boolean>;
  onGrenze: (kw: number) => Promise<boolean>;
  onFahrzeug: (tagRef: string, w: { name?: string; quelle?: 'sofort' | 'ueberschuss' | '' }) => Promise<boolean>;
}) {
  switch (blatt.art) {
    case 'geraet':
      return <GeraetBlatt k={k} id={blatt.id} modus={blatt.modus} />;
    case 'speicher':
      return <SpeicherBlatt k={k} />;
    case 'pause':
      return <PauseBlatt k={k} />;
    case 'vorrang':
      return <VorrangBlatt k={k} />;
    case 'p14a':
      return <P14aBlatt k={k} />;
    case 'negativ':
      return <NegativBlatt k={k} />;
    case 'anbinden':
      return <AnbindenBlatt k={k} />;
    case 'neu':
      return <NeuBlatt k={k} id={blatt.id} />;
    case 'rahmen':
      return <RahmenBlatt k={k} rahmen={rahmen} config={daten.chargingConfig} onGrenze={onGrenze} />;
    case 'ziel':
      return <ZielBlatt k={k} id={blatt.id} onSpeichern={onSteuerart} />;
    case 'fahrzeug':
      return <FahrzeugBlatt k={k} tagRef={blatt.tagRef} fahrzeuge={daten.fahrzeuge} onSetzen={onFahrzeug} />;
    case 'regel': {
      const vorhanden = blatt.flowId ? karten.find((x) => x.flowId === blatt.flowId) ?? null : null;
      if (vorhanden && !vorhanden.entwurf) {
        return <FreieRegel k={k} karte={vorhanden} />;
      }
      const start = vorhanden?.entwurf ?? neuerEntwurf(ziele, { geraet: blatt.geraet, vorlage: blatt.vorlage });
      return (
        <RegelBlatt
          k={k}
          start={start}
          bearbeiten={!!vorhanden}
          ziele={ziele}
          bezug={bezug}
          karten={karten}
          sofortFolgen={!!vorhanden && !vorhanden.an}
          onAktivieren={onRegel}
          onLoeschen={onLoeschen}
        />
      );
    }
    default:
      return null;
  }
}

function FreieRegel({ k, karte }: { k: BlattKontext; karte: RegelKarte }) {
  return (
    <Blatt symbol="zap" titel={karte.name} unter="im freien Editor gebaut" onClose={k.zu}>
      <div className="warum">Diese Regel ist größer als der Satzbaukasten. Sie läuft wie gebaut; ändern lässt sie sich im freien Editor.</div>
      <p className="leise">Ein- und Ausschalten geht mit dem Schalter an der Regel.</p>
    </Blatt>
  );
}
