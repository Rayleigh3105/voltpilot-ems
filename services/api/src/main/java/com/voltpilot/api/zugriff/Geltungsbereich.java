package com.voltpilot.api.zugriff;

import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der EINE Prüfpunkt des Standort-Zauns im API (UEMS AP-03 IP-5, §6.2 Punkt 4): sieht diese Anfrage die Anlage?
 *
 * <p>Die Antwort gibt die Datenbank, nicht dieser Code: {@code site} trägt neben der Mandanten-Policy die Policy
 * {@code site_scope} (V20260915190000), die {@code app.zugriff} und {@code app.standort_ids} aus {@link ZugriffContext}
 * liest. Eine Anlage eines fremden Kundenbereichs und eine Anlage außerhalb der eigenen Standorte sind darum dieselbe
 * Antwort wie eine, die es nicht gibt: 404, nie 403 — die Existenz wird nicht bestätigt (AP-03 A13).
 *
 * <p>Ersetzt die verstreuten {@code SiteRepository.existsForCurrentTenant}. Wer eine Anlage aus dem Pfad nimmt und
 * danach NICHT über {@code site} weiterliest (Messwerte, Hypertables, Rollups), prüft sie hier;
 * {@code SiteScopeArchitekturTest} führt die Liste dieser Stellen.
 */
@Component
public class Geltungsbereich {

    private final JdbcTemplate jdbc;

    public Geltungsbereich(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Sieht die Anfrage diese Anlage? {@code false} auch für {@code null}. */
    public boolean siteVisible(UUID siteId) {
        if (siteId == null) {
            return false;
        }
        return Boolean.TRUE.equals(
                jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM site WHERE id = ?)", Boolean.class, siteId));
    }

    /** 404 „Anlage nicht gefunden.", wenn die Anfrage die Anlage nicht sieht. */
    public void requireSite(UUID siteId) {
        if (!siteVisible(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }

    /**
     * Hebt den Standort-Zaun für den REST DER LAUFENDEN TRANSAKTION auf ({@code set_config(…, true)}); der
     * Mandanten-Zaun bleibt. Nur für Ableitungen, die die Sichtbarkeit selbst nach dem Rechte-Vertrag rechnen und
     * nichts Unsichtbares ausgeben — heute allein die Selbstauskunft ({@code n von m Standorten}, Zuweisungen an
     * fremden Standorten). {@code SiteScopeArchitekturTest} führt die Liste der Aufrufer.
     *
     * @throws IllegalStateException ohne Transaktion — dann gälte die Aufhebung für keine oder eine fremde Abfrage
     */
    public void ganzenKundenbereichLesen() {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Den ganzen Kundenbereich lesen geht nur in einer Transaktion.");
        }
        jdbc.queryForList("SELECT set_config('app.zugriff', 'unternehmen', true), "
                + "set_config('app.standort_ids', '{}', true)");
    }
}
