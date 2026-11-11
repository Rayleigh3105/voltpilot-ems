package com.voltpilot.api.erzeuger;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.erzeuger.VorgabenAbleitung.Kontext;
import com.voltpilot.api.erzeuger.VorgabenAbleitung.Zustand;
import com.voltpilot.api.erzeuger.VorgabenLaufRepository.Stand;
import com.voltpilot.api.erzeuger.VorgabenLaufRepository.Steuerung;
import com.voltpilot.api.erzeuger.VorgabenVerlauf.Probe;
import com.voltpilot.api.forecast.ForecastModelService;
import com.voltpilot.api.forecast.ForecastModels;
import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.optimizer.OptimizerDiagnosticsService;
import com.voltpilot.api.optimizer.SlotEconomics;
import com.voltpilot.api.repo.HistoryRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.AnteilVerlustRepository;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Der Takt der Vorgaben (UEMS EZ-7, Konzept vp-erzeuger-wago-konzept §4.6): je Kundenbereich unter
 * {@link TenantContext} mit der Laufzeitrolle — wie {@code SteuerungVorsprungLaeufer}; nur die Liste der
 * Kundenbereiche kommt über die Admin-Rolle. Je Anlagensteuerung liest er die Werte seit seinem Stand
 * ({@code erzeuger_vorgabe_lauf}), leitet mit {@link VorgabenAbleitung} die Vorgaben ab und schreibt sie, die Lücken
 * und den neuen Stand in EINER Transaktion: ein Neustart der api setzt genau dort fort, nichts doppelt.
 *
 * <p><b>Nachlauf.</b> Ohne Stand beginnt er bei der Einrichtung (Beginn der Bindung der Komponente) und arbeitet die
 * gespeicherten Werte in Spannen von {@link #SPANNE} ab, höchstens {@value #SPANNEN_JE_TAKT} je Takt und Steuerung.
 *
 * <p><b>Bis wohin.</b> Höchstens bis {@code jetzt − }{@link #VERZUG} (die Box liefert „seit“ und Zähler im 60-s-Takt
 * nach) und nie über die jüngste Probe hinaus: ist die Box still, wartet der Stand, und was sie nachliefert, kommt in
 * Zeitfolge noch an. Eine Probe, die erst nach einem Lauf über ihre Zeit kommt, bleibt als Lücke stehen.
 *
 * <p>Sperre je Steuerung über {@code pg_try_advisory_xact_lock}: mehrere api-Instanzen leiten nie dieselbe
 * gleichzeitig ab. Schalter {@code voltpilot.erzeuger.vorgaben.enabled} — Vorgabe AN (Hausregel), im Testlauf AUS
 * (surefire, {@code services/api/pom.xml}).
 */
@Component
@ConditionalOnProperty(name = "voltpilot.erzeuger.vorgaben.enabled", havingValue = "true", matchIfMissing = true)
public class VorgabenLaeufer {

    private static final Logger log = LoggerFactory.getLogger(VorgabenLaeufer.class);

    /** Die Fassung der Ableitung; sie steht am Stand, damit eine spätere Fassung weiß, wer was abgeleitet hat. */
    static final int FASSUNG = 1;
    /** So weit hinter der Uhr bleibt der Läufer: „seit“ und Zähler kommen bis zu 65 s nach dem Wechsel. */
    static final Duration VERZUG = Duration.ofSeconds(120);
    static final Duration SPANNE = Duration.ofHours(6);
    static final int SPANNEN_JE_TAKT = 8;

    private final JdbcTemplate adminJdbc;
    private final VorgabenLaufRepository repo;
    private final TransactionTemplate tx;
    private final ObjectMapper json;
    private final ForecastModelService modelle;
    private final AnteilVerlustRepository prognosen;
    private final OptimizerDiagnosticsService preise;
    private final HistoryRepository boerse;

    /** Beendete Kundenbereiche lässt der Läufer aus; ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public VorgabenLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc, VorgabenLaufRepository repo,
            PlatformTransactionManager transaktionen, ObjectMapper json, ForecastModelService modelle,
            AnteilVerlustRepository prognosen, OptimizerDiagnosticsService preise, HistoryRepository boerse) {
        this.adminJdbc = adminJdbc;
        this.repo = repo;
        this.tx = new TransactionTemplate(transaktionen);
        this.json = json;
        this.modelle = modelle;
        this.prognosen = prognosen;
        this.preise = preise;
        this.boerse = boerse;
    }

    @Scheduled(fixedDelayString = "${voltpilot.erzeuger.vorgaben.interval-ms:60000}",
            initialDelayString = "${voltpilot.erzeuger.vorgaben.initial-delay-ms:120000}")
    public void takt() {
        try {
            lauf(Instant.now());
        } catch (RuntimeException e) {
            log.warn("Vorgaben: Takt übersprungen: {}", e.toString());
        }
    }

    /** Ein Takt über alle Kundenbereiche. Wirft nie je Steuerung; Rückgabe = geschriebene Vorgaben. */
    public int lauf(Instant jetzt) {
        List<UUID> kundenbereiche =
                adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        int geschrieben = 0;
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) {
                continue;
            }
            try {
                TenantContext.set(tenant);
                for (Steuerung s : repo.steuerungen()) {
                    try {
                        geschrieben += steuerung(tenant, s, jetzt);
                    } catch (RuntimeException e) {
                        log.error("Vorgaben: Steuerung {} im Kundenbereich {} gescheitert, Stand unverändert: {}",
                                s.geraetId(), tenant, e.toString(), e);
                    }
                }
            } catch (RuntimeException e) {
                log.error("Vorgaben: Kundenbereich {} gescheitert: {}", tenant, e.toString(), e);
            } finally {
                TenantContext.clear();
            }
        }
        return geschrieben;
    }

    /** Eine Steuerung bis {@code jetzt − VERZUG} ableiten, Spanne für Spanne. */
    int steuerung(UUID tenant, Steuerung s, Instant jetzt) {
        int geschrieben = 0;
        for (int i = 0; i < SPANNEN_JE_TAKT; i++) {
            Integer n = tx.execute(status -> spanne(tenant, s, jetzt));
            if (n == null || n < 0) {
                break;
            }
            geschrieben += n;
        }
        return geschrieben;
    }

    /** Eine Spanne in einer Transaktion; -1 = nichts (mehr) zu tun. */
    private int spanne(UUID tenant, Steuerung s, Instant jetzt) {
        if (!repo.sperre(s.geraetId())) {
            return -1;
        }
        Optional<Stand> stand = repo.stand(s.geraetId());
        Instant ab = stand.map(Stand::verarbeitetBis).orElse(s.eingerichtet().minusSeconds(1));
        List<String> punkte = VorgabenAbleitung.punkte(s.teAnzahl());
        Optional<Instant> juengste = repo.juengsteProbe(tenant, s.entityId(), punkte, ab);
        if (juengste.isEmpty()) {
            return -1;
        }
        Instant bis = frueher(frueher(jetzt.minus(VERZUG), juengste.get()), ab.plus(SPANNE));
        if (!bis.isAfter(ab)) {
            return -1;
        }
        Zustand zustand = stand.map(x -> lies(x.zustand())).orElseGet(Zustand::new);
        List<Probe> proben = repo.proben(tenant, s.entityId(), punkte, ab,
                bis.plusSeconds(VorgabenAbleitung.NACHSCHAU_S));
        Kontext kontext = new Kontext(s.anlagenart(), s.teAnzahl(), s.nennKw(), prognose(s, ab, bis),
                preis(s, ab, bis));
        VorgabenAbleitung ableitung = new VorgabenAbleitung(kontext, zustand);
        VorgabenVerlauf.lesungen(zustand.getragen, proben, ab, bis, repo.datenluecken(tenant, s.entityId(), ab, bis),
                repo.neustarts(s.entityId(), s.dataSourceId(), ab, bis)).forEach(ableitung::lesung);
        repo.speichere(tenant, s, ableitung.geaendert(), ableitung.luecken(), bis, FASSUNG, ableitung.zustand());
        return ableitung.geaendert().size();
    }

    /** PV: die vorhandene Prognose der Anlage (aktives Modell) je Viertelstunde; sonst keine. */
    private VorgabenAbleitung.Prognose prognose(Steuerung s, Instant ab, Instant bis) {
        if (!"pv".equals(s.anlagenart())) {
            return null;
        }
        String modell = modelle.activeModels(s.siteId()).get(ForecastModels.KIND_PV);
        if (modell == null) {
            return null;
        }
        Map<Instant, Double> kw = prognosen.pvPrognose(s.siteId(), modell, viertel(ab), bis.plus(VIERTEL));
        if (kw.isEmpty()) {
            // Ohne Prognose keine Grundlage: die Vorgaben dieser Spanne bekommen keine Methode (Prognosen hält die
            // Anlage 30 Tage — ein Nachlauf über ältere Werte schätzt nichts).
            return null;
        }
        return t -> {
            Double wert = kw.get(viertel(t));
            return wert == null ? null : BigDecimal.valueOf(wert * 1000.0);
        };
    }

    /**
     * Die Euro-Schätzung zu den Preisen der Anlage (EW-8 A): dieselbe Rechnung wie die Erlösanzeige
     * ({@link SlotEconomics#exportValueCtKwh}) je Viertelstunde. Nur für PV — für Biogas fehlen Marktwert und
     * Vermarktungsentgelt bis EZ-12 (die heutige Rechnung nähme den Solar-Marktwert).
     */
    private VorgabenAbleitung.Preis preis(Steuerung s, Instant ab, Instant bis) {
        if (!"pv".equals(s.anlagenart()) || s.biddingZone() == null) {
            return null;
        }
        SlotEconomics economics = preise.economicsFor(s.siteId(), ab, bis);
        if (economics == null) {
            return null;
        }
        Map<Instant, BigDecimal> spot = new HashMap<>();
        boerse.priceSlots(s.biddingZone(), viertel(ab), bis.plus(VIERTEL))
                .forEach(p -> spot.put(p.slot(), p.value()));
        return t -> {
            Instant slot = viertel(t);
            BigDecimal eurMwh = spot.get(slot);
            return economics.exportValueCtKwh(eurMwh == null ? null : eurMwh.doubleValue(), slot);
        };
    }

    private static final Duration VIERTEL = Duration.ofMinutes(15);

    private static Instant viertel(Instant t) {
        long s = t.truncatedTo(ChronoUnit.MINUTES).getEpochSecond();
        return Instant.ofEpochSecond(s - Math.floorMod(s, 900));
    }

    private static Instant frueher(Instant a, Instant b) {
        return a.isBefore(b) ? a : b;
    }

    private Zustand lies(String text) {
        try {
            return json.readValue(text, Zustand.class);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Stand der Vorgaben nicht lesbar", e);
        }
    }
}
