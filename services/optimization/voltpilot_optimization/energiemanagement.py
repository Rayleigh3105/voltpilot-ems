"""AP-19 NW-1: Energiemanagement — reine Regeln, ohne Uhr, Datenbank oder Schreibweg.

Aus k_faelle.py (AP-19, 24.09.2026): ``ueberpruefung`` (DK5), der nächste Termin von internem Audit (IA4) und
Managementbewertung (MG7), die Frist der Feststellung (FS1), die Zusammenführung der Wiedervorlage (``zeile``, WV3),
``vergleich_anwendungsbereich`` (DK7), die Verzeichnis-Zeile ``vz`` (G1, VZ2) und die kanonische Form der Kopien
(``pz`` — aber in der Zahlform der Zwillinge, bericht.md A1: ``-5`` statt ``-5.0``). Der Tag des Abrufs kommt immer
von außen. Alle drei Zwillinge fahren docs/contracts/v2/energiemanagement-vectors.json.
"""
import calendar
import hashlib
import json
import re
from datetime import date, timedelta
from decimal import Decimal

STARTWERTE = dict(ueberpruefung_monate=12, ueberpruefung_monate_mindestens=1, ueberpruefung_monate_hoechstens=60,
                  audit_rhythmus_monate=12, managementbewertung_rhythmus_monate=12, feststellung_frist_tage=90,
                  vorschau_tage=30, wortlaut_zeichen_hoechstens=20000, begruendung_zeichen_mindestens=10,
                  begruendung_zeichen_hoechstens=500, eintrag_zeichen_hoechstens=2000)
VOKABULARE = dict(
    dokument_art=["energiepolitik", "anwendungsbereich", "kontext", "rechtliche_anforderungen", "risiken_chancen",
                  "bestellung", "verfahren", "betrieb", "beschaffung", "kommunikation", "auslegung", "kompetenz"],
    dokument_klasse=["vorgabe", "nachweis"],
    dokument_zustand=["entwurf", "gueltig", "aufgehoben"],
    dokument_bezug=["unternehmen", "standort", "energieeinsatz", "person", "aufgabe"],
    fassung_form=["wortlaut", "verweis"],
    fassung_status=["entwurf", "beantragt", "freigegeben", "abgelehnt", "abgeloest"],
    dokument_eintrag=["bekannt_gemacht", "geprueft_bleibt", "aufgehoben", "kommentar"],
    bekanntmachung_weg=["aushang", "intranet", "unterweisung", "besprechung", "e_mail", "weiterer"],
    aufgabe=["unternehmensleitung", "energiemanagement_leiten", "energieteam", "bezugsbasen", "energieziele_massnahmen",
             "bewertung_messplanung", "interne_audits", "managementbewertung", "dokumente", "weitere"],
    person_zustand=["aktiv", "beendet"],
    aufgabe_zustand=["laufend", "beendet"],
    audit_zustand=["geplant", "durchgefuehrt", "abgeschlossen", "abgesagt"],
    audit_eintrag=["hinweis", "kommentar"],
    feststellung_quelle=["internes_audit", "eigene", "extern", "managementbewertung"],
    feststellung_zustand=["offen", "abgeschlossen"],
    feststellung_eintrag=["kommentar", "behebung", "ursache_aussage", "aehnliche_faelle"],
    wirksamkeit_ergebnis=["wirksam", "nicht_wirksam", "ohne_massnahme", "zurueckgenommen"],
    managementbewertung_zustand=["entwurf", "freigegeben"],
    beschluss_art=["energieziel", "massnahme", "dokument", "aufgabe", "ressourcen", "audit", "keine_aenderung", "weitere"],
    folge_art=["energieziel", "massnahme", "dokument", "aufgabe", "audit"],
    wiedervorlage_art=["dokument_ueberpruefung", "internes_audit", "managementbewertung", "feststellung",
                       "bewertung_ueberpruefung", "bezugsbasis_ueberpruefung", "energieziel_bewertung", "massnahme_termin",
                       "abweichung_frist", "messbedarf_frist", "bericht_anstoss"],
    verzeichnis_ort=["in_voltpilot", "wortlaut_original_beim_kunden", "verweis"],
    verzeichnis_gruppe=["grundlagen", "verantwortung", "risiken_chancen", "kompetenz_kommunikation",
                        "betrieb_auslegung_beschaffung", "bewertung_messplanung", "kennzahlen_bezugsbasen",
                        "ziele_massnahmen_abweichungen", "audits_feststellungen", "managementbewertung", "berichte"],
    ueberpruefung_art=["dokument", "internes_audit", "managementbewertung", "feststellung"],
    ueberpruefung_grund=["nachweis", "keine_fassung", "kein_audit", "keine_managementbewertung", "abgeschlossen"],
)
DOKUMENT_ART_KLASSE = dict(energiepolitik="vorgabe", anwendungsbereich="vorgabe", kontext="vorgabe",
                           rechtliche_anforderungen="vorgabe", risiken_chancen="vorgabe", bestellung="vorgabe",
                           verfahren="vorgabe", betrieb="vorgabe", beschaffung="vorgabe", kommunikation="vorgabe",
                           auslegung="nachweis", kompetenz="nachweis")
LEITUNGS_PFLICHT = ["energiepolitik", "anwendungsbereich", "bestellung"]
WOERTER = dict(
    dokument_art=dict(energiepolitik="Energiepolitik", anwendungsbereich="Anwendungsbereich",
                      kontext="Kontext und interessierte Parteien", rechtliche_anforderungen="Rechtliche Anforderungen",
                      risiken_chancen="Risiken und Chancen", bestellung="Bestellung und Aufgaben (Beleg)",
                      verfahren="Vorgehen", betrieb="Betrieb und Instandhaltung", beschaffung="Beschaffung",
                      kommunikation="Kommunikation", auslegung="Auslegung (Nachweis)", kompetenz="Kompetenz (Nachweis)"),
    aufgabe=dict(unternehmensleitung="Leitung des Unternehmens",
                 energiemanagement_leiten="Energiemanagement leiten und an die Leitung berichten",
                 energieteam="Mitglied im Energieteam", bezugsbasen="Bezugsbasen pflegen und freigeben",
                 energieziele_massnahmen="Energieziele und Maßnahmen führen",
                 bewertung_messplanung="Energetische Bewertung und Messplanung",
                 interne_audits="Interne Audits planen und durchführen",
                 managementbewertung="Managementbewertung vorbereiten", dokumente="Dokumente des Energiemanagements pflegen",
                 weitere="weitere Aufgabe (mit Wortlaut)"),
    verzeichnis_gruppe=dict(grundlagen="Anwendungsbereich, Kontext und Energiepolitik",
                            verantwortung="Aufgaben und Verantwortliche", risiken_chancen="Risiken und Chancen",
                            kompetenz_kommunikation="Kompetenz und Kommunikation",
                            betrieb_auslegung_beschaffung="Betrieb, Auslegung und Beschaffung",
                            bewertung_messplanung="Energetische Bewertung und Messplanung",
                            kennzahlen_bezugsbasen="Kennzahlen, Bezugsbasen und Leistungsvergleiche",
                            ziele_massnahmen_abweichungen="Energieziele, Maßnahmen und Abweichungen",
                            audits_feststellungen="Interne Audits und Feststellungen",
                            managementbewertung="Managementbewertung", berichte="Berichte"),
    verzeichnis_ort=dict(in_voltpilot="in VoltPilot", wortlaut_original_beim_kunden="Wortlaut in VoltPilot, Original bei Ihnen",
                         verweis="Geführt in Ihrem System"),
)
VERANTWORTUNG = ("Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr Unternehmen. VoltPilot hält fest, "
                 "wer was wann entschieden hat, und beurteilt nicht, ob Ihr Energiemanagement genügt.")
GRENZ_SATZ = ("VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur "
              "Konformität mit einer Norm ist damit nicht verbunden.")
SAETZE = dict(
    verantwortung=VERANTWORTUNG,
    grenz_satz=GRENZ_SATZ,
    dokument_kopf="{art} {kennzeichen} · Fassung {fassung} · freigegeben am {am} · entschieden von {entschieden_von} · eingetragen von {eingetragen_von}.",
    ort_wortlaut="Wortlaut in VoltPilot, Original bei Ihnen: {ablage}.",
    ort_verweis="Geführt in Ihrem System: {ablage} ({angaben}).",
    verweis_pruefsumme="Die Prüfsumme wird in Ihrem Browser gebildet; die Datei verlässt Ihren Rechner nicht.",
    verweis_keine_datei="VoltPilot speichert keine Dateien. Halten Sie fest, wo das Original liegt; die Prüfsumme zeigt später, ob es noch dasselbe ist.",
    ueberpruefung="Überprüfung fällig seit {tage} Tagen.",
    geprueft_bleibt="Geprüft, bleibt — entschieden von {person} am {am}: ‚{begruendung}‘",
    bekanntmachung="Bekannt gemacht am {am} an {kreis} über {weg} — eingetragen von {person}.",
    anwendungsbereich_deckungsgleich="Der Betrachtungsumfang der energetischen Bewertung (Fassung {fassung}, ab {ab}) umfasst dieselben Standorte und Energieträger.",
    anwendungsbereich_unterschied="{was} gehört zum Anwendungsbereich, aber nicht zum Betrachtungsumfang der energetischen Bewertung (Fassung {fassung}).",
    freigabe_ohne_leitung="Diese Fassung braucht eine Entscheidung der Leitung. Für die Aufgabe ‚Leitung des Unternehmens‘ ist keine Person festgelegt.",
    aufgabe_ohne_person="{aufgabe} — keine Person festgelegt.",
    person_ohne_konto="{name} · {funktion} · ohne Konto — erscheint als ‚entschieden von‘.",
    einsicht_rolle="Einsicht — Sie sehen das Energiemanagement des ganzen Unternehmens und können nichts ändern.",
    einsicht_schreibversuch="Mit ‚Einsicht‘ können Sie hier nichts ändern. Festhalten kann, wer das Energiemanagement bearbeitet.",
    audit_kopf="Internes Audit {kennzeichen} · durchgeführt am {am} von {auditor} ({unabhaengigkeit}).",
    hinweis="Hinweis — festgestellt von {festgestellt_von}, eingetragen von {eingetragen_von} am {am}.",
    feststellung_kopf="Feststellung {kennzeichen} · {quelle} · festgestellt von {person} am {am} · Verantwortlich {verantwortlich} · Frist {frist} · {zustand}.",
    behebung="Sofortige Behebung — {person}, {am}: {wortlaut}",
    ursache_aussage="Ursache — Aussage von {person}, {am}: {wortlaut}",
    herkunft_feststellung="Herkunft: Feststellung {kennung}.",
    herkunft_audit="Herkunft: internes Audit {kennung}.",
    herkunft_managementbewertung="Herkunft: Managementbewertung {kennung} (Beschluss {beschluss}).",
    wirksamkeit="Wirksamkeit geprüft am {am} von {person}: {ergebnis} — Stand Nr. {nr} mit Prüfsumme.",
    wirksamkeit_noch_nicht="Die Wirksamkeit lässt sich prüfen, sobald jede Maßnahme umgesetzt, bewertet oder verworfen ist.",
    vieraugen_nicht_erfuellbar="Vier-Augen nicht erfüllbar: außer {personen} darf niemand freigeben, und {beteiligt} sind hier beteiligt.",
    managementbewertung_kopf="Managementbewertung {jahr} · Sitzung am {sitzung} · Leitung {leitung} · Stand Nr. {nr} vom {stand_vom}, mit Prüfsumme.",
    managementbewertung_erste="Keine frühere Managementbewertung festgehalten.",
    beschluss="Beschluss {nr} — entschieden von {entschieden_von}, eingetragen von {eingetragen_von}: {wortlaut}",
    beschluss_ohne_folge="Keine Folge in VoltPilot — der Beschluss steht im Stand vom {am}.",
    stand_seines_tages="Dieser Stand zeigt die Eingaben vom {datenstand}. Was sich danach geändert hat, zeigt die nächste Managementbewertung.",
    wiedervorlage_zeile="{gegenstand}: {was} seit {tage} Tagen fällig.",
    wiedervorlage_leer="Zurzeit ist nichts fällig.",
    kalender_abzug="Stand vom {am} aus VoltPilot; maßgeblich ist die Wiedervorlage im Portal.",
    baustein="Energiemanagement — {faellig} fällig · {vorschau} in den nächsten {tage} Tagen.",
    verzeichnis_leer="Hier ist noch nichts festgehalten.",
    verzeichnis_filter="In meinem Namen festgehalten: {anzahl} Einträge.",
    zuschnitt_titel="Was VoltPilot führt — was bei Ihnen liegt.",
)
PLATZ = re.compile(r"\{([a-z_]+)\}")


def _tag(iso):
    return date.fromisoformat(iso[:10])


def plus_monate(tag, n):
    """Tag + n Monate, Monatsende geklemmt (wie LocalDate.plusMonths, AP-16 BewertungFrist, AP-17 F5)."""
    y, m = divmod(tag.month - 1 + n, 12)
    y, m = tag.year + y, m + 1
    return date(y, m, min(tag.day, calendar.monthrange(y, m)[1]))


def lage(tage):
    """Die Lage einer Frist zum Abruf — die Wörter der Wiedervorlage (k_faelle ``zeile``)."""
    if tage > 0:
        return f"seit {tage} Tagen fällig"
    if tage == 0:
        return "heute fällig"
    return f"fällig in {-tage} Tagen"


def _frist(faellig_am, basis, fassung, abruf):
    tage = (_tag(abruf) - faellig_am).days
    return dict(faellig_am=faellig_am.isoformat(), basis=basis.isoformat(), fassung=fassung, tage=tage, satz=lage(tage), grund=None)


def _ohne(grund, basis=None):
    return dict(faellig_am=None, basis=basis, fassung=None, tage=None, satz=None, grund=grund)


def ueberpruefung(e):
    """DK5, IA4, MG7, FS1: wann die Sache wieder vorliegt — beim Abruf, der Tag kommt von außen (``abruf``)."""
    art, abruf = e["art"], _tag(e["abruf"])
    if art == "dokument":
        klasse = DOKUMENT_ART_KLASSE.get(e["dokument_art"])
        if klasse is None:
            return dict(fehler="dokument_art")
        if klasse == "nachweis":
            return _ohne("nachweis")
        monate = e["monate"]
        if monate is None or not STARTWERTE["ueberpruefung_monate_mindestens"] <= monate <= STARTWERTE["ueberpruefung_monate_hoechstens"]:
            return dict(fehler="ueberpruefung_monate")
        frei = [f for f in e["fassungen"] if _tag(f["freigegeben_am"]) <= abruf]
        if not frei:
            return _ohne("keine_fassung")
        gilt = max(frei, key=lambda f: f["nr"])
        bleibt = [_tag(b["am"]) for b in e["geprueft_bleibt"] if b["fassung"] == gilt["nr"] and _tag(b["am"]) <= abruf]
        basis = max([_tag(gilt["freigegeben_am"])] + bleibt)
        return _frist(plus_monate(basis, monate), basis, gilt["nr"], e["abruf"])
    if art in ("internes_audit", "managementbewertung"):
        if e["monate"] < 1:
            return dict(fehler="rhythmus_monate")
        tage = [_tag(t) for t in e["tage"] if _tag(t) <= abruf]
        if not tage:
            return _ohne("kein_audit" if art == "internes_audit" else "keine_managementbewertung")
        basis = max(tage)
        return _frist(plus_monate(basis, e["monate"]), basis, None, e["abruf"])
    if art == "feststellung":
        if e["zustand"] not in VOKABULARE["feststellung_zustand"]:
            return dict(fehler="feststellung_zustand")
        if e["frist_tage"] < 1:
            return dict(fehler="frist_tage")
        if e["zustand"] != "offen":
            return _ohne("abgeschlossen", e["festgestellt_am"])
        basis = _tag(e["festgestellt_am"])
        frist = _tag(e["frist"]) if e["frist"] is not None else basis + timedelta(days=e["frist_tage"])
        return _frist(frist, basis, None, e["abruf"])
    return dict(fehler="ueberpruefung_art")


def wiedervorlage(e):
    """WV1–WV3: jede Frist kommt fertig aus ihrer Regel (WV2) — hier nur Lage, Vorschau-Fenster und Reihenfolge."""
    if e["vorschau_tage"] < 0:
        return dict(fehler="vorschau_tage")
    abruf = _tag(e["abruf"])
    zeilen = []
    for z in e["zeilen"]:
        if z["art"] not in VOKABULARE["wiedervorlage_art"]:
            return dict(fehler="wiedervorlage_art")
        tage = (abruf - _tag(z["faellig_am"])).days
        zeilen.append(dict(art=z["art"], kennzeichen=z["kennzeichen"], titel=z["titel"], faellig_am=z["faellig_am"],
                           tage=tage, satz=lage(tage), verantwortlich=z["verantwortlich"]))
    liste = sorted([z for z in zeilen if z["tage"] >= -e["vorschau_tage"]], key=lambda z: (z["faellig_am"], z["kennzeichen"]))
    faellig = [z for z in liste if z["tage"] >= 0]
    vorschau = [z for z in liste if z["tage"] < 0]
    return dict(faellig=faellig, vorschau=vorschau, anzahl_faellig=len(faellig), anzahl_vorschau=len(vorschau),
                nicht_in_liste=sorted(z["kennzeichen"] for z in zeilen if z["tage"] < -e["vorschau_tage"]))


def anwendungsbereich_vergleich(e):
    """DK7: Unterschiede zwischen Anwendungsbereich und Betrachtungsumfang (AP-16 U1) — Mengen, kein Urteil."""
    ab, um = e["anwendungsbereich"], e["betrachtungsumfang"]
    st_ab = [s for s in ab["standorte"] if s not in um["standorte"]]
    st_um = [s for s in um["standorte"] if s not in ab["standorte"]]
    tr_ab = [t for t in ab["traeger"] if t not in um["traeger"]]
    tr_um = [t for t in um["traeger"] if t not in ab["traeger"]]
    return dict(standorte_nur_im_anwendungsbereich=st_ab, standorte_nur_im_betrachtungsumfang=st_um,
                traeger_nur_im_anwendungsbereich=tr_ab, traeger_nur_im_betrachtungsumfang=tr_um,
                deckungsgleich=not (st_ab or st_um or tr_ab or tr_um))


def verzeichnis_zeile(e):
    """VZ2, G1: die Zeile mit ihrem Gruppen-Wort und dem Ort als Wort; Ablage nur, wo das Original beim Kunden liegt."""
    if e["gruppe"] not in WOERTER["verzeichnis_gruppe"]:
        return dict(fehler="verzeichnis_gruppe")
    if e["ort"] not in WOERTER["verzeichnis_ort"]:
        return dict(fehler="verzeichnis_ort")
    if e["ort"] == "in_voltpilot" and e["ablage"] is not None:
        return dict(fehler="ablage_unerwartet")
    if e["ort"] != "in_voltpilot" and not e["ablage"]:
        return dict(fehler="ablage_fehlt")
    aus = {k: e[k] for k in ("gruppe", "art", "kennzeichen", "titel", "nr", "entschieden_von", "eingetragen_von", "tag", "pruefsumme", "ort")}
    aus["gruppe_wort"] = WOERTER["verzeichnis_gruppe"][e["gruppe"]]
    aus["ort_satz"] = WOERTER["verzeichnis_ort"][e["ort"]] + (f": {e['ablage']}" if e["ablage"] else "")
    return aus


def _zahl(x):
    """bericht.md A1: Dezimalschreibweise ohne Exponent und ohne nachgestellte Nullen — ``-5.0`` wird ``-5``."""
    if isinstance(x, int):
        return str(x)
    d = Decimal(repr(x))
    return "0" if d == 0 else format(d.normalize(), "f")


def kanonisch(x):
    """bericht.md A1 — byte-gleich zu ``BerichtRegeln.kanonisch`` und ``uemsBericht.kanonisch``."""
    if x is None:
        return "null"
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, (int, float)):
        return _zahl(x)
    if isinstance(x, str):
        return json.dumps(x, ensure_ascii=False)
    if isinstance(x, list):
        return "[" + ",".join(kanonisch(v) for v in x) + "]"
    namen = sorted(x, key=lambda k: k.encode("utf-16-be"))
    return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + kanonisch(x[k]) for k in namen) + "}"


def pruefsumme(e):
    """A6 über A1: ``sha256:`` + SHA-256 der UTF-8-Bytes des kanonischen Texts einer Kopie."""
    text = kanonisch(e["kopie"])
    return dict(kanonisch=text, pruefsumme="sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest())


def satz(schluessel, werte):
    """SP4: die Schablone aus §5.8, jeder Platzhalter genau aus ``werte`` — kein Wert fehlt, keiner bleibt übrig."""
    vorlage = SAETZE.get(schluessel)
    if vorlage is None:
        return dict(fehler="satz_unbekannt")
    namen = PLATZ.findall(vorlage)
    for n in namen:
        if n not in werte:
            return dict(fehler=f"wert_fehlt:{n}")
    uebrig = sorted(set(werte) - set(namen))
    if uebrig:
        return dict(fehler=f"wert_uebrig:{uebrig[0]}")
    return dict(satz=PLATZ.sub(lambda t: werte[t.group(1)], vorlage))
