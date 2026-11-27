package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Schaltspur (vp-schalten-3s, Captain 27.11.2026: „mehr als 30 Sekunden - bitte rausfinden, wo die Zeit hingeht“):
 * die Zeitspur EINES Handeingriffs an einem Verbraucher, mit EINER Kennung über jeden Abschnitt.
 *
 * <ol>
 *   <li>API: Anfrage angekommen ({@code api_eingang_at}), Umschlag beim Broker abgegeben ({@code gesendet_at}).</li>
 *   <li>Box ab dem Release mit Schaltspur, in IHRER Uhr: empfangen, entschieden (Schiedsrichter und Schutzregeln),
 *       ans Gerät geschrieben, zurückgelesen, Herzschlag gebaut - der Block {@code consumers.{id}.trace} trägt die
 *       request_id des Umschlags zurück.</li>
 *   <li>API, für JEDE Box: erster Herzschlag nach dem Senden, erster Herzschlag mit gehaltenem Wunsch (Grund der
 *       Schutzregel), erster Herzschlag mit bestätigtem Wunsch ({@link SchaltSpurAbgleich}).</li>
 *   <li>Portal, in der monotonen Uhr des Browsers: Klick bis Antwort, Klick bis bestätigt sichtbar.</li>
 * </ol>
 *
 * <p><b>Er wirft nie in den Ingest.</b> Wie der Kommando-Verlauf ist die Spur eine Anzeige-Wahrheit; sie darf den
 * Herzschlag-Zuhörer, an dem die Rückmeldung des Verbrauchers hängt, unter keinen Umständen versenken.
 *
 * <p>Anlegen und „gesendet“ laufen je in einer EIGENEN, sofort festgeschriebenen Transaktion: der Handeingriff
 * veröffentlicht noch innerhalb seiner Transaktion, und eine schnelle Box kann antworten, bevor sie festgeschrieben
 * ist - der Zuhörer muss die Spur dann schon sehen.
 */
@Component
public class SchaltSpur {

    private static final Logger log = LoggerFactory.getLogger(SchaltSpur.class);

    /** Eine neue Spur: ihre Kennung und die request_id, unter der sie zur Box reist. */
    public record Neu(UUID id, String requestId) {
    }

    private final SchaltSpurRepository store;
    private final TransactionTemplate eigene;

    public SchaltSpur(SchaltSpurRepository store, PlatformTransactionManager transaktionen) {
        this.store = store;
        this.eigene = new TransactionTemplate(transaktionen);
        this.eigene.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    /**
     * Die request_id eines Handeingriffs mit Spur. Der Vertrag (edge-desired.schema.json) kennt die request_id als
     * die eine Korrelation je Aussendung, höchstens 128 Zeichen; jede Box behandelt sie als undurchsichtig.
     */
    public static String requestId(UUID entityId, UUID spurId) {
        return "override:" + entityId + ":" + spurId;
    }

    /** Legt die Spur eines Handeingriffs an, bevor er gesendet wird. Wirft nie; ohne Spur ist das Ergebnis null. */
    public Neu beginnen(UUID siteId, UUID entityId, String art, String kommando, BigDecimal wert,
            List<Integer> ausgaenge, Instant eingang) {
        UUID id = UUID.randomUUID();
        String requestId = requestId(entityId, id);
        try {
            eigene.executeWithoutResult(s -> store.anlegen(id, siteId, entityId, requestId, art, kommando, wert,
                    ausgaenge, eingang));
            log.info("Schaltspur {}: {} an Verbraucher {} angenommen", id, art, entityId);
            return new Neu(id, requestId);
        } catch (RuntimeException e) {
            log.warn("Schaltspur für Verbraucher {} nicht angelegt: {}", entityId, e.toString());
            return null;
        }
    }

    /** Der Umschlag ist beim Broker - oder warum nicht ({@code zustellung}, der pushReason). Wirft nie. */
    public void gesendet(Neu spur, UUID deviceId, Instant eingang, boolean pushed, String zustellung) {
        if (spur == null) {
            return;
        }
        Instant jetzt = Instant.now();
        try {
            eigene.executeWithoutResult(s -> store.gesendet(spur.id(), deviceId, pushed ? jetzt : null, zustellung));
            if (pushed) {
                log.info("Schaltspur {}: an Box {} gesendet nach {} ms", spur.id(), deviceId, ms(eingang, jetzt));
            } else {
                log.info("Schaltspur {}: nicht gesendet ({})", spur.id(), zustellung);
            }
        } catch (RuntimeException e) {
            log.warn("Schaltspur {}: Sendezeit nicht gespeichert: {}", spur.id(), e.toString());
        }
    }

    /**
     * Ein Herzschlag einer Box mit {@code consumers}-Block, nachdem der Zuhörer ihn gespeichert hat. Läuft unter dem
     * Mandanten des Zuhörers. {@code eintraege} ist der rohe Block (für {@code trace}), {@code rows} sind die
     * gespeicherten Zustände, {@code gemeldet} der Zeitstempel des Herzschlags (Uhr der Box). Wirft nie.
     */
    public void herzschlag(UUID siteId, UUID deviceId, Instant empfangen, Instant gemeldet, JsonNode eintraege,
            List<ConsumerRuntimeStatusRepository.Row> rows) {
        try {
            Map<UUID, ConsumerRuntimeStatusRepository.Row> jeVerbraucher = rows.stream()
                    .collect(Collectors.toMap(ConsumerRuntimeStatusRepository.Row::entityId, Function.identity(),
                            (a, b) -> a));
            for (SchaltSpurRepository.Zeile z : store.offen(siteId, deviceId, jeVerbraucher.keySet())) {
                abgleichen(z, jeVerbraucher.get(z.entityId()),
                        eintraege == null ? null : eintraege.get(z.entityId().toString()), empfangen, gemeldet);
            }
        } catch (RuntimeException e) {
            log.warn("Schaltspur: Herzschlag der Box {} nicht abgeglichen: {}", deviceId, e.toString());
        }
    }

    private void abgleichen(SchaltSpurRepository.Zeile z, ConsumerRuntimeStatusRepository.Row row, JsonNode eintrag,
            Instant empfangen, Instant gemeldet) {
        // Ein Herzschlag, der vor dem Senden ankam, sagt nichts über diesen Wunsch.
        if (z.gesendet() == null || empfangen.isBefore(z.gesendet())) {
            return;
        }
        JsonNode trace = eintrag == null ? null : eintrag.get("trace");
        boolean eigeneSpur = trace != null && trace.isObject()
                && z.requestId().equals(trace.path("request_id").asText(null));
        SchaltSpurAbgleich.Urteil urteil = SchaltSpurAbgleich.urteil(z.wunsch(), row);
        Instant gehalten = urteil == SchaltSpurAbgleich.Urteil.GEHALTEN ? empfangen : null;
        Instant bestaetigt = urteil == SchaltSpurAbgleich.Urteil.BESTAETIGT ? empfangen : null;
        String ergebnis = switch (urteil) {
            case BESTAETIGT -> "bestaetigt";
            case GEHALTEN -> "gehalten";
            case ABWEICHUNG -> "abweichung";
            case OFFEN -> z.ergebnis(); // gehalten/abweichend bleibt so stehen, bis ein Herzschlag den Wunsch erfüllt
        };
        String grund = urteil == SchaltSpurAbgleich.Urteil.GEHALTEN || urteil == SchaltSpurAbgleich.Urteil.ABWEICHUNG
                ? row.reasonCode() : null;
        store.fortschreiben(z.id(), empfangen,
                eigeneSpur ? zeit(trace, "received_at") : null,
                eigeneSpur ? zeit(trace, "admitted_at") : null,
                eigeneSpur ? zeit(trace, "written_at") : null,
                eigeneSpur ? zeit(trace, "read_back_at") : null,
                eigeneSpur ? gemeldet : null,
                eigeneSpur ? urteilDerBox(trace) : null,
                gehalten, grund, bestaetigt, ergebnis);
        if (z.ersteMeldung() == null) {
            log.info("Schaltspur {}: erster Herzschlag der Box nach {} ms ab Senden{}", z.id(),
                    ms(z.gesendet(), empfangen), eigeneSpur ? " (Box meldet ihre Zeitpunkte)" : "");
        }
        if (bestaetigt != null) {
            log.info("Schaltspur {}: bestätigt nach {} ms ab Anfrage ({} ms ab Senden)", z.id(),
                    ms(z.apiEingang(), empfangen), ms(z.gesendet(), empfangen));
        } else if (gehalten != null && z.gehalten() == null) {
            log.info("Schaltspur {}: von der Box gehalten ({}) nach {} ms ab Anfrage", z.id(), grund,
                    ms(z.apiEingang(), empfangen));
        }
    }

    /** Was das Portal selbst gemessen hat (Klick bis Antwort, Klick bis bestätigt sichtbar). */
    public boolean portal(UUID siteId, UUID entityId, UUID spurId, Integer antwortMs, Integer sichtbarMs) {
        boolean ok = store.portal(siteId, entityId, spurId, grenze(antwortMs), grenze(sichtbarMs));
        if (ok) {
            log.info("Schaltspur {}: Portal meldet Klick bis Antwort {} ms, Klick bis bestätigt sichtbar {} ms",
                    spurId, antwortMs, sichtbarMs);
        }
        return ok;
    }

    public List<SchaltSpurRepository.Zeile> liste(UUID siteId, UUID entityId) {
        return store.liste(siteId, entityId);
    }

    /** Ein Wert außerhalb einer Stunde ist keine Messung dieses Wegs. */
    private static Integer grenze(Integer ms) {
        return ms == null || ms < 0 || ms > 3_600_000 ? null : ms;
    }

    private static String urteilDerBox(JsonNode trace) {
        String outcome = trace.path("outcome").asText("");
        if (!outcome.matches("[a-z_]{1,32}")) {
            return null;
        }
        String reason = trace.path("reason_code").asText("");
        return reason.matches("[a-z_]{1,48}") ? outcome + ":" + reason : outcome;
    }

    private static Instant zeit(JsonNode node, String feld) {
        JsonNode v = node.get(feld);
        if (v == null || !v.isTextual()) {
            return null;
        }
        try {
            return Instant.parse(v.asText());
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static long ms(Instant von, Instant bis) {
        return Duration.between(von, bis).toMillis();
    }
}
