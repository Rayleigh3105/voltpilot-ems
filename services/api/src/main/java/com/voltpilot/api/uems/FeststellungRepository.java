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
 * UEMS AP-19 IP-19: Feststellung, ihre Einträge und die Stände ihrer Wirksamkeit unter Mandanten-RLS und dem
 * Standort-Zaun aus IP-16 ({@code V20260925031500}). Jeder Übergang schreibt eine Zeile in
 * {@code energiemanagement_aenderung} (§5.6); den Zustand {@code abgeschlossen} setzt der schließende Stand selbst
 * (Trigger {@code feststellung_wirksamkeit_schliesst}) — dieses Repository schreibt ihn nie. Gelöscht wird nie.
 */
@Repository
public class FeststellungRepository {

    public record Feststellung(UUID id, String kennzeichen, String quelleArt, UUID auditId, String auditKennzeichen,
            String quelleKennung, String quelleWortlaut, String wortlaut, UUID vorgabeDokumentId,
            String vorgabeDokument, Integer vorgabeFassung, String vorgabeWortlaut, UUID standortId, String bezugAufgabe,
            UUID bezugDokumentId, String bezugDokument, List<String> bezugObjekte, UUID festgestelltVon,
            LocalDate festgestelltAm, String verantwortlichSub, String verantwortlichName, LocalDate frist,
            String zustand, ProtokollAkteur akteur, Instant angelegtAm, int eintraege, String ergebnis) {}

    public record Neu(String quelleArt, UUID auditId, String quelleKennung, String quelleWortlaut, String wortlaut,
            UUID vorgabeDokumentId, Integer vorgabeFassung, String vorgabeWortlaut, UUID standortId,
            String bezugAufgabe, UUID bezugDokumentId, List<String> bezugObjekte, UUID festgestelltVon,
            LocalDate festgestelltAm, String verantwortlichSub, String verantwortlichName, String verantwortlichKonto,
            LocalDate frist) {}

    public record Eintrag(long id, String art, LocalDate am, UUID personId, String wortlaut, ProtokollAkteur akteur,
            Instant zeit) {}

    public record Massnahme(UUID id, String kennzeichen, String titel, String zustand, LocalDate termin,
            LocalDate umgesetztAm, String verantwortlichSub, String verantwortlichName) {}

    public record Stand(UUID id, int nr, String ergebnis, String begruendung, UUID entschiedenVon, LocalDate am,
            String kopie, String pruefsumme, boolean vieraugen, String status, ProtokollAkteur freigabe,
            Instant freigabeAm, ProtokollAkteur entscheidung, Instant entschiedenAm, String ablehnung) {}

    public record NeuerStand(String ergebnis, String begruendung, UUID entschiedenVon, LocalDate am, String kopie,
            String pruefsumme, boolean vieraugen, String freigabeRolle, Instant jetzt) {}

    /** Die laufende Zuordnung einer Aufgabe an einem Tag, mit den Personen (Kürzel, ohne Kürzel der Name). */
    public record Zuordnung(String aufgabe, String person, String vertretung, LocalDate giltAb, String entschiedenVon) {}

    /** Ein Konto mit Recht, eine Wirksamkeit freizugeben (Kundenadministrator oder Energiemanager am Unternehmen). */
    public record Berechtigt(String sub, String name) {}

    private final JdbcTemplate jdbc;

    public FeststellungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static final String FESTSTELLUNG = """
            SELECT f.*, a.kennzeichen AS audit_kennzeichen, vd.kennzeichen AS vorgabe_dokument,
                bd.kennzeichen AS bezug_dokument,
                (SELECT count(*) FROM feststellung_eintrag e WHERE e.tenant_id = f.tenant_id
                    AND e.feststellung_id = f.id) AS eintrag_zahl,
                (SELECT w.ergebnis FROM feststellung_wirksamkeit w WHERE w.tenant_id = f.tenant_id
                    AND w.feststellung_id = f.id AND w.status = 'freigegeben'
                    AND w.ergebnis IN ('wirksam', 'ohne_massnahme', 'zurueckgenommen')) AS schluss
            FROM feststellung f
            LEFT JOIN internes_audit a ON a.id = f.audit_id AND a.tenant_id = f.tenant_id
            LEFT JOIN energiemanagement_dokument vd ON vd.id = f.vorgabe_dokument_id AND vd.tenant_id = f.tenant_id
            LEFT JOIN energiemanagement_dokument bd ON bd.id = f.bezug_dokument_id AND bd.tenant_id = f.tenant_id
            """;

    private static final RowMapper<Feststellung> ZEILE = (rs, n) -> new Feststellung(rs.getObject("id", UUID.class),
            rs.getString("kennzeichen"), rs.getString("quelle_art"), rs.getObject("audit_id", UUID.class),
            rs.getString("audit_kennzeichen"), rs.getString("quelle_kennung"), rs.getString("quelle_wortlaut"),
            rs.getString("wortlaut"), rs.getObject("vorgabe_dokument_id", UUID.class), rs.getString("vorgabe_dokument"),
            (Integer) rs.getObject("vorgabe_fassung"), rs.getString("vorgabe_wortlaut"),
            rs.getObject("standort_id", UUID.class), rs.getString("bezug_aufgabe"),
            rs.getObject("bezug_dokument_id", UUID.class), rs.getString("bezug_dokument"),
            texte(rs.getArray("bezug_objekte")), rs.getObject("festgestellt_von", UUID.class),
            rs.getObject("festgestellt_am", LocalDate.class), rs.getString("verantwortlich_sub"),
            rs.getString("verantwortlich_name"), rs.getObject("frist", LocalDate.class), rs.getString("zustand"),
            akteur(rs, "actor"), instant(rs, "angelegt_am"), rs.getInt("eintrag_zahl"), rs.getString("schluss"));

    /** Alle sichtbaren Feststellungen: offene zuerst nach Frist (am längsten überfällig oben), dann abgeschlossene. */
    public List<Feststellung> feststellungen() {
        return jdbc.query(FESTSTELLUNG + " ORDER BY (f.zustand <> 'offen'), CASE WHEN f.zustand = 'offen' THEN f.frist "
                + "END, f.kennzeichen DESC", ZEILE);
    }

    public Optional<Feststellung> feststellung(UUID id) {
        return jdbc.query(FESTSTELLUNG + " WHERE f.id = ?", ZEILE, id).stream().findFirst();
    }

    /** Sperrt die Feststellung für den Übergang (die Stände sperren sie im Trigger ebenso). */
    public Optional<Feststellung> sperren(UUID id) {
        jdbc.query("SELECT id FROM feststellung WHERE id = ? FOR UPDATE", (rs, n) -> 1, id);
        return feststellung(id);
    }

    public List<Eintrag> eintraege(UUID feststellung) {
        return jdbc.query("SELECT * FROM feststellung_eintrag WHERE feststellung_id = ? ORDER BY am, created_at, id",
                (rs, n) -> new Eintrag(rs.getLong("id"), rs.getString("art"), rs.getObject("am", LocalDate.class),
                        rs.getObject("person_id", UUID.class), rs.getString("wortlaut"), akteur(rs, "actor"),
                        instant(rs, "created_at")), feststellung);
    }

    /** Die Maßnahmen mit Herkunft {@code nichtkonformitaet} und dieser Kennung (FS3, IP-17) — im Zaun der Anfrage. */
    public List<Massnahme> massnahmen(String kennzeichen) {
        return jdbc.query("SELECT id, kennzeichen, titel, zustand, termin, umgesetzt_am, verantwortlich_sub, "
                + "verantwortlich_name FROM massnahme WHERE herkunft_art = 'nichtkonformitaet' AND herkunft_kennung = ? "
                + "ORDER BY kennzeichen", (rs, n) -> new Massnahme(rs.getObject("id", UUID.class),
                        rs.getString("kennzeichen"), rs.getString("titel"), rs.getString("zustand"),
                        rs.getObject("termin", LocalDate.class), rs.getObject("umgesetzt_am", LocalDate.class),
                        rs.getString("verantwortlich_sub"), rs.getString("verantwortlich_name")), kennzeichen);
    }

    public List<Stand> staende(UUID feststellung) {
        return jdbc.query("SELECT * FROM feststellung_wirksamkeit WHERE feststellung_id = ? ORDER BY stand_nr",
                (rs, n) -> new Stand(rs.getObject("id", UUID.class), rs.getInt("stand_nr"), rs.getString("ergebnis"),
                        rs.getString("begruendung"), rs.getObject("entschieden_von", UUID.class),
                        rs.getObject("entschieden_tag", LocalDate.class), rs.getString("kopie"),
                        rs.getString("pruefsumme"), rs.getBoolean("vieraugen"), rs.getString("status"),
                        akteur(rs, "freigabe"), instant(rs, "freigabe_am"),
                        rs.getString("entscheidung_name") == null ? null : akteur(rs, "entscheidung"),
                        instant(rs, "entschieden_am"), rs.getString("entscheidungs_begruendung")), feststellung);
    }

    /** Ein sichtbares Dokument mit dieser Fassung (die Vorgabe) — leer, wenn es sie im Zaun nicht gibt. */
    public boolean fassungVorhanden(UUID dokument, int fassung) {
        return !jdbc.queryForList("SELECT 1 FROM energiemanagement_dokument_fassung WHERE dokument_id = ? AND fassung = ?",
                Integer.class, dokument, fassung).isEmpty();
    }

    public boolean dokumentVorhanden(UUID dokument) {
        return !jdbc.queryForList("SELECT 1 FROM energiemanagement_dokument WHERE id = ?", Integer.class, dokument)
                .isEmpty();
    }

    /** Die Frist der Einstellung; ohne Einstellung der Startwert des Vertrags. */
    public Optional<Integer> fristTage() {
        return jdbc.queryForList("SELECT feststellung_frist_tage FROM energiemanagement_einstellung", Integer.class)
                .stream().findFirst();
    }

    /** Vier-Augen nach Einstellung des Unternehmens (Muster Dokument-Fassung, Maßnahmen-Bewertung). */
    public boolean vierAugen() {
        List<Boolean> werte = jdbc.queryForList("SELECT vieraugen_freigabe FROM unternehmen WHERE tenant_id = ? "
                + "FOR SHARE", Boolean.class, tenant());
        return !werte.isEmpty() && Boolean.TRUE.equals(werte.get(0));
    }

    /**
     * Wer eine Wirksamkeit freigeben darf: die aktiven Konten mit einer zu {@code jetzt} wirksamen Zuweisung als
     * Kundenadministrator oder Energiemanager am Unternehmen ({@code energiemanagement.freigeben} KA U · EM U) — nach
     * Namen, jedes einmal.
     */
    public List<Berechtigt> berechtigte(Instant jetzt) {
        return jdbc.query("""
                SELECT b.sub, coalesce(nullif(btrim(b.anzeigename), ''), b.sub) AS name
                FROM benutzer b
                WHERE b.zustand = 'aktiv' AND EXISTS (SELECT 1 FROM zugriff z
                    WHERE z.tenant_id = b.tenant_id AND z.benutzer_sub = b.sub AND z.standort_id IS NULL
                      AND z.rolle IN ('kundenadministrator', 'energiemanager')
                      AND public.zugriff_zeitraum(z.gueltig_ab, z.endet_am, z.beendet_am) @> ?::timestamptz)
                ORDER BY name, b.sub
                """, (rs, n) -> new Berechtigt(rs.getString("sub"), rs.getString("name")), Timestamp.from(jetzt));
    }

    /** Die an {@code tag} laufende Zuordnung der Aufgabe (die zuletzt begonnene), mit den Zeichen der Personen. */
    public Optional<Zuordnung> zuordnung(String aufgabe, LocalDate tag) {
        return jdbc.query("""
                SELECT a.aufgabe, a.gilt_ab, coalesce(p.kuerzel, p.name) AS person,
                    coalesce(v.kuerzel, v.name) AS vertretung, coalesce(e.kuerzel, e.name) AS entschieden
                FROM energiemanagement_aufgabe a
                JOIN energiemanagement_person p ON p.id = a.person_id AND p.tenant_id = a.tenant_id
                LEFT JOIN energiemanagement_person v ON v.id = a.vertretung_person_id AND v.tenant_id = a.tenant_id
                LEFT JOIN energiemanagement_person e ON e.id = a.entschieden_von AND e.tenant_id = a.tenant_id
                WHERE a.aufgabe = ? AND a.gilt_ab <= ? AND (a.gilt_bis IS NULL OR a.gilt_bis >= ?)
                ORDER BY a.gilt_ab DESC, a.created_at DESC, a.id DESC LIMIT 1
                """, (rs, n) -> new Zuordnung(rs.getString("aufgabe"), rs.getString("person"),
                        rs.getString("vertretung"), rs.getObject("gilt_ab", LocalDate.class),
                        rs.getString("entschieden")), aufgabe, tag, tag).stream().findFirst();
    }

    /** Erfasst die Feststellung offen; Kennzeichen (Jahr des Anlegens) und Frist-Vorgabe setzt der Trigger. */
    public UUID erfassen(Neu f, Instant angelegtAm, ProtokollAkteur wer) {
        UUID id = jdbc.queryForObject("""
                INSERT INTO feststellung (tenant_id, quelle_art, audit_id, quelle_kennung, quelle_wortlaut, wortlaut,
                    vorgabe_dokument_id, vorgabe_fassung, vorgabe_wortlaut, standort_id, bezug_aufgabe,
                    bezug_dokument_id, bezug_objekte, festgestellt_von, festgestellt_am, verantwortlich_sub,
                    verantwortlich_name, verantwortlich_konto, frist, angelegt_am, actor_sub, actor_name, actor_rolle,
                    actor_art)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id
                """, UUID.class, tenant(), f.quelleArt(), f.auditId(), f.quelleKennung(), f.quelleWortlaut(),
                f.wortlaut(), f.vorgabeDokumentId(), f.vorgabeFassung(), f.vorgabeWortlaut(), f.standortId(),
                f.bezugAufgabe(), f.bezugDokumentId(), f.bezugObjekte().toArray(String[]::new), f.festgestelltVon(),
                f.festgestelltAm(),
                f.verantwortlichSub(), f.verantwortlichName(), f.verantwortlichKonto(), f.frist(),
                Timestamp.from(angelegtAm), wer.sub(), wer.name(), wer.rolle(), wer.art());
        protokoll(id, "feststellung_erfasst", null, schnappschuss(id), null, wer);
        return id;
    }

    public long eintrag(UUID feststellung, String art, LocalDate am, UUID person, String wortlaut, ProtokollAkteur wer) {
        Long id = jdbc.queryForObject("""
                INSERT INTO feststellung_eintrag (tenant_id, feststellung_id, art, am, person_id, wortlaut, actor_sub,
                    actor_name, actor_rolle, actor_art)
                VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id
                """, Long.class, tenant(), feststellung, art, am, person, wortlaut, wer.sub(), wer.name(), wer.rolle(),
                wer.art());
        String neu = jdbc.queryForObject("SELECT (to_jsonb(e) - 'tenant_id')::text FROM feststellung_eintrag e "
                + "WHERE id = ?", String.class, id);
        protokoll(feststellung, "eintrag", null, neu, null, wer);
        return id;
    }

    public void frist(UUID id, LocalDate frist, String begruendung, ProtokollAkteur wer) {
        String alt = schnappschuss(id);
        jdbc.update("UPDATE feststellung SET frist = ? WHERE id = ?", frist, id);
        protokoll(id, "feststellung_geaendert", alt, schnappschuss(id), begruendung, wer);
    }

    public void verantwortlich(UUID id, String sub, String name, String konto, String begruendung, ProtokollAkteur wer) {
        String alt = schnappschuss(id);
        jdbc.update("UPDATE feststellung SET verantwortlich_sub = ?, verantwortlich_name = ?, verantwortlich_konto = ? "
                + "WHERE id = ?", sub, name, konto, id);
        protokoll(id, "feststellung_geaendert", alt, schnappschuss(id), begruendung, wer);
    }

    /**
     * Legt Stand Nr. n an — ohne Vier-Augen freigegeben, mit Vier-Augen als Antrag; die Nr. vergibt der Trigger.
     * Protokoll: {@code wirksamkeit_beantragt}, {@code wirksamkeit_geprueft} ({@code nicht_wirksam}) oder
     * {@code feststellung_abgeschlossen} (der Stand schließt sie selbst).
     */
    public int stand(UUID feststellung, NeuerStand s, ProtokollAkteur wer) {
        Integer nr = jdbc.queryForObject("""
                INSERT INTO feststellung_wirksamkeit (tenant_id, feststellung_id, ergebnis, begruendung,
                    entschieden_von, entschieden_tag, kopie, pruefsumme, vieraugen, status, freigabe_sub, freigabe_name,
                    freigabe_rolle, freigabe_art, freigabe_am)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING stand_nr
                """, Integer.class, tenant(), feststellung, s.ergebnis(), s.begruendung(), s.entschiedenVon(), s.am(),
                s.kopie(), s.pruefsumme(), s.vieraugen(), s.vieraugen() ? "beantragt" : "freigegeben", wer.sub(),
                wer.name(), s.freigabeRolle(), wer.art(), Timestamp.from(s.jetzt()));
        protokoll(feststellung, s.vieraugen() ? "wirksamkeit_beantragt" : wort(s.ergebnis()), null,
                standSchnappschuss(feststellung, nr), s.begruendung(), wer);
        return nr;
    }

    /** Die zweite Person bestätigt den Antrag (Vier-Augen); ein schließendes Ergebnis schließt die Feststellung. */
    public void bestaetigen(UUID feststellung, Stand antrag, Instant jetzt, ProtokollAkteur wer) {
        jdbc.update("UPDATE feststellung_wirksamkeit SET status = 'freigegeben', entscheidung_sub = ?, "
                + "entscheidung_name = ?, entscheidung_rolle = ?, entscheidung_art = ?, entschieden_am = ? WHERE id = ?",
                wer.sub(), wer.name(), wer.rolle(), wer.art(), Timestamp.from(jetzt), antrag.id());
        protokoll(feststellung, wort(antrag.ergebnis()), null, standSchnappschuss(feststellung, antrag.nr()), null, wer);
    }

    /** Die zweite Person lehnt den Antrag mit Begründung ab; der Stand behält seine Nr. */
    public void ablehnen(UUID feststellung, Stand antrag, String begruendung, Instant jetzt, ProtokollAkteur wer) {
        jdbc.update("UPDATE feststellung_wirksamkeit SET status = 'abgelehnt', entscheidung_sub = ?, "
                + "entscheidung_name = ?, entscheidung_rolle = ?, entscheidung_art = ?, entschieden_am = ?, "
                + "entscheidungs_begruendung = ? WHERE id = ?", wer.sub(), wer.name(), wer.rolle(), wer.art(),
                Timestamp.from(jetzt), begruendung, antrag.id());
        protokoll(feststellung, "wirksamkeit_abgelehnt", null, standSchnappschuss(feststellung, antrag.nr()), begruendung,
                wer);
    }

    public List<EnergiemanagementPersonenRepository.Aenderung> verlauf(UUID id) {
        return jdbc.query("SELECT * FROM energiemanagement_aenderung WHERE objekt = 'feststellung' AND objekt_id = ? "
                + "ORDER BY created_at, id", (rs, n) -> new EnergiemanagementPersonenRepository.Aenderung(
                        rs.getLong("id"), rs.getString("art"), rs.getString("alt"), rs.getString("neu"),
                        rs.getString("begruendung"), akteur(rs, "actor"), instant(rs, "created_at")), id);
    }

    /** §5.6: {@code nicht_wirksam} hält offen ({@code wirksamkeit_geprueft}), die übrigen schließen ab. */
    private static String wort(String ergebnis) {
        return "nicht_wirksam".equals(ergebnis) ? "wirksamkeit_geprueft" : "feststellung_abgeschlossen";
    }

    private void protokoll(UUID id, String art, String alt, String neu, String begruendung, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO energiemanagement_aenderung (tenant_id, objekt, objekt_id, art, alt, neu, begruendung, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?,'feststellung',?,?,?::jsonb,?::jsonb,?,?,?,?,?)",
                tenant(), id, art, alt, neu, begruendung, wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    private String schnappschuss(UUID id) {
        return jdbc.queryForObject("SELECT (to_jsonb(f) - 'tenant_id')::text FROM feststellung f WHERE id = ?",
                String.class, id);
    }

    private String standSchnappschuss(UUID feststellung, int nr) {
        return jdbc.queryForObject("SELECT (to_jsonb(w) - 'tenant_id' - 'kopie')::text FROM feststellung_wirksamkeit w "
                + "WHERE feststellung_id = ? AND stand_nr = ?", String.class, feststellung, nr);
    }

    private static List<String> texte(Array a) throws SQLException {
        return a == null ? List.of() : Arrays.stream((Object[]) a.getArray()).map(Object::toString).toList();
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

    /**
     * AP-19 IP-23 (FS1): gibt es den Beschluss {@code BR-…/Bn} einer sichtbaren Managementbewertung mit Stand? Leer ohne
     * Beschluss, sonst ob die Managementbewertung freigegeben ist.
     */
    public java.util.Optional<Boolean> beschlussImStand(String kennung) {
        return ManagementbewertungBeschluss.imStand(jdbc, kennung);
    }
}
