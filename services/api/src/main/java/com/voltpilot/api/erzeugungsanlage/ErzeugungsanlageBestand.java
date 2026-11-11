package com.voltpilot.api.erzeugungsanlage;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.erzeugungsanlage.ErzeugungsanlageRepository.Bestand;
import com.voltpilot.api.erzeugungsanlage.ErzeugungsanlageRepository.Ea;
import com.voltpilot.api.erzeugungsanlage.ErzeugungsanlageRepository.Fassung;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * EA 1 folgt der Anlage (Messkonzepte S1, Einfachheit für Anlagen mit einer EA). Nach jeder Änderung an PV-Summe,
 * MaStR-Übernahme oder eigenem Satz der Anlage ({@code AssetRepository.applyPv/savePv/addPvCapacity},
 * {@code EinspeiseverguetungRepository.setAngegeben}) zieht diese Klasse nach:
 *
 * <ul>
 *   <li>Hat die Anlage noch nie eine EA getragen und trägt ihr PV-Aggregat etwas, entsteht EA 1, die der Anlage folgt -
 *       so erzeugt der bisherige Weg SEE-Nummer → Nachschlagen → Übernehmen EA 1.</li>
 *   <li>Ist die einzige EA eine, die der Anlage folgt, übernimmt sie Inbetriebnahme, MaStR-Einheit und die Antwort zu
 *       § 51a; eine geänderte Leistung oder ein geänderter eigener Satz wird eine neue Fassung ab heute (am Tag ihres
 *       Eintrags ersetzt sie die Fassung, nie überschrieben).</li>
 *   <li>Sonst (mehrere EA, oder die EA folgt nicht) geschieht nichts: dann pflegt ein Mensch die EA.</li>
 * </ul>
 *
 * <p>NIE ein Fehler für den Aufrufer: der Nachzug läuft in einem eigenen Savepoint; scheitert er, bleibt die Änderung
 * an der Anlage, wie sie war, und das Protokoll der Anwendung nennt die Anlage. Fahrplan, Erlöse und Box lesen die EA
 * nicht.
 */
@Component
public class ErzeugungsanlageBestand {

    static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    static final ProtokollAkteur ANLAGE = new ProtokollAkteur(null, "Angaben der Anlage", "voltpilot_betrieb",
            "voltpilot");
    private static final Pattern SEE = Pattern.compile("^SEE[0-9]{12}$");
    private static final Logger log = LoggerFactory.getLogger(ErzeugungsanlageBestand.class);

    private final ErzeugungsanlageRepository repo;
    private final ObjectMapper json;
    private final TransactionTemplate savepoint;
    private volatile Clock uhr = Clock.systemUTC();

    public ErzeugungsanlageBestand(ErzeugungsanlageRepository repo, ObjectMapper json,
            PlatformTransactionManager transactionManager) {
        this.repo = repo;
        this.json = json;
        this.savepoint = new TransactionTemplate(transactionManager);
        this.savepoint.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);
    }

    /** Nur für Tests: die Uhr, an der „heute“ hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** Nach einer Änderung an den PV-Angaben oder am eigenen Satz der Anlage. Wirft nie. */
    public void nachziehen(UUID siteId) {
        try {
            savepoint.executeWithoutResult(tx -> nachziehenJetzt(siteId));
        } catch (RuntimeException e) {
            log.warn("Erzeugungsanlage der Anlage {} nicht nachgezogen: {}", siteId, e.toString());
        }
    }

    private void nachziehenJetzt(UUID siteId) {
        Bestand b = repo.bestand(siteId);
        if (b == null) {
            return;
        }
        repo.sperren(siteId);
        List<Ea> eas = repo.aktive(siteId);
        ProtokollAkteur wer = ProtokollAkteur.aus(SecurityContextHolder.getContext().getAuthentication())
                .orElse(ANLAGE);
        Instant jetzt = uhr.instant();
        LocalDate heute = LocalDate.ofInstant(jetzt, BERLIN);
        Werte w = Werte.aus(b);
        if (eas.isEmpty()) {
            if (repo.jeEine(siteId) || !w.traegtEtwas(b)) {
                return;
            }
            UUID id = repo.anlegen(b.tenantId(), siteId, repo.naechsteNummer(siteId), null, "pv", w.inbetriebnahme,
                    w.abSolarspitzengesetz, w.registry, w.registryUnitId, w.registryFetchedAt, true, kurz(wer));
            repo.fassungEintragen(b.tenantId(), id, null, w.kwp, null, w.satz, "bestand", kurz(wer));
            Map<String, Object> neu = identitaet(w);
            neu.put("nummer", 1);
            neu.put("folgt_anlage", true);
            neu.putAll(fassung(null, w.kwp, null, w.satz));
            repo.protokoll(b.tenantId(), siteId, id, "angelegt", null, text(neu), wer);
            return;
        }
        if (eas.size() != 1 || !eas.get(0).folgtAnlage()) {
            return;
        }
        Ea ea = eas.get(0);
        if (!Objects.equals(ea.inbetriebnahme(), w.inbetriebnahme)
                || !Objects.equals(ea.abSolarspitzengesetz(), w.abSolarspitzengesetz)
                || !Objects.equals(ea.registry(), w.registry)
                || !Objects.equals(ea.registryUnitId(), w.registryUnitId)
                || !Objects.equals(ea.registryFetchedAt(), w.registryFetchedAt)) {
            repo.identitaet(ea.id(), ea.name(), ea.art(), w.inbetriebnahme, w.abSolarspitzengesetz, w.registry,
                    w.registryUnitId, w.registryFetchedAt, jetzt);
            Map<String, Object> alt = new LinkedHashMap<>();
            alt.put("inbetriebnahme", tag(ea.inbetriebnahme()));
            alt.put("inbetriebnahme_ab_solarspitzengesetz", ea.abSolarspitzengesetz());
            alt.put("registry_unit_id", ea.registryUnitId());
            repo.protokoll(b.tenantId(), siteId, ea.id(), "bestand", text(alt), text(identitaet(w)), wer);
        }
        List<Fassung> fassungen = repo.fassungen(List.of(ea.id()));
        Fassung gilt = ErzeugungsanlageService.fassungAm(fassungen, heute);
        if (gilt != null && gleich(gilt.leistungKwp(), w.kwp) && gleich(gilt.satzAngegebenCtKwh(), w.satz)) {
            return;
        }
        LocalDate ab = heute;
        if (gilt == null) {
            ab = null;
        } else if (heute.equals(gilt.gueltigAb())
                || heute.equals(LocalDate.ofInstant(gilt.eingetragenAm(), BERLIN))) {
            // Am Tag ihres Eintrags wird die Fassung ersetzt - ein Einrichten in mehreren Schritten hinterlässt keine
            // Fassung je Schritt.
            ab = gilt.gueltigAb();
            repo.fassungAufheben(gilt.id(), jetzt);
        }
        String einspeiseart = gilt == null ? null : gilt.einspeiseart();
        repo.fassungEintragen(b.tenantId(), ea.id(), ab, w.kwp, einspeiseart, w.satz, "bestand", kurz(wer));
        repo.protokoll(b.tenantId(), siteId, ea.id(), "bestand",
                gilt == null ? null : text(fassung(gilt.gueltigAb(), gilt.leistungKwp(), gilt.einspeiseart(),
                        gilt.satzAngegebenCtKwh())),
                text(fassung(ab, w.kwp, einspeiseart, w.satz)), wer);
    }

    /** Die Angaben der Anlage in der Form der EA: leere oder ungültige Werte werden null, nie 0. */
    record Werte(BigDecimal kwp, LocalDate inbetriebnahme, Boolean abSolarspitzengesetz, String registry,
            String registryUnitId, Instant registryFetchedAt, BigDecimal satz) {

        static Werte aus(Bestand b) {
            BigDecimal kwp = b.kwp() != null && b.kwp().signum() > 0 ? b.kwp() : null;
            boolean mastr = "mastr".equals(b.registry()) && b.registryUnitId() != null
                    && SEE.matcher(b.registryUnitId()).matches();
            BigDecimal satz = b.satzCtKwh() != null && b.satzCtKwh().signum() >= 0
                    && b.satzCtKwh().compareTo(BigDecimal.valueOf(100)) <= 0 ? b.satzCtKwh() : null;
            return new Werte(kwp, b.inbetriebnahme(),
                    b.inbetriebnahme() == null ? b.abSolarspitzengesetz() : null,
                    mastr ? "mastr" : null, mastr ? b.registryUnitId() : null,
                    mastr ? b.registryFetchedAt() : null, satz);
        }

        boolean traegtEtwas(Bestand b) {
            return b.hatPvAggregat() && (kwp != null || inbetriebnahme != null || registryUnitId != null);
        }
    }

    // ------------------------------------------------------------------------------------------ Gerüst

    static String kurz(ProtokollAkteur wer) {
        return wer.sub() != null ? wer.sub() : wer.name();
    }

    static boolean gleich(BigDecimal a, BigDecimal b) {
        return a == null ? b == null : b != null && a.compareTo(b) == 0;
    }

    private static Map<String, Object> identitaet(Werte w) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("inbetriebnahme", tag(w.inbetriebnahme));
        m.put("inbetriebnahme_ab_solarspitzengesetz", w.abSolarspitzengesetz);
        m.put("registry_unit_id", w.registryUnitId);
        return m;
    }

    static Map<String, Object> fassung(LocalDate ab, BigDecimal kwp, String einspeiseart, BigDecimal satz) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("gueltig_ab", tag(ab));
        m.put("leistung_kwp", kwp);
        m.put("einspeiseart", einspeiseart);
        m.put("satz_angegeben_ct_kwh", satz);
        return m;
    }

    private static String tag(LocalDate d) {
        return d == null ? null : d.toString();
    }

    private String text(Map<String, Object> m) {
        try {
            return json.writeValueAsString(m);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
