package com.voltpilot.api.zugriff;

import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.KennzahlRegeln;
import com.voltpilot.api.uems.KennzahlUmfang;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.DarfErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.function.Function;
import java.util.function.Supplier;
import java.util.Set;
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
     * Sieht die Anfrage diesen Standort? Dieselbe Antwort aus der Datenbank wie bei der Anlage: {@code standort}
     * trägt {@code site_scope} mit {@code id = ANY (app.standort_ids)} (IP-5).
     */
    public boolean standortVisible(UUID standortId) {
        if (standortId == null) {
            return false;
        }
        return Boolean.TRUE.equals(
                jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM standort WHERE id = ?)", Boolean.class, standortId));
    }

    /**
     * 404 „Standort nicht gefunden.", wenn die Anfrage den Standort nicht sieht — der Prüfpunkt der
     * Standort-Menge an {@code /earnings} (IP-10). Ein fremder Standort ist 404, nie 403: die Existenz wird
     * nicht bestätigt (AP-03 A14).
     */
    public void requireStandort(UUID standortId) {
        if (!standortVisible(standortId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Standort nicht gefunden.");
        }
    }

    /**
     * R-A1/R-A5: der gemeinsame Prüfpunkt für Kennzahlen, Berichte und Exporte. {@code null} bedeutet
     * Unternehmens-Geltung, nicht „alle sichtbaren Standorte“. Die Matrix gewährt sie ausschließlich U-Rollen,
     * nie einer Unterstützung. Die Standortliste kommt aus der mandanten- und standortgezäunten Verbindung.
     */
    public static DarfErgebnis scope(Benutzer wer, Kundenbereich kundenbereich, String recht, String standort,
            Instant jetzt) {
        return RechteAbleitung.darf(RechteMatrixDatei.matrix(), wer, kundenbereich, recht,
                standort == null ? Ziel.unternehmen() : Ziel.standort(standort), jetzt);
    }

    /** Bestehende Routen behalten ihr Fehlerformat: fremdes Objekt 404, fehlendes Unternehmensrecht 403. */
    public static DarfErgebnis requireScope(Benutzer wer, Kundenbereich kundenbereich, String recht, String standort,
            Instant jetzt, Function<DarfErgebnis, ? extends RuntimeException> ablehnung) {
        DarfErgebnis d = scope(wer, kundenbereich, recht, standort, jetzt);
        if (!d.darf()) {
            throw ablehnung.apply(d);
        }
        return d;
    }

    /** Keine Metadaten im Nein: die Liste darf ausschließlich einen ANZAHL-Hinweis bilden. */
    public record KennzahlSicht(boolean sichtbar, boolean hinweis) {}

    public static KennzahlSicht scope(Benutzer wer, Kundenbereich kundenbereich, boolean eigeneGeltung,
            Set<String> eingaenge, Instant jetzt) {
        List<Boolean> sichtbar = eingaenge.stream().map(s -> !KennzahlUmfang.UNBEKANNT.equals(s)
                && scope(wer, kundenbereich, KennzahlRegeln.ANSEHEN,
                        KennzahlUmfang.UNTERNEHMEN.equals(s) ? null : s, jetzt).darf()).toList();
        boolean dritter = wer.konto() != RechteAbleitung.Konto.BENUTZER;
        boolean wert = KennzahlRegeln.MIT_WERT.equals(KennzahlRegeln.sichtbarkeit(eigeneGeltung, sichtbar, dritter));
        // W3 bleibt bestehen. Auch bei allen Eingangs-Standorten im Zugriff gibt ein fehlendes
        // Unternehmensrecht keinen Namen preis (korrigierte A15-Abnahme, Firstmate 16.09.2026).
        return new KennzahlSicht(wert, !wert && !dritter && sichtbar.stream().anyMatch(Boolean::booleanValue));
    }

    public static void requireScope(KennzahlSicht sicht, Supplier<? extends RuntimeException> nichtGefunden) {
        if (!sicht.sichtbar()) {
            throw nichtGefunden.get();
        }
    }

    public static DarfErgebnis requireScope(Benutzer wer, Kundenbereich kundenbereich, String recht, String standort,
            Instant jetzt) {
        return requireScope(wer, kundenbereich, recht, standort, jetzt, d -> d.http() == 403
                ? new RechtFehlt(recht, d)
                : new ResponseStatusException(HttpStatus.NOT_FOUND, "Nicht gefunden."));
    }

    /** R-A4/R-A7: ausschließlich sichtbare Namen und die erlaubte Gesamt-ANZAHL; volle Sicht bleibt zeichengleich. */
    public static String exportKopf(List<String> namen, int gesamt) {
        return namen.size() >= gesamt ? null
                : "Teilansicht: " + String.join(", ", namen) + " (" + namen.size() + " von " + gesamt + " Standorten)";
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
