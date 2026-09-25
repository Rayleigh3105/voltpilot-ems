"""AP-18 NW-1: Ziele, Maßnahmen, Abweichungen — reine Regeln, ohne Uhr, Datenbank oder Schreibweg.

Aus k_faelle.py (AP-18, 24.09.2026): ``zeitraum`` (Wirkung und Ziel-Stand) und ``ueberfaellig_seit``. Δ, Band und
Urteil je Monat rechnet diese Datei NICHT: sie sind die Operationen ``vergleich`` und ``zeitraum`` der Bezugsbasis
(``bezugsbasis.py``), die hier aufgerufen werden. Hier steht nur, welche Monate zählen (Nachher-Zeitraum,
Umsetzungsmonat, ``basis_nach_umsetzung``, Zielperiode), der Vorschlag am Ziel und die Frist. Summe durch Summe, nie
ein Mittel der Monats-Δ. Alle drei Zwillinge fahren docs/contracts/v2/verbesserung-vectors.json.
"""
import re
from datetime import date, timedelta
from fractions import Fraction

from voltpilot_optimization import bezugsbasis as bb

STARTWERTE = dict(nachher_monate=12, nachher_monate_hoechstens=36, abweichung_frist_tage=30)
VOKABULARE = dict(
    energieziel_zustand=["offen", "bewertet", "beendet"],
    energieziel_ergebnis=["erreicht", "verfehlt", "nicht_bewertbar"],
    zielstand_vorschlag=["erreicht", "nicht_erreicht"],
    massnahme_zustand=["geplant", "umgesetzt", "bewertet", "verworfen"],
    massnahme_herkunft=["abweichung", "energieziel", "einsatz", "von_hand", "nichtkonformitaet", "audit",
                        "managementbewertung"],
    abweichung_zustand=["offen", "abgeschlossen"],
    abweichung_ergebnis=["massnahme", "erklaert", "keine_abweichung", "nicht_bewertbar"],
    abweichung_eintrag_art=["kommentar", "ursache_aussage"],
    auffaelligkeit_zustand=["offen", "beantwortet"],
    auffaelligkeit_antwort=["abweichung", "zur_kenntnis"],
    ursache_beleg=["keine_messung", "mit_beleg"],
    wirkung_ergebnis=["belegt", "nicht_belegt", "nicht_messbar"],
    wirkung_grund=["umsetzungsmonat", "basis_nach_umsetzung", "unvollstaendig", "basis_fehlt", "basis_beendet",
                   "zu_wenig_perioden", "variable_fehlt", "variable_ausserhalb", "periode_nicht_zu_ende", "keine_werte"],
    anstoss_art=["ausgangslage_korrigiert", "bewertung_korrigiert", "messgrundlage_beendet", "messgrundlage_neu_gefasst"],
    anstoss_zustand=["offen", "beantwortet"],
    anstoss_antwort=["bleibt", "neu_kopiert", "neu_bewertet"],
    frist_art=["massnahme", "abweichung", "energieziel"],
    frist_faellig=["ueberfaellig", "bewertung_faellig"],
)
# Die Kundensätze (Report §5.9) als Schablonen; {name} füllt die Operation ``satz``.
SAETZE = {
    "auffaelligkeit": "Auffälligkeit: {monat} — {gemessen} gemessen, {erwartet} erwartet bei {bedingung}: {prozent} als die Bezugsbasis erwarten lässt ({urteil}, Band ± {band} %). Vermerkt am {am}. Abweichung eröffnen oder zur Kenntnis nehmen.",
    "auffaelligkeit_zur_kenntnis": "Auffälligkeit {monat}: {prozent} als die Bezugsbasis erwarten lässt ({urteil}, Band ± {band} %) — zur Kenntnis genommen von {person} am {am}: ‚{begruendung}‘",
    "abweichung_kopf": "Abweichung {kennzeichen} · {kennzahl}, {monate}: {prozent} als die Bezugsbasis erwarten lässt · Verantwortlich {person} · Frist {frist} · {zustand}.",
    "ursache_aussage": "Ursache — Aussage von {person}, {am} (keine Messung): ‚{wortlaut}‘",
    "ursache_aussage_mit_beleg": "Ursache — Aussage von {person}, {am} (mit Beleg: {beleg}): ‚{wortlaut}‘",
    "abschluss_massnahme": "Abgeschlossen am {am} von {person}: Maßnahme {massnahme} — ‚{begruendung}‘",
    "abschluss_erklaert": "Abgeschlossen am {am} von {person}: erklärt — ‚{begruendung}‘",
    "massnahme_kopf": "{kennzeichen} · {titel} · Verantwortlich {person} · Termin {termin} · umgesetzt am {umgesetzt_am}.",
    "messgrundlage": "Messgrundlage: {kennzahl}, Bezugsbasis {bezugsbasis}, Fassung {fassung} — bereinigt um {bereinigt_um} ({methode}). Ausgangslage {ausgangslage_monat}: {ausgangslage_prozent} als erwartet (Version {version}, Kopie vom {kopiert_am}). Erwartete Wirkung: {erwartete_wirkung} — ‚{wortlaut}‘",
    "ohne_messgrundlage": "{kennzeichen} · {titel} · ohne Messgrundlage — Wirkung nicht messbar. Um die Wirkung zu messen, braucht {einsatz} eine Energieleistungskennzahl ({hinweis}).",
    "wirkung_vorlaeufig": "Wirkung von {massnahme}, beobachtet: {prozent} {energie} als die Bezugsbasis erwarten lässt ({zeitraum}, {monate} Monaten; {ausschluesse}) — erwartet waren {erwartete_wirkung}. Ob die Maßnahme das bewirkt hat, sagt eine Person.",
    "wirkung_umsetzungsmonat": "{monat}: Umsetzungsmonat — nicht gezählt.",
    "wirkung_nicht_bewertbar": "{monat}: nicht bewertbar — {grund}.",
    "wirkung_basis_nach_umsetzung": "{monat}: nicht bewertbar — die Bezugsbasis {bezugsbasis}, Fassung {fassung} hat eine Referenzperiode ({referenzperiode}), die nach der Umsetzung endet; sie enthielte die Maßnahme.",
    "bewertung_belegt": "Belegt von {person} am {am}: ‚{begruendung}‘ Beobachtet: {prozent} ({monate} Monaten). Stand Nr. {stand}, Prüfsumme {pruefsumme}",
    "bewertung_offen": "Beobachtet — nicht belegt. Eine Bewertung mit Begründung setzt eine Person.",
    "bewertung_nicht_messbar": "Bewertet am {am} von {person}: nicht messbar — ‚{begruendung}‘",
    "energieziel_stand": "Energieziel {kennzeichen} · {wortlaut} · {zielperiode} · Verantwortlich {person}. Stand nach {monate} Monaten: {prozent} ({ausschluesse}). Bezugsbasis {bezugsbasis}, Fassung {fassung}.",
    "energieziel_ende": "Energieziel {kennzeichen}, Zielperiode {zielperiode}: {prozent} {energie} als die Bezugsbasis erwarten lässt ({monate} Monaten; {ausschluesse}) — Zielwert {zielwert}. Über die ganze Zielperiode nicht bewertbar; die Bewertung trifft eine Person. Bewertet am {am} von {person}: {ergebnis}.",
    "energieziel_vorschlag": "Zielwert {vorschlag}: {prozent} gegenüber {zielwert} ({monate} Monaten) — Vorschlag; bestätigen oder mit Begründung abweichen.",
    "ueberfaellig": "{kennzeichen} · {zustand} · Termin {termin} · überfällig seit {tage} Tagen · {person}.",
    "baustein": "Ziele und Maßnahmen — {ueberfaellig} · {umgesetzt} · {ziele}.",
    "anstoss_ausgangslage_korrigiert": "Ausgangslage korrigiert: {korrektur} ({am}) — die Ausgangslage zitiert {monat} in Version {version_alt} ({prozent_alt} als erwartet), gültig ist Version {version_neu} ({prozent_neu}). Beibehalten mit Begründung oder neu kopieren.",
    "leer": "Noch keine Energieziele, Maßnahmen oder Abweichungen. Sie entstehen aus Ihren Energieleistungskennzahlen: aus einer Auffälligkeit, aus einem Energieziel oder von Hand.",
    "grenz_satz": "VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.",
}
_MONAT = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")
_PERIODE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])/(\d{4})-(0[1-9]|1[0-2])$")
_PLATZ = re.compile(r"\{([a-z_]+)\}")


def _plus(monat, n):
    j, m = divmod(int(monat[:4]) * 12 + int(monat[5:7]) - 1 + n, 12)
    return f"{j:04d}-{m + 1:02d}"


def _abstand(von, bis):
    return (int(bis[:4]) * 12 + int(bis[5:7])) - (int(von[:4]) * 12 + int(von[5:7]))


def _einordnen(m, extra_grund=None):
    """Ein Monat zählt, wenn der Vergleich der Bezugsbasis ein Urteil trägt; sonst ihr Grund (``unvollstaendig`` für ohne_urteil)."""
    if extra_grund:
        return extra_grund
    r = bb.vergleich(m["vergleich"])
    if r["urteil"] == bb.NA:
        return r["grund"]
    return "unvollstaendig" if r["urteil"] == bb.OHNE else None


def _summe(zaehlen, soll):
    """U5 der Bezugsbasis: Operation ``zeitraum`` über die zählenden Monate gegen die Fassung des letzten (P4)."""
    if not zaehlen:
        return dict(urteil=bb.NA, gemessen=None, erwartet=None, delta_prozent=None, band_prozent=None, richtung=None, kennzeichen=[])
    letzter = zaehlen[-1]["vergleich"]
    z = bb.zeitraum({"fassung": letzter["fassung"], "basis_beendet": False, "soll_monate": len(zaehlen),
                     "monate": [{k: m["vergleich"][k] for k in ("abgeschlossen", "gemessen", "variablen")} for m in zaehlen]})
    kennzeichen = list(z["kennzeichen"])
    if len(zaehlen) < soll:
        kennzeichen.append(f"{len(zaehlen)} von {soll} Monaten")
    return dict(urteil=z["urteil"], gemessen=z["gemessen"], erwartet=z["erwartet"], delta_prozent=z["delta_prozent"],
                band_prozent=z["band_prozent"], richtung=z["richtung"], kennzeichen=kennzeichen)


def wirkung(e):
    """WK1–WK4: Nachher-Monate ab dem Monat nach ``umgesetzt_am``; Σ ÷ Σ über die bewertbaren; Ausschlüsse mit Grund."""
    n = e["nachher_monate"]
    if not STARTWERTE["nachher_monate"] <= n <= STARTWERTE["nachher_monate_hoechstens"]:
        return {"fehler": "nachher_monate"}
    umsetzung = e["umgesetzt_am"][:7]
    von, bis = _plus(umsetzung, 1), _plus(umsetzung, n)
    nicht_gezaehlt, zaehlen, endgueltig = [], [], []
    for m in e["monate"]:
        monat = m["monat"]
        if monat == umsetzung:
            nicht_gezaehlt.append({"monat": monat, "grund": "umsetzungsmonat"})
            continue
        if monat < von or monat > bis:
            continue
        endgueltig.append(monat)
        rp = m.get("referenzperiode")
        nach = "basis_nach_umsetzung" if rp and m["vergleich"]["fassung"] is not None and rp[8:] >= umsetzung else None
        grund = _einordnen(m, nach)
        if grund:
            nicht_gezaehlt.append({"monat": monat, "grund": grund})
        else:
            zaehlen.append(m)
    return dict(nachher_von=von, nachher_bis=bis, umsetzungsmonat=umsetzung,
                zeitraum_von=endgueltig[0] if endgueltig else None, zeitraum_bis=endgueltig[-1] if endgueltig else None,
                monate_bewertbar=len(zaehlen), monate_endgueltig=len(endgueltig), monate_soll=n,
                monate=f"{len(zaehlen)} von {n}", vorlaeufig=len(endgueltig) < n, nicht_gezaehlt=nicht_gezaehlt,
                **_summe(zaehlen, n))


def zielstand(e):
    """Z3/Z4: Σ ÷ Σ über die endgültigen Monate der Zielperiode; Vorschlag nur, wenn alle Monate bewertbar sind."""
    p = _PERIODE.match(e["zielperiode"])
    if not p:
        return {"fehler": "zielperiode_format"}
    von, bis = e["zielperiode"][:7], e["zielperiode"][8:]
    if bis < von:
        return {"fehler": "zielperiode_reihenfolge"}
    soll = _abstand(von, bis) + 1
    nicht_gezaehlt, zaehlen, endgueltig = [], [], []
    for m in e["monate"]:
        if m["monat"] < von or m["monat"] > bis:
            continue
        endgueltig.append(m["monat"])
        grund = _einordnen(m)
        if grund:
            nicht_gezaehlt.append({"monat": m["monat"], "grund": grund})
        else:
            zaehlen.append(m)
    summe = _summe(zaehlen, soll)
    vorschlag = None
    if len(zaehlen) == soll:
        g, erw, ziel = Fraction(summe["gemessen"]), Fraction(summe["erwartet"]), Fraction(e["zielwert_prozent"])
        vorschlag = "erreicht" if (g - erw) * 100 <= ziel * erw else "nicht_erreicht"
    return dict(zielperiode=e["zielperiode"], zielwert_prozent=e["zielwert_prozent"], monate_bewertbar=len(zaehlen),
                monate_endgueltig=len(endgueltig), monate_soll=soll, monate=f"{len(zaehlen)} von {soll}",
                vollstaendig=len(zaehlen) == soll, nicht_gezaehlt=nicht_gezaehlt, vorschlag=vorschlag, **summe)


def _letzter_tag(monat):
    return date(int(monat[:4]) + (monat[5:7] == "12"), int(monat[5:7]) % 12 + 1, 1) - timedelta(days=1)


def frist(e):
    """F1: „überfällig seit n Tagen“ / „Bewertung fällig seit n Tagen“ beim Abruf; die Uhr kommt von außen (``abruf``)."""
    art = e["art"]
    offen = {"massnahme": "geplant", "abweichung": "offen", "energieziel": "offen"}[art]
    termin = _letzter_tag(e["zielperiode"][8:]) if art == "energieziel" else date.fromisoformat(e["termin"])
    ohne = dict(termin=termin.isoformat(), faellig=None, seit_tagen=None)
    if e["zustand"] != offen or (art == "energieziel" and not e["letzter_monat_endgueltig"]):
        return ohne
    tage = (date.fromisoformat(e["abruf"]) - termin).days
    if tage < 0:
        return ohne
    return dict(termin=termin.isoformat(), faellig="bewertung_faellig" if art == "energieziel" else "ueberfaellig", seit_tagen=tage)


def satz(schluessel, werte):
    """SP4: die Schablone aus §5.9, jeder Platzhalter genau aus ``werte`` — kein Wert fehlt, keiner bleibt übrig."""
    vorlage = SAETZE.get(schluessel)
    if vorlage is None:
        return {"fehler": "satz_unbekannt"}
    namen = _PLATZ.findall(vorlage)
    fehlt = [n for n in namen if n not in werte]
    if fehlt:
        return {"fehler": f"wert_fehlt:{fehlt[0]}"}
    uebrig = sorted(set(werte) - set(namen))
    if uebrig:
        return {"fehler": f"wert_uebrig:{uebrig[0]}"}
    return {"satz": _PLATZ.sub(lambda t: werte[t.group(1)], vorlage)}
