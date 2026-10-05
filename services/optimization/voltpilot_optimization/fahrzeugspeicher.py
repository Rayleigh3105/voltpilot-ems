"""MiSpeL MP-33: das Fahrzeug am bidirektionalen Ladepunkt als Speicher - reine Rechnung.

Aus dem Datenmodell MP-31 (Vertrag ``docs/contracts/v2/mispel-ladepunkt-bidirektional.md``: Faehigkeit § 2,
Einordnung § 3, Fahrzeugfenster § 5) und der Messung am Stecker wird ein
:class:`~voltpilot_optimization.domain.Fahrzeugspeicher` am Horizont. Ohne Uhr, Datenbank oder Solver; den Lader hat
:func:`voltpilot_optimization.inputs.load_fahrzeugspeicher`, das Modell :func:`voltpilot_optimization.solver._add_fahrzeug`.
Zitierweise „A1 S. 35“ = Anlage 1 der Festlegung (BNetzA, Az. 618-25-02, Beschluss vom 01.10.2026), Seite 35.

Regeln:

- **Einordnung** wie ``LadepunktRegeln.einordnung`` (Zwilling): unidirektional = sonstiger Verbrauch (A1 S. 7, S. 26)
  und nie ein Speicher; bidirektional nur V2H mit unterbundener Rueckspeisung bei Einspeisung = Alternative zur
  Ausschliesslichkeit (A1 S. 26 Fn. 21, S. 27 Fn. 22); sonst Ladepunkt der Festlegung.
- **Zulaessig** (:func:`zulaessig`): im Mischbetrieb nur mit einem Formelsatz mit Ladepunkt hinter Z2 (A2, A3, A4;
  A1 S. 9 Uebersicht 1, S. 29–32), im EEG-Modus (FK3) nur die Alternative zur Ausschliesslichkeit (A1 S. 27 Fn. 22).
  MP-33d: auch A2 „Ladepunkt“ ohne Stromspeicher (A1 S. 29–30) - der Ladepunkt zaehlt wie ein Stromspeicher
  (A1 S. 26–27), das Fahrzeug ist dann der einzige Speicher im Modell (``OptimizationInput.ohne_stromspeicher``).
- **Abfahrtsziel immer erreicht:** an jeder Grenze, an der das Fahrzeug steht, ist der Ladestand mindestens so hoch,
  dass das naechste Ziel mit voller Ladeleistung noch erreichbar ist - auch wenn die Abfahrt hinter dem Horizont liegt.
  An der Abfahrt selbst ist das das Ziel. Nur was physisch nicht erreichbar ist (Ankunft zu leer, Fenster zu kurz),
  wird auf den schnellsten Ladeweg gekappt.
- **Fahrstrom** ist sonstiger Verbrauch (A1 S. 25 Fn. 19): der Plan rechnet ihn nicht; jede Ankunft startet mit der
  Planannahme Mindest-Ladestand (unbekannt ist keine Messung - der naechste Lauf nimmt die gemessene).

MP-33f - die Einstellungen des Fahrers (Vertrag § 5a, Bedienkonzept BK-41 Variante A), alle ein **Wunsch** am Ladepunkt
(A1 S. 27); ``einstellung=None`` heisst „nicht gelesen“ und rechnet wie MP-33:

- **Zurueckspeisen** ``aus`` · ``v2h`` · ``v2g`` begrenzt, was der Plan mit dem Fahrzeug tun darf - nie ueber der
  Faehigkeit des Tages (A1 S. 26 Fn. 21; :func:`rueckspeisen_wirksam`). Ohne Zeile gilt ``aus`` (§ 5a): der Plan laedt
  das Fahrzeug nur. ``v2h`` haelt die Rueckspeisung im Haus (V2H vor V2G, E3 = D; A1 S. 27 Fn. 22).
- **Reserve** ist ``mindest_soc_pct`` des Fahrzeugfensters (§ 5a: kein neues Feld) - unveraendert die Untergrenze.
- **Abfahrten** (``abfahrten[]`` je Wochentag, ``naechste_fahrt`` einmalig) sind harte Abfahrtsziele wie die des
  Fensters (:func:`fahrer_abfahrten`, :func:`mit_fahrer_abfahrten`): eine Anwesenheit endet an der ersten Abfahrt des
  Fahrers in ihr, mit dem hoeheren der beiden Ziele; steht das Fahrzeug gemessen am Stecker ohne Fenster, steht es bis
  zur naechsten Abfahrt des Fahrers. „Nur die naechste Fahrt“ ersetzt den Wochenplan bis zu ihr („danach gilt wieder
  der Wochenplan“, § 5a); eine vergangene zaehlt nicht.
- **Akku schonen** ``vollzyklen_je_tag`` (0,5 · 1 · 2) ersetzt die feste 1; leer = nicht gesagt = die feste 1.

MP-39b - **Aus, Schnell und eine Szene halten das Zurueckspeisen an** (Captain-Entscheid 04.10.2026): der Lademodus
des Ladepunkts „Aus“ (die Wallbox ruht ganz) oder „Schnell“ (nur laden, fuer diese Ladung) - beides der Handeingriff
der Box auf die laufende Sitzung, gemeldet am Stecker (:func:`lademodus_halt`) - und eine aktive Szene, die den
Ladepunkt pausiert hat (``site_scene.paused_entity_ids``, „der sichere Zustand des Geraets gilt“), sind ein
**Halte-Grund** (:func:`halte_grund`). Er wirkt an der einen Stelle :func:`rueckspeisen_wirksam`: der Lauf plant nur
laden, der Block ``fahrzeug`` entfaellt (MP-39: fehlt = nie zurueckspeisen). Endet der Halte-Grund (Schnell endet mit
der Sitzung oder nach hoechstens 4 h, die Szene mit „Beenden“), plant der naechste Lauf wieder mit der Stufe der
Wallbox-Karte (§ 5a). Die Box haelt sofort, nicht erst mit dem Plan (``edge-app/core/internal/entladeschutz``,
``Lage.Halt``). Kein Wort der Festlegung: die Freigabe ist ein Wunsch am Ladepunkt (A1 S. 27), den der Kunde
jederzeit zuruecknimmt.

MP-41c (BK-41c-3 = A, Captain-Entscheid 05.10.2026: „Schnell“ heisst immer: nur laden) - **die dauerhafte Steuerart
„sofort“ haelt ebenso an** (:data:`HALT_LADEMODUS_SOFORT`): die Karte zeigt sie als „Schnell“, also ruht das
Zurueckspeisen wie beim Eingriff. „sofort“ ist, was die Portal-Projektion so nennt (:func:`steuerart_sofort`, Zwilling
von ``SteuerartProjektion.projiziere`` fuer eine OCPP-Saeule, Vektoren ``mispel-steuerart-sofort-vectors.json``) - die
Quellen-Bahn ``schnell`` allein reicht nicht, denn „Guenstige Stunden“ faehrt dieselbe Bahn mit einer Preis-Policy.
Die Box kennt die Policy nicht (sie lebt in Node-RED); sie erfaehrt „sofort“ mit dem Plan (Block fehlt =
``freigabe_aus``, wie bei der Szene), also hoechstens einen Planlauf spaeter (firstmate-Entscheid 05.10.2026 = A).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, tzinfo

from voltpilot_optimization.domain import (
    FAHRZEUG_VERSCHLEISS_CT_JE_KWH,
    FAHRZEUG_VOLLZYKLEN_JE_TAG,
    WIRKUNGSGRAD_LADEPUNKT,
    Fahrzeugspeicher,
)

SONSTIGER_VERBRAUCH = "sonstiger_verbrauch"
LADEPUNKT_DER_FESTLEGUNG = "ladepunkt_der_festlegung"
ALTERNATIVE_ZUR_AUSSCHLIESSLICHKEIT = "alternative_zur_ausschliesslichkeit"

#: Formelsaetze mit einem Ladepunkt hinter Z2 (A1 S. 9, Uebersicht 1): A2 ohne, A3 und A4 mit Stromspeicher.
LADEPUNKT_FORMELSAETZE = frozenset({"A2", "A3", "A4"})
#: Davon die, in denen der Optimierer das Fahrzeug plant - seit MP-33d alle drei: in A2 (ohne Stromspeicher,
#: A1 S. 29–30) ist das Fahrzeug der einzige Speicher; Z2 misst dann nur den Ladepunkt.
FAHRZEUG_FORMELSAETZE = LADEPUNKT_FORMELSAETZE

#: OCPP-1.6-Status mit angestecktem Fahrzeug (ChargePointStatus).
STECKER_BELEGT = frozenset({"Preparing", "Charging", "SuspendedEVSE", "SuspendedEV", "Finishing"})
#: OCPP-1.6-Status ohne Fahrzeug.
STECKER_FREI = frozenset({"Available"})


@dataclass(frozen=True)
class Faehigkeit:
    """Die am Tag wirksame Fassung (Vertrag § 2)."""

    nutzbarkeit: str
    v2h: bool
    v2g: bool
    unterbunden: bool
    rueckspeiseleistung_kw: float | None


@dataclass(frozen=True)
class Anwesenheit:
    """Ein Wochenfenster (Vertrag § 5): ISO-Wochentag der Ankunft, halboffen ``[ankunft, abfahrt)``."""

    wochentag: int
    ankunft: time
    abfahrt: time
    abfahrt_soc_pct: float | None


@dataclass(frozen=True)
class Fenster:
    mindest_soc_pct: float | None
    kapazitaet_kwh: float | None
    anwesenheit: tuple[Anwesenheit, ...]


@dataclass(frozen=True)
class Messung:
    """Die frische Messung am Stecker zum Laufbeginn: ``angesteckt`` ``None`` = Status sagt nichts.

    ``lademodus`` (MP-39b): der Halte-Grund aus dem Lademodus am Stecker (:func:`lademodus_halt`), ``None`` = keiner.
    """

    angesteckt: bool | None
    soc_pct: float | None
    lademodus: str | None = None


#: Die Freigabe des Fahrers (§ 5a) - das Vokabular von ``entities[].fahrzeug.rueckspeisen`` im Fahrplan 2.0 (MP-39).
RUECKSPEISEN_AUS = "aus"
RUECKSPEISEN_V2H = "v2h"
RUECKSPEISEN_V2G = "v2g"


@dataclass(frozen=True)
class Abfahrt:
    """Eine Abfahrt des Wochenplans (§ 5a, ``ladepunkt_abfahrt``): ISO-Wochentag, Uhrzeit in der Ortszeit, Ziel."""

    wochentag: int
    abfahrt: time
    abfahrt_soc_pct: float


@dataclass(frozen=True)
class FahrerEinstellung:
    """Die Einstellungen des Fahrers am Ladepunkt (§ 5a, ``ladepunkt_fahrer_einstellung``).

    ``naechste_fahrt`` = ``(Abfahrt UTC, Ladestand bei Abfahrt)`` oder ``None``; ``vollzyklen_je_tag`` ``None`` = nicht
    gesagt. Die Reserve steht im Fahrzeugfenster (:class:`Fenster`), nicht hier.
    """

    rueckspeisen: str
    vollzyklen_je_tag: float | None = None
    abfahrten: tuple[Abfahrt, ...] = ()
    naechste_fahrt: tuple[datetime, float] | None = None


#: Ohne Zeile gilt „aus“ (§ 5a, ``erfasst: false``) - die Box speist ohne Freigabe nie zurueck (MP-39).
OHNE_EINSTELLUNG = FahrerEinstellung(RUECKSPEISEN_AUS)

#: MP-39b - die Halte-Gruende. Dieselben Woerter wie die Gruende des Entladeschutzes der Box
#: (``entladeschutz.GrundLademodusAus`` / ``GrundLademodusSchnell``), damit Plan und Box denselben Grund nennen.
HALT_LADEMODUS_AUS = "lademodus_aus"
HALT_LADEMODUS_SCHNELL = "lademodus_schnell"
HALT_SZENE = "szene"
#: MP-41c - die dauerhafte Steuerart „sofort“ des Ladepunkts (:func:`steuerart_sofort`). Ein Wort nur des Plans: die
#: Box haelt dafuer nicht selbst an, sie bekommt keinen Block (``entladeschutz.GrundFreigabeAus``).
HALT_LADEMODUS_SOFORT = "lademodus_sofort"

#: Das Maschinenwort des Lastmanagements fuer „Laden pausieren“ (``lastmgmt.ReasonManual``), wie die Box es in
#: ``device_charge_connector.reason`` meldet.
GRUND_HANDEINGRIFF = "handeingriff"


def lademodus_halt(boost: bool | None, reason: str | None) -> str | None:
    """Der Lademodus am Stecker als Halte-Grund (MP-39b), ``None`` = „Smart“ (keiner).

    Zwilling der Ladepunkt-Zweige von ``eingriffVon`` / ``ladeWahl`` im Portal (``frontend/portal/src/steuerung/bild.ts``,
    ``laden.ts``), in derselben Reihenfolge: ``boost`` = „Schnell“ (der Handeingriff „voll“), ``reason = handeingriff``
    = „Aus“ (der Handeingriff „pause“). Beides ist derselbe Eintrag der Box je Stecker, gebunden an die laufende
    Sitzung und hoechstens 4 h lang (``lastmgmt.BoostMaxDuration``). Die dauerhafte Steuerart „sofort“ ist keine
    Ladung - sie haelt seit MP-41c ueber :func:`halte_grund` an (``sofort``), nicht ueber die Messung am Stecker.
    """
    if boost:
        return HALT_LADEMODUS_SCHNELL
    if reason == GRUND_HANDEINGRIFF:
        return HALT_LADEMODUS_AUS
    return None


def halte_grund(messung: Messung | None, szene: bool, sofort: bool = False) -> str | None:
    """Was das Zurueckspeisen jetzt anhaelt (MP-39b): der Lademodus am Stecker vor der Steuerart „sofort“ (MP-41c)
    vor der Szene, ``None`` = nichts.

    ``szene`` = eine aktive Szene hat diesen Ladepunkt pausiert (``site_scene.paused_entity_ids``). Nur eine frische
    Messung traegt einen Lademodus - veraltete Telemetrie ist nicht aktuell. ``sofort`` = die dauerhafte Steuerart
    des Ladepunkts ist „sofort“ (:func:`steuerart_sofort`); sie ist Einstellung, keine Messung, und gilt ohne Stecker.
    """
    if messung is not None and messung.lademodus is not None:
        return messung.lademodus
    if sofort:
        return HALT_LADEMODUS_SOFORT
    return HALT_SZENE if szene else None


# --- MP-41c: die dauerhafte Steuerart „sofort“ (Zwilling von SteuerartProjektion) ----------------------------------

#: Die Woerter der Quellen-Bahn der Box (``lastmgmt/surplus.go``, ``charge_points[].source``/``surplus_policy``).
BAHN_SCHNELL = "schnell"
BAHN_NUR_SONNE = "nur_sonne"
BAHN_SONNE_ZUERST = "sonne_zuerst"

#: Die Quelle, die die Wallbox-Karte als „Schnell“ zeigt (``SteuerartProjektion.QUELLE_SOFORT``).
QUELLE_SOFORT = "sofort"


def bahn(saeule: str | None, anlage: str | None) -> str:
    """Die Quellen-Bahn, die diese Saeule faehrt: ihre eigene Wahl (Allowlist ``source``), sonst die der Anlage
    (``site_charging_config.surplus_policy``). Ein leeres oder unbekanntes Wort ist ``schnell`` - die Vorgabe der Box
    (``lastmgmt.NormalizePolicy``), mit der eine nie gefragte Anlage laedt (``SteuerartProjektion.anlagenStandard``)."""
    wort = (saeule or "").strip() or (anlage or "").strip()
    return wort if wort in (BAHN_NUR_SONNE, BAHN_SONNE_ZUERST) else BAHN_SCHNELL


def steuerart_sofort(dokument: object, saeule: str | None, anlage: str | None) -> bool:
    """Ob die Portal-Projektion die Steuerart dieses OCPP-Ladepunkts „sofort“ nennt (MP-41c, BK-41c-3).

    Zwilling von ``SteuerartProjektion.projiziere(dokument, istOcppLadepunkt=true, saeulenSteuerart(...))`` -
    nur die Frage „Quelle = sofort?“, Regel fuer Regel und ohne Werte; gebunden an die geteilten Vektoren
    ``docs/contracts/v2/mispel-steuerart-sofort-vectors.json`` (Java ``SteuerartSofortVektorenTest``).
    ``dokument`` = das Dokument der aktiven Policy (``consumer_policy.lifecycle = 'active'``) oder ``None``:

    - keine Policy oder keine aktive Anforderung: die Bahn (:func:`bahn`) - ``schnell`` ist „sofort“ (Regel 1);
    - eine Quelle (Regeln 3-6, mit Ziel Regel 8): „sofort“ nur die Form „Fahrzeug verbunden ⇒ ein“ (Regel 3) -
      „Guenstige Stunden“ faehrt dieselbe Bahn ``schnell``, ist aber keine;
    - eine Frist allein: an einer OCPP-Saeule „diese Bahn plus diese Frist“ - die Bahn entscheidet;
    - alles andere ist „Eigene Regel“ (Regel 9), nie „sofort“.
    """
    bahn_sofort = bahn(saeule, anlage) == BAHN_SCHNELL
    if not isinstance(dokument, dict):
        return bahn_sofort
    anforderungen = dokument.get("requirements")
    aktive = [
        r for r in (anforderungen if isinstance(anforderungen, list) else [])
        if not (isinstance(r, dict) and r.get("active") is False)
    ]
    if not aktive:
        return bahn_sofort
    quelle = ziel = None
    for r in aktive:
        q = _als_quelle(r) if isinstance(r, dict) else None
        z = _als_ziel(r) if isinstance(r, dict) else None
        if q is not None and quelle is None:
            quelle = q
        elif z is not None and ziel is None:
            ziel = z
        else:
            return False  # zwei Quellen, zwei Ziele oder eine Form, die die Projektion nicht liest: Eigene Regel
    if quelle is not None:
        return quelle == QUELLE_SOFORT
    return bahn_sofort if ziel is not None else False


def _text(v: object) -> str:
    return v if isinstance(v, str) else ""


def _zahl(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _zielbares_target(t: object) -> bool:
    if not isinstance(t, dict):
        return False
    art = _text(t.get("kind"))
    if art == "on_off":
        return t.get("value") is True
    return art == "kw" and _zahl(t.get("value"))


def _fenster(rec: object) -> bool:
    return isinstance(rec, dict) and all(_text(rec.get(k)) for k in ("days", "from", "to"))


def _fahrzeug_blatt(n: object) -> bool:
    return (isinstance(n, dict) and _text(n.get("signal")) == "consumer.vehicle_connected"
            and _text(n.get("operator")) == "eq" and n.get("value") is True)


def _einzel_blatt(cond: object) -> dict | None:
    """Das eine Blatt einer Quellen-Form; die einzige Verknuepfung ist ``all[Quelle, vehicle_connected]``."""
    if not isinstance(cond, dict):
        return None
    if "signal" in cond:
        return cond
    alle = cond.get("all")
    if not isinstance(alle, list) or len(alle) != 2:
        return None
    a, b = alle
    if _fahrzeug_blatt(a) and not _fahrzeug_blatt(b) and isinstance(b, dict) and "signal" in b:
        return b
    if _fahrzeug_blatt(b) and not _fahrzeug_blatt(a) and isinstance(a, dict) and "signal" in a:
        return a
    return None


def _als_quelle(r: dict) -> str | None:
    if not _zielbares_target(r.get("target")):
        return None
    art = _text(r.get("kind"))
    if art == "fixed_window":
        return "feste_zeiten" if _text(r.get("enforcement")) == "must_run" and _fenster(r.get("recurrence")) else None
    if art != "reactive":
        return None
    blatt = _einzel_blatt(r.get("condition"))
    if blatt is None:
        return None
    signal, op, wert = _text(blatt.get("signal")), _text(blatt.get("operator")), blatt.get("value")
    if signal == "consumer.vehicle_connected":
        return QUELLE_SOFORT if op == "eq" and wert is True else None
    if signal == "site.pv_surplus_kw":
        return "ueberschuss" if op in ("gt", "gte") and _zahl(wert) else None
    if signal in ("market.import_price_ct_kwh", "market.spot_price_ct_kwh"):
        return "guenstig" if op in ("lt", "lte") and _zahl(wert) else None
    return None


def _als_ziel(r: dict) -> str | None:
    if (_text(r.get("kind")) != "flexible_task" or _text(r.get("enforcement")) != "required_by_deadline"
            or not _zielbares_target(r.get("target")) or not _fenster(r.get("recurrence"))):
        return None
    bedarf = r.get("demand") if isinstance(r.get("demand"), dict) else {}
    energie = _zahl(bedarf.get("energy_kwh"))
    laufzeit = bedarf.get("runtime_minutes")
    laufzeit = isinstance(laufzeit, int) and not isinstance(laufzeit, bool) and -2**31 <= laufzeit < 2**31
    if energie == laufzeit:
        return None  # beides oder keines: mehrdeutig
    return "bis_uhrzeit" if energie else "laufzeit_bis"


def rueckspeisen_wirksam(wunsch: str | None, f: Faehigkeit, halt: str | None = None) -> str:
    """Die Stufe, die der Plan fahren darf: der Wunsch des Fahrers, nie ueber der Faehigkeit des Tages (§ 5a,
    A1 S. 26 Fn. 21). Zwilling von ``LadepunktRegeln.rueckspeisenWirksam``: ``v2g`` ohne V2G wird ``v2h``, ohne V2H
    ``aus``; ein unbekanntes Wort ist ``aus``.

    Die EINE Stelle, an der der Plan die Stufe festlegt. MP-39b: ein Halte-Grund (:func:`halte_grund` - Lademodus
    „Aus“ oder „Schnell“, eine Szene) macht sie ``aus`` und wirkt so auf Plan und Block ``fahrzeug`` zugleich; ohne
    ihn gilt wieder die Stufe der Wallbox-Karte. Die Ansicht (``LadepunktRegeln``) kennt keinen Halte-Grund - sie
    zeigt, was der Fahrer eingestellt hat.
    """
    if halt is not None:
        return RUECKSPEISEN_AUS
    if wunsch == RUECKSPEISEN_V2G and f.v2g:
        return RUECKSPEISEN_V2G
    if wunsch in (RUECKSPEISEN_V2G, RUECKSPEISEN_V2H) and f.v2h:
        return RUECKSPEISEN_V2H
    return RUECKSPEISEN_AUS


def fahrer_abfahrten(
    einstellung: FahrerEinstellung, von: datetime, bis: datetime, zone: tzinfo
) -> list[tuple[datetime, float]]:
    """Die Abfahrten des Fahrers nach ``von`` bis acht Tage nach ``bis``: ``(Abfahrt UTC, Ladestand bei Abfahrt)``.

    Der Wochenplan je ISO-Wochentag in der Ortszeit; „nur die naechste Fahrt“ ersetzt ihn bis einschliesslich zu ihr,
    danach gilt er wieder (§ 5a). Eine Abfahrt vor ``von`` (auch eine vergangene naechste Fahrt) zaehlt nicht -
    veraltet ist nicht aktuell.
    """
    out: list[tuple[datetime, float]] = []
    tag = von.astimezone(zone).date() - timedelta(days=1)
    letzter = bis.astimezone(zone).date() + timedelta(days=8)
    while tag <= letzter:
        for a in einstellung.abfahrten:
            if a.wochentag == tag.isoweekday():
                ab = _lokal(tag, a.abfahrt, zone)
                if ab > von:
                    out.append((ab, float(a.abfahrt_soc_pct)))
        tag += timedelta(days=1)
    naechste = einstellung.naechste_fahrt
    if naechste is not None and naechste[0] > von:
        out = [a for a in out if a[0] > naechste[0]] + [(naechste[0], float(naechste[1]))]
    return sorted(out)


def _hoeher(a: float | None, b: float | None) -> float | None:
    gesagt = [x for x in (a, b) if x is not None]
    return max(gesagt) if gesagt else None


def mit_fahrer_abfahrten(
    fenster_: list[tuple[datetime, datetime, float | None]],
    abfahrten: list[tuple[datetime, float]],
    jetzt_angesteckt: bool,
    von: datetime,
) -> list[tuple[datetime, datetime, float | None]]:
    """Die Anwesenheiten ``(ankunft, abfahrt, abfahrt_soc_pct)`` mit den Abfahrten des Fahrers (§ 5a).

    - Eine Anwesenheit endet an der ersten Abfahrt des Fahrers in ihr (``ankunft < t <= abfahrt``) - das Fahrzeug
      kann nicht zweimal abfahren; das Ziel ist das hoehere der beiden (das Abfahrtsziel wird immer erreicht).
    - Steht das Fahrzeug gemessen jetzt am Stecker und deckt kein Fenster ``von``, steht es bis zur naechsten Abfahrt
      des Fahrers; beginnt vorher ein Fenster, geht die Anwesenheit in dieses ueber (ohne neue Ankunftsannahme).
    - Ohne Abfahrten des Fahrers bleibt alles wie in MP-33.
    """
    if not abfahrten:
        return fenster_
    out = []
    for an, ab, ziel in fenster_:
        d = next((a for a in abfahrten if an < a[0] <= ab), None)
        out.append((an, ab, ziel) if d is None else (an, d[0], _hoeher(ziel, d[1])))
    if jetzt_angesteckt and not any(an <= von < ab for an, ab, _ in out):
        d = next((a for a in abfahrten if a[0] > von), None)
        if d is not None:
            folgend = [k for k, (an, _, _) in enumerate(out) if von < an < d[0]]
            if folgend:
                k = folgend[0]
                out[k] = (von, out[k][1], out[k][2])
            else:
                out.append((von, d[0], d[1]))
    return sorted(out)


def einordnung(f: Faehigkeit | None) -> str:
    """Zwilling von ``LadepunktRegeln.einordnung``; ohne Fassung gilt unidirektional (Vertrag § 2, Bestand)."""
    if f is None or f.nutzbarkeit != "bidirektional":
        return SONSTIGER_VERBRAUCH
    if not f.v2g and f.unterbunden:
        return ALTERNATIVE_ZUR_AUSSCHLIESSLICHKEIT
    return LADEPUNKT_DER_FESTLEGUNG


def zulaessig(
    einordnung_: str, foerderweg: str | None, formelsatz: str | None, netzladen_erlaubt: bool
) -> str | None:
    """``None``, wenn das Fahrzeug in diesem Foerderweg als Speicher geplant wird, sonst der Grund."""
    if einordnung_ == SONSTIGER_VERBRAUCH:
        return "unidirektional"
    if foerderweg == "marktpraemie_abgrenzung":
        return None if formelsatz in FAHRZEUG_FORMELSAETZE else "formelsatz_ohne_ladepunkt"
    if not netzladen_erlaubt and einordnung_ != ALTERNATIVE_ZUR_AUSSCHLIESSLICHKEIT:
        # EEG-Modus (FK3): ein Ladepunkt der Festlegung schliesst die Ausschliesslichkeit aus (A1 S. 27 Fn. 22).
        return "ausschliesslichkeit_mit_ladepunkt"
    return None


def intervalle(
    anwesenheit: tuple[Anwesenheit, ...], von: datetime, bis: datetime, zone: tzinfo
) -> list[tuple[datetime, datetime, float | None]]:
    """Die Anwesenheiten ``(ankunft, abfahrt, abfahrt_soc_pct)`` (UTC), die ``[von, bis)`` beruehren, plus die erste
    danach (fuer das Ziel hinter dem Horizont). ``abfahrt`` vor ``ankunft`` = ueber Mitternacht."""
    erster = von.astimezone(zone).date() - timedelta(days=8)
    letzter = bis.astimezone(zone).date() + timedelta(days=8)
    out = []
    tag = erster
    while tag <= letzter:
        for a in anwesenheit:
            if a.wochentag != tag.isoweekday():
                continue
            ab_tag = tag if a.abfahrt > a.ankunft else tag + timedelta(days=1)
            an = _lokal(tag, a.ankunft, zone)
            ab = _lokal(ab_tag, a.abfahrt, zone)
            if ab > von:
                out.append((an, ab, a.abfahrt_soc_pct))
        tag += timedelta(days=1)
    out.sort()
    ergebnis = [i for i in out if i[0] < bis]
    danach = [i for i in out if i[0] >= bis]
    return ergebnis + danach[:1]


def _lokal(tag: date, uhrzeit: time, zone: tzinfo) -> datetime:
    from datetime import timezone

    return datetime.combine(tag, uhrzeit, tzinfo=zone).astimezone(timezone.utc)


def fahrzeugspeicher(
    komponente_id: str,
    faehigkeit: Faehigkeit,
    fenster: Fenster | None,
    messung: Messung | None,
    slot_starts: list[datetime],
    slot_minutes: int,
    zone: tzinfo,
    einstellung: FahrerEinstellung | None = None,
    box_device_id: str | None = None,
    szene: bool = False,
    sofort: bool = False,
) -> tuple[Fahrzeugspeicher | None, str | None]:
    """Der Fahrzeugspeicher am Horizont oder ``(None, grund)``.

    Gruende: ``planungsangaben_fehlen`` (Rueckspeiseleistung, Kapazitaet oder Fenster und Abfahrten des Fahrers leer -
    unbekannt ist keine Null), ``ladestand_unbekannt`` (es steht laut Fenster jetzt da, aber ohne frische Messung des
    Ladestands plant niemand einen Speicher - P7), ``nicht_im_horizont`` (keine Anwesenheit beruehrt den Horizont).
    ``einstellung`` = die Einstellungen des Fahrers (MP-33f; ``None`` = nicht gelesen, rechnet wie MP-33).
    ``szene`` = eine aktive Szene hat diesen Ladepunkt pausiert (MP-39b); mit dem Lademodus der ``messung`` ein
    Halte-Grund (:func:`halte_grund`), der auch ohne gelesene Einstellungen gilt. ``sofort`` = die dauerhafte
    Steuerart des Ladepunkts ist „sofort“ (MP-41c, :func:`steuerart_sofort`), ebenso ein Halte-Grund.
    """
    fahrer_sagt_abfahrt = einstellung is not None and bool(einstellung.abfahrten or einstellung.naechste_fahrt)
    if fenster is None or not (fenster.anwesenheit or fahrer_sagt_abfahrt):
        return None, "planungsangaben_fehlen"
    if faehigkeit.rueckspeiseleistung_kw is None or fenster.kapazitaet_kwh is None:
        return None, "planungsangaben_fehlen"
    n = len(slot_starts)
    dt_h = slot_minutes / 60.0
    slot = timedelta(minutes=slot_minutes)
    cap = float(fenster.kapazitaet_kwh)
    leistung = float(faehigkeit.rueckspeiseleistung_kw)
    einweg = math.sqrt(WIRKUNGSGRAD_LADEPUNKT)
    mindest = (fenster.mindest_soc_pct or 0.0) / 100.0 * cap
    halt = halte_grund(messung, szene, sofort)
    if einstellung is None:
        stufe, v2g, vollzyklen = None, faehigkeit.v2g, FAHRZEUG_VOLLZYKLEN_JE_TAG
        if halt is not None:
            stufe = RUECKSPEISEN_AUS
    else:
        stufe = rueckspeisen_wirksam(einstellung.rueckspeisen, faehigkeit, halt)
        v2g = stufe == RUECKSPEISEN_V2G
        vollzyklen = (
            float(einstellung.vollzyklen_je_tag)
            if einstellung.vollzyklen_je_tag is not None
            else FAHRZEUG_VOLLZYKLEN_JE_TAG
        )
    # Ohne gesagten Mindest-Ladestand wird nie zurueckgespeist (Vertrag § 5: „leer = nicht gesagt“), ohne Freigabe
    # des Fahrers ebenso (§ 5a: ohne Zeile „aus“).
    rueckspeisen_kw = leistung if fenster.mindest_soc_pct is not None and stufe != RUECKSPEISEN_AUS else 0.0
    grenzen = [slot_starts[0] + i * slot for i in range(n + 1)]
    fenster_ = intervalle(fenster.anwesenheit, grenzen[0], grenzen[-1], zone)
    if einstellung is not None:
        fenster_ = mit_fahrer_abfahrten(
            fenster_,
            fahrer_abfahrten(einstellung, grenzen[0], grenzen[-1], zone),
            messung is not None and messung.angesteckt is True,
            grenzen[0],
        )

    def _anwesend(t: int) -> int | None:
        # Ein Slot zaehlt nur, wenn er ganz im Fenster liegt: die Abfahrt ist dann nie spaeter als geplant.
        for i, (an, ab, _) in enumerate(fenster_):
            if an <= grenzen[t] and grenzen[t + 1] <= ab:
                return i
        return None

    im_fenster = [_anwesend(t) for t in range(n)]
    if im_fenster[0] is not None and messung is not None and messung.angesteckt is False:
        # Das Fenster sagt „da“, der Stecker „frei“: das Fahrzeug ist noch nicht gekommen. Diese Anwesenheit
        # plant der Lauf nicht; die naechste beginnt wieder mit der Annahme.
        erstes = im_fenster[0]
        im_fenster = [None if i == erstes else i for i in im_fenster]
    if all(i is None for i in im_fenster):
        return None, "nicht_im_horizont"
    angesteckt = tuple(i is not None for i in im_fenster)
    erstes_da = next(i for i in im_fenster if i is not None)
    stand: list[float | None] = [None] * (n + 1)
    if angesteckt[0]:
        if messung is None or messung.soc_pct is None:
            return None, "ladestand_unbekannt"
        stand[0] = min(max(messung.soc_pct / 100.0 * cap, 0.0), cap)
    for s in range(1, n):
        if angesteckt[s] and not angesteckt[s - 1]:
            stand[s] = min(mindest, cap)  # Ankunft: Planannahme, Fahrstrom unterwegs = sonstiger Verbrauch

    def _ziel(i: int) -> float:
        pct = fenster_[i][2]
        return min(max(pct / 100.0 * cap if pct is not None else mindest, mindest), cap)

    def _ziel_pct(i: int) -> float | None:
        # fuer den Block ``fahrzeug``: das Ziel wie _ziel, aber nur was gesagt ist (unbekannt ist keine Null)
        hoechstes = _hoeher(fenster_[i][2], fenster.mindest_soc_pct)
        return min(hoechstes, 100.0) if hoechstes is not None else None

    def _abfahrt_grenze(i: int) -> datetime:
        # die letzte Slot-Grenze, die nicht nach der Abfahrt liegt (ganze Slots, wie _anwesend)
        ab = fenster_[i][1]
        return grenzen[0] + ((ab - grenzen[0]) // slot) * slot

    unter = [0.0] * (n + 1)
    abfahrten: list[tuple[int, float]] = []
    start_kwh = 0.0
    start_s = 0
    for s in range(n + 1):
        jetzt_da = s < n and angesteckt[s]
        eben_da = s > 0 and angesteckt[s - 1]
        if not (jetzt_da or eben_da):
            continue
        i = im_fenster[s] if jetzt_da else im_fenster[s - 1]
        if stand[s] is not None:
            start_kwh, start_s = stand[s], s
        ziel = _ziel(i)
        stunden = max((_abfahrt_grenze(i) - grenzen[s]).total_seconds() / 3600.0, 0.0)
        noetig = max(mindest, ziel - einweg * leistung * stunden)
        erreichbar = start_kwh + einweg * leistung * (s - start_s) * dt_h
        unter[s] = min(noetig, erreichbar, cap)
        if eben_da and not jetzt_da and stunden == 0.0:  # nicht das Horizontende mitten im Fenster
            abfahrten.append((s, ziel))
    return (
        Fahrzeugspeicher(
            komponente_id=komponente_id,
            kapazitaet_kwh=cap,
            laden_kw=leistung,
            rueckspeisen_kw=rueckspeisen_kw,
            v2g=v2g,
            angesteckt=angesteckt,
            stand_kwh=tuple(stand),
            untergrenze_kwh=tuple(unter),
            abfahrten=tuple(abfahrten),
            tag_je_slot=tuple(t.astimezone(zone).date().isoformat() for t in slot_starts),
            wirkungsgrad=WIRKUNGSGRAD_LADEPUNKT,
            verschleiss_ct_je_kwh=FAHRZEUG_VERSCHLEISS_CT_JE_KWH,
            vollzyklen_je_tag=vollzyklen,
            rueckspeisen=stufe,
            mindest_soc_pct=fenster.mindest_soc_pct,
            naechste_abfahrt=(fenster_[erstes_da][1], _ziel_pct(erstes_da)),
            box_device_id=box_device_id,
            rueckspeisen_halt=halt,
        ),
        None,
    )
