package com.voltpilot.api.uems;

import com.voltpilot.api.uems.MessreiheFassungen.Fassung;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Schreibweg der Werte einer Bezugsgröße (UEMS AP-09 IP-7): die Wert-Fassungen in {@code bezugsgroesse_wert}
 * und der Vorgang einer Berichtigung in {@code bezugsgroesse_berichtigung} (V20260915010000).
 *
 * <p>Keine Regel: was geschrieben werden darf, urteilen {@link BezugsgroesseRegeln} und {@link BezugsdatenRegeln}
 * im {@link BezugswertService}. Die Datenbank hält dieselben Wände noch einmal — append-only, lückenlose Fassungen,
 * Urheber ≠ Freigeber an derselben Wert-Fassung, bei Vier-Augen an nie der Ersteller als Freigeber. Nur innerhalb
 * einer Transaktion aufrufen; der Mandant ist die RLS.
 */
@Repository
public class BezugswertRepository {

    static final String TABELLE = "bezugsgroesse_berichtigung";

    private final JdbcTemplate jdbc;

    public BezugswertRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Der Vorgang einer Berichtigung ({@code BK-…}) mit allen Fassungen; die letzte ist sein Stand. */
    public record Berichtigung(
            String kennung,
            UUID bezugsgroesseId,
            LocalDate periodeVon,
            LocalDate periodeBis,
            String zeitzone,
            int ersetztFassung,
            BigDecimal betrag,
            String begruendung,
            String geliefertText,
            List<Fassung> fassungen) {

        public String status() {
            return fassungen.get(fassungen.size() - 1).status();
        }

        /** Wer die Berichtigung angelegt hat (Fassung 1). */
        public ProtokollAkteur ersteller() {
            return fassungen.get(0).akteur();
        }
    }

    /**
     * Eine neue Wert-Fassung — immer {@code wirksam} und Herkunft {@code eingabe}; der gelieferte Text und die Einheit
     * der Bezugsgröße bleiben in der Herkunft. {@code freigeber} nur, wenn eine ZWEITE Person freigab (F3).
     */
    public record NeueFassung(
            UUID tenant,
            BezugsgroesseRepository.Zeile bezugsgroesse,
            LocalDate periodeVon,
            LocalDate periodeBis,
            String zeitzone,
            int fassung,
            Integer ersetztFassung,
            String vorgang,
            BigDecimal betrag,
            String begruendung,
            String geliefertText,
            ProtokollAkteur urheber,
            ProtokollAkteur freigeber) {}

    /**
     * Die Vier-Augen-Einstellung des Unternehmens (AP-08 E8) mit Zeilensperre bis zum Ende der Transaktion — das
     * Umschalten wartet. Ohne Unternehmen-Zeile oder ohne Einstellung gilt die Vorgabe aus.
     */
    public boolean vierAugenGesperrt(UUID tenant) {
        List<Boolean> werte = jdbc.queryForList("SELECT vieraugen_freigabe FROM unternehmen WHERE tenant_id = ? "
                + "FOR SHARE", Boolean.class, tenant);
        return !werte.isEmpty() && Boolean.TRUE.equals(werte.get(0));
    }

    public void wertSchreiben(NeueFassung f) {
        BezugsgroesseRepository.Zeile b = f.bezugsgroesse();
        ProtokollAkteur u = f.urheber();
        ProtokollAkteur g = f.freigeber();
        jdbc.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                + "periode_von, periode_bis, zeitzone, fassung, ersetzt_fassung, vorgang, status, betrag, begruendung, "
                + "herkunft_art, geliefert_text, geliefert_einheit, actor_sub, actor_name, actor_rolle, actor_art, "
                + "freigeber_sub, freigeber_name, freigeber_rolle, freigeber_art) "
                + "VALUES (?,?,?,?,?,?,?,?,?,?,?,'wirksam',?,?,'eingabe',?,?,?,?,?,?,?,?,?,?)",
                f.tenant(), b.id(), b.wertart(), b.einheit(), b.periodeArt(), f.periodeVon(), f.periodeBis(),
                f.zeitzone(), f.fassung(), f.ersetztFassung(), f.vorgang(), f.betrag(), f.begruendung(),
                f.geliefertText(), b.einheit(), u.sub(), u.name(), u.rolle(), u.art(),
                g == null ? null : g.sub(), g == null ? null : g.name(), g == null ? null : g.rolle(),
                g == null ? null : g.art());
    }

    /**
     * Legt den Vorgang an (Fassung 1) und vergibt seine Kennung {@code BK-<Jahr>-<lfd. Nr.>} im Jahr der Erfassung in
     * der Zone der Bezugsgröße. {@code status} ist {@code vorschlag} (Vier-Augen an, noch keine Wert-Fassung) oder
     * {@code freigegeben} (aus: {@code wertFassung} ist die Fassung, die dieselbe Transaktion schreibt).
     */
    public String anlegen(UUID tenant, UUID bezugsgroesseId, LocalDate periodeVon, LocalDate periodeBis,
            String zeitzone, int ersetztFassung, BigDecimal betrag, String begruendung, String geliefertText,
            String status, Integer wertFassung, ProtokollAkteur wer) {
        String kennung = MessreiheFassungen.naechsteKennung(jdbc, TABELLE, BezugsgroesseRegeln.BERICHTIGUNG_PRAEFIX,
                tenant, ZoneId.of(zeitzone));
        jdbc.update("INSERT INTO bezugsgroesse_berichtigung (tenant_id, kennung, fassung, status, bezugsgroesse_id, "
                + "periode_von, periode_bis, zeitzone, ersetzt_fassung, betrag, begruendung, geliefert_text, "
                + "freigabe_vieraugen, wert_fassung, actor_sub, actor_name, actor_rolle, actor_art) "
                + "VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                tenant, kennung, status, bezugsgroesseId, periodeVon, periodeBis, zeitzone, ersetztFassung, betrag,
                begruendung, geliefertText, BezugsdatenRegeln.VORSCHLAG.equals(status), wertFassung,
                wer.sub(), wer.name(), wer.rolle(), wer.art());
        return kennung;
    }

    /** Die Entscheidung über einen Vorschlag: Fassung n + 1 mit Begründung, Einstellung und der geschriebenen Wert-Fassung. */
    public void entscheiden(UUID tenant, String kennung, int fassung, String status, String grund, boolean vierAugen,
            Integer wertFassung, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO bezugsgroesse_berichtigung (tenant_id, kennung, fassung, status, grund, "
                + "freigabe_vieraugen, wert_fassung, actor_sub, actor_name, actor_rolle, actor_art) "
                + "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                tenant, kennung, fassung, status, grund, vierAugen, wertFassung,
                wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    public Optional<Berichtigung> lies(UUID tenant, String kennung) {
        return jdbc.query("SELECT bezugsgroesse_id, periode_von, periode_bis, zeitzone, ersetzt_fassung, betrag, "
                + "begruendung, geliefert_text FROM bezugsgroesse_berichtigung "
                + "WHERE tenant_id = ? AND kennung = ? AND fassung = 1",
                (rs, n) -> new Berichtigung(kennung, rs.getObject("bezugsgroesse_id", UUID.class),
                        rs.getObject("periode_von", LocalDate.class), rs.getObject("periode_bis", LocalDate.class),
                        rs.getString("zeitzone"), rs.getInt("ersetzt_fassung"), rs.getBigDecimal("betrag"),
                        rs.getString("begruendung"), rs.getString("geliefert_text"),
                        MessreiheFassungen.fassungen(jdbc, TABELLE, tenant, kennung)),
                tenant, kennung).stream().findFirst();
    }

    /** Der offene Vorschlag für den Wert einer Periode, wenn es einen gibt (F3: höchstens einer). */
    public Optional<Berichtigung> offen(UUID tenant, UUID bezugsgroesseId, LocalDate periodeVon) {
        return offene(tenant, bezugsgroesseId).values().stream()
                .filter(v -> v.periodeVon().equals(periodeVon))
                .findFirst();
    }

    /** Die offenen Vorschläge einer Bezugsgröße je erstem Tag ihrer Periode — älteste Kennung zuerst. */
    public Map<LocalDate, Berichtigung> offene(UUID tenant, UUID bezugsgroesseId) {
        Map<LocalDate, Berichtigung> offen = new LinkedHashMap<>();
        List<String> kennungen = jdbc.queryForList("SELECT b.kennung FROM bezugsgroesse_berichtigung b "
                + "WHERE b.tenant_id = ? AND b.bezugsgroesse_id = ? AND b.fassung = 1 AND b.status = 'vorschlag' "
                + "AND NOT EXISTS (SELECT 1 FROM bezugsgroesse_berichtigung d "
                + "WHERE d.tenant_id = b.tenant_id AND d.kennung = b.kennung AND d.fassung > 1) "
                + "ORDER BY b.created_at, b.kennung", String.class, tenant, bezugsgroesseId);
        for (String kennung : kennungen) {
            lies(tenant, kennung).ifPresent(v -> offen.putIfAbsent(v.periodeVon(), v));
        }
        return offen;
    }
}
