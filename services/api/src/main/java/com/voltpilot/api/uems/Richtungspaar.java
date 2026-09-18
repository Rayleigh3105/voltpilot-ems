package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.MeasurementCatalog;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Das Richtungspaar einer Reihe, deren Katalogkanal ZWEI Flussrichtungen in EINER Größe führt —
 * {@code charge_discharge} („Laden / Entladen“) und {@code import_export} („Bezug / Abgabe“).
 *
 * <p><b>Warum es das gibt.</b> Das Lesemodell führt für eine solche Reihe genau eine NETTO-Menge;
 * ein Bericht, der daraus Laden und Entladen getrennt zeigen soll, müsste sie aus den Vorzeichen
 * der Viertelstunden neu rechnen — und ein Bericht rechnet nichts neu, er schreibt ab
 * ({@code bericht.md} EW3). Darum entstehen die beiden Anteile <b>in der Verdichtung</b>, dort wo
 * aus den Viertelstunden die Tages- und Periodenmenge wird, und stehen seit
 * {@code V20260918101000} neben der Menge in {@code messreihe_tag} und {@code messreihe_periode}.
 *
 * <p><b>Die Regel</b> ist die des Anteils eines Vorzeichen-Werts, eine Ebene höher angewandt:
 * {@code positiv} = Σ max(0, Teil), {@code negativ} = Σ max(0, −Teil), gebildet von
 * {@link VerbrauchRegeln#anteilDesWerts}. Welches WORT ein Anteil trägt, sagt
 * {@link MessstelleRegeln#RICHTUNGSPAAR}, nicht die Spalte.
 *
 * <p><b>Wann es fehlt</b> (und {@code null} ist, nie 0 — unbekannt ist keine Null): wenn der Kanal
 * nur einen Fluss führt oder unbekannt ist; wenn die Reihe ein ZÄHLERSTAND ist (dort ist die Menge
 * der Zuwachs zweier Stände, kein Vorzeichen-Teil, und ein Anteil wäre eine erfundene Zahl); und
 * wenn ein Teil der Periode seinen Anteil nicht trägt, weil er vor dieser Migration verdichtet
 * wurde.
 *
 * <p><b>⚠ Der MOMENTANWERT fehlt hier noch — und das ist heute jeder Speicher.</b> Im gepackten
 * Katalog (2026.09.16.1) trägt <em>jeder</em> Kanal mit zwei Richtungen {@code active_power} in W,
 * also einen Momentanwert: 5 × {@code charge_discharge}, 49 × {@code import_export}, kein einziger
 * als Intervallmenge. Seine Menge entsteht durch INTEGRATION der Leistung über die Zeit
 * ({@code VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT} — das Kennzeichen, das MS-04 im Referenzfall
 * trägt), und der exakte Anteil wäre die Integration von {@code max(0, P)} bzw. {@code max(0, −P)}
 * über die ROHWERTE. Die stehen nur der Viertelstunden-Verdichtung zur Verfügung; ab hier ist die
 * Viertelstunde schon zu EINER vorzeichenbehafteten Energie verdichtet, und ein Vorzeichenwechsel
 * INNERHALB einer Viertelstunde wäre verloren. Eine Summe über Viertelstunden-Vorzeichen wäre
 * darum nicht der Anteil, sondern eine Näherung — und eine Näherung ist in einem Nachweis, den ein
 * Abzug byte-gleich festhält, keine Zahl. Bis {@code messreihe_viertelstunde} die beiden Anteile
 * selbst trägt, liefert diese Regel für einen Momentanwert-Kanal {@code null}.
 */
final class Richtungspaar {

    private Richtungspaar() {
    }

    /**
     * Was eine Periode über ihre beiden Flussrichtungen sagt: die Wörter aus
     * {@link MessstelleRegeln#RICHTUNGSPAAR} und die beiden gespeicherten Mengen. Die NETTO-Menge
     * bleibt daneben, wo sie war — dies ist kein zweiter Wert der Messstelle, sondern ihr Aufbau.
     *
     * @param positivWort „Laden“ bzw. „Bezug“
     * @param negativWort „Entladen“ bzw. „Abgabe“
     */
    record Paar(String positivWort, String negativWort, BigDecimal positiv, BigDecimal negativ) {}

    /**
     * Das gespeicherte Richtungspaar EINER Periode einer Reihe — {@link Optional#empty()}, wenn die
     * Reihe keine zwei Richtungen führt oder die Periode ihr Paar nicht trägt (vor
     * {@code V20260918101000} verdichtet). Der Abzug eines Berichts liest hier ab, statt zu rechnen.
     *
     * @param spur {@code entity_id = ? AND messkanal = ?} bzw. {@code messstelle_id = ?} wie beim
     *     Lesen der Basis; {@code spurArgs} sind seine Werte
     */
    static Optional<Paar> derPeriode(JdbcTemplate j, MeasurementCatalog katalog, UUID tenant, String kanal,
            String art, Instant beginn, String spur, List<Object> spurArgs) {
        Map<String, String> woerter = woerter(katalog, kanal);
        if (woerter == null) {
            return Optional.empty();
        }
        List<Object> args = new java.util.ArrayList<>(List.of(tenant, art, java.sql.Timestamp.from(beginn)));
        args.addAll(spurArgs);
        List<BigDecimal[]> zeilen = j.query(
                "SELECT menge_positiv, menge_negativ FROM messreihe_periode "
                        + "WHERE tenant_id = ? AND art = ? AND beginn = ? AND " + spur,
                (rs, i) -> new BigDecimal[] {rs.getBigDecimal(1), rs.getBigDecimal(2)}, args.toArray());
        if (zeilen.isEmpty() || zeilen.get(0)[0] == null || zeilen.get(0)[1] == null) {
            return Optional.empty();
        }
        return Optional.of(new Paar(woerter.get(MessstelleRegeln.ANTEIL_POSITIV),
                woerter.get(MessstelleRegeln.ANTEIL_NEGATIV), zeilen.get(0)[0], zeilen.get(0)[1]));
    }

    /** Die beiden Wörter des Kanals, {@code null} ohne zwei Richtungen. */
    static Map<String, String> woerter(MeasurementCatalog katalog, String kanal) {
        MeasurementCatalog.Semantik s = kanal == null ? null : katalog.semantik(kanal);
        return s == null || s.direction() == null ? null : MessstelleRegeln.RICHTUNGSPAAR.get(s.direction());
    }

    /**
     * Das Paar aus den Viertelstunden einer Periode — für Tag und Monat, die beide unmittelbar auf
     * den Viertelstunden stehen.
     *
     * @param kanal der Messkanal (Katalogpunkt), dessen Richtung entscheidet
     * @param wertart die Wertart der Reihe; nur {@code intervallmenge} trägt ein Paar
     * @param werteteile die Viertelstunden; nur die in {@code [beginn, ende)} zählen
     * @return {@code {positiv, negativ}} oder {@code null}, wenn es keine Aussage gibt
     */
    static BigDecimal[] ausTeilen(MeasurementCatalog katalog, String kanal, String wertart,
            List<VerbrauchRegeln.Werteteil> werteteile, Instant beginn, Instant ende) {
        // Nur die Intervallmenge: dort IST der Viertelstunden-Wert die vorzeichenbehaftete Menge
        // dieser Viertelstunde, die Zerlegung also exakt. Für den Momentanwert siehe den Klassen-
        // kommentar — er braucht die Rohwerte, nicht diese Ebene.
        if (!zweiRichtungen(katalog, kanal) || !"intervallmenge".equals(ViertelstundeRegeln.regelWort(wertart))) {
            return null;
        }
        Summe s = new Summe();
        for (VerbrauchRegeln.Werteteil w : werteteile) {
            VerbrauchRegeln.Teilperiode t = w.teil();
            if (t == null || t.von().isBefore(beginn) || !t.von().isBefore(ende)) {
                continue;
            }
            s.nimm(VerbrauchRegeln.anteilDesWerts(w.summe(), MessstelleRegeln.ANTEIL_POSITIV),
                    VerbrauchRegeln.anteilDesWerts(w.summe(), MessstelleRegeln.ANTEIL_NEGATIV));
        }
        return s.fertig();
    }

    /** Führt der Katalogkanal zwei Flussrichtungen in EINER Größe? */
    static boolean zweiRichtungen(MeasurementCatalog katalog, String kanal) {
        return woerter(katalog, kanal) != null;
    }

    /**
     * Die laufende Summe über die Teile einer Periode — für das Jahr, das seine Monate summiert.
     * Fehlt EIN Teil sein Paar, fehlt es der ganzen Periode: eine Summe über die halbe Wahrheit
     * wäre eine Zahl, die niemand nachrechnen kann.
     */
    static final class Summe {
        private BigDecimal positiv = BigDecimal.ZERO;
        private BigDecimal negativ = BigDecimal.ZERO;
        private boolean gesehen;
        private boolean luecke;

        void nimm(BigDecimal p, BigDecimal n) {
            if (p == null || n == null) {
                luecke = true;
                return;
            }
            gesehen = true;
            positiv = positiv.add(p);
            negativ = negativ.add(n);
        }

        BigDecimal[] fertig() {
            return gesehen && !luecke ? new BigDecimal[] {positiv, negativ} : null;
        }
    }
}
