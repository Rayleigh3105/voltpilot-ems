import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api, type GeraetSummenwert } from "../api";
import { GeraetSummenwerte } from "./GeraetSummenwerte";
vi.mock("./SummenwertAssistent", () => ({ useSummenwertAssistent: () => ({ oeffneSummenwertAssistent: vi.fn(), assistent: null }) }));
const z: GeraetSummenwert = {
  messstelle: {
    id: "m1",
    name: "Dach West",
    kennzeichen: "MS-0042",
    art: "berechnet",
    medium: "Strom",
    lebenszyklus: "aktiv",
    fehlt: [],
    notiz: "bleibt",
    hauptgroesse: {
      groesse: "Wirkleistung",
      wertart: "Momentanwert",
      einheit: "kW",
      richtung: "Erzeugung",
    },
  },
  rolle: null,
  wert: {
    wert: 14.4,
    einheit: "kW",
    stand: "2026-09-16T08:15:00Z",
    unvollstaendig: false,
    fehlende: [],
  },
};
afterEach(() => vi.restoreAllMocks());
it("zeigt rollenlose Summenwerte einmal über alle Komponenten des physischen Geräts", async () => {
  const get = vi.spyOn(api, "geraetSummenwerte").mockResolvedValue([z]);
  render(
    <GeraetSummenwerte
              geraetId="inverter"
      siteId="s1"
      deviceId="d1"
      entityId="e1"
      entityIds={["e1", "e2"]}
      geraetName="Wechselrichter"
    />,
  );
  expect(await screen.findByText("Dach West")).toBeVisible();
  expect(screen.getAllByText("Dach West")).toHaveLength(1);
  expect(screen.getByText("ohne Rolle")).toBeVisible();
  expect(screen.getByText(/Stand 16.09., 10:15 Uhr/)).toHaveTextContent(
    "14,4 kW",
  );
  expect(get).toHaveBeenCalledWith("s1", "e2");
});
it("fehlende Werte werden keine Null und fehlgeschlagenes Laden kein Leerzustand", async () => {
  vi.spyOn(api, "geraetSummenwerte").mockRejectedValue(new Error("offline"));
  render(
    <GeraetSummenwerte
              geraetId="inverter"
      siteId="s1"
      deviceId="d1"
      entityId="e1"
      geraetName="Wechselrichter"
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "konnten nicht geladen werden",
  );
  expect(screen.queryByText(/Aus den Registern/)).toBeNull();
});
it("Umbenennen erhält Kennzeichen, Notiz", async () => {
  vi.spyOn(api, "geraetSummenwerte").mockResolvedValue([
    { ...z, messstelle: { ...z.messstelle } },
  ]);
  const put = vi
    .spyOn(api, "messstelleBearbeiten")
    .mockResolvedValue(z.messstelle);
  render(
    <GeraetSummenwerte
              geraetId="inverter"
      siteId="s1"
      deviceId="d1"
      entityId="e1"
      geraetName="Wechselrichter"
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Aktionen für Dach West" }),
  );
  fireEvent.click(screen.getByText("Umbenennen"));
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Dach Ost" },
  });
  fireEvent.click(screen.getByText("Speichern"));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith("m1", {
      kennzeichen: "MS-0042",
      name: "Dach Ost",
      notiz: "bleibt",

    }),
  );
});
