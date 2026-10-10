package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.EnergiezielDto;
import com.voltpilot.api.web.dto.MassnahmeDto;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Antwort einer Person auf einen Anstoß am Vorgang (UEMS AP-18 IP-17, M5, Z5, §5.7) — kein Läufer antwortet. Einmalig
 * (Trigger {@code vorgang_anstoss_einmalig}; ein zweites Mal 409 {@code anstoss_beantwortet}), mit der Protokollzeile
 * {@code anstoss_beantwortet} am Vorgang, in EINER Transaktion mit dem, was die Antwort auslöst:
 *
 * <ul>
 *   <li>{@code bleibt} — die Kopie bleibt, mit Begründung (10–500 Zeichen); Recht {@code verbesserung.verwalten}.</li>
 *   <li>{@code neu_kopiert} — nur Maßnahme, nur {@code ausgangslage_korrigiert}: die Ausgangslage neu aus dem Leser
 *       ({@link MassnahmeService#ausgangslageNeu}), neue Prüfsumme; die alte Kopie mit ihrer Prüfsumme steht in der
 *       Protokollzeile ({@code alt}). Recht {@code verbesserung.verwalten}.</li>
 *   <li>{@code neu_bewertet} — Maßnahme: der Stand Nr. n + 1 über {@link MassnahmeBewertung} (mit Vier-Augen als
 *       Antrag); Ziel: die Bewertung über {@link EnergiezielService} (nur am offenen Ziel — eine gestellte
 *       Ziel-Bewertung wird nie zurückgenommen, Z5). Keine zweite Bewertungslogik. Recht
 *       {@code verbesserung.abschliessen}.</li>
 * </ul>
 *
 * <p>Welche Antwort zu welcher Art passt, steht in {@link #PASSEND}; sonst 422 {@code antwort_passt_nicht}. Zaun wie die
 * Vorgänge (IP-10, IP-7): der Vorgang außerhalb der Sicht 404, der Anstoß an einem anderen Vorgang 404, ohne Recht 403.
 */
@Service
public class VorgangAntwort {

    static final String BLEIBT = "bleibt";
    static final String NEU_KOPIERT = "neu_kopiert";
    static final String NEU_BEWERTET = "neu_bewertet";

    /** Je Vorgang und Art die Antworten, die etwas bedeuten (R12 Schritt 3; Z5: eine Ziel-Bewertung bleibt). */
    static final Map<String, Set<String>> PASSEND_MASSNAHME = Map.of(
            VorgangAnstoss.AUSGANGSLAGE_KORRIGIERT, Set.of(BLEIBT, NEU_KOPIERT),
            VorgangAnstoss.BEWERTUNG_KORRIGIERT, Set.of(BLEIBT, NEU_BEWERTET),
            VorgangAnstoss.BEENDET, Set.of(BLEIBT, NEU_BEWERTET),
            VorgangAnstoss.NEU_GEFASST, Set.of(BLEIBT, NEU_BEWERTET));
    static final Map<String, Set<String>> PASSEND_ZIEL = Map.of(
            VorgangAnstoss.BEWERTUNG_KORRIGIERT, Set.of(BLEIBT),
            VorgangAnstoss.BEENDET, Set.of(BLEIBT, NEU_BEWERTET),
            VorgangAnstoss.NEU_GEFASST, Set.of(BLEIBT, NEU_BEWERTET));
    static final Map<String, Map<String, Set<String>>> PASSEND = Map.of("massnahme", PASSEND_MASSNAHME,
            "energieziel", PASSEND_ZIEL);

    /** {@code vorgang_anstoss_antwort_chk}: diese Rollen stehen an der Antwort, sonst keine. */
    private static final Set<String> ROLLEN = Set.of("kundenadministrator", "energiemanager", "bearbeiter",
            "bedienberechtigt", "leser", "unterstuetzer", "voltpilot_betrieb");

    private final MassnahmeService massnahmen;
    private final MassnahmeBewertung bewertung;
    private final EnergiezielService ziele;
    private final KennzahlService kennzahlen;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaktion;

    public VorgangAntwort(MassnahmeService massnahmen, MassnahmeBewertung bewertung, EnergiezielService ziele,
            KennzahlService kennzahlen, JdbcTemplate jdbc, PlatformTransactionManager transactionManager) {
        this.massnahmen = massnahmen;
        this.bewertung = bewertung;
        this.ziele = ziele;
        this.kennzahlen = kennzahlen;
        this.jdbc = jdbc;
        this.transaktion = new TransactionTemplate(transactionManager);
    }

    /** {@code POST /api/v1/massnahmen/{id}/anstoesse/{aid}/antwort}. */
    public MassnahmeDto.Massnahme massnahme(UUID id, UUID aid, MassnahmeDto.AnstossAntwort a, ProtokollAkteur wer) {
        Eingang e = eingang(a == null ? null : a.antwort(), a == null ? null : a.begruendung(),
                a == null ? null : a.ergebnis());
        Map<String, Object> z = massnahmen.zeile(id, recht(e.antwort()), wer);
        String kennzeichen = (String) z.get("kennzeichen");
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        Instant jetzt = kennzahlen.jetzt();
        transaktion.executeWithoutResult(s -> {
            Map<String, Object> an = offen(aid, "massnahme_id", id, "massnahme", e.antwort());
            Map<String, Object> alt = new LinkedHashMap<>();
            Map<String, Object> neu = neu(an, e);
            if (NEU_KOPIERT.equals(e.antwort())) {
                String zustand = jdbc.queryForObject("SELECT zustand FROM massnahme WHERE id = ? FOR UPDATE",
                        String.class, id);
                if ("verworfen".equals(zustand)) {
                    throw new VerbesserungAbgelehnt(409, "massnahme_endgueltig", "Die Maßnahme " + kennzeichen
                            + " ist verworfen; ihre Ausgangslage bleibt.", Map.of("zustand", zustand));
                }
                String[] kopie = massnahmen.ausgangslageNeu(z);
                alt.put("ausgangslage", z.get("ausgangslage"));
                alt.put("ausgangslage_pruefsumme", z.get("ausgangslage_pruefsumme"));
                jdbc.update("UPDATE massnahme SET ausgangslage = ?, ausgangslage_pruefsumme = ? WHERE id = ?", kopie[0],
                        kopie[1], id);
                neu.put("ausgangslage_pruefsumme", kopie[1]);
            } else if (NEU_BEWERTET.equals(e.antwort())) {
                MassnahmeDto.Bewerten b = new MassnahmeDto.Bewerten(e.ergebnis(), e.begruendung());
                if (bewertung.vierAugen(tenant)) {
                    bewertung.beantragen(id, b, wer);
                } else {
                    bewertung.bewerten(id, b, wer);
                }
                Map<String, Object> stand = jdbc.queryForMap("SELECT stand_nr, status, pruefsumme FROM massnahme_bewertung "
                        + "WHERE massnahme_id = ? ORDER BY stand_nr DESC LIMIT 1", id);
                neu.put("stand_nr", stand.get("stand_nr"));
                neu.put("stand_status", stand.get("status"));
                neu.put("stand_pruefsumme", stand.get("pruefsumme"));
            }
            beantworten(aid, e, wer, jetzt);
            alt.put("zustand", "offen");
            massnahmen.protokoll(tenant, id, "anstoss_beantwortet", alt, neu, e.begruendung(), null, wer);
        });
        return massnahmen.eine(id);
    }

    /** {@code POST /api/v1/energieziele/{id}/anstoesse/{aid}/antwort}. */
    public EnergiezielDto.Energieziel energieziel(UUID id, UUID aid, EnergiezielDto.AnstossAntwort a,
            ProtokollAkteur wer) {
        Eingang e = eingang(a == null ? null : a.antwort(), a == null ? null : a.begruendung(),
                a == null ? null : a.ergebnis());
        ziele.fuerAnstoss(id, recht(e.antwort()), wer);
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        Instant jetzt = kennzahlen.jetzt();
        transaktion.executeWithoutResult(s -> {
            Map<String, Object> an = offen(aid, "energieziel_id", id, "energieziel", e.antwort());
            Map<String, Object> neu = neu(an, e);
            if (NEU_BEWERTET.equals(e.antwort())) {
                EnergiezielDto.Bewerten b = new EnergiezielDto.Bewerten(e.ergebnis(), e.begruendung());
                if (ziele.vierAugen(tenant)) {
                    ziele.beantragen(id, b, wer);
                } else {
                    ziele.bewerten(id, b, wer);
                }
                Map<String, Object> st = jdbc.queryForMap("SELECT bewertung_status, bewertung_pruefsumme FROM energieziel "
                        + "WHERE id = ?", id);
                neu.put("bewertung_status", st.get("bewertung_status"));
                neu.put("pruefsumme", st.get("bewertung_pruefsumme"));
            }
            beantworten(aid, e, wer, jetzt);
            ziele.protokoll(tenant, id, "anstoss_beantwortet", Map.of("zustand", "offen"), neu, e.begruendung(), wer);
        });
        return ziele.eines(id);
    }

    // ================================================================================ Gemeinsam

    private record Eingang(String antwort, String begruendung, String ergebnis) {}

    /** Antwort aus dem Vokabular (400), Begründung bei {@code bleibt} Pflicht, sonst wahlfrei — immer 10–500 (422). */
    private static Eingang eingang(String antwort, String begruendung, String ergebnis) {
        if (antwort == null || !VerbesserungRegeln.VOKABULARE.get("anstoss_antwort").contains(antwort)) {
            throw VerbesserungAbgelehnt.anfrage("antwort");
        }
        String b = begruendung == null || begruendung.isBlank() ? null : begruendung.strip();
        if ((b == null && BLEIBT.equals(antwort)) || (b != null && (b.length() < 10 || b.length() > 500))) {
            throw VerbesserungAbgelehnt.fachlich("begruendung_fehlt", "Bitte begründen Sie mit 10 bis 500 Zeichen.",
                    Map.of("min", 10, "max", 500));
        }
        return new Eingang(antwort, b, NEU_BEWERTET.equals(antwort) ? ergebnis : null);
    }

    private static String recht(String antwort) {
        return NEU_BEWERTET.equals(antwort) ? MassnahmeBewertung.ABSCHLIESSEN : MassnahmeService.VERWALTEN;
    }

    /**
     * Der Anstoß am Vorgang unter Sperre (App-Rolle, RLS): an einem anderen Vorgang 404, die Antwort passt nicht zur Art
     * 422, schon beantwortet 409.
     */
    private Map<String, Object> offen(UUID aid, String spalte, UUID vorgang, String objekt, String antwort) {
        Map<String, Object> an = jdbc.queryForList("SELECT id, art, anlass_kennung, zustand, antwort FROM vorgang_anstoss "
                + "WHERE id = ? AND " + spalte + " = ? FOR UPDATE", aid, vorgang).stream().findFirst()
                .orElseThrow(() -> new VerbesserungAbgelehnt(404, "nicht_gefunden", "Diesen Anstoß gibt es an diesem "
                        + "Vorgang nicht.", null));
        String art = (String) an.get("art");
        if (!"offen".equals(an.get("zustand"))) {
            throw new VerbesserungAbgelehnt(409, "anstoss_beantwortet", "Dieser Anstoß ist schon beantwortet ("
                    + an.get("antwort") + "); die Antwort ist einmalig.", Map.of("antwort", an.get("antwort")));
        }
        Set<String> passend = PASSEND.get(objekt).getOrDefault(art, Set.of());
        if (!passend.contains(antwort)) {
            throw VerbesserungAbgelehnt.fachlich("antwort_passt_nicht", "Auf „" + art + "“ passt die Antwort „" + antwort
                    + "“ nicht.", Map.of("art", art, "antworten", List.copyOf(new java.util.TreeSet<>(passend))));
        }
        return an;
    }

    private static Map<String, Object> neu(Map<String, Object> an, Eingang e) {
        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("anstoss_id", an.get("id").toString());
        neu.put("art", an.get("art"));
        neu.put("anlass_kennung", an.get("anlass_kennung"));
        neu.put("zustand", "beantwortet");
        neu.put("antwort", e.antwort());
        return neu;
    }

    private void beantworten(UUID aid, Eingang e, ProtokollAkteur wer, Instant jetzt) {
        jdbc.update("UPDATE vorgang_anstoss SET zustand = 'beantwortet', antwort = ?, antwort_begruendung = ?, "
                + "beantwortet_am = ?, beantwortet_sub = ?, beantwortet_name = ?, beantwortet_rolle = ?, "
                + "beantwortet_art = ? WHERE id = ?", e.antwort(), e.begruendung(), Timestamp.from(jetzt), wer.sub(),
                wer.name(), ROLLEN.contains(wer.rolle()) ? wer.rolle() : null, wer.art(), aid);
    }
}
