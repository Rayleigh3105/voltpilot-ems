package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.EnergiemanagementVerantwortungDto.Objekt;
import java.util.List;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * UEMS AP-19 IP-18 (PA4): die internen Audits in „Wer ist wofür verantwortlich“ — je Audit sein Verantwortlicher
 * (Konto, IA1) und sein Zustand, gelesen über {@link InternesAuditService#programm} mit dem Zaun des Aufrufers.
 * Auditorin oder Auditor sind hier nicht „verantwortlich“: sie prüfen (IA5).
 */
@Component
@Order(10)
public class AuditVerantwortung implements VerantwortungQuelle {

    /** Die Art dieser Quelle — ergänzt {@code objekt.art} in {@code openapi.yaml} nach denen des Bestands. */
    static final List<String> ARTEN = List.of("internes_audit");

    private final InternesAuditService audits;

    public AuditVerantwortung(InternesAuditService audits) {
        this.audits = audits;
    }

    @Override
    public List<Objekt> objekte() {
        return audits.programm(null).audits().stream()
                .map(a -> new Objekt("internes_audit", a.id(), a.kennzeichen(), a.titel(), a.verantwortlich(),
                        a.zustand()))
                .toList();
    }
}
