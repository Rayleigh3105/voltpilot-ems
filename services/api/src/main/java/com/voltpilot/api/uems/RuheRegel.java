package com.voltpilot.api.uems;

import com.voltpilot.api.interventions.Handeingriff;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;

/**
 * Die Ruhe bis zum Start (UEMS AP-01 IP-4, Regel R0, Entscheid E7 = A): eine Anlage, die zur
 * Funktion „Steuern &amp; Optimieren“ gehört, aber nicht gestartet ist, ruht OHNE Enddatum — im
 * heutigen Pause-Zustand der Box. Die Zeile ist {@code device_override} mit {@code kind = pause}
 * und der Herkunft {@value #HERKUNFT_FUNKTION}; eine Zeile ohne Herkunft ist der Handeingriff von
 * Steuerung Stufe 4.
 *
 * <p>Drei Hälften, jede gepinnt von {@code docs/contracts/v2/override-vectors.json}:
 *
 * <ol>
 *   <li>{@link #zeileAbgelehnt} — was die Tabelle annimmt (Zwilling der CHECKs von
 *       {@code V20260914193000}, in ihrer Namensreihenfolge).
 *   <li>{@link #push} — was der Publisher in den Registry-Push schreibt: eine Ruhe trägt
 *       {@value #FELD_WIDERRUF} und für eine ältere Box ein rollierendes Ende.
 *   <li>{@link #ruht} — was die Box daraus macht (Zwilling von {@code entities.Registry.Paused} im
 *       Go-Core): bis auf Widerruf, unabhängig von Ende und Uhr.
 * </ol>
 *
 * <p>Rein, ohne Spring; jede zeitabhängige Funktion nimmt ihr {@code jetzt}.
 */
public final class RuheRegel {

    private RuheRegel() {}

    /** Die einzige Herkunft: die Ruhe der Funktion. Leer = Handeingriff. */
    public static final String HERKUNFT_FUNKTION = "funktion";

    /** Das bestehende Feld: bis wann die Box ruht (absolut, Steuerung Stufe 4 B5). */
    public static final String FELD_ENDE = "automation_paused_until";

    /** Das neue, additive Feld: die Box ruht bis auf Widerruf. */
    public static final String FELD_WIDERRUF = "automation_paused_until_revoked";

    /**
     * Das Ende, das eine ÄLTERE Box (die {@value #FELD_WIDERRUF} überliest) mit jeder Ruhe bekommt:
     * dieselbe Kappe wie jeder gehaltene Handeingriff auf der Box (D-5).
     */
    public static final Duration ENDE_FUER_AELTERE_BOX = Handeingriff.TTL_KAPPE;

    /** Ab wann die Ruhe erneut gepusht wird, damit das Ende der älteren Box nie erreicht wird (B6). */
    public static final Duration ERNEUERN_NACH = Handeingriff.ERNEUERN_NACH;

    /** Die geschlossene Liste der Ablehnungen, je mit dem CHECK, der sie in der Tabelle trägt. */
    public enum Ablehnung {
        ENDE_PFLICHT("ende_pflicht", "device_override_ende_chk"),
        FUNKTION_OHNE_ENDE("funktion_ohne_ende", "device_override_funktion_ohne_ende_chk"),
        FUNKTION_NUR_PAUSE("funktion_nur_pause", "device_override_herkunft_chk"),
        HERKUNFT_UNBEKANNT("herkunft_unbekannt", "device_override_herkunft_chk");

        private final String code;
        private final String constraint;

        Ablehnung(String code, String constraint) {
            this.code = code;
            this.constraint = constraint;
        }

        public String code() {
            return code;
        }

        public String constraint() {
            return constraint;
        }
    }

    /**
     * Warum die Tabelle diese Zeile ablehnt, oder leer. Die Reihenfolge ist die Namensreihenfolge
     * der CHECKs — Postgres meldet den ersten Verstoss in genau dieser Ordnung.
     */
    public static Optional<Ablehnung> zeileAbgelehnt(String kind, String herkunft, Instant endsAt) {
        boolean funktion = HERKUNFT_FUNKTION.equals(herkunft);
        if (endsAt == null && !funktion) {
            return Optional.of(Ablehnung.ENDE_PFLICHT);
        }
        if (funktion && endsAt != null) {
            return Optional.of(Ablehnung.FUNKTION_OHNE_ENDE);
        }
        if (herkunft != null && !funktion) {
            return Optional.of(Ablehnung.HERKUNFT_UNBEKANNT);
        }
        if (funktion && !"pause".equals(kind)) {
            return Optional.of(Ablehnung.FUNKTION_NUR_PAUSE);
        }
        return Optional.empty();
    }

    /**
     * Die Felder einer laufenden Pause im Registry-Push. {@code bisAufWiderruf} false heisst: das
     * Feld {@value #FELD_WIDERRUF} fehlt — der Push ist byte-gleich zum Handeingriff von vorher.
     */
    public record PushFelder(Instant ende, boolean bisAufWiderruf) {}

    /** Eine Pause mit Ende trägt ihr Ende; die Ruhe (ohne Ende) den Widerruf und jetzt + 4 h. */
    public static PushFelder push(Instant endsAt, Instant jetzt) {
        return endsAt != null
                ? new PushFelder(endsAt, false)
                : new PushFelder(jetzt.plus(ENDE_FUER_AELTERE_BOX), true);
    }

    /** Ruht die Box? Bis auf Widerruf immer; sonst bis zum Ende (das Ende selbst ist vorbei). */
    public static boolean ruht(Instant ende, boolean bisAufWiderruf, Instant jetzt) {
        return bisAufWiderruf || (ende != null && jetzt.isBefore(ende));
    }

    /** Ruht eine Box VOR diesem Stand? Sie kennt nur das Ende. */
    public static boolean ruhtAeltereBox(Instant ende, Instant jetzt) {
        return ruht(ende, false, jetzt);
    }

    /** Muss die Ruhe neu gepusht werden? Nie gesendet, oder VOR der Grenze (strikt, wie B6). */
    public static boolean erneuernFaellig(Instant zuletztGesendet, Instant jetzt) {
        return zuletztGesendet == null || zuletztGesendet.isBefore(jetzt.minus(ERNEUERN_NACH));
    }
}
