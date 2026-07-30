using System.Text.RegularExpressions;

namespace WaveshareWidgets.Widgets;

/// <summary>Does a property name denote a credential? The install-time half of the rule
/// that <c>tools/validate-widget.js</c> enforces at build time (issue #57).
///
/// Two implementations exist because they run at different moments: the Node validator
/// is a build tool an author can skip, and the install path has to hold the line for a
/// package nobody on this project ever compiled. They are kept honest by a shared
/// fixture — <c>tools/credential-names.json</c> — which BOTH are checked against in CI
/// (<c>--self-test</c> here, <c>tools/CredentialRule</c> for this file). Change the
/// fixture first; a rule that drifts silently is worse than no rule, because the
/// validator would refuse a widget the host then installs anyway.
///
/// Every regex below is a direct port. Keep them in step, comments included.</summary>
public static partial class CredentialNames
{
    // camelCase and PascalCase count — `apiToken`, `clientSecret`, `githubPAT`,
    // `APIToken` are the COMMON spellings, so the name is split at case boundaries
    // before matching. The trailing `s?` exists because `credential` matched and
    // `credentials` did not; it cannot swallow the boundary cases, since the character
    // after the optional s must still end the word (`passwordless`, `secretary`,
    // `tokenizer` all stay innocent).
    [GeneratedRegex(@"(^|[^a-z0-9])(token|secret|password|passwd|api ?key|bearer|pat|credential|private ?key|access ?key|authorization|auth ?header|jwt|pass ?phrase)s?([^a-z0-9]|$)", RegexOptions.IgnoreCase)]
    private static partial Regex CredentialWord();

    // Credential-equivalent URLs (WIDGET-SPEC: "a private ICS or webhook link"). A
    // webhook URL IS the credential — anyone holding it can post. But most url
    // properties are public (iframe and youtube both ship one), so a bare
    // url/link/endpoint is never enough on its own.
    [GeneratedRegex(@"(^|[^a-z0-9])web ?hook([^a-z0-9]|$)", RegexOptions.IgnoreCase)]
    private static partial Regex Webhook();

    [GeneratedRegex(@"web ?hook$", RegexOptions.IgnoreCase)]
    private static partial Regex WebhookValue();

    // All-lowercase compounds have no case boundary to split on and no word boundary to
    // match. Anchored at the END: unanchored, `userKeyboardLayout` squashes to
    // `userkeyboardlayout`, matches `userkey`, and fails a keyboard-layout select.
    [GeneratedRegex(@"(api|client|access|auth|refresh|session|bearer|private|user|admin|service|oauth)(token|secret|key|password|passwd)s?$", RegexOptions.IgnoreCase)]
    private static partial Regex Compound();

    // A url/link/endpoint is the credential only when the name denotes the VALUE:
    // `privateIcsUrl` holds it, `signedUrlExpiry` holds a duration.
    [GeneratedRegex(@"(url|uri|link|endpoint|address|feed)$", RegexOptions.IgnoreCase)]
    private static partial Regex UrlValue();

    [GeneratedRegex(@"(^|[^a-z0-9])(url|uri|link|endpoint|address|feed)([^a-z0-9]|$)", RegexOptions.IgnoreCase)]
    private static partial Regex Urlish();

    [GeneratedRegex(@"(^|[^a-z0-9])(private|secret|signed|personal|sas)([^a-z0-9]|$)", RegexOptions.IgnoreCase)]
    private static partial Regex SecretQualifier();

    // A name ENDING in one of these describes something ABOUT a credential rather than
    // holding one: `tokenEndpoint` is a public OAuth URL, `tokenExpiry` a duration,
    // `accessTokenType` a string like "Bearer". Without this an ordinary OAuth widget is
    // refused at install unless it declares a public URL as `secret`, which would be a
    // lie. Only the credential-WORD rules are waived; the webhook and signed-URL rules
    // still run, because `webhookEndpoint` genuinely IS the credential.
    // Deliberately tight: every entry must be a word that cannot itself hold the secret.
    // `value`, `url` and `name` are absent for that reason.
    [GeneratedRegex(@"(^|[^a-z0-9])(endpoints?|expiry|expires|expiration|ttl|lifetime|type|label|format|algorithm|issuer|scopes?|count|prefix|enabled)$", RegexOptions.IgnoreCase)]
    private static partial Regex MetadataTail();

    [GeneratedRegex(@"([A-Z]+)([A-Z][a-z])")] private static partial Regex AcronymThenWord();
    [GeneratedRegex(@"([a-z0-9])([A-Z])")] private static partial Regex WordThenWord();
    [GeneratedRegex(@"[_\-.]+")] private static partial Regex Separators();
    [GeneratedRegex(@"\s+")] private static partial Regex Whitespace();

    /// <summary>True when this property name denotes a credential, and so must be
    /// declared <c>type: "secret"</c> rather than stored as plaintext.</summary>
    public static bool LooksLikeCredential(string? name)
    {
        // Two case boundaries, because initialisms are everywhere in this domain:
        //   acronym->word  "APIToken" -> "API Token"
        //   word->Word     "apiToken" -> "api Token", "githubPAT" -> "github PAT"
        // Separators join in, and the squashed form is tried too so a two-word spelling
        // of a one-word keyword ("access key" -> "accesskey") still matches. Word
        // boundaries keep the squashed pass honest: "compatMode" does NOT match "pat".
        var spaced = AcronymThenWord().Replace(name ?? "", "$1 $2");
        spaced = WordThenWord().Replace(spaced, "$1 $2");
        spaced = Separators().Replace(spaced, " ");
        var squashed = Whitespace().Replace(spaced, "");

        var trimmed = spaced.Trim();
        // Metadata about a credential is not the credential; see MetadataTail.
        if (!MetadataTail().IsMatch(trimmed))
        {
            if (CredentialWord().IsMatch(spaced) || CredentialWord().IsMatch(squashed)) return true;
            if (Compound().IsMatch(squashed)) return true;
        }
        if (Webhook().IsMatch(spaced) && (Urlish().IsMatch(spaced) || WebhookValue().IsMatch(trimmed))) return true;
        return Urlish().IsMatch(spaced) && SecretQualifier().IsMatch(spaced) && UrlValue().IsMatch(trimmed);
    }
}
