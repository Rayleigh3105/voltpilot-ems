package com.voltpilot.api.mispel;

import com.voltpilot.api.mispel.LadepunktRegeln.Abfahrt;
import com.voltpilot.api.mispel.LadepunktRegeln.Faehigkeit;
import com.voltpilot.api.mispel.LadepunktRegeln.Fahrzeugfenster;
import com.voltpilot.api.mispel.LadepunktRegeln.Fenster;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Time;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der bidirektionale Ladepunkt (MiSpeL MP-31, V20261002214500) unter RLS: die Ladepunkt-Komponenten einer Anlage,
 * die Fassungen ihrer Fähigkeit (nie gelöscht, nie umgeschrieben — die App-Rolle setzt nur {@code aufgehoben_am})
 * und der laufende Stand des Fahrzeugfensters.
 */
@Repository
public class LadepunktRepository {

    /** Die Katalog-Typen eines Ladepunkts ({@code TopologyDeriver.isChargingType}). */
    static final List<String> TYPEN = List.of("ev-charger", "wallbox");

    private static final String KOMPONENTE = "SELECT mp.id, mp.label, mp.entity_type, "
            + "(SELECT cp.charge_point_id FROM device_charge_point cp WHERE cp.entity_id = mp.id "
            + "ORDER BY cp.reported_at DESC LIMIT 1) AS charge_point_id "
            + "FROM measurement_point mp WHERE mp.site_id = ? AND mp.entity_type IN ('ev-charger', 'wallbox') ";
    private static final String FAEHIGKEIT = "SELECT id, komponente_id, nutzbarkeit, v2h, v2g, "
            + "rueckspeisung_bei_einspeisung_unterbunden, rueckspeiseleistung_kw, gueltig_ab, aufgehoben_am, created_at, "
            + "created_by FROM ladepunkt_faehigkeit ";
    private static final String ORDNUNG = " ORDER BY komponente_id, gueltig_ab, created_at, id";

    private final JdbcTemplate jdbc;

    public LadepunktRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Eine Ladepunkt-Komponente; {@code chargePointId} = die OCPP-Kennung, wenn die Box sie gemeldet hat. */
    public record Komponente(UUID id, String label, String typ, String chargePointId) {}

    /** Eine Fassung der Fähigkeit, wie sie gespeichert ist. */
    public record Fassung(UUID id, UUID komponenteId, Faehigkeit faehigkeit, LocalDate gueltigAb, Instant aufgehobenAm,
            Instant eingetragenAm, String eingetragenVon) {
        public boolean aufgehoben() {
            return aufgehobenAm != null;
        }
    }

    /** Das Fahrzeugfenster mit seinem Änderungsstempel. */
    public record FensterStand(Fahrzeugfenster fenster, Instant geaendertAm, String geaendertVon) {}

    /** {@code true} = die Anlage ist unter RLS sichtbar. */
    public boolean anlageSichtbar(UUID siteId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM site WHERE id = ?)", Boolean.class,
                siteId));
    }

    /** Die Ladepunkte der Anlage — leer für eine fremde. */
    public List<Komponente> derAnlage(UUID siteId) {
        return List.copyOf(jdbc.query(KOMPONENTE + "ORDER BY mp.created_at, mp.id", LadepunktRepository::komponente,
                siteId));
    }

    /** Ein Ladepunkt der Anlage; leer, wenn die Komponente fremd, unbekannt oder kein Ladepunkt ist. */
    public Optional<Komponente> finde(UUID siteId, UUID komponenteId) {
        return jdbc.query(KOMPONENTE + "AND mp.id = ?", LadepunktRepository::komponente, siteId, komponenteId).stream()
                .findFirst();
    }

    /** Die Fassungen eines Ladepunkts, aufgehobene eingeschlossen. */
    public List<Fassung> fassungen(UUID komponenteId) {
        return List.copyOf(jdbc.query(FAEHIGKEIT + "WHERE komponente_id = ?" + ORDNUNG, LadepunktRepository::fassung,
                komponenteId));
    }

    /** Die Fassungen aller Ladepunkte der Anlage — ein Lesezug. */
    public List<Fassung> fassungenDerAnlage(UUID siteId) {
        return List.copyOf(jdbc.query(FAEHIGKEIT + "WHERE site_id = ?" + ORDNUNG, LadepunktRepository::fassung, siteId));
    }

    public UUID eintragen(UUID tenantId, UUID siteId, UUID komponenteId, Faehigkeit f, LocalDate gueltigAb, String von) {
        return jdbc.queryForObject("INSERT INTO ladepunkt_faehigkeit (tenant_id, site_id, komponente_id, nutzbarkeit, "
                + "v2h, v2g, rueckspeisung_bei_einspeisung_unterbunden, rueckspeiseleistung_kw, gueltig_ab, created_by) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, tenantId, siteId, komponenteId,
                f.nutzbarkeit(), f.v2h(), f.v2g(), f.rueckspeisungBeiEinspeisungUnterbunden(),
                f.rueckspeiseleistungKw(), gueltigAb, von);
    }

    public boolean aufheben(UUID id, Instant am) {
        return jdbc.update("UPDATE ladepunkt_faehigkeit SET aufgehoben_am = ? WHERE id = ? AND aufgehoben_am IS NULL",
                Timestamp.from(am), id) == 1;
    }

    /**
     * MiSpeL MP-38: die letzte signierte Ablesung (OCMF) des Ladepunkts vor {@code bis}, über die OCPP-Kennungen,
     * die der Herzschlag dieser Komponente zuordnet ({@code device_charge_point.entity_id}). Leer = die Säule hat
     * bis dahin keinen signierten Messwert geliefert.
     */
    public Optional<SignierterMesswert> signierterMesswert(UUID siteId, UUID komponenteId, Instant bis) {
        return jdbc.query("SELECT s.gemessen_am, s.zeit, s.anlass, s.wert_text, s.einheit, s.obis, s.zaehlerkennung, "
                + "s.signaturstatus, s.pruefgrund, s.schluessel_quelle, s.schluessel_sha256, s.charge_point_id "
                + "FROM ladepunkt_signierter_messwert s JOIN device_charge_point cp "
                + "ON cp.device_id = s.device_id AND cp.charge_point_id = s.charge_point_id "
                + "WHERE s.site_id = ? AND cp.entity_id = ? AND s.gemessen_am < ? "
                + "ORDER BY s.gemessen_am DESC, s.empfangen_am DESC, s.ablesung DESC LIMIT 1",
                (rs, n) -> new SignierterMesswert(rs.getTimestamp("gemessen_am").toInstant(), rs.getString("zeit"),
                        rs.getString("anlass"), rs.getString("wert_text"), rs.getString("einheit"), rs.getString("obis"),
                        rs.getString("zaehlerkennung"), rs.getString("signaturstatus"), rs.getString("pruefgrund"),
                        rs.getString("schluessel_quelle"), rs.getString("schluessel_sha256")),
                siteId, komponenteId, Timestamp.from(bis)).stream().findFirst();
    }

    /** Eine signierte Ablesung; {@code wert} unverändert wie im Datensatz geschrieben. */
    public record SignierterMesswert(Instant gemessenAm, String zeit, String anlass, String wert, String einheit,
            String obis, String zaehlerkennung, String signaturstatus, String pruefgrund, String schluesselQuelle,
            String schluesselSha256) {}

    /** Das Fahrzeugfenster eines Ladepunkts; leer = nie gesetzt. */
    public Optional<FensterStand> fahrzeugfenster(UUID komponenteId) {
        List<Fenster> anwesenheit = jdbc.query("SELECT wochentag, ankunft, abfahrt, abfahrt_soc_pct "
                + "FROM ladepunkt_anwesenheit WHERE komponente_id = ? ORDER BY wochentag, ankunft",
                (rs, n) -> new Fenster(rs.getInt("wochentag"), rs.getTime("ankunft").toLocalTime(),
                        rs.getTime("abfahrt").toLocalTime(), rs.getBigDecimal("abfahrt_soc_pct")), komponenteId);
        return jdbc.query("SELECT mindest_soc_pct, kapazitaet_kwh, geaendert_am, geaendert_von "
                + "FROM ladepunkt_fahrzeugfenster WHERE komponente_id = ?",
                (rs, n) -> new FensterStand(new Fahrzeugfenster(rs.getBigDecimal("mindest_soc_pct"),
                        rs.getBigDecimal("kapazitaet_kwh"), List.copyOf(anwesenheit)),
                        rs.getTimestamp("geaendert_am").toInstant(), rs.getString("geaendert_von")), komponenteId)
                .stream().findFirst();
    }

    /** Ersetzt das Fahrzeugfenster ganz (Aufrufer hält die Transaktion). */
    public void fahrzeugfensterErsetzen(UUID tenantId, UUID siteId, UUID komponenteId, Fahrzeugfenster f, Instant am,
            String von) {
        jdbc.update("INSERT INTO ladepunkt_fahrzeugfenster (komponente_id, tenant_id, site_id, mindest_soc_pct, "
                + "kapazitaet_kwh, geaendert_am, geaendert_von) VALUES (?, ?, ?, ?, ?, ?, ?) "
                + "ON CONFLICT (komponente_id) DO UPDATE SET mindest_soc_pct = EXCLUDED.mindest_soc_pct, "
                + "kapazitaet_kwh = EXCLUDED.kapazitaet_kwh, geaendert_am = EXCLUDED.geaendert_am, "
                + "geaendert_von = EXCLUDED.geaendert_von", komponenteId, tenantId, siteId, f.mindestSocPct(),
                f.kapazitaetKwh(), Timestamp.from(am), von);
        jdbc.update("DELETE FROM ladepunkt_anwesenheit WHERE komponente_id = ?", komponenteId);
        for (Fenster w : f.anwesenheit()) {
            jdbc.update("INSERT INTO ladepunkt_anwesenheit (komponente_id, tenant_id, wochentag, ankunft, abfahrt, "
                    + "abfahrt_soc_pct) VALUES (?, ?, ?, ?, ?, ?)", komponenteId, tenantId, w.wochentag(),
                    Time.valueOf(w.ankunft()), Time.valueOf(w.abfahrt()), w.abfahrtSocPct());
        }
    }

    /**
     * Die Einstellungen des Fahrers (MP-41a, V20261004114700), wie gespeichert; die Reserve steht im Fahrzeugfenster.
     * Abfahrten mit derselben Uhrzeit und demselben Ladestand bilden wieder eine Abfahrt für mehrere Wochentage.
     */
    public record FahrerStand(String rueckspeisen, BigDecimal vollzyklenJeTag, List<Abfahrt> abfahrten,
            Instant naechsteFahrt, BigDecimal naechsteFahrtSocPct, Instant geaendertAm, String geaendertVon) {}

    /** Die Einstellungen des Fahrers; leer = nie gesetzt. */
    public Optional<FahrerStand> fahrerEinstellungen(UUID komponenteId) {
        Map<String, Abfahrt> gruppen = new LinkedHashMap<>();
        jdbc.query("SELECT wochentag, abfahrt, abfahrt_soc_pct FROM ladepunkt_abfahrt WHERE komponente_id = ? "
                + "ORDER BY wochentag", rs -> {
                    LocalTime zeit = rs.getTime("abfahrt").toLocalTime();
                    BigDecimal soc = rs.getBigDecimal("abfahrt_soc_pct");
                    Abfahrt a = gruppen.computeIfAbsent(zeit + "|" + soc.stripTrailingZeros().toPlainString(),
                            k -> new Abfahrt(new ArrayList<>(), zeit, soc));
                    a.wochentage().add(rs.getInt("wochentag"));
                }, komponenteId);
        List<Abfahrt> abfahrten = gruppen.values().stream()
                .map(a -> new Abfahrt(List.copyOf(a.wochentage()), a.abfahrt(), a.abfahrtSocPct())).toList();
        return jdbc.query("SELECT rueckspeisen, vollzyklen_je_tag, naechste_fahrt_abfahrt, naechste_fahrt_soc_pct, "
                + "geaendert_am, geaendert_von FROM ladepunkt_fahrer_einstellung WHERE komponente_id = ?",
                (rs, n) -> {
                    Timestamp naechste = rs.getTimestamp("naechste_fahrt_abfahrt");
                    return new FahrerStand(rs.getString("rueckspeisen"), rs.getBigDecimal("vollzyklen_je_tag"),
                            abfahrten, naechste == null ? null : naechste.toInstant(),
                            rs.getBigDecimal("naechste_fahrt_soc_pct"), rs.getTimestamp("geaendert_am").toInstant(),
                            rs.getString("geaendert_von"));
                }, komponenteId).stream().findFirst();
    }

    /**
     * Ersetzt die Einstellungen des Fahrers ganz und setzt die Reserve als Mindest-Ladestand des Fahrzeugfensters
     * (Kapazität und Anwesenheit bleiben); der Aufrufer hält die Transaktion.
     */
    public void fahrerEinstellungenErsetzen(UUID tenantId, UUID siteId, UUID komponenteId,
            LadepunktRegeln.FahrerEinstellungen f, Instant naechsteFahrt, Instant am, String von) {
        jdbc.update("INSERT INTO ladepunkt_fahrer_einstellung (komponente_id, tenant_id, site_id, rueckspeisen, "
                + "vollzyklen_je_tag, naechste_fahrt_abfahrt, naechste_fahrt_soc_pct, geaendert_am, geaendert_von) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (komponente_id) DO UPDATE SET "
                + "rueckspeisen = EXCLUDED.rueckspeisen, vollzyklen_je_tag = EXCLUDED.vollzyklen_je_tag, "
                + "naechste_fahrt_abfahrt = EXCLUDED.naechste_fahrt_abfahrt, "
                + "naechste_fahrt_soc_pct = EXCLUDED.naechste_fahrt_soc_pct, geaendert_am = EXCLUDED.geaendert_am, "
                + "geaendert_von = EXCLUDED.geaendert_von", komponenteId, tenantId, siteId, f.rueckspeisen(),
                f.vollzyklenJeTag(), naechsteFahrt == null ? null : Timestamp.from(naechsteFahrt),
                f.naechsteFahrt() == null ? null : f.naechsteFahrt().abfahrtSocPct(), Timestamp.from(am), von);
        jdbc.update("DELETE FROM ladepunkt_abfahrt WHERE komponente_id = ?", komponenteId);
        for (Abfahrt a : f.abfahrten()) {
            for (Integer tag : a.wochentage()) {
                jdbc.update("INSERT INTO ladepunkt_abfahrt (komponente_id, tenant_id, wochentag, abfahrt, "
                        + "abfahrt_soc_pct) VALUES (?, ?, ?, ?, ?)", komponenteId, tenantId, tag,
                        Time.valueOf(a.abfahrt()), a.abfahrtSocPct());
            }
        }
        jdbc.update("INSERT INTO ladepunkt_fahrzeugfenster (komponente_id, tenant_id, site_id, mindest_soc_pct, "
                + "geaendert_am, geaendert_von) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (komponente_id) DO UPDATE SET "
                + "mindest_soc_pct = EXCLUDED.mindest_soc_pct, geaendert_am = EXCLUDED.geaendert_am, "
                + "geaendert_von = EXCLUDED.geaendert_von", komponenteId, tenantId, siteId, f.reservePct(),
                Timestamp.from(am), von);
    }

    private static Komponente komponente(ResultSet rs, int n) throws SQLException {
        return new Komponente(rs.getObject("id", UUID.class), rs.getString("label"), rs.getString("entity_type"),
                rs.getString("charge_point_id"));
    }

    private static Fassung fassung(ResultSet rs, int n) throws SQLException {
        Timestamp auf = rs.getTimestamp("aufgehoben_am");
        return new Fassung(rs.getObject("id", UUID.class), rs.getObject("komponente_id", UUID.class),
                new Faehigkeit(rs.getString("nutzbarkeit"), rs.getBoolean("v2h"), rs.getBoolean("v2g"),
                        rs.getBoolean("rueckspeisung_bei_einspeisung_unterbunden"),
                        rs.getBigDecimal("rueckspeiseleistung_kw")),
                rs.getDate("gueltig_ab").toLocalDate(), auf == null ? null : auf.toInstant(),
                rs.getTimestamp("created_at").toInstant(), rs.getString("created_by"));
    }
}
