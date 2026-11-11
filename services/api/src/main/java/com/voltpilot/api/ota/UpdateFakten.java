package com.voltpilot.api.ota;

import java.time.Instant;

/**
 * Die DREI Fakten einer Zuweisung, nie vermischt (Geräte &amp; Updates G2):
 * <b>angefragt</b> (das Portal hat das Release zugewiesen), <b>angenommen</b>
 * (die Box hat es geprüft und übernommen) und <b>bestätigt</b> (die Box fährt
 * es, Selbsttest grün) - jeder mit seinem eigenen Zeitpunkt.
 *
 * <p>Bis hierher kannte die Seite nur EINEN gemischten Zustand
 * ({@link RolloutStates}): ob eine Box eine Anfrage noch nicht gesehen, schon
 * abgelehnt oder angenommen und gerade im Selbsttest hatte, war daraus nicht
 * abzulesen, und das Prüfurteil der Box ({@code target_verdict}) erreichte das
 * Portal nie. Die Plattform-Regel bleibt: die Cloud fragt an, die Box entscheidet
 * und bestätigt - Anfrage, Annahme und Ergebnis sind drei verschiedene Aussagen.
 *
 * <p><b>Zugeordnet wird nur, was die Box zu GENAU dieser Anfrage meldet:</b> ihr
 * gemeldetes Ziel ist das angefragte Release, oder sie fährt es schon. Ein
 * Urteil oder ein Fehlschlag zu einem früheren Ziel gilt für die neue Anfrage
 * nicht. Eine Box, die sich nicht meldet, „wartet" (die Anfrage liegt retained
 * beim Broker) - das ist nie „abgelehnt".
 *
 * <p>Zeitpunkte sind Serverzeit ({@code device_update_target.assigned_at},
 * {@code device_update_status.target_verdict_at}/{@code current_since}); fehlt
 * einer, ist er unbekannt ({@code null}) und wird nicht geraten.
 *
 * <p>Rein, ohne DB und ohne Umgebungs-Uhr - {@code now} kommt herein.
 */
public final class UpdateFakten {

    /** Angenommen/bestätigt: ja. */
    public static final String JA = "ja";
    /** Noch nicht geschehen, die Box ist erreichbar. */
    public static final String OFFEN = "offen";
    /** Angenommen: die Box meldet sich nicht; die Anfrage wartet beim Broker. */
    public static final String WARTET = "wartet";
    /** Angenommen: die Box hat die Anfrage abgelehnt (Prüfurteil {@code rejected}). */
    public static final String ABGELEHNT = "abgelehnt";
    /** Angenommen: die Box stellt die Anfrage zurück (Prüfurteil {@code deferred}). */
    public static final String ZURUECKGESTELLT = "zurueckgestellt";
    /** Bestätigt: die Box ist dabei (laden, anwenden, Selbsttest). */
    public static final String LAEUFT = "laeuft";
    /** Bestätigt: das Anwenden ist fehlgeschlagen. */
    public static final String FEHLGESCHLAGEN = "fehlgeschlagen";
    /** Bestätigt: die Box hat das Release angewandt und selbst zurückgenommen. */
    public static final String ZURUECKGENOMMEN = "zurueckgenommen";
    /** Bestätigt: die Box hat den Beginn der Anwendung gemeldet und schweigt seitdem. */
    public static final String VERSTUMMT = "verstummt";

    /** Der Zwischenschritt, solange {@link #LAEUFT}: Release laden. */
    public static final String SCHRITT_LAEDT = "laedt";
    /** Der Zwischenschritt: Release anwenden. */
    public static final String SCHRITT_WENDET_AN = "wendet_an";
    /** Der Zwischenschritt: Selbsttest der neuen Fassung. */
    public static final String SCHRITT_SELBSTTEST = "selbsttest";

    private UpdateFakten() {
    }

    /** Die Zuweisung, wie das Portal sie gesetzt hat ({@code device_update_target}). */
    public record Anfrage(String release, long releaseSeq, Instant am, String von) {
    }

    /**
     * Was die Box gemeldet hat ({@code device_update_status}).
     *
     * @param ziel          das gemeldete Ziel ({@code update.target})
     * @param urteil        ihr Prüfurteil dazu ({@code ok}, {@code deferred}, {@code rejected})
     * @param urteilSeit    seit wann dieses Urteil zu diesem Ziel gilt
     * @param laeuft        der laufende Stempel ({@code update.current}, sonst {@code version})
     * @param laeuftSeit    seit wann dieser Stempel läuft
     * @param zustand       {@code update.state} (Vertrags-Vokabular)
     * @param grund         {@code update.reason}
     * @param lebenszeichen das letzte Lebenszeichen ({@link RolloutStates#lebenszeichen})
     */
    public record Meldung(String ziel, String urteil, Instant urteilSeit, String laeuft,
            Instant laeuftSeit, String zustand, String grund, Instant lebenszeichen) {
    }

    /** Angefragt (Portal). */
    public record Angefragt(String release, long releaseSeq, Instant am, String von) {
    }

    /** Angenommen (Box): {@link #JA}, {@link #OFFEN}, {@link #WARTET}, {@link #ABGELEHNT}, {@link #ZURUECKGESTELLT}. */
    public record Angenommen(String stand, Instant am, String grund) {
    }

    /**
     * Bestätigt (Box): {@link #JA}, {@link #OFFEN}, {@link #LAEUFT} (mit
     * {@code schritt}), {@link #FEHLGESCHLAGEN}, {@link #ZURUECKGENOMMEN},
     * {@link #VERSTUMMT}.
     */
    public record Bestaetigt(String stand, Instant am, String schritt, String grund) {
    }

    /** Die drei Fakten einer Anfrage. */
    public record Fakten(Angefragt angefragt, Angenommen angenommen, Bestaetigt bestaetigt) {
    }

    /**
     * Die drei Fakten zu einer Anfrage.
     *
     * @return {@code null}, wenn es keine Anfrage gibt (ohne Anfrage gibt es nichts
     *         anzunehmen oder zu bestätigen)
     */
    public static Fakten of(Anfrage anfrage, Meldung m, Instant now) {
        if (anfrage == null || anfrage.release() == null) {
            return null;
        }
        Angefragt angefragt = new Angefragt(anfrage.release(), anfrage.releaseSeq(), anfrage.am(),
                anfrage.von());
        boolean laeuftZiel = m != null
                && RolloutStates.releaseIsRunning(anfrage.release(), m.laeuft());
        boolean kenntZiel = m != null && m.ziel() != null
                && anfrage.release().equals(m.ziel().trim());
        boolean stumm = m == null || m.lebenszeichen() == null
                || RolloutStates.offline(m.lebenszeichen(), now);
        String urteil = kenntZiel ? m.urteil() : null;
        String zustand = (kenntZiel || laeuftZiel) ? m.zustand() : null;

        Angenommen angenommen;
        if (laeuftZiel) {
            angenommen = new Angenommen(JA, "ok".equals(urteil) ? m.urteilSeit() : m.laeuftSeit(), null);
        } else if ("ok".equals(urteil)) {
            angenommen = new Angenommen(JA, m.urteilSeit(), null);
        } else if ("rejected".equals(urteil)) {
            angenommen = new Angenommen(ABGELEHNT, m.urteilSeit(), grund(m,
                    "Die Box konnte die Signatur des Releases nicht prüfen."));
        } else if ("deferred".equals(urteil)) {
            angenommen = new Angenommen(ZURUECKGESTELLT, m.urteilSeit(), grund(m,
                    "Das Release gilt für diese Box nicht."));
        } else if (stumm) {
            angenommen = new Angenommen(WARTET, null, null);
        } else {
            angenommen = new Angenommen(OFFEN, null, null);
        }

        Bestaetigt bestaetigt;
        if (ABGELEHNT.equals(angenommen.stand()) || ZURUECKGESTELLT.equals(angenommen.stand())
                || zustand == null && !laeuftZiel) {
            // Nichts angewandt: die Box hat nicht angenommen oder noch nichts zu
            // dieser Anfrage gemeldet.
            bestaetigt = new Bestaetigt(OFFEN, null, null, null);
        } else if ("rolled_back".equals(zustand)) {
            // Der laufende Stempel wechselte mit der Rücknahme - sein Zeitpunkt
            // ist der der Rücknahme.
            bestaetigt = new Bestaetigt(ZURUECKGENOMMEN, m.laeuftSeit(), null, grund(m,
                    "Die Box hat das Release angewandt und selbst zurückgenommen."));
        } else if ("failed".equals(zustand)) {
            bestaetigt = new Bestaetigt(FEHLGESCHLAGEN, null, null, grund(m,
                    "Die Box meldet einen fehlgeschlagenen Update-Versuch."));
        } else if ("applying".equals(zustand) && m.lebenszeichen() != null
                && m.lebenszeichen().isBefore(now.minus(RolloutStates.SILENT_APPLYING_AFTER))) {
            bestaetigt = new Bestaetigt(VERSTUMMT, null, SCHRITT_WENDET_AN,
                    "Die Box hat den Beginn der Anwendung gemeldet und sich seitdem nicht mehr gemeldet.");
        } else if (schritt(zustand) != null) {
            bestaetigt = new Bestaetigt(LAEUFT, null, schritt(zustand), m.grund());
        } else if (laeuftZiel) {
            bestaetigt = new Bestaetigt(JA, m.laeuftSeit(), null, null);
        } else {
            bestaetigt = new Bestaetigt(OFFEN, null, null, null);
        }
        return new Fakten(angefragt, angenommen, bestaetigt);
    }

    /** Der Zwischenschritt eines Vertrags-Zustands, sonst {@code null}. */
    static String schritt(String zustand) {
        if (zustand == null) {
            return null;
        }
        return switch (zustand) {
            case "downloading" -> SCHRITT_LAEDT;
            case "applying" -> SCHRITT_WENDET_AN;
            case "self_test" -> SCHRITT_SELBSTTEST;
            default -> null;
        };
    }

    private static String grund(Meldung m, String fallback) {
        return m != null && m.grund() != null && !m.grund().isBlank() ? m.grund() : fallback;
    }
}
