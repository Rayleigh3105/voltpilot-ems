package com.voltpilot.api.registerwrite;

import com.voltpilot.api.repo.RegisterWriteEventRepository;
import com.voltpilot.api.web.dto.RegisterWriteEventDto;

/**
 * Die EINE Abbildung einer Journal-Zeile auf ihre DTO-Form.
 *
 * <p>Sie steht hier und nicht in einem Controller, weil sie ZWEI Flächen
 * beliefert: den Register-Drawer (Beleg + Verlauf) und den vierten Strom
 * {@code register} der Befehle-Seite. Zwei Abbildungen desselben Vorgangs wären
 * zwei Wahrheiten über eine Zeile - genau das, was das Journal vermeidet.
 */
public final class RegisterWriteEvents {

    private RegisterWriteEvents() {
    }

    public static RegisterWriteEventDto toDto(RegisterWriteEventRepository.Entry e) {
        return new RegisterWriteEventDto(e.id(), e.requestId(), e.source(),
                e.deviceId() == null ? null : e.deviceId().toString(), e.deviceRef(), e.lane(),
                e.targetLabel(), e.registerKind(), e.address(),
                e.address() == null ? null : RegisterKnowledge.hex(e.address()),
                e.addressInput(), e.valueInput(), e.note(), e.valueRaw(), e.expectedBefore(),
                e.registerLabel(), e.registerClass(), e.scaleNote(), e.origin(), e.actorName(),
                e.actorRole(), e.viaTenantSwitcher(), e.requestedAt(), e.beforeRaw(),
                e.afterRaw(), e.adopted(), e.outcome(), e.reason(), e.answeredAt());
    }
}
