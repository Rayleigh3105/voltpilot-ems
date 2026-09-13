package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Der EINE Leseweg für den Anteil eines Formel-Terms (UEMS AP-10 IP-5, PR #688 nachziehen 3/4;
 * Vertrag {@code docs/contracts/v2/verteilung-vectors.json} Block {@code leseweg}, Prosa
 * {@code messstelle-formel.md} §1.1/§6.3).
 *
 * <p>Ein Term nimmt entweder den GANZEN Wert seines Eingangs (heute jeder gespeicherte Term) oder
 * einen Anteil davon:
 * <ul>
 *   <li>{@code anteil} = {@code positiv} | {@code negativ} — den Teil eines Messwerts (Laden ODER
 *       Entladen). Woher dieser Teil kommt, sagt die Quellenbindung — das baut AP-08 IP-7;</li>
 *   <li>{@code eingang_art} = {@code verteilung} — den Anteil DES TAGES einer Kostenstelle an einer
 *       Messstelle („4100 von MS-07“). Die Verteilung baut AP-10 IP-8.</li>
 * </ul>
 *
 * <p>Der Anteil des Tages ist seit AP-10 IP-8 lesbar: {@link #lies} liest die Zeilen der Verteilung am Tag
 * ({@link Verteilungen}, Tabelle {@code messstelle_verteilung}), wählt über {@link VerteilungRegeln#amTag}
 * die geltenden und rechnet über {@link #tagesanteil} mit {@link VerteilungRegeln#term} — aufgerufen, nie
 * nachgebaut. Ohne Zeile am Tag ist das Urteil {@code nicht_verteilt}: ein Zustand, keine Zahl, keine
 * Null. Der Teil eines Messwerts wartet weiter: {@link #lies} lehnt ihn BENANNT ab — mit Code und
 * Kundensatz aus dem Vertrag, nie mit einer geratenen Zahl. Schreibweg, Live-Wert und Verlauf von
 * {@link MessstelleFormelService} fragen ausschließlich diese Methode.
 *
 * <p>Keine dynamischen Umlageschlüssel (Grenze des Captains): ein Anteil ist eine gepflegte Zahl mit
 * Gültigkeit, nie eine aus Messwerten gerechnete Quote.
 */
@Component
public class AnteilLeseweg {

    /**
     * Woher der Leseweg die Verteilung einer Messstelle nimmt (AP-10 IP-8, Tabelle
     * {@code messstelle_verteilung}; {@link VerteilungRepository}).
     */
    @FunctionalInterface
    public interface Verteilungen {
        /** Die wirksamen Zeilen der Messstelle, die am Tag gelten könnten, samt ihren Zielen. */
        Stand stand(UUID messstelle, LocalDate tag);
    }

    /**
     * Die Verteilung einer Messstelle, wie der Leseweg sie braucht: ihr Kennzeichen (für „verteilt (70 %
     * von MS-07)“), die Zeilen und die Ziele — Schlüssel der Kostenstelle ist ihre ID als Text.
     */
    public record Stand(String kennzeichen, List<VerteilungRegeln.Bestandszeile> zeilen,
            List<VerteilungRegeln.Ziel> ziele) {}

    private final Verteilungen verteilungen;

    public AnteilLeseweg(Verteilungen verteilungen) {
        this.verteilungen = verteilungen;
    }

    /** Der ganze Wert — die Vorgabe; gespeichert als {@code NULL} (V20260913143000). */
    public static final String GESAMT = "gesamt";
    public static final String POSITIV = "positiv";
    public static final String NEGATIV = "negativ";
    /** Das Vokabular {@code anteil} (Vertrag {@code vokabulare.anteil}). */
    public static final List<String> ANTEILE = List.of(GESAMT, POSITIV, NEGATIV);
    /** Die dritte Eingangs-Art neben {@code messkanal} und {@code messstelle}. */
    public static final String VERTEILUNG = "verteilung";

    /**
     * Die geschlossene Menge der Ablehnungen eines Terms vor dem Rechnen, in Prüfreihenfolge
     * (Vertrag {@code leseweg.ablehnungen}; {@code AnteilLesewegVectorsTest} hält Code, Status,
     * Feld, Wartet-auf und Satz Zeichen für Zeichen an der Datei).
     */
    public enum Ablehnung {
        /** Eine Vertragsregel, die nie wartet: der Anteil kommt aus der Verteilung, nie als Faktor. */
        VERTEILUNGS_TERM_OHNE_FAKTOR(VerteilungRegeln.FEHLER_TERM_FAKTOR, 422, null, "faktor",
                "Ein Verteilungs-Anteil kommt aus der Verteilung des Tages und hat darum keinen eigenen Faktor."),
        /** Der Teil eines Messwerts — wartet auf die Quellenbindung mit Anteil. */
        ANTEIL_WARTET_AUF_AP08("anteil_wartet_auf_ap08", 422, "AP-08 IP-7", "anteil",
                "Nur den positiven oder nur den negativen Teil eines Messwerts (etwa Laden oder Entladen) "
                        + "kann eine Formel noch nicht lesen. Der Term wird darum nicht gespeichert — "
                        + "geschätzt wird nichts.");

        private final String code;
        private final int status;
        private final String wartetAuf;
        private final String feld;
        private final String satz;

        Ablehnung(String code, int status, String wartetAuf, String feld, String satz) {
            this.code = code;
            this.status = status;
            this.wartetAuf = wartetAuf;
            this.feld = feld;
            this.satz = satz;
        }

        public String code() {
            return code;
        }

        public int status() {
            return status;
        }

        /** Das Bau-Paket, das die fehlende Fähigkeit liefert — {@code null} für eine Vertragsregel. */
        public String wartetAuf() {
            return wartetAuf;
        }

        /** Das Feld des Terms, an dem die Ablehnung hängt. */
        public String feld() {
            return feld;
        }

        /** Der Kundensatz — die EINE Formulierung. */
        public String satz() {
            return satz;
        }
    }

    /**
     * Was ein Term über seinen Anteil weiß. {@code wartet != null}: die Fähigkeit fehlt — der
     * Schreibweg speichert den Term nicht, die Rechnung nennt ihn als fehlend. Sonst nimmt der Term
     * den ganzen Wert ({@code term == null}) oder den Anteil des Tages aus {@code verteilung}.
     */
    public record Lesung(
            Ablehnung wartet,
            VerteilungRegeln.VerteilungsTerm term,
            LocalDate tag,
            List<VerteilungRegeln.Abschnitt> verteilung) {

        /** Der ganze Wert — die Lesung jedes Terms von vor AP-10 IP-5. */
        public static final Lesung GANZ = new Lesung(null, null, null, List.of());

        static Lesung wartetAuf(Ablehnung a) {
            return new Lesung(a, null, null, List.of());
        }

        /** Nimmt der Term den ganzen Wert seines Eingangs (dann rechnet der Bestand unverändert)? */
        public boolean ganz() {
            return wartet == null && term == null;
        }

        /**
         * Was der Term aus der Menge {@code quelle} seines Eingangs nimmt: der ganze Wert, der Anteil
         * des Tages ({@link VerteilungRegeln#term}) oder — wenn er wartet — keine Menge und der Code
         * der Ablehnung als Fehler. {@code quelle == null} bleibt „keine Menge“, nie 0.
         */
        public VerteilungRegeln.TermUrteil urteil(BigDecimal quelle) {
            if (wartet != null) {
                return new VerteilungRegeln.TermUrteil(null, null, List.of(), wartet.code());
            }
            if (term == null || quelle == null) {
                return new VerteilungRegeln.TermUrteil(quelle, null, List.of(), null);
            }
            return VerteilungRegeln.term(term, tag, quelle, verteilung);
        }
    }

    /**
     * Die Vertragsregel VOR jedem Lesen: ein Verteilungs-Term mit einem Faktor ≠ 1 wird abgelehnt
     * ({@link VerteilungRegeln#faktorErlaubt} — dieselbe Regel, die {@link VerteilungRegeln#term} fragt).
     */
    public static Optional<Ablehnung> vertragsregel(String eingangArt, BigDecimal faktor) {
        if (VERTEILUNG.equals(eingangArt) && !VerteilungRegeln.faktorErlaubt(faktor)) {
            return Optional.of(Ablehnung.VERTEILUNGS_TERM_OHNE_FAKTOR);
        }
        return Optional.empty();
    }

    /**
     * DIE EINE STELLE: wie ein Term an einem Tag seinen Anteil liest. Erst der Teil des Messwerts,
     * dann die Verteilung dieses Teils ({@code leseweg.pruefreihenfolge}). Der Teil wartet benannt; ein
     * Verteilungs-Term liest den Anteil DES TAGES; ein Term ohne beides nimmt den ganzen Wert.
     *
     * @param anteil {@code null} = {@link #GESAMT}
     * @param tag der Tag, dessen Anteil gilt — beim Live-Wert heute, im Verlauf der Tag des Buckets,
     *     beim Schreiben der erste Tag der Fassung (nie „heute“ für einen alten Tag)
     */
    public Lesung lies(String eingangArt, String anteil, UUID quellMessstelleId, UUID verteilungZiel,
            LocalDate tag) {
        if (anteil != null && !GESAMT.equals(anteil)) {
            // ⚠ AP-08 IP-7: HIER wird aus der Ablehnung der Aufruf — den Teil `anteil` des Eingangs
            // über die Quellenbindung mit Anteil lesen. Bis dahin: benannt, nie geraten.
            return Lesung.wartetAuf(Ablehnung.ANTEIL_WARTET_AUF_AP08);
        }
        if (VERTEILUNG.equals(eingangArt)) {
            // AP-10 IP-8: die Zeilen der Verteilung von `quellMessstelleId` am Tag, das Ziel ist
            // `verteilungZiel` (Schlüssel: die ID der Kostenstelle). Ohne Zeile → nicht_verteilt.
            Stand stand = quellMessstelleId == null
                    ? new Stand(null, List.of(), List.of())
                    : verteilungen.stand(quellMessstelleId, tag);
            VerteilungRegeln.AmTagUrteil am = VerteilungRegeln.amTag(tag, stand.zeilen(), stand.ziele());
            VerteilungRegeln.VerteilungsTerm term = new VerteilungRegeln.VerteilungsTerm(VERTEILUNG,
                    verteilungZiel == null ? null : verteilungZiel.toString(),
                    stand.kennzeichen() == null ? String.valueOf(quellMessstelleId) : stand.kennzeichen(),
                    GESAMT, BigDecimal.ONE, "+");
            return tagesanteil(term, tag, am.zeilen().isEmpty()
                    ? List.of()
                    : List.of(new VerteilungRegeln.Abschnitt(tag, tag, am.zeilen())));
        }
        return Lesung.GANZ;
    }

    /**
     * Die Lesung eines Verteilungs-Terms aus den Abschnitten SEINER Verteilung: der Anteil des TAGES,
     * gerechnet von {@link VerteilungRegeln#term} (Regel {@code term} des Vertrags). Was am 3. März
     * galt, ist die Wahrheit des 3. März — auch wenn die Verteilung heute anders ist.
     */
    public static Lesung tagesanteil(VerteilungRegeln.VerteilungsTerm term, LocalDate tag,
            List<VerteilungRegeln.Abschnitt> verteilung) {
        return new Lesung(null, term, tag, List.copyOf(verteilung));
    }
}
