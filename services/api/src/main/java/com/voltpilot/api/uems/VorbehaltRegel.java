package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

/**
 * Der Vorbehalt der Bezugsseite aus Messwerten (UEMS AP-15 IP-13, Regel B4, Kasten W10, Matrixzeile A20, Fall R23) —
 * rein, Vektoren {@code docs/contracts/v2/vorbehalt-vectors.json}.
 *
 * <p>Eingang je Tag der Anlage ist der höchste BELEGTE Viertelstundenwert des Ungeregelten, den die Verbund-Bilanz
 * (IP-12) schon rechnet ({@link VerbundBilanzRegel.Urteil#hoechstes}) — eine unvollständige Viertelstunde zählt nicht,
 * ein Tag ohne belegte Viertelstunde ist kein Messtag. Gemessen = Höchstwert der letzten ≤ 12 Monate × 1,1,
 * AUFgerundet auf 0,1 kW (die sichere Seite, Rundungs-Lesart aus IP-2), nie unter 0.
 *
 * <p><b>Richtung.</b> Verlangt die Messung MEHR als den geltenden Vorbehalt, wird erhöht — das verengt nur und
 * geschieht selbsttätig, auch vor dem 30. Messtag (B4 „sobald die Messung sie verlangt“; ein kurzer Zeitraum
 * unterschätzt den Höchstwert, nie überschätzt er ihn). Verlangt sie WENIGER, bleibt es ein Vorschlag — und erst ab
 * 30 Messtagen; davor gilt der erklärte Wert weiter. Ohne geltenden Wert (unbekannt ist keine Null) gibt es nichts
 * zu erhöhen: ab 30 Messtagen ein Vorschlag.
 *
 * <p><b>Zwei Takte (IP-13 Folge, R23 „die Cloud prüft nach jeder Viertelstunde“).</b> {@link #pruefen} ist der
 * Tageslauf über die Bilanz-Tage (erhöhen, vorschlagen, 30-Tage-Regel, 12-Monats-Sicht). {@link #erhoehen} ist der
 * Viertelstunden-Takt: er kennt NUR das Erhöhen — mit derselben Zahl ({@link #gemessen}) und demselben Vergleich
 * (gemessen &gt; geltend) über die REIFEN belegten Viertelstunden von gestern und heute ({@link #reifBis}).
 */
public final class VorbehaltRegel {

    /** Fassung der Regel; steht in jeder Zeile von {@code steuerungsverbund_vorbehalt}. */
    public static final String FASSUNG = "1";

    /** Zuschlag auf den Höchstwert (B4, A20). */
    public static final BigDecimal ZUSCHLAG = new BigDecimal("1.1");

    /** Ab so vielen Messtagen ersetzt die Messung den erklärten Wert (B4). */
    public static final int MINDEST_MESSTAGE = 30;

    /** Höchstens so viele Monate zurück (B4). */
    public static final int MONATE = 12;

    /**
     * So lange nach ihrem Ende gilt eine Viertelstunde dem Viertelstunden-Takt als REIF: 10 Minuten. Früher ist sie
     * nicht verlässlich — der Verdichter (AP-07 IP-12) läuft alle 5 Minuten, trägt einen Rohwert erst 2 Minuten nach
     * seinem Eingang ein ({@code ViertelstundeVerdichter.SICHERHEIT}), und die Box sendet im Takt ihrer Kadenz
     * (10–60 s) plus Transport; eine gerade erst verdichtete Viertelstunde kann ihr Mittel noch aus einem Teil der
     * Werte haben und trotzdem „vollständig“ heißen (ein Momentanwert hält zwei Kadenzen). 2 + 5 + 3 Minuten
     * Transport = 10.
     */
    public static final Duration REIFE = Duration.ofMinutes(10);

    private static final long VIERTELSTUNDE_S = 15 * 60;

    /** Was der Lauf tut. */
    public enum Aktion {
        ERHOEHEN("erhoehen"),
        VORSCHLAGEN("vorschlagen"),
        KEINE("keine");

        private final String code;

        Aktion(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Warum nichts geschieht — nur bei {@link Aktion#KEINE}. */
    public enum Grund {
        KEINE_MESSUNG("keine_messung"),
        ZU_WENIG_MESSUNG("zu_wenig_messung"),
        UNVERAENDERT("unveraendert");

        private final String code;

        Grund(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Ein Tag der Anlage: höchster belegter Viertelstundenwert des Ungeregelten, {@code null} = kein Messtag. */
    public record Tag(LocalDate tag, BigDecimal hoechstesKw, Instant hoechstesVon) {}

    /**
     * Das Urteil. {@code neuKw} = gemessen (Höchstwert × 1,1 aufgerundet), leer ohne Messtag; {@code altKw} = der
     * geltende Wert, leer = unbekannt. Der Zeitraum sind Tage der Anlage, beide eingeschlossen.
     */
    public record Urteil(Aktion aktion, Grund grund, BigDecimal altKw, BigDecimal neuKw, BigDecimal hoechstwertKw,
            Instant hoechstwertVon, LocalDate zeitraumVon, LocalDate zeitraumBis, int messtage) {}

    private VorbehaltRegel() {}

    /** Der erste Tag des Zeitraums: heute vor zwölf Monaten; der letzte ist gestern. */
    public static LocalDate zeitraumVon(LocalDate heute) {
        return heute.minusMonths(MONATE);
    }

    /** Höchstwert × 1,1, aufgerundet auf 0,1 kW, nie unter 0. */
    public static BigDecimal gemessen(BigDecimal hoechstwertKw) {
        BigDecimal v = hoechstwertKw.multiply(ZUSCHLAG).setScale(1, RoundingMode.CEILING);
        return v.signum() < 0 ? BigDecimal.ZERO.setScale(1) : v;
    }

    /** Das Ende der jüngsten reifen Viertelstunde: (jetzt − {@link #REIFE}) abgerundet auf die Viertelstunde. */
    public static Instant reifBis(Instant jetzt) {
        long s = jetzt.minus(REIFE).getEpochSecond();
        return Instant.ofEpochSecond(Math.floorDiv(s, VIERTELSTUNDE_S) * VIERTELSTUNDE_S);
    }

    /**
     * Das Urteil des Viertelstunden-Takts über die Tage {@code tage} (je Tag der höchste belegte REIFE Wert,
     * {@code null} = kein Messtag): {@link Aktion#ERHOEHEN}, wenn gemessen &gt; geltend — sonst leer. Senken, 30-Tage-Regel und
     * 12-Monats-Sicht bleiben beim Tageslauf; ohne geltenden Wert gibt es nichts zu erhöhen. Der Zeitraum sind die Tage
     * des Takts (erster bis letzter Eintrag), der Höchstwert bei Gleichstand der früheste.
     */
    public static Optional<Urteil> erhoehen(BigDecimal altKw, List<Tag> tage) {
        if (altKw == null || tage.isEmpty()) {
            return Optional.empty();
        }
        LocalDate von = null;
        LocalDate bis = null;
        int messtage = 0;
        Tag hoechster = null;
        for (Tag t : tage) {
            von = von == null || t.tag().isBefore(von) ? t.tag() : von;
            bis = bis == null || t.tag().isAfter(bis) ? t.tag() : bis;
            if (t.hoechstesKw() == null) {
                continue;
            }
            messtage++;
            if (hoechster == null || t.hoechstesKw().compareTo(hoechster.hoechstesKw()) > 0
                    || (t.hoechstesKw().compareTo(hoechster.hoechstesKw()) == 0 && t.tag().isBefore(hoechster.tag()))) {
                hoechster = t;
            }
        }
        if (hoechster == null) {
            return Optional.empty();
        }
        BigDecimal neu = gemessen(hoechster.hoechstesKw());
        if (neu.compareTo(altKw) <= 0) {
            return Optional.empty();
        }
        return Optional.of(new Urteil(Aktion.ERHOEHEN, null, altKw, neu, hoechster.hoechstesKw(),
                hoechster.hoechstesVon(), von, bis, messtage));
    }

    /** Das Urteil über die Tage {@code tage} am Tag {@code heute} gegen den geltenden Vorbehalt {@code altKw}. */
    public static Urteil pruefen(BigDecimal altKw, List<Tag> tage, LocalDate heute) {
        LocalDate von = zeitraumVon(heute);
        LocalDate bis = heute.minusDays(1);
        int messtage = 0;
        Tag hoechster = null;
        for (Tag t : tage) {
            if (t.tag().isBefore(von) || t.tag().isAfter(bis) || t.hoechstesKw() == null) {
                continue;
            }
            messtage++;
            if (hoechster == null || t.hoechstesKw().compareTo(hoechster.hoechstesKw()) > 0
                    || (t.hoechstesKw().compareTo(hoechster.hoechstesKw()) == 0 && t.tag().isBefore(hoechster.tag()))) {
                hoechster = t;
            }
        }
        if (hoechster == null) {
            return new Urteil(Aktion.KEINE, Grund.KEINE_MESSUNG, altKw, null, null, null, von, bis, 0);
        }
        BigDecimal neu = gemessen(hoechster.hoechstesKw());
        Aktion aktion;
        Grund grund = null;
        if (altKw != null && neu.compareTo(altKw) > 0) {
            aktion = Aktion.ERHOEHEN;
        } else if (messtage < MINDEST_MESSTAGE) {
            aktion = Aktion.KEINE;
            grund = Grund.ZU_WENIG_MESSUNG;
        } else if (altKw == null || neu.compareTo(altKw) < 0) {
            aktion = Aktion.VORSCHLAGEN;
        } else {
            aktion = Aktion.KEINE;
            grund = Grund.UNVERAENDERT;
        }
        return new Urteil(aktion, grund, altKw, neu, hoechster.hoechstesKw(), hoechster.hoechstesVon(), von, bis,
                messtage);
    }
}
