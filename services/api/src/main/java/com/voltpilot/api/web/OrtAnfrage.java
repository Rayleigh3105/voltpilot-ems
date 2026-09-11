package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.OrtAbgelehnt;
import com.voltpilot.api.uems.ProtokollAkteur;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/**
 * Liest die Anfragen der Schreibrouten der Ortsstruktur STRENG (Unternehmen, Standort — und
 * mit IP-5 Gebäude/Bereich): ein Feld, das es an der Route nicht gibt, ist 400
 * {@code anfrage_ungueltig} mit {@code feld} — nie still verworfen. Wer an einen Standort
 * schon eine Fläche (IP-5) oder eine Anlage (IP-11) schickt, soll nicht glauben, sie sei
 * gespeichert. Dasselbe Muster wie {@code MessstelleController}.
 */
@Component
public class OrtAnfrage {

    private final ObjectMapper streng;

    public OrtAnfrage(ObjectMapper json) {
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /** Der Urheber des Protokolleintrags; ohne Anmeldung (nur bei abgeschaltetem OIDC) 401. */
    static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** Eine Route ohne Felder (Archivieren): kein Inhalt oder {@code {}} — jedes Feld ist 400. */
    static void leer(JsonNode body) {
        if (body == null || body.isNull() || (body.isObject() && body.isEmpty())) {
            return;
        }
        if (!body.isObject()) {
            throw OrtAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        String feld = body.fieldNames().next();
        throw OrtAbgelehnt.anfrage(feld, "„" + feld + "“ gibt es hier nicht.");
    }

    /** Ein JSON-Objekt in der Form {@code typ}; {@code leerErlaubt}: ohne Inhalt {@code null}. */
    <T> T lies(JsonNode body, Class<T> typ, boolean leerErlaubt) {
        if (leerErlaubt && (body == null || body.isNull())) {
            return null;
        }
        if (body == null || !body.isObject()) {
            throw OrtAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        try {
            return streng.treeToValue(body, typ);
        } catch (UnrecognizedPropertyException e) {
            String feld = pfad(e);
            throw OrtAbgelehnt.anfrage(feld, "„" + feld + "“ gibt es hier nicht.");
        } catch (JsonMappingException e) {
            String feld = pfad(e);
            throw OrtAbgelehnt.anfrage(feld, "„" + feld + "“ hat nicht die erwartete Form.");
        } catch (JsonProcessingException e) {
            throw OrtAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
    }

    /** {@code adresse.plz}, {@code nutzung[1]} — der Weg zum Feld. */
    private static String pfad(JsonMappingException e) {
        StringBuilder s = new StringBuilder();
        for (JsonMappingException.Reference r : e.getPath()) {
            if (r.getFieldName() != null) {
                s.append(s.isEmpty() ? "" : ".").append(r.getFieldName());
            } else if (r.getIndex() >= 0) {
                s.append('[').append(r.getIndex()).append(']');
            }
        }
        return s.toString();
    }
}
