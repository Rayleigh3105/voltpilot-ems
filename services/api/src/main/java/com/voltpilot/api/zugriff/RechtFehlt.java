package com.voltpilot.api.zugriff;

import com.voltpilot.api.uems.RechteAbleitung.DarfErgebnis;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 403 {@code recht_fehlt} (UEMS AP-03 IP-6, §5.9): das Objekt liegt im Geltungsbereich, die Aktion aber nicht im Recht
 * des Aufrufers. Hier verrät 403 nichts (W2). Der Körper folgt den UEMS-Ablehnungen ({@code code}, {@code message},
 * Fakten): {@code recht} ist die Kennung aus der Matrix, {@code rolle_noetig} die kleinste Rolle, die es dürfte
 * ({@code null} = keine Kundenrolle, etwa beim Unterstützer), {@code umfang_noetig} nur bei einem zu kleinen Umfang
 * einer Unterstützung.
 */
public class RechtFehlt extends RuntimeException {

    public static final String CODE = "recht_fehlt";

    private final String kennung;
    private final transient DarfErgebnis darf;

    public RechtFehlt(String kennung, DarfErgebnis darf) {
        super(darf.text());
        this.kennung = kennung;
        this.darf = darf;
    }

    public String kennung() {
        return kennung;
    }

    public DarfErgebnis darf() {
        return darf;
    }

    public Map<String, Object> koerper() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", CODE);
        body.put("message", darf.text());
        body.put("recht", kennung);
        body.put("rolle_noetig", darf.rolleNoetig() == null ? null : darf.rolleNoetig().code());
        if (darf.umfangNoetig() != null) {
            body.put("umfang_noetig", darf.umfangNoetig().code());
        }
        return body;
    }
}
