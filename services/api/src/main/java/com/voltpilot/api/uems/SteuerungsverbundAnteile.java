package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundVokabular.Ablehnung;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.AuslegungUrteil;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.DokumentAblehnung;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.DokumentUrteil;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Die Anteile einer Gemeinsamen Steuerung (UEMS AP-15 IP-2, NW-1; Vertrag {@code steuerungsverbund.md}): Verteilung
 * je Richtung (G2–G4, E2 = A), Übergangsstand des Zweischritts (G5) und die Prüfung eines Anteils-Dokuments, wie die
 * Box sie rechnet (T4, G5, Y1).
 *
 * <p>Rein: ohne Spring, ohne DB, ohne Uhr. Gerechnet wird in ganzen Zehntel-kW; jede Rundung verengt — Grenze und
 * Nennleistung ab-, Vorbehalt und Geräte-Rückfall aufrunden, jeder anteilige Zuschlag abgerundet, der Rundungsrest
 * bleibt ungenutzt. Die Python-Referenz ist {@code services/optimization/tests/test_steuerungsverbund_referenz.py};
 * beide fahren {@code docs/contracts/v2/verbund-anteil-vectors.json}, der Go-Zwilling der Box kommt mit IP-17.
 * <b>Wer eine Regel ändert, ändert die Vektor-Datei UND alle Zwillinge.</b>
 */
public final class SteuerungsverbundAnteile {

    /** Die zwei Richtungen, die Anteile tragen; die Vorgabe des Netzbetreibers ist eine Verengung, kein Anteil. */
    public static final List<Grenzart> RICHTUNGEN = List.of(Grenzart.EINSPEISUNG, Grenzart.BEZUG);

    /** Verteil-Reihenfolge (G4): zuerst die mitsteuernden Boxen, dann die führende. */
    private static final List<Rolle> VERTEIL_REIHENFOLGE = List.of(Rolle.STEUERT_MIT, Rolle.FUEHRT);

    private SteuerungsverbundAnteile() {}

    /** Ein Mitglied in EINER Richtung: Nennleistung und Geräte-Rückfall der Box in kW. */
    public record Mitglied(String box, Rolle rolle, BigDecimal nennKw, BigDecimal rueckfallKw) {}

    /**
     * Das Urteil einer Richtung. {@code summeRueckfallKw} fehlt bei {@code vorbehalt_ueber_grenze},
     * {@code ungenutztKw} bei jedem Urteil außer {@code passt}; {@code anteile} ist dann leer.
     */
    public record Auslegung(AuslegungUrteil urteil, BigDecimal verteilbarKw, BigDecimal summeRueckfallKw,
            Map<String, BigDecimal> anteile, BigDecimal ungenutztKw) {

        /** Scharfschalten verlangt {@code passt} (I1); jedes andere Urteil lehnt mit {@code auslegung_passt_nicht} ab (E2 = A). */
        public Ablehnung ablehnung() {
            return urteil == AuslegungUrteil.PASST ? null : Ablehnung.AUSLEGUNG_PASST_NICHT;
        }
    }

    /** Übergangsstand, die Boxen, die ihn quittieren müssen, und ob danach noch ein Zielstand folgt. */
    public record Uebergang(Map<String, BigDecimal> uebergang, List<String> verengteBoxen, boolean zweiterSchritt) {}

    /** Wer die Box ist — Mandant, Anlage und eigene Kennung (T4). */
    public record Identitaet(String mandant, String anlage, String box) {}

    /** Der wirksame Stand einer Box; {@code null} an der Aufrufstelle heißt: noch kein Dokument. */
    public record Stand(long epoche, long revision) {}

    /** Ein Anteils-Dokument mit der GANZEN Tabelle je Richtung und {@code verteilbar} (Y1). */
    public record Dokument(String mandant, String anlage, long epoche, long revision, Map<Grenzart, BigDecimal> verteilbar,
            Map<Grenzart, Map<String, BigDecimal>> anteile) {}

    /** Urteil der Box; {@code grund} nur bei {@code abgelehnt}. */
    public record Pruefung(DokumentUrteil urteil, DokumentAblehnung grund) {

        static final Pruefung ANGENOMMEN = new Pruefung(DokumentUrteil.ANGENOMMEN, null);

        static Pruefung abgelehnt(DokumentAblehnung grund) {
            return new Pruefung(DokumentUrteil.ABGELEHNT, grund);
        }
    }

    /**
     * Anteile einer Richtung (G2–G4). Ungültiger Eingang — negativ, Box doppelt, Lese-Box als Mitglied, Rückfall über
     * Nennleistung (an den rohen Werten) — wirft {@link IllegalArgumentException}.
     */
    public static Auslegung anteile(BigDecimal grenzeKw, BigDecimal vorbehaltKw, List<Mitglied> mitglieder) {
        nichtNegativ(grenzeKw);
        nichtNegativ(vorbehaltKw);
        Set<String> gesehen = new HashSet<>();
        Map<String, Long> rueckfall = new LinkedHashMap<>();
        Map<String, Long> nenn = new LinkedHashMap<>();
        for (Mitglied m : mitglieder) {
            nichtNegativ(m.nennKw());
            nichtNegativ(m.rueckfallKw());
            if (!gesehen.add(m.box())) {
                throw new IllegalArgumentException("Box doppelt: " + m.box());
            }
            if (!VERTEIL_REIHENFOLGE.contains(m.rolle())) {
                throw new IllegalArgumentException("nur fuehrt und steuert_mit sind Mitglieder: " + m.box());
            }
            if (m.rueckfallKw().compareTo(m.nennKw()) > 0) {
                throw new IllegalArgumentException("Rückfall über Nennleistung: " + m.box());
            }
            long f = zehntel(m.rueckfallKw(), RoundingMode.CEILING);
            rueckfall.put(m.box(), f);
            // Obergrenze: der Anteil ist nie kleiner als der aufgerundete Rückfall, auch wenn die abgerundete
            // Nennleistung darunter liegt (22,08 / 22,08 kW → 22,1 kW) — und die Box bekommt darüber nichts
            nenn.put(m.box(), Math.max(zehntel(m.nennKw(), RoundingMode.FLOOR), f));
        }

        long verteilbar = zehntel(grenzeKw, RoundingMode.FLOOR) - zehntel(vorbehaltKw, RoundingMode.CEILING);
        if (verteilbar < 0) {
            return new Auslegung(AuslegungUrteil.VORBEHALT_UEBER_GRENZE, kw(verteilbar), null, Map.of(), null);
        }
        long summeRueckfall = rueckfall.values().stream().mapToLong(Long::longValue).sum();
        if (summeRueckfall > verteilbar) {
            return new Auslegung(AuslegungUrteil.AUSLEGUNG_PASST_NICHT, kw(verteilbar), kw(summeRueckfall), Map.of(), null);
        }

        long rest = verteilbar - summeRueckfall;
        Map<String, Long> anteil = new LinkedHashMap<>(rueckfall);
        for (Rolle rolle : VERTEIL_REIHENFOLGE) {
            List<String> gruppe = mitglieder.stream().filter(m -> m.rolle() == rolle).map(Mitglied::box).toList();
            Map<String, Long> bedarf = new LinkedHashMap<>();
            for (String b : gruppe) {
                bedarf.put(b, nenn.get(b) - anteil.get(b));
            }
            long gesamt = bedarf.values().stream().mapToLong(Long::longValue).sum();
            if (gesamt == 0 || rest == 0) {
                continue;
            }
            if (gesamt <= rest) {
                bedarf.forEach((b, z) -> anteil.merge(b, z, Long::sum));
                rest -= gesamt;
            } else {
                long zuVerteilen = rest;
                bedarf.forEach((b, z) -> anteil.merge(b, zuVerteilen * z / gesamt, Long::sum)); // ganzzahlig = abgerundet
                rest = 0; // der Rundungsrest bleibt ungenutzt, er wandert nicht weiter
            }
        }
        Map<String, BigDecimal> ergebnis = new LinkedHashMap<>();
        anteil.forEach((b, z) -> ergebnis.put(b, kw(z)));
        long vergeben = anteil.values().stream().mapToLong(Long::longValue).sum();
        return new Auslegung(AuslegungUrteil.PASST, kw(verteilbar), kw(summeRueckfall), ergebnis, kw(verteilbar - vergeben));
    }

    /** Zweischritt (G5): je Box das Kleinere aus alt und neu; wer in einem Stand fehlt, steht dort mit 0. */
    public static Uebergang uebergangsstand(Map<String, BigDecimal> alt, Map<String, BigDecimal> neu) {
        Set<String> boxen = new TreeSet<>(alt.keySet());
        boxen.addAll(neu.keySet());
        Map<String, BigDecimal> uebergang = new TreeMap<>();
        List<String> verengt = new ArrayList<>();
        boolean zweiterSchritt = false;
        for (String b : boxen) {
            BigDecimal a = alt.getOrDefault(b, BigDecimal.ZERO);
            BigDecimal n = neu.getOrDefault(b, BigDecimal.ZERO);
            BigDecimal u = a.min(n);
            uebergang.put(b, u);
            if (u.compareTo(a) < 0) {
                verengt.add(b);
            }
            if (u.compareTo(n) != 0) {
                zweiterSchritt = true;
            }
        }
        return new Uebergang(uebergang, List.copyOf(verengt), zweiterSchritt);
    }

    /**
     * Die Prüfung eines Anteils-Dokuments auf der Box, in dieser Reihenfolge: Mandant und Anlage, die eigene Kennung in
     * BEIDEN Richtungen (unbekannt ist keine Null), Epoche und Revision steigen nur (dieselbe Revision noch einmal ist
     * angenommen), je Richtung Summe ≤ verteilbar — exakt, ohne Rundung.
     */
    public static Pruefung dokumentPruefen(Identitaet identitaet, Stand stand, Dokument dokument) {
        if (!identitaet.mandant().equals(dokument.mandant()) || !identitaet.anlage().equals(dokument.anlage())) {
            return Pruefung.abgelehnt(DokumentAblehnung.FREMDE_ANLAGE);
        }
        for (Grenzart r : RICHTUNGEN) {
            Map<String, BigDecimal> tabelle = dokument.anteile().get(r);
            if (tabelle == null || !tabelle.containsKey(identitaet.box())) {
                return Pruefung.abgelehnt(DokumentAblehnung.BOX_FEHLT_IM_DOKUMENT);
            }
        }
        if (stand != null && (dokument.epoche() < stand.epoche()
                || dokument.epoche() == stand.epoche() && dokument.revision() < stand.revision())) {
            return Pruefung.abgelehnt(DokumentAblehnung.REVISION_AELTER);
        }
        for (Grenzart r : RICHTUNGEN) {
            BigDecimal summe = dokument.anteile().get(r).values().stream().reduce(BigDecimal.ZERO, BigDecimal::add);
            if (summe.compareTo(dokument.verteilbar().get(r)) > 0) {
                return Pruefung.abgelehnt(DokumentAblehnung.SUMME_UEBER_VERTEILBAR);
            }
        }
        return Pruefung.ANGENOMMEN;
    }

    private static void nichtNegativ(BigDecimal kw) {
        if (kw == null || kw.signum() < 0) {
            throw new IllegalArgumentException("Eingang fehlt oder ist negativ: " + kw);
        }
    }

    private static long zehntel(BigDecimal kw, RoundingMode rundung) {
        return kw.movePointRight(1).setScale(0, rundung).longValueExact();
    }

    private static BigDecimal kw(long zehntel) {
        return BigDecimal.valueOf(zehntel, 1);
    }
}
