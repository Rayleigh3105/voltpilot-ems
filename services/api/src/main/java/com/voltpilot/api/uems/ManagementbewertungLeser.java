package com.voltpilot.api.uems;

import java.sql.Array;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * UEMS AP-19 IP-23 (MG4–MG6): die Leser von Sitzung, Beschlüssen und Folgen einer Managementbewertung — auf DER
 * Verbindung, die man ihnen gibt (die Bildung des Abzugs oder die Anfrage), immer im genannten Mandanten.
 *
 * <p>Die Folgen eines Beschlusses sind zweierlei, beide nur angehängt: die Hand-Verknüpfung
 * ({@code managementbewertung_folge}: Energieziel, Dokument-Fassung, Aufgabe, internes Audit — {@code wie = von_hand}) und
 * die Objekte, die den Beschluss selbst nennen — eine Maßnahme mit Herkunft {@code managementbewertung} ({@code herkunft}),
 * eine Aufgabe ({@code zuordnung}), eine Dokument-Fassung ({@code fassung}) und „geprüft, bleibt“ ({@code geprueft_bleibt})
 * über ihre {@code beschluss_kennung} BR-…/Bn. Gelesen, nie kopiert: der Zustand ist der von heute (R14).
 */
final class ManagementbewertungLeser {

    record Sitzung(UUID id, LocalDate tag, UUID leitung, List<UUID> teilnehmende, String ort, String eingetragenVon,
            LocalDate eingetragenAm) {}

    record Beschluss(UUID id, int nr, String art, String wortlaut, UUID entschiedenVon, UUID zustaendig,
            LocalDate termin, String eingetragenVon, LocalDate eingetragenAm) {}

    /**
     * Eine Folge: der Beschluss (Nr.), die Art des Objekts ({@code folge_art}), sein Kennzeichen, wie verknüpft, sein
     * Zustand heute (das Wort des Objekts), ein Tag des Objekts (Termin, gilt ab, freigegeben, geprüft) und eine Angabe
     * (Zielperiode des Energieziels, Person der Aufgabe), wann und von wem verknüpft.
     */
    record Folge(int beschluss, String art, String objekt, UUID objektId, String wie, String zustand, LocalDate tag,
            String angabe, LocalDate verknuepftAm, String eingetragenVon) {}

    private ManagementbewertungLeser() {}

    static Optional<Sitzung> sitzung(JdbcTemplate j, UUID tenant, UUID bericht, ZoneId zone) {
        return j.query("SELECT id, tag, leitung_person_id, teilnehmende, ort, actor_name, geaendert_am "
                + "FROM managementbewertung_sitzung WHERE tenant_id = ? AND bericht_id = ?", (rs, i) -> new Sitzung(
                        rs.getObject("id", UUID.class), rs.getObject("tag", LocalDate.class),
                        rs.getObject("leitung_person_id", UUID.class), uuids(rs.getArray("teilnehmende")),
                        rs.getString("ort"), rs.getString("actor_name"), tag(rs.getTimestamp("geaendert_am"), zone)),
                tenant, bericht).stream().findFirst();
    }

    static List<Beschluss> beschluesse(JdbcTemplate j, UUID tenant, UUID bericht, ZoneId zone) {
        return j.query("SELECT id, nr, art, wortlaut, entschieden_von, zustaendig, termin, actor_name, created_at "
                + "FROM managementbewertung_beschluss WHERE tenant_id = ? AND bericht_id = ? ORDER BY nr",
                (rs, i) -> new Beschluss(rs.getObject("id", UUID.class), rs.getInt("nr"), rs.getString("art"),
                        rs.getString("wortlaut"), rs.getObject("entschieden_von", UUID.class),
                        rs.getObject("zustaendig", UUID.class), rs.getObject("termin", LocalDate.class),
                        rs.getString("actor_name"), tag(rs.getTimestamp("created_at"), zone)),
                tenant, bericht);
    }

    /** Die Namen der Personen, wie sie heute heißen; eine unbekannte ID fehlt in der Antwort. */
    static Map<UUID, String> namen(JdbcTemplate j, UUID tenant, Collection<UUID> ids) {
        Map<UUID, String> aus = new LinkedHashMap<>();
        if (ids.isEmpty()) {
            return aus;
        }
        j.query("SELECT id, name FROM energiemanagement_person WHERE tenant_id = ? AND id = ANY (?::uuid[])", rs -> {
            aus.put(rs.getObject("id", UUID.class), rs.getString("name"));
        }, tenant, feld(ids));
        return aus;
    }

    /** PA3: hat die Person am {@code tag} die laufende Aufgabe „Leitung des Unternehmens“? */
    static boolean istLeitung(JdbcTemplate j, UUID tenant, UUID person, LocalDate tag) {
        Integer n = j.queryForObject("SELECT count(*) FROM energiemanagement_aufgabe WHERE tenant_id = ? "
                + "AND aufgabe = 'unternehmensleitung' AND person_id = ? AND gilt_ab <= ? "
                + "AND (gilt_bis IS NULL OR gilt_bis >= ?)", Integer.class, tenant, person, tag, tag);
        return n != null && n > 0;
    }

    /** MG6: die Folgen aller Beschlüsse der Managementbewertung {@code kennung}, nach Beschluss und Verknüpfung. */
    static List<Folge> folgen(JdbcTemplate j, UUID tenant, UUID bericht, String kennung, ZoneId zone) {
        List<Folge> aus = new ArrayList<>();
        j.query("""
                SELECT b.nr, f.art, f.created_at, f.actor_name,
                       e.id AS e_id, e.kennzeichen AS e_kz, e.zustand AS e_zustand, e.zielperiode,
                       fa.id AS f_id, d.kennzeichen || '/' || fa.fassung AS f_kz, fa.freigabe_status, fa.entschieden_tag,
                       a.id AS a_id, a.aufgabe, a.zustand AS a_zustand, a.gilt_ab, p.name AS a_person,
                       au.id AS au_id, au.kennzeichen AS au_kz, au.zustand AS au_zustand, au.durchgefuehrt_am
                  FROM managementbewertung_folge f
                  JOIN managementbewertung_beschluss b ON b.tenant_id = f.tenant_id AND b.id = f.beschluss_id
                  LEFT JOIN energieziel e ON e.tenant_id = f.tenant_id AND e.id = f.energieziel_id
                  LEFT JOIN energiemanagement_dokument_fassung fa ON fa.tenant_id = f.tenant_id AND fa.id = f.fassung_id
                  LEFT JOIN energiemanagement_dokument d ON d.tenant_id = fa.tenant_id AND d.id = fa.dokument_id
                  LEFT JOIN energiemanagement_aufgabe a ON a.tenant_id = f.tenant_id AND a.id = f.aufgabe_id
                  LEFT JOIN energiemanagement_person p ON p.tenant_id = a.tenant_id AND p.id = a.person_id
                  LEFT JOIN internes_audit au ON au.tenant_id = f.tenant_id AND au.id = f.audit_id
                 WHERE f.tenant_id = ? AND b.bericht_id = ?
                """, rs -> {
                    int nr = rs.getInt("nr");
                    LocalDate am = tag(rs.getTimestamp("created_at"), zone);
                    String von = rs.getString("actor_name");
                    switch (rs.getString("art")) {
                        case "energieziel" -> aus.add(new Folge(nr, "energieziel", rs.getString("e_kz"),
                                rs.getObject("e_id", UUID.class), "von_hand", rs.getString("e_zustand"), null,
                                rs.getString("zielperiode"), am, von));
                        case "dokument" -> aus.add(new Folge(nr, "dokument", rs.getString("f_kz"),
                                rs.getObject("f_id", UUID.class), "von_hand", rs.getString("freigabe_status"),
                                rs.getObject("entschieden_tag", LocalDate.class), null, am, von));
                        case "aufgabe" -> aus.add(new Folge(nr, "aufgabe", rs.getString("aufgabe"),
                                rs.getObject("a_id", UUID.class), "von_hand", rs.getString("a_zustand"),
                                rs.getObject("gilt_ab", LocalDate.class), rs.getString("a_person"), am, von));
                        default -> aus.add(new Folge(nr, "audit", rs.getString("au_kz"),
                                rs.getObject("au_id", UUID.class), "von_hand", rs.getString("au_zustand"),
                                rs.getObject("durchgefuehrt_am", LocalDate.class), null, am, von));
                    }
                }, tenant, bericht);
        // Die Objekte, die den Beschluss selbst nennen (BR-…/Bn) — die Nr. steht hinter dem letzten „/B“.
        String muster = "^" + kennung + "/B[0-9]{1,3}$"; // BR-JJJJ-nnnn: nur Ziffern und Striche
        j.query("SELECT id, kennzeichen, zustand, termin, herkunft_kennung, created_at, actor_name FROM massnahme "
                + "WHERE tenant_id = ? AND herkunft_art = 'managementbewertung' AND herkunft_kennung ~ ?", rs -> {
                    aus.add(new Folge(nr(rs.getString("herkunft_kennung")), "massnahme", rs.getString("kennzeichen"),
                            rs.getObject("id", UUID.class), "herkunft", rs.getString("zustand"),
                            rs.getObject("termin", LocalDate.class), null, tag(rs.getTimestamp("created_at"), zone),
                            rs.getString("actor_name")));
                }, tenant, muster);
        j.query("SELECT a.id, a.aufgabe, a.zustand, a.gilt_ab, a.beschluss_kennung, a.created_at, a.actor_name, "
                + "p.name AS person FROM energiemanagement_aufgabe a JOIN energiemanagement_person p "
                + "ON p.tenant_id = a.tenant_id AND p.id = a.person_id WHERE a.tenant_id = ? AND a.beschluss_kennung ~ ?",
                rs -> {
                    aus.add(new Folge(nr(rs.getString("beschluss_kennung")), "aufgabe", rs.getString("aufgabe"),
                            rs.getObject("id", UUID.class), "zuordnung", rs.getString("zustand"),
                            rs.getObject("gilt_ab", LocalDate.class), rs.getString("person"),
                            tag(rs.getTimestamp("created_at"), zone), rs.getString("actor_name")));
                }, tenant, muster);
        j.query("SELECT fa.id, d.kennzeichen || '/' || fa.fassung AS kz, fa.freigabe_status, fa.entschieden_tag, "
                + "fa.beschluss_kennung, fa.created_at, fa.actor_name FROM energiemanagement_dokument_fassung fa "
                + "JOIN energiemanagement_dokument d ON d.tenant_id = fa.tenant_id AND d.id = fa.dokument_id "
                + "WHERE fa.tenant_id = ? AND fa.beschluss_kennung ~ ?", rs -> {
                    aus.add(new Folge(nr(rs.getString("beschluss_kennung")), "dokument", rs.getString("kz"),
                            rs.getObject("id", UUID.class), "fassung", rs.getString("freigabe_status"),
                            rs.getObject("entschieden_tag", LocalDate.class), null,
                            tag(rs.getTimestamp("created_at"), zone), rs.getString("actor_name")));
                }, tenant, muster);
        j.query("SELECT e.dokument_id, d.kennzeichen, e.am, e.beschluss_kennung, e.created_at, e.actor_name "
                + "FROM energiemanagement_dokument_eintrag e JOIN energiemanagement_dokument d "
                + "ON d.tenant_id = e.tenant_id AND d.id = e.dokument_id WHERE e.tenant_id = ? "
                + "AND e.art = 'geprueft_bleibt' AND e.beschluss_kennung ~ ?", rs -> {
                    aus.add(new Folge(nr(rs.getString("beschluss_kennung")), "dokument", rs.getString("kennzeichen"),
                            rs.getObject("dokument_id", UUID.class), "geprueft_bleibt", "geprueft_bleibt",
                            rs.getObject("am", LocalDate.class), null, tag(rs.getTimestamp("created_at"), zone),
                            rs.getString("actor_name")));
                }, tenant, muster);
        aus.sort(Comparator.comparingInt(Folge::beschluss).thenComparing(Folge::verknuepftAm)
                .thenComparing(Folge::objekt, Comparator.nullsLast(Comparator.naturalOrder())));
        return aus;
    }

    private static int nr(String beschlussKennung) {
        return Integer.parseInt(beschlussKennung.substring(beschlussKennung.lastIndexOf("/B") + 2));
    }

    private static LocalDate tag(Timestamp t, ZoneId zone) {
        return t == null ? null : LocalDate.ofInstant(t.toInstant(), zone);
    }

    private static List<UUID> uuids(Array a) throws SQLException {
        return a == null ? List.of() : Arrays.stream((Object[]) a.getArray()).map(o -> (UUID) o).toList();
    }

    /** Eine Liste von IDs als {@code uuid[]}-Literal (Muster {@code InternesAuditRepository}). */
    static String feld(Collection<UUID> ids) {
        return ids.stream().map(UUID::toString).collect(Collectors.joining(",", "{", "}"));
    }
}
