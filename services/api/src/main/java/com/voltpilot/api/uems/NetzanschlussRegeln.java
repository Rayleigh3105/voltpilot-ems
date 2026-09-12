package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Der NETZANSCHLUSS als eigenes Objekt am Standort (UEMS AP-10 E8, AP-00 E6/E10) — reine Regel.
 *
 * <p>Der Anschluss gehört dem STANDORT; eine Anlage verweist zeitgültig auf ihn (Tage, Muster A).
 * Je Tag hat eine Anlage höchstens einen Anschluss UND ein Anschluss höchstens eine Anlage; ein
 * Wechsel beendet die laufende Bindung am Vortag, nichts wird überschrieben.
 *
 * <p><b>Was hier NICHT passiert (W9):</b> die Preis- und Grenzspalten der Anlage
 * ({@code site.max_feed_in_kw}, {@code site_supply_price} …) bleiben unverändert an der Anlage;
 * ihr Umzug ist ein eigenes Folgepaket. Und die Kopfzeile ZEIGT die vereinbarte Leistung neben der
 * Momentanleistung — sie PRÜFT keine Grenze: das tut AP-15. Eine Fläche, die eine Überschreitung
 * behauptete, hätte hier keinen Fakt, der sie trägt.
 *
 * <p>Die EINE Wahrheit steht in {@code docs/contracts/v2/netzanschluss-vectors.json} (Prosa:
 * {@code netzanschluss.md}); der TS-Zwilling ist {@code frontend/portal/src/uemsNetzanschluss.ts}.
 *
 * <p>Rein: ohne Spring, ohne DB, ohne Uhr.
 */
public final class NetzanschlussRegeln {

    private NetzanschlussRegeln() {}

    /** Dieselbe Kennzeichen-Form wie bei der Messstelle (AP-00 E10) — nur mit eigenem Präfix. */
    public static final String KENNZEICHEN_PRAEFIX = "NA-";

    public static final int KENNZEICHEN_STELLEN = 4;

    /** Elf Ziffern. Eine kürzere Nummer wird abgelehnt, nie aufgefüllt. */
    public static final String MALO_MUSTER = "^[0-9]{11}$";

    private static final Pattern MALO = Pattern.compile(MALO_MUSTER);

    /** Geschlossenes Vokabular: ein Wort außerhalb wird VERWORFEN, nie geraten. */
    public static final List<String> MESSUNGEN = List.of("RLM", "SLP");

    public static final String FEHLER_KENNZEICHEN_FORMAT =
            MessstelleRegeln.Fehler.KENNZEICHEN_FORMAT.code();
    public static final String FEHLER_KENNZEICHEN_BELEGT =
            MessstelleRegeln.Fehler.KENNZEICHEN_BELEGT.code();
    public static final String FEHLER_MALO = "malo_form";
    public static final String FEHLER_ANFRAGE = "anfrage_ungueltig";
    public static final String FEHLER_BINDUNG_UEBERLAPPT =
            MessstelleRegeln.Fehler.BINDUNG_UEBERLAPPT.code();
    public static final String FEHLER_ANSCHLUSS_BELEGT = "anschluss_belegt";

    /** Ein Hinweis hält nichts an — er sagt nur, was auffällt. */
    public static final String HINWEIS_VEREINBART_UEBER_ANSCHLUSS = "vereinbart_ueber_anschluss";

    public static final String KOPFZEILE_TRENNER = " · ";

    // ------------------------------------------------------------------------------ Kennzeichen

    public record Vorschlag(String kennzeichen, int zaehler) {}

    public record KennzeichenUrteil(boolean gueltig, String fehler, Vorschlag vorschlag) {}

    /** Das automatische Kennzeichen zur laufenden Nummer: {@code 2 → NA-0002}. */
    public static String automatisch(int nummer) {
        return KENNZEICHEN_PRAEFIX + String.format(Locale.ROOT, "%0" + KENNZEICHEN_STELLEN + "d", nummer);
    }

    /**
     * {@code kandidat == null} heißt: automatisch vergeben — die kleinste Nummer über dem Zähler,
     * deren Kennzeichen niemand trägt oder trug. Ein einmal vergebenes Kennzeichen wird nie an
     * einen anderen Anschluss weitergegeben.
     */
    public static KennzeichenUrteil kennzeichen(String kandidat, List<String> belegt, int zaehler) {
        if (kandidat == null) {
            int n = zaehler + 1;
            while (belegt.contains(automatisch(n))) {
                n++;
            }
            return new KennzeichenUrteil(true, null, new Vorschlag(automatisch(n), n));
        }
        if (!MessstelleRegeln.kennzeichenFormatGueltig(kandidat)) {
            return new KennzeichenUrteil(false, FEHLER_KENNZEICHEN_FORMAT, null);
        }
        if (belegt.contains(kandidat)) {
            return new KennzeichenUrteil(false, FEHLER_KENNZEICHEN_BELEGT, null);
        }
        return new KennzeichenUrteil(true, null, null);
    }

    // ------------------------------------------------------------------------ Marktlokation

    public record MaloUrteil(String malo, String fehler) {}

    /**
     * Die Marktlokation hat elf Ziffern. Ohne Marktlokation ist der Anschluss anlegbar — sie ist
     * dann {@code null}, nicht „unbekannt 0“. Was die Form nicht hält, wird abgelehnt statt
     * zurechtgebogen.
     */
    public static MaloUrteil malo(String text) {
        if (text == null) {
            return new MaloUrteil(null, null);
        }
        return MALO.matcher(text).matches()
                ? new MaloUrteil(text, null)
                : new MaloUrteil(null, FEHLER_MALO);
    }

    // ------------------------------------------------------------------------------- Felder

    public record Felder(
            String name,
            String standort,
            String malo,
            String netzbetreiber,
            BigDecimal anschlussKva,
            BigDecimal vereinbartKw,
            String messung) {}

    public record FelderUrteil(boolean gueltig, String fehler, String feld, List<String> hinweise) {}

    /**
     * Name und Standort sind Pflicht; Leistungen sind freiwillig, aber wenn sie da sind, sind sie
     * größer als null. Die Messung kommt aus dem geschlossenen Vokabular. Eine vereinbarte
     * Leistung ÜBER der Anschlussleistung ist ein Hinweis, keine Ablehnung: was der Netzbetreiber
     * vereinbart hat, wissen wir nicht besser als er.
     */
    public static FelderUrteil felder(Felder f) {
        if (f.name() == null || f.name().isBlank()) {
            return new FelderUrteil(false, FEHLER_ANFRAGE, "name", List.of());
        }
        if (f.standort() == null || f.standort().isBlank()) {
            return new FelderUrteil(false, FEHLER_ANFRAGE, "standort", List.of());
        }
        if (f.messung() == null || !MESSUNGEN.contains(f.messung())) {
            return new FelderUrteil(false, FEHLER_ANFRAGE, "messung", List.of());
        }
        if (f.anschlussKva() != null && f.anschlussKva().signum() <= 0) {
            return new FelderUrteil(false, FEHLER_ANFRAGE, "anschluss_kva", List.of());
        }
        if (f.vereinbartKw() != null && f.vereinbartKw().signum() <= 0) {
            return new FelderUrteil(false, FEHLER_ANFRAGE, "vereinbart_kw", List.of());
        }
        if (f.malo() != null && malo(f.malo()).fehler() != null) {
            return new FelderUrteil(false, FEHLER_ANFRAGE, "malo", List.of());
        }
        List<String> hinweise = new ArrayList<>();
        if (f.anschlussKva() != null
                && f.vereinbartKw() != null
                && f.vereinbartKw().compareTo(f.anschlussKva()) > 0) {
            hinweise.add(HINWEIS_VEREINBART_UEBER_ANSCHLUSS);
        }
        return new FelderUrteil(true, null, null, List.copyOf(hinweise));
    }

    // ------------------------------------------------------------------------------ Bindung

    /** Eine zeitgültige Bindung Anlage ↔ Netzanschluss; {@code gueltigBis == null} heißt „läuft“. */
    public record Bindung(
            String anlage, String netzanschluss, LocalDate gueltigAb, LocalDate gueltigBis) {}

    public record BindungUrteil(Bindung beendet, Bindung eintrag, String fehler, boolean rueckwirkend) {}

    private static boolean laeuftAm(Bindung b, LocalDate tag) {
        return !tag.isBefore(b.gueltigAb()) && (b.gueltigBis() == null || !tag.isAfter(b.gueltigBis()));
    }

    /**
     * Eine neue Bindung ab ihrem Tag. Läuft an diesem Tag schon eine Bindung DERSELBEN Anlage, die
     * an genau diesem Tag beginnt, ist das ein Konflikt; beginnt die neue später, wird die laufende
     * am Vortag beendet. Hängt der Anschluss am Tag schon an einer ANDEREN Anlage, ist er belegt.
     */
    public static BindungUrteil bindung(List<Bindung> bestehend, Bindung neu, LocalDate heute) {
        boolean rueckwirkend = neu.gueltigAb().isBefore(heute);
        for (Bindung b : bestehend) {
            if (b.netzanschluss().equals(neu.netzanschluss())
                    && !b.anlage().equals(neu.anlage())
                    && laeuftAm(b, neu.gueltigAb())) {
                return new BindungUrteil(null, null, FEHLER_ANSCHLUSS_BELEGT, rueckwirkend);
            }
        }
        Bindung laufend = bestehend.stream()
                .filter(b -> b.anlage().equals(neu.anlage()) && laeuftAm(b, neu.gueltigAb()))
                .findFirst()
                .orElse(null);
        if (laufend == null) {
            return new BindungUrteil(null, neu, null, rueckwirkend);
        }
        if (!neu.gueltigAb().isAfter(laufend.gueltigAb())) {
            return new BindungUrteil(null, null, FEHLER_BINDUNG_UEBERLAPPT, rueckwirkend);
        }
        Bindung beendet = new Bindung(laufend.anlage(), laufend.netzanschluss(), laufend.gueltigAb(),
                neu.gueltigAb().minusDays(1));
        return new BindungUrteil(beendet, neu, null, rueckwirkend);
    }

    // ----------------------------------------------------------------------------- Kopfzeile

    public record KopfzeileUrteil(String text, boolean grenzeGeprueft) {}

    /**
     * Die Kopfzeile der Bilanz-Seite. Was fehlt, steht nicht da — ein fehlender Momentanwert wird
     * nie zu „0 kW“. {@code grenzeGeprueft} ist immer {@code false}: hier wird GEZEIGT, nicht
     * geprüft (AP-15).
     */
    public static KopfzeileUrteil kopfzeile(
            String netzanschluss, BigDecimal vereinbartKw, BigDecimal anschlussKva, BigDecimal momentanKw) {
        List<String> teile = new ArrayList<>();
        if (vereinbartKw != null) {
            teile.add("vereinbart " + BilanzAbleitung.zahlDe(vereinbartKw) + " kW");
        }
        if (anschlussKva != null) {
            teile.add("Anschluss " + BilanzAbleitung.zahlDe(anschlussKva) + " kVA");
        }
        if (momentanKw != null) {
            teile.add("Momentan " + BilanzAbleitung.zahlDe(momentanKw) + " kW");
        }
        return new KopfzeileUrteil(String.join(KOPFZEILE_TRENNER, teile), false);
    }
}
