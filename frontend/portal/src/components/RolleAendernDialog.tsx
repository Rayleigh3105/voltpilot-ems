import { useState } from "react";
import { Button } from "../../designsystem/components/core/Button";
import { Modal } from "../../designsystem/components/shell/Modal";
import {
  api,
  ApiError,
  type GeraetSummenwert,
  type SummenwertRolle,
} from "../api";
import { SUMMENWERT } from "../glossar";
import { ROLLEN } from "../uemsRollen";
import "./GeraetSummenwerte.css";

const FOLGEN = {
  pv: "Ersetzt in der Anlagen-Übersicht die PV-Zahl der beteiligten Geräte. Die Summe zählt einmal.",
  consumer:
    "Ersetzt in der Anlagen-Übersicht die Verbrauchszahl der beteiligten Geräte. Ein Teilverbrauch enthält nicht den gesamten Verbrauch der Anlage.",
  grid: "Wird der Netzwert dieser Anlage. Es gibt genau einen maßgeblichen Netzwert.",
  keine: `Die Anlagen-Übersicht verwendet für die beteiligten Geräte wieder den ursprünglichen Wert. Der ${SUMMENWERT} bleibt bestehen.`,
};

export function RolleAendernDialog({
  siteId,
  entityId,
  zeile,
  onClose,
  onGespeichert,
}: {
  siteId: string;
  entityId: string;
  zeile: GeraetSummenwert;
  onClose: () => void;
  onGespeichert: () => void;
}) {
  const [wahl, setWahl] = useState<SummenwertRolle | "keine">(
    zeile.rolle ?? "keine",
  );
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [konflikt, setKonflikt] = useState(false);
  const [ersetzen, setErsetzen] = useState(false);
  const groesse = zeile.messstelle.hauptgroesse;
  const passend = (r: SummenwertRolle | "keine") =>
    r === "keine" ||
    (groesse?.groesse === "Wirkleistung" &&
      groesse.wertart === "Momentanwert" &&
      groesse.einheit === "kW" &&
      groesse.richtung ===
        ({ pv: "Erzeugung", consumer: "Bezug", grid: "richtungslos" } as const)[
          r
        ]);
  async function speichern() {
    if (busy) return;
    setBusy(true);
    setFehler(null);
    try {
      if (wahl === "keine") {
        if (zeile.rolle)
          await api.rolleEntziehen(siteId, entityId, zeile.rolle);
      } else
        await api.anlageRolleZuordnen(
          siteId,
          wahl,
          zeile.messstelle.id,
          ersetzen,
        );
      onGespeichert();
      onClose();
    } catch (e) {
      setFehler(
        e instanceof ApiError
          ? e.message
          : "Die Rolle konnte nicht geändert werden.",
      );
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        (e.body as { code?: string })?.code === "netz_mehrfach"
      )
        setKonflikt(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={`Rolle von „${zeile.messstelle.name || SUMMENWERT}“`}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          {(
            <Button
              onClick={() => void speichern()}
              disabled={busy || !passend(wahl) || (konflikt && !ersetzen)}
            >
              {busy ? "Wird übernommen …" : "Übernehmen"}
            </Button>
          )}
        </>
      }
    >
      <div className="vp-summen-dialog">
        <p>
          Aktuell:{" "}
          <strong>{zeile.rolle ? ROLLEN[zeile.rolle] : "ohne Rolle"}</strong>
        </p>
        <fieldset className="vp-summen-rollen">
          <legend>Verwenden als</legend>
          {(Object.keys(ROLLEN) as Array<SummenwertRolle | "keine">).map(
            (r) => (
              <label key={r}>
                <input
                  type="radio"
                  name="summenwert-rolle"
                  value={r}
                  checked={wahl === r}
                  disabled={!passend(r) || busy}
                  onChange={() => {
                    setWahl(r);
                    setKonflikt(false);
                    setErsetzen(false);
                    setFehler(null);
                  }}
                />
                <span>
                  <strong>{ROLLEN[r]}</strong>
                  <span>{FOLGEN[r]}</span>
                  {!passend(r) && (
                    <small>
                      Die Größe oder Richtung dieses Werts passt nicht zu dieser
                      Rolle.
                    </small>
                  )}
                </span>
              </label>
            ),
          )}
        </fieldset>
        <p className="vp-muted">
          Die Änderung gilt ab jetzt und steht im Änderungsprotokoll der Anlage.
          Frühere Werte bleiben erhalten.
        </p>
        {fehler && <p role="alert">{fehler}</p>}
        {konflikt && (
          <label className="vp-summen-ersatz">
            <input
              type="checkbox"
              checked={ersetzen}
              onChange={(e) => setErsetzen(e.target.checked)}
            />
            Den bisherigen Netzwert dieser Anlage ersetzen.
          </label>
        )}
      </div>
    </Modal>
  );
}
