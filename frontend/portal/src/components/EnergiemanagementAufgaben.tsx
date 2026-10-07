import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type EnergiemanagementAufgaben as Stand, type EnergiemanagementPerson, type EnergiemanagementZuordnung } from '../api';
import * as T from '../aufgabenBild';
import * as E from '../energiemanagementPortal';
import { merkeAbruf, routenHeute } from '../routenUhr';
import { useRollen } from '../rollen';
import { useIsPhone } from '../useIsPhone';
import { PersonAnlegenDialog } from './DokumentDialoge';
import { AufgabeZuordnenDialog, ZuordnungBeendenDialog } from './EnergiemanagementAufgabeDialoge';
import { EinsichtRecht } from './EinsichtRecht';
import { GrenzSatz } from './GrenzSatz';
import { NwBlatt } from './nachweisen/NwBlatt';
import { NwKopf } from './nachweisen/NwKopf';
import { PruefZeilen } from './nachweisen/NwSchritte';
import { StatusZeile } from './nachweisen/NwStatus';
import { NwZeichen } from './nachweisen/NwZeichen';
import { Fakt, Kuerzel, NwKarte, NwZeile, NwZeilen } from './nachweisen/NwZeilen';
import { RowMenu } from './RowMenu';
import { VpDatePicker } from './VpDatePicker';

/**
 * Reiter „Aufgaben“ (Konzept Nachweisen n1 Runde 2, §6.8, Entscheid 23; vorher IP-13, PA1–PA3): „Wer macht was“ am Tag
 * der Route, die Status-Zeile „● jede Aufgabe hat eine Person“ (oder wie viele keine haben), je Aufgabe eine Zeile mit
 * Kurzwort und Kürzeln - am Rechner dazu der Name. Name, Vertretung, seit wann, „entschieden von“, Beleg und Beschluss
 * stehen im Blatt der Aufgabe; dort auch Zuordnen und Beenden. Die Personen stehen am Rechner rechts, am Telefon hinter
 * „Personen“. Ohne gewählten Tag fragt der Reiter die Route und nimmt ihren Tag (Befund 3); „Stand an einem anderen Tag“
 * und „Wer ist wofür verantwortlich“ stehen im Menü „…“. Zuordnen, Beenden und Person anlegen nur mit
 * `energiemanagement.verwalten`.
 */
export function EnergiemanagementAufgaben({ onPerson, onVerantwortung }: { onPerson: (id: string) => void; onVerantwortung: () => void }) {
  const rollen = useRollen();
  const darf = rollen.darf(E.RECHT_VERWALTEN, null);
  const isPhone = useIsPhone();
  // Konzept Nachweisen n1, Befund 3: ohne gewählten Tag fragt der Reiter die Route - „heute“ ist ihr Tag, nie der des
  // Browsers (in der Prüfumgebung lag zwischen beiden das Jahr 2026 neben 2029).
  const [gewaehlt, setGewaehlt] = useState<string | null>(null);
  const [stand, setStand] = useState<Stand | null>(null);
  const [personen, setPersonen] = useState<EnergiemanagementPerson[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [neu, setNeu] = useState(0);
  const [zuordnen, setZuordnen] = useState<{ aufgabe: string | null } | null>(null);
  const [beenden, setBeenden] = useState<EnergiemanagementZuordnung | null>(null);
  const [personDialog, setPersonDialog] = useState(false);
  const [blatt, setBlatt] = useState<null | 'personen' | 'tag' | { aufgabe: string }>(null);
  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    Promise.all([api.energiemanagementAufgaben(gewaehlt ?? undefined), api.energiemanagementPersonen()]).then(
      ([a, p]) => {
        if (!aktiv) return;
        if (gewaehlt === null) merkeAbruf(a.tag);
        setStand(a);
        setPersonen(p.personen);
      },
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [gewaehlt, neu]);
  const tag = gewaehlt ?? stand?.tag ?? routenHeute();
  const gespeichert = () => {
    setZuordnen(null);
    setBeenden(null);
    setPersonDialog(false);
    setBlatt(null);
    setNeu((n) => n + 1);
  };

  const zeilen = stand ? T.aufgabenZeilen(stand) : [];
  const status = stand ? T.aufgabenStatus(zeilen) : null;
  const leute = personen && stand ? T.personenZeilen(personen, stand) : [];
  const offen = typeof blatt === 'object' && blatt ? (zeilen.find((z) => z.aufgabe === blatt.aufgabe) ?? null) : null;

  // Am Rechner steht „Aufgabe zuordnen“ als Knopf neben dem Menü (Desktop-Mock r2d-T1), am Telefon nur im Menü.
  const menue = (
    <span className="vp-nw-kopf-knoepfe">
      {!isPhone && darf && (
        <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
          <Button variant="outline" size="sm" iconLeft={<Icon name="plus" size={16} />} onClick={() => setZuordnen({ aufgabe: null })} data-testid="aufgaben-zuordnen">
            {E.KNOPF_ZUORDNEN}
          </Button>
        </EinsichtRecht>
      )}
      <RowMenu
      label="Weitere Aktionen"
      items={[
        { label: E.KNOPF_ZUORDNEN, recht: E.RECHT_VERWALTEN, standort: null, onClick: () => setZuordnen({ aufgabe: null }) },
        { label: E.KNOPF_PERSON, recht: E.RECHT_VERWALTEN, standort: null, onClick: () => setPersonDialog(true) },
        { label: 'Stand an einem anderen Tag', onClick: () => setBlatt('tag') },
        { label: E.KNOPF_VERANTWORTUNG, onClick: onVerantwortung },
      ]}
      />
    </span>
  );

  // Am Rechner mit Kürzel (Mock r2d-T1); im Blatt am Telefon steht der Name allein (Blatt ≤ 35 Wörter).
  const personenListe = (
    <NwZeilen testId="personen-liste">
      {leute.map((z) => (
        <NwZeile
          key={z.person.id}
          vorn={isPhone ? undefined : <Kuerzel personen={[{ name: z.person.name, kuerzel: z.person.kuerzel }]} />}
          titel={z.person.name}
          unter={z.person.funktion}
          rechts={T.personFakt(z) ? <Fakt>{T.personFakt(z)}</Fakt> : undefined}
          leise={z.person.zustand !== 'aktiv'}
          onClick={() => onPerson(z.person.id)}
          testId={`person-zeile-${z.person.kuerzel ?? z.person.id}`}
        />
      ))}
    </NwZeilen>
  );

  return (
    <div className="vp-nw-seite is-reiter" data-testid="aufgaben-reiter">
      <NwKopf
        titel="Aufgaben"
        erklaerung={T.erklaerungAufgabe(zeilen, tag)}
        kurzzeile={stand ? `${T.KURZZEILE} · Stand ${E.tagText(tag)}` : T.KURZZEILE}
        status={status && <StatusZeile zeichen={<NwZeichen art={status.zeichen} />} text={status.text} testId="aufgaben-status" />}
        menue={menue}
        testId="aufgaben-kopf"
      />
      {fehler ? (
        <p className="vp-ez-fehler" role="alert">
          {fehler}
        </p>
      ) : !stand ? (
        <p className="vp-ez-leise">Wird geladen …</p>
      ) : (
        <div className="vp-nw-zwei">
          <div className="vp-nw-spalte-haupt">
            <NwKarte titel="Aufgaben" zahl={zeilen.length} testId="aufgaben-liste">
              <NwZeilen>
                {zeilen.map((z) => (
                  <NwZeile
                    key={z.aufgabe}
                    titel={z.kurz}
                    rechts={
                      z.personen.length ? (
                        <span className="vp-nw-personen">
                          <span className="vp-nw-nur-breit">{T.personenWort(z.personen)}</span>
                          <Kuerzel personen={z.personen} />
                        </span>
                      ) : (
                        <Fakt>keine Person</Fakt>
                      )
                    }
                    verb={!z.personen.length && darf ? 'Zuordnen' : undefined}
                    onClick={() => setBlatt({ aufgabe: z.aufgabe })}
                    testId={`aufgabe-${z.aufgabe}`}
                  />
                ))}
              </NwZeilen>
            </NwKarte>
          </div>
          <div className="vp-nw-spalte-seite">
            {isPhone ? (
              <NwZeilen>
                <NwZeile titel={T.PERSONEN} rechts={<Fakt>{leute.filter((z) => z.person.zustand === 'aktiv').length}</Fakt>} onClick={() => setBlatt('personen')} testId="aufgaben-personen" />
              </NwZeilen>
            ) : (
              <NwKarte
                titel={T.PERSONEN}
                zahl={leute.filter((z) => z.person.zustand === 'aktiv').length}
                rechts={
                  darf ? (
                    <button type="button" className="vp-nw-kk-verb" onClick={() => setPersonDialog(true)} data-testid="aufgaben-person-anlegen">
                      {E.KNOPF_PERSON}
                    </button>
                  ) : undefined
                }
              >
                {personenListe}
              </NwKarte>
            )}
          </div>
        </div>
      )}
      {/* Grenz- und Verantwortungs-Satz stehen einmal am Fuß des Bereichs („Was VoltPilot leistet“, K7/D5). */}
      <GrenzSatz verantwortung />

      <NwBlatt open={!!offen} titel={offen?.wort ?? ''} onClose={() => setBlatt(null)} testId="aufgabe-blatt">
        {offen && (
          <div className="vp-nw-schritt-inhalt" data-entscheid={offen.ohnePerson ? 'aufgabe_festlegen' : undefined} data-entscheid-kennzeichen={offen.aufgabe}>
            {offen.ohnePerson && <p className="vp-nw-leise" data-testid="aufgabe-ohne-person">{offen.ohnePerson}</p>}
            {[...offen.laufend, ...offen.spaeter].map((z) => (
              <div key={z.id} className="vp-nw-schritt-inhalt" data-testid={`zuordnung-${z.aufgabe}-${z.person.kuerzel ?? z.person.id}`}>
                <PruefZeilen
                  zeilen={[
                    { etikett: 'Person', wert: <a href="#" onClick={(e) => (e.preventDefault(), onPerson(z.person.id))}>{z.person.name}</a> },
                    ...(z.vertretung ? [{ etikett: 'Vertretung', wert: z.vertretung.name }] : []),
                    { etikett: 'Gilt', wert: T.seitWort(z, tag) },
                    ...(z.entschieden_von ? [{ etikett: 'Entschieden von', wert: z.entschieden_von.name }] : []),
                    ...(z.beschluss_kennung ? [{ etikett: 'Beschluss', wert: z.beschluss_kennung }] : []),
                    ...(z.beleg?.ablage ? [{ etikett: 'Beleg', wert: [z.beleg.bezeichnung, z.beleg.ablage].filter(Boolean).join(' · ') }] : []),
                  ]}
                />
                {darf && z.gilt_ab <= tag && (
                  <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setBlatt(null);
                        setBeenden(z);
                      }}
                      data-testid="zuordnung-beenden"
                    >
                      {E.KNOPF_BEENDEN}
                    </Button>
                  </EinsichtRecht>
                )}
              </div>
            ))}
            {/* Mit „Einsicht“ steht hier der Leer-Satz statt des Knopfs (R6); ohne Recht und ohne Einsicht nichts. */}
            <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
              <Button
                variant={offen.ohnePerson ? 'primary' : 'outline'}
                onClick={() => {
                  setBlatt(null);
                  setZuordnen({ aufgabe: offen.aufgabe });
                }}
                data-testid="aufgabe-zeile-zuordnen"
                data-entscheid-schritt
              >
                {E.KNOPF_ZUORDNEN}
              </Button>
            </EinsichtRecht>
          </div>
        )}
      </NwBlatt>
      {/* „Person anlegen“ steht am Telefon im Menü „…“. */}
      <NwBlatt open={blatt === 'personen'} titel={T.PERSONEN} onClose={() => setBlatt(null)} testId="personen-blatt">
        {personenListe}
      </NwBlatt>
      <NwBlatt open={blatt === 'tag'} titel="Stand am" onClose={() => setBlatt(null)} testId="aufgaben-tag-blatt">
        <VpDatePicker
          label="Tag"
          value={tag}
          onChange={(t) => {
            if (!t) return;
            setGewaehlt(t);
            setBlatt(null);
          }}
        />
      </NwBlatt>

      {zuordnen && <AufgabeZuordnenDialog aufgabe={zuordnen.aufgabe} ab={tag} onClose={() => setZuordnen(null)} onZugeordnet={gespeichert} />}
      {beenden && <ZuordnungBeendenDialog zuordnung={beenden} ab={tag} onClose={() => setBeenden(null)} onBeendet={gespeichert} />}
      {personDialog && <PersonAnlegenDialog leitung={false} ab={tag} onClose={() => setPersonDialog(false)} onAngelegt={gespeichert} />}
    </div>
  );
}
