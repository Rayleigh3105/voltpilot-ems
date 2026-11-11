package com.voltpilot.api.geraete;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.DeviceDto;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * "Box ausbauen" ohne Mandantensprung (vp-admin-box-ausbauen, Captain-Auftrag 11.11.2026): EIN
 * Einstieg der Geräteakte ("Vom Kunden lösen", {@code BoxLoesenDialog.tsx}) bietet dem Plattform-
 * Admin jetzt auch diese Handlung an, wenn die Box schon Daten hat ({@code BoxLoesenRegel} lehnt
 * "lösen" dann ab). Ruft dieselbe Umsetzung wie der Kunde ({@link BoxAusbauenService}, "Gerät
 * entfernen") - kein zweiter Weg daneben, derselbe 409-Wächter ({@code box_hat_zustaendigkeiten}).
 *
 * <p><b>Mandantentrennung</b> wie {@link BoxLoesenService}/{@link BoxEndgueltigLoeschenService}: der
 * Erst-Befund kommt aus {@link AdminBoxLoesenRepository} (BYPASSRLS, über jeden Mandanten - dieselbe
 * Abfrage wie "Vom Kunden lösen", da beide Handlungen am selben Punkt entscheiden, WESSEN Box es
 * ist); die eigentliche Umsetzung und das Protokoll laufen mit GESETZTEM {@link TenantContext} über
 * die RLS-gezäunte App-Rolle.
 */
@Service
public class BoxAusbauenAdminService {

    private final AdminBoxLoesenRepository admin;
    private final AdminBoxAusbauenRepository idempotenz;
    private final BoxAusbauenProtokollRepository protokoll;
    private final BoxAusbauenService ausbauen;
    private final DeviceRepository devices;
    private final TransactionTemplate tx;

    public BoxAusbauenAdminService(AdminBoxLoesenRepository admin, AdminBoxAusbauenRepository idempotenz,
            BoxAusbauenProtokollRepository protokoll, BoxAusbauenService ausbauen, DeviceRepository devices,
            PlatformTransactionManager transactions) {
        this.admin = admin;
        this.idempotenz = idempotenz;
        this.protokoll = protokoll;
        this.ausbauen = ausbauen;
        this.devices = devices;
        this.tx = new TransactionTemplate(transactions);
    }

    public record Ergebnis(String externalRef, UUID deviceId, Instant ausgebautAm, String anlass,
            boolean bereitsAusgebaut) {
    }

    /**
     * Ausbauen (POST). {@code akteur} ist IMMER die Platform-Admin-Person. 400, wählt der Aufruf
     * keinen geschlossenen Anlass ({@link BoxLoesenAnlass}); 404, kennt die Referenz keine aktive
     * Box UND kein Protokoll-Eintrag dieser Referenz; 409 {@code box_hat_zustaendigkeiten}, solange
     * die Box noch Datenquellen liest oder geplante Zuständigkeiten hat
     * ({@code DeviceRepository#ausbauen}) - nichts geändert. Idempotent über
     * {@code box_ausbauen_protokoll} (genau ein Eintrag je Geräte-ID): ein Doppelklick oder eine
     * Wiederholung nach einem Netzfehler baut nie eine zweite Box aus.
     */
    public Ergebnis ausbauen(String externalRef, String anlass, String anlassText, ProtokollAkteur akteur) {
        validateAnlass(anlass, anlassText);
        Optional<BoxBefundSql.Zeile> vorab = admin.befund(externalRef);
        if (vorab.isEmpty()) {
            return idempotent(externalRef);
        }
        BoxBefundSql.Zeile zeile = vorab.get();
        UUID vorherigerMandant = TenantContext.get();
        try {
            TenantContext.set(zeile.tenantId());
            return tx.execute(status -> ausbauenGesperrt(zeile, anlass, anlassText, akteur));
        } finally {
            if (vorherigerMandant == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorherigerMandant);
            }
        }
    }

    private Ergebnis ausbauenGesperrt(BoxBefundSql.Zeile vorab, String anlass, String anlassText,
            ProtokollAkteur akteur) {
        devices.lockReference(vorab.externalRef());
        Optional<DeviceDto> aktuell = devices.findById(vorab.deviceId());
        if (aktuell.isEmpty()) {
            // Zwischen dem Erst-Befund und der Sperre ist die Box verschwunden (ein Rennen mit dem
            // Kunden-Weg "Gerät entfernen"): dieselbe Idempotenz wie beim unbekannten Befund oben,
            // statt eines überraschenden 404 für eine Aktion, die gerade erst ihr Ziel erreichte.
            return idempotent(vorab.externalRef());
        }
        DeviceDto device = aktuell.get();
        ausbauen.ausbauen(device, vorab.tenantId(), akteur);
        BoxAusbauenProtokollRepository.Protokolliert p = protokoll.protokollieren(
                new BoxAusbauenProtokollRepository.Eintrag(vorab.tenantId(), vorab.tenantName(), vorab.siteId(),
                        vorab.siteName(), device.id(), vorab.externalRef(), vorab.verbundenAm(),
                        akteur == null ? null : akteur.sub(), akteur == null ? "VoltPilot" : akteur.name(), anlass,
                        anlassText));
        return new Ergebnis(vorab.externalRef(), device.id(), p.ausgebautAm(), p.anlass(), false);
    }

    private Ergebnis idempotent(String externalRef) {
        return idempotenz.letztesProtokoll(externalRef)
                .map(p -> new Ergebnis(externalRef, p.deviceId(), p.ausgebautAm(), p.anlass(), true))
                .orElseThrow(() -> unbekannt(externalRef));
    }

    private static void validateAnlass(String anlass, String anlassText) {
        if (anlass == null || !BoxLoesenAnlass.VOKABULAR.contains(anlass)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Bitte wählen Sie einen Anlass.");
        }
        boolean brauchtText = "anderer_anlass".equals(anlass);
        if (brauchtText == (anlassText == null || anlassText.isBlank())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    brauchtText ? "Bitte beschreiben Sie den Anlass." : "Ein Text gilt nur bei 'Anderer Anlass …'.");
        }
    }

    private static ResponseStatusException unbekannt(String externalRef) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "Unbekannte Referenz: " + externalRef);
    }
}
