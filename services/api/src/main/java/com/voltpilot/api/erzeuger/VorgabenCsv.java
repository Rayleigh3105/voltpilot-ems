package com.voltpilot.api.erzeuger;

import com.voltpilot.api.erzeuger.VorgabenRepository.LueckeZeile;
import com.voltpilot.api.erzeuger.VorgabenRepository.Zeile;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * „Vorgaben als CSV“ (UEMS EZ-7, EW-12 A): rein, ohne Spring und ohne Datenbank. Spalten und Wörter deutsch, Zahlen
 * im de-DE-Format (Dezimalkomma, ohne Tausenderpunkt, ungerundet), Trenner Semikolon, UTF-8 mit BOM, Zeilenende
 * CRLF — dieselbe Form wie {@code MeldungenCsv}. Zeiten als ISO 8601 in Ortszeit (Europe/Berlin) mit Versatz,
 * damit die Stunde der Zeitumstellung eindeutig bleibt. Unbekannt ist eine leere Zelle, nie 0.
 *
 * <p>Die Zeilen sind die Vorgaben und die Datenlücken mit weiteren Wechseln, nach Beginn. Die Euro-Spalte ist eine
 * Schätzung zu den Preisen der Anlage, ohne Aussage über eine Erstattung (EW-8 A).
 */
public final class VorgabenCsv {

    public static final String BOM = "﻿";
    public static final String ZEILENENDE = "\r\n";
    private static final String TRENNER = ";";
    private static final DateTimeFormatter ZEIT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssXXX");

    static final List<String> SPALTEN = List.of("Urheber", "Art", "Einheit", "Beginn", "Beginn genau", "Ende",
            "Ende genau", "Läuft", "Dauer (s)", "Kleinste Vorgabe (%)", "Kleinste Vorgabe (kW)", "Ist im Mittel (kW)",
            "Verfügbar im Mittel (kW)", "Geschätzt nicht erzeugt (kWh)", "Schätzmethode", "Wert geschätzt (€)", "Kanal",
            "Bindung", "Unvollständig", "Neustart der Steuerung", "Zähler Beginn", "Zähler Ende",
            "Gründe nicht bereit", "Weitere Wechsel in der Lücke");

    static final Map<String, String> URHEBER = Map.of("netzbetreiber", "Netzbetreiber", "direktvermarkter",
            "Direktvermarkter", "anlage", "Anlage selbst", "hand", "Hand", "ersatzwert", "Ersatzwert", "schutz",
            "Schutz");
    static final Map<String, String> ART = Map.of("p_begrenzung", "Wirkleistung begrenzt", "abschaltung",
            "Abschaltung", "q_vorgabe", "cos-φ-Vorgabe", "dv_aktivierung", "Abruf (Aktivierung)", "dv_stopp", "Stopp",
            "nicht_bereit", "nicht bereit", "automatik", "Automatik (Netzpunkt-Regelung)", "ersatzwert",
            "Ersatzwert");
    static final Map<String, String> METHODE = Map.of("pv_prognose", "PV-Prognose der Anlage",
            "nennleistung_bereite_motoren", "Nennleistung der bereiten Motoren", "dv_sollwert_davor",
            "Sollwert des Direktvermarkters davor");
    static final Map<String, String> KANAL = Map.of("keiner", "keiner", "feste_grenze", "feste Grenze", "stufen",
            "Stufen", "fernwirktechnik", "Fernwirktechnik", "relais_ma", "Relais und mA", "modbus", "Modbus");
    static final Map<String, String> BINDUNG = Map.of("bindend", "bindend", "nicht_bindend", "nicht bindend");

    private VorgabenCsv() {}

    /** Die Datei: BOM, jede Zeile mit CRLF. */
    public static byte[] datei(List<Zeile> vorgaben, List<LueckeZeile> luecken) {
        StringBuilder s = new StringBuilder(BOM);
        zeilen(vorgaben, luecken).forEach(z -> s.append(z).append(ZEILENENDE));
        return s.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** Die Zeilen der Datei, ohne BOM und Zeilenende — für den Test ohne Byte-Kodierung. */
    static List<String> zeilen(List<Zeile> vorgaben, List<LueckeZeile> luecken) {
        record Eintrag(Instant beginn, String zeile) {}
        List<Eintrag> eintraege = new ArrayList<>();
        vorgaben.forEach(v -> eintraege.add(new Eintrag(v.beginn(), zeile(v))));
        luecken.forEach(l -> eintraege.add(new Eintrag(l.beginn(), zeile(l))));
        eintraege.sort(Comparator.comparing(Eintrag::beginn));
        List<String> raus = new ArrayList<>();
        raus.add(String.join(TRENNER, SPALTEN));
        eintraege.forEach(e -> raus.add(e.zeile()));
        return raus;
    }

    private static String zeile(Zeile v) {
        ErzeugerRegisterbild.Feld tBits = ErzeugerRegisterbild.feld("erzeuger.te[1].t_bits").orElseThrow();
        String gruende = v.gruende().stream()
                .map(w -> tBits.bits().stream().filter(b -> b.wort().equals(w)).findFirst()
                        .map(ErzeugerRegisterbild.Bit::text).orElse(w))
                .collect(Collectors.joining(", "));
        return String.join(TRENNER, zelle(URHEBER.getOrDefault(v.urheber(), v.urheber())),
                zelle(ART.getOrDefault(v.art(), v.art())), zelle(einheit(v.teNr(), v.einheitName())),
                zelle(zeit(v.beginn())), janein(v.beginnGenau()), zelle(zeit(v.ende())),
                v.ende() == null ? "" : janein(v.endeGenau()), janein(v.ende() == null),
                String.valueOf(Duration.between(v.beginn(), v.belegtBis()).getSeconds()),
                zahl(v.vorgabeProzent()), kw(v.vorgabeW()), kw(v.istMittelW()), kw(v.verfuegbarMittelW()),
                zahl(v.energieKwh()), zelle(v.methode() == null ? null : METHODE.getOrDefault(v.methode(), v.methode())),
                zahl(v.wertEur()), zelle(v.kanal() == null ? null : KANAL.getOrDefault(v.kanal(), v.kanal())),
                zelle(v.bindung() == null ? null : BINDUNG.getOrDefault(v.bindung(), v.bindung())),
                janein(v.unvollstaendig()), janein(v.neustart()), zahl(v.zaehlerBeginn()), zahl(v.zaehlerEnde()),
                zelle(gruende.isEmpty() ? null : gruende), "");
    }

    private static String zeile(LueckeZeile l) {
        String weitere = l.weitereWechsel() != null ? String.valueOf(l.weitereWechsel()) : "unbekannt (Neustart)";
        List<String> z = new ArrayList<>();
        z.add(zelle(URHEBER.getOrDefault(l.urheber(), l.urheber())));
        z.add("Datenlücke");
        z.add(zelle(einheit(null, null)));
        z.add(zelle(zeit(l.beginn())));
        z.add("");
        z.add(zelle(zeit(l.ende())));
        z.add("");
        z.add(janein(false));
        z.add(String.valueOf(Duration.between(l.beginn(), l.ende()).getSeconds()));
        for (int i = 0; i < 10; i++) {
            z.add("");
        }
        z.add(janein(l.neustart()));
        z.add(zahl(l.zaehlerVorher()));
        z.add(zahl(l.zaehlerNachher()));
        z.add("");
        z.add(zelle(weitere));
        return String.join(TRENNER, z);
    }

    private static String einheit(Integer teNr, String name) {
        if (teNr == null) {
            return "ganze Anlage";
        }
        return name == null ? "Einheit " + teNr : "Einheit " + teNr + " · " + name;
    }

    private static String zeit(Instant t) {
        return t == null ? null : ZEIT.format(t.atZone(VorgabenAbleitung.ZONE));
    }

    private static String janein(boolean b) {
        return b ? "ja" : "nein";
    }

    /** Eine Zahl ungerundet mit Dezimalkomma; leer, wenn keine. */
    static String zahl(Number n) {
        if (n == null) {
            return "";
        }
        BigDecimal b = n instanceof BigDecimal d ? d : new BigDecimal(n.toString());
        return b.stripTrailingZeros().toPlainString().replace('.', ',');
    }

    /** Watt als Kilowatt, ungerundet mit Dezimalkomma. */
    static String kw(BigDecimal watt) {
        return watt == null ? "" : zahl(watt.movePointLeft(3));
    }

    private static String zelle(String s) {
        if (s == null) {
            return "";
        }
        if (s.contains(";") || s.contains("\"") || s.contains("\n") || s.contains("\r")) {
            return "\"" + s.replace("\"", "\"\"") + "\"";
        }
        return s;
    }
}
