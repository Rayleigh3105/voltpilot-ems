package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * AP-17 E9 = C (IP-12a): die dritte Herkunft {@code bezogen} — Tagesmittel der Außentemperatur,
 * von VoltPilot aus einem Wetter-Archiv bezogen, über {@link GradtagRegeln} zu Gradtagen. Rein: kein
 * Abruf, keine Uhr; der Client kommt mit IP-12b. Vertrag {@code bezugsdaten.md} §„Wetter-Archiv“.
 */
public final class WetterArchivRegeln {
    private WetterArchivRegeln() {}

    public static final String HERKUNFT = "bezogen";
    public static final String VARIABLE_FEHLT = "variable_fehlt";
    public static final String TEMPERATUR_BEZOGEN = "Temperatur von VoltPilot bezogen";
    public static final String WORT_TAGE = "Tagen";
    public static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final DateTimeFormatter ABRUF = DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm");

    public record Koordinaten(BigDecimal breite, BigDecimal laenge) {}
    public record Archivtag(LocalDate datum, BigDecimal mittel, String quelle, OffsetDateTime abgerufenAm) {}
    public record Tag(LocalDate datum, BigDecimal betrag, String zustand, List<String> kennzeichen) {}
    public record Monat(BigDecimal betrag, String zustand, String grund, List<String> kennzeichen) {}
    public record Ergebnis(boolean abruf, String grund, String satz, List<Tag> tage, List<LocalDate> nieGeschrieben, Monat monat) {}

    /** Das Kennzeichen an jeder bezogenen Zahl: Quelle und Abrufzeit in der Ortszone. */
    public static String kennzeichen(String quelle, OffsetDateTime abgerufenAm) {
        return TEMPERATUR_BEZOGEN + " (" + quelle + ", abgerufen am " + ABRUF.format(abgerufenAm.atZoneSameInstant(ZONE)) + ")";
    }

    /** §5.8: der Satz für einen Standort ohne Koordinaten — derselbe wie {@code UEMS_KOORDINATEN_FEHLEN_SATZ}. */
    public static String koordinatenFehlen(String standort) {
        return "Für den Standort " + standort + " kann VoltPilot kein Wetter beziehen: die Koordinaten fehlen. "
                + "Eine Wetterbereinigung über Gradtage ist hier erst möglich, wenn der Standort Koordinaten hat.";
    }

    /** Nur ein Archiv-Tag: vor dem Kalendertag des Abrufs in der Ortszone (bis gestern). Vorhersage nie. */
    public static boolean archivtag(LocalDate datum, OffsetDateTime abgerufenAm) {
        return datum.isBefore(abgerufenAm.atZoneSameInstant(ZONE).toLocalDate());
    }

    public static Ergebnis monat(String standort, Koordinaten koordinaten, YearMonth monat, List<Archivtag> archiv,
            BigDecimal raum, BigDecimal grenze) {
        if (koordinaten == null) {
            if (!archiv.isEmpty()) throw new IllegalArgumentException("ohne Koordinaten gibt es keinen Abruf");
            return new Ergebnis(false, VARIABLE_FEHLT, koordinatenFehlen(standort), List.of(), List.of(),
                    new Monat(null, VerbrauchRegeln.KEINE_WERTE, VARIABLE_FEHLT, List.of()));
        }
        Map<LocalDate, Archivtag> geschrieben = new LinkedHashMap<>();
        List<LocalDate> nie = new ArrayList<>();
        Set<LocalDate> gesehen = new HashSet<>();
        for (Archivtag a : archiv) {
            if (!YearMonth.from(a.datum()).equals(monat)) throw new IllegalArgumentException("Tag außerhalb des Monats: " + a.datum());
            if (!gesehen.add(a.datum())) throw new IllegalArgumentException("Tag doppelt: " + a.datum());
            if (archivtag(a.datum(), a.abgerufenAm()) && a.mittel() != null) geschrieben.put(a.datum(), a);
            else if (!archivtag(a.datum(), a.abgerufenAm())) nie.add(a.datum());
        }
        List<Tag> tage = new ArrayList<>();
        List<GradtagRegeln.Tag> monatsTage = new ArrayList<>();
        Map<String, OffsetDateTime> spaetesterAbruf = new LinkedHashMap<>();
        for (int d = 1; d <= monat.lengthOfMonth(); d++) {
            Archivtag a = geschrieben.get(monat.atDay(d));
            if (a == null) {
                monatsTage.add(new GradtagRegeln.Tag(null, VerbrauchRegeln.KEINE_WERTE));
                continue;
            }
            GradtagRegeln.Tag tag = new GradtagRegeln.Tag(a.mittel(), VerbrauchRegeln.VOLLSTAENDIG);
            monatsTage.add(tag);
            GradtagRegeln.Ergebnis e = GradtagRegeln.gradtage(List.of(tag), raum, grenze);
            List<String> kz = new ArrayList<>(e.kennzeichen());
            kz.add(kennzeichen(a.quelle(), a.abgerufenAm()));
            tage.add(new Tag(a.datum(), e.betrag(), e.zustand(), List.copyOf(kz)));
            spaetesterAbruf.merge(a.quelle(), a.abgerufenAm(), (x, y) -> y.toInstant().isAfter(x.toInstant()) ? y : x);
        }
        GradtagRegeln.Ergebnis m = GradtagRegeln.gradtage(monatsTage, raum, grenze);
        List<String> kz = new ArrayList<>(m.kennzeichen());
        spaetesterAbruf.forEach((quelle, zeit) -> kz.add(kennzeichen(quelle, zeit)));
        if (tage.size() < monat.lengthOfMonth()) kz.add(tage.size() + " von " + monat.lengthOfMonth() + " " + WORT_TAGE);
        return new Ergebnis(true, null, null, List.copyOf(tage), List.copyOf(nie),
                new Monat(m.betrag(), m.zustand(), m.betrag() == null ? VARIABLE_FEHLT : null, List.copyOf(kz)));
    }
}
