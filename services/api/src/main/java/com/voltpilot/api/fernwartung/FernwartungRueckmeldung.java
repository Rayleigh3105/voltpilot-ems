package com.voltpilot.api.fernwartung;

import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Die Rückmeldung des Tunnel-Dienstes ans Portal (Fenster-Schlüssel, Schritt 4;
 * Vertrag: {@code docs/contracts/fernwartung-rueckmeldung-v1.md}): je Box
 * „verbunden seit" und „zuletzt gefragt um", je Fenster „Schlüssel abgeholt
 * um". Hier stehen die Form der Meldung und die Regeln, nach denen die API
 * sie annimmt - rein, ohne Datenbank.
 *
 * <p><b>Die Meldung ist Anzeige.</b> Nichts aus ihr fließt in den Soll-Stand
 * ({@link FernwartungService#soll}); die Klassen der Rückmeldung und die des
 * Soll-Stands kennen einander nicht ({@code FernwartungRueckmeldungRegelnTest}).
 *
 * <p><b>Streng gelesen.</b> Ein unbekanntes Feld, eine andere Version, eine
 * Kennung, die keine UUID ist, eine Zeitangabe nach {@code gemeldetUm} oder
 * eine Uhr des Wartungsservers, die von der der API abweicht: die ganze
 * Meldung wird abgewiesen. Eine halbe Meldung zeigte im Portal einen Stand,
 * den es so nie gab.
 */
public final class FernwartungRueckmeldung {

    /** Die einzige Version der Meldung, die diese API annimmt. */
    public static final int VERSION = 1;
    /** Mehr Boxen bzw. Fenster nennt eine Meldung nicht. */
    public static final int MAX_EINTRAEGE = 10_000;
    /** Eine größere Meldung liest die API nicht zu Ende. */
    public static final int MAX_BYTES = 2 * 1024 * 1024;
    /** So weit darf {@code gemeldetUm} von der Uhr der API abweichen. */
    public static final Duration MAX_UHRABWEICHUNG = Duration.ofMinutes(5);

    private static final Pattern UUID_FORM = Pattern.compile(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    /**
     * Eigener Leser, unabhängig vom ObjectMapper der Anwendung: unbekannte
     * Felder, doppelte Felder, Text statt Zahl und Reste hinter dem Dokument
     * sind Fehler.
     */
    private static final ObjectMapper LESER = JsonMapper.builder()
            .addModule(new JavaTimeModule())
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .build();

    /** Die Meldung, wie sie ankommt: jedes Feld kann fehlen, die Prüfung nennt den Grund. */
    public record Meldung(Integer version, Instant gemeldetUm, Instant gestartetUm, Boolean schluesselausgabe,
            List<BoxMeldung> boxen, List<FensterMeldung> fenster) {
    }

    /** {@code null} ist eine Aussage: nicht verbunden bzw. seit dem Start des Dienstes nicht gefragt. */
    public record BoxMeldung(String id, Instant verbundenSeit, Instant zuletztGefragtUm) {
    }

    /** {@code null}: seit dem Start des Dienstes nicht abgeholt. */
    public record FensterMeldung(String id, Instant schluesselAbgeholtUm) {
    }

    /** Eine geprüfte Meldung. */
    public record Geprueft(Instant gemeldetUm, Instant gestartetUm, boolean schluesselausgabe, List<Box> boxen,
            List<Fenster> fenster) {
    }

    public record Box(UUID id, Instant verbundenSeit, Instant zuletztGefragtUm) {
    }

    public record Fenster(UUID id, Instant schluesselAbgeholtUm) {
    }

    /** Die Meldung hat nicht die vereinbarte Form; die Nachricht nennt den Grund. */
    public static final class Ungueltig extends RuntimeException {
        public Ungueltig(String grund) {
            super(grund);
        }
    }

    private FernwartungRueckmeldung() {
    }

    /** Liest den Rumpf streng. Kein JSON oder ein unbekanntes Feld: {@link Ungueltig}. */
    public static Meldung lies(byte[] rumpf) {
        try {
            Meldung m = LESER.readValue(rumpf, Meldung.class);
            if (m == null) {
                throw new Ungueltig("Die Rückmeldung ist leer.");
            }
            return m;
        } catch (IOException e) {
            throw new Ungueltig("Die Rückmeldung hat nicht die vereinbarte Form (JSON, Version " + VERSION
                    + ", keine weiteren Felder).");
        }
    }

    /**
     * Prüft eine Meldung gegen die Uhr der API. Ob die genannten Boxen und
     * Fenster existieren, prüft danach {@code FernwartungRueckmeldungService}.
     */
    public static Geprueft pruefe(Meldung m, Instant jetzt) {
        if (m.version() == null || m.version() != VERSION) {
            throw new Ungueltig("Version " + m.version() + " der Rückmeldung ist unbekannt (erwartet " + VERSION
                    + ").");
        }
        if (m.gemeldetUm() == null || m.gestartetUm() == null || m.schluesselausgabe() == null
                || m.boxen() == null || m.fenster() == null) {
            throw new Ungueltig("In der Rückmeldung fehlt ein Feld (gemeldetUm, gestartetUm, schluesselausgabe, "
                    + "boxen, fenster).");
        }
        if (m.boxen().size() > MAX_EINTRAEGE || m.fenster().size() > MAX_EINTRAEGE) {
            throw new Ungueltig("Die Rückmeldung nennt mehr als " + MAX_EINTRAEGE + " Boxen oder Fenster.");
        }
        Duration abweichung = Duration.between(jetzt, m.gemeldetUm()).abs();
        if (abweichung.compareTo(MAX_UHRABWEICHUNG) > 0) {
            throw new Ungueltig("Die Uhr des Wartungsservers weicht um " + abweichung.toMinutes()
                    + " Minuten von der Uhr der API ab (erlaubt sind " + MAX_UHRABWEICHUNG.toMinutes()
                    + "). Bitte den Zeitabgleich des Wartungsservers prüfen.");
        }
        spaetestens(m.gestartetUm(), m.gemeldetUm(), "gestartetUm");

        Set<UUID> gesehen = new HashSet<>();
        List<Box> boxen = new ArrayList<>(m.boxen().size());
        for (BoxMeldung b : m.boxen()) {
            if (b == null) {
                throw new Ungueltig("Die Rückmeldung nennt eine leere Box.");
            }
            UUID id = kennung(b.id(), "Box");
            if (!gesehen.add(id)) {
                throw new Ungueltig("Die Rückmeldung nennt die Box " + id + " mehrfach.");
            }
            spaetestens(b.verbundenSeit(), m.gemeldetUm(), "verbundenSeit");
            spaetestens(b.zuletztGefragtUm(), m.gemeldetUm(), "zuletztGefragtUm");
            boxen.add(new Box(id, b.verbundenSeit(), b.zuletztGefragtUm()));
        }
        gesehen.clear();
        List<Fenster> fenster = new ArrayList<>(m.fenster().size());
        for (FensterMeldung f : m.fenster()) {
            if (f == null) {
                throw new Ungueltig("Die Rückmeldung nennt ein leeres Fenster.");
            }
            UUID id = kennung(f.id(), "Fenster");
            if (!gesehen.add(id)) {
                throw new Ungueltig("Die Rückmeldung nennt das Fenster " + id + " mehrfach.");
            }
            spaetestens(f.schluesselAbgeholtUm(), m.gemeldetUm(), "schluesselAbgeholtUm");
            fenster.add(new Fenster(id, f.schluesselAbgeholtUm()));
        }
        return new Geprueft(m.gemeldetUm(), m.gestartetUm(), m.schluesselausgabe(), List.copyOf(boxen),
                List.copyOf(fenster));
    }

    private static UUID kennung(String text, String was) {
        if (text == null || !UUID_FORM.matcher(text).matches()) {
            throw new Ungueltig("Die Rückmeldung nennt ein(e) " + was + " ohne gültige id.");
        }
        return UUID.fromString(text);
    }

    /** Keine Angabe liegt nach {@code gemeldetUm}: der Dienst meldet, was war. */
    private static void spaetestens(Instant zeit, Instant gemeldetUm, String feld) {
        if (zeit != null && zeit.isAfter(gemeldetUm)) {
            throw new Ungueltig("In der Rückmeldung liegt " + feld + " nach gemeldetUm.");
        }
    }
}
