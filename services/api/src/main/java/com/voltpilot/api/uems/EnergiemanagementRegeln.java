package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * AP-19 NW-1: Energiemanagement — reine Regeln ({@code docs/contracts/v2/energiemanagement.md}). Keine Fläche ruft sie
 * bisher auf. Zwillinge: {@code frontend/portal/src/energiemanagement.ts} und {@code voltpilot_optimization/energiemanagement.py};
 * alle drei fahren {@code energiemanagement-vectors.json}. Die kanonische Form einer Kopie ist {@link BerichtRegeln#kanonisch}
 * (A1: {@code -5}, nie {@code -5.0}). Der Tag des Abrufs kommt von außen ({@code abruf}), nie von einer Uhr.
 */
public final class EnergiemanagementRegeln {
    private EnergiemanagementRegeln() {}

    public record Startwerte(int ueberpruefung_monate, int ueberpruefung_monate_mindestens, int ueberpruefung_monate_hoechstens,
            int audit_rhythmus_monate, int managementbewertung_rhythmus_monate, int feststellung_frist_tage, int vorschau_tage,
            int wortlaut_zeichen_hoechstens, int begruendung_zeichen_mindestens, int begruendung_zeichen_hoechstens, int eintrag_zeichen_hoechstens) {}
    public static final Startwerte STARTWERTE = new Startwerte(12, 1, 60, 12, 12, 90, 30, 20000, 10, 500, 2000);
    public static final Map<String, List<String>> VOKABULARE = vokabulare();
    public static final Map<String, String> DOKUMENT_ART_KLASSE = dokumentArtKlasse();
    public static final List<String> LEITUNGS_PFLICHT = List.of("energiepolitik", "anwendungsbereich", "bestellung");
    public static final Map<String, Map<String, String>> WOERTER = woerter();
    /** Die Kundensätze (Report §5.8) als Schablonen; {@code {name}} füllt die Operation {@code satz}. */
    public static final Map<String, String> SAETZE = Map.ofEntries(
            Map.entry("verantwortung", "Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr Unternehmen. VoltPilot hält fest, wer was wann entschieden hat, und beurteilt nicht, ob Ihr Energiemanagement genügt."),
            Map.entry("grenz_satz", "VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden."),
            Map.entry("dokument_kopf", "{art} {kennzeichen} · Fassung {fassung} · freigegeben am {am} · entschieden von {entschieden_von} · eingetragen von {eingetragen_von}."),
            Map.entry("ort_wortlaut", "Wortlaut in VoltPilot, Original bei Ihnen: {ablage}."),
            Map.entry("ort_verweis", "Geführt in Ihrem System: {ablage} ({angaben})."),
            Map.entry("verweis_pruefsumme", "Die Prüfsumme wird in Ihrem Browser gebildet; die Datei verlässt Ihren Rechner nicht."),
            Map.entry("verweis_keine_datei", "VoltPilot speichert keine Dateien. Halten Sie fest, wo das Original liegt; die Prüfsumme zeigt später, ob es noch dasselbe ist."),
            Map.entry("ueberpruefung", "Überprüfung fällig seit {tage} Tagen."),
            Map.entry("geprueft_bleibt", "Geprüft, bleibt — entschieden von {person} am {am}: ‚{begruendung}‘"),
            Map.entry("bekanntmachung", "Bekannt gemacht am {am} an {kreis} über {weg} — eingetragen von {person}."),
            Map.entry("anwendungsbereich_deckungsgleich", "Der Betrachtungsumfang der energetischen Bewertung (Fassung {fassung}, ab {ab}) umfasst dieselben Standorte und Energieträger."),
            Map.entry("anwendungsbereich_unterschied", "{was} gehört zum Anwendungsbereich, aber nicht zum Betrachtungsumfang der energetischen Bewertung (Fassung {fassung})."),
            Map.entry("freigabe_ohne_leitung", "Diese Fassung braucht eine Entscheidung der Leitung. Für die Aufgabe ‚Leitung des Unternehmens‘ ist keine Person festgelegt."),
            Map.entry("aufgabe_ohne_person", "{aufgabe} — keine Person festgelegt."),
            Map.entry("person_ohne_konto", "{name} · {funktion} · ohne Konto — erscheint als ‚entschieden von‘."),
            Map.entry("einsicht_rolle", "Einsicht — Sie sehen das Energiemanagement des ganzen Unternehmens und können nichts ändern."),
            Map.entry("einsicht_schreibversuch", "Mit ‚Einsicht‘ können Sie hier nichts ändern. Festhalten kann, wer das Energiemanagement bearbeitet."),
            Map.entry("audit_kopf", "Internes Audit {kennzeichen} · durchgeführt am {am} von {auditor} ({unabhaengigkeit})."),
            Map.entry("hinweis", "Hinweis — festgestellt von {festgestellt_von}, eingetragen von {eingetragen_von} am {am}."),
            Map.entry("feststellung_kopf", "Feststellung {kennzeichen} · {quelle} · festgestellt von {person} am {am} · Verantwortlich {verantwortlich} · Frist {frist} · {zustand}."),
            Map.entry("behebung", "Sofortige Behebung — {person}, {am}: {wortlaut}"),
            Map.entry("ursache_aussage", "Ursache — Aussage von {person}, {am}: {wortlaut}"),
            Map.entry("herkunft_feststellung", "Herkunft: Feststellung {kennung}."),
            Map.entry("herkunft_audit", "Herkunft: internes Audit {kennung}."),
            Map.entry("herkunft_managementbewertung", "Herkunft: Managementbewertung {kennung} (Beschluss {beschluss})."),
            Map.entry("wirksamkeit", "Wirksamkeit geprüft am {am} von {person}: {ergebnis} — Stand Nr. {nr} mit Prüfsumme."),
            Map.entry("wirksamkeit_noch_nicht", "Die Wirksamkeit lässt sich prüfen, sobald jede Maßnahme umgesetzt, bewertet oder verworfen ist."),
            Map.entry("vieraugen_nicht_erfuellbar", "Vier-Augen nicht erfüllbar: außer {personen} darf niemand freigeben, und {beteiligt} sind hier beteiligt."),
            Map.entry("managementbewertung_kopf", "Managementbewertung {jahr} · Sitzung am {sitzung} · Leitung {leitung} · Stand Nr. {nr} vom {stand_vom}, mit Prüfsumme."),
            Map.entry("managementbewertung_erste", "Keine frühere Managementbewertung festgehalten."),
            Map.entry("beschluss", "Beschluss {nr} — entschieden von {entschieden_von}, eingetragen von {eingetragen_von}: {wortlaut}"),
            Map.entry("beschluss_ohne_folge", "Keine Folge in VoltPilot — der Beschluss steht im Stand vom {am}."),
            Map.entry("stand_seines_tages", "Dieser Stand zeigt die Eingaben vom {datenstand}. Was sich danach geändert hat, zeigt die nächste Managementbewertung."),
            Map.entry("wiedervorlage_zeile", "{gegenstand}: {was} seit {tage} Tagen fällig."),
            Map.entry("wiedervorlage_leer", "Zurzeit ist nichts fällig."),
            Map.entry("kalender_abzug", "Stand vom {am} aus VoltPilot; maßgeblich ist die Wiedervorlage im Portal."),
            Map.entry("baustein", "Energiemanagement — {faellig} fällig · {vorschau} in den nächsten {tage} Tagen."),
            Map.entry("verzeichnis_leer", "Hier ist noch nichts festgehalten."),
            Map.entry("verzeichnis_filter", "In meinem Namen festgehalten: {anzahl} Einträge."),
            Map.entry("zuschnitt_titel", "Was VoltPilot führt — was bei Ihnen liegt.")
    );

    public record Fassung(int nr, String freigegeben_am) {}
    public record Bleibt(int fassung, String am) {}
    /** Je {@code art} trägt der Eingang andere Felder: dokument (DK5), internes_audit/managementbewertung (IA4/MG7), feststellung (FS1). */
    public record UeberpruefungEingang(String art, String dokument_art, Integer monate, List<Fassung> fassungen, List<Bleibt> geprueft_bleibt,
            List<String> tage, String festgestellt_am, String frist, Integer frist_tage, String zustand, String abruf) {}
    public record WiedervorlageZeile(String art, String kennzeichen, String titel, String faellig_am, String verantwortlich) {}
    public record WiedervorlageEingang(String abruf, int vorschau_tage, List<WiedervorlageZeile> zeilen) {}
    public record Menge(List<String> standorte, List<String> traeger) {}
    public record VergleichEingang(Menge anwendungsbereich, Menge betrachtungsumfang) {}
    public record VerzeichnisEingang(String gruppe, String art, String kennzeichen, String titel, Integer nr, String entschieden_von,
            String eingetragen_von, String tag, String pruefsumme, String ort, String ablage) {}

    private static final Pattern PLATZ = Pattern.compile("\\{([a-z_]+)\\}");

    private static Map<String, List<String>> vokabulare() {
        var m = new LinkedHashMap<String, List<String>>();
        m.put("dokument_art", List.of("energiepolitik", "anwendungsbereich", "kontext", "rechtliche_anforderungen", "risiken_chancen", "bestellung", "verfahren", "betrieb", "beschaffung", "kommunikation", "auslegung", "kompetenz"));
        m.put("dokument_klasse", List.of("vorgabe", "nachweis"));
        m.put("dokument_zustand", List.of("entwurf", "gueltig", "aufgehoben"));
        m.put("dokument_bezug", List.of("unternehmen", "standort", "energieeinsatz", "person", "aufgabe"));
        m.put("fassung_form", List.of("wortlaut", "verweis"));
        m.put("fassung_status", List.of("entwurf", "beantragt", "freigegeben", "abgelehnt", "abgeloest"));
        m.put("dokument_eintrag", List.of("bekannt_gemacht", "geprueft_bleibt", "aufgehoben", "kommentar"));
        m.put("bekanntmachung_weg", List.of("aushang", "intranet", "unterweisung", "besprechung", "e_mail", "weiterer"));
        m.put("aufgabe", List.of("unternehmensleitung", "energiemanagement_leiten", "energieteam", "bezugsbasen", "energieziele_massnahmen", "bewertung_messplanung", "interne_audits", "managementbewertung", "dokumente", "weitere"));
        m.put("person_zustand", List.of("aktiv", "beendet"));
        m.put("aufgabe_zustand", List.of("laufend", "beendet"));
        m.put("audit_zustand", List.of("geplant", "durchgefuehrt", "abgeschlossen", "abgesagt"));
        m.put("audit_eintrag", List.of("hinweis", "kommentar"));
        m.put("feststellung_quelle", List.of("internes_audit", "eigene", "extern", "managementbewertung"));
        m.put("feststellung_zustand", List.of("offen", "abgeschlossen"));
        m.put("feststellung_eintrag", List.of("kommentar", "behebung", "ursache_aussage", "aehnliche_faelle"));
        m.put("wirksamkeit_ergebnis", List.of("wirksam", "nicht_wirksam", "ohne_massnahme", "zurueckgenommen"));
        m.put("managementbewertung_zustand", List.of("entwurf", "freigegeben"));
        m.put("beschluss_art", List.of("energieziel", "massnahme", "dokument", "aufgabe", "ressourcen", "audit", "keine_aenderung", "weitere"));
        m.put("folge_art", List.of("energieziel", "massnahme", "dokument", "aufgabe", "audit"));
        m.put("wiedervorlage_art", List.of("dokument_ueberpruefung", "internes_audit", "managementbewertung", "feststellung", "bewertung_ueberpruefung", "bezugsbasis_ueberpruefung", "energieziel_bewertung", "massnahme_termin", "abweichung_frist", "messbedarf_frist", "bericht_anstoss"));
        m.put("verzeichnis_ort", List.of("in_voltpilot", "wortlaut_original_beim_kunden", "verweis"));
        m.put("verzeichnis_gruppe", List.of("grundlagen", "verantwortung", "risiken_chancen", "kompetenz_kommunikation", "betrieb_auslegung_beschaffung", "bewertung_messplanung", "kennzahlen_bezugsbasen", "ziele_massnahmen_abweichungen", "audits_feststellungen", "managementbewertung", "berichte"));
        m.put("ueberpruefung_art", List.of("dokument", "internes_audit", "managementbewertung", "feststellung"));
        m.put("ueberpruefung_grund", List.of("nachweis", "keine_fassung", "kein_audit", "keine_managementbewertung", "abgeschlossen"));
        return m;
    }

    private static Map<String, String> dokumentArtKlasse() {
        var m = new LinkedHashMap<String, String>();
        for (String art : VOKABULARE.get("dokument_art")) {
            m.put(art, art.equals("auslegung") || art.equals("kompetenz") ? "nachweis" : "vorgabe");
        }
        return m;
    }

    private static Map<String, Map<String, String>> woerter() {
        var m = new LinkedHashMap<String, Map<String, String>>();
        m.put("dokument_art", geordnet("energiepolitik", "Energiepolitik", "anwendungsbereich", "Anwendungsbereich", "kontext", "Kontext und interessierte Parteien",
                "rechtliche_anforderungen", "Rechtliche Anforderungen", "risiken_chancen", "Risiken und Chancen", "bestellung", "Bestellung und Aufgaben (Beleg)",
                "verfahren", "Vorgehen", "betrieb", "Betrieb und Instandhaltung", "beschaffung", "Beschaffung", "kommunikation", "Kommunikation",
                "auslegung", "Auslegung (Nachweis)", "kompetenz", "Kompetenz (Nachweis)"));
        m.put("aufgabe", geordnet("unternehmensleitung", "Leitung des Unternehmens", "energiemanagement_leiten", "Energiemanagement leiten und an die Leitung berichten",
                "energieteam", "Mitglied im Energieteam", "bezugsbasen", "Bezugsbasen pflegen und freigeben", "energieziele_massnahmen", "Energieziele und Maßnahmen führen",
                "bewertung_messplanung", "Energetische Bewertung und Messplanung", "interne_audits", "Interne Audits planen und durchführen",
                "managementbewertung", "Managementbewertung vorbereiten", "dokumente", "Dokumente des Energiemanagements pflegen", "weitere", "weitere Aufgabe (mit Wortlaut)"));
        m.put("verzeichnis_gruppe", geordnet("grundlagen", "Anwendungsbereich, Kontext und Energiepolitik", "verantwortung", "Aufgaben und Verantwortliche",
                "risiken_chancen", "Risiken und Chancen", "kompetenz_kommunikation", "Kompetenz und Kommunikation", "betrieb_auslegung_beschaffung", "Betrieb, Auslegung und Beschaffung",
                "bewertung_messplanung", "Energetische Bewertung und Messplanung", "kennzahlen_bezugsbasen", "Kennzahlen, Bezugsbasen und Leistungsvergleiche",
                "ziele_massnahmen_abweichungen", "Energieziele, Maßnahmen und Abweichungen", "audits_feststellungen", "Interne Audits und Feststellungen",
                "managementbewertung", "Managementbewertung", "berichte", "Berichte"));
        m.put("verzeichnis_ort", geordnet("in_voltpilot", "in VoltPilot", "wortlaut_original_beim_kunden", "Wortlaut in VoltPilot, Original bei Ihnen",
                "verweis", "Geführt in Ihrem System"));
        return m;
    }

    private static Map<String, String> geordnet(String... paare) {
        var m = new LinkedHashMap<String, String>();
        for (int i = 0; i < paare.length; i += 2) {
            m.put(paare[i], paare[i + 1]);
        }
        return m;
    }

    private static Map<String, Object> fehler(String grund) {
        return new LinkedHashMap<>(Map.of("fehler", grund));
    }

    /** Die Lage einer Frist zum Abruf — die Wörter der Wiedervorlage (k_faelle {@code zeile}). */
    public static String lage(int tage) {
        if (tage > 0) return "seit " + tage + " Tagen fällig";
        if (tage == 0) return "heute fällig";
        return "fällig in " + (-tage) + " Tagen";
    }

    private static int tageBis(LocalDate faellig, String abruf) {
        return (int) ChronoUnit.DAYS.between(faellig, LocalDate.parse(abruf));
    }

    private static Map<String, Object> frist(LocalDate faelligAm, LocalDate basis, Integer fassung, String abruf) {
        int tage = tageBis(faelligAm, abruf);
        var aus = new LinkedHashMap<String, Object>();
        aus.put("faellig_am", faelligAm.toString());
        aus.put("basis", basis.toString());
        aus.put("fassung", fassung);
        aus.put("tage", tage);
        aus.put("satz", lage(tage));
        aus.put("grund", null);
        return aus;
    }

    private static Map<String, Object> ohne(String grund, String basis) {
        var aus = new LinkedHashMap<String, Object>();
        aus.put("faellig_am", null);
        aus.put("basis", basis);
        aus.put("fassung", null);
        aus.put("tage", null);
        aus.put("satz", null);
        aus.put("grund", grund);
        return aus;
    }

    /** DK5, IA4, MG7, FS1: wann die Sache wieder vorliegt — beim Abruf; der Tag kommt von außen ({@code abruf}). */
    public static Map<String, Object> ueberpruefung(UeberpruefungEingang e) {
        LocalDate abruf = LocalDate.parse(e.abruf());
        switch (e.art()) {
            case "dokument" -> {
                String klasse = DOKUMENT_ART_KLASSE.get(e.dokument_art());
                if (klasse == null) return fehler("dokument_art");
                if (klasse.equals("nachweis")) return ohne("nachweis", null);
                Integer monate = e.monate();
                if (monate == null || monate < STARTWERTE.ueberpruefung_monate_mindestens() || monate > STARTWERTE.ueberpruefung_monate_hoechstens()) {
                    return fehler("ueberpruefung_monate");
                }
                Fassung gilt = e.fassungen().stream().filter(f -> !LocalDate.parse(f.freigegeben_am()).isAfter(abruf))
                        .max(Comparator.comparingInt(Fassung::nr)).orElse(null);
                if (gilt == null) return ohne("keine_fassung", null);
                LocalDate basis = LocalDate.parse(gilt.freigegeben_am());
                for (Bleibt b : e.geprueft_bleibt()) {
                    LocalDate am = LocalDate.parse(b.am());
                    if (b.fassung() == gilt.nr() && !am.isAfter(abruf) && am.isAfter(basis)) basis = am;
                }
                return frist(basis.plusMonths(monate), basis, gilt.nr(), e.abruf());
            }
            case "internes_audit", "managementbewertung" -> {
                if (e.monate() < 1) return fehler("rhythmus_monate");
                LocalDate basis = e.tage().stream().map(LocalDate::parse).filter(t -> !t.isAfter(abruf)).max(Comparator.naturalOrder()).orElse(null);
                if (basis == null) return ohne(e.art().equals("internes_audit") ? "kein_audit" : "keine_managementbewertung", null);
                return frist(basis.plusMonths(e.monate()), basis, null, e.abruf());
            }
            case "feststellung" -> {
                if (!VOKABULARE.get("feststellung_zustand").contains(e.zustand())) return fehler("feststellung_zustand");
                if (e.frist_tage() < 1) return fehler("frist_tage");
                if (!e.zustand().equals("offen")) return ohne("abgeschlossen", e.festgestellt_am());
                LocalDate basis = LocalDate.parse(e.festgestellt_am());
                LocalDate frist = e.frist() != null ? LocalDate.parse(e.frist()) : basis.plusDays(e.frist_tage());
                return frist(frist, basis, null, e.abruf());
            }
            default -> {
                return fehler("ueberpruefung_art");
            }
        }
    }

    /** WV1–WV3: jede Frist kommt fertig aus ihrer Regel (WV2) — hier nur Lage, Vorschau-Fenster und Reihenfolge. */
    public static Map<String, Object> wiedervorlage(WiedervorlageEingang e) {
        if (e.vorschau_tage() < 0) return fehler("vorschau_tage");
        var zeilen = new ArrayList<Map<String, Object>>();
        for (var z : e.zeilen()) {
            if (!VOKABULARE.get("wiedervorlage_art").contains(z.art())) return fehler("wiedervorlage_art");
            int tage = tageBis(LocalDate.parse(z.faellig_am()), e.abruf());
            var aus = new LinkedHashMap<String, Object>();
            aus.put("art", z.art());
            aus.put("kennzeichen", z.kennzeichen());
            aus.put("titel", z.titel());
            aus.put("faellig_am", z.faellig_am());
            aus.put("tage", tage);
            aus.put("satz", lage(tage));
            aus.put("verantwortlich", z.verantwortlich());
            zeilen.add(aus);
        }
        var liste = zeilen.stream().filter(z -> (int) z.get("tage") >= -e.vorschau_tage())
                .sorted(Comparator.comparing((Map<String, Object> z) -> (String) z.get("faellig_am")).thenComparing(z -> (String) z.get("kennzeichen")))
                .toList();
        var faellig = liste.stream().filter(z -> (int) z.get("tage") >= 0).toList();
        var vorschau = liste.stream().filter(z -> (int) z.get("tage") < 0).toList();
        var aus = new LinkedHashMap<String, Object>();
        aus.put("faellig", faellig);
        aus.put("vorschau", vorschau);
        aus.put("anzahl_faellig", faellig.size());
        aus.put("anzahl_vorschau", vorschau.size());
        aus.put("nicht_in_liste", zeilen.stream().filter(z -> (int) z.get("tage") < -e.vorschau_tage()).map(z -> (String) z.get("kennzeichen")).sorted().toList());
        return aus;
    }

    /** DK7: Unterschiede zwischen Anwendungsbereich und Betrachtungsumfang (AP-16 U1) — Mengen, kein Urteil. */
    public static Map<String, Object> anwendungsbereichVergleich(VergleichEingang e) {
        var ab = e.anwendungsbereich();
        var um = e.betrachtungsumfang();
        var stAb = ab.standorte().stream().filter(s -> !um.standorte().contains(s)).toList();
        var stUm = um.standorte().stream().filter(s -> !ab.standorte().contains(s)).toList();
        var trAb = ab.traeger().stream().filter(t -> !um.traeger().contains(t)).toList();
        var trUm = um.traeger().stream().filter(t -> !ab.traeger().contains(t)).toList();
        var aus = new LinkedHashMap<String, Object>();
        aus.put("standorte_nur_im_anwendungsbereich", stAb);
        aus.put("standorte_nur_im_betrachtungsumfang", stUm);
        aus.put("traeger_nur_im_anwendungsbereich", trAb);
        aus.put("traeger_nur_im_betrachtungsumfang", trUm);
        aus.put("deckungsgleich", stAb.isEmpty() && stUm.isEmpty() && trAb.isEmpty() && trUm.isEmpty());
        return aus;
    }

    /** VZ2, G1: die Zeile mit ihrem Gruppen-Wort und dem Ort als Wort; Ablage nur, wo das Original beim Kunden liegt. */
    public static Map<String, Object> verzeichnisZeile(VerzeichnisEingang e) {
        String gruppe = WOERTER.get("verzeichnis_gruppe").get(e.gruppe());
        String ort = WOERTER.get("verzeichnis_ort").get(e.ort());
        if (gruppe == null) return fehler("verzeichnis_gruppe");
        if (ort == null) return fehler("verzeichnis_ort");
        boolean ablage = e.ablage() != null && !e.ablage().isEmpty();
        if (e.ort().equals("in_voltpilot") && e.ablage() != null) return fehler("ablage_unerwartet");
        if (!e.ort().equals("in_voltpilot") && !ablage) return fehler("ablage_fehlt");
        var aus = new LinkedHashMap<String, Object>();
        aus.put("gruppe", e.gruppe());
        aus.put("art", e.art());
        aus.put("kennzeichen", e.kennzeichen());
        aus.put("titel", e.titel());
        aus.put("nr", e.nr());
        aus.put("entschieden_von", e.entschieden_von());
        aus.put("eingetragen_von", e.eingetragen_von());
        aus.put("tag", e.tag());
        aus.put("pruefsumme", e.pruefsumme());
        aus.put("ort", e.ort());
        aus.put("gruppe_wort", gruppe);
        aus.put("ort_satz", ablage ? ort + ": " + e.ablage() : ort);
        return aus;
    }

    /** A6 über A1 von {@code bericht.md}: {@code sha256:} + SHA-256 der UTF-8-Bytes des kanonischen Texts einer Kopie. */
    public static Map<String, Object> pruefsumme(JsonNode kopie) {
        String text = BerichtRegeln.kanonisch(kopie);
        var aus = new LinkedHashMap<String, Object>();
        aus.put("kanonisch", text);
        aus.put("pruefsumme", BerichtRegeln.pruefsumme(text));
        return aus;
    }

    /** SP4: die Schablone aus §5.8, jeder Platzhalter genau aus {@code werte} — kein Wert fehlt, keiner bleibt übrig. */
    public static Map<String, Object> satz(String schluessel, Map<String, String> werte) {
        String vorlage = SAETZE.get(schluessel);
        if (vorlage == null) return fehler("satz_unbekannt");
        var namen = new ArrayList<String>();
        Matcher t = PLATZ.matcher(vorlage);
        while (t.find()) namen.add(t.group(1));
        for (var n : namen) if (!werte.containsKey(n)) return fehler("wert_fehlt:" + n);
        var uebrig = new TreeSet<>(werte.keySet());
        uebrig.removeAll(namen);
        if (!uebrig.isEmpty()) return fehler("wert_uebrig:" + uebrig.first());
        var sb = new StringBuilder();
        Matcher f = PLATZ.matcher(vorlage);
        while (f.find()) f.appendReplacement(sb, Matcher.quoteReplacement(werte.get(f.group(1))));
        f.appendTail(sb);
        return new LinkedHashMap<>(Map.of("satz", sb.toString()));
    }
}
