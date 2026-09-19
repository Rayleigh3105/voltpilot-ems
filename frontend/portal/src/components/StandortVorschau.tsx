import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type Betriebsart, type Site, type StandortZuordnungVorschau } from '../api';
import { useRollen } from '../rollen';
import { VpPicker } from './VpPicker';
import { anfrage, formular, gruppierungAendern, pruefen, wasSichAendert, type VorschlagGruppeForm } from '../standortVorschlag';
import './StandortVorschau.css';

export function NochNichtZugeordnetKarte({ vorschau, onOeffnen }: {
  vorschau: StandortZuordnungVorschau;
  onOeffnen: () => void;
}) {
  if (vorschau.anlagenZahl === 0) return null;
  return (
    <Card className="vp-sv-hinweis" padding="md" radius="md">
      <div>
        <p className="vp-sv-kicker">Noch nicht zugeordnet</p>
        <strong>{vorschau.anlagenZahl} {vorschau.anlagenZahl === 1 ? 'Anlage' : 'Anlagen'}</strong>
        <p>Nächster Schritt: Standorte einrichten.</p>
      </div>
      <Button variant="primary" onClick={onOeffnen}>Standorte einrichten</Button>
    </Card>
  );
}

export function StandortVorschau({ open, vorschau, aktuelleEbene, isAdmin, betriebsart, anlagen, anwendungen, onClose, onBestaetigt }: {
  open: boolean;
  vorschau: StandortZuordnungVorschau | null;
  aktuelleEbene: 'heute' | 'standort' | 'unternehmen';
  isAdmin: boolean;
  betriebsart: Betriebsart | null;
  anlagen: readonly Pick<Site, 'tarifArt'>[];
  anwendungen: readonly string[];
  onClose: () => void;
  onBestaetigt: () => void;
}) {
  const rollen = useRollen();
  const [gruppen, setGruppen] = useState<VorschlagGruppeForm[]>([]);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ausgang = vorschau ? formular(vorschau) : [];

  useEffect(() => {
    if (open && vorschau) {
      setGruppen(formular(vorschau));
      setFehler(null);
    }
  }, [open, vorschau]);

  function setze(id: string, feld: keyof VorschlagGruppeForm, wert: string) {
    setGruppen((alt) => alt.map((g) => g.id === id ? { ...g, [feld]: wert } : g));
    setFehler(null);
  }

  async function bestaetigen(e: FormEvent) {
    e.preventDefault();
    const lokal = pruefen(gruppen);
    if (lokal) { setFehler(lokal); return; }
    setBusy(true);
    try {
      await api.standortZuordnungBestaetigen(anfrage(gruppen));
      onBestaetigt();
    } catch (err) {
      setFehler(err instanceof Error ? err.message : 'Die Zuordnung konnte nicht bestätigt werden.');
    } finally {
      setBusy(false);
    }
  }

  if (!rollen.darf('standort.verwalten', null)) return null;
  const aenderungen = wasSichAendert({ aktuelleEbene, zielGruppen: gruppen.length, isAdmin, betriebsart, anlagen, anwendungen });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Standorte einrichten"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Später</Button>
        <Button type="submit" form="vp-standort-vorschlag" disabled={busy}>Zuordnung bestätigen</Button>
      </>}
    >
      <form id="vp-standort-vorschlag" className="vp-sv" onSubmit={(e) => void bestaetigen(e)} noValidate>
        <header>
          <h2>Vorschau: Ihre Anlagen und Standorte</h2>
          <p>Unser Vorschlag: je Anlage ein Standort. Legen Sie zusammen, was zusammengehört.</p>
          {gruppen.length > 1 ? (
            <Button type="button" variant="outline" onClick={() => setGruppen(gruppierungAendern(gruppen, ausgang, { art: 'alle_zusammen' }))}>
              Alle Anlagen zusammenlegen
            </Button>
          ) : vorschau && vorschau.gruppen.length > 1 ? (
            <Button type="button" variant="outline" onClick={() => setGruppen(gruppierungAendern(gruppen, ausgang, { art: 'alle_getrennt' }))}>
              Wieder getrennt lassen
            </Button>
          ) : null}
        </header>
        {gruppen.map((g) => (
          <Card key={g.id} className="vp-sv-gruppe" padding="md" radius="md">
            <Input label="Name des Standorts *" value={g.name} onChange={(e) => setze(g.id, 'name', e.target.value)} />
            <ul aria-label={`Anlagen für ${g.name || 'diesen Standort'}`}>
              {g.anlagen.map((a) => <li key={a.vorschlagId}>
                <div className="vp-sv-anlage"><strong>{a.anlageName}</strong><span>zugeordnet ab {datum(a.gueltigAb)}</span></div>
                <VpPicker
                  label={`Gehört zu: ${a.anlageName}`}
                  value={g.id}
                  options={[
                    ...gruppen.map((ziel) => ({ value: ziel.id, label: ziel.name.trim() || 'Standort ohne Namen' })),
                    { value: '__eigen__', label: 'Eigener Standort' },
                  ]}
                  onChange={(ziel) => {
                    setGruppen((alt) => gruppierungAendern(alt, ausgang, {
                      art: 'anlage_zuordnen',
                      vorschlagId: a.vorschlagId,
                      zielGruppeId: ziel === '__eigen__' ? null : ziel,
                    }));
                    setFehler(null);
                  }}
                />
              </li>)}
            </ul>
            <div className="vp-sv-adresse">
              <Input label="Straße und Hausnummer *" value={g.strasse} onChange={(e) => setze(g.id, 'strasse', e.target.value)} />
              <Input label="PLZ" inputMode="numeric" value={g.plz} onChange={(e) => setze(g.id, 'plz', e.target.value)} />
              <Input label="Ort *" value={g.ort} onChange={(e) => setze(g.id, 'ort', e.target.value)} />
            </div>
            <p className="vp-sv-zone">Zeitzone {g.zeitzone}</p>
          </Card>
        ))}
        <aside className="vp-sv-folgen" aria-labelledby="vp-sv-aenderungen">
          <p className="vp-sv-vorher">Bis Sie bestätigen, ändert sich nichts.</p>
          <h3 id="vp-sv-aenderungen">Was sich ändert</h3>
          {aenderungen.map((satz) => <p key={satz}>{satz}</p>)}
        </aside>
        {fehler && <p className="vp-sv-fehler" role="alert">{fehler}</p>}
      </form>
    </Modal>
  );
}

function datum(iso: string): string {
  return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T12:00:00Z`));
}
