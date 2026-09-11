package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Die Anlage und ihr Standort an den Stellen, an denen die ANLAGE selbst entsteht oder endet
 * (UEMS AP-02 IP-9): die EINE Stelle, die eine Anlage einem Standort zuordnet und es
 * protokolliert — für die Bestandsübernahme ({@link BestandsuebernahmeService}) und das
 * Anlegen ({@code POST /api/v1/sites}) —, und der Grabstein beim Löschen (W5).
 *
 * <h2>Anlegen (§6.3: „Neue Anlagen fragen nach dem Standort, vorbelegt bei genau einem")</h2>
 *
 * {@link #zielBeimAnlegen} urteilt VOR dem Anlegen, ohne zu schreiben: eine genannte
 * {@code standortId} muss ein Standort des Kundenbereichs sein (sonst 400 wie jede unbekannte
 * ID im Rumpf der Ortsstruktur) und darf nicht archiviert sein (409 {@code ziel_archiviert});
 * ohne {@code standortId} wird der EINE nicht archivierte Standort vorbelegt, ohne Standort
 * bleibt die Anlage wie heute „noch nicht zugeordnet" (sie kommt später über die
 * Bestandsübernahme bzw. die Vorschau), und bei MEHREREN ist die Wahl Pflicht (422
 * {@code standort_waehlen} mit der Liste). {@link #beimAnlegen} ordnet dann in DERSELBEN
 * Transaktion wie die Anlage zu — ab dem Tag ihres {@code created_at} in der Zeitzone des
 * Standorts (E9), also heute, nicht rückwirkend.
 *
 * <h2>Löschen (W5: „die Zuordnung bleibt als beendetes Intervall mit Protokolleintrag
 * stehen")</h2>
 *
 * {@link #beimLoeschen} läuft VOR dem Löschen der Anlage, in derselben Transaktion: jede
 * Zuordnung, die heute gilt oder später gälte, endet heute (ein Intervall, das erst später
 * begänne, wird aufgehoben), und je Intervall steht „geloescht" im Protokoll. Die Zeile
 * überlebt die Anlage (V20260911290000: der Fremdschlüssel auf {@code site} ist gefallen).
 * Das Löschen selbst — 409 bei Geräten, danach Kaskade — ändert sich nicht.
 *
 * <p>Der Mandant ist die RLS: ein fremder Standort ist nicht da.
 */
@Service
public class AnlageStandortService {

    /** {@code objekt_art} der Einträge dieses Dienstes. */
    static final String OBJEKT = "anlage";
    /** „Anlage zugeordnet" (V20260911100000: verschoben, auch „Anlage zugeordnet"). */
    static final String ZUGEORDNET = "verschoben";
    /** „Anlage entfernt am …" (W5). */
    static final String ENTFERNT = "geloescht";

    private final JdbcTemplate jdbc;
    private final StandortRepository standorte;
    private final AnlageStandortRepository zuordnungen;
    private final OrtProtokoll protokoll;
    private volatile Clock uhr = Clock.systemUTC();

    public AnlageStandortService(JdbcTemplate jdbc, StandortRepository standorte,
            AnlageStandortRepository zuordnungen, OrtProtokoll protokoll) {
        this.jdbc = jdbc;
        this.standorte = standorte;
        this.zuordnungen = zuordnungen;
        this.protokoll = protokoll;
    }

    /** Nur für Tests: die Uhr, an der „heute" hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ---------------------------------------------------------------- Anlegen

    /**
     * Welchem Standort eine NEUE Anlage zugeordnet wird — leer: keinem (der Kundenbereich hat
     * keinen). Schreibt nichts; eine Ablehnung fliegt, bevor die Anlage entsteht.
     */
    public Optional<StandortRepository.Standort> zielBeimAnlegen(UUID standortId) {
        if (standortId != null) {
            StandortRepository.Standort s = standorte.finde(standortId).orElseThrow(() ->
                    OrtAbgelehnt.anfrage("standortId", "Diesen Standort gibt es nicht."));
            if (s.archiviertAm() != null) {
                LocalDate heute = uhr.instant().atZone(ZoneId.of(s.zeitzone())).toLocalDate();
                throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.ZIEL_ARCHIVIERT,
                        "Am " + OrtsbaumAbleitung.datumText(heute) + " war " + s.name() + " archiviert.",
                        Map.of("feld", "standortId"));
            }
            return Optional.of(s);
        }
        List<StandortRepository.Standort> offen = standorte.alle().stream()
                .filter(s -> s.archiviertAm() == null).toList();
        if (offen.size() > 1) {
            List<Map<String, Object>> liste = new ArrayList<>();
            for (StandortRepository.Standort s : offen) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", s.id());
                m.put("kurzzeichen", s.kurzzeichen());
                m.put("name", s.name());
                liste.add(m);
            }
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("feld", "standortId");
            fakten.put("standorte", liste);
            throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.STANDORT_WAEHLEN, "Ihr Unternehmen hat "
                    + offen.size() + " Standorte. Bitte wählen Sie, zu welchem Standort die neue Anlage "
                    + "gehört.", fakten);
        }
        return offen.stream().findFirst();
    }

    /**
     * Ordnet die eben angelegte Anlage ihrem Standort zu — in der Transaktion des Anlegens,
     * ab dem Tag ihres {@code created_at} in der Zeitzone des Standorts.
     */
    public void beimAnlegen(UUID siteId, StandortRepository.Standort ziel, ProtokollAkteur wer) {
        record Zeile(String name, OffsetDateTime angelegtUm) {}
        Zeile anlage = jdbc.queryForObject("SELECT name, created_at FROM site WHERE id = ?",
                (rs, n) -> new Zeile(rs.getString("name"), rs.getObject("created_at", OffsetDateTime.class)),
                siteId);
        LocalDate ab = BestandsuebernahmeAbleitung.tag(anlage.angelegtUm(), ZoneId.of(ziel.zeitzone()));
        zuordnen(kundenbereich(), siteId, anlage.name(), ziel, ab, uhr.instant(), wer);
    }

    /**
     * Die EINE Zuordnung „Anlage → Standort ab Tag" samt ihrem Protokolleintrag — die
     * Bestandsübernahme und das Anlegen schreiben hierüber, in der Transaktion des Aufrufers.
     */
    UUID zuordnen(UUID tenant, UUID siteId, String anlagenName, StandortRepository.Standort ziel,
            LocalDate ab, Instant jetzt, ProtokollAkteur wer) {
        UUID id = zuordnungen.zuordnen(tenant, siteId, ziel.id(), ab, null, wer.sub());
        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("anlage_name", anlagenName);
        neu.put("standort_id", ziel.id());
        neu.put("standort_kurzzeichen", ziel.kurzzeichen());
        neu.put("standort_name", ziel.name());
        protokoll.eintragen(tenant, OBJEKT, siteId, ZUGEORDNET, null, neu, ab, ZoneId.of(ziel.zeitzone()),
                jetzt, wer);
        return id;
    }

    // ---------------------------------------------------------------- Löschen

    /**
     * Der Grabstein (W5): jede Zuordnung der Anlage, die heute gilt oder später gälte, endet
     * heute in der Zeitzone ihres Standorts — eine, die erst später begänne, wird aufgehoben —,
     * und je Intervall ein Eintrag „geloescht". Eine schon beendete bleibt, wie sie ist.
     *
     * @param wer der Urheber — erst gefragt, wenn es etwas zu beenden gibt
     * @return wie viele Intervalle endeten oder aufgehoben wurden
     */
    public int beimLoeschen(UUID siteId, Supplier<ProtokollAkteur> wer) {
        UUID tenant = kundenbereich();
        Instant jetzt = uhr.instant();
        String anlagenName = null;
        int n = 0;
        for (AnlageStandortRepository.Zuordnung iv : zuordnungen.fuerAnlage(siteId)) {
            if (iv.aufgehoben()) {
                continue;
            }
            StandortRepository.Standort st = standorte.finde(iv.standortId()).orElse(null);
            ZoneId zone = st == null ? OrtsbaumAbleitung.VORGABE_ZEITZONE : ZoneId.of(st.zeitzone());
            LocalDate heute = jetzt.atZone(zone).toLocalDate();
            if (iv.gueltigBis() != null && iv.gueltigBis().isBefore(heute)) {
                continue;
            }
            if (anlagenName == null) {
                anlagenName = jdbc.queryForObject("SELECT name FROM site WHERE id = ?", String.class, siteId);
            }
            Map<String, Object> alt = new LinkedHashMap<>();
            alt.put("anlage_name", anlagenName);
            alt.put("standort_id", iv.standortId());
            alt.put("standort_kurzzeichen", st == null ? null : st.kurzzeichen());
            alt.put("standort_name", st == null ? null : st.name());
            alt.put("gueltig_ab", iv.gueltigAb().toString());
            alt.put("gueltig_bis", iv.gueltigBis() == null ? null : iv.gueltigBis().toString());
            Map<String, Object> neu = new LinkedHashMap<>();
            if (iv.gueltigAb().isAfter(heute)) {
                zuordnungen.aufheben(iv.id(), jetzt);
                neu.put("aufgehoben", true);
            } else {
                zuordnungen.beenden(iv.id(), heute);
                neu.put("gueltig_bis", heute.toString());
            }
            protokoll.eintragen(tenant, OBJEKT, siteId, ENTFERNT, alt, neu, heute, zone, jetzt, wer.get());
            n++;
        }
        return n;
    }

    private static UUID kundenbereich() {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw OrtAbgelehnt.nichtGefunden("Kein Kundenbereich gewählt.");
        }
        return tenant;
    }
}
