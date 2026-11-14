package com.voltpilot.api.preis;

import com.voltpilot.api.consumers.PriceWindowSource;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.ota.BoxArt;
import com.voltpilot.api.repo.PriceRepository;
import com.voltpilot.api.repo.UpdateStatusRepository;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Die EINE Wahrheit der Preis-Zuleitung zur Box (Vertrag
 * {@code docs/contracts/v2/mqtt-price-current.md}): WER den aktuellen
 * Börsenpreis gespeist bekommt und WELCHER Slot gerade gilt. Der Takt
 * ({@link PreisZuleitungTakt}) veröffentlicht danach, und {@code GET
 * /sites/{id}/prices} sagt dem Portal mit derselben Ableitung, ob der
 * Preis-Baustein des Regel-Baukastens entsperrt ist - nie zwei Regeln.
 *
 * <p><b>Tarifgrundlage = Erlösanzeige/Optimierer</b> (Projektregel in
 * {@code AGENTS.md}): gesendet wird der NACKTE Börsenpreis des Slots
 * (ct/kWh) aus {@code day_ahead_prices} der Zone, Viertelstunde schlägt
 * Stunde ({@link PriceWindowSource#preferQuarterHours}) - exakt die Reihen,
 * mit denen Erlösanzeige und Optimierer rechnen und die das Portal als
 * „Börsenpreis" zeigt (der Probelauf einer Regel rechnet auf denselben).
 *
 * <p><b>Gesperrt für Kunden ohne zeitveränderlichen Preis:</b> maßgeblich ist
 * die AUSSAGE des Kunden ({@code tarif_art = 'fest'} = „mein Preis ist
 * flach"), nicht der Bewertungs-Rückfall der Erlösanzeige - eine
 * {@code fest}-Anlage ohne gepflegten Preis wird dort notgedrungen zu
 * Börsenpreisen bewertet, ihr Tarif folgt der Börse deshalb trotzdem nicht.
 * {@code dynamisch} und {@code ohne} sind genau die Anlagen, deren Bezug die
 * Erlösanzeige je Slot zum Börsenpreis bewertet.
 *
 * <p><b>Fähigkeit der Box:</b> gespeist wird nur eine Anlage mit führender
 * Box, die Regeln auch ausführen kann - eine Edge Light kann das nicht
 * (Paritätsliste, derselbe Capability-Check wie {@code FlowActivationService}).
 * Der Grund einer Sperre reist als Code zum Portal und wird dort im Klartext
 * gezeigt.
 */
@Service
public class PreisZuleitung {

    /** Sperr-Gründe (Klartext macht das Portal daraus). */
    public static final String GRUND_KEIN_DYNAMISCHER_TARIF = "kein_dynamischer_tarif";
    public static final String GRUND_KEINE_ZONE = "keine_zone";
    public static final String GRUND_KEINE_BOX = "keine_box";
    public static final String GRUND_EDGE_LIGHT = "edge_light";

    /**
     * Ob die Anlage gespeist wird; {@code grund} ist genau dann gesetzt, wenn
     * nicht, {@code box} genau dann, wenn ja (die führende Box als Ziel).
     */
    public record Stand(boolean aktiv, String grund, UUID box) {

        static Stand gesperrt(String grund) {
            return new Stand(false, grund, null);
        }

        static Stand aktiv(UUID box) {
            return new Stand(true, null, box);
        }
    }

    private final LeadDeviceService leadDevices;
    private final UpdateStatusRepository updateStatus;
    private final PriceRepository prices;

    public PreisZuleitung(LeadDeviceService leadDevices,
            UpdateStatusRepository updateStatus, PriceRepository prices) {
        this.leadDevices = leadDevices;
        this.updateStatus = updateStatus;
        this.prices = prices;
    }

    /**
     * Der Stand einer Anlage, unter dem Mandanten der Sitzung (RLS). Die
     * Reihenfolge der Gründe ist die hilfreichste für den Kunden: erst der
     * Tarif (seine Entscheidung), dann die Box (die Voraussetzung).
     *
     * @param tarifArt {@code site.tarif_art} ({@code fest}, {@code dynamisch},
     *     {@code ohne} oder {@code null})
     */
    public Stand stand(UUID siteId, String biddingZone, String tarifArt) {
        if (biddingZone == null || biddingZone.isBlank()) {
            return Stand.gesperrt(GRUND_KEINE_ZONE);
        }
        if ("fest".equals(tarifArt)) {
            return Stand.gesperrt(GRUND_KEIN_DYNAMISCHER_TARIF);
        }
        LeadDeviceService.FuehrendeBox lead = leadDevices.fuehrendeBox(siteId);
        if (lead.box() == null) {
            return Stand.gesperrt(GRUND_KEINE_BOX);
        }
        if (BoxArt.LIGHT.equals(updateStatus.boxArt(lead.box()))) {
            return Stand.gesperrt(GRUND_EDGE_LIGHT);
        }
        return Stand.aktiv(lead.box());
    }

    /**
     * Der Preis-Slot, der {@code now} enthält (halboffen {@code [ts, end)}),
     * Viertelstunde vor Stunde - oder {@code null}, wenn die Zone keinen
     * gespeicherten Preis für jetzt hat. Dann wird NICHTS gesendet: der letzte
     * Stand auf der Box läuft über seine Frische ab und die Bedingung ist
     * ehrlich unbekannt, nie eine erfundene Zahl.
     */
    public PricePoint aktuellerSlot(String biddingZone, Instant now) {
        List<com.voltpilot.api.web.dto.PricePointDto> points = PriceWindowSource.preferQuarterHours(
                prices.findForZone(biddingZone, now.minus(Duration.ofHours(1)), now, 16));
        for (com.voltpilot.api.web.dto.PricePointDto p : points) {
            if (!p.ts().isAfter(now) && p.end().isAfter(now)) {
                return new PricePoint(p.ts(), p.end(), p.priceEurMwh().doubleValue() / 10.0);
            }
        }
        return null;
    }

    /** Ein sendefertiger Slot: der nackte Börsenpreis in ct/kWh. */
    public record PricePoint(Instant slotStart, Instant slotEnd, double priceCtKwh) {}
}
