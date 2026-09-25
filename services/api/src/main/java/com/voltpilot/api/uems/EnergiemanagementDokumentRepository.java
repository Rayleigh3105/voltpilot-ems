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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * UEMS AP-19 IP-7: Dokumente, Fassungen, Anwendungsbereich und Einträge unter Mandanten-RLS und dem Standort-Zaun aus
 * IP-5 ({@code site_scope} über {@code standort_id}; Fassung, Eintrag, Anwendungsbereich und Protokoll folgen ihrem
 * Dokument). Jeder Übergang schreibt eine Zeile in {@code energiemanagement_aenderung} (§5.6, {@code objekt =
 * 'dokument'}). Gelöscht wird nie; Freigegebenes hält der Trigger unveränderlich.
 */
@Repository
public class EnergiemanagementDokumentRepository {

    /**
     * Ein Dokument mit seinem Bezug (G5): genau einer von Standort, Energieeinsatz, Person und Aufgabe ist gesetzt,
     * beim Energieeinsatz dazu der abgeleitete Standort als Zaun (IP-14).
     */
    public record Dokument(UUID id, String kennzeichen, String art, String titel, String bezug, UUID standortId,
            UUID energieeinsatzId, UUID personId, UUID aufgabeId, String zustand, Integer ueberpruefungMonate,
            String belegBezeichnung, String belegAblage, String belegKennung, String belegAdresse, String belegSha256,
            ProtokollAkteur akteur, Instant angelegtAm) {}

    public record NeuesDokument(String art, String titel, String bezug, UUID standortId, UUID energieeinsatzId,
            UUID personId, UUID aufgabeId, Integer ueberpruefungMonate, String belegBezeichnung, String belegAblage,
            String belegKennung, String belegAdresse, String belegSha256) {}

    /** Ein Energieeinsatz, wie ihn der Bezug eines Dokuments nennt (Kennzeichen und Name, AP-16). */
    public record Einsatz(UUID id, String kennzeichen, String name) {}

    public record Fassung(UUID id, int nr, String form, String wortlaut, String verweisBezeichnung,
            String verweisAblage, String verweisKennung, String verweisAdresse, String verweisFassungsangabe,
            LocalDate verweisDatum, String verweisSha256, String kopie, String pruefsumme, String begruendung,
            String beschlussKennung, boolean vieraugen, String status, UUID entschiedenVon, LocalDate entschiedenTag,
            String freigabeBegruendung, ProtokollAkteur freigabe, Instant freigabeAm, ProtokollAkteur entscheidung,
            Instant entschiedenAm, String entscheidungsBegruendung, Instant freigegebenAm, ProtokollAkteur akteur,
            Instant angelegtAm) {}

    /** Der Inhalt eines Entwurfs: Wortlaut ODER Verweis (G3), wahlfrei Begründung und Beschluss. */
    public record Inhalt(String form, String wortlaut, String verweisBezeichnung, String verweisAblage,
            String verweisKennung, String verweisAdresse, String verweisFassungsangabe, LocalDate verweisDatum,
            String verweisSha256, String begruendung, String beschlussKennung) {}

    public record Bereich(List<UUID> standortIds, List<String> traeger, String ausschluesse) {}

    public record Eintrag(long id, String art, Integer fassung, LocalDate am, UUID personId, UUID entschiedenVon,
            String kreis, String weg, String wegWortlaut, String begruendung, String beschlussKennung,
            String kommentar, ProtokollAkteur akteur, Instant angelegtAm) {}

    public record NeuerEintrag(String art, Integer fassung, LocalDate am, UUID personId, UUID entschiedenVon,
            String kreis, String weg, String wegWortlaut, String begruendung, String beschlussKennung) {}

    public record Standort(UUID id, String kurzzeichen, String name) {}

    private static final RowMapper<Dokument> DOKUMENT = (rs, n) -> new Dokument(rs.getObject("id", UUID.class),
            rs.getString("kennzeichen"), rs.getString("art"), rs.getString("titel"), rs.getString("bezug"),
            rs.getObject("standort_id", UUID.class), rs.getObject("energieeinsatz_id", UUID.class),
            rs.getObject("person_id", UUID.class), rs.getObject("aufgabe_id", UUID.class), rs.getString("zustand"),
            (Integer) rs.getObject("ueberpruefung_monate"), rs.getString("beleg_bezeichnung"),
            rs.getString("beleg_ablage"), rs.getString("beleg_kennung"), rs.getString("beleg_adresse"),
            rs.getString("beleg_sha256"), akteur(rs, "actor"), instant(rs, "angelegt_am"));

    private static final RowMapper<Fassung> FASSUNG = (rs, n) -> new Fassung(rs.getObject("id", UUID.class),
            rs.getInt("fassung"), rs.getString("form"), rs.getString("wortlaut"), rs.getString("verweis_bezeichnung"),
            rs.getString("verweis_ablage"), rs.getString("verweis_kennung"), rs.getString("verweis_adresse"),
            rs.getString("verweis_fassungsangabe"), rs.getObject("verweis_datum", LocalDate.class),
            rs.getString("verweis_sha256"), rs.getString("kopie"), rs.getString("pruefsumme"),
            rs.getString("begruendung"), rs.getString("beschluss_kennung"), rs.getBoolean("vieraugen"),
            rs.getString("freigabe_status"), rs.getObject("entschieden_von", UUID.class),
            rs.getObject("entschieden_tag", LocalDate.class), rs.getString("freigabe_begruendung"),
            rs.getString("freigabe_name") == null ? null : akteur(rs, "freigabe"), instant(rs, "freigabe_am"),
            rs.getString("entscheidung_name") == null ? null : akteur(rs, "entscheidung"),
            instant(rs, "entschieden_am"), rs.getString("entscheidungs_begruendung"), instant(rs, "freigegeben_am"),
            akteur(rs, "actor"), instant(rs, "created_at"));

    private static final RowMapper<Eintrag> EINTRAG = (rs, n) -> new Eintrag(rs.getLong("id"), rs.getString("art"),
            (Integer) rs.getObject("fassung"), rs.getObject("am", LocalDate.class),
            rs.getObject("person_id", UUID.class), rs.getObject("entschieden_von", UUID.class), rs.getString("kreis"),
            rs.getString("weg"), rs.getString("weg_wortlaut"), rs.getString("begruendung"),
            rs.getString("beschluss_kennung"), rs.getString("kommentar"), akteur(rs, "actor"),
            instant(rs, "created_at"));

    private final JdbcTemplate jdbc;

    public EnergiemanagementDokumentRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ------------------------------------------------------------------ Dokument

    /** Die Dokumente im Zaun der Anfrage, nach Kennzeichen (D-0001 vor D-0010). */
    public List<Dokument> dokumente() {
        return jdbc.query("SELECT * FROM energiemanagement_dokument ORDER BY length(kennzeichen), kennzeichen",
                DOKUMENT);
    }

    public Optional<Dokument> dokument(UUID id) {
        return jdbc.query("SELECT * FROM energiemanagement_dokument WHERE id = ?", DOKUMENT, id).stream().findFirst();
    }

    public Optional<Dokument> dokumentSperren(UUID id) {
        return jdbc.query("SELECT * FROM energiemanagement_dokument WHERE id = ? FOR UPDATE", DOKUMENT, id).stream()
                .findFirst();
    }

    /** Legt das Dokument im Entwurf an; D-nnnn vergibt der Trigger. Protokoll {@code dokument_angelegt}. */
    public UUID anlegen(NeuesDokument d, ProtokollAkteur wer) {
        UUID id = jdbc.queryForObject("""
                INSERT INTO energiemanagement_dokument (tenant_id, kennzeichen, art, titel, bezug, standort_id,
                    energieeinsatz_id, person_id, aufgabe_id, ueberpruefung_monate, beleg_bezeichnung, beleg_ablage,
                    beleg_kennung, beleg_adresse, beleg_sha256, actor_sub, actor_name, actor_rolle, actor_art)
                VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
                """, UUID.class, tenant(), d.art(), d.titel(), d.bezug(), d.standortId(), d.energieeinsatzId(),
                d.personId(), d.aufgabeId(), d.ueberpruefungMonate(), d.belegBezeichnung(), d.belegAblage(),
                d.belegKennung(), d.belegAdresse(), d.belegSha256(), wer.sub(), wer.name(), wer.rolle(), wer.art());
        protokoll(id, "dokument_angelegt", null, dokumentSchnappschuss(id), null, wer);
        return id;
    }

    /** entwurf → gültig mit der ersten freigegebenen Fassung (dieselbe Transaktion); Protokoll {@code dokument_gueltig}. */
    public void gueltig(UUID id, ProtokollAkteur wer) {
        String alt = dokumentSchnappschuss(id);
        jdbc.update("UPDATE energiemanagement_dokument SET zustand = 'gueltig' WHERE id = ?", id);
        protokoll(id, "dokument_gueltig", alt, dokumentSchnappschuss(id), null, wer);
    }

    /** Erst der Eintrag „aufgehoben“, dann der Zustand (DK8, Trigger); Protokoll {@code dokument_aufgehoben}. */
    public void aufheben(UUID id, NeuerEintrag e, ProtokollAkteur wer) {
        String alt = dokumentSchnappschuss(id);
        eintragen(id, e, wer);
        jdbc.update("UPDATE energiemanagement_dokument SET zustand = 'aufgehoben' WHERE id = ?", id);
        protokoll(id, "dokument_aufgehoben", alt, dokumentSchnappschuss(id), e.begruendung(), wer);
    }

    // ------------------------------------------------------------------ Fassung

    public List<Fassung> fassungen(UUID dokument) {
        return jdbc.query("SELECT * FROM energiemanagement_dokument_fassung WHERE dokument_id = ? ORDER BY fassung",
                FASSUNG, dokument);
    }

    public Optional<Fassung> fassungSperren(UUID dokument, int nr) {
        return jdbc.query("SELECT * FROM energiemanagement_dokument_fassung WHERE dokument_id = ? AND fassung = ? "
                + "FOR UPDATE", FASSUNG, dokument, nr).stream().findFirst();
    }

    /** Eine neue Fassung im Entwurf (Nr. vergibt der Trigger); Protokoll {@code fassung_entworfen}. */
    public int entwerfen(UUID dokument, Inhalt i, Bereich b, ProtokollAkteur wer) {
        UUID id = jdbc.queryForObject("""
                INSERT INTO energiemanagement_dokument_fassung (tenant_id, dokument_id, fassung, form, wortlaut,
                    verweis_bezeichnung, verweis_ablage, verweis_kennung, verweis_adresse, verweis_fassungsangabe,
                    verweis_datum, verweis_sha256, begruendung, beschluss_kennung,
                    actor_sub, actor_name, actor_rolle, actor_art)
                VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
                """, UUID.class, tenant(), dokument, i.form(), i.wortlaut(), i.verweisBezeichnung(),
                i.verweisAblage(), i.verweisKennung(), i.verweisAdresse(), i.verweisFassungsangabe(),
                i.verweisDatum(), i.verweisSha256(), i.begruendung(), i.beschlussKennung(), wer.sub(), wer.name(),
                wer.rolle(), wer.art());
        if (b != null) {
            bereichSchreiben(id, b, false);
        }
        protokoll(dokument, "fassung_entworfen", null, fassungSchnappschuss(id), i.begruendung(), wer);
        return jdbc.queryForObject("SELECT fassung FROM energiemanagement_dokument_fassung WHERE id = ?",
                Integer.class, id);
    }

    /** Der offene Entwurf wird überschrieben — im Entwurf ist die Fassung änderbar (Trigger); Protokoll wie oben. */
    public void entwurfUeberschreiben(UUID dokument, Fassung f, Inhalt i, Bereich b, ProtokollAkteur wer) {
        String alt = fassungSchnappschuss(f.id());
        jdbc.update("""
                UPDATE energiemanagement_dokument_fassung SET form = ?, wortlaut = ?, verweis_bezeichnung = ?,
                    verweis_ablage = ?, verweis_kennung = ?, verweis_adresse = ?, verweis_fassungsangabe = ?,
                    verweis_datum = ?, verweis_sha256 = ?, begruendung = ?, beschluss_kennung = ?
                 WHERE id = ?
                """, i.form(), i.wortlaut(), i.verweisBezeichnung(), i.verweisAblage(), i.verweisKennung(),
                i.verweisAdresse(), i.verweisFassungsangabe(), i.verweisDatum(), i.verweisSha256(), i.begruendung(),
                i.beschlussKennung(), f.id());
        if (b != null) {
            bereichSchreiben(f.id(), b, bereich(f.id()).isPresent());
        }
        protokoll(dokument, "fassung_entworfen", alt, fassungSchnappschuss(f.id()), i.begruendung(), wer);
    }

    /** Antrag (Vier-Augen): Kopie, Prüfsumme, „entschieden von“ und das beantragende Konto. */
    public void beantragen(UUID dokument, Fassung f, String kopie, String pruefsumme, UUID entschiedenVon,
            LocalDate tag, String begruendung, String freigabeRolle, ProtokollAkteur wer) {
        String alt = fassungSchnappschuss(f.id());
        jdbc.update("""
                UPDATE energiemanagement_dokument_fassung SET kopie = ?, pruefsumme = ?, vieraugen = true,
                    freigabe_status = 'beantragt', entschieden_von = ?, entschieden_tag = ?, freigabe_begruendung = ?,
                    freigabe_sub = ?, freigabe_name = ?, freigabe_rolle = ?, freigabe_art = ?, freigabe_am = now()
                 WHERE id = ?
                """, kopie, pruefsumme, entschiedenVon, tag, begruendung, wer.sub(), wer.name(), freigabeRolle,
                wer.art(), f.id());
        protokoll(dokument, "fassung_beantragt", alt, fassungSchnappschuss(f.id()), begruendung, wer);
    }

    /** Freigabe ohne Vier-Augen: direkt aus dem Entwurf; Protokoll {@code fassung_freigegeben}. */
    public void freigeben(UUID dokument, Fassung f, String kopie, String pruefsumme, UUID entschiedenVon,
            LocalDate tag, String begruendung, String freigabeRolle, ProtokollAkteur wer) {
        String alt = fassungSchnappschuss(f.id());
        jdbc.update("""
                UPDATE energiemanagement_dokument_fassung SET kopie = ?, pruefsumme = ?, freigabe_status = 'freigegeben',
                    entschieden_von = ?, entschieden_tag = ?, freigabe_begruendung = ?, freigabe_sub = ?,
                    freigabe_name = ?, freigabe_rolle = ?, freigabe_art = ?, freigabe_am = now(), freigegeben_am = now()
                 WHERE id = ?
                """, kopie, pruefsumme, entschiedenVon, tag, begruendung, wer.sub(), wer.name(), freigabeRolle,
                wer.art(), f.id());
        protokoll(dokument, "fassung_freigegeben", alt, fassungSchnappschuss(f.id()), begruendung, wer);
    }

    /** Vier-Augen: die zweite Person bestätigt den Antrag; ihre Begründung steht nur im Protokoll. */
    public void bestaetigen(UUID dokument, Fassung f, String begruendung, ProtokollAkteur wer) {
        String alt = fassungSchnappschuss(f.id());
        jdbc.update("""
                UPDATE energiemanagement_dokument_fassung SET freigabe_status = 'freigegeben', entscheidung_sub = ?,
                    entscheidung_name = ?, entscheidung_rolle = ?, entscheidung_art = ?, entschieden_am = now(),
                    freigegeben_am = now()
                 WHERE id = ?
                """, wer.sub(), wer.name(), wer.rolle(), wer.art(), f.id());
        protokoll(dokument, "fassung_freigegeben", alt, fassungSchnappschuss(f.id()), begruendung, wer);
    }

    /** Vier-Augen: die zweite Person lehnt ab; Protokoll {@code fassung_abgelehnt}. */
    public void ablehnen(UUID dokument, Fassung f, String begruendung, ProtokollAkteur wer) {
        String alt = fassungSchnappschuss(f.id());
        jdbc.update("""
                UPDATE energiemanagement_dokument_fassung SET freigabe_status = 'abgelehnt', entscheidung_sub = ?,
                    entscheidung_name = ?, entscheidung_rolle = ?, entscheidung_art = ?, entschieden_am = now(),
                    entscheidungs_begruendung = ?
                 WHERE id = ?
                """, wer.sub(), wer.name(), wer.rolle(), wer.art(), begruendung, f.id());
        protokoll(dokument, "fassung_abgelehnt", alt, fassungSchnappschuss(f.id()), begruendung, wer);
    }

    /** DK4: die frühere Fassung heißt ab jetzt „abgelöst“ — gelesen, nie gespeichert; nur die Protokoll-Zeile. */
    public void abgeloest(UUID dokument, int alt, int neu, ProtokollAkteur wer) {
        protokoll(dokument, "fassung_abgeloest", "{\"fassung\":" + alt + "}",
                "{\"fassung\":" + alt + ",\"abgeloest_durch\":" + neu + "}", null, wer);
    }

    // ------------------------------------------------------------------ Anwendungsbereich

    public Optional<Bereich> bereich(UUID fassung) {
        return jdbc.query("SELECT standort_ids, traeger, ausschluesse::text AS ausschluesse "
                + "FROM energiemanagement_anwendungsbereich WHERE fassung_id = ?", (rs, n) -> new Bereich(
                        uuids(rs.getArray("standort_ids")), texte(rs.getArray("traeger")), rs.getString("ausschluesse")),
                fassung).stream().findFirst();
    }

    private void bereichSchreiben(UUID fassung, Bereich b, boolean vorhanden) {
        String sql = vorhanden
                ? "UPDATE energiemanagement_anwendungsbereich SET standort_ids = ?, traeger = ?, ausschluesse = ?::jsonb "
                        + "WHERE fassung_id = ? AND tenant_id = ?"
                : "INSERT INTO energiemanagement_anwendungsbereich (standort_ids, traeger, ausschluesse, fassung_id, "
                        + "tenant_id) VALUES (?, ?, ?::jsonb, ?, ?)";
        jdbc.update(con -> {
            var ps = con.prepareStatement(sql);
            ps.setArray(1, con.createArrayOf("uuid", b.standortIds().toArray()));
            ps.setArray(2, con.createArrayOf("text", b.traeger().toArray()));
            ps.setString(3, b.ausschluesse());
            ps.setObject(4, fassung);
            ps.setObject(5, tenant());
            return ps;
        });
    }

    // ------------------------------------------------------------------ Einträge

    public List<Eintrag> eintraege(UUID dokument) {
        return jdbc.query("SELECT * FROM energiemanagement_dokument_eintrag WHERE dokument_id = ? "
                + "ORDER BY created_at, id", EINTRAG, dokument);
    }

    /** Ein Eintrag (nur anhängen) und seine Protokoll-Zeile — {@code bekannt_gemacht} bzw. {@code geprueft_bleibt}. */
    public void eintragMitProtokoll(UUID dokument, NeuerEintrag e, ProtokollAkteur wer) {
        long id = eintragen(dokument, e, wer);
        protokoll(dokument, e.art(), null, jdbc.queryForObject("SELECT (to_jsonb(e) - 'tenant_id')::text "
                + "FROM energiemanagement_dokument_eintrag e WHERE id = ?", String.class, id), e.begruendung(), wer);
    }

    private long eintragen(UUID dokument, NeuerEintrag e, ProtokollAkteur wer) {
        return jdbc.queryForObject("""
                INSERT INTO energiemanagement_dokument_eintrag (tenant_id, dokument_id, fassung, art, am, person_id,
                    entschieden_von, kreis, weg, weg_wortlaut, begruendung, beschluss_kennung,
                    actor_sub, actor_name, actor_rolle, actor_art)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
                """, Long.class, tenant(), dokument, e.fassung(), e.art(), e.am(), e.personId(), e.entschiedenVon(),
                e.kreis(), e.weg(), e.wegWortlaut(), e.begruendung(), e.beschlussKennung(), wer.sub(), wer.name(),
                wer.rolle(), wer.art());
    }

    // ------------------------------------------------------------------ Lesehilfen

    public List<EnergiemanagementPersonenRepository.Aenderung> verlauf(UUID dokument) {
        return jdbc.query("SELECT * FROM energiemanagement_aenderung WHERE objekt = 'dokument' AND objekt_id = ? "
                + "ORDER BY created_at, id", (rs, n) -> new EnergiemanagementPersonenRepository.Aenderung(
                        rs.getLong("id"), rs.getString("art"), rs.getString("alt"), rs.getString("neu"),
                        rs.getString("begruendung"), akteur(rs, "actor"), instant(rs, "created_at")), dokument);
    }

    /** Standorte im Zaun der Anfrage (RLS {@code site_scope} an {@code standort}). */
    public List<Standort> standorte(List<UUID> ids) {
        if (ids.isEmpty()) {
            return List.of();
        }
        return jdbc.query(con -> {
            var ps = con.prepareStatement("SELECT id, kurzzeichen, name FROM standort WHERE id = ANY (?)");
            ps.setArray(1, con.createArrayOf("uuid", ids.toArray()));
            return ps;
        }, (rs, n) -> new Standort(rs.getObject("id", UUID.class), rs.getString("kurzzeichen"), rs.getString("name")));
    }

    /**
     * Kennzeichen und Name der Energieeinsätze, die Bezüge nennen (IP-14). Der Einsatz hat keinen eigenen Zaun; wer das
     * Dokument sieht, sieht, woran es hängt.
     */
    public List<Einsatz> einsaetze(List<UUID> ids) {
        if (ids.isEmpty()) {
            return List.of();
        }
        return jdbc.query(con -> {
            var ps = con.prepareStatement("SELECT id, kennzeichen, name FROM energieeinsatz WHERE id = ANY (?)");
            ps.setArray(1, con.createArrayOf("uuid", ids.toArray()));
            return ps;
        }, (rs, n) -> new Einsatz(rs.getObject("id", UUID.class), rs.getString("kennzeichen"), rs.getString("name")));
    }

    /** Die Person, die das Konto des Aufrufers trägt — so nennt ein Eintrag, wer ihn festgehalten hat. */
    public Optional<UUID> personDesKontos(String sub) {
        return sub == null ? Optional.empty() : jdbc.queryForList(
                "SELECT id FROM energiemanagement_person WHERE konto_sub = ?", UUID.class, sub).stream().findFirst();
    }

    /** AP-08 E8: die Vier-Augen-Einstellung des Unternehmens; ohne Einstellung gilt die Vorgabe aus. */
    public boolean vierAugen() {
        List<Boolean> werte = jdbc.queryForList("SELECT vieraugen_freigabe FROM unternehmen WHERE tenant_id = ? "
                + "FOR SHARE", Boolean.class, tenant());
        return !werte.isEmpty() && Boolean.TRUE.equals(werte.get(0));
    }

    // ------------------------------------------------------------------ Hilfen

    private void protokoll(UUID dokument, String art, String alt, String neu, String begruendung, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO energiemanagement_aenderung (tenant_id, objekt, objekt_id, art, alt, neu, begruendung, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?,'dokument',?,?,?::jsonb,?::jsonb,?,?,?,?,?)",
                tenant(), dokument, art, alt, neu, begruendung, wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    private String dokumentSchnappschuss(UUID id) {
        return jdbc.queryForObject("SELECT (to_jsonb(d) - 'tenant_id')::text FROM energiemanagement_dokument d "
                + "WHERE id = ?", String.class, id);
    }

    private String fassungSchnappschuss(UUID id) {
        return jdbc.queryForObject("SELECT (to_jsonb(f) - 'tenant_id')::text FROM energiemanagement_dokument_fassung f "
                + "WHERE id = ?", String.class, id);
    }

    private static UUID tenant() {
        return Objects.requireNonNull(TenantContext.get(), "Mandant aus TenantContext erforderlich");
    }

    private static ProtokollAkteur akteur(ResultSet rs, String praefix) throws SQLException {
        return new ProtokollAkteur(rs.getString(praefix + "_sub"), rs.getString(praefix + "_name"),
                rs.getString(praefix + "_rolle"), rs.getString(praefix + "_art"));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    private static List<UUID> uuids(Array a) throws SQLException {
        return Arrays.asList((UUID[]) a.getArray());
    }

    private static List<String> texte(Array a) throws SQLException {
        return Arrays.asList((String[]) a.getArray());
    }

    /** MG6: der genannte Beschluss BR-…/Bn gibt es, und seine Managementbewertung ist freigegeben (sonst 422). */
    public void beschlussPruefen(String kennung) {
        ManagementbewertungBeschluss.pruefen(jdbc, kennung);
    }
}
