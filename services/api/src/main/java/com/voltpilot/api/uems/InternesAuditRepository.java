package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * UEMS AP-19 IP-18: internes Audit und seine Hinweise unter Mandanten-RLS und dem Standort-Zaun aus IP-16
 * ({@code V20260925031500}). Jeder Übergang schreibt eine Zeile in {@code energiemanagement_aenderung} (§5.6); die
 * Übergänge selbst hält die Datenbank einmalig (Trigger {@code internes_audit_eingefroren}). Gelöscht wird nie.
 */
@Repository
public class InternesAuditRepository {

    public record Audit(UUID id, String kennzeichen, String titel, LocalDate termin, List<UUID> auditorIds,
            String unabhaengigkeit, String was, String woran, String verantwortlichSub, String verantwortlichName,
            List<UUID> standortIds, String zustand, LocalDate durchgefuehrtAm, String abgesagtBegruendung,
            String zusammenfassung, String berichtBezeichnung, String berichtAblage, String berichtKennung,
            String berichtAdresse, String berichtSha256, String kopie, String pruefsumme, UUID entschiedenVon,
            LocalDate abgeschlossenAm, ProtokollAkteur abschluss, Instant abschlussEingetragenAm, ProtokollAkteur akteur,
            Instant angelegtAm, int hinweise) {}

    public record Stand(String titel, LocalDate termin, List<UUID> auditorIds, String unabhaengigkeit, String was,
            String woran, String verantwortlichSub, String verantwortlichName, String verantwortlichKonto,
            List<UUID> standortIds) {}

    public record Hinweis(int nr, LocalDate am, UUID festgestelltVon, String wortlaut, ProtokollAkteur akteur,
            Instant zeit) {}

    public record Person(UUID id, String name, String funktion, String kuerzel, String kontoSub, LocalDate bis) {}

    public record Konto(String sub, String konto, String name) {}

    public record Abschluss(UUID entschiedenVon, LocalDate am, String zusammenfassung, String berichtBezeichnung,
            String berichtAblage, String berichtKennung, String berichtAdresse, String berichtSha256, String kopie,
            String pruefsumme, Instant eingetragenAm) {}

    private final JdbcTemplate jdbc;

    public InternesAuditRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static final String AUDIT = """
            SELECT a.*, (SELECT count(*) FROM internes_audit_eintrag e WHERE e.tenant_id = a.tenant_id
                AND e.audit_id = a.id AND e.art = 'hinweis') AS hinweis_zahl
            FROM internes_audit a
            """;

    private static final RowMapper<Audit> AUDIT_ZEILE = (rs, n) -> new Audit(rs.getObject("id", UUID.class),
            rs.getString("kennzeichen"), rs.getString("titel"), rs.getObject("termin", LocalDate.class),
            uuids(rs.getArray("auditor_ids")), rs.getString("unabhaengigkeit"), rs.getString("was"),
            rs.getString("woran"), rs.getString("verantwortlich_sub"), rs.getString("verantwortlich_name"),
            uuids(rs.getArray("standort_ids")), rs.getString("zustand"),
            rs.getObject("durchgefuehrt_am", LocalDate.class), rs.getString("abgesagt_begruendung"),
            rs.getString("zusammenfassung"), rs.getString("bericht_bezeichnung"), rs.getString("bericht_ablage"),
            rs.getString("bericht_kennung"), rs.getString("bericht_adresse"), rs.getString("bericht_sha256"),
            rs.getString("kopie"), rs.getString("pruefsumme"), rs.getObject("entschieden_von", UUID.class),
            rs.getObject("abgeschlossen_am", LocalDate.class),
            rs.getString("abschluss_name") == null ? null : new ProtokollAkteur(rs.getString("abschluss_sub"),
                    rs.getString("abschluss_name"), rs.getString("abschluss_rolle"), rs.getString("abschluss_art")),
            instant(rs, "abschluss_eingetragen_am"), akteur(rs), instant(rs, "angelegt_am"), rs.getInt("hinweis_zahl"));

    /** Das Auditprogramm: alle Audits, die die Anfrage sieht — Termin absteigend. */
    public List<Audit> audits() {
        return jdbc.query(AUDIT + " ORDER BY a.termin DESC, a.kennzeichen DESC", AUDIT_ZEILE);
    }

    public Optional<Audit> audit(UUID id) {
        return jdbc.query(AUDIT + " WHERE a.id = ?", AUDIT_ZEILE, id).stream().findFirst();
    }

    /** Sperrt das Audit für den Übergang. */
    public Optional<Audit> auditSperren(UUID id) {
        return jdbc.query("SELECT a.*, 0 AS hinweis_zahl FROM internes_audit a WHERE a.id = ? FOR UPDATE", AUDIT_ZEILE,
                id).stream().findFirst();
    }

    public List<Hinweis> hinweise(UUID audit) {
        return jdbc.query("SELECT * FROM internes_audit_eintrag WHERE audit_id = ? AND art = 'hinweis' ORDER BY nr",
                (rs, n) -> new Hinweis(rs.getInt("nr"), rs.getObject("am", LocalDate.class),
                        rs.getObject("festgestellt_von", UUID.class), rs.getString("wortlaut"), akteur(rs),
                        instant(rs, "created_at")), audit);
    }

    /** Die Kennzeichen der Feststellungen mit Quelle dieses Audit (IA2). */
    public List<String> feststellungen(UUID audit) {
        return jdbc.queryForList("SELECT kennzeichen FROM feststellung WHERE audit_id = ? ORDER BY kennzeichen",
                String.class, audit);
    }

    public List<Person> personen(List<UUID> ids) {
        if (ids.isEmpty()) {
            return List.of();
        }
        return jdbc.query("SELECT id, name, funktion, kuerzel, konto_sub, bis FROM energiemanagement_person "
                + "WHERE id = ANY (?::uuid[])", (rs, n) -> new Person(rs.getObject("id", UUID.class),
                        rs.getString("name"), rs.getString("funktion"), rs.getString("kuerzel"),
                        rs.getString("konto_sub"), rs.getObject("bis", LocalDate.class)), feld(ids));
    }

    /** Die Person, die mit diesem Konto verknüpft ist (für „eingetragen von“ in der Kopie). */
    public Optional<Person> personDesKontos(String sub) {
        if (sub == null) {
            return Optional.empty();
        }
        return jdbc.query("SELECT id, name, funktion, kuerzel, konto_sub, bis FROM energiemanagement_person "
                + "WHERE konto_sub = ?", (rs, n) -> new Person(rs.getObject("id", UUID.class), rs.getString("name"),
                        rs.getString("funktion"), rs.getString("kuerzel"), rs.getString("konto_sub"),
                        rs.getObject("bis", LocalDate.class)), sub).stream().findFirst();
    }

    /** Ein aktives Konto des Kundenbereichs — Verantwortlich ist ein Konto (IA1). */
    public Optional<Konto> konto(String sub) {
        return jdbc.query("SELECT sub, konto, anzeigename FROM benutzer WHERE sub = ? AND zustand = 'aktiv'",
                (rs, n) -> new Konto(rs.getString("sub"), rs.getString("konto"), rs.getString("anzeigename")), sub)
                .stream().findFirst();
    }

    /** Wie viele der Standorte der Kundenbereich hat. */
    public int standorte(List<UUID> ids) {
        if (ids.isEmpty()) {
            return 0;
        }
        return jdbc.queryForObject("SELECT count(*) FROM standort WHERE id = ANY (?::uuid[])", Integer.class, feld(ids));
    }

    /** Herkunft und ihre Kennung einer Maßnahme (AP-18) — leer, wenn es sie im Kundenbereich nicht gibt. */
    public Optional<String[]> massnahmeHerkunft(String kennzeichen) {
        return jdbc.query("SELECT herkunft_art, herkunft_kennung FROM massnahme WHERE kennzeichen = ?",
                (rs, n) -> new String[] {rs.getString("herkunft_art"), rs.getString("herkunft_kennung")}, kennzeichen)
                .stream().findFirst();
    }

    /** Der Rhythmus des Kundenbereichs; ohne Einstellung der Startwert des Vertrags. */
    public Optional<Integer> rhythmusMonate() {
        return jdbc.queryForList("SELECT audit_rhythmus_monate FROM energiemanagement_einstellung", Integer.class)
                .stream().findFirst();
    }

    /** Legt das Audit geplant an; das Kennzeichen vergibt der Zähler im Jahr des Anlegens. */
    public UUID anlegen(Stand s, Instant angelegtAm, ProtokollAkteur wer) {
        UUID id = jdbc.queryForObject("""
                INSERT INTO internes_audit (tenant_id, titel, termin, auditor_ids, unabhaengigkeit, was, woran,
                    verantwortlich_sub, verantwortlich_name, verantwortlich_konto, standort_ids, angelegt_am,
                    actor_sub, actor_name, actor_rolle, actor_art)
                VALUES (?,?,?,?::uuid[],?,?,?,?,?,?,?::uuid[],?,?,?,?,?) RETURNING id
                """, UUID.class, tenant(), s.titel(), s.termin(), feld(s.auditorIds()), s.unabhaengigkeit(), s.was(),
                s.woran(), s.verantwortlichSub(), s.verantwortlichName(), s.verantwortlichKonto(),
                feld(s.standortIds()), Timestamp.from(angelegtAm), wer.sub(), wer.name(), wer.rolle(), wer.art());
        protokoll(id, "audit_geplant", null, schnappschuss(id), null, wer);
        return id;
    }

    public void aendern(UUID id, Stand s, String begruendung, ProtokollAkteur wer) {
        String alt = schnappschuss(id);
        jdbc.update("UPDATE internes_audit SET titel = ?, termin = ?, auditor_ids = ?::uuid[], unabhaengigkeit = ?, "
                + "was = ?, woran = ?, verantwortlich_sub = ?, verantwortlich_name = ?, verantwortlich_konto = ?, "
                + "standort_ids = ?::uuid[] WHERE id = ?", s.titel(), s.termin(), feld(s.auditorIds()),
                s.unabhaengigkeit(), s.was(), s.woran(), s.verantwortlichSub(), s.verantwortlichName(),
                s.verantwortlichKonto(), feld(s.standortIds()), id);
        protokoll(id, "audit_geaendert", alt, schnappschuss(id), begruendung, wer);
    }

    public void durchgefuehrt(UUID id, LocalDate am, ProtokollAkteur wer) {
        String alt = schnappschuss(id);
        jdbc.update("UPDATE internes_audit SET zustand = 'durchgefuehrt', durchgefuehrt_am = ? WHERE id = ?", am, id);
        protokoll(id, "audit_durchgefuehrt", alt, schnappschuss(id), null, wer);
    }

    /** Hängt einen Hinweis an; die Nummer vergibt der Trigger lückenlos. */
    public int hinweis(UUID audit, LocalDate am, UUID festgestelltVon, String wortlaut, ProtokollAkteur wer) {
        Integer nr = jdbc.queryForObject("""
                INSERT INTO internes_audit_eintrag (tenant_id, audit_id, art, am, festgestellt_von, wortlaut,
                    actor_sub, actor_name, actor_rolle, actor_art)
                VALUES (?,?,'hinweis',?,?,?,?,?,?,?) RETURNING nr
                """, Integer.class, tenant(), audit, am, festgestelltVon, wortlaut, wer.sub(), wer.name(), wer.rolle(),
                wer.art());
        String neu = jdbc.queryForObject("SELECT (to_jsonb(e) - 'tenant_id')::text FROM internes_audit_eintrag e "
                + "WHERE audit_id = ? AND art = 'hinweis' AND nr = ?", String.class, audit, nr);
        protokoll(audit, "hinweis", null, neu, null, wer);
        return nr;
    }

    public void abschliessen(UUID id, Abschluss a, ProtokollAkteur wer) {
        String alt = schnappschuss(id);
        jdbc.update("UPDATE internes_audit SET zustand = 'abgeschlossen', entschieden_von = ?, abgeschlossen_am = ?, "
                + "zusammenfassung = ?, bericht_bezeichnung = ?, bericht_ablage = ?, bericht_kennung = ?, "
                + "bericht_adresse = ?, bericht_sha256 = ?, kopie = ?, pruefsumme = ?, abschluss_sub = ?, "
                + "abschluss_name = ?, abschluss_rolle = ?, abschluss_art = ?, abschluss_eingetragen_am = ? "
                + "WHERE id = ?", a.entschiedenVon(), a.am(), a.zusammenfassung(), a.berichtBezeichnung(),
                a.berichtAblage(), a.berichtKennung(), a.berichtAdresse(), a.berichtSha256(), a.kopie(), a.pruefsumme(),
                wer.sub(), wer.name(), wer.rolle(), wer.art(), Timestamp.from(a.eingetragenAm()), id);
        protokoll(id, "audit_abgeschlossen", alt, schnappschuss(id), null, wer);
    }

    public void absagen(UUID id, String begruendung, ProtokollAkteur wer) {
        String alt = schnappschuss(id);
        jdbc.update("UPDATE internes_audit SET zustand = 'abgesagt', abgesagt_begruendung = ? WHERE id = ?",
                begruendung, id);
        protokoll(id, "audit_abgesagt", alt, schnappschuss(id), begruendung, wer);
    }

    public List<EnergiemanagementPersonenRepository.Aenderung> verlauf(UUID id) {
        return jdbc.query("SELECT * FROM energiemanagement_aenderung WHERE objekt = 'internes_audit' AND objekt_id = ? "
                + "ORDER BY created_at, id", (rs, n) -> new EnergiemanagementPersonenRepository.Aenderung(
                        rs.getLong("id"), rs.getString("art"), rs.getString("alt"), rs.getString("neu"),
                        rs.getString("begruendung"), akteur(rs), instant(rs, "created_at")), id);
    }

    private void protokoll(UUID id, String art, String alt, String neu, String begruendung, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO energiemanagement_aenderung (tenant_id, objekt, objekt_id, art, alt, neu, begruendung, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?,'internes_audit',?,?,?::jsonb,?::jsonb,?,?,?,?,?)",
                tenant(), id, art, alt, neu, begruendung, wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    private String schnappschuss(UUID id) {
        return jdbc.queryForObject("SELECT (to_jsonb(a) - 'tenant_id')::text FROM internes_audit a WHERE id = ?",
                String.class, id);
    }

    /** {@code {…}} als Text für {@code ?::uuid[]} — UUIDs brauchen keine Maskierung. */
    private static String feld(List<UUID> ids) {
        return ids.stream().map(UUID::toString).collect(Collectors.joining(",", "{", "}"));
    }

    private static List<UUID> uuids(Array a) throws SQLException {
        return a == null ? List.of() : Arrays.stream((Object[]) a.getArray()).map(o -> (UUID) o).toList();
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
