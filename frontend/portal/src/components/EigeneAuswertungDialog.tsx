import { Recht } from './Recht';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import type { VpOption } from '../picker/optionen';
import { VpPicker } from './VpPicker';
import {
  AGGREGATE,
  MAX_TITEL,
  aggregatLabel,
  aggregatSatz,
  ausEntwurf,
  einheit,
  entwurfFehler,
  erlaubt,
  grund,
  leererEntwurf,
  nachKanalwechsel,
  titelVorschlag,
  vorlagen,
  zuEntwurf,
  type Darstellung,
  type EigeneAuswertungDef,
  type Entwurf,
} from '../eigeneAuswertung';
import { api } from '../api';
import { measurementTree, v1FallbackTree, type VerlaufGroup } from '../verlauf';
import './EigeneAuswertung.css';

/**
 * Der GEFÜHRTE Dialog „Eigene Auswertung" (Anwendungs-Programm Stufe 5): erst
 * die Komponente, dann ihr Messwert, dann die Kennzahl, dann die Darstellung,
 * zuletzt die Überschrift — in dieser Reihenfolge, weil jede Frage die nächste
 * überhaupt erst beantwortbar macht.
 *
 * Render-only: jede Regel liegt im reinen `src/eigeneAuswertung.ts`.
 *
 * ## ⚠ Was hier NICHT passiert: raten
 *
 * Die Auswahl der Komponenten und Messwerte ist DIESELBE, aus der der
 * Messwerte-Explorer seinen Baum baut (`verlauf.measurementTree`) — kein
 * zweiter Katalog, keine zweite Namensbildung. Und eine Kennzahl, die auf dem
 * gewählten Kanal nicht ehrlich wäre, wird gar nicht erst angeboten: sie bleibt
 * SICHTBAR und nennt ihren Grund (die Haus-Regel „eine Sperre ohne Grund ist
 * ein Rätsel"), statt still zu verschwinden.
 */
export function EigeneAuswertungDialog({
  open,
  siteId,
  bearbeiten,
  onSpeichern,
  onEntfernen,
  onAbbrechen,
}: {
  open: boolean;
  siteId: string;
  /** Eine bestehende Auswertung zum Ändern, oder null = neu anlegen. */
  bearbeiten: EigeneAuswertungDef | null;
  onSpeichern: (def: Omit<EigeneAuswertungDef, 'id'> & { id?: string | null }) => void;
  onEntfernen?: (id: string) => void;
  onAbbrechen: () => void;
}) {
  const [entwurf, setEntwurf] = useState<Entwurf>(() => leererEntwurf());
  /** Hat der Kunde die Überschrift selbst angefasst? Dann nie überschreiben. */
  const [titelBeruehrt, setTitelBeruehrt] = useState(false);
  const [gruppen, setGruppen] = useState<VerlaufGroup[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setEntwurf(bearbeiten ? zuEntwurf(bearbeiten) : leererEntwurf());
    setTitelBeruehrt(bearbeiten != null);
  }, [open, bearbeiten]);

  /**
   * Der Messwert-Baum wird ERST BEIM ÖFFNEN geholt — die zwei Abrufe gehören
   * nicht auf den heissen Pfad des Cockpits, und der Dialog ist eine seltene,
   * bewusste Handlung. Es ist derselbe Baum wie im Messwerte-Explorer
   * (`measurementTree`), also dieselben Namen und dieselben Kanäle; ohne v2
   * fällt er wie dort auf die Anlagen-Messwerte zurück.
   */
  useEffect(() => {
    if (!open) return undefined;
    let aktiv = true;
    setGruppen(null);
    Promise.all([api.siteEntities(siteId), api.topology(siteId).catch(() => null)])
      .then(([entities, topology]) => {
        if (!aktiv) return;
        const baum = topology ? measurementTree(entities, topology) : [];
        setGruppen(baum.length > 0 ? baum : v1FallbackTree());
      })
      .catch(() => {
        if (aktiv) setGruppen(v1FallbackTree());
      });
    return () => {
      aktiv = false;
    };
  }, [open, siteId]);

  /* Im v1-Rückfall gehören PV, Haus, Netz und Speicher technisch alle zur
     synthetischen Entity `anlage`. Der Picker braucht trotzdem vier eindeutige
     Werte — sonst markiert React vier Zeilen mit demselben Schlüssel und jede
     Wahl landet wieder bei der ersten (PV). Nur der Picker-Wert wird deshalb
     bei Dubletten ergänzt; gespeichert wird weiter die echte Entity-ID. */
  const gruppenAuswahl = useMemo(() => {
    const alle = gruppen ?? [];
    const anzahl = new Map<string, number>();
    for (const g of alle) anzahl.set(g.entityId, (anzahl.get(g.entityId) ?? 0) + 1);
    return alle.map((gruppe, index) => ({
      gruppe,
      value: (anzahl.get(gruppe.entityId) ?? 0) > 1
        ? `${gruppe.entityId}::${index}`
        : gruppe.entityId,
    }));
  }, [gruppen]);

  const komponenten: VpOption[] = useMemo(
    () =>
      gruppenAuswahl.map(({ gruppe, value }) => ({
        value,
        label: gruppe.label,
        sub: gruppe.deviceLine,
      })),
    [gruppenAuswahl],
  );

  const gruppenWahl =
    gruppenAuswahl.find((g) => g.value === entwurf.entityId)
    ?? gruppenAuswahl.find(
      (g) =>
        g.gruppe.entityId === entwurf.entityId
        && g.gruppe.items.some((i) => i.channel === entwurf.channel),
    )
    ?? gruppenAuswahl.find((g) => g.gruppe.entityId === entwurf.entityId)
    ?? null;
  const gruppe = gruppenWahl?.gruppe ?? null;

  const messwerte: VpOption[] = useMemo(
    () =>
      (gruppe?.items ?? []).map((i) => ({
        value: i.channel,
        label: i.label,
        sub: i.unit || null,
      })),
    [gruppe],
  );
  const item = gruppe?.items.find((i) => i.channel === entwurf.channel) ?? null;

  // Der Titel-VORSCHLAG folgt der Auswahl, solange der Kunde ihn nicht selbst
  // angefasst hat — danach nie wieder.
  useEffect(() => {
    if (titelBeruehrt || !gruppe || !item) return;
    setEntwurf((e) => ({
      ...e,
      titel: titelVorschlag(gruppe.rawLabel || gruppe.label, item.label, e.aggregat),
    }));
  }, [titelBeruehrt, gruppe, item, entwurf.aggregat]);

  const fehler = entwurfFehler(entwurf);
  const einheitText = item ? einheit(entwurf.channel, item.unit) : '';

  return (
    <Modal
      open={open}
      onClose={onAbbrechen}
      title={bearbeiten ? 'Eigene Auswertung ändern' : 'Eigene Auswertung'}
      footer={
        <div className="vp-eigen-dialog-footer">
          {bearbeiten && onEntfernen && (
            <Recht aktion="auswertung.anlegen"><Button variant="ghost" onClick={() => onEntfernen(bearbeiten.id)}>
              Entfernen
            </Button></Recht>
          )}
          <Button variant="ghost" onClick={onAbbrechen}>
            Abbrechen
          </Button>
          <Recht aktion="auswertung.anlegen"><Button
            onClick={() => {
              if (fehler) return;
              onSpeichern({
                ...ausEntwurf(
                  { ...entwurf, entityId: gruppe?.entityId ?? entwurf.entityId },
                  bearbeiten?.id ?? '',
                ),
                id: bearbeiten?.id ?? null,
              });
            }}
            disabled={fehler != null}
          >
            {bearbeiten ? 'Übernehmen' : 'Anlegen'}
          </Button></Recht>
        </div>
      }
    >
      <div className="vp-eigen-dialog">
        <p className="vp-eigen-dialog-intro">
          Suchen Sie sich einen Messwert Ihrer Anlage aus — daraus wird eine Kachel oder ein
          Verlauf in Ihrem Cockpit.
        </p>

        {gruppen == null ? (
          <p className="vp-eigen-hinweis">Messwerte werden geladen …</p>
        ) : gruppen.length === 0 ? (
          <p className="vp-eigen-hinweis">
            Ihre Anlage meldet noch keine Messwerte. Sobald das erste Gerät liefert, können Sie
            hier eine eigene Auswertung anlegen.
          </p>
        ) : (
          <>
            <VpPicker
              label="1 · Komponente"
              options={komponenten}
              value={gruppenWahl?.value ?? null}
              onChange={(v) =>
                setEntwurf((e) => ({ ...e, entityId: v, channel: '' }))
              }
              placeholder="Komponente wählen …"
            />

            <VpPicker
              label="2 · Messwert"
              options={messwerte}
              value={entwurf.channel || null}
              onChange={(v) => setEntwurf((e) => nachKanalwechsel(e, v))}
              placeholder={
                entwurf.entityId ? 'Messwert wählen …' : 'Erst eine Komponente wählen'
              }
              disabled={!entwurf.entityId}
              hint={einheitText ? `Gemessen in ${einheitText}.` : undefined}
            />

            <fieldset className="vp-eigen-feld" disabled={!entwurf.channel}>
              <legend>3 · Zeitbezug</legend>
              <div className="vp-eigen-optionen">
                {AGGREGATE.map((a) => {
                  const ok = !entwurf.channel || erlaubt(entwurf.channel, a);
                  const warum = entwurf.channel
                    ? grund(entwurf.channel, a, item?.label)
                    : null;
                  return (
                    <label
                      key={a}
                      className={`vp-eigen-option${ok ? '' : ' is-off'}`}
                      title={warum ?? undefined}
                    >
                      <input
                        type="radio"
                        name="vp-eigen-aggregat"
                        checked={entwurf.aggregat === a}
                        disabled={!ok}
                        onChange={() => setEntwurf((e) => ({ ...e, aggregat: a }))}
                      />
                      <span>
                        <strong>{aggregatLabel(a)}</strong>
                        {/* ⚠ Eine gesperrte Wahl bleibt SICHTBAR und nennt
                            ihren Grund - eine Sperre ohne Grund ist ein
                            Rätsel (die Haus-Regel des Pickers). */}
                        <em>{ok ? aggregatSatz(entwurf.channel, a) : warum}</em>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <fieldset className="vp-eigen-feld">
              <legend>4 · Darstellung</legend>
              <div className="vp-eigen-optionen">
                {vorlagen().map((v) => (
                  <label key={v.id} className="vp-eigen-option">
                    <input
                      type="radio"
                      name="vp-eigen-darstellung"
                      checked={entwurf.darstellung === v.darstellung}
                      onChange={() =>
                        setEntwurf((e) => ({
                          ...e,
                          darstellung: v.darstellung as Darstellung,
                        }))
                      }
                    />
                    <span>
                      <strong>{v.label}</strong>
                      <em>{v.satz}</em>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <Input
              label="5 · Überschrift"
              value={entwurf.titel}
              maxLength={MAX_TITEL}
              onChange={(ev: React.ChangeEvent<HTMLInputElement>) => {
                setTitelBeruehrt(true);
                setEntwurf((e) => ({ ...e, titel: ev.target.value }));
              }}
              hint="So heisst die Kachel in Ihrem Cockpit."
            />

            {fehler && (
              <p className="vp-eigen-fehler" role="alert">
                {fehler}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
