package com.voltpilot.api.command;

import com.voltpilot.api.history.HistoryRange;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Die REINEN Regeln der Befehls-SUCHE (Geräteseiten Revision B, Konzept
 * {@code vp-geraeteseite-rev-b8} §6, Captain-Punkt 4): welche Strukturfilter es
 * gibt, was ihr Vokabular ist und welches Fenster eine Anfrage aufspannen darf.
 *
 * <p>Keine Datenbank, kein Spring, keine Uhr aus dem Nichts - jede
 * zeitabhängige Funktion nimmt ihr {@code today} entgegen (das
 * {@code CommandLog}/{@code Tagesprotokoll}/{@code FleetPflege}-Muster), damit
 * Fenster-Arithmetik und Vokabular Docker-frei prüfbar sind.
 *
 * <p><b>⚠ STRUKTUR serverseitig, TEXT clientseitig</b> (§6 Regel 1). Hier
 * entstehen ausschliesslich die drei STRUKTUR-Filter (Strom · Herkunft ·
 * Ergebnis) plus das Fenster. Der FREITEXT bleibt bewusst im Portal: die
 * deutschen Sätze entstehen dort ({@code befehle.ts film()}), und eine
 * Server-Suche fände nur Rohfelder - sie widerspräche also dem, was der Kunde
 * liest, und wäre genau die zweite Wahrheit, gegen die das Haus baut.
 *
 * <p><b>⚠ Ein unbekanntes Wort wird BENANNT abgelehnt, nie still verworfen.</b>
 * Ein stillschweigend ignorierter Filter zeigte MEHR Zeilen als verlangt und
 * läse sich als „es gibt keine weiteren" - die gefährlichere der beiden
 * Auskünfte. Dieselbe Disziplin wie beim Ingest, nur mit umgekehrtem Vorzeichen:
 * dort verwirft ein unbekanntes Wort die Aussage, hier die ANFRAGE.
 */
public final class CommandFilter {

    private CommandFilter() {
    }

    // -- Das Vokabular --------------------------------------------------------

    /**
     * Die Ströme, nach denen gefiltert werden darf. Es sind die vier Ströme des
     * Speichers plus der vierte, zur Lesezeit eingemischte Strom
     * {@code register} - genau die Wörter, die {@code CommandEntryDto.stream}
     * je trägt.
     */
    public static final Set<String> STREAMS = Set.of(CommandLog.STREAM_BATTERIE,
            CommandLog.STREAM_ABREGELUNG, CommandLog.STREAM_VERBRAUCHER,
            CommandLog.STREAM_LADEPUNKT, CommandLogReader.STREAM_REGISTER);

    /** Die Herkunft einer Zeile: abgeleitet · vom Gerät · über das Portal. */
    public static final Set<String> SOURCES = Set.of(CommandLog.SOURCE_CLOUD,
            CommandLog.SOURCE_GERAET, "portal");

    // -- Die ERGEBNISSE (ein Vokabular über beide Speicher) -------------------

    /** Das Gerät hält, was befohlen wurde. */
    public static final String RESULT_BESTAETIGT = CommandLog.VERDICT_BESTAETIGT;
    /** Das Gerät hält nachweislich etwas anderes. */
    public static final String RESULT_ABWEICHEND = CommandLog.VERDICT_ABWEICHEND;
    /** Schweigen - ausdrücklich NICHT „abweichend" (die PR-280-Lehre). */
    public static final String RESULT_KEINE_ANTWORT = CommandLog.VERDICT_KEINE_ANTWORT;
    /** Eine Abweichung ist gesehen, aber noch nicht bestätigt. */
    public static final String RESULT_PRUEFT = CommandLog.VERDICT_PRUEFT;
    /** Nicht (mehr) bestätigt, ohne dass die Ursache belegbar wäre. */
    public static final String RESULT_UNBESTAETIGT = CommandLog.VERDICT_UNBESTAETIGT;
    /**
     * Ein anderes System regelt möglicherweise mit. Kein Rücklese-Urteil,
     * sondern die SCHÄRFERE Aussage daneben (die Klemm-Plateau-Lektion) - und
     * deshalb ein eigenes Filter-Wort statt eines Urteils.
     */
    public static final String RESULT_FREMDEINFLUSS = "fremdeinfluss";
    /** Der Not-Aus stand an: es wurde nichts geschrieben. */
    public static final String RESULT_NOTAUS = "notaus";
    /** Register: das Gerät hat den Wert nachweislich übernommen. */
    public static final String RESULT_UEBERNOMMEN = "uebernommen";
    /** Register: das Gerät hat den Wert nachweislich NICHT übernommen. */
    public static final String RESULT_NICHT_UEBERNOMMEN = "nicht_uebernommen";
    /** Register: es kam gar keine Quittung - Schweigen, kein Widerspruch. */
    public static final String RESULT_KEINE_QUITTUNG = "keine_quittung";

    /**
     * Die Ergebnisse der HALTEPERIODEN (die Zeilen aus {@code device_command_log}).
     * Sie sind ein anderes Vokabular als die drei Register-Ausgänge, weil sie
     * eine andere Frage beantworten: „hält das Gerät den Befehl" gegen „ist der
     * eine Schreibvorgang angekommen".
     */
    public static final Set<String> LOG_RESULTS = Set.of(RESULT_BESTAETIGT, RESULT_ABWEICHEND,
            RESULT_KEINE_ANTWORT, RESULT_PRUEFT, RESULT_UNBESTAETIGT, RESULT_FREMDEINFLUSS,
            RESULT_NOTAUS);

    /**
     * Die fünf Wörter, die WIRKLICH in {@code device_command_log.verdict}
     * stehen können - die Teilmenge von {@link #LOG_RESULTS}, die eine SPALTE
     * ist. {@code fremdeinfluss} und {@code notaus} gehören nicht dazu: sie
     * leben in eigenen Spalten, weil sie andere Fragen beantworten.
     */
    public static final Set<String> VERDICT_WORDS = Set.of(RESULT_BESTAETIGT, RESULT_ABWEICHEND,
            RESULT_KEINE_ANTWORT, RESULT_PRUEFT, RESULT_UNBESTAETIGT);

    /** Die Ausgänge eines Register-Schreibvorgangs. */
    public static final Set<String> REGISTER_RESULTS =
            Set.of(RESULT_UEBERNOMMEN, RESULT_NICHT_UEBERNOMMEN, RESULT_KEINE_QUITTUNG);

    /** Das ganze Ergebnis-Vokabular, über beide Speicher. */
    public static final Set<String> RESULTS = union(LOG_RESULTS, REGISTER_RESULTS);

    // -- Das Fenster ----------------------------------------------------------

    /**
     * Wie weit ein Fenster zurückreichen darf. Es ist EXAKT die Aufbewahrung
     * ({@link CommandLog#RETENTION}) - ein Fenster, das weiter zurückgriffe,
     * fände nichts und läse sich als „damals war nichts", während in Wahrheit
     * gelöscht wurde.
     */
    public static final int MAX_DAYS_BACK = (int) CommandLog.RETENTION.toDays();

    /** Der Vorgabe-Deckel einer Antwort; {@code limit} darf ihn heben. */
    public static final int DEFAULT_LIMIT = 500;

    /** Die harte Obergrenze eines {@code limit} - darüber wird abgelehnt. */
    public static final int MAX_LIMIT = 2_000;

    /**
     * Die Zeiträume, die diese Route kennt. {@code month} ist seit dieser Stufe
     * dabei (§6: „Zeitraum bis 90 Tage"), {@code year} bewusst NICHT: ein Jahr
     * überschreitet die Aufbewahrung und wäre damit ein Fenster, das per
     * Konstruktion unvollständig antwortet.
     */
    public static final Set<HistoryRange> RANGES =
            Set.of(HistoryRange.DAY, HistoryRange.WEEK, HistoryRange.MONTH);

    // -- Der Filter selbst ----------------------------------------------------

    /**
     * Die drei Strukturfilter. Eine LEERE Menge heisst „keine Einschränkung" -
     * nie „nichts zeigen": ein Filter, den niemand gesetzt hat, darf nicht alles
     * verschlucken.
     */
    public record Filter(Set<String> streams, Set<String> sources, Set<String> results) {

        /** Der leere Filter - er zeigt alles. */
        public static final Filter NONE = new Filter(Set.of(), Set.of(), Set.of());

        public boolean isEmpty() {
            return streams.isEmpty() && sources.isEmpty() && results.isEmpty();
        }

        /**
         * Ob der vierte Strom {@code register} überhaupt noch vorkommen kann.
         * Er ist ein PUNKT-Ereignis aus einem anderen Speicher, also entscheidet
         * das schon die Anfrage: ohne ihn wird seine Abfrage gar nicht gestellt.
         */
        public boolean includesRegister() {
            if (!streams.isEmpty() && !streams.contains(CommandLogReader.STREAM_REGISTER)) {
                return false;
            }
            // Ein Ergebnis-Filter, der AUSSCHLIESSLICH Halteperioden-Wörter
            // nennt, kann keine Register-Zeile treffen - sie tragen keines
            // davon. Das ist keine Optimierung, sondern dieselbe Ehrlichkeit:
            // eine Zeile ohne dieses Ergebnis ist kein Treffer.
            return results.isEmpty() || results.stream().anyMatch(REGISTER_RESULTS::contains);
        }

        /**
         * Ob die HALTEPERIODEN überhaupt noch vorkommen können - die Kehrseite
         * von {@link #includesRegister()}.
         */
        public boolean includesLog() {
            if (!streams.isEmpty()
                    && streams.stream().allMatch(CommandLogReader.STREAM_REGISTER::equals)) {
                return false;
            }
            return results.isEmpty() || results.stream().anyMatch(LOG_RESULTS::contains);
        }

        /** Die Ströme OHNE {@code register} - das Vokabular des Speichers. */
        public Set<String> logStreams() {
            LinkedHashSet<String> out = new LinkedHashSet<>(streams);
            out.remove(CommandLogReader.STREAM_REGISTER);
            return out;
        }

        /** Die Ergebnis-Wörter, die eine Halteperiode tragen kann. */
        public Set<String> logResults() {
            return intersect(results, LOG_RESULTS);
        }

        /** Die Ergebnis-Wörter, die ein Register-Vorgang tragen kann. */
        public Set<String> registerResults() {
            return intersect(results, REGISTER_RESULTS);
        }
    }

    /**
     * Liest die drei Filter-Parameter. Komma-getrennt, Leerraum egal,
     * Gross-/Kleinschreibung egal - ein Support-Link wird von Hand
     * zusammengesetzt, und ein Leerzeichen darf ihn nicht kaputt machen.
     *
     * @throws IllegalArgumentException mit deutschem Grund, sobald EIN Wort
     *                                  ausserhalb seines Vokabulars steht
     */
    public static Filter parse(String streams, String sources, String results) {
        return new Filter(words(streams, STREAMS, "Befehlsart"),
                words(sources, SOURCES, "Herkunft"),
                words(results, RESULTS, "Ergebnis"));
    }

    /**
     * Ein Filter-Parameter als Menge. {@code null}/leer = keine Einschränkung.
     *
     * <p>Ein unbekanntes Wort wird abgelehnt und die Meldung NENNT das erlaubte
     * Vokabular: „ungültig" ist auf einer Fläche, die ein Mensch bedient, keine
     * Antwort (die {@code ChargingConfigService}-Disziplin).
     */
    static Set<String> words(String raw, Set<String> vocabulary, String label) {
        if (raw == null || raw.isBlank()) {
            return Set.of();
        }
        LinkedHashSet<String> out = new LinkedHashSet<>();
        for (String part : raw.split(",")) {
            String v = part.trim().toLowerCase(Locale.ROOT);
            if (v.isEmpty()) {
                continue;
            }
            if (!vocabulary.contains(v)) {
                List<String> allowed = vocabulary.stream().sorted().toList();
                throw new IllegalArgumentException("Unbekannter Filter „" + label + "\": \"" + v
                        + "\". Möglich sind " + String.join(", ", allowed) + ".");
            }
            out.add(v);
        }
        return Set.copyOf(out);
    }

    /**
     * Das Fenster einer Anfrage: entweder ein Kalender-Zeitraum ({@code range}
     * + {@code at}) oder ein ausdrückliches {@code from}/{@code to}.
     *
     * <p><b>⚠ Die 90-Tage-Grenze ist keine Bequemlichkeit</b>, sondern die
     * Aufbewahrung selbst: ein Fenster davor fände nichts und läse sich als
     * „damals wurde nichts geschickt" - eine entlastende Aussage über eine Zeit,
     * die gelöscht ist. Deshalb wird sie ABGELEHNT statt still gekappt.
     *
     * @param today der laufende Berliner Kalendertag - nie {@code LocalDate.now()}
     *              aus dem Nichts
     */
    public static HistoryRange.Window window(HistoryRange range, LocalDate at, LocalDate from,
            LocalDate to, LocalDate today) {
        if (from != null || to != null) {
            if (from == null || to == null) {
                throw new IllegalArgumentException(
                        "Ein eigener Zeitraum braucht Anfang und Ende (von/bis).");
            }
            if (to.isBefore(from)) {
                throw new IllegalArgumentException("Das Ende liegt vor dem Anfang.");
            }
            // `to` ist der letzte gemeinte TAG, das Fenster endet am Tagesende:
            // ein Fenster, das um 00:00 des Bis-Tages endete, liesse den ganzen
            // gewählten Tag aussen vor - genau der Fehler, den ein Mensch nie
            // vermuten würde.
            return requireInRetention(new HistoryRange.Window(
                    from.atStartOfDay(HistoryRange.ZONE).toInstant(),
                    to.plusDays(1).atStartOfDay(HistoryRange.ZONE).toInstant()), today);
        }
        return requireInRetention(range.window(at != null ? at : today), today);
    }

    private static HistoryRange.Window requireInRetention(HistoryRange.Window w, LocalDate today) {
        Instant floor = today.minusDays(MAX_DAYS_BACK).atStartOfDay(HistoryRange.ZONE).toInstant();
        if (w.from().isBefore(floor)) {
            throw new IllegalArgumentException("Der Verlauf wird " + MAX_DAYS_BACK
                    + " Tage aufbewahrt - weiter zurück liegt nichts mehr vor.");
        }
        return w;
    }

    /**
     * Der Antwort-Deckel. {@code null} = die Vorgabe; ein unplausibler Wert wird
     * abgelehnt, nie still zurechtgebogen.
     */
    public static int limit(Integer raw) {
        if (raw == null) {
            return DEFAULT_LIMIT;
        }
        if (raw < 1 || raw > MAX_LIMIT) {
            throw new IllegalArgumentException(
                    "Es lassen sich zwischen 1 und " + MAX_LIMIT + " Zeilen auf einmal abrufen.");
        }
        return raw;
    }

    /**
     * Der Cursor der Paginierung: „gib mir die jüngsten Zeilen, die bis zu
     * diesem Zeitpunkt begannen".
     *
     * <p><b>⚠ Er vergleicht {@code <=}, nicht {@code <}</b>, und das ist eine
     * Ehrlichkeitsregel: zwei Zeilen dürfen denselben Beginn tragen, und ein
     * striktes Kleiner verlöre die zweite lautlos an der Seitengrenze. Die
     * Fläche mischt die Seiten deshalb über die {@code id} - dieselbe Zeile
     * zweimal zu bekommen ist harmlos, sie einmal zu verlieren nicht.
     */
    public static Instant before(Instant raw, Instant windowEnd) {
        if (raw == null) {
            return windowEnd;
        }
        return raw.isAfter(windowEnd) ? windowEnd : raw;
    }

    private static Set<String> union(Set<String> a, Set<String> b) {
        LinkedHashSet<String> out = new LinkedHashSet<>(a);
        out.addAll(b);
        return Set.copyOf(out);
    }

    private static Set<String> intersect(Set<String> a, Set<String> b) {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        for (String v : a) {
            if (b.contains(v)) {
                out.add(v);
            }
        }
        return Set.copyOf(out);
    }

    /** Nur für Tests + Fehlermeldungen: das Vokabular als sortierte Liste. */
    static List<String> sorted(Set<String> vocabulary) {
        return Arrays.stream(vocabulary.toArray(String[]::new)).sorted().toList();
    }
}
