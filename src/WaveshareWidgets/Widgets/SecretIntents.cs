namespace WaveshareWidgets.Widgets;

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
    /// <summary>The value is blanked for the editor and encrypted on its way to disk.
    /// <c>Mask</c>, <c>Seal</c> and the stored index act on exactly this set.</summary>
    public static bool Protects(SecretIntent intent) =>
        intent is SecretIntent.Protect or SecretIntent.ProtectWithoutReveal;

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
    /// The <c>a == b</c> arm keeps this total for members that do not exist yet, and
    /// tools/SecretRoundTrip walks <c>Enum.GetValues</c> so a third intent has to be
    /// placed in this ordering deliberately rather than defaulting into it.</summary>
    public static SecretIntent MostProtective(SecretIntent a, SecretIntent b)
    {
        if (a == b)
            return a;
        return a is SecretIntent.ProtectWithoutReveal || b is SecretIntent.ProtectWithoutReveal
            ? SecretIntent.ProtectWithoutReveal
            : SecretIntent.Protect;
    }
}
