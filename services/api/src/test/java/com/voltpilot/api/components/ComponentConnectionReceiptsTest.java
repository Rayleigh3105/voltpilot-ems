package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Der Beleg-Speicher - und seit Einheitsmodell Stufe 4 die EVIDENZ, die er
 * mittraegt (Anforderung 3: wer/wann/Evidenz).
 *
 * <p>Rein, ohne Docker: der Speicher ist eine Regel, keine Infrastruktur.
 */
class ComponentConnectionReceiptsTest {

    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final String REF = "custom:switch";
    private static final Map<String, Object> FIELDS = Map.of("host", "192.168.1.5", "address", 12);

    /** Eine steuerbare Uhr - die Verfalls-Regel darf nicht an der Wanduhr haengen. */
    private static final class Tick extends Clock {
        private Instant now = Instant.parse("2026-08-17T10:00:00Z");

        @Override public java.time.ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override public Instant instant() {
            return now;
        }

        void advance(Duration d) {
            now = now.plus(d);
        }
    }

    @Test
    void theEvidenceTravelsWithTheReceiptAndDiesWithIt() {
        Tick clock = new Tick();
        ComponentConnectionReceipts receipts = new ComponentConnectionReceipts(clock);

        receipts.record(SITE, REF, FIELDS, "Wert 1, zurueckgelesen 1 (passt)");
        assertThat(receipts.has(SITE, REF, FIELDS)).isTrue();
        assertThat(receipts.evidence(SITE, REF, FIELDS)).isEqualTo("Wert 1, zurueckgelesen 1 (passt)");

        // Ein abgelaufener Beleg gilt nicht - und eine Evidenz OHNE gueltigen
        // Beleg gibt es nicht, sonst ueberlebte der Nachweis seinen Test.
        clock.advance(ComponentConnectionReceipts.TTL.plusSeconds(1));
        assertThat(receipts.has(SITE, REF, FIELDS)).isFalse();
        assertThat(receipts.evidence(SITE, REF, FIELDS)).isNull();
    }

    @Test
    void aReceiptWithoutEvidenceStaysValid() {
        // Der Verbindungstest der Stufe 1 hat keine Evidenz - dort IST der
        // Messwert die Antwort. Der Beleg gilt trotzdem.
        ComponentConnectionReceipts receipts = new ComponentConnectionReceipts(new Tick());
        receipts.record(SITE, "custom:read", FIELDS);
        assertThat(receipts.has(SITE, "custom:read", FIELDS)).isTrue();
        assertThat(receipts.evidence(SITE, "custom:read", FIELDS)).isNull();
    }

    @Test
    void theEvidenceIsBoundToEXACTLYThisDefinition() {
        // Eine geaenderte Adresse ist ein anderes Geraet: weder Beleg noch
        // Evidenz duerfen mitwandern.
        ComponentConnectionReceipts receipts = new ComponentConnectionReceipts(new Tick());
        receipts.record(SITE, REF, FIELDS, "Wert 1");
        Map<String, Object> other = Map.of("host", "192.168.1.5", "address", 13);
        assertThat(receipts.has(SITE, REF, other)).isFalse();
        assertThat(receipts.evidence(SITE, REF, other)).isNull();
    }

    @Test
    void aReceiptIsBoundToTheExactTemplateVersion() {
        ComponentConnectionReceipts receipts = new ComponentConnectionReceipts(new Tick());
        receipts.record(SITE, REF, 1, FIELDS);

        assertThat(receipts.has(SITE, REF, 1, FIELDS)).isTrue();
        assertThat(receipts.has(SITE, REF, 2, FIELDS)).isFalse();
        assertThat(receipts.has(SITE, REF, FIELDS)).isFalse();
    }

    /**
     * Der HALBE Beleg (Live-Fall Muehlfeldweg 2, 21.08.2026): das Geraet hat
     * geantwortet, aber EIN Kanal fehlt nachweislich. Er nennt den Kanal - das
     * ist der Unterschied zwischen einem Freibrief und einer benannten Ausnahme.
     */
    @Test
    void anOverridableReceiptNamesTheMissingChannel() {
        Tick tick = new Tick();
        ComponentConnectionReceipts r = new ComponentConnectionReceipts(tick);
        r.recordOverridable(SITE, REF, FIELDS, "soc_pct");

        assertThat(r.has(SITE, REF, FIELDS)).isTrue();
        assertThat(r.overrideChannel(SITE, REF, FIELDS)).isEqualTo("soc_pct");
        // Ein VOLLSTAENDIGER Test nennt keinen - „nichts fehlt" ist die Antwort.
        r.record(SITE, REF, FIELDS);
        assertThat(r.overrideChannel(SITE, REF, FIELDS)).isNull();
    }

    /** Die Ausnahme gilt GENAU dieser Verbindung - und verfaellt wie jeder Beleg. */
    @Test
    void anOverridableReceiptIsBoundToItsConnectionAndExpires() {
        Tick tick = new Tick();
        ComponentConnectionReceipts r = new ComponentConnectionReceipts(tick);
        r.recordOverridable(SITE, REF, FIELDS, "soc_pct");

        Map<String, Object> andereAdresse = Map.of("host", "192.168.1.6", "address", 12);
        assertThat(r.overrideChannel(SITE, REF, andereAdresse)).isNull();

        tick.advance(ComponentConnectionReceipts.TTL.plusMinutes(1));
        assertThat(r.has(SITE, REF, FIELDS)).isFalse();
        assertThat(r.overrideChannel(SITE, REF, FIELDS)).isNull();
    }
}
