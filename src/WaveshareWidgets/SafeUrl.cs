namespace WaveshareWidgets;

/// <summary>
/// Renders a URL for the log without disclosing it (issue #59).
///
/// WIDGET-SPEC calls a private ICS or webhook link credential-equivalent: the URL *is*
/// the credential, since anyone holding it can read or post. The host's success paths
/// already logged only <c>uri.Host</c> for that reason — and then the failure paths
/// interpolated the whole thing, which is the half that actually repeats. A signed URL
/// against a flaky endpoint wrote its query string into <c>app.log</c> on every failed
/// poll, and <c>app.log</c> is plaintext, is not covered by the DPAPI work in #15, and is
/// the first file a user attaches to a bug report.
///
/// HOST ONLY. Keeping the path was tempting for diagnosis and is not safe: a Slack or
/// Discord webhook carries its secret in the PATH
/// (<c>hooks.slack.com/services/T…/B…/XXXXXXXX</c>), so a rule that dropped only the
/// query would still publish the credential the spec names first. Userinfo
/// (<c>https://user:pass@host</c>) is dropped for the same reason — <see cref="Uri.Host"/>
/// excludes it, which is most of why this is built on Uri rather than on string surgery.
///
/// The port rides along only when it is non-default, because "which of the two services
/// on this box" is real diagnostic value and a port number is not a secret.
/// </summary>
internal static class SafeUrl
{
    /// <summary>What to print when there is nothing safe to say. Deliberately not the
    /// input: the most common reason a URL cannot be parsed is that it is malformed, and
    /// that is precisely the failure path most likely to be carrying a mangled credential
    /// (a token pasted with a stray space, say). Falling back to the raw string would put
    /// the leak back exactly where the exception handler needed it least.</summary>
    private const string Unknown = "(unparseable url)";

    public static string Describe(string? url)
    {
        if (string.IsNullOrWhiteSpace(url))
            return "(no url)";
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return Unknown;
        return Describe(uri);
    }

    public static string Describe(Uri? uri)
    {
        if (uri is null)
            return "(no url)";
        // A relative Uri has no Host to read — IsAbsoluteUri must be checked before any
        // component is touched, or this throws from inside a catch block and replaces a
        // useful error with an unrelated one.
        if (!uri.IsAbsoluteUri)
            return Unknown;
        var host = uri.Host;
        if (string.IsNullOrEmpty(host))
            return Unknown;   // file:///C:/… and mailto: have no host worth naming
        return uri.IsDefaultPort ? host : $"{host}:{uri.Port}";
    }
}
