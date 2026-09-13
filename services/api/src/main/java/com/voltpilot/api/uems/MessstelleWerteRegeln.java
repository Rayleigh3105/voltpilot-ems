package com.voltpilot.api.uems;

import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Die reinen Regeln des Lese-Modells „Werte je Messstelle“ (UEMS AP-08 IP-9): wie die Anfrage
 * gelesen wird, welche Schritte ein Zeitraum im Raster hat und welche führende Quelle einen
 * Schritt beantworten darf. Kein Spring, keine Datenbank — gerechnet wird hier NICHTS an einem
 * Wert; Mengen, Zustände und Kennzeichen kommen aus den Speicherklassen und ihrer Regel.
 *
 * <p><b>Ein Schritt wird aus GENAU EINER Reihe beantwortet</b> (Komponente + Messkanal, AP-07 E2).
 * Der Schritt gehört der Messstelle nur, wenn ihre führenden Bindungen derselben Reihe ihn GANZ
 * decken — ein Zählerwechsel an derselben Komponente (Z-5a → Z-5b) wechselt den Einbau, nicht die
 * Reihe, und bleibt darum eine Antwort. Deckt keine Bindung den Schritt, hat die Messstelle für ihn
 * „keine Werte“; deckt ihn eine nur teilweise oder decken ihn zwei Reihen, gehört ein Teil der
 * gespeicherten Periode nicht dieser Messstelle, und die Antwort nennt den Grund statt einer Zahl.
 */
public final class MessstelleWerteRegeln {

    private MessstelleWerteRegeln() {}

    /** Das geschlossene Raster der Route. */
    public enum Raster {
        VIERTELSTUNDE("viertelstunde"),
        STUNDE("stunde"),
        TAG("tag"),
        MONAT("monat"),
        JAHR("jahr");

        private final String wort;

        Raster(String wort) {
            this.wort = wort;
        }

        public String wort() {
            return wort;
        }

        /** Das Raster zum Wort — {@code null}, wenn es das Wort nicht gibt. */
        public static Raster aus(String wort) {
            return Arrays.stream(values()).filter(r -> r.wort.equals(wort)).findFirst().orElse(null);
        }

        /** Die Wörter in ihrer Reihenfolge — so stehen sie in der Ablehnung und in der OpenAPI. */
        public static List<String> woerter() {
            return Arrays.stream(values()).map(Raster::wort).toList();
        }
    }

    /**
     * Die Grenze je Antwort: dieselbe Zeilenbremse wie im Verlauf
     * ({@code SpeicherklasseHistorie.HOECHSTENS_ZEILEN}) — 2 200 Schritte, für die Stunde ein Viertel,
     * weil sie ihre Viertelstunden in denselben Lesezug holt.
     */
    public static int hoechstensSchritte(Raster r) {
        return r == Raster.STUNDE ? 550 : 2200;
    }

    /** Frühester Anfang und spätestes Ende — ein Zeitraum außerhalb ist ein Tippfehler, keine Frage. */
    public static final Instant FRUEHESTENS = Instant.parse("2000-01-01T00:00:00Z");
    public static final Instant SPAETESTENS = Instant.parse("2100-01-01T00:00:00Z");

    // ---------------------------------------------------------------------------- Ablehnung

    /** Die Gründe einer abgelehnten Anfrage — geschlossen, je mit dem Feld, das sie betrifft. */
    public enum Grund {
        /** Ein Pflichtfeld fehlt. */
        FEHLT("fehlt"),
        /** Das Raster kennt die Route nicht. */
        RASTER_UNBEKANNT("raster_unbekannt"),
        /** Kein Tag (JJJJ-MM-TT) und kein Zeitpunkt mit Versatz — oder ein Tag, den es nicht gibt. */
        FORM("form"),
        /** Der Zeitpunkt liegt nicht auf einer Grenze des Rasters in der Zeitzone des Standorts. */
        NICHT_IM_RASTER("nicht_im_raster"),
        /** {@code von} liegt nicht vor {@code bis}. */
        VON_NICHT_VOR_BIS("von_nicht_vor_bis"),
        /** Vor 2000 oder nach 2100. */
        AUSSERHALB("ausserhalb"),
        /** Mehr Schritte, als eine Antwort trägt. */
        ZU_VIELE_SCHRITTE("zu_viele_schritte"),
        /** Die Version ist keine ganze Zahl ab 1. */
        VERSION_UNGUELTIG("version_ungueltig");

        private final String wort;

        Grund(String wort) {
            this.wort = wort;
        }

        public String wort() {
            return wort;
        }
    }

    /** Eine abgelehnte Anfrage: Feld, Grund und der deutsche Satz. Nichts ist gelesen. */
    public record Ablehnung(String feld, Grund grund, String satz) {}

    /** Die Ablehnung als Ausnahme — der Dienst reicht sie als 400 {@code anfrage_ungueltig} weiter. */
    public static final class Abgelehnt extends RuntimeException {
        private final Ablehnung ablehnung;

        Abgelehnt(Ablehnung ablehnung) {
            super(ablehnung.satz());
            this.ablehnung = ablehnung;
        }

        public Ablehnung ablehnung() {
            return ablehnung;
        }
    }

    private static Abgelehnt ab(String feld, Grund grund, String satz) {
        return new Abgelehnt(new Ablehnung(feld, grund, satz));
    }

    // ------------------------------------------------------------------------------ Anfrage

    /**
     * Die Form der Anfrage, bevor die Messstelle bekannt ist: Raster, die Form von {@code von} und
     * {@code bis}, die Version. Ein Tag braucht die Zeitzone des Standorts und wird erst in
     * {@link #zeitraum} zum Zeitpunkt.
     */
    public record Form(Raster raster, Zeitangabe von, Zeitangabe bis, Integer version) {}

    /** Ein Tag (JJJJ-MM-TT) ODER ein Zeitpunkt mit Versatz — genau eines ist gesetzt. */
    public record Zeitangabe(LocalDate tag, Instant zeitpunkt) {}

    public static Form form(String raster, String von, String bis, String version) {
        if (leer(raster)) {
            throw ab("raster", Grund.FEHLT, "„raster“ fehlt — bekannt sind " + String.join(", ", Raster.woerter()) + ".");
        }
        Raster r = Raster.aus(raster);
        if (r == null) {
            throw ab("raster", Grund.RASTER_UNBEKANNT,
                    "„" + raster + "“ ist kein Raster — bekannt sind " + String.join(", ", Raster.woerter()) + ".");
        }
        Zeitangabe v = zeitangabe("von", von);
        Zeitangabe b = zeitangabe("bis", bis);
        Integer n = null;
        if (version != null) {
            try {
                n = Integer.valueOf(version.trim());
            } catch (NumberFormatException e) {
                n = null;
            }
            if (n == null || n < 1) {
                throw ab("version", Grund.VERSION_UNGUELTIG, "„version“ ist eine ganze Zahl ab 1.");
            }
        }
        return new Form(r, v, b, n);
    }

    private static Zeitangabe zeitangabe(String feld, String text) {
        if (leer(text)) {
            throw ab(feld, Grund.FEHLT, "„" + feld + "“ fehlt — ein Tag (JJJJ-MM-TT) oder ein Zeitpunkt mit Versatz.");
        }
        String t = text.trim();
        try {
            if (t.length() == 10) {
                return new Zeitangabe(LocalDate.parse(t, DateTimeFormatter.ISO_LOCAL_DATE), null);
            }
            return new Zeitangabe(null, OffsetDateTime.parse(t).toInstant());
        } catch (DateTimeParseException e) {
            throw ab(feld, Grund.FORM, "„" + feld + "“ ist kein Tag (JJJJ-MM-TT) und kein Zeitpunkt mit Versatz"
                    + " (2026-10-25T02:00:00+02:00).");
        }
    }

    /** Der geprüfte Zeitraum mit seinen Schritten. {@code bis} ist ausschließlich (halboffen). */
    public record Zeitraum(Raster raster, ZoneId zone, Instant von, Instant bis, List<Schritt> schritte) {}

    /** Ein Schritt des Rasters in der Zeitzone des Standorts, halboffen {@code [von, bis)}. */
    public record Schritt(Instant von, Instant bis) {}

    /**
     * Die Anfrage in der Zeitzone des Standorts. Ein Tag als {@code von} ist sein Beginn, ein Tag als
     * {@code bis} ist der LETZTE Tag einschließlich (tagesgenau wie jede Zuordnung im Haus); ein
     * Zeitpunkt ist genau dieser Zeitpunkt, {@code bis} dann ausschließlich. Beide Grenzen liegen im
     * Raster — gerundet wird nie, ein Zeitpunkt daneben ist eine benannte Ablehnung.
     */
    public static Zeitraum zeitraum(Form f, ZoneId zone) {
        Instant von = f.von().tag() != null ? f.von().tag().atStartOfDay(zone).toInstant() : f.von().zeitpunkt();
        Instant bis = f.bis().tag() != null ? f.bis().tag().plusDays(1).atStartOfDay(zone).toInstant()
                : f.bis().zeitpunkt();
        if (von.isBefore(FRUEHESTENS) || von.isAfter(SPAETESTENS)) {
            throw ab("von", Grund.AUSSERHALB, "„von“ liegt vor 2000 oder nach 2100.");
        }
        if (bis.isBefore(FRUEHESTENS) || bis.isAfter(SPAETESTENS)) {
            throw ab("bis", Grund.AUSSERHALB, "„bis“ liegt vor 2000 oder nach 2100.");
        }
        if (!von.isBefore(bis)) {
            throw ab("bis", Grund.VON_NICHT_VOR_BIS, "„von“ muss vor „bis“ liegen.");
        }
        Raster r = f.raster();
        if (!aufGrenze(r, von, zone)) {
            throw ab("von", Grund.NICHT_IM_RASTER, "„von“ liegt nicht auf dem Beginn " + genitiv(r)
                    + " in der Zeitzone des Standorts (" + zone.getId() + ").");
        }
        if (!aufGrenze(r, bis, zone)) {
            throw ab("bis", Grund.NICHT_IM_RASTER, "„bis“ liegt nicht auf dem Ende " + genitiv(r)
                    + " in der Zeitzone des Standorts (" + zone.getId() + ").");
        }
        int hoechstens = hoechstensSchritte(r);
        List<Schritt> schritte = new ArrayList<>();
        for (Instant s = von; s.isBefore(bis); s = naechste(r, s, zone)) {
            if (schritte.size() == hoechstens) {
                throw ab("bis", Grund.ZU_VIELE_SCHRITTE, "Der Zeitraum hat mehr als " + hoechstens
                        + " Schritte im Raster „" + r.wort() + "“ — bitte kürzer anfragen.");
            }
            schritte.add(new Schritt(s, naechste(r, s, zone)));
        }
        return new Zeitraum(r, zone, von, bis, List.copyOf(schritte));
    }

    private static String genitiv(Raster r) {
        return switch (r) {
            case VIERTELSTUNDE -> "einer Viertelstunde";
            case STUNDE -> "einer Stunde";
            case TAG -> "eines Tages";
            case MONAT -> "eines Monats";
            case JAHR -> "eines Jahres";
        };
    }

    /**
     * Liegt {@code t} auf einer Grenze? Viertelstunde und Stunde im UTC-Raster (die zugelassenen Zonen
     * haben ganze Stunden Versatz — die doppelte Stunde am 25.10. sind zwei Schritte, die fehlende am
     * 28.03. keiner), Tag, Monat und Jahr als Kalenderperioden der Zone.
     */
    static boolean aufGrenze(Raster r, Instant t, ZoneId zone) {
        if (t.getNano() != 0) {
            return false;
        }
        ZonedDateTime z = t.atZone(zone);
        return switch (r) {
            case VIERTELSTUNDE -> t.getEpochSecond() % 900 == 0;
            case STUNDE -> t.getEpochSecond() % 900 == 0 && z.getMinute() == 0;
            case TAG -> z.toLocalDate().atStartOfDay(zone).toInstant().equals(t);
            case MONAT -> z.getDayOfMonth() == 1 && z.toLocalDate().atStartOfDay(zone).toInstant().equals(t);
            case JAHR -> z.getDayOfYear() == 1 && z.toLocalDate().atStartOfDay(zone).toInstant().equals(t);
        };
    }

    static Instant naechste(Raster r, Instant t, ZoneId zone) {
        LocalDate tag = t.atZone(zone).toLocalDate();
        return switch (r) {
            case VIERTELSTUNDE -> t.plusSeconds(900);
            case STUNDE -> t.plusSeconds(3600);
            case TAG -> tag.plusDays(1).atStartOfDay(zone).toInstant();
            case MONAT -> tag.withDayOfMonth(1).plusMonths(1).atStartOfDay(zone).toInstant();
            case JAHR -> tag.withDayOfYear(1).plusYears(1).atStartOfDay(zone).toInstant();
        };
    }

    // ---------------------------------------------------------------------------- Deckung

    /**
     * Eine führende Bindung der Hauptgröße, wie die Deckung sie braucht. {@code bis} {@code null} =
     * läuft; {@code anteil} {@code null} = der ganze Wert.
     */
    public record Bindung(UUID id, UUID entityId, String kanal, String herleitung, String anteil,
            Instant ab, Instant bis) {

        boolean beruehrt(Schritt s) {
            return ab.isBefore(s.bis()) && (bis == null || bis.isAfter(s.von()));
        }
    }

    /** Die Reihe, aus der ein Schritt gelesen wird: Komponente + Messkanal (AP-07 E2). */
    public record Reihe(UUID entityId, String kanal) {}

    /**
     * Die Gründe, aus denen ein Schritt KEINE Zahl trägt, obwohl die Anfrage gültig ist — geschlossen.
     * Jeder ist ein Code, kein Kundensatz: den Satz spricht die Fläche (AP-08 IP-10/IP-11).
     */
    public enum OhneZahl {
        /** Keine führende Bindung der Hauptgröße berührt den Schritt: „keine Werte“. */
        KEINE_QUELLE("keine_quelle"),
        /**
         * Eine führende Bindung deckt den Schritt nur zum Teil, oder zwei Reihen teilen ihn: die
         * gespeicherte Periode gehört nicht ganz dieser Messstelle.
         */
        QUELLE_TEILWEISE("quelle_teilweise"),
        /**
         * Die Bindung liest nur einen Anteil eines Vorzeichen-Werts (AP-08 IP-7) — die Speicherklassen
         * tragen den ganzen Wert der Reihe, eine Menge je Anteil ist nirgends gespeichert.
         */
        ANTEIL_NICHT_GESPEICHERT("anteil_nicht_gespeichert"),
        /** Eine berechnete Messstelle hat keine Reihe; ihre Werte rechnet die Formel (AP-10). */
        BERECHNET("berechnet"),
        /** Rohwerte bzw. Viertelstunden sind da, die Periode ist aber noch nicht gebildet. */
        NOCH_NICHT_GEBILDET("noch_nicht_gebildet"),
        /**
         * Die Periode ist gespeichert, aber vor der Mengenregel gebildet (ein endgültiger Tag von vor
         * AP-08 IP-5): sie trägt keine Menge und keinen Zustand und wird nie neu geschrieben.
         */
        OHNE_MENGE_GESPEICHERT("ohne_menge_gespeichert"),
        /** Die angefragte Version ist für diesen Schritt nicht gespeichert (frühere Fassungen: IP-18). */
        VERSION_NICHT_GESPEICHERT("version_nicht_gespeichert");

        private final String wort;

        OhneZahl(String wort) {
            this.wort = wort;
        }

        public String wort() {
            return wort;
        }
    }

    /** Das Urteil über einen Schritt: genau eine Reihe (mit ihrer Bindung) ODER ein Grund. */
    public record Deckung(Reihe reihe, Bindung bindung, OhneZahl grund) {}

    /**
     * Welche Reihe den Schritt beantwortet. Die Bindungen sind die FÜHRENDEN der Hauptgröße (eine
     * Vergleichsquelle liefert hier nie). Die Prüfreihenfolge: keine Bindung → Anteil → mehr als eine
     * Reihe → Lücke in der Deckung → die eine Reihe.
     */
    public static Deckung deckung(List<Bindung> fuehrend, Schritt s) {
        List<Bindung> treffer = fuehrend.stream().filter(b -> b.beruehrt(s))
                .sorted(Comparator.comparing(Bindung::ab)).toList();
        if (treffer.isEmpty()) {
            return new Deckung(null, null, OhneZahl.KEINE_QUELLE);
        }
        if (treffer.stream().anyMatch(b -> b.anteil() != null)) {
            return new Deckung(null, null, OhneZahl.ANTEIL_NICHT_GESPEICHERT);
        }
        Reihe reihe = new Reihe(treffer.get(0).entityId(), treffer.get(0).kanal());
        if (treffer.stream().anyMatch(b -> !new Reihe(b.entityId(), b.kanal()).equals(reihe))) {
            return new Deckung(null, null, OhneZahl.QUELLE_TEILWEISE);
        }
        Instant gedeckt = s.von();
        for (Bindung b : treffer) {
            if (b.ab().isAfter(gedeckt)) {
                return new Deckung(null, null, OhneZahl.QUELLE_TEILWEISE);
            }
            if (b.bis() == null) {
                gedeckt = s.bis();
                break;
            }
            if (b.bis().isAfter(gedeckt)) {
                gedeckt = b.bis();
            }
        }
        if (gedeckt.isBefore(s.bis())) {
            return new Deckung(null, null, OhneZahl.QUELLE_TEILWEISE);
        }
        return new Deckung(reihe, treffer.get(treffer.size() - 1), null);
    }

    // ------------------------------------------------------------------------- Zeitformen

    /** ISO-8601 mit Offset in der Zone — die Form des Exports ({@code ErgebnisZustand.raster}). */
    private static final DateTimeFormatter ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssxxx", Locale.ROOT);

    public static String iso(Instant t, ZoneId zone) {
        return ISO.format(t.atZone(zone));
    }

    /** Welche Herleitung eine MENGE trägt und welche Mittel/Min/Max — jede Zahl steht in der Einheit der Messstelle. */
    public static boolean traegtMenge(String herleitung) {
        return !"momentanwert".equals(herleitung);
    }

    private static boolean leer(String s) {
        return s == null || s.isBlank();
    }

    /** Nur für die Fakten der Ablehnung: das Feld und der Grund, snake_case. */
    public static Map<String, Object> fakten(Ablehnung a) {
        return Map.of("feld", Objects.requireNonNull(a.feld()), "grund", a.grund().wort());
    }
}
