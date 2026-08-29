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
signal. **It must not be a sentinel value** — that was tried, and step 6 below is the
write-up of why it cannot work. `Mask` lists these addresses in a projection-only marker
beside `secretsSet`, the editor names the ones the user cleared in `secretsCleared` on the
way back, and `Seal` reads three distinct cases — `""` is untouched (restore), a name in
that list is cleared (remove), anything else is new text (save verbatim).

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

`WithSecretsForced` and `RedactionOnly` went with step 4, along with
`SettingsWindow.AddRedactionManifests`. What replaced them is a per-id list of credential
names snapshotted beside the manifests and read straight into the plan — additive on the
settings side for the same reason the manifest union is, because a name that ever masked
a field must still be planned when the save arrives or the blank overwrites the value.

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
   virtual host (`{slug}.widgets.plinth` in `WidgetLibrary`), while the shell runs on
   `app.plinth`. The `allow-same-origin` in the frame sandbox preserves the *widget's* own
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

**Done (#72).** `MessageOrigin.IsShell` now gates both message handlers, so the boundary
is a check rather than an inference. It compares scheme and host only: the host is what
separates the shell from widget frames, which live on different hosts entirely, while
requiring a specific path or port would fail *closed* if the shell ever gained a query
string — dropping every message and leaving the app looking dead, in an environment that
cannot run WebView2 to notice. The predicate is a pure function so `tools/MessageOrigin`
can cover both directions exhaustively; only the one-line wiring rests on inspection.

`prior` is therefore trusted for a checked reason rather than a configurational accident,
which is what the rest of Part B depends on.

### Also required

`DashboardWindow.save-layout` must hand `SecretSealResult.Minted` back to the shell, the
way `SettingsWindow` already does, and `shell.js` must adopt the ids. That is #70, and it
is the same channel — once identity flows both ways, both halves are the same feature.

---

## Sequencing

1. ~~**The plan as a pure vehicle.**~~ **Done.** `SecretPlan` with only `Protect`, threaded
   through `Mask`/`Seal`/`Reveal`. Zero behaviour change, proven by every existing probe
   passing unmodified. This is the load-bearing refactor; everything else is a small
   addition on top of it.
2. ~~**Verify the save channel.**~~ **Done (#72).** `MessageOrigin.IsShell` gates both
   message handlers, so step 3 rests on a check rather than on three configurational
   barriers.
3. **Identity protocol** (Part B) — closes #68, #70, #56 items 1 and 3.
4. ~~**`ProtectWithoutReveal`**~~ **Done.** Closes #67, #104, and #62's classification
   half. `RejectedWidget.RedactNames` reach `SecretPlan` directly, so a refusal shadowed
   by a same-id widget that loaded can be carried at all — `WidgetLibrary.AllRefusals`
   retains it for redaction while `Rejected` stays filtered for the banner. Two things
   the write-up did not anticipate, both found while building it:
   - **Withholding the reveal means blanking, not skipping.** A refused widget's
     credential is normally legacy plaintext, so there is nothing to decline to decrypt;
     an implementation that merely skipped the address left the plaintext in the payload
     and closed nothing. The blank round-trips through `Seal`'s restore, so the two call
     sites in each window must build from ONE snapshot. `P35b` is that probe.
   - **The union direction is the fix, not a tidiness choice.** If `Protect` could beat
     `ProtectWithoutReveal`, declaring the shadowed name `secret` in the loaded manifest
     would be the entire #104 exploit. `SecretIntents.MostProtective` and `P35i`.
5. ~~**`RestoreIfUntouched`**~~ **Done.** Closes #66, #105 and #120's dashboard and editor
   halves. It is the LEAST protective intent — it does not encrypt — so it loses every
   collision in `MostProtective`, which is what stops it being planned for a name the
   manifest still calls `secret` and blanking a credential one line after decrypting it.
   Placement is forced by `P35x`, an explicit rank table cross-checked against the code
   for every pair. (`P35r`–`P35t` do NOT force it — they are invariant checks any sane
   function satisfies. An earlier version of this line claimed otherwise; adding a member
   and running the suite showed nothing failed.)

   Three things the write-up did not anticipate:
   - **The plan cannot be narrow.** Nothing anywhere records that a property *used to be*
     `secret` — a manifest states the present tense only. So every declared non-`secret`,
     non-`list` property carries the intent, and the VALUE decides. That makes the value
     check load-bearing for every ordinary setting in every layout, which is what `P36j`
     exists to police.
   - **Blanking needs two conditions, not one.** `CanUnprotect` (never
     `LooksLikeEnvelope` — a user can type `dpapi:v1:…`) AND a stably addressable slot.
     An id-less slot gets an id minted by `shell.js` on its first unrelated on-panel edit
     while the stored copy is still id-less, `SlotKey` refuses that mismatch (#68), the
     restore misses, and the blank reaches disk. `Blankable` is both, and `Seal` consults
     the same predicate so the restore and the blank can never disagree.
   - **`Seal`'s empty case must be gated the same way.** A blank from a slot we did not
     blank is the user's clear. Restoring it is the uneditable-field failure PR #65 hit
     three times, and with a broad plan it would hit every text input in the product.

6. ~~**The clear protocol.**~~ **Done.** Closes #153, #154, #155. Not a step this document
   planned — it was forced by seven review rounds on step 5, four of them the same
   mechanism.

   `ClearMarker` was a sentinel string written *into* a value. But "the user cleared this"
   is a statement **about** a value, and encoding it in the value made one string mean two
   things with no way to say which. Every rule over `(incoming, stored)` broke something:

   | rule | broke |
   | --- | --- |
   | always protocol | an untouched field echoing a value that already equalled it |
   | only where the address is restorable | a real Clear after the stored value changed |
   | only where incoming differs from stored | Clear of a field whose stored value IS it |

   The third case is unfixable by any such rule — incoming and stored agree while the
   meanings differ — because the information is not in the payload at all. `LiteralPrefix`
   made it worse rather than better: escaping is a **per-producer obligation**, there are
   six controls across two editors, and only the text inputs ever had it.

   Cleared addresses now travel as `secretsCleared`, a per-slot projection, the direction
   `secretsSet` and `secretsRestorable` already travel. A name in a list cannot be confused
   with a value, so nothing escapes anything and every setting means itself. Both sentinels
   are deleted, along with the unwrap `shell.js` needed to stop widgets being handed one.

   `Seal` gained one argument and lost three special cases. The other two took real work
   on top, and review caught me claiming otherwise:

   - **The affordance belongs to the FIELD, not a control (#154).** A demoted property can
     be any type, and each control's own reset emits an empty or absent value the host
     reads as untouched — so a Clear living in the `text` branch left every other type with
     an envelope it could not delete. It is keyed on the list now, in both editors.
   - **`Reveal` did need a channel after all (#153).** I wrote that it did not, because the
     editor can state what it cleared; but the panel cannot offer a Clear it does not know
     to draw, and a blanked field is indistinguishable from an always-empty one. `Reveal`
     reports the addresses it blanked and `DashboardWindow` stamps them where `Mask` puts
     its own.

   `LayoutSlot` still carries no extension data, so `ReadClearedMarkers` runs on the raw
   node before deserialization — and indexes over the slots that survive the placeholder
   filter, or every marker past a blank slot lands on its neighbour.
6. **Row addressing** — closes #62's remaining half.

Still to delete, once nothing needs them: `_maskedManifests`, `_revealedManifests` and
`MergeManifestSnapshot`. `WithSecretsForced` and `RedactionOnly` went with step 4 — the
plan is what says "this address holds a credential" now, so there is nothing left to
fabricate a manifest for. The snapshots survive because they answer a different question
(what did the library say when this payload was built), which the plan does not yet carry.

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

## The retained attic (#226): an identity-only address space

A slot removed on-panel or from the settings form is RETIRED, not discarded: its def
moves verbatim into the top-level `retained[]` array of `layout.json`, addressed solely
by `widgetId|i:instanceId` — the same key `SlotKey` derives for an id-bearing live slot,
and never by grid position. The retire paths (`shell.js removeSlot`, `settings.js
removeSlotAt`) mint an `instanceId` first when the def has none, so every attic entry is
id-bearing; `Seal` and `BuildStoredIndex` visit retained slots (an on-panel-retired
tile's revealed plaintext is re-sealed; an already-retired tile's ciphertext is findable
across saves), while `Reveal`, `Mask`, and the `(page,slot)` cleared-marker channel
deliberately do **not** — a retained tile never renders, so its secret travels to both
editors and rests on disk as `dpapi:v1:` ciphertext only. Two consequences follow from
identity-only addressing: the stored index's duplicate-key poison treats one instanceId
seated in both pages and retained as ambiguity and blanks BOTH (the retire paths resolve
the live tree before pushing, precisely so this state never arises in normal flow), and
the positional `|w:0` alias is never published for a retained entry — a widget with one
live and one retired copy must not hand the retired credential to the live tile by
position.

The attic is bounded (`LayoutStore.MaxRetainedPerWidget` per widget id) and reconciled
host-side on every save: the incoming attic is UNIONED with the disk's (a stale save from
the other window cannot silently shrink it), then capped evict-oldest by `retiredAt`.
Destroying an evicted entry removes its bytes from `layout.json` AND purges its derived
ww-secure bucket (`WidgetSecrets.ForgetInstance`) — guarded by liveness, so an id a
surviving tile still references is never purged, per #188's rule that the app purges only
what it knowingly removed.

**Legacy loss (accepted, by the same #68 proof).** A tile never edited on-panel has no
`instanceId` in the *stored* layout. When it is retired, the retire path mints
`widgetId|i:<new>`, but the stored value is reachable only under `widgetId|w:0` — the
carry-over misses, and on the masked retire path the manifest secret is dropped. This is
byte-identical to the loss already shipped on a legacy tile's first on-panel edit:
stored-id-less + incoming-id-bearing is indistinguishable from "deleted the sole
credentialed tile, added a fresh instance of the same widget", and a positional retry
that recovered the first would hand the second a deleted instance's credential — which
then transmits to whatever endpoint the new tile points at. Lost is retypable;
misdelivered is not. Tiles that are id-bearing in the stored layout (everything added by
`addWidget` or the settings gallery) preserve their secret through retire.

**A Clear that is followed by a Remove is honored, by identity.** The cleared-property
channel is positional (`(page, slot)`), and a retired slot has no position — so when a
user clears a credential and removes the tile before the next save, the marker travels
*inside* the retired def where the positional reader never looks. Read only that way, Seal
would see an ordinary blank, restore the stored ciphertext by identity, and put the
credential the user explicitly destroyed back into the attic, ready to reconnect on
restore. `ReadRetainedClearedMarkers` therefore reads the attic's markers off the raw node
keyed by `widgetId|i:instanceId`, and `Seal` resolves them to slot references before
walking, so one `Cleared()` answers for both address spaces. The check runs ahead of the
value branches, so a clear drops a retired def's revealed plaintext (the on-panel path) and
its ciphertext alike — exactly as it does for a live slot.

**Restore inherits three constraints from this model, and honors all three.** Restore
keeps the retained `instanceId` (the derived ww-secure bucket reconnects through it) and
must, in one mutation: (a) remove the entry from `retained[]` as it copies the def back
into a page — else the pages∧retained twin arises and the poison blanks the just-restored
credential; (b) mint a fresh id only on a genuine collision with a live tile; and
(c) persist and re-init rather than render the moved def directly — `Reveal` is Pages-only,
so a client-side restore would hand the widget sealed ciphertext as its setting.
`LayoutStore.RestoreRetained` is that mutation. Two details are worth naming because they
are not obvious from the constraints alone:

- (a) is `RemoveAll` by identity, not "remove the matched entry". A duplicate-identity
  attic is a corruption class this code already assumes it must survive — the stored
  index shares one seen-set across the pages and retained walks precisely for it — so
  restoring "the" entry and leaving its twin would manufacture the twin state the
  constraint exists to avoid.
- On the (b) re-mint path the ww-secure bucket stays with the live tile holding the old
  id, which is correct under #188's rule: it is that tile's. So a re-minted restore
  reconnects **Axis A only** — the DPAPI envelope is user-scoped, not instance-scoped, and
  rides along — while the widget re-authenticates Axis B. Restoring an uncontested id (the
  overwhelmingly common case) reconnects both.

The def a settings-side restore hands back to the editor is masked over a wrapper that is
literally `{"pages":[{"slots":[def]}]}` with the window's own `MaskedPlan()`. Both halves
are load-bearing: `Mask` returns having done *nothing* unless it finds `layoutNode["pages"]`,
and a manifest-only plan walks straight past a **refused** widget's plaintext residue —
either mistake posts a credential into the editor's model, which is the state the
host-performed restore exists to prevent.

**Clear destroys, and fails closed.** `ClearRetained` drops the entry (again `RemoveAll` by
identity: a leftover twin would sit in the survivors' attic and talk the liveness guard out
of the destroy, so the Clear would neither empty the row nor purge the bucket) and computes
the forget set with `InstancesToForget` over the post-removal layout — eviction's rule
exactly. Unlike eviction, a failure to write the secure store aborts the whole operation
without saving: eviction tolerates catch-and-continue because blocking an ordinary save on
secure-store trouble is the worse failure, but Clear is a dedicated destroy with its own
ack, and saving a layout that no longer names the instance while its bucket survives would
strand a *working* credential nothing references.

**Cross-window convergence for Clear.** The union (`MergeRetainedFromDisk`) only ever ADDS
disk entries the incoming payload omits — that asymmetry is what protects the attic from a
stale window shrinking it — so an incoming entry the disk lacks is never questioned, and a
still-open window re-ships a cleared entry from memory. `Seal` then keeps its still-openable
ciphertext idempotently, and a later Restore would hand back a *working* credential the user
explicitly destroyed. So each destroy is mirrored to the other window, both ways:
settings→panel through `DashboardWindow.PostRetainedGone` (the shell's `evicted-ids`
splice), panel→settings through the `DashboardWindow.RetainedGone` event that
`SettingsWindow.Dashboard`'s setter subscribes to (the editor's `retained-gone` splice).
The settings→panel direction is the one that would fail constantly without it — the panel
re-ships its whole model on every drag and resize — but neither race is worth leaving open
once the wiring exists.

**A restore needs the same mirror, for the opposite reason.** The settings editor holds the
pre-restore pages *and* still lists the entry as retired, and its next ordinary save writes
that model back; the union cannot rescue the live slot, because it only ever adds disk attic
entries. The tile would drop off its page and reappear in the removed list. So the panel
also raises `RetainedRestored`, and the settings window answers it with exactly the masked
def its own Restore would have produced — the editor adopts the slot rather than
re-litigating it. Nothing is lost when it misses (a divergent page list declines the mirror
and the restore simply reverts), but a restore that silently undoes itself is not a
behaviour to ship.

Both clients drop **every** entry under the identity, not the first match, exactly as the
host does: a leftover twin is re-shipped on the next save, seating that identity in pages
and retained at once — the poison state again.

No tombstones. The mirror is best-effort by construction (a window opened after the destroy
re-reads disk and is correct by definition), and a persistent tombstone list with no expiry
story, for a same-machine race whose residue would be visible rather than silent, buys less
than it costs.

**The ack claims something about disk, so it waits for disk.** `LayoutStore.Save` swallows
its write failures — a save is triggered by ordinary editing on both surfaces, and throwing
out of those paths would take something visible down with it — but it now REPORTS whether
the write landed, and Clear and Restore both check. Clear has already destroyed the bucket
by then (destroy-before-Save, so the surviving state is a retained tile that
re-authenticates, never a destroyed tile with a live credential), so its ack carries
`saved` and the clients keep the row when it is false: telling the user "deleted for good"
while the entry sits on disk with a still-openable envelope is the one lie this operation
cannot afford.
