# Typenschild-Varianten (`Model.Aliases` / `modelAliases`) — Bauplan P8

Der Kunde tippt ab, was auf seinem Gerät steht. Deye liefert dieselbe
HV-Hybrid-Reihe unter mehreren Namen aus — im Katalog heißt sie
`SUN-30K-SG01HP3-EU`, auf dem Typenschild steht `SUN-30K-SG01HP3-EU-BM3`
bzw. `-BM4`. Wer die Variante suchte, fand bis hier **nichts** und griff daneben.

## Die Regel: ein Alias ist NUR ein Name

Eine Variante bekommt **keine eigene Kennung, keine eigene Vorlage, kein
Verhalten**. Sie wandert als weiterer Name mit dem Modell mit und wird
mitdurchsucht; gewählt wird immer das Modell selbst.

Warum kein zweiter Katalog-Eintrag:

1. **Die Steuerungs-Freigabe ist auf `brand+model` geschlüsselt**
   (`inverter_control_certification`, `V20260814000000` — „ein Familien-Schlüssel
   würde von einem geprüften Gerät auf ungeprüfte Geschwister schließen").
   Ein Eintrag `…-BM3` wäre ein **unzertifiziertes** Modell: wer sein Typenschild
   wählt, verlöre die Freigabe, die sein Gerät längst hat.
2. **Alias-Kontinuität.** Eine Bestandsanlage hält ihre gespeicherte
   Modell-Kennung. Einen Namen dazuzuschreiben entwertet sie nicht; ein zweiter
   Eintrag daneben lüde dazu ein, sie „richtigzustellen".

Die Registerkarte bleibt unberührt `hybrid_3p` (ha-solarman `deye_p3.yaml` deckt
SG04LP3 LV **und** SG01HP3/SG02HP3 HV; der einzige Modell-Unterschied ist die
MPPT-Zahl, und die summiert der Decoder ohnehin). Reine Kosmetik am Namen —
**kein Decoder-, Familien- oder Anbindungs-Wechsel**.

## Wo es wohnt (der Weg durch alle drei Sprachen)

| Ort | Feld |
|---|---|
| `edge-app/core/internal/inverter/inverter.go` | `Model.Aliases` (Wahrheit; Helfer `mv(...)`) |
| `edge-app/core/internal/inverter/templates.go` | `Template.ModelAliases` → `model_aliases` |
| `services/api/src/main/resources/componenttemplates/builtin.json` | erzeugt, nie von Hand |
| `services/api` | Spalte `component_template.model_aliases` (`V20260911000000`), `ComponentTemplateDto.modelAliases` |
| `frontend/portal/src/komponentenAssistent.ts` | `modellAliase()`, Suche (`heuhaufen`/`rang`), `modellZusatz` |

Nach jedem Katalog-Edit: `(cd edge-app/core && go run ./cmd/vp-template-export)`
— der Byte-Vergleich ist ein `go test ./...`-Wächter.

**Ehrlichkeitsregel:** abwesend/`null` heißt „dieses Modell hat nur seinen einen
Namen", nie „es hat keine Varianten". `[]` wird nie geschrieben (`omitempty`),
und `BuiltinComponentTemplatesTest` prüft genau das.

## Was P8 NICHT getan hat (offene Kunden-Stammdaten)

Zwei Punkte der Diagnose `data/vp-deye-diybms-luecke-l5` sind **Kundendaten** und
werden hier nur festgehalten — keine automatische Änderung:

- **Falsches Modell-Label an einer laufenden Anlage.** Die Komponente steht seit
  dem 21.08.2026 als `SUN-30K-SG02HP3-EU-AM3` im Portal, das Typenschild sagt
  `SUN-30K-SG01HP3-EU-BM3` (Report §2.6: sehr wahrscheinlich ein Eingabe-Irrtum
  beim AM3-Scout). Funktional folgenlos — **gleiche Familie `hybrid_3p`, gleiche
  30 kW, gleicher Leseweg**. Zu korrigieren ist es im Portal durch Umstellen der
  Modell-Wahl auf `sun-30k-sg01hp3` (jetzt auch über „BM3" auffindbar); die
  Anbindung wird dabei NICHT umgeschlüsselt. ⚠ Die Steuerungs-Freigabe hängt an
  `brand+model` — die Korrektur bringt die Anlage auf das Modell, das im
  Register steht (`sun-30k-sg01hp3`), also auf die zertifizierte Seite.
- **Speicher-Asset 80 kWh / 30 kW passt nicht zum Pack.** Der reale Pack sind
  176 Zellen NMC/NCA (Kennlinie 3,26–4,18 V/Zelle, 11 Bänke à 16 Zellen ≈ 622 V;
  der Deye las 650,0 V). Bei 200–234 Ah ergibt das **≈ 130–150 kWh**, nicht 80.
  Auch die Deye-eigenen Kapazitätsangaben widersprechen sich (`0x0066` 234 Ah vs.
  `0x0250` 200 Ah). Die belastbare Zahl kennt nur der Kunde — deshalb bleibt das
  Asset unangetastet und die Diskrepanz nur notiert.
