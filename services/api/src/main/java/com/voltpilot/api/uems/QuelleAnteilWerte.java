package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.web.dto.MesskanalDto;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der Leseweg einer Quellenbindung MIT ANTEIL (UEMS AP-08 IP-7, E15 = A; Vertrag
 * {@code verbrauch-vectors.json} {@code regeln.anteil}, Vektor F19): was eine Messstelle über eine
 * Periode aus dem positiven oder negativen Teil eines Vorzeichen-Werts liest — Mittel, Min, Max und
 * die Energie je Anteil.
 *
 * <p><b>Geteilt wird JE ROHWERT, nie je Mittelwert.</b> Die Rohwerte der Reihe (Komponente + Kanal)
 * kommen aus {@code device_measurement_sample}; geteilt und gerechnet wird ausschließlich in
 * {@link VerbrauchRegeln#momentanwerteAnteil} — hier wird nichts gemittelt, nichts zugeordnet und
 * kein Vorzeichen gedreht. Die gespeicherte Viertelstunde der Reihe ({@code messreihe_viertelstunde})
 * ist der GANZE Vorzeichen-Wert und taugt dafür nicht: aus ihrem Mittel ließe sich der Anteil nicht
 * mehr zurückgewinnen (E15 Option C, verworfen).
 *
 * <p><b>Das Box-Vorzeichen wirkt genau einmal.</b> Die Box wendet „Vorzeichen umgekehrt“ beim
 * Erfassen an (AP-04 E5); der gespeicherte Rohwert ist vorzeichenrichtig (+ = Bezug). Dieser Weg liest
 * darum keine Einstellungs-Fassung — ein falsch gesetztes Vorzeichen korrigiert eine neue Fassung ab
 * Zeitpunkt, die Vergangenheit eine Korrektur (AP-08 IP-12 ff.), nie dieser Leseweg.
 *
 * <p><b>Kein Saldo</b> (E12): der Anteil ist eine eigene Menge mit eigenem Kennzeichen
 * („positiver Anteil von K-3 · Wirkleistung“) — Bezug minus Abgabe entsteht nur als berechnete
 * Messstelle (AP-10).
 *
 * <p>Die Energie je Anteil gibt es, weil E15 sie ausdrücklich nennt; einen Anteil hat nach Regel 7 nur
 * eine Leistung mit Vorzeichen, nie eine Spannung. Sie steht wie jede Energie aus Leistung nur mit dem
 * Kennzeichen „aus Leistung integriert“ und nie über eine Lücke.
 *
 * <p>Gerechnet wird in kW (die Einheit der Größe „Wirkleistung“): der Katalog führt jeden Vorzeichen-Wert
 * in W, und der Wert wird VOR dem Teilen mit dem festen Faktor seiner Einheit umgerechnet — eine
 * Skalierung, die mit {@code max(0, ·)} vertauscht. Eine andere Einheit wird nicht geraten: dann gibt es
 * keine Periode.
 *
 * <p>Grenzen: nur so weit die Rohdaten reichen (Rohdaten-Frist); keine Speicherklasse je Anteil und
 * kein Lese-Modell je Messstelle (AP-08 IP-9 entscheidet, wer hier anruft). Unter RLS: eine fremde
 * Bindung ist nicht da ({@link Optional#empty()}).
 */
@Component
public class QuelleAnteilWerte {

    /** Wie viele kW ein Wert der Kanal-Einheit ist — die Einheiten der Wirkleistung (Regel 7). */
    private static final Map<String, BigDecimal> KW_JE_EINHEIT = Map.of(
            "W", new BigDecimal("0.001"), "kW", BigDecimal.ONE, "MW", BigDecimal.valueOf(1000));

    private final JdbcTemplate jdbc;
    private final MesskanalService kanaele;
    private final QuelleKadenzRepository kadenzen;

    public QuelleAnteilWerte(JdbcTemplate jdbc, MesskanalService kanaele, QuelleKadenzRepository kadenzen) {
        this.jdbc = jdbc;
        this.kanaele = kanaele;
        this.kadenzen = kadenzen;
    }

    /**
     * Eine Periode, wie die Bindung sie liest.
     *
     * @param anteil {@code positiv} | {@code negativ}
     * @param quelle wie das Kennzeichen die Quelle nennt: Komponente · Messwert
     * @param kadenzS die wirksame Kadenz zu Beginn der Periode (Fassung → Mess-Selektion → Katalog)
     * @param ergebnis Mittel/Min/Max in kW, die Energie in kWh
     */
    public record Periode(UUID quelleId, String anteil, String quelle, int kadenzS, VerbrauchRegeln.Ergebnis ergebnis) {}

    private record Bindung(UUID entityId, String kanal, String anteil, String komponente, Instant gueltigAb,
            Instant gueltigBis) {}

    /**
     * Die Periode {@code [von, bis)} einer Bindung mit Anteil. Leer, wenn es die Bindung (für diesen
     * Mandanten) nicht gibt, sie keinen Anteil trägt — der ganze Wert hat seine Wege schon — oder der
     * Kanal keine Einheit der Wirkleistung nennt.
     * Gezählt werden nur Rohwerte, solange die Bindung gilt.
     */
    public Optional<Periode> periode(UUID quelleId, Instant von, Instant bis) {
        Bindung b = jdbc.query("""
                SELECT q.entity_id, q.kanal, q.anteil, p.label, q.gueltig_ab, q.gueltig_bis
                  FROM messstelle_quelle q
                  JOIN measurement_point p ON p.id = q.entity_id
                 WHERE q.id = ? AND q.anteil IS NOT NULL
                """, (rs, n) -> new Bindung(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3),
                        rs.getString(4), rs.getTimestamp(5).toInstant(),
                        rs.getTimestamp(6) == null ? null : rs.getTimestamp(6).toInstant()), quelleId)
                .stream().findFirst().orElse(null);
        if (b == null) {
            return Optional.empty();
        }
        Optional<MesskanalDto.Messkanal> kanal = kanaele.kanal(b.entityId(), b.kanal());
        BigDecimal kwJeWert = kanal.map(MesskanalDto.Messkanal::einheit).map(KW_JE_EINHEIT::get).orElse(null);
        if (kwJeWert == null) {
            return Optional.empty();
        }
        int kadenzS = kanaele.kadenz(b.kanal(), kanal.map(MesskanalDto.Messkanal::kadenzS).orElse(null),
                kadenzen.jeBindung(List.of(quelleId), von).get(quelleId)).erwartetS();
        Duration kadenz = Duration.ofSeconds(kadenzS);
        String name = kanal.map(MesskanalDto.Messkanal::anzeigename).orElse(null);
        String quelle = (b.komponente() == null ? "Komponente" : b.komponente()) + " · "
                + (name == null ? b.kanal() : name);

        // Das Halten über die Grenzen braucht die Nachbarn bis HALTEN_FAKTOR × Kadenz (M4, F24).
        Duration rand = kadenz.multipliedBy(VerbrauchRegeln.HALTEN_FAKTOR);
        Instant ab = von.minus(rand).isBefore(b.gueltigAb()) ? b.gueltigAb() : von.minus(rand);
        Instant ende = bis.plus(rand);
        if (b.gueltigBis() != null && b.gueltigBis().isBefore(ende)) {
            ende = b.gueltigBis();
        }
        List<VerbrauchRegeln.Rohwert> werte = jdbc.query("""
                SELECT s.time, coalesce(s.decoded_numeric, s.raw_numeric) AS zahl, s.quality
                  FROM device_measurement_sample s
                 WHERE s.entity_id = ? AND s.point_key = ?
                   AND s.entity_id IS NOT NULL AND s.role IS DISTINCT FROM 'spiegel'
                   AND s.time >= ? AND s.time < ?
                   AND coalesce(s.decoded_numeric, s.raw_numeric) IS NOT NULL
                 ORDER BY s.time, s.received_at
                """, (rs, n) -> new VerbrauchRegeln.Rohwert(rs.getTimestamp(1).toInstant(),
                        rs.getBigDecimal(2).multiply(kwJeWert), "good".equals(rs.getString(3))),
                b.entityId(), b.kanal(), Timestamp.from(ab), Timestamp.from(ende));

        VerbrauchRegeln.Ergebnis e = VerbrauchRegeln.momentanwerteAnteil(werte, von, bis, kadenz, true,
                b.anteil(), quelle);
        return Optional.of(new Periode(quelleId, b.anteil(), quelle, kadenzS, e));
    }
}
