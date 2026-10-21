package com.voltpilot.api.erzeuger;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.erzeuger.VorgabenAbleitung.Luecke;
import com.voltpilot.api.erzeuger.VorgabenAbleitung.Vorgabe;
import com.voltpilot.api.erzeuger.VorgabenVerlauf.Probe;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Speicher des {@link VorgabenLaeufer}s (UEMS EZ-7): Anlagensteuerungen, Proben und Ereignisse lesen, Vorgaben,
 * Lücken und den Stand schreiben. Läuft als Laufzeitrolle unter dem Mandanten des Takts ({@code TenantContext});
 * die Messdaten liest er ohne {@code site}-Join — nur der Takt ruft ihn, nie eine Anfrage.
 */
@Repository
public class VorgabenLaufRepository {

    /** Eine Anlagensteuerung, wie der Läufer sie braucht. {@code teAnzahl}/{@code anlagenart} aus der laufenden Fassung. */
    public record Steuerung(UUID geraetId, UUID siteId, UUID entityId, UUID dataSourceId, Instant eingerichtet,
            int teAnzahl, String anlagenart, String biddingZone, Map<Integer, BigDecimal> nennKw) {}

    /** Der gespeicherte Stand: bis wohin verarbeitet, und der Zustand der Ableitung als JSON. */
    public record Stand(Instant verarbeitetBis, String zustand) {}

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public VorgabenLaufRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Die eingebauten Anlagensteuerungen des Mandanten mit Komponente; Einrichtung = Beginn der Bindung. */
    public List<Steuerung> steuerungen() {
        List<Steuerung> out = jdbc.query("SELECT g.id, g.site_id, v.entity_id, g.data_source_id, v.gueltig_ab, "
                + "f.te_anzahl, f.anlagenart, s.bidding_zone "
                + "FROM geraet g "
                + "JOIN site s ON s.id = g.site_id "
                + "JOIN geraet_komponente v ON v.geraet_id = g.id AND v.gueltig_ab <= now() "
                + "AND (v.gueltig_bis IS NULL OR v.gueltig_bis > now()) "
                + "JOIN measurement_point m ON m.id = v.entity_id AND m.entity_type = '"
                + AnlagensteuerungRepository.ENTITY_TYPE + "' "
                + "LEFT JOIN registerbild_fassung f ON f.geraet_id = g.id AND f.gueltig_ab <= now() "
                + "AND (f.gueltig_bis IS NULL OR f.gueltig_bis > now()) "
                + "WHERE g.geraeteart = 'controller' AND g.ausgebaut_am IS NULL ORDER BY g.id",
                (rs, n) -> new Steuerung(rs.getObject("id", UUID.class), rs.getObject("site_id", UUID.class),
                        rs.getObject("entity_id", UUID.class), rs.getObject("data_source_id", UUID.class),
                        rs.getTimestamp("gueltig_ab").toInstant(),
                        rs.getObject("te_anzahl") == null ? 0 : rs.getInt("te_anzahl"), rs.getString("anlagenart"),
                        rs.getString("bidding_zone"), Map.of()));
        return out.stream().map(s -> {
            Map<Integer, BigDecimal> nenn = new HashMap<>();
            jdbc.query("SELECT te_nr, nennleistung_kw FROM geraet_teil WHERE geraet_id = ? "
                    + "AND teilart = 'erzeugungseinheit' AND ausgebaut_am IS NULL AND nennleistung_kw IS NOT NULL",
                    rs -> {
                        nenn.put(rs.getInt("te_nr"), rs.getBigDecimal("nennleistung_kw"));
                    }, s.geraetId());
            int teAnzahl = s.teAnzahl() > 0 ? s.teAnzahl()
                    : Math.max(1, nenn.keySet().stream().mapToInt(Integer::intValue).max().orElse(1));
            return new Steuerung(s.geraetId(), s.siteId(), s.entityId(), s.dataSourceId(), s.eingerichtet(),
                    teAnzahl, s.anlagenart(), s.biddingZone(), Map.copyOf(nenn));
        }).toList();
    }

    /**
     * Die Steuerung für diesen Lauf sperren: nur ein Takt (auch über mehrere api-Instanzen) leitet sie gleichzeitig
     * ab. Gilt bis zum Ende der Transaktion; false = ein anderer ist dran.
     */
    public boolean sperre(UUID geraetId) {
        Boolean frei = jdbc.queryForObject("SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0))", Boolean.class,
                "erzeuger_vorgabe:" + geraetId);
        return Boolean.TRUE.equals(frei);
    }

    public Optional<Stand> stand(UUID geraetId) {
        return jdbc.query("SELECT verarbeitet_bis, zustand::text AS zustand FROM erzeuger_vorgabe_lauf "
                + "WHERE geraet_id = ?", (rs, n) -> new Stand(rs.getTimestamp("verarbeitet_bis").toInstant(),
                        rs.getString("zustand")), geraetId).stream().findFirst();
    }

    /** Die jüngste Lesezeit eines Punkts des Bilds nach {@code ab} — leer ohne neue Werte. */
    public Optional<Instant> juengsteProbe(UUID tenant, UUID entityId, List<String> punkte, Instant ab) {
        Timestamp t = jdbc.queryForObject("SELECT max(d.time) FROM device_measurement_sample d "
                + "WHERE d.tenant_id = ? AND d.entity_id = ? AND d.point_key = ANY(?) AND d.time > ? "
                + "AND d.role IS DISTINCT FROM 'spiegel'", Timestamp.class, tenant, entityId,
                punkte.toArray(String[]::new), Timestamp.from(ab));
        return Optional.ofNullable(t).map(Timestamp::toInstant);
    }

    /** Die Proben der Punkte in {@code (ab, bis]}, nach Zeit. */
    public List<Probe> proben(UUID tenant, UUID entityId, List<String> punkte, Instant ab, Instant bis) {
        return jdbc.query("SELECT d.time, d.point_key, coalesce(d.decoded_numeric, d.raw_numeric) AS wert, d.quality "
                + "FROM device_measurement_sample d WHERE d.tenant_id = ? AND d.entity_id = ? "
                + "AND d.point_key = ANY(?) AND d.time > ? AND d.time <= ? AND d.role IS DISTINCT FROM 'spiegel' "
                + "ORDER BY d.time, d.point_key",
                (rs, n) -> new Probe(rs.getTimestamp("time").toInstant(), rs.getString("point_key"),
                        rs.getBigDecimal("wert"), rs.getString("quality")),
                tenant, entityId, punkte.toArray(String[]::new), Timestamp.from(ab), Timestamp.from(bis));
    }

    /**
     * Gemeldete Datenlücken ({@code data_gap}) der Boxen, die diese Steuerung in {@code (ab, bis]} gelesen haben:
     * die Box hat Werte verworfen — was in die Zeit fällt, ist unvollständig.
     */
    public List<Instant> datenluecken(UUID tenant, UUID entityId, Instant ab, Instant bis) {
        return jdbc.queryForList("SELECT e.occurred_at FROM device_measurement_event e "
                + "WHERE e.tenant_id = ? AND e.event_kind = 'data_gap' AND e.occurred_at > ? AND e.occurred_at <= ? "
                + "AND e.device_id IN (SELECT DISTINCT d.device_id FROM device_measurement_sample d "
                + "WHERE d.tenant_id = ? AND d.entity_id = ? AND d.time > ? AND d.time <= ?) ORDER BY e.occurred_at",
                Timestamp.class, tenant, Timestamp.from(ab), Timestamp.from(bis), tenant, entityId,
                Timestamp.from(ab), Timestamp.from(bis)).stream().map(Timestamp::toInstant).toList();
    }

    /** Neustarts der Steuerung ({@code device_restart} der Box, EZ-5) in {@code (ab, bis]}. */
    public List<Instant> neustarts(UUID entityId, UUID dataSourceId, Instant ab, Instant bis) {
        return jdbc.queryForList("SELECT r.zeit FROM messreihe_ereignis r WHERE r.art = 'device_restart' "
                + "AND r.zeit > ? AND r.zeit <= ? AND (r.entity_id = ? OR (r.entity_id IS NULL AND r.data_source_id = ?)) "
                + "ORDER BY r.zeit", Timestamp.class, Timestamp.from(ab), Timestamp.from(bis), entityId,
                dataSourceId).stream().map(Timestamp::toInstant).toList();
    }

    /**
     * Was eine Runde der Ableitung ergab, in derselben Transaktion wie der neue Stand: geänderte Vorgaben (über ihre
     * Kennung, ein zweites Schreiben ersetzt), neue Lücken, verarbeitet bis {@code bis}.
     */
    public void speichere(UUID tenant, Steuerung s, List<Vorgabe> vorgaben, List<Luecke> luecken, Instant bis,
            int fassung, VorgabenAbleitung.Zustand zustand) {
        for (Vorgabe v : vorgaben) {
            jdbc.update("INSERT INTO erzeuger_vorgabe (id, tenant_id, site_id, geraet_id, te_nr, urheber, art, beginn, "
                    + "beginn_genau, ende, ende_genau, gesehen_bis, vorgabe_prozent, vorgabe_w, ist_mittel_w, "
                    + "verfuegbar_mittel_w, energie_kwh, methode, energie_je_tag, wert_eur, kanal, bindung, "
                    + "unvollstaendig, neustart, zaehler_beginn, zaehler_ende, gruende, roh_beginn, roh_ende, "
                    + "aktualisiert_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, "
                    + "?, ?, ?, ?::text[], ?::jsonb, ?::jsonb, now()) "
                    + "ON CONFLICT (id, beginn) DO UPDATE SET ende = EXCLUDED.ende, ende_genau = EXCLUDED.ende_genau, "
                    + "gesehen_bis = EXCLUDED.gesehen_bis, vorgabe_prozent = EXCLUDED.vorgabe_prozent, "
                    + "vorgabe_w = EXCLUDED.vorgabe_w, ist_mittel_w = EXCLUDED.ist_mittel_w, "
                    + "verfuegbar_mittel_w = EXCLUDED.verfuegbar_mittel_w, energie_kwh = EXCLUDED.energie_kwh, "
                    + "methode = EXCLUDED.methode, energie_je_tag = EXCLUDED.energie_je_tag, "
                    + "wert_eur = EXCLUDED.wert_eur, kanal = EXCLUDED.kanal, bindung = EXCLUDED.bindung, "
                    + "unvollstaendig = EXCLUDED.unvollstaendig, neustart = EXCLUDED.neustart, "
                    + "zaehler_beginn = EXCLUDED.zaehler_beginn, zaehler_ende = EXCLUDED.zaehler_ende, "
                    + "gruende = EXCLUDED.gruende, roh_beginn = EXCLUDED.roh_beginn, roh_ende = EXCLUDED.roh_ende, "
                    + "aktualisiert_am = now()",
                    v.id, tenant, s.siteId(), s.geraetId(), v.teNr, v.urheber, v.art, Timestamp.from(v.beginn),
                    v.beginnGenau, v.ende == null ? null : Timestamp.from(v.ende), v.endeGenau,
                    Timestamp.from(v.gesehenBis == null ? v.beginn : v.gesehenBis), v.kleinsteProzent, v.kleinsteW,
                    v.istMittelW(), v.verfuegbarMittelW(), v.energieKwh(), v.methode, text(v.energieJeTagKwh()),
                    v.wertEur(), v.kanal, v.bindung(), v.unvollstaendig, v.neustart, zahl(v.zaehlerBeginn),
                    zahl(v.zaehlerEnde), "{" + String.join(",", v.gruende) + "}",
                    text(v.rohBeginn == null ? Map.of() : v.rohBeginn), text(v.rohEnde == null ? Map.of() : v.rohEnde));
        }
        for (Luecke l : luecken) {
            jdbc.update("INSERT INTO erzeuger_vorgabe_luecke (id, tenant_id, site_id, geraet_id, urheber, beginn, ende, "
                    + "weitere_wechsel, neustart, zaehler_vorher, zaehler_nachher) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    + "ON CONFLICT (id, beginn) DO NOTHING", l.id(), tenant, s.siteId(), s.geraetId(), l.urheber(),
                    Timestamp.from(l.beginn()), Timestamp.from(l.ende()), l.weitereWechsel(), l.neustart(),
                    zahl(l.zaehlerVorher()), zahl(l.zaehlerNachher()));
        }
        jdbc.update("INSERT INTO erzeuger_vorgabe_lauf (geraet_id, tenant_id, site_id, verarbeitet_bis, fassung, zustand, "
                + "aktualisiert_am) VALUES (?, ?, ?, ?, ?, ?::jsonb, now()) ON CONFLICT (geraet_id) DO UPDATE SET "
                + "verarbeitet_bis = EXCLUDED.verarbeitet_bis, fassung = EXCLUDED.fassung, zustand = EXCLUDED.zustand, "
                + "aktualisiert_am = now()", s.geraetId(), tenant, s.siteId(), Timestamp.from(bis), fassung,
                text(zustand));
    }

    private static Integer zahl(Long wert) {
        return wert == null ? null : Math.toIntExact(wert);
    }

    private String text(Object wert) {
        try {
            return json.writeValueAsString(wert);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Vorgabe nicht als JSON schreibbar", e);
        }
    }
}
