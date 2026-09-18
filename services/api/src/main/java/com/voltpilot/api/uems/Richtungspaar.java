package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.MeasurementCatalog;
import java.math.BigDecimal;
import java.time.Duration;
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
 * <p><b>Der MOMENTANWERT — und das ist heute jeder Speicher.</b> Im gepackten Katalog trägt
 * <em>jeder</em> Kanal mit zwei Richtungen {@code active_power} in W, also einen Momentanwert:
 * 5 × {@code charge_discharge}, 49 × {@code import_export}, kein einziger als Intervallmenge. Seine
 * Menge entsteht durch INTEGRATION der Leistung ({@code VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT} —
 * das Kennzeichen, das MS-04 im Referenzfall trägt). Sein Anteil entsteht darum in
 * {@link #jeRohwert}: die Integration von {@code max(0, P)} bzw. {@code max(0, −P)} <b>je
 * Rohwert</b>, in der Viertelstunden-Verdichtung, wie AP-08 E15/M5 es verlangt. Ab der Tages-Ebene
 * ist die Viertelstunde schon zu EINER Energie verdichtet; {@link #ausTeilen} summiert von dort an
 * nur noch die GESPEICHERTEN Anteile, es rechnet keinen mehr aus.
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
        return mengenDerPeriode(j, tenant, art, beginn, spur, spurArgs)
                .map(m -> new Paar(woerter.get(MessstelleRegeln.ANTEIL_POSITIV),
                        woerter.get(MessstelleRegeln.ANTEIL_NEGATIV), m[0], m[1]));
    }

    /**
     * Nur die beiden ZAHLEN der Periode, ohne den Katalog zu fragen — für einen Aufrufer, der die
     * Wörter schon kennt.
     *
     * <p>Der Berichts-Abzug ist so einer: dass eine Messstelle „Laden / Entladen“ führt, sagt ihre
     * eigene Hauptgröße (AP-04), nicht der Katalogpunkt ihrer heutigen Quellenbindung. Die Bindung
     * kann wechseln; wie die Messstelle ihre zwei Flüsse nennt, bleibt. Dass das Paar überhaupt
     * dasteht, hat die Verdichtung schon entschieden — sie schreibt es nur für einen
     * Zwei-Richtungs-Kanal.
     */
    static Optional<BigDecimal[]> mengenDerPeriode(JdbcTemplate j, UUID tenant, String art, Instant beginn,
            String spur, List<Object> spurArgs) {
        List<Object> args = new java.util.ArrayList<>(List.of(tenant, art, java.sql.Timestamp.from(beginn)));
        args.addAll(spurArgs);
        List<BigDecimal[]> zeilen = j.query(
                "SELECT menge_positiv, menge_negativ FROM messreihe_periode "
                        + "WHERE tenant_id = ? AND art = ? AND beginn = ? AND " + spur,
                (rs, i) -> new BigDecimal[] {rs.getBigDecimal(1), rs.getBigDecimal(2)}, args.toArray());
        if (zeilen.isEmpty() || zeilen.get(0)[0] == null || zeilen.get(0)[1] == null) {
            return Optional.empty();
        }
        return Optional.of(zeilen.get(0));
    }

    /** Die beiden Wörter des Kanals, {@code null} ohne zwei Richtungen. */
    static Map<String, String> woerter(MeasurementCatalog katalog, String kanal) {
        MeasurementCatalog.Semantik s = kanal == null ? null : katalog.semantik(kanal);
        return s == null || s.direction() == null ? null : MessstelleRegeln.RICHTUNGSPAAR.get(s.direction());
    }

    /**
     * Der Anteil EINER Viertelstunde, je Rohwert gebildet (AP-08 E15/M5) — {@code {positiv,
     * negativ}} als Energie, oder {@code null}, wenn es keine Aussage gibt.
     *
     * <p>Es gibt sie nur, wenn der Kanal zwei Flussrichtungen in EINER Größe führt <b>und</b> seine
     * Menge aus integrierter Leistung entsteht (Momentanwert mit Integrations-Bindung). Ein
     * Zählerstand hat keine Vorzeichen-Teile (die Menge ist der Zuwachs zweier Stände), und ohne
     * Integrations-Bindung gibt es gar keine Energie (E5).
     *
     * <p>Die Rohwerte werden mit {@link VerbrauchRegeln#anteilJeRohwert} getrennt und dann mit
     * derselben Regel integriert, die {@code energie} bildet — nicht nachgebaut, sondern
     * aufgerufen. Eine Reihe ohne Vorzeichenwechsel bekommt so auf der einen Seite ihre Energie und
     * auf der anderen 0; beides ist gemessen, keines geraten.
     */
    static BigDecimal[] jeRohwert(MeasurementCatalog katalog, String kanal, String wertart,
            boolean integrieren, List<VerbrauchRegeln.Rohwert> werte, Instant von, Instant bis,
            Duration kadenz) {
        if (!zweiRichtungen(katalog, kanal) || !integrieren
                || !"momentanwert".equals(ViertelstundeRegeln.regelWort(wertart))) {
            return null;
        }
        VerbrauchRegeln.Werteteil positiv = VerbrauchRegeln.momentanwertTeil(
                VerbrauchRegeln.anteilJeRohwert(werte, MessstelleRegeln.ANTEIL_POSITIV), von, bis, kadenz, true);
        VerbrauchRegeln.Werteteil negativ = VerbrauchRegeln.momentanwertTeil(
                VerbrauchRegeln.anteilJeRohwert(werte, MessstelleRegeln.ANTEIL_NEGATIV), von, bis, kadenz, true);
        if (positiv == null || negativ == null || positiv.energie() == null || negativ.energie() == null) {
            return null;
        }
        return new BigDecimal[] {positiv.energie().abs(), negativ.energie().abs()};
    }

    /**
     * Das Paar einer Periode aus den GESPEICHERTEN Anteilen ihrer Viertelstunden — für Tag und
     * Monat, die beide unmittelbar auf den Viertelstunden stehen. Hier wird nichts mehr gerechnet:
     * die Anteile stehen seit {@code V20260918104000} in {@code messreihe_viertelstunde}, gebildet
     * je Rohwert.
     *
     * @param anteile je Viertelstunde ihr {@code {positiv, negativ}} oder {@code null}
     * @return {@code {positiv, negativ}} oder {@code null}, wenn es keine Aussage gibt
     */
    static BigDecimal[] ausTeilen(List<ViertelstundenTeile.Anteil> anteile, Instant beginn, Instant ende) {
        Summe s = new Summe();
        boolean einer = false;
        for (ViertelstundenTeile.Anteil a : anteile) {
            if (a.von().isBefore(beginn) || !a.von().isBefore(ende)) {
                continue;
            }
            einer = true;
            s.nimm(a.positiv(), a.negativ());
        }
        return einer ? s.fertig() : null;
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
