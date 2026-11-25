package com.voltpilot.api.direktvermarktung;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.DirektvermarktungRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository.ZugangChiffrat;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Die AES-256-GCM-Leseseite der in {@link PartnerzugangSpeicher} festgeschriebenen Ablageform. Die
 * Schreibseite (ZIP öffnen, prüfen, verschlüsseln) ist der eigene, beim Captain gehaltene Auftrag - hier
 * wird NUR gelesen, und jede Abweichung ist dasselbe stille {@code empty()}: welcher Teil fehlte, gehört
 * nicht in ein Log neben ein Chiffrat.
 */
@Component
public class AesGcmPartnerzugangSpeicher implements PartnerzugangSpeicher {

    private static final Logger log = LoggerFactory.getLogger(AesGcmPartnerzugangSpeicher.class);
    private static final int GCM_TAG_BITS = 128;

    private final DirektvermarktungRepository repo;
    private final ObjectMapper json;
    private final byte[] schluessel;

    public AesGcmPartnerzugangSpeicher(DirektvermarktungRepository repo, ObjectMapper json,
            @Value("${voltpilot.direktvermarktung.partnerzugang-schluessel:}") String schluesselBase64) {
        this.repo = repo;
        this.json = json;
        byte[] k = null;
        if (schluesselBase64 != null && !schluesselBase64.isBlank()) {
            try {
                k = Base64.getDecoder().decode(schluesselBase64.trim());
                if (k.length != 32) {
                    log.error("direktvermarktung: VP_PARTNERZUGANG_SCHLUESSEL hat {} Byte statt 32 - "
                            + "Zugaenge sind nicht lesbar", k.length);
                    k = null;
                }
            } catch (IllegalArgumentException e) {
                log.error("direktvermarktung: VP_PARTNERZUGANG_SCHLUESSEL ist kein Base64 - "
                        + "Zugaenge sind nicht lesbar");
            }
        }
        this.schluessel = k;
    }

    @Override
    public Optional<JsonNode> lade(UUID zugangId) {
        if (schluessel == null) {
            log.warn("direktvermarktung: Zugang {} angefragt, aber kein VP_PARTNERZUGANG_SCHLUESSEL gesetzt",
                    zugangId);
            return Optional.empty();
        }
        ZugangChiffrat z = repo.zugangChiffrat(zugangId);
        if (z == null || z.chiffrat() == null || z.nonce() == null) {
            return Optional.empty();
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(schluessel, "AES"),
                    new GCMParameterSpec(GCM_TAG_BITS, z.nonce()));
            byte[] klartext = cipher.doFinal(z.chiffrat());
            JsonNode doc = json.readTree(klartext);
            if (!doc.isObject() || !doc.has("dateien") || !doc.has("gegenstelle")) {
                log.warn("direktvermarktung: Zugang {} entschluesselt, aber nicht in der Ablageform", zugangId);
                return Optional.empty();
            }
            return Optional.of(doc);
        } catch (Exception e) {
            // Bewusst ohne e.getMessage(): neben einem Chiffrat gehoert kein Grund ins Log.
            log.warn("direktvermarktung: Zugang {} nicht entschluesselbar", zugangId);
            return Optional.empty();
        }
    }
}
