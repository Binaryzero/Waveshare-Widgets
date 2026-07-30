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

The recurring shape: what the host needs to say is "*this value*, at this address, gets
this treatment". A per-widget artifact cannot say it, so today the host fabricates
manifests that approximate it — and the approximation is what breaks.

**One thing the plan does not fix, and must not claim to.** In #67's duplicate-id case the
host cannot tell which folder produced a given slot: `LayoutSlot` persists `widgetId` and
`instanceId` only, both duplicates share the first, and the second identifies an instance
rather than a manifest. So if the loaded and refused manifests both declare `apiToken` —
one as `text`, one as `secret` — no per-slot key resolves which one this slot's value
belongs to. Address alone is not provenance.

The answer is not to invent provenance but to **refuse the ambiguity in the safe
direction**: intents from every manifest sharing an id are unioned, most-protective wins.
The value is then masked and re-encrypted even when the loaded widget considers it
ordinary. That is the existing secret-wins collision rule, applied where it already
belongs, and it needs no new persisted state.

It has a real cost, stated so nobody discovers it as a bug: a loaded widget's ordinary
setting that happens to share a name with a shadowing refused widget's credential becomes
redacted in the editor. Narrow — it needs two folders with an ordinally identical id, one
of each kind, and a colliding property name — and the alternative is leaking a credential
to a WebView that hosts real widget iframes.

### The vehicle

```csharp
readonly record struct SecretAddress(
    string Slot,        // the resolved slot key — see Part B
    string Property,
    int? Row = null,    // list index, when the value lives in a row
    string? Field = null);

enum SecretIntent
{
    Protect,               // today's `secret`: mask, encrypt on save, decrypt for the dashboard
    ProtectWithoutReveal,  // mask and encrypt exactly as Protect; never decrypt into a payload
    RestoreIfUntouched,    // blank on the way out; put back only if it came back untouched
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

**`ProtectWithoutReveal`** is for a refused widget's credential (#62, #67). It masks and
**encrypts exactly like `Protect`** — that matters, because a refused widget's credential
is typically legacy plaintext and today's redaction stand-in already encrypts it on the
next save. `P27e`/`P27f` assert precisely that ("it is now encrypted at rest, which the
refusal alone never achieved"), so an intent that restored the value verbatim without
encrypting would leave a readable credential on disk indefinitely and regress a shipped
guarantee. The only thing it withholds is the reveal: a refused widget is not loaded, so
nothing legitimate is waiting to receive the plaintext, and putting it in a dashboard
payload would be handing it out for no purpose.

What the plan actually buys here is not a weaker intent — it is being able to carry the
entry **at all**, per address, without fabricating a manifest to say it.

**`RestoreIfUntouched`** is #66's demoted secret, and it exists to *separate read
semantics from write semantics*: blank on the way out, restore on the way in if untouched,
otherwise save the user's text verbatim with no encryption.

"Untouched" cannot be inferred from the value. `EditorPlaceholder` is `""`, and a demoted
property renders as an ordinary text input, which also sends `""` when the user clears it.
Comparing against the blank alone would restore the old ciphertext over a deliberate
clear, making the field impossible to empty — which is the *same* "permanently uneditable
field" failure this document cites PR #65 for hitting. So the intent needs an explicit
signal, and the machinery already exists: `Mask` lists these addresses in a
projection-only marker beside `secretsSet`, the editor emits `SecretStore.ClearMarker` for
them exactly as the secret editor does, and `Seal` reads three distinct cases — `""` is
untouched (restore), `ClearMarker` is cleared (remove), anything else is new text (save
verbatim).

Two further constraints from probing, both non-obvious:

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

`prior` is a claim the host cannot verify, and the whole design rests on only the shell
being able to make it. An installed widget is third-party code, so "only the shell can
post `save-layout`" has to be an established fact rather than an assumption. What the
source actually shows, as three independent barriers:

1. **Widget frames are cross-origin with the shell.** Every widget is mapped to its own
   virtual host (`{slug}.widgets.wsw` in `WidgetLibrary`), while the shell runs on
   `app.wsw`. The `allow-same-origin` in the frame sandbox preserves the *widget's* own
   origin — it does not make it the shell's — so `parent.chrome.webview` is blocked by
   same-origin policy.
2. **`DashboardWindow` subscribes to `CoreWebView2.WebMessageReceived`,** which WebView2
   documents as raised for the **top-level document**. Frame messages surface on
   `CoreWebView2Frame.WebMessageReceived`, which requires a `FrameCreated` subscription.
3. **There is no `FrameCreated` handler anywhere in the app,** so even the frame-level
   channel has nothing listening.

Three barriers is comfortable, but note what is missing: `OnWebMessageReceived` dispatches
on the payload's `type` and never inspects `e.Source`. Every barrier above is a property
of the *hosting configuration*, so any of them could be relaxed by a future change — a
shared virtual host for widget assets, a `FrameCreated` subscription added for some other
feature — without anyone noticing that this design's trust boundary moved with it.

Checking `e.Source` costs nothing and would make the boundary explicit at the point that
depends on it. It is filed rather than done here because it changes the dashboard's only
message channel, and this environment cannot exercise WebView2 to prove a mistaken origin
check does not silently mute the whole shell. **That hardening should land before the
identity protocol does**, so `prior` is trusted for a checked reason rather than a
configurational accident.

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
2. **Verify the save channel** — check `e.Source` in the dashboard's message handler, so
   step 3 rests on a check rather than on three configurational barriers.
3. **Identity protocol** (Part B) — closes #68, #70, #56 items 1 and 3.
4. **`ProtectWithoutReveal`** — closes #67, and #62's classification half.
5. **`RestoreIfUntouched`** — closes #66.
6. **Row addressing** — closes #62's remaining half.

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
