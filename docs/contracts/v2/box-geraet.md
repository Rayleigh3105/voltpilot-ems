# Vertrag: Gerät der Box im Update-Block (`update.geraet`)

Geräte & Updates G8 (Konzept vom 05.11.2026, Entscheid E4 A). Additiv im Status-Herzschlag beider Linien (Docker-Box `vp-edge-core`, Edge Light `vp-edge-light`); eine ältere Cloud ignoriert das Feld, eine ältere Box sendet es nicht.

## Form

```json
"update": {
  "backend": "light",
  "current": "edge-light-2026.11.4",
  "state": "idle",
  "geraet": { "modell": "GL.iNet GL-MT300N-V2", "arch": "mipsle", "loader": "update", "loader_stand": 1 }
}
```

| Feld | Bedeutung |
|---|---|
| `modell` | Die Angabe des Geräts, nie geraten. Fehlt, wenn keine Quelle lesbar ist oder nur Platzhalter nennt. |
| `arch` | `runtime.GOARCH` des laufenden Programms (`amd64`, `arm64`, `mipsle`, `arm` …). |
| `loader` | Nur Edge Light: `update` – der Loader kennt das Update-Protokoll (er setzt `VP_OTA_RAM_DIR`, Stufe 2); `flash` – er startet immer die Fassung aus dem Flash (Stufe 1). Fehlt bei der Docker-Box. |
| `loader_stand` | Nur Edge Light, additiv seit dem Loader-Selbstupdate: die `LOADER_STAND`-Marke des Loaders im Flash (`edge-app/core/internal/loaderstand`), gelesen vom Programm. Fehlt bei alten Loadern ohne Marke, bei alten Programmen, bei der Docker-Box und auf dem WAGO PFC200 (dort pflegt das Programm keinen Loader, `edge-light/pfc`). Damit ist ohne Wartungstunnel prüfbar, welche Box welchen Loader fährt. |

## Erkennung (Box, `edge-app/core/internal/geraet`)

Einmal beim Start, die erste Quelle mit Inhalt gewinnt:

1. Die Bestellnummer eines WAGO-Controllers, die der Startweg auf dem Gerät erfragt und dem Programm mitgibt (`VP_WAGO_BESTELLNUMMER`, `edge-light/pfc`): `WAGO 750-8212`. Sie gilt nur in der Form zweier Zifferngruppen mit Bindestrich, wahlweise mit Variante (`750-8212/025-000`), und wird nie ergänzt oder umgeschrieben; alles andere ist keine Angabe, dann gilt die nächste Quelle.
2. `/tmp/sysinfo/model` (OpenWrt).
3. `/proc/device-tree/model`, `/sys/firmware/devicetree/base/model` (ARM-Boards; im Docker-Container maskiert).
4. Die Zeile `Model` in `/proc/cpuinfo` (Raspberry-Pi-Kerne, auch im Container lesbar).
5. DMI `sys_vendor` + `product_name` (PC); Platzhalter wie „To Be Filled By O.E.M.“ fallen weg, ein Produkt, das den Hersteller schon nennt, steht allein.

NUL-Bytes und Leerraum werden zusammengefasst, das Modell hart auf 80 Zeichen gekürzt. Auch der Sofort-Bericht beim Anwenden (`PublishUpdateState`) trägt den Block.

## Annahme (Cloud, `ota.BoxGeraet`)

- `modell`: Leerraum zusammengefasst, hart auf 80 Zeichen gekürzt; leer = keine Angabe.
- `arch`: `[a-z0-9_]{1,16}`, sonst verworfen.
- `loader`: nur `update` oder `flash`, jedes andere Wort wird verworfen, nie geraten.
- `loader_stand`: eine ganze Zahl von 1 bis 1000000, alles andere (Wörter, Brüche, 0, negativ, darüber) wird verworfen, nie geraten.
- Gespeichert in `device_update_status` (`geraet_modell`, `geraet_arch`, `loader`, `loader_stand`), nur wenn der Block kommt; fehlt er (ältere Box, älterer Sofort-Bericht), bleibt die zuletzt gemeldete Angabe stehen.

## Folgen

- **Stufe 1** einer Edge-Light-Box heißt jetzt: kein gekreuztes Vertrauen **oder** `loader = flash` (`BoxArt.stufe1`, Portal `stufe1`). Ohne Loader-Angabe entscheidet wie bisher allein das Vertrauen. Ein Edge-Light-Release an eine solche Box ist 409 mit dem Loader-Satz (`BoxArt.GRUND_LIGHT_STUFE_1_LOADER`, Portal-Zwilling wortgleich).
- Die Flotten-Zeile (`/admin/edge-updates`) und das Inventar (`/admin/devices`) tragen `geraetModell`, `geraetArch`, `loader`, `loaderStand`; das Portal zeigt „Modell · Architektur“ oder „Gerät nicht gemeldet“, mit gemeldeter Marke „… · Loader-Stand n“ (`geraetZeile`).

Fälle für beide Seiten: [box-geraet-vectors.json](box-geraet-vectors.json) (`erkennung` prüft die Box, `herzschlag` die Annahme; `wago_bestellnummer` in einem Fall ist die Angabe des Startwegs).
