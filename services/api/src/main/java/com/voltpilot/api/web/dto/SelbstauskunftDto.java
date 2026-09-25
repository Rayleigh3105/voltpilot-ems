package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Selbstauskunft {@code GET /api/v1/me} (UEMS AP-03 IP-4) — die Form von {@code Selbstauskunft} in
 * {@code docs/contracts/openapi.yaml}. Standorte, künftige Zuweisungen und Teilansicht tragen die Wörter der
 * Ableitung {@code sichtbare_standorte} aus {@code docs/contracts/v2/rechte-vectors.json}.
 *
 * @param kundenbereich {@code null} ohne angenommenen Kundenbereich (Partner ohne wirksame Unterstützung)
 * @param zugang {@code konto} | {@code unterstuetzung} | {@code umschalter} (Plattform über {@code X-Tenant-Id}, bis
 *     IP-8); {@code null} ohne Kundenbereich
 * @param rollen die wirksamen Rollen (Kennungen der Matrix) in der Folge der Matrix
 * @param unternehmenRechte die Aktionen, die der Aufrufer auf Unternehmensebene darf
 * @param text der Satz ohne Standort („Ihnen ist derzeit kein Standort zugewiesen. …“), sonst {@code null}
 */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public record SelbstauskunftDto(
        String kennung,
        String name,
        String konto,
        String zustand,
        Kundenbereich kundenbereich,
        String zugang,
        List<String> rollen,
        boolean unternehmensweit,
        List<Standort> standorte,
        List<String> unternehmenRechte,
        List<Kuenftig> kuenftig,
        String text,
        Teilansicht teilansicht,
        Unterstuetzungen unterstuetzungen,
        List<Person> kundenadministratoren,
        List<com.voltpilot.api.zugriff.EigeneKundenbereiche.Eintrag> kundenbereiche) {

    public SelbstauskunftDto mitKundenbereichen(List<com.voltpilot.api.zugriff.EigeneKundenbereiche.Eintrag> eigene) {
        return new SelbstauskunftDto(kennung, name, konto, zustand, kundenbereich, zugang, rollen, unternehmensweit,
                standorte, unternehmenRechte, kuenftig, text, teilansicht, unterstuetzungen, kundenadministratoren, eigene);
    }

    /**
     * @param beendet {@code null}, solange der Kundenbereich aktiv ist; sonst das Vertragsende (UEMS AP-20 IP-16)
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Kundenbereich(UUID id, String name, Beendet beendet) {

        public Kundenbereich(UUID id, String name) {
            this(id, name, null);
        }
    }

    /**
     * Der beendete Kundenbereich (UEMS AP-20 IP-16, RF-08) — die Quelle des Kopf-Hinweises im Portal.
     *
     * @param beendetAm der Kalendertag des Endes (Europe/Berlin)
     * @param loeschungFruehestens Tag des Endes plus Frist, beim Abruf gerechnet
     * @param liest {@code true} nur für den Kundenadministrator; jede andere Person liest nicht mehr
     * @param text der Satz für DIESE Person — gebildet in der API ({@code KundenbereichEnde}), nie im Portal
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Beendet(String beendetAm, String loeschungFruehestens, boolean liest, String text) {}

    /**
     * Ein sichtbarer Standort.
     *
     * @param umfang der höchste Umfang einer Unterstützung an diesem Standort, sonst {@code null}
     * @param ocppStufe {@code keine} | {@code CUSTOMER} | {@code SITE_ADMIN} | {@code PLATFORM} (E13)
     * @param rechte die Aktionen (Kennungen der Matrix), die der Aufrufer an diesem Standort darf — in der Folge der
     *     Matrix
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Standort(UUID id, String kennzeichen, String name, List<String> rollen, String umfang,
            String ocppStufe, List<String> rechte) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Kuenftig(String standort, OffsetDateTime ab, String text) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Teilansicht(int sichtbar, int gesamt, boolean unternehmensebene, boolean teilansicht,
            String kopfzeile, String exportKopfzeile, boolean unternehmensweiteObjekte) {}

    /**
     * @param eigene die wirksamen Unterstützungen des Aufrufers in diesem Kundenbereich (Partner, Plattform)
     * @param gewaehrte die wirksamen Unterstützungen an den sichtbaren Standorten des Kundenkontos
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Unterstuetzungen(List<Unterstuetzung> eigene, List<Unterstuetzung> gewaehrte) {
        public static final Unterstuetzungen KEINE = new Unterstuetzungen(List.of(), List.of());
    }

    /**
     * Eine Unterstützung mit ihren Banner-Fakten.
     *
     * @param gueltigBis das Enddatum (einschließlich); der Notfall-Zugriff hat keins, nur {@code endet}
     * @param banner der Satz des Banners — beim Kunden „… hat Zugriff auf …“, beim Unterstützer „Sie arbeiten im
     *     Kundenbereich …“
     * @param erinnerung {@code true} in den letzten sieben Tagen (nie beim Notfall-Zugriff)
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Unterstuetzung(String art, String umfang, List<String> standorte, OffsetDateTime gueltigAb,
            String gueltigBis, OffsetDateTime endet, String zustand, boolean erinnerung, Person unterstuetzer,
            String banner) {}

    /** Eine Person: {@code kennung} ist das Subject des Kontos. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Person(String kennung, String name) {}
}
