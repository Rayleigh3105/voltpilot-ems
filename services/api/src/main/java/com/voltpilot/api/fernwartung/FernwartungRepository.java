package com.voltpilot.api.fernwartung;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Tabellen der Fernwartung (Migration V20261007163700) an der dedizierten
 * BYPASSRLS-Rolle {@code voltpilot_admin} - dasselbe Muster wie
 * {@code EdgeReleaseRepository}. Erreichbar nur aus platform-admin-Routen und
 * der Leseroute des Tunnel-Dienstes.
 *
 * <p><b>Transaktionen:</b> eine Änderung und ihr Protokolleintrag gehören
 * zusammen. {@code @Transactional} hinge am Mandanten-Datenpfad (dem
 * {@code @Primary}-Transaktionsmanager, siehe {@code RolloutService}); deshalb
 * führt dieses Repository seine Transaktion selbst, über einen eigenen
 * Transaktionsmanager auf GENAU der Admin-DataSource, an der auch das
 * {@code adminJdbcTemplate} hängt. Jede schreibende Transaktion nimmt zuerst
 * eine Advisory-Sperre: Adressvergabe und Fenster-Überschneidungsprüfung
 * laufen so nacheinander, nie verschränkt.
 */
@Repository
public class FernwartungRepository {

    /** Fester Schlüssel der Advisory-Sperre aller Fernwartungs-Schreibvorgänge. */
    private static final long SPERRE = 0x76705f6677L; // "vp_fw"

    private static final String ZUGANG_SPALTEN =
            "z.id, z.art, z.edge_ref, z.name, z.public_key, host(z.tunnel_adresse) AS adresse, z.status, "
                    + "z.notiz, z.angelegt_am, z.angelegt_von, z.geaendert_am, z.geaendert_von ";

    /** Wo eine Box gekoppelt ist - für Admins, damit „edge-…" einen Kunden bekommt. */
    private static final String ZUGANG_SELECT = "SELECT " + ZUGANG_SPALTEN
            + ", d.site_id, s.name AS site_name, d.tenant_id, t.name AS tenant_name "
            + "FROM fernwartung_zugang z "
            + "LEFT JOIN device d ON z.art = 'box' AND d.external_ref = z.edge_ref "
            + "LEFT JOIN site s ON s.id = d.site_id "
            + "LEFT JOIN tenant t ON t.id = d.tenant_id ";

    private static final String FENSTER_SELECT = "SELECT f.id, f.box_id, b.edge_ref, "
            + "host(b.tunnel_adresse) AS box_adresse, f.techniker_id, t.name AS techniker_name, "
            + "host(t.tunnel_adresse) AS techniker_adresse, f.grund, f.beginn, f.ende, f.geoeffnet_am, "
            + "f.geoeffnet_von, f.geoeffnet_von_name, f.geschlossen_am, f.geschlossen_von, "
            + "f.geschlossen_von_name, b.status AS box_status, t.status AS techniker_status "
            + "FROM fernwartung_fenster f "
            + "JOIN fernwartung_zugang b ON b.id = f.box_id "
            + "JOIN fernwartung_zugang t ON t.id = f.techniker_id ";

    /** Ein WireGuard-Peer des Wartungsservers. */
    public record Zugang(UUID id, String art, String edgeRef, String name, String publicKey,
            String adresse, String status, String notiz, Instant angelegtAm, String angelegtVon,
            Instant geaendertAm, String geaendertVon, UUID siteId, String siteName, UUID tenantId,
            String tenantName) {

        public boolean aktiv() {
            return "aktiv".equals(status);
        }
    }

    /** Ein Fernwartungs-Zeitfenster, mit den Adressen beider Seiten. */
    public record Fenster(UUID id, UUID boxId, String edgeRef, String boxAdresse, UUID technikerId,
            String technikerName, String technikerAdresse, String grund, Instant beginn, Instant ende,
            Instant geoeffnetAm, String geoeffnetVon, String geoeffnetVonName, Instant geschlossenAm,
            String geschlossenVon, String geschlossenVonName, String boxStatus, String technikerStatus) {

        /** Das tatsächliche Ende: vorzeitig geschlossen oder planmäßig. */
        public Instant wirksamesEnde() {
            return geschlossenAm != null && geschlossenAm.isBefore(ende) ? geschlossenAm : ende;
        }

        /** Offen = begonnen, nicht beendet, nicht geschlossen - nach der Uhr {@code jetzt}. */
        public boolean offen(Instant jetzt) {
            return geschlossenAm == null && !beginn.isAfter(jetzt) && ende.isAfter(jetzt);
        }

        /** Geplant = noch nicht begonnen und nicht abgesagt. */
        public boolean geplant(Instant jetzt) {
            return geschlossenAm == null && beginn.isAfter(jetzt);
        }
    }

    /** Ein Eintrag im Protokoll; {@code details} ist das JSON-Objekt als Text. */
    public record ProtokollEintrag(UUID id, Instant zeit, String akteur, String akteurName, String aktion,
            UUID boxId, String edgeRef, UUID technikerId, String technikerName, UUID fensterId,
            String details) {
    }

    /** Wann ein Tunnel-Dienst den Soll-Stand zuletzt abgeholt hat. */
    public record DienstAbruf(String dienst, Instant zuletztAm, int peers, int fenster) {
    }

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;

    public FernwartungRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate,
            @Qualifier("adminDataSource") DataSource adminDataSource) {
        this.jdbc = adminJdbcTemplate;
        this.tx = new TransactionTemplate(new DataSourceTransactionManager(adminDataSource));
    }

    /**
     * Führt {@code arbeit} in EINER Transaktion auf der Admin-Verbindung aus,
     * nach der Advisory-Sperre. Eine Ausnahme rollt alles zurück, auch den
     * Protokolleintrag.
     */
    public <T> T schreibend(Supplier<T> arbeit) {
        return tx.execute(status -> {
            jdbc.query("SELECT pg_advisory_xact_lock(?)", rs -> null, SPERRE);
            return arbeit.get();
        });
    }

    // ── Zugänge ───────────────────────────────────────────────────────────

    public List<Zugang> zugaenge(String art) {
        return jdbc.query(ZUGANG_SELECT + "WHERE z.art = ? ORDER BY z.tunnel_adresse",
                FernwartungRepository::zugang, art);
    }

    public List<Zugang> aktiveZugaenge() {
        return jdbc.query(ZUGANG_SELECT + "WHERE z.status = 'aktiv' ORDER BY z.art, z.tunnel_adresse",
                FernwartungRepository::zugang);
    }

    public Optional<Zugang> box(String edgeRef) {
        return jdbc.query(ZUGANG_SELECT + "WHERE z.art = 'box' AND z.edge_ref = ?",
                FernwartungRepository::zugang, edgeRef).stream().findFirst();
    }

    public Optional<Zugang> zugang(UUID id) {
        return jdbc.query(ZUGANG_SELECT + "WHERE z.id = ?", FernwartungRepository::zugang, id)
                .stream().findFirst();
    }

    public Optional<Zugang> zugangMitSchluessel(String publicKey) {
        return jdbc.query(ZUGANG_SELECT + "WHERE z.public_key = ?", FernwartungRepository::zugang, publicKey)
                .stream().findFirst();
    }

    /**
     * Kennt die Plattform diese Referenz schon - als gekoppeltes Gerät oder im
     * Werkstatt-Register? Für Referenzen, die kein Prüfzeichen tragen.
     */
    public boolean referenzBekannt(String externalRef) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM device WHERE external_ref = ?) "
                        + "OR EXISTS (SELECT 1 FROM provisioned_device WHERE external_ref = ?)",
                Boolean.class, externalRef, externalRef));
    }

    /** Alle belegten Adressen in {@code netz}, auch gesperrter Zugänge (keine Wiedervergabe). */
    public Set<Integer> belegteAdressen(Ipv4Netz netz) {
        List<String> adressen = jdbc.query(
                "SELECT host(tunnel_adresse) FROM fernwartung_zugang WHERE tunnel_adresse <<= ?::inet",
                (rs, n) -> rs.getString(1), netz.toString());
        Set<Integer> belegt = new HashSet<>();
        for (String a : adressen) {
            belegt.add(Ipv4Netz.adresse(a));
        }
        return belegt;
    }

    public UUID zugangAnlegen(String art, String edgeRef, String name, String publicKey, String adresse,
            String notiz, String akteur) {
        return jdbc.queryForObject(
                "INSERT INTO fernwartung_zugang (art, edge_ref, name, public_key, tunnel_adresse, notiz, "
                        + "angelegt_von, geaendert_von) VALUES (?, ?, ?, ?, ?::inet, ?, ?, ?) RETURNING id",
                UUID.class, art, edgeRef, name, publicKey, adresse + "/32", notiz, akteur, akteur);
    }

    public void schluesselSetzen(UUID id, String publicKey, String notiz, String akteur) {
        jdbc.update("UPDATE fernwartung_zugang SET public_key = ?, notiz = coalesce(?, notiz), "
                + "geaendert_am = now(), geaendert_von = ? WHERE id = ?", publicKey, notiz, akteur, id);
    }

    public void statusSetzen(UUID id, String status, String akteur) {
        jdbc.update("UPDATE fernwartung_zugang SET status = ?, geaendert_am = now(), geaendert_von = ? "
                + "WHERE id = ?", status, akteur, id);
    }

    // ── Fenster ───────────────────────────────────────────────────────────

    public Optional<Fenster> fenster(UUID id) {
        return jdbc.query(FENSTER_SELECT + "WHERE f.id = ?", FernwartungRepository::fenster, id)
                .stream().findFirst();
    }

    /** Fenster, neueste zuerst; {@code boxId}/{@code technikerId} leer = alle. */
    public List<Fenster> fensterListe(UUID boxId, UUID technikerId, int limit) {
        return jdbc.query(FENSTER_SELECT
                        + "WHERE (?::uuid IS NULL OR f.box_id = ?::uuid) "
                        + "AND (?::uuid IS NULL OR f.techniker_id = ?::uuid) "
                        + "ORDER BY f.beginn DESC, f.geoeffnet_am DESC LIMIT ?",
                FernwartungRepository::fenster, boxId, boxId, technikerId, technikerId, limit);
    }

    /** Alle Fenster, die zu {@code jetzt} offen sind oder noch beginnen werden. */
    public List<Fenster> offeneUndGeplanteFenster(Instant jetzt) {
        return jdbc.query(FENSTER_SELECT + "WHERE f.geschlossen_am IS NULL AND f.ende > ? "
                + "ORDER BY f.beginn", FernwartungRepository::fenster, Timestamp.from(jetzt));
    }

    /**
     * Gibt es für dieses Paar ein nicht geschlossenes Fenster, das sich mit
     * {@code [beginn, ende)} überschneidet?
     */
    public Optional<Fenster> ueberschneidung(UUID boxId, UUID technikerId, Instant beginn, Instant ende) {
        return jdbc.query(FENSTER_SELECT + "WHERE f.box_id = ? AND f.techniker_id = ? "
                        + "AND f.geschlossen_am IS NULL AND f.beginn < ? AND f.ende > ? LIMIT 1",
                FernwartungRepository::fenster, boxId, technikerId, Timestamp.from(ende), Timestamp.from(beginn))
                .stream().findFirst();
    }

    public UUID fensterAnlegen(UUID boxId, UUID technikerId, String grund, Instant beginn, Instant ende,
            String akteur, String akteurName) {
        return jdbc.queryForObject(
                "INSERT INTO fernwartung_fenster (box_id, techniker_id, grund, beginn, ende, geoeffnet_von, "
                        + "geoeffnet_von_name) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
                UUID.class, boxId, technikerId, grund, Timestamp.from(beginn), Timestamp.from(ende), akteur,
                akteurName);
    }

    public void fensterSchliessen(UUID id, Instant am, String akteur, String akteurName) {
        jdbc.update("UPDATE fernwartung_fenster SET geschlossen_am = ?, geschlossen_von = ?, "
                + "geschlossen_von_name = ? WHERE id = ? AND geschlossen_am IS NULL",
                Timestamp.from(am), akteur, akteurName, id);
    }

    // ── Protokoll ─────────────────────────────────────────────────────────

    public void protokollieren(String akteur, String akteurName, String aktion, UUID boxId, UUID technikerId,
            UUID fensterId, String detailsJson) {
        jdbc.update("INSERT INTO fernwartung_protokoll (akteur, akteur_name, aktion, box_id, techniker_id, "
                        + "fenster_id, details) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb)",
                akteur, akteurName, aktion, boxId, technikerId, fensterId, detailsJson);
    }

    public List<ProtokollEintrag> protokoll(UUID boxId, UUID technikerId, int limit) {
        return jdbc.query("SELECT p.id, p.zeit, p.akteur, p.akteur_name, p.aktion, p.box_id, b.edge_ref, "
                        + "p.techniker_id, t.name AS techniker_name, p.fenster_id, p.details::text AS details "
                        + "FROM fernwartung_protokoll p "
                        + "LEFT JOIN fernwartung_zugang b ON b.id = p.box_id "
                        + "LEFT JOIN fernwartung_zugang t ON t.id = p.techniker_id "
                        + "WHERE (?::uuid IS NULL OR p.box_id = ?::uuid) "
                        + "AND (?::uuid IS NULL OR p.techniker_id = ?::uuid) "
                        + "ORDER BY p.zeit DESC, p.id LIMIT ?",
                (rs, n) -> new ProtokollEintrag(
                        rs.getObject("id", UUID.class),
                        instant(rs, "zeit"),
                        rs.getString("akteur"),
                        rs.getString("akteur_name"),
                        rs.getString("aktion"),
                        rs.getObject("box_id", UUID.class),
                        rs.getString("edge_ref"),
                        rs.getObject("techniker_id", UUID.class),
                        rs.getString("techniker_name"),
                        rs.getObject("fenster_id", UUID.class),
                        rs.getString("details")),
                boxId, boxId, technikerId, technikerId, limit);
    }

    // ── Abruf durch den Tunnel-Dienst ─────────────────────────────────────

    public void abrufMerken(String dienst, Instant am, int peers, int fenster) {
        jdbc.update("INSERT INTO fernwartung_dienst_abruf (dienst, zuletzt_am, peers, fenster) "
                + "VALUES (?, ?, ?, ?) ON CONFLICT (dienst) DO UPDATE SET zuletzt_am = excluded.zuletzt_am, "
                + "peers = excluded.peers, fenster = excluded.fenster", dienst, Timestamp.from(am), peers, fenster);
    }

    public List<DienstAbruf> abrufe() {
        return jdbc.query("SELECT dienst, zuletzt_am, peers, fenster FROM fernwartung_dienst_abruf "
                        + "ORDER BY zuletzt_am DESC",
                (rs, n) -> new DienstAbruf(rs.getString("dienst"), instant(rs, "zuletzt_am"),
                        rs.getInt("peers"), rs.getInt("fenster")));
    }

    // ── Abbildung ─────────────────────────────────────────────────────────

    private static Zugang zugang(ResultSet rs, int n) throws SQLException {
        return new Zugang(
                rs.getObject("id", UUID.class),
                rs.getString("art"),
                rs.getString("edge_ref"),
                rs.getString("name"),
                rs.getString("public_key"),
                rs.getString("adresse"),
                rs.getString("status"),
                rs.getString("notiz"),
                instant(rs, "angelegt_am"),
                rs.getString("angelegt_von"),
                instant(rs, "geaendert_am"),
                rs.getString("geaendert_von"),
                rs.getObject("site_id", UUID.class),
                rs.getString("site_name"),
                rs.getObject("tenant_id", UUID.class),
                rs.getString("tenant_name"));
    }

    private static Fenster fenster(ResultSet rs, int n) throws SQLException {
        return new Fenster(
                rs.getObject("id", UUID.class),
                rs.getObject("box_id", UUID.class),
                rs.getString("edge_ref"),
                rs.getString("box_adresse"),
                rs.getObject("techniker_id", UUID.class),
                rs.getString("techniker_name"),
                rs.getString("techniker_adresse"),
                rs.getString("grund"),
                instant(rs, "beginn"),
                instant(rs, "ende"),
                instant(rs, "geoeffnet_am"),
                rs.getString("geoeffnet_von"),
                rs.getString("geoeffnet_von_name"),
                instant(rs, "geschlossen_am"),
                rs.getString("geschlossen_von"),
                rs.getString("geschlossen_von_name"),
                rs.getString("box_status"),
                rs.getString("techniker_status"));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
