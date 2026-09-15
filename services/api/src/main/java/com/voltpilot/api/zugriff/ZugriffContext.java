package com.voltpilot.api.zugriff;

import com.voltpilot.api.uems.RechteAbleitung.Konto;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Wer fragt, in welchem Kundenbereich und mit welchen Zuweisungen — je Anfrage (UEMS AP-03 IP-4).
 *
 * <p>{@link ZugriffFilter} legt ihn direkt nach dem {@code TenantFilter} an und räumt ihn im {@code finally} ab;
 * {@link com.voltpilot.api.tenant.TenantAwareDataSource} liest ihn beim Ausleihen einer Verbindung und setzt daraus
 * neben {@code app.tenant_id} die Sitzungs-Einstellungen {@code app.zugriff} ({@code unternehmen} | {@code standorte})
 * und {@code app.standort_ids} — und setzt alle drei beim Zurückgeben wieder zurück.
 *
 * <p><b>Noch liest keine Policy die beiden Einstellungen.</b> {@code site_scope} ist IP-5; bis dahin ändert der
 * Kontext an keiner Abfrage etwas. Wer ihn liest (IP-5 ff.), liest ihn HIER — nie aus einem Anfragekörper.
 */
public final class ZugriffContext {

    /** Der Wert von {@code app.zugriff}. */
    public enum Modus {
        UNTERNEHMEN("unternehmen"),
        STANDORTE("standorte");

        private final String code;

        Modus(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Wie der Kundenbereich der Anfrage erreicht wurde. */
    public enum Zugang {
        /** Das Kundenkonto: {@code tenant_id} aus dem Token. */
        KONTO("konto"),
        /** Partner- oder Plattform-Konto: {@code X-Kundenbereich}, angenommen gegen eine wirksame Unterstützung. */
        UNTERSTUETZUNG("unterstuetzung"),
        /** Plattform-Konto: der heutige Mandanten-Umschalter {@code X-Tenant-Id} — bis IP-8 (AP-03 W3). */
        UMSCHALTER("umschalter");

        private final String code;

        Zugang(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /**
     * Der Zugriff einer Anfrage.
     *
     * @param kundenbereich der Mandant, in dem die Anfrage liest — derselbe wie {@code TenantContext}
     * @param zuweisungen die zu {@code stand} wirksamen Zuweisungen des Aufrufers in diesem Kundenbereich; für
     *     Partner und Plattform nur ihre Unterstützungen, am Umschalter keine
     * @param stand der Zeitpunkt, zu dem „wirksam" gilt
     */
    public record Zugriff(String sub, Konto konto, UUID kundenbereich, Zugang zugang,
            List<ZugriffRepository.Zeile> zuweisungen, Instant stand) {

        public Zugriff {
            Objects.requireNonNull(kundenbereich, "kundenbereich");
            zuweisungen = List.copyOf(zuweisungen);
        }

        /**
         * {@code unternehmen}, wenn das Kundenkonto eine wirksame mandantenweite Zuweisung hat — und am Umschalter,
         * der heute den ganzen Kundenbereich sieht (W3). Sonst {@code standorte}: auch ein Kundenkonto OHNE wirksame
         * Zuweisung (der engste Zaun, sobald IP-5 ihn liest).
         */
        public Modus modus() {
            if (zugang == Zugang.UMSCHALTER) {
                return Modus.UNTERNEHMEN;
            }
            boolean mandantenweit = zuweisungen.stream().anyMatch(z -> z.standortId() == null);
            return zugang == Zugang.KONTO && mandantenweit ? Modus.UNTERNEHMEN : Modus.STANDORTE;
        }

        /** Die Standorte der standortbezogenen Zuweisungen, ohne Doppel und sortiert. */
        public List<UUID> standortIds() {
            return zuweisungen.stream().map(ZugriffRepository.Zeile::standortId).filter(Objects::nonNull).distinct()
                    .sorted().toList();
        }

        /** {@code app.standort_ids} als Postgres-Array-Literal: {@code {a,b}}, ohne Standort {@code {}}. */
        public String standortIdsWert() {
            return standortIds().stream().map(UUID::toString).collect(Collectors.joining(",", "{", "}"));
        }
    }

    private static final ThreadLocal<Zugriff> CURRENT = new ThreadLocal<>();

    private ZugriffContext() {
    }

    public static void set(Zugriff zugriff) {
        CURRENT.set(zugriff);
    }

    public static Zugriff get() {
        return CURRENT.get();
    }

    public static void clear() {
        CURRENT.remove();
    }
}
