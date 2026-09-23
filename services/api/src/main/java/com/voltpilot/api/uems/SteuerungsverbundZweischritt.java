package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collection;
import java.util.EnumMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Der Ablauf um den Zweischritt (UEMS AP-15 IP-7, G5, A10, A18): welches Dokument als nächstes geht und wann der
 * Zielstand fällig ist. Die Rechnung „je Box das Kleinere“ bleibt in {@link SteuerungsverbundAnteile#uebergangsstand}
 * (NW-1); hier wird sie je Richtung angewandt und zu EINEM Dokument mit der ganzen Tabelle zusammengesetzt (Y1).
 *
 * <p>Die Zustände: kein Dokument → Übergangsstand an ALLE → warten auf die Quittung JEDER verengten Box → Zielstand.
 * Es gibt keinen Zeitablauf: fehlt eine Quittung, bleibt der Übergangsstand — enger als nötig, nie zu weit (R12).
 * Rein: ohne Spring, ohne DB, ohne Uhr.
 */
public final class SteuerungsverbundZweischritt {

    private SteuerungsverbundZweischritt() {}

    /** Der Schritt eines Dokuments (Spalte {@code steuerungsverbund_anteile.schritt}, Feld {@code schritt}). */
    public enum Schritt {
        UEBERGANG("uebergang"),
        ZIEL("ziel");

        private final String code;

        Schritt(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }

        public static Schritt aus(String code) {
            for (Schritt s : values()) {
                if (s.code.equals(code)) {
                    return s;
                }
            }
            throw new IllegalArgumentException("unbekannter Schritt " + code);
        }
    }

    /** Eine Tabelle: je Richtung die Anteile je Box und {@code verteilbar} (Y1: die GANZE Tabelle reist mit). */
    public record Tabelle(Map<Grenzart, Map<String, BigDecimal>> anteile, Map<Grenzart, BigDecimal> verteilbar) {

        /** Alle Boxen der Tabelle, sortiert — die Empfänger eines Dokuments. */
        public Set<String> boxen() {
            Set<String> boxen = new java.util.TreeSet<>();
            anteile.values().forEach(m -> boxen.addAll(m.keySet()));
            return boxen;
        }
    }

    /**
     * Das nächste Dokument: sein Schritt, seine Tabelle, der noch ausstehende Zielstand (nur beim Übergang mit zweitem
     * Schritt) und die Boxen, deren Quittung der Zielstand braucht.
     */
    public record Dokument(Schritt schritt, Tabelle tabelle, Tabelle ziel, List<String> verengteBoxen) {}

    /** Epoche und Revision (steigen nur, G5). */
    public record Stand(long epoche, long revision) implements Comparable<Stand> {

        @Override
        public int compareTo(Stand o) {
            return epoche != o.epoche ? Long.compare(epoche, o.epoche) : Long.compare(revision, o.revision);
        }
    }

    /**
     * Der erste Schritt: je Richtung der Übergangsstand aus dem, was die Boxen wirksam halten ({@code alt}), und dem
     * Zielstand. Verengt ist eine Box, wenn sie in IRGENDEINER Richtung enger wird. Ist der Übergang schon der Ziel-
     * stand (reines Verengen), ist das Dokument der Zielstand und nichts wartet. {@code verteilbar} des Übergangs ist
     * das des Zielstands — die Summe des Übergangs liegt je Box unter dem Ziel, also darunter (Vertrag §1, G5). Eine
     * Richtung, die der Zielstand nicht trägt (ausdrücklich unbegrenzte Einspeisung), fehlt auch im Übergang.
     */
    public static Dokument beginnen(Map<Grenzart, Map<String, BigDecimal>> alt, Tabelle ziel) {
        Map<Grenzart, Map<String, BigDecimal>> uebergang = new EnumMap<>(Grenzart.class);
        Set<String> verengt = new LinkedHashSet<>();
        boolean zweiterSchritt = false;
        for (Grenzart r : SteuerungsverbundAnteile.RICHTUNGEN) {
            if (!ziel.anteile().containsKey(r)) {
                continue;
            }
            SteuerungsverbundAnteile.Uebergang u = SteuerungsverbundAnteile.uebergangsstand(
                    alt.getOrDefault(r, Map.of()), ziel.anteile().get(r));
            uebergang.put(r, new TreeMap<>(u.uebergang()));
            verengt.addAll(u.verengteBoxen());
            zweiterSchritt |= u.zweiterSchritt();
        }
        List<String> verengteBoxen = List.copyOf(new java.util.TreeSet<>(verengt));
        if (!zweiterSchritt) {
            return new Dokument(Schritt.ZIEL, new Tabelle(uebergang, ziel.verteilbar()), null, verengteBoxen);
        }
        return new Dokument(Schritt.UEBERGANG, new Tabelle(uebergang, ziel.verteilbar()), ziel, verengteBoxen);
    }

    /**
     * Ist der Zielstand fällig? Erst wenn JEDE verengte Box den Übergang (oder später) quittiert hat. Ohne Quittung —
     * gleich wie lange — nie (R12, A10).
     */
    public static boolean zielFaellig(Stand uebergang, Collection<String> verengteBoxen,
            Map<String, Stand> quittiert) {
        for (String box : verengteBoxen) {
            Stand q = quittiert.get(box);
            if (q == null || q.compareTo(uebergang) < 0) {
                return false;
            }
        }
        return true;
    }

    /**
     * A18: meldet eine Box einen Stand über dem, was die Cloud ihr je gesendet hat, wurde die Cloud-Datenbank
     * zurückgespielt. Danach ändert die Cloud nichts mehr, bis neu scharfgeschaltet wird.
     */
    public static boolean rueckgespielt(Stand gesendet, Stand gemeldet) {
        return gemeldet != null && (gesendet == null || gemeldet.compareTo(gesendet) > 0);
    }

    /**
     * „Alt“ vor dem allerersten Dokument (§5.3, W11): die führende Box hält blind die GANZE Grenze, eine Box, die noch
     * nicht steuert, hält nichts — ihre Geräte laufen mit ihrem Rückfall.
     */
    public static Map<Grenzart, Map<String, BigDecimal>> altOhneDokument(
            List<SteuerungsverbundAbleitung.Mitglied> mitglieder,
            Map<Grenzart, SteuerungsverbundRegeln.Richtung> eingaenge) {
        Map<Grenzart, Map<String, BigDecimal>> alt = new EnumMap<>(Grenzart.class);
        eingaenge.forEach((r, e) -> {
            Map<String, BigDecimal> je = new TreeMap<>();
            for (SteuerungsverbundAbleitung.Mitglied m : mitglieder) {
                je.put(m.box(), m.rolle() == Rolle.FUEHRT ? e.grenzeKw() : e.jeBox().get(m.box()).rueckfallKw());
            }
            alt.put(r, je);
        });
        return alt;
    }

    /**
     * „Alt“ aus den gespeicherten Dokumenten: je Box das Größere aus ihrem Eintrag im zuletzt QUITTIERTEN und im
     * zuletzt GESENDETEN Dokument — sie kann jedes der beiden halten. Fehlt eine Box in beiden, fehlt sie hier (0).
     */
    public static Map<Grenzart, Map<String, BigDecimal>> altAusDokumenten(Map<String, Tabelle> quittiert,
            Map<String, Tabelle> gesendet) {
        Map<Grenzart, Map<String, BigDecimal>> alt = new EnumMap<>(Grenzart.class);
        for (Grenzart r : SteuerungsverbundAnteile.RICHTUNGEN) {
            Map<String, BigDecimal> je = new TreeMap<>();
            List<Map<String, Tabelle>> quellen = new ArrayList<>(List.of(quittiert, gesendet));
            for (Map<String, Tabelle> quelle : quellen) {
                quelle.forEach((box, t) -> {
                    BigDecimal kw = t == null ? null : t.anteile().getOrDefault(r, Map.of()).get(box);
                    if (kw != null) {
                        je.merge(box, kw, BigDecimal::max);
                    }
                });
            }
            alt.put(r, je);
        }
        return alt;
    }
}
