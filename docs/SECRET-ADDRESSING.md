# Secret addressing: the design six issues are waiting on

Status: **design, not yet implemented.** Written after PRs #61, #65 and #69, which
between them produced forty-odd verified review findings in this area and three
withdrawals. Everything here is a constraint those rounds established the hard way; the
point of the document is that the next attempt starts from them instead of rediscovering
them.

Blocked on this: #56, #62, #66, #67, #68, #70.

## The one-sentence diagnosis

`SecretPolicy` answers two questions badly, and every one of the six issues is one of
them:

1. **"Is this value a credential?"** — answered by asking the *widget manifest* whether a
   *top-level property* is typed `secret`.
2. **"Which stored value belongs to this slot?"** — answered by guessing from an instance
   id the client may have invented, falling back to position.

Question 1 needs an address (`slot`, `property`, and sometimes `row`/`field`) and an
*intent*, not a type name. Question 2 needs the client to stop inventing identities the
host has to guess about.

They are two designs. They meet at exactly one point — addresses are keyed by slot
identity — so they are designed together and implemented identity-first.

---

## Part A — the redaction plan

### Why the manifest is the wrong carrier

| Issue | What breaks | Why a manifest cannot say it |
| --- | --- | --- |
| #62 | credential at `endpoints[3].apiKey` | a manifest classifies a *property*, and the value is inside a list row |
| #66 | property demoted `secret` → `text`, stored value still ciphertext | manifest classification carries **read and write** semantics inseparably; three fixes in PR #65 each traded the display bug for data loss or an uneditable field |
| #67 | two folders declare the same widget id, one refused | one snapshot entry cannot represent two widgets; every merge rule was wrong in some direction |

The recurring shape: the host **knows** exactly which slot and which key holds the
credential. Expressing that knowledge through a per-widget artifact is what manufactures
the ambiguity.

### The vehicle

```csharp
readonly record struct SecretAddress(
    string Slot,        // the resolved slot key — see Part B
    string Property,
    int? Row = null,    // list index, when the value lives in a row
    string? Field = null);

enum SecretIntent
{
    Protect,             // today's `secret`: mask, encrypt on save, decrypt for the dashboard
    RedactOnly,          // mask and restore, never encrypt, never decrypt
    RestoreIfUntouched,  // blank on the way out; put back only if it came back unchanged
}

sealed record SecretPlanEntry(SecretAddress Address, SecretIntent Intent);

sealed class SecretPlan
{
    public static SecretPlan For(
        DashboardLayout layout,
        Func<string, WidgetManifest?> lookup,
        IReadOnlyList<RejectedWidget> rejected);
}
```

`Mask`, `Seal` and `Reveal` take a `SecretPlan` instead of a manifest lookup. That is the
whole change; the intents below are what the three current problems each need.

### The three intents

**`Protect`** is today's behaviour, unchanged, from `Properties[type == "secret"]`.

**`RedactOnly`** is for a value the host must keep out of the editor but has no manifest
authority over: a refused widget's credential (#62, #67). Mask blanks it, Seal restores it
verbatim, and nothing ever encrypts or decrypts it — the host does not know it is a
credential, only that a refused manifest *claimed* it was. Crucially the entry is keyed by
`(slot, property)`, so a shadowed duplicate's names apply to that duplicate's slots and
nowhere else. That is precisely the thing #67 proves a manifest cannot express.

**`RestoreIfUntouched`** is #66's demoted secret, and it is the intent that exists to
*separate read semantics from write semantics*. Blank on the way out; on the way in, if
the value is exactly the blank the host wrote, restore the stored node — otherwise take
the user's input verbatim, as ordinary text, with no encryption. That is the property
PR #65 could not get through the manifest: the field stays editable and clearable, because
nothing on the write side treats it as a secret.

Two constraints from probing, both non-obvious:

- **Decryptability, not shape.** `dpapi:v1:YWJj` is a legitimate setting value that
  matches `LooksLikeEnvelope`. Only `CanUnprotect` answers "did *we* write this?"
- **Never plan `RestoreIfUntouched` for a name the current manifest already calls
  `secret`,** or a credential whose plaintext happens to be a locally-created envelope is
  blanked immediately after being decrypted correctly.

### Rows (#62)

`Row` is an index on the mask side, because that is all the editor payload has. On the
seal side an index is not enough: the user may have reordered the list, and restoring by
index would hand row 3's credential to row 1.

Rows are matched by their **non-secret field values** — the row's own visible content is
its identity. When two rows are indistinguishable under that comparison, carry-over is
refused for both and the user re-enters. That is the same posture `SlotKey` already takes
for ambiguous slots, and it is why this is safe to state now: the refusal is the
established answer in this pipeline, not a new policy invented for lists.

### What this deletes

The masked-manifest snapshot machinery — `_maskedManifests`, `_revealedManifests`,
`WithSecretsForced`, `RedactionOnly`, `MergeManifestSnapshot` and its secret-wins union —
exists only because a manifest is the wrong carrier and the host has to fabricate one that
says what it means. A plan is directly serializable, directly addressable, and can be
captured verbatim. All of it goes.

---

## Part B — the identity protocol

### The rule

**A client must never invent an identity the host has to guess about.**

| Issue | Symptom |
| --- | --- |
| #68 | client mints an id; host cannot tell "same slot, new id" from "different slot" |
| #70 | host mints an id; `DashboardWindow` never tells the shell, so the two disagree |
| #56 (1) | minted ids applied by stale page/slot index; the wrong slot is stamped |
| #56 (3) | minting replaces the positional `uniqueId`, orphaning widget-local storage |

#68 is the sharp one, and PR #69 established why no lookup rule can fix it. These two
sequences produce **byte-identical payloads**:

1. the shell mints an id for a legacy slot on its first on-panel edit;
2. the user deletes the sole credentialed tile and adds a fresh instance of the same
   widget.

Both: stored id-less with a credential, incoming id-bearing, one instance on each side,
same position. Any carry-over rule that serves (1) also serves (2) — handing a deleted
instance's token to a tile the user believes is unconfigured, which then transmits it to
whatever endpoint the new tile points at. The information needed to separate them does not
exist in the payload. It exists only in the client.

### Two options, and the pick

**Option 1 — the client declares provenance.** Each submitted slot carries what the client
believes its identity was when the host last sent it:

```jsonc
{ "widgetId": "…", "instanceId": "s3f2…",
  "prior": { "instanceId": null, "page": 0, "slot": 1 } }   // "I minted this for that slot"
```

A freshly added tile sends `"prior": null` — which is exactly the evidence #68 is missing.

**Option 2 — only the host mints.** Clients never invent ids; the host stamps on save and
hands them back. Closes #70 by construction and #68 by removing the client mint.

**Pick option 1.** Option 2 fights a real client need: `shell.js` mints because a running
widget needs a `uniqueId` for its local-storage keys *immediately*, before any save has
happened, and #56 item 3 records that changing that id afterwards silently orphans widget
state. Option 1 also subsumes #56 item 1 for free — the prior identity *is* the
correlation token that issue asks for, with no new bookkeeping threaded through
`pendingSaves`.

### The trust question, stated rather than buried

`prior` is a claim the host cannot verify. It is worth being explicit that this is
acceptable here and why:

- the client is our own WebView, not third-party content;
- the claim is still subject to every existing check — the `widgetId` must match, and
  ambiguous cases still refuse;
- so the worst a wrong claim can do is move a credential between slots of the *same
  widget* within the same layout, which is the blast radius that already exists today.

It would **not** be acceptable if widget iframes could forge it. They cannot reach the
save channel; if that ever changes, this decision has to be revisited, which is the reason
it is written down here rather than assumed.

### Also required

`DashboardWindow.save-layout` must hand `SecretSealResult.Minted` back to the shell, the
way `SettingsWindow` already does, and `shell.js` must adopt the ids. That is #70, and it
is the same channel — once identity flows both ways, both halves are the same feature.

---

## Sequencing

1. **The plan as a pure vehicle.** Introduce `SecretPlan` with only `Protect`, and thread
   it through `Mask`/`Seal`/`Reveal`. Zero behaviour change — proven by every existing
   probe passing unmodified. This is the load-bearing refactor; everything else is a small
   addition on top of it.
2. **Identity protocol** (Part B) — closes #68, #70, #56 items 1 and 3.
3. **`RedactOnly`** — closes #67, and #62's classification half.
4. **`RestoreIfUntouched`** — closes #66.
5. **Row addressing** — closes #62's remaining half.

Identity comes before the intents because addresses are keyed by slot identity, and
because two PRs have now failed on exactly that ordering being implicit.

## Rules carried forward

Learned at cost on #61, #65 and #69; they apply to every step above.

- **Falsify every probe.** Revert the fix, confirm the probe *fails*, restore it. A probe
  that passes both ways proves nothing — PR #69's `P31i` asserted a stamp that a later
  branch was making anyway, and passed with the fix removed.
- **Identity comparers are ordinal everywhere.** `Rescan` resolves duplicates ordinally,
  so `Foo` and `foo` are two widgets, and every consumer must agree. Two separate findings
  came from one consumer disagreeing.
- **Check every consumer of a piece of data before changing it.** Three findings in this
  area were "there is another consumer I did not check" — #70 is literally that.
- **When a mechanism produces findings round after round, the mechanism is the finding.**
  Withdraw and file rather than patch again.
- **Where identity cannot be established, refuse and let the user re-enter.** Losing a
  credential is recoverable by retyping it; transmitting an old one to a new endpoint is
  not.
