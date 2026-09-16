import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type GeraetSummenwert } from "../api";
import { RolleAendernDialog } from "./RolleAendernDialog";

export const zeile: GeraetSummenwert = {
  messstelle: {
    id: "m1",
    name: "Dach West",
    kennzeichen: "MS-0042",
    art: "berechnet",
    medium: "Strom",
    lebenszyklus: "aktiv",
    fehlt: [],
    notiz: null,
    hauptgroesse: {
      groesse: "Wirkleistung",
      wertart: "Momentanwert",
      einheit: "kW",
      richtung: "Erzeugung",
    },
  },
  rolle: "pv",
  wert: {
    wert: 14.4,
    einheit: "kW",
    stand: "2026-09-16T08:15:00Z",
    unvollstaendig: false,
    fehlende: [],
  },
};
afterEach(() => vi.restoreAllMocks());
function Wirt() {
  const [offen, setOffen] = useState(false);
  return (
    <>
      <button
        onClick={(e) => {
          e.currentTarget.focus();
          setOffen(true);
        }}
      >
        Rolle ändern
      </button>
      {offen && (
        <RolleAendernDialog
          siteId="s1"
          entityId="e1"
          zeile={zeile}
          onClose={() => setOffen(false)}
          onGespeichert={() => {}}
        />
      )}
    </>
  );
}
describe("Rolle ändern", () => {
  it("hält den Fokus im Modal und kehrt mit Escape zum Auslöser zurück", async () => {
    render(<Wirt />);
    const start = screen.getByRole("button", { name: "Rolle ändern" });
    fireEvent.click(start);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    const uebernehmen = screen.getByRole("button", { name: "Übernehmen" });
    uebernehmen.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(start);
  });
  it("entzieht nur die Zuordnung und lässt den Summenwert bestehen", async () => {
    const del = vi
      .spyOn(api, "rolleEntziehen")
      .mockResolvedValue({ zugeordnet: null, abgeloest: null });
    const archiv = vi.spyOn(api, "messstelleArchivieren");
    render(<Wirt />);
    fireEvent.click(screen.getByText("Rolle ändern"));
    fireEvent.click(screen.getByRole("radio", { name: /keine Rolle/ }));
    fireEvent.click(screen.getByText("Übernehmen"));
    await waitFor(() => expect(del).toHaveBeenCalledWith("s1", "e1", "pv"));
    expect(archiv).not.toHaveBeenCalled();
  });
  it("setzt die Rolle an allen beteiligten Geräten über den Anlagenweg", async () => {
    const put = vi
      .spyOn(api, "anlageRolleZuordnen")
      .mockResolvedValue({ geraete: [] });
    render(
      <RolleAendernDialog
        siteId="s1"
        entityId="e1"
        zeile={{ ...zeile, rolle: null }}
        onClose={() => {}}
        onGespeichert={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /PV-Produktion/ }));
    fireEvent.click(screen.getByText("Übernehmen"));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("s1", "pv", "m1", false),
    );
  });
  it("ersetzt einen belegten Netzwert erst nach ausdrücklicher Bestätigung", async () => {
    const put = vi
      .spyOn(api, "anlageRolleZuordnen")
      .mockRejectedValueOnce(
        new ApiError(409, "Netzwert ist bereits belegt.", {
          code: "netz_mehrfach",
        }),
      )
      .mockResolvedValueOnce({ geraete: [] });
    const netz = {
      ...zeile,
      rolle: null,
      messstelle: {
        ...zeile.messstelle,
        hauptgroesse: {
          ...zeile.messstelle.hauptgroesse!,
          richtung: "richtungslos",
        },
      },
    };
    render(
      <RolleAendernDialog
        siteId="s1"
        entityId="e1"
        zeile={netz}
        onClose={() => {}}
        onGespeichert={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /^Netz/ }));
    fireEvent.click(screen.getByText("Übernehmen"));
    const checkbox = await screen.findByRole("checkbox");
    expect(screen.getByText("Übernehmen")).toBeDisabled();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByText("Übernehmen"));
    await waitFor(() =>
      expect(put).toHaveBeenLastCalledWith("s1", "grid", "m1", true),
    );
  });
});
