#!/usr/bin/env python3
"""Tor-Pruefer der ersten UEMS-Produktfreigabe (AP-14 IP-21).

Je Tor aus dem Freigabeplan (Konzept "Erste Produktfreigabe" §3.4) sammelt das
Werkzeug die Belege und faellt je Pruefpunkt GENAU EIN Urteil:

  belegt                     - es gibt einen nachpruefbaren Beleg; die Fundstelle steht dabei
  offen: ...                 - was fehlt und wer es liefert (Crew oder Betreiber)
  nicht maschinell pruefbar  - was nur der Betreiber wissen kann; er hat es im Stand-Blatt
                               bestaetigt, das Werkzeug hat es NICHT nachgeprueft

Ehrlichkeit vor Bequemlichkeit: ein Beleg ist nie "die Datei existiert".
Ein Nachweis-Test gilt nur mit einem gruenen Surefire-Bericht DIESES Standes,
das Bestandsblatt nur datiert und juenger als sieben Tage, die Generalprobe nur
mit Zahlen, die erkennbar nicht vom Wegwerf-Bestand stammen. Das Stand-Blatt des
Betreibers kann NIEMALS einen maschinell pruefbaren Punkt gruen machen.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import subprocess
import sys
import xml.etree.ElementTree as ET

BELEGT = 'belegt'
OFFEN = 'offen'
BETREIBER_WORT = 'nicht maschinell pruefbar'

BLATT_TAGE = 7
# Eine Migrationssumme unter einer Sekunde kann nicht von echten Daten stammen.
WEGWERF_SUMME_MS = 1000
PROBE_ERLAUBTE_EXITS = (0, 21, 22)
PROBE_EXIT_TEXT = {
    21: 'Z03 - eingerichtete Anlagen, vom Betreiber gegen den Steuerbestand zu pruefen',
    22: 'Z05 - Kundenbereiche ohne Stichtag, vom Betreiber zu erklaeren',
}

TORE = {
    'G0': 'Zusammenfuehren - uems nach main in einem Stueck',
    'G1': 'Ausrollen - der Rollout-Tag; danach haben alle alles (E1 = B)',
    'GA': 'Edge-Release A - additive Box-Pakete, je Box zugewiesen',
    'GB': 'Edge-Release B - RUNTIME_VERSION, WAGO',
}


# --------------------------------------------------------------------------- #
# Stand-Blatt des Betreibers
# --------------------------------------------------------------------------- #

class StandFehler(Exception):
    """Das Stand-Blatt ist nicht lesbar - lieber abbrechen als raten."""


def lies_stand(pfad: pathlib.Path) -> dict:
    """Winziger, strenger Leser fuer das Stand-Blatt.

    Absichtlich kein YAML-Paket: die Datei hat genau zwei Ebenen, und alles,
    was der Leser nicht versteht, ist ein Fehler statt einer stillen Annahme.
    """
    stand: dict = {}
    block = None
    for nr, roh in enumerate(pfad.read_text(encoding='utf-8').splitlines(), 1):
        # Kommentar ist nur eine Zeile, die mit # beginnt - ein # im Wert bleibt stehen.
        zeile = '' if roh.lstrip().startswith('#') else roh.rstrip()
        if not zeile.strip():
            continue
        if not zeile.startswith(' '):
            if not zeile.endswith(':'):
                raise StandFehler(f'{pfad}:{nr}: erwartet "punkt:" am Zeilenanfang')
            block = zeile[:-1].strip()
            stand[block] = {}
            continue
        if not zeile.startswith('  ') or zeile[2:3] == ' ':
            raise StandFehler(f'{pfad}:{nr}: erwartet genau zwei Leerzeichen Einzug')
        if block is None:
            raise StandFehler(f'{pfad}:{nr}: eingerueckte Zeile ohne Punkt darueber')
        if ':' not in zeile:
            raise StandFehler(f'{pfad}:{nr}: erwartet "feld: wert"')
        feld, wert = zeile.strip().split(':', 1)
        stand[block][feld.strip()] = wert.strip().strip('"').strip("'")
    return stand


# --------------------------------------------------------------------------- #
# Kontext
# --------------------------------------------------------------------------- #

class Kontext:
    def __init__(self, args, wurzel: pathlib.Path):
        self.wurzel = wurzel
        self.jetzt = dt.datetime.now(dt.timezone.utc)
        self.laeufe = pathlib.Path(args.laeufe) if args.laeufe else wurzel / 'services/api/target/surefire-reports'
        self.laeufe_gesetzt = bool(args.laeufe)
        self.blatt = pathlib.Path(args.blatt) if args.blatt else None
        self.generalprobe = pathlib.Path(args.generalprobe) if args.generalprobe else None
        self.stand_pfad = pathlib.Path(args.stand) if args.stand else None
        self.stand = lies_stand(self.stand_pfad) if self.stand_pfad else {}
        self.kopf, self.kopf_zeit = self._kopf()

    def git(self, *argv) -> str:
        return subprocess.run(['git', '-C', str(self.wurzel), *argv],
                              capture_output=True, text=True, check=False).stdout.strip()

    def _kopf(self):
        sha = self.git('rev-parse', 'HEAD')
        roh = self.git('show', '-s', '--format=%cI', 'HEAD')
        try:
            zeit = dt.datetime.fromisoformat(roh)
        except ValueError:
            zeit = None
        return sha, zeit

    def mtime(self, pfad: pathlib.Path) -> dt.datetime:
        return dt.datetime.fromtimestamp(pfad.stat().st_mtime, dt.timezone.utc)


def tag(zeit: dt.datetime) -> str:
    return zeit.astimezone(dt.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')


# --------------------------------------------------------------------------- #
# Pruefer
# --------------------------------------------------------------------------- #

def surefire(klasse: str, landete_mit: str = '', wer: str = 'Crew'):
    """Ein Nachweis-Test gilt nur mit einem gruenen Bericht DIESES Standes.

    Das Werkzeug faehrt die Klasse nicht - es liest den Bericht und sagt, von
    wann er ist. `<laeufe>/stand.txt` darf den Commit des Laufs nennen; ohne die
    Datei traegt der Bericht keinen Commit, dann gilt allein sein Zeitpunkt.
    """
    def pruefe(ctx: Kontext):
        datei = ctx.laeufe / f'TEST-{klasse}.xml'
        kurz = klasse.rsplit('.', 1)[-1]
        if not datei.exists():
            woher = str(ctx.laeufe) if ctx.laeufe_gesetzt else 'services/api/target/surefire-reports'
            herkunft = f' Die Klasse steht im Repo seit {landete_mit}.' if landete_mit else ''
            return OFFEN, (f'kein Surefire-Bericht fuer {kurz} unter {woher}; '
                           f'die Klasse einmal fahren oder --laeufe <verzeichnis> angeben ({wer}).{herkunft}')
        try:
            suite = ET.parse(datei).getroot()
        except ET.ParseError as fehler:
            return OFFEN, f'{datei.name} ist nicht lesbar ({fehler}); Lauf wiederholen ({wer})'
        zahl = lambda name: int(suite.get(name) or 0)  # noqa: E731
        rot = zahl('failures') + zahl('errors')
        if rot:
            return OFFEN, (f'{kurz} ist im Bericht vom {tag(ctx.mtime(datei))} ROT '
                           f'({rot} von {zahl("tests")}); der Befund gehoert behoben ({wer})')
        if zahl('tests') == 0 or zahl('tests') == zahl('skipped'):
            return OFFEN, (f'{kurz} hat im Bericht vom {tag(ctx.mtime(datei))} nichts ausgefuehrt '
                           f'({zahl("skipped")} uebersprungen) - uebersprungen ist nicht gruen ({wer})')

        stand_datei = ctx.laeufe / 'stand.txt'
        if stand_datei.exists():
            worte = stand_datei.read_text(encoding='utf-8').split()
            sha = worte[0] if worte else ''
            if len(sha) < 7 or not (ctx.kopf.startswith(sha) or sha.startswith(ctx.kopf)):
                return OFFEN, (f'{kurz} ist gruen, aber der Bericht stammt laut stand.txt von {sha or "?"}, '
                               f'geprueft wird {ctx.kopf[:8]}; Lauf auf diesem Stand wiederholen ({wer})')
            woher = f'Stand {sha[:8]} laut stand.txt'
        else:
            if ctx.kopf_zeit and ctx.mtime(datei) < ctx.kopf_zeit:
                return OFFEN, (f'{kurz} ist gruen, aber der Bericht vom {tag(ctx.mtime(datei))} ist AELTER '
                               f'als der gepruefte Stand {ctx.kopf[:8]} ({tag(ctx.kopf_zeit)}); '
                               f'Lauf auf diesem Stand wiederholen ({wer})')
            woher = 'kein Commit im Bericht vermerkt, nur der Zeitpunkt'
        # Uebersprungene Faelle werden genannt, nicht verschwiegen.
        sprung = f', {zahl("skipped")} uebersprungen' if zahl('skipped') else ''
        return BELEGT, (f'{datei.name}: {zahl("tests")} Tests, 0 Fehler{sprung}, Bericht vom '
                        f'{tag(ctx.mtime(datei))} ({woher})')
    return pruefe


def gemergt(pr: int, was: str):
    """Ein Paket gilt als gemergt, wenn sein PR-Commit vom geprueften Stand erreichbar ist."""
    def pruefe(ctx: Kontext):
        treffer = ctx.git('log', '--format=%H%x09%cs%x09%s', f'--grep=(#{pr})', '--fixed-strings', 'HEAD')
        for zeile in treffer.splitlines():
            sha, datum, betreff = zeile.split('\t', 2)
            if f'(#{pr})' in betreff:
                return BELEGT, f'{sha[:8]} vom {datum}: {betreff}'
        return OFFEN, f'{was} (PR {pr}) ist von {ctx.kopf[:8]} aus nicht erreichbar; erst mergen (Crew)'
    return pruefe


def m2_probezweig(ctx: Kontext):
    """M-2: die Zusammenfuehrung ist geprobt und `main` steckt im geprueften Stand."""
    haupt = (ctx.git('rev-parse', '--verify', '--quiet', 'origin/main')
             or ctx.git('rev-parse', '--verify', '--quiet', 'main'))
    if not haupt:
        return OFFEN, 'weder origin/main noch main sind hier bekannt; Repo vollstaendig holen (Crew)'
    vorfahre = subprocess.run(['git', '-C', str(ctx.wurzel), 'merge-base', '--is-ancestor', haupt, 'HEAD'],
                              capture_output=True, check=False).returncode == 0
    if not vorfahre:
        return OFFEN, (f'main {haupt[:8]} ist kein Vorfahre von {ctx.kopf[:8]}; die Zusammenfuehrung ist '
                       f'nicht geprobt oder main ist weitergewandert (Crew)')
    urteil, text = gemergt(981, 'die geprobte Zusammenfuehrung')(ctx)
    if urteil != BELEGT:
        return urteil, text
    baum = ctx.git('rev-parse', 'HEAD^{tree}')
    return BELEGT, (f'{text}; main {haupt[:8]} ist Vorfahre von {ctx.kopf[:8]}, Baum {baum[:8]}. '
                    f'Die Datei-fuer-Datei-Tabelle zu PR 904 steht im Text von PR 981, nicht im Repo')


def m1_blatt(ctx: Kontext):
    """M-1: das Bestandsblatt gegen Produktion, datiert und juenger als sieben Tage."""
    if ctx.blatt is None:
        return OFFEN, ('kein --blatt <datei>; der Betreiber faehrt tools/betriebsabfragen/bestand-vor-uems.sql '
                       'gegen Produktion und gibt Teil A-C heraus (Betreiber)')
    if not ctx.blatt.exists():
        return OFFEN, f'{ctx.blatt} gibt es nicht; Ergebnisblatt hinterlegen (Betreiber)'
    if ctx.blatt.stat().st_size == 0:
        return OFFEN, f'{ctx.blatt} ist leer; das ist kein Ergebnis (Betreiber)'
    alter = (ctx.jetzt - ctx.mtime(ctx.blatt)).days
    if alter > BLATT_TAGE:
        return OFFEN, (f'{ctx.blatt.name} ist vom {tag(ctx.mtime(ctx.blatt))} und damit {alter} Tage alt; '
                       f'das Blatt muss juenger als {BLATT_TAGE} Tage sein (Betreiber)')
    return BELEGT, f'{ctx.blatt}, datiert {tag(ctx.mtime(ctx.blatt))}, {alter} Tage alt'


def _probe_datei(ctx: Kontext, name: str):
    if ctx.generalprobe is None:
        return None, ('kein --generalprobe <verzeichnis>; der Betreiber faehrt tools/generalprobe/ gegen eine '
                      'wiederhergestellte Kopie und gibt die Ausgabe heraus (Betreiber)')
    datei = ctx.generalprobe / name
    if not datei.exists():
        return None, f'{datei} fehlt; die Uebung ist nicht gefahren (Betreiber)'
    try:
        return json.loads(datei.read_text(encoding='utf-8')), None
    except (ValueError, OSError) as fehler:
        return None, f'{datei} ist nicht lesbar ({fehler}); Ausgabe erneut herausgeben (Betreiber)'


def nw1_generalprobe(ctx: Kontext):
    bericht, fehlt = _probe_datei(ctx, 'probe.json')
    if bericht is None:
        return OFFEN, fehlt
    code = bericht.get('exit_code')
    if code not in PROBE_ERLAUBTE_EXITS:
        return OFFEN, (f'probe.json endete mit exit_code {code}; nur 0, 21 und 22 sind vorlegbare Laeufe '
                       f'(tools/generalprobe/README.md, benannte Exit-Codes) (Betreiber)')
    for wo, teil in (('C', bericht.get('C', {})), ('W1', bericht.get('W1', {}))):
        z08 = teil.get('Z08')
        if z08 is None:
            if wo == 'W1':
                continue
            return OFFEN, 'probe.json nennt keine Z08-Zaehler; Bericht unvollstaendig (Betreiber)'
        if z08.get('geloescht_markiert') or z08.get('fehlgeschlagen'):
            return OFFEN, (f'{wo}.Z08 ist auffaellig (geloescht_markiert={z08.get("geloescht_markiert")}, '
                           f'fehlgeschlagen={z08.get("fehlgeschlagen")}); erfolgreiche DELETE-Marker sind ein '
                           f'Schaden, kein bestandener Lauf (Betreiber)')
    teil_a = bericht.get('A', {})
    summe = teil_a.get('summe_ms')
    if summe is None:
        return OFFEN, 'probe.json nennt keine Migrationsdauern (Rubrik A); Bericht unvollstaendig (Betreiber)'
    if summe < WEGWERF_SUMME_MS:
        return OFFEN, (f'kein Produktions-Beleg: die {teil_a.get("migrationen")} Migrationen summieren sich auf '
                       f'{summe} ms. Unter einer Sekunde stammen die Zahlen erkennbar vom Wegwerf-Bestand, '
                       f'nicht von einer wiederhergestellten Kopie - damit laesst sich kein Fenster planen '
                       f'(Betreiber)')
    zusatz = PROBE_EXIT_TEXT.get(code)
    nachsatz = f'; Pruefauftrag an den Betreiber offen: {zusatz}' if zusatz else ''
    return BELEGT, (f'probe.json: exit_code {code}, {teil_a.get("migrationen")} Migrationen, Summe {summe} ms, '
                    f'Z08 = 0{nachsatz}')


def nw8_rueckweg(ctx: Kontext):
    bericht, fehlt = _probe_datei(ctx, 'rueckweg.json')
    if bericht is None:
        return OFFEN, fehlt
    if bericht.get('exit_code') != 0:
        return OFFEN, f'rueckweg.json endete mit exit_code {bericht.get("exit_code")}; kein bestandener Rueckweg (Betreiber)'
    if not (bericht.get('flyway_stimmt') and bericht.get('Q01_stimmt')):
        return OFFEN, ('rueckweg.json: Flyway-Stand oder Q01 sind nach der Wiederherstellung nicht bytegleich '
                       '(Betreiber)')
    dauer = bericht.get('wiederherstellung_ms')
    if not dauer:
        return OFFEN, 'rueckweg.json nennt keine wiederherstellung_ms; die Dauer ist der Kern des Nachweises (Betreiber)'
    return BELEGT, f'rueckweg.json: Wiederherstellung {dauer} ms, Flyway-Stand und Q01 bytegleich'


AUSGELIEFERTES_PAAR = 'edge-2026.09.4'


def _nw3_protokolle(ctx: Kontext):
    ordner = ctx.wurzel / 'docs/rollout'
    for datei in sorted(ordner.glob('nw3-protokoll-*.json')):
        try:
            yield datei, json.loads(datei.read_text(encoding='utf-8'))
        except (ValueError, OSError):
            continue


def _nw3_urteil(ctx: Kontext, datei, protokoll):
    schlecht = [p['punkt'] for p in protokoll.get('punkte', []) if p.get('urteil') != 'gruen']
    paar = protokoll.get('paar', {})
    quelle = (f'{datei.relative_to(ctx.wurzel)} vom {protokoll.get("gefahren_am")}, '
              f'Paar {paar.get("name")}')
    if schlecht:
        return OFFEN, (f'{quelle}: {protokoll.get("zusammenfassung")} - offen bzw. mit Befund: '
                       f'{"; ".join(schlecht)} (Crew)')
    warnung = ''
    if 'Tag gebaut' in str(paar.get('herkunft', '')):
        warnung = ('. ACHTUNG: das Paar ist AUS DEM TAG GEBAUT, nicht das Release-Artefakt der '
                   'privaten Registry - der Betreiber muss wissen, was er da vor sich hat')
    return BELEGT, f'{quelle}: {protokoll.get("zusammenfassung")}{warnung}'


def nw3_ausgeliefert(ctx: Kontext):
    """G1: das AUSGELIEFERTE Image gegen die neue Cloud."""
    for datei, protokoll in _nw3_protokolle(ctx):
        if protokoll.get('paar', {}).get('name') == AUSGELIEFERTES_PAAR:
            return _nw3_urteil(ctx, datei, protokoll)
    return OFFEN, (f'kein NW-3-Protokoll fuer das ausgelieferte Paar {AUSGELIEFERTES_PAAR} unter '
                   f'docs/rollout/; tools/nw3-box-image/nw3.sh einmal fahren (Crew)')


def nw3_neues_image(ctx: Kontext):
    """GA: NW-3 gegen das NEUE Image - das ausgelieferte Paar zaehlt hier nicht."""
    kandidaten = [(d, p) for d, p in _nw3_protokolle(ctx)
                  if p.get('paar', {}).get('name') != AUSGELIEFERTES_PAAR]
    if not kandidaten:
        return OFFEN, (f'es gibt kein NW-3-Protokoll fuer ein anderes Paar als das ausgelieferte '
                       f'{AUSGELIEFERTES_PAAR}; Edge-Release A ist nicht gebaut (Crew)')
    urteile = [_nw3_urteil(ctx, d, p) for d, p in kandidaten]
    offene = [t for u, t in urteile if u == OFFEN]
    if offene:
        return OFFEN, ' | '.join(offene)
    return BELEGT, ' | '.join(t for _, t in urteile)


def betreiber(schluessel: str, was: str, wer_liefert: str = 'Betreiber'):
    """Was nur der Betreiber weiss - beantwortet allein sein Stand-Blatt.

    Das Werkzeug fragt nie interaktiv und raet nie. Ein Stand-Blatt-Eintrag
    macht einen Punkt NICHT gruen: er bleibt als Wort des Betreibers gekennzeichnet.
    """
    def pruefe(ctx: Kontext):
        if ctx.stand_pfad is None:
            return OFFEN, f'{was} - kein --stand <datei> angegeben ({wer_liefert})'
        eintrag = ctx.stand.get(schluessel)
        if eintrag is None:
            return OFFEN, (f'{was} - im Stand-Blatt {ctx.stand_pfad.name} fehlt der Punkt "{schluessel}" '
                           f'({wer_liefert})')
        if eintrag.get('bestaetigt', '').lower() not in ('ja', 'yes', 'true'):
            grund = eintrag.get('beleg') or eintrag.get('grund') or 'ohne Begruendung'
            return OFFEN, (f'{was} - "{schluessel}" steht im Stand-Blatt auf '
                           f'bestaetigt: {eintrag.get("bestaetigt", "(leer)")} ({grund}) ({wer_liefert})')
        am = eintrag.get('am')
        if not am:
            return OFFEN, f'{was} - "{schluessel}" ist bestaetigt, nennt aber kein Datum "am:" ({wer_liefert})'
        try:
            dt.date.fromisoformat(am)
        except ValueError:
            return OFFEN, f'{was} - "{schluessel}": "am: {am}" ist kein Datum JJJJ-MM-TT ({wer_liefert})'
        beleg = eintrag.get('beleg', '')
        durch = eintrag.get('durch', 'Betreiber')
        return BETREIBER_WORT, (f'{was} - {durch} bestaetigt am {am}'
                                f'{": " + beleg if beleg else ""}. '
                                f'Quelle: {ctx.stand_pfad.name}; das Werkzeug hat das nicht nachgeprueft')
    return pruefe


# --------------------------------------------------------------------------- #
# Die Pruefpunkte je Tor - die Liste aus §3.4 ist verbindlich
# --------------------------------------------------------------------------- #

def punkte(tor: str):
    if tor == 'G0':
        return [
            ('V0', 'Migrations-Waechter: erst der Satz von main, dann der Rest', '§3.4',
             surefire('com.voltpilot.api.uems.UemsProduktionsreihenfolgeMigrationTest', 'PR 947')),
            ('NW-2', 'Steuerung aus einem Stueck', '§3.4 / §4.13',
             surefire('com.voltpilot.api.uems.UemsBestandSteuerungAusEinemStueckTest', 'PR 969')),
            ('M-2', 'Probe-Zweig gruen, PR-904-Tabelle', '§3.4', m2_probezweig),
            ('IP-3', 'Halb-Zustand geschlossen', '§3.4', gemergt(963, 'IP-3 Halb-Zustand schliessen')),
            ('IP-4', 'Die erste Minute des Messkunden', '§3.4', gemergt(965, 'IP-4 erste Minute des Messkunden')),
            ('IP-14', 'Uebergang mit "Was sich aendert"', '§3.4', gemergt(967, 'IP-14 Portal-Bestandsschutz')),
            ('IP-15', 'Zuordnung korrigieren', '§3.4', gemergt(968, 'IP-15 Zuordnung korrigieren')),
            ('IP-9', 'UEMS-Metriken in der api', '§3.4', gemergt(966, 'IP-9 UEMS-Metriken')),
            ('IP-19', 'Sprach-Waechter und Release-Notiz', '§3.4', gemergt(978, 'IP-19 Sprach-Waechter')),
        ]
    if tor == 'G1':
        return [
            ('M-1a', 'Bestandsblatt gegen Produktion gefahren', '§3.4', m1_blatt),
            ('M-1b', 'Bestandsblatt ausgewertet: Q03 Lage c/f erklaert, Q15 WAL-Archiv laeuft', '§3.4',
             betreiber('m1_ausgewertet', 'Q03 Lage c/f erklaert und Q15 WAL-Archiv laeuft')),
            ('NW-1', 'Generalprobe an einer wiederhergestellten Kopie', '§3.4 / §4.13', nw1_generalprobe),
            ('NW-8', 'Rueckweg geuebt, Dauer bekannt', '§3.4 / §4.13', nw8_rueckweg),
            ('NW-3', 'Das ausgelieferte Box-Image gegen die neue Cloud', '§3.4 / §4.13', nw3_ausgeliefert),
            ('NW-4', 'Durchgehender Messkunden-Lauf', '§3.4 / §4.13',
             surefire('com.voltpilot.api.uems.UemsMesskundenLaufAbnahmeTest', 'PR 973, Kennzahl-Glied PR 975')),
            ('NW-5', 'Last "100 Messstellen" als 24-h-Messung', '§3.4 / §3.3',
             betreiber('nw5_lastmessung',
                       '24-h-Messung nach Profil L1-L4 auf der Probe-Umgebung; tools/lastprofil-messung/ liegt bereit',
                       'Crew faehrt, Betreiber stellt die Probe-Umgebung')),
            ('NW-6', 'Alarm-Uebung: jeder Alarm einmal, jeder Laeufer-Schalter einmal', '§3.4 / §4.13',
             betreiber('nw6_alarmuebung',
                       'jeden Alarm einmal ausgeloest, Zustellung an "betreiber" beobachtet, jeden Laeufer-Schalter umgelegt')),
            ('NW-6k', 'NW-6 im Kleinen: Dauerlaeufer-Einrichtung ueber die Produktwege traegt bis zur Alarm-Kennzahl',
             'Drehbuch §14.2 / §14.6',
             surefire('com.voltpilot.api.metrics.DauerlaeuferGanzerWegDbTest',
                      'PR 999, Einrichtung ueber die Produktwege mit dem IP-18-Folgepaket; die Writer-Haelfte '
                      'DauerlaeuferWriterNahtTest liegt in services/timescale-writer. Die Uebung in Produktion '
                      'bleibt NW-6')),
            ('L6', 'Kapazitaet nach L6 als Zahl', '§3.4',
             betreiber('kapazitaet_l6', 'Kapazitaet aus der echten Belegung gerechnet, nicht behauptet (W5)')),
            ('P', 'Pilotkunden gewaehlt und eingewilligt', '§3.4',
             betreiber('pilotkunden', 'die Handvoll betreuter Kundenbereiche steht und hat eingewilligt')),
            ('M-4', 'gitops-PR 37 gemergt und ausgerollt - mindestens einen Tag VOR dem Fenster', '§3.4 / Drehbuch §2.2',
             betreiber('gitops_pr37',
                       'PR 37 gemergt, ein Sync und ein api-Neustart auf dem ALTEN Schema beobachtet')),
            ('M-4b', 'Die zwei Platzhalter aus PR 37 gesetzt', 'Drehbuch §2.3 / §9.3',
             betreiber('gitops_platzhalter',
                       'uems_datenbank_warnschwelle_bytes aus Q14 und der Tenant des Dauerlaeufers (IP-18) gesetzt')),
            ('F6', 'Support-Weg einmal gegangen', '§3.4 / Drehbuch §11',
             betreiber('supportweg', 'der Support-Weg ist einmal von aussen gegangen worden')),
            ('B9', 'Kundennachricht zum Fenster samt Release-Notiz raus', '§3.4 / Drehbuch §10',
             betreiber('kundennachricht',
                       'Nachricht 48 h vorher raus, Release-Notiz mit den sichtbaren Aenderungen dabei; '
                       'docs/rollout/release-notiz-vorlage.md ist die VORLAGE, keine versendete Nachricht')),
            ('IP-18', 'Dauerlaeufer-Kundenbereich steht', 'Drehbuch §14',
             betreiber('ip18_dauerlaeufer',
                       'Kundenbereich "VoltPilot Dauerlaeufer (intern)" angelegt, zwei Boxen angemeldet, '
                       'VOLTPILOT_UEMS_DAUERLAEUFER_TENANT und voltpilot:uems_dauerlaeufer gesetzt, '
                       'Uebung Simulator anhalten -> VoltPilotDauerlaeuferStumm nach 15 min gesehen',
                       'Betreiber, das Werkzeug liegt bereit')),
            ('W1', 'Entscheidung ueber den Start-Waechter auf main', 'Drehbuch §9.1',
             betreiber('startwaechter_main',
                       'die alte api schreibt beim Neustart 18 DELETE-Marker, danach startet die neue nicht; '
                       'das Drehbuch ist mit und ohne Waechter fahrbar - der Betreiber entscheidet')),
            ('R1', 'Standort-Zaun auf geraet/component_definition bleibt, ein fremdes Geraet ist unsichtbar',
             'Bau-Befund AP-03 IP-5 / Entscheid A vom 21.09.2026',
             surefire('com.voltpilot.api.zugriff.RechtMatrixApiTest',
                      'PR 830; das entschiedene Urteil haelt ausserhalbIstDieselbe404WieEineKennungDieEsNichtGibt fest')),
        ]
    if tor == 'GA':
        return [
            ('NW-3neu', 'NW-3 gegen das NEUE Image', '§3.4', nw3_neues_image),
            ('Q08', 'Keine Bestandsbox wuerde ihren heutigen Plan ablehnen', '§3.4 / IP-17',
             betreiber('budgetpruefung_produktion',
                       'tools/budgetpruefung/run.sh lesend gegen Produktion gefahren, Teil-D-Liste leer oder erklaert',
                       'Crew faehrt, Betreiber gibt den Zugang')),
            ('CP', 'Core und Palette gemeinsam freigegeben', '§3.4',
             betreiber('core_palette_gemeinsam',
                       'Core und Node-RED-Palette gehen als EIN Release-Stand, nie einzeln')),
        ]
    if tor == 'GB':
        return [
            ('FA', 'Ganze Flotte auf Release A', '§3.4',
             betreiber('flotte_auf_release_a', 'jede Box im Feld faehrt Release A')),
            ('Q10', 'pending_edge leer oder erklaert', '§3.4',
             betreiber('q10_pending_edge', 'Q10 aus dem Bestandsblatt: pending_edge leer oder je Fall erklaert')),
            ('HW', 'AP-05-Hardware-Pruefstand (Ahrenberg C-1)', '§3.4',
             betreiber('wago_hardware_pilot',
                       'WAGO-Pilot an echter Hardware gefahren; Simulatornachweise ersetzen keinen Pruefstand',
                       'Crew faehrt, Betreiber stellt die Hardware')),
        ]
    raise KeyError(tor)


# --------------------------------------------------------------------------- #
# Ausgabe
# --------------------------------------------------------------------------- #

def berichte(tor: str, ctx: Kontext, aus=None) -> int:
    aus = aus or sys.stdout
    zweig = ctx.git('rev-parse', '--abbrev-ref', 'HEAD')
    print(f'Tor {tor} - {TORE[tor]}', file=aus)
    print(f'Geprueft am {tag(ctx.jetzt)} gegen {ctx.kopf[:8]} ({zweig}'
          f'{", " + tag(ctx.kopf_zeit) if ctx.kopf_zeit else ""})', file=aus)
    print(f'Stand-Blatt des Betreibers: {ctx.stand_pfad if ctx.stand_pfad else "keines angegeben (--stand)"}', file=aus)
    print('', file=aus)

    zaehler = {BELEGT: 0, OFFEN: 0, BETREIBER_WORT: 0}
    for kennung, titel, quelle, pruefer in punkte(tor):
        urteil, text = pruefer(ctx)
        zaehler[urteil] += 1
        print(f'  [{urteil}] {kennung}  {titel}  ({quelle})', file=aus)
        print(f'      {text}', file=aus)
    print('', file=aus)
    print(f'{zaehler[BELEGT]} belegt · {zaehler[OFFEN]} offen · '
          f'{zaehler[BETREIBER_WORT]} nicht maschinell pruefbar, vom Betreiber bestaetigt', file=aus)
    if zaehler[OFFEN]:
        print(f'Tor {tor}: NICHT vollstaendig belegt. Die offenen Punkte stehen oben.', file=aus)
        return 1
    print(f'Tor {tor}: jeder Pruefpunkt hat einen Beleg oder das Wort des Betreibers.', file=aus)
    print('Das Werkzeug oeffnet kein Tor - das tut der Betreiber selbst.', file=aus)
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        prog='pruefe-tor.sh',
        description='Legt je Tor der ersten UEMS-Produktfreigabe vor, was belegt ist und was fehlt. '
                    'Das Werkzeug urteilt nicht darueber, ob ein Tor oeffnet - das tut der Betreiber selbst.',
        epilog='Exit 0 = kein Punkt offen · 1 = mindestens ein Punkt offen · 2 = Aufruffehler.')
    p.add_argument('tor', choices=sorted(TORE), metavar='TOR', help='G0, G1, GA oder GB')
    p.add_argument('--stand', help='Stand-Blatt des Betreibers (Vorlage: tools/freigabe/freigabe-stand.example.yaml)')
    p.add_argument('--laeufe', help='Verzeichnis mit Surefire-Berichten; Vorgabe services/api/target/surefire-reports')
    p.add_argument('--blatt', help='datierte Ergebnisdatei des Bestandsblatts (M-1)')
    p.add_argument('--generalprobe', help='Verzeichnis mit probe.json und rueckweg.json')
    p.add_argument('--wurzel', help='Repo-Wurzel; Vorgabe: zwei Ebenen ueber diesem Skript')
    try:
        args = p.parse_args(argv)
    except SystemExit as ende:
        if ende.code:
            # Unbekanntes Tor: die vollstaendige Hilfe statt nur der Nutzungszeile.
            print(p.format_help(), file=sys.stderr)
            return 2
        return 0

    wurzel = pathlib.Path(args.wurzel) if args.wurzel else pathlib.Path(__file__).resolve().parents[2]
    try:
        ctx = Kontext(args, wurzel)
    except (StandFehler, OSError) as fehler:
        print(f'Stand-Blatt nicht lesbar: {fehler}', file=sys.stderr)
        return 2
    return berichte(args.tor, ctx)


if __name__ == '__main__':
    sys.exit(main())
