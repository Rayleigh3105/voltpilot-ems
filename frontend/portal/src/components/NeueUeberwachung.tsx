import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api } from '../api';
import { energiezielName } from '../energiezielBild';
import { ueberwachungApi } from '../ueberwachungApi';
import {
  anlageWerte,
  katalogWerte,
  ORT_GRUPPEN,
  ortOptionen,
  ortWert,
  WERT_GRUPPE_TITEL,
  type UeberwachungOrt,
  type WertGruppe,
  type WertWahl,
} from '../ueberwachungAuswahl';
import { BottomSheet } from './BottomSheet';
import { VpPicker } from './VpPicker';
import './NeueUeberwachung.css';

/**
 * Das Blatt „Neue Überwachung“ unter Meldungen › Überwachungen (Konzept b1, 20.10.2026, E3): der
 * EINE Ort, an dem eine Überwachung entsteht. „Wo?“ wählt Anlage, Messstelle, Kennzahl oder
 * Energieziel, „Welcher Wert?“ listet, was sich dort überwachen lässt; ein Tipp auf einen Wert gibt
 * ihn an die Seite, die dann das vorhandene Blatt „Überwachen“ öffnet. Am Telefon `BottomSheet`, am
 * Rechner das zentrierte `Modal`.
 */
export function NeueUeberwachung({
  offen,
  isPhone,
  onClose,
  onWahl,
}: {
  offen: boolean;
  isPhone: boolean;
  onClose: () => void;
  onWahl: (wert: WertWahl) => void;
}) {
  const [orte, setOrte] = useState<UeberwachungOrt[] | null>(null);
  const [orteFehler, setOrteFehler] = useState<string | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [ortKey, setOrtKey] = useState<string | null>(null);
  const [werte, setWerte] = useState<WertWahl[] | null>(null);
  const [werteFehler, setWerteFehler] = useState<string | null>(null);

  useEffect(() => {
    if (!offen) return undefined;
    let aktiv = true;
    setOrteFehler(null);
    void ladeOrte().then(
      (liste) => {
        if (!aktiv) return;
        setOrte(liste);
        // Nur ein Ort zur Wahl: er ist gewählt, die Frage „Wo?“ ist dann schon beantwortet.
        if (liste.length === 1) setOrtKey((k) => k ?? ortWert(liste[0]));
      },
      () => { if (aktiv) setOrteFehler('Die Orte konnten nicht geladen werden.'); },
    );
    return () => { aktiv = false; };
  }, [offen, versuch]);

  const ort = orte?.find((o) => ortWert(o) === ortKey) ?? null;
  const ortArt = ort?.art ?? null;
  const ortId = ort?.id ?? null;
  const ortName = ort?.name ?? null;

  useEffect(() => {
    setWerteFehler(null);
    if (ortArt == null || ortId == null || ortName == null) { setWerte(null); return undefined; }
    if (ortArt !== 'anlage') { setWerte(katalogWerte({ art: ortArt, id: ortId, name: ortName })); return undefined; }
    let aktiv = true;
    setWerte(null);
    ueberwachungApi.werte(`anlage:${ortId}`).then(
      (w) => { if (aktiv) setWerte(anlageWerte(w)); },
      () => { if (aktiv) setWerteFehler('Die Werte dieser Anlage konnten nicht geladen werden.'); },
    );
    return () => { aktiv = false; };
  }, [ortArt, ortId, ortName]);

  const inhalt = (
    <div className="vp-nu">
      <VpPicker
        label="Wo?"
        options={ortOptionen(orte ?? [])}
        groups={ORT_GRUPPEN}
        value={ortKey}
        onChange={setOrtKey}
        placeholder="Ort wählen"
        loading={orte == null && orteFehler == null}
        loadError={orteFehler}
        onRetry={() => setVersuch((v) => v + 1)}
        emptyText={() => 'Keine Orte gefunden.'}
      />
      {ort && (
        <section className="vp-nu-werte" aria-label="Welcher Wert?">
          <h3 className="vp-nu-frage">Welcher Wert?</h3>
          {werteFehler ? (
            <p role="alert" className="vp-nu-hinweis">{werteFehler}</p>
          ) : werte == null ? (
            <p className="vp-nu-hinweis">Wird geladen …</p>
          ) : werte.length === 0 ? (
            <p className="vp-nu-hinweis">An diesem Ort lässt sich noch nichts überwachen.</p>
          ) : (
            (['live', 'geraet', 'ort'] as const).map((g) => {
              const zeilen = werte.filter((w) => w.gruppe === g);
              if (zeilen.length === 0) return null;
              return (
                <WertGruppeListe key={g} titel={werte.some((w) => w.gruppe !== g) ? WERT_GRUPPE_TITEL[g] : null}>
                  {zeilen.map((w) => (
                    <li key={w.schluessel}>
                      <button type="button" className="vp-nu-wert" onClick={() => onWahl(w)}>
                        <span className={`vp-nu-ico is-${tonFuer(w)}`} aria-hidden="true">
                          <Icon name={iconFuer(w, g)} size={16} />
                        </span>
                        <span className="vp-nu-name">{w.name}</span>
                        {w.wertText && <span className="vp-nu-jetzt">{w.wertText}</span>}
                        <Icon name="chevron-right" size={16} />
                      </button>
                    </li>
                  ))}
                </WertGruppeListe>
              );
            })
          )}
        </section>
      )}
    </div>
  );

  return isPhone ? (
    <BottomSheet open={offen} title="Neue Überwachung" onClose={onClose}>
      {inhalt}
    </BottomSheet>
  ) : (
    <Modal open={offen} onClose={onClose} title="Neue Überwachung">
      {inhalt}
    </Modal>
  );
}

function WertGruppeListe({ titel, children }: { titel: string | null; children: ReactNode }) {
  return (
    <>
      {titel && <p className="vp-nu-gruppe">{titel}</p>}
      <ul className="vp-nu-liste">{children}</ul>
    </>
  );
}

/** Die Orte, die die Person sieht. Fehlt ein Bereich (z. B. ohne Messfunktion), fehlt nur er. */
async function ladeOrte(): Promise<UeberwachungOrt[]> {
  const [anlagen, messstellen, kennzahlen, energieziele] = await Promise.allSettled([
    api.listSites(),
    api.messstellen(),
    api.kennzahlen(),
    api.energieziele(),
  ]);
  if (anlagen.status === 'rejected') throw anlagen.reason;
  const orte: UeberwachungOrt[] = anlagen.value.eintraege.map((s) => ({ art: 'anlage', id: s.id, name: s.name }));
  if (messstellen.status === 'fulfilled') {
    for (const m of messstellen.value.messstellen) {
      if (m.lebenszyklus === 'archiviert') continue;
      orte.push({ art: 'messstelle', id: m.id, name: m.name ?? m.kennzeichen, sub: m.name ? m.kennzeichen : null });
    }
  }
  if (kennzahlen.status === 'fulfilled') {
    for (const k of kennzahlen.value.kennzahlen) {
      if (k.archiviert_am) continue;
      orte.push({ art: 'kennzahl', id: k.id, name: k.name, sub: k.kennzeichen });
    }
  }
  if (energieziele.status === 'fulfilled') {
    for (const e of energieziele.value.energieziele) {
      if (e.zustand === 'beendet') continue;
      orte.push({ art: 'energieziel', id: e.id, name: energiezielName(e), sub: `${e.kennzeichen} · ${e.kennzahl.name}` });
    }
  }
  return orte;
}

const LIVE_ICON: [string, IconName][] = [
  ['anlage.pv.', 'sun'],
  ['anlage.verbrauch.', 'home'],
  ['anlage.speicher.', 'battery'],
  ['anlage.netz.', 'pole'],
  ['anlage.ladepunkte.', 'plug'],
  ['anlage.preis.', 'euro'],
];

function iconFuer(w: WertWahl, g: WertGruppe): IconName {
  if (g === 'geraet') return 'cpu';
  if (g === 'ort') return w.wertart.startsWith('kennzahl.') ? 'chart' : w.wertart.startsWith('energieziel.') ? 'target' : 'activity';
  return LIVE_ICON.find(([p]) => w.wertart.startsWith(p))?.[1] ?? 'activity';
}

function tonFuer(w: WertWahl): string {
  if (w.wertart.startsWith('anlage.pv.')) return 'pv';
  if (w.wertart.startsWith('anlage.verbrauch.') || w.wertart.startsWith('anlage.ladepunkte.')) return 'load';
  if (w.wertart.startsWith('anlage.speicher.')) return 'batt';
  if (w.wertart.startsWith('anlage.netz.')) return 'grid';
  return 'ruhig';
}
