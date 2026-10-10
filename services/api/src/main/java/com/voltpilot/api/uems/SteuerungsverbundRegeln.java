package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundVokabular.Ablehnung;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Stufe;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Die Regeln des Verbund-Objekts einer Gemeinsamen Steuerung (UEMS AP-15 IP-4; Vertrag {@code steuerungsverbund.md}
 * §5, Vektoren {@code docs/contracts/v2/steuerungsverbund-objekt-vectors.json}): T1 Heimat der Box, T2 genau ein
 * Netzanschluss (W3), genau eine führt, Messpunkt = Datenquelle dieser Anlage und vom Mitglied gelesen (B1, B3),
 * T6 Lesen macht kein Mitglied; G2/G3 rechnet {@link SteuerungsverbundAnteile#anteile} mit den Mitgliedern DIESES
 * Verbunds.
 *
 * <p>Rein: ohne Spring, ohne DB, ohne Uhr — geprüft wird ein Stand zu einem Zeitpunkt, den der Aufrufer lädt. Die
 * Urteile sind Wörter aus {@link Ablehnung}; was die Datenbank strukturell ausschließt (zwei führende Boxen, `liest`
 * als Mitglied, eine Box oder ein Messpunkt doppelt, zwei Netzanschlüsse) ist ein Eingabefehler, kein Urteil
 * ({@link IllegalArgumentException}, Vektoren mit {@code "fehler": true}).
 */
public final class SteuerungsverbundRegeln {

    private SteuerungsverbundRegeln() {}

    /** Ein erklärtes Mitglied: Box, ihre Heimat-Anlage, Rolle, Messpunkt (Kennung einer Datenquelle; null = keiner). */
    public record Mitglied(String box, String heimat, Rolle rolle, String messpunkt) {}

    /** Eine Datenquelle: die Anlage, in der sie verdrahtet ist, und die Box, die sie liest (null = keine). */
    public record Datenquelle(String kennung, String anlage, String gelesenVon) {}

    /** Der Verbund zu einem Zeitpunkt: seine Anlage, die an diesem Tag gebundenen Netzanschlüsse, die Mitglieder. */
    public record Verbund(String anlage, List<String> netzanschluesse, List<Mitglied> mitglieder) {}

    /** Nennleistung und Geräte-Rückfall einer Box in EINER Richtung (G3; dieselbe Menge hinter dem Abgang). */
    public record Leistung(BigDecimal nennKw, BigDecimal rueckfallKw) {}

    /**
     * Eingang der Auslegung einer Richtung (G2): Grenze, Vorbehalt, je Box ihre Leistung und der Übergangszuschlag für
     * den Ausfall der führenden Box ({@link SteuerungsverbundAnteile#uebergangszuschlag}; 0 ohne Speicher dort).
     */
    public record Richtung(BigDecimal grenzeKw, BigDecimal vorbehaltKw, Map<String, Leistung> jeBox,
            BigDecimal uebergangszuschlagKw) {

        /** Ohne Übergangszuschlag — der Stand vor dem Puffer, für Verbünde ohne Speicher an der führenden Box. */
        public Richtung(BigDecimal grenzeKw, BigDecimal vorbehaltKw, Map<String, Leistung> jeBox) {
            this(grenzeKw, vorbehaltKw, jeBox, BigDecimal.ZERO);
        }
    }

    /** Ein Grund, warum der Verbund so nicht scharf werden kann; {@code box} bzw. {@code richtung} nur, wo er daran hängt. */
    public record Befund(Ablehnung ablehnung, String box, Grenzart richtung) {}

    /** Alle Befunde in der Reihenfolge des Vokabulars, je Wort in der Reihenfolge der Mitglieder. */
    public record Urteil(List<Befund> befunde) {

        public boolean zulaessig() {
            return befunde.isEmpty();
        }

        /** Der erste Grund — die Antwort einer Route (409); null, wenn zulässig. */
        public Ablehnung ablehnung() {
            return befunde.isEmpty() ? null : befunde.get(0).ablehnung();
        }
    }

    /**
     * Prüft den Verbund. {@code auslegung} darf fehlen oder leer sein (dann wird G2/G3 nicht geprüft, etwa beim
     * Einrichten vor der ersten Messung); jede übergebene Richtung wird mit genau den Mitgliedern dieses Verbunds
     * gerechnet.
     */
    public static Urteil pruefen(Verbund verbund, Collection<Datenquelle> quellen, Map<Grenzart, Richtung> auslegung) {
        Map<String, Datenquelle> quelle = new HashMap<>();
        for (Datenquelle q : quellen) {
            if (quelle.put(q.kennung(), q) != null) {
                throw new IllegalArgumentException("Datenquelle doppelt: " + q.kennung());
            }
        }
        strukturPruefen(verbund, quelle);

        List<Befund> befunde = new ArrayList<>();
        for (Mitglied m : verbund.mitglieder()) {
            if (!verbund.anlage().equals(m.heimat())) {
                befunde.add(new Befund(Ablehnung.BOX_NICHT_IN_ANLAGE, m.box(), null));
            }
        }
        if (verbund.netzanschluesse().isEmpty()) {
            befunde.add(new Befund(Ablehnung.KEIN_NETZANSCHLUSS, null, null));
        }
        if (auslegung != null) {
            for (Grenzart richtung : SteuerungsverbundAnteile.RICHTUNGEN) {
                Richtung eingang = auslegung.get(richtung);
                if (eingang == null) {
                    continue;
                }
                var a = SteuerungsverbundAnteile.anteile(eingang.grenzeKw(), eingang.vorbehaltKw(),
                        eingang.uebergangszuschlagKw(), anteilsMitglieder(verbund, eingang, richtung));
                if (a.ablehnung() != null) {
                    befunde.add(new Befund(a.ablehnung(), null, richtung));
                }
            }
        }
        Mitglied fuehrt = verbund.mitglieder().stream().filter(m -> m.rolle() == Rolle.FUEHRT).findFirst().orElse(null);
        if (fuehrt == null || !misst(verbund, fuehrt, quelle)) {
            befunde.add(new Befund(Ablehnung.FUEHRENDE_BOX_MISST_NICHT, fuehrt == null ? null : fuehrt.box(), null));
        }
        for (Mitglied m : verbund.mitglieder()) {
            // B3: ohne Abgangszähler gilt die Summe ihrer Geräteleistungen — kein Messpunkt ist erlaubt.
            if (m.rolle() == Rolle.STEUERT_MIT && m.messpunkt() != null && !misst(verbund, m, quelle)) {
                befunde.add(new Befund(Ablehnung.MITSTEUERNDE_BOX_MISST_NICHT, m.box(), null));
            }
        }
        befunde.sort(Comparator.comparingInt(b -> b.ablehnung().ordinal())); // stabil: je Wort Mitglieder-Reihenfolge
        return new Urteil(List.copyOf(befunde));
    }

    /**
     * T6: Mitglied ist eine Box nur mit Heimat in der Anlage des Verbunds UND einer Rolle {@code fuehrt} oder
     * {@code steuert_mit}. Eine Zuständigkeit fürs Lesen — auch über die Systemgrenze (AP-00 E7, R21) — macht
     * niemanden zum Mitglied.
     */
    public static boolean istMitglied(Verbund verbund, String box) {
        return verbund.mitglieder().stream().anyMatch(m -> m.box().equals(box)
                && verbund.anlage().equals(m.heimat())
                && (m.rolle() == Rolle.FUEHRT || m.rolle() == Rolle.STEUERT_MIT));
    }

    /**
     * T6 Rückrichtung (IP-8, R21 Schritt 3): die Zuständigkeit für diese Datenquelle wechselt NUR als Änderung der
     * Gemeinsamen Steuerung (anhalten → ändern → prüfen → scharfschalten), wenn die Gemeinsame Steuerung scharf ist
     * ({@link Stufe#ANTEILE_AKTIV} oder {@link Stufe#ANGEHALTEN} — die Anteile sind in Kraft) und die Quelle sie trägt:
     * Messpunkt eines Mitglieds (für die führende Box der Netzzähler) oder eine Steuerquelle, die ein Mitglied liest.
     * Ohne Gemeinsame Steuerung ({@code verbund} null), vor dem Scharfschalten und für jede andere Quelle — auch eine,
     * die eine Box über die Anlagengrenze liest (R21) — bleibt der Zuständigkeitswechsel, wie er ist.
     */
    public static boolean wechseltNurAlsAenderung(Stufe stufe, Verbund verbund, Datenquelle quelle,
            boolean steuerquelle) {
        if (verbund == null || (stufe != Stufe.ANTEILE_AKTIV && stufe != Stufe.ANGEHALTEN)) {
            return false;
        }
        boolean messpunkt = verbund.mitglieder().stream()
                .anyMatch(m -> quelle.kennung().equals(m.messpunkt()) && istMitglied(verbund, m.box()));
        return messpunkt || (steuerquelle && quelle.gelesenVon() != null && istMitglied(verbund, quelle.gelesenVon()));
    }

    /** Messpunkt ist eine Datenquelle DIESER Anlage, und dieses Mitglied liest sie. */
    private static boolean misst(Verbund verbund, Mitglied m, Map<String, Datenquelle> quelle) {
        if (m.messpunkt() == null) {
            return false;
        }
        Datenquelle q = quelle.get(m.messpunkt());
        return verbund.anlage().equals(q.anlage()) && m.box().equals(q.gelesenVon());
    }

    private static void strukturPruefen(Verbund verbund, Map<String, Datenquelle> quelle) {
        if (verbund.netzanschluesse().size() > 1) {
            // W3: ein System an mehreren Netzanschlüssen ist außerhalb des Umfangs; anlage_netzanschluss schließt es aus.
            throw new IllegalArgumentException("gekuppelter Fall: mehr als ein Netzanschluss " + verbund.netzanschluesse());
        }
        Set<String> boxen = new HashSet<>();
        Set<String> messpunkte = new HashSet<>();
        int fuehrende = 0;
        for (Mitglied m : verbund.mitglieder()) {
            if (m.rolle() != Rolle.FUEHRT && m.rolle() != Rolle.STEUERT_MIT) {
                throw new IllegalArgumentException("Lesen macht kein Mitglied (T6): " + m.box());
            }
            if (!boxen.add(m.box())) {
                throw new IllegalArgumentException("Box doppelt: " + m.box());
            }
            if (m.rolle() == Rolle.FUEHRT && ++fuehrende > 1) {
                throw new IllegalArgumentException("genau eine führt: zwei führende Boxen");
            }
            if (m.messpunkt() != null) {
                if (!quelle.containsKey(m.messpunkt())) {
                    throw new IllegalArgumentException("Messpunkt unbekannt: " + m.messpunkt());
                }
                if (!messpunkte.add(m.messpunkt())) {
                    throw new IllegalArgumentException("Messpunkt doppelt (kein Doppel-Lesen): " + m.messpunkt());
                }
            }
        }
    }

    private static List<SteuerungsverbundAnteile.Mitglied> anteilsMitglieder(Verbund verbund, Richtung eingang,
            Grenzart richtung) {
        if (!eingang.jeBox().keySet().equals(boxenDes(verbund))) {
            throw new IllegalArgumentException("Leistung je Box passt nicht zu den Mitgliedern (" + richtung.code() + ")");
        }
        List<SteuerungsverbundAnteile.Mitglied> mitglieder = new ArrayList<>();
        for (Mitglied m : verbund.mitglieder()) {
            Leistung l = eingang.jeBox().get(m.box());
            mitglieder.add(new SteuerungsverbundAnteile.Mitglied(m.box(), m.rolle(), l.nennKw(), l.rueckfallKw()));
        }
        return mitglieder;
    }

    private static Set<String> boxenDes(Verbund verbund) {
        Set<String> boxen = new HashSet<>();
        verbund.mitglieder().forEach(m -> boxen.add(m.box()));
        return boxen;
    }
}
