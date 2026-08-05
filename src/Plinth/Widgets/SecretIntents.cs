namespace Plinth.Widgets;

/// <summary>What each <see cref="SecretIntent"/> entitles the pipeline to do, and which
/// intent wins when two sources classify the same address.
///
/// Pure and dependency-free on purpose, because two of the three answers are security
/// decisions and one of them has an attacker on the other side of it:
///
/// <list type="bullet">
/// <item>"May this value be decrypted into a payload a widget iframe can read?" —
///   <see cref="Reveals"/>.</item>
/// <item>"Two folders declare the same widget id and classify the same property
///   differently; which classification applies?" — <see cref="MostProtective"/>. The
///   loaded half of that pair is written by whoever wrote the folder that loaded (#67,
///   #104), so this must not be a rule an attacker can win.</item>
/// </list>
///
/// Naming them here is also what makes adding an intent safe. Before this, all three
/// questions were spelled <c>intent is not SecretIntent.Protect</c> at five call sites, so
/// a second enum member switched every one of them off at once — Mask would stop blanking
/// and Seal would stop encrypting, silently, in the same change that was meant to protect
/// something more.</summary>
public static class SecretIntents
{
    /// <summary>The value is ENCRYPTED on its way to disk, and treated as a credential by
    /// the stored index. <c>Seal</c>'s cipher branches act on exactly this set.
    ///
    /// <see cref="SecretIntent.RestoreIfUntouched"/> is deliberately outside it. That
    /// value is blanked for a payload exactly as these are — see <see cref="Withholds"/> —
    /// but the manifest now calls the property ordinary, so encrypting what the user types
    /// into it would be the pipeline overriding the manifest it is supposed to obey.
    /// Separating read semantics from write semantics is the entire point of that intent;
    /// folding it in here would weld them back together.</summary>
    public static bool Protects(SecretIntent intent) =>
        intent is SecretIntent.Protect or SecretIntent.ProtectWithoutReveal;

    /// <summary>The value is kept OUT of a payload — blanked for the editor by <c>Mask</c>
    /// and for the dashboard by <c>Reveal</c>.
    ///
    /// Every intent withholds something; only <see cref="SecretIntent.Protect"/> hands the
    /// real value back, and it does so by decrypting rather than by passing the stored one
    /// through. So this is "every intent", and it is written as an explicit set anyway
    /// because the next member added might not be — a reader should have to state which
    /// side of this line a new intent falls on rather than inherit it from a default.
    ///
    /// Whether a given VALUE is actually blanked is a second question with a second
    /// answer, because blanking is only safe where the value can be put back. That part
    /// is not here: it depends on the slot and the stored bytes, not on the intent.</summary>
    public static bool Withholds(SecretIntent intent) =>
        intent is SecretIntent.Protect
            or SecretIntent.ProtectWithoutReveal
            or SecretIntent.RestoreIfUntouched;

    /// <summary>The value is decrypted into the dashboard payload. <c>Reveal</c> acts on
    /// exactly this set, and it is deliberately SMALLER than <see cref="Protects"/>:
    /// <see cref="SecretIntent.ProtectWithoutReveal"/> earns its name here and nowhere
    /// else.</summary>
    public static bool Reveals(SecretIntent intent) =>
        intent is SecretIntent.Protect;

    /// <summary>The intent that applies when two sources classify one address.
    ///
    /// <see cref="SecretIntent.ProtectWithoutReveal"/> is the ceiling: it does everything
    /// <see cref="SecretIntent.Protect"/> does and withholds the reveal on top. That
    /// ordering is not a preference, it is the fix for #104 — the loaded manifest in a
    /// duplicate-id pair may be the hostile one, and if <c>Protect</c> could win, an
    /// attacker would only have to declare the shadowed widget's credential name
    /// <c>secret</c> in their own manifest to have the host decrypt it into their iframe.
    ///
    /// The cost is stated in docs/SECRET-ADDRESSING.md and is real: a loaded widget's own
    /// credential stops being revealed to it if a shadowing refused copy names the same
    /// property. That needs two folders, an ordinally identical id, one of each kind and a
    /// colliding name, and the user's fix is to remove the refused folder. Losing a
    /// credential is recoverable by retyping it; handing one to a widget that should not
    /// have it is not.
    ///
    /// The full ordering is <c>RestoreIfUntouched &lt; Protect &lt; ProtectWithoutReveal</c>.
    /// The floor matters as much as the ceiling: <c>RestoreIfUntouched</c> does not encrypt,
    /// so planning it for a name the manifest still calls <c>secret</c> would blank a
    /// credential immediately after decrypting it correctly, and save the blank. It loses
    /// every collision, which the fallback below already does for it — a pair containing
    /// neither <c>ProtectWithoutReveal</c> resolves to <c>Protect</c>.
    ///
    /// The <c>a == b</c> arm keeps this total for members that do not exist yet. Placement
    /// is forced by <c>P35x</c> in tools/SecretRoundTrip, which holds the rank table this
    /// paragraph describes and cross-checks it against this function for every pair. The
    /// idempotence/commutativity/closure probes beside it do NOT force placement — any
    /// sane function satisfies them, including one that has never heard of a new member.
    /// </summary>
    public static SecretIntent MostProtective(SecretIntent a, SecretIntent b)
    {
        if (a == b)
            return a;
        return a is SecretIntent.ProtectWithoutReveal || b is SecretIntent.ProtectWithoutReveal
            ? SecretIntent.ProtectWithoutReveal
            : SecretIntent.Protect;
    }
}
