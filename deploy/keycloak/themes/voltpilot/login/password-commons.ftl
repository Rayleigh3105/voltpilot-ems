<#--
  "Von anderen Geraeten abmelden" im Haus-Kleid.

  Ueberschreibt keycloak.v2s Fassung nur, um die PatternFly-Checkbox durch die
  eigene .vpl-check zu ersetzen - Name, Wert und Vorbelegung bleiben exakt
  gleich, sonst wuerde die Aktion etwas anderes tun.
-->
<#macro logoutOtherSessions>
    <label class="vpl-check" for="logout-sessions">
        <input type="checkbox" id="logout-sessions" name="logout-sessions" value="on" checked>
        <span>${msg("logoutOtherSessions")}</span>
    </label>
</#macro>
