package com.voltpilot.api.erzeuger;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * PFC200 Stufe 4: die Tabellen {@code koppelbild_stand} (Herzschlag-Block {@code koppel} je Box und Steuerung) und
 * {@code koppelbild_freigabe} (Beleg des Schalt-Tests und Freigabe je Anlagensteuerung und Stellplatz). Alles unter
 * RLS als App-Rolle im Mandanten des Aufrufers.
 */
@Repository
public class KoppelbildRepository {

    /** Ein gespeicherter Stand: welche Box ihn meldete, der bereinigte Eintrag als JSON-Text, wann er ankam. */
    public record StandZeile(UUID deviceId, UUID entityId, String json, Instant empfangenAt) {}

    /** Ein Stand, wie der Herzschlag ihn ersetzt: Komponente, ihre Anlage, bereinigter Eintrag. */
    public record NeuerStand(UUID entityId, UUID siteId, String json) {}

    /** Die Komponente einer eingebauten Anlagensteuerung: ihre Anlage und ihr Gerät. */
    public record Komponente(UUID entityId, UUID siteId, UUID geraetId) {}

    /**
     * Beleg und Freigabe eines Stellplatzes. Die Form ({@link #form()}) ist die des letzten Tests; der Beleg
     * ({@code test*}) steht nur für einen bestandenen Test genau dieser Form, die Freigabe nur mit Beleg und bestätigter
     * Wirkung.
     */
    public record Freigabe(UUID id, UUID geraetId, UUID siteId, int platz, Koppelbild.Angebot form, String kommando,
            Instant versuchAt, String versuchUrteil, Boolean versuchOk, Long testWert, String testUrteil,
            Long testWirksam, Integer testFolge, Instant testAt, String testVon, Instant freigegebenAt,
            String freigegebenVon, boolean physischBestaetigt, String evidenz, Instant widerrufenAt,
            String widerrufenVon, String widerrufenGrund) {

        /** Gilt die Freigabe gerade (erteilt, nicht widerrufen)? */
        public boolean aktiv() {
            return freigegebenAt != null && widerrufenAt == null;
        }

        /**
         * Trägt die Zeile einen bestandenen Test für genau diese Form, der jünger ist als ein Widerruf? Nach einer
         * Rücknahme oder einem Wegfall muss der Test wiederholt werden.
         */
        public boolean beleg(Koppelbild.Angebot angebot) {
            return testAt != null && angebot != null && angebot.equals(form)
                    && (widerrufenAt == null || testAt.isAfter(widerrufenAt));
        }

        /** Ein Versuch nach dem letzten Widerruf, der nicht bestanden hat. */
        public boolean versuchNichtAngenommen() {
            return versuchAt != null && Boolean.FALSE.equals(versuchOk)
                    && (widerrufenAt == null || versuchAt.isAfter(widerrufenAt))
                    && (testAt == null || versuchAt.isAfter(testAt));
        }
    }

    private static final String FREIGABE = "SELECT id, geraet_id, site_id, platz, art, ziel, nr, band_min, band_max, "
            + "kommando, versuch_at, versuch_urteil, versuch_ok, test_wert, test_urteil, test_wirksam, test_folge, "
            + "test_at, test_von, freigegeben_at, freigegeben_von, physisch_bestaetigt, evidenz, widerrufen_at, "
            + "widerrufen_von, widerrufen_grund FROM koppelbild_freigabe ";

    private final JdbcTemplate jdbc;

    public KoppelbildRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ------------------------------------------------------------------ Stand

    /**
     * Die eingebauten Anlagensteuerungen zu diesen Komponenten (unter RLS: eine fremde fehlt). Der Block nennt die
     * Komponente; Anlage und Gerät kommen aus der Cloud, nie aus der Nutzlast.
     */
    public Map<UUID, Komponente> komponenten(Collection<UUID> entityIds) {
        if (entityIds.isEmpty()) return Map.of();
        Map<UUID, Komponente> out = new LinkedHashMap<>();
        jdbc.query(con -> {
            var ps = con.prepareStatement("SELECT m.id, m.site_id, v.geraet_id FROM measurement_point m "
                    + "JOIN geraet_komponente v ON v.entity_id = m.id AND v.gueltig_ab <= now() "
                    + "AND (v.gueltig_bis IS NULL OR v.gueltig_bis > now()) "
                    + "JOIN geraet g ON g.id = v.geraet_id AND g.geraeteart = 'controller' AND g.ausgebaut_am IS NULL "
                    + "WHERE m.entity_type = '" + AnlagensteuerungRepository.ENTITY_TYPE + "' AND m.id = ANY (?)");
            ps.setArray(1, con.createArrayOf("uuid", entityIds.toArray()));
            return ps;
        }, rs -> {
            UUID id = rs.getObject(1, UUID.class);
            out.put(id, new Komponente(id, rs.getObject(2, UUID.class), rs.getObject(3, UUID.class)));
        });
        return out;
    }

    /**
     * Ersetzt den Stand einer Box: Steuerungen, die der Block nicht mehr nennt, fallen weg, die übrigen werden
     * überschrieben. Eine leere Liste leert den Stand der Box.
     */
    public void ersetzeStand(UUID deviceId, UUID tenantId, List<NeuerStand> staende, Instant empfangen) {
        if (staende.isEmpty()) {
            jdbc.update("DELETE FROM koppelbild_stand WHERE device_id = ?", deviceId);
            return;
        }
        UUID[] ids = staende.stream().map(NeuerStand::entityId).toArray(UUID[]::new);
        jdbc.update(con -> {
            var ps = con.prepareStatement("DELETE FROM koppelbild_stand WHERE device_id = ? AND NOT (entity_id = ANY (?))");
            ps.setObject(1, deviceId);
            ps.setArray(2, con.createArrayOf("uuid", ids));
            return ps;
        });
        for (NeuerStand s : staende) {
            jdbc.update("INSERT INTO koppelbild_stand (device_id, entity_id, tenant_id, site_id, stand, empfangen_at) "
                    + "VALUES (?, ?, ?, ?, ?::jsonb, ?) ON CONFLICT (device_id, entity_id) DO UPDATE SET "
                    + "site_id = EXCLUDED.site_id, stand = EXCLUDED.stand, empfangen_at = EXCLUDED.empfangen_at",
                    deviceId, s.entityId(), tenantId, s.siteId(), s.json(), Timestamp.from(empfangen));
        }
    }

    /** Der jüngste Stand einer Steuerung über alle Boxen (nach einem Box-Wechsel meldet die neue). */
    public Optional<StandZeile> juengsterStand(UUID entityId) {
        return jdbc.query("SELECT device_id, entity_id, stand::text, empfangen_at FROM koppelbild_stand "
                + "WHERE entity_id = ? ORDER BY empfangen_at DESC LIMIT 1", (rs, n) -> new StandZeile(
                        rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3),
                        rs.getTimestamp(4).toInstant()), entityId).stream().findFirst();
    }

    // ------------------------------------------------------------------ Freigabe

    public List<Freigabe> freigaben(UUID geraetId) {
        return jdbc.query(FREIGABE + "WHERE geraet_id = ? ORDER BY platz", KoppelbildRepository::freigabe, geraetId);
    }

    public Optional<Freigabe> freigabe(UUID geraetId, int platz) {
        return jdbc.query(FREIGABE + "WHERE geraet_id = ? AND platz = ?", KoppelbildRepository::freigabe, geraetId,
                platz).stream().findFirst();
    }

    /** Sperrt die Zeilen einer Steuerung für die laufende Transaktion (zwei Freigaben zugleich). */
    public List<Freigabe> freigabenSperren(UUID geraetId) {
        return jdbc.query(FREIGABE + "WHERE geraet_id = ? ORDER BY platz FOR UPDATE", KoppelbildRepository::freigabe,
                geraetId);
    }

    /** Die geltenden Freigaben der Anlage je Komponente ihrer Steuerung, nach Stellplatz. */
    public Map<UUID, List<Freigabe>> aktiveJeKomponente(UUID siteId) {
        Map<UUID, List<Freigabe>> out = new LinkedHashMap<>();
        jdbc.query("SELECT v.entity_id, f.id, f.geraet_id, f.site_id, f.platz, f.art, f.ziel, f.nr, f.band_min, "
                + "f.band_max, f.kommando, f.versuch_at, f.versuch_urteil, f.versuch_ok, f.test_wert, f.test_urteil, "
                + "f.test_wirksam, f.test_folge, f.test_at, f.test_von, f.freigegeben_at, f.freigegeben_von, "
                + "f.physisch_bestaetigt, f.evidenz, f.widerrufen_at, f.widerrufen_von, f.widerrufen_grund "
                + "FROM koppelbild_freigabe f "
                + "JOIN geraet_komponente v ON v.geraet_id = f.geraet_id AND v.gueltig_ab <= now() "
                + "AND (v.gueltig_bis IS NULL OR v.gueltig_bis > now()) "
                + "JOIN measurement_point m ON m.id = v.entity_id AND m.entity_type = '"
                + AnlagensteuerungRepository.ENTITY_TYPE + "' "
                + "WHERE f.site_id = ? AND f.freigegeben_at IS NOT NULL AND f.widerrufen_at IS NULL "
                + "ORDER BY v.entity_id, f.platz", rs -> {
                    out.computeIfAbsent(rs.getObject("entity_id", UUID.class), k -> new ArrayList<>())
                            .add(freigabe(rs, 0));
                }, siteId);
        return out;
    }

    /** Wie viele Stellplätze der Steuerung gerade freigegeben sind. */
    public int aktiveAnzahl(UUID geraetId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM koppelbild_freigabe WHERE geraet_id = ? "
                + "AND freigegeben_at IS NOT NULL AND widerrufen_at IS NULL", Integer.class, geraetId);
        return n == null ? 0 : n;
    }

    /** Schreibt die ganze Zeile eines Stellplatzes (neu oder ersetzt, Schlüssel Steuerung + Stellplatz). */
    public void speichern(UUID tenantId, Freigabe f) {
        jdbc.update("INSERT INTO koppelbild_freigabe (tenant_id, site_id, geraet_id, platz, art, ziel, nr, band_min, "
                + "band_max, kommando, versuch_at, versuch_urteil, versuch_ok, test_wert, test_urteil, test_wirksam, "
                + "test_folge, test_at, test_von, freigegeben_at, freigegeben_von, physisch_bestaetigt, evidenz, "
                + "widerrufen_at, widerrufen_von, widerrufen_grund, aktualisiert_at) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now()) "
                + "ON CONFLICT (geraet_id, platz) DO UPDATE SET site_id = EXCLUDED.site_id, art = EXCLUDED.art, "
                + "ziel = EXCLUDED.ziel, nr = EXCLUDED.nr, band_min = EXCLUDED.band_min, band_max = EXCLUDED.band_max, "
                + "kommando = EXCLUDED.kommando, versuch_at = EXCLUDED.versuch_at, "
                + "versuch_urteil = EXCLUDED.versuch_urteil, versuch_ok = EXCLUDED.versuch_ok, "
                + "test_wert = EXCLUDED.test_wert, test_urteil = EXCLUDED.test_urteil, "
                + "test_wirksam = EXCLUDED.test_wirksam, test_folge = EXCLUDED.test_folge, "
                + "test_at = EXCLUDED.test_at, test_von = EXCLUDED.test_von, "
                + "freigegeben_at = EXCLUDED.freigegeben_at, freigegeben_von = EXCLUDED.freigegeben_von, "
                + "physisch_bestaetigt = EXCLUDED.physisch_bestaetigt, evidenz = EXCLUDED.evidenz, "
                + "widerrufen_at = EXCLUDED.widerrufen_at, widerrufen_von = EXCLUDED.widerrufen_von, "
                + "widerrufen_grund = EXCLUDED.widerrufen_grund, aktualisiert_at = now()",
                tenantId, f.siteId(), f.geraetId(), f.platz(), f.form().art(), f.form().ziel(), f.form().nr(),
                f.form().min(), f.form().max(), f.kommando(), ts(f.versuchAt()), f.versuchUrteil(), f.versuchOk(),
                f.testWert(), f.testUrteil(), f.testWirksam(), f.testFolge(), ts(f.testAt()), f.testVon(),
                ts(f.freigegebenAt()), f.freigegebenVon(), f.physischBestaetigt(), f.evidenz(), ts(f.widerrufenAt()),
                f.widerrufenVon(), f.widerrufenGrund());
    }

    /** Widerruft eine geltende Freigabe; {@code true}, wenn es eine gab. */
    public boolean widerrufen(UUID id, Instant am, String von, String grund) {
        return jdbc.update("UPDATE koppelbild_freigabe SET widerrufen_at = ?, widerrufen_von = ?, widerrufen_grund = ?, "
                + "aktualisiert_at = now() WHERE id = ? AND freigegeben_at IS NOT NULL AND widerrufen_at IS NULL",
                Timestamp.from(am), von, grund, id) == 1;
    }

    private static Timestamp ts(Instant t) {
        return t == null ? null : Timestamp.from(t);
    }

    private static Instant zeit(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    private static Freigabe freigabe(ResultSet rs, int n) throws SQLException {
        return new Freigabe(rs.getObject("id", UUID.class), rs.getObject("geraet_id", UUID.class),
                rs.getObject("site_id", UUID.class), rs.getInt("platz"),
                new Koppelbild.Angebot(rs.getString("art"), rs.getString("ziel"), rs.getInt("nr"),
                        rs.getLong("band_min"), rs.getLong("band_max")),
                rs.getString("kommando"), zeit(rs, "versuch_at"), rs.getString("versuch_urteil"),
                (Boolean) rs.getObject("versuch_ok"), (Long) rs.getObject("test_wert"), rs.getString("test_urteil"),
                (Long) rs.getObject("test_wirksam"), (Integer) rs.getObject("test_folge"), zeit(rs, "test_at"),
                rs.getString("test_von"), zeit(rs, "freigegeben_at"), rs.getString("freigegeben_von"),
                rs.getBoolean("physisch_bestaetigt"), rs.getString("evidenz"), zeit(rs, "widerrufen_at"),
                rs.getString("widerrufen_von"), rs.getString("widerrufen_grund"));
    }
}
