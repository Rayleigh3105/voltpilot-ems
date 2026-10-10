package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.web.dto.BewertungKriterienDto.Kriterium;
import java.io.IOException;
import java.math.BigDecimal;
import java.util.List;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

/** Startwerte aus genau dem verpackten NW-1-Vertrag, keine zweite Zahlentabelle. */
@Component
public class BewertungKriterienVertrag {
    private final ObjectNode startwerte;
    public BewertungKriterienVertrag(ObjectMapper json) throws IOException {
        try (var in = new ClassPathResource("uems/bewertung-vectors.json").getInputStream()) {
            startwerte = (ObjectNode) json.readTree(in).required("startwerte");
        }
    }
    public ObjectNode vorgabe() { return startwerte.deepCopy(); }

    /** Auch nach JSONB-Lesen dieselbe Reihenfolge und dieselben JSON-Zahlentypen wie im Vertrag. */
    public ObjectNode ordnen(JsonNode werte) {
        ObjectNode result = startwerte.objectNode();
        startwerte.fieldNames().forEachRemaining(k -> result.set(k, werte.get(k)));
        return result;
    }
    public ObjectNode pruefen(JsonNode werte) {
        if (werte == null || !werte.isObject() || werte.size() != startwerte.size()) throw ungueltig();
        var felder = startwerte.fieldNames();
        while (felder.hasNext()) {
            String key = felder.next();
            JsonNode wert = werte.get(key);
            boolean monate = startwerte.get(key).isIntegralNumber();
            if (wert == null || (monate ? !wert.isIntegralNumber() || !wert.canConvertToInt() : !wert.isTextual()))
                throw ungueltig();
            if (!monate && !wert.textValue().matches("(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?")) throw ungueltig();
            BigDecimal zahl;
            try { zahl = new BigDecimal(wert.asText()); }
            catch (NumberFormatException ex) { throw ungueltig(); }
            if (zahl.signum() < 0 || (monate && zahl.signum() == 0)
                    || (!monate && !key.equals("K3") && zahl.compareTo(BigDecimal.valueOf(100)) > 0)) throw ungueltig();
        }
        if (werte.get("mindest_monate").intValue() > werte.get("K7").intValue()) throw ungueltig();
        return ordnen(werte);
    }
    public List<Kriterium> kriterien(JsonNode w) {
        return List.of(new Kriterium("K1",w.get("K1"),"%",">="),
                new Kriterium("K2",w.get("K2"),"%","kumuliert bis"),
                new Kriterium("K3",w.get("K3"),"kWh",">="),
                new Kriterium("K4",null,null,null),
                new Kriterium("K5",w.get("K5"),"%",">="),
                new Kriterium("K6",w.get("K6"),"%","<="),
                new Kriterium("K7",w.get("K7"),"Monate","="),
                new Kriterium("K8",w.get("K8"),"%",">="));
    }
    private static BewertungKriterienAbgelehnt ungueltig() {
        return new BewertungKriterienAbgelehnt(422,"kriterien_ungueltig",
                "Bitte prüfen Sie die Schwellen: Prozentwerte von 0 bis 100, nichtnegative Mengen und volle Monate.");
    }
}
