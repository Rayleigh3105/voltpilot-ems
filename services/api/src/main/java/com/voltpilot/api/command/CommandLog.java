package com.voltpilot.api.command;

import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Die REINEN Regeln des Kommando-Verlaufs (Kommando-Transparenz V1, Konzept
 * {@code vp-kommando-transparenz-k3} §4.2): aus zwei Herzschlag-MOMENTAUFNAHMEN
 * wird eine fortgeschriebene HALTEPERIODE plus - wo wirklich etwas gekippt ist -
 * ein Punkt-Ereignis.
 *
 * <p>Keine Datenbank, kein Spring, keine Uhr aus dem Nichts: jede zeitabhängige
 * Funktion nimmt ihr {@code now} entgegen (das {@code Tagesprotokoll}/
 * {@code FleetPflege}/{@code RuleEvents}-Muster), damit Lücken-Erkennung und
 * Schlüsselvergleich Docker-frei prüfbar sind.
 *
 * <p><b>Warum Perioden statt eines Ereignis-Logs</b> steht ausführlich in der
 * Migration {@code V20260823000000}. Kurz: der Fernsteuerpfad schreibt ~26.500
 * Mal pro Tag und Gerät; ein rohes Log wäre Rauschen, in dem die eine
 * interessante Zeile unauffindbar ist.
 *
 * <p><b>Die fünf Ehrlichkeitsregeln, die diese Datei trägt</b> - sie sind der
 * Grund, warum der Verlauf nichts behaupten kann, das niemand gemessen hat:
 *
 * <ol>
 *   <li><b>Die ERSTE Beobachtung ist kein EREIGNIS.</b> Ohne Vorzustand wird
 *       eine Periode ERÖFFNET (das ist die Beobachtung selbst), aber kein
 *       Punkt-Ereignis geschrieben - sonst meldete jedes frisch angeschlossene
 *       Gerät eine „Freigabe erteilt", die nie stattgefunden hat.</li>
 *   <li><b>Schweigen ist eine Lücke, kein Ende.</b> Bleibt der Herzschlag
 *       länger als {@link #GAP_AFTER} aus, wird die offene Periode an ihrem
 *       LETZTEN belegten Zeitpunkt geschlossen und die Stille als eigenes
 *       Ereignis ({@link #EVENT_LUECKE}) festgehalten - nie bis „jetzt"
 *       weiterbehauptet.</li>
 *   <li><b>Über eine Lücke hinweg wird KEIN Wechsel behauptet.</b> Dass die
 *       Freigabe nach zwei Stunden Stille anders steht, ist eine Beobachtung,
 *       aber kein beobachteter Übergang - der Zeitpunkt wäre erfunden. Die
 *       Lücken-Zeile sagt stattdessen, dass wir nicht hingesehen haben.</li>
 *   <li><b>Der NACHGEFÜHRTE Wert ist bewusst NICHT Teil des Schlüssels</b>
 *       (§4.2 ⚠): er folgt sekündlich dem gemessenen Haus bzw. Überschuss.
 *       Stünde er im Schlüssel, zerfiele jede Viertelstunde in Dutzende
 *       Perioden - das Roh-Log durch die Hintertür. Er reist als
 *       erster/letzter/min/max im Aggregat.</li>
 *   <li><b>Nur gemeldete Wörter.</b> Zustände und Modi kommen unverändert aus
 *       dem Ingest, der ein unbekanntes Wort längst verworfen hat; hier wird
 *       nie eines geraten und nie eines übersetzt.</li>
 * </ol>
 */
public final class CommandLog {

    private CommandLog() {
    }

    /** Die v1-Plattform-Zeitzone (die {@code HistoryRange}-Festlegung). */
    public static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    // -- Die Ströme -----------------------------------------------------------

    /** Der Wechselrichter-Sollwert (Batterie laden/entladen). */
    public static final String STREAM_BATTERIE = "batterie";
    /** Die Einspeise-Begrenzung (PV abregeln). */
    public static final String STREAM_ABREGELUNG = "abregelung";
    /** Steuerbare Verbraucher (Wallbox, Heizstab, Schalter). */
    public static final String STREAM_VERBRAUCHER = "verbraucher";
    /**
     * Das OCPP-Ladeprofil, das die Box einer Ladesäule hinterlegt
     * (Lastmanagement Stufe 3). Eine Periode je SÄULE - der Verlauf ist die
     * Geschichte der zugeteilten Grenze, nicht die der 30-Sekunden-
     * Auffrischungen (die bleiben draussen, wie überall hier).
     */
    public static final String STREAM_LADEPUNKT = "ladepunkt";

    // -- Die Zeilenarten ------------------------------------------------------

    public static final String KIND_PERIODE = "periode";
    public static final String KIND_EREIGNIS = "ereignis";

    // -- Die Herkunft ---------------------------------------------------------

    /** V1: aus dem Herzschlag-Diffing der Cloud abgeleitet. */
    public static final String SOURCE_CLOUD = "cloud_abgeleitet";
    /** Stufe 2: vom Gerät selbst gemeldet (heute nie geschrieben). */
    public static final String SOURCE_GERAET = "geraet";

    // -- Die Rücklese-Urteile (`readback-verify`-Semantik) --------------------

    /** Das Gerät hält, was befohlen wurde. */
    public static final String VERDICT_BESTAETIGT = "bestaetigt";
    /** Das Gerät hält NACHWEISLICH etwas anderes (entprellt, 3× in Folge). */
    public static final String VERDICT_ABWEICHEND = "abweichend";
    /**
     * Das Gerät antwortet nicht (entprellt, 6× in Folge). ⚠ Das ist NICHT
     * {@link #VERDICT_ABWEICHEND} - Schweigen ist eine Lücke, kein bewiesener
     * Defekt (die PR-280-Lehre). V1 kann die beiden aus dem 15-s-Herzschlag
     * nicht trennen und schreibt dieses Wort deshalb NIE; es steht hier für den
     * Präzisions-Uplink (Stufe 2) und ist im Portal-Vokabular schon vorgesehen.
     */
    public static final String VERDICT_KEINE_ANTWORT = "keine_antwort";
    /** Eine Abweichung ist gesehen, aber noch nicht bestätigt (Stufe 2). */
    public static final String VERDICT_PRUEFT = "prueft";
    /** Nicht (mehr) bestätigt, ohne dass die Ursache belegbar wäre. */
    public static final String VERDICT_UNBESTAETIGT = "unbestaetigt";

    /**
     * Die Urteile, die V1 aus dem Herzschlag WIRKLICH ableiten kann. Der
     * Präzisions-Uplink erweitert sie, ohne dass die Fläche sich ändert.
     */
    public static final Set<String> V1_VERDICTS =
            Set.of(VERDICT_BESTAETIGT, VERDICT_ABWEICHEND, VERDICT_UNBESTAETIGT);

    // -- Die Punkt-Ereignisse -------------------------------------------------

    /** Der Not-Aus der Steuerung wurde AKTIV (es wird nichts mehr geschrieben). */
    public static final String EVENT_NOTAUS_EIN = "notaus_ein";
    /** Der Not-Aus wurde aufgehoben. */
    public static final String EVENT_NOTAUS_AUS = "notaus_aus";
    /** Die Steuerung dieses Geräts wurde freigegeben. */
    public static final String EVENT_FREIGABE_ERTEILT = "freigabe_erteilt";
    /** Die Freigabe wurde zurückgenommen. */
    public static final String EVENT_FREIGABE_WIDERRUFEN = "freigabe_widerrufen";
    /** Zwischen zwei Herzschlägen lag Stille - wir haben nicht hingesehen. */
    public static final String EVENT_LUECKE = "luecke";
    /** Der Tages-Deckel hat gegriffen - das Protokoll SAGT das selbst. */
    public static final String EVENT_GEDECKELT = "verlauf_gedeckelt";

    // -- Das WARUM ------------------------------------------------------------

    /** Der Sollwert kommt aus dem Fahrplan. */
    public static final String WHY_FAHRPLAN = "fahrplan";
    /** Die eingebaute Eigenverbrauchs-Sicherung fährt (kein frischer Plan). */
    public static final String WHY_SICHERUNG = "sicherung";

    // -- Zeit + Grenzen -------------------------------------------------------

    /**
     * Die Genauigkeit, die die Fläche NENNEN muss: abgeleitet wird aus dem
     * 15-Sekunden-Herzschlag, ein Wechsel-und-zurück dazwischen ist unsichtbar
     * (§7 „Granularität ehrlich").
     */
    public static final int ACCURACY_SECONDS = 15;

    /**
     * Ab dieser Stille gilt der Verlauf als unterbrochen. Bewusst deutlich über
     * dem 15-s-Takt: ein verpasster oder verzögerter Herzschlag ist Normalbetrieb
     * und darf keine Lücken-Zeile erzeugen.
     */
    public static final Duration GAP_AFTER = Duration.ofMinutes(5);

    /** Aufbewahrung (Captain-Entscheid F3; Begründung in der Migration). */
    public static final Duration RETENTION = Duration.ofDays(90);

    /**
     * Der Tages-Deckel je Anlage. Er schützt die TABELLE vor einem flatternden
     * Gerät und ist bewusst so hoch, dass er im Betrieb nie greift: die
     * erwartete Dichte sind ~130 Zeilen je Gerät und Tag (§4.2). Greift er,
     * schreibt er sich SELBST ins Protokoll, statt still zu kappen.
     */
    public static final int MAX_ROWS_PER_SITE_DAY = 2_000;

    /**
     * Die Genauigkeit, auf die ein Plan-Sollwert für den SCHLÜSSEL gerundet
     * wird. Ohne sie zerlegte numerisches Rauschen eine ruhige Stunde in
     * Perioden; mit 10 W ist jede real unterscheidbare Anweisung noch getrennt.
     */
    private static final double PLAN_KW_STEP = 0.01;

    // -- Die Datensätze -------------------------------------------------------

    /**
     * Was EIN Herzschlag über EINEN Schreibpfad sagt. Alles ausser
     * {@code stream} darf fehlen - ein nicht gemeldetes Feld ist {@code null}
     * und wird nie zu einer 0 gemacht.
     *
     * @param commandedKw der Wert, den das Gerät gerade fährt (nach jeder
     *                    In-Slot-Korrektur) - er reist ins Aggregat, NIE in den
     *                    Schlüssel.
     * @param whyRef      die Referenz, die den Sollwert BEGRÜNDET (der
     *                    Plan-Sollwert des Slots) - sie ist Schlüssel-Mitglied,
     *                    damit eine ruhige Fahrplan-Stunde EINE Periode bleibt.
     */
    public record Observation(String stream, java.util.UUID entityId, String mode, String path,
            String whyKind, String whyRef, Double commandedKw, String verdict,
            Boolean controlEnabled, Boolean released, Boolean foreignInfluence, Detail detail) {
    }

    /**
     * Der Roh-Blick einer Zeile (§2.4). V1 trägt genau das, was der Herzschlag
     * hergibt: Rollen, Zähler, gemeldeter Zustand. Register/Adressen folgen mit
     * dem Präzisions-Uplink; sie hier zu erfinden wäre das Gegenteil des Zwecks.
     */
    public record Detail(String mismatchRoles, String certSource, Integer units,
            Integer certifiedUnits, String state, String reasonCode) {

        public boolean isEmpty() {
            return mismatchRoles == null && certSource == null && units == null
                    && certifiedUnits == null && state == null && reasonCode == null;
        }
    }

    /** Die offene Periode, so wie die Regeln sie brauchen. */
    public record OpenPeriod(long id, String stream, java.util.UUID entityId, Instant startedAt,
            Instant lastSeenAt, String mode, String path, String whyKind, String whyRef,
            String verdict, Boolean controlEnabled, Boolean released, Boolean foreignInfluence) {
    }

    /** Ein anzuhängendes Punkt-Ereignis. */
    public record Event(String eventKind, Instant startedAt, Instant endedAt) {
    }

    /**
     * Was der Schreiber tun soll. Bewusst DEKLARATIV: die Regeln entscheiden,
     * das Repository führt aus - so ist der ganze Entscheidungsbaum Docker-frei
     * prüfbar.
     *
     * @param closeAt  ist er gesetzt, wird die offene Periode DORT geschlossen
     *                 (bei einer Lücke an ihrem letzten belegten Zeitpunkt, bei
     *                 einem Schlüsselwechsel im Moment der Beobachtung).
     * @param openNew  eine neue Periode eröffnen.
     * @param extend   die offene Periode fortschreiben (Aggregat + Frische).
     * @param events   die Punkt-Ereignisse dieser Beobachtung.
     */
    public record Plan(Instant closeAt, boolean openNew, boolean extend, List<Event> events) {
    }

    // -- Die Entscheidung -----------------------------------------------------

    /**
     * Die eine Regel: was folgt aus (offene Periode, Beobachtung, jetzt)?
     *
     * <p>Die Reihenfolge ist bindend: erst die LÜCKE (sie macht jede Aussage
     * über einen Übergang unmöglich), dann der Schlüsselvergleich, dann das
     * Fortschreiben. Wer sie umstellt, behauptet Übergänge über Zeiträume
     * hinweg, in denen niemand hingesehen hat.
     */
    public static Plan decide(OpenPeriod open, Observation now, Instant at) {
        if (open == null) {
            // Regel 1: die erste Beobachtung eröffnet eine Periode, meldet aber
            // keinen Übergang - es gibt kein Vorher, gegen das er entstünde.
            return new Plan(null, true, false, List.of());
        }
        if (isGap(open.lastSeenAt(), at)) {
            // Regel 2 + 3: an der letzten belegten Stelle schliessen, die Stille
            // benennen, neu eröffnen - und KEINEN Wechsel behaupten.
            return new Plan(open.lastSeenAt(), true, false,
                    List.of(new Event(EVENT_LUECKE, open.lastSeenAt(), at)));
        }
        List<Event> events = gateEvents(open, now, at);
        if (sameKey(open, now)) {
            return new Plan(null, false, true, events);
        }
        return new Plan(at, true, false, events);
    }

    /** Ob zwischen zwei Herzschlägen so viel Stille lag, dass sie zählt. */
    public static boolean isGap(Instant lastSeenAt, Instant at) {
        return lastSeenAt != null && at.isAfter(lastSeenAt.plus(GAP_AFTER));
    }

    /**
     * Der SCHLÜSSEL (§4.2). Er umfasst ausdrücklich NICHT den nachgeführten
     * Wert und nicht das Roh-Detail - beide ändern sich laufend, ohne dass sich
     * die AUSSAGE ändert.
     *
     * <p>Die Komponente ist ebenfalls kein Schlüssel-Mitglied: sie wird über die
     * Zuordnung nachgetragen, sobald sie auflösbar ist (der Schreiber hebt sie
     * dann an der laufenden Periode nach), und ein Nachtragen ist kein neuer
     * Betriebszustand.
     */
    public static boolean sameKey(OpenPeriod open, Observation now) {
        return Objects.equals(open.mode(), now.mode())
                && Objects.equals(open.path(), now.path())
                && Objects.equals(open.whyKind(), now.whyKind())
                && Objects.equals(open.whyRef(), now.whyRef())
                && Objects.equals(open.verdict(), now.verdict())
                && Objects.equals(open.controlEnabled(), now.controlEnabled())
                && Objects.equals(open.released(), now.released())
                && Objects.equals(open.foreignInfluence(), now.foreignInfluence());
    }

    /**
     * Die Punkt-Ereignisse eines beobachteten Übergangs: Not-Aus und Freigabe.
     *
     * <p>Sie sind die zwei Zustände, die §4.2 ausdrücklich als „keine Periode"
     * führt - sie beantworten „wer hat wann etwas an der Erlaubnis geändert",
     * während die Perioden „was wurde gefahren" beantworten. Ein Wert, der
     * vorher UNBEKANNT war, erzeugt keines: aus „wir wussten es nicht" wird nie
     * ein Übergang.
     */
    static List<Event> gateEvents(OpenPeriod open, Observation now, Instant at) {
        List<Event> out = new ArrayList<>(2);
        if (flipped(open.controlEnabled(), now.controlEnabled())) {
            out.add(new Event(Boolean.TRUE.equals(now.controlEnabled())
                    ? EVENT_NOTAUS_AUS : EVENT_NOTAUS_EIN, at, at));
        }
        if (flipped(open.released(), now.released())) {
            out.add(new Event(Boolean.TRUE.equals(now.released())
                    ? EVENT_FREIGABE_ERTEILT : EVENT_FREIGABE_WIDERRUFEN, at, at));
        }
        return out;
    }

    private static boolean flipped(Boolean was, Boolean is) {
        return was != null && is != null && !was.equals(is);
    }

    // -- Die Urteils-Ableitungen ----------------------------------------------

    /**
     * Das Batterie-Urteil aus dem Herzschlag. Die Edge NENNT die abweichenden
     * Register erst, wenn die Abweichung ENTPRELLT ist ({@code applyControlConfirm}
     * löscht sie in jedem anderen Zustand) - eine nicht-leere Rollen-Liste ist
     * also der Beleg für eine BESTÄTIGTE Abweichung. Ohne sie bleibt es beim
     * ehrlichen {@code unbestaetigt}: aus 15-Sekunden-Momentaufnahmen lässt sich
     * „keine Antwort" nicht von „prüft gerade" trennen.
     */
    public static String batteryVerdict(boolean allMatch, String mismatchRoles) {
        if (allMatch) {
            return VERDICT_BESTAETIGT;
        }
        return blank(mismatchRoles) ? VERDICT_UNBESTAETIGT : VERDICT_ABWEICHEND;
    }

    /**
     * Das Abregel-Urteil. ⚠ {@code null} heisst „nichts angewandt" und ist NICHT
     * „das Rücklesen widersprach" - nur {@code TRUE} ist eine Bestätigung
     * (dieselbe Dreiwertigkeit wie in {@code device_curtailment_status}).
     */
    public static String curtailVerdict(Boolean allMatch, boolean active) {
        if (!active) {
            return null; // nichts angewandt - es gibt nichts zu bestätigen
        }
        if (allMatch == null) {
            return VERDICT_UNBESTAETIGT;
        }
        return allMatch ? VERDICT_BESTAETIGT : VERDICT_ABWEICHEND;
    }

    /**
     * Das Verbraucher-Urteil. {@code null} = das Gerät hat sich zur Ausführung
     * nicht geäussert; das bleibt eine Lücke, nie ein Widerspruch.
     */
    public static String consumerVerdict(Boolean confirmed) {
        if (confirmed == null) {
            return null;
        }
        return confirmed ? VERDICT_BESTAETIGT : VERDICT_UNBESTAETIGT;
    }

    /**
     * Die Plan-Referenz des Schlüssels: der Sollwert VOR jeder In-Slot-Korrektur,
     * gerundet. Ohne gemeldeten Modus fällt sie auf den kommandierten Wert
     * zurück (ein älterer Edge-Stand meldet keine Korrektur, also IST er der
     * Plan-Wert).
     *
     * <p><b>Die Sicherung hat bewusst keine Referenz:</b> ihr Wert folgt
     * PV minus Last und ändert sich laufend - stünde er im Schlüssel, entstünde
     * je Messung eine Periode.
     */
    public static String planRef(String mode, Double commandedKw, Double plannedKw) {
        if (WHY_SICHERUNG.equals(mode) || "fallback".equals(mode)) {
            return null;
        }
        Double ref = plannedKw != null ? plannedKw : commandedKw;
        if (ref == null || !Double.isFinite(ref)) {
            return null;
        }
        double rounded = Math.round(ref / PLAN_KW_STEP) * PLAN_KW_STEP;
        return String.format(java.util.Locale.ROOT, "%.2f", rounded);
    }

    /** Der Beginn des laufenden Berliner Kalendertages (der Deckel-Rahmen). */
    public static Instant berlinDayStart(Instant now) {
        return now.atZone(ZONE).toLocalDate().atStartOfDay(ZONE).toInstant();
    }

    /**
     * <b>DIE KONVENTION DES FENSTERS: eine Zeile gehört zum Tag ihres STARTS.</b>
     *
     * <p>Der Anlass (19.08.2026): der „Heute"-Tab begann um 17:26 mit dem Slot
     * „23:45–00:00" - der letzten Viertelstunde des VORTAGS. Sie geriet auf zwei
     * Wegen hinein, und beide sind mit dieser einen Regel erschlagen: die
     * Fenster-Abfrage nahm eine Periode, die GENAU auf {@code from} endete
     * (halb-offenes Fenster falsch abgebildet: {@code >=} statt {@code >}), und
     * sie nahm die reale Überlappung von wenigen Sekunden, mit der jede
     * Mitternachts-Periode in den Folgetag hineinragt - der Optimierer wechselt
     * den Plan-Sollwert um 00:00, geschlossen wird sie erst vom NÄCHSTEN
     * Herzschlag.
     *
     * <p><b>Diese Methode ist die Untergrenze, ab der eine VOR dem Fenster
     * begonnene Periode noch in das Fenster gehört</b> - nämlich dann, wenn sie
     * dort mindestens einen Herzschlag lang wirklich in Kraft war. Der Abstand
     * ist deshalb {@link #ACCURACY_SECONDS}: das ist die Auflösung, mit der
     * dieser Verlauf überhaupt beobachtet wird und die die Fläche dem Kunden
     * NENNT. Eine Periode, deren ganze Anwesenheit im Tag kürzer ist als ein
     * einziger Herzschlag, ist nach dem eigenen Massstab dieses Features keine
     * Aussage über diesen Tag.
     *
     * <p><b>Nicht ersetzt wird damit die Überlappung selbst</b>: eine Periode,
     * die um 22:00 des Vortags begann und heute um 06:00 endet, war heute
     * stundenlang in Kraft und MUSS sichtbar bleiben - sonst begänne der Film
     * mit einem unerklärten Loch, und ein Tag, an dem gar nichts umschaltet,
     * behauptete „es wurde nichts geschickt". Sie ist bloss als das kenntlich zu
     * machen, was sie ist (die Fläche stellt ihr Datum voran).
     *
     * <p>Der Tages-Deckel zählt seit jeher nach {@code started_at}
     * ({@code CommandLogRepository.countSince}); genau diese Asymmetrie zur
     * Leseroute war der Fehler.
     */
    public static Instant carryInAfter(Instant windowStart) {
        return windowStart.plusSeconds(ACCURACY_SECONDS);
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
