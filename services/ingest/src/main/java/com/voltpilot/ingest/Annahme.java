package com.voltpilot.ingest;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Was die Datenannahme aus EINEM Umschlag weiterreicht und was sie ablehnt (UEMS AP-07 IP-5): ein
 * fehlerhafter oder unplausibler Wert verwirft nur sich selbst, der Rest des Umschlags läuft
 * weiter. {@code weiter} ist {@code null}, wenn kein Wert übrig blieb.
 */
record Annahme<T>(T weiter, Absender absender, List<Ablehnungen.Ablehnung> ablehnungen) {

    /**
     * Wer den Umschlag schickte: Kundenbereich, Anlage, Box, der Uplink ({@code strom} = Blatt
     * des Topics) und seine Sequenz — {@code null}, wenn die Box keine meldet (nie geraten).
     */
    record Absender(UUID tenantId, UUID siteId, UUID deviceId, String strom, Long sequenz) {

        /**
         * Der Absender aus dem Topic {@code ems/{t}/{s}/{d}/v2/{strom}} — die mTLS-geprüfte
         * Identität, auch wenn der Umschlag selbst unlesbar ist oder eine andere nennt.
         */
        static Optional<Absender> ausTopic(String topic, Long sequenz) {
            String[] t = topic == null ? new String[0] : topic.split("/", -1);
            if (t.length != 6 || !"ems".equals(t[0]) || !"v2".equals(t[4]) || t[5].isEmpty()) {
                return Optional.empty();
            }
            UUID tenant = kanonisch(t[1]);
            UUID site = kanonisch(t[2]);
            UUID device = kanonisch(t[3]);
            return tenant == null || site == null || device == null ? Optional.empty()
                    : Optional.of(new Absender(tenant, site, device, t[5], sequenz));
        }

        /** Nur die Normalform (klein, 8-4-4-4-12) — eine andere Schreibweise ist keine Kennung. */
        private static UUID kanonisch(String s) {
            try {
                UUID u = UUID.fromString(s);
                return u.toString().equals(s) ? u : null;
            } catch (IllegalArgumentException e) {
                return null;
            }
        }
    }
}
