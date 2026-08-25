package com.voltpilot.api.interventions;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;

/**
 * Die REINEN Regeln des Handeingriffs (Steuerung Stufe 4, Konzept
 * `vp-steuerung-konzept-b3` §3.2 + §3.7 B2/B4/B6, Captain-Entscheid S1 = A) -
 * Docker-frei geprüft wie `Tagesprotokoll`/`FleetPflege`/`RolloutStates`; jede
 * zeitabhängige Funktion nimmt ihr {@code now}.
 *
 * <p>Der Kern ist EINE Aussage: <b>„Speicher halten" und „Speicher jetzt laden"
 * brauchen KEIN neues Kommando.</b> Halten ist {@code setpoint_kw = 0} (der
 * Speicher lädt und entlädt nicht), Laden ist ein positiver
 * {@code setpoint_kw} - beides existiert seit E1a im Kommando-Vokabular, reist
 * über den BESTEHENDEN {@code v2/desired}-Weg und wird auf dem Gerät durch die
 * BESTEHENDE Guard-Kette geklemmt.
 *
 * <p><b>⚠ Die EEG-Regel bleibt strukturell, nicht als Zusage:</b> ob beim
 * „jetzt laden" aus dem NETZ geladen werden darf, entscheidet nicht die Cloud,
 * sondern {@code guards.Clamp} auf der Box gegen die Registry-Angabe
 * {@code charge_from_grid_allowed} (D-8: abwesend/false = nur Solar). Sie bindet
 * dort für JEDEN Halter - also auch für einen Handeingriff. Deshalb gibt es hier
 * kein Feld dafür und keinen Weg, sie zu umgehen.
 *
 * <p><b>Was es AUSDRÜCKLICH nicht gibt:</b> „nicht unter X % entladen". Das
 * bräuchte ein neues Kommando (SoC-Boden in D-14) und war Variante B des
 * Entscheids S1 - der Captain hat A gewählt.
 */
public final class Handeingriff {

    /** Die Vokabeln, die eine Anfrage tragen darf. */
    public static final String HALTEN = "speicher_halten";
    public static final String LADEN = "speicher_laden";
    public static final String PAUSE = "pause";

    /**
     * Die kürzeste Dauer, die angeboten wird (§3.2). Kürzer ist kein Eingriff,
     * sondern ein Zucken - und der nächste Fahrplan-Takt käme ohnehin dazwischen.
     */
    public static final Duration MIN_DAUER = Duration.ofMinutes(15);

    /**
     * ⚠ Die Kappe des ARBITERS (D-5 {@code OverrideTTLCap} = 4 h) - nicht die
     * des Eingriffs. Ein längerer Eingriff wird cloud-seitig ERNEUERT (B6), der
     * gesendete TTL bleibt darunter. Wer hier etwas ändert, ändert
     * `edge-app/core/internal/desired/desired.go` mit.
     */
    public static final Duration TTL_KAPPE = Duration.ofHours(4);

    /**
     * Ab wann ein laufender Eingriff neu ausgesendet wird (B6). Deutlich unter
     * {@link #TTL_KAPPE}, damit ein verlorener Takt den Wunsch nicht verfallen
     * lässt: die Box hält ihn 4 h, wir frischen nach 3 h auf.
     */
    public static final Duration ERNEUERN_NACH = Duration.ofHours(3);

    /** Die längste Dauer, die ein Eingriff überhaupt haben darf. */
    public static final Duration MAX_DAUER = Duration.ofHours(24);

    private Handeingriff() {
    }

    /** Was der Kunde gewählt hat, roh aus dem Rumpf. */
    public record Anfrage(String kind, Integer durationMinutes, Instant endsAt,
            BigDecimal setpointKw) {}

    /** Warum eine Anfrage nicht ausgeführt wird - IMMER mit deutschem Grund. */
    public static final class Abgelehnt extends RuntimeException {
        public Abgelehnt(String message) {
            super(message);
        }
    }

    /** Kennt dieses Haus die Art? */
    public static boolean bekannt(String kind) {
        return HALTEN.equals(kind) || LADEN.equals(kind) || PAUSE.equals(kind);
    }

    /** Betrifft die Art den Speicher (statt der ganzen Anlage)? */
    public static boolean istSpeicher(String kind) {
        return HALTEN.equals(kind) || LADEN.equals(kind);
    }

    /**
     * Das Ende des Eingriffs. Eine Dauer ist PFLICHT (§3.2: „ein Eingriff läuft
     * nie unbegrenzt") - es gibt hier bewusst keinen Vorgabewert, weil eine
     * geratene Dauer eine Aussage über eine Kundenanlage wäre.
     */
    public static Instant ende(Anfrage a, Instant now) {
        Instant ende;
        if (a != null && a.endsAt() != null) {
            ende = a.endsAt();
        } else if (a != null && a.durationMinutes() != null && a.durationMinutes() > 0) {
            ende = now.plus(Duration.ofMinutes(a.durationMinutes()));
        } else {
            throw new Abgelehnt("Bitte eine Dauer oder eine Endzeit angeben - ein Eingriff "
                    + "läuft nie unbegrenzt.");
        }
        if (!ende.isAfter(now)) {
            throw new Abgelehnt("Die Endzeit muss in der Zukunft liegen.");
        }
        Duration dauer = Duration.between(now, ende);
        if (dauer.compareTo(MIN_DAUER) < 0) {
            throw new Abgelehnt("Ein Eingriff dauert mindestens "
                    + MIN_DAUER.toMinutes() + " Minuten.");
        }
        if (dauer.compareTo(MAX_DAUER) > 0) {
            throw new Abgelehnt("Ein Eingriff dauert höchstens "
                    + MAX_DAUER.toHours() + " Stunden. Für länger: bitte eine Regel anlegen.");
        }
        return ende;
    }

    /**
     * „bis morgen 06:00" als absolute Zeit in der Zone der Anlage. Die
     * Oberfläche bietet es als Dauer-Auswahl an (§3.2) und schickt das
     * Ergebnis als {@code endsAt} - hier steht die Arithmetik EINMAL, damit
     * sie über Sommerzeit-Grenzen richtig bleibt.
     */
    public static Instant bisMorgenFrueh(Instant now, ZoneId zone, LocalTime uhrzeit) {
        LocalDate morgen = LocalDate.ofInstant(now, zone).plusDays(1);
        return morgen.atTime(uhrzeit).atZone(zone).toInstant();
    }

    /**
     * Der TTL des EINEN ausgesendeten Wunsches: die Restdauer, gekappt auf
     * {@link #TTL_KAPPE}. Ein längerer Eingriff wird erneuert (B6) - der
     * Vertrag D-5 wird dafür nie gedehnt.
     */
    public static int ttlSekunden(Instant ende, Instant now) {
        Duration rest = Duration.between(now, ende);
        if (rest.compareTo(TTL_KAPPE) > 0) {
            rest = TTL_KAPPE;
        }
        return (int) Math.max(1, rest.getSeconds());
    }

    /** Muss dieser Eingriff neu ausgesendet werden (B6)? */
    public static boolean brauchtErneuerung(Instant renewedAt, Instant ende, Instant now) {
        if (!ende.isAfter(now)) {
            return false; // abgelaufen - der Wunsch verfällt auf dem Gerät von selbst
        }
        return renewedAt == null || !renewedAt.isAfter(now.minus(ERNEUERN_NACH));
    }

    /**
     * Der Sollwert, den ein Speicher-Eingriff sendet.
     *
     * <ul>
     *   <li>{@link #HALTEN} → {@code 0} (weder laden noch entladen; S1 = A);</li>
     *   <li>{@link #LADEN} → der gewünschte Wert, sonst die volle Ladeleistung;
     *       auf die Nennleistung gekappt, weil ein Wunsch darüber vom Gerät
     *       ohnehin geklemmt würde und die Vorschau dann falsch stünde.</li>
     * </ul>
     *
     * <p>⚠ Ein NEGATIVER Wert (entladen) wird ABGELEHNT statt geklemmt: es gibt
     * in dieser Stufe keinen „jetzt entladen"-Eingriff, und aus einer Zahl mit
     * falschem Vorzeichen eine andere Handlung zu machen wäre geraten.
     */
    public static BigDecimal sollwert(String kind, BigDecimal gewuenscht, BigDecimal maxLadenKw) {
        if (HALTEN.equals(kind)) {
            return BigDecimal.ZERO;
        }
        if (!LADEN.equals(kind)) {
            throw new Abgelehnt("Unbekannter Eingriff.");
        }
        if (gewuenscht != null && gewuenscht.signum() < 0) {
            throw new Abgelehnt("Zum Entladen gibt es keinen Handeingriff - „Ladestand halten\" "
                    + "stoppt den Speicher, den Rest plant VoltPilot.");
        }
        if (gewuenscht == null || gewuenscht.signum() == 0) {
            if (maxLadenKw == null || maxLadenKw.signum() <= 0) {
                throw new Abgelehnt("Für diesen Speicher ist keine Ladeleistung hinterlegt - "
                        + "bitte im Anlagen-Modell nachtragen.");
            }
            return maxLadenKw;
        }
        return maxLadenKw != null && maxLadenKw.signum() > 0 && gewuenscht.compareTo(maxLadenKw) > 0
                ? maxLadenKw
                : gewuenscht;
    }
}
