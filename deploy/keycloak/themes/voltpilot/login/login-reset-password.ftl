<#--
  Passwort vergessen - VORBEREITET, heute nicht erreichbar.

  Der Realm hat resetPasswordAllowed=false, weil es keinen SMTP-Versand gibt;
  login.ftl zeigt statt eines Links den Support-Hinweis. Sobald der Versand
  existiert, reicht ein Realm-Schalter - diese Seite steht schon.

  Der Bestaetigungstext (emailInstruction) verraet bewusst NICHT, ob es das
  Konto gibt (Enumerations-Schutz); er kommt von Keycloak und wird im
  info-Abschnitt der Karte gerendert.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayInfo=true displayMessage=!messagesPerField.existsError('username'); section>
<!-- template: login-reset-password.ftl (voltpilot) -->
    <#if section = "header">
        ${msg("emailForgotTitle")}
    <#elseif section = "hint">
        <p class="vpl-hint">${msg("vpResetHint")}</p>
    <#elseif section = "form">
        <form id="kc-reset-password-form" class="vpl-form" action="${url.loginAction}" method="post" novalidate="novalidate">
            <#assign label>
                <#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if>
            </#assign>
            <div class="vpl-field">
                <label class="vpl-label" for="username">${label}</label>
                <input class="vpl-input" id="username" name="username" type="text"
                       value="${(auth.attemptedUsername!'')}" inputmode="email"
                       autocomplete="username" autocapitalize="none" spellcheck="false"
                       autofocus enterkeyhint="go"
                       aria-invalid="${messagesPerField.existsError('username')?string('true','false')}" />
            </div>
            <button type="submit" class="vpl-submit" data-vp-busy="${msg("vpSending")}">
                <span class="vpl-spin" hidden aria-hidden="true"></span>
                <span class="vpl-submit-label">${msg("vpResetSubmit")}</span>
            </button>
            <p class="vpl-note"><a class="vpl-link" href="${url.loginUrl}">${msg("backToLogin")}</a></p>
        </form>
    <#elseif section = "info">
        <#if realm.duplicateEmailsAllowed>${msg("emailInstructionUsername")}<#else>${msg("emailInstruction")}</#if>
    </#if>
</@layout.registrationLayout>
