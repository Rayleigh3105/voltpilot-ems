package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.mispel.FoerderwegRepository;
import com.voltpilot.api.mispel.MispelNachweisAbgelehnt;
import com.voltpilot.api.mispel.MispelPauschalRepository;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der Jahresstand der Pauschaloption für das Portal (MiSpeL MP-27, Bedienkonzept BK-27 Variante A „Jahresband“):
 * die gespeicherten Jahresläufe des Rechenwerks (MP-25, {@code mispel_pauschal_jahr}) eines Kalenderjahres, je
 * (Rumpf-)Jahr die jüngste Fassung mit den Jahreswerten der Anlage 2 — (P1), (P3), (P4), (P9), (P10), (P11), (P14),
 * (P15) bzw. im Rumpfjahr (P1)R, (P3)R, (P4)R (A2 S. 51–55). Vertrag {@code docs/contracts/v2/mispel-pauschal.md}
 * „Jahresstand für das Portal“.
 *
 * <p>Immer 200 für eine sichtbare Anlage: ein Jahr ohne Lauf hat leere {@code staende} (das Portal zeigt dann keine
 * Karte). Eine Schätzung bis Jahresende liefert die Route nicht ({@code schaetzung = null}): sie braucht ein
 * Jahresprofil, das der Jahreszustand noch nicht hat — hochgerechnet mit dem bisherigen Tempo wird nicht.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/mispel/pauschal")
public class SiteMispelPauschalController {

    private static final ObjectMapper JSON = new ObjectMapper();

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Stand(LocalDate tagVon, LocalDate tagBis, boolean rumpfjahr, int fassung, String formelsatz,
            String basisfall, String stand, List<String> standGruende, String wertequelle, int viertelstundenErwartet,
            int viertelstundenGerechnet, Instant gerechnetAm, Map<String, BigDecimal> stammdaten,
            Map<String, BigDecimal> jahreswerte) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Jahr(UUID siteId, int jahr, LocalDate anwendbarAb, List<Stand> staende, Object schaetzung) {}

    private final MispelPauschalRepository laeufe;
    private final FoerderwegRepository anlagen;
    private final RechtPruefung rechte;
    private final LocalDate pauschaloptionAb;

    public SiteMispelPauschalController(MispelPauschalRepository laeufe, FoerderwegRepository anlagen,
            RechtPruefung rechte, @Value("${voltpilot.mispel.pauschaloption-ab:}") String pauschaloptionAb) {
        this.laeufe = laeufe;
        this.anlagen = anlagen;
        this.rechte = rechte;
        this.pauschaloptionAb = pauschaloptionAb == null || pauschaloptionAb.isBlank() ? null
                : LocalDate.parse(pauschaloptionAb.trim());
    }

    /** Recht: {@code messwerte.ansehen} (Leseweg der Anlage). Das Kalenderjahr: je (Rumpf-)Jahr der jüngste Lauf. */
    @GetMapping("/jahre/{jahr}")
    public Jahr jahr(@PathVariable UUID siteId, @PathVariable String jahr) {
        rechte.pruefenLesen(RechtZiel.ANLAGE, siteId,
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden."));
        // Eine fremde Anlage ist unter RLS unsichtbar: 404 statt eines leeren Jahres.
        if (anlagen.schalter(siteId).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        if (!jahr.matches("\\d{4}")) {
            throw new MispelNachweisAbgelehnt("zeitraum_ungueltig", 400, "„" + jahr + "“ ist kein Jahr (JJJJ).");
        }
        int j = Integer.parseInt(jahr);
        List<Stand> staende = laeufe.jahresstaende(siteId, j).stream().map(s -> new Stand(s.tagVon(), s.tagBis(),
                !(s.tagVon().getDayOfYear() == 1 && s.tagBis().equals(LocalDate.of(j, 12, 31))), s.fassung(),
                s.formelsatz(), s.basisfall(), s.stand(), liste(s.standGruende()), s.wertequelle(),
                s.viertelstundenErwartet(), s.viertelstundenGerechnet(), s.gerechnetAm(), zahlen(s.stammdaten()),
                zahlen(s.jahreswerte()))).toList();
        return new Jahr(siteId, j, pauschaloptionAb, staende, null);
    }

    /** {@code {code, message}} wie der Nachweis. */
    @ExceptionHandler(MispelNachweisAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(MispelNachweisAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        return ResponseEntity.status(e.status()).contentType(MediaType.APPLICATION_JSON).body(body);
    }

    private static List<String> liste(String json) {
        if (json == null) {
            return List.of();
        }
        try {
            return JSON.readValue(json, new TypeReference<List<String>>() {});
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * Die Werte des Nachweises sind ungerundete Brüche („5000“, „1/3“, Vertrag Regel vergleich); für die Anzeige auf
     * drei Nachkommastellen (kWh bzw. kW). Der Nachweis selbst bleibt ungerundet.
     */
    static Map<String, BigDecimal> zahlen(String json) {
        Map<String, BigDecimal> out = new LinkedHashMap<>();
        if (json == null) {
            return out;
        }
        Map<String, Object> roh;
        try {
            roh = JSON.readValue(json, new TypeReference<LinkedHashMap<String, Object>>() {});
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
        roh.forEach((k, v) -> out.put(k, v == null ? null : zahl(String.valueOf(v))));
        return out;
    }

    static BigDecimal zahl(String text) {
        int strich = text.indexOf('/');
        BigDecimal z = strich < 0 ? new BigDecimal(text)
                : new BigDecimal(text.substring(0, strich)).divide(new BigDecimal(text.substring(strich + 1)),
                        MathContext.DECIMAL128);
        return z.setScale(3, RoundingMode.HALF_UP).stripTrailingZeros();
    }
}
