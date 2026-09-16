import { expect, test, type Page } from "@playwright/test";

const messstelle = {
  id: "gw-1",
  kennzeichen: "MS-0007",
  name: "Dach West",
  art: "berechnet",
  medium: "Strom",
  lebenszyklus: "aktiv",
  fehlt: [],
  notiz: null,
  hauptgroesse: {
    groesse: "Wirkleistung",
    richtung: "Erzeugung",
    wertart: "Momentanwert",
    einheit: "kW",
  },
};
const wert = {
  wert: 14.4,
  einheit: "kW",
  stand: "2026-09-16T08:15:00Z",
  unvollstaendig: false,
  fehlende: [],
};

async function mock(page: Page, leer = false) {
  const state = {
    rolle: "pv" as string | null,
    name: messstelle.name,
    archiv: false,
    aufrufe: [] as string[],
  };
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url()),
      method = route.request().method(),
      path = url.pathname;
    if (method !== "GET") state.aufrufe.push(`${method} ${path}`);
    if (path.endsWith("/summenwerte"))
      return route.fulfill({
        json:
          leer || state.archiv
            ? []
            : [
                {
                  messstelle: { ...messstelle, name: state.name },
                  rolle: state.rolle,
                  wert,
                },
                {
                  messstelle: {
                    ...messstelle,
                    id: "gw-2",
                    kennzeichen: "MS-0008",
                    name: "Zusätzliche Dachfläche",
                  },
                  rolle: null,
                  wert: {
                    ...wert,
                    wert: null,
                    stand: null,
                    unvollstaendig: true,
                  },
                },
              ],
      });
    if (/\/rollen\/pv$/.test(path)) {
      if (method === "DELETE") state.rolle = null;
      if (method === "PUT") state.rolle = "pv";
      return route.fulfill({
        json: { zugeordnet: null, abgeloest: null, geraete: [] },
      });
    }
    if (path.endsWith("/aenderungen"))
      return route.fulfill({
        json: {
          achse: "eintrag",
          von: null,
          bis: null,
          weiter: null,
          eintraege: [
            {
              id: "ort-1",
              quelle: "ort",
              art: state.rolle ? "rolle_gesetzt" : "rolle_entzogen",
              text: state.rolle
                ? "PV-Produktion: „Dach West“ statt „PV-Leistung“"
                : "PV-Produktion entzogen: „Dach West“",
              bezug: {
                art: "anlage",
                id: "site-e2e",
                kennzeichen: null,
                name: "Werk Ahrenberg",
              },
              gilt_ab: "2026-09-16T08:22:00Z",
              gilt_bis: null,
              eingetragen_am: "2026-09-16T08:22:00Z",
              zeitform: "sofort",
              grund: null,
              urheber: {
                name: "Jonas Wendlinger",
                rolle: "kundenadministrator",
                art: "kunde",
              },
              alt: {},
              neu: {},
            },
          ],
        },
      });
    if (path.endsWith("/formel"))
      return route.fulfill({
        json: {
          messstelle_id: "gw-1",
          schema_version: "1.0",
          hauptgroesse: messstelle.hauptgroesse,
          formel_vorhanden: true,
          eingaenge_eingerichtet: true,
          terme: [
            {
              position: 0,
              eingang_art: "messkanal",
              entity_id: "inv",
              point_key: "pv1",
              quell_messstelle_id: null,
              vorzeichen: "+",
              faktor: 1,
              gilt_als_erzeugung: false,
              groesse: messstelle.hauptgroesse,
              eingerichtet: true,
            },
            {
              position: 1,
              eingang_art: "messkanal",
              entity_id: "inv",
              point_key: "pv2",
              quell_messstelle_id: null,
              vorzeichen: "+",
              faktor: 1,
              gilt_als_erzeugung: false,
              groesse: messstelle.hauptgroesse,
              eingerichtet: true,
            },
          ],
        },
      });
    if (path.endsWith("/entities"))
      return route.fulfill({
        json: {
          entities: [
            { id: "inv", label: "Deye SUN-30K", typeLabel: "Wechselrichter" },
          ],
        },
      });
    if (path.endsWith("/messkanaele"))
      return route.fulfill({
        json: {
          messkanaele: ["pv1", "pv2", "pv3"].map((kanal, i) => ({
            kanal,
            anzeigename: `PV ${i + 1}`,
            ...messstelle.hauptgroesse,
            aktiv: true,
          })),
        },
      });
    if (path.endsWith("/archivieren")) {
      state.archiv = true;
      return route.fulfill({ json: messstelle });
    }
    if (path.endsWith("/messstellen/gw-1") && method === "PUT") {
      state.name = route.request().postDataJSON().name;
      return route.fulfill({ json: { ...messstelle, name: state.name } });
    }
    if (path.endsWith("/formel/fassungen")) return route.fulfill({ json: {} });
    return route.fulfill({ json: {} });
  });
  return state;
}
async function menue(page: Page, name = "Dach West") {
  await page.getByRole("button", { name: `Aktionen für ${name}` }).click();
}
async function keinQuerlauf(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator(".vp-modal")
      .evaluateAll((nodes) =>
        nodes.every((n) => n.scrollWidth <= n.clientWidth + 1),
      ),
  ).toBe(true);
}

for (const breite of [375, 1440])
  test(`Karte und alle Dialoge bei ${breite}px · A3 Rolle entziehen und setzen`, async ({
    page,
  }, info) => {
    test.skip(
      info.project.name !== "desktop-chromium",
      "gezielt beide Breiten",
    );
    const state = await mock(page);
    const fehler: string[] = [];
    page.on("pageerror", (e) => fehler.push(e.message));
    await page.setViewportSize({ width: breite, height: 1000 });
    await page.goto("/e2e/summenwert.html");
    await expect(page.getByText("Dach West", { exact: true })).toBeVisible();
    await expect(page.getByText(/14,4\s+kW · Stand/)).toBeVisible();
    await expect(page.getByText("ohne Rolle", { exact: true })).toBeVisible();
    await keinQuerlauf(page);
    await page.screenshot({ animations: "disabled",
      path: `${process.env.SUMMENWERT_BILDER ?? 'e2e/shots'}/summenwert-geraetkarte-${breite}.png`,
      fullPage: true,
    });
    if (breite === 1440)
      await page.screenshot({ animations: "disabled",
        path: `${process.env.SUMMENWERT_BILDER ?? 'e2e/shots'}/summenwert-geraetkarte.png`,
        fullPage: true,
      });
    await menue(page);
    await page
      .getByRole("menuitem", { name: "Rolle ändern", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("radio", { name: /keine Rolle/ }).check();
    await keinQuerlauf(page);
    await page.screenshot({ animations: "disabled",
      path: `${process.env.SUMMENWERT_BILDER ?? 'e2e/shots'}/summenwert-rolle-${breite}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Übernehmen", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => state.rolle).toBe(null);
    await expect(
      page.getByRole("button", { name: "Aktionen für Dach West" }),
    ).toBeFocused();
    await menue(page);
    await page
      .getByRole("menuitem", { name: "Rolle ändern", exact: true })
      .click();
    await page.getByRole("radio", { name: /PV-Produktion/ }).check();
    await page.getByRole("button", { name: "Übernehmen", exact: true }).click();
    await expect.poll(() => state.rolle).toBe("pv");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await menue(page);
    await page
      .getByRole("menuitem", { name: "Umbenennen", exact: true })
      .click();
    await page.getByLabel("Name", { exact: true }).fill("Dachflächen");
    await keinQuerlauf(page);
    await page.screenshot({ animations: "disabled",
      path: `${process.env.SUMMENWERT_BILDER ?? 'e2e/shots'}/summenwert-name-${breite}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await menue(page, "Dachflächen");
    await page
      .getByRole("menuitem", { name: "Archivieren", exact: true })
      .click();
    await keinQuerlauf(page);
    await page.screenshot({ animations: "disabled",
      path: `${process.env.SUMMENWERT_BILDER ?? 'e2e/shots'}/summenwert-archiv-${breite}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Änderungsprotokoll der Anlage" })
      .click();
    await expect(
      page.getByText("Jonas Wendlinger", { exact: false }),
    ).toBeVisible();
    await keinQuerlauf(page);
    await page.screenshot({ animations: "disabled",
      path: `${process.env.SUMMENWERT_BILDER ?? 'e2e/shots'}/summenwert-protokoll-${breite}.png`,
      fullPage: true,
    });
    expect(state.aufrufe).toContain(
      "DELETE /api/v1/sites/site-e2e/komponenten/inv/rollen/pv",
    );
    expect(state.aufrufe).toContain("PUT /api/v1/sites/site-e2e/rollen/pv");
    expect(fehler).toEqual([]);
  });

test("Leerzustand", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium", "einmal");
  await page.setViewportSize({ width: 375, height: 850 });
  await mock(page, true);
  await page.goto("/e2e/summenwert.html");
  await expect(page.getByText(/Aus den Registern dieses Geräts/)).toBeVisible();
  await page.screenshot({ animations: "disabled",
    path: `${process.env.SUMMENWERT_BILDER ?? 'e2e/shots'}/summenwert-leer-375.png`,
    fullPage: true,
  });
});
