package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * UEMS AP-19 IP-6: Personen und Aufgaben unter Mandanten-RLS (Tabellen aus IP-5, V20260925013500). Aufgaben tragen den
 * Zaun „nur unternehmensweit“ ({@code site_scope}); Personen nur den Mandanten-Zaun. Jede Zeile nennt ihren Urheber;
 * jeder Übergang schreibt eine Zeile in {@code energiemanagement_aenderung} (§5.6). Gelöscht wird nie — die App-Rolle
 * hat kein DELETE, und die Fremdschlüssel sind RESTRICT (PA5).
 */
@Repository
public class EnergiemanagementPersonenRepository {

    public record Person(UUID id, String name, String funktion, String kuerzel, String organisation, String kontoSub,
            String kontoName, String kontoZustand, LocalDate seit, LocalDate bis, String zustand,
            String beendetBegruendung, ProtokollAkteur akteur, Instant angelegtAm) {}

    public record NeuePerson(String name, String funktion, String kuerzel, String organisation, String kontoSub,
            LocalDate seit) {}

    public record Stand(String name, String funktion, String kuerzel, String organisation, String kontoSub,
            LocalDate seit) {}

    public record Zuordnung(UUID id, String aufgabe, String aufgabeWortlaut, UUID personId, LocalDate giltAb,
            LocalDate giltBis, UUID vertretungPersonId, UUID entschiedenVon, String begruendung,
            String belegBezeichnung, String belegAblage, String belegKennung, String belegAdresse, String belegSha256,
            String beschlussKennung, String zustand, String beendetBegruendung, ProtokollAkteur akteur,
            Instant angelegtAm) {}

    public record NeueZuordnung(String aufgabe, String aufgabeWortlaut, UUID personId, LocalDate giltAb,
            UUID vertretungPersonId, UUID entschiedenVon, String begruendung, String belegBezeichnung,
            String belegAblage, String belegKennung, String belegAdresse, String belegSha256,
            String beschlussKennung) {}

    public record Aenderung(long id, String art, String alt, String neu, String begruendung, ProtokollAkteur akteur,
            Instant zeit) {}

    private final JdbcTemplate jdbc;

    public EnergiemanagementPersonenRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static final String PERSON = """
            SELECT p.*, b.anzeigename AS konto_name, b.zustand AS konto_zustand
            FROM energiemanagement_person p
            LEFT JOIN benutzer b ON b.tenant_id = p.tenant_id AND b.sub = p.konto_sub
            """;

    private static final RowMapper<Person> PERSON_ZEILE = (rs, n) -> new Person(rs.getObject("id", UUID.class),
            rs.getString("name"), rs.getString("funktion"), rs.getString("kuerzel"), rs.getString("organisation"),
            rs.getString("konto_sub"), rs.getString("konto_name"), rs.getString("konto_zustand"),
            rs.getObject("seit", LocalDate.class), rs.getObject("bis", LocalDate.class), rs.getString("zustand"),
            rs.getString("beendet_begruendung"), akteur(rs), instant(rs, "created_at"));

    private static final RowMapper<Zuordnung> ZUORDNUNG = (rs, n) -> new Zuordnung(rs.getObject("id", UUID.class),
            rs.getString("aufgabe"), rs.getString("aufgabe_wortlaut"), rs.getObject("person_id", UUID.class),
            rs.getObject("gilt_ab", LocalDate.class), rs.getObject("gilt_bis", LocalDate.class),
            rs.getObject("vertretung_person_id", UUID.class), rs.getObject("entschieden_von", UUID.class),
            rs.getString("begruendung"), rs.getString("beleg_bezeichnung"), rs.getString("beleg_ablage"),
            rs.getString("beleg_kennung"), rs.getString("beleg_adresse"), rs.getString("beleg_sha256"),
            rs.getString("beschluss_kennung"), rs.getString("zustand"), rs.getString("beendet_begruendung"),
            akteur(rs), instant(rs, "created_at"));

    /** Alle Personen des Kundenbereichs, auch beendete: aktive zuerst, dann nach Name. */
    public List<Person> personen() {
        return jdbc.query(PERSON + " ORDER BY p.zustand = 'beendet', lower(p.name), p.created_at, p.id", PERSON_ZEILE);
    }

    public Optional<Person> person(UUID id) {
        return jdbc.query(PERSON + " WHERE p.id = ?", PERSON_ZEILE, id).stream().findFirst();
    }

    /** Sperrt die Person für den Übergang (FOR UPDATE, ohne den Benutzerspiegel). */
    public Optional<Person> personSperren(UUID id) {
        return jdbc.query("SELECT p.*, NULL AS konto_name, NULL AS konto_zustand FROM energiemanagement_person p "
                + "WHERE p.id = ? FOR UPDATE", PERSON_ZEILE, id).stream().findFirst();
    }

    public UUID personAnlegen(NeuePerson p, ProtokollAkteur wer) {
        UUID id = jdbc.queryForObject("""
                INSERT INTO energiemanagement_person (tenant_id, name, funktion, kuerzel, organisation, konto_sub, seit,
                    actor_sub, actor_name, actor_rolle, actor_art)
                VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id
                """, UUID.class, tenant(), p.name(), p.funktion(), p.kuerzel(), p.organisation(), p.kontoSub(),
                p.seit(), wer.sub(), wer.name(), wer.rolle(), wer.art());
        protokoll("person", id, "person_erfasst", null, personSchnappschuss(id), null, wer);
        return id;
    }

    /** Der änderbare Stand; eine Protokoll-Zeile {@code person_geaendert} mit alt und neu. */
    public void personAendern(UUID id, Stand s, String begruendung, ProtokollAkteur wer) {
        String alt = personSchnappschuss(id);
        jdbc.update("UPDATE energiemanagement_person SET name = ?, funktion = ?, kuerzel = ?, organisation = ?, "
                + "konto_sub = ?, seit = ? WHERE id = ?", s.name(), s.funktion(), s.kuerzel(), s.organisation(),
                s.kontoSub(), s.seit(), id);
        protokoll("person", id, "person_geaendert", alt, personSchnappschuss(id), begruendung, wer);
    }

    /** „bis“ beendet die Person, endgültig; eine Protokoll-Zeile {@code person_beendet}. */
    public void personBeenden(UUID id, LocalDate bis, String begruendung, ProtokollAkteur wer) {
        String alt = personSchnappschuss(id);
        jdbc.update("UPDATE energiemanagement_person SET bis = ?, zustand = 'beendet', beendet_begruendung = ? "
                + "WHERE id = ?", bis, begruendung, id);
        protokoll("person", id, "person_beendet", alt, personSchnappschuss(id), begruendung, wer);
    }

    public boolean kuerzelVergeben(String kuerzel, UUID ausser) {
        return !jdbc.queryForList("SELECT id FROM energiemanagement_person WHERE kuerzel = ? AND id IS DISTINCT FROM ?",
                UUID.class, kuerzel, ausser).isEmpty();
    }

    public boolean kontoVergeben(String sub, UUID ausser) {
        return !jdbc.queryForList("SELECT id FROM energiemanagement_person WHERE konto_sub = ? "
                + "AND id IS DISTINCT FROM ?", UUID.class, sub, ausser).isEmpty();
    }

    /** Ein Konto des Kundenbereichs, das es gibt und das nicht entfernt ist (Muster Energieeinsatz). */
    public boolean kontoVorhanden(String sub) {
        return !jdbc.queryForList("SELECT sub FROM benutzer WHERE sub = ? AND konto = 'benutzer' "
                + "AND zustand <> 'entfernt' FOR SHARE", String.class, sub).isEmpty();
    }

    /** Zuordnungen, die die Person als Person oder Vertretung NACH {@code bis} noch tragen. */
    public List<Zuordnung> laufendNach(UUID person, LocalDate bis) {
        return jdbc.query("SELECT * FROM energiemanagement_aufgabe WHERE (person_id = ? OR vertretung_person_id = ?) "
                + "AND (gilt_bis IS NULL OR gilt_bis > ?) ORDER BY gilt_ab, created_at, id", ZUORDNUNG, person, person,
                bis);
    }

    public List<Aenderung> verlauf(String objekt, UUID id) {
        return jdbc.query("SELECT * FROM energiemanagement_aenderung WHERE objekt = ? AND objekt_id = ? "
                + "ORDER BY created_at, id", (rs, n) -> new Aenderung(rs.getLong("id"), rs.getString("art"),
                        rs.getString("alt"), rs.getString("neu"), rs.getString("begruendung"), akteur(rs),
                        instant(rs, "created_at")), objekt, id);
    }

    /** Alle Zuordnungen, auch beendete und künftige — unter dem Zaun „nur unternehmensweit“. */
    public List<Zuordnung> zuordnungen() {
        return jdbc.query("SELECT * FROM energiemanagement_aufgabe ORDER BY gilt_ab, created_at, id", ZUORDNUNG);
    }

    public Optional<Zuordnung> zuordnungSperren(UUID id) {
        return jdbc.query("SELECT * FROM energiemanagement_aufgabe WHERE id = ? FOR UPDATE", ZUORDNUNG, id).stream()
                .findFirst();
    }

    public Optional<Zuordnung> zuordnung(UUID id) {
        return jdbc.query("SELECT * FROM energiemanagement_aufgabe WHERE id = ?", ZUORDNUNG, id).stream().findFirst();
    }

    /** Dieselbe Aufgabe (bei „weitere“ derselbe Wortlaut) für dieselbe Person, die ab {@code ab} noch gilt. */
    public boolean ueberschneidet(String aufgabe, String wortlaut, UUID person, LocalDate ab) {
        return !jdbc.queryForList("SELECT id FROM energiemanagement_aufgabe WHERE aufgabe = ? "
                + "AND aufgabe_wortlaut IS NOT DISTINCT FROM ? AND person_id = ? AND (gilt_bis IS NULL OR gilt_bis >= ?)",
                UUID.class, aufgabe, wortlaut, person, ab).isEmpty();
    }

    public UUID zuordnen(NeueZuordnung z, ProtokollAkteur wer) {
        UUID id = jdbc.queryForObject("""
                INSERT INTO energiemanagement_aufgabe (tenant_id, aufgabe, aufgabe_wortlaut, person_id, gilt_ab,
                    vertretung_person_id, entschieden_von, begruendung, beleg_bezeichnung, beleg_ablage, beleg_kennung,
                    beleg_adresse, beleg_sha256, beschluss_kennung, actor_sub, actor_name, actor_rolle, actor_art)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id
                """, UUID.class, tenant(), z.aufgabe(), z.aufgabeWortlaut(), z.personId(), z.giltAb(),
                z.vertretungPersonId(), z.entschiedenVon(), z.begruendung(), z.belegBezeichnung(), z.belegAblage(),
                z.belegKennung(), z.belegAdresse(), z.belegSha256(), z.beschlussKennung(), wer.sub(), wer.name(),
                wer.rolle(), wer.art());
        protokoll("aufgabe", id, "aufgabe_zugeordnet", null, zuordnungSchnappschuss(id), z.begruendung(), wer);
        return id;
    }

    public void beenden(UUID id, LocalDate bis, String begruendung, ProtokollAkteur wer) {
        String alt = zuordnungSchnappschuss(id);
        jdbc.update("UPDATE energiemanagement_aufgabe SET gilt_bis = ?, zustand = 'beendet', beendet_begruendung = ? "
                + "WHERE id = ?", bis, begruendung, id);
        protokoll("aufgabe", id, "aufgabe_beendet", alt, zuordnungSchnappschuss(id), begruendung, wer);
    }

    private void protokoll(String objekt, UUID id, String art, String alt, String neu, String begruendung,
            ProtokollAkteur wer) {
        jdbc.update("INSERT INTO energiemanagement_aenderung (tenant_id, objekt, objekt_id, art, alt, neu, begruendung, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?,?,?,?,?::jsonb,?::jsonb,?,?,?,?,?)",
                tenant(), objekt, id, art, alt, neu, begruendung, wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    private String personSchnappschuss(UUID id) {
        return jdbc.queryForObject("SELECT (to_jsonb(p) - 'tenant_id')::text FROM energiemanagement_person p "
                + "WHERE id = ?", String.class, id);
    }

    private String zuordnungSchnappschuss(UUID id) {
        return jdbc.queryForObject("SELECT (to_jsonb(a) - 'tenant_id')::text FROM energiemanagement_aufgabe a "
                + "WHERE id = ?", String.class, id);
    }

    private static UUID tenant() {
        return Objects.requireNonNull(TenantContext.get(), "Mandant aus TenantContext erforderlich");
    }

    private static ProtokollAkteur akteur(ResultSet rs) throws SQLException {
        return new ProtokollAkteur(rs.getString("actor_sub"), rs.getString("actor_name"),
                rs.getString("actor_rolle"), rs.getString("actor_art"));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
