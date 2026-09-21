package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Die Regeln der Sprungprobe (UEMS AP-15 IP-21, Kasten E3 = A, Regeln T5/I3, Fälle R1/R19, Befund A17; Vertrag
 * {@code docs/contracts/v2/mqtt-sprungprobe.md}, Vektoren {@code sprungprobe-vectors.json}). Rein: ohne Spring, ohne DB,
 * ohne Uhr. Die Box rechnet sie nicht — sie verstellt und berichtet; geurteilt wird hier.
 *
 * <p><b>Auswertung.</b> Je Sprung: die Box nennt ihre eigene Änderung der verstellten Größe ({@code eigene_kw} =
 * während − vorher, als Betrag der Erzeugung bzw. des Verbrauchs; senken ist negativ). Am Netzpunkt der führenden Box
 * (+ Bezug / − Einspeisung) wird erwartet: Erzeugung senken → {@code −eigene_kw}, Verbrauch senken →
 * {@code +eigene_kw}. Gesehen = Mittel des Netzpunkts im Fenster [von + 20 s, bis) minus Mittel in [von − 20 s, von).
 * Bestanden, wenn |gesehen − erwartet| ≤ max(10 %, 2 kW) — in JEDEM der beiden Sprünge (R19).
 *
 * <p><b>Entwerten (I3).</b> Eine Probe gilt für die Struktur, in der sie lief. Ändert sich der Eintrag einer Box
 * (Rolle, Messpunkt, Signal) oder die Zuständigkeit ihres Messpunkts oder einer Steuerquelle, die sie liest, ist ihre
 * Probe entwertet; betrifft es die führende Box oder den Netzzähler, sind es die Proben ALLER Boxen.
 */
public final class SprungprobeRegel {

    private SprungprobeRegel() {}

    /** Name der Box-Fähigkeit (nur gemeldet, keine Zeile in {@code edge-capabilities.json}). */
    public static final String FAEHIGKEIT = "sprungprobe";

    /** Obergrenze des Sprungs; die Box verstellt nie mehr, als sie gerade erzeugt bzw. verbraucht. */
    public static final BigDecimal MAX_SPRUNG_KW = new BigDecimal("50");
    /** Dauer eines Sprungs (E3: „zweimal für 60 s“). */
    public static final int DAUER_S = 60;
    /** Wie oft (E3, R19). */
    public static final int WIEDERHOLUNGEN = 2;
    /** Ruhe zwischen zwei Sprüngen. */
    public static final int PAUSE_S = 60;
    /** Der Netzpunkt muss den Sprung innerhalb dieser Zeit zeigen (§5.3); davor zählt er nicht. */
    public static final int EINSCHWINGEN_S = 20;
    /** Das Fenster „vorher“ am Netzpunkt. */
    public static final int VORHER_S = 20;
    /** Beim Auslösen muss der Netzpunkt der führenden Box einen Wert haben, der höchstens so alt ist. */
    public static final int FRISCH_S = 60;
    /** Nach dieser Zeit beginnt die Box eine zugestellte Probe nicht mehr ({@code gueltig_bis}). */
    public static final int ANNAHME_S = 120;
    /** Bis so lange nach dem Auslösen wird ein Bericht angenommen; danach läuft keine Probe mehr. */
    public static final int LAUFZEIT_S = 600;
    /** Ein kleinerer eigener Sprung trennt „gesehen“ nicht sicher von der Toleranz: nicht auswertbar. */
    public static final BigDecimal MIN_SPRUNG_KW = new BigDecimal("5");
    static final BigDecimal TOLERANZ_ANTEIL = new BigDecimal("0.10");
    static final BigDecimal TOLERANZ_MIN_KW = new BigDecimal("2");

    /** Was die Box verstellt: immer in die sichere Richtung — senken (§5.3). */
    public enum Art {
        ERZEUGUNG_SENKEN("erzeugung_senken"),
        VERBRAUCH_SENKEN("verbrauch_senken");

        private final String code;

        Art(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }

        public static Art aus(String code) {
            for (Art a : values()) {
                if (a.code.equals(code)) {
                    return a;
                }
            }
            return null;
        }
    }

    /** Das Urteil über eine Probe. {@code ausgeloest} = der Bericht steht aus. */
    public static final String AUSGELOEST = "ausgeloest";
    public static final String BESTANDEN = "bestanden";
    public static final String NICHT_BESTANDEN = "nicht_bestanden";
    public static final String ABGEBROCHEN = "abgebrochen";
    public static final String NICHT_AUSWERTBAR = "nicht_auswertbar";
    public static final List<String> URTEILE = List.of(AUSGELOEST, BESTANDEN, NICHT_BESTANDEN, ABGEBROCHEN,
            NICHT_AUSWERTBAR);

    /** Gründe zu {@code nicht_bestanden}: der Netzpunkt zeigt den Sprung nicht so, wie die Box ihn machte (A17). */
    public static final List<String> GRUENDE_NICHT_BESTANDEN = List.of("nicht_gesehen", "falsche_richtung",
            "zu_klein", "zu_gross");
    /** Gründe zu {@code nicht_auswertbar}: unbekannt ist kein Bestanden — und auch kein Durchfallen. */
    public static final List<String> GRUENDE_NICHT_AUSWERTBAR = List.of("netzpunkt_nicht_frisch",
            "eigene_wirkung_unbekannt", "sprung_zu_klein", "bericht_unvollstaendig");
    /** Warum die Box abbrach — ihr eigener Wächter steht über der Probe. */
    public static final List<String> GRUENDE_ABGEBROCHEN = List.of("einspeisewaechter", "bezugswaechter",
            "eingefroren", "geraeteschutz", "regelung_aus", "keine_stellgroesse", "abgelaufen", "neustart");

    /**
     * Ein Sprung, wie er zur Auswertung kommt; {@code null} = unbekannt (kein Wert im Fenster bzw. keine eigene Messung).
     *
     * @param eigeneKw       Änderung der verstellten Größe laut Box (während − vorher; senken negativ)
     * @param netzVorherKw   Mittel des Netzpunkts in [von − 20 s, von)
     * @param netzWaehrendKw Mittel des Netzpunkts in [von + 20 s, bis)
     */
    public record Sprung(BigDecimal eigeneKw, BigDecimal netzVorherKw, BigDecimal netzWaehrendKw) {}

    /** Was je Sprung gemessen und geurteilt wurde ({@code grund} null = passt). */
    public record Messung(BigDecimal erwartetKw, BigDecimal gesehenKw, BigDecimal toleranzKw, String urteil,
            String grund) {}

    public record Ergebnis(String urteil, String grund, List<Messung> messungen) {}

    /**
     * Das Urteil. Abgebrochen geht vor; dann ein klares Durchfallen (erster Grund in Sprung-Reihenfolge) vor
     * „nicht auswertbar“; bestanden nur mit {@link #WIEDERHOLUNGEN} Sprüngen, die alle passen.
     */
    public static Ergebnis auswerten(Art art, boolean abgebrochen, String abbruchGrund, List<Sprung> spruenge) {
        Objects.requireNonNull(art);
        List<Messung> messungen = new ArrayList<>();
        for (Sprung s : spruenge) {
            messungen.add(messen(art, s));
        }
        if (abgebrochen) {
            return new Ergebnis(ABGEBROCHEN, abbruchGrund, List.copyOf(messungen));
        }
        for (Messung m : messungen) {
            if (NICHT_BESTANDEN.equals(m.urteil())) {
                return new Ergebnis(NICHT_BESTANDEN, m.grund(), List.copyOf(messungen));
            }
        }
        for (Messung m : messungen) {
            if (NICHT_AUSWERTBAR.equals(m.urteil())) {
                return new Ergebnis(NICHT_AUSWERTBAR, m.grund(), List.copyOf(messungen));
            }
        }
        if (messungen.size() < WIEDERHOLUNGEN) {
            return new Ergebnis(NICHT_AUSWERTBAR, "bericht_unvollstaendig", List.copyOf(messungen));
        }
        return new Ergebnis(BESTANDEN, null, List.copyOf(messungen));
    }

    static Messung messen(Art art, Sprung s) {
        if (s.eigeneKw() == null) {
            return new Messung(null, null, null, NICHT_AUSWERTBAR, "eigene_wirkung_unbekannt");
        }
        if (s.eigeneKw().compareTo(MIN_SPRUNG_KW.negate()) > 0) {
            return new Messung(null, null, null, NICHT_AUSWERTBAR, "sprung_zu_klein");
        }
        BigDecimal erwartet = art == Art.ERZEUGUNG_SENKEN ? s.eigeneKw().negate() : s.eigeneKw();
        BigDecimal toleranz = toleranz(erwartet);
        if (s.netzVorherKw() == null || s.netzWaehrendKw() == null) {
            return new Messung(erwartet, null, toleranz, NICHT_AUSWERTBAR, "netzpunkt_nicht_frisch");
        }
        BigDecimal gesehen = s.netzWaehrendKw().subtract(s.netzVorherKw());
        String grund;
        if (gesehen.subtract(erwartet).abs().compareTo(toleranz) <= 0) {
            grund = null;
        } else if (gesehen.abs().compareTo(toleranz) <= 0) {
            grund = "nicht_gesehen";
        } else if (gesehen.signum() != erwartet.signum()) {
            grund = "falsche_richtung";
        } else if (gesehen.abs().compareTo(erwartet.abs()) < 0) {
            grund = "zu_klein";
        } else {
            grund = "zu_gross";
        }
        return new Messung(erwartet, runden(gesehen), toleranz, grund == null ? BESTANDEN : NICHT_BESTANDEN, grund);
    }

    /** max(10 % des erwarteten Betrags, 2 kW) — R19. */
    public static BigDecimal toleranz(BigDecimal erwartet) {
        BigDecimal anteil = erwartet.abs().multiply(TOLERANZ_ANTEIL);
        return runden(anteil.max(TOLERANZ_MIN_KW));
    }

    private static BigDecimal runden(BigDecimal kw) {
        return kw.setScale(3, RoundingMode.HALF_UP).stripTrailingZeros();
    }

    // ------------------------------------------------------------------ Entwerten (I3)

    /** Der Eintrag einer Box in der Struktur ({@code messpunkt} null = ohne eigenen Zähler). */
    public record Eintrag(String box, String rolle, String messpunkt) {}

    /**
     * Welche Proben entwertet eine Änderung der Mitglieder (Einrichten/Ändern/Auflösen)? Jede Box, deren Eintrag sich
     * ändert, kommt oder geht, und jede, deren Signal sich ändert; ändert sich die führende Box oder ihr Messpunkt (der
     * Netzzähler), alle Boxen vorher und nachher.
     */
    public static Set<String> betroffenBeimAendern(List<Eintrag> vorher, List<Eintrag> nachher,
            Set<String> signalGeaendert) {
        Set<String> alle = new LinkedHashSet<>();
        vorher.forEach(e -> alle.add(e.box()));
        nachher.forEach(e -> alle.add(e.box()));
        Eintrag fuehrtVorher = fuehrende(vorher);
        Eintrag fuehrtNachher = fuehrende(nachher);
        if (!Objects.equals(fuehrtVorher, fuehrtNachher)) {
            return alle;
        }
        Set<String> betroffen = new LinkedHashSet<>();
        for (String box : alle) {
            if (!Objects.equals(eintrag(vorher, box), eintrag(nachher, box)) || signalGeaendert.contains(box)) {
                betroffen.add(box);
            }
        }
        return betroffen;
    }

    /**
     * Welche Proben entwertet ein Zuständigkeitswechsel der Datenquelle {@code quelle} (T6-Rückrichtung, Befund aus
     * IP-26)? Der Netzzähler (Messpunkt der führenden Box): alle. Der Messpunkt eines anderen Mitglieds: dieses. Eine
     * Steuerquelle: die Box, die sie bisher las, und die, die sie künftig liest — soweit Mitglieder. Sonst keine.
     */
    public static Set<String> betroffenBeimWechsel(List<Eintrag> mitglieder, String quelle, boolean steuerquelle,
            String bisher, String kuenftig) {
        Set<String> boxen = new LinkedHashSet<>();
        mitglieder.forEach(e -> boxen.add(e.box()));
        for (Eintrag e : mitglieder) {
            if (quelle.equals(e.messpunkt())) {
                return "fuehrt".equals(e.rolle()) ? boxen : new LinkedHashSet<>(Set.of(e.box()));
            }
        }
        Set<String> betroffen = new LinkedHashSet<>();
        if (steuerquelle) {
            if (bisher != null && boxen.contains(bisher)) {
                betroffen.add(bisher);
            }
            if (kuenftig != null && boxen.contains(kuenftig)) {
                betroffen.add(kuenftig);
            }
        }
        return betroffen;
    }

    private static Eintrag fuehrende(List<Eintrag> eintraege) {
        return eintraege.stream().filter(e -> "fuehrt".equals(e.rolle())).findFirst().orElse(null);
    }

    private static Eintrag eintrag(List<Eintrag> eintraege, String box) {
        return eintraege.stream().filter(e -> e.box().equals(box)).findFirst().orElse(null);
    }
}
