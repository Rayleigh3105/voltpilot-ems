import { useRollen } from '../rollen';
import { Recht } from './Recht';
import { useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type Messstelle, type MessstelleFormel, type MessstelleWert } from '../api';
import { fmtNum } from '../format';
import { SUMMENWERT } from '../gesamtwert';
import { ladeSiteGesamtwerte as ladeQuellen } from '../gesamtwertQuelle';
import { ConfirmDialog } from './ConfirmDialog';
import { PROTOKOLL_LABEL, ProtokollDialog } from './ProtokollDialog';
import { RowMenu, type RowMenuItem } from './RowMenu';
import { WERTE_LABEL, WerteDialog } from './WerteDialog';
import './Gesamtwert.css';

/**
 * Die COCKPIT-Fläche der Gesamtwerte (Konzept `vp-helfer-konzept-h1` §2.5): ein
 * berechneter Wert erscheint auf „Meine Anlage" mit seinem Live-Wert wie ein
 * gemessener — nur trägt er ein dezentes „berechnet". Von hier laufen auch die
 * Lebenszyklus-Wege (umbenennen · anhalten/fortsetzen · archivieren statt hartem
 * Löschen) und die Anzeige-Rolle „gilt als Gesamt-PV".
 *
 * Render-only. Der Wert selbst kommt vom Server (`GET …/wert`); ist EIN Term
 * unvollständig, steht das da — nie eine heimlich kleinere Summe. Ohne einen
 * einzigen Gesamtwert rendert die Fläche nichts (kein leerer Kasten).
 */

interface GwZeile {
  messstelle: Messstelle;
  formel: MessstelleFormel | null;
  wert: MessstelleWert | null;
}

export function GesamtwertKarten({
  siteId,
  version,
  onNeu,
  eingebettet = false,
}: {
  siteId: string;
  /** Erhöht sich, wenn ein neuer Gesamtwert angelegt wurde — dann neu laden. */
  version: number;
  /** Öffnet den Assistenten für einen weiteren Gesamtwert. */
  onNeu?: () => void;
  /**
   * Eingebettet unter einer fremden Überschrift (vp-agg §2.5/C: die Auswertungen-Fläche trägt Titel
   * UND den „+ Gesamtwert"-Einstieg): dann entfällt der EIGENE Kopf, sonst stünde die Überschrift
   * doppelt. Ohne diese Angabe (freistehend) bleibt der Kopf wie bisher.
   */
  eingebettet?: boolean;
}) {
  const rechte = useRollen();
  const [zeilen, setZeilen] = useState<GwZeile[] | null>(null);
  const [umbenennen, setUmbenennen] = useState<{ id: string; name: string } | null>(null);
  const [archivieren, setArchivieren] = useState<GwZeile | null>(null);
  // Das Änderungsprotokoll JE MESSSTELLE (AP-04 IP-21) — es liest nur.
  const [protokoll, setProtokoll] = useState<GwZeile | null>(null);
  // Die Tages- und Monatswerte JE MESSSTELLE (AP-08 IP-11) — sie lesen nur.
  const [werte, setWerte] = useState<GwZeile | null>(null);
  const [busy, setBusy] = useState(false);
  const [neuLaden, setNeuLaden] = useState(0);

  useEffect(() => {
    let aktiv = true;
    setZeilen(null);
    ladeSiteGesamtwerte(siteId)
      .then((zs) => aktiv && setZeilen(zs))
      .catch(() => aktiv && setZeilen([]));
    return () => {
      aktiv = false;
    };
  }, [siteId, version, neuLaden]);

  const auffrischen = () => setNeuLaden((n) => n + 1);

  const anhalten = async (z: GwZeile, an: boolean) => {
    if (busy || !rechte.darf("messstelle.bearbeiten")) return;
    setBusy(true);
    try {
      if (an) await api.messstelleAnhalten(z.messstelle.id);
      else await api.messstelleFortsetzen(z.messstelle.id);
      auffrischen();
    } finally {
      setBusy(false);
    }
  };

  const speichereName = async () => {
    if (!umbenennen || busy || !rechte.darf("messstelle.bearbeiten")) return;
    setBusy(true);
    try {
      const z = zeilen?.find((x) => x.messstelle.id === umbenennen.id);
      // PUT ersetzt alle drei Felder — Kennzeichen UND Notiz mitschicken, sonst
      // würde eine bestehende Notiz beim Umbenennen geleert (Review-Nebenbefund).
      await api.messstelleBearbeiten(umbenennen.id, {
        kennzeichen: z?.messstelle.kennzeichen,
        name: umbenennen.name.trim(),
        notiz: z?.messstelle.notiz ?? undefined,
      });
      setUmbenennen(null);
      auffrischen();
    } finally {
      setBusy(false);
    }
  };

  const bestaetigeArchiv = async () => {
    if (!archivieren || busy || !rechte.darf("messstelle.bearbeiten")) return;
    setBusy(true);
    try {
      await api.messstelleArchivieren(archivieren.messstelle.id);
      setArchivieren(null);
      auffrischen();
    } finally {
      setBusy(false);
    }
  };

  // Kein leerer Kasten: ohne einen einzigen Gesamtwert rendert die Fläche nichts.
  if (zeilen == null || zeilen.length === 0) return null;

  return (
    <section className="vp-gwk" aria-label={`${SUMMENWERT}e`}>
      {!eingebettet && (
        <div className="vp-gwk-head">
          <h3>Zusammengestellte Werte</h3>
          {onNeu && (
            <Recht aktion="messstelle.formel"><button type="button" className="vp-gwk-neu" onClick={onNeu}>
              <Icon name="plus" size={15} /> {SUMMENWERT}
            </button></Recht>
          )}
        </div>
      )}
      <div className="vp-gwk-grid">
        {zeilen.map((z) => (
          <Karte
            key={z.messstelle.id}
            zeile={z}
            bearbeiten={umbenennen?.id === z.messstelle.id ? umbenennen : null}
            busy={busy}
            onNameEntwurf={(name) => setUmbenennen({ id: z.messstelle.id, name })}
            onNameSpeichern={speichereName}
            onNameAbbrechen={() => setUmbenennen(null)}
            onAnhalten={() => anhalten(z, z.messstelle.lebenszyklus !== 'angehalten')}
            onUmbenennen={() => setUmbenennen({ id: z.messstelle.id, name: z.messstelle.name ?? '' })}
            onArchivieren={() => setArchivieren(z)}
            onProtokoll={() => setProtokoll(z)}
            onWerte={() => setWerte(z)}
          />
        ))}
      </div>

      <ProtokollDialog
        open={protokoll != null}
        titel={protokoll?.messstelle.name || SUMMENWERT}
        ziel={protokoll ? { art: 'messstelle', id: protokoll.messstelle.id } : null}
        onClose={() => setProtokoll(null)}
      />

      <WerteDialog
        key={werte?.messstelle.id ?? 'zu'}
        open={werte != null}
        kennzeichen={werte?.messstelle.kennzeichen ?? null}
        titel={werte ? `${werte.messstelle.kennzeichen} · ${werte.messstelle.name || SUMMENWERT}` : SUMMENWERT}
        onClose={() => setWerte(null)}
      />

      <ConfirmDialog
        open={archivieren != null && rechte.darf("messstelle.bearbeiten")}
        title={`„${archivieren?.messstelle.name ?? SUMMENWERT}" archivieren?`}
        intro="Der Wert verschwindet aus Übersicht und Verlauf — seine bisherige Definition und sein Verlauf bleiben aber erhalten."
        consequences={[
          'Das Kennzeichen bleibt belegt und wird nie neu vergeben.',
          'Sie können jederzeit einen neuen Summenwert zusammenstellen.',
        ]}
        confirmLabel="Archivieren"
        tone="danger"
        busy={busy}
        onConfirm={bestaetigeArchiv}
        onCancel={() => setArchivieren(null)}
      />
    </section>
  );
}

function Karte({
  zeile,
  bearbeiten,
  busy,
  onNameEntwurf,
  onNameSpeichern,
  onNameAbbrechen,
  onAnhalten,
  onUmbenennen,
  onArchivieren,
  onProtokoll,
  onWerte,
}: {
  zeile: GwZeile;
  bearbeiten: { id: string; name: string } | null;
  busy: boolean;
  onNameEntwurf: (name: string) => void;
  onNameSpeichern: () => void;
  onNameAbbrechen: () => void;
  onAnhalten: () => void;
  onUmbenennen: () => void;
  onArchivieren: () => void;
  onProtokoll: () => void;
  onWerte: () => void;
}) {
  const { messstelle: m, wert } = zeile;
  const angehalten = m.lebenszyklus === 'angehalten';
  const chipZustand = angehalten
    ? 'angehalten'
    : wert == null
      ? 'nicht abrufbar'
      : wert.unvollstaendig
        ? 'unvollständig'
        : 'vollständig';
  const menu: RowMenuItem[] = [
    { recht: 'messstelle.bearbeiten', label: 'Umbenennen', icon: 'pencil', onClick: onUmbenennen },
    { recht: 'messstelle.bearbeiten', label: angehalten ? 'Fortsetzen' : 'Anhalten', icon: angehalten ? 'refresh-cw' : 'eye-off', onClick: onAnhalten },
    { label: WERTE_LABEL, icon: 'calendar', onClick: onWerte },
    { label: PROTOKOLL_LABEL, icon: 'history', onClick: onProtokoll },
    { recht: 'messstelle.bearbeiten', label: 'Archivieren', icon: 'trash', danger: true, onClick: onArchivieren },
  ];

  return (
    <div className={`vp-gwk-card${angehalten ? ' is-angehalten' : ''}`}>
      <div className="vp-gwk-card-top">
        <span className="vp-gwk-ic">
          <Icon name="sliders" size={16} />
        </span>
        {bearbeiten ? (
          <span className="vp-gwk-rename">
            <input
              autoFocus
              value={bearbeiten.name}
              maxLength={80}
              onChange={(e) => onNameEntwurf(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onNameSpeichern();
                if (e.key === 'Escape') onNameAbbrechen();
              }}
              aria-label="Name"
            />
            <Recht aktion="messstelle.bearbeiten"><button type="button" aria-label="Speichern" disabled={busy || !bearbeiten.name.trim()} onClick={onNameSpeichern}>
              <Icon name="check" size={16} />
            </button></Recht>
            <button type="button" aria-label="Abbrechen" onClick={onNameAbbrechen}>
              <Icon name="x" size={16} />
            </button>
          </span>
        ) : (
          <span className="vp-gwk-name">{m.name || SUMMENWERT}</span>
        )}
        {!bearbeiten && (
          <button
            type="button"
            className="vp-gwk-chip calc"
            data-zustand={chipZustand}
            aria-label={`${m.name || SUMMENWERT}: Herkunft und Werte öffnen (${chipZustand})`}
            onClick={onWerte}
          >
            berechnet · {chipZustand}
          </button>
        )}
        {!bearbeiten && (
          <span className="vp-gwk-menu">
            <RowMenu items={menu} />
          </span>
        )}
      </div>
      <div className="vp-gwk-value">
        {angehalten ? (
          <span className="vp-gwk-paused">angehalten</span>
        ) : wert == null ? (
          <span className="vp-gwk-unknown">—</span>
        ) : wert.unvollstaendig ? (
          <span className="vp-gwk-incomplete">unvollständig</span>
        ) : (
          <span className="vp-gwk-big">{fmtNum(wert.wert, wert.einheit ?? '', stellen(wert.wert))}</span>
        )}
      </div>
      {!angehalten && wert?.unvollstaendig && (
        <p className="vp-gwk-note">Ein Wert fehlt gerade — der Summenwert bleibt leer statt zu klein.</p>
      )}
    </div>
  );
}

function stellen(wert: number | null): number {
  if (wert == null) return 1;
  const a = Math.abs(wert);
  return a >= 100 ? 0 : a >= 10 ? 1 : 2;
}

/**
 * Die Gesamtwerte DIESER Anlage samt ihrem Live-Wert. Die Zuordnung (welche
 * berechnete Messstelle zu dieser Anlage gehört) kommt aus `gesamtwertQuelle`;
 * hier kommt je Zeile nur noch ihr aktueller Wert (`GET …/wert`) dazu.
 */
async function ladeSiteGesamtwerte(siteId: string): Promise<GwZeile[]> {
  const quellen = await ladeQuellen(siteId);
  return Promise.all(
    quellen.map(async ({ messstelle, formel }): Promise<GwZeile> => {
      const wert = await api.messstelleWert(messstelle.id).catch(() => null);
      return { messstelle, formel, wert };
    }),
  );
}
