package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Die reinen Regeln des BERICHTS (UEMS AP-12 IP-1/IP-3) — Vertrag {@code docs/contracts/v2/bericht.md}, Vektoren
 * {@code bericht-vectors.json}, TS-Zwilling {@code frontend/portal/src/uemsBericht.ts}.
 *
 * <p>Ein Bericht ist ein eigenes Objekt (Vorlage × Geltung × Zeitraum) mit einem Entwurf und freigegebenen
 * Berichtsständen; ein Berichtsstand ist ein ABZUG — Text mit Prüfsumme, nie ein Verweis (E1). Diese Klasse bildet keinen
 * Abzug und liest keine Tabelle: sie legt Zeitraum und Vergleichszeiträume fest (V1, Q5), prüft die Voraussetzungen einer
 * Freigabe (F1) und den Datenstand (D2–D4), schneidet Änderungen mit dem Quellenverzeichnis (B1, B4, B6), vergleicht zwei
 * Abzüge (R1), schreibt die kanonische Form und ihre Prüfsumme (A1, A6), die Zeilen des Berichts-CSV (DA3), die
 * Teilansicht (G3) und die Sätze (§5.8).
 *
 * <p><b>Aufgerufen, nicht kopiert:</b> Periodengrenzen {@link BezugsPeriode#spanneVon}, Tagesbeginn und Frist
 * {@link TagRegeln}, Uhrzeit, Zone und Zahlform {@link ErgebnisZustand}, Kennzahl-Anzeige und Periodenname
 * {@link KennzahlRegeln}, Datum {@link OrtsbaumAbleitung#datumText}, Recht {@link RechteAbleitung#darf}; die Betroffenheit
 * spricht die Sprache der Naht ({@link BerichteNaht.Bericht}, {@link KorrekturKaskade.Betroffen}). Noch ruft niemand an
 * (Tabellen IP-4, Abzug IP-5/IP-6, Routen IP-7, Naht IP-8, Läufer IP-9, Ausgabe IP-10/IP-11).
 */
public final class BerichtRegeln {

    private BerichtRegeln() {}

    // ============================================================== Vokabulare

    public static final String ENTWURF = "entwurf";
    public static final String FREIGEGEBEN = "freigegeben";
    public static final List<String> STAENDE = List.of(ENTWURF, FREIGEGEBEN);

    public static final String MONATSBERICHT_STANDORT = "monatsbericht_standort";
    public static final String JAHRESBERICHT_STANDORT = "jahresbericht_standort";
    public static final String MONATSBERICHT_UNTERNEHMEN = "monatsbericht_unternehmen";
    public static final String JAHRESBERICHT_UNTERNEHMEN = "jahresbericht_unternehmen";
    public static final String ENERGETISCHE_BEWERTUNG = "energetische_bewertung";
    /** AP-17 IP-21a (S1, W8): Vertrag 1.4 — die Kennzahl im Vergleich mit ihrer Bezugsbasis. */
    public static final String LEISTUNGSVERGLEICH = "leistungsvergleich";
    /**
     * AP-19 IP-22 (MG1–MG3): Vertrag 1.5 — die Managementbewertung am Unternehmen für ein Jahr. Ihre Abschnitte zitieren
     * Stände und Zustände ({@link BerichtManagementbewertung}), ihre Rechte sind {@code energiemanagement.*}.
     */
    public static final String MANAGEMENTBEWERTUNG = "managementbewertung";
    /**
     * AP-17 IP-21a: Vorlagen im Katalog, deren Leser noch fehlt. Anlegen antwortet für sie {@link #VORLAGE_UNBEKANNT};
     * das Portal zeigt keine Karte. Seit IP-21b (der Abzug aus Kennzahl, Basis und Vergleich) leer.
     */
    public static final Set<String> OHNE_LESER = Set.of();
    /**
     * AP-17 IP-21b: Vorlagen ohne PDF/CSV ({@code 422 ausgabe_fehlt}). Seit IP-22 (Layout und Mapping des
     * Leistungsvergleichs in {@link BerichtPdf}/{@link BerichtCsv}) leer.
     */
    public static final Set<String> OHNE_AUSGABE = Set.of();
    /**
     * AP-19 IP-22: Vorlagen mit PDF, aber ohne Berichts-CSV ({@code 422 ausgabe_fehlt} nach dem Recht) — die
     * Managementbewertung ist ein Dokument der Leitung, keine Tabelle zum Weiterrechnen.
     */
    public static final Set<String> OHNE_CSV = Set.of(MANAGEMENTBEWERTUNG);
    /** AP-14/AP-16: derselbe Grenz-Satz im Bewertungs-PDF und -CSV; das Portal hält ihn als {@code UEMS_NORMGRENZE}. */
    public static final String BEWERTUNG_GRENZ_SATZ = "VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen "
            + "und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.";

    public static final String STANDORT = KennzahlRegeln.STANDORT;
    public static final String UNTERNEHMEN = KennzahlRegeln.UNTERNEHMEN;
    public static final List<String> GELTUNG_ARTEN = List.of(STANDORT, UNTERNEHMEN);

    public static final String MONAT = "monat";
    public static final String JAHR = "jahr";
    public static final String DATENGRUNDLAGE = "datengrundlage";
    public static final List<String> ZEITRAUM_ARTEN = List.of(MONAT, JAHR, DATENGRUNDLAGE);

    public static final String VORMONAT = "vormonat";
    public static final String VORJAHRESMONAT = "vorjahresmonat";
    public static final String VORJAHR = "vorjahr";
    public static final List<String> VERGLEICH_ARTEN = List.of(VORMONAT, VORJAHRESMONAT, VORJAHR);

    public static final List<String> QUELLE_ARTEN =
            List.of("messstelle", "kostenstelle", "bezugsgroesse", "stammdatum", "kennzahl", "umfang",
                    "energieeinsatz", "messbedarf", "messmittel", "bezugsbasis",
                    // 1.5 (AP-19 IP-22, MG3): die Quellen der Managementbewertung — keine trägt Kennzahl-Werte.
                    "energieziel", "massnahme", "abweichung", "feststellung", "internes_audit", "dokument", "beschluss",
                    "berichtsstand");

    public static final String UNMITTELBAR = "unmittelbar";
    public static final String MITTELBAR = "mittelbar";
    public static final String VERGLEICH = "vergleich";
    public static final List<String> QUELLE_BEZUEGE = List.of(UNMITTELBAR, MITTELBAR, VERGLEICH);

    public static final String KORREKTUR_FREIGEGEBEN = "korrektur_freigegeben";
    public static final String KORREKTUR_ZURUECKGENOMMEN = "korrektur_zurueckgenommen";
    public static final String ERSATZWERT_WIRKSAM = "ersatzwert_wirksam";
    public static final String ERSATZWERT_ZURUECKGENOMMEN = "ersatzwert_zurueckgenommen";
    public static final String BEZUGSGROESSE_FASSUNG = "bezugsgroesse_fassung";
    public static final String KENNZAHL_FASSUNG_RUECKWIRKEND = "kennzahl_fassung_rueckwirkend";
    public static final String ZUORDNUNG_RUECKWIRKEND = "zuordnung_rueckwirkend";
    public static final String ANLAGE_UMZUG_RUECKWIRKEND = "anlage_umzug_rueckwirkend";
    public static final String FLAECHE_RUECKWIRKEND = "flaeche_rueckwirkend";
    public static final String VERTEILUNG_RUECKWIRKEND = "verteilung_rueckwirkend";
    public static final String EINSTUFUNG_FASSUNG = "einstufung_fassung";
    public static final String KRITERIEN_FASSUNG = "kriterien_fassung";
    public static final String UMFANG_FASSUNG = "umfang_fassung";
    public static final String MESSBEDARF_ZUSTAND = "messbedarf_zustand";
    public static final String PROZESS_ZUORDNUNG_RUECKWIRKEND = "prozess_zuordnung_rueckwirkend";
    public static final String MESSMITTEL_ANGABE = "messmittel_angabe";
    /** AP-17 IP-23 (A5, S4): ein Anstoß an der zitierten Basis-Fassung ({@code bezugsbasis_anstoss}, IP-15). */
    public static final String BEZUGSBASIS_ANSTOSS = "bezugsbasis_anstoss";
    /** AP-17 IP-23 (A5, S4): eine neue Fassung der zitierten Bezugsbasis ist freigegeben. */
    public static final String BEZUGSBASIS_FASSUNG = "bezugsbasis_fassung";
    /** AP-17 IP-23 (A5, S4): die zitierte Bezugsbasis ist beendet. */
    public static final String BEZUGSBASIS_BEENDET = "bezugsbasis_beendet";
    /** Die Anstoß-Arten, die von einer Bezugsbasis kommen (A5). */
    public static final List<String> BEZUGSBASIS_ARTEN = List.of(BEZUGSBASIS_ANSTOSS, BEZUGSBASIS_FASSUNG,
            BEZUGSBASIS_BEENDET);
    /** B4 — die Anstoß-Arten, geschlossen. */
    public static final List<String> ANSTOSS_ARTEN = List.of(KORREKTUR_FREIGEGEBEN, KORREKTUR_ZURUECKGENOMMEN,
            ERSATZWERT_WIRKSAM, ERSATZWERT_ZURUECKGENOMMEN, BEZUGSGROESSE_FASSUNG, KENNZAHL_FASSUNG_RUECKWIRKEND,
            ZUORDNUNG_RUECKWIRKEND, ANLAGE_UMZUG_RUECKWIRKEND, FLAECHE_RUECKWIRKEND, VERTEILUNG_RUECKWIRKEND,
            EINSTUFUNG_FASSUNG, KRITERIEN_FASSUNG, UMFANG_FASSUNG, MESSBEDARF_ZUSTAND,
            PROZESS_ZUORDNUNG_RUECKWIRKEND, MESSMITTEL_ANGABE, BEZUGSBASIS_ANSTOSS, BEZUGSBASIS_FASSUNG,
            BEZUGSBASIS_BEENDET);

    public static final List<String> ANSTOSS_ZUSTAENDE = List.of("offen", "erledigt", "verworfen");

    public static final String VOR_BESTEHEN = KennzahlRegeln.VOR_BESTEHEN;
    public static final String QUELLE_BEENDET = "quelle_beendet";
    public static final String KEINE_WERTE = "keine_werte";
    public static final List<String> GRUENDE_OHNE_VERGLEICH = List.of(VOR_BESTEHEN, QUELLE_BEENDET, KEINE_WERTE);

    public static final String UMBENENNUNG = "umbenennung";
    public static final String NICHT_RUECKWIRKEND = "nicht_rueckwirkend";
    public static final String KEINE_STRUKTURAENDERUNG = "keine_strukturaenderung";
    /** B6 — warum eine Zeile eines Änderungsprotokolls KEIN Anstoß ist. */
    public static final List<String> KEIN_ANSTOSS = List.of(UMBENENNUNG, NICHT_RUECKWIRKEND, KEINE_STRUKTURAENDERUNG);

    public static final String ORT_AENDERUNG = "ort_aenderung";
    public static final String MESSSTELLE_AENDERUNG = "messstelle_aenderung";
    public static final String ENERGIEEINSATZ_AENDERUNG = "energieeinsatz_aenderung";
    public static final String BEWERTUNG_AENDERUNG = "bewertung_aenderung";
    public static final String MESSBEDARF_AENDERUNG = "messbedarf_aenderung";
    public static final String GERAET_AENDERUNG = "geraet_aenderung";
    public static final List<String> BEWERTUNGS_PROTOKOLLE = List.of(ENERGIEEINSATZ_AENDERUNG,
            BEWERTUNG_AENDERUNG, MESSBEDARF_AENDERUNG, GERAET_AENDERUNG);
    public static final List<String> STRUKTUR_PROTOKOLLE = List.of(ORT_AENDERUNG, MESSSTELLE_AENDERUNG,
            ENERGIEEINSATZ_AENDERUNG, BEWERTUNG_AENDERUNG, MESSBEDARF_AENDERUNG, GERAET_AENDERUNG);

    public static final List<String> HANDLUNGEN =
            List.of("abrufen", "pdf", "csv", "anlegen", "freigeben", "verwerfen", "archivieren",
                    "wiedervorlage_aendern");

    public static final String ZEITRAUM_NICHT_ZU_ENDE = "zeitraum_nicht_zu_ende";
    public static final String WERTE_VORLAEUFIG = "werte_vorlaeufig";
    public static final String ENTWURF_VERALTET = "entwurf_veraltet";
    public static final String KEINE_QUELLEN = "keine_quellen";
    public static final String BERICHT_GIBT_ES_SCHON = "bericht_gibt_es_schon";
    public static final String STAND_GIBT_ES_NICHT = "stand_gibt_es_nicht";
    public static final String WERT_NICHT_MEHR_GESPEICHERT = "wert_nicht_mehr_gespeichert";
    public static final String BERICHTS_BELEGE = "berichts_belege";
    public static final String ABZUG_BESCHAEDIGT = "abzug_beschaedigt";
    public static final String VORLAGE_UNBEKANNT = "vorlage_unbekannt";
    public static final String GELTUNG_UNBEKANNT = "geltung_unbekannt";
    /** §5.8 — der HTTP-Status je Fehler-Code. */
    public static final Map<String, Integer> FEHLER_STATUS = geordnet(ZEITRAUM_NICHT_ZU_ENDE, 422, WERTE_VORLAEUFIG, 422,
            ENTWURF_VERALTET, 409, KEINE_QUELLEN, 422, BERICHT_GIBT_ES_SCHON, 409, STAND_GIBT_ES_NICHT, 404,
            WERT_NICHT_MEHR_GESPEICHERT, 404, BERICHTS_BELEGE, 409, ABZUG_BESCHAEDIGT, 500, VORLAGE_UNBEKANNT, 422,
            GELTUNG_UNBEKANNT, 404);
    public static final List<String> FEHLER = List.copyOf(FEHLER_STATUS.keySet());

    /** Reserviert im Ereignis-Vokabular, angelegt mit den Berichts-Tabellen (IP-4) — Art/Bezug. */
    public static final List<String> EREIGNISSE_RESERVIERT = List.of("bericht_freigegeben/bericht",
            "bericht_revision_angestossen/bericht", "bericht_entwurf_neu_gebildet/bericht", "bericht_abgerufen/bericht");

    /** Die Rechte der Berichte; seit AP-19 IP-11 (RE4, W10) je eine Lese-Kennung neben dem Freigabe-Recht am Unternehmen. */
    public static final List<String> RECHTE = List.of("bericht.standort_abrufen", "bericht.standort_freigeben",
            "bericht.unternehmen", "bericht.unternehmen_abrufen", "bewertung.abrufen", "bewertung.ansehen",
            "export.standort", "export.unternehmen");

    /** G1 — Handlung × Geltung → Kennung der Rechte-Matrix, Schlüssel {@code <geltung>/<handlung>}. */
    public static final Map<String, String> KENNUNG = kennungen();

    /** G3 — die Standorte einer Teilansicht sind die, deren Messwerte die Person ansehen darf. */
    public static final String TEILANSICHT_RECHT = KennzahlRegeln.ANSEHEN;

    // ============================================================== Regeln der Darstellung

    /** F1 — ein Stand ist frühestens Periodenende + diese Frist freigebbar (AP-07 E5, {@link TagRegeln#endgueltigAb}). */
    public static final Duration FREIGABE_FRIST = TagRegeln.FRIST;
    public static final int PROZENT_NACHKOMMASTELLEN = 1;
    public static final int PROZENT_RECHEN_NACHKOMMASTELLEN = KennzahlRegeln.WERT_NACHKOMMASTELLEN;
    public static final int QUELLEN_IM_SATZ = 3;
    public static final String PRUEFSUMME_PRAEFIX = "sha256:";
    public static final String KENNZEICHEN_TRENNER = ErgebnisZustand.TRENNER;
    public static final String OHNE_ZAHL = ErgebnisZustand.OHNE_ZAHL;
    public static final String CSV_TRENNER = ";";
    public static final String CSV_DEZIMAL = ",";
    public static final List<String> CSV_SPALTEN = List.of("quelle", "name", "ort", "periode", "menge", "einheit",
            "zustand", "abdeckung_prozent", "kennzeichen", "fassung", "endgueltig_ab", "version", "berechnet_am");
    public static final List<String> CSV_KOPF = List.of("bericht", "vorlage", "geltung", "zeitraum", "stand",
            "datenstand", "freigegeben_am", "freigegeben_von", "zeitzone", "dezimal", "trenner", "zahlen", "pruefsumme",
            "erzeugt_am", "erzeugt_von", "teilansicht");

    private static final BigDecimal HUNDERT = new BigDecimal("100");

    /** E14 — Wörter, die ein Bericht nie über sich sagt („Version“ gehört den Werten). */
    public static final List<String> VERBOTENE_WOERTER =
            List.of("Version des Berichts", "Ausgabe", "Snapshot", "Report", "Freigabe zurücknehmen");

    /** §5.8 und der Kopf — die Satzvorlagen; {@code {name}} füllt die Regel. */
    public static final Map<String, String> SAETZE = geordnet(
            "zeitraum_nicht_zu_ende", "{zeitraum} ist noch nicht zu Ende — ein Berichtsstand ist ab dem {datum} möglich ({tage} Tage nach {ende}).",
            "zeitraum_monat", "Der {name}",
            "zeitraum_jahr", "Das Jahr {name}",
            "zeitraum_datengrundlage", "Die Datengrundlage {name}",
            "ende_monat", "Monatsende",
            "ende_jahr", "Jahresende",
            "ende_datengrundlage", "Ende der Datengrundlage",
            "werte_vorlaeufig", "{werte} noch vorläufig (endgültig ab {datum}): {quellen} — ein Berichtsstand braucht endgültige Werte.",
            "werte_mehrere", "{anzahl} Werte sind",
            "werte_einer", "1 Wert ist",
            "quellen_weitere", "…",
            "entwurf_veraltet", "Der Entwurf hat sich seit dem {zeitpunkt} geändert{anlass}. Laden Sie ihn neu{pruefen}.",
            "entwurf_veraltet_anlass", " ({anlass})",
            "entwurf_veraltet_pruefen", " und prüfen Sie die {anzahl} Abweichungen",
            "entwurf_veraltet_pruefen_eine", " und prüfen Sie die Abweichung",
            "keine_quellen", "Für {geltung} gibt es {zeitraum} keine Messstellen.",
            "keine_quellen_seit", "Für {geltung} gibt es {zeitraum} keine Messstellen — der Standort besteht seit dem {datum}.",
            "im_monat", "im {name}",
            "im_jahr", "im Jahr {name}",
            "bericht_gibt_es_schon", "Diesen Bericht gibt es schon: {kennung} ({vorlage} {geltung}, {zeitraum}).",
            "vorlage_monat", "Monatsbericht",
            "vorlage_jahr", "Jahresbericht",
            "stand_gibt_es_nicht", "Berichtsstand Nr. {nr} gibt es nicht — der neueste ist Nr. {neueste} vom {datum}.",
            "stand_gibt_es_nicht_keiner", "Berichtsstand Nr. {nr} gibt es nicht — der Bericht hat noch keinen freigegebenen Berichtsstand.",
            "wert_nicht_mehr_gespeichert", "Der Wert {zeitraum} wird nicht mehr gespeichert (Aufbewahrung 10 Jahre). Der Berichtsstand Nr. {nr} vom {datum} hält ihn fest.",
            "wert_nicht_mehr_gespeichert_ohne_stand", "Der Wert {zeitraum} wird nicht mehr gespeichert (Aufbewahrung 10 Jahre).",
            "vom_monat", "vom {name}",
            "vom_jahr", "vom Jahr {name}",
            "berichts_belege", "Diese Komponente ist Beleg in {anzahl} freigegebenen Berichtsständen ({staende}). Löschen ist nicht möglich — beenden Sie die Bindung stattdessen.",
            "berichts_belege_eins", "Diese Komponente ist Beleg in einem freigegebenen Berichtsstand ({staende}). Löschen ist nicht möglich — beenden Sie die Bindung stattdessen.",
            "stand_bezeichnung", "{kennung} Nr. {nr}",
            "abzug_beschaedigt", "Der Berichtsstand Nr. {nr} kann nicht gelesen werden: die Prüfsumme stimmt nicht. Bitte wenden Sie sich an VoltPilot.",
            "vorlage_unbekannt", "Diese Berichtsvorlage gibt es nicht.",
            "geltung_unbekannt", "Diesen Standort gibt es nicht.",
            "kopf_stand", "Datenstand {datenstand} · Berichtsstand Nr. {nr} · freigegeben {freigegeben} von {person}",
            "kopf_entwurf", "Entwurf · Datenstand {datenstand}",
            "zeit_mit_zone", "{zeitpunkt} ({zone})",
            "anlass_korrektur", "Korrektur {kennung}",
            "anlass_ersatzwert", "Ersatzwert {kennung}",
            "anlass_zuordnung_rueckwirkend", "Zuordnung {objekt} geändert, gilt ab {ab}, eingetragen {am}",
            "anlass_anlage_umzug_rueckwirkend", "Anlage {objekt} umgezogen, gilt ab {ab}, eingetragen {am}",
            "anlass_flaeche_rueckwirkend", "Fläche {objekt} geändert, gilt ab {ab}, eingetragen {am}",
            "anlass_verteilung_rueckwirkend", "Verteilung {objekt} berichtigt, gilt ab {ab}, eingetragen {am}",
            "anlass_einstufung_fassung", "Einstufung {objekt} geändert",
            "anlass_kriterien_fassung", "Kriterien-Fassung geändert",
            "anlass_umfang_fassung", "Betrachtungsumfang geändert",
            "anlass_messbedarf_zustand", "Messbedarf {objekt} geändert",
            "anlass_prozess_zuordnung_rueckwirkend", "Prozess-Zuordnung {objekt} rückwirkend geändert",
            "anlass_messmittel_angabe", "Messmittel-Angaben {objekt} geändert",
            "anlass_bezugsbasis_anstoss", "Bezugsbasis {basis}, Fassung {fassung}: Anstoß liegt vor",
            "anlass_bezugsbasis_fassung", "Bezugsbasis {basis}: Fassung {fassung} freigegeben",
            "anlass_bezugsbasis_beendet", "Bezugsbasis {basis} beendet",
            "ueber_formel", "{anlass} (über die Formel)",
            "ueber_kennzahl", "{anlass} (über die Kennzahl)",
            "csv_geltung_standort", "Standort {kennzeichen} {name}",
            "csv_geltung_unternehmen", "Unternehmen {kennzeichen} {name}",
            "csv_zeitraum", "{schluessel} ({erster}–{letzter})",
            "leistungsvergleich_stand", "Leistungsvergleich {name}, {zeitraum} · Stand Nr. {nr} vom {datum} · Bezugsbasis "
                    + "{bezugsbasis}, Fassung {fassung} · Prüfsumme {pruefsumme}…",
            "leistungsvergleich_ohne_stand", "ungesichert — noch kein Stand");

    // ============================================================== Kennzeichen (ergebnis-zustand 1.10)

    /** Ein Kennzeichen eines Berichts: Muster, Platzhalter-Typen, Stelle. */
    public record Kennzeichen(String schluessel, String muster, Map<String, String> platzhalter, String stelle) {}

    /** Die Platzhalter-Typen; {@code uhr} ist der von {@link ErgebnisZustand#PLATZHALTER}. */
    public static final Map<String, String> KENNZEICHEN_PLATZHALTER = geordnet(
            "nr", "[1-9][0-9]*",
            "datum", "(?:0[1-9]|[12][0-9]|3[01])\\.(?:0[1-9]|1[0-2])\\.[0-9]{4}",
            "uhr", ErgebnisZustand.PLATZHALTER.get("uhr"),
            "text", ".+");

    public static final List<Kennzeichen> KENNZEICHEN = List.of(
            new Kennzeichen("berichtsstand", "Berichtsstand Nr. {nr}", Map.of("nr", "nr"), "bericht"),
            new Kennzeichen("ersetzt_durch", "ersetzt durch Nr. {nr} ({datum})", geordnet("nr", "nr", "datum", "datum"), "stand"),
            new Kennzeichen("revision_noetig", "Revision nötig — {anlass}", Map.of("anlass", "text"), "bericht"),
            new Kennzeichen("entwurf", "Entwurf · Datenstand {datum} {uhr}", geordnet("datum", "datum", "uhr", "uhr"), "bericht"),
            new Kennzeichen("zeitraum_laeuft", "Zeitraum läuft", Map.of(), "entwurf"),
            new Kennzeichen("vorlaeufig", "vorläufig — endgültig ab {datum}", Map.of("datum", "datum"), "wert"),
            new Kennzeichen("heute", "heute: {name}", Map.of("name", "text"), "quelle"),
            new Kennzeichen("teilansicht", "Teilansicht: {standorte}", Map.of("standorte", "text"), "datei"),
            new Kennzeichen("vor_beginn", "vor Beginn (Energiemanagement seit {datum})", Map.of("datum", "datum"), "wert"),
            new Kennzeichen("anstoss_verworfen", "Anstoß verworfen ({begruendung})", Map.of("begruendung", "text"), "bericht"));

    public static final String ZEITRAUM_LAEUFT = muster("zeitraum_laeuft");

    // ============================================================== Vorlagen (V2)

    /**
     * Eine Berichtsvorlage: Geltung, Zeitraum, Vergleiche und die Schlüssel ihrer Abschnitte. {@code geltungArt} und
     * {@code zeitraumArt} sind die Vorgabe; {@code geltungArten} × {@code zeitraumArten} die Paare, für die sie gilt
     * (1.4: der Leistungsvergleich kennt sechs, jede andere Vorlage genau eines).
     */
    public record Vorlage(String schluessel, int fassung, String geltungArt, String zeitraumArt, List<String> vergleiche,
            List<String> abschnitte, List<String> geltungArten, List<String> zeitraumArten) {

        public Vorlage {
            if (!geltungArten.get(0).equals(geltungArt) || !zeitraumArten.get(0).equals(zeitraumArt)) {
                throw new IllegalArgumentException("Vorlage " + schluessel + ": die Vorgabe steht vorn");
            }
        }

        /** Eine Vorlage mit genau einem Paar aus Geltung und Zeitraum. */
        public Vorlage(String schluessel, int fassung, String geltungArt, String zeitraumArt, List<String> vergleiche,
                List<String> abschnitte) {
            this(schluessel, fassung, geltungArt, zeitraumArt, vergleiche, abschnitte, List.of(geltungArt),
                    List.of(zeitraumArt));
        }

        public boolean passt(String geltung, String zeitraum) {
            return geltungArten.contains(geltung) && zeitraumArten.contains(zeitraum);
        }
    }

    public static final Map<String, Vorlage> VORLAGEN = vorlagen(
            new Vorlage(MONATSBERICHT_STANDORT, 1, STANDORT, MONAT, List.of(VORMONAT, VORJAHRESMONAT),
                    List.of("kopf", "zusammenfassung", "verbrauch_je_messstelle", "tagesverlauf", "kennzahlen", "qualitaet",
                            "quellenverzeichnis")),
            new Vorlage(JAHRESBERICHT_STANDORT, 1, STANDORT, JAHR, List.of(VORJAHR),
                    List.of("kopf", "zusammenfassung", "verbrauch_je_messstelle", "monatswerte", "kennzahlen", "qualitaet",
                            "quellenverzeichnis")),
            new Vorlage(MONATSBERICHT_UNTERNEHMEN, 1, UNTERNEHMEN, MONAT, List.of(VORMONAT, VORJAHRESMONAT),
                    List.of("kopf", "zusammenfassung", "standorte", "kostenstellen", "kennzahlen", "qualitaet",
                            "quellenverzeichnis")),
            new Vorlage(JAHRESBERICHT_UNTERNEHMEN, 1, UNTERNEHMEN, JAHR, List.of(VORJAHR),
                    List.of("kopf", "zusammenfassung", "standorte", "kostenstellen", "monatswerte", "kennzahlen", "qualitaet",
                            "quellenverzeichnis")),
            new Vorlage(ENERGETISCHE_BEWERTUNG, 1, UNTERNEHMEN, DATENGRUNDLAGE, List.of(),
                    List.of("umfang", "rangliste", "einstufungen", "messabdeckung", "messplanung", "messmittel",
                            "qualitaet", "quellenverzeichnis")),
            new Vorlage(LEISTUNGSVERGLEICH, 1, UNTERNEHMEN, MONAT, List.of(),
                    List.of("kopf", "kennzahl", "bezugsbasis", "vergleich_je_periode", "urteil", "grenzen_und_vorbehalte",
                            "statische_faktoren", "quellenverzeichnis"),
                    List.of(UNTERNEHMEN, STANDORT), List.of(MONAT, JAHR, DATENGRUNDLAGE)),
            new Vorlage(MANAGEMENTBEWERTUNG, 1, UNTERNEHMEN, JAHR, List.of(),
                    List.of("vorige_beschluesse", "grundlagen", "energieziele", "energieleistung", "massnahmen",
                            "abweichungen", "audits_feststellungen", "bewertung_messplanung", "wiedervorlage", "beschluesse",
                            "sitzung", "quellenverzeichnis")));

    /** V2 — die Vorlage zu ihrem Schlüssel; {@code null} = {@link #VORLAGE_UNBEKANNT}. */
    public static Vorlage vorlage(String schluessel) {
        return VORLAGEN.get(schluessel);
    }

    /** V2 — gilt die Vorlage für Geltung × Zeitraum? Dieselbe Frage stellt {@code bericht_vorlage_passt()} der Datenbank. */
    public static boolean vorlagePasst(String schluessel, String geltungArt, String zeitraumArt) {
        Vorlage v = VORLAGEN.get(schluessel);
        return v != null && v.passt(geltungArt, zeitraumArt);
    }

    // ============================================================== Zeitraum (V1, Q5)

    public record Vergleichszeitraum(String art, String schluessel, LocalDate ersterTag, LocalDate letzterTag, Instant von,
            Instant bis) {}

    /**
     * @param von halboffen: Mitternacht des ersten Tags in der Zone
     * @param bis Mitternacht nach dem letzten Tag
     * @param freigabeAb frühester Freigabe-Zeitpunkt (F1)
     */
    public record Zeitraum(String art, String schluessel, LocalDate ersterTag, LocalDate letzterTag, Instant von, Instant bis,
            Instant freigabeAb, String bezeichnung, List<Vergleichszeitraum> vergleiche) {}

    /** V1/S1 — Kalendermonat, Kalenderjahr oder eine Datengrundlage aus ganzen Monaten. */
    public static Zeitraum zeitraum(String art, String schluessel, ZoneId zone) {
        if (!ZEITRAUM_ARTEN.contains(art)) {
            throw new IllegalArgumentException("Zeitraum-Art " + art + " hat keinen Bericht");
        }
        LocalDate[] spanne;
        if (DATENGRUNDLAGE.equals(art)) {
            String[] teile = schluessel.split("/", -1);
            if (teile.length < 1 || teile.length > 2) {
                throw new IllegalArgumentException("Datengrundlage " + schluessel);
            }
            LocalDate von = java.time.YearMonth.parse(teile[0]).atDay(1);
            LocalDate bis = java.time.YearMonth.parse(teile.length == 1 ? teile[0] : teile[1]).atEndOfMonth();
            if (bis.isBefore(von)) {
                throw new IllegalArgumentException("Datengrundlage " + schluessel);
            }
            spanne = new LocalDate[] {von, bis};
        } else {
            spanne = BezugsPeriode.spanneVon(schluessel, art);
        }
        List<Vergleichszeitraum> vergleiche = new ArrayList<>();
        if (MONAT.equals(art)) {
            vergleiche.add(vergleichszeitraum(VORMONAT, spanne[0].minusMonths(1), MONAT, zone));
            vergleiche.add(vergleichszeitraum(VORJAHRESMONAT, spanne[0].minusYears(1), MONAT, zone));
        } else if (JAHR.equals(art)) {
            vergleiche.add(vergleichszeitraum(VORJAHR, spanne[0].minusYears(1), JAHR, zone));
        }
        Instant bis = TagRegeln.beginn(spanne[1].plusDays(1), zone);
        String bezeichnung = DATENGRUNDLAGE.equals(art)
                ? KennzahlRegeln.periodeText(MONAT, java.time.YearMonth.from(spanne[0]).toString())
                        + (java.time.YearMonth.from(spanne[0]).equals(java.time.YearMonth.from(spanne[1])) ? ""
                                : " bis " + KennzahlRegeln.periodeText(MONAT,
                                        java.time.YearMonth.from(spanne[1]).toString()))
                : KennzahlRegeln.periodeText(art, schluessel);
        return new Zeitraum(art, schluessel, spanne[0], spanne[1], TagRegeln.beginn(spanne[0], zone), bis,
                TagRegeln.endgueltigAb(bis), bezeichnung, List.copyOf(vergleiche));
    }

    private static Vergleichszeitraum vergleichszeitraum(String art, LocalDate tag, String periodeArt, ZoneId zone) {
        String schluessel = BezugsPeriode.schluesselVon(tag, periodeArt);
        LocalDate[] spanne = BezugsPeriode.spanneVon(schluessel, periodeArt);
        return new Vergleichszeitraum(art, schluessel, spanne[0], spanne[1], TagRegeln.beginn(spanne[0], zone),
                TagRegeln.beginn(spanne[1].plusDays(1), zone));
    }

    /**
     * Q5 — warum ein Vergleichszeitraum keine Zahl hat: ganz vor dem Bestehen der Quelle, ganz nach ihrem Ende, oder sie
     * hat dort keine Werte; {@code null} = es gibt eine Zahl.
     */
    public static String vergleichGrund(LocalDate ersterTag, LocalDate letzterTag, LocalDate bestehtSeit, LocalDate beendetAm,
            boolean hatWerte) {
        if (bestehtSeit != null && letzterTag.isBefore(bestehtSeit)) {
            return VOR_BESTEHEN;
        }
        if (beendetAm != null && ersterTag.isAfter(beendetAm)) {
            return QUELLE_BEENDET;
        }
        return hatWerte ? null : KEINE_WERTE;
    }

    /**
     * @param prozent ungerundet auf {@link #PROZENT_RECHEN_NACHKOMMASTELLEN} Stellen; {@code null} ohne Vergleichswert
     *     oder bei Vergleichswert 0
     */
    public record Vergleich(BigDecimal differenz, BigDecimal prozent, String anzeigeDifferenz, String anzeigeProzent,
            String zustand, String grund) {}

    /** Q5, DA1 — ein Wert gegen seinen Vergleichszeitraum: Differenz, Prozent, beide angezeigt; ohne Vergleich der Grund. */
    public static Vergleich vergleich(BigDecimal aktuell, BigDecimal vergleichswert, String einheit, String ebene,
            String grund) {
        if (vergleichswert == null) {
            return new Vergleich(null, null, OHNE_ZAHL, OHNE_ZAHL, ErgebnisZustand.KEINE_WERTE, grund);
        }
        if (aktuell == null) {
            return new Vergleich(null, null, OHNE_ZAHL, OHNE_ZAHL, null, null);
        }
        BigDecimal differenz = aktuell.subtract(vergleichswert);
        BigDecimal prozent = vergleichswert.signum() == 0 ? null
                : differenz.multiply(HUNDERT).divide(vergleichswert, PROZENT_RECHEN_NACHKOMMASTELLEN, RoundingMode.HALF_UP);
        String anzeigeProzent = prozent == null ? OHNE_ZAHL
                : plus(prozent.setScale(PROZENT_NACHKOMMASTELLEN, RoundingMode.HALF_UP))
                        + ErgebnisZustand.zahlMitStellen(prozent, PROZENT_NACHKOMMASTELLEN, ErgebnisZustand.PROZENT);
        return new Vergleich(differenz, prozent, plus(differenz) + ErgebnisZustand.zahl(differenz, einheit, ebene),
                anzeigeProzent, null, null);
    }

    private static String plus(BigDecimal wert) {
        return wert.signum() > 0 ? "+" : "";
    }

    // ============================================================== Freigabe (F1)

    /** Ein Wert des Entwurfs, soweit die Freigabe ihn prüft. */
    public record FreigabeWert(String quelle, String name, String fassung, Instant endgueltigAb) {}

    /**
     * @param datenstandUebermittelt der Datenstand des Entwurfs, den die Person sah (F2)
     * @param datenstandEntwurf der Datenstand des gespeicherten Entwurfs
     * @param anlass Kennung des Anlasses der letzten Neubildung, sonst {@code null}
     * @param abweichungen wie viele Zahlen sich seit dem übermittelten Datenstand geändert haben (R1)
     */
    public record FreigabeAntrag(String zeitraumArt, String schluessel, ZoneId zone, Instant jetzt, List<FreigabeWert> werte,
            Instant datenstandUebermittelt, Instant datenstandEntwurf, int letzteNr, String anlass, int abweichungen) {}

    public record Freigabe(boolean erlaubt, Integer status, String code, Integer nr, Instant moeglichAb, Integer vorlaeufig,
            List<String> vorlaeufige, Instant datenstandUebermittelt, Instant datenstandAktuell, Instant datenstand,
            Instant freigegebenAm, String kundensatz) {}

    /**
     * F1 — die Voraussetzungen einer Freigabe in ihrer Reihenfolge: Zeitraum zu Ende, jeder Wert endgültig, der gesehene
     * Entwurf ist der gespeicherte. Die erste verletzte antwortet mit Code und Kundensatz; sonst ist es Berichtsstand
     * Nr. letzte + 1. Das Recht prüft die Route davor (G2: ein fremder Standort ist 404, nie ein anderer Befund).
     */
    public static Freigabe freigabe(FreigabeAntrag a) {
        Zeitraum z = zeitraum(a.zeitraumArt(), a.schluessel(), a.zone());
        if (a.jetzt().isBefore(z.bis())) {
            String satz = fuelle(SAETZE.get(ZEITRAUM_NICHT_ZU_ENDE), Map.of(
                    "zeitraum", fuelle(SAETZE.get("zeitraum_" + a.zeitraumArt()), Map.of("name", z.bezeichnung())),
                    "datum", datum(z.freigabeAb(), a.zone()),
                    "tage", String.valueOf(FREIGABE_FRIST.toDays()),
                    "ende", SAETZE.get("ende_" + a.zeitraumArt())));
            return new Freigabe(false, FEHLER_STATUS.get(ZEITRAUM_NICHT_ZU_ENDE), ZEITRAUM_NICHT_ZU_ENDE, null,
                    z.freigabeAb(), null, null, null, null, null, null, satz);
        }
        List<FreigabeWert> vorlaeufig = a.werte().stream().filter(w -> KennzahlRegeln.VORLAEUFIG.equals(w.fassung())).toList();
        if (!vorlaeufig.isEmpty()) {
            Instant ab = vorlaeufig.stream().map(FreigabeWert::endgueltigAb).filter(t -> t != null)
                    .max(Instant::compareTo).orElse(null);
            Set<String> quellen = new LinkedHashSet<>();
            Set<String> namen = new LinkedHashSet<>();
            for (FreigabeWert w : vorlaeufig) {
                quellen.add(w.quelle());
                namen.add(w.name() == null ? w.quelle() : w.quelle() + " " + w.name());
            }
            List<String> genannt = new ArrayList<>(namen.stream().limit(QUELLEN_IM_SATZ).toList());
            if (namen.size() > QUELLEN_IM_SATZ) {
                genannt.add(SAETZE.get("quellen_weitere"));
            }
            String werte = vorlaeufig.size() == 1 ? SAETZE.get("werte_einer")
                    : fuelle(SAETZE.get("werte_mehrere"), Map.of("anzahl", String.valueOf(vorlaeufig.size())));
            String satz = fuelle(SAETZE.get(WERTE_VORLAEUFIG), Map.of("werte", werte,
                    "datum", ab == null ? OHNE_ZAHL : datum(ab, a.zone()), "quellen", String.join(", ", genannt)));
            return new Freigabe(false, FEHLER_STATUS.get(WERTE_VORLAEUFIG), WERTE_VORLAEUFIG, null, ab, vorlaeufig.size(),
                    List.copyOf(quellen), null, null, null, null, satz);
        }
        if (!a.datenstandUebermittelt().equals(a.datenstandEntwurf())) {
            String pruefen = a.abweichungen() == 0 ? ""
                    : a.abweichungen() == 1 ? SAETZE.get("entwurf_veraltet_pruefen_eine")
                    : fuelle(SAETZE.get("entwurf_veraltet_pruefen"), Map.of("anzahl", String.valueOf(a.abweichungen())));
            String satz = fuelle(SAETZE.get(ENTWURF_VERALTET), Map.of(
                    "zeitpunkt", KorrekturVorschlagRegeln.zeitpunkt(a.datenstandUebermittelt(), a.zone()),
                    "anlass", a.anlass() == null ? "" : fuelle(SAETZE.get("entwurf_veraltet_anlass"), Map.of("anlass", anlass(a.anlass()))),
                    "pruefen", pruefen));
            return new Freigabe(false, FEHLER_STATUS.get(ENTWURF_VERALTET), ENTWURF_VERALTET, null, null, null, null,
                    a.datenstandUebermittelt(), a.datenstandEntwurf(), null, null, satz);
        }
        return new Freigabe(true, 201, null, a.letzteNr() + 1, null, null, null, null, null, a.datenstandEntwurf(), a.jetzt(),
                null);
    }

    // ============================================================== Datenstand (D2–D4)

    /** Eine Änderung einer Quelle mit ihrem Zeitstempel: eine Version, eine Fassung, ein rückwirkendes Protokoll. */
    public record Aenderung(String quelle, String art, Instant zeitpunkt) {}

    public static final String BERECHNET_AM = "berechnet_am";
    public static final String ENDGUELTIG_AB = "endgueltig_ab";
    public static final String FREIGABE_VOR_DATENSTAND = "freigabe_vor_datenstand";

    /**
     * D2 — jede einbezogene Berechnungszeit ≤ Datenstand; bei der Freigabe zusätzlich jedes „endgültig ab“ ≤ Datenstand.
     * Die Verstöße in ihrer Folge ({@link Aenderung#quelle()} leer); leer = gilt.
     */
    public static List<Aenderung> d2(Instant datenstand, List<Instant> berechnetAm, List<Instant> endgueltigAb,
            boolean beiFreigabe) {
        List<Aenderung> raus = new ArrayList<>();
        berechnetAm.stream().filter(t -> t.isAfter(datenstand)).forEach(t -> raus.add(new Aenderung(null, BERECHNET_AM, t)));
        if (beiFreigabe) {
            endgueltigAb.stream().filter(t -> t.isAfter(datenstand)).forEach(t -> raus.add(new Aenderung(null, ENDGUELTIG_AB, t)));
        }
        return raus;
    }

    /** D3 — Freigabe ≥ Datenstand und keine Änderung einer Quelle in (Datenstand, Freigabe]; leer = gilt. */
    public static List<Aenderung> d3(Instant datenstand, Instant freigabe, List<Aenderung> aenderungen) {
        List<Aenderung> raus = new ArrayList<>();
        if (freigabe.isBefore(datenstand)) {
            raus.add(new Aenderung(null, FREIGABE_VOR_DATENSTAND, freigabe));
        }
        aenderungen.stream().filter(x -> x.zeitpunkt().isAfter(datenstand) && !x.zeitpunkt().isAfter(freigabe)).forEach(raus::add);
        return raus;
    }

    /** D4 — die Änderungen, die neuer sind als der Datenstand; leer = der Entwurf ist aktuell. */
    public static List<Aenderung> d4(Instant datenstand, List<Aenderung> aenderungen) {
        return aenderungen.stream().filter(x -> x.zeitpunkt().isAfter(datenstand)).toList();
    }

    // ============================================================== Betroffenheit (B1, B4, B6)

    /**
     * Eine Zeile des Quellenverzeichnisses: eines Entwurfs ({@code nr} leer) oder eines Berichtsstands; {@code ersetzt} =
     * der Stand trägt „ersetzt durch“. Tage einschließlich.
     */
    public record Quelle(String bericht, Integer nr, boolean ersetzt, String objekt, String bezug, LocalDate ersterTag,
            LocalDate letzterTag) {}

    /**
     * B1, Pfad 1 — die Berichte, die eine Verarbeitung der Kaskade trifft: Objekte = die Messstellen ihrer Reihen (über
     * die Quellenbindung, die der Aufrufer liest) und {@link KorrekturKaskade.Betroffen#messstellen()}, seit AP-11 IP-9 die
     * Bezugsgrößen ({@link KorrekturKaskade.Betroffen#bezugsgroessen()}) und bei einer rückwirkend geänderten Berechnung
     * die Kennzahl selbst ({@code anlass}); Zeitraum = {@code ersterTag … letzterTag}. Je Bericht der gültige Stand
     * ({@link BerichteNaht.Stand#FREIGEGEBEN}, nie ein ersetzter) vor dem Entwurf.
     */
    public static List<BerichteNaht.Bericht> betroffene(List<Quelle> quellen, KorrekturKaskade.Betroffen betroffen,
            Function<KorrekturKaskade.Reihe, List<String>> bindung) {
        Set<String> objekte = new LinkedHashSet<>();
        betroffen.reihen().forEach(r -> objekte.addAll(bindung.apply(r)));
        objekte.addAll(betroffen.messstellen());
        betroffen.bezugsgroessen().forEach(g -> objekte.add(g.kennzeichen()));
        if (KorrekturKaskade.BERECHNUNG_GEAENDERT.equals(betroffen.status())) {
            objekte.add(betroffen.anlass());
        }
        return schnitt(quellen, objekte, betroffen.ersterTag(), betroffen.letzterTag());
    }

    /** B1, Pfad 2 — die Berichte, deren Quellen eine Strukturänderung ab {@code giltAb} trifft (B6: danach keine). */
    public static List<BerichteNaht.Bericht> betroffene(List<Quelle> quellen, Collection<String> objekte, LocalDate giltAb) {
        return schnitt(quellen, new LinkedHashSet<>(objekte), giltAb, null);
    }

    private static List<BerichteNaht.Bericht> schnitt(List<Quelle> quellen, Set<String> objekte, LocalDate von, LocalDate bis) {
        Map<String, Set<BerichteNaht.Stand>> treffer = new TreeMap<>();
        for (Quelle q : quellen) {
            boolean imZeitraum = !q.letzterTag().isBefore(von) && (bis == null || !q.ersterTag().isAfter(bis));
            if (!objekte.contains(q.objekt()) || !imZeitraum || (q.nr() != null && q.ersetzt())) {
                continue;
            }
            treffer.computeIfAbsent(q.bericht(), k -> new LinkedHashSet<>())
                    .add(q.nr() == null ? BerichteNaht.Stand.ENTWURF : BerichteNaht.Stand.FREIGEGEBEN);
        }
        List<BerichteNaht.Bericht> raus = new ArrayList<>();
        treffer.forEach((kennung, staende) -> {
            for (BerichteNaht.Stand s : List.of(BerichteNaht.Stand.FREIGEGEBEN, BerichteNaht.Stand.ENTWURF)) {
                if (staende.contains(s)) {
                    raus.add(new BerichteNaht.Bericht(kennung, s));
                }
            }
        });
        return raus;
    }

    /**
     * B4, Pfad 1 — die Anstoß-Art einer Verarbeitung der Kaskade (Korrektur K-…, Ersatzwert EW-…); seit AP-11 IP-9 eine
     * rückwirkend geänderte Berechnung ({@code kennzahl_fassung_rueckwirkend}) und jede geänderte Bezugsgröße — Fassung
     * ≥ 2, Rücknahme oder rückwirkendes Stammdatum ({@code bezugsgroesse_fassung}).
     */
    public static String anstossArt(KorrekturKaskade.Betroffen b) {
        if (KorrekturKaskade.BERECHNUNG_GEAENDERT.equals(b.status())) {
            return KENNZAHL_FASSUNG_RUECKWIRKEND;
        }
        if (!b.bezugsgroessen().isEmpty()) {
            return BEZUGSGROESSE_FASSUNG;
        }
        boolean korrektur = b.anlass().startsWith("K-");
        boolean ersatzwert = b.anlass().startsWith("EW-");
        if (korrektur && KorrekturKaskade.FREIGEGEBEN.equals(b.status())) {
            return KORREKTUR_FREIGEGEBEN;
        }
        if (korrektur && KorrekturKaskade.ZURUECKGENOMMEN.equals(b.status())) {
            return KORREKTUR_ZURUECKGENOMMEN;
        }
        if (ersatzwert && KorrekturKaskade.WIRKSAM.equals(b.status())) {
            return ERSATZWERT_WIRKSAM;
        }
        if (ersatzwert && KorrekturKaskade.ZURUECKGENOMMEN.equals(b.status())) {
            return ERSATZWERT_ZURUECKGENOMMEN;
        }
        throw new IllegalArgumentException("Anlass " + b.anlass() + " mit Status " + b.status() + " hat keine Anstoß-Art");
    }

    /** Das Urteil über eine Zeile eines Änderungsprotokolls: eine Anstoß-Art ODER ein Grund, warum keiner. */
    public record Struktur(String anstossArt, String grund) {}

    /**
     * B3/B4/B6, Pfad 2 — was eine Zeile von {@code ort_aenderung} oder {@code messstelle_aenderung} für Berichte ist:
     * rückwirkend verschoben/korrigiert (Anlage: Umzug), rückwirkende Fläche, rückwirkende Ortszuordnung einer Messstelle,
     * berichtigte Verteilung ({@code korrektur}); eine Umbenennung ({@code bearbeitet}) nie; alles andere keine
     * Strukturänderung. Ob die Zeile eine Quelle im Zeitraum trifft, entscheidet {@link #betroffene(List, Collection, LocalDate)}.
     */
    public static Struktur struktur(String protokoll, String objektArt, String art, boolean rueckwirkend, boolean korrektur) {
        if (!STRUKTUR_PROTOKOLLE.contains(protokoll)) {
            throw new IllegalArgumentException("Protokoll " + protokoll + " ist kein Strukturänderungs-Protokoll");
        }
        if (ENERGIEEINSATZ_AENDERUNG.equals(protokoll)) {
            return switch (art) {
                case "einstufung_gesetzt", "einstufung_bestaetigt" -> new Struktur(EINSTUFUNG_FASSUNG, null);
                default -> new Struktur(null, KEINE_STRUKTURAENDERUNG);
            };
        }
        if (BEWERTUNG_AENDERUNG.equals(protokoll)) {
            return switch (art) {
                case "umfang_geaendert" -> new Struktur(UMFANG_FASSUNG, null);
                case "kriterien_geaendert", "kriterien_freigegeben" -> new Struktur(KRITERIEN_FASSUNG, null);
                default -> new Struktur(null, KEINE_STRUKTURAENDERUNG);
            };
        }
        if (MESSBEDARF_AENDERUNG.equals(protokoll)) {
            return List.of("erfasst", "bearbeitet", "eingeloest", "verworfen").contains(art)
                    ? new Struktur(MESSBEDARF_ZUSTAND, null)
                    : new Struktur(null, KEINE_STRUKTURAENDERUNG);
        }
        if (GERAET_AENDERUNG.equals(protokoll)) {
            return "messmittel_angabe".equals(art) ? new Struktur(MESSMITTEL_ANGABE, null)
                    : new Struktur(null, KEINE_STRUKTURAENDERUNG);
        }
        if (MESSSTELLE_AENDERUNG.equals(protokoll) && "prozesse_zugeordnet".equals(art)) {
            return rueckwirkend ? new Struktur(PROZESS_ZUORDNUNG_RUECKWIRKEND, null)
                    : new Struktur(null, NICHT_RUECKWIRKEND);
        }
        if ("bearbeitet".equals(art)) {
            return new Struktur(null, UMBENENNUNG);
        }
        String anstoss;
        boolean wirkt = rueckwirkend;
        if (ORT_AENDERUNG.equals(protokoll) && ("verschoben".equals(art) || "korrigiert".equals(art))) {
            anstoss = "anlage".equals(objektArt) ? ANLAGE_UMZUG_RUECKWIRKEND : ZUORDNUNG_RUECKWIRKEND;
        } else if (ORT_AENDERUNG.equals(protokoll) && "flaeche_geaendert".equals(art)) {
            anstoss = FLAECHE_RUECKWIRKEND;
        } else if (MESSSTELLE_AENDERUNG.equals(protokoll) && ("ort_zugeordnet".equals(art)
                || "ort_korrigiert".equals(art) || "zaehler_gewechselt".equals(art))) {
            anstoss = ZUORDNUNG_RUECKWIRKEND;
        } else if (MESSSTELLE_AENDERUNG.equals(protokoll) && "verteilung_geaendert".equals(art)) {
            anstoss = VERTEILUNG_RUECKWIRKEND;
            wirkt = korrektur;
        } else {
            return new Struktur(null, KEINE_STRUKTURAENDERUNG);
        }
        return wirkt ? new Struktur(anstoss, null) : new Struktur(null, NICHT_RUECKWIRKEND);
    }

    // ============================================================== Abweichung (R1)

    /** Eine Zahl, die sich zwischen zwei Abzügen unterscheidet; fehlt sie auf einer Seite, ist die Seite leer. */
    public record Abweichung(String quelle, String mengeArt, BigDecimal vorher, BigDecimal nachher, String version,
            String anlass) {}

    /**
     * R1 — der Vergleich zweier Abzüge (Entwurf gegen Stand, Stand gegen Stand): je Menge ({@code werte}, Schlüssel Quelle
     * + Mengen-Art) und je Kennzahl jede andere Zahl oder Version. Der Anlass sind die Korrekturen, die der neue Abzug
     * zusätzlich nennt — an ihrer Reihe unmittelbar, an einer berechneten Messstelle „über die Formel“, an einer Kennzahl
     * „über die Kennzahl“.
     */
    public static List<Abweichung> abweichungen(JsonNode alt, JsonNode neu) {
        Set<String> alteKorrekturen = new LinkedHashSet<>();
        alt.path("qualitaet").path("korrekturen").forEach(k -> alteKorrekturen.add(k.path("kennung").asText()));
        List<String> kennungen = new ArrayList<>();
        Set<String> reihen = new LinkedHashSet<>();
        neu.path("qualitaet").path("korrekturen").forEach(k -> {
            if (!alteKorrekturen.contains(k.path("kennung").asText())) {
                kennungen.add(k.path("kennung").asText());
                reihen.add(k.path("reihe").asText());
            }
        });
        String anlass = kennungen.isEmpty() ? null : String.join(", ", kennungen);
        List<Abweichung> raus = new ArrayList<>();
        vergleiche(alt.path("werte"), neu.path("werte"), "menge", anlass, reihen, raus);
        vergleiche(alt.path("kennzahlen"), neu.path("kennzahlen"), "wert", anlass, reihen, raus);
        return raus;
    }

    private static void vergleiche(JsonNode alt, JsonNode neu, String feld, String anlass, Set<String> reihen,
            List<Abweichung> raus) {
        Map<List<String>, JsonNode> alte = nachSchluessel(alt);
        Map<List<String>, JsonNode> neue = nachSchluessel(neu);
        neue.forEach((k, n) -> zeile(k, alte.get(k), n, feld, anlass, reihen, raus));
        alte.forEach((k, a) -> {
            if (!neue.containsKey(k)) {
                zeile(k, a, null, feld, anlass, reihen, raus);
            }
        });
    }

    private static Map<List<String>, JsonNode> nachSchluessel(JsonNode liste) {
        Map<List<String>, JsonNode> raus = new LinkedHashMap<>();
        liste.forEach(w -> raus.put(java.util.Arrays.asList(w.path("quelle").asText(),
                w.hasNonNull("menge_art") ? w.path("menge_art").asText() : null), w));
        return raus;
    }

    private static void zeile(List<String> k, JsonNode a, JsonNode n, String feld, String anlass, Set<String> reihen,
            List<Abweichung> raus) {
        BigDecimal vorher = a == null ? null : betrag(a.path(feld));
        BigDecimal nachher = n == null ? null : betrag(n.path(feld));
        if (a != null && n != null && gleich(vorher, nachher) && a.path("version").asInt() == n.path("version").asInt()) {
            return;
        }
        JsonNode w = n != null ? n : a;
        String grund = anlass == null ? null
                : "wert".equals(feld) ? fuelle(SAETZE.get("ueber_kennzahl"), Map.of("anlass", anlass))
                : reihen.contains(k.get(0)) ? anlass
                : w.has("formel") ? fuelle(SAETZE.get("ueber_formel"), Map.of("anlass", anlass)) : anlass;
        String version = (a == null ? OHNE_ZAHL : a.path("version").asText()) + " → "
                + (n == null ? OHNE_ZAHL : n.path("version").asText());
        raus.add(new Abweichung(k.get(0), k.get(1), vorher, nachher, version, grund));
    }

    private static BigDecimal betrag(JsonNode n) {
        return n == null || n.isMissingNode() || n.isNull() ? null : n.decimalValue();
    }

    private static boolean gleich(BigDecimal a, BigDecimal b) {
        return a == null ? b == null : b != null && a.compareTo(b) == 0;
    }

    // ============================================================== Rechte (G1, G3)

    /** G1 — die Kennung der Rechte-Matrix für eine Handlung an einem Bericht dieser Geltung. */
    public static String kennung(String handlung, String geltungArt) {
        String k = KENNUNG.get(geltungArt + "/" + handlung);
        if (k == null) {
            throw new IllegalArgumentException("Handlung " + handlung + " an " + geltungArt + " hat keine Kennung");
        }
        return k;
    }

    /**
     * G3 (R-A4) — die Teilansicht einer Person: wer das Unternehmen nicht exportieren darf, sieht die Standorte, deren
     * Messwerte er ansehen darf, in der Folge des Kundenbereichs; {@code null} = keine Teilansicht. Beide Urteile spricht
     * {@link RechteAbleitung#darf}. Eine wirksame UNTERNEHMENSWEITE Zuweisung ist nie eine Teilansicht (AP-03 E10): bis
     * AP-19 IP-12 durfte jede solche Rolle auch exportieren, die Rolle Einsicht sieht alles und exportiert nicht (RE3).
     */
    public static List<String> teilansicht(RechteAbleitung.Matrix m, RechteAbleitung.Benutzer b,
            RechteAbleitung.Kundenbereich k, Instant jetzt) {
        if (RechteAbleitung.darf(m, b, k, kennung("csv", UNTERNEHMEN), RechteAbleitung.Ziel.unternehmen(), jetzt).darf()
                || b.zuweisungen().stream().anyMatch(z -> z.unternehmensweit() && z.wirksam(jetzt))) {
            return null;
        }
        return k.standorte().stream()
                .filter(s -> RechteAbleitung.darf(m, b, k, TEILANSICHT_RECHT, RechteAbleitung.Ziel.standort(s.kennzeichen()),
                        jetzt).darf())
                .map(RechteAbleitung.Standort::name).toList();
    }

    // ============================================================== Abzug: kanonische Form und Prüfsumme (A1, A6)

    /**
     * A1 — der kanonische Text eines Abzugs: Schlüssel nach UTF-16-Codeeinheiten sortiert, kein Leerraum, Zeichenketten
     * wie {@code JSON.stringify} (Anführungszeichen, Rückstrich und die fünf kurzen Escapes, andere Steuerzeichen als
     * Unicode-Escape mit vier kleinen Hex-Ziffern), Zahlen ohne
     * Exponent und ohne nachgestellte Nullen. Byte-gleich zum TS-Zwilling.
     */
    public static String kanonisch(JsonNode n) {
        StringBuilder sb = new StringBuilder();
        schreibe(n, sb);
        return sb.toString();
    }

    private static void schreibe(JsonNode n, StringBuilder sb) {
        if (n == null || n.isNull() || n.isMissingNode()) {
            sb.append("null");
        } else if (n.isObject()) {
            List<String> namen = new ArrayList<>();
            n.fieldNames().forEachRemaining(namen::add);
            Collections.sort(namen);
            sb.append('{');
            for (int i = 0; i < namen.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                zeichenkette(namen.get(i), sb);
                sb.append(':');
                schreibe(n.get(namen.get(i)), sb);
            }
            sb.append('}');
        } else if (n.isArray()) {
            sb.append('[');
            for (int i = 0; i < n.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                schreibe(n.get(i), sb);
            }
            sb.append(']');
        } else if (n.isBoolean()) {
            sb.append(n.booleanValue());
        } else if (n.isIntegralNumber()) {
            sb.append(n.bigIntegerValue());
        } else if (n.isNumber()) {
            BigDecimal d = n.decimalValue();
            sb.append(d.signum() == 0 ? "0" : d.stripTrailingZeros().toPlainString());
        } else {
            zeichenkette(n.asText(), sb);
        }
    }

    private static void zeichenkette(String s, StringBuilder sb) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
    }

    /** A6 — {@code sha256:} + SHA-256 (klein, hex) über die UTF-8-Bytes des kanonischen Texts. */
    public static String pruefsumme(String kanonischerText) {
        try {
            return PRUEFSUMME_PRAEFIX + HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(kanonischerText.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 fehlt in dieser JVM", e);
        }
    }

    // ============================================================== Berichts-CSV (DA3)

    public record CsvKopf(String bericht, String vorlage, int vorlageFassung, String geltungArt, String geltungKennzeichen,
            String geltungName, String zeitraumArt, String schluessel, ZoneId zone, int stand, Instant datenstand,
            Instant freigegebenAm, String freigegebenVon, String pruefsumme, Instant erzeugtAm, String erzeugtVon,
            List<String> teilansicht) {}

    /** DA3 — der Kopfblock: eine Zeile {@code # schlüssel=wert} je {@link #CSV_KOPF}, Zeiten in der Zone mit Offset. */
    public static List<String> csvKopf(CsvKopf k) {
        Zeitraum z = zeitraum(k.zeitraumArt(), k.schluessel(), k.zone());
        List<String> werte = List.of(k.bericht(), k.vorlage() + " " + k.vorlageFassung(),
                fuelle(SAETZE.get("csv_geltung_" + k.geltungArt()), Map.of("kennzeichen", k.geltungKennzeichen(), "name", k.geltungName())),
                fuelle(SAETZE.get("csv_zeitraum"), Map.of("schluessel", k.schluessel(),
                        "erster", OrtsbaumAbleitung.datumText(z.ersterTag()), "letzter", OrtsbaumAbleitung.datumText(z.letzterTag()))),
                String.valueOf(k.stand()), BezugsPeriode.iso(k.datenstand(), k.zone()), BezugsPeriode.iso(k.freigegebenAm(), k.zone()),
                k.freigegebenVon(), k.zone().getId(), CSV_DEZIMAL, CSV_TRENNER, "ungerundet", k.pruefsumme(),
                BezugsPeriode.iso(k.erzeugtAm(), k.zone()), k.erzeugtVon(),
                k.teilansicht() == null ? "" : String.join(", ", k.teilansicht()));
        List<String> raus = new ArrayList<>();
        for (int i = 0; i < CSV_KOPF.size(); i++) {
            raus.add("# " + CSV_KOPF.get(i) + "=" + werte.get(i));
        }
        return raus;
    }

    public record CsvZeile(String quelle, String name, String ort, String periode, BigDecimal menge, String einheit,
            String zustand, BigDecimal abdeckungProzent, List<String> kennzeichen, String fassung, Instant endgueltigAb,
            Integer version, Instant berechnetAm) {}

    /**
     * DA3 — eine Zeile je Wert mit den 13 Spalten: Zahlen ungerundet mit Dezimalkomma, Zeiten in der Zone mit Offset,
     * Kennzeichen mit „ · “; eine Zelle mit {@code ;}, {@code "} oder Zeilenumbruch steht in Anführungszeichen.
     */
    public static String csvZeile(CsvZeile z, ZoneId zone) {
        List<String> zellen = java.util.Arrays.asList(z.quelle(), z.name(), z.ort(), z.periode(), csvZahl(z.menge()),
                z.einheit(), z.zustand(), csvZahl(z.abdeckungProzent()), String.join(KENNZEICHEN_TRENNER, z.kennzeichen()),
                z.fassung(), z.endgueltigAb() == null ? null : BezugsPeriode.iso(z.endgueltigAb(), zone),
                z.version() == null ? null : String.valueOf(z.version()),
                z.berechnetAm() == null ? null : BezugsPeriode.iso(z.berechnetAm(), zone));
        List<String> raus = new ArrayList<>();
        zellen.forEach(c -> raus.add(csvZelle(c)));
        return String.join(CSV_TRENNER, raus);
    }

    private static String csvZahl(BigDecimal d) {
        return d == null ? null : d.toPlainString().replace(".", CSV_DEZIMAL);
    }

    private static String csvZelle(String s) {
        if (s == null) {
            return "";
        }
        if (s.contains(";") || s.contains("\"") || s.contains("\n") || s.contains("\r")) {
            return "\"" + s.replace("\"", "\"\"") + "\"";
        }
        return s;
    }

    // ============================================================== Kopf, Kennzeichen, Anlass (D5, R5, A5, G3)

    /** D5 — „Datenstand 10.11.2026 08:55 (MEZ) · Berichtsstand Nr. 1 · freigegeben 10.11.2026 09:02 von …“; ohne Stand der Entwurf. */
    public static String kopf(Instant datenstand, ZoneId zone, Integer nr, Instant freigegebenAm, String freigegebenVon) {
        String ds = ErgebnisZustand.uhr(datenstand, zone).contains(" ") ? KorrekturVorschlagRegeln.zeitpunkt(datenstand, zone)
                : fuelle(SAETZE.get("zeit_mit_zone"), Map.of("zeitpunkt", KorrekturVorschlagRegeln.zeitpunkt(datenstand, zone),
                        "zone", ErgebnisZustand.zoneKurz(datenstand, zone)));
        if (nr == null) {
            return fuelle(SAETZE.get("kopf_entwurf"), Map.of("datenstand", ds));
        }
        return fuelle(SAETZE.get("kopf_stand"), Map.of("datenstand", ds, "nr", String.valueOf(nr),
                "freigegeben", KorrekturVorschlagRegeln.zeitpunkt(freigegebenAm, zone), "person", freigegebenVon));
    }

    public static String berichtsstand(int nr) {
        return fuelle(muster("berichtsstand"), Map.of("nr", String.valueOf(nr)));
    }

    public static String ersetztDurch(int nr, Instant am, ZoneId zone) {
        return fuelle(muster("ersetzt_durch"), Map.of("nr", String.valueOf(nr), "datum", datum(am, zone)));
    }

    public static String revisionNoetig(String anlass) {
        return fuelle(muster("revision_noetig"), Map.of("anlass", anlass));
    }

    public static String entwurf(Instant datenstand, ZoneId zone) {
        return fuelle(muster("entwurf"), Map.of("datum", datum(datenstand, zone), "uhr", ErgebnisZustand.uhr(datenstand, zone)));
    }

    public static String vorlaeufig(Instant endgueltigAb, ZoneId zone) {
        return fuelle(muster("vorlaeufig"), Map.of("datum", datum(endgueltigAb, zone)));
    }

    /** A5 — der Hinweis „heute: …“, nur wenn der Name sich seit dem Datenstand geändert hat. */
    public static String heute(String nameZumDatenstand, String nameHeute) {
        return nameHeute.equals(nameZumDatenstand) ? null : fuelle(muster("heute"), Map.of("name", nameHeute));
    }

    /** G3 — „Teilansicht: …“; ohne Standorte keine. */
    public static String teilansichtKennzeichen(List<String> standorte) {
        return standorte == null || standorte.isEmpty() ? null
                : fuelle(muster("teilansicht"), Map.of("standorte", String.join(", ", standorte)));
    }

    public static String vorBeginn(LocalDate seit) {
        return fuelle(muster("vor_beginn"), Map.of("datum", OrtsbaumAbleitung.datumText(seit)));
    }

    public static String anstossVerworfen(String begruendung) {
        return fuelle(muster("anstoss_verworfen"), Map.of("begruendung", begruendung));
    }

    /**
     * Der Anlass in Kundensprache: „Korrektur K-2026-0007“, „Ersatzwert EW-2026-0001“, die Kennung einer Strukturänderung
     * ({@link #strukturKennung}) als „Verteilung MS-07 berichtigt, gilt ab 01.10.2026, eingetragen 20.11.2026“ — ohne
     * Kennzeichen entfällt es —, sonst der Text selbst.
     */
    /** A5 (AP-17 IP-23): {@code BB-…/Fassung-n}, {@code BB-…/Fassung-n/anstoss:<id>}, {@code BB-…/beendet}. */
    private static final Pattern BASIS_KENNUNG =
            Pattern.compile("^(BB-\\d{4,})/(Fassung-(\\d+)(/anstoss:[0-9a-f-]+)?|beendet)$");

    public static String anlass(String kennung) {
        if (kennung.startsWith("K-")) {
            return fuelle(SAETZE.get("anlass_korrektur"), Map.of("kennung", kennung));
        }
        if (kennung.startsWith("EW-")) {
            return fuelle(SAETZE.get("anlass_ersatzwert"), Map.of("kennung", kennung));
        }
        Matcher s = STRUKTUR_KENNUNG.matcher(kennung);
        if (s.matches()) {
            String satz = SAETZE.get("anlass_" + s.group(1));
            String ab = OrtsbaumAbleitung.datumText(LocalDate.parse(s.group(3)));
            String am = OrtsbaumAbleitung.datumText(LocalDate.parse(s.group(4)));
            return s.group(2) == null ? fuelle(satz.replace(" {objekt}", ""), Map.of("ab", ab, "am", am))
                    : fuelle(satz, Map.of("objekt", s.group(2), "ab", ab, "am", am));
        }
        Matcher bb = BASIS_KENNUNG.matcher(kennung);
        if (bb.matches()) {
            if ("beendet".equals(bb.group(2))) {
                return fuelle(SAETZE.get("anlass_bezugsbasis_beendet"), Map.of("basis", bb.group(1)));
            }
            return fuelle(SAETZE.get(bb.group(4) == null ? "anlass_bezugsbasis_fassung" : "anlass_bezugsbasis_anstoss"),
                    Map.of("basis", bb.group(1), "fassung", bb.group(3)));
        }
        Matcher b = BEWERTUNG_KENNUNG.matcher(kennung);
        if (b.matches()) {
            String satz = SAETZE.get("anlass_" + b.group(1));
            return b.group(2) == null ? satz.replace(" {objekt}", "")
                    : fuelle(satz, Map.of("objekt", b.group(2)));
        }
        return kennung;
    }

    /** Ein Kennzeichen, das in einer Ereignis-Kennung stehen darf — sonst entfällt es in der Strukturänderungs-Kennung. */
    private static final Pattern KENNZEICHEN_IN_KENNUNG = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]*$");

    private static final Pattern STRUKTUR_KENNUNG = Pattern.compile("^(" + ZUORDNUNG_RUECKWIRKEND + "|"
            + ANLAGE_UMZUG_RUECKWIRKEND + "|" + FLAECHE_RUECKWIRKEND + "|" + VERTEILUNG_RUECKWIRKEND
            + ")/([A-Za-z0-9][A-Za-z0-9._-]*)?/([0-9]{4}-[0-9]{2}-[0-9]{2})/([0-9]{4}-[0-9]{2}-[0-9]{2})/(" + ORT_AENDERUNG
            + "|" + MESSSTELLE_AENDERUNG + ")-([0-9]+)$");
    private static final Pattern BEWERTUNG_KENNUNG = Pattern.compile("^(" + EINSTUFUNG_FASSUNG + "|"
            + KRITERIEN_FASSUNG + "|" + UMFANG_FASSUNG + "|" + MESSBEDARF_ZUSTAND + "|"
            + PROZESS_ZUORDNUNG_RUECKWIRKEND + "|" + MESSMITTEL_ANGABE
            + ")/([A-Za-z0-9][A-Za-z0-9._-]*)?/((?:energieeinsatz|bewertung|messbedarf|messstelle|geraet)_aenderung)-([0-9]+)$");

    /**
     * B3, Pfad 2 — die Anlass-Kennung einer Strukturänderung: {@code <Anstoß-Art>/<Kennzeichen>/<gilt ab>/<eingetragen>/
     * <Protokoll>-<Zeile>}, z. B. {@code verteilung_rueckwirkend/MS-07/2026-10-01/2026-11-20/messstelle_aenderung-4711}.
     * Die Protokollzeile macht sie eindeutig (zwei Berichtigungen am selben Tag sind zwei Anstöße, B7), die übrigen Teile
     * lesbar ({@link #anlass}); sie ist eine Ereignis-Kennung ({@code events-raw} {@code $defs/kennung}) — ein Kennzeichen
     * mit anderen Zeichen (Leerzeichen, Schrägstrich) entfällt darum, der Satz sagt es ohne.
     */
    public static String strukturKennung(String anstossArt, String kennzeichen, LocalDate giltAb, LocalDate eingetragen,
            String protokoll, long zeile) {
        if (!List.of(ZUORDNUNG_RUECKWIRKEND, ANLAGE_UMZUG_RUECKWIRKEND, FLAECHE_RUECKWIRKEND, VERTEILUNG_RUECKWIRKEND)
                .contains(anstossArt) || !List.of(ORT_AENDERUNG, MESSSTELLE_AENDERUNG).contains(protokoll)) {
            throw new IllegalArgumentException(anstossArt + " aus " + protokoll + " ist keine Strukturänderung");
        }
        String objekt = kennzeichen != null && KENNZEICHEN_IN_KENNUNG.matcher(kennzeichen).matches() ? kennzeichen : "";
        return anstossArt + "/" + objekt + "/" + giltAb + "/" + eingetragen + "/" + protokoll + "-" + zeile;
    }

    /** AP-16 S3: eindeutige, lesbare Kennung einer bewertungsbezogenen Protokollzeile. */
    public static String bewertungKennung(String anstossArt, String kennzeichen, String protokoll, long zeile) {
        if (!List.of(EINSTUFUNG_FASSUNG, KRITERIEN_FASSUNG, UMFANG_FASSUNG, MESSBEDARF_ZUSTAND,
                PROZESS_ZUORDNUNG_RUECKWIRKEND, MESSMITTEL_ANGABE).contains(anstossArt)
                || !(BEWERTUNGS_PROTOKOLLE.contains(protokoll) || MESSSTELLE_AENDERUNG.equals(protokoll))) {
            throw new IllegalArgumentException(anstossArt + " aus " + protokoll + " ist kein Bewertungs-Anstoß");
        }
        String objekt = kennzeichen != null && KENNZEICHEN_IN_KENNUNG.matcher(kennzeichen).matches() ? kennzeichen : "";
        return anstossArt + "/" + objekt + "/" + protokoll + "-" + zeile;
    }

    // ============================================================== Sätze (§5.8) und Anzeige (DA1)

    public static String keineQuellen(String geltung, String zeitraumArt, String schluessel, LocalDate bestehtSeit) {
        String zeitraum = fuelle(SAETZE.get("im_" + zeitraumArt), Map.of("name", KennzahlRegeln.periodeText(zeitraumArt, schluessel)));
        return bestehtSeit == null ? fuelle(SAETZE.get(KEINE_QUELLEN), Map.of("geltung", geltung, "zeitraum", zeitraum))
                : fuelle(SAETZE.get("keine_quellen_seit"), Map.of("geltung", geltung, "zeitraum", zeitraum,
                        "datum", OrtsbaumAbleitung.datumText(bestehtSeit)));
    }

    public static String berichtGibtEsSchon(String kennung, String geltung, String zeitraumArt, String schluessel) {
        return fuelle(SAETZE.get(BERICHT_GIBT_ES_SCHON), Map.of("kennung", kennung, "vorlage", SAETZE.get("vorlage_" + zeitraumArt),
                "geltung", geltung, "zeitraum", KennzahlRegeln.periodeText(zeitraumArt, schluessel)));
    }

    public static String standGibtEsNicht(int nr, Integer neuesteNr, Instant neuesteAm, ZoneId zone) {
        return neuesteNr == null ? fuelle(SAETZE.get("stand_gibt_es_nicht_keiner"), Map.of("nr", String.valueOf(nr)))
                : fuelle(SAETZE.get(STAND_GIBT_ES_NICHT), Map.of("nr", String.valueOf(nr), "neueste", String.valueOf(neuesteNr),
                        "datum", datum(neuesteAm, zone)));
    }

    public static String wertNichtMehrGespeichert(String zeitraumArt, String schluessel, Integer standNr, Instant standAm,
            ZoneId zone) {
        String zeitraum = fuelle(SAETZE.get("vom_" + zeitraumArt), Map.of("name", KennzahlRegeln.periodeText(zeitraumArt, schluessel)));
        return standNr == null ? fuelle(SAETZE.get("wert_nicht_mehr_gespeichert_ohne_stand"), Map.of("zeitraum", zeitraum))
                : fuelle(SAETZE.get(WERT_NICHT_MEHR_GESPEICHERT), Map.of("zeitraum", zeitraum, "nr", String.valueOf(standNr),
                        "datum", datum(standAm, zone)));
    }

    /** Ein freigegebener Berichtsstand in einer Liste: „BR-2026-0001 Nr. 1“. */
    public record StandBezeichnung(String kennung, int nr) {}

    /** Die Stände einer Liste, wie die Kundensätze sie nennen: „BR-2026-0001 Nr. 1, BR-2026-0001 Nr. 2“. */
    public static String standBezeichnungen(List<StandBezeichnung> staende) {
        return String.join(", ", staende.stream()
                .map(s -> fuelle(SAETZE.get("stand_bezeichnung"), Map.of("kennung", s.kennung(), "nr", String.valueOf(s.nr())))).toList());
    }

    public static String berichtsBelege(List<StandBezeichnung> staende) {
        String liste = standBezeichnungen(staende);
        return staende.size() == 1 ? fuelle(SAETZE.get("berichts_belege_eins"), Map.of("staende", liste))
                : fuelle(SAETZE.get(BERICHTS_BELEGE), Map.of("anzahl", String.valueOf(staende.size()), "staende", liste));
    }

    public static String abzugBeschaedigt(int nr) {
        return fuelle(SAETZE.get(ABZUG_BESCHAEDIGT), Map.of("nr", String.valueOf(nr)));
    }

    public static final String ANZEIGE_MENGE = "menge";
    public static final String ANZEIGE_KENNZAHL = "kennzahl";
    public static final String ANZEIGE_PROZENT = "prozent";

    /**
     * DA1 — eine Zahl des Abzugs angezeigt: eine Menge mit den Stellen ihrer Ebene ({@link ErgebnisZustand#zahl}), eine
     * Kennzahl wie AP-11 ({@link KennzahlRegeln#anzeige}), der Prozentwert eines Vergleichs mit einer Nachkommastelle.
     */
    public static String anzeige(String art, BigDecimal wert, String einheit, String ebene) {
        return switch (art) {
            case ANZEIGE_MENGE -> ErgebnisZustand.zahl(wert, einheit, ebene);
            case ANZEIGE_KENNZAHL -> KennzahlRegeln.anzeige(wert, einheit, null);
            case ANZEIGE_PROZENT -> ErgebnisZustand.zahlMitStellen(wert, PROZENT_NACHKOMMASTELLEN, ErgebnisZustand.PROZENT);
            default -> throw new IllegalArgumentException("Anzeige-Art " + art);
        };
    }

    // ============================================================== Helfer

    private static String datum(Instant t, ZoneId zone) {
        return OrtsbaumAbleitung.datumText(TagRegeln.tag(t, zone));
    }

    private static String muster(String schluessel) {
        return KENNZEICHEN.stream().filter(k -> k.schluessel().equals(schluessel)).findFirst().orElseThrow().muster();
    }

    private static String fuelle(String vorlage, Map<String, String> werte) {
        String raus = vorlage;
        for (Map.Entry<String, String> e : werte.entrySet()) {
            raus = raus.replace("{" + e.getKey() + "}", e.getValue());
        }
        return raus;
    }

    private static Map<String, String> kennungen() {
        Map<String, String> raus = new LinkedHashMap<>();
        for (String geltung : GELTUNG_ARTEN) {
            for (String h : HANDLUNGEN) {
                boolean standort = STANDORT.equals(geltung);
                boolean lesen = "abrufen".equals(h) || "pdf".equals(h);
                // AP-19 IP-11 (RE4, W10): am Unternehmen trägt das Lesen seine eigene Kennung, wie am Standort.
                String k = "csv".equals(h) ? (standort ? "export.standort" : "export.unternehmen")
                        : standort ? (lesen ? "bericht.standort_abrufen" : "bericht.standort_freigeben")
                        : lesen ? "bericht.unternehmen_abrufen" : "bericht.unternehmen";
                raus.put(geltung + "/" + h, k);
            }
        }
        return Collections.unmodifiableMap(raus);
    }

    private static Map<String, Vorlage> vorlagen(Vorlage... vorlagen) {
        Map<String, Vorlage> raus = new LinkedHashMap<>();
        for (Vorlage v : vorlagen) {
            raus.put(v.schluessel(), v);
        }
        return Collections.unmodifiableMap(raus);
    }

    @SuppressWarnings("unchecked")
    private static <V> Map<String, V> geordnet(Object... paare) {
        Map<String, V> raus = new LinkedHashMap<>();
        for (int i = 0; i < paare.length; i += 2) {
            raus.put((String) paare[i], (V) paare[i + 1]);
        }
        return Collections.unmodifiableMap(raus);
    }
}
