<#--
  VoltPilot login page (Login-Screen Stufe 1, Konzept data/vp-login-screen-k3).

  Die Karte selbst kommt aus template.ftl; hier steht nur ihr Inhalt. Vier
  Entscheidungen, die man beim Anfassen kennen muss:

  1. DIE FEHLERMELDUNG HAENGT AM PASSWORTFELD. `displayMessage` ist bei einem
     Feldfehler false (die Karte zeigt dann keinen globalen Kasten), und der
     Text steht per aria-describedby am Feld - so liest ihn eine Vorlesesoftware
     mit dem Feld zusammen. Keycloak meldet falsche Zugangsdaten bewusst
     GENERISCH, auch bei einer Brute-Force-Sperre (keine Konten-Enumeration);
     der "zu viele Versuche"-Hinweis darf nur von der Portal-Karte kommen, die
     die Sperre wirklich kennt (429). Deshalb steht hier nichts davon.

  2. DER PASSWORT-UMSCHALTER IST EIN WORT ("Anzeigen"/"Verbergen"), kein
     Font-Awesome-Auge - genau wie im Portal-Registrierungsformular. Er steht
     im DOM NACH dem Feld und wird optisch per Grid in die Label-Zeile gehoben:
     so laeuft Tab Benutzername -> Passwort -> Anzeigen -> Anmelden.
     ⚠ Er traegt bewusst NICHT die kcFormPasswordVisibilityButtonClass - das
     eingebaute passwordVisibility.js von keycloak.v2 wuerde ihn sonst ein
     zweites Mal verdrahten.

  3. `#kc-form-login` MUSS bleiben: js/register-link.js haengt den
     "Konto erstellen"-Link direkt dahinter ein (die Selbstregistrierung ist
     eine PORTAL-Route, kein Keycloak-Formular).

  4. `usernameHidden` = Re-Authentifizierung. Das Konto steht dann fest (die
     Zeile dazu rendert template.ftl), gefragt wird nur das Passwort - also
     traegt die Karte auch einen anderen Titel.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=false; section>
<!-- template: login.ftl (voltpilot) -->

    <#if section = "header">
        <#if usernameHidden??>${msg("vpReauthTitle")}<#else>${msg("loginAccountTitle")}</#if>
    <#elseif section = "hint">
        <p class="vpl-hint"><#if usernameHidden??>${msg("vpReauthHint")}<#else>${msg("vpLoginHint")}</#if></p>
    <#elseif section = "form">
        <#if realm.password>
        <form id="kc-form-login" class="vpl-form" onsubmit="return true;" action="${url.loginAction}" method="post" novalidate="novalidate">
            <#assign hasError = messagesPerField.existsError('username','password')>

            <#if !usernameHidden??>
                <#assign userLabel>
                    <#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if>
                </#assign>
                <div class="vpl-field">
                    <label class="vpl-label" for="username">${userLabel}</label>
                    <input class="vpl-input" id="username" name="username" type="text"
                           value="${(login.username!'')}"
                           inputmode="email" autocomplete="username" autocapitalize="none"
                           autocorrect="off" spellcheck="false" enterkeyhint="next"
                           autofocus aria-invalid="${hasError?string('true','false')}" />
                </div>
            </#if>

            <#-- ⚠ Der Umschalter steht NACH dem Feld (Tab: Passwort -> Anzeigen);
                 optisch hebt ihn `.vpl-field.has-toggle` per Grid in die
                 Label-Zeile. Reihenfolge im Markup NICHT umdrehen. -->
            <div class="vpl-field has-toggle">
                <label class="vpl-label" for="password">${msg("password")}</label>
                <input class="vpl-input" id="password" name="password" type="password"
                       autocomplete="current-password" enterkeyhint="go"
                       <#if usernameHidden??>autofocus</#if>
                       aria-invalid="${hasError?string('true','false')}"
                       <#if hasError>aria-describedby="vp-login-error"</#if> />
                <button type="button" class="vpl-toggle" id="vp-pw-toggle"
                        data-vp-toggle="password"
                        data-vp-show="${msg("vpShow")}" data-vp-hide="${msg("vpHide")}"
                        aria-controls="password" aria-pressed="false">${msg("vpShow")}</button>
                <#if hasError>
                    <p class="vpl-error" id="vp-login-error">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
                        <span>${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}</span>
                    </p>
                </#if>
            </div>

            <#if realm.rememberMe && !usernameHidden??>
                <label class="vpl-check">
                    <input id="rememberMe" name="rememberMe" type="checkbox" <#if login.rememberMe??>checked</#if>>
                    ${msg("rememberMe")}
                </label>
            </#if>

            <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>

            <button type="submit" class="vpl-submit" name="login" id="kc-login"
                    data-vp-busy="${msg("vpSigningIn")}">
                <span class="vpl-spin" hidden aria-hidden="true"></span>
                <span class="vpl-submit-label"><#if usernameHidden??>${msg("vpReauthSubmit")}<#else>${msg("doLogIn")}</#if></span>
            </button>
        </form>

        <#if realm.resetPasswordAllowed>
            <p class="vpl-note"><a class="vpl-link" href="${url.loginResetCredentialsUrl}">${msg("doForgotPassword")}</a></p>
        <#else>
            <#-- Ohne SMTP gibt es keine Selbstbedienung; Support setzt das
                 Passwort ueber die Benutzer-Seite der Admin-Konsole zurueck. -->
            <p class="vpl-note vpl-note-muted">${msg("vpForgotSupport")}</p>
        </#if>

        <ul class="vpl-trust">
            <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>${msg("vpTrustEncrypted")}</li>
            <li>${msg("vpTrustServers")}</li>
            <li>${msg("vpTrustDsgvo")}</li>
        </ul>
        </#if>
    </#if>

</@layout.registrationLayout>
