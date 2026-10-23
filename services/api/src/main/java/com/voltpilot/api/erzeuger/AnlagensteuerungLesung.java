package com.voltpilot.api.erzeuger;

import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Lesung;
import com.voltpilot.api.web.dto.SiteSourceDto;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * UEMS EZ-22: ob eine Anlagensteuerung Daten liefert — aus genau den Werten, die sie liefert: der jüngsten Lesung
 * ihres Erzeuger-Bilds ({@code device_measurement_sample}, die festen Abschnitte {@code erzeuger.kopf|a|nb|dv|wirkung},
 * ohne Spiegel), mit der Frist der Werte-Fläche ({@link AnlagensteuerungService#AKTUELL_BIS_S}), an der auch der Kopf
 * ihrer Geräteseite urteilt.
 *
 * <p>Vorher entstand der Zustand aus zwei Quellen, die eine Steuerung nie füllt: die Lebendigkeit der Topologie liest
 * {@code telemetry_v2} über die Messkanäle der Komponente, und eine Steuerung hat keine ({@code default_measure: []});
 * der Quellstatus ({@code /sources}) ist der Selbstverdrahtungs-Status der Box, und die liest die Quelle der Rolle
 * {@value AnlagensteuerungQuelle#ROLLE} nie (das tut der Messplan). Beide sagten deshalb „never“, während die Werte
 * ankamen (Gore Pleinfeld, „Wartet auf die ersten Daten“ neben „Liefert Daten“ an der Datenquelle).
 *
 * <p>Nur der Zustand: kein Wert der Steuerung geht dadurch in die Topologie oder die Bilanz.
 */
@Component
public class AnlagensteuerungLesung {

    static final Duration FRIST = Duration.ofSeconds(AnlagensteuerungService.AKTUELL_BIS_S);

    /** Die festen Abschnitte des Bilds — die liest jede Steuerung, gleich wie viele Einheiten sie hat. */
    static final List<String> PUNKTE = ErzeugerRegisterbild.punkte(1).stream()
            .filter(k -> ErzeugerRegisterbild.teNr(k).isEmpty()).toList();

    private final AnlagensteuerungRepository repo;

    public AnlagensteuerungLesung(AnlagensteuerungRepository repo) {
        this.repo = repo;
    }

    /** Die Steuerungs-Komponenten der Anlage mit ihrer jüngsten Lesung, nach Komponente. */
    public Map<UUID, Lesung> fuerAnlage(UUID siteId) {
        Map<UUID, Lesung> out = new HashMap<>();
        for (Lesung l : repo.lesungen(siteId, PUNKTE)) {
            out.put(l.entityId(), l);
        }
        return out;
    }

    /** {@code never} ohne Lesung, {@code ok} innerhalb der Frist, sonst {@code stale} — das Vokabular der Topologie. */
    public static String health(Instant juengst, Instant jetzt) {
        if (juengst == null) {
            return "never";
        }
        return Duration.between(juengst, jetzt).compareTo(FRIST) <= 0 ? "ok" : "stale";
    }

    /**
     * Der Quellstatus der Anlage mit dem Zustand jeder Steuerungs-Quelle aus ihrer Lesung: eine Quelle der Rolle
     * {@value AnlagensteuerungQuelle#ROLLE}, deren Kennung der Pin einer Steuerung ist, trägt {@code health} und
     * {@code readAt} der Steuerung; alles andere bleibt, wie die Box es meldet.
     */
    public List<SiteSourceDto> inQuellen(UUID siteId, List<SiteSourceDto> quellen, Instant jetzt) {
        if (quellen.stream().noneMatch(q -> AnlagensteuerungQuelle.ROLLE.equals(q.role()))) {
            return quellen;
        }
        Map<String, Lesung> jePin = new HashMap<>();
        for (Lesung l : fuerAnlage(siteId).values()) {
            if (l.edgeSourceId() != null) {
                jePin.put(l.edgeSourceId(), l);
            }
        }
        return quellen.stream().map(q -> {
            Lesung l = AnlagensteuerungQuelle.ROLLE.equals(q.role()) ? jePin.get(q.sourceId()) : null;
            return l == null ? q
                    : new SiteSourceDto(q.deviceId(), q.sourceId(), q.kind(), q.role(), q.label(), q.brand(),
                            q.model(), q.pvKw(), q.powerKw(), q.loadKw(), health(l.juengst(), jetzt), l.juengst(),
                            q.reportedAt(), q.bms());
        }).toList();
    }
}
