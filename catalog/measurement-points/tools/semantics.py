"""Größe (`quantity`) und Richtung (`direction`) je Messpunkt — deterministisch und belegt.

`quantity` sagt, WAS für eine Größe der Wert ist; `direction`, in welche Richtung die Energie
fließt. Beides kommt nur aus einem Beleg, nie aus einer Vermutung:

1. eine REGEL unten, die einen genormten Namen (OCPP-Measurand, SunSpec-Punktname), ein
   wörtliches Herstellerlabel (Deye/ha-solarman, KACO, Kostal, Fronius) oder das Shelly-Feld
   samt Rohbeleg nennt — die erste passende Regel gewinnt, jede Regel nennt ihren Beleg;
2. sonst die belegte EINHEIT des Punkts (`UNIT_QUANTITY`): ein Wert in V ist eine Spannung.
   Prozent ist bewusst KEINE Größe — ein Ladestand steht nur über eine Regel im Katalog.

Was keine Größe hat, hat auch keine Richtung (`null`/`null`). Eine Größe ohne Flussrichtung
(Spannung, Frequenz, Ladestand …) trägt `none` („richtungslos“). Jede Energie-Größe (`*energy*`)
trägt eine Richtung — außer den ausdrücklich benannten Punkten in
`ENERGY_WITHOUT_DIRECTION`, deren Quelle die Richtung nicht nennt. Ein Vorzeichen-Wert, dessen
Quelle nur „Leistung am Netzpunkt“ oder „Speicherleistung“ sagt, trägt die zusammengefasste
Richtung (`import_export` bzw. `charge_discharge`), nie eine geratene Einzelrichtung.
"""

from __future__ import annotations

import re
from typing import Any

QUANTITIES = (
    "active_energy", "active_power", "apparent_energy", "apparent_power", "current",
    "energy_capacity", "frequency", "power_factor", "reactive_energy", "reactive_power",
    "soc", "temperature", "voltage",
)
DIRECTIONS = (
    "charge", "charge_discharge", "discharge", "export", "generation", "import",
    "import_export", "none",
)
ENERGY_QUANTITIES = frozenset(q for q in QUANTITIES if "energy" in q)
# Größen ohne Flussrichtung: sie tragen immer `none`.
DIRECTIONLESS = frozenset({
    "apparent_power", "energy_capacity", "frequency", "power_factor", "soc", "temperature",
    "voltage",
})
# Einheiten einer Energiemenge. Ein Punkt mit einer davon MUSS eine Energie-Größe tragen,
# sonst entkäme er der Richtungspflicht.
ENERGY_UNITS = frozenset({"MWh", "VAh", "Wh", "Wmin", "kWh", "mWh", "varh"})

# Belegte Einheit → Größe (Dimension). Nur eindeutige Einheiten; „Pct“ und „%“ fehlen bewusst.
# Eine Einheit mit eingebackenem Faktor („0,1 kWh“, „cHz“) gibt es nicht mehr: `unit` ist die Einheit
# des DEKODIERTEN Werts, der Faktor steht an `scale` (`validate.py` lehnt eine Zahl vorn ab).
UNIT_QUANTITY = {
    "W": "active_power", "kW": "active_power",
    "Wh": "active_energy", "kWh": "active_energy", "MWh": "active_energy",
    "mWh": "active_energy", "Wmin": "active_energy",
    "var": "reactive_power", "varh": "reactive_energy",
    "VA": "apparent_power", "VAh": "apparent_energy",
    "V": "voltage",
    "A": "current",
    "Hz": "frequency",
    "°C": "temperature", "°F": "temperature", "C": "temperature",
    "PF": "power_factor", "cos()": "power_factor",
}
# ⚠ „K“ fehlt bewusst: der einzige Punkt in Kelvin (Shelly lights[].temp) ist eine
# FARBtemperatur, keine gemessene Temperatur.

# Die Quelle nennt eine Energiemenge, aber keine Richtung. Jeder Eintrag ist ein einzelner,
# ausdrücklich benannter Punkt mit Grund — nie ein Muster; der Katalog-Test zählt sie.
ENERGY_WITHOUT_DIRECTION = {
    "deye.hybrid_1p.meter.today-energy":
        "ha-solarman nennt nur „Today Energy“/„Daily Energy“ (0x003C) — ohne Richtung",
    "deye.hybrid_1p.meter.total-energy":
        "ha-solarman nennt nur „Total Energy“ (0x003F/0x0040) — ohne Richtung",
    "sunspec.model_122.actvarhq1":
        "SunSpec 122 nennt nur „Quadrant 1“ ohne Bezugsrichtung (Erzeuger- oder Verbraucher-Zählpfeil)",
    "sunspec.model_122.actvarhq2":
        "SunSpec 122 nennt nur „Quadrant 2“ ohne Bezugsrichtung (Erzeuger- oder Verbraucher-Zählpfeil)",
    "sunspec.model_122.actvarhq3":
        "SunSpec 122 nennt nur „Quadrant 3“ ohne Bezugsrichtung (Erzeuger- oder Verbraucher-Zählpfeil)",
    "sunspec.model_122.actvarhq4":
        "SunSpec 122 nennt nur „Quadrant 4“ ohne Bezugsrichtung (Erzeuger- oder Verbraucher-Zählpfeil)",
    # go-e nennt für seine Zähler nur „in Wh“ (generate.GOE_EINHEIT_IM_TEXT), nie eine Richtung.
    **{
        f"goe.api_v2.{key}": f"go-e API v2 `{key}`: „{text}“ — ohne Richtung"
        for key, text in (
            ("eto", "energy_total, measured in Wh"),
            ("eto_mid", "MID energy_total, measured in Wh"),
            ("wh", "energy in Wh since car connected"),
            ("wh_mid", "MID energy in Wh since car connected"),
            ("whb", "energy BATTERY in Wh since car connected"),
            ("whg", "energy GRID in Wh since car connected"),
            ("who", "energy OTHER in Wh since car connected"),
            ("whs", "energy SOLAR in Wh since car connected"),
        )
    },
}

# Zähler (`aggregation_kind: counter`), deren Einheit KEINE Anzeige-Einheit des Vertrags
# `docs/contracts/v2/ergebnis-zustand-vectors.json` (`rundung.anzeige_einheiten`) ist. Die Cloud nennt
# für sie keine Zahl in einem Mengen-Satz („Zuwachs gemessen …“ ohne Zahl) — darum steht jeder
# einzeln hier, mit der ART, warum, und nie geraten. Ein Nachtrag an `unit` hebt den Laufzeitstand
# (`unit` ist ein Box-Feld, `cataloglib.EDGE_FIELDS`) und gehört damit zu einem Edge-Release.
ZAEHLER_OHNE_ANZEIGE_EINHEIT_ARTEN = {
    "keine_energie": "zählt Zyklen, Ereignisse oder Revisionen — es gibt keine Einheit nachzutragen",
    "einheit_im_schluessel": "die Station nennt die Einheit je Wert; sie steht im konkreten Schlüssel "
                             "der Reihe (`MeasurementCatalog.einheit`), nie im Katalog",
    "faktor_zu_erheben": "der Faktor dieser Karte ist nicht belegt und wird am Gerät erhoben (UEMS AP-05 "
                         "Befund 4) — ohne Faktor hat der dekodierte Wert keine Einheit",
}
ZAEHLER_OHNE_ANZEIGE_EINHEIT: dict[str, tuple[str, str]] = {
    **{
        f"deye.hybrid_3p.battery-{n}.battery-{n}-cycles":
            ("keine_energie", f"ha-solarman „Battery {n} Cycles“ zählt Ladezyklen")
        for n in range(1, 21)
    },
    "deye.hybrid_3p.meter.today-battery-life-cycles":
        ("keine_energie", "ha-solarman „Today Battery Life Cycles“ zählt Ladezyklen"),
    "deye.hybrid_3p.meter.total-battery-life-cycles":
        ("keine_energie", "ha-solarman „Total Battery Life Cycles“ zählt Ladezyklen"),
    "shelly.gen1.input[*].inputs[*].event_cnt": ("keine_energie", "Shelly `event_cnt` zählt Eingangs-Ereignisse"),
    "shelly.gen1.system.cfg_changed_cnt": ("keine_energie", "Shelly `cfg_changed_cnt` zählt Konfigurationsänderungen"),
    "shelly.gen1.system.serial": ("keine_energie", "Shelly `serial` zählt Neustarts"),
    "shelly.gen2plus.sys.cfg_rev": ("keine_energie", "Shelly `cfg_rev` ist eine Konfigurationsrevision"),
    "shelly.gen2plus.sys.kvs_rev": ("keine_energie", "Shelly `kvs_rev` ist eine KVS-Revision"),
    "shelly.gen2plus.sys.schedule_rev": ("keine_energie", "Shelly `schedule_rev` ist eine Zeitplanrevision"),
    "shelly.gen2plus.sys.webhook_rev": ("keine_energie", "Shelly `webhook_rev` ist eine Webhook-Revision"),
    **{
        f"ocpp.1_6.metervalues.energy.{art}.{richtung}.register.context[*].format[*].phase[*].location[*].unit[*]":
            ("einheit_im_schluessel",
             f"OCPP-1.6-SampledValue `unit` je Wert → `…unit[wh]`; `unit[none]` bleibt unbekannt, der "
             f"OCPP-Vorgabewert wird nicht geraten ({art} {richtung})")
        for art in ("active", "reactive") for richtung in ("export", "import")
    },
    **{
        f"wago.pm494.karte[*].{key}": ("faktor_zu_erheben",
                                       f"WAGO 750-494 `{key}`: die Messwert-Tabelle ist nur für die 750-495 "
                                       f"belegt — Datentyp und Energie-Faktor erhebt Pilotschritt 1/2")
        for key in ("energy_export_total", "energy_import_total")
    },
}

SUNSPEC_METER = r"sunspec\.model_2(0[1-4]|1[1-4])"
SUNSPEC_INVERTER = r"sunspec\.model_1(0[1-3]|1[1-3])"
DEYE = r"(hybrid_1p|hybrid_3p|micro|string)"
SHELLY_ENERGY = r"shelly\.gen2plus\.(cover|light_rgb_rgbw|pm1|switch)\[\*\]"
WAGO = r"wago\.pm49[45]"

# (Familie, Punktschlüssel, Größe oder None = aus der Einheit, Richtung, Beleg).
# Beide Muster sind reguläre Ausdrücke über den GANZEN Wert; die erste passende Regel gewinnt.
RULES: tuple[tuple[str, str, str | None, str | None, str], ...] = (
    # --- OCPP 1.6 MeterValues: der Measurand IST die Größe samt Richtung (genormte Namen).
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.energy\.active\.import\..*", "active_energy", "import",
     "OCPP-1.6-Measurand Energy.Active.Import.*"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.energy\.active\.export\..*", "active_energy", "export",
     "OCPP-1.6-Measurand Energy.Active.Export.*"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.energy\.reactive\.import\..*", "reactive_energy", "import",
     "OCPP-1.6-Measurand Energy.Reactive.Import.*"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.energy\.reactive\.export\..*", "reactive_energy", "export",
     "OCPP-1.6-Measurand Energy.Reactive.Export.*"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.power\.active\.import\..*", "active_power", "import",
     "OCPP-1.6-Measurand Power.Active.Import"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.power\.active\.export\..*", "active_power", "export",
     "OCPP-1.6-Measurand Power.Active.Export"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.power\.reactive\.import\..*", "reactive_power", "import",
     "OCPP-1.6-Measurand Power.Reactive.Import"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.power\.reactive\.export\..*", "reactive_power", "export",
     "OCPP-1.6-Measurand Power.Reactive.Export"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.power\.offered\..*", "active_power", None,
     "OCPP-1.6-Measurand Power.Offered ist eine Grenze, kein Fluss"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.power\.factor\..*", "power_factor", "none",
     "OCPP-1.6-Measurand Power.Factor"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.current\.import\..*", "current", "import",
     "OCPP-1.6-Measurand Current.Import"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.current\.export\..*", "current", "export",
     "OCPP-1.6-Measurand Current.Export"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.current\.offered\..*", "current", None,
     "OCPP-1.6-Measurand Current.Offered ist eine Grenze, kein Fluss"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.voltage\..*", "voltage", "none",
     "OCPP-1.6-Measurand Voltage"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.frequency\..*", "frequency", "none",
     "OCPP-1.6-Measurand Frequency"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.temperature\..*", "temperature", "none",
     "OCPP-1.6-Measurand Temperature"),
    ("ocpp\\.1_6", r"ocpp\.1_6\.metervalues\.soc\..*", "soc", "none",
     "OCPP-1.6-Measurand SoC"),

    # --- SunSpec-Zählermodelle 201–204/211–214: die Punktnamen tragen Imp/Exp.
    (SUNSPEC_METER, SUNSPEC_METER + r"\.totwhimp(ph[abc])?", "active_energy", "import",
     "SunSpec TotWhImp* „Total Real Energy Imported“"),
    (SUNSPEC_METER, SUNSPEC_METER + r"\.totwhexp(ph[abc])?", "active_energy", "export",
     "SunSpec TotWhExp* „Total Real Energy Exported“"),
    (SUNSPEC_METER, SUNSPEC_METER + r"\.totvahimp(ph[abc])?", "apparent_energy", "import",
     "SunSpec TotVAhImp* „Total VA-hours Imported“"),
    (SUNSPEC_METER, SUNSPEC_METER + r"\.totvahexp(ph[abc])?", "apparent_energy", "export",
     "SunSpec TotVAhExp* „Total VA-hours Exported“"),
    (SUNSPEC_METER, SUNSPEC_METER + r"\.totvarhimpq[12](ph[abc])?", "reactive_energy", "import",
     "SunSpec TotVArhImpQ1/Q2* „VAr-hours Imported“"),
    (SUNSPEC_METER, SUNSPEC_METER + r"\.totvarhexpq[34](ph[abc])?", "reactive_energy", "export",
     "SunSpec TotVArhExpQ3/Q4* „VAr-hours Exported“"),
    # Der Zähler misst beide Richtungen (TotWhImp UND TotWhExp): seine Wirkleistung ist der
    # Vorzeichen-Wert am Zählpunkt.
    (SUNSPEC_METER, SUNSPEC_METER + r"\.w(ph[abc])?", "active_power", "import_export",
     "SunSpec-Zähler W* „Total Real Power“, vorzeichenbehaftet; derselbe Zähler zählt Imp und Exp"),
    ("sunspec\\.model_[0-9]+", r"sunspec\.model_[0-9]+\.pf(ph[abc])?", "power_factor", "none",
     "SunSpec PF* „Power Factor“"),

    # --- SunSpec-Wechselrichter: die AC-Energie ist die Erzeugung (Modell 122: „output“).
    (SUNSPEC_INVERTER, SUNSPEC_INVERTER + r"\.wh", "active_energy", "generation",
     "SunSpec-Wechselrichter WH „AC Energy“ (lebenslang, nur steigend)"),
    ("sunspec\\.model_122", r"sunspec\.model_122\.actwh", "active_energy", "generation",
     "SunSpec 122 ActWh „AC lifetime active (real) energy output“"),
    ("sunspec\\.model_122", r"sunspec\.model_122\.actvah", "apparent_energy", "generation",
     "SunSpec 122 ActVAh „AC lifetime apparent energy output“"),
    ("sunspec\\.model_160", r"sunspec\.model_160\.module\[\*\]\.dcwh", "active_energy", "generation",
     "SunSpec 160 DCWH „Lifetime Energy“ je MPPT-Modul"),
    ("sunspec\\.model_160", r"sunspec\.model_160\.module\[\*\]\.dcw", "active_power", "generation",
     "SunSpec 160 DCW „DC Power“ je MPPT-Modul"),
    ("sunspec\\.model_120", r"sunspec\.model_120\.whrtg", "energy_capacity", "none",
     "SunSpec 120 WHRtg „Nominal energy rating of storage device“"),
    ("sunspec\\.model_124", r"sunspec\.model_124\.chastate", "soc", "none",
     "SunSpec 124 ChaState „Currently available energy as a percent of the capacity rating“"),

    # --- Deye (ha-solarman): das wörtliche Herstellerlabel nennt die Richtung.
    (DEYE, r"deye\.[a-z0-9_]+\.meter\.(today|total)-energy-import", "active_energy", "import",
     "ha-solarman „Today/Total Energy Import“"),
    (DEYE, r"deye\.[a-z0-9_]+\.meter\.(today|total)-energy-export", "active_energy", "export",
     "ha-solarman „Today/Total Energy Export“"),
    (DEYE, r"deye\.[a-z0-9_]+\.meter\.(today|total)-battery-charge", "active_energy", "charge",
     "ha-solarman „Today/Total Battery Charge“"),
    (DEYE, r"deye\.[a-z0-9_]+\.meter\.(today|total)-battery-discharge", "active_energy", "discharge",
     "ha-solarman „Today/Total Battery Discharge“"),
    (DEYE, r"deye\.[a-z0-9_]+\.(meter|pv)\.(today|total)-production(-[1-4])?", "active_energy", "generation",
     "ha-solarman „Today/Total Production“"),
    (DEYE, r"deye\.[a-z0-9_]+\.meter\.generator-energy(-today)?", "active_energy", "generation",
     "ha-solarman „Generator Energy“"),
    (DEYE, r"deye\.[a-z0-9_]+\.meter\.(today|total)-load-consumption", "active_energy", "import",
     "ha-solarman „Today/Total Load Consumption“ — Verbrauch des Lastzweigs ist dessen Bezug"),
    (DEYE, r"deye\.[a-z0-9_]+\.meter\.(today|total)-losses", "active_energy", "none",
     "ha-solarman „Today/Total Losses“ — Verlust ist kein Fluss über einen Messort"),
    (DEYE, r"deye\.[a-z0-9_]+\.battery\.battery-capacity", "energy_capacity", "none",
     "ha-solarman „Battery Capacity“"),
    (DEYE, r"deye\.[a-z0-9_]+\.battery(-[0-9]+)?\.battery(-[0-9]+)?", "soc", "none",
     "ha-solarman „Battery“/„Battery N“ mit Geräteklasse battery (Ladestand)"),
    (DEYE, r"deye\.[a-z0-9_]+\.bms\.battery-bms-soc", "soc", "none",
     "ha-solarman „Battery BMS SOC“"),
    (DEYE, r"deye\.[a-z0-9_]+\.battery\.battery-power", "active_power", "charge_discharge",
     "ha-solarman „Battery Power“ — Speicherleistung, vorzeichenbehaftet"),
    (DEYE, r"deye\.[a-z0-9_]+\.pv\.pv[1-4]?-power", "active_power", "generation",
     "ha-solarman „PV Power“/„PVn Power“"),
    (DEYE, r"deye\.[a-z0-9_]+\.load\.load(-l[1-3])?-power", "active_power", "import",
     "ha-solarman „Load Power“/„Load Ln Power“ — Verbrauch des Lastzweigs"),
    (DEYE, r"deye\.[a-z0-9_]+\.grid\.(grid(-l[1-3])?|external(-ct[1-3])?)-power", "active_power",
     "import_export", "ha-solarman „Grid Power“/„External Power“ — Leistung am Netzpunkt, vorzeichenbehaftet"),

    # --- Wechselrichter per HTTP/Modbus aus dem eigenen Laufzeitbestand (sources/builtin).
    ("kaco_http|kaco_http_hybrid", r"kaco_http(_hybrid)?\.energy-(today|total)", "active_energy", "generation",
     "KACO eto/etd „Gesamterzeugung“/„Erzeugung heute“"),
    ("kaco_http|kaco_http_hybrid", r"kaco_http(_hybrid)?\.grid-power", "active_power", "import_export",
     "KACO meter.pac „Netzleistung“ am Zähler"),
    ("kaco_http_hybrid", r"kaco_http_hybrid\.battery-power", "active_power", "charge_discharge",
     "KACO pb „Batterieleistung (Originalvorzeichen)“"),
    ("kaco_http_hybrid", r"kaco_http_hybrid\.battery-soc", "soc", "none", "KACO soc „Batterieladestand“"),
    ("fronius_solar_api", r"fronius_solar_api\.grid-power", "active_power", "import_export",
     "Fronius P_Grid „Netzleistung“"),
    ("fronius_solar_api", r"fronius_solar_api\.pv-power", "active_power", "generation",
     "Fronius P_PV „PV-Leistung“"),
    ("fronius_solar_api", r"fronius_solar_api\.battery-power-crosscheck", "active_power", "charge_discharge",
     "Fronius P_Akku „Batterieleistung“"),
    ("fronius_solar_api", r"fronius_solar_api\.battery-soc", "soc", "none",
     "Fronius Inverters[1].SOC „Batterieladestand“"),
    ("kostal_plenticore", r"kostal_plenticore\.grid-power", "active_power", "import_export",
     "Kostal „Total active power (powermeter)“"),
    ("kostal_plenticore", r"kostal_plenticore\.battery-power", "active_power", "charge_discharge",
     "Kostal „Actual battery charge/discharge power“"),
    ("kostal_plenticore", r"kostal_plenticore\.battery-soc", "soc", "none", "Kostal „Battery actual SOC“"),
    ("kostal_plenticore", r"kostal_plenticore\.battery-work-capacity", "energy_capacity", "none",
     "Kostal „Battery work capacity“"),

    # --- Shelly: aenergy = bezogen, ret_aenergy = rückgespeist (Feldname und Rohbeleg).
    ("shelly\\.gen2plus", SHELLY_ENERGY + r"\.aenergy\.(total|by_minute\[\*\])", "active_energy", "import",
     "Shelly aenergy „Bezogene Wirkenergie“"),
    ("shelly\\.gen2plus", SHELLY_ENERGY + r"\.ret_aenergy\.(total|by_minute\[\*\])", "active_energy", "export",
     "Shelly ret_aenergy „Rückgespeiste Wirkenergie“"),
    ("shelly\\.gen2plus", r"shelly\.gen2plus\.em1data\[\*\]\.total_act_energy", "active_energy", "import",
     "Shelly EM1Data total_act_energy"),
    ("shelly\\.gen2plus", r"shelly\.gen2plus\.em1data\[\*\]\.total_act_ret_energy", "active_energy", "export",
     "Shelly EM1Data total_act_ret_energy"),
    ("shelly\\.gen2plus", r"shelly\.gen2plus\.emdata\[\*\]\.([abc]_total_act_energy|total_act)", "active_energy",
     "import", "Shelly EMData *_total_act_energy/total_act"),
    ("shelly\\.gen2plus", r"shelly\.gen2plus\.emdata\[\*\]\.([abc]_total_act_ret_energy|total_act_ret)",
     "active_energy", "export", "Shelly EMData *_total_act_ret_energy/total_act_ret"),
    ("shelly\\.gen2plus", r"shelly\.gen2plus\.em\[\*\]\.([abc]_act_power|total_act_power)", "active_power",
     "import_export", "Shelly EM act_power — Zweirichtungszähler (EMData zählt bezogen und rückgespeist)"),
    ("shelly\\.gen2plus", r"shelly\.gen2plus\.em1\[\*\]\.act_power", "active_power", "import_export",
     "Shelly EM1 act_power — Zweirichtungszähler (EM1Data zählt bezogen und rückgespeist)"),
    ("shelly\\.gen1", r"shelly\.gen1\.emeter\[\*\]\.emeters\[\*\]\.total", "active_energy", "import",
     "Shelly Gen1 emeters[].total „Bezogene Wirkenergie“"),
    ("shelly\\.gen1", r"shelly\.gen1\.emeter\[\*\]\.emeters\[\*\]\.total_returned", "active_energy", "export",
     "Shelly Gen1 emeters[].total_returned „Rückgespeiste Wirkenergie“"),
    ("shelly\\.gen1", r"shelly\.gen1\.emeter\[\*\]\.emeters\[\*\]\.power", "active_power", "import_export",
     "Shelly Gen1 emeters[].power — Zweirichtungszähler (total und total_returned)"),
    ("shelly\\.gen1", r"shelly\.gen1\.meter\[\*\]\.meters\[\*\]\.(total|counters\[\*\])", "active_energy",
     "import", "Shelly Gen1 meters[] „energy consumed by the attached electrical appliance“"),

    # --- WAGO 750-494/495 am Registerbild v1: WAS ein Messwert-Feld ist, legt der Vertrag fest (§4.3) und
    # gilt für beide Karten; OB und WIE eine Karte es liefert, steht je Zahl in `angaben`.
    (WAGO, WAGO + r"\.karte\[\*\]\.energy_import_total", "active_energy", "import",
     "Registerbild WAGO v1 §4.3 Nr. 1 „Wirkenergie Bezug gesamt (Zählerstand)“"),
    (WAGO, WAGO + r"\.karte\[\*\]\.energy_export_total", "active_energy", "export",
     "Registerbild WAGO v1 §4.3 Nr. 2 „Wirkenergie Lieferung gesamt (Zählerstand)“"),
    (WAGO, WAGO + r"\.karte\[\*\]\.power_l[123]", "active_power", None,
     "Registerbild WAGO v1 §4.3 Nr. 3–5 „Wirkleistung L1–L3“ — das Vorzeichen ist zu erheben, keine Richtung"),
    (WAGO, WAGO + r"\.karte\[\*\]\.voltage_l[123]", "voltage", "none",
     "Registerbild WAGO v1 §4.3 Nr. 6–8 „Spannung L1–L3“"),
    (WAGO, WAGO + r"\.karte\[\*\]\.current_l[123]", "current", None,
     "Registerbild WAGO v1 §4.3 Nr. 9–11 „Strom L1–L3“"),
    (WAGO, WAGO + r"\.karte\[\*\]\.frequency", "frequency", "none",
     "Registerbild WAGO v1 §4.3 Nr. 12 „Netzfrequenz“"),
)

_COMPILED = tuple(
    (re.compile(family), re.compile(key), quantity, direction, beleg)
    for family, key, quantity, direction, beleg in RULES
)


def rule_for(point: dict[str, Any]) -> int | None:
    """Index der ersten passenden Regel oder None."""
    for index, (family, key, _, _, _) in enumerate(_COMPILED):
        if family.fullmatch(point["family"]) and key.fullmatch(point["point_key"]):
            return index
    return None


def classify(point: dict[str, Any]) -> tuple[str | None, str | None]:
    """(`quantity`, `direction`) eines Punkts — die Regel, sonst die Einheit, sonst beides null."""
    index = rule_for(point)
    if index is not None:
        _, _, quantity, direction, _ = _COMPILED[index]
        quantity = quantity or UNIT_QUANTITY.get(point.get("unit"))
    else:
        quantity = UNIT_QUANTITY.get(point.get("unit"))
        direction = None
    if quantity is None:
        return None, None
    if quantity in DIRECTIONLESS:
        direction = "none"
    return quantity, direction
