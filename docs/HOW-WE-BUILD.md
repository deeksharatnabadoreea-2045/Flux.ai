# How we build Flux

This is our shared map. If a step does not match this page, stop and ask.

## End goal

Build a platform that:

1. Keeps getting smarter over time (it can suggest upgrades; a human must approve them).
2. Can run many kinds of human trials on computers — not only drug tests — using virtual people instead of real people.
3. Aims for results that match real life as closely as possible. We treat perfect match as the target we earn with proof, not a claim we make early.
4. Makes money.
5. Feels clearer and nicer over time, aiming toward Apple-level calm and polish.

## How you and I work

1. I say what I want to do next, in plain English.
2. You say yes, no, or change this.
3. I only do the work after you approve.
4. No surprise builds.
5. No hard words with you. If I must use a hard word once, I explain it in normal words.
6. **From now on: UX and monetization move together.** Each approved product step should make the product nicer to use **and** make paid access clearer (or easier to buy). We do not park money work while only polishing, or polish while ignoring money.

## What we do not claim yet

- We do not say computer trials already replace real human trials.
- We do not say the system is already perfect or already a finished “super mind.”
- We only claim what we can show with proof.

## Build order

We build in layers. Small useful thing first.

1. **This page** — shared goal and rules — **done**.
2. **First product people can use** — simple Flux chat — **done**.
3. **Money path (first pass)** — Get access / Pay on the chat page — **done** (basic path live).
4. **Science engine, one step at a time** — check computer trials against past real results — **in progress** (steps 1–2 done; can continue when you ask).
5. **UX + monetization together** — **active from now on**. Every round: calmer product feel **and** a clearer pay path.
6. **Self-improvement with a human gate** — the system suggests upgrades; you approve before anything changes.

### Science so far (parked until you ask to continue)

- Step 1: past-trial MATCH/MISS checker
- Step 2: second fixture + hit rate (`python3 -m engine.past_trial_check`)
  - **NCT00876395** (BOLERO-1) — fail
  - **NCT01642004** (CheckMate 017) — success

## What “good progress” looks like

After each approved step, you should be able to answer yes to at least one of these:

- Can a real person use something new?
- Can we charge for something clearer than before?
- Did we get closer to trustworthy computer trials?
- Did the product feel nicer to use?
- Did the system suggest a useful upgrade that you could approve or reject?

For **UX + money** rounds, aim for yes on **both** “nicer to use” and “clearer to pay” when we can.

## Next step (needs your yes / no / change)

**UX + money round 1**

1. **UX:** calm the Get access panel on chat (clearer layout, quieter look, easier to read).
2. **Money:** clearer offer copy — what $29/month includes — still using the email Pay link until you have a real pay URL (Stripe etc. goes in `js/access-config.js`).

No science work in this round unless you ask.

Say **yes**, **no**, or **change this**.
