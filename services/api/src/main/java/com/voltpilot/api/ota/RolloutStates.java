package com.voltpilot.api.ota;

import java.time.Duration;
import java.time.Instant;

/**
 * Die EINE Ableitung „was ist mit diesem Gerät gerade los" - rein, ohne DB,
 * ohne Broker, ohne Uhr aus der Umgebung (jede zeitabhängige Methode bekommt
 * {@code now} übergeben). Das ist das {@code Tagesprotokoll}/{@code
 * SlotEconomics}-Muster: eine Regel, die eine Behauptung über eine Kundenanlage
 * erzeugt, gehört an EINE Stelle und wird Docker-frei festgenagelt.
 *
 * <h2>Die Ehrlichkeitsregeln (Scout §7, wörtlich übernommen)</h2>
 * <ul>
 *   <li><b>„unbekannt" ist nie „veraltet".</b> Ein Gerät, das keinen
 *       {@code update}-Block meldet, sagt nichts über sein Alter - eine
 *       Oberfläche, die daraus „veraltet" macht, erfindet einen Zustand.</li>
 *   <li><b>„offline" ist nie „fehlgeschlagen".</b> Ein Gerät hinter NAT ist
 *       regelmäßig weg; die Zuweisung liegt retained auf dem Broker und wird
 *       nachgeholt. Das ist der Normalfall einer Verteilung, kein Vorfall.</li>
 *   <li><b>Jede rote Zeile trägt ihren Grund.</b> Jeder nicht-grüne Zustand
 *       hier hat eine {@code reason}-Quelle: entweder den deutschen Grund des
 *       Geräts oder einen, den diese Klasse formuliert.</li>
 *   <li><b>„im Update verstummt" existiert nur, weil {@code applying} DURABEL
 *       vor dem Stoppen gemeldet wird.</b> Ohne diese Vorarbeit wäre es von
 *       „das Gerät ist einfach weg" nicht zu unterscheiden - und genau das
 *       wäre der teuerste blinde Fleck einer Verteilung.</li>
 * </ul>
 */
public final class RolloutStates {

    /**
     * Das Portal-Vokabular je Gerät (§7.2). {@code ZURUECKGESTELLT} ist die
     * eine Ergänzung der Stufe 2: der Scout schrieb die Maschine für den
     * AUTONOMEN Fall, in dem ein Gerät nach der Prüfung sofort weitermacht -
     * ein Politik-Halt (Anti-Rollback-Boden, falsches Backend) ist weder
     * ausstehend noch fehlgeschlagen und darf nicht als eines von beidem
     * erscheinen.
     */
    public static final String AKTUELL = "aktuell";
    public static final String AUSSTEHEND = "ausstehend";
    /**
     * <b>„Sie sind dran"</b> - das Gerät hat das zugewiesene Release GEPRÜFT
     * und wartet auf das beaufsichtigte Anwenden durch einen Menschen (OTA
     * Stufe 2: {@code state=deferred ∧ target_verdict=ok}).
     *
     * <p>Er trennt den einen Fall, in dem der ADMIN der fehlende Akteur ist,
     * von „die Zuweisung ist unterwegs" - bis hierher fielen beide in
     * {@link #AUSSTEHEND} und trugen damit denselben Fortschritts-Ton, obwohl
     * sich ohne eine Handlung nie wieder etwas bewegt (Reibung R1 des
     * UX-Deep-Dives {@code vp-admin-geraete-ux-k2}). Die Unterscheidung war
     * schon maschinenlesbar angelegt - sie wurde nur nicht ausgespielt.
     *
     * <p>Er hält den Rollout NICHT an (es ist kein Vorfall) und zählt NICHT
     * als bestätigt (die Welle wartet wirklich).
     */
    public static final String WARTET_AUF_ANWENDUNG = "wartet_auf_anwendung";
    /**
     * <b>Autonomie blockiert</b> - das Gerät meldet eine STEHENDE Sperre
     * ({@code otaapply.Blocker*}: Neutral-Zeit, Platte, Interlock, stiller
     * Kern, …). Signatur und Politik sind in Ordnung, aber das Gerät DARF
     * gerade nicht anwenden.
     *
     * <p>Wie {@link #ZURUECKGESTELLT} ist das kein Vorfall und hält keine
     * Verteilung an - aber es ist auch kein Fortschritt, und genau so darf es
     * nie wieder aussehen. Der Grund kommt vom Gerät (es weiß, warum es nicht
     * anwendet), der maschinenlesbare Name aus {@code Reported.blocker}.
     */
    public static final String BLOCKIERT = "blockiert";
    public static final String LAEDT = "laedt";
    public static final String WENDET_AN = "wendet_an";
    public static final String SELBSTTEST = "selbsttest";
    public static final String BESTAETIGT = "bestaetigt";
    public static final String ZURUECKGEROLLT = "zurueckgerollt";
    public static final String OFFLINE_HOLT_NACH = "offline_holt_nach";
    public static final String IM_UPDATE_VERSTUMMT = "im_update_verstummt";
    public static final String FEHLGESCHLAGEN = "fehlgeschlagen";
    public static final String ZURUECKGESTELLT = "zurueckgestellt";
    public static final String UNBEKANNT = "unbekannt";

    /**
     * Wie lange ein Gerät stumm sein darf, bevor es als offline gilt. Dasselbe
     * Fenster wie überall im Haus (Overview/Fleet/{@code api.ts}) - eine
     * zweite Lebendigkeits-Definition wäre eine zweite Wahrheit.
     */
    public static final Duration OFFLINE_AFTER = Duration.ofMinutes(5);

    /**
     * Wie lange ein Gerät im Zustand {@code applying} stumm sein darf, bevor es
     * „im Update verstummt" heißt. Ein Anwenden (Pull + Neustart) dauert
     * Minuten, nicht Sekunden - deshalb bewusst deutlich weiter als das
     * Offline-Fenster, sonst wäre jeder normale Neustart ein Alarm.
     */
    public static final Duration SILENT_APPLYING_AFTER = Duration.ofMinutes(20);

    private RolloutStates() {
    }

    /**
     * Das gemeldete IST eines Geräts, so weit es die Cloud kennt.
     *
     * <p>{@code blocker} ist der maschinenlesbare Name einer STEHENDEN Sperre
     * ({@code otaapply.Blocker*}); {@code null} heißt „keine gemeldet" und ist
     * ausdrücklich NICHT „nicht blockiert" - ein älterer Edge-Stand meldet das
     * Feld gar nicht. Deshalb wird aus seiner Abwesenheit nie etwas abgeleitet,
     * nur aus seiner Anwesenheit.
     */
    public record Reported(String version, String current, String target, String state,
            String verdict, String reason, String blocker, Instant reportedAt,
            Instant lastSeenAt) {

        /** Der Vor-Blocker-Aufrufweg: ein Gerät, das keine Sperre meldet. */
        public Reported(String version, String current, String target, String state,
                String verdict, String reason, Instant reportedAt, Instant lastSeenAt) {
            this(version, current, target, state, verdict, reason, null, reportedAt, lastSeenAt);
        }
    }

    /** Das abgeleitete Urteil: Zustand + (bei jedem nicht-grünen) sein Grund. */
    public record Verdict(String state, String reason) {
    }

    /**
     * Der Zustand EINES Geräts gegen sein zugewiesenes Release.
     *
     * @param assignedRelease das zugewiesene Release, {@code null} = keine
     *                        Zuweisung (dann kann nur „aktuell" oder
     *                        „unbekannt" herauskommen - ohne Soll gibt es
     *                        keinen Fortschritt zu behaupten).
     */
    public static Verdict derive(String assignedRelease, Reported r, Instant now) {
        boolean everReported = r != null && (r.version() != null || r.state() != null);
        if (!everReported) {
            return new Verdict(UNBEKANNT,
                    "Dieses Gerät hat noch keinen Software-Stand gemeldet.");
        }

        String running = r.current() != null ? r.current() : r.version();
        boolean isTarget = assignedRelease != null && releaseIsRunning(assignedRelease, running);

        // Ein Endzustand, den das Gerät MELDET, gilt auch dann, wenn es danach
        // still wurde: ein „fehlgeschlagen" verschwindet nicht dadurch, dass
        // niemand mehr zuhört.
        if ("failed".equals(r.state())) {
            return new Verdict(FEHLGESCHLAGEN, reasonOr(r,
                    "Das Gerät meldet einen fehlgeschlagenen Update-Versuch."));
        }
        if ("rolled_back".equals(r.state())) {
            return new Verdict(ZURUECKGEROLLT, reasonOr(r,
                    "Das Gerät ist auf seinen vorherigen Stand zurückgerollt."));
        }

        boolean silent = r.reportedAt() == null
                || r.reportedAt().isBefore(now.minus(OFFLINE_AFTER));

        if ("applying".equals(r.state())) {
            if (r.reportedAt() != null
                    && r.reportedAt().isBefore(now.minus(SILENT_APPLYING_AFTER))) {
                // DER Zustand, für den `applying` durabel vor dem Stoppen
                // gemeldet wird: ein Gerät, das MITTEN im Anwenden verstummt,
                // ist etwas anderes als eines, das einfach offline ist.
                return new Verdict(IM_UPDATE_VERSTUMMT,
                        "Das Gerät hat den Beginn der Anwendung gemeldet und sich seitdem "
                                + "nicht mehr gemeldet.");
            }
            return new Verdict(WENDET_AN, r == null ? null : r.reason());
        }

        if (silent) {
            if (isTarget) {
                // Es hat den Soll-Stand erreicht und ist danach still geworden -
                // das ist kein offener Rollout-Punkt.
                return new Verdict(BESTAETIGT, null);
            }
            return new Verdict(OFFLINE_HOLT_NACH,
                    "Das Gerät meldet sich gerade nicht. Die Zuweisung liegt beim Broker "
                            + "bereit und wird beim nächsten Verbindungsaufbau abgeholt.");
        }

        if ("downloading".equals(r.state())) {
            return new Verdict(LAEDT, r.reason());
        }
        if ("self_test".equals(r.state())) {
            return new Verdict(SELBSTTEST, r.reason());
        }
        if (isTarget) {
            return new Verdict(BESTAETIGT, null);
        }
        if (assignedRelease == null) {
            return new Verdict(AKTUELL, null);
        }
        // Ab hier: es GIBT ein Soll, das Gerät fährt es noch nicht, und es ist
        // erreichbar. Sein eigenes Prüfurteil entscheidet, WAS das heißt.
        if ("rejected".equals(r.verdict())) {
            return new Verdict(FEHLGESCHLAGEN, reasonOr(r,
                    "Das Gerät konnte die Signatur des zugewiesenen Releases nicht prüfen."));
        }
        if ("deferred".equals(r.verdict())) {
            return new Verdict(ZURUECKGESTELLT, reasonOr(r,
                    "Das zugewiesene Release gilt für dieses Gerät nicht."));
        }
        // Eine STEHENDE Sperre schlägt „wartet auf Sie": auf einer blockierten
        // Box wartet niemand auf den Admin - sie darf gar nicht anwenden, und
        // ein Klick würde daran nichts ändern.
        if (isBlocked(r)) {
            return new Verdict(BLOCKIERT, reasonOr(r,
                    "Dieses Gerät meldet eine Sperre, aber keinen Grund dazu."));
        }
        // „Sie sind dran": geprüft und in Ordnung, das Anwenden ist beaufsichtigt.
        if ("deferred".equals(r.state()) && "ok".equals(r.verdict())) {
            return new Verdict(WARTET_AUF_ANWENDUNG, reasonOr(r,
                    "Das Release ist auf diesem Gerät verifiziert und wartet auf das "
                            + "beaufsichtigte Anwenden."));
        }
        return new Verdict(AUSSTEHEND, r.reason());
    }

    /**
     * Löst der Zustand einen AUTO-HALT aus? (D4: jeder {@code failed} /
     * {@code rolled_back} / „im Update verstummt" hält die Verteilung an.)
     *
     * <p>Bewusst NICHT dabei: {@code offline_holt_nach} (der Normalfall hinter
     * NAT) und {@code zurueckgestellt} (eine Politik-Entscheidung, kein
     * Vorfall) - ein Auto-Halt bei einer offline gegangenen Box würde jeden
     * Rollout am ersten Funkloch beenden.
     */
    public static boolean haltsRollout(String state) {
        return FEHLGESCHLAGEN.equals(state) || ZURUECKGEROLLT.equals(state)
                || IM_UPDATE_VERSTUMMT.equals(state);
    }

    /** Zustände, die für die Wellen-Freigabe als abgeschlossen zählen. */
    public static boolean isConfirmed(String state) {
        return BESTAETIGT.equals(state);
    }

    /**
     * Die {@code IsRunning}-Regel des Geräts, hier gespiegelt: edge-images
     * stempelt bei Tag-Builds {@code <tag>-<kurzsha>}, also zählt sowohl die
     * nackte Gleichheit als auch das Tag mit angehängter SHA.
     *
     * <p>Der Zwilling ist {@code otaverify.ReleaseIsRunning} im Go-Core - die
     * beiden dürfen nicht auseinanderlaufen (das refCheckChar/EdgeRef-Muster),
     * sonst beantworten Gerät und Portal „läuft das schon?" verschieden.
     */
    public static boolean releaseIsRunning(String release, String stamped) {
        if (release == null || stamped == null) {
            return false;
        }
        String s = stamped.trim();
        return s.equals(release) || s.startsWith(release + "-");
    }

    /**
     * Der Satzanfang, mit dem der Sidecar JEDE stehende Sperre einleitet
     * ({@code otaapply.BlockedPrefix}, PR #331 - dort ausdrücklich als „die EINE
     * Formulierung" gebaut, damit „wartet" und „blockiert" nirgends gleich
     * aussehen). Der Go-Zwilling ist die Konstante selbst; die beiden dürfen
     * nicht auseinanderlaufen (das refCheckChar/EdgeRef-Muster).
     *
     * <p><b>Er ist der ÜBERGANG, nicht die Regel.</b> Die dauerhafte Antwort ist
     * das maschinenlesbare {@code blocker}-Feld - aber die heutige Flotte fährt
     * Stände, die es noch nicht senden, und für sie wäre „wartet auf Anwendung"
     * die falscheste aller Aussagen: dort wartet niemand auf den Admin. Sobald
     * eine Box das Feld meldet, entscheidet es allein; diese Prüfung greift dann
     * gar nicht mehr, weil sie nach ihm kommt.
     */
    public static final String BLOCKED_PREFIX = "Autonomie blockiert: ";

    /**
     * Meldet dieses Gerät eine stehende Sperre? Erst der maschinenlesbare Name,
     * dann - für ältere Stände - der gepinnte Satzanfang. Die ABWESENHEIT von
     * beidem sagt nichts, aus ihr wird nie „läuft" abgeleitet.
     */
    private static boolean isBlocked(Reported r) {
        if (r.blocker() != null && !r.blocker().isBlank()) {
            return true;
        }
        return r.reason() != null && r.reason().startsWith(BLOCKED_PREFIX);
    }

    private static String reasonOr(Reported r, String fallback) {
        return r != null && r.reason() != null && !r.reason().isBlank() ? r.reason() : fallback;
    }
}
