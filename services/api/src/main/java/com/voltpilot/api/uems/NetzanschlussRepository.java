package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Netzanschluss, Kennzeichen-Belegung und Anlage ↔ Netzanschluss (UEMS AP-10 IP-6,
 * {@code V20260913235000}). Jede Abfrage läuft unter RLS: ein fremder Anschluss, eine fremde Anlage
 * ist nicht da. Kein DELETE — ein Anschluss wird beendet, eine Bindung beendet oder aufgehoben.
 */
@Repository
public class NetzanschlussRepository {

    /** Ein Netzanschluss, wie er heute in der Zeile steht. */
    public record Anschluss(UUID id, UUID standortId, String kennzeichen, String name, String malo,
            String netzbetreiber, BigDecimal anschlussKva, BigDecimal vereinbartKw, String messung,
            LocalDate gueltigAb, LocalDate gueltigBis, Instant angelegtAm) {}

    /** Die Felder, die Anlegen und Bearbeiten schreiben. */
    public record Felder(String kennzeichen, String name, String malo, String netzbetreiber,
            BigDecimal anschlussKva, BigDecimal vereinbartKw, String messung, LocalDate gueltigAb,
            LocalDate gueltigBis) {}

    /**
     * Ein wirksames (nicht aufgehobenes) Intervall Anlage ↔ Netzanschluss. {@code anlageName} ist
     * {@code null}, wenn die Anlage gelöscht ist — die Bindung überlebt sie (W5).
     */
    public record Bindung(UUID id, UUID siteId, String anlageName, UUID netzanschlussId,
            String netzanschlussKennzeichen, LocalDate gueltigAb, LocalDate gueltigBis) {

        public boolean laeuftAm(LocalDate tag) {
            return !tag.isBefore(gueltigAb) && (gueltigBis == null || !tag.isAfter(gueltigBis));
        }
    }

    /** Ein belegtes Kennzeichen und der Anschluss, der es trägt oder trug. */
    public record Belegung(String kennzeichen, UUID netzanschlussId) {}

    private static final String SPALTEN = "id, standort_id, kennzeichen, name, malo, netzbetreiber, anschluss_kva, "
            + "vereinbart_kw, messung, gueltig_ab, gueltig_bis, created_at";

    private static final RowMapper<Anschluss> ANSCHLUSS = (rs, n) -> new Anschluss(
            rs.getObject("id", UUID.class),
            rs.getObject("standort_id", UUID.class),
            rs.getString("kennzeichen"),
            rs.getString("name"),
            rs.getString("malo"),
            rs.getString("netzbetreiber"),
            ohneNullen(rs.getBigDecimal("anschluss_kva")),
            ohneNullen(rs.getBigDecimal("vereinbart_kw")),
            rs.getString("messung"),
            rs.getObject("gueltig_ab", LocalDate.class),
            rs.getObject("gueltig_bis", LocalDate.class),
            instant(rs, "created_at"));

    private static final String BINDUNG_SPALTEN = "SELECT b.id, b.site_id, s.name AS anlage_name, b.netzanschluss_id, "
            + "n.kennzeichen, b.gueltig_ab, b.gueltig_bis FROM anlage_netzanschluss b "
            + "JOIN netzanschluss n ON n.id = b.netzanschluss_id AND n.tenant_id = b.tenant_id "
            + "LEFT JOIN site s ON s.id = b.site_id AND s.tenant_id = b.tenant_id "
            + "WHERE b.aufgehoben_am IS NULL ";

    private static final RowMapper<Bindung> BINDUNG = (rs, n) -> new Bindung(
            rs.getObject("id", UUID.class),
            rs.getObject("site_id", UUID.class),
            rs.getString("anlage_name"),
            rs.getObject("netzanschluss_id", UUID.class),
            rs.getString("kennzeichen"),
            rs.getObject("gueltig_ab", LocalDate.class),
            rs.getObject("gueltig_bis", LocalDate.class));

    private final JdbcTemplate jdbc;

    public NetzanschlussRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ------------------------------------------------------------------ Anschluss

    /** Die Anschlüsse eines Standorts, beendete eingeschlossen, nach Kennzeichen. */
    public List<Anschluss> amStandort(UUID standort) {
        return jdbc.query("SELECT " + SPALTEN + " FROM netzanschluss WHERE standort_id = ? ORDER BY kennzeichen, id",
                ANSCHLUSS, standort);
    }

    public Optional<Anschluss> finde(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + " FROM netzanschluss WHERE id = ?", ANSCHLUSS, id).stream().findFirst();
    }

    /** Jedes Kennzeichen, das ein Anschluss des Kundenbereichs trägt oder trug — die Eingabe {@code belegt}. */
    public List<Belegung> belegt() {
        return jdbc.query("SELECT kennzeichen, netzanschluss_id FROM netzanschluss_kennzeichen ORDER BY kennzeichen",
                (rs, n) -> new Belegung(rs.getString("kennzeichen"), rs.getObject("netzanschluss_id", UUID.class)));
    }

    /** Der Stand des Kennzeichen-Zählers — ohne ihn zu bewegen (0, solange nichts automatisch vergeben ist). */
    public int zaehler() {
        List<Integer> z = jdbc.queryForList("SELECT zaehler FROM netzanschluss_kennzeichen_seq", Integer.class);
        return z.isEmpty() ? 0 : z.get(0);
    }

    /**
     * Der Zähler UNTER Zeilensperre — zwei gleichzeitige automatische Vergaben bekommen zwei Nummern.
     * Nur in einer Transaktion: ohne sie gälte die Sperre nur für diese eine Anweisung.
     */
    public int zaehlerSperren(UUID tenant) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Die Kennzeichen-Vergabe braucht eine Transaktion");
        }
        jdbc.update("INSERT INTO netzanschluss_kennzeichen_seq (tenant_id) VALUES (?) ON CONFLICT (tenant_id) DO NOTHING",
                tenant);
        return jdbc.queryForObject("SELECT zaehler FROM netzanschluss_kennzeichen_seq WHERE tenant_id = ? FOR UPDATE",
                Integer.class, tenant);
    }

    public void zaehlerSetzen(UUID tenant, int zaehler) {
        jdbc.update("UPDATE netzanschluss_kennzeichen_seq SET zaehler = ?, updated_at = now() WHERE tenant_id = ?",
                zaehler, tenant);
    }

    public UUID anlegen(UUID tenant, UUID standort, Felder f, String wer) {
        return jdbc.queryForObject("INSERT INTO netzanschluss (tenant_id, standort_id, kennzeichen, name, malo, "
                + "netzbetreiber, anschluss_kva, vereinbart_kw, messung, gueltig_ab, gueltig_bis, created_by) "
                + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id", UUID.class, tenant, standort, f.kennzeichen(),
                f.name(), f.malo(), f.netzbetreiber(), f.anschlussKva(), f.vereinbartKw(), f.messung(), f.gueltigAb(),
                f.gueltigBis(), wer);
    }

    public void bearbeiten(UUID id, Felder f) {
        jdbc.update("UPDATE netzanschluss SET kennzeichen = ?, name = ?, malo = ?, netzbetreiber = ?, anschluss_kva = ?, "
                + "vereinbart_kw = ?, messung = ?, gueltig_ab = ?, gueltig_bis = ?, updated_at = now() WHERE id = ?",
                f.kennzeichen(), f.name(), f.malo(), f.netzbetreiber(), f.anschlussKva(), f.vereinbartKw(), f.messung(),
                f.gueltigAb(), f.gueltigBis(), id);
    }

    /**
     * Die Bindungen, die außerhalb der Tage [ab, bis] des Anschlusses lägen — dieselbe Funktion, die
     * der Trigger am Anschluss fragt ({@code uems_zuordnungen_ausserhalb}, V20260913160000).
     */
    public List<Bindung> ausserhalb(UUID tenant, UUID id, LocalDate ab, LocalDate bis) {
        return jdbc.query(BINDUNG_SPALTEN + "AND b.id IN (SELECT a.zeile_id FROM uems_zuordnungen_ausserhalb("
                + "'netzanschluss', ?::uuid, ?::uuid, ?::date, ?::date) a WHERE a.tabelle = 'anlage_netzanschluss') ORDER BY b.gueltig_ab, b.id",
                BINDUNG, tenant, id, ab, bis);
    }

    // -------------------------------------------------------------------- Bindung

    /** Alle wirksamen Bindungen des Kundenbereichs, nach Beginn — die Zeilen des Standort-Lesemodells. */
    public List<Bindung> bindungen() {
        return jdbc.query(BINDUNG_SPALTEN + "ORDER BY b.gueltig_ab, b.id", BINDUNG);
    }

    /** Die wirksamen Bindungen einer Anlage ODER eines Anschlusses — alles, was die Bindungsregel sehen muss. */
    public List<Bindung> bindungenVon(UUID siteId, UUID netzanschluss) {
        return jdbc.query(BINDUNG_SPALTEN + "AND (b.site_id = ? OR b.netzanschluss_id = ?) ORDER BY b.gueltig_ab, b.id",
                BINDUNG, siteId, netzanschluss);
    }

    public List<Bindung> bindungenDerAnlage(UUID siteId) {
        return jdbc.query(BINDUNG_SPALTEN + "AND b.site_id = ? ORDER BY b.gueltig_ab, b.id", BINDUNG, siteId);
    }

    public List<Bindung> bindungenDesAnschlusses(UUID netzanschluss) {
        return jdbc.query(BINDUNG_SPALTEN + "AND b.netzanschluss_id = ? ORDER BY b.gueltig_ab, b.id", BINDUNG,
                netzanschluss);
    }

    public void bindungBeenden(UUID id, LocalDate bis) {
        jdbc.update("UPDATE anlage_netzanschluss SET gueltig_bis = ? WHERE id = ?", bis, id);
    }

    public void bindungAufheben(UUID id, Instant jetzt) {
        jdbc.update("UPDATE anlage_netzanschluss SET aufgehoben_am = ? WHERE id = ?", Timestamp.from(jetzt), id);
    }

    public UUID bindungEintragen(UUID tenant, UUID siteId, UUID netzanschluss, LocalDate ab, LocalDate bis, String wer) {
        return jdbc.queryForObject("INSERT INTO anlage_netzanschluss (tenant_id, site_id, netzanschluss_id, gueltig_ab, "
                + "gueltig_bis, created_by) VALUES (?,?,?,?,?,?) RETURNING id", UUID.class, tenant, siteId, netzanschluss,
                ab, bis, wer);
    }

    /** Der Name der Anlage — leer, wenn es sie im Kundenbereich nicht gibt. */
    public Optional<String> anlagenName(UUID siteId) {
        return jdbc.queryForList("SELECT name FROM site WHERE id = ?", String.class, siteId).stream().findFirst();
    }

    // ------------------------------------------------------------------ Protokoll

    /** GENAU EIN Eintrag je Schreibvorgang; die Eintragszeit setzt die Datenbank. */
    public void protokoll(UUID tenant, UUID netzanschluss, String art, String altJson, String neuJson, Instant giltAb,
            boolean rueckwirkend, String grund, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO netzanschluss_aenderung (tenant_id, netzanschluss_id, art, alt, neu, gilt_ab, "
                + "rueckwirkend, grund, actor_sub, actor_name, actor_rolle, actor_art) "
                + "VALUES (?,?,?,?::jsonb,?::jsonb,?,?,?,?,?,?,?)", tenant, netzanschluss, art, altJson, neuJson,
                Timestamp.from(giltAb), rueckwirkend, grund, wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    /** {@code 630.000} aus NUMERIC(12,3) wird {@code 630} — die Zahl, die angelegt wurde. */
    private static BigDecimal ohneNullen(BigDecimal wert) {
        if (wert == null) {
            return null;
        }
        BigDecimal kurz = wert.stripTrailingZeros();
        return kurz.scale() < 0 ? kurz.setScale(0) : kurz;
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
