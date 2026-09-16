package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityRegistryService.PushOutcome;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.UebergabeRepository.Stand;
import com.voltpilot.api.uems.ZustaendigkeitRepository.Zeitraum;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * AP-06 IP-7: EIN Tor für jeden Registry-Push. Plan und Ausführung bleiben getrennt.
 * pending hält den alten Leser; removing entfernt die Quelle aus ALLEN Boxen;
 * erst eine Quittung der tatsächlich versandten Fassung erlaubt receiving.
 * Auch der alte Registry-Herzschlag quittiert (15-s-Kadenz); bloßer Zeitablauf nie.
 * Jede Phase braucht einen eigenen Aufruf, also keine Freigabe im ersten Entzug.
 */
@Service
public class QuellenUebergabe {
    private final UebergabeRepository repo;
    private final MessreiheEreignisRepository ereignisse;
    private final TransactionTemplate tx;
    private final ObjectMapper json;

    public QuellenUebergabe(UebergabeRepository repo, org.springframework.jdbc.core.JdbcTemplate jdbc,
            PlatformTransactionManager manager, ObjectMapper json) {
        this.repo = repo;
        // Ohne Transaktions-Proxy: der Zusatz bleibt in UNSEREM Savepoint, ein SQL-Fehler
        // darf die übergeordnete Registry-Transaktion nicht rollback-only markieren.
        this.ereignisse = new MessreiheEreignisRepository(jdbc);
        this.tx = new TransactionTemplate(manager);
        this.json = json;
    }

    public record Plan(List<Zeitraum> zeitraeume, List<UUID> boxen, String revision) {}

    public PushOutcome zustellen(UUID anlage, Instant jetzt, List<Zeitraum> zeitraeume,
            Function<Plan, PushOutcome> push) {
        return tx.execute(status -> {
            if (!repo.sperren(anlage)) {
                return new PushOutcome(false, false, "uebergabe_belegt", null);
            }
            Map<UUID,List<Zeitraum>> quellen = new LinkedHashMap<>();
            zeitraeume.forEach(z -> quellen.computeIfAbsent(z.dataSourceId(), k -> new ArrayList<>()).add(z));
            List<Zeitraum> wirksam = new ArrayList<>();
            List<Stand> staende = new ArrayList<>();
            Map<UUID,List<UUID>> unsichereLeser = new LinkedHashMap<>();
            List<UUID> boxen = repo.boxen(anlage);
            for (var eintrag : quellen.entrySet()) {
                List<Zeitraum> reihe = eintrag.getValue().stream()
                        .sorted(Comparator.comparing(Zeitraum::effectiveFrom)).toList();
                Zeitraum soll = reihe.stream().filter(z -> !z.effectiveFrom().isAfter(jetzt)
                        && (z.effectiveTo() == null || z.effectiveTo().isAfter(jetzt)))
                        .findFirst().orElse(null);
                if (soll == null) continue;
                Stand s = repo.stand(eintrag.getKey());
                boolean committed = s != null && !repo.inDieserTransaktionGeschrieben(s.quelle());
                if (s == null) {
                    Zeitraum vorher = reihe.stream().filter(z -> z.effectiveFrom().isBefore(soll.effectiveFrom()))
                            .reduce((a,b) -> b).orElse(soll);
                    // Nach einem Cloud-Upgrade kann IP-6 den Wechsel schon zugestellt haben.
                    // Ohne Ausführungsstand keinen alten Leser erneut einschalten: erst ALLE
                    // möglichen bisherigen Leser leeren und quittieren lassen, dann das Soll.
                    boolean unbekannt = !vorher.id().equals(soll.id());
                    s = new Stand(soll.dataSourceId(), anlage, soll.id(), vorher.deviceId(),
                            soll.deviceId(), unbekannt ? "reconciling" : "active",
                            soll.effectiveFrom(), unbekannt ? jetzt : null, null, UUID.randomUUID());
                }
                if ((s.phase().equals("active") || s.phase().equals("pending"))
                        && !s.assignment().equals(soll.id())) {
                    s = new Stand(s.quelle(), anlage, soll.id(), s.leser(), soll.deviceId(),
                            s.leser().equals(soll.deviceId()) ? "active" : "pending",
                            soll.effectiveFrom(), null, null, UUID.randomUUID());
                }
                // Ausgebaut/fremde Anlage: niemals einen Leser erfinden. IP-7-Gate bleibt zu.
                boolean erreichbar = boxen.contains(s.ziel()) && frisch(repo.rueckmeldung(s.ziel()), jetzt);
                if (s.phase().equals("reconciling")) {
                    unsichereLeser.put(s.quelle(), java.util.stream.Stream.concat(
                            reihe.stream().filter(z -> !z.effectiveFrom().isAfter(jetzt)).map(Zeitraum::deviceId),
                            java.util.stream.Stream.of(s.leser(), s.ziel())).distinct()
                            .filter(box -> !repo.nachweislichAusgebaut(box)).toList());
                }
                String entzugsfassung = s.revision();
                switch (s.phase()) {
                    case "pending" -> {
                        if (erreichbar && boxen.contains(s.leser())) {
                            s = phase(s, "removing", jetzt, null);
                        }
                    }
                    case "reconciling" -> {
                        if (committed && erreichbar && unsichereLeser.get(s.quelle()).stream()
                                .allMatch(box -> quittiert(box, entzugsfassung, jetzt))) {
                            s = phase(s, "receiving", s.begonnen(), null);
                        }
                    }
                    case "removing" -> {
                        if (committed && erreichbar && quittiert(s.leser(), s.revision(), jetzt)) {
                            s = phase(s, "receiving", s.begonnen(), null);
                        }
                    }
                    case "receiving" -> {
                        if (committed && quittiert(s.ziel(), s.revision(), jetzt)) {
                            marker(s, jetzt, jetzt, status);
                            s = new Stand(s.quelle(), anlage, s.assignment(), s.ziel(), s.ziel(),
                                    "active", s.faellig(), null, null, s.ereignis());
                        }
                    }
                    default -> { }
                }
                repo.speichern(s);
                staende.add(s);
                UUID leser = switch (s.phase()) {
                    case "removing", "reconciling" -> null;
                    case "receiving" -> s.ziel();
                    default -> s.leser();
                };
                if (leser != null) wirksam.add(new Zeitraum(s.assignment(), s.quelle(), leser,
                        Instant.EPOCH, null));
            }
            List<UUID> bisherigeBoxen = java.util.stream.Stream.concat(staende.stream()
                    .flatMap(s -> java.util.stream.Stream.of(s.leser(), s.ziel())),
                    unsichereLeser.values().stream().flatMap(List::stream)).distinct().toList();
            String versandteRevision = repo.naechsteRevision();
            PushOutcome ausgang = push.apply(new Plan(wirksam, bisherigeBoxen, versandteRevision));
            for (Stand s : staende) {
                List<UUID> adressaten = s.phase().equals("reconciling") ? unsichereLeser.get(s.quelle())
                        : s.phase().equals("removing") ? List.of(s.leser())
                        : s.phase().equals("receiving") ? List.of(s.ziel()) : List.of();
                if (!adressaten.isEmpty() && adressaten.stream().allMatch(adressat -> ausgang.boxen().stream()
                        .anyMatch(b -> b.deviceId().equals(adressat) && b.published()))) {
                    Stand gesendet = phase(s, s.phase(), entzieht(s) && s.revision() == null ? jetzt : s.begonnen(),
                            s.revision() == null ? versandteRevision : s.revision());
                    repo.speichern(gesendet);
                    if (entzieht(s)) marker(gesendet, null, jetzt, status);
                }
            }
            return ausgang;
        });
    }

    private static boolean entzieht(Stand s) {
        return s.phase().equals("removing") || s.phase().equals("reconciling");
    }

    private boolean quittiert(UUID box, String revision, Instant jetzt) {
        var r = repo.rueckmeldung(box);
        if (revision == null || !frisch(r, jetzt) || r.revision() == null) return false;
        // Weitere Pushes derselben Phase bleiben hinter demselben Tor. Ein späterer
        // Herzschlag darf deren neuere Fassung bestätigen, sonst verhungert der Takt.
        long gesendet = revisionsnummer(revision);
        return gesendet > 0 && revisionsnummer(r.revision()) >= gesendet;
    }
    private static long revisionsnummer(String revision) {
        if (!revision.startsWith(UebergabeRepository.REVISION_PREFIX)) return -1;
        try { return Long.parseLong(revision.substring(UebergabeRepository.REVISION_PREFIX.length())); }
        catch (NumberFormatException e) { return -1; }
    }
    private static boolean frisch(UebergabeRepository.Rueckmeldung r, Instant jetzt) {
        return r != null && !r.eingang().isBefore(jetzt.minusSeconds(300)) && !r.eingang().isAfter(jetzt);
    }
    private static Stand phase(Stand s, String phase, Instant begonnen, String revision) {
        return new Stand(s.quelle(), s.anlage(), s.assignment(), s.leser(), s.ziel(), phase,
                s.faellig(), begonnen, revision, s.ereignis());
    }
    private void marker(Stand s, Instant bis, Instant eingang,
            org.springframework.transaction.TransactionStatus status) {
        Object savepoint = status.createSavepoint();
        try {
            ObjectNode e = json.createObjectNode().put("ereignis_id", s.ereignis().toString())
                    .put("art", "handover").put("datenquelle", s.quelle().toString())
                    .put("anlass", "uebergabe").put("box_alt", s.leser().toString())
                    .put("box_neu", s.ziel().toString()).put("von", s.begonnen().truncatedTo(java.time.temporal.ChronoUnit.MINUTES).toString());
            if (bis == null) e.putNull("bis"); else e.put("bis", bis.toString());
            var result = ereignisse.anhaengen(TenantContext.get(), s.anlage(), EreignisVokabular.Urheber.CLOUD,
                    e, null, eingang);
            if (result.ausgang() == MessreiheEreignisRepository.Ausgang.VERWORFEN)
                throw new IllegalStateException("Übergabe-Marker: " + result.grund() + " / " + result.hinweis());
        } catch (RuntimeException e) {
            status.rollbackToSavepoint(savepoint);
            io.micrometer.core.instrument.Metrics.counter("voltpilot_uems_uebergabe_marker",
                    "ergebnis", "fehler").increment();
            org.slf4j.LoggerFactory.getLogger(QuellenUebergabe.class).warn(
                    "Übergabe-Marker für {} nicht gespeichert: {}", s.quelle(), e.toString());
        } finally {
            status.releaseSavepoint(savepoint);
        }
    }
}
