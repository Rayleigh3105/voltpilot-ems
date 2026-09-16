import { Recht } from './Recht';
import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type Messkanal, type MessstelleRegisterZeile, type StandorteAmStichtag } from '../api';
import { jetztEingabe, kanalZeile, zeitpunktAus } from '../geraetEinstellungen';
import { ablehnung, anlageWahlen, komponenteAus, komponenteWert, type KomponenteWahl } from '../messstelleDialog';
import {
  bindenPruefen,
  folgenSatz,
  GILT_AB,
  keinZielSatz,
  KNOPF,
  komponenteOptionen,
  messwertOptionen,
  messwertZeilen,
  TITEL,
  UHRZEIT,
  WAS_GESCHIEHT,
  zielOptionen,
  zielZeilen,
  zweckOptionen,
  type BindenEingabe,
  type BindenKontext,
  type BindenZiel,
  type BindungsRolle,
} from '../quelleBinden';
import { rueckwirkung, type Groesse } from '../uemsMessstelle';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import { VpTimePicker } from './VpTimePicker';
import './QuelleBindenDialog.css';

/**
 * „Quelle binden“ und „Vergleichsquelle hinzufügen“ (UEMS AP-04 IP-14, D3 · V1) als zentriertes
 * `Modal` — am Telefon Vollbild. Der Dialog rendert nur; jede Ableitung steht in `quelleBinden.ts`.
 *
 * ZWEI EINSTIEGE, EIN DIALOG (§5.2):
 * - `{ art: 'messstelle' }` — von der Messstellen-Seite: die Zielgröße steht fest, gewählt werden
 *   Komponente und Messwert.
 * - `{ art: 'messwert' }` — „Als Messstelle verwenden“ an der Komponente: der Messwert steht fest,
 *   gewählt wird die Messstellen-Größe, die ihn lesen soll.
 *
 * In beiden Richtungen urteilt dieselbe Regel 7, und in beiden steht das, was NICHT passt, GRAU in
 * der Liste — mit dem Satz, warum.
 */

export type QuelleBindenZiel =
  | {
      art: 'messstelle';
      messstelleId: string;
      kennzeichen: string;
      groesse: Groesse;
      hauptgroesse: boolean;
      /** Die Anlage, deren Komponenten zuerst gezeigt werden; `null` = alle. */
      anlageId?: string | null;
    }
  | {
      art: 'messwert';
      anlageId: string;
      entityId: string;
      kanal: Messkanal;
    };

export interface QuelleBindenDialogProps {
  open: boolean;
  rolle: BindungsRolle;
  ziel: QuelleBindenZiel;
  /** Die Uhr des Dialogs (Tests und Bühne); ohne sie „jetzt“. */
  jetzt?: string;
  onClose: () => void;
  /** Nach einem erfolgreichen Eintrag — die Fläche liest danach neu. */
  onGebunden: () => void;
}

export function QuelleBindenDialog({ open, rolle, ziel, jetzt, onClose, onGebunden }: QuelleBindenDialogProps) {
  const feldId = useId();
  const uhr = useMemo(() => jetzt ?? new Date().toISOString(), [jetzt, open]);
  const [eingabe, setEingabe] = useState<BindenEingabe>(() => leereEingabe(uhr, ziel));
  const [standorte, setStandorte] = useState<StandorteAmStichtag | null>(null);
  const [komponenten, setKomponenten] = useState<KomponenteWahl[] | null>(null);
  const [kanaele, setKanaele] = useState<Messkanal[] | null>(null);
  const [register, setRegister] = useState<MessstelleRegisterZeile[] | null>(null);
  const [beruehrt, setBeruehrt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverFehler, setServerFehler] = useState<{ feld: string | null; satz: string } | null>(null);
  const [fertig, setFertig] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEingabe(leereEingabe(uhr, ziel));
    setBeruehrt(false);
    setServerFehler(null);
    setFertig(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Der Einstieg an der Messstelle braucht die Anlagen und ihre Komponenten.
  useEffect(() => {
    if (!open || ziel.art !== 'messstelle') return undefined;
    let aktiv = true;
    api.standorte().then(
      (s) => aktiv && setStandorte(s),
      () => aktiv && setStandorte(null),
    );
    return () => {
      aktiv = false;
    };
  }, [open, ziel.art]);

  // Kennt die Fläche die Anlage der Messstelle (ihre elektrische Stellung), zeigt der Dialog NUR
  // deren Komponenten: eine Messstelle liest aus dem Gerät ihrer eigenen Anlage. Ohne Stellung
  // bleiben alle — dann weiß niemand etwas Besseres, und geraten wird nichts.
  const nurAnlage = ziel.art === 'messstelle' ? (ziel.anlageId ?? null) : null;
  const anlagen = useMemo(
    () => (standorte ? anlageWahlen(standorte, null).filter((a) => !nurAnlage || a.id === nurAnlage) : []),
    [standorte, nurAnlage],
  );
  const anlagenSchluessel = anlagen.map((a) => a.id).join(',');
  useEffect(() => {
    if (!open || ziel.art !== 'messstelle' || anlagen.length === 0) return undefined;
    let aktiv = true;
    setKomponenten(null);
    void Promise.all(
      anlagen.map((a) =>
        api.siteEntities(a.id).then(
          (r) => r.entities.map((entity): KomponenteWahl => ({ anlageId: a.id, anlageName: a.name, entity })),
          () => [] as KomponenteWahl[],
        ),
      ),
    ).then((listen) => aktiv && setKomponenten(listen.flat()));
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ziel.art, anlagenSchluessel]);

  // Die Messwerte der gewählten Komponente.
  useEffect(() => {
    if (!open || ziel.art !== 'messstelle') return undefined;
    const k = komponenteAus(eingabe.komponente);
    if (!k) {
      setKanaele(null);
      return undefined;
    }
    let aktiv = true;
    setKanaele(null);
    api.komponenteMesskanaele(k.anlageId, k.entityId).then(
      (l) => aktiv && setKanaele(l.messkanaele),
      () => aktiv && setKanaele([]),
    );
    return () => {
      aktiv = false;
    };
  }, [open, ziel.art, eingabe.komponente]);

  // Der Einstieg am Messwert braucht das Register: welche Messstellen-Größe kann ihn lesen?
  useEffect(() => {
    if (!open || ziel.art !== 'messwert') return undefined;
    let aktiv = true;
    setRegister(null);
    api.messstellenRegister().then(
      (r) => aktiv && setRegister(r.register),
      () => aktiv && setRegister([]),
    );
    return () => {
      aktiv = false;
    };
  }, [open, ziel.art]);

  const ziele = useMemo(
    () => (ziel.art === 'messwert' && register ? zielZeilen(register, ziel.kanal, rolle) : []),
    [ziel, register, rolle],
  );
  const gewaehltesZiel: BindenZiel | null = useMemo(() => {
    if (ziel.art === 'messstelle') {
      return {
        messstelleId: ziel.messstelleId,
        kennzeichen: ziel.kennzeichen,
        groesse: ziel.groesse,
        hauptgroesse: ziel.hauptgroesse,
      };
    }
    const z = ziele.find((x) => x.wert === eingabe.ziel && x.passend);
    return z
      ? { messstelleId: z.messstelleId, kennzeichen: z.messstelle.split(' · ')[0], groesse: z.groesse, hauptgroesse: z.hauptgroesse }
      : null;
  }, [ziel, ziele, eingabe.ziel]);

  const zielGroesse = gewaehltesZiel?.groesse ?? null;
  const zeilen = useMemo(
    () =>
      ziel.art === 'messstelle' && zielGroesse && kanaele
        ? messwertZeilen(kanaele, zielGroesse, { rolle, eigenesKennzeichen: ziel.kennzeichen, anteil: true })
        : [],
    [ziel, zielGroesse, kanaele, rolle],
  );

  const messwert: BindenKontext['messwert'] = useMemo(() => {
    if (ziel.art === 'messstelle') {
      const k = komponenteAus(eingabe.komponente);
      const z = zeilen.find((x) => x.kanal === eingabe.kanal);
      return k && z ? { ...z, komponente: k.entityId } : null;
    }
    const z = ziele.find((x) => x.wert === eingabe.ziel);
    return z
      ? {
          kanal: ziel.kanal.kanal,
          name: ziel.kanal.anzeigename ?? ziel.kanal.kanal,
          detail: null,
          passend: z.passend,
          anteil: z.anteil,
          herleitung: null,
          grund: z.grund,
          komponente: ziel.entityId,
        }
      : null;
  }, [ziel, zeilen, ziele, eingabe.komponente, eingabe.kanal, eingabe.ziel]);

  const urteil = bindenPruefen(eingabe, { rolle, ziel: gewaehltesZiel, messwert }, zeitpunktAus);
  const lokal = beruehrt ? urteil.fehler : {};
  const komponenteName =
    komponenten?.find((k) => komponenteWert(k.anlageId, k.entity.id) === eingabe.komponente)?.entity.label ?? null;

  const folgen =
    urteil.anfrage && gewaehltesZiel && messwert && urteil.zeitpunkt
      ? folgenSatz({
          rolle,
          kennzeichen: gewaehltesZiel.kennzeichen,
          zeitpunkt: urteil.zeitpunkt,
          jetzt: uhr,
          komponente:
            ziel.art === 'messstelle'
              ? (komponenteName ?? 'Komponente')
              : (ziel.kanal.anzeigename ?? ziel.kanal.kanal),
          messwert: messwert.name,
          zweck: rolle === 'vergleich' ? eingabe.zweck : null,
          anteil: messwert.anteil,
          richtung: gewaehltesZiel.groesse.richtung,
          rueckwirkendAbzeichen: rueckwirkung(uhr, urteil.zeitpunkt).abzeichen,
        })
      : null;

  async function binden() {
    setBeruehrt(true);
    if (!urteil.anfrage || !urteil.messstelleId) return;
    setBusy(true);
    setServerFehler(null);
    try {
      await api.messstelleQuelleBinden(urteil.messstelleId, urteil.anfrage);
      setFertig(folgen);
      onGebunden();
    } catch (e) {
      const a = ablehnung(e instanceof ApiError ? e : null, { schritt: 3, anlageName: () => null });
      setServerFehler({ feld: a.feld, satz: a.satz });
    } finally {
      setBusy(false);
    }
  }

  const feld = (name: string) => `${feldId}-${name}`;
  const serverAn = (name: string) => (serverFehler?.feld === name ? serverFehler.satz : undefined);

  return (
    <Modal open={open} onClose={onClose} title={TITEL[rolle]} footer={fuss()}>
      <div className="vp-qb" data-testid="quelle-binden">
        {fertig ? (
          <p className="vp-qb-fertig" role="status" data-testid="quelle-gebunden">
            <Icon name="check" size={20} />
            <span>{fertig}</span>
          </p>
        ) : (
          <>
            {ziel.art === 'messstelle' ? (
              <>
                <p className="vp-qb-vorspann" data-testid="quelle-ziel">
                  {gewaehltesZiel?.kennzeichen} · {ziel.groesse.groesse} · {ziel.groesse.richtung} ·{' '}
                  {ziel.groesse.einheit} · {ziel.groesse.wertart}
                </p>
                <VpPicker
                  id={feld('komponente')}
                  label="Komponente"
                  placeholder="Komponente wählen"
                  options={komponenteOptionen(komponenten ?? [])}
                  loading={komponenten === null}
                  value={eingabe.komponente || null}
                  onChange={(v) => setzen({ komponente: v, kanal: '' })}
                />
                {eingabe.komponente && (
                  <VpPicker
                    id={feld('kanal')}
                    label="Messwert"
                    placeholder="Messwert wählen"
                    options={zielGroesse ? messwertOptionen(zeilen, zielGroesse) : []}
                    loading={kanaele === null}
                    value={eingabe.kanal || null}
                    onChange={(v) => setzen({ kanal: v })}
                    error={serverAn('kanal') ?? lokal.kanal}
                  />
                )}
              </>
            ) : (
              <>
                {/* Die Zeile des Messwerts wie im Messkanal-Read-Model — in KUNDENWÖRTERN
                    („Zählerstand · kWh · alle 15 min“), nie im Katalogwort `counter`. */}
                <p className="vp-qb-vorspann" data-testid="quelle-messwert">
                  {[kanalZeile(ziel.kanal).name, kanalZeile(ziel.kanal).detail].filter(Boolean).join(' · ')}
                </p>
                {register !== null && ziele.every((z) => !z.passend) ? (
                  <p className="vp-qb-grund" data-testid="quelle-kein-ziel">
                    {keinZielSatz(ziele, ziel.kanal.anzeigename ?? ziel.kanal.kanal)}
                  </p>
                ) : (
                  <VpPicker
                    id={feld('ziel')}
                    label="Messstelle und Messgröße"
                    placeholder="Messstelle wählen"
                    options={zielOptionen(ziele)}
                    loading={register === null}
                    value={eingabe.ziel || null}
                    onChange={(v) => setzen({ ziel: v })}
                    error={serverAn('kanal') ?? lokal.ziel}
                  />
                )}
              </>
            )}

            {rolle === 'vergleich' && (
              <VpPicker
                id={feld('zweck')}
                label="Zweck *"
                placeholder="Zweck wählen"
                options={zweckOptionen()}
                value={eingabe.zweck || null}
                onChange={(v) => setzen({ zweck: v })}
                error={lokal.zweck}
              />
            )}

            <div className="vp-qb-zeit">
              <VpDatePicker
                id={feld('zeitpunkt')}
                label={GILT_AB}
                value={eingabe.datum}
                onChange={(v) => setzen({ datum: v })}
                error={serverAn('zeitpunkt') ?? lokal.zeitpunkt}
              />
              <VpTimePicker label={UHRZEIT} value={eingabe.uhrzeit} onChange={(v) => setzen({ uhrzeit: v })} />
            </div>

            {folgen && (
              <p className="vp-qb-folgen" data-testid="quelle-folgen">
                <span className="vp-qb-folgen-titel">{WAS_GESCHIEHT}</span>
                {folgen}
              </p>
            )}
            {serverFehler && serverFehler.feld === null && <p className="vp-qb-fehler">{serverFehler.satz}</p>}
          </>
        )}
      </div>
    </Modal>
  );

  function setzen(teil: Partial<BindenEingabe>) {
    setServerFehler(null);
    setEingabe((e) => ({ ...e, ...teil }));
  }

  function fuss() {
    if (fertig) return <Button onClick={onClose}>Schließen</Button>;
    return (
      <>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Abbrechen
        </Button>
        <Recht aktion="messstelle.quelle" rueckwirkend={Boolean(urteil.zeitpunkt && rueckwirkung(uhr, urteil.zeitpunkt).art === 'rueckwirkend')}><Button onClick={() => void binden()} disabled={busy}>
          {KNOPF[rolle]}
        </Button></Recht>
      </>
    );
  }
}

function leereEingabe(jetzt: string, ziel: QuelleBindenZiel): BindenEingabe {
  const t = jetztEingabe(jetzt);
  return {
    ziel: '',
    komponente: ziel.art === 'messwert' ? komponenteWert(ziel.anlageId, ziel.entityId) : '',
    kanal: ziel.art === 'messwert' ? ziel.kanal.kanal : '',
    zweck: '',
    datum: t.datum,
    uhrzeit: t.uhrzeit,
  };
}
