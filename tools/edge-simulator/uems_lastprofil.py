#!/usr/bin/env python3
"""AP-14 IP-8: deterministisches Lastprofil fuer 100 Messstellen.

Vier Box-Identitaeten desselben Kundenbereichs liefern je 25 Messstellen mit
13 Kanaelen einmal je Minute.  Das sind exakt 325 Samples/Box/Minute und 1 300
Samples/Minute im Verbund.  Die Nutzlast ist der bestehende MQTT-Vertrag 2.0;
wegen dessen Grenze von 256 Samples wird ein Box-Takt in 256 + 69 geteilt.

Die Generatoren sind absichtlich eine Bibliothek.  Ein Abnahmelauf kann sie
direkt an einen Publisher haengen, waehrend die Tests ohne Broker die
Nachrichtenfolge pruefen.  Keine Rechneruhr fliesst in die Werte ein.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Iterable, Iterator

from uems_szenarien import KATALOGSTAND, Streckenszenarien, Zustellung, _broker_veroeffentlicher, _zustellart, _z

BOXEN = ("E-1", "E-2", "E-2′", "E-3")
MESSSTELLEN_JE_BOX = 25
KANAELE_JE_MESSSTELLE = 13
SAMPLES_JE_BOX_MINUTE = MESSSTELLEN_JE_BOX * KANAELE_JE_MESSSTELLE
SAMPLES_JE_MINUTE = len(BOXEN) * SAMPLES_JE_BOX_MINUTE
STOSS_MINUTEN = 210
STOSS_SAMPLES = STOSS_MINUTEN * SAMPLES_JE_BOX_MINUTE
STOSS_VIERTELSTUNDEN = MESSSTELLEN_JE_BOX * KANAELE_JE_MESSSTELLE * (STOSS_MINUTEN // 15)
MAX_SAMPLES_JE_UMSCHLAG = 256
DEFAULT_START = datetime(2026, 11, 3, 0, 0, tzinfo=timezone.utc)


@dataclass(frozen=True)
class Lastprofil:
    name: str
    minuten: int
    zustellungen: Iterable[Zustellung]


def _samples(seed: int, box_index: int, minute: int, messzeit: datetime) -> list[dict]:
    """325 reproduzierbare Kanaele; der Samen veraendert Werte, nie Identitaeten."""
    result = []
    basis = seed * 10_000_000 + box_index * 1_000_000 + minute * SAMPLES_JE_BOX_MINUTE
    for messstelle in range(1, MESSSTELLEN_JE_BOX + 1):
        for kanal in range(1, KANAELE_JE_MESSSTELLE + 1):
            index = (messstelle - 1) * KANAELE_JE_MESSSTELLE + kanal - 1
            roh = basis + index
            result.append({
                "point_key": f"custom.last.box-{box_index + 1}.ms-{messstelle:02d}.k-{kanal:02d}",
                "raw": roh,
                "decoded": round(roh / 1000.0, 3),
                "quality": "good",
                "observed_at": _z(messzeit),
            })
    return result


def _box_takt(
    strecke: Streckenszenarien,
    box: str,
    box_index: int,
    minute: int,
    messzeit: datetime,
    eingang: datetime,
    seed: int,
    *,
    aus_outbox: bool = False,
) -> Iterator[Zustellung]:
    samples = _samples(seed, box_index, minute, messzeit)
    for teil, von in enumerate(range(0, len(samples), MAX_SAMPLES_JE_UMSCHLAG)):
        chunk = samples[von:von + MAX_SAMPLES_JE_UMSCHLAG]
        sequenz = minute * 2 + teil + 1
        nutzlast = strecke.umschlag(box, sequenz, chunk, messzeit, fassung=None)
        assert nutzlast["schema_version"] == "2.0"
        yield Zustellung(
            topic=strecke.topic(box, "measurement-samples"),
            nutzlast=nutzlast,
            eingangszeit=_z(eingang),
            box=box,
            zustellart=_zustellart(messzeit, eingang),
            aus_outbox=aus_outbox,
            hinweis="Lastprofil: Outbox-Replay FIFO" if aus_outbox else "Lastprofil: direkter Minutentakt",
        )


def dauerlast(
    minuten: int = 24 * 60,
    *,
    seed: int = 14_008,
    start: datetime = DEFAULT_START,
) -> Lastprofil:
    if minuten < 1:
        raise ValueError("Dauerlast braucht mindestens eine Minute")

    def folge() -> Iterator[Zustellung]:
        strecke = Streckenszenarien()
        for minute in range(minuten):
            messzeit = start + timedelta(minutes=minute)
            for box_index, box in enumerate(BOXEN):
                yield from _box_takt(
                    strecke, box, box_index, minute, messzeit,
                    messzeit + timedelta(seconds=2), seed,
                )

    return Lastprofil("dauerlast", minuten, folge())


def nachliefer_stoss(
    *,
    seed: int = 14_008,
    start: datetime = DEFAULT_START,
    getrennte_box: str = "E-3",
) -> Lastprofil:
    """210 Minuten getrennt, danach derselbe Puffer FIFO in 105 Sekunden.

    Wie A3 bekommt jeder der 210 Minutentakte seine Original-Messzeit.  Wegen
    der 2.0-Grenze sind es zwei Umschlaege je Takt; vier Umschlaege werden pro
    Sekunde nachgeliefert.  Die anderen drei Boxen liefern waehrenddessen durch.
    """
    if getrennte_box not in BOXEN:
        raise ValueError(f"unbekannte Box: {getrennte_box}")

    def folge() -> Iterator[Zustellung]:
        strecke = Streckenszenarien()
        getrennt_index = BOXEN.index(getrennte_box)
        for minute in range(STOSS_MINUTEN):
            messzeit = start + timedelta(minutes=minute)
            for box_index, box in enumerate(BOXEN):
                if box == getrennte_box:
                    continue
                yield from _box_takt(
                    strecke, box, box_index, minute, messzeit,
                    messzeit + timedelta(seconds=2), seed,
                )

        rueckkehr = start + timedelta(minutes=STOSS_MINUTEN, seconds=60)
        for minute in range(STOSS_MINUTEN):
            messzeit = start + timedelta(minutes=minute)
            # Zwei Teile desselben Taktes haben denselben Eingang; die Takte
            # bleiben streng FIFO und entsprechen A3 (zwei Takte je Sekunde).
            eingang = rueckkehr + timedelta(milliseconds=500 * minute)
            yield from _box_takt(
                strecke, getrennte_box, getrennt_index, minute, messzeit,
                eingang, seed, aus_outbox=True,
            )

    return Lastprofil("nachliefer-stoss", STOSS_MINUTEN, folge())


def kaltstart(
    minuten: int = 24 * 60,
    *,
    seed: int = 14_008,
    start: datetime = DEFAULT_START,
) -> Lastprofil:
    """Erste Rueckrechnung: historischer Tagespuffer aller vier Boxen FIFO."""
    if minuten < 1:
        raise ValueError("Kaltstart braucht mindestens eine Minute")

    def folge() -> Iterator[Zustellung]:
        strecke = Streckenszenarien()
        rueckrechnung = start + timedelta(minutes=minuten, seconds=60)
        nummer = 0
        for minute in range(minuten):
            messzeit = start + timedelta(minutes=minute)
            for box_index, box in enumerate(BOXEN):
                eingang = rueckrechnung + timedelta(milliseconds=250 * nummer)
                nummer += 1
                yield from _box_takt(
                    strecke, box, box_index, minute, messzeit,
                    eingang, seed, aus_outbox=True,
                )

    return Lastprofil("kaltstart", minuten, folge())


def bytes_der_zustellung(zustellung: Zustellung) -> bytes:
    return json.dumps(
        zustellung.nutzlast, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def spielen(
    profil: Lastprofil,
    veroeffentliche: Callable[[Zustellung], None],
    *,
    time_scale: float = 1.0,
    schlafen: Callable[[float], None] = time.sleep,
) -> dict:
    """Spielt Eingangsabstaende in Echtzeit (1) oder gerafft (>1)."""
    if time_scale <= 0:
        raise ValueError("time_scale muss groesser als 0 sein")
    erster: datetime | None = None
    letzter_soll = 0.0
    beginn = time.monotonic()
    zustellungen = samples = 0
    for zustellung in profil.zustellungen:
        eingang = datetime.strptime(zustellung.eingangszeit, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        erster = erster or eingang
        soll = (eingang - erster).total_seconds() / time_scale
        pause = soll - (time.monotonic() - beginn)
        if pause > 0:
            schlafen(pause)
        veroeffentliche(zustellung)
        letzter_soll = soll
        zustellungen += 1
        samples += len(zustellung.nutzlast["samples"])
    return {"profil": profil.name, "zustellungen": zustellungen, "samples": samples,
            "simulierte_minuten": profil.minuten, "time_scale": time_scale,
            "soll_dauer_s": round(letzter_soll, 3)}


def _profil(args) -> Lastprofil:
    start = datetime.fromisoformat(args.start.replace("Z", "+00:00")).astimezone(timezone.utc)
    if args.profil == "dauerlast":
        return dauerlast(args.minuten, seed=args.seed, start=start)
    if args.profil == "nachliefer-stoss":
        return nachliefer_stoss(seed=args.seed, start=start, getrennte_box=args.getrennte_box)
    return kaltstart(args.minuten, seed=args.seed, start=start)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AP-14 IP-8: UEMS-Lastprofil im Edge-Simulator")
    parser.add_argument("--profil", choices=("dauerlast", "nachliefer-stoss", "kaltstart"),
                        default="dauerlast")
    parser.add_argument("--minuten", type=int, default=24 * 60,
                        help="Dauer fuer Dauerlast/Kaltstart; der Stoß ist fest 210 min")
    parser.add_argument("--seed", type=int, default=14_008)
    parser.add_argument("--start", default="2026-11-03T00:00:00Z")
    parser.add_argument("--getrennte-box", choices=BOXEN, default="E-3")
    parser.add_argument("--time-scale", type=float, default=1.0,
                        help="1 = Echtzeit; 288 = ein Tag in fuenf Minuten")
    parser.add_argument("--zustellungen", action="store_true", help="Nutzlasten als JSONL ausgeben")
    parser.add_argument("--broker", default=os.environ.get("VP_SIM_BROKER"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("VP_SIM_PORT", "1883")))
    parser.add_argument("--tls", action="store_true", default=os.environ.get("VP_SIM_TLS") == "1")
    parser.add_argument("--benutzer", default=os.environ.get("VP_SIM_USER"))
    parser.add_argument("--kennwort", default=os.environ.get("VP_SIM_PASSWORD"))
    args = parser.parse_args(argv)
    profil = _profil(args)

    if args.zustellungen:
        for z in profil.zustellungen:
            print(json.dumps({"topic": z.topic, "eingangszeit": z.eingangszeit,
                              "aus_outbox": z.aus_outbox, "nutzlast": z.nutzlast},
                             ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        return 0

    if not args.broker:
        zaehler = {box: 0 for box in BOXEN}
        outbox = 0
        zustellungen = 0
        for z in profil.zustellungen:
            n = len(z.nutzlast["samples"])
            zaehler[z.box] += n
            outbox += n if z.aus_outbox else 0
            zustellungen += 1
        print(json.dumps({"profil": profil.name, "minuten": profil.minuten,
                          "samples_je_box": zaehler, "samples": sum(zaehler.values()),
                          "outbox_samples": outbox, "zustellungen": zustellungen,
                          "broker": None}, ensure_ascii=False, sort_keys=True))
        return 0

    client, publish = _broker_veroeffentlicher(
        args.broker, args.port, tls=args.tls, benutzer=args.benutzer, kennwort=args.kennwort
    )
    try:
        print(json.dumps(spielen(profil, publish, time_scale=args.time_scale), ensure_ascii=False))
    finally:
        client.loop_stop()
        client.disconnect()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
